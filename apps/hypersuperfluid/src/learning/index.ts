/**
 * The self-improvement loop, mounted once per agent preset: bounded memory visible to every session, a skill library
 * the agent maintains, background reviews of finished work, and lifecycle maintenance of what it learned.
 * Durable text reaches the model through `agent/pre-step` user messages, so it is logged and appended rather than
 * rewriting the cached prefix.
 * @module hypersuperfluid/learning
 */

import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { textOf } from '../content.ts'
import { hsfHome } from '../home.ts'
import { DEFAULT_CURATOR, runCurator, runCuratorIfDue, type CuratorConfig } from './curator.ts'
import { DEFAULT_MEMORY_LIMITS, MemoryStore, type MemoryTarget, type MemoryWrite } from './memory.ts'
import { CURATOR_PROMPT, REVIEW_PROMPT, REVIEW_TOOLS } from './prompts.ts'
import { SkillStore } from './skill-store.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'hsf-memory': { kind: 'hsf-memory' } & ContextFormed
  }
}

/** Cordis plugin name. */
export const name = 'hsf-learning'
/** Services this plugin needs. */
export const inject = ['tools', 'subagents', 'sessionProjections']

/** Learning settings. */
export interface Config {
  /** State directory; defaults to `HSF_HOME`, then `<DSH_HOME>/hsf`. */
  home?: string
  /** Background reviews after this many of the person's messages; 0 disables them. */
  reviewEveryTurns?: number
  /** Background reviews after this many tool calls; 0 disables them. */
  reviewEveryToolCalls?: number
  /** Maximum characters of `MEMORY.md`. */
  memoryChars?: number
  /** Maximum characters of `USER.md`. */
  userChars?: number
  /** Hours between deterministic curator passes. */
  curatorIntervalHours?: number
  /** Days of inactivity before a skill becomes stale. */
  staleAfterDays?: number
  /** Days of inactivity before a skill is archived. */
  archiveAfterDays?: number
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  home: z.string(),
  reviewEveryTurns: z.natural().default(10),
  reviewEveryToolCalls: z.natural().default(15),
  memoryChars: z.natural().default(DEFAULT_MEMORY_LIMITS.memory),
  userChars: z.natural().default(DEFAULT_MEMORY_LIMITS.user),
  curatorIntervalHours: z.natural().default(DEFAULT_CURATOR.intervalHours),
  staleAfterDays: z.natural().default(DEFAULT_CURATOR.staleAfterDays),
  archiveAfterDays: z.natural().default(DEFAULT_CURATOR.archiveAfterDays),
})

const memoryStateSchema = zod.object({ lastHash: zod.string().nullable() })
const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex')

function describeWrite(write: MemoryWrite): string {
  return `${write.target}: ${write.entries} entries, ${write.used} of ${write.limit} characters used.`
}

/**
 * @param ctx - an agent preset scope.
 * @param config - the learning settings.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const home = hsfHome(config.home)
  const memory = new MemoryStore(join(home, 'memory'), {
    memory: config.memoryChars ?? DEFAULT_MEMORY_LIMITS.memory,
    user: config.userChars ?? DEFAULT_MEMORY_LIMITS.user,
  })
  const skills = new SkillStore(join(home, 'skills'))
  const curator: CuratorConfig = {
    intervalHours: config.curatorIntervalHours ?? DEFAULT_CURATOR.intervalHours,
    staleAfterDays: config.staleAfterDays ?? DEFAULT_CURATOR.staleAfterDays,
    archiveAfterDays: config.archiveAfterDays ?? DEFAULT_CURATOR.archiveAfterDays,
    backupsKept: DEFAULT_CURATOR.backupsKept,
  }
  const reviewEveryTurns = config.reviewEveryTurns ?? 10
  const reviewEveryToolCalls = config.reviewEveryToolCalls ?? 15

  const log = (line: string): void => {
    mkdirSync(home, { recursive: true })
    appendFileSync(join(home, 'learning.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
  }

  // ── Memory reaches each session as a durable, appended snapshot, re-sent only when it changed. ─────────────────────
  const projection = ctx.sessionProjections.register({
    key: 'hsfMemory',
    stateVersion: 1,
    stateSchema: memoryStateSchema,
    init: () => ({ lastHash: null }),
    apply: (state, event) => {
      if (event.type !== 'user/message' || event.data.source.kind !== 'hsf-memory') return state
      if (event.data.source.form !== 'snapshot') return state
      return { lastHash: hashOf(event.data.source.sections.map(section => section.text).join('\n')) }
    },
  })

  ctx.on('agent/pre-step', async ({ agent, step, signal }, next): Promise<PreStepDecision> => {
    const handle = await projection
    ctx.fiber.assertActive()
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || step !== 1) return decision
    const text = memory.snapshot()
    if (text === '' || handle.stateOf(agent.session).lastHash === hashOf(text)) return decision
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'hsf-memory', form: 'snapshot', sections: [{ name: 'hsf-memory', text }] },
      })],
    }
  }, { prepend: true })

  // ── Model-facing tools. ───────────────────────────────────────────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory',
    description: 'Keep a durable fact for future sessions. target "user" is who the person is and how they want you to work; target "memory" is the environment: tool quirks, conventions, paths. Save only what this conversation grounds, and remove what turned out wrong. Never store secrets. Stores are small: replace stale entries instead of piling up.',
    parameters: {
      action: { type: 'string', required: true, enum: ['add', 'replace', 'remove'] },
      target: { type: 'string', required: true, enum: ['memory', 'user'] },
      content: { type: 'string', description: 'The fact, for add and replace.' },
      old_text: { type: 'string', description: 'A unique part of the entry to change, for replace and remove.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args) {
      const target = args.target as MemoryTarget
      switch (args.action) {
        case 'add': return Promise.resolve(describeWrite(memory.add(target, args.content ?? '')))
        case 'replace': return Promise.resolve(describeWrite(memory.replace(target, args.old_text ?? '', args.content ?? '')))
        default: return Promise.resolve(describeWrite(memory.remove(target, args.old_text ?? '')))
      }
    },
  })), 'hsf memory tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'skill_view',
    description: 'Inspect your self-written skill library. Without a name it lists the skills with usage counts. With a name it returns SKILL.md, or a support file with file_path, and enables edits to what you read. To follow a skill during normal work, prefer the skill tool.',
    parameters: {
      name: { type: 'string' },
      file_path: { type: 'string', description: 'A path under references/, templates/ or scripts/.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args, exec) {
      if (args.name === undefined) {
        const rows = skills.list().map(skill => `- ${skill.name} [${skill.usage.state}${skill.usage.pinned ? ', pinned' : ''}, by ${skill.usage.createdBy}, used ${skill.usage.useCount}x]: ${skill.description}`)
        const archived = skills.archived()
        return Promise.resolve([...rows.length > 0 ? rows : ['The library is empty.'], ...archived.length > 0 ? [`Archived: ${archived.join(', ')}`] : []].join('\n'))
      }
      const view = skills.view(String(exec.agent?.id ?? 'unknown'), args.name, args.file_path)
      return Promise.resolve(view.files.length > 0 ? `${view.content}\n\n<support_files>\n${view.files.join('\n')}\n</support_files>` : view.content)
    },
  })), 'hsf skill_view tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'skill_manage',
    description: 'Write down how to do a class of task so future sessions do it right the first time. Actions: create a new class-level skill (content is the whole SKILL.md with frontmatter name and description); patch one passage of SKILL.md (old_text, new_text); write_file or remove_file for references/, templates/ or scripts/; archive; restore; pin; unpin. View a skill with skill_view before changing it. Name the class of task, never a ticket, an error string, or today\'s one-off.',
    parameters: {
      action: { type: 'string', required: true, enum: ['create', 'patch', 'write_file', 'remove_file', 'archive', 'restore', 'pin', 'unpin'] },
      name: { type: 'string', required: true },
      content: { type: 'string' },
      old_text: { type: 'string' },
      new_text: { type: 'string' },
      file_path: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args, exec) {
      const reader = String(exec.agent?.id ?? 'unknown')
      switch (args.action) {
        case 'create': skills.create(args.name, args.content ?? ''); break
        case 'patch': skills.patch(reader, args.name, args.old_text ?? '', args.new_text ?? ''); break
        case 'write_file': skills.writeFile(reader, args.name, args.file_path ?? '', args.content ?? ''); break
        case 'remove_file': skills.removeFile(reader, args.name, args.file_path ?? ''); break
        case 'archive': skills.archive(args.name); break
        case 'restore': skills.restore(args.name); break
        case 'pin': skills.setFlags(args.name, { pinned: true }); break
        default: skills.setFlags(args.name, { pinned: false })
      }
      log(`skill ${args.action} ${args.name}`)
      return Promise.resolve(`Done: ${args.action} ${args.name}.`)
    },
  })), 'hsf skill_manage tool')

  // ── Background reviews fork the conversation, so they read what happened at the parent's cached prefix. ───────────
  const reviewing = new Set<string>()
  const counters = new WeakMap<Agent, { turns: number; tools: number; busy: boolean }>()
  const countersOf = (agent: Agent) => {
    let found = counters.get(agent)
    if (found === undefined) {
      found = { turns: 0, tools: 0, busy: false }
      counters.set(agent, found)
    }
    return found
  }
  const isRoot = (agent: Agent): boolean => {
    try {
      return ctx.subagents.rootOf(agent) === agent
    } catch (error: unknown) {
      ctx.logger.debug('hsf-learning: not a tree root: %s', String(error))
      return false
    }
  }

  const startFork = async (agent: Agent, label: string, prompt: string): Promise<void> => {
    const state = countersOf(agent)
    if (state.busy) return
    state.busy = true
    const childId = SessionId(randomUUID())
    reviewing.add(String(childId))
    const abort = new AbortController()
    try {
      const activation = await ctx.subagents.startActivation({
        provider: 'fork', label, name: `learning-${childId.slice(0, 8)}`, childId, parent: agent,
        prompt: [{ type: 'text', text: prompt }], signal: abort.signal, delivery: 'caller',
      })
      try {
        const result = await activation.result
        log(`${label} (${result.stopReason}): ${textOf(result.output).replaceAll('\n', ' | ').slice(0, 600)}`)
      } finally {
        await activation.dispose()
      }
    } catch (error: unknown) {
      log(`${label} failed: ${String(error)}`)
      ctx.logger.warn('hsf-learning: %s failed: %s', label, String(error))
    } finally {
      reviewing.delete(String(childId))
      state.busy = false
    }
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (reviewing.has(String(exec.agent?.id)) && !REVIEW_TOOLS.has(exec.name)) {
      return { kind: 'deny', reason: 'This background review may use only memory, skill_view and skill_manage.' }
    }
    return next()
  })

  ctx.on('tools/result', (exec) => {
    const agent = exec.agent
    if (agent === undefined || reviewing.has(String(agent.id))) return
    countersOf(agent).tools += 1
    if (exec.name === 'skill' && typeof exec.arguments === 'object' && exec.arguments !== null && 'name' in exec.arguments && typeof exec.arguments.name === 'string') {
      skills.recordUse(exec.arguments.name)
    }
  })

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    if (messages.some(message => message.source.kind === 'user')) countersOf(agent).turns += 1
    return next()
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle' || !isRoot(agent)) return
    const report = runCuratorIfDue(skills, curator, Date.now())
    if (report !== undefined && report.staled.length + report.archived.length + report.reactivated.length > 0) {
      log(`curator: staled ${report.staled.join(', ') || 'none'}; archived ${report.archived.join(', ') || 'none'}; reactivated ${report.reactivated.join(', ') || 'none'}`)
    }
    const state = countersOf(agent)
    const turnsDue = reviewEveryTurns > 0 && state.turns >= reviewEveryTurns
    const toolsDue = reviewEveryToolCalls > 0 && state.tools >= reviewEveryToolCalls
    if (!turnsDue && !toolsDue) return
    state.turns = 0
    state.tools = 0
    void startFork(agent, 'Learning review', REVIEW_PROMPT)
  })

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'learning_run',
    description: 'Start background learning now instead of waiting for it. mode "review" reviews this conversation into memory and skills; mode "consolidate" merges overlapping skills; mode "curate" applies the lifecycle rules to unused skills at once and reports the changes.',
    parameters: { mode: { type: 'string', required: true, enum: ['review', 'consolidate', 'curate'] } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args, exec) {
      if (args.mode === 'curate') return Promise.resolve(JSON.stringify(runCurator(skills, curator, Date.now())))
      if (exec.agent === undefined) throw new Error('learning_run needs a calling agent.')
      void startFork(exec.agent, args.mode === 'review' ? 'Learning review' : 'Skill consolidation', args.mode === 'review' ? REVIEW_PROMPT : CURATOR_PROMPT)
      return Promise.resolve(`Started ${args.mode} in the background. Results appear in ${join(home, 'learning.log')}.`)
    },
  })), 'hsf learning_run tool')
}
