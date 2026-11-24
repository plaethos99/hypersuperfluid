/**
 * The Office tools for the modes that edit documents (Master operator and Office): `office_documents` lists the files
 * open in the app's Office editor, and `office_edit` runs Office JavaScript in one of them. They use the editor server
 * the host-level `hsf-office-editor` plugin provides.
 * @module hypersuperfluid/office-editor/tools
 */

import { basename, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from './index.ts'
import { EDITOR_EXTENSIONS, type OpenDocument } from './server.ts'

/** Cordis plugin name. */
export const name = 'hsf-office-edit-tools'
/** Services this plugin needs. */
export const inject = ['tools', 'hsfOfficeEditor']

/** Settings. */
export interface Config {
  /** How long an `office_edit` script may take, in seconds. */
  timeoutSeconds?: number
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  timeoutSeconds: z.natural().default(60),
})

/** What the agent is told about writing scripts. */
export const OFFICE_EDIT_DESCRIPTION = [
  'Change or read a Word, Excel, PowerPoint or PDF file that is open in the app\'s Office editor, as the person watches.',
  'The script is the body of a function in ONLYOFFICE\'s Office JavaScript API (the API of its macros and plugins), with the global `Api`.',
  'Word: `var doc = Api.GetDocument()`; `Api.CreateParagraph()`, `p.AddText(…)` (returns a run: `.SetBold(true)`), `doc.Push(p)` to append at the end (never `doc.InsertContent` to append: it inserts at the cursor, which is the top of a new file; in an empty document fill `doc.GetElement(0)` first, then Push the rest), `doc.GetElement(i)`, `doc.GetElementsCount()`, `doc.SearchAndReplace({searchString, replaceString})`, `Api.CreateTable(cols, rows)`, `range.SetBold(true)`.',
  'Excel: `var sheet = Api.GetActiveSheet()`; `sheet.GetRange("A1:C3").SetValue(…)`, `.GetValue()`, `.SetFormula("=SUM(A1:A9)")`, `.SetFillColor(Api.CreateColorFromRGB(…))`, `Api.AddSheet(name)`, `sheet.AddChart(…)`.',
  'PowerPoint: `var pres = Api.GetPresentation()`; `Api.CreateSlide()`, `pres.AddSlide(slide)`, `pres.GetSlideByIndex(i)`, `Api.CreateShape(…)`, `shape.GetDocContent()` for its text.',
  '`return` a JSON value to read the document (for example its paragraphs\' text or a range\'s values); read before you change. A thrown error comes back as the result. To check a change, read it back with another script: the person sees it at once, so there is no need to reopen the file.',
  'The change can be undone in the editor, and it is saved to the file automatically.',
  'If the file is not open, ask the person to open it (click it in the files pane or a file card); office_documents lists what is open.',
].join(' ')

/** How the agent sees an open document. */
export function describeDocument(document: OpenDocument): Record<string, unknown> {
  return { path: document.path, name: basename(document.path), editor: document.kind, openSince: new Date(document.openedAt).toISOString() }
}

/**
 * @param ctx - the agent's composition.
 * @param config - settings.
 */
export function apply(ctx: Context, config: Config): void {
  const server = ctx.hsfOfficeEditor
  const cwdOf = (agent: { session: never } | undefined): string =>
    (agent === undefined ? undefined : ctx.get('workingDirectory')?.get(agent.session)) ?? process.cwd()
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'office_documents',
    description: 'List the Word, Excel, PowerPoint and PDF files open in the app\'s Office editor right now, which office_edit can change.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => {
      const open = server.open()
      if (open.length === 0) return Promise.resolve('No document is open in the Office editor. The person opens one by clicking a .docx, .xlsx, .pptx or .pdf file in the files pane or a file card.')
      return Promise.resolve(JSON.stringify(open.map(describeDocument), null, 2))
    },
  })), 'hsf-office-editor: office_documents tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'office_edit',
    description: OFFICE_EDIT_DESCRIPTION,
    parameters: {
      path: { type: 'string', required: true, description: `The open file, absolute or relative to the working folder (${EDITOR_EXTENSIONS.map(extension => `.${extension}`).join(' ')}).` },
      script: { type: 'string', required: true, description: 'Office JavaScript: the body of a function using `Api`; `return` a JSON value to read.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const path = isAbsolute(args.path) ? args.path : resolve(cwdOf(exec.agent as never), args.path)
      const document = server.find(path)
      if (document === undefined) {
        throw new Error(`${basename(path)} is not open in the Office editor. Ask the person to open it (click it in the files pane or a file card), then try again.`)
      }
      const result = await server.run(document, args.script, (config.timeoutSeconds ?? 60) * 1000, exec.signal)
      if (!result.ok) throw new Error(result.error)
      return JSON.stringify({ result: result.value ?? null, note: 'Applied in the open editor; it saves to the file automatically.' })
    },
  })), 'hsf-office-editor: office_edit tool')
}
