/**
 * The local server behind the Office editors. It serves ONLYOFFICE's editors (built from ranuts/document by the
 * "Office editor" workflow into `office-editor/`) and a small host page per open document, all on 127.0.0.1.
 *
 * Each document gets a random token. With it, the page in the editor frame can only:
 * - read that one file (`GET /hsf/doc/<id>/file`),
 * - save it back (`POST /hsf/doc/<id>/save`), refused when the file changed on disk since it was loaded,
 * - take the agent's next script for it (`GET /hsf/doc/<id>/next`, a long poll) and report the result
 *   (`POST /hsf/doc/<id>/result`).
 * The editor's static files carry no secrets and are served to anyone who can reach 127.0.0.1.
 * @module hypersuperfluid/office-editor/server
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, extname, join, normalize, sep } from 'node:path'
import { hostPage } from './page.ts'

/** What kind of editor a file opens in. */
export type EditorKind = 'word' | 'cell' | 'slide' | 'pdf'

const KINDS: Readonly<Record<string, EditorKind>> = {
  docx: 'word', doc: 'word', odt: 'word', rtf: 'word', txt: 'word',
  xlsx: 'cell', xls: 'cell', ods: 'cell', csv: 'cell',
  pptx: 'slide', ppt: 'slide', odp: 'slide',
  pdf: 'pdf',
}

/** File suffixes the editors open. */
export const EDITOR_EXTENSIONS = Object.keys(KINDS)

/** The editor kind of a path, or undefined. */
export function editorKind(path: string): EditorKind | undefined {
  return KINDS[extname(path).slice(1).toLowerCase()]
}

/** A file's freshness token: modification time and size. */
export async function versionOf(path: string): Promise<string> {
  const info = await stat(path)
  return `${String(Math.trunc(info.mtimeMs))}-${String(info.size)}`
}

/** A script the agent sent to an open document. */
interface Command {
  readonly id: string
  readonly script: string
  readonly resolve: (result: CommandResult) => void
}

/** What running a script gave. */
export type CommandResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }

/** One document open in an editor. */
export interface OpenDocument {
  readonly id: string
  readonly path: string
  readonly kind: EditorKind
  readonly token: string
  readonly openedAt: number
  /** The version the editor last loaded or saved. */
  version: string
  /** When the editor page last asked for work; a page that stopped asking is gone. */
  lastSeen: number
  readonly queue: Command[]
  readonly pending: Map<string, Command>
  waiter: ((command: Command | undefined) => void) | undefined
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json', '.map': 'application/json', '.bin': 'application/octet-stream',
}

/** A page that has not polled for this long is treated as closed. */
const STALE_MS = 90_000
/** How long one long poll waits before answering "nothing yet". */
const POLL_MS = 25_000
/** The largest file the editor loads or saves. */
const MAX_FILE_BYTES = 200 * 1024 * 1024

/**
 * Resolves a request path inside a folder, refusing anything that would land outside it.
 * @param root - the folder.
 * @param requestPath - the URL path, already decoded.
 * @returns the absolute file path, or undefined.
 */
export function assetPath(root: string, requestPath: string): string | undefined {
  const cleaned = requestPath.replace(/\\/gu, '/').replace(/^\/+/u, '')
  if (cleaned.split('/').some(part => part === '..')) return undefined
  const base = normalize(root).replace(/[\\/]+$/u, '')
  const target = normalize(join(base, cleaned))
  return target.startsWith(base + sep) ? target : undefined
}

/** The editor server. It starts on first use and stops with the plugin. */
export class EditorServer {
  private server: Server | undefined
  private starting: Promise<string> | undefined
  private readonly documents = new Map<string, OpenDocument>()

  constructor(private readonly assets: string) {}

  /** Whether the built editors are present. */
  get available(): boolean {
    return existsSync(join(this.assets, 'editor.html'))
  }

  /** The documents an editor page is showing now. */
  open(): readonly OpenDocument[] {
    const now = Date.now()
    return [...this.documents.values()].filter(document => now - document.lastSeen < STALE_MS)
  }

  /** The open document for a path, matched case-insensitively on Windows. */
  find(path: string): OpenDocument | undefined {
    const wanted = process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path)
    return this.open().find(document => (process.platform === 'win32' ? normalize(document.path).toLowerCase() : normalize(document.path)) === wanted)
  }

  /**
   * Prepares an editor page for a file.
   * @param path - the file's absolute path.
   * @param theme - the app's light or dark mode.
   * @returns the page's address.
   */
  async openDocument(path: string, theme: 'light' | 'dark'): Promise<{ url: string; document: OpenDocument }> {
    const kind = editorKind(path)
    if (kind === undefined) throw new Error(`no editor for ${basename(path)}`)
    const base = await this.start()
    const document: OpenDocument = {
      id: randomUUID(), path, kind, token: randomBytes(24).toString('base64url'), openedAt: Date.now(),
      version: await versionOf(path), lastSeen: Date.now(), queue: [], pending: new Map(), waiter: undefined,
    }
    this.documents.set(document.id, document)
    const query = new URLSearchParams({ doc: document.id, t: document.token, theme })
    return { url: `${base}/hsf/editor?${query.toString()}`, document }
  }

  /**
   * Runs a script in an open document's editor and waits for its result.
   * @param document - the document.
   * @param script - Office JavaScript (ONLYOFFICE's document API) for the body of a function.
   * @param timeoutMs - how long to wait.
   * @param signal - cancellation.
   * @returns the result.
   */
  run(document: OpenDocument, script: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (result: CommandResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        document.pending.delete(command.id)
        const queued = document.queue.indexOf(command)
        if (queued >= 0) document.queue.splice(queued, 1)
        resolve(result)
      }
      const command: Command = { id: randomUUID(), script, resolve: finish }
      const timer = setTimeout(() => {
        finish({ ok: false, error: 'The editor did not answer in time. Is the document still open in the side panel?' })
      }, timeoutMs)
      signal?.addEventListener('abort', () => { finish({ ok: false, error: 'cancelled' }) }, { once: true })
      document.pending.set(command.id, command)
      const waiter = document.waiter
      document.waiter = undefined
      if (waiter === undefined) document.queue.push(command)
      else waiter(command)
    })
  }

  /** Stops the server. */
  close(): Promise<void> {
    for (const document of this.documents.values()) {
      document.waiter?.(undefined)
      for (const command of document.pending.values()) command.resolve({ ok: false, error: 'The editor closed.' })
    }
    this.documents.clear()
    const server = this.server
    this.server = undefined
    this.starting = undefined
    if (server === undefined) return Promise.resolve()
    return new Promise((done) => { server.close(() => { done() }); server.closeAllConnections() })
  }

  private start(): Promise<string> {
    this.starting ??= new Promise((done, reject) => {
      const server = createServer((request, response) => {
        this.handle(request, response).catch((error: unknown) => {
          if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' })
          response.end(error instanceof Error ? error.message : String(error))
        })
      })
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        this.server = server
        server.unref()
        done(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`)
      })
    })
    return this.starting
  }

  private documentOf(url: URL, id: string): OpenDocument | undefined {
    const document = this.documents.get(id)
    const token = url.searchParams.get('t') ?? ''
    if (document === undefined) return undefined
    const have = Buffer.from(document.token)
    const wanted = Buffer.from(token)
    return have.length === wanted.length && timingSafeEqual(have, wanted) ? document : undefined
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/hsf/editor') {
      const document = this.documentOf(url, url.searchParams.get('doc') ?? '')
      if (document === undefined) { response.writeHead(403).end('This editor link has expired. Open the file again.'); return }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(hostPage({ id: document.id, token: document.token, kind: document.kind, name: basename(document.path), theme: url.searchParams.get('theme') === 'dark' ? 'dark' : 'light' }))
      return
    }
    const route = /^\/hsf\/doc\/([0-9a-f-]{36})\/(file|save|next|result)$/u.exec(url.pathname)
    if (route !== null) {
      const document = this.documentOf(url, route[1] as string)
      if (document === undefined) { response.writeHead(403).end(); return }
      document.lastSeen = Date.now()
      await this.documentRoute(document, route[2] as 'file' | 'save' | 'next' | 'result', request, response)
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return }
    let pathname = decodeURIComponent(url.pathname)
    // The editor is served at `/office`, not its own `/editor`: at `/editor` it first waits up to 15 s for its
    // offline service worker to take over the page. That worker is refused here: this server takes a new port each
    // run, so each run would install another worker with its own large cache, and it would sit in front of `/hsf/`.
    // `/editor` stays an alias: the editor probes it for headers.
    if (pathname === '/office' || pathname === '/editor') pathname = '/editor.html'
    if (pathname === '/sw.js') { response.writeHead(404).end(); return }
    const file = assetPath(this.assets, pathname)
    if (file === undefined || !existsSync(file) || !statSync(file).isFile()) { response.writeHead(404).end(); return }
    // The build ships the x2t converter pre-compressed (`x2t.wasm.br`) and expects the server to declare it, so the
    // browser decodes it on the way in (the same rule as its own `_headers`).
    const brotli = file.endsWith('.br')
    response.writeHead(200, {
      'content-type': brotli ? 'application/octet-stream' : MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=86400',
      ...brotli ? { 'content-encoding': 'br' } : {},
    })
    if (request.method === 'HEAD') { response.end(); return }
    createReadStream(file).pipe(response)
  }

  private async documentRoute(document: OpenDocument, action: 'file' | 'save' | 'next' | 'result', request: IncomingMessage, response: ServerResponse): Promise<void> {
    switch (action) {
      case 'file': {
        const data = await readFile(document.path)
        document.version = await versionOf(document.path)
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-hsf-version': document.version })
        response.end(data)
        return
      }
      case 'save': {
        if (request.method !== 'POST') { response.writeHead(405).end(); return }
        const body = await readBody(request, MAX_FILE_BYTES)
        const current = await versionOf(document.path)
        if (current !== document.version) {
          response.writeHead(409, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'The file changed on disk after it was opened.', version: current }))
          return
        }
        const temp = `${document.path}.hsf-${randomBytes(4).toString('hex')}.tmp`
        await writeFile(temp, body)
        await rename(temp, document.path)
        document.version = await versionOf(document.path)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ version: document.version }))
        return
      }
      case 'next': {
        const next = document.queue.shift()
        // Each answer carries the file's version on disk now, so the page can tell when something else changed it.
        const answer = async (command: Command | undefined): Promise<void> => {
          const version = await versionOf(document.path).catch(() => document.version)
          if (response.writableEnded || response.destroyed) {
            // The page went away while the version was read: keep the script for its next poll.
            if (command !== undefined && document.pending.has(command.id)) document.queue.unshift(command)
            return
          }
          if (command === undefined) { response.writeHead(204, { 'x-hsf-version': version }).end(); return }
          response.writeHead(200, { 'content-type': 'application/json', 'x-hsf-version': version })
          response.end(JSON.stringify({ id: command.id, script: command.script }))
        }
        if (next !== undefined) { await answer(next); return }
        document.waiter?.(undefined)
        const timer = setTimeout(() => {
          if (document.waiter === wait) document.waiter = undefined
          void answer(undefined)
        }, POLL_MS)
        const wait = (command: Command | undefined): void => { clearTimeout(timer); void answer(command) }
        document.waiter = wait
        request.on('close', () => {
          if (document.waiter !== wait) return
          document.waiter = undefined
          clearTimeout(timer)
        })
        return
      }
      case 'result': {
        if (request.method !== 'POST') { response.writeHead(405).end(); return }
        const message = JSON.parse((await readBody(request, 8 * 1024 * 1024)).toString('utf8')) as { id?: string; ok?: boolean; value?: unknown; error?: string }
        const command = message.id === undefined ? undefined : document.pending.get(message.id)
        command?.resolve(message.ok === true ? { ok: true, value: message.value } : { ok: false, error: message.error ?? 'The script failed.' })
        response.writeHead(204).end()
        return
      }
    }
  }
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) throw new Error('The request is too large.')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}
