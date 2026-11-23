/**
 * The storyboard file: a `*.storyboard.json` in the working folder. The agent writes it (scenes, each with a start
 * and an end frame described in words); the app shows it as a board, and its Proceed button draws the frames in
 * Google Flow or Grok Imagine. Drawn frames go in a folder beside the file (`<name>.frames/`), and the file records
 * each frame's picture, where it was drawn, and why one failed, so the board shows progress as it is drawn.
 * @module hypersuperfluid/creative/storyboard
 */

import { basename, dirname, join } from 'node:path'

/** The suffix that makes a file a storyboard. */
export const STORYBOARD_SUFFIX = '.storyboard.json'

/** The aspect ratios both Flow and Grok Imagine offer. */
export const ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const
/** One of {@link ASPECTS}. */
export type Aspect = typeof ASPECTS[number]

/** Where a frame was drawn. */
export type FrameSource = 'flow' | 'grok'

/** One frame of a scene: what it shows, and once drawn, the picture. */
export interface Frame {
  /** What the picture shows, as a picture prompt. */
  prompt: string
  /** The picture, relative to the storyboard file. */
  image?: string
  /** Drawing state: absent until drawing starts. */
  status?: 'drawing' | 'done' | 'failed'
  /** Why drawing failed. */
  error?: string
  /** Where it was drawn. */
  source?: FrameSource
}

/** One scene: a start frame and an end frame, and what happens between them. */
export interface Scene {
  /** Stable id, unique in the board. */
  id: string
  /** A short title. */
  title: string
  /** What happens between the two frames (the motion a clip would show). */
  action?: string
  /** Planned length in seconds. */
  seconds?: number
  start: Frame
  end: Frame
}

/** A character whose look every frame that names them keeps. */
export interface Character {
  name: string
  /** What they look like, as a picture prompt. */
  look: string
}

/** The whole board. */
export interface Storyboard {
  version: 1
  title: string
  aspect: Aspect
  /** The look every frame shares (medium, palette, lighting, lens). */
  style?: string
  characters?: Character[]
  scenes: Scene[]
}

/** Which frame of a scene. */
export type FrameKind = 'start' | 'end'

const text = (value: unknown, what: string, max = 4000): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${what} must be a non-empty string`)
  if (value.length > max) throw new Error(`${what} is longer than ${String(max)} characters`)
  return value.trim()
}

const optionalText = (value: unknown, what: string): string | undefined => value === undefined ? undefined : text(value, what)

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${what} must be an object`)
  return value as Record<string, unknown>
}

function frameOf(value: unknown, what: string): Frame {
  const raw = record(value, what)
  const frame: Frame = { prompt: text(raw.prompt, `${what}.prompt`) }
  if (typeof raw.image === 'string' && raw.image !== '') frame.image = raw.image
  if (raw.status === 'drawing' || raw.status === 'done' || raw.status === 'failed') frame.status = raw.status
  if (typeof raw.error === 'string') frame.error = raw.error
  if (raw.source === 'flow' || raw.source === 'grok') frame.source = raw.source
  return frame
}

/**
 * Reads and checks a storyboard. Unknown fields are dropped; a missing or wrong required field throws, naming it.
 * @param value - parsed JSON.
 * @returns the storyboard.
 */
export function parseStoryboard(value: unknown): Storyboard {
  const raw = record(value, 'storyboard')
  if (raw.version !== undefined && raw.version !== 1) throw new Error('storyboard.version must be 1')
  const aspect = raw.aspect ?? '16:9'
  if (!(ASPECTS as readonly unknown[]).includes(aspect)) throw new Error(`storyboard.aspect must be one of ${ASPECTS.join(', ')}`)
  if (!Array.isArray(raw.scenes) || raw.scenes.length === 0) throw new Error('storyboard.scenes must list at least one scene')
  if (raw.scenes.length > 60) throw new Error('storyboard.scenes holds at most 60 scenes')
  const ids = new Set<string>()
  const scenes = raw.scenes.map((item: unknown, index): Scene => {
    const what = `scenes[${String(index)}]`
    const scene = record(item, what)
    const id = scene.id === undefined ? `s${String(index + 1)}` : text(scene.id, `${what}.id`, 40)
    if (!/^[\w-]+$/u.test(id)) throw new Error(`${what}.id may hold only letters, digits, - and _`)
    if (ids.has(id)) throw new Error(`${what}.id "${id}" is used twice`)
    ids.add(id)
    const seconds = scene.seconds
    if (seconds !== undefined && (typeof seconds !== 'number' || !(seconds > 0) || seconds > 60)) throw new Error(`${what}.seconds must be between 0 and 60`)
    const result: Scene = { id, title: text(scene.title, `${what}.title`, 200), start: frameOf(scene.start, `${what}.start`), end: frameOf(scene.end, `${what}.end`) }
    const action = optionalText(scene.action, `${what}.action`)
    if (action !== undefined) result.action = action
    if (typeof seconds === 'number') result.seconds = seconds
    return result
  })
  const characters = raw.characters === undefined ? undefined : (Array.isArray(raw.characters) ? raw.characters : [raw.characters])
    .map((item: unknown, index): Character => {
      const character = record(item, `characters[${String(index)}]`)
      return { name: text(character.name, `characters[${String(index)}].name`, 80), look: text(character.look, `characters[${String(index)}].look`) }
    })
  const board: Storyboard = { version: 1, title: text(raw.title, 'storyboard.title', 200), aspect: aspect as Aspect, scenes }
  const style = optionalText(raw.style, 'storyboard.style')
  if (style !== undefined) board.style = style
  if (characters !== undefined && characters.length > 0) board.characters = characters
  return board
}

/**
 * The storyboard as written to disk, with a stable field order.
 * @param board - the storyboard.
 * @returns JSON text ending in a newline.
 */
export function formatStoryboard(board: Storyboard): string {
  return `${JSON.stringify(board, null, 2)}\n`
}

/**
 * The picture prompt for a frame: its own words, then the characters it names and the shared style.
 * @param board - the storyboard.
 * @param frame - the frame.
 * @returns the prompt.
 */
export function framePrompt(board: Storyboard, frame: Frame): string {
  const words = frame.prompt.toLowerCase()
  const cast = (board.characters ?? []).filter(character => words.includes(character.name.toLowerCase()))
  const parts = [frame.prompt.replace(/[.\s]+$/u, '') + '.']
  for (const character of cast) parts.push(`${character.name}: ${character.look.replace(/[.\s]+$/u, '')}.`)
  if (board.style !== undefined) parts.push(`Style: ${board.style.replace(/[.\s]+$/u, '')}.`)
  return parts.join(' ')
}

/**
 * The prompt that turns a scene's start frame into its end frame, so both show the same place and people.
 * @param board - the storyboard.
 * @param scene - the scene.
 * @returns the edit prompt.
 */
export function endEditPrompt(board: Storyboard, scene: Scene): string {
  const action = scene.action === undefined ? '' : ` What happened: ${scene.action.replace(/[.\s]+$/u, '')}.`
  return `The same scene, the same characters and the same style, a moment later.${action} Now: ${framePrompt(board, scene.end)} Keep each character's look, the setting and the framing.`
}

/** The folder a storyboard's frames are drawn into. */
export function framesFolder(storyboardPath: string): string {
  return join(dirname(storyboardPath), `${basename(storyboardPath, STORYBOARD_SUFFIX)}.frames`)
}

/** A frame's picture path, relative to the storyboard. */
export function frameImage(storyboardPath: string, scene: Scene, kind: FrameKind, extension: string): string {
  return `${basename(framesFolder(storyboardPath))}/${scene.id}-${kind}.${extension}`
}

/** A frame still to draw. */
export interface PendingFrame {
  readonly scene: Scene
  readonly kind: FrameKind
}

/**
 * The frames a run draws, in order: every frame of the chosen scenes (all, or one) that has no picture, or all of
 * them when redrawing.
 * @param board - the storyboard.
 * @param options - one scene, and whether to redraw frames that already have a picture.
 * @returns the frames, start before end within a scene.
 */
export function framesToDraw(board: Storyboard, options: { scene?: string; redraw?: boolean } = {}): PendingFrame[] {
  const scenes = options.scene === undefined ? board.scenes : board.scenes.filter(scene => scene.id === options.scene)
  if (options.scene !== undefined && scenes.length === 0) throw new Error(`no scene "${options.scene}" in this storyboard`)
  const pending: PendingFrame[] = []
  for (const scene of scenes) {
    for (const kind of ['start', 'end'] as const) {
      const frame = scene[kind]
      if (options.redraw === true || frame.image === undefined || frame.status !== 'done') pending.push({ scene, kind })
    }
  }
  return pending
}

/** Whether a path names a storyboard file. */
export function isStoryboardPath(path: string): boolean {
  return path.toLowerCase().endsWith(STORYBOARD_SUFFIX)
}
