import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assetPath, EditorServer, editorKind, versionOf } from '../src/office-editor/server.ts'
import { hostPage } from '../src/office-editor/page.ts'
import { OFFICE_EDITOR_EXTENSIONS, officeEditorDefinition, openRouteUrl } from '../src/client/office-editor.ts'

let dir: string
let assets: string
let server: EditorServer
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hsf-office-'))
  assets = join(dir, 'assets')
  mkdirSync(join(assets, 'sdkjs'), { recursive: true })
  writeFileSync(join(assets, 'editor.html'), '<!doctype html><title>editor</title>')
  writeFileSync(join(assets, 'sdkjs', 'app.js'), 'console.log(1)')
  writeFileSync(join(assets, 'sw.js'), 'self.skipWaiting()')
  server = new EditorServer(assets)
})
afterEach(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Opens a document and returns helpers bound to its page address. */
async function open(name: string, data: string): Promise<{ path: string; url: URL; at: (route: string) => string }> {
  const path = join(dir, name)
  writeFileSync(path, data)
  const { url } = await server.openDocument(path, 'light')
  const page = new URL(url)
  const id = page.searchParams.get('doc') as string
  const token = page.searchParams.get('t') as string
  return { path, url: page, at: route => `${page.origin}/hsf/doc/${id}/${route}?t=${encodeURIComponent(token)}` }
}

describe('office editor server', () => {
  it('knows which files open in which editor', () => {
    expect(editorKind('C:\\Reports\\Q3.DOCX')).toBe('word')
    expect(editorKind('/data/sales.xlsx')).toBe('cell')
    expect(editorKind('/deck.pptx')).toBe('slide')
    expect(editorKind('/scan.pdf')).toBe('pdf')
    expect(editorKind('/notes.md')).toBeUndefined()
    expect(server.available).toBe(true)
  })

  it('serves the editor files and nothing outside their folder', async () => {
    const { url } = await open('a.docx', 'x')
    expect(await (await fetch(`${url.origin}/office`)).text()).toContain('<title>editor</title>')
    expect((await fetch(`${url.origin}/sw.js`)).status).toBe(404)
    expect((await fetch(`${url.origin}/sdkjs/app.js`)).headers.get('content-type')).toContain('javascript')
    expect(assetPath(assets, '/../a.docx')).toBeUndefined()
    expect(assetPath(`${assets}/`, '/editor.html')).toBe(join(assets, 'editor.html'))
    expect((await fetch(`${url.origin}/%2e%2e/a.docx`)).status).toBe(404)
  })

  it('gives the host page only with the right token', async () => {
    const { url } = await open('a.docx', 'x')
    expect((await fetch(url)).status).toBe(200)
    const wrong = new URL(url)
    wrong.searchParams.set('t', 'nope')
    expect((await fetch(wrong)).status).toBe(403)
  })

  it('loads the file and saves it back, refusing a save over a file that changed on disk', async () => {
    const { path, at } = await open('report.docx', 'original')
    const file = await fetch(at('file'))
    expect(await file.text()).toBe('original')
    expect((await fetch(at('save'), { method: 'POST', body: 'edited' })).status).toBe(200)
    expect(readFileSync(path, 'utf8')).toBe('edited')
    await new Promise(resolve => setTimeout(resolve, 20))
    writeFileSync(path, 'changed elsewhere, longer')
    expect((await fetch(at('save'), { method: 'POST', body: 'mine' })).status).toBe(409)
    expect(readFileSync(path, 'utf8')).toBe('changed elsewhere, longer')
  })

  it('hands a script to the page and returns what the page reports', async () => {
    const { path, at } = await open('sales.xlsx', 'x')
    const document = server.find(path)
    expect(document?.kind).toBe('cell')
    const result = server.run(document!, 'return Api.GetActiveSheet().GetRange("A1").GetValue()', 5_000)
    const next = await fetch(at('next'))
    const command = await next.json() as { id: string; script: string }
    expect(command.script).toContain('GetRange("A1")')
    await fetch(at('result'), { method: 'POST', body: JSON.stringify({ id: command.id, ok: true, value: 'Region' }) })
    expect(await result).toEqual({ ok: true, value: 'Region' })
  })

  it('tells the page the version on disk, so it can reload a file changed elsewhere', async () => {
    const { path, at } = await open('notes.docx', 'first')
    const loaded = (await fetch(at('file'))).headers.get('x-hsf-version')
    await new Promise(resolve => setTimeout(resolve, 20))
    writeFileSync(path, 'changed elsewhere')
    void server.run(server.find(path)!, 'return 1', 5_000)
    const polled = (await fetch(at('next'))).headers.get('x-hsf-version')
    expect(polled).toBe(await versionOf(path))
    expect(polled).not.toBe(loaded)
  })

  it('reports a script error and times out when no page answers', async () => {
    const { path, at } = await open('deck.pptx', 'x')
    const document = server.find(path)!
    const failing = server.run(document, 'throw new Error("no")', 5_000)
    const command = await (await fetch(at('next'))).json() as { id: string }
    await fetch(at('result'), { method: 'POST', body: JSON.stringify({ id: command.id, ok: false, error: 'no' }) })
    expect(await failing).toEqual({ ok: false, error: 'no' })
    expect(await server.run(document, 'return 1', 50)).toMatchObject({ ok: false })
  })

  it('writes a host page that loads the editor and carries the document', () => {
    const html = hostPage({ id: 'abc', token: 't<k', kind: 'word', name: 'a <b>.docx', theme: 'dark' })
    expect(html).toContain('src="/office?embed=1&amp;locale=en"')
    expect(html).toContain('a &lt;b&gt;.docx')
    expect(html).not.toContain('t<k')
  })
})

describe('office editor tab', () => {
  it('claims the Office and PDF files, leaving text and CSV to their own views', () => {
    expect(officeEditorDefinition.extensions).toEqual(OFFICE_EDITOR_EXTENSIONS)
    expect(OFFICE_EDITOR_EXTENSIONS).not.toContain('csv')
    expect(openRouteUrl('http://127.0.0.1:7420/', 'C:\\a b.docx', true))
      .toBe('http://127.0.0.1:7420/api/hsf/office/open?path=C%3A%5Ca+b.docx&theme=dark')
  })
})
