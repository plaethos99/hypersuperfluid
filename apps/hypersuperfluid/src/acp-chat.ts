/**
 * Subscription chat models: each installed vendor CLI (Grok Build, Google Antigravity, Gemini CLI, OpenCode, Hermes)
 * appears in the chat model picker, and choosing it runs that vendor's own agent on the person's plan as the chat's
 * model. The CLI keeps its own login; this plugin never reads, copies or forwards a token.
 *
 * A vendor agent is a whole agent, not a bare model. It keeps its own tools, and it also gets the chat's
 * Hypersuperfluid tools (the built-in browser, memory, skills, web, Firecrawl, office and ERP tools, whatever the mode
 * has) through an MCP server named `hypersuperfluid`. A call to one of those pauses the vendor's turn: this adapter
 * ends the model step with a DSH tool call, DSH runs it as for any model (approvals, sandbox, the tool's display, the
 * session log), and the next step hands the result back to the waiting vendor and streams on. Its thinking and its
 * own tool activity arrive as reasoning text, its answer as the reply.
 *
 * One CLI session backs each DSH session while the app runs, so a turn sends only the new user input. When that
 * session is missing (first turn, after a restart, or after a retry changed the history), a fresh CLI session gets
 * the conversation so far as text.
 * @module hypersuperfluid/acp-chat
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ContentBlock as AcpContentBlock,
  type McpServer,
  type PromptResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, RequestMessage, StreamChunk,
  ToolCallId, ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-working-directory'
import { McpHost, type McpRegistration, type McpTool, type McpToolResult } from './mcp-host.ts'
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
  /** Offer the chat's Hypersuperfluid tools to the CLI over MCP. */
  shareTools?: boolean
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
  shareTools: z.boolean().default(true),
})

/** The provider route of a CLI. */
export function routeOf(id: string): string {
  return `sub-${id}`
}

/** The model id each route offers: the CLI's own default model on the person's plan. */
export const MODEL_ID = 'plan'

/** The MCP server name the CLI sees; its tools appear to the vendor as `hypersuperfluid` tools. */
export const MCP_SERVER_NAME = 'hypersuperfluid'

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

/** A tool result's text for the vendor; images are named, not sent. */
export function toolResultText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push('[the tool returned an image, which this model cannot see]')
    else if (block.type === 'file') parts.push('[the tool returned a file]')
  }
  return parts.join('\n')
}

function assistantText(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('')
}

/** What one turn sends: the user input since the last reply, and how many replies came before it. */
export interface TurnInput {
  /** Assistant messages already in the history. */
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
  messages.forEach((message, index) => { if (message.role === 'assistant' || message.role === 'tool') lastReply = index })
  const replies = messages.filter(message => message.role === 'assistant').length
  const typed = messages.slice(lastReply + 1)
    .filter(message => message.role === 'user')
    .map(message => userText(message.content))
    .filter(text => text.trim() !== '')
    .join('\n\n')
  // A request that ends with tool results asks the model to go on from them.
  const input = typed === '' && messages.at(-1)?.role === 'tool' ? 'Continue from the tool results above.' : typed
  const lines: string[] = []
  for (const message of messages.slice(0, lastReply + 1)) {
    if (message.role === 'user') {
      const text = userText(message.content).trim()
      if (text !== '') lines.push(`User: ${text}`)
    } else if (message.role === 'assistant') {
      const text = assistantText(message.content).trim()
      if (text !== '') lines.push(`Assistant: ${text}`)
      for (const block of message.content) if (block.type === 'tool-call') lines.push(`Assistant used the tool ${block.name}.`)
    } else if (message.role === 'tool') {
      const text = toolResultText(message.content).trim()
      if (text !== '') lines.push(`Tool result: ${text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text}`)
    }
  }
  const transcript = lines.length === 0
    ? input
    : `This conversation started earlier, possibly with another model. Here it is so far:\n\n${lines.join('\n\n')}\n\nThe user now says:\n\n${input}`
  return { replies, input, transcript }
}

/** The chat's DSH tools as MCP tools. */
export function mcpTools(tools: readonly ToolSchema[]): McpTool[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: typeof tool.parameters.type === 'string' ? tool.parameters : { type: 'object', ...tool.parameters },
  }))
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

/** Turns ACP updates into text, reasoning and tool-call blocks. */
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

  /** Whether any visible text was written. */
  wroteText = false

  /** Whether anything was written. */
  get wrote(): boolean {
    return this.index >= 0
  }

  /**
   * Writes one complete DSH tool call.
   * @param id - the call id.
   * @param tool - the tool name.
   * @param args - the arguments as JSON.
   */
  toolCall(id: ToolCallId, tool: string, args: string): void {
    this.end()
    this.index += 1
    this.emit({ type: 'block-start', index: this.index, blockType: 'tool-call' })
    this.emit({ type: 'tool-call-delta', index: this.index, id, name: tool, argumentsDelta: args })
    this.emit({ type: 'block-end', index: this.index, block: { type: 'tool-call', id, name: tool, arguments: args } })
  }

  /**
   * Applies one ACP session update.
   * @param update - the update.
   */
  apply(update: SessionNotification['update']): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') {
          this.write('text', update.content.text)
          if (update.content.text !== '') this.wroteText = true
        }
        break
      case 'agent_thought_chunk':
        if (update.content.type === 'text') this.write('reasoning', update.content.text)
        break
      case 'tool_call':
        this.tools.set(update.toolCallId, update.title)
        // Calls to the shared tools show as DSH tool calls; repeating them here would show them twice.
        if (!isSharedToolTitle(update.title)) this.write('reasoning', `\n▸ ${update.title}\n`)
        break
      case 'tool_call_update': {
        const title = update.title ?? this.tools.get(update.toolCallId) ?? 'tool'
        if (update.status === 'failed' && !isSharedToolTitle(title)) this.write('reasoning', `✗ ${title} failed\n`)
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

function isSharedToolTitle(title: string): boolean {
  return title.toLowerCase().includes(MCP_SERVER_NAME)
}

const AUTH_ERROR = /auth|log ?in|sign ?in|credential|unauthori[sz]ed/iu

/** A call to a shared tool, from the vendor through MCP. */
interface SharedCall {
  readonly id: ToolCallId
  readonly tool: string
  readonly args: string
  readonly resolve: (result: McpToolResult) => void
  settled: boolean
}

/** The stream step currently reading a chat's turn. */
interface Reader {
  update(update: SessionNotification['update']): void
  calls(calls: SharedCall[]): void
  end(outcome: TurnOutcome): void
}

type TurnOutcome = { readonly response: PromptResponse } | { readonly error: unknown }

/** One running CLI behind one DSH session. */
interface ChatProcess {
  readonly child: SubprocessHandle
  readonly agent: AcpAgent
  readonly cwd: string
  sessionId: string
  mcp: McpRegistration | undefined
  /** The chat's DSH tools, refreshed each step. */
  tools: readonly ToolSchema[]
  /** Assistant messages the history holds once the last step is recorded. */
  replies: number
  /** Whether a vendor turn is in progress. */
  inTurn: boolean
  /** How the last turn ended, when no step was reading. */
  outcome: TurnOutcome | undefined
  /** Updates that arrived while no step was reading. */
  readonly buffered: Array<SessionNotification['update']>
  /** Shared calls that arrived while no step was reading. */
  readonly queued: SharedCall[]
  /** Shared calls handed to DSH and waiting for its results. */
  readonly waiting: Map<string, SharedCall>
  reader: Reader | undefined
  idle: ReturnType<typeof setTimeout> | undefined
}

type AcpAgent = ReturnType<ReturnType<typeof createAcpClientApp>['connect']>['agent']
type ResolvedCli = ChatCliConfig & { argv: string[]; env: Record<string, string> }

/**
 * Where `mcp-bridge` is: beside this module, as `.js` once built and as `.ts` in the source tree.
 * @returns the script's path, or undefined when neither exists.
 */
export function bridgeScript(): string | undefined {
  for (const extension of ['.js', '.ts']) {
    const path = fileURLToPath(new URL(`./mcp-bridge${extension}`, import.meta.url))
    if (existsSync(path)) return path
  }
  return undefined
}

/** The adapter: one provider route per installed CLI. */
export class AcpChatAdapter extends LlmAdapter {
  private readonly chats = new Map<string, ChatProcess>()
  private readonly byRoute = new Map<string, ResolvedCli>()
  private readonly host = new McpHost()

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    clis: readonly ResolvedCli[],
    private readonly bridge: { readonly command: string; readonly args: string[]; readonly env: Record<string, string> } | undefined
      = defaultBridge(),
  ) {
    super()
    for (const cli of clis) this.byRoute.set(routeOf(cli.id), cli)
  }

  /** The provider routes this adapter owns. */
  get routes(): string[] {
    return [...this.byRoute.keys()]
  }

  private cli(provider: string): ResolvedCli {
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
      description: `Runs ${cli.label} on your own subscription. It keeps its own tools and gets this chat's Hypersuperfluid tools, and it receives text only.`,
      inputModalities: ['text'],
      badge: { text: 'Subscription', tone: 'info' },
    }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const cli = this.cli(provider)
    // The vendor agent manages its own context, so DSH never compacts or hands off on its behalf.
    return Promise.resolve({ provider, id: model, name: `${cli.label} · your plan`, inputModalities: ['text'], context: { contextWindow: 10_000_000 } })
  }

  /** Stops every CLI and the tool server. */
  async dispose(): Promise<void> {
    const chats = [...this.chats.values()]
    this.chats.clear()
    await Promise.allSettled(chats.map(chat => this.stop(chat)))
    await this.host.close()
  }

  private async stop(chat: ChatProcess): Promise<void> {
    if (chat.idle !== undefined) clearTimeout(chat.idle)
    this.abandon(chat, 'The chat ended before the tool finished.')
    chat.mcp?.dispose()
    chat.child.stdin?.end()
    chat.child.terminate()
    await chat.child.waitForExit().catch(() => false)
  }

  /** Answers every shared call still open, so the vendor never waits on a step that will not come. */
  private abandon(chat: ChatProcess, reason: string): void {
    for (const call of [...chat.queued, ...chat.waiting.values()]) settle(call, { text: reason, isError: true })
    chat.queued.length = 0
    chat.waiting.clear()
  }

  private cwdOf(sessionId: SessionId | undefined): string {
    if (sessionId === undefined) return process.cwd()
    const session: Session | undefined = this.ctx.sessions.get(sessionId)
    if (session === undefined) return process.cwd()
    return this.ctx.get('workingDirectory')?.get(session) ?? process.cwd()
  }

  private async start(provider: string, cwd: string, tools: readonly ToolSchema[]): Promise<ChatProcess> {
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
        const chat = holder.chat
        if (chat !== undefined && params.sessionId === chat.sessionId) {
          if (chat.reader === undefined) chat.buffered.push(params.update)
          else chat.reader.update(params.update)
        }
        return Promise.resolve()
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        // The shared tools ask DSH's own approval gate, so the vendor's prompt for them is always allowed.
        const shared = isSharedToolTitle(params.toolCall.title ?? '')
        if (permission === 'allow' || shared) {
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
    const chat: ChatProcess = {
      child, agent, cwd, sessionId: '', mcp: undefined, tools, replies: 0, inTurn: false, outcome: undefined,
      buffered: [], queued: [], waiting: new Map(), reader: undefined, idle: undefined,
    }
    try {
      const mcpServers: McpServer[] = []
      if ((this.config.shareTools ?? true) && this.bridge !== undefined && tools.length > 0) {
        chat.mcp = await this.host.register({
          tools: () => mcpTools(chat.tools),
          call: (tool, args, signal) => this.sharedCall(chat, tool, args, signal),
        })
        mcpServers.push({
          name: MCP_SERVER_NAME, command: this.bridge.command, args: this.bridge.args,
          env: Object.entries({ ...this.bridge.env, HSF_MCP_URL: chat.mcp.url, HSF_MCP_TOKEN: chat.mcp.token })
            .map(([key, value]) => ({ name: key, value })),
        })
      }
      await Promise.race([agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }), exited])
      const session = await Promise.race([agent.request(methods.agent.session.new, { cwd, mcpServers }), exited])
      chat.sessionId = session.sessionId
      holder.chat = chat
      return chat
    } catch (error) {
      chat.mcp?.dispose()
      child.terminate()
      const message = error instanceof Error ? error.message : String(error)
      if (AUTH_ERROR.test(message)) {
        throw new Error(`${cli.label} is not signed in. Open Settings → Subscriptions and choose Sign in, then send your message again.`, { cause: error })
      }
      throw new Error(`${cli.label} could not start a session: ${message}`, { cause: error })
    }
  }

  /** A shared tool call from the vendor: handed to the reading step, or queued for the next one. */
  private sharedCall(chat: ChatProcess, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpToolResult> {
    return new Promise((resolve) => {
      const call: SharedCall = {
        id: brandString<ToolCallId>(`hsf_${randomUUID().replaceAll('-', '')}`), tool, args: JSON.stringify(args), resolve, settled: false,
      }
      signal.addEventListener('abort', () => {
        settle(call, { text: 'cancelled', isError: true })
        const queuedAt = chat.queued.indexOf(call)
        if (queuedAt >= 0) chat.queued.splice(queuedAt, 1)
      }, { once: true })
      if (chat.reader === undefined) chat.queued.push(call)
      else chat.reader.calls([call])
    })
  }

  private armIdle(key: string, chat: ChatProcess): void {
    if (chat.idle !== undefined) clearTimeout(chat.idle)
    const minutes = this.config.idleMinutes ?? 30
    if (minutes === 0 || chat.inTurn) return
    chat.idle = setTimeout(() => {
      if (chat.inTurn || this.chats.get(key) !== chat) return
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

  /** Begins a vendor turn; its end reaches the reading step, or waits for the next one. */
  private begin(chat: ChatProcess, text: string): void {
    chat.inTurn = true
    chat.outcome = undefined
    const prompt: AcpContentBlock[] = [{ type: 'text', text }]
    const finish = (outcome: TurnOutcome): void => {
      chat.inTurn = false
      this.abandon(chat, 'The turn ended before the tool finished.')
      if (chat.reader === undefined) chat.outcome = outcome
      else chat.reader.end(outcome)
    }
    chat.agent.request(methods.agent.session.prompt, { sessionId: chat.sessionId, prompt })
      .then((response) => { finish({ response }) }, (error: unknown) => { finish({ error }) })
  }

  /** Cancels a vendor turn and waits briefly for it to end. */
  private async cancelTurn(chat: ChatProcess): Promise<boolean> {
    if (!chat.inTurn) return true
    this.abandon(chat, 'The person sent a new message instead.')
    const ended = new Promise<void>((done) => {
      chat.reader = { update: () => {}, calls: (calls) => { for (const call of calls) settle(call, { text: 'cancelled', isError: true }) }, end: () => { done() } }
    })
    void chat.agent.notify(methods.agent.session.cancel, { sessionId: chat.sessionId }).catch(() => {})
    const timeout = new Promise<'timeout'>((done) => { setTimeout(() => { done('timeout') }, 10_000).unref?.() })
    const result = await Promise.race([ended, timeout])
    chat.reader = undefined
    chat.buffered.length = 0
    return result !== 'timeout'
  }

  private async run(options: GenerateOptions, queue: ChunkQueue): Promise<void> {
    const cli = this.cli(options.provider)
    // Titles and summaries would spend the plan on bookkeeping; DSH falls back to its own titles.
    if (options.purpose !== undefined) throw new Error(`${cli.label} answers conversation turns only`)
    const key = `${options.provider}\u0000${options.sessionId ?? ''}`
    const cwd = this.cwdOf(options.sessionId)
    const tools = options.tools ?? []
    const replies = options.messages.filter(message => message.role === 'assistant').length
    let chat = options.sessionId === undefined ? undefined : this.chats.get(key)
    if (chat !== undefined) chat.tools = tools

    const results = trailingToolResults(options.messages)
    if (results.length > 0 && chat !== undefined && chat.replies === replies && (chat.inTurn || chat.outcome !== undefined)) {
      // DSH ran the shared tools the last step asked for: hand the results back and keep reading the same turn.
      for (const result of results) {
        const call = chat.waiting.get(result.id)
        if (call === undefined) continue
        chat.waiting.delete(result.id)
        settle(call, { text: result.text, isError: result.isError })
      }
      this.abandon(chat, 'The tool returned no result.')
      await this.read(key, chat, replies, queue, options.signal)
      return
    }

    const turn = turnInput(options.messages)
    if (turn.input === '') throw new Error('There is no new message to send.')
    if (chat !== undefined && !(await this.cancelTurn(chat))) {
      this.chats.delete(key)
      void this.stop(chat)
      chat = undefined
    }
    if (chat !== undefined && (chat.replies !== replies || chat.cwd !== cwd)) {
      this.chats.delete(key)
      void this.stop(chat)
      chat = undefined
    }
    const fresh = chat === undefined
    chat ??= await this.start(options.provider, cwd, tools)
    if (options.sessionId !== undefined) this.chats.set(key, chat)
    if (chat.idle !== undefined) clearTimeout(chat.idle)
    const shared = chat.mcp === undefined
      ? ''
      : `\n\n(Hypersuperfluid's own tools for this chat are on the MCP server "${MCP_SERVER_NAME}": ${chat.tools.map(tool => tool.name).join(', ')}. Use them when they fit, for example its built-in browser; a call may wait for the person's approval.)`
    this.begin(chat, `${fresh ? turn.transcript : turn.input}${fresh ? shared : ''}`)
    await this.read(key, chat, replies, queue, options.signal)
  }

  /**
   * Reads the chat's turn until the vendor calls shared tools (the step ends with DSH tool calls) or the turn ends.
   * @param key - the chat's key.
   * @param chat - the chat.
   * @param replies - assistant messages in the history before this step.
   * @param queue - where the step's chunks go.
   * @param signal - the step's cancellation.
   */
  private read(key: string, chat: ChatProcess, replies: number, queue: ChunkQueue, signal: AbortSignal | undefined): Promise<void> {
    const cli = [...this.byRoute.values()].find(candidate => key.startsWith(`${routeOf(candidate.id)}\u0000`))
    const label = cli?.label ?? 'The subscription CLI'
    const writer = new BlockWriter((chunk) => { queue.push(chunk) })
    return new Promise<void>((done, fail) => {
      let finished = false
      const detach = (): void => {
        finished = true
        chat.reader = undefined
        signal?.removeEventListener('abort', onAbort)
      }
      const stepDone = (): void => {
        chat.replies = replies + 1
        if (this.chats.get(key) === chat) this.armIdle(key, chat)
        done()
      }
      const onAbort = (): void => {
        if (finished) return
        detach()
        this.abandon(chat, 'The person stopped the chat.')
        void chat.agent.notify(methods.agent.session.cancel, { sessionId: chat.sessionId }).catch(() => {})
        fail(signal?.reason instanceof Error ? signal.reason : new Error('cancelled'))
      }
      const reader: Reader = {
        update: (update) => { if (!finished) writer.apply(update) },
        calls: (calls) => {
          if (finished) {
            chat.queued.push(...calls)
            return
          }
          detach()
          for (const call of calls) {
            if (call.settled) continue
            chat.waiting.set(call.id, call)
            writer.toolCall(call.id, call.tool, call.args)
          }
          queue.push({ type: 'finish', reason: { kind: 'tool-calls' } })
          stepDone()
        },
        end: (outcome) => {
          if (finished) return
          detach()
          writer.end()
          if ('error' in outcome) {
            if (this.chats.get(key) === chat) this.chats.delete(key)
            void this.stop(chat)
            fail(outcome.error)
            return
          }
          if (!writer.wroteText && !writer.wrote) {
            writer.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `(${label} ended its turn without a reply.)` } })
            writer.end()
          }
          const usage = outcome.response.usage
          if (usage !== undefined && usage !== null) {
            queue.push({ type: 'usage', usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens } })
          }
          queue.push({ type: 'finish', reason: outcome.response.stopReason === 'max_tokens' ? { kind: 'max-tokens' } : { kind: 'stop' } })
          stepDone()
        },
      }
      if (signal?.aborted === true) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      chat.reader = reader
      // Whatever arrived between steps comes first, in order.
      for (const update of chat.buffered.splice(0)) reader.update(update)
      const queued = chat.queued.splice(0).filter(call => !call.settled)
      if (queued.length > 0) {
        reader.calls(queued)
        return
      }
      const outcome = chat.outcome
      if (outcome !== undefined) {
        chat.outcome = undefined
        reader.end(outcome)
      }
    })
  }
}

function settle(call: SharedCall, result: McpToolResult): void {
  if (call.settled) return
  call.settled = true
  call.resolve(result)
}

/** The tool results at the end of a request, newest step only. */
export function trailingToolResults(messages: readonly RequestMessage[]): Array<{ id: string; text: string; isError: boolean }> {
  const results: Array<{ id: string; text: string; isError: boolean }> = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as RequestMessage
    if (message.role !== 'tool') break
    results.unshift({ id: message.toolCallId, text: toolResultText(message.content), isError: message.isError === true })
  }
  return results
}

function defaultBridge(): { command: string; args: string[]; env: Record<string, string> } | undefined {
  const script = bridgeScript()
  if (script === undefined) return undefined
  // In the desktop app `process.execPath` is Electron, which runs a script only in Node mode.
  const env: Record<string, string> = process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' }
  return { command: process.execPath, args: [script], env }
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
