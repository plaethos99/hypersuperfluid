/**
 * Task-level recursion: Propose, Probe, Compose. Each mode schedules exactly 4k rollouts and 3k improvement stages,
 * which {@link Ledger.assertIdentity} enforces so a run's cost stays predictable. An invalid proposal gets one retry
 * with the problem as feedback, then inherits the current harness. Ported from Harness² `core/recursion.py`
 * (Apache-2.0; see THIRD_PARTY.md). The executor supplies every effect, so this module runs without a model.
 * @module hypersuperfluid/recursion/engine
 */

import { aggregateMission, composeRoundMission, proposeMission } from './prompts.ts'
import { diffTrees, validateTree, type Tree } from './tree.ts'

/** What the method knows about one finished rollout. It never carries a score. */
export interface RunView {
  /** The rollout's label. */
  readonly label: string
  /** Whether the rollout ended without an infrastructure failure. */
  readonly ok: boolean
  /** Whether it produced a result. */
  readonly delivered: boolean
  /** Its failure, when not ok. */
  readonly error?: string
}

/** An improvement stage's request to the executor. */
export interface StageRequest {
  /** The stage's label, such as `inv1` or `agg1`. */
  readonly label: string
  /** The mission text. */
  readonly mission: string
  /** The harness the editor starts from. */
  readonly start: Tree
  /** Rollouts to show as evidence. */
  readonly rollouts: readonly RunView[]
  /** Candidate labels to show with their harnesses. */
  readonly candidates: ReadonlyArray<{ readonly label: string; readonly tree: Tree }>
  /** Notes from earlier stages, by label. */
  readonly decisions: Readonly<Record<string, string>>
  /** Feedback from a rejected earlier attempt at this stage. */
  readonly feedback?: string
}

/** What an editor returned. */
export interface StageReply {
  /** The harness as the editor left it, or undefined when the session did not finish. */
  readonly tree?: Tree
  /** Paths the editor left off the surface. */
  readonly rejected: readonly string[]
  /** The editor's notes. */
  readonly notes: string
}

/** The effects a refinement needs. */
export interface RefineExecutor {
  /** Runs the task once under a harness. Rejections are recorded as a dead rollout. */
  rollout(label: string, tree: Tree): Promise<RunView>
  /** Runs one editor session. Rejections are recorded as an execution failure of that stage. */
  edit(request: StageRequest): Promise<StageReply>
  /** Reports progress to the person's job view. */
  progress(line: string): void
}

/** One stage's outcome. */
export interface Stage {
  /** The stage's label. */
  readonly label: string
  /** `INV`, `DOM`, `AGG` or `COMPOSE`. */
  readonly dim: string
  /** The harness it produced, or the inherited one on fallback. */
  readonly tree: Tree
  /** Whether the edit changed nothing. */
  readonly keptBase: boolean
  /** Whether it fell back after invalid proposals or a failure. */
  readonly fellBack: boolean
  /** Its last problem, when it fell back. */
  readonly error: string
  /** The editor's notes. */
  readonly notes: string
}

/** Counts scheduled work so a run can prove it spent what it promised. */
export class Ledger {
  /** Rollout labels in order. */
  readonly rollouts: string[] = []
  /** Stage labels in order. */
  readonly stages: string[] = []

  /**
   * @param k - the recursion budget.
   * @throws when the run's counts differ from 4k rollouts and 3k stages.
   */
  assertIdentity(k: number): void {
    if (this.rollouts.length !== 4 * k || this.stages.length !== 3 * k) {
      throw new Error(`refinement ledger mismatch: ${this.rollouts.length} rollouts and ${this.stages.length} stages for k=${k}, expected ${4 * k} and ${3 * k}`)
    }
  }
}

/** A finished recursion. */
export interface ModeResult {
  /** `parallel` or `sequential`. */
  readonly mode: 'parallel' | 'sequential'
  /** The recursion budget. */
  readonly k: number
  /** Every stage. */
  readonly stages: readonly Stage[]
  /** Every harness by label. */
  readonly trees: Readonly<Record<string, Tree>>
  /** Every rollout by label. */
  readonly rollouts: Readonly<Record<string, RunView>>
  /** Labels of the final candidates that selection chooses among. */
  readonly finals: readonly string[]
  /** What was spent. */
  readonly ledger: Ledger
}

/** Runs items with at most `width` in flight, keeping their order in the result. */
async function pooled<T, R>(items: readonly T[], width: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await run(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, worker))
  return results
}

const STAGE_ATTEMPTS = 2
const NOTES_PATTERN = /<notes>([\s\S]*?)<\/notes>/u

/** Shared state of one recursion. */
class Run {
  readonly ledger = new Ledger()
  readonly stages: Stage[] = []
  readonly trees: Record<string, Tree> = {}
  readonly rollouts: Record<string, RunView> = {}

  constructor(
    readonly executor: RefineExecutor,
    readonly width: number,
    readonly signal: AbortSignal,
  ) {}

  private async rollOne(label: string, tree: Tree): Promise<RunView> {
    this.signal.throwIfAborted()
    this.executor.progress(`probing ${label}`)
    try {
      return await this.executor.rollout(label, tree)
    } catch (error: unknown) {
      this.signal.throwIfAborted()
      return { label, ok: false, delivered: false, error: String(error) }
    }
  }

  /** Rolls harnesses concurrently, recording them in the caller's order so a concurrent run reads like a serial one. */
  async roll(items: ReadonlyArray<readonly [string, Tree]>): Promise<void> {
    const results = await pooled(items, this.width, ([label, tree]) => this.rollOne(label, tree))
    results.forEach((view) => {
      this.ledger.rollouts.push(view.label)
      this.rollouts[view.label] = view
    })
  }

  async stage(label: string, dim: string, mission: string, fallback: Tree, evidence: Pick<StageRequest, 'rollouts' | 'candidates' | 'decisions'>): Promise<Stage> {
    let feedback: string | undefined
    let start = fallback
    this.executor.progress(`editing ${label}`)
    for (let attempt = 1; attempt <= STAGE_ATTEMPTS; attempt += 1) {
      this.signal.throwIfAborted()
      let reply: StageReply
      try {
        reply = await this.executor.edit({ label, mission, start, ...evidence, ...feedback === undefined ? {} : { feedback } })
      } catch (error: unknown) {
        this.signal.throwIfAborted()
        return this.fellBack(label, dim, fallback, String(error))
      }
      if (reply.tree === undefined) {
        feedback = 'The harness directory did not come back from your session. Edit the files in `harness/` in place.'
        continue
      }
      start = reply.tree
      if (reply.rejected.length > 0) {
        feedback = `These files are off the editable surface and were not applied: ${reply.rejected.slice(0, 6).join(', ')}. Fix them in \`harness/\`.`
        continue
      }
      if (Object.keys(reply.tree).length === 0 && Object.keys(fallback).length > 0) {
        feedback = '`harness/` came back empty. Edit the files; do not delete them all.'
        continue
      }
      const problems = validateTree(reply.tree)
      if (problems.length > 0) {
        feedback = problems.join('\n')
        continue
      }
      const change = diffTrees(fallback, reply.tree)
      return {
        label, dim, tree: reply.tree, fellBack: false, error: '',
        keptBase: change.added.length + change.removed.length + change.modified.length === 0,
        notes: (NOTES_PATTERN.exec(reply.notes)?.[1] ?? reply.notes).trim(),
      }
    }
    return this.fellBack(label, dim, fallback, feedback ?? 'no valid proposal')
  }

  private fellBack(label: string, dim: string, fallback: Tree, error: string): Stage {
    return { label, dim, tree: { ...fallback }, keptBase: true, fellBack: true, error: error.slice(0, 400), notes: '' }
  }

  record(stages: readonly Stage[]): void {
    for (const stage of stages) {
      this.ledger.stages.push(stage.label)
      this.stages.push(stage)
      this.trees[stage.label] = stage.tree
    }
  }

  decisions(): Record<string, string> {
    return Object.fromEntries(this.stages.map(stage => [stage.label, stage.notes !== '' ? stage.notes : stage.error]))
  }

  result(mode: ModeResult['mode'], k: number, finals: readonly string[]): ModeResult {
    this.ledger.assertIdentity(k)
    return { mode, k, stages: this.stages, trees: this.trees, rollouts: this.rollouts, finals, ledger: this.ledger }
  }
}

/** The inputs of one recursion. */
export interface RecursionOptions {
  /** The recursion budget. */
  readonly k: number
  /** The task's domain. */
  readonly domain: string
  /** The harness to start from. */
  readonly base: Tree
  /** The effects. */
  readonly executor: RefineExecutor
  /** Concurrent rollouts and editors. */
  readonly width: number
  /** Cancels the run. */
  readonly signal: AbortSignal
}

async function baseRuns(run: Run, k: number, base: Tree): Promise<RunView[]> {
  const labels = Array.from({ length: k }, (_, index) => `base${index + 1}`)
  await run.roll(labels.map(label => [label, base] as const))
  labels.forEach((label) => { run.trees[label] = base })
  return labels.map(label => run.rollouts[label] as RunView)
}

/**
 * Width: 2k candidates from shared evidence, then k independent compositions.
 * @param options - the run's inputs.
 * @returns what the run produced, with `agg1..aggk` as finals.
 */
export async function runParallel(options: RecursionOptions): Promise<ModeResult> {
  const { k, domain, base: baseTree, executor, width, signal } = options
  const run = new Run(executor, width, signal)
  const base = await baseRuns(run, k, baseTree)
  const specs = Array.from({ length: k }, (_, index) => index + 1).flatMap(i => (['INV', 'DOM'] as const).map(dim => ({ label: `${dim.toLowerCase()}${i}`, dim })))
  const candidates = await pooled(specs, width, ({ label, dim }) =>
    run.stage(label, dim, proposeMission(dim, domain), baseTree, { rollouts: base, candidates: [], decisions: {} }))
  run.record(candidates)
  await run.roll(candidates.map(stage => [stage.label, stage.tree] as const))
  const evidence = {
    rollouts: [...base, ...candidates.map(stage => run.rollouts[stage.label] as RunView)],
    candidates: candidates.map(stage => ({ label: stage.label, tree: stage.tree })),
    decisions: run.decisions(),
  }
  const labels = Array.from({ length: k }, (_, index) => `agg${index + 1}`)
  const compositions = await pooled(labels, width, label => run.stage(label, 'AGG', aggregateMission(domain, k), baseTree, evidence))
  run.record(compositions)
  await run.roll(compositions.map(stage => [stage.label, stage.tree] as const))
  return run.result('parallel', k, labels)
}

/**
 * Depth: k nested Propose, Probe, Compose passes over the same shared base evidence.
 * @param options - the run's inputs.
 * @returns what the run produced, with `c1..ck` as finals.
 */
export async function runSequential(options: RecursionOptions): Promise<ModeResult> {
  const { k, domain, base: baseTree, executor, width, signal } = options
  const run = new Run(executor, width, signal)
  const base = await baseRuns(run, k, baseTree)
  let current = baseTree
  const history: Array<{ label: string; tree: Tree }> = []
  for (let t = 1; t <= k; t += 1) {
    const evidence = () => ({
      rollouts: [...base, ...history.map(item => run.rollouts[item.label] as RunView)],
      candidates: [...history],
      decisions: run.decisions(),
    })
    const round = evidence()
    const specs = (['INV', 'DOM'] as const).map(dim => ({ label: `${dim.toLowerCase()}${t}`, dim }))
    const candidates = await pooled(specs, width, ({ label, dim }) => run.stage(label, dim, proposeMission(dim, domain), current, round))
    run.record(candidates)
    await run.roll(candidates.map(stage => [stage.label, stage.tree] as const))
    history.push(...candidates.map(stage => ({ label: stage.label, tree: stage.tree })))
    const label = `c${t}`
    const composed = await run.stage(label, 'COMPOSE', composeRoundMission(domain, t, k), current, evidence())
    run.record([composed])
    await run.roll([[label, composed.tree]])
    history.push({ label, tree: composed.tree })
    current = composed.tree
  }
  return run.result('sequential', k, Array.from({ length: k }, (_, index) => `c${index + 1}`))
}

/**
 * Assigns stable anonymous ids: a canonical sort, then a seeded shuffle, so a resumed selection sees the same ids.
 * @param labels - the candidate labels.
 * @param seed - any stable text, such as the run's id.
 * @returns anonymous id to label.
 */
export function assignAnonymousIds(labels: readonly string[], seed: string): Record<string, string> {
  let state = [...seed].reduce((hash, char) => (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0, 7)
  const ordered = [...labels].sort()
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const swap = state % (index + 1)
    const held = ordered[index] as string
    ordered[index] = ordered[swap] as string
    ordered[swap] = held
  }
  return Object.fromEntries(ordered.map((label, index) => [String.fromCharCode(65 + index % 26) + (index >= 26 ? String(Math.floor(index / 26)) : ''), label]))
}
