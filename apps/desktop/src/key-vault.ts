/**
 * Hypersuperfluid key vault: API keys dropped into the portable folder are encrypted at first start and the plain
 * files are deleted, so the keys never sit on disk in readable form and never appear in Settings or to the agent's
 * file tools. They are decrypted only in memory and handed to the Host process, whose tools already drop every
 * credential-shaped variable (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`) from the commands they run.
 *
 * Sources, imported in this order and then deleted:
 * - `keys.sealed` beside the app, written at packaging time by `apps/hypersuperfluid/portable/assemble.mjs --keys`, so a
 *   distributed zip carries no plain-text key. Its key is part of the app, so it stops casual reading, not a determined
 *   person with the app.
 * - `keys.env` or `.env` beside the app, in dotenv syntax. `NAME=` with no value removes a key from the vault.
 *
 * The vault itself is encrypted with Electron's `safeStorage`: Windows DPAPI for the signed-in user, the macOS
 * Keychain, or the Linux secret service. A vault copied to another computer or user cannot be opened there; it is set
 * aside as `keys.vault.unreadable`, and the keys are dropped in again.
 * @module desktop/key-vault
 */

import { createDecipheriv, createCipheriv, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The encryption the vault uses; Electron's `safeStorage` in the app, a fake in tests. */
export interface VaultCipher {
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

/** Where the vault and the dropped files are. */
export interface KeyVaultPaths {
  /** The encrypted vault. */
  readonly vault: string
  /** Plain-text files to import and delete, in order. */
  readonly drops: readonly string[]
  /** The packaging-time sealed file, imported and deleted first. */
  readonly sealed?: string
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Reads dotenv text: `NAME=value`, optional `export `, `#` comments, single or double quotes, and `\n` escapes in
 * double quotes. Invalid names are skipped.
 * @param text - the file's text.
 * @returns the entries in file order; an empty value means "remove".
 */
export function parseDotenv(text: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line)
    if (match === null) continue
    const name = match[1] as string
    if (!NAME.test(name)) continue
    let value = (match[2] as string).trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"')
    } else if (value.startsWith('\'') && value.endsWith('\'') && value.length >= 2) {
      value = value.slice(1, -1)
    } else {
      value = value.replace(/\s+#.*$/, '')
    }
    entries.set(name, value)
  }
  return entries
}

// The sealed format only keeps keys out of plain sight inside a distributed zip; its passphrase ships with the app.
const SEAL_PASSPHRASE = 'hypersuperfluid/keys.sealed/v1'

/**
 * Seals dotenv text for distribution (AES-256-GCM under a key the app knows).
 * @param text - the dotenv text.
 * @returns the sealed file's bytes.
 */
export function sealKeys(text: string): Buffer {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', scryptSync(SEAL_PASSPHRASE, salt, 32), iv)
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return Buffer.from(JSON.stringify({ v: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }))
}

/**
 * Opens a sealed file.
 * @param bytes - the sealed file's bytes.
 * @returns the dotenv text.
 * @throws when the file is not a sealed key file or was altered.
 */
export function unsealKeys(bytes: Buffer): string {
  const sealed = JSON.parse(bytes.toString('utf8')) as { v: number; salt: string; iv: string; tag: string; data: string }
  if (sealed.v !== 1) throw new Error(`unknown sealed key format ${String(sealed.v)}`)
  const decipher = createDecipheriv('aes-256-gcm', scryptSync(SEAL_PASSPHRASE, Buffer.from(sealed.salt, 'base64'), 32), Buffer.from(sealed.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8')
}

/** Overwrites a file with zeros before deleting it, so its plain text does not stay in the same disk blocks. */
export function shred(path: string): void {
  try {
    writeFileSync(path, Buffer.alloc(statSync(path).size))
  } finally {
    rmSync(path, { force: true })
  }
}

/** What opening the vault did, for the log; it never holds values. */
export interface KeyVaultReport {
  readonly keys: readonly string[]
  readonly imported: readonly string[]
  readonly removed: readonly string[]
  readonly warnings: readonly string[]
}

/**
 * Imports dropped keys into the vault, deletes the dropped files, and returns every key for the Host's environment.
 * @param paths - the vault and the dropped files.
 * @param cipher - the vault's encryption.
 * @returns the environment entries and a report without values.
 */
export function openKeyVault(paths: KeyVaultPaths, cipher: VaultCipher): { env: Record<string, string>; report: KeyVaultReport } {
  const warnings: string[] = []
  const keys = new Map<string, string>()
  const available = cipher.available()

  if (available && existsSync(paths.vault)) {
    try {
      for (const [name, value] of Object.entries(JSON.parse(cipher.decrypt(readFileSync(paths.vault))) as Record<string, string>)) {
        if (NAME.test(name) && typeof value === 'string') keys.set(name, value)
      }
    } catch (error) {
      const aside = `${paths.vault}.unreadable`
      renameSync(paths.vault, aside)
      warnings.push(`The key vault could not be opened on this computer or account (${String(error)}); it was moved to ${aside}. Drop the keys file in again.`)
    }
  }

  const sources: Array<{ path: string; text: () => string }> = []
  const sealed = paths.sealed
  if (sealed !== undefined && existsSync(sealed)) sources.push({ path: sealed, text: () => unsealKeys(readFileSync(sealed)) })
  for (const drop of paths.drops) if (existsSync(drop)) sources.push({ path: drop, text: () => readFileSync(drop, 'utf8') })

  const imported: string[] = []
  const removed: string[] = []
  const consumed: string[] = []
  for (const source of sources) {
    let entries: Map<string, string>
    try {
      entries = parseDotenv(source.text())
    } catch (error) {
      warnings.push(`${source.path} could not be read and was left in place: ${String(error)}`)
      continue
    }
    for (const [name, value] of entries) {
      if (value === '') {
        if (keys.delete(name)) removed.push(name)
      } else {
        keys.set(name, value)
        imported.push(name)
      }
    }
    consumed.push(source.path)
  }

  if (consumed.length > 0) {
    if (available) {
      mkdirSync(dirname(paths.vault), { recursive: true })
      const temp = `${paths.vault}.tmp`
      writeFileSync(temp, cipher.encrypt(JSON.stringify(Object.fromEntries(keys))))
      renameSync(temp, paths.vault)
      for (const path of consumed) shred(path)
    } else {
      warnings.push('This system offers no secure storage, so the keys were used from the dropped file this time and the file was left in place.')
    }
  }

  return {
    env: Object.fromEntries(keys),
    report: { keys: [...keys.keys()].sort(), imported: [...new Set(imported)].sort(), removed: [...new Set(removed)].sort(), warnings },
  }
}

/**
 * The vault's standard locations: the vault under `<DSH_HOME>/hsf`, and the dropped files beside the portable app.
 * @param dshHome - the Harness home.
 * @param portableRoot - the portable folder, from `HSF_PORTABLE_ROOT`.
 * @returns the paths.
 */
export function keyVaultPaths(dshHome: string, portableRoot: string | undefined): KeyVaultPaths {
  const drops = portableRoot === undefined || portableRoot === '' ? [] : [join(portableRoot, 'keys.env'), join(portableRoot, '.env')]
  return {
    vault: join(dshHome, 'hsf', 'keys.vault'),
    drops,
    ...portableRoot === undefined || portableRoot === '' ? {} : { sealed: join(portableRoot, 'keys.sealed') },
  }
}
