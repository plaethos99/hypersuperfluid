/**
 * A tool allowlist for a mode that talks to people outside: every tool not on the list is refused before it runs,
 * whatever registered it (host-plane MCP servers such as the ERP connection included). The guide mode uses it, so a
 * guest on a share link can reach nothing on this machine beyond the listed tools.
 * @module hypersuperfluid/allowlist
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'hsf-allowlist'

/** Allowlist settings. */
export interface Config {
  /** Tool names this mode may run. */
  allow: string[]
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({ allow: z.array(z.string()).default([]) })

/**
 * Whether a tool may run.
 * @param allow - the allowed names.
 * @param tool - the tool being called.
 * @returns true when it is on the list.
 */
export function allowed(allow: readonly string[], tool: string): boolean {
  return allow.includes(tool)
}

/**
 * @param ctx - a preset scope.
 * @param config - the settings.
 */
export function apply(ctx: Context, config: Config): void {
  const allow = config.allow ?? []
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow' || allowed(allow, exec.name)) return decision
    return { kind: 'deny', reason: `${exec.name} is not available in this mode, which serves people outside this computer. Answer with guidance instead.` }
  }, { prepend: true })
}
