/**
 * Apps: Word, Excel, PowerPoint and Storyboard as apps in the app's sidebar. The page lists a folder's files for each
 * app and makes new ones; a file opens in the chat's side panel (the Office editor, or the storyboard board), where
 * what the person asks in chat is carried out (`tools.ts` tells the agent what is open there).
 *
 * Owner-only routes:
 * - `GET /api/hsf/apps/files?dir=…`: the folder's files for each app, newest first;
 * - `POST /api/hsf/apps/new?dir=…&app=word|excel|powerpoint|storyboard[&name=…]`: makes a blank file there.
 * @module hypersuperfluid/apps
 */

import { existsSync, statSync } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import { defaultAssets } from '../office-editor/index.ts'
import { APPS, appOf, blankFile, type AppId } from './blank.ts'

/** Cordis plugin name. */
export const name = 'hsf-apps'
/** Services this plugin needs; the routes wait for the optional `connection`. */
export const inject: string[] = []

/** Settings. */
export interface Config {
  /** The Office editor build, for blank decks; defaults to the bundle's. */
  editorAssets?: string
  /** How many folders deep the file list looks. */
  depth?: number
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  editorAssets: z.string(),
  depth: z.natural().default(3),
})

/** One file an app opens. */
export interface AppFile {
  readonly path: string
  readonly name: string
  readonly app: AppId
  readonly modified: number
}

const SKIPPED = new Set(['node_modules', '__pycache__', 'venv', '.venv', 'dist', 'build'])
const LIMIT = 300

/**
 * The files the apps open in a folder and its subfolders, newest first.
 * @param root - the folder.
 * @param depth - how many folders deep to look.
 * @returns the files.
 */
export async function appFiles(root: string, depth: number): Promise<AppFile[]> {
  const found: AppFile[] = []
  const walk = async (folder: string, level: number): Promise<void> => {
    if (found.length >= LIMIT) return
    let entries
    try { entries = await readdir(folder, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (found.length >= LIMIT) return
      // Hidden folders, build output and a storyboard's own frames folder hold nothing to open.
      if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue
      const path = join(folder, entry.name)
      if (entry.isDirectory()) {
        if (level < depth && !SKIPPED.has(entry.name) && !entry.name.endsWith('.frames')) await walk(path, level + 1)
        continue
      }
      const app = entry.isFile() ? appOf(entry.name) : undefined
      if (app === undefined) continue
      const info = await stat(path).catch(() => undefined)
      if (info !== undefined) found.push({ path, name: entry.name, app, modified: Math.trunc(info.mtimeMs) })
    }
  }
  await walk(root, 0)
  return found.sort((left, right) => right.modified - left.modified)
}

/**
 * A free file name for a new file: the asked name made safe, with the app's suffix, numbered when taken.
 * @param folder - where it goes.
 * @param app - which app.
 * @param asked - the name the person typed, if any.
 * @returns the absolute path.
 */
export function newFilePath(folder: string, app: AppId, asked: string | undefined): string {
  const suffix = `.${APPS[app].extension}`
  let stem = (asked ?? '').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (stem.toLowerCase().endsWith(suffix)) stem = stem.slice(0, -suffix.length).trim()
  stem = stem.replace(/[. ]+$/u, '').slice(0, 120)
  if (stem === '') stem = app === 'storyboard' ? 'Storyboard' : `Untitled ${APPS[app].label}`
  for (let n = 1; ; n++) {
    const path = join(folder, `${n === 1 ? stem : `${stem} (${String(n)})`}${suffix}`)
    if (!existsSync(path)) return path
  }
}

/**
 * @param ctx - the host composition.
 * @param config - settings.
 */
export function apply(ctx: Context, config: Config): void {
  const assets = config.editorAssets ?? defaultAssets()
  const folderOf = (url: URL): string | Response => {
    const dir = url.searchParams.get('dir') ?? ''
    if (!isAbsolute(dir) || dir.includes('\0')) return Response.json({ error: 'absolute folder required' }, { status: 400 })
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return Response.json({ error: 'not a folder' }, { status: 404 })
    return dir
  }
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/hsf/apps/files', methods: ['GET'], requestBody: 'buffered',
      fetch: async (request) => {
        const dir = folderOf(new URL(request.url))
        if (typeof dir !== 'string') return dir
        return Response.json({ files: await appFiles(dir, config.depth ?? 3) }, { headers: { 'cache-control': 'no-store' } })
      },
    }), 'hsf-apps: /api/hsf/apps/files')
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/hsf/apps/new', methods: ['POST'], requestBody: 'buffered',
      fetch: async (request) => {
        const url = new URL(request.url)
        const dir = folderOf(url)
        if (typeof dir !== 'string') return dir
        const app = url.searchParams.get('app')
        if (app === null || !(app in APPS)) return Response.json({ error: 'app must be word, excel, powerpoint or storyboard' }, { status: 400 })
        const path = newFilePath(dir, app as AppId, url.searchParams.get('name') ?? undefined)
        try {
          await writeFile(path, await blankFile(app as AppId, basename(path, `.${APPS[app as AppId].extension}`), assets), { flag: 'wx' })
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 })
        }
        return Response.json({ path, app })
      },
    }), 'hsf-apps: /api/hsf/apps/new')
  })
}
