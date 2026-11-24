/**
 * `side_panel`: what the person has open in the side panel's apps right now (Word, Excel, PowerPoint and PDF files in
 * the Office editor, and storyboards on their board), so a request in chat such as "make the title bigger" or "add a
 * scene at night" goes to the file they are looking at. It reads the Office editor and Creative services when those
 * plugins are loaded.
 * @module hypersuperfluid/apps/tools
 */

import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '../office-editor/index.ts'
import type {} from '../creative/index.ts'

/** Cordis plugin name. */
export const name = 'hsf-apps-tools'
/** Services this plugin needs. */
export const inject = ['tools']

/** One open app file as the agent sees it. */
export interface OpenAppFile {
  readonly path: string
  readonly name: string
  readonly app: 'word' | 'excel' | 'powerpoint' | 'pdf' | 'storyboard'
  readonly change: string
}

const OFFICE_APP = { word: 'word', cell: 'excel', slide: 'powerpoint', pdf: 'pdf' } as const

/** What the agent is told. */
export const SIDE_PANEL_DESCRIPTION = [
  'List the files the person has open in the side panel\'s apps right now: Word, Excel, PowerPoint and PDF files in the Office editor,',
  'and storyboards on their board. Call it first when the person asks for a change without naming a file ("make the title bold",',
  '"add a scene"): the file open there is the one they mean. Each entry says how to change it.',
].join(' ')

/**
 * @param ctx - the agent's composition.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'side_panel',
    description: SIDE_PANEL_DESCRIPTION,
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => {
      const open: OpenAppFile[] = []
      for (const document of ctx.get('hsfOfficeEditor')?.open() ?? []) {
        open.push({ path: document.path, name: basename(document.path), app: OFFICE_APP[document.kind], change: 'office_edit (the person sees the change at once; it saves itself)' })
      }
      for (const path of ctx.get('hsfCreative')?.openBoards() ?? []) {
        open.push({ path, name: basename(path), app: 'storyboard', change: 'read the file, then storyboard_save it whole with the same scene ids' })
      }
      if (open.length === 0) {
        return Promise.resolve('Nothing is open in the side panel\'s apps. The person opens an app from Apps in the sidebar (or a file from the files pane). Ask which file they mean, or make a new one.')
      }
      return Promise.resolve(JSON.stringify(open, null, 2))
    },
  })), 'hsf-apps: side_panel tool')
}
