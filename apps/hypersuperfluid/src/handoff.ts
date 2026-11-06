/**
 * Handoff before the context fills. A long task does not wait for compaction to squeeze its history: once the last
 * request used `threshold` of the model's context window (70% by default, below compaction's 80%), the agent is told
 * once, through a durable notice, to hand off. The `handoff` tool then writes a detailed handoff document under
 * `<working folder>/.hsf/handoffs/`, opens a new session in the same folder with the same mode and model, and starts
 * it on the handoff, so the work continues with a clean context and nothing important lost. The person can ask for a
 * handoff at any time as well.
 *
 * Compaction stays as the safety net. When it runs anyway, its checkpoint is saved beside the handoffs, so a session
 * that was compacted still leaves a readable record.
 * @module hypersuperfluid/handoff
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-working-directory'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { textOf } from './content.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'hsf-handoff': { kind: 'hsf-handoff' } & ContextFormed
  }
}

/** Cordis plugin name. */
export const name = 'hsf-handoff'
/** Services this plugin needs. Session creation, titles, workspaces, presets and working folders are read with `ctx.get` when present. */
export const inject = ['tools', 'sessions', 'sessionProjections', 'tokenMeter']

/** Handoff settings. */
export interface Config {
  /** Share of the context window, after one request, at which the agent is told to hand off. 0 turns the notice off. */
  threshold?: number
  /**
   * Share of the window a session that itself began from a handoff must add before it is told to hand off again.
   * It stops a chain of handoffs when the handoff alone already sits near the threshold.
   */
  minGrowth?: number
  /** Folder, relative to the session's working folder, that keeps handoffs and compaction checkpoints. */
  dir?: string
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  threshold: z.number().min(0).max(0.95).default(0.7),
  minGrowth: z.number().min(0).max(0.95).default(0.25),
  dir: z.string().default('.hsf/handoffs'),
})

/** What the agent writes into a handoff. Every field is plain Markdown. */
export interface HandoffFields {
  readonly goal: string
  readonly status: string
  readonly done?: string | undefined
  readonly decisions?: string | undefined
  readonly files?: string | undefined
  readonly commands?: string | undefined
  readonly problems?: string | undefined
  readonly next_steps: string
  readonly open_questions?: string | undefined
  readonly context?: string | undefined
}

/** Facts the plugin records itself, so the handoff does not depend on the model remembering them. */
export interface HandoffFacts {
  readonly sessionId: string
  readonly title?: string
  readonly preset?: string
  readonly model?: string
  readonly cwd: string
  readonly time: string
  readonly pressure?: string
  readonly git?: string
}

const SECTIONS: ReadonlyArray<readonly [keyof HandoffFields, string]> = [
  ['goal', 'Goal and what the person asked for'],
  ['status', 'Where it stands'],
  ['done', 'Done and verified'],
  ['decisions', 'Decisions and why'],
  ['files', 'Files and places that matter'],
  ['commands', 'Commands, checks and how to verify'],
  ['problems', 'Problems, errors and fixes'],
  ['next_steps', 'Next steps, in order'],
  ['open_questions', 'Open questions and waiting on the person'],
  ['context', 'Other context to keep'],
]

/**
 * Renders a handoff document. Empty sections say "(none)" rather than disappearing, so a reader can tell an empty
 * section from a forgotten one.
 * @param fields - what the agent wrote.
 * @param facts - what the plugin recorded.
 * @returns the Markdown document.
 */
export function renderHandoff(fields: HandoffFields, facts: HandoffFacts): string {
  const lines = [
    `# Handoff${facts.title === undefined ? '' : `: ${facts.title}`}`,
    '',
    `- Session: ${facts.sessionId}`,
    `- Written: ${facts.time}`,
    `- Working folder: ${facts.cwd}`,
    ...facts.preset === undefined ? [] : [`- Mode: ${facts.preset}`],
    ...facts.model === undefined ? [] : [`- Model: ${facts.model}`],
    ...facts.pressure === undefined ? [] : [`- Context used: ${facts.pressure}`],
    '',
  ]
  for (const [key, heading] of SECTIONS) {
    const value = fields[key]?.trim()
    lines.push(`## ${heading}`, '', value === undefined || value === '' ? '(none)' : value, '')
  }
  if (facts.git !== undefined && facts.git !== '') lines.push('## Repository state when written', '', '```text', facts.git, '```', '')
  return lines.join('\n')
}

/**
 * The first message of the continuing session.
 * @param document - the handoff.
 * @param path - where it was saved.
 * @param from - the session that handed off.
 * @returns the message text.
 */
export function continuationPrompt(document: string, path: string, from: string): string {
  return [
    `You are continuing work that session ${from} handed off before its context filled. The handoff below is the`,
    `complete state, also saved at ${path}. Treat it as established context: do not ask the person to repeat anything`,
    'it answers. Check anything it marks unverified, then carry on from "Next steps". Report to the person as usual.',
    '',
    document,
  ].join('\n')
}

/**
 * The repository state, when the folder is a Git checkout. Failures leave it out.
 * @param cwd - the working folder.
 * @returns branch, recent commits and changed files, or undefined.
 */
export function gitState(cwd: string): string | undefined {
  const run = (args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, windowsHide: true }).trim()
  try {
    const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'])
    const log = run(['log', '--oneline', '-5'])
    const status = run(['status', '--short']).split('\n').filter(line => line !== '')
    const shown = status.slice(0, 40)
    const more = status.length > shown.length ? [`... and ${String(status.length - shown.length)} more`] : []
    return [`branch: ${branch}`, '', 'recent commits:', log, '', `changed files (${String(status.length)}):`, ...shown, ...more].join('\n')
  } catch {
    return undefined
  }
}

/**
 * The share of the context window the last request used.
 * @param pressure - the token meter's reading.
 * @returns a fraction, or undefined before the first request.
 */
export function pressureRatio(pressure: { pressureTokens?: number; contextWindow?: number }): number | undefined {
  if (pressure.pressureTokens === undefined || pressure.contextWindow === undefined || pressure.contextWindow <= 0) return undefined
  return pressure.pressureTokens / pressure.contextWindow
}

/**
 * Whether to tell the agent to hand off now.
 * @param ratio - the share of the window the last request used.
 * @param threshold - the configured share.
 * @param continued - whether this session itself began from a handoff.
 * @param baseline - the first share this session measured.
 * @param minGrowth - the share a continued session must add first.
 * @returns true at the threshold, and for a continued session only after real growth.
 */
export function shouldNotice(ratio: number, threshold: number, continued: boolean, baseline: number, minGrowth: number): boolean {
  if (threshold <= 0 || ratio < threshold) return false
  return !continued || ratio - baseline >= minGrowth
}

/**
 * The first share recorded for a session, recording this one when there is none.
 * @param baselines - the record.
 * @param id - the session.
 * @param ratio - the current share.
 * @returns the session's first share.
 */
export function baselineOf(baselines: Map<string, number>, id: string, ratio: number): number {
  const known = baselines.get(id)
  if (known !== undefined) return known
  baselines.set(id, ratio)
  return ratio
}

/** The notice that tells the agent to hand off. */
export function handoffNotice(ratio: number, window: number): string {
  const percent = Math.round(ratio * 100)
  return [
    `Context check: the last request used ${String(percent)}% of this model's ${String(window)}-token context window.`,
    'Hand off now, before it fills: finish only the step in hand if it takes a moment, then call the `handoff` tool with',
    'a complete, detailed handoff. Write it for a capable colleague who has seen none of this conversation: exact paths,',
    'commands, versions, error messages, decisions with their reasons, what is verified and what is not, and the next',
    'steps in order. The work then continues in a new session. After the tool returns, end your turn with one line',
    'naming the new session.',
  ].join(' ')
}

const handoffStateSchema = zod.object({ noticed: zod.boolean(), continued: zod.boolean() })

/**
 * @param ctx - an agent preset scope.
 * @param config - the handoff settings.
 */
export function apply(ctx: Context, config: Config): void {
  const threshold = config.threshold ?? 0.7
  const minGrowth = config.minGrowth ?? 0.25
  // The first share each continued session measured, held in memory: after a restart it is taken again, which only delays the notice.
  const baselines = new Map<string, number>()
  const dirOf = (cwd: string): string => join(cwd, config.dir ?? '.hsf/handoffs')

  const projection = ctx.sessionProjections.register({
    key: 'hsfHandoff',
    stateVersion: 3,
    stateSchema: handoffStateSchema,
    init: () => ({ noticed: false, continued: false }),
    apply: (state, event) => {
      // Only the notice counts: a continued session starts with an hsf-handoff relay and may hand off again later.
      if (event.type !== 'user/message' || event.data.source.kind !== 'hsf-handoff') return state
      if (event.data.source.form === 'notice') return { ...state, noticed: true }
      if (event.data.source.form === 'relay') return { ...state, continued: true }
      return state
    },
  })

  const isRoot = (agent: Agent): boolean => {
    const subagents = ctx.get('subagents')
    if (subagents === undefined) return true
    try {
      return subagents.rootOf(agent) === agent
    } catch {
      return true
    }
  }
  const cwdOf = (agent: Agent): string => ctx.get('workingDirectory')?.get(agent.session) ?? process.cwd()

  // ── Tell the agent once, at the threshold, to hand off. ─────────────────────────────────────────────────────────
  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const handle = await projection
    ctx.fiber.assertActive()
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || threshold <= 0 || !isRoot(agent)) return decision
    const state = handle.stateOf(agent.session)
    if (state.noticed) return decision
    const pressure = ctx.tokenMeter.contextPressure(agent.session)
    const ratio = pressureRatio(pressure)
    if (ratio === undefined || pressure.contextWindow === undefined) return decision
    if (!shouldNotice(ratio, threshold, state.continued, baselineOf(baselines, String(agent.session.id), ratio), minGrowth)) return decision
    const text = handoffNotice(ratio, pressure.contextWindow)
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'hsf-handoff', form: 'notice', summary: `Context ${String(Math.round(ratio * 100))}% full: handing off to a new session` },
      })],
    }
  }, { prepend: true })

  // ── Keep compaction checkpoints too, so a compacted session still leaves a readable record. ─────────────────────
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'compaction/summary') return
    try {
      const cwd = ctx.get('workingDirectory')?.get(session) ?? process.cwd()
      const dir = dirOf(cwd)
      mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      writeFileSync(join(dir, `${stamp}-${String(session.id)}-checkpoint.md`), [
        '# Compaction checkpoint', '', `- Session: ${String(session.id)}`, `- Written: ${new Date().toISOString()}`, '',
        textOf(event.data.summary), '',
      ].join('\n'), 'utf8')
    } catch (error) {
      ctx.logger.warn('hsf-handoff: could not save a compaction checkpoint: %s', String(error))
    }
  })

  // ── The handoff itself. ─────────────────────────────────────────────────────────────────────────────────────────
  const field = (description: string) => ({ type: 'string' as const, description })
  const needed = (description: string) => ({ type: 'string' as const, description, required: true as const })
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'handoff',
    description: 'Write a detailed handoff and continue the work in a new session with a clean context. Use it when told the context is filling, when the person asks, or before a very long next phase. Write each field for a capable colleague who has seen none of this conversation: exact paths, commands, versions, errors, decisions with reasons, and what is and is not verified. Set continue to false only to save the handoff without starting a new session.',
    parameters: {
      goal: needed('What the person asked for and the goal behind it, quoting their exact words where they matter.'),
      status: needed('Where the work stands right now, including anything half-done.'),
      done: field('What is finished, and how each part was verified.'),
      decisions: field('Decisions made and why, including options ruled out and the person\'s preferences and corrections.'),
      files: field('Files, folders, URLs, records and services that matter, each with why.'),
      commands: field('Commands that build, run, test or check the work, and their last results.'),
      problems: field('Errors met, their causes, fixes, and anything still failing.'),
      next_steps: needed('The remaining work, in order, concrete enough to start without asking.'),
      open_questions: field('Questions waiting on the person, and approvals not yet given.'),
      context: field('Anything else the next session needs: constraints, credentials by name only (never values), environment facts.'),
      continue: { type: 'boolean', description: 'Start a new session on this handoff (default true).' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('handoff needs a calling agent.')
      const cwd = cwdOf(agent)
      const pressure = ctx.tokenMeter.contextPressure(agent.session)
      const ratio = pressureRatio(pressure)
      const model = agent.model.current()
      const preset = ctx.get('agentPresets')?.presetForSession(agent.session) ?? undefined
      const title = ctx.get('sessionTitle')?.get(agent.session)?.title
      const facts: HandoffFacts = {
        sessionId: String(agent.session.id),
        ...title === undefined ? {} : { title },
        ...preset === undefined || preset === null ? {} : { preset },
        ...model === undefined ? {} : { model: `${model.provider}/${model.model}` },
        cwd,
        time: new Date().toISOString(),
        ...ratio === undefined || pressure.contextWindow === undefined ? {} : { pressure: `${String(Math.round(ratio * 100))}% of ${String(pressure.contextWindow)} tokens` },
        ...(() => { const git = gitState(cwd); return git === undefined ? {} : { git } })(),
      }
      const fields: HandoffFields = {
        goal: args.goal, status: args.status, next_steps: args.next_steps, done: args.done, decisions: args.decisions,
        files: args.files, commands: args.commands, problems: args.problems, open_questions: args.open_questions, context: args.context,
      }
      const document = renderHandoff(fields, facts)
      const dir = dirOf(cwd)
      mkdirSync(dir, { recursive: true })
      const path = join(dir, `${facts.time.replace(/[:.]/g, '-')}-${facts.sessionId}.md`)
      writeFileSync(path, document, 'utf8')
      if (args.continue === false) return `Handoff saved to ${path}. No new session was started.`

      const controller = ctx.get('sessionController')
      if (controller === undefined) return `Handoff saved to ${path}, but this deployment cannot open sessions, so continue by hand: start a new chat in ${cwd} and paste the file.`
      const created = await controller.create({
        sessionId: SessionId(randomUUID()),
        cwd,
        ...preset === undefined || preset === null ? {} : { agentPreset: preset },
      })
      const sessionId = created.sessionId
      const resolved = await controller.resolveAgent(sessionId)
      if ('error' in resolved) return `Handoff saved to ${path}. A new session ${String(sessionId)} was created but could not start (${resolved.error.message}); open it and paste the file.`
      const next = resolved.agent
      try {
        await (await ctx.get('workspaceRegistry')?.resolveByPath(cwd))?.attachSession(sessionId)
      } catch (error) {
        ctx.logger.warn('hsf-handoff: the new session did not join the workspace at %s: %s', cwd, String(error))
      }
      if (model !== undefined) next.model.select(model)
      try {
        ctx.get('sessionTitle')?.rename(next.session, `${title ?? 'Task'} (continued)`)
      } catch (error) {
        ctx.logger.debug('hsf-handoff: the new session was not named: %s', String(error))
      }
      next.followup(createUserMessage({
        content: [{ type: 'text', text: continuationPrompt(document, path, facts.sessionId) }],
        source: { kind: 'hsf-handoff', form: 'relay' },
      }))
      await ctx.sessions.flush(next.session)
      return `Handoff saved to ${path}. The work continues in the new session ${String(sessionId)}${title === undefined ? '' : ` ("${title} (continued)")`}, which has started on it. Stop here: end your turn with one line naming that session.`
    },
  })), 'hsf-handoff: handoff tool')
}
