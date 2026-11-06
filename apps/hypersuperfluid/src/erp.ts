/**
 * ERP capability, off until an ERP is connected: with no `erp-agent.yaml` in the state directory nothing starts and no
 * tool appears. Once connected, the Python server from the Odoo agent runs out of process through `erp/launch.mjs`.
 * Its environment is prepared once in the background before either server starts, so neither server's startup waits on
 * an installation and the host is not held up. The two servers separate reading from customizing, so a connection
 * without a `customize` block never gets tools that change a database.
 * @module hypersuperfluid/erp
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { hsfHome } from './home.ts'

/** Cordis plugin name. */
export const name = 'hsf-erp'

/** ERP settings. */
export interface Config {
  /** State directory; defaults to `HSF_HOME`, then `<DSH_HOME>/hsf`. */
  home?: string
  /** Maximum milliseconds of one ERP tool call. */
  toolCallTimeoutMs?: number
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  home: z.string(),
  toolCallTimeoutMs: z.natural().default(240_000),
})

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The environment every launcher process gets. The host's MCP client reduces a server's environment, so the state
 * directory is passed explicitly rather than inherited.
 * @param home - the state directory.
 * @returns the variables to set.
 */
export function launcherEnv(home: string): Record<string, string> {
  // In the desktop app `process.execPath` is Electron, which runs the launcher only in Node mode.
  return { HSF_HOME: home, ...process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' } }
}

/**
 * @param ctx - the host composition.
 * @param config - the ERP settings.
 */
export function apply(ctx: Context, config: Config): void {
  const home = hsfHome(config.home)
  const dir = join(home, 'erp')
  const yaml = join(dir, 'erp-agent.yaml')
  if (!existsSync(yaml)) {
    ctx.logger.info('hsf-erp: no ERP connected. Copy erp/config/erp-agent.example.yaml to %s to connect one.', yaml)
    return
  }
  const launcher = join(packageRoot, 'erp', 'launch.mjs')
  const env = launcherEnv(home)
  const mount = (): void => {
    // A connection may need no secrets, and the server refuses an --env-file that does not exist.
    const secrets = join(dir, '.env')
    const secretArgs = existsSync(secrets) ? ['--env-file', secrets] : []
    const server = (serverName: string, entry: string) => ({
      serverName,
      transport: 'stdio' as const,
      command: process.execPath,
      args: [launcher, entry, '--config', yaml, ...secretArgs],
      env,
      toolCallTimeoutMs: config.toolCallTimeoutMs ?? 240_000,
      failOnStartupError: false,
    })
    ctx.plugin(mcpClient, server('erp', 'erp-mcp'))
    ctx.plugin(mcpClient, server('customize', 'erp-customize'))
  }
  if (existsSync(join(dir, 'python', '.ready'))) {
    mount()
    return
  }
  ctx.logger.info('hsf-erp: preparing the ERP environment in the background; the ERP tools appear when it is ready')
  const child = spawn(process.execPath, [launcher, '--prepare'], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  let tail = ''
  child.stderr.on('data', (chunk: Buffer) => { tail = (tail + chunk.toString('utf8')).slice(-2000) })
  let disposed = false
  ctx.effect(() => () => {
    disposed = true
    child.kill()
  }, 'hsf-erp environment preparation')
  child.on('exit', (code) => {
    if (disposed) return
    if (code === 0) mount()
    else ctx.logger.warn('hsf-erp: preparing the ERP environment failed (exit %s): %s', String(code), tail.trim().split('\n').slice(-3).join(' | '))
  })
}
