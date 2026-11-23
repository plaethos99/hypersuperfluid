/**
 * The picture services' browser windows. Google Flow and Grok Imagine have no public API and Google refuses sign-in
 * inside app windows, so each runs in Microsoft Edge or Google Chrome, launched with a profile of its own (the
 * person's everyday profile, passwords and cookies are never touched) and the DevTools protocol on a local port.
 * The person signs in there once; the profile keeps the session. Nothing attaches while they sign in: the app only
 * reads the list of open tabs, and attaches to a tab only to draw.
 *
 * Ported from the BookShorts studio (`apps/studio/electron/flow.ts`), where this way of driving Flow and Grok was
 * worked out.
 * @module hypersuperfluid/creative/browser
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** One tab, as the DevTools protocol lists it. */
export interface Tab {
  readonly type: string
  readonly url: string
  readonly webSocketDebuggerUrl: string
}

/** Sends one protocol command. */
export type Send = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
/** Listens to the tab's protocol events; returns how to stop. */
export type Listen = (handler: (method: string, params: Record<string, unknown>) => void) => () => void

/** Where Edge and Chrome are installed, in the order tried. */
export function browserCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'win32') {
    return [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      join(env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    ]
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      join(env.HOME ?? '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ]
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser']
}

/** One service's browser: its profile folder, its protocol port, and the page it opens. */
export class ServiceBrowser {
  constructor(
    private readonly options: {
      /** What the person calls it, for messages. */
      readonly label: string
      readonly port: number
      readonly profile: string
      readonly home: string
      /** An explicit browser; otherwise Edge or Chrome where installed. */
      readonly executable?: string
    },
  ) {}

  /** The browser's open tabs, or undefined when it is not running. */
  async tabs(): Promise<Tab[] | undefined> {
    try {
      const response = await fetch(`http://127.0.0.1:${String(this.options.port)}/json`, { signal: AbortSignal.timeout(1500) })
      return await response.json() as Tab[]
    } catch {
      return undefined
    }
  }

  /**
   * Shows the window, launching the browser at `url` (or the service's home) when it is not running.
   * @param url - the page to open on a fresh launch.
   */
  async open(url = this.options.home): Promise<void> {
    const open = await this.tabs()
    if (open !== undefined) {
      const tab = open.find(item => item.type === 'page')
      if (tab !== undefined) await attach(tab, send => send('Page.bringToFront'))
      else await fetch(`http://127.0.0.1:${String(this.options.port)}/json/new?${url}`, { method: 'PUT' })
      return
    }
    const executable = this.options.executable !== undefined && this.options.executable !== ''
      ? this.options.executable
      : browserCandidates().find(path => existsSync(path))
    if (executable === undefined || !existsSync(executable)) {
      throw new Error(`${this.options.label} runs in Microsoft Edge or Google Chrome; neither was found.`)
    }
    spawn(executable, [
      `--remote-debugging-port=${String(this.options.port)}`,
      `--user-data-dir=${this.options.profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      // A fresh Edge profile signs in to the Windows account and syncs its data; this profile keeps none of it.
      '--disable-sync',
      // The service keeps working at full speed while its window is minimized or behind others.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      url,
    ], { detached: true, stdio: 'ignore' }).unref()
  }
}

/**
 * Attaches to a tab for the length of `work`.
 * @param tab - the tab.
 * @param work - what to do with it.
 * @returns what `work` returns.
 */
export async function attach<T>(tab: Tab, work: (send: Send, listen: Listen) => Promise<T>): Promise<T> {
  const socket = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve)
    socket.addEventListener('error', () => { reject(new Error('Could not connect to the browser window')) })
  })
  let next = 0
  // A lost connection never answers: without this a drawing would wait on it forever.
  const waiting = new Set<(error: Error) => void>()
  socket.addEventListener('close', () => { for (const fail of waiting) fail(new Error('The connection to the browser window was lost')) }, { once: true })
  const send: Send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++next
    const onMessage = (event: MessageEvent): void => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } }
      if (message.id !== mine) return
      socket.removeEventListener('message', onMessage)
      waiting.delete(reject)
      if (message.error !== undefined) reject(new Error(message.error.message))
      else resolve(message.result ?? {})
    }
    socket.addEventListener('message', onMessage)
    waiting.add(reject)
    socket.send(JSON.stringify({ id: mine, method, params }))
  })
  const listen: Listen = (handler) => {
    const onMessage = (event: MessageEvent): void => {
      const message = JSON.parse(String(event.data)) as { method?: string; params?: Record<string, unknown> }
      if (message.method !== undefined) handler(message.method, message.params ?? {})
    }
    socket.addEventListener('message', onMessage)
    return () => { socket.removeEventListener('message', onMessage) }
  }
  try {
    return await work(send, listen)
  } finally {
    socket.close()
  }
}

/**
 * Runs an expression in the page and returns its value; a thrown error comes back as an Error with its message.
 * @param send - the tab's protocol.
 * @param expression - JavaScript; promises are awaited.
 * @returns the value.
 */
export async function evaluate<T>(send: Send, expression: string): Promise<T> {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }) as {
    result?: { value?: T }
    exceptionDetails?: { exception?: { description?: string }; text?: string }
  }
  if (result.exceptionDetails !== undefined) {
    const raw = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'The page script failed'
    throw new Error((raw.split('\n')[0] ?? raw).replace(/^Error: /u, ''))
  }
  return result.result?.value as T
}

/** A native mouse click, which pages take as the person's own (they ignore scripted clicks on generate buttons). */
export async function clickAt(send: Send, at: { readonly x: number; readonly y: number }): Promise<void> {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
}

/** Puts a local file into the page's file input marked `data-bs-upload`. */
export async function uploadFile(send: Send, file: string, service: string): Promise<void> {
  const document = await send('DOM.getDocument', { depth: -1, pierce: true }) as { root: { nodeId: number } }
  const found = await send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '[data-bs-upload]' }) as { nodeId: number }
  if (found.nodeId === 0) throw new Error(`${service} has no picture upload on the page`)
  await send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [file] })
}

/** Runs work one at a time. */
export function serial(): <T>(work: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve()
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = last.catch(() => {}).then(work)
    last = run
    return run
  }
}
