/**
 * Reads what a codebase is and how it is set up, run and tested, from the files at its root: package manifests,
 * lock files, build files, Docker files, `.env` examples and the README's setup section. It reads a fixed set of
 * files and never walks the tree, so it is cheap enough to run on every step for the working folder.
 * @module hypersuperfluid/repo/survey
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/** What a codebase is and how it is worked with. */
export interface RepoSurvey {
  readonly root: string
  readonly name: string
  /** Languages and frameworks, e.g. "Node.js", "Python", "Next.js". */
  readonly kinds: readonly string[]
  /** Root files that told us so. */
  readonly markers: readonly string[]
  /** Setup, build, test, run and lint commands, best guess first. */
  readonly commands: Readonly<Partial<Record<CommandKind, string>>>
  /** Variable names from `.env.example` and the like, never values. */
  readonly envNames: readonly string[]
  /** The file those names came from. */
  readonly envExample?: string
  /** The README's setup or install section, trimmed. */
  readonly readmeSetup?: string
  readonly hasGit: boolean
  readonly hasDocker: boolean
  /** Folders with their own manifest one level down (a monorepo's apps). */
  readonly subprojects: readonly string[]
}

/** The kinds of command a survey reports. */
export type CommandKind = 'install' | 'build' | 'test' | 'run' | 'lint'

const MANIFESTS: ReadonlyArray<readonly [string, string]> = [
  ['package.json', 'Node.js'],
  ['pyproject.toml', 'Python'],
  ['requirements.txt', 'Python'],
  ['setup.py', 'Python'],
  ['Pipfile', 'Python'],
  ['environment.yml', 'Python (conda)'],
  ['go.mod', 'Go'],
  ['Cargo.toml', 'Rust'],
  ['pom.xml', 'Java (Maven)'],
  ['build.gradle', 'Java/Kotlin (Gradle)'],
  ['build.gradle.kts', 'Java/Kotlin (Gradle)'],
  ['composer.json', 'PHP'],
  ['Gemfile', 'Ruby'],
  ['mix.exs', 'Elixir'],
  ['pubspec.yaml', 'Dart/Flutter'],
  ['CMakeLists.txt', 'C/C++ (CMake)'],
  ['Makefile', 'Make'],
  ['deno.json', 'Deno'],
  ['__manifest__.py', 'Odoo module'],
]

const ENV_EXAMPLES = ['.env.example', '.env.sample', '.env.template', '.env.dist', 'example.env', '.env.local.example']

/** True when a folder looks like a codebase: it has a manifest, a build file or a git checkout. */
export function isCodebase(dir: string): boolean {
  return MANIFESTS.some(([file]) => existsSync(join(dir, file))) || existsSync(join(dir, '.git'))
    || safeList(dir).some(name => name.endsWith('.sln') || name.endsWith('.csproj'))
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

function readText(path: string, limit = 200_000): string | undefined {
  try {
    if (statSync(path).size > limit) return undefined
    return readFileSync(path, 'utf8')
  } catch { return undefined }
}

interface PackageJson {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  packageManager?: string
}

function readPackageJson(dir: string): PackageJson | undefined {
  const text = readText(join(dir, 'package.json'))
  if (text === undefined) return undefined
  try { return JSON.parse(text) as PackageJson } catch { return undefined }
}

/** The Node package manager a folder uses. */
export function nodePackageManager(dir: string, pkg: PackageJson | undefined): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  const declared = pkg?.packageManager?.split('@')[0]
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm') return declared
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun'
  return 'npm'
}

const FRAMEWORKS: ReadonlyArray<readonly [string, string]> = [
  ['next', 'Next.js'], ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['@angular/core', 'Angular'],
  ['express', 'Express'], ['electron', 'Electron'], ['vite', 'Vite'], ['@nestjs/core', 'NestJS'], ['typescript', 'TypeScript'],
]

function nodeCommands(dir: string, pkg: PackageJson, kinds: string[]): Partial<Record<CommandKind, string>> {
  const pm = nodePackageManager(dir, pkg)
  const run = (script: string): string => (pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`)
  const scripts = pkg.scripts ?? {}
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  for (const [dep, label] of FRAMEWORKS) if (dep in deps && !kinds.includes(label)) kinds.push(label)
  const pick = (...names: string[]): string | undefined => names.find(name => scripts[name] !== undefined)
  const commands: Partial<Record<CommandKind, string>> = { install: `${pm} install` }
  const build = pick('build', 'compile')
  const test = pick('test', 'test:unit', 'vitest')
  const start = pick('dev', 'start', 'serve', 'preview')
  const lint = pick('lint', 'typecheck', 'check')
  if (build !== undefined) commands.build = run(build)
  if (test !== undefined && !/no test specified/u.test(scripts[test] ?? '')) commands.test = run(test)
  if (start !== undefined) commands.run = run(start)
  if (lint !== undefined) commands.lint = run(lint)
  return commands
}

function pythonCommands(dir: string, names: readonly string[]): Partial<Record<CommandKind, string>> {
  const pyproject = readText(join(dir, 'pyproject.toml')) ?? ''
  const commands: Partial<Record<CommandKind, string>> = {}
  if (existsSync(join(dir, 'uv.lock'))) commands.install = 'uv sync'
  else if (/\[tool\.poetry\]/u.test(pyproject)) commands.install = 'poetry install'
  else if (existsSync(join(dir, 'requirements.txt'))) commands.install = 'python -m venv .venv, then .venv\'s pip install -r requirements.txt'
  else if (pyproject !== '' || existsSync(join(dir, 'setup.py'))) commands.install = 'python -m venv .venv, then .venv\'s pip install -e .'
  if (names.includes('manage.py')) commands.run = 'python manage.py migrate, then python manage.py runserver'
  else if (names.includes('app.py')) commands.run = 'python app.py'
  else if (names.includes('main.py')) commands.run = 'python main.py'
  if (/pytest/u.test(pyproject) || names.includes('pytest.ini') || names.includes('tests')) commands.test = 'python -m pytest'
  if (/\[tool\.ruff/u.test(pyproject)) commands.lint = 'ruff check .'
  return commands
}

const OTHER_COMMANDS: Readonly<Record<string, Partial<Record<CommandKind, string>>>> = {
  'go.mod': { install: 'go mod download', build: 'go build ./...', test: 'go test ./...', lint: 'go vet ./...' },
  'Cargo.toml': { build: 'cargo build', test: 'cargo test', run: 'cargo run', lint: 'cargo clippy' },
  'pom.xml': { build: 'mvn -q package -DskipTests', test: 'mvn -q test' },
  'build.gradle': { build: 'gradle build -x test (or ./gradlew)', test: 'gradle test' },
  'build.gradle.kts': { build: 'gradle build -x test (or ./gradlew)', test: 'gradle test' },
  'composer.json': { install: 'composer install' },
  'Gemfile': { install: 'bundle install' },
  'pubspec.yaml': { install: 'flutter pub get', test: 'flutter test', run: 'flutter run' },
  'CMakeLists.txt': { build: 'cmake -S . -B build && cmake --build build' },
  'mix.exs': { install: 'mix deps.get', test: 'mix test' },
}

/** Variable names in an env example file; values are never returned. */
export function envNames(text: string): string[] {
  const names: string[] = []
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line)
    if (match?.[1] !== undefined && !names.includes(match[1])) names.push(match[1])
  }
  return names
}

/** The README's install, setup or getting-started section, up to `limit` characters. */
export function readmeSetup(text: string, limit = 1500): string | undefined {
  const lines = text.split(/\r?\n/u)
  const setupHeading = /^#{1,4}\s.*\b(install|installation|setup|set up|getting started|quick ?start|usage|running|run locally)\b/iu
  const start = lines.findIndex(line => setupHeading.test(line))
  if (start < 0) return undefined
  const level = /^(#+)/u.exec(lines[start] ?? '')?.[1]?.length ?? 2
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = /^(#+)\s/u.exec(lines[index] ?? '')
    if (heading?.[1] !== undefined && heading[1].length <= level) { end = index; break }
  }
  const section = lines.slice(start, end).join('\n').trim()
  return section.length > limit ? `${section.slice(0, limit)}\n…` : section
}

/**
 * Surveys a codebase's root.
 * @param root - the folder.
 * @returns what it is and how it is set up, run and tested.
 */
export function surveyRepo(root: string): RepoSurvey {
  const names = safeList(root)
  const kinds: string[] = []
  const markers: string[] = []
  let commands: Partial<Record<CommandKind, string>> = {}
  for (const [file, kind] of MANIFESTS) {
    if (!names.includes(file)) continue
    markers.push(file)
    if (!kinds.includes(kind)) kinds.push(kind)
  }
  for (const name of names) {
    if (name.endsWith('.sln') || name.endsWith('.csproj')) {
      markers.push(name)
      if (!kinds.includes('.NET')) kinds.push('.NET')
      commands = { build: 'dotnet build', test: 'dotnet test', run: 'dotnet run', ...commands }
    }
  }
  const pkg = names.includes('package.json') ? readPackageJson(root) : undefined
  if (pkg !== undefined) commands = { ...nodeCommands(root, pkg, kinds), ...commands }
  if (kinds.includes('Python') || kinds.includes('Python (conda)')) commands = { ...pythonCommands(root, names), ...commands }
  for (const [file, more] of Object.entries(OTHER_COMMANDS)) if (names.includes(file)) commands = { ...more, ...commands }
  if (names.includes('Makefile') && commands.build === undefined) commands.build = 'make'
  const hasDocker = names.some(name => /^(docker-compose|compose)\.ya?ml$/u.test(name) || name === 'Dockerfile')
  if (hasDocker) {
    markers.push(...names.filter(name => /^(docker-compose|compose)\.ya?ml$|^Dockerfile$/u.test(name)))
    if (commands.run === undefined && names.some(name => /compose\.ya?ml$/u.test(name))) commands.run = 'docker compose up'
  }
  const envFile = ENV_EXAMPLES.find(file => names.includes(file))
  const envText = envFile === undefined ? undefined : readText(join(root, envFile))
  const readme = names.find(name => /^readme(\.md|\.rst|\.txt)?$/iu.test(name))
  const setup = readme === undefined ? undefined : readmeSetup(readText(join(root, readme)) ?? '')
  const subprojects = names.filter((name) => {
    if (name.startsWith('.') || name === 'node_modules') return false
    const path = join(root, name)
    try { return statSync(path).isDirectory() && MANIFESTS.some(([file]) => existsSync(join(path, file))) } catch { return false }
  }).slice(0, 12)
  return {
    root, name: basename(root), kinds, markers, commands,
    envNames: envText === undefined ? [] : envNames(envText),
    ...(envFile === undefined ? {} : { envExample: envFile }),
    ...(setup === undefined ? {} : { readmeSetup: setup }),
    hasGit: names.includes('.git'), hasDocker, subprojects,
  }
}

/** One line: what the codebase is, from what. */
export function surveyLine(survey: RepoSurvey): string {
  const kinds = survey.kinds.length === 0 ? 'a folder' : `a ${survey.kinds.join(', ')} project`
  const markers = survey.markers.length === 0 ? '' : ` (${survey.markers.slice(0, 6).join(', ')})`
  return `${kinds}${markers}`
}

/** The whole survey as the agent reads it. */
export function formatSurvey(survey: RepoSurvey): string {
  const lines = [`${survey.root}: ${surveyLine(survey)}`]
  const commands = Object.entries(survey.commands)
  if (commands.length > 0) lines.push('Commands (from the files; check the README):', ...commands.map(([kind, command]) => `- ${kind}: ${command}`))
  if (survey.envNames.length > 0) lines.push(`Settings in ${survey.envExample ?? '.env'}: ${survey.envNames.join(', ')}`)
  if (survey.subprojects.length > 0) lines.push(`Subprojects: ${survey.subprojects.join(', ')}`)
  lines.push(`Git checkout: ${survey.hasGit ? 'yes' : 'no'}; Docker: ${survey.hasDocker ? 'yes' : 'no'}`)
  if (survey.readmeSetup !== undefined) lines.push('README setup section:', survey.readmeSetup)
  return lines.join('\n')
}
