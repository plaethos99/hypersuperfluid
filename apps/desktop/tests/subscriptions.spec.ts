import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkSubscription, cliEnvironment, createSubscriptions, openSignIn, signInLaunch, SUBSCRIPTION_TOOLS,
  type SubscriptionsHost, type SubscriptionTool,
} from '../src/subscriptions.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hsf-subs-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** A stand-in ACP CLI: it answers `initialize`, then opens a session or asks for a sign-in, as FAKE_MODE says. */
const FAKE_CLI = `
const mode = process.env.FAKE_MODE
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\\n'); buffer = lines.pop()
  for (const line of lines) {
    const message = JSON.parse(line)
    if (mode === 'silent') continue
    const reply = message.method === 'initialize'
      ? { result: { protocolVersion: 1, authMethods: [] } }
      : mode === 'auth' ? { error: { code: -32000, message: 'Authentication required' } } : { result: { sessionId: 's1' } }
    process.stdout.write('banner line\\n' + JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply }) + '\\n')
  }
})
`

/** Installs the fake CLI as `fakecli` the way npm does on this platform. */
function installFake(): void {
  writeFileSync(join(dir, 'fake.js'), FAKE_CLI)
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'fakecli.cmd'), '@ECHO off\r\n"%~dp0\\node.exe" "%~dp0\\fake.js" %*\r\n')
  } else {
    writeFileSync(join(dir, 'fakecli'), `#!${process.execPath}\n${FAKE_CLI}`)
    chmodSync(join(dir, 'fakecli'), 0o755)
  }
}

const fake: SubscriptionTool = { id: 'fake', tool: 'fake', label: 'Fake', plan: 'test plan', command: 'fakecli', acpArgs: [], signInArgs: ['login'] }
const host = (mode: string, extra: NodeJS.ProcessEnv = {}): SubscriptionsHost => ({
  env: () => ({ ...process.env, PATH: dir, Path: undefined, FAKE_MODE: mode, ...extra }),
  execPath: process.execPath,
})

describe('checkSubscription', () => {
  it('reports signed in when the CLI opens a session', async () => {
    installFake()
    expect(await checkSubscription(fake, host('ok'))).toMatchObject({ state: 'signed-in' })
  })

  it('reports signed out when the CLI asks for a sign-in', async () => {
    installFake()
    expect(await checkSubscription(fake, host('auth'))).toMatchObject({ state: 'signed-out' })
  })

  it('gives up when the CLI does not answer', async () => {
    installFake()
    expect(await checkSubscription(fake, host('silent'), 1_500)).toMatchObject({ state: 'unknown' })
  })

  it('reports a CLI that is not on PATH', async () => {
    expect(await checkSubscription(fake, host('ok'))).toMatchObject({ state: 'not-installed' })
  })
})

describe('the CLI environment', () => {
  it('drops the keys this app holds', () => {
    const env = cliEnvironment({ PATH: '/bin', DEEPSEEK_API_KEY: 'x', GITHUB_TOKEN: 'y', DB_PASSWORD: 'z', HOME: '/home/me' })
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/me' })
  })
})

describe('signing in', () => {
  it('opens a console that stays open on Windows', () => {
    const grok = SUBSCRIPTION_TOOLS.find(tool => tool.id === 'grok') as SubscriptionTool
    expect(signInLaunch(grok, 'win32')).toEqual({
      command: 'cmd.exe', args: ['/d', '/s', '/c', 'start "Sign in to Grok Build" cmd.exe /k grok login'], verbatim: true,
    })
    expect(signInLaunch(grok, 'darwin')?.command).toBe('osascript')
  })

  it('starts the terminal detached and reports it', async () => {
    installFake()
    const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }> = []
    const spawnStub = ((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: options.env })
      const child = Object.assign(new EventEmitter(), { unref: () => {} })
      queueMicrotask(() => child.emit('spawn'))
      return child
    }) as unknown as NonNullable<SubscriptionsHost['spawn']>
    const result = await openSignIn(fake, { ...host('ok', { OPENAI_API_KEY: 'secret' }), platform: process.platform === 'win32' ? 'win32' : 'linux', spawn: spawnStub })
    expect(result.opened).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.env?.OPENAI_API_KEY).toBeUndefined()
  })

  it('does not open a terminal for a tool that is not installed', async () => {
    expect((await openSignIn(fake, host('ok'))).opened).toBe(false)
  })

  it('refuses ids it does not know', () => {
    const subscriptions = createSubscriptions(host('ok'))
    expect(() => subscriptions.signIn('calc && whoami')).toThrow(/unknown subscription tool/u)
    expect(subscriptions.list().map(tool => tool.id)).toEqual(['grok', 'agy', 'gemini-cli', 'opencode', 'hermes'])
  })
})
