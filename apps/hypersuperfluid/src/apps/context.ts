/**
 * Side panel context: before each model step the agent is told, without asking, what the person has open in the side
 * panel's apps (Word, Excel, PowerPoint and PDF files in the Office editor, storyboards on their board), what the
 * working folder holds (a codebase's kind, the apps' files) and which codebases or archives the person's message
 * points at (`@folder`, a path, a git link). So "make the title bigger", "add a scene at night" or "write up this repo
 * in the document" goes to the right file with no questions.
 *
 * A note is added only when what it says changed since the last one in that chat, so a long chat does not fill with
 * repeats. It is a context message, not a chat bubble.
 * @module hypersuperfluid/apps/context
 */

import { existsSync, statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '../office-editor/index.ts'
import type {} from '../creative/index.ts'
import { gitUrl } from '../repo/fetch.ts'
import { isCodebase, surveyLine, surveyRepo } from '../repo/survey.ts'
import { appFiles, type AppFile } from './index.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * What the side panel's apps, the working folder and the message's codebases hold.
     * @persistenceAttribution
     */
    'hsf-side-panel': { kind: 'hsf-side-panel' } & ContextFormed
  }
}

/** Cordis plugin name. */
export const name = 'hsf-side-panel-context'
/** Services this plugin needs. */
export const inject = ['agents']

const KIND = 'hsf-side-panel'
const OFFICE_LABEL = { word: 'Word', cell: 'Excel', slide: 'PowerPoint', pdf: 'PDF' } as const
const APP_LABEL = { word: 'Word', excel: 'Excel', powerpoint: 'PowerPoint', storyboard: 'Storyboard' } as const

/** One file open in a side-panel app. */
export interface PanelFile {
  readonly path: string
  readonly app: 'Word' | 'Excel' | 'PowerPoint' | 'PDF' | 'Storyboard'
}

/** Everything the note is made from. */
export interface PanelSnapshot {
  readonly open: readonly PanelFile[]
  readonly folder: string
  readonly folderKind?: string
  readonly folderFiles: readonly AppFile[]
  /** Codebases, archives and git links the person's latest message points at. */
  readonly referenced: readonly string[]
}

/** The text of the person's messages this step. */
export function messageText(messages: readonly UserMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const part of message.content) if (part.type === 'text') parts.push(part.text)
  }
  return parts.join('\n')
}

/** A quoted absolute path, or a bare one starting at a drive or a usual Unix root. */
const ABSOLUTE_PATH = new RegExp(String.raw`"((?:[A-Za-z]:[\\/]|\/)[^"\n]+)"`
  + String.raw`|(?:^|\s)((?:[A-Za-z]:[\\/]|\/(?:Users|home|tmp|opt|mnt|Volumes)\/)[^\s"'` + '`' + String.raw`<>|]+)`, 'gu')
/** A link to a repository on a known git host, or an ssh remote. */
const GIT_LINK = /(?:https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\/[^\s)>"']+|git@[^\s:]+:\S+)/gu

/**
 * The folders, archives and git links a message points at: `@path` and `@"path"` mentions, quoted or bare absolute
 * paths, and git host links.
 * @param text - the message.
 * @param cwd - for relative mentions.
 * @returns a line for each, saying what it is.
 */
export function referencedCodebases(text: string, cwd: string): string[] {
  const trim = (value: string): string => value.replace(/[\\/.,;:!?)]+$/u, '')
  const candidates = new Set<string>()
  for (const match of text.matchAll(/(?:^|\s)@(?:"([^"]+)"|(\S+))/gu)) candidates.add(trim(match[1] ?? match[2] ?? ''))
  for (const match of text.matchAll(ABSOLUTE_PATH)) candidates.add(trim(match[1] ?? match[2] ?? ''))
  const lines: string[] = []
  for (const link of text.matchAll(GIT_LINK)) {
    const url = trim(link[0])
    if (gitUrl(url) !== undefined && lines.length < 6) lines.push(`${url}: a git repository (repo_fetch clones it)`)
  }
  for (const candidate of candidates) {
    if (candidate.length === 0 || lines.length >= 6) continue
    const path = isAbsolute(candidate) ? candidate : resolve(cwd, candidate)
    let info
    try { info = statSync(path) } catch { continue }
    if (info.isDirectory()) {
      if (isCodebase(path)) lines.push(`${path}: ${surveyLine(surveyRepo(path))}`)
      else lines.push(`${path}: a folder`)
    } else if (/\.(zip|tar|tar\.gz|tgz)$/iu.test(path)) lines.push(`${path}: an archive (repo_fetch unpacks it)`)
  }
  return lines
}

/** The note the agent reads, or undefined when there is nothing worth saying. */
export function renderNote(snapshot: PanelSnapshot): string | undefined {
  const lines: string[] = []
  if (snapshot.open.length > 0) {
    lines.push('Open in the side panel right now:')
    for (const file of snapshot.open) {
      const how = file.app === 'Storyboard'
        ? 'read the file, then storyboard_save it whole with the same scene ids'
        : 'change it with office_edit; the person sees it at once and it saves itself'
      lines.push(`- ${file.app}: ${file.path} (${how})`)
    }
  } else {
    lines.push('Nothing is open in the side panel\'s apps.')
  }
  lines.push(`Working folder: ${snapshot.folder}${snapshot.folderKind === undefined ? '' : `, ${snapshot.folderKind}`}`)
  const others = snapshot.folderFiles.filter(file => !snapshot.open.some(open => open.path === file.path)).slice(0, 8)
  if (others.length > 0) lines.push(`Other app files there: ${others.map(file => `${basename(file.path)} (${APP_LABEL[file.app]})`).join(', ')}`)
  if (snapshot.referenced.length > 0) lines.push('The person\'s message points at:', ...snapshot.referenced.map(line => `- ${line}`))
  const empty = snapshot.open.length === 0 && snapshot.referenced.length === 0 && others.length === 0
  if (empty && snapshot.folderKind === undefined) return undefined
  lines.push([
    'A request that names no file is about what is open in the side panel. Use the working folder and any codebase the person points at',
    'as the source for it: for example, read the code to write its documentation into the open Word file, put a project\'s figures in the',
    'open sheet, or plan a product demo on the open storyboard. Read before you change, and change only what was asked.',
  ].join(' '))
  return lines.join('\n')
}

/**
 * @param ctx - the agent's composition.
 */
export function apply(ctx: Context): void {
  const lastNote = new WeakMap<object, string>()
  const folderCache = new Map<string, { at: number; kind: string | undefined; files: AppFile[] }>()

  const folderFacts = async (folder: string): Promise<{ kind: string | undefined; files: AppFile[] }> => {
    const cached = folderCache.get(folder)
    if (cached !== undefined && Date.now() - cached.at < 15_000) return cached
    const kind = existsSync(folder) && isCodebase(folder) ? surveyLine(surveyRepo(folder)) : undefined
    const files = await appFiles(folder, 2).catch(() => [])
    const facts = { at: Date.now(), kind, files }
    folderCache.set(folder, facts)
    return facts
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    try {
      const open: PanelFile[] = []
      for (const document of ctx.get('hsfOfficeEditor')?.open() ?? []) open.push({ path: document.path, app: OFFICE_LABEL[document.kind] })
      for (const path of ctx.get('hsfCreative')?.openBoards() ?? []) open.push({ path, app: 'Storyboard' })
      const folder = ctx.get('workingDirectory')?.get(agent.session) ?? process.cwd()
      const facts = await folderFacts(folder)
      const snapshot = { open, folder, folderFiles: facts.files, ...(facts.kind === undefined ? {} : { folderKind: facts.kind }) }
      // What the message points at is said with that message only; the rest is repeated only when it changes.
      const text = messageText(decision.messages)
      const referenced = text === '' ? [] : referencedCodebases(text, folder)
      const base = renderNote({ ...snapshot, referenced: [] }) ?? ''
      const note = renderNote({ ...snapshot, referenced })
      if (note === undefined || (referenced.length === 0 && lastNote.get(agent.session) === base)) return decision
      lastNote.set(agent.session, base)
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({ content: [{ type: 'text', text: note }], source: { kind: KIND, form: 'snapshot', sections: [{ name: KIND, text: note }] } }),
        ],
      }
    } catch (error) {
      ctx.logger.warn(`side panel context: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })
}
