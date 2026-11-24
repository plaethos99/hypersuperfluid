import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { zip } from '../src/apps/blank.ts'
import { referencedCodebases, renderNote } from '../src/apps/context.ts'
import { fetchRepo, freeFolder, gitUrl, recentDownloads, sourceKind, unwrap } from '../src/repo/fetch.ts'
import { envNames, formatSurvey, isCodebase, readmeSetup, surveyRepo } from '../src/repo/survey.ts'
import { copyCodebase, isInside } from '../src/repo/tools.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hsf-repo-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function nodeProject(root: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: { dev: 'vite', build: 'vite build', test: 'vitest run', lint: 'eslint .' },
    dependencies: { react: '19' }, devDependencies: { vite: '7', typescript: '5' },
  }))
  writeFileSync(join(root, 'pnpm-lock.yaml'), '')
  writeFileSync(join(root, '.env.example'), '# keys\nOPENAI_API_KEY=sk-secret-example\nexport PORT=3000\n')
  writeFileSync(join(root, 'README.md'), '# App\n\nAbout it.\n\n## Getting started\n\nRun `pnpm install`.\n\n### Notes\n\nmore\n\n## License\n\nMIT\n')
}

describe('surveying a codebase', () => {
  it('reads a Node project: package manager, scripts, frameworks, settings names and setup', () => {
    nodeProject(dir)
    const survey = surveyRepo(dir)
    expect(survey.kinds).toEqual(['Node.js', 'React', 'Vite', 'TypeScript'])
    expect(survey.commands).toEqual({ install: 'pnpm install', build: 'pnpm build', test: 'pnpm test', run: 'pnpm dev', lint: 'pnpm lint' })
    expect(survey.envNames).toEqual(['OPENAI_API_KEY', 'PORT'])
    expect(survey.readmeSetup).toContain('pnpm install')
    expect(survey.readmeSetup).toContain('### Notes')
    expect(survey.readmeSetup).not.toContain('License')
    const text = formatSurvey(survey)
    expect(text).toContain('OPENAI_API_KEY')
    expect(text).not.toContain('sk-secret-example')
  })

  it('reads Python, Go and monorepos', () => {
    writeFileSync(join(dir, 'requirements.txt'), 'flask')
    writeFileSync(join(dir, 'app.py'), '')
    mkdirSync(join(dir, 'tests'))
    mkdirSync(join(dir, 'worker'))
    writeFileSync(join(dir, 'worker', 'go.mod'), 'module w')
    const survey = surveyRepo(dir)
    expect(survey.kinds).toEqual(['Python'])
    expect(survey.commands.install).toContain('requirements.txt')
    expect(survey.commands.run).toBe('python app.py')
    expect(survey.commands.test).toBe('python -m pytest')
    expect(survey.subprojects).toEqual(['worker'])
    expect(isCodebase(dir)).toBe(true)
    expect(isCodebase(join(dir, 'tests'))).toBe(false)
  })

  it('takes only names from env examples, and finds no setup section when there is none', () => {
    expect(envNames('A=1\n  B = 2\n#C=3\nnot a line\nA=4')).toEqual(['A', 'B'])
    expect(readmeSetup('# Title\n\nJust text.')).toBeUndefined()
  })
})

describe('getting a codebase', () => {
  it('knows git links from other links', () => {
    expect(gitUrl('https://github.com/santifer/career-ops')).toEqual({ url: 'https://github.com/santifer/career-ops.git', name: 'career-ops', owner: 'santifer', host: 'github.com' })
    expect(gitUrl('https://github.com/a/b/tree/main/src')?.name).toBe('b')
    expect(gitUrl('git@github.com:a/b.git')?.name).toBe('b')
    expect(gitUrl('https://example.com/a/b')).toBeUndefined()
    expect(gitUrl('https://example.com/a/b.git')?.name).toBe('b')
    expect(sourceKind('https://gitlab.com/a/b')).toBe('git')
    expect(sourceKind(dir)).toBe('folder')
    expect(sourceKind(join(dir, 'missing'))).toBeUndefined()
  })

  it('never overwrites, and unwraps an archive\'s single folder', () => {
    expect(freeFolder(dir, 'a:b')).toBe(join(dir, 'a-b'))
    mkdirSync(join(dir, 'repo'))
    expect(freeFolder(dir, 'repo')).toBe(join(dir, 'repo-2'))
    mkdirSync(join(dir, 'repo', 'repo-main'))
    expect(unwrap(join(dir, 'repo'))).toBe(join(dir, 'repo', 'repo-main'))
  })

  it('unpacks a downloaded zip into the working folder and leaves the zip alone', async () => {
    const archive = join(dir, 'tool-main.zip')
    writeFileSync(archive, zip([['tool-main/package.json', '{"scripts":{"test":"node t.js"}}'], ['tool-main/t.js', '']]))
    const work = join(dir, 'work')
    const fetched = await fetchRepo(archive, work)
    expect(fetched.kind).toBe('archive')
    expect(fetched.root).toBe(join(work, 'tool-main', 'tool-main'))
    expect(readFileSync(join(fetched.root, 'package.json'), 'utf8')).toContain('node t.js')
    expect(existsSync(archive)).toBe(true)
    expect((await fetchRepo(archive, work)).root).toBe(join(work, 'tool-main-2', 'tool-main'))
  })

  it('finds recent downloads: archives and codebase folders, one level down too', () => {
    writeFileSync(join(dir, 'a.zip'), '')
    nodeProject(join(dir, 'b'))
    nodeProject(join(dir, 'c-main', 'c-main'))
    mkdirSync(join(dir, 'photos'))
    writeFileSync(join(dir, 'notes.txt'), '')
    const found = recentDownloads(dir).map(item => [item.kind, item.path]).sort()
    expect(found).toEqual([['archive', join(dir, 'a.zip')], ['folder', join(dir, 'b')], ['folder', join(dir, 'c-main', 'c-main')]].sort())
  })

  it('copies a folder in without installs, and keeps the working folder from widening', async () => {
    nodeProject(join(dir, 'src-app'))
    mkdirSync(join(dir, 'src-app', 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(dir, 'src-app', 'node_modules', 'x', 'i.js'), '')
    const copy = await copyCodebase(join(dir, 'src-app'), join(dir, 'work'))
    expect(existsSync(join(copy, 'package.json'))).toBe(true)
    expect(existsSync(join(copy, 'node_modules'))).toBe(false)
    expect(isInside(join(dir, 'work'), copy)).toBe(true)
    expect(isInside(join(dir, 'work'), dir)).toBe(false)
    expect(isInside(join(dir, 'work'), join(dir, 'work-2'))).toBe(false)
  })
})

describe('the side panel note', () => {
  it('says what is open, what the folder is, and how to change each', () => {
    const note = renderNote({
      open: [{ path: 'C:\\w\\Report.docx', app: 'Word' }, { path: 'C:\\w\\ad.storyboard.json', app: 'Storyboard' }],
      folder: 'C:\\w', folderKind: 'a Node.js project (package.json)',
      folderFiles: [{ path: 'C:\\w\\Report.docx', name: 'Report.docx', app: 'word', modified: 2 }, { path: 'C:\\w\\q3.xlsx', name: 'q3.xlsx', app: 'excel', modified: 1 }],
      referenced: [],
    }) ?? ''
    expect(note).toContain('- Word: C:\\w\\Report.docx (change it with office_edit')
    expect(note).toContain('- Storyboard: C:\\w\\ad.storyboard.json (read the file, then storyboard_save')
    expect(note).toContain('Working folder: C:\\w, a Node.js project')
    expect(note).toContain('Other app files there: q3.xlsx (Excel)')
    expect(note).not.toContain('Report.docx (Word)')
  })

  it('says nothing when there is nothing to say', () => {
    expect(renderNote({ open: [], folder: 'C:\\empty', folderFiles: [], referenced: [] })).toBeUndefined()
  })

  it('finds the codebases, archives and git links a message points at', () => {
    nodeProject(join(dir, 'my app'))
    writeFileSync(join(dir, 'x.zip'), '')
    mkdirSync(join(dir, 'docs'))
    const text = `look at @"my app/" and ${join(dir, 'x.zip')} and @docs, then https://github.com/a/b. Also @missing`
    expect(referencedCodebases(text, dir)).toEqual([
      'https://github.com/a/b: a git repository (repo_fetch clones it)',
      `${join(dir, 'my app')}: a Node.js, React, Vite, TypeScript project (package.json)`,
      `${join(dir, 'docs')}: a folder`,
      `${join(dir, 'x.zip')}: an archive (repo_fetch unpacks it)`,
    ])
  })
})
