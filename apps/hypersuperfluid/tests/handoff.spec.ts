import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { baselineOf, continuationPrompt, gitState, handoffNotice, pressureRatio, renderHandoff, shouldNotice } from '../src/handoff.ts'
import { careerOpsCandidates, careerOpsStatus, findCareerOps } from '../src/career.ts'
import { firecrawlEntry, firecrawlEnv } from '../src/firecrawl.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hsf-handoff-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const FACTS = { sessionId: 's-1', cwd: 'C:/work', time: '2026-11-06T10:00:00.000Z' }

describe('handoff', () => {
  it('keeps every section, marking empty ones instead of dropping them', () => {
    const text = renderHandoff({ goal: 'Ship the report.', status: 'Half done.', next_steps: '1. Finish charts.' }, { ...FACTS, preset: 'office', model: 'deepseek/deepseek-flash' })
    expect(text).toContain('## Goal and what the person asked for\n\nShip the report.')
    expect(text).toContain('## Decisions and why\n\n(none)')
    expect(text).toContain('## Next steps, in order\n\n1. Finish charts.')
    expect(text).toContain('- Mode: office')
    expect(text).toContain('- Model: deepseek/deepseek-flash')
  })

  it('records the repository state when there is one', () => {
    const text = renderHandoff({ goal: 'g', status: 's', next_steps: 'n' }, { ...FACTS, git: 'branch: main' })
    expect(text).toContain('## Repository state when written\n\n```text\nbranch: main\n```')
  })

  it('reads the context share only once both numbers are known', () => {
    expect(pressureRatio({})).toBeUndefined()
    expect(pressureRatio({ pressureTokens: 10 })).toBeUndefined()
    expect(pressureRatio({ pressureTokens: 700, contextWindow: 1000 })).toBe(0.7)
  })

  it('notices at the threshold, and a continued session only after it has grown', () => {
    expect(shouldNotice(0.69, 0.7, false, 0.02, 0.25)).toBe(false)
    expect(shouldNotice(0.7, 0.7, false, 0.02, 0.25)).toBe(true)
    // A continuation that starts near the threshold must not hand off at once, which would chain handoffs forever.
    expect(shouldNotice(0.72, 0.7, true, 0.68, 0.25)).toBe(false)
    expect(shouldNotice(0.93, 0.7, true, 0.68, 0.25)).toBe(true)
    expect(shouldNotice(0.9, 0, false, 0, 0.25)).toBe(false)
  })

  it('keeps the first share a session measured', () => {
    const baselines = new Map<string, number>()
    expect(baselineOf(baselines, 's', 0.05)).toBe(0.05)
    expect(baselineOf(baselines, 's', 0.4)).toBe(0.05)
  })

  it('tells the agent the share and to hand off before it fills', () => {
    const text = handoffNotice(0.72, 128_000)
    expect(text).toContain('72%')
    expect(text).toContain('128000-token')
    expect(text).toContain('`handoff` tool')
  })

  it('starts the next session on the whole handoff and where it is saved', () => {
    const text = continuationPrompt('# Handoff\n\nbody', 'C:/work/.hsf/handoffs/x.md', 's-1')
    expect(text).toContain('session s-1 handed off')
    expect(text).toContain('C:/work/.hsf/handoffs/x.md')
    expect(text.endsWith('# Handoff\n\nbody')).toBe(true)
  })

  it('describes a Git checkout and stays quiet outside one', () => {
    expect(gitState(dir)).toBeUndefined()
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
    writeFileSync(join(dir, 'a.txt'), 'x')
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '.'], { cwd: dir })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'first'], { cwd: dir })
    writeFileSync(join(dir, 'b.txt'), 'y')
    const state = gitState(dir)
    expect(state).toContain('branch: main')
    expect(state).toContain('first')
    expect(state).toContain('?? b.txt')
  })
})

describe('career', () => {
  const install = (root: string): void => {
    mkdirSync(join(root, 'modes'), { recursive: true })
    mkdirSync(join(root, '.agents', 'skills', 'career-ops'), { recursive: true })
    writeFileSync(join(root, 'AGENTS.md'), '# career-ops')
    writeFileSync(join(root, '.agents', 'skills', 'career-ops', 'SKILL.md'), '---\nname: career-ops\n---\n')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.39.0' }))
  }

  it('prefers the setting, then the environment, then the portable folder', () => {
    const candidates = careerOpsCandidates({ root: join(dir, 'a') }, { CAREER_OPS_INSTALL: join(dir, 'b'), HSF_PORTABLE_ROOT: join(dir, 'p') }, dir)
    expect(candidates.slice(0, 3)).toEqual([join(dir, 'a'), join(dir, 'b'), join(dir, 'p', 'career-ops')])
  })

  it('finds an install in a parent folder and ignores folders that only look like one', () => {
    mkdirSync(join(dir, 'career-ops'))
    writeFileSync(join(dir, 'career-ops', 'AGENTS.md'), '')
    expect(findCareerOps({ home: join(dir, 'home') }, {}, join(dir, 'deep', 'er'))).toBeUndefined()
    install(join(dir, 'career-ops'))
    expect(findCareerOps({ home: join(dir, 'home') }, {}, join(dir, 'deep', 'er'))).toBe(join(dir, 'career-ops'))
  })

  it('reports the first-run steps it still needs, and the data folder override', () => {
    const root = join(dir, 'career-ops')
    install(root)
    const fresh = careerOpsStatus(root, {})
    expect(fresh).toMatchObject({ installed: true, version: '1.39.0', dataRoot: root, dependenciesInstalled: false, hasCv: false })
    expect(fresh.next[0]).toContain('npm install')
    writeFileSync(join(root, '.career-ops-data'), '../mydata')
    expect(careerOpsStatus(root, {}).dataRoot).toBe(join(dir, 'mydata'))
    expect(careerOpsStatus(root, { CAREER_OPS_ROOT: join(dir, 'env') }).dataRoot).toBe(join(dir, 'env'))
    expect(careerOpsStatus(undefined).installed).toBe(false)
  })
})

describe('firecrawl', () => {
  it('passes the key only as a credential reference, and only when one is set', () => {
    expect(firecrawlEnv({}, true, {})).toMatchObject({ FIRECRAWL_API_KEY: '${credential:FIRECRAWL_API_KEY}' })
    expect(firecrawlEnv({}, false, {})).not.toHaveProperty('FIRECRAWL_API_KEY')
    expect(firecrawlEnv({}, false, { FIRECRAWL_API_URL: 'http://localhost:3002' })).toMatchObject({ FIRECRAWL_API_URL: 'http://localhost:3002' })
    expect(firecrawlEnv({ apiUrl: 'http://own' }, false, { FIRECRAWL_API_URL: 'http://env' }).FIRECRAWL_API_URL).toBe('http://own')
  })

  it('resolves the bundled server', () => {
    expect(firecrawlEntry()).toMatch(/firecrawl-mcp[\\/]dist[\\/]index\.js$/u)
  })
})
