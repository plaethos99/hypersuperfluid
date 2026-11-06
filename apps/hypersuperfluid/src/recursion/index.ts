/**
 * The `harness_refine` tool: recursive harness refinement as a background job. It runs the task under the current
 * harness, proposes edits on how the agent works and what a practitioner knows, probes them on the same task, composes
 * a refined harness, and adopts the best result blind. The lesson enters a per-domain library that later refinement
 * reads. A run costs 4k rollouts and 3k editor sessions, so it happens only when asked for.
 * @module hypersuperfluid/recursion
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { hsfHome } from '../home.ts'
import { assignAnonymousIds, runParallel, runSequential, type ModeResult } from './engine.ts'
import { WorkspaceExecutor, type ExecutorHost } from './executor.ts'
import { hasExperience, Library } from './library.ts'
import { selectMission } from './prompts.ts'
import { readWorkspaceTree, type Tree } from './tree.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    refine: 'refine'
  }
}

/** Cordis plugin name. */
export const name = 'hsf-recursion'
/** Services this plugin needs. */
export const inject = ['tools', 'subagents', 'jobs']

/** Refinement settings. */
export interface Config {
  /** State directory; defaults to `HSF_HOME`, then `<DSH_HOME>/hsf`. */
  home?: string
  /** Concurrent rollouts and editors. */
  width?: number
  /** Maximum minutes of one rollout or editor session. */
  stageMinutes?: number
  /** The largest recursion budget the tool accepts. */
  maxK?: number
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  home: z.string(),
  width: z.natural().min(1).default(2),
  stageMinutes: z.natural().min(1).default(30),
  maxK: z.natural().min(1).default(3),
})

const SELECTION_SCHEMA = {
  type: 'object',
  properties: {
    choice: { type: 'string' },
    why: { type: 'string' },
    experience: {
      type: 'object',
      properties: {
        cue: { type: 'string' }, lesson: { type: 'string' }, evidence: { type: 'string' },
        confidence: { type: 'string' }, edits: { type: 'string' },
      },
      required: ['cue', 'lesson', 'evidence'],
    },
  },
  required: ['choice', 'why', 'experience'],
  additionalProperties: false,
} as const

interface Selection {
  readonly label: string
  readonly why: string
  readonly experience: unknown
  readonly fellBack: boolean
}

function isSelectionReply(value: unknown): value is { choice: string; why: string; experience: unknown } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.choice === 'string' && typeof record.why === 'string'
}

/**
 * Formats a finished refinement for the agent that asked for it.
 * @param result - the recursion.
 * @param selection - the adopted candidate.
 * @param runDir - the run's directory.
 * @param libraryEntry - where the lesson was stored, when one was.
 * @returns the job's final text.
 */
export function renderOutcome(result: ModeResult, selection: Selection, runDir: string, libraryEntry: string | undefined): string {
  const diff = join(runDir, 'rollouts', selection.label, 'changes.diff')
  const fellBack = result.stages.filter(stage => stage.fellBack).map(stage => stage.label)
  return [
    `Refinement finished (${result.mode}, k=${result.k}): ${result.ledger.rollouts.length} rollouts and ${result.ledger.stages.length} editor sessions.`,
    `Adopted: ${selection.label}${selection.fellBack ? ' (selection failed, so this is the first delivered final, not a judged choice)' : ''}.`,
    ...selection.why === '' ? [] : [`Why: ${selection.why}`],
    ...fellBack.length > 0 ? [`Stages that kept the inherited harness after invalid proposals: ${fellBack.join(', ')}.`] : [],
    `Result reply: ${join(runDir, 'rollouts', selection.label, 'output.md')}`,
    `Result patch, NOT applied to the workspace: ${diff}`,
    `Adopted harness: ${join(runDir, 'harnesses', selection.label)}`,
    libraryEntry === undefined ? 'No lesson was stored in the library.' : `Lesson stored: ${libraryEntry}`,
    'Tell the person what was adopted and ask before applying the patch or copying the harness into the workspace.',
  ].join('\n')
}

/**
 * @param ctx - an agent preset scope.
 * @param config - the refinement settings.
 */
export function apply(ctx: Context, config: Config): void {
  const home = hsfHome(config.home)
  const maxK = config.maxK ?? 3
  const trajectories = new Map<string, string[]>()

  ctx.on('tools/result', (exec, result) => {
    const lines = trajectories.get(String(exec.agent?.id))
    if (lines === undefined) return
    const args = JSON.stringify(exec.arguments).slice(0, 600)
    const content = JSON.stringify(result.content ?? '').slice(0, 4000)
    lines.push(`[ACTION] ${exec.name} ${args}\n[${result.isError === true ? 'ERROR' : 'OBSERVATION'}] ${content}\n`)
  })

  const host: ExecutorHost = {
    async startChild({ childId, label, cwd, prompt, parent, signal, outputSchema }) {
      trajectories.set(String(childId), [])
      const activation = await ctx.subagents.startActivation({
        provider: 'spawn', label, childId, parent, cwd, signal, delivery: 'caller',
        prompt: [{ type: 'text', text: prompt }],
        ...outputSchema === undefined ? {} : { outputSchema: outputSchema as never },
      })
      const stop = (): void => { void activation.dispose().catch((error: unknown) => { ctx.logger.warn('hsf-recursion: stopping %s failed: %s', label, String(error)) }) }
      signal.addEventListener('abort', stop, { once: true })
      try {
        return await activation.result
      } finally {
        signal.removeEventListener('abort', stop)
        await activation.dispose()
      }
    },
    trajectoryOf: childId => (trajectories.get(childId) ?? []).join('\n'),
    releaseTrajectory: (childId) => { trajectories.delete(childId) },
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'harness_refine',
    description: 'Do a high-stakes or recurring task several times under improved instructions and keep the best result. It runs the task under the current harness in isolated copies of the workspace, proposes edits, probes them on the same task, composes a refined harness, and adopts the best result blind. Costs 4k full runs and 3k editor sessions, so use it only when the person asks to refine or when quality clearly justifies that spend, and confirm first. Runs in the background; the workspace itself is not changed.',
    parameters: {
      task: { type: 'string', required: true, description: 'The complete, self-contained task, as the runs will receive it.' },
      domain: { type: 'string', required: true, description: 'A short domain name grouping related work, such as odoo, devops, embedded or legal. Lessons are shared within a domain.' },
      k: { type: 'number', description: 'The recursion budget, default 1.' },
      mode: { type: 'string', enum: ['parallel', 'sequential'], description: 'parallel explores wider, sequential refines deeper. Default sequential.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { jobId: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `Started refinement job ${value.jobId}. You will be told when it ends.` }],
    },
    isConcurrencySafe: () => true,
    execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('harness_refine needs a calling agent.')
      const k = Math.trunc(args.k ?? 1)
      if (k < 1 || k > maxK) throw new Error(`k must be from 1 to ${maxK}.`)
      const workspace = parent.session.header.cwd
      if (workspace === undefined) throw new Error('This session has no working directory to refine in.')
      const library = new Library(join(home, 'library'), args.domain)
      const abort = new AbortController()

      const jobId = ctx.jobs.start({
        kind: 'refine',
        label: `Refine: ${args.task.slice(0, 80)}`,
        owner: parent.id,
        toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
        outputLimitBytes: 16_384,
        run(job) {
          const refine = async (): Promise<JobOutcome> => {
            const executor = new WorkspaceExecutor({
              workspace, task: args.task, parent,
              copyLibrary: target => library.copyTo(target),
              timeoutMs: (config.stageMinutes ?? 30) * 60_000,
              progress: (line) => { job.updateProgress(line); job.append(`${line}\n`) },
              signal: abort.signal, host,
            })
            let chosen: string | undefined
            try {
              const base = readWorkspaceTree(workspace)
              const options = { k, domain: args.domain, base, executor, width: config.width ?? 2, signal: abort.signal }
              const result = args.mode === 'parallel' ? await runParallel(options) : await runSequential(options)
              const selection = await select(executor, result, workspace)
              chosen = selection.label
              const adopted = result.trees[selection.label] as Tree
              const entry = library.add(executor.runId, adopted, selection)
              const text = renderOutcome(result, selection, executor.runDir, entry)
              job.append(`${text}\n`)
              return { status: 'completed', detail: `adopted ${selection.label}` }
            } finally {
              executor.cleanup(chosen)
            }
          }
          return {
            cancel: (reason) => { abort.abort(new Error(reason ?? 'refinement cancelled')) },
            done: refine().catch((error: unknown) => {
              job.append(`Refinement failed: ${String(error)}\n`)
              return { status: abort.signal.aborted ? 'killed' : 'failed', detail: String(error).slice(0, 300) } as JobOutcome
            }),
          }
        },
      })
      return Promise.resolve({ jobId: String(jobId) })
    },
    presentCall: args => ({ card: 'generic', title: `Refine (${args.domain})`, rawInput: args }),
  })), 'hsf harness_refine tool')
}

async function select(executor: WorkspaceExecutor, result: ModeResult, workspace: string): Promise<Selection> {
  const delivered = result.finals.filter(label => result.rollouts[label]?.ok === true && result.rollouts[label]?.delivered === true)
  const firstDelivered = delivered[0]
  if (firstDelivered === undefined) throw new Error(`no final candidate delivered a result; see the rollouts under ${executor.runDir}`)
  if (delivered.length === 1) {
    const only = await reflect(executor, result, { A: firstDelivered })
    return only ?? { label: firstDelivered, why: '', experience: undefined, fellBack: true }
  }
  const ids = assignAnonymousIds(delivered, `${workspace}|${executor.runId}`)
  return await reflect(executor, result, ids) ?? { label: firstDelivered, why: '', experience: undefined, fellBack: true }
}

async function reflect(
  executor: WorkspaceExecutor,
  result: ModeResult,
  ids: Readonly<Record<string, string>>,
): Promise<Selection | undefined> {
  const reply = await executor.select(selectMission(Object.keys(ids).length), ids, label => result.trees[label] ?? {}, SELECTION_SCHEMA)
    .catch(() => undefined)
  if (reply === undefined || !isSelectionReply(reply.structured)) return undefined
  const label = ids[reply.structured.choice]
  if (label === undefined) return undefined
  const experience = hasExperience(reply.structured.experience) ? reply.structured.experience : undefined
  return { label, why: reply.structured.why, experience, fellBack: false }
}
