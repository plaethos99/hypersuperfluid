/**
 * Subscription workers: the vendors' own command-line agents, reached over the Agent Client Protocol. Each CLI keeps
 * its own login, and this plugin never reads, copies or forwards a token, so a subscription stays inside the program
 * its vendor licensed it to. A worker runs its own agent loop and returns its final answer. A CLI that is not installed
 * registers no provider, so the matching tool row in the preset simply does not appear.
 * @module hypersuperfluid/workers
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as subagentAcp from '@deepseek-ai/dsh-subagent-acp'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'hsf-workers'
/** Services this plugin needs. */
export const inject = ['subagents', 'subprocess']

/** One CLI worker. */
export interface WorkerConfig {
  /** The provider name, which the preset's tool row selects. */
  id: string
  /** The executable's name on PATH, or an absolute path. */
  command: string
  /** Arguments that start its ACP server. */
  args: string[]
  /** How to answer the CLI's permission requests. */
  permission?: 'allow' | 'reject'
}

/** Worker settings. */
export interface Config {
  /** The CLIs to look for. */
  workers?: WorkerConfig[]
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  workers: z.array(z.object({
    id: z.string().required(),
    command: z.string().required(),
    args: z.array(z.string()).required(),
    permission: z.union(['allow', 'reject']).default('allow'),
  })).default([]),
})

/** A command ready to spawn without a shell. */
export interface ResolvedCommand {
  /** The executable. */
  readonly command: string
  /** Arguments to put before the worker's own. */
  readonly prefixArgs: readonly string[]
}

function pathDirs(): string[] {
  return (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(dir => dir !== '')
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Reads the script an npm `.cmd` shim launches, because Windows refuses to spawn a `.cmd` without a shell and a shell
 * would re-parse the arguments.
 * @param shim - the shim's path.
 * @returns the command to run instead, or undefined when the shim's format is unknown.
 */
export function resolveCmdShim(shim: string): ResolvedCommand | undefined {
  const text = readFileSync(shim, 'utf8')
  const targets = [...text.matchAll(/"%(?:dp0|~dp0)%?\\?([^"]+)"/giu)].map(match => (match[1] as string).replaceAll('\\', '/')).filter(target => !/\bnode(\.exe)?$/iu.test(target))
  const target = targets.at(-1)
  if (target === undefined) return undefined
  const path = join(dirname(shim), target)
  if (!existsSync(path)) return undefined
  return path.toLowerCase().endsWith('.exe') ? { command: path, prefixArgs: [] } : { command: process.execPath, prefixArgs: [path] }
}

/**
 * Finds an executable on PATH.
 * @param command - a name or absolute path.
 * @returns how to spawn it, or undefined when it is not installed.
 */
export function resolveCommand(command: string): ResolvedCommand | undefined {
  const isPath = command.includes('/') || command.includes('\\')
  const candidates = isPath ? [command] : pathDirs().map(dir => join(dir, command))
  for (const base of candidates) {
    if (process.platform !== 'win32') {
      if (isFile(base)) return { command: base, prefixArgs: [] }
      continue
    }
    if (isFile(`${base}.exe`)) return { command: `${base}.exe`, prefixArgs: [] }
    if (isFile(`${base}.cmd`)) {
      const shim = resolveCmdShim(`${base}.cmd`)
      if (shim !== undefined) return shim
    }
    if (base.toLowerCase().endsWith('.exe') && isFile(base)) return { command: base, prefixArgs: [] }
  }
  return undefined
}

/** A worker's reachability. */
export interface WorkerStatus {
  /** The worker's id. */
  readonly id: string
  /** Whether the CLI is installed. */
  readonly installed: boolean
  /** Whether its ACP server answered `initialize`. */
  readonly responding: boolean
  /** What the server or the failure said, without any credential. */
  readonly detail: string
}

/**
 * Starts a worker's ACP server and sends `initialize`. It starts no session and sends no prompt, so it spends nothing
 * from the subscription.
 * @param worker - the worker.
 * @param timeoutMs - how long to wait for the reply.
 * @returns what happened.
 */
export function probeWorker(worker: WorkerConfig, timeoutMs = 20_000): Promise<WorkerStatus> {
  const resolved = resolveCommand(worker.command)
  if (resolved === undefined) return Promise.resolve({ id: worker.id, installed: false, responding: false, detail: `${worker.command} is not on PATH.` })
  return new Promise((done) => {
    const child = spawn(resolved.command, [...resolved.prefixArgs, ...worker.args], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    let buffer = ''
    let settled = false
    const finish = (responding: boolean, detail: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      done({ id: worker.id, installed: true, responding, detail })
    }
    const timer = setTimeout(() => { finish(false, `No ACP reply within ${timeoutMs} ms. It may need a login: run the CLI once in a terminal.`) }, timeoutMs)
    child.on('error', (error) => { finish(false, error.message) })
    child.on('exit', (code) => { finish(false, `It exited with code ${String(code)} before answering.`) })
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      for (const line of buffer.split('\n').slice(0, -1)) {
        try {
          const message = JSON.parse(line) as { id?: unknown; result?: { protocolVersion?: unknown }; error?: { message?: unknown } }
          if (message.id !== 1) continue
          if (message.result !== undefined) finish(true, `ACP protocol version ${String(message.result.protocolVersion)}.`)
          else finish(false, `Refused: ${String(message.error?.message)}`)
        } catch {
          // A CLI may print banner lines before its first JSON-RPC message.
        }
      }
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`)
  })
}

/**
 * @param ctx - the host composition.
 * @param config - the CLIs to look for.
 */
export function apply(ctx: Context, config: Config): void {
  const workers = config.workers ?? []
  for (const worker of workers) {
    const resolved = resolveCommand(worker.command)
    if (resolved === undefined) {
      ctx.logger.info('hsf-workers: %s is not installed, so the %s worker is unavailable', worker.command, worker.id)
      continue
    }
    ctx.plugin(subagentAcp, {
      providerName: worker.id,
      command: resolved.command,
      args: [...resolved.prefixArgs, ...worker.args],
      permission: worker.permission ?? 'allow',
      // In the desktop app `process.execPath` is Electron, which runs an npm shim's script only in Node mode.
      env: resolved.command === process.execPath && process.versions.electron !== undefined ? { ELECTRON_RUN_AS_NODE: '1' } : {},
    })
  }
  const tools = ctx.get('tools')
  if (tools === undefined) return
  ctx.effect(() => tools.register(defineTool({
    name: 'workers_status',
    description: 'Check which subscription CLI workers (such as grok, agy and opencode) are installed and answer. It sends no prompt and spends nothing. Use it when a worker tool is missing or fails.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      const statuses = await Promise.all(workers.map(worker => probeWorker(worker)))
      return statuses.map(status => `${status.id}: ${status.responding ? 'answers ACP (its login is only tested by a real task)' : status.installed ? 'installed, not answering' : 'not installed'}. ${status.detail}`).join('\n')
    },
  })), 'hsf workers_status tool')
}
