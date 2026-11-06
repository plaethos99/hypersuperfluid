import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allowed } from '../src/allowlist.ts'
import { guestPage } from '../src/portal/page.ts'
import { LinkStore, safeJoin } from '../src/portal/store.ts'
import { tunnelUrlIn } from '../src/portal/tunnel.ts'
import { listFiles, zipFolder } from '../src/portal/zip.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hsf-portal-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('safeJoin', () => {
  it('keeps folder uploads inside their folder', () => {
    expect(safeJoin(dir, 'src/app.py')).toBe(join(dir, 'src', 'app.py'))
    expect(safeJoin(dir, 'src\\win\\a.txt')).toBe(join(dir, 'src', 'win', 'a.txt'))
  })

  it('treats a leading slash as relative to the folder', () => {
    expect(safeJoin(dir, '/etc/passwd')).toBe(join(dir, 'etc', 'passwd'))
  })

  it.each(['../x', 'a/../../x', 'C:/Windows/system32/x', '', 'a//b'])('refuses %j', (path) => {
    expect(() => safeJoin(dir, path)).toThrow(/refused/u)
  })
})

describe('LinkStore', () => {
  it('opens a link only with its token, and keeps only the hash on disk', () => {
    const store = new LinkStore(dir)
    const { link, token } = store.create('ask', 'Help', 24)
    expect(store.byToken(token)?.id).toBe(link.id)
    expect(store.byToken(`${token}x`)).toBeUndefined()
    const reloaded = new LinkStore(dir)
    expect(reloaded.byToken(token)?.id).toBe(link.id)
    expect(JSON.stringify(reloaded.all())).not.toContain(token)
  })

  it('stops working after it expires or is stopped', () => {
    const store = new LinkStore(dir)
    const { link } = store.create('agent', 'Job', 1, Date.parse('2026-01-01T00:00:00Z'))
    expect(store.active(link, Date.parse('2026-01-01T00:30:00Z'))).toBe(true)
    expect(store.active(link, Date.parse('2026-01-01T01:00:01Z'))).toBe(false)
    link.stopped = true
    expect(store.active(link, Date.parse('2026-01-01T00:30:00Z'))).toBe(false)
  })

  it('finds the link behind a session and a job', () => {
    const store = new LinkStore(dir)
    const { link } = store.create('agent', 'Job', 1)
    link.jobs.push({ id: 'j1', task: 't', status: 'running', createdAt: '', updatedAt: '', files: 0, bytes: 0, sessionId: 's-job' })
    expect(store.bySession('s-job')?.job?.id).toBe('j1')
    expect(store.bySession('nope')).toBeUndefined()
  })
})

describe('zipFolder', () => {
  it('writes an archive that a standard reader opens, with nested paths and Unicode names', () => {
    const root = join(dir, 'work')
    mkdirSync(join(root, 'src', 'deep'), { recursive: true })
    writeFileSync(join(root, 'README.md'), '# hello\n'.repeat(200))
    writeFileSync(join(root, 'src', 'deep', 'données.txt'), 'x')
    writeFileSync(join(root, 'empty.bin'), Buffer.alloc(0))
    expect(listFiles(root)).toEqual(['README.md', 'empty.bin', 'src/deep/données.txt'])
    const zip = join(dir, 'out.zip')
    writeFileSync(zip, zipFolder(root))
    const python = process.platform === 'win32' ? 'python' : 'python3'
    const listing = execFileSync(python, ['-c', 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("\\n".join(sorted(z.namelist())))', zip], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    expect(listing.trim().split(/\r?\n/u)).toEqual(['README.md', 'empty.bin', 'src/deep/données.txt'])
  })

  it('refuses a folder over its limits', () => {
    writeFileSync(join(dir, 'a.txt'), 'abc')
    expect(() => zipFolder(dir, { files: 10, bytes: 2 })).toThrow(/bytes/u)
    expect(() => zipFolder(dir, { files: 0, bytes: 100 })).toThrow(/files/u)
  })
})

describe('tunnel addresses', () => {
  it('reads cloudflared and ngrok output', () => {
    expect(tunnelUrlIn('cloudflared', 'INF |  https://brave-otter-12.trycloudflare.com  |')).toBe('https://brave-otter-12.trycloudflare.com')
    expect(tunnelUrlIn('ngrok', '{"msg":"started tunnel","url":"https://abc.ngrok-free.app"}')).toBe('https://abc.ngrok-free.app')
    expect(tunnelUrlIn('cloudflared', 'starting...')).toBeUndefined()
  })
})

describe('guide mode allowlist', () => {
  it('lets only listed tools through', () => {
    const list = ['skill', 'web_search', 'web_fetch', 'todo_write']
    expect(allowed(list, 'web_search')).toBe(true)
    expect(allowed(list, 'pwsh')).toBe(false)
    expect(allowed(list, 'mcp__erp__odoo_search_read')).toBe(false)
    expect(allowed(list, 'portal_share')).toBe(false)
  })
})

describe('guest page', () => {
  it('escapes the title and puts the nonce on its only script and style', () => {
    const html = guestPage('ask', '<img src=x onerror=alert(1)>', 'NONCE123')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html.match(/<script/gu)?.length).toBe(1)
    expect(html).toContain('<script nonce="NONCE123">')
    expect(html).toContain('<style nonce="NONCE123">')
  })

  it('offers a folder picker only on agent links', () => {
    expect(guestPage('agent', 't', 'n')).toContain('webkitdirectory')
    expect(guestPage('ask', 't', 'n')).not.toContain('webkitdirectory')
  })
})
