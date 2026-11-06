import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { probeWorker, resolveCmdShim, resolveCommand } from '../src/workers.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hsf-workers-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** An npm-generated Windows shim, as `npm install -g` writes it. */
const NPM_SHIM = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & "%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode" %*\r\n'

describe('resolveCmdShim', () => {
  it('finds the script an npm shim runs, so it can start without a shell', () => {
    mkdirSync(join(dir, 'node_modules', 'opencode-ai', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'opencode-ai', 'bin', 'opencode'), '#!/usr/bin/env node\n')
    writeFileSync(join(dir, 'opencode.cmd'), NPM_SHIM)
    const resolved = resolveCmdShim(join(dir, 'opencode.cmd'))
    expect(resolved?.command).toBe(process.execPath)
    expect(resolved?.prefixArgs[0]).toBe(join(dir, 'node_modules', 'opencode-ai', 'bin', 'opencode'))
  })

  it('reports an unknown shim format rather than guessing', () => {
    writeFileSync(join(dir, 'tool.cmd'), '@echo off\r\nsomething %*\r\n')
    expect(resolveCmdShim(join(dir, 'tool.cmd'))).toBeUndefined()
  })
})

describe('resolveCommand', () => {
  it('reports a missing CLI as not installed', () => {
    expect(resolveCommand('definitely-not-a-real-cli-name')).toBeUndefined()
    expect(resolveCommand(join(dir, 'absent'))).toBeUndefined()
  })

  it('finds the current node by absolute path', () => {
    const withoutExtension = process.execPath.replace(/\.exe$/iu, '')
    expect(resolveCommand(withoutExtension)?.command).toBe(process.execPath)
  })
})

describe('probeWorker', () => {
  const fake = (body: string) => {
    const script = join(dir, 'fake.mjs')
    writeFileSync(script, body)
    return { id: 'fake', command: process.execPath.replace(/\.exe$/iu, ''), args: [script] }
  }

  it('reports not installed without starting anything', async () => {
    expect(await probeWorker({ id: 'x', command: 'definitely-not-a-real-cli-name', args: [] })).toMatchObject({ installed: false, responding: false })
  })

  it('reports ready when the server answers initialize, after any banner', async () => {
    const worker = fake('process.stdin.once(\'data\', () => { console.log(\'Welcome banner\'); console.log(JSON.stringify({ jsonrpc: \'2.0\', id: 1, result: { protocolVersion: 1 } })) }); setInterval(() => {}, 1000)')
    expect(await probeWorker(worker, 10_000)).toMatchObject({ installed: true, responding: true })
  })

  it('reports the refusal of a server that answers with an error', async () => {
    const worker = fake('process.stdin.once(\'data\', () => console.log(JSON.stringify({ jsonrpc: \'2.0\', id: 1, error: { message: \'login required\' } }))); setInterval(() => {}, 1000)')
    const status = await probeWorker(worker, 10_000)
    expect(status.responding).toBe(false)
    expect(status.detail).toContain('login required')
  })

  it('reports a server that exits or stays silent', async () => {
    expect((await probeWorker(fake('process.exit(3)'), 10_000)).detail).toContain('code 3')
    expect((await probeWorker(fake('setInterval(() => {}, 1000)'), 300)).detail).toMatch(/No ACP reply/u)
  })
})
