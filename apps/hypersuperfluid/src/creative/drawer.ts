/**
 * Draws a storyboard's frames. Each scene's start frame is drawn from its prompt; its end frame is the start frame
 * changed as the end prompt says, so both show the same place and people (drawn from its own prompt when the start
 * frame could not be made). Google Flow gets every chance first: a slip is tried once more and a CAPTCHA waits for
 * the person. A picture Flow will not make, or every picture when Flow's window is not ready, goes to Grok Imagine
 * when its window is signed in. The picture files go in `<name>.frames/` beside the storyboard, and the storyboard
 * records each frame's progress, so the board in the app shows it as it happens.
 * @module hypersuperfluid/creative/drawer
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join, normalize } from 'node:path'
import {
  endEditPrompt, formatStoryboard, frameImage, framePrompt, framesFolder, framesToDraw, parseStoryboard,
  type Frame, type FrameKind, type FrameSource, type Storyboard,
} from './storyboard.ts'

/** A picture service as the drawer uses it. */
export interface PictureService {
  state(): Promise<'closed' | 'signin' | 'ready'>
  image(prompt: string, aspect: string): Promise<Buffer>
}

/** Flow can also change a picture with an aspect; Grok without. */
export interface Services {
  readonly flow: PictureService & { edit(picture: string, prompt: string, aspect: string): Promise<Buffer> }
  readonly grok: PictureService & { edit(picture: string, prompt: string): Promise<Buffer> }
}

/** Drawing settings. */
export interface DrawerOptions {
  /** Which service draws first. */
  readonly prefer: FrameSource
  /** How long a CAPTCHA is given to be answered before Flow is tried again. */
  readonly captchaWaitMs: number
}

/** A run's progress, as the app shows it. */
export interface RunStatus {
  readonly path: string
  readonly total: number
  done: number
  failed: number
  /** The frame being drawn, as "<scene id> start|end". */
  current?: string
  /** What the run is doing now, in words. */
  note?: string
  finished: boolean
  /** Why the run stopped early. */
  error?: string
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const isPolicy = (error: unknown): boolean => /^POLICY:|refused/iu.test(message(error))
const isCaptcha = (error: unknown): boolean => /CAPTCHA/u.test(message(error))

/** The file suffix for a picture's bytes. */
export function pictureExtension(data: Buffer): string {
  if (data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png'
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return 'jpg'
}

/** Reads and checks a storyboard file. */
export async function readStoryboard(path: string): Promise<Storyboard> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`${path} is not readable JSON: ${message(error)}`)
  }
  return parseStoryboard(parsed)
}

/** Writes a storyboard file in one step, so the app never reads half a file. */
export async function writeStoryboard(path: string, board: Storyboard): Promise<void> {
  const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, formatStoryboard(board))
  await rename(temp, path)
}

/** Draws storyboards, one run per file at a time. */
export class StoryboardDrawer {
  private readonly runs = new Map<string, { status: RunStatus; abort: AbortController }>()

  constructor(private readonly services: Services, private readonly options: DrawerOptions) {}

  /** A file's current or last run. */
  status(path: string): RunStatus | undefined {
    return this.runs.get(normalize(path))?.status
  }

  /**
   * Starts drawing; returns at once with the run's status. A file already being drawn keeps its run.
   * @param path - the storyboard file.
   * @param options - one scene only, and whether to redraw frames that have a picture.
   * @returns the run's status.
   */
  async start(path: string, options: { scene?: string; redraw?: boolean } = {}): Promise<RunStatus> {
    const key = normalize(path)
    const running = this.runs.get(key)
    if (running !== undefined && !running.status.finished) return running.status
    const board = await readStoryboard(path)
    const pending = framesToDraw(board, options)
    const status: RunStatus = { path, total: pending.length, done: 0, failed: 0, finished: pending.length === 0 }
    if (pending.length === 0) status.note = 'Every frame is drawn. Use Redraw to draw a scene again.'
    const abort = new AbortController()
    this.runs.set(key, { status, abort })
    if (pending.length > 0) {
      void this.run(path, pending.map(item => ({ id: item.scene.id, kind: item.kind })), status, abort.signal)
        .catch((error: unknown) => { status.error = message(error) })
        .finally(() => { status.finished = true; delete status.current })
    }
    return status
  }

  /** Stops a file's run after the frame being drawn. */
  stop(path: string): void {
    this.runs.get(normalize(path))?.abort.abort()
  }

  /** Stops every run. */
  stopAll(): void {
    for (const run of this.runs.values()) run.abort.abort()
  }

  private async run(path: string, frames: { id: string; kind: FrameKind }[], status: RunStatus, signal: AbortSignal): Promise<void> {
    await mkdir(framesFolder(path), { recursive: true })
    for (const { id, kind } of frames) {
      if (signal.aborted) { status.note = 'Stopped.'; return }
      status.current = `${id} ${kind}`
      // The file is read again for every frame: the agent or the person may have changed it meanwhile.
      await this.update(path, id, kind, (frame) => { frame.status = 'drawing'; delete frame.error })
      try {
        const board = await readStoryboard(path)
        const scene = board.scenes.find(item => item.id === id)
        if (scene === undefined) continue
        const { data, source } = await this.draw(path, board, scene, kind, (note) => { status.note = note })
        const image = frameImage(path, scene, kind, pictureExtension(data))
        await writeFile(join(dirname(path), image), data)
        await this.update(path, id, kind, (frame) => { frame.image = image; frame.status = 'done'; frame.source = source; delete frame.error })
        status.done++
        delete status.note
      } catch (error) {
        status.failed++
        await this.update(path, id, kind, (frame) => { frame.status = 'failed'; frame.error = message(error).replace(/^POLICY: /u, '') })
        // With neither window ready, every frame would fail the same way: stop and say what to open.
        if (/^Open (Flow|Grok)|neither/u.test(message(error))) { status.error = message(error); return }
      }
    }
  }

  private async update(path: string, id: string, kind: FrameKind, change: (frame: Frame) => void): Promise<void> {
    const board = await readStoryboard(path)
    const scene = board.scenes.find(item => item.id === id)
    if (scene === undefined) return
    change(scene[kind])
    await writeStoryboard(path, board)
  }

  private async draw(path: string, board: Storyboard, scene: Storyboard['scenes'][number], kind: FrameKind, note: (text: string) => void): Promise<{ data: Buffer; source: FrameSource }> {
    const start = scene.start
    if (kind === 'end' && start.status === 'done' && start.image !== undefined) {
      const picture = join(dirname(path), start.image)
      const prompt = endEditPrompt(board, scene)
      return this.withServices(
        () => this.services.flow.edit(picture, prompt, board.aspect),
        () => this.services.grok.edit(picture, prompt),
        note,
      )
    }
    const prompt = framePrompt(board, scene[kind])
    return this.withServices(
      () => this.services.flow.image(prompt, board.aspect),
      () => this.services.grok.image(prompt, board.aspect),
      note,
    )
  }

  /** Flow first (twice, waiting out a CAPTCHA), then Grok; or Grok first when preferred. */
  private async withServices(
    inFlow: () => Promise<Buffer>, inGrok: () => Promise<Buffer>, note: (text: string) => void,
  ): Promise<{ data: Buffer; source: FrameSource }> {
    const [flowState, grokState] = await Promise.all([this.services.flow.state(), this.services.grok.state()])
    const grokReady = grokState === 'ready'
    if (this.options.prefer === 'grok' && grokReady) return { data: await inGrok(), source: 'grok' }
    if (flowState !== 'ready') {
      if (grokReady) {
        note('Flow is not open on a project; drawing in Grok Imagine.')
        return { data: await inGrok(), source: 'grok' }
      }
      throw new Error('Open Flow (sign in and open a project) or Grok Imagine (sign in) with the buttons above, then press Proceed again. Neither is ready.')
    }
    let last: unknown
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return { data: await inFlow(), source: 'flow' }
      } catch (error) {
        last = error
        if (isPolicy(error)) break
        if (isCaptcha(error)) {
          note('Flow is asking for a check: answer it in the Flow window.')
          await new Promise(resolve => setTimeout(resolve, this.options.captchaWaitMs))
        } else {
          note(`Flow did not make it (${message(error)}); trying Flow again.`)
        }
      }
    }
    if (!grokReady) throw last
    note(`Flow could not make it (${message(last).replace(/^POLICY: /u, '')}); drawing it in Grok Imagine.`)
    return { data: await inGrok(), source: 'grok' }
  }
}
