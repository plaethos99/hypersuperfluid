import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  endEditPrompt, framePrompt, framesFolder, framesToDraw, isStoryboardPath, parseStoryboard, type Storyboard,
} from '../src/creative/storyboard.ts'
import { pictureExtension, readStoryboard, StoryboardDrawer, writeStoryboard, type RunStatus, type Services } from '../src/creative/drawer.ts'
import { carryPictures } from '../src/creative/tools.ts'
import { pictureIn } from '../src/creative/flow.ts'
import { browserCandidates } from '../src/creative/browser.ts'
import { aspectRatio, creativeUrl, framePath, progressOf, storyboardDefinition } from '../src/client/storyboard.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3])

const BOARD = {
  title: 'Lighthouse',
  aspect: '9:16',
  style: 'Watercolour, soft dusk light.',
  characters: [{ name: 'Mira', look: 'a girl of ten, red raincoat, short black hair' }],
  scenes: [
    { id: 's1', title: 'Arrival', action: 'Mira walks to the door', start: { prompt: 'Mira at the foot of a lighthouse' }, end: { prompt: 'Mira at the door' } },
    { title: 'Inside', start: { prompt: 'A spiral staircase' }, end: { prompt: 'The lamp room' } },
  ],
}

describe('storyboard file', () => {
  it('reads a board, filling ids and dropping unknown fields', () => {
    const board = parseStoryboard({ ...BOARD, extra: 1 })
    expect(board.version).toBe(1)
    expect(board.scenes.map(scene => scene.id)).toEqual(['s1', 's2'])
    expect('extra' in board).toBe(false)
    expect(parseStoryboard({ title: 'x', scenes: BOARD.scenes }).aspect).toBe('16:9')
  })

  it('names the field that is wrong', () => {
    expect(() => parseStoryboard({ ...BOARD, aspect: '2:1' })).toThrow(/aspect/u)
    expect(() => parseStoryboard({ ...BOARD, scenes: [] })).toThrow(/at least one scene/u)
    expect(() => parseStoryboard({ ...BOARD, scenes: [{ ...BOARD.scenes[0], end: {} }] })).toThrow(/scenes\[0\]\.end\.prompt/u)
    expect(() => parseStoryboard({ ...BOARD, scenes: [BOARD.scenes[0], BOARD.scenes[0]] })).toThrow(/used twice/u)
    expect(() => parseStoryboard({ ...BOARD, scenes: [{ ...BOARD.scenes[0], id: '../x' }] })).toThrow(/id may hold/u)
  })

  it('builds prompts with the named characters and the shared style', () => {
    const board = parseStoryboard(BOARD)
    const scene = board.scenes[0]!
    expect(framePrompt(board, scene.start)).toBe('Mira at the foot of a lighthouse. Mira: a girl of ten, red raincoat, short black hair. Style: Watercolour, soft dusk light.')
    expect(framePrompt(board, board.scenes[1]!.start)).not.toContain('Mira')
    const edit = endEditPrompt(board, scene)
    expect(edit).toContain('a moment later')
    expect(edit).toContain('What happened: Mira walks to the door.')
    expect(edit).toContain('Now: Mira at the door.')
  })

  it('lists the frames still to draw, one scene, or all again', () => {
    const board = parseStoryboard(BOARD)
    board.scenes[0]!.start = { ...board.scenes[0]!.start, image: 'a.png', status: 'done' }
    expect(framesToDraw(board).map(frame => `${frame.scene.id} ${frame.kind}`)).toEqual(['s1 end', 's2 start', 's2 end'])
    expect(framesToDraw(board, { scene: 's1', redraw: true })).toHaveLength(2)
    expect(() => framesToDraw(board, { scene: 'nope' })).toThrow(/no scene/u)
  })

  it('knows its file names', () => {
    expect(isStoryboardPath('C:\\work\\Ad.Storyboard.JSON')).toBe(true)
    expect(isStoryboardPath('/work/ad.json')).toBe(false)
    expect(framesFolder(join('work', 'ad.storyboard.json'))).toBe(join('work', 'ad.frames'))
  })

  it('keeps pictures of unchanged frames when saved again, and drops stale ones', () => {
    const before = parseStoryboard(BOARD)
    for (const scene of before.scenes) {
      scene.start = { ...scene.start, image: `${scene.id}-start.png`, status: 'done', source: 'flow' }
      scene.end = { ...scene.end, image: `${scene.id}-end.png`, status: 'done', source: 'grok' }
    }
    const next = parseStoryboard({ ...BOARD, scenes: [BOARD.scenes[0], { ...BOARD.scenes[1], start: { prompt: 'A narrow staircase' } }] })
    carryPictures(next, before)
    expect(next.scenes[0]!.start).toMatchObject({ image: 's1-start.png', status: 'done', source: 'flow' })
    expect(next.scenes[0]!.end).toMatchObject({ image: 's1-end.png', source: 'grok' })
    // The start prompt changed, so both its picture and the end frame drawn from it are stale.
    expect(next.scenes[1]!.start.image).toBeUndefined()
    expect(next.scenes[1]!.end.image).toBeUndefined()
  })
})

describe('drawing', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hsf-creative-'))
    path = join(dir, 'ad.storyboard.json')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  type Call = [string, ...string[]]
  function services(options: { flow?: 'closed' | 'signin' | 'ready'; grok?: 'closed' | 'signin' | 'ready'; flowFails?: (prompt: string) => string | undefined } = {}): { services: Services; calls: Call[] } {
    const calls: Call[] = []
    const fail = (prompt: string): void => {
      const reason = options.flowFails?.(prompt)
      if (reason !== undefined) throw new Error(reason)
    }
    return {
      calls,
      services: {
        flow: {
          state: () => Promise.resolve(options.flow ?? 'ready'),
          image: (prompt, aspect) => { calls.push(['flow.image', prompt.slice(0, 20), aspect]); fail(prompt); return Promise.resolve(PNG) },
          edit: (picture, prompt, aspect) => { calls.push(['flow.edit', picture, aspect]); fail(prompt); return Promise.resolve(PNG) },
        },
        grok: {
          state: () => Promise.resolve(options.grok ?? 'closed'),
          image: (prompt) => { calls.push(['grok.image', prompt.slice(0, 20)]); return Promise.resolve(JPG) },
          edit: (picture) => { calls.push(['grok.edit', picture]); return Promise.resolve(JPG) },
        },
      },
    }
  }

  async function finish(drawer: StoryboardDrawer, status: RunStatus): Promise<RunStatus> {
    for (let i = 0; i < 200 && !status.finished; i++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(status.finished).toBe(true)
    return drawer.status(path)!
  }

  it('draws start frames from prompts and end frames by changing the start frame, in Flow', async () => {
    await writeStoryboard(path, parseStoryboard(BOARD))
    const { services: fake, calls } = services()
    const drawer = new StoryboardDrawer(fake, { prefer: 'flow', captchaWaitMs: 1 })
    const status = await finish(drawer, await drawer.start(path))
    expect(status).toMatchObject({ total: 4, done: 4, failed: 0 })
    expect(calls.map(call => call[0])).toEqual(['flow.image', 'flow.edit', 'flow.image', 'flow.edit'])
    expect(calls[0]![2]).toBe('9:16')
    expect(calls[1]![1]).toBe(join(dir, 'ad.frames', 's1-start.png'))
    const board = await readStoryboard(path)
    expect(board.scenes[0]!.end).toMatchObject({ image: 'ad.frames/s1-end.png', status: 'done', source: 'flow' })
    expect(readFileSync(join(dir, 'ad.frames', 's2-end.png'))).toEqual(PNG)
    // Nothing is left to draw, so a second Proceed says so instead of drawing again.
    expect((await drawer.start(path)).note).toMatch(/Every frame is drawn/u)
  })

  it('sends a picture Flow refuses to Grok when Grok is signed in', async () => {
    await writeStoryboard(path, parseStoryboard({ ...BOARD, scenes: [BOARD.scenes[0]] }))
    const { services: fake, calls } = services({ grok: 'ready', flowFails: prompt => (prompt.startsWith('Mira at the foot') ? 'POLICY: Flow refused it' : undefined) })
    const drawer = new StoryboardDrawer(fake, { prefer: 'flow', captchaWaitMs: 1 })
    await finish(drawer, await drawer.start(path))
    expect(calls.map(call => call[0])).toEqual(['flow.image', 'grok.image', 'flow.edit'])
    const board = await readStoryboard(path)
    expect(board.scenes[0]!.start).toMatchObject({ image: 'ad.frames/s1-start.jpg', source: 'grok' })
    expect(board.scenes[0]!.end.source).toBe('flow')
  })

  it('tries Flow twice on a slip, and records a frame neither service made', async () => {
    await writeStoryboard(path, parseStoryboard({ ...BOARD, scenes: [BOARD.scenes[0]] }))
    const { services: fake, calls } = services({ flowFails: prompt => (prompt.startsWith('Mira at the foot') ? 'Flow failed to make it (busy)' : undefined) })
    const drawer = new StoryboardDrawer(fake, { prefer: 'flow', captchaWaitMs: 1 })
    const status = await finish(drawer, await drawer.start(path))
    expect(status).toMatchObject({ done: 1, failed: 1 })
    // The start frame failed, so the end frame is drawn from its own prompt.
    expect(calls.map(call => call[0])).toEqual(['flow.image', 'flow.image', 'flow.image'])
    const board = await readStoryboard(path)
    expect(board.scenes[0]!.start).toMatchObject({ status: 'failed', error: 'Flow failed to make it (busy)' })
    expect(board.scenes[0]!.start.image).toBeUndefined()
  })

  it('stops at once and says what to open when neither window is ready', async () => {
    await writeStoryboard(path, parseStoryboard(BOARD))
    const { services: fake, calls } = services({ flow: 'signin', grok: 'closed' })
    const drawer = new StoryboardDrawer(fake, { prefer: 'flow', captchaWaitMs: 1 })
    const status = await finish(drawer, await drawer.start(path))
    expect(calls).toEqual([])
    expect(status.failed).toBe(1)
    expect(status.error).toMatch(/^Open Flow/u)
  })

  it('draws in Grok when Flow is not open, and in Grok first when preferred', async () => {
    await writeStoryboard(path, parseStoryboard({ ...BOARD, scenes: [BOARD.scenes[0]] }))
    const closed = services({ flow: 'closed', grok: 'ready' })
    let drawer = new StoryboardDrawer(closed.services, { prefer: 'flow', captchaWaitMs: 1 })
    await finish(drawer, await drawer.start(path))
    expect(closed.calls.map(call => call[0])).toEqual(['grok.image', 'grok.edit'])
    const preferred = services({ grok: 'ready' })
    drawer = new StoryboardDrawer(preferred.services, { prefer: 'grok', captchaWaitMs: 1 })
    await finish(drawer, await drawer.start(path, { redraw: true }))
    expect(preferred.calls.map(call => call[0])).toEqual(['grok.image', 'grok.edit'])
  })

  it('stops between frames when asked', async () => {
    await writeStoryboard(path, parseStoryboard(BOARD))
    const { services: fake } = services()
    const drawer = new StoryboardDrawer(fake, { prefer: 'flow', captchaWaitMs: 1 })
    const run = await drawer.start(path)
    drawer.stop(path)
    const status = await finish(drawer, run)
    expect(status.done).toBeLessThan(4)
    expect(status.note).toBe('Stopped.')
  })

  it('tells picture formats apart', () => {
    expect(pictureExtension(PNG)).toBe('png')
    expect(pictureExtension(JPG)).toBe('jpg')
    expect(pictureExtension(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp')
    expect(existsSync(path)).toBe(false)
  })

  it('reads the picture link from Flow\'s answer, or why there is none', () => {
    const id = '0f0e0d0c-0000-4000-8000-000000000001'
    const body = `[[[\\"${id}\\",…"https://flow-content.google/image/other?x\\u003d1" "https://flow-content.google/image/${id}?sig\\u003dabc\\u0026e\\u003d2"`
    expect(pictureIn(body)).toBe(`https://flow-content.google/image/${id}?sig=abc&e=2`)
    expect(() => pictureIn('ErrorInfo PUBLIC_ERROR_UNSAFE_GENERATION policy')).toThrow(/^POLICY:/u)
    expect(() => pictureIn('ErrorInfo quota')).toThrow(/Flow failed/u)
  })

  it('finds Edge and Chrome where they are installed', () => {
    expect(browserCandidates('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' })[0]).toContain('msedge.exe')
    expect(browserCandidates('darwin', { HOME: '/Users/a' }).some(path => path.includes('Google Chrome.app'))).toBe(true)
  })
})

describe('storyboard board', () => {
  it('claims .storyboard.json files ahead of the JSON view', () => {
    expect(storyboardDefinition.extensions).toEqual(['storyboard.json'])
    expect(storyboardDefinition.priority).toBe('extension')
  })

  it('finds frame pictures beside the storyboard', () => {
    expect(framePath('C:\\work\\ad.storyboard.json', 'ad.frames/s1-start.png')).toBe('C:\\work\\ad.frames\\s1-start.png')
    expect(framePath('/home/a/ad.storyboard.json', 'ad.frames/s1-start.png')).toBe('/home/a/ad.frames/s1-start.png')
  })

  it('sizes frames and counts progress', () => {
    expect(aspectRatio('9:16')).toBe('9 / 16')
    const board = { title: 't', aspect: '16:9', scenes: [{ id: 's1', title: 'a', start: { prompt: 'p', image: 'x.png', status: 'done' }, end: { prompt: 'q', status: 'failed' } }] }
    expect(progressOf(board)).toEqual({ drawn: 1, total: 2 })
    expect(creativeUrl('http://127.0.0.1:7420/', 'draw', { path: 'C:\\a b.storyboard.json', scene: undefined }))
      .toBe('http://127.0.0.1:7420/api/hsf/creative/draw?path=C%3A%5Ca+b.storyboard.json')
  })
})

/** Keeps the writer's output shape checked: a stable, readable file. */
describe('storyboard on disk', () => {
  it('writes readable JSON that reads back the same', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hsf-creative-'))
    try {
      const file = join(dir, 'x.storyboard.json')
      const board: Storyboard = parseStoryboard(BOARD)
      await writeStoryboard(file, board)
      expect(readFileSync(file, 'utf8')).toMatch(/^\{\n {2}"version": 1,\n {2}"title": "Lighthouse"/u)
      expect(await readStoryboard(file)).toEqual(board)
      writeFileSync(file, '{ nope')
      await expect(readStoryboard(file)).rejects.toThrow(/not readable JSON/u)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
