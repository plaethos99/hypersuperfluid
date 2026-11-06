/**
 * A minimal ZIP writer for job results: deflate entries, UTF-8 names, no ZIP64 (results stay well under 4 GiB and
 * 65,535 files, which the caller enforces). Written in-process so every platform produces the same archive without
 * `zip`, `tar` or PowerShell.
 * @module hypersuperfluid/portal/zip
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'

/** Files under a folder, relative to it, skipping symbolic links so an archive cannot reach outside the folder. */
export function listFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(root)
  return out.sort()
}

/** DOS date and time fields for a modification time. */
function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/**
 * Builds a ZIP of every regular file under a folder.
 * @param root - the folder.
 * @param limits - the most files and bytes to accept.
 * @returns the archive bytes.
 * @throws when the folder exceeds a limit.
 */
export function zipFolder(root: string, limits = { files: 20_000, bytes: 1024 * 1024 * 1024 }): Buffer {
  const files = listFiles(root)
  if (files.length > limits.files) throw new Error(`the folder has ${String(files.length)} files, more than ${String(limits.files)}`)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  let total = 0
  for (const name of files) {
    const path = join(root, ...name.split('/'))
    const data = readFileSync(path)
    total += data.length
    if (total > limits.bytes) throw new Error(`the folder holds more than ${String(limits.bytes)} bytes`)
    const compressed = deflateRawSync(data)
    const stored = compressed.length >= data.length
    const body = stored ? data : compressed
    const nameBytes = Buffer.from(name, 'utf8')
    const { time, date } = dosTime(statSync(path).mtime)
    const checksum = crc32(data) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(stored ? 0 : 8, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, body)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
