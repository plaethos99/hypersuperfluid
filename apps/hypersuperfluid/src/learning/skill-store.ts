/**
 * The library of skills the agent writes for itself, with usage telemetry and a read-before-write guard. Layout and
 * lifecycle follow Hermes Agent (see THIRD_PARTY.md): `<root>/<name>/SKILL.md` plus `references/`, `templates/` and
 * `scripts/`; archived skills move to `<root>/.archive/`; nothing is ever deleted.
 * @module hypersuperfluid/learning/skill-store
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { scanForThreats, writeAtomic } from './memory.ts'

/** Lifecycle of one skill. */
export type SkillState = 'active' | 'stale' | 'archived'

/** Usage record for one skill. */
export interface SkillUsage {
  /** Times the skill's instructions were read while doing work. */
  useCount: number
  /** Times the skill was viewed through `skill_view`. */
  viewCount: number
  /** Times the skill was edited. */
  patchCount: number
  /** Milliseconds since the epoch of the latest read or edit. */
  lastActivityAt: number
  /** Current lifecycle state. */
  state: SkillState
  /** A pinned skill is exempt from every automatic transition. */
  pinned: boolean
  /** A locked skill refuses every write. */
  locked: boolean
  /** Who wrote it; the curator touches only `agent` skills. */
  createdBy: 'agent' | 'person'
}

/** A listing row. */
export interface SkillSummary {
  /** The skill's directory name. */
  readonly name: string
  /** The skill's frontmatter description. */
  readonly description: string
  /** Its usage record. */
  readonly usage: SkillUsage
}

const NAME = /^[a-z0-9][a-z0-9-]{1,63}$/u
const SUPPORT_FILE = /^(references|templates|scripts)\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/u
const USAGE_FILE = '.usage.json'
const ARCHIVE_DIR = '.archive'
/** A skill's instructions must fit a model's attention; longer depth belongs in `references/`. */
const MAX_SKILL_CHARS = 20_000
const MAX_DESCRIPTION_CHARS = 200

/**
 * Reads one field from a `SKILL.md` YAML frontmatter block.
 * @param text - the file's content.
 * @param field - the top-level scalar field to read.
 * @returns the field's value without quotes, or undefined.
 */
export function frontmatterField(text: string, field: string): string | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1]
  if (block === undefined) return undefined
  const line = block.split(/\r?\n/u).find(row => row.startsWith(`${field}:`))
  return line?.slice(field.length + 1).trim().replace(/^["']|["']$/gu, '')
}

function defaultUsage(now: number, createdBy: SkillUsage['createdBy']): SkillUsage {
  return { useCount: 0, viewCount: 0, patchCount: 0, lastActivityAt: now, state: 'active', pinned: false, locked: false, createdBy }
}

/** Reads and writes one skill library root. */
export class SkillStore {
  /** Keys of `reader\0target` proving a target was read during the reader's current review or session. */
  private readonly reads = new Set<string>()

  /**
   * @param root - the library's directory.
   * @param now - the clock, replaceable in tests.
   */
  constructor(readonly root: string, private readonly now: () => number = Date.now) {}

  private usagePath(): string {
    return join(this.root, USAGE_FILE)
  }

  private allUsage(): Record<string, SkillUsage> {
    try {
      return JSON.parse(readFileSync(this.usagePath(), 'utf8')) as Record<string, SkillUsage>
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  private update(name: string, change: (usage: SkillUsage) => void): void {
    const all = this.allUsage()
    const usage = all[name] ?? defaultUsage(this.now(), 'person')
    change(usage)
    all[name] = usage
    writeAtomic(this.usagePath(), `${JSON.stringify(all, null, 2)}\n`)
  }

  private dir(name: string): string {
    if (!NAME.test(name)) throw new Error(`"${name}" is not a valid skill name: use 2 to 64 lower-case letters, digits or hyphens, starting with a letter or digit.`)
    return join(this.root, name)
  }

  private requireSkill(name: string): string {
    const dir = this.dir(name)
    if (!existsSync(join(dir, 'SKILL.md'))) throw new Error(`There is no skill named "${name}". List them with skill_view without a name.`)
    return dir
  }

  private requireWritable(name: string): string {
    const dir = this.requireSkill(name)
    if (this.allUsage()[name]?.locked === true) throw new Error(`The skill "${name}" is locked. Put the suggested change in your reply instead; do not recreate it under another name.`)
    return dir
  }

  private validateContent(name: string, content: string): void {
    if (content.length > MAX_SKILL_CHARS) throw new Error(`SKILL.md has ${content.length} characters, over the limit of ${MAX_SKILL_CHARS}. Move depth into references/.`)
    const declared = frontmatterField(content, 'name')
    if (declared !== name) throw new Error(`SKILL.md must start with YAML frontmatter whose name is "${name}".`)
    const description = frontmatterField(content, 'description') ?? ''
    if (description === '' || description.length > MAX_DESCRIPTION_CHARS) throw new Error(`The frontmatter description must be 1 to ${MAX_DESCRIPTION_CHARS} characters and say when to use the skill.`)
    this.validateSafe(content)
  }

  private validateSafe(content: string): void {
    const threat = scanForThreats(content)
    if (threat !== undefined) throw new Error(`Refused: the text contains ${threat}, which must not persist into future sessions.`)
  }

  private requireRead(reader: string, name: string, file: string): void {
    if (!this.reads.has(`${reader}\0${name}\0${file}`)) {
      throw new Error(`Read before writing: call skill_view with name "${name}"${file === 'SKILL.md' ? '' : ` and file_path "${file}"`} in this session, then base your write on what it returned.`)
    }
  }

  /**
   * @param name - a skill name.
   * @returns whether a library skill of that name exists.
   */
  has(name: string): boolean {
    return NAME.test(name) && existsSync(join(this.root, name, 'SKILL.md'))
  }

  /** @returns every active or stale skill, sorted by name. */
  list(): SkillSummary[] {
    if (!existsSync(this.root)) return []
    const usage = this.allUsage()
    return readdirSync(this.root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && NAME.test(entry.name) && existsSync(join(this.root, entry.name, 'SKILL.md')))
      .map(entry => ({
        name: entry.name,
        description: frontmatterField(readFileSync(join(this.root, entry.name, 'SKILL.md'), 'utf8'), 'description') ?? '',
        usage: usage[entry.name] ?? defaultUsage(this.now(), 'person'),
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  private supportFiles(dir: string): string[] {
    return ['references', 'templates', 'scripts'].flatMap((kind) => {
      const path = join(dir, kind)
      if (!existsSync(path)) return []
      return readdirSync(path, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    }).sort()
  }

  /**
   * Reads a skill or one support file, and records the read for the read-before-write guard.
   * @param reader - who reads: an opaque id of the session.
   * @param name - the skill.
   * @param file - a support file path; omission reads `SKILL.md`.
   * @returns the file's content, and the list of the skill's support files.
   * @throws when the skill or file does not exist.
   */
  view(reader: string, name: string, file?: string): { content: string; files: string[] } {
    const dir = this.requireSkill(name)
    const target = file === undefined ? 'SKILL.md' : this.supportPath(file)
    const content = readFileSync(join(dir, target), 'utf8')
    this.reads.add(`${reader}\0${name}\0${target}`)
    this.update(name, (usage) => { usage.viewCount += 1; usage.lastActivityAt = this.now() })
    return { content, files: this.supportFiles(dir) }
  }

  /**
   * Counts a read of the skill's instructions through the harness's own skill loader.
   * @param name - the skill; a name outside this library is ignored.
   */
  recordUse(name: string): void {
    if (!this.has(name)) return
    this.update(name, (usage) => { usage.useCount += 1; usage.lastActivityAt = this.now() })
  }

  /**
   * Creates a skill the agent wrote.
   * @param name - the class-level name.
   * @param content - the complete `SKILL.md`.
   * @throws when the name exists or the content is invalid.
   */
  create(name: string, content: string): void {
    const dir = this.dir(name)
    if (existsSync(join(dir, 'SKILL.md'))) throw new Error(`The skill "${name}" already exists. Patch it instead of replacing it.`)
    if (existsSync(join(this.root, ARCHIVE_DIR, name))) throw new Error(`An archived skill named "${name}" exists. Restore it with action restore instead.`)
    this.validateContent(name, content)
    writeAtomic(join(dir, 'SKILL.md'), content)
    const all = this.allUsage()
    all[name] = defaultUsage(this.now(), 'agent')
    writeAtomic(this.usagePath(), `${JSON.stringify(all, null, 2)}\n`)
  }

  /**
   * Replaces one unique passage of `SKILL.md`.
   * @param reader - who writes; they must have viewed the skill first.
   * @param name - the skill.
   * @param oldText - the passage to replace, which must occur exactly once.
   * @param newText - its replacement.
   * @throws when unread, locked, or the passage is absent or ambiguous.
   */
  patch(reader: string, name: string, oldText: string, newText: string): void {
    const dir = this.requireWritable(name)
    this.requireRead(reader, name, 'SKILL.md')
    const path = join(dir, 'SKILL.md')
    const current = readFileSync(path, 'utf8')
    const parts = current.split(oldText)
    if (oldText === '' || parts.length === 1) throw new Error('That passage is not in SKILL.md. View the skill again and copy the passage exactly.')
    if (parts.length > 2) throw new Error(`That passage occurs ${parts.length - 1} times in SKILL.md. Give a longer unique passage.`)
    const next = parts.join(newText)
    this.validateContent(name, next)
    writeAtomic(path, next)
    this.update(name, (usage) => { usage.patchCount += 1; usage.lastActivityAt = this.now() })
  }

  private supportPath(file: string): string {
    const normalized = file.replaceAll('\\', '/')
    if (!SUPPORT_FILE.test(normalized) || normalized.split('/').includes('..')) {
      throw new Error('A support file must be under references/, templates/ or scripts/, with no parent-directory segments.')
    }
    return normalized
  }

  /**
   * Writes one support file; replacing an existing file requires having read it.
   * @param reader - who writes.
   * @param name - the skill.
   * @param file - the path under `references/`, `templates/` or `scripts/`.
   * @param content - the file's content.
   * @throws when unread, locked, or the path or content is unsafe.
   */
  writeFile(reader: string, name: string, file: string, content: string): void {
    const dir = this.requireWritable(name)
    const relativePath = this.supportPath(file)
    const path = resolve(dir, relativePath)
    if (existsSync(path)) this.requireRead(reader, name, relativePath)
    this.validateSafe(content)
    writeAtomic(path, content)
    this.update(name, (usage) => { usage.patchCount += 1; usage.lastActivityAt = this.now() })
  }

  /**
   * Removes one support file after it has been read.
   * @param reader - who writes.
   * @param name - the skill.
   * @param file - the path under `references/`, `templates/` or `scripts/`.
   * @throws when unread, locked, or the file is absent.
   */
  removeFile(reader: string, name: string, file: string): void {
    const dir = this.requireWritable(name)
    const relativePath = this.supportPath(file)
    this.requireRead(reader, name, relativePath)
    rmSync(resolve(dir, relativePath))
    this.update(name, (usage) => { usage.patchCount += 1; usage.lastActivityAt = this.now() })
  }

  /**
   * Sets the pinned or locked flag.
   * @param name - the skill.
   * @param flags - the flags to set.
   */
  setFlags(name: string, flags: { readonly pinned?: boolean; readonly locked?: boolean }): void {
    this.requireSkill(name)
    this.update(name, (usage) => {
      if (flags.pinned !== undefined) usage.pinned = flags.pinned
      if (flags.locked !== undefined) usage.locked = flags.locked
    })
  }

  /**
   * Moves a skill to the archive; archiving is the strongest removal this store offers.
   * @param name - the skill.
   * @throws when the skill is pinned.
   */
  archive(name: string): void {
    const dir = this.requireWritable(name)
    if (this.allUsage()[name]?.pinned === true) throw new Error(`The skill "${name}" is pinned and cannot be archived.`)
    const target = join(this.root, ARCHIVE_DIR, name)
    mkdirSync(dirname(target), { recursive: true })
    rmSync(target, { recursive: true, force: true })
    renameSync(dir, target)
    this.update(name, (usage) => { usage.state = 'archived' })
  }

  /**
   * Restores an archived skill.
   * @param name - the skill.
   * @throws when no archived skill has that name or the name is in use.
   */
  restore(name: string): void {
    const source = join(this.root, ARCHIVE_DIR, name)
    if (!existsSync(source)) throw new Error(`There is no archived skill named "${name}".`)
    const dir = this.dir(name)
    if (existsSync(dir)) throw new Error(`A skill named "${name}" exists already.`)
    renameSync(source, dir)
    this.update(name, (usage) => { usage.state = 'active'; usage.lastActivityAt = this.now() })
  }

  /** @returns the names in the archive. */
  archived(): string[] {
    const dir = join(this.root, ARCHIVE_DIR)
    return existsSync(dir) ? readdirSync(dir).filter(name => statSync(join(dir, name)).isDirectory()).sort() : []
  }

  /**
   * Copies the whole library to a dated snapshot, keeping the latest few.
   * @param keep - snapshots to keep.
   * @returns the snapshot's directory, or undefined when the library does not exist.
   */
  backup(keep: number): string | undefined {
    if (!existsSync(this.root)) return undefined
    const backups = join(this.root, '..', 'skills-backups')
    const target = join(backups, new Date(this.now()).toISOString().replace(/[:.]/gu, '-'))
    cpSync(this.root, target, { recursive: true })
    const all = readdirSync(backups).sort()
    for (const old of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(backups, old), { recursive: true, force: true })
    return target
  }

  /**
   * Sets a skill's state without moving it.
   * @param name - the skill.
   * @param state - the new state.
   */
  markState(name: string, state: SkillState): void {
    this.update(name, (usage) => { usage.state = state })
  }
}
