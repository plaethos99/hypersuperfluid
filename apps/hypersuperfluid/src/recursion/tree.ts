/**
 * The editable harness: the files around a model that shape how it works, kept as `relative path -> content`.
 *
 * Harness² edits eight component kinds. On this harness, system prompt, guardrails, memory and tool guidance are all
 * one always-on `AGENTS.md`, which the agent-instructions plugin loads; skills and scripts live under `.agents/`.
 * Subagents and plugins are deliberately off the surface: a plugin runs inside the host process, and a candidate must
 * never be able to reach beyond its own run.
 * @module hypersuperfluid/recursion/tree
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { frontmatterField } from '../learning/skill-store.ts'
import { scanForThreats } from '../learning/memory.ts'

/** Relative path to file content. */
export type Tree = Record<string, string>

/** The always-on instruction file. */
export const ALWAYS_ON = 'AGENTS.md'
/** Maximum characters of always-on text: it is paid for on every request. */
export const ALWAYS_ON_MAX = 12_000

const NAME = '[a-z0-9][a-z0-9_-]*'
const SKILL_MD = new RegExp(`^\\.agents/skills/(${NAME})/SKILL\\.md$`, 'u')
const SKILL_SUPPORT = new RegExp(`^\\.agents/skills/${NAME}/(references|scripts|templates)/[A-Za-z0-9_.-]+$`, 'u')
const SCRIPT = /^\.agents\/scripts\/[a-z0-9_][a-z0-9_-]*\.(py|js|mjs|sh|ps1)$/u
const MAX_FILE_BYTES = 200_000

/**
 * @param rel - a forward-slash relative path.
 * @returns whether the path is on the editable surface.
 */
export function isAllowed(rel: string): boolean {
  if (rel.split('/').includes('..')) return false
  return rel === ALWAYS_ON || SKILL_MD.test(rel) || SKILL_SUPPORT.test(rel) || SCRIPT.test(rel)
}

function walk(dir: string, visit: (path: string) => void): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory() && entry.name !== '__pycache__' && entry.name !== 'node_modules') walk(path, visit)
    else if (entry.isFile()) visit(path)
  }
}

/**
 * Reads a harness directory.
 * @param dir - the directory.
 * @param rejected - collects paths on disk that are off the surface; omission ignores them.
 * @returns the tree of every file on the surface.
 */
export function readTree(dir: string, rejected?: string[]): Tree {
  const tree: Tree = {}
  walk(dir, (path) => {
    const rel = relative(dir, path).split(sep).join('/')
    if (!isAllowed(rel)) {
      rejected?.push(rel)
      return
    }
    if (statSync(path).size > MAX_FILE_BYTES) {
      rejected?.push(`${rel} (over ${MAX_FILE_BYTES} bytes)`)
      return
    }
    tree[rel] = readFileSync(path, 'utf8')
  })
  return tree
}

/**
 * Reads the harness a workspace already has, looking only at the surface's own locations.
 * @param workspace - the workspace's root.
 * @returns its tree, which is empty when it has no instructions or skills.
 */
export function readWorkspaceTree(workspace: string): Tree {
  const tree: Tree = {}
  const instructions = join(workspace, ALWAYS_ON)
  if (existsSync(instructions) && statSync(instructions).isFile()) tree[ALWAYS_ON] = readFileSync(instructions, 'utf8')
  return { ...tree, ...Object.fromEntries(
    ['skills', 'scripts'].flatMap((kind) => {
      const found: Array<[string, string]> = []
      walk(join(workspace, '.agents', kind), (path) => {
        const rel = relative(workspace, path).split(sep).join('/')
        if (isAllowed(rel) && statSync(path).size <= MAX_FILE_BYTES) found.push([rel, readFileSync(path, 'utf8')])
      })
      return found
    }),
  ) }
}

/**
 * Writes a tree into a directory, leaving other files alone.
 * @param tree - the tree.
 * @param dir - the target directory.
 */
export function writeTree(tree: Tree, dir: string): void {
  mkdirSync(dir, { recursive: true })
  for (const [rel, content] of Object.entries(tree)) {
    const path = join(dir, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, 'utf8')
  }
}

/**
 * Checks a proposed tree. Each message is fed back verbatim to the editor as retry feedback.
 * @param tree - the proposal.
 * @returns the problems, empty when the tree is acceptable.
 */
export function validateTree(tree: Tree): string[] {
  const problems: string[] = []
  const always = tree[ALWAYS_ON]
  if (always !== undefined && always.length > ALWAYS_ON_MAX) {
    problems.push(`${ALWAYS_ON} has ${always.length} characters, over the limit of ${ALWAYS_ON_MAX}. It is paid for on every request: move triggered knowledge into a skill.`)
  }
  for (const [rel, content] of Object.entries(tree)) {
    if (!isAllowed(rel)) problems.push(`${rel} is off the editable surface.`)
    const threat = scanForThreats(content)
    if (threat !== undefined) problems.push(`${rel} contains ${threat}.`)
    const skill = SKILL_MD.exec(rel)?.[1]
    if (skill !== undefined) {
      if (frontmatterField(content, 'name') !== skill) problems.push(`${rel} must have YAML frontmatter whose name is "${skill}".`)
      if ((frontmatterField(content, 'description') ?? '') === '') problems.push(`${rel} needs a frontmatter description saying when to use it.`)
    }
  }
  for (const rel of Object.keys(tree)) {
    const skill = /^\.agents\/skills\/([^/]+)\//u.exec(rel)?.[1]
    if (skill !== undefined && tree[`.agents/skills/${skill}/SKILL.md`] === undefined) {
      problems.push(`${rel} belongs to skill "${skill}", which has no SKILL.md.`)
    }
  }
  return problems
}

/** Paths that differ between two trees. */
export interface TreeDiff {
  /** Paths only in the new tree. */
  readonly added: readonly string[]
  /** Paths only in the old tree. */
  readonly removed: readonly string[]
  /** Paths in both with different content. */
  readonly modified: readonly string[]
}

/**
 * @param before - the old tree.
 * @param after - the new tree.
 * @returns the paths that differ.
 */
export function diffTrees(before: Tree, after: Tree): TreeDiff {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  return {
    added: paths.filter(path => before[path] === undefined),
    removed: paths.filter(path => after[path] === undefined),
    modified: paths.filter(path => before[path] !== undefined && after[path] !== undefined && before[path] !== after[path]),
  }
}

/**
 * @param tree - a tree.
 * @returns a stable digest of its content, for telling identical candidates apart.
 */
export function treeDigest(tree: Tree): string {
  const hash = createHash('sha256')
  for (const path of Object.keys(tree).sort()) hash.update(path).update('\0').update(tree[path] as string).update('\0')
  return hash.digest('hex').slice(0, 16)
}

/**
 * @param tree - a tree.
 * @returns a one-line census of its components.
 */
export function inventory(tree: Tree): string {
  const skills = Object.keys(tree).filter(path => SKILL_MD.test(path)).length
  const scripts = Object.keys(tree).filter(path => SCRIPT.test(path)).length
  const parts = [...skills > 0 ? [`${skills} skills`] : [], ...scripts > 0 ? [`${scripts} scripts`] : []]
  return `${parts.length > 0 ? parts.join(', ') : 'always-on edits only'}; ${(tree[ALWAYS_ON] ?? '').length} always-on characters`
}
