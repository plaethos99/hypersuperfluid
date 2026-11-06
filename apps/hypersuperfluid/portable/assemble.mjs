/**
 * Assembles the portable Windows folder from a packaged desktop app:
 *
 *   Hypersuperfluid-<version>-win-x64-portable/
 *     Hypersuperfluid.cmd   starts the app with all state under data\
 *     README.txt
 *     app\                  the unpacked desktop app, unchanged
 *     career-ops\           CareerOps' system files, when a checkout is beside the repo (never a person's own data)
 *     keys.sealed           with --keys: the given .env, sealed, so the folder and its zip hold no plain-text key
 *
 * Usage:
 *   node apps/hypersuperfluid/portable/assemble.mjs [<win-unpacked dir>] [<output dir>] [--keys <.env file>] [--no-career-ops]
 *
 * --keys seals the file with a key built into the app: it keeps keys out of plain sight in the zip, but anyone with the
 * app could recover them. At first start the app moves them into its encrypted vault and deletes keys.sealed.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..', '..')

const positional = []
let keysFile
let careerOps = true
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (arg === '--keys') keysFile = process.argv[++i]
  else if (arg === '--no-career-ops') careerOps = false
  else positional.push(arg)
}

const unpacked = resolve(positional[0] ?? join(repo, 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64', 'unsigned-artifacts', 'win-unpacked'))
const outRoot = resolve(positional[1] ?? join(repo, 'dist-portable'))
const executable = join(unpacked, 'Hypersuperfluid.exe')
if (!existsSync(executable)) {
  console.error(`assemble: ${executable} does not exist. Build the app first: pnpm run package:desktop:win:x64:unsigned`)
  process.exit(1)
}

const { version } = JSON.parse(readFileSync(join(repo, 'apps', 'desktop', 'package.json'), 'utf8'))
const name = `Hypersuperfluid-${version}-win-x64-portable`
const target = join(outRoot, name)
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(unpacked, join(target, 'app'), { recursive: true, verbatimSymlinks: true })
cpSync(join(here, 'Hypersuperfluid.cmd'), join(target, 'Hypersuperfluid.cmd'))
cpSync(join(here, 'README.txt'), join(target, 'README.txt'))

// CareerOps: only the files its own repository tracks. Its data contract keeps every personal file (CV, profile,
// tracker, reports) untracked, so a person's job search never ends up in a zip meant for someone else.
const careerSource = join(repo, 'career-ops')
if (careerOps && existsSync(join(careerSource, '.git'))) {
  const tracked = execFileSync('git', ['-C', careerSource, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)
  for (const file of tracked) {
    const from = join(careerSource, file)
    if (!existsSync(from)) continue
    const to = join(target, 'career-ops', file)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to)
  }
  console.error(`assemble: added CareerOps (${tracked.length} system files)`)
}

if (keysFile !== undefined) {
  const { sealKeys } = await import(pathToFileURL(join(repo, 'apps', 'desktop', 'src', 'key-vault.ts')).href)
  writeFileSync(join(target, 'keys.sealed'), sealKeys(readFileSync(resolve(keysFile), 'utf8')))
  console.error('assemble: sealed the keys into keys.sealed; the folder holds no plain-text key')
}

console.log(target)
