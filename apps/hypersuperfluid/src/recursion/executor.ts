/**
 * Runs refinement on real work. Every rollout gets an isolated copy of the workspace and a child Session, and every
 * editor gets a directory holding the evidence. All of it lives under `<workspace>/.hsf/runs/<id>/`, because a spawned
 * child keeps its parent's write boundary. The person's own files never change here: the chosen result comes back as
 * a patch they decide about.
 * @module hypersuperfluid/recursion/executor
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import { textOf } from '../content.ts'
import type { RefineExecutor, RunView, StageReply, StageRequest } from './engine.ts'
import { readTree, writeTree, type Tree } from './tree.ts'

/** Directories never copied into a rollout: they are rebuilt, huge, or both. */
const COPY_EXCLUDES = new Set(['.git', '.hsf', 'node_modules', '.venv', 'venv', '__pycache__', 'target', 'dist', 'build', '.gradle', '.next'])
const OUTPUT_CAP = 200_000
const GIT_IDENTITY = ['-c', 'user.name=hypersuperfluid', '-c', 'user.email=hsf@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=']

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
}

/**
 * Copies a workspace into a directory inside itself, which `cpSync` refuses even with a filter. Symbolic links are left
 * out: one could point outside the workspace, and a run must not write through it.
 */
function copyWorkspace(source: string, target: string): void {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (COPY_EXCLUDES.has(entry.name)) continue
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) copyWorkspace(from, to)
    else if (entry.isFile()) copyFileSync(from, to)
  }
}

function isGitWorktree(dir: string): boolean {
  try {
    return git(dir, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'
  } catch {
    return false
  }
}

/** The services the executor uses, narrowed from the plugin context. */
export interface ExecutorHost {
  /** Starts one child Session and returns its outcome. */
  startChild(request: {
    readonly childId: SessionId
    readonly label: string
    readonly cwd: string
    readonly prompt: string
    readonly parent: Agent
    readonly signal: AbortSignal
    readonly outputSchema?: object
  }): Promise<SubagentResult>
  /** Text recorded for a child's tool calls so far, read after it ends. */
  trajectoryOf(childId: string): string
  /** Stops recording a child's tool calls. */
  releaseTrajectory(childId: string): void
}

/** The fixed inputs of one run. */
export interface ExecutorOptions {
  /** The workspace being worked on. */
  readonly workspace: string
  /** The task as the person stated it. */
  readonly task: string
  /** The calling agent. */
  readonly parent: Agent
  /** Copy of the experience library, when there are entries. */
  readonly copyLibrary: (target: string) => boolean
  /** Maximum time of one rollout or editor session. */
  readonly timeoutMs: number
  /** Job progress line. */
  readonly progress: (line: string) => void
  /** Cancels the run. */
  readonly signal: AbortSignal
  /** The services. */
  readonly host: ExecutorHost
}

/** Effects of one refinement in one workspace. */
export class WorkspaceExecutor implements RefineExecutor {
  /** This run's id. */
  readonly runId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`
  /** This run's directory. */
  readonly runDir: string
  private readonly gitSource: boolean
  private readonly worktrees: string[] = []

  /** @param options - the run's inputs. */
  constructor(private readonly options: ExecutorOptions) {
    this.runDir = join(options.workspace, '.hsf', 'runs', this.runId)
    mkdirSync(this.runDir, { recursive: true })
    writeFileSync(join(this.runDir, 'task.md'), options.task, 'utf8')
    this.gitSource = isGitWorktree(options.workspace)
    if (this.gitSource) this.excludeFromGit()
  }

  /** Keeps run data out of the person's `git status` without touching a tracked file. */
  private excludeFromGit(): void {
    const exclude = join(this.options.workspace, git(this.options.workspace, ['rev-parse', '--git-path', 'info/exclude']).trim())
    mkdirSync(join(exclude, '..'), { recursive: true })
    const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
    if (!current.split(/\r?\n/u).includes('.hsf/')) appendFileSync(exclude, `${current.endsWith('\n') || current === '' ? '' : '\n'}.hsf/\n`, 'utf8')
  }

  /**
   * Gives a rollout its own copy of the workspace, including uncommitted tracked edits, with the harness committed so
   * that `changes.diff` shows only what the run did.
   */
  private prepareWorkspace(label: string, tree: Tree): string {
    const path = join(this.runDir, 'workspaces', label)
    if (this.gitSource) {
      const stash = git(this.options.workspace, ['stash', 'create']).trim()
      git(this.options.workspace, ['worktree', 'add', '--detach', path, stash === '' ? 'HEAD' : stash])
      this.worktrees.push(path)
    } else {
      copyWorkspace(this.options.workspace, path)
      git(path, ['init', '-q'])
      git(path, ['add', '-A'])
      git(path, ['commit', '-q', '--allow-empty', '-m', 'workspace'])
    }
    writeTree(tree, path)
    git(path, ['add', '-A'])
    git(path, ['commit', '-q', '--allow-empty', '-m', `harness ${label}`])
    return path
  }

  private async runChild(label: string, cwd: string, prompt: string, outputSchema?: object): Promise<SubagentResult> {
    const childId = SessionId(randomUUID())
    const abort = new AbortController()
    const timer = setTimeout(() => { abort.abort(new Error(`${label} ran past its time limit`)) }, this.options.timeoutMs)
    const cancel = (): void => { abort.abort(this.options.signal.reason) }
    this.options.signal.addEventListener('abort', cancel, { once: true })
    try {
      return await this.options.host.startChild({
        childId, label, cwd, prompt, parent: this.options.parent, signal: abort.signal,
        ...outputSchema === undefined ? {} : { outputSchema },
      })
    } finally {
      clearTimeout(timer)
      this.options.signal.removeEventListener('abort', cancel)
      const rolloutDir = join(this.runDir, 'rollouts', label)
      if (existsSync(rolloutDir)) writeFileSync(join(rolloutDir, 'trajectory.md'), this.options.host.trajectoryOf(childId).slice(0, OUTPUT_CAP), 'utf8')
      this.options.host.releaseTrajectory(childId)
    }
  }

  /** {@inheritDoc RefineExecutor.rollout} */
  async rollout(label: string, tree: Tree): Promise<RunView> {
    const rolloutDir = join(this.runDir, 'rollouts', label)
    mkdirSync(rolloutDir, { recursive: true })
    writeTree(tree, join(this.runDir, 'harnesses', label))
    const workspace = this.prepareWorkspace(label, tree)
    const result = await this.runChild(label, workspace, this.options.task)
    const output = textOf(result.output)
    writeFileSync(join(rolloutDir, 'output.md'), output.slice(0, OUTPUT_CAP), 'utf8')
    git(workspace, ['add', '-A'])
    const diff = git(workspace, ['diff', '--cached', 'HEAD', '--binary'])
    writeFileSync(join(rolloutDir, 'changes.diff'), diff, 'utf8')
    const ok = result.stopReason === 'completed'
    return { label, ok, delivered: ok && (output.trim() !== '' || diff.trim() !== ''), ...ok ? {} : { error: `stopped: ${result.stopReason}` } }
  }

  /** {@inheritDoc RefineExecutor.edit} */
  async edit(request: StageRequest): Promise<StageReply> {
    const dir = join(this.runDir, 'context', request.label)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'task.md'), this.options.task, 'utf8')
    writeTree(request.start, join(dir, 'harness'))
    for (const view of request.rollouts) {
      const source = join(this.runDir, 'rollouts', view.label)
      if (existsSync(source)) cpSync(source, join(dir, 'rollouts', view.label), { recursive: true })
    }
    for (const candidate of request.candidates) writeTree(candidate.tree, join(dir, 'candidates', candidate.label))
    const decisions = Object.entries(request.decisions).map(([label, notes]) => `## ${label}\n${notes}`).join('\n\n')
    if (decisions !== '') writeFileSync(join(dir, 'decisions.md'), decisions, 'utf8')
    this.options.copyLibrary(join(dir, 'library'))
    const prompt = request.feedback === undefined ? request.mission : `${request.mission}\n\n# YOUR PREVIOUS ATTEMPT WAS REJECTED\n\n${request.feedback}\n\nFix it in \`harness/\` and reply again.`
    const result = await this.runChild(request.label, dir, prompt)
    if (result.stopReason !== 'completed') throw new Error(`editor stopped: ${result.stopReason}`)
    const rejected: string[] = []
    const tree = readTree(join(dir, 'harness'), rejected)
    return { tree, rejected, notes: textOf(result.output) }
  }

  /** {@inheritDoc RefineExecutor.progress} */
  progress(line: string): void {
    this.options.progress(line)
  }

  /**
   * Starts the selection and reflection session over anonymized candidates.
   * @param prompt - the selection mission.
   * @param idToLabel - anonymous id to rollout label.
   * @param treeOf - the harness of a label.
   * @param schema - the required structured output.
   * @returns the child's outcome.
   */
  async select(
    prompt: string,
    idToLabel: Readonly<Record<string, string>>,
    treeOf: (label: string) => Tree,
    schema: object,
  ): Promise<SubagentResult> {
    const dir = join(this.runDir, 'selection')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'task.md'), this.options.task, 'utf8')
    for (const [id, label] of Object.entries(idToLabel)) {
      const target = join(dir, 'candidates', id)
      mkdirSync(target, { recursive: true })
      const source = join(this.runDir, 'rollouts', label)
      for (const file of ['output.md', 'changes.diff']) {
        if (existsSync(join(source, file))) cpSync(join(source, file), join(target, file))
      }
      const summary = Object.entries(treeOf(label)).map(([path, text]) => `## ${path}\n\n${text}`).join('\n\n')
      writeFileSync(join(target, 'harness.md'), summary === '' ? '(the unmodified harness)' : summary, 'utf8')
    }
    return this.runChild('selection', dir, prompt, schema)
  }

  /**
   * Removes the rollouts' workspace copies, keeping every evidence file. Nothing outside this run's directory is touched.
   * @param keep - the rollout whose workspace stays, so the person can inspect the chosen result.
   */
  cleanup(keep?: string): void {
    const kept = keep === undefined ? undefined : join(this.runDir, 'workspaces', keep)
    for (const path of this.worktrees) {
      if (path === kept) continue
      try {
        git(this.options.workspace, ['worktree', 'remove', '--force', path])
      } catch {
        rmSync(path, { recursive: true, force: true })
      }
    }
    if (this.gitSource) {
      git(this.options.workspace, ['worktree', 'prune'])
      return
    }
    const root = join(this.runDir, 'workspaces')
    if (!existsSync(root)) return
    for (const label of readdirSync(root)) {
      if (label !== keep) rmSync(join(root, label), { recursive: true, force: true })
    }
  }
}
