/**
 * Hypersuperfluid subscriptions: the vendors' command-line agents (Grok Build, Google Antigravity, OpenCode, Gemini
 * CLI, Hermes) that the agent hands work to on the person's own plans. Settings shows whether each is installed and
 * signed in, and its Sign in button opens the vendor's own login in a new terminal window. The login stays inside the
 * vendor's program: nothing here reads, copies or receives a token.
 *
 * The renderer sends only a tool id. Every command line is a constant in this file, so a page cannot make the main
 * process run anything else.
 * @module desktop/subscriptions
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type { SubscriptionCheck, SubscriptionInfo, SubscriptionSignIn, SubscriptionState } from './subscription-types.ts'

export type * from './subscription-types.ts'

/** One subscription CLI. */
export interface SubscriptionTool {
  /** The worker id in `cordis.patch.yml`. */
  readonly id: string
  /** The agent's tool name. */
  readonly tool: string
  /** The product name. */
  readonly label: string
  /** The plan it uses. */
  readonly plan: string
  /** The executable's name on PATH. */
  readonly command: string
  /** Arguments that start its ACP server. */
  readonly acpArgs: readonly string[]
  /** Arguments that start its interactive sign-in. */
  readonly signInArgs: readonly string[]
  /** A caution shown beside the tool, if any. */
  readonly note?: string
}

/** The tools Settings lists, in display order. They match the `hsf-workers` rows in `cordis.patch.yml`. */
export const SUBSCRIPTION_TOOLS: readonly SubscriptionTool[] = [
  { id: 'grok', tool: 'grok', label: 'Grok Build', plan: 'xAI Grok subscription', command: 'grok', acpArgs: ['agent', 'stdio'], signInArgs: ['login'] },
  {
    id: 'agy', tool: 'agy', label: 'Google Antigravity', plan: 'Google account', command: 'agy', acpArgs: ['acp'], signInArgs: [],
    note: 'Google has not said whether scripted use of a Google sign-in is allowed. Use a Gemini API key for anything you cannot risk.',
  },
  {
    id: 'gemini-cli', tool: 'gemini_cli', label: 'Gemini CLI', plan: 'Google account', command: 'gemini', acpArgs: ['--acp'], signInArgs: [],
    note: 'Google\'s Gemini CLI terms forbid using its sign-in through other software, and people report suspended accounts. Use a Gemini API key for anything you cannot risk.',
  },
  {
    id: 'opencode', tool: 'opencode', label: 'OpenCode', plan: 'OpenCode providers; its free models need no sign-in', command: 'opencode',
    acpArgs: ['acp'], signInArgs: ['auth', 'login'],
  },
  { id: 'hermes', tool: 'hermes', label: 'Hermes Agent', plan: 'the model Hermes is set up with', command: 'hermes', acpArgs: ['acp'], signInArgs: ['model'] },
]

/** A command ready to spawn without a shell. */
export interface ResolvedCommand {
  readonly command: string
  readonly prefixArgs: readonly string[]
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Reads the script an npm `.cmd` shim launches, because Windows refuses to spawn a `.cmd` without a shell. The same
 * rule as `apps/hypersuperfluid/src/workers.ts`, which the Host uses to start these CLIs.
 * @param shim - the shim's path.
 * @param nodePath - the Node to run a script with.
 * @returns the command to run instead, or undefined when the shim's format is unknown.
 */
export function resolveCmdShim(shim: string, nodePath: string): ResolvedCommand | undefined {
  const text = readFileSync(shim, 'utf8')
  const targets = [...text.matchAll(/"%(?:dp0|~dp0)%?\\?([^"]+)"/giu)]
    .map(match => (match[1] as string).replaceAll('\\', '/'))
    .filter(target => !/\bnode(\.exe)?$/iu.test(target))
  const target = targets.at(-1)
  if (target === undefined) return undefined
  const path = join(dirname(shim), target)
  if (!existsSync(path)) return undefined
  return path.toLowerCase().endsWith('.exe') ? { command: path, prefixArgs: [] } : { command: nodePath, prefixArgs: [path] }
}

/**
 * Finds an executable on a PATH.
 * @param command - the executable's name.
 * @param path - the PATH to search.
 * @param platform - the operating system.
 * @param nodePath - the Node to run an npm shim's script with.
 * @returns how to spawn it, or undefined when it is not installed.
 */
export function resolveCommand(command: string, path: string, platform: NodeJS.Platform, nodePath: string): ResolvedCommand | undefined {
  for (const dir of path.split(platform === 'win32' ? ';' : delimiter).filter(entry => entry !== '')) {
    const base = join(dir, command)
    if (platform !== 'win32') {
      if (isFile(base)) return { command: base, prefixArgs: [] }
      continue
    }
    if (isFile(`${base}.exe`)) return { command: `${base}.exe`, prefixArgs: [] }
    if (isFile(`${base}.cmd`)) {
      const shim = resolveCmdShim(`${base}.cmd`, nodePath)
      if (shim !== undefined) return shim
    }
  }
  return undefined
}

/** What the module needs from the main process. */
export interface SubscriptionsHost {
  /** The environment the Host starts the CLIs with; credential-shaped names are dropped before use. */
  readonly env: () => NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  /** Electron's executable, which runs an npm shim's script in Node mode. */
  readonly execPath?: string
  /** Starts a process; tests replace it. */
  readonly spawn?: typeof spawn
}

const CREDENTIAL_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/iu

/**
 * The environment a vendor CLI gets: the person's own, without the keys this app holds, so a vendor program never sees
 * another vendor's key.
 * @param env - the Host environment.
 * @returns a copy without credential-shaped names.
 */
export function cliEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CREDENTIAL_NAME.test(name)))
}

function pathOf(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? ''
}

/** JSON-RPC errors that mean "sign in first". */
function isAuthError(error: { code?: unknown; message?: unknown }): boolean {
  return error.code === -32000 || /auth|log ?in|sign ?in|credential|unauthori[sz]ed|api key/iu.test(String(error.message ?? ''))
}

/**
 * Asks a CLI's ACP server to initialize and open a session. Opening a session sends no prompt, so it spends nothing; a
 * CLI that is not signed in refuses it.
 * @param tool - the tool.
 * @param host - the main process.
 * @param timeoutMs - how long to wait.
 * @returns what the CLI answered.
 */
export function checkSubscription(tool: SubscriptionTool, host: SubscriptionsHost, timeoutMs = 30_000): Promise<SubscriptionCheck> {
  const env = cliEnvironment(host.env())
  const platform = host.platform ?? process.platform
  const execPath = host.execPath ?? process.execPath
  const resolved = resolveCommand(tool.command, pathOf(env), platform, execPath)
  if (resolved === undefined) {
    return Promise.resolve({ id: tool.id, state: 'not-installed', detail: `${tool.command} was not found on PATH.` })
  }
  const start = host.spawn ?? spawn
  return new Promise((done) => {
    const child = start(resolved.command, [...resolved.prefixArgs, ...tool.acpArgs], {
      cwd: homedir(),
      env: resolved.command === execPath ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let buffer = ''
    let settled = false
    const finish = (state: SubscriptionState, detail: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      done({ id: tool.id, state, detail })
    }
    const send = (id: number, method: string, params: unknown): void => {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    }
    const timer = setTimeout(() => { finish('unknown', 'It did not answer in time. Sign in, then check again.') }, timeoutMs)
    child.on('error', (error) => { finish('unknown', error.message) })
    child.on('exit', (code) => { finish('unknown', `It stopped (exit code ${String(code)}) before answering.`) })
    child.stdin?.on('error', () => { finish('unknown', 'It closed its input before answering.') })
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        let message: { id?: unknown; method?: unknown; result?: { sessionId?: unknown }; error?: { code?: unknown; message?: unknown } }
        try {
          message = JSON.parse(line) as typeof message
        } catch {
          continue // banner lines before the first JSON-RPC message
        }
        if (message.id === 1) {
          if (message.error !== undefined) {
            finish('unknown', `It refused to start: ${String(message.error.message)}`)
            return
          }
          send(2, 'session/new', { cwd: homedir(), mcpServers: [] })
        } else if (message.id === 2) {
          if (message.result?.sessionId !== undefined) finish('signed-in', 'It opened a session.')
          else if (message.error !== undefined && isAuthError(message.error)) finish('signed-out', 'It asked to sign in first.')
          else finish('unknown', `It could not open a session: ${String(message.error?.message ?? 'no reason given')}`)
        } else if (typeof message.method === 'string' && message.id !== undefined) {
          // A request from the CLI (a permission or file read): refuse it, since no task is running.
          child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not supported during a sign-in check' } })}\n`)
        }
      }
    })
    send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
  })
}

/** A terminal launch: the program, its arguments, and whether Windows must pass them unquoted. */
export interface TerminalLaunch {
  readonly command: string
  readonly args: string[]
  readonly verbatim: boolean
}

/**
 * How to open a terminal window that runs the sign-in and stays open.
 * @param tool - the tool.
 * @param platform - the operating system.
 * @returns the program and arguments, or undefined when this platform has no known terminal.
 */
export function signInLaunch(tool: SubscriptionTool, platform: NodeJS.Platform): TerminalLaunch | undefined {
  const line = [tool.command, ...tool.signInArgs].join(' ')
  if (platform === 'win32') {
    // `start` opens a new console; `/k` keeps it open so the person can read the result.
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', `start "Sign in to ${tool.label}" cmd.exe /k ${line}`], verbatim: true }
  }
  if (platform === 'darwin') {
    return { command: 'osascript', args: ['-e', `tell application "Terminal" to do script "${line}"`, '-e', 'tell application "Terminal" to activate'], verbatim: false }
  }
  if (platform === 'linux') {
    return { command: 'x-terminal-emulator', args: ['-e', 'sh', '-c', `${line}; exec "\${SHELL:-sh}"`], verbatim: false }
  }
  return undefined
}

/**
 * Opens the vendor's sign-in in a new terminal window.
 * @param tool - the tool.
 * @param host - the main process.
 * @returns whether a window was started.
 */
export function openSignIn(tool: SubscriptionTool, host: SubscriptionsHost): Promise<SubscriptionSignIn> {
  const env = cliEnvironment(host.env())
  const platform = host.platform ?? process.platform
  const signInCommand = [tool.command, ...tool.signInArgs].join(' ')
  if (resolveCommand(tool.command, pathOf(env), platform, host.execPath ?? process.execPath) === undefined) {
    return Promise.resolve({ opened: false, detail: `${tool.label} is not installed. Install it, then restart the app.` })
  }
  const launch = signInLaunch(tool, platform)
  if (launch === undefined) return Promise.resolve({ opened: false, detail: `Run ${signInCommand} in a terminal.` })
  const start = host.spawn ?? spawn
  return new Promise((done) => {
    const child = start(launch.command, launch.args, {
      cwd: homedir(), env, detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: launch.verbatim,
    })
    child.on('error', (error) => { done({ opened: false, detail: `Could not open a terminal (${error.message}). Run ${signInCommand} in a terminal.` }) })
    child.on('spawn', () => {
      child.unref()
      done({ opened: true, detail: `A terminal window is running ${signInCommand}. Finish there, then check again.` })
    })
  })
}

function toolOf(id: unknown): SubscriptionTool {
  const tool = SUBSCRIPTION_TOOLS.find(candidate => candidate.id === id)
  if (tool === undefined) throw new Error(`unknown subscription tool: ${String(id)}`)
  return tool
}

/** The operations the IPC handlers call; ids come from the renderer, so they are checked here. */
export interface Subscriptions {
  list(): SubscriptionInfo[]
  check(id: unknown): Promise<SubscriptionCheck>
  signIn(id: unknown): Promise<SubscriptionSignIn>
}

/**
 * The main-process side of the Settings page.
 * @param host - the main process.
 * @returns the operations IPC handlers call.
 */
export function createSubscriptions(host: SubscriptionsHost): Subscriptions {
  return {
    list() {
      const env = cliEnvironment(host.env())
      const platform = host.platform ?? process.platform
      return SUBSCRIPTION_TOOLS.map(tool => ({
        id: tool.id,
        tool: tool.tool,
        label: tool.label,
        plan: tool.plan,
        signInCommand: tool.signInArgs.length === 0 ? `${tool.command} (run it once)` : [tool.command, ...tool.signInArgs].join(' '),
        installed: resolveCommand(tool.command, pathOf(env), platform, host.execPath ?? process.execPath) !== undefined,
        ...tool.note === undefined ? {} : { note: tool.note },
      }))
    },
    check: id => checkSubscription(toolOf(id), host),
    signIn: id => openSignIn(toolOf(id), host),
  }
}
