import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import { runSequential } from '../src/recursion/engine.ts'
import { WorkspaceExecutor, type ExecutorHost } from '../src/recursion/executor.ts'
import { ALWAYS_ON } from '../src/recursion/tree.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const completed = (text: string): SubagentResult => ({ output: [{ type: 'text', text }], stopReason: 'completed' })

let workspace: string
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'hsf-workspace-'))
  writeFileSync(join(workspace, 'data.txt'), 'original\n')
})
afterEach(() => { rmSync(workspace, { recursive: true, force: true }) })

/** A host whose children act on their working directory, as a real child Session would. */
function hostThat(act: (cwd: string, prompt: string) => void): ExecutorHost & { readonly cwds: string[] } {
  const cwds: string[] = []
  return {
    cwds,
    startChild: ({ cwd, prompt }) => {
      cwds.push(cwd)
      act(cwd, prompt)
      return Promise.resolve(completed('done'))
    },
    trajectoryOf: () => '[ACTION] write\n',
    releaseTrajectory: () => {},
  }
}

function executorWith(host: ExecutorHost, signal = new AbortController().signal): WorkspaceExecutor {
  return new WorkspaceExecutor({
    workspace, task: 'Change data.txt', parent: {} as Agent, copyLibrary: () => false,
    timeoutMs: 60_000, progress: () => {}, signal, host,
  })
}

describe.each([
  ['a plain folder', () => {}],
  ['a git repository', () => {
    git(workspace, 'init', '-q')
    git(workspace, 'add', '-A')
    git(workspace, 'commit', '-qm', 'start')
  }],
])('rollouts in %s', (_label, prepare) => {
  beforeEach(prepare)

  it('runs in an isolated copy, and returns only what the run did as a patch', async () => {
    const executor = executorWith(hostThat((cwd) => { writeFileSync(join(cwd, 'data.txt'), 'changed\n') }))
    const view = await executor.rollout('base1', { [ALWAYS_ON]: 'harness rules\n' })
    expect(view).toMatchObject({ ok: true, delivered: true })
    expect(readFileSync(join(workspace, 'data.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('original\n')
    expect(existsSync(join(workspace, ALWAYS_ON))).toBe(false)
    const diff = readFileSync(join(executor.runDir, 'rollouts', 'base1', 'changes.diff'), 'utf8')
    expect(diff).toContain('+changed')
    expect(diff).not.toContain('harness rules')
    expect(readFileSync(join(executor.runDir, 'rollouts', 'base1', 'trajectory.md'), 'utf8')).toContain('[ACTION]')
    executor.cleanup()
  })

  it('gives the run the harness on disk', async () => {
    const seen: string[] = []
    const executor = executorWith(hostThat((cwd) => { seen.push(readFileSync(join(cwd, ALWAYS_ON), 'utf8')) }))
    await executor.rollout('inv1', { [ALWAYS_ON]: 'rules for inv1' })
    expect(seen).toEqual(['rules for inv1'])
    executor.cleanup()
  })

  it('removes workspace copies but keeps the evidence and the chosen one', async () => {
    const executor = executorWith(hostThat(() => {}))
    await executor.rollout('c1', {})
    await executor.rollout('base1', {})
    executor.cleanup('c1')
    expect(existsSync(join(executor.runDir, 'workspaces', 'base1'))).toBe(false)
    expect(existsSync(join(executor.runDir, 'workspaces', 'c1'))).toBe(true)
    expect(existsSync(join(executor.runDir, 'rollouts', 'base1', 'output.md'))).toBe(true)
  })
})

describe('WorkspaceExecutor', () => {
  it('leaves generated and vendored directories out of a copy', async () => {
    mkdirSync(join(workspace, 'node_modules', 'big'), { recursive: true })
    writeFileSync(join(workspace, 'node_modules', 'big', 'index.js'), 'x')
    const seen: boolean[] = []
    const executor = executorWith(hostThat((cwd) => { seen.push(existsSync(join(cwd, 'node_modules'))) }))
    await executor.rollout('base1', {})
    expect(seen).toEqual([false])
  })

  it('carries uncommitted edits into a git rollout, and keeps run data out of git status', async () => {
    git(workspace, 'init', '-q')
    git(workspace, 'add', '-A')
    git(workspace, 'commit', '-qm', 'start')
    writeFileSync(join(workspace, 'data.txt'), 'uncommitted\n')
    const seen: string[] = []
    const executor = executorWith(hostThat((cwd) => { seen.push(readFileSync(join(cwd, 'data.txt'), 'utf8')) }))
    await executor.rollout('base1', {})
    expect(seen[0]?.replaceAll('\r\n', '\n')).toBe('uncommitted\n')
    expect(git(workspace, 'status', '--porcelain')).not.toContain('.hsf')
    executor.cleanup()
  })

  it('gives an editor its evidence, and reads back the harness it left', async () => {
    const executor = executorWith(hostThat((cwd, prompt) => {
      if (prompt.includes('MISSION')) {
        expect(readFileSync(join(cwd, 'harness', ALWAYS_ON), 'utf8')).toBe('start')
        expect(existsSync(join(cwd, 'rollouts', 'base1', 'changes.diff'))).toBe(true)
        expect(readFileSync(join(cwd, 'decisions.md'), 'utf8')).toContain('why inv1')
        writeFileSync(join(cwd, 'harness', ALWAYS_ON), 'edited')
        writeFileSync(join(cwd, 'harness', 'stray.txt'), 'x')
      }
    }))
    await executor.rollout('base1', {})
    const reply = await executor.edit({
      label: 'c1', mission: 'MISSION', start: { [ALWAYS_ON]: 'start' },
      rollouts: [{ label: 'base1', ok: true, delivered: true }], candidates: [], decisions: { inv1: 'why inv1' },
    })
    expect(reply.tree).toEqual({ [ALWAYS_ON]: 'edited' })
    expect(reply.rejected).toEqual(['stray.txt'])
    executor.cleanup()
  })

  it('reports a child that did not complete as undelivered', async () => {
    const executor = executorWith({ ...hostThat(() => {}), startChild: () => Promise.resolve({ output: [], stopReason: 'error' }) })
    expect(await executor.rollout('base1', {})).toMatchObject({ ok: false, delivered: false, error: 'stopped: error' })
    executor.cleanup()
  })

  it('completes a whole sequential refinement on real files', async () => {
    const executor = executorWith(hostThat((cwd, prompt) => {
      if (prompt === 'Change data.txt') writeFileSync(join(cwd, 'data.txt'), 'changed\n')
      else writeFileSync(join(cwd, 'harness', ALWAYS_ON), 'Check the file after writing.\n')
    }))
    const result = await runSequential({ k: 1, domain: 'demo', base: {}, executor, width: 2, signal: new AbortController().signal })
    expect(result.ledger.rollouts).toEqual(['base1', 'inv1', 'dom1', 'c1'])
    expect(result.stages.every(stage => !stage.fellBack)).toBe(true)
    expect(result.rollouts.c1).toMatchObject({ ok: true, delivered: true })
    expect(result.trees.c1?.[ALWAYS_ON]).toBe('Check the file after writing.\n')
    executor.cleanup('c1')
  })
})
