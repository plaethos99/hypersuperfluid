/**
 * Subscription chat models: each installed vendor CLI (Grok Build, Google Antigravity, Gemini CLI, OpenCode, Hermes)
 * appears in the chat model picker, and choosing it runs that vendor's own agent on the person's plan as the chat's
 * model. The CLI keeps its own login; this plugin never reads, copies or forwards a token.
 *
 * A vendor agent is a whole agent, not a bare model: it works with its own tools in the session's working folder,
 * and it cannot call DSH's tools. Its tool activity and thinking arrive as reasoning text, its answer as the reply.
 * One CLI session backs each DSH session while the app runs, so a turn sends only the new user input. When that
 * session is missing (first turn, after a restart, or after a retry changed the history), a fresh CLI session gets
 * the conversation so far as text.
 * @module hypersuperfluid/acp-chat
 */

import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ContentBlock as AcpContentBlock,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, RequestMessage, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-working-directory'
import { resolveCommand } from './workers.ts'

/** Cordis plugin name. */
export const name = 'hsf-acp-chat'
/** Services this plugin needs; the working folder comes from the optional `workingDirectory`. */
export const inject = ['llm', 'subprocess', 'sessions']

/** One vendor CLI offered as a chat model. */
export interface ChatCliConfig {
  /** The worker id; the provider route is `sub-<id>`. */
  id: string
  /** The product name shown in the picker. */
  label: string
  /** The executable's name on PATH, or an absolute path. */
  command: string
  /** Arguments that start its ACP server. */
  args: string[]
}

/** Plugin settings. */
export interface Config {
  /** The CLIs to offer. */
  clis?: ChatCliConfig[]
  /** How to answer a CLI's requests to use its own tools: allow, or refuse everything but chat. */
  permission?: 'allow' | 'reject'
  /** Stop a chat's CLI after this many idle minutes; the next turn starts it again with the conversation so far. */
  idleMinutes?: number
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  clis: z.array(z.object({
    id: z.string().required(),
    label: z.string().required(),
    command: z.string().required(),
    args: z.array(z.string()).required(),
  })).default([]),
  permission: z.union(['allow', 'reject']).default('allow'),
  idleMinutes: z.natural().default(30),
})

/** The provider route of a CLI. */
export function routeOf(id: string): string {
  return `sub-${id}`
}

/** The model id each route offers: the CLI's own default model on the person's plan. */
export const MODEL_ID = 'plan'

/** Visible text of user-role content; images and files are named, not sent. */
export function userText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push('[an image was attached here; this model receives text only]')
    else if (block.type === 'file') parts.push('[a file was attached here; this model receives text only]')
  }
  return parts.join('\n')
}

function assistantText(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('')
}

/** What one turn sends: the user input since the last reply, and how many replies came before it. */
export interface TurnInput {
  /** Replies already in the history. */
  readonly replies: number
  /** The new user input. */
  readonly input: string
  /** The whole conversation as text, for a CLI session that has not seen it. */
  readonly transcript: string
}

/**
 * Splits a request into the new user input and the conversation before it.
 * @param messages - the request's messages.
 * @returns the turn's input.
 */
export function turnInput(messages: readonly RequestMessage[]): TurnInput {
  let lastReply = -1
  messages.forEach((message, index) => { if (message.role === 'assistant') lastReply = index })
  const replies = messages.filter(message => message.role === 'assistant').length
  const input = messages.slice(lastReply + 1)
    .filter(message => message.role === 'user')
    .map(message => userText(message.content))
    .filter(text => text.trim() !== '')
    .join('\n\n')
  const lines: string[] = []
  for (const message of messages.slice(0, lastReply + 1)) {
    if (message.role === 'user') {
      const text = userText(message.content).trim()
      if (text !== '') lines.push(`User: ${text}`)
    } else if (message.role === 'assistant') {
      const text = assistantText(message.content).trim()
      if (text !== '') lines.push(`Assistant: ${text}`)
    }
  }
  const transcript = lines.length === 0
    ? input
    : `This conversation started earlier, possibly with another model. Here it is so far:\n\n${lines.join('\n\n')}\n\nThe user now says:\n\n${input}`
  return { replies, input, transcript }
}

/** A queue that turns pushed chunks into an async iterable; `close(error)` makes the next read reject. */
export class ChunkQueue implements AsyncIterable<StreamChunk> {
  private readonly items: StreamChunk[] = []
  private reader: { resolve: (result: IteratorResult<StreamChunk>) => void; reject: (reason: unknown) => void } | undefined
  private ended: { failure: unknown } | undefined

  push(chunk: StreamChunk): void {
    if (this.ended !== undefined) return
    const reader = this.reader
    this.reader = undefined
    if (reader === undefined) this.items.push(chunk)
    else reader.resolve({ value: chunk, done: false })
  }

  close(failure?: unknown): void {
    if (this.ended !== undefined) return
    this.ended = { failure }
    const reader = this.reader
    this.reader = undefined
    if (reader === undefined) return
    if (failure === undefined) reader.resolve({ value: undefined, done: true })
    else reader.reject(failure)
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
    return {
      next: () => new Promise<IteratorResult<StreamChunk>>((resolve, reject) => {
        const item = this.items.shift()
        if (item !== undefined) resolve({ value: item, done: false })
        else if (this.ended === undefined) this.reader = { resolve, reject }
        else if (this.ended.failure === undefined) resolve({ value: undefined, done: true })
        else reject(this.ended.failure)
      }),
    }
  }
}

/** Turns ACP updates into text and reasoning blocks. */
export class BlockWriter {
  private index = -1
  private kind: 'text' | 'reasoning' | undefined
  private buffer = ''
  private readonly tools = new Map<string, string>()

  constructor(private readonly emit: (chunk: StreamChunk) => void) {}

  private write(kind: 'text' | 'reasoning', text: string): void {
    if (text === '') return
    if (this.kind !== kind) {
      this.end()
      this.index += 1
      this.kind = kind
      this.emit({ type: 'block-start', index: this.index, blockType: kind })
    }
    this.buffer += text
    this.emit(kind === 'text' ? { type: 'text-delta', index: this.index, text } : { type: 'reasoning-delta', index: this.index, text })
  }

  /** Closes the open block. */
  end(): void {
    if (this.kind === undefined) return
    this.emit({ type: 'block-end', index: this.index, block: { type: this.kind, text: this.buffer } })
    this.kind = undefined
    this.buffer = ''
  }

  /** Whether anything was written. */
  get wrote(): boolean {
    return this.index >= 0
  }

  /**
   * Applies one ACP session update.
   * @param update - the update.
   */
  apply(update: SessionNotification['update']): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') this.write('text', update.content.text)
        break
      case 'agent_thought_chunk':
        if (update.content.type === 'text') this.write('reasoning', update.content.text)
        break
      case 'tool_call':
        this.tools.set(update.toolCallId, update.title)
        this.write('reasoning', `\n▸ ${update.title}\n`)
        break
      case 'tool_call_update': {
        const title = update.title ?? this.tools.get(update.toolCallId) ?? 'tool'
        if (update.status === 'failed') this.write('reasoning', `✗ ${title} failed\n`)
        break
      }
      case 'plan':
        this.write('reasoning', `\nPlan:\n${update.entries.map(entry => `${entry.status === 'completed' ? '✓' : '·'} ${entry.content}`).join('\n')}\n`)
        break
      default:
        break
    }
  }
}

const AUTH_ERROR = /auth|log ?in|sign ?in|credential|unauthori[sz]ed/iu

/** One running CLI behind one DSH session. */
interface ChatProcess {
  readonly child: SubprocessHandle
  readonly sessionId: string
  readonly agent: ReturnType<ReturnType<ReturnType<typeof createAcpClientApp>['onNotification']>['connect']>['agent']
  readonly cwd: string
  /** Replies this CLI session has given. */
  replies: number
  /** Where the current turn's updates go. */
  sink: ((update: SessionNotification['update']) => void) | undefined
  idle: ReturnType<typeof setTimeout> | undefined
  busy: boolean
}

/** The adapter: one provider route per installed CLI. */
export class AcpChatAdapter extends LlmAdapter {
  private readonly chats = new Map<string, ChatProcess>()
  private readonly byRoute = new Map<string, ChatCliConfig & { argv: string[]; env: Record<string, string> }>()

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    clis: ReadonlyArray<ChatCliConfig & { argv: string[]; env: Record<string, string> }>,
  ) {
    super()
    for (const cli of clis) this.byRoute.set(routeOf(cli.id), cli)
  }

  /** The provider routes this adapter owns. */
  get routes(): string[] {
    return [...this.byRoute.keys()]
  }

  private cli(provider: string): ChatCliConfig & { argv: string[]; env: Record<string, string> } {
    const cli = this.byRoute.get(provider)
    if (cli === undefined) throw new Error(`hsf-acp-chat: no CLI for ${provider}`)
    return cli
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: `${this.cli(provider).label} (subscription)` }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const cli = this.cli(provider)
    return Promise.resolve([{
      provider, id: MODEL_ID, name: `${cli.label} · your plan`,
      description: `Runs ${cli.label} on your own subscription with its own tools in the working folder. It cannot use Hypersuperfluid's tools, and it receives text only.`,
      inputModalities: ['text'],
      badge: { text: 'Subscription', tone: 'info' },
    }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const cli = this.cli(provider)
    // The vendor agent manages its own context, so DSH never compacts or hands off on its behalf.
    return Promise.resolve({ provider, id: model, name: `${cli.label} · your plan`, inputModalities: ['text'], context: { contextWindow: 10_000_000 } })
  }

  /** Stops every CLI. */
  async dispose(): Promise<void> {
    const chats = [...this.chats.values()]
    this.chats.clear()
    await Promise.allSettled(chats.map(chat => this.stop(chat)))
  }

  private async stop(chat: ChatProcess): Promise<void> {
    if (chat.idle !== undefined) clearTimeout(chat.idle)
    chat.child.stdin?.end()
    chat.child.terminate()
    await chat.child.waitForExit().catch(() => false)
  }

  private cwdOf(sessionId: SessionId | undefined): string {
    if (sessionId === undefined) return process.cwd()
    const session: Session | undefined = this.ctx.sessions.get(sessionId)
    if (session === undefined) return process.cwd()
    return this.ctx.get('workingDirectory')?.get(session) ?? process.cwd()
  }

  private async start(provider: string, cwd: string): Promise<ChatProcess> {
    const cli = this.cli(provider)
    const child = this.ctx.subprocess.spawn({
      argv: cli.argv, cwd, graceMs: 3_000, env: cli.env,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 16_384 } },
    })
    if (child.stdin === undefined || child.stdout === undefined) throw new Error('hsf-acp-chat: the CLI has no protocol pipes')
    const holder: { chat?: ChatProcess } = {}
    const permission = this.config.permission ?? 'allow'
    const app = createAcpClientApp({ name: 'hypersuperfluid-chat' })
      .onNotification(methods.client.session.update, ({ params }) => {
        holder.chat?.sink?.(params.update)
        return Promise.resolve()
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        if (permission === 'allow') {
          const allow = params.options.find(option => option.kind === 'allow_once' || option.kind === 'allow_always')
          if (allow !== undefined) return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } })
        }
        return Promise.resolve({ outcome: { outcome: 'cancelled' } })
      })
    const connection = app.connect(ndJsonStream(
      NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ))
    const agent = connection.agent
    const exited = child.done.then((outcome) => {
      throw new Error(`${cli.label} stopped (exit code ${String(outcome.exitCode)}). ${stderrTail(child)}`.trim())
    })
    exited.catch(() => {})
    try {
      await Promise.race([agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }), exited])
      const session = await Promise.race([agent.request(methods.agent.session.new, { cwd, mcpServers: [] }), exited])
      const chat: ChatProcess = {
        child, sessionId: session.sessionId, agent, cwd, replies: 0, sink: undefined, idle: undefined, busy: false,
      }
      holder.chat = chat
      return chat
    } catch (error) {
      child.terminate()
      const message = error instanceof Error ? error.message : String(error)
      if (AUTH_ERROR.test(message)) {
        throw new Error(`${cli.label} is not signed in. Open Settings → Subscriptions and choose Sign in, then send your message again.`, { cause: error })
      }
      throw new Error(`${cli.label} could not start a session: ${message}`, { cause: error })
    }
  }

  private armIdle(key: string, chat: ChatProcess): void {
    if (chat.idle !== undefined) clearTimeout(chat.idle)
    const minutes = this.config.idleMinutes ?? 30
    if (minutes === 0) return
    chat.idle = setTimeout(() => {
      if (chat.busy || this.chats.get(key) !== chat) return
      this.chats.delete(key)
      void this.stop(chat)
    }, minutes * 60_000)
    chat.idle.unref?.()
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const queue = new ChunkQueue()
    void this.run(options, queue).then(() => { queue.close() }, (error: unknown) => { queue.close(error) })
    return queue
  }

  private async run(options: GenerateOptions, queue: ChunkQueue): Promise<void> {
    const cli = this.cli(options.provider)
    // Titles and summaries would spend the plan on bookkeeping; DSH falls back to its own titles.
    if (options.purpose !== undefined) throw new Error(`${cli.label} answers conversation turns only`)
    const turn = turnInput(options.messages)
    if (turn.input === '') throw new Error('There is no new message to send.')
    const key = `${options.provider}\u0000${options.sessionId ?? ''}`
    const cwd = this.cwdOf(options.sessionId)
    let chat = options.sessionId === undefined ? undefined : this.chats.get(key)
    if (chat !== undefined && (chat.busy || chat.replies !== turn.replies || chat.cwd !== cwd)) {
      this.chats.delete(key)
      void this.stop(chat)
      chat = undefined
    }
    const fresh = chat === undefined
    chat ??= await this.start(options.provider, cwd)
    if (options.sessionId !== undefined) this.chats.set(key, chat)
    const live = chat
    live.busy = true
    if (live.idle !== undefined) clearTimeout(live.idle)
    const writer = new BlockWriter((chunk) => { queue.push(chunk) })
    live.sink = (update) => { writer.apply(update) }
    const onAbort = (): void => {
      void live.agent.notify(methods.agent.session.cancel, { sessionId: live.sessionId }).catch(() => {})
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const prompt: AcpContentBlock[] = [{ type: 'text', text: fresh ? turn.transcript : turn.input }]
      const response = await live.agent.request(methods.agent.session.prompt, { sessionId: live.sessionId, prompt })
      writer.end()
      if (options.signal?.aborted === true) throw options.signal.reason instanceof Error ? options.signal.reason : new Error('cancelled')
      if (!writer.wrote) {
        writer.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `(${cli.label} ended its turn without a reply.)` } })
        writer.end()
      }
      live.replies = turn.replies + 1
      const usage = response.usage
      if (usage !== undefined && usage !== null) {
        queue.push({ type: 'usage', usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens } })
      }
      queue.push({ type: 'finish', reason: response.stopReason === 'max_tokens' ? { kind: 'max-tokens' } : { kind: 'stop' } })
    } catch (error) {
      if (options.sessionId !== undefined && this.chats.get(key) === live) this.chats.delete(key)
      void this.stop(live)
      throw error
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      live.sink = undefined
      live.busy = false
      if (this.chats.get(key) === live) this.armIdle(key, live)
    }
  }
}

function stderrTail(child: SubprocessHandle): string {
  try {
    const text = child.collected.stderr?.readFrom(0).text ?? ''
    return text.trim().split('\n').slice(-3).join(' ').slice(0, 400)
  } catch {
    return ''
  }
}

/**
 * Registers a provider route for every installed CLI.
 * @param ctx - the host composition.
 * @param config - the CLIs and the permission policy.
 */
export function apply(ctx: Context, config: Config): void {
  const clis = (config.clis ?? []).flatMap((cli) => {
    const resolved = resolveCommand(cli.command)
    if (resolved === undefined) return []
    // In the desktop app `process.execPath` is Electron, which runs an npm shim's script only in Node mode.
    const env: Record<string, string> = resolved.command === process.execPath && process.versions.electron !== undefined ? { ELECTRON_RUN_AS_NODE: '1' } : {}
    return [{ ...cli, argv: [resolved.command, ...resolved.prefixArgs, ...cli.args], env }]
  })
  if (clis.length === 0) {
    ctx.logger.info('hsf-acp-chat: no subscription CLI is installed, so no subscription models are offered')
    return
  }
  const adapter = new AcpChatAdapter(ctx, config, clis)
  ctx.effect(() => {
    const registration = ctx.llm.registerAdapter(adapter.routes, adapter)
    return () => {
      registration()
      void adapter.dispose()
    }
  }, 'hsf-acp-chat: subscription models')
}
