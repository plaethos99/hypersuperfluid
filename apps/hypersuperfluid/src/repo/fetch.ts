/**
 * Gets a codebase onto disk: clones a git URL (shallow), unpacks a downloaded archive, or takes a folder as it is, and
 * finds the codebases the person downloaded recently. Nothing is overwritten: a second copy gets a new folder name.
 * @module hypersuperfluid/repo/fetch
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { isCodebase } from './survey.ts'

const run = promisify(execFile)

/** What a source is. */
export type SourceKind = 'git' | 'archive' | 'folder'

const ARCHIVE = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tar\.xz)$/iu

/** A git host URL as owner and repo, or undefined. */
export function gitUrl(source: string): { url: string; name: string; owner?: string; host?: string } | undefined {
  const trimmed = source.trim().replace(/\/+$/u, '')
  const ssh = /^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/u.exec(trimmed)
  if (ssh?.[1] !== undefined && ssh[2] !== undefined && ssh[3] !== undefined) {
    return { url: trimmed, name: ssh[3], owner: ssh[2], host: ssh[1] }
  }
  let parsed: URL
  try { parsed = new URL(trimmed) } catch { return undefined }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
  const parts = parsed.pathname.split('/').filter(part => part.length > 0)
  const known = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)$/u.test(parsed.hostname)
  if (!known && !parsed.pathname.endsWith('.git')) return undefined
  if (parts.length < 2) return undefined
  const owner = parts[0] ?? ''
  const name = (parts[1] ?? '').replace(/\.git$/u, '')
  return { url: `${parsed.protocol}//${parsed.host}/${owner}/${name}.git`, name, owner, host: parsed.hostname }
}

/** What kind of source a string names, or undefined when it names nothing usable. */
export function sourceKind(source: string): SourceKind | undefined {
  if (gitUrl(source) !== undefined) return 'git'
  const path = resolve(source)
  if (!existsSync(path)) return undefined
  if (statSync(path).isDirectory()) return 'folder'
  return ARCHIVE.test(path) ? 'archive' : undefined
}

/** A folder name under `parent` that is not taken: `name`, then `name-2`, `name-3`… */
export function freeFolder(parent: string, name: string): string {
  const clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/gu, '-').trim() || 'repo'
  let candidate = join(parent, clean)
  for (let index = 2; existsSync(candidate); index += 1) candidate = join(parent, `${clean}-${String(index)}`)
  return candidate
}

/** An unpacked archive's real root: the one folder inside, when there is only one. */
export function unwrap(folder: string): string {
  const entries = readdirSync(folder).filter(entry => !entry.startsWith('.') && entry !== '__MACOSX')
  if (entries.length !== 1 || entries[0] === undefined) return folder
  const only = join(folder, entries[0])
  return statSync(only).isDirectory() ? only : folder
}

/** Where a fetch put the codebase. */
export interface Fetched {
  readonly root: string
  readonly kind: SourceKind
  readonly note: string
}

async function hasGit(): Promise<boolean> {
  try { await run('git', ['--version'], { timeout: 10_000, windowsHide: true }); return true } catch { return false }
}

async function extract(archive: string, into: string, signal: AbortSignal | undefined): Promise<void> {
  mkdirSync(into, { recursive: true })
  // bsdtar ships with Windows 10+ and macOS and reads zip too; GNU tar on Linux needs unzip for a zip.
  const isZip = /\.zip$/iu.test(archive)
  if (isZip && process.platform === 'linux') {
    await run('unzip', ['-q', archive, '-d', into], { timeout: 600_000, windowsHide: true, ...(signal === undefined ? {} : { signal }) })
    return
  }
  // On Windows, Windows' own bsdtar: a Git or MSYS tar earlier on PATH reads `C:` as a remote host.
  const systemTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  const tar = process.platform === 'win32' && existsSync(systemTar) ? systemTar : 'tar'
  await run(tar, ['-xf', archive, '-C', into], { timeout: 600_000, windowsHide: true, ...(signal === undefined ? {} : { signal }) })
}

/**
 * Gets a codebase onto disk.
 * @param source - a git URL, an archive's path, or a folder's path.
 * @param parent - where a clone or an unpacked archive goes.
 * @param signal - cancels the clone or download.
 * @returns where it is.
 */
export async function fetchRepo(source: string, parent: string, signal?: AbortSignal): Promise<Fetched> {
  const git = gitUrl(source)
  if (git !== undefined) {
    mkdirSync(parent, { recursive: true })
    const target = freeFolder(parent, git.name)
    if (await hasGit()) {
      await run('git', ['clone', '--depth', '1', git.url, target], { timeout: 900_000, windowsHide: true, ...(signal === undefined ? {} : { signal }) })
      return { root: target, kind: 'git', note: `Cloned ${git.url} (latest commit only; \`git fetch --unshallow\` gets the history).` }
    }
    if (git.host !== 'github.com' || git.owner === undefined) throw new Error('git is not installed. Install Git (git-scm.com), then try again.')
    const response = await fetch(`https://codeload.github.com/${git.owner}/${git.name}/zip/HEAD`, signal === undefined ? {} : { signal })
    if (!response.ok) throw new Error(`GitHub answered ${String(response.status)} for ${git.owner}/${git.name}: is the repository public and the name right?`)
    const archive = join(tmpdir(), `hsf-${git.name}-${String(Date.now())}.zip`)
    await writeFile(archive, Buffer.from(await response.arrayBuffer()))
    await extract(archive, target, signal)
    return { root: unwrap(target), kind: 'git', note: `Downloaded ${git.owner}/${git.name} as a zip (git is not installed, so this copy has no history).` }
  }
  const path = resolve(source)
  if (!existsSync(path)) throw new Error(`${source} is neither a git URL nor a file or folder on this computer.`)
  if (statSync(path).isDirectory()) return { root: path, kind: 'folder', note: 'Worked on in place.' }
  if (!ARCHIVE.test(path)) throw new Error(`${basename(path)} is not an archive (zip, tar, tar.gz) or a folder.`)
  mkdirSync(parent, { recursive: true })
  const target = freeFolder(parent, basename(path).replace(ARCHIVE, '').replace(extname(path), ''))
  await extract(path, target, signal)
  return { root: unwrap(target), kind: 'archive', note: `Unpacked ${basename(path)}; the archive itself is left where it was.` }
}

/** A codebase or archive the person downloaded. */
export interface Download {
  readonly path: string
  readonly kind: 'archive' | 'folder'
  readonly modified: number
}

/** The usual Downloads folder. */
export function downloadsFolder(): string {
  return join(homedir(), 'Downloads')
}

/**
 * Codebases and archives in a folder changed in the last `days`, newest first: archives, and folders that hold a
 * codebase directly or one level down (an unpacked `repo-main/repo-main`).
 * @param folder - usually Downloads.
 * @param days - how far back.
 * @param limit - how many.
 * @returns what was found.
 */
export function recentDownloads(folder = downloadsFolder(), days = 30, limit = 10): Download[] {
  const since = Date.now() - days * 86_400_000
  const found: Download[] = []
  let names: string[]
  try { names = readdirSync(folder) } catch { return [] }
  for (const name of names) {
    if (name.startsWith('.')) continue
    const path = join(folder, name)
    let info
    try { info = statSync(path) } catch { continue }
    if (info.mtimeMs < since) continue
    if (info.isFile() && /\.(zip|tar\.gz|tgz)$/iu.test(name)) found.push({ path, kind: 'archive', modified: info.mtimeMs })
    else if (info.isDirectory()) {
      if (isCodebase(path)) found.push({ path, kind: 'folder', modified: info.mtimeMs })
      else {
        const inner = unwrapSafe(path)
        if (inner !== path && isCodebase(inner)) found.push({ path: inner, kind: 'folder', modified: info.mtimeMs })
      }
    }
  }
  return found.sort((left, right) => right.modified - left.modified).slice(0, limit)
}

function unwrapSafe(path: string): string {
  try { return unwrap(path) } catch { return path }
}
