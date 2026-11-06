/**
 * Share links and their conversations, kept as JSON under `<HSF_HOME>/portal`. A link's token appears only in the URL
 * handed to the guest; the store keeps its SHA-256, so the file alone cannot be used to open a link.
 * @module hypersuperfluid/portal/store
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, normalize, sep } from 'node:path'

/** What a link lets a guest do. */
export type LinkKind = 'ask' | 'agent'

/** One line of a link's conversation, as the guest sees it. */
export interface TranscriptEntry {
  readonly role: 'guest' | 'agent' | 'notice'
  readonly text: string
  readonly at: string
  readonly files?: readonly string[]
}

/** A guest's job on an agent link. */
export interface Job {
  readonly id: string
  readonly task: string
  status: 'waiting' | 'running' | 'done' | 'failed' | 'rejected'
  readonly createdAt: string
  readonly files: number
  readonly bytes: number
  sessionId?: string
  result?: string
  updatedAt: string
}

/** A share link. */
export interface Link {
  readonly id: string
  readonly kind: LinkKind
  readonly title: string
  readonly tokenHash: string
  readonly createdAt: string
  readonly expiresAt: string
  stopped?: boolean
  sessionId?: string
  transcript: TranscriptEntry[]
  jobs: Job[]
}

/** Hash of a link token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** A new unguessable token: 32 random bytes, URL-safe. */
export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

/** A short random id. */
export function newId(): string {
  return randomBytes(6).toString('hex')
}

/**
 * Resolves a guest-supplied relative path inside a folder, refusing anything that would land outside it.
 * @param root - the folder.
 * @param relativePath - the path the browser sent, such as `src/app.py`.
 * @returns the absolute path.
 * @throws on absolute paths, drive letters, `..` escapes and empty names.
 */
export function safeJoin(root: string, relativePath: string): string {
  const cleaned = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (cleaned === '' || isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned) || cleaned.split('/').some(part => part === '..' || part === '')) {
    throw new Error(`refused file path: ${relativePath}`)
  }
  const target = normalize(join(root, ...cleaned.split('/')))
  if (!target.startsWith(normalize(root) + sep)) throw new Error(`refused file path: ${relativePath}`)
  return target
}

/** The links of one portal, persisted after every change. */
export class LinkStore {
  private readonly file: string
  private links: Link[]

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true })
    this.file = join(root, 'links.json')
    this.links = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as Link[]) : []
  }

  /** Where a link keeps its files. */
  dirOf(link: Link): string {
    return join(this.root, link.id)
  }

  /** Every link, newest first. */
  all(): readonly Link[] {
    return [...this.links].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** Whether a link still accepts guests. */
  active(link: Link, now = Date.now()): boolean {
    return link.stopped !== true && Date.parse(link.expiresAt) > now
  }

  /**
   * Creates a link.
   * @returns the link and its token, which is shown once and never stored.
   */
  create(kind: LinkKind, title: string, hours: number, now = Date.now()): { link: Link; token: string } {
    const token = newToken()
    const link: Link = {
      id: newId(),
      kind,
      title,
      tokenHash: hashToken(token),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + hours * 3_600_000).toISOString(),
      transcript: [],
      jobs: [],
    }
    this.links.push(link)
    mkdirSync(this.dirOf(link), { recursive: true })
    this.save()
    return { link, token }
  }

  /** Finds the link a token opens, comparing hashes in constant time. */
  byToken(token: string): Link | undefined {
    const wanted = Buffer.from(hashToken(token), 'hex')
    return this.links.find((link) => {
      const have = Buffer.from(link.tokenHash, 'hex')
      return have.length === wanted.length && timingSafeEqual(have, wanted)
    })
  }

  /** Finds a link by id. */
  byId(id: string): Link | undefined {
    return this.links.find(link => link.id === id)
  }

  /** Finds the link and job a session belongs to. */
  bySession(sessionId: string): { link: Link; job?: Job } | undefined {
    for (const link of this.links) {
      if (link.sessionId === sessionId) return { link }
      const job = link.jobs.find(candidate => candidate.sessionId === sessionId)
      if (job !== undefined) return { link, job }
    }
    return undefined
  }

  /** Adds a transcript line. */
  say(link: Link, entry: Omit<TranscriptEntry, 'at'>): void {
    link.transcript.push({ ...entry, at: new Date().toISOString() })
    this.save()
  }

  /** Writes the store atomically. */
  save(): void {
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(this.links, null, 2), 'utf8')
    renameSync(temp, this.file)
  }
}
