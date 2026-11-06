/**
 * Firecrawl web research: the official Firecrawl MCP server, bundled as a dependency and run with this process's own
 * Node, so nothing is downloaded at run time. Its tools (`mcp__firecrawl__firecrawl_search`, `..._scrape`, `..._crawl`,
 * `..._map`, `..._extract`, the research tools and more) read whole sites as clean Markdown, which the career and
 * analysis modes use for deep company, market and source research.
 *
 * The key never appears in configuration: the server's environment names `${credential:FIRECRAWL_API_KEY}`, which the
 * MCP client resolves through the credential provider at start and redacts from every diagnostic. Set the key in
 * Settings > Models, the environment, or `.env`, then restart. Without one, Firecrawl's own keyless tier answers; a
 * self-hosted Firecrawl is selected with `FIRECRAWL_API_URL`.
 * @module hypersuperfluid/firecrawl
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/** Cordis plugin name. */
export const name = 'hsf-firecrawl'

/** Firecrawl settings. */
export interface Config {
  /** Credential that holds the API key. */
  keyRef?: string
  /** A self-hosted Firecrawl's address; the hosted service when empty. Overrides `FIRECRAWL_API_URL`. */
  apiUrl?: string
  /** Maximum milliseconds of one tool call; crawls and research run long. */
  toolCallTimeoutMs?: number
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  keyRef: z.string().default('FIRECRAWL_API_KEY'),
  apiUrl: z.string(),
  toolCallTimeoutMs: z.natural().default(300_000),
})

/**
 * The server's entry script, resolved from this package's own dependency.
 * @returns the absolute path of `firecrawl-mcp`'s executable.
 */
export function firecrawlEntry(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('firecrawl-mcp/package.json')), 'dist', 'index.js')
}

/**
 * The server's environment: the credential reference, never the value, plus a self-hosted address when one is set.
 * @param config - the settings.
 * @param keyed - whether the key credential is configured; without it the server runs keyless.
 * @param env - the host environment, for `FIRECRAWL_API_URL`.
 * @returns the explicit variables for the server process.
 */
export function firecrawlEnv(config: Config, keyed: boolean, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const apiUrl = config.apiUrl !== undefined && config.apiUrl !== '' ? config.apiUrl : env.FIRECRAWL_API_URL
  return {
    ...keyed ? { FIRECRAWL_API_KEY: `\${credential:${config.keyRef ?? 'FIRECRAWL_API_KEY'}}` } : {},
    ...apiUrl === undefined || apiUrl === '' ? {} : { FIRECRAWL_API_URL: apiUrl },
    // In the desktop app `process.execPath` is Electron, which runs a script only in Node mode.
    ...process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' },
  }
}

/**
 * @param ctx - the host composition.
 * @param config - the settings.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  let entry: string
  try {
    entry = firecrawlEntry()
  } catch (error) {
    ctx.logger.warn('hsf-firecrawl: the bundled Firecrawl server is missing, so Firecrawl tools are off: %s', String(error))
    return
  }
  const ref = (config.keyRef ?? 'FIRECRAWL_API_KEY') as CredentialRef
  const keyed = (await ctx.get('credentials')?.describe(ref).catch(() => undefined))?.configured === true
  if (!keyed) ctx.logger.info('hsf-firecrawl: no %s set, so Firecrawl runs on its keyless tier', ref)
  ctx.plugin(mcpClient, {
    serverName: 'firecrawl',
    transport: 'stdio' as const,
    command: process.execPath,
    args: [entry],
    env: firecrawlEnv(config, keyed),
    expandTemplates: keyed,
    toolCallTimeoutMs: config.toolCallTimeoutMs ?? 300_000,
    failOnStartupError: false,
  })
}
