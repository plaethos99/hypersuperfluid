/**
 * Creative: storyboards drawn in Google Flow and Grok Imagine. The agent in Creative mode writes a storyboard file
 * (`*.storyboard.json`, see `storyboard.ts`); the app shows it as a board, and its Proceed button draws each scene's
 * start and end frames in the person's own Flow or Grok account, in browser windows of their own (`browser.ts`).
 *
 * Owner-only routes behind the board's buttons:
 * - `GET /api/hsf/creative/status?path=…`: whether Flow and Grok are ready, and the file's drawing run;
 * - `POST /api/hsf/creative/open?service=flow|grok`: shows the service's window, launching it if needed;
 * - `POST /api/hsf/creative/draw?path=…[&scene=…][&redraw=1]`: starts drawing the frames still missing (or one
 *   scene's, or redraws);
 * - `POST /api/hsf/creative/stop?path=…`: stops after the frame being drawn.
 * @module hypersuperfluid/creative
 */

import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import { hsfHome } from '../home.ts'
import { ServiceBrowser } from './browser.ts'
import { StoryboardDrawer } from './drawer.ts'
import { Flow, FLOW_URL } from './flow.ts'
import { Grok, GROK_URL } from './grok.ts'
import { isStoryboardPath } from './storyboard.ts'

/** The Creative service: the two picture services and the drawer. */
export interface CreativeService {
  readonly flow: Flow
  readonly grok: Grok
  readonly drawer: StoryboardDrawer
  /** The storyboards a board in the app is showing now (it asks for their status every few seconds). */
  openBoards(): string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Storyboards and the picture services that draw them. */
    hsfCreative: CreativeService
  }
}

/** A board that has not asked for its status for this long is closed (it asks every 10 s at most). */
const BOARD_STALE_MS = 30_000

/** Cordis plugin name. */
export const name = 'hsf-creative'
/** Services this plugin needs; the routes wait for the optional `connection`. It provides `hsfCreative`. */
export const inject: string[] = []

/** Settings. */
export interface Config {
  /** Where the browser profiles live; defaults to `creative/` in the bundle's state folder. */
  home?: string
  /** The browser to run Flow and Grok in; defaults to Edge, then Chrome. */
  browser?: string
  /** DevTools port of the Flow window. */
  flowPort?: number
  /** DevTools port of the Grok Imagine window. */
  grokPort?: number
  /** Which service draws first. */
  prefer?: 'flow' | 'grok'
  /** How long a Flow CAPTCHA is given to be answered, in seconds. */
  captchaWaitSeconds?: number
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  home: z.string(),
  browser: z.string(),
  // Not BookShorts' ports (9334, 9360), so both apps can run side by side with their own windows.
  flowPort: z.natural().default(9434),
  grokPort: z.natural().default(9460),
  prefer: z.union(['flow', 'grok'] as const).default('flow'),
  captchaWaitSeconds: z.natural().default(60),
})

/**
 * @param ctx - the host composition.
 * @param config - settings.
 */
export function apply(ctx: Context, config: Config): void {
  const home = join(hsfHome(config.home), 'creative')
  const executable = config.browser === undefined ? {} : { executable: config.browser }
  const flow = new Flow(new ServiceBrowser({
    label: 'Google Flow', port: config.flowPort ?? 9434, profile: join(home, 'flow-profile'), home: FLOW_URL, ...executable,
  }))
  const grok = new Grok(new ServiceBrowser({
    label: 'Grok Imagine', port: config.grokPort ?? 9460, profile: join(home, 'grok-profile'), home: GROK_URL, ...executable,
  }))
  const shown = new Map<string, number>()
  const drawer = new StoryboardDrawer({ flow, grok }, { prefer: config.prefer ?? 'flow', captchaWaitMs: (config.captchaWaitSeconds ?? 60) * 1000 })
  ctx.effect(() => () => { drawer.stopAll() }, 'hsf-creative: stop drawing')

  const storyboardOf = (url: URL): string | Response => {
    const path = url.searchParams.get('path') ?? ''
    if (!isAbsolute(path) || path.includes('\0')) return Response.json({ error: 'absolute path required' }, { status: 400 })
    if (!isStoryboardPath(path)) return Response.json({ error: 'not a .storyboard.json file' }, { status: 415 })
    if (!existsSync(path)) return Response.json({ error: 'not found' }, { status: 404 })
    return path
  }
  const failure = (error: unknown): Response =>
    Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 })

  ctx.inject(['connection'], (scope) => {
    const route = (path: string, method: 'GET' | 'POST', fetch: (url: URL) => Promise<Response>): void => {
      scope.effect(() => scope.connection.fetch.register({
        path, methods: [method], requestBody: 'buffered',
        fetch: request => fetch(new URL(request.url)).catch(failure),
      }), `hsf-creative: ${path}`)
    }
    route('/api/hsf/creative/status', 'GET', async (url) => {
      const [flowState, grokState] = await Promise.all([flow.state(), grok.state()])
      const path = url.searchParams.get('path')
      if (path !== null && isAbsolute(path) && isStoryboardPath(path)) shown.set(path, Date.now())
      const run = path === null || path === '' ? undefined : drawer.status(path)
      return Response.json({ flow: flowState, grok: grokState, run: run ?? null }, { headers: { 'cache-control': 'no-store' } })
    })
    route('/api/hsf/creative/open', 'POST', async (url) => {
      const service = url.searchParams.get('service')
      if (service !== 'flow' && service !== 'grok') return Response.json({ error: 'service must be flow or grok' }, { status: 400 })
      await (service === 'flow' ? flow : grok).browser.open()
      return Response.json({ ok: true })
    })
    route('/api/hsf/creative/draw', 'POST', async (url) => {
      const path = storyboardOf(url)
      if (typeof path !== 'string') return path
      const scene = url.searchParams.get('scene') ?? ''
      const options = { ...scene === '' ? {} : { scene }, redraw: url.searchParams.get('redraw') === '1' }
      return Response.json({ run: await drawer.start(path, options) })
    })
    route('/api/hsf/creative/stop', 'POST', (url) => {
      const path = storyboardOf(url)
      if (typeof path !== 'string') return Promise.resolve(path)
      drawer.stop(path)
      return Promise.resolve(Response.json({ ok: true }))
    })
  })

  const openBoards = (): string[] => {
    const now = Date.now()
    return [...shown].filter(([path, seen]) => now - seen < BOARD_STALE_MS && existsSync(path)).map(([path]) => path)
  }
  ctx.provide('hsfCreative', { flow, grok, drawer, openBoards })
}
