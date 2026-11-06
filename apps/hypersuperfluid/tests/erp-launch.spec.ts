import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { launcherEnv } from '../src/erp.ts'

const launcher = resolve(import.meta.dirname, '..', 'erp', 'launch.mjs')
let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'hsf-erp-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

/** Marks the environment ready, so the launcher's lock and start paths run without a real installation. */
function markReady(): void {
  mkdirSync(join(home, 'erp', 'python'), { recursive: true })
  writeFileSync(join(home, 'erp', 'python', '.ready'), 'test')
}

const run = (args: string[], env: Record<string, string | undefined>) => spawnSync(process.execPath, [launcher, ...args], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, encoding: 'utf8' })

describe('erp/launch.mjs', () => {
  it('refuses to guess the state directory when the host passes none', () => {
    const result = run(['--prepare'], { HSF_HOME: undefined, DSH_HOME: home })
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/HSF_HOME is not set/u)
    expect(existsSync(join(home, 'hsf'))).toBe(false)
  })

  it('rejects an unknown command', () => {
    expect(run(['rm'], { HSF_HOME: home }).status).toBe(2)
  })

  it('prepares nothing when the environment is ready, and leaves no lock', () => {
    markReady()
    const result = run(['--prepare'], { HSF_HOME: home })
    expect(result.status).toBe(0)
    expect(existsSync(join(home, 'erp', '.setup-lock'))).toBe(false)
  })

  it('waits for a setup another process holds, then proceeds once it finishes', async () => {
    mkdirSync(join(home, 'erp', '.setup-lock'), { recursive: true })
    const started = Date.now()
    const child = spawn(process.execPath, [launcher, '--prepare'], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HSF_HOME: home } })
    const exit = new Promise<number | null>((done) => { child.on('exit', done) })
    await new Promise((done) => { setTimeout(done, 1_500) })
    expect(child.exitCode).toBeNull()
    markReady()
    rmSync(join(home, 'erp', '.setup-lock'), { recursive: true, force: true })
    expect(await exit).toBe(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500)
  })
})

describe('launcherEnv', () => {
  it('passes the state directory explicitly', () => {
    expect(launcherEnv('/state').HSF_HOME).toBe('/state')
  })
})
