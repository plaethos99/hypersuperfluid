/**
 * Prepares the ERP Python environment, or starts one ERP MCP server in it. Nothing is installed until an ERP is
 * connected. stdout carries the MCP protocol, so setup output goes to stderr.
 *
 * Usage: launch.mjs --prepare | launch.mjs <entry> [server arguments], where <entry> is erp-mcp or erp-customize.
 * HSF_HOME must name the state directory: a host's MCP client starts servers with a reduced environment, so the
 * launcher never guesses it.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENTRIES = new Set(['erp-mcp', 'erp-customize'])
const [entry, ...serverArgs] = process.argv.slice(2)
if (entry !== '--prepare' && !ENTRIES.has(entry)) {
  console.error(`launch.mjs: unknown command "${entry}", expected --prepare or one of ${[...ENTRIES].join(', ')}`)
  process.exit(2)
}
if (process.env.HSF_HOME === undefined || process.env.HSF_HOME === '') {
  console.error('launch.mjs: HSF_HOME is not set, so the ERP state directory is unknown')
  process.exit(2)
}

const source = dirname(fileURLToPath(import.meta.url))
const home = resolve(process.env.HSF_HOME)
const environment = join(home, 'erp', 'python')
const stamp = join(environment, '.ready')
const lock = join(home, 'erp', '.setup-lock')
/** A lock older than this belongs to a setup that died. */
const STALE_LOCK_MS = 30 * 60_000
const isWindows = process.platform === 'win32'
const scripts = join(environment, isWindows ? 'Scripts' : 'bin')
const python = join(scripts, isWindows ? 'python.exe' : 'python')

/** Runs a setup step with its output on stderr, and returns whether it succeeded. */
function step(command, args) {
  const result = spawnSync(command, args, { stdio: ['ignore', process.stderr, process.stderr], windowsHide: true })
  return !result.error && result.status === 0
}

function findBasePython() {
  for (const [command, args] of [['python3.13', []], ['python3.12', []], ['python3', []], ['python', []], ['py', ['-3']]]) {
    const probe = spawnSync(command, [...args, '-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)'], { stdio: 'ignore', windowsHide: true })
    if (!probe.error && probe.status === 0) return [command, args]
  }
  return undefined
}

/**
 * Copies the server's source next to its environment, because in the desktop app it lies inside `app.asar`, which
 * only Electron's own file functions can read and an installer run as a child process cannot.
 */
function copySource() {
  const target = join(home, 'erp', 'source')
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  for (const item of ['src', 'pyproject.toml']) cpSync(join(source, item), join(target, item), { recursive: true })
  return target
}

function createEnvironment() {
  console.error('hypersuperfluid: preparing the ERP environment. This happens once and takes a few minutes.')
  rmSync(environment, { recursive: true, force: true })
  const installable = copySource()
  if (step('uv', ['venv', '--python', '3.12', environment]) && step('uv', ['pip', 'install', '--python', python, installable])) return true
  rmSync(environment, { recursive: true, force: true })
  const base = findBasePython()
  if (base === undefined) {
    console.error('hypersuperfluid: ERP tools need uv or Python 3.12 or newer. Install one and restart.')
    return false
  }
  const [command, args] = base
  return step(command, [...args, '-m', 'venv', environment]) && step(python, ['-m', 'pip', 'install', '--disable-pip-version-check', installable])
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Makes sure the environment exists, building it under a lock so concurrent starts build it once. */
function ensureEnvironment() {
  mkdirSync(dirname(lock), { recursive: true })
  for (;;) {
    if (existsSync(stamp)) return true
    try {
      mkdirSync(lock)
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { recursive: true, force: true })
      else sleep(2_000)
    }
  }
  try {
    if (existsSync(stamp)) return true
    if (!createEnvironment()) return false
    writeFileSync(stamp, new Date().toISOString())
    return true
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

if (!ensureEnvironment()) process.exit(1)
if (entry === '--prepare') process.exit(0)

const server = join(scripts, isWindows ? `${entry}.exe` : entry)
const result = spawnSync(server, serverArgs, { stdio: 'inherit', windowsHide: true })
if (result.error) {
  console.error(`hypersuperfluid: could not start ${entry}: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
