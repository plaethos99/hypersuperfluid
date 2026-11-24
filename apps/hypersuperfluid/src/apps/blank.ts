/**
 * Blank files for the Apps: an empty Word document and Excel workbook written as minimal Office Open XML, a
 * PowerPoint deck copied from the Office editor's own blank theme (a deck needs a master, a layout and a theme), and
 * a starter storyboard.
 * @module hypersuperfluid/apps/blank
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { formatStoryboard, type Storyboard } from '../creative/storyboard.ts'

/** The apps, and the file each makes. */
export const APPS = {
  word: { label: 'Word', extension: 'docx', extensions: ['docx', 'doc', 'odt', 'rtf'] },
  excel: { label: 'Excel', extension: 'xlsx', extensions: ['xlsx', 'xls', 'ods', 'csv'] },
  powerpoint: { label: 'PowerPoint', extension: 'pptx', extensions: ['pptx', 'ppt', 'odp'] },
  storyboard: { label: 'Storyboard', extension: 'storyboard.json', extensions: ['storyboard.json'] },
} as const

/** One of {@link APPS}. */
export type AppId = keyof typeof APPS

/** The app a file belongs to, or undefined. */
export function appOf(name: string): AppId | undefined {
  const lower = name.toLowerCase()
  if (lower.endsWith('.storyboard.json')) return 'storyboard'
  const extension = lower.slice(lower.lastIndexOf('.') + 1)
  for (const [id, app] of Object.entries(APPS) as [AppId, typeof APPS[AppId]][]) {
    if (id !== 'storyboard' && (app.extensions as readonly string[]).includes(extension)) return id
  }
  return undefined
}

/**
 * A zip archive of stored (uncompressed) entries, which every Office reader accepts.
 * @param files - entry names and their contents, in order.
 * @returns the archive.
 */
export function zip(files: ReadonlyArray<readonly [string, string | Buffer]>): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of files) {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt32LE(0x00210000, 10) // 1980-01-01 00:00
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt32LE(0x00210000, 12)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    parts.push(local, nameBytes, data)
    central.push(entry, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'

/** A heading style as Word names it: `Heading 1` has the id `Heading1`, so scripts and people find it by either. */
const heading = (id: string, name: string, size: number, level: number | undefined): string =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>`
  + `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/>${level === undefined ? '' : `<w:outlineLvl w:val="${String(level)}"/>`}</w:pPr>`
  + `<w:rPr><w:b/><w:sz w:val="${String(size)}"/></w:rPr></w:style>`

/** Normal, Title and Headings 1 to 3, so a blank document has the styles people and scripts ask for. */
const WORD_STYLES = `${XML}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
  + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>'
  + '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
  + heading('Title', 'Title', 56, undefined)
  + heading('Heading1', 'heading 1', 32, 0) + heading('Heading2', 'heading 2', 26, 1) + heading('Heading3', 'heading 3', 24, 2)
  + '</w:styles>'

/** An empty Word document. */
export function blankDocx(): Buffer {
  return zip([
    ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`],
    ['_rels/.rels', `${XML}<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="rId1" Type="${RELS}/officeDocument" Target="word/document.xml"/></Relationships>`],
    ['word/_rels/document.xml.rels', `${XML}<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="rId1" Type="${RELS}/styles" Target="styles.xml"/></Relationships>`],
    ['word/styles.xml', WORD_STYLES],
    ['word/document.xml', `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`],
  ])
}

/** An empty Excel workbook with one sheet. */
export function blankXlsx(): Buffer {
  return zip([
    ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ['_rels/.rels', `${XML}<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="rId1" Type="${RELS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${RELS}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="rId1" Type="${RELS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ['xl/worksheets/sheet1.xml', `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`],
  ])
}

/** Where the Office editor build keeps its blank deck. */
export function blankDeckPath(editorAssets: string): string {
  return join(editorAssets, 'sdkjs', 'slide', 'themes', 'src', '01_blank.pptx')
}

/** A starter storyboard: one scene to replace, so the board opens and the agent fills it from chat. */
export function starterStoryboard(title: string): Storyboard {
  return {
    version: 1, title, aspect: '16:9',
    scenes: [{
      id: 's1', title: 'Opening',
      start: { prompt: 'The opening shot: ask in chat for the story and the scenes will be written here' },
      end: { prompt: 'The same shot a moment later' },
    }],
  }
}

/**
 * The bytes of a new file for an app.
 * @param app - which app.
 * @param title - the file's title, for a storyboard.
 * @param editorAssets - the Office editor build, for a deck.
 * @returns the bytes.
 */
export async function blankFile(app: AppId, title: string, editorAssets: string): Promise<Buffer> {
  switch (app) {
    case 'word': return blankDocx()
    case 'excel': return blankXlsx()
    case 'powerpoint': {
      const deck = blankDeckPath(editorAssets)
      if (!existsSync(deck)) throw new Error('New PowerPoint decks need the Office editors, which are not part of this build.')
      return readFile(deck)
    }
    case 'storyboard': return Buffer.from(formatStoryboard(starterStoryboard(title)), 'utf8')
  }
}
