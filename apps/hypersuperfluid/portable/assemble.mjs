/**
 * Assembles the portable Windows folder from a packaged desktop app:
 *
 *   Hypersuperfluid-<version>-win-x64-portable/
 *     Hypersuperfluid.cmd   starts the app with all state under data\
 *     README.txt
 *     app\                  the unpacked desktop app, unchanged
 *
 * Usage: node apps/hypersuperfluid/portable/assemble.mjs [<win-unpacked dir>] [<output dir>]
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..', '..')
const unpacked = resolve(process.argv[2] ?? join(repo, 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64', 'unsigned-artifacts', 'win-unpacked'))
const outRoot = resolve(process.argv[3] ?? join(repo, 'dist-portable'))
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
console.log(target)
