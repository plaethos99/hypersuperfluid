/**
 * The deterministic part of skill lifecycle maintenance, following the invariants of Hermes Agent's curator: it
 * touches only skills the agent wrote, exempts pinned skills, and archives at most, never deletes. The model-driven
 * consolidation pass is the review prompt `CURATOR_PROMPT` in `prompts.ts`.
 * @module hypersuperfluid/learning/curator
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from './memory.ts'
import type { SkillStore } from './skill-store.ts'

/** Curator timing. */
export interface CuratorConfig {
  /** Hours between deterministic passes. */
  readonly intervalHours: number
  /** Days without activity after which a skill becomes stale. */
  readonly staleAfterDays: number
  /** Days without activity after which a skill is archived. */
  readonly archiveAfterDays: number
  /** Library snapshots to keep. */
  readonly backupsKept: number
}

/** Hermes Agent's defaults. */
export const DEFAULT_CURATOR: CuratorConfig = { intervalHours: 24, staleAfterDays: 30, archiveAfterDays: 90, backupsKept: 5 }

/** What one pass changed. */
export interface CuratorReport {
  /** Skills marked stale. */
  readonly staled: readonly string[]
  /** Skills archived. */
  readonly archived: readonly string[]
  /** Skills that returned to active because they were used again. */
  readonly reactivated: readonly string[]
  /** The snapshot taken first, when anything changed. */
  readonly backup?: string
}

const DAY_MS = 86_400_000
const STATE_FILE = '.curator.json'

/**
 * Runs one deterministic pass, taking a library snapshot only when something is about to change.
 * @param store - the skill library.
 * @param config - the timing.
 * @param now - the current time in milliseconds.
 * @returns what changed.
 */
export function runCurator(store: SkillStore, config: CuratorConfig, now: number): CuratorReport {
  const candidates = store.list().filter(skill => skill.usage.createdBy === 'agent' && !skill.usage.pinned && !skill.usage.locked)
  const idleDays = (at: number) => (now - at) / DAY_MS
  const toArchive = candidates.filter(skill => idleDays(skill.usage.lastActivityAt) >= config.archiveAfterDays)
  const toStale = candidates.filter(skill => skill.usage.state === 'active' && idleDays(skill.usage.lastActivityAt) >= config.staleAfterDays && idleDays(skill.usage.lastActivityAt) < config.archiveAfterDays)
  const toActivate = candidates.filter(skill => skill.usage.state === 'stale' && idleDays(skill.usage.lastActivityAt) < config.staleAfterDays)
  const backup = toArchive.length + toStale.length > 0 ? store.backup(config.backupsKept) : undefined
  for (const skill of toArchive) store.archive(skill.name)
  for (const skill of toStale) store.markState(skill.name, 'stale')
  for (const skill of toActivate) store.markState(skill.name, 'active')
  return {
    staled: toStale.map(skill => skill.name),
    archived: toArchive.map(skill => skill.name),
    reactivated: toActivate.map(skill => skill.name),
    ...backup === undefined ? {} : { backup },
  }
}

/**
 * Runs a pass when the interval has elapsed since the last one.
 * @param store - the skill library.
 * @param config - the timing.
 * @param now - the current time in milliseconds.
 * @returns the report, or undefined when no pass was due.
 */
export function runCuratorIfDue(store: SkillStore, config: CuratorConfig, now: number): CuratorReport | undefined {
  const path = join(store.root, STATE_FILE)
  let last = 0
  try {
    last = (JSON.parse(readFileSync(path, 'utf8')) as { lastRunAt: number }).lastRunAt
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (now - last < config.intervalHours * 3_600_000) return undefined
  const report = runCurator(store, config, now)
  writeAtomic(path, `${JSON.stringify({ lastRunAt: now })}\n`)
  return report
}
