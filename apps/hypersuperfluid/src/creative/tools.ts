/**
 * The Creative tools for the agent: `storyboard_save` writes a checked storyboard file (keeping the pictures of frames
 * whose words did not change), and `storyboard_draw` starts drawing its frames, the same as the board's Proceed
 * button. They use the drawer the host-level `hsf-creative` plugin provides.
 * @module hypersuperfluid/creative/tools
 */

import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from './index.ts'
import { readStoryboard, writeStoryboard } from './drawer.ts'
import { ASPECTS, isStoryboardPath, parseStoryboard, STORYBOARD_SUFFIX, type Storyboard } from './storyboard.ts'

/** Cordis plugin name. */
export const name = 'hsf-creative-tools'
/** Services this plugin needs. */
export const inject = ['tools', 'hsfCreative']

/** What the agent is told about the storyboard format. */
export const STORYBOARD_SAVE_DESCRIPTION = [
  `Write a storyboard file (${STORYBOARD_SUFFIX}) that the app shows as a board of scenes, each with a start frame and an end frame.`,
  'The person reviews it there and presses Proceed to have the frames drawn in their own Google Flow or Grok Imagine account.',
  `storyboard: {title, aspect (${ASPECTS.join(' | ')}), style?: the look every frame shares (medium, palette, lighting, lens),`,
  'characters?: [{name, look}] (a frame whose prompt names a character gets their look added),',
  'scenes: [{id (letters, digits, - and _; keep ids stable across saves), title, action?: what happens between the frames, seconds?,',
  'start: {prompt}, end: {prompt}}]}.',
  'Write each prompt as a picture prompt: subject, setting, composition and camera, in one or two sentences; the end frame is drawn by',
  'changing the start frame, so its prompt says what is different a moment later.',
  'Saving again keeps the pictures of frames whose prompt did not change; a changed prompt clears its picture so it is drawn again.',
].join(' ')

/** Keeps the drawing state of frames whose prompt is unchanged. */
export function carryPictures(next: Storyboard, previous: Storyboard | undefined): Storyboard {
  if (previous === undefined) return next
  for (const scene of next.scenes) {
    const before = previous.scenes.find(item => item.id === scene.id)
    if (before === undefined) continue
    for (const kind of ['start', 'end'] as const) {
      const frame = scene[kind]
      const old = before[kind]
      if (frame.image !== undefined || frame.status !== undefined) continue
      // A changed start frame changes the end frame drawn from it.
      const stale = old.prompt !== frame.prompt || (kind === 'end' && before.start.prompt !== scene.start.prompt)
      if (stale || old.image === undefined) continue
      frame.image = old.image
      if (old.status !== undefined) frame.status = old.status
      if (old.source !== undefined) frame.source = old.source
    }
  }
  return next
}

/**
 * @param ctx - the agent's composition.
 */
export function apply(ctx: Context): void {
  const creative = ctx.hsfCreative
  const pathOf = (path: string, agent: { session: never } | undefined): string => {
    const cwd = (agent === undefined ? undefined : ctx.get('workingDirectory')?.get(agent.session)) ?? process.cwd()
    const full = isAbsolute(path) ? path : resolve(cwd, path)
    if (!isStoryboardPath(full)) throw new Error(`A storyboard file name ends in ${STORYBOARD_SUFFIX}.`)
    return full
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'storyboard_save',
    description: STORYBOARD_SAVE_DESCRIPTION,
    parameters: {
      path: { type: 'string', required: true, description: `The file, ending in ${STORYBOARD_SUFFIX}, absolute or relative to the working folder.` },
      storyboard: { type: 'json', required: true, description: 'The whole storyboard, as described above.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const path = pathOf(args.path, exec.agent as never)
      const board = parseStoryboard(typeof args.storyboard === 'string' ? JSON.parse(args.storyboard) as unknown : args.storyboard)
      const previous = existsSync(path) ? await readStoryboard(path).catch(() => undefined) : undefined
      await mkdir(dirname(path), { recursive: true })
      await writeStoryboard(path, carryPictures(board, previous))
      const kept = board.scenes.flatMap(scene => [scene.start, scene.end]).filter(frame => frame.image !== undefined).length
      return JSON.stringify({
        path, scenes: board.scenes.length, framesKept: kept,
        next: 'Present the file so the person can open the board; they press Proceed there to draw the frames. Call storyboard_draw only when they ask you to draw.',
      })
    },
  })), 'hsf-creative: storyboard_save tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'storyboard_draw',
    description: 'Start drawing a storyboard\'s missing frames in the person\'s Google Flow or Grok Imagine window, the same as the board\'s Proceed button. Only when the person asks you to draw. It returns at once; the board shows progress. Call it again to see how far it got.',
    parameters: {
      path: { type: 'string', required: true, description: `The ${STORYBOARD_SUFFIX} file.` },
      scene: { type: 'string', description: 'One scene id only.' },
      redraw: { type: 'boolean', description: 'Draw again frames that already have a picture.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const path = pathOf(args.path, exec.agent as never)
      const [flow, grok] = await Promise.all([creative.flow.state(), creative.grok.state()])
      if (flow !== 'ready' && grok !== 'ready') {
        const note = 'Neither Flow nor Grok Imagine is ready. Ask the person to press "Open Flow" (sign in, open a project) or "Open Grok" on the board, then try again.'
        return JSON.stringify({ started: false, flow, grok, note })
      }
      const run = await creative.drawer.start(path, {
        ...args.scene === undefined ? {} : { scene: args.scene },
        ...args.redraw === undefined ? {} : { redraw: args.redraw },
      })
      return JSON.stringify({ flow, grok, run })
    },
  })), 'hsf-creative: storyboard_draw tool')
}
