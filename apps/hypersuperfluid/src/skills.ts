/**
 * Skill discovery for the agent preset: DSH's filesystem provider over the project's own skills, plus the skills the
 * agent wrote and the expert skills this bundle ships. Each skill costs one catalog line until it is read, so the
 * expertise adds almost nothing to a request.
 * @module hypersuperfluid/skills
 */

import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { hsfHome } from './home.ts'

/** Cordis plugin name. */
export const name = 'hsf-skills'
/** Services this plugin needs. */
export const inject = ['skills']

/** Skill discovery settings. */
export interface Config {
  /** State directory; defaults to `HSF_HOME`, then `<DSH_HOME>/hsf`. */
  home?: string
  /** More directories to read skills from. */
  extraDirs?: string[]
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  home: z.string(),
  extraDirs: z.array(z.string()).default([]),
})

/** `lib/skills.js` sits one level under the package root, as `src/skills.ts` does. */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * @param ctx - an agent preset scope.
 * @param config - the discovery settings.
 */
export function apply(ctx: Context, config: Config): void {
  const learned = join(hsfHome(config.home), 'skills')
  mkdirSync(learned, { recursive: true })
  ctx.plugin(skillFilesystem, { customSkillDirs: [learned, join(packageRoot, 'skills'), ...config.extraDirs ?? []] })
}
