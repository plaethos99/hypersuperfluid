import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { AcpChatAdapter, BlockWriter, ChunkQueue, MODEL_ID, routeOf, turnInput } from '../src/acp-chat.ts'

/** A stand-in ACP agent: it echoes each prompt, reports a tool call, asks for one permission, and counts sessions. */
const FAKE_AGENT = `
const mode = process.argv[2]
let buffer = ''
let sessions = 0
let turns = 0
const pending = new Map()
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\\n'); buffer = lines.pop()
  for (const line of lines) {
    if (line.trim() === '') continue
    const message = JSON.parse(line)
    if (message.method === undefined) { pending.get(message.id)?.(message.result); continue }
    if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {}, authMethods: [] } })
    else if (message.method === 'session/new') {
      if (mode === 'auth') send({ id: message.id, error: { code: -32000, message: 'Authentication required' } })
      else { sessions += 1; send({ id: message.id, result: { sessionId: 's' + sessions } }) }
    } else if (message.method === 'session/prompt') {
      turns += 1
      const sessionId = message.params.sessionId
      const text = message.params.prompt.map(block => block.text).join('')
      const update = (u) => send({ method: 'session/update', params: { sessionId, update: u } })
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } })
      update({ sessionUpdate: 'tool_call', toolCallId: 't' + turns, title: 'Read notes.txt', kind: 'read', status: 'pending' })
      pending.set('p' + turns, (result) => {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'session ' + sessions + ' turn ' + turns + ' permission ' + result.outcome.outcome + ': ' } })
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text } })
        send({ id: message.id, result: { stopReason: 'end_turn' } })
      })
      send({ id: 'p' + turns, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 't' + turns, title: 'Read notes.txt', kind: 'read' }, options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } })
    } else if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'unknown' } })
  }
})
`

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hsf-acp-chat-'))
  writeFileSync(join(dir, 'agent.js'), FAKE_AGENT)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** The subprocess seam, backed by child_process. */
function spawnSeam(spec: SubprocessSpawnSpec): SubprocessHandle {
  const child = spawn(spec.argv[0] as string, spec.argv.slice(1), { cwd: spec.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (exitCode, signal) => { resolve({ exitCode, signal }) })
  })
  return {
    stdin: child.stdin, stdout: child.stdout, stderr: undefined, control: undefined,
    collected: { stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) } },
    done,
    terminate: () => { child.kill() },
    waitForExit: async () => { await done; return true },
  } as unknown as SubprocessHandle
}

const spawned: string[][] = []
function adapter(mode = 'ok', permission: 'allow' | 'reject' = 'allow'): AcpChatAdapter {
  const ctx = {
    subprocess: { spawn: (spec: SubprocessSpawnSpec) => { spawned.push([...spec.argv]); return spawnSeam(spec) } },
    sessions: { get: () => undefined },
    get: () => undefined,
  } as unknown as Context
  return new AcpChatAdapter(ctx, { permission, idleMinutes: 0 }, [{
    id: 'fake', label: 'Fake CLI', command: 'fake', args: [], argv: [process.execPath, join(dir, 'agent.js'), mode], env: {},
  }])
}

const user = (text: string): RequestMessage => ({ role: 'user', content: [{ type: 'text', text }] })
const reply = (text: string): RequestMessage => ({
  role: 'assistant', id: 'm', content: [{ type: 'text', text }], source: { kind: 'model' },
} as unknown as RequestMessage)
const SESSION = 'session-1' as SessionId

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}
const textOf = (chunks: StreamChunk[]): string => chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'text' ? [chunk.block.text] : []).join('')
const reasoningOf = (chunks: StreamChunk[]): string => chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'reasoning' ? [chunk.block.text] : []).join('')
const options = (messages: RequestMessage[], extra: Partial<GenerateOptions> = {}): GenerateOptions => ({
  provider: routeOf('fake'), model: MODEL_ID, messages, sessionId: SESSION, ...extra,
})

describe('turnInput', () => {
  it('sends a first message as it is', () => {
    expect(turnInput([user('hello')])).toEqual({ replies: 0, input: 'hello', transcript: 'hello' })
  })

  it('takes the input after the last reply and keeps the conversation for a fresh session', () => {
    const turn = turnInput([user('hello'), reply('hi there'), user('fix the bug'), user('in calc.py')])
    expect(turn.replies).toBe(1)
    expect(turn.input).toBe('fix the bug\n\nin calc.py')
    expect(turn.transcript).toContain('User: hello\n\nAssistant: hi there')
    expect(turn.transcript.endsWith('fix the bug\n\nin calc.py')).toBe(true)
  })

  it('names images instead of dropping them silently', () => {
    const turn = turnInput([{ role: 'user', content: [{ type: 'text', text: 'see this' }, { type: 'image' } as never] }])
    expect(turn.input).toContain('receives text only')
  })
})

describe('BlockWriter', () => {
  it('opens and closes blocks as the kind changes', () => {
    const chunks: StreamChunk[] = []
    const writer = new BlockWriter((chunk) => { chunks.push(chunk) })
    writer.apply({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } })
    writer.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } })
    writer.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } })
    writer.end()
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'reasoning-delta', 'block-end', 'block-start', 'text-delta', 'text-delta', 'block-end'])
    expect(textOf(chunks)).toBe('Hello')
  })
})

describe('ChunkQueue', () => {
  it('delivers pushed chunks, then ends or fails', async () => {
    const queue = new ChunkQueue()
    queue.push({ type: 'finish', reason: { kind: 'stop' } })
    queue.close()
    expect(await collect(queue)).toHaveLength(1)
    const failing = new ChunkQueue()
    setTimeout(() => { failing.close(new Error('boom')) }, 5)
    await expect(collect(failing)).rejects.toThrow('boom')
  })
})

describe('AcpChatAdapter', () => {
  it('offers one subscription model per CLI', async () => {
    const chat = adapter()
    expect(chat.routes).toEqual(['sub-fake'])
    expect(chat.providerInfo('sub-fake').name).toBe('Fake CLI (subscription)')
    expect((await chat.listModels('sub-fake')).map(model => model.id)).toEqual([MODEL_ID])
  })

  it('keeps one CLI session per chat and sends only the new input', async () => {
    const chat = adapter()
    spawned.length = 0
    try {
      const first = await collect(chat.stream(options([user('hello')])))
      expect(textOf(first)).toBe('session 1 turn 1 permission selected: hello')
      expect(reasoningOf(first)).toContain('▸ Read notes.txt')
      expect(first.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      const second = await collect(chat.stream(options([user('hello'), reply(textOf(first)), user('and again')])))
      expect(textOf(second)).toBe('session 1 turn 2 permission selected: and again')
      expect(spawned).toHaveLength(1)
    } finally {
      await chat.dispose()
    }
  })

  it('starts a fresh session with the conversation when the history no longer matches', async () => {
    const chat = adapter()
    try {
      await collect(chat.stream(options([user('hello')])))
      const retried = await collect(chat.stream(options([user('hello'), reply('a'), user('b'), reply('c'), user('d')])))
      expect(textOf(retried)).toContain('session 1 turn 1')
      expect(textOf(retried)).toContain('User: hello')
    } finally {
      await chat.dispose()
    }
  })

  it('refuses tool use when the policy says so', async () => {
    const chat = adapter('ok', 'reject')
    try {
      expect(textOf(await collect(chat.stream(options([user('hi')]))))).toContain('permission cancelled')
    } finally {
      await chat.dispose()
    }
  })

  it('says where to sign in when the CLI is signed out', async () => {
    const chat = adapter('auth')
    await expect(collect(chat.stream(options([user('hi')])))).rejects.toThrow(/Settings → Subscriptions/u)
    await chat.dispose()
  })

  it('does not spend the plan on titles or summaries', async () => {
    const chat = adapter()
    await expect(collect(chat.stream(options([user('hi')], { purpose: 'session-title' as never })))).rejects.toThrow(/conversation turns only/u)
    await chat.dispose()
  })

  it('streams through the DSH model runtime as a normal reply', async () => {
    const ctx = new CordisContext()
    await ctx.plugin(LlmRuntime)
    const chat = adapter()
    ctx.llm.registerAdapter(chat.routes, chat)
    try {
      const chunks = await collect(ctx.llm.stream(options([user('through the runtime')])))
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(textOf(chunks)).toContain('through the runtime')
      expect(reasoningOf(chunks)).toContain('thinking')
    } finally {
      await chat.dispose()
      await ctx.fiber.dispose()
    }
  })
})
