/**
 * Where this bundle keeps its durable state.
 * @module hypersuperfluid/home
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Resolves the state directory: an explicit value, then `HSF_HOME`, then `hsf` under `DSH_HOME`, then `~/.dsh/hsf`.
 * @param configured - the plugin's `home` setting.
 * @returns the absolute state directory.
 */
export function hsfHome(configured?: string): string {
  if (configured !== undefined && configured !== '') return resolve(configured)
  if (process.env.HSF_HOME !== undefined && process.env.HSF_HOME !== '') return resolve(process.env.HSF_HOME)
  return join(process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh'), 'hsf')
}
