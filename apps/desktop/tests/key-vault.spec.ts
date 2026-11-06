import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { keyVaultPaths, openKeyVault, parseDotenv, sealKeys, unsealKeys, type VaultCipher } from '../src/key-vault.ts'

/** A reversible stand-in for safeStorage that also proves the vault never stores plain text. */
const fakeCipher = (available = true): VaultCipher => ({
  available: () => available,
  encrypt: plain => Buffer.from(Buffer.from(plain, 'utf8').map(byte => byte ^ 0x5a)),
  decrypt: data => Buffer.from(data.map(byte => byte ^ 0x5a)).toString('utf8'),
})

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hsf-vault-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const FAKE = `sk-${'f'.repeat(24)}`

describe('parseDotenv', () => {
  it('reads the usual dotenv forms and skips the rest', () => {
    const parsed = parseDotenv('﻿# keys\nexport A=1\nB = "two words"\nC=\'single\'\nD=plain # comment\nE="line\\nbreak"\nbad name=1\nF=\n')
    expect(Object.fromEntries(parsed)).toEqual({ A: '1', B: 'two words', C: 'single', D: 'plain', E: 'line\nbreak', F: '' })
  })
})

describe('openKeyVault', () => {
  it('imports dropped keys, deletes the files, and keeps them encrypted across starts', () => {
    const root = join(dir, 'portable')
    const paths = keyVaultPaths(join(dir, 'home'), root)
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, '.env'), `DEEPSEEK_API_KEY=${FAKE}\nFIRECRAWL_API_KEY=fc-1\n`)
    const first = openKeyVault(paths, fakeCipher())
    expect(first.env).toEqual({ DEEPSEEK_API_KEY: FAKE, FIRECRAWL_API_KEY: 'fc-1' })
    expect(first.report.imported).toEqual(['DEEPSEEK_API_KEY', 'FIRECRAWL_API_KEY'])
    expect(existsSync(join(root, '.env'))).toBe(false)
    expect(readFileSync(paths.vault).toString('utf8')).not.toContain(FAKE)
    expect(openKeyVault(paths, fakeCipher()).env).toEqual(first.env)
  })

  it('removes a key given with an empty value, and later files win', () => {
    const root = join(dir, 'p')
    mkdirSync(root, { recursive: true })
    const paths = keyVaultPaths(join(dir, 'home'), root)
    writeFileSync(join(root, 'keys.env'), 'A=1\nB=2\n')
    openKeyVault(paths, fakeCipher())
    writeFileSync(join(root, 'keys.env'), 'A=\n')
    writeFileSync(join(root, '.env'), 'B=3\n')
    const next = openKeyVault(paths, fakeCipher())
    expect(next.env).toEqual({ B: '3' })
    expect(next.report.removed).toEqual(['A'])
  })

  it('opens a sealed file from packaging and deletes it', () => {
    const root = join(dir, 'p')
    mkdirSync(root, { recursive: true })
    const sealed = sealKeys(`OPENROUTER_API_KEY=${FAKE}\n`)
    expect(sealed.toString('utf8')).not.toContain(FAKE)
    expect(unsealKeys(sealed)).toBe(`OPENROUTER_API_KEY=${FAKE}\n`)
    writeFileSync(join(root, 'keys.sealed'), sealed)
    const opened = openKeyVault(keyVaultPaths(join(dir, 'home'), root), fakeCipher())
    expect(opened.env).toEqual({ OPENROUTER_API_KEY: FAKE })
    expect(existsSync(join(root, 'keys.sealed'))).toBe(false)
  })

  it('leaves the file in place when there is no secure storage', () => {
    const root = join(dir, 'p')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, '.env'), 'A=1\n')
    const opened = openKeyVault(keyVaultPaths(join(dir, 'home'), root), fakeCipher(false))
    expect(opened.env).toEqual({ A: '1' })
    expect(existsSync(join(root, '.env'))).toBe(true)
    expect(opened.report.warnings[0]).toMatch(/no secure storage/u)
  })

  it('sets aside a vault it cannot open instead of failing', () => {
    const paths = keyVaultPaths(join(dir, 'home'), undefined)
    mkdirSync(join(dir, 'home', 'hsf'), { recursive: true })
    writeFileSync(paths.vault, 'not encrypted json')
    const opened = openKeyVault(paths, { ...fakeCipher(), decrypt: () => { throw new Error('other account') } })
    expect(opened.env).toEqual({})
    expect(existsSync(`${paths.vault}.unreadable`)).toBe(true)
  })
})
