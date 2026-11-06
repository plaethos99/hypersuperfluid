/**
 * The per-domain experience library: harnessing-level recursion. Every adopted harness is stored whole with why it
 * was chosen and one transferable lesson, and later refinement in the same domain reads them as examples. Ported from
 * Harness² `core/library.py` (Apache-2.0; see THIRD_PARTY.md).
 * @module hypersuperfluid/recursion/library
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inventory, readTree, writeTree, type Tree } from './tree.ts'

/** A lesson that must stand on evidence. */
export interface Experience {
  /** When a future reader should recall this. */
  readonly cue: string
  /** The rule that transfers. */
  readonly lesson: string
  /** What the runs showed. */
  readonly evidence: string
  /** How sure the writer is. */
  readonly confidence?: string
  /** What each harness edit did. */
  readonly edits?: string
}

/**
 * @param value - a parsed reply.
 * @returns whether it holds a usable lesson; a reply without one is not stored, because an unexplained harness teaches nothing.
 */
export function hasExperience(value: unknown): value is Experience {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return ['cue', 'lesson', 'evidence'].every(key => typeof record[key] === 'string' && (record[key] as string).trim() !== '')
}

/**
 * @param domain - a free-form domain name.
 * @returns a directory name, never a path.
 */
export function domainDir(domain: string): string {
  return domain.trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'general'
}

function taskSlug(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9_-]+/gu, '__').slice(0, 96)
}

function experienceField(path: string, field: string): string {
  if (!existsSync(path)) return ''
  const line = readFileSync(path, 'utf8').split(/\r?\n/u).find(row => row.startsWith(`- **${field}**:`))
  return line === undefined ? '' : line.slice(line.indexOf(':') + 1).trim()
}

/** One domain's library, read before each refinement and appended after. */
export class Library {
  /** This domain's directory. */
  readonly dir: string

  /**
   * @param root - the directory of all libraries.
   * @param domain - the domain.
   */
  constructor(root: string, domain: string) {
    this.dir = join(root, domainDir(domain))
  }

  /** @returns the stored entry names, sorted. */
  entries(): string[] {
    const harnesses = join(this.dir, 'harnesses')
    return existsSync(harnesses) ? readdirSync(harnesses).sort() : []
  }

  /**
   * Copies the library for an editor to read, where its write boundary allows.
   * @param target - the directory to copy into.
   * @returns whether anything was copied.
   */
  copyTo(target: string): boolean {
    if (this.entries().length === 0) return false
    cpSync(this.dir, target, { recursive: true })
    return true
  }

  /**
   * Stores an adopted harness.
   * @param taskId - the task's identity.
   * @param harness - the whole adopted tree.
   * @param record - the adopted label, why it was chosen, and its lesson.
   * @returns the entry's directory, or undefined when there is no usable lesson.
   */
  add(
    taskId: string,
    harness: Tree,
    record: { readonly label: string; readonly why: string; readonly experience: unknown },
  ): string | undefined {
    if (!hasExperience(record.experience)) return undefined
    const entry = join(this.dir, 'harnesses', taskSlug(taskId))
    rmSync(join(entry, 'harness'), { recursive: true, force: true })
    writeTree(harness, join(entry, 'harness'))
    const { cue, lesson, evidence, confidence, edits } = record.experience
    const lines = [
      `# ${taskId}`, '',
      `- adopted: \`${record.label}\``,
      `- components: ${inventory(harness)}`, '',
      ...record.why.trim() === '' ? [] : ['## Why this was chosen', record.why.trim(), ''],
      ...edits === undefined || edits.trim() === '' ? [] : ['## What each edit did', edits.trim(), ''],
      '## Transferable lesson',
      `- **cue**: ${cue.trim()}`,
      `- **lesson**: ${lesson.trim()}`,
      `- **evidence**: ${evidence.trim()}`,
      ...confidence === undefined ? [] : [`- **confidence**: ${confidence.trim()}`],
      '',
    ]
    writeFileSync(join(entry, 'EXPERIENCE.md'), lines.join('\n'), 'utf8')
    this.rebuildIndex()
    return entry
  }

  /** Regenerates `INDEX.md` from what is on disk. */
  rebuildIndex(): void {
    mkdirSync(this.dir, { recursive: true })
    const rows = ['# Experience library', '', 'Each entry is an earlier task in THIS domain whose harness was chosen, stored whole with why it was picked. Browse this index, then open the entries relevant to the work in front of you.', '']
    for (const name of this.entries()) {
      const entry = join(this.dir, 'harnesses', name)
      const cue = experienceField(join(entry, 'EXPERIENCE.md'), 'cue')
      rows.push(`## \`harnesses/${name}/\``, `- harness: ${inventory(readTree(join(entry, 'harness')))}`, `- why: \`harnesses/${name}/EXPERIENCE.md\``, ...cue === '' ? [] : [`- cue: ${cue}`], '')
    }
    writeFileSync(join(this.dir, 'INDEX.md'), rows.join('\n'), 'utf8')
  }
}
