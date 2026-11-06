/**
 * CareerOps (github.com/career-ops-hq/career-ops) as the career mode's engine. CareerOps is AI-agnostic: its logic is
 * Markdown modes plus Node scripts, and its `career-ops` skill routes a request to the right mode after finding the
 * install from the skill file's own location. This module finds the install, adds that skill to the preset's catalog,
 * and gives the agent `career_ops_status`, which reports what the first run still needs.
 *
 * The install is the first of: the `root` setting, `CAREER_OPS_INSTALL`, `career-ops` beside the portable app
 * (`HSF_PORTABLE_ROOT`), `<HSF_HOME>/career-ops`, `career-ops` in the current directory and its parents, and
 * `~/career-ops`. The user's own files (CV, profile, tracker, reports) stay where CareerOps' data contract puts them.
 * @module hypersuperfluid/career
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { hsfHome } from './home.ts'

/** Cordis plugin name. */
export const name = 'hsf-career'
/** Services this plugin needs. */
export const inject = ['tools']

/** Career settings. */
export interface Config {
  /** The CareerOps install; searched for when empty. */
  root?: string
  /** State directory; defaults to `HSF_HOME`, then `<DSH_HOME>/hsf`. */
  home?: string
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  root: z.string(),
  home: z.string(),
})

/**
 * Whether a directory is a CareerOps install: it holds both `AGENTS.md` and `modes/`, the sentinels its own router uses.
 * @param dir - the candidate.
 * @returns true for an install.
 */
export function isCareerOps(dir: string): boolean {
  return existsSync(join(dir, 'AGENTS.md')) && existsSync(join(dir, 'modes')) && existsSync(join(dir, '.agents', 'skills', 'career-ops', 'SKILL.md'))
}

/**
 * The candidate install directories, most specific first.
 * @param config - the settings.
 * @param env - the environment.
 * @param cwd - where to start the upward search.
 * @returns absolute candidates.
 */
export function careerOpsCandidates(config: Config, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string[] {
  const candidates: string[] = []
  const add = (value: string | undefined): void => { if (value !== undefined && value !== '') candidates.push(resolve(value)) }
  add(config.root)
  add(env.CAREER_OPS_INSTALL)
  if (env.HSF_PORTABLE_ROOT !== undefined && env.HSF_PORTABLE_ROOT !== '') add(join(env.HSF_PORTABLE_ROOT, 'career-ops'))
  add(join(hsfHome(config.home), 'career-ops'))
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    add(join(dir, 'career-ops'))
    if (dirname(dir) === dir) break
  }
  add(join(homedir(), 'career-ops'))
  return [...new Set(candidates)]
}

/**
 * Finds the CareerOps install.
 * @param config - the settings.
 * @param env - the environment.
 * @param cwd - where to start the upward search.
 * @returns the install directory, or undefined when there is none.
 */
export function findCareerOps(config: Config, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | undefined {
  return careerOpsCandidates(config, env, cwd).find(isCareerOps)
}

/** What the first run still needs, read from the files rather than guessed. */
export interface CareerOpsStatus {
  readonly installed: boolean
  readonly root?: string
  readonly version?: string
  readonly dataRoot?: string
  readonly dependenciesInstalled?: boolean
  readonly hasCv?: boolean
  readonly hasProfile?: boolean
  readonly next: string[]
}

/**
 * Reads an install's state. The data root follows CareerOps' own precedence for the overrides this process can see:
 * `CAREER_OPS_ROOT` or `CAREER_OPS_DATA_DIR`, then the `.career-ops-data` marker, then the install itself.
 * @param root - the install, or undefined.
 * @param env - the environment.
 * @returns the status with the next steps in order.
 */
export function careerOpsStatus(root: string | undefined, env: NodeJS.ProcessEnv = process.env): CareerOpsStatus {
  if (root === undefined) {
    return {
      installed: false,
      next: ['CareerOps is not installed. Ask first, because it downloads software: then run `npx @santifer/career-ops init` in the folder the person picks, or set CAREER_OPS_INSTALL to an existing checkout and restart.'],
    }
  }
  const override = env.CAREER_OPS_ROOT ?? env.CAREER_OPS_DATA_DIR
  let dataRoot = root
  if (override !== undefined && override !== '') dataRoot = resolve(root, override)
  else if (existsSync(join(root, '.career-ops-data'))) {
    const marked = readFileSync(join(root, '.career-ops-data'), 'utf8').trim()
    if (marked !== '') dataRoot = resolve(root, marked)
  }
  let version: string | undefined
  try {
    version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version
  } catch {
    version = undefined
  }
  const dependenciesInstalled = existsSync(join(root, 'node_modules', 'js-yaml')) && existsSync(join(root, 'node_modules', 'playwright'))
  const hasCv = existsSync(join(dataRoot, 'cv.md'))
  const hasProfile = existsSync(join(dataRoot, 'config', 'profile.yml'))
  const next: string[] = []
  if (!dependenciesInstalled) next.push(`Install its dependencies once: \`npm install\` in ${root}. PDF output also needs \`npx playwright install chromium\` there.`)
  if (!hasCv || !hasProfile) next.push(`Run the first-run setup in ${join(root, 'AGENTS.md')}: it builds cv.md and config/profile.yml by chatting with the person.`)
  next.push('Load the career-ops skill and follow its routing; run every script from the install directory.')
  return { installed: true, root, ...version === undefined ? {} : { version }, dataRoot, dependenciesInstalled, hasCv, hasProfile, next }
}

/**
 * @param ctx - a preset scope.
 * @param config - the settings.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'career_ops_status',
    description: 'Find the CareerOps install and report what it still needs: its folder, the data folder holding the CV, profile and tracker, whether its dependencies are installed, and the next steps. Call it before the first career task of a session.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => Promise.resolve(JSON.stringify(careerOpsStatus(findCareerOps(config)), null, 2)),
  })), 'hsf-career: career_ops_status tool')
}
