/**
 * Office editors: ONLYOFFICE's Word, Excel, PowerPoint and PDF editors inside the app, editable by hand and from chat.
 *
 * - The app opens a file in an editor through the owner-only route `GET /api/hsf/office/open?path=…`, which answers
 *   with the editor page's address on the local editor server (`server.ts`).
 * - `office_documents` lists the documents open in an editor; `office_edit` runs Office JavaScript (ONLYOFFICE's
 *   document API, the one its plugins and macros use) in one of them, so a change asked for in chat appears in the
 *   open document and is saved to the file.
 * @module hypersuperfluid/office-editor
 */

import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import { EditorServer, editorKind } from './server.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The local Office editor server: open documents and the scripts sent to them. */
    hsfOfficeEditor: EditorServer
  }
}

/** Cordis plugin name. */
export const name = 'hsf-office-editor'
/** Services this plugin needs; the app route waits for the optional `connection`. It provides `hsfOfficeEditor`. */
export const inject: string[] = []

/** Settings. */
export interface Config {
  /** The built editors; defaults to `office-editor/` in the bundle. */
  assets?: string
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  assets: z.string(),
})

/**
 * Where the built editors are: beside `lib/` once packaged, at the bundle root from the source tree.
 * @returns the folder.
 */
export function defaultAssets(): string {
  // From lib/ the editors are one folder up; from src/office-editor/ (running from source) two.
  for (const relative of ['../office-editor/', '../../office-editor/']) {
    const path = fileURLToPath(new URL(relative, import.meta.url))
    if (existsSync(join(path, 'editor.html'))) return path
  }
  return fileURLToPath(new URL('../office-editor/', import.meta.url))
}

/**
 * @param ctx - the host composition.
 * @param config - settings.
 */
export function apply(ctx: Context, config: Config): void {
  const server = new EditorServer(config.assets ?? defaultAssets())
  ctx.effect(() => () => { void server.close() }, 'hsf-office-editor: server')

  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/hsf/office/open',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const params = new URL(request.url).searchParams
        const path = params.get('path') ?? ''
        if (!isAbsolute(path) || path.includes('\0')) return Response.json({ error: 'absolute path required' }, { status: 400 })
        if (editorKind(path) === undefined) return Response.json({ error: 'no editor for this kind of file' }, { status: 415 })
        if (!existsSync(path)) return Response.json({ error: 'not found' }, { status: 404 })
        if (!server.available) return Response.json({ error: 'The Office editors are not part of this build.' }, { status: 503 })
        const { url, document } = await server.openDocument(path, params.get('theme') === 'dark' ? 'dark' : 'light')
        return Response.json({ url, kind: document.kind }, { headers: { 'cache-control': 'no-store' } })
      },
    }), 'hsf-office-editor: /api/hsf/office/open')
  })

  ctx.provide('hsfOfficeEditor', server)
}
