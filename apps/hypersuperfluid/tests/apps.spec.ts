import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appOf, blankDocx, blankFile, blankXlsx, starterStoryboard, zip } from '../src/apps/blank.ts'
import { appFiles, newFilePath } from '../src/apps/index.ts'
import { parseStoryboard } from '../src/creative/storyboard.ts'
import { APP_CARDS, appsUrl, relativeFolder, whenText } from '../src/client/apps.ts'
import { currentSession, folderOf, type SessionRows } from '../src/client/apps-register.ts'
import { QUIET_ONBOARDING_STEPS, QUIET_PRIORITY } from '../src/client/quiet-start.ts'

/** Reads a stored or deflated zip's entries, enough to check what `zip` writes. */
function entries(archive: Buffer): Map<string, string> {
  const found = new Map<string, string>()
  let at = 0
  while (archive.readUInt32LE(at) === 0x04034b50) {
    const method = archive.readUInt16LE(at + 8)
    const size = archive.readUInt32LE(at + 18)
    const nameLength = archive.readUInt16LE(at + 26)
    const extra = archive.readUInt16LE(at + 28)
    const name = archive.subarray(at + 30, at + 30 + nameLength).toString('utf8')
    const data = archive.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + size)
    found.set(name, (method === 8 ? inflateRawSync(data) : data).toString('utf8'))
    at += 30 + nameLength + extra + size
  }
  expect(archive.readUInt32LE(archive.length - 22)).toBe(0x06054b50)
  return found
}

describe('blank files', () => {
  it('knows which app opens a file', () => {
    expect(appOf('Report.DOCX')).toBe('word')
    expect(appOf('budget.csv')).toBe('excel')
    expect(appOf('deck.pptx')).toBe('powerpoint')
    expect(appOf('ad.storyboard.json')).toBe('storyboard')
    expect(appOf('data.json')).toBeUndefined()
  })

  it('writes zips any reader can open', () => {
    const archive = zip([['a.txt', 'hello'], ['dir/b.xml', '<x/>']])
    expect([...entries(archive)]).toEqual([['a.txt', 'hello'], ['dir/b.xml', '<x/>']])
    expect(archive.readUInt16LE(archive.length - 22 + 10)).toBe(2)
  })

  it('makes an empty Word document and Excel workbook', () => {
    const docx = entries(blankDocx())
    expect([...docx.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/document.xml'])
    expect(docx.get('word/styles.xml')).toContain('w:styleId="Heading1"')
    expect(docx.get('word/document.xml')).toContain('<w:body>')
    const xlsx = entries(blankXlsx())
    expect(xlsx.get('xl/workbook.xml')).toContain('name="Sheet1"')
    expect(xlsx.get('[Content_Types].xml')).toContain('/xl/worksheets/sheet1.xml')
  })

  it('starts a storyboard the board and the agent can read', async () => {
    expect(parseStoryboard(starterStoryboard('Launch')).title).toBe('Launch')
    expect(parseStoryboard(JSON.parse((await blankFile('storyboard', 'Launch', '/nowhere')).toString('utf8'))).scenes).toHaveLength(1)
    await expect(blankFile('powerpoint', 'Deck', '/nowhere')).rejects.toThrow(/Office editors/u)
  })
})

describe('the apps folder', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hsf-apps-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('lists each app\'s files newest first, skipping hidden, build and frame folders', async () => {
    mkdirSync(join(dir, 'reports'))
    mkdirSync(join(dir, '.git'))
    mkdirSync(join(dir, 'node_modules'))
    mkdirSync(join(dir, 'ad.frames'))
    writeFileSync(join(dir, 'old.docx'), 'x')
    writeFileSync(join(dir, 'reports', 'q3.xlsx'), 'x')
    writeFileSync(join(dir, 'ad.storyboard.json'), '{}')
    writeFileSync(join(dir, '~$old.docx'), 'x')
    writeFileSync(join(dir, '.git', 'x.docx'), 'x')
    writeFileSync(join(dir, 'node_modules', 'y.pptx'), 'x')
    writeFileSync(join(dir, 'ad.frames', 's1.json'), 'x')
    writeFileSync(join(dir, 'notes.md'), 'x')
    utimesSync(join(dir, 'old.docx'), new Date(2020, 0, 1), new Date(2020, 0, 1))
    const files = await appFiles(dir, 3)
    expect(files.map(file => [file.name, file.app])).toEqual(expect.arrayContaining([['q3.xlsx', 'excel'], ['ad.storyboard.json', 'storyboard']]))
    expect(files).toHaveLength(3)
    expect(files.at(-1)?.name).toBe('old.docx')
    expect(await appFiles(dir, 0)).toHaveLength(2)
  })

  it('names new files safely and never over an existing one', () => {
    expect(newFilePath(dir, 'word', '  Q3 report  ')).toBe(join(dir, 'Q3 report.docx'))
    expect(newFilePath(dir, 'excel', 'a/b:c?.xlsx')).toBe(join(dir, 'a b c.xlsx'))
    expect(newFilePath(dir, 'powerpoint', '')).toBe(join(dir, 'Untitled PowerPoint.pptx'))
    expect(newFilePath(dir, 'storyboard', undefined)).toBe(join(dir, 'Storyboard.storyboard.json'))
    writeFileSync(join(dir, 'Plan.docx'), 'x')
    writeFileSync(join(dir, 'Plan (2).docx'), 'x')
    expect(newFilePath(dir, 'word', 'Plan')).toBe(join(dir, 'Plan (3).docx'))
  })
})

describe('the apps view', () => {
  it('lists the four apps and builds its routes', () => {
    expect(APP_CARDS.map(card => card.label)).toEqual(['Word', 'Excel', 'PowerPoint', 'Storyboard'])
    expect(appsUrl('http://127.0.0.1:7420/', 'new', { dir: 'C:\\w', app: 'word', name: 'A b' }))
      .toBe('http://127.0.0.1:7420/api/hsf/apps/new?dir=C%3A%5Cw&app=word&name=A+b')
  })

  it('shows where a file is and how old it is', () => {
    expect(relativeFolder('C:\\work\\', 'C:\\work\\reports\\q3.xlsx')).toBe('reports')
    expect(relativeFolder('/work', '/work/a.docx')).toBe('')
    const now = Date.UTC(2026, 10, 24, 12)
    expect(whenText(now - 20_000, now)).toBe('just now')
    expect(whenText(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(whenText(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(whenText(now - 30 * 3_600_000, now)).toBe('yesterday')
  })

  it('opens files from the page in the chat on screen, else the latest one, with its folder', () => {
    const list: SessionRows = {
      ids: ['a', 'b', 'c'],
      byId: {
        a: { updatedAt: 1, cwd: 'C:\\a' },
        b: { updatedAt: 5, cwd: 'C:\\b' },
        c: { updatedAt: 9, origin: 'subagent' },
      },
      projectionsBySession: { b: { values: { workingDirectory: 'C:\\b\\moved' } } },
    }
    expect(currentSession(list)).toBe('b')
    expect(folderOf(list, 'b')).toBe('C:\\b\\moved')
    expect(folderOf(list, 'a')).toBe('C:\\a')
    expect(currentSession({ ...list, byId: { ...list.byId, a: { updatedAt: 1, cwd: 'C:\\a', retainedBy: { mainView: 1 } } } })).toBe('a')
    expect(currentSession({ ids: [], byId: {} })).toBeUndefined()
  })
})

describe('no pop-ups at start', () => {
  it('shadows both first-run steps of DSH, which register at priority 0', () => {
    expect(QUIET_ONBOARDING_STEPS).toEqual(['welcome-notice', 'deepseek-official'])
    expect(QUIET_PRIORITY).toBeLessThan(0)
  })
})
