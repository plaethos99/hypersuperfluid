/**
 * The Office editor tab: clicking a Word, Excel, PowerPoint or PDF file opens it in ONLYOFFICE's editor with its
 * ribbon, instead of a read-only preview. The host serves the editor (`src/office-editor/`); this body asks for an
 * editor page through the owner-only route `/api/hsf/office/open` and frames it. DSH's own Office, spreadsheet and
 * PDF previews stay in the tab's viewer menu.
 * @module hypersuperfluid/client/office-editor
 */

import { createElement as h, useEffect, useState, type ReactNode } from 'react'
import type { DocumentPreviewDefinition, DocumentPreviewProps } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'

/** Renderer identity, shared by the definition and its keyed body. */
export const OFFICE_EDITOR_ID = '@deepseek-ai/dsh-hypersuperfluid/office-editor'

/** The files that open in an editor. Plain text and CSV keep DSH's text and table views. */
export const OFFICE_EDITOR_EXTENSIONS = ['docx', 'doc', 'odt', 'rtf', 'xlsx', 'xls', 'ods', 'pptx', 'ppt', 'odp', 'pdf'] as const

/** The preview definition. */
export const officeEditorDefinition: DocumentPreviewDefinition = {
  id: OFFICE_EDITOR_ID,
  extensions: OFFICE_EDITOR_EXTENSIONS,
  binaryExtensions: OFFICE_EDITOR_EXTENSIONS,
  priority: 'extension',
  title: () => 'Office editor',
  loading: 'renderer',
  wrap: false,
}

/**
 * The address of the route that opens a file in an editor.
 * @param base - the document base URI.
 * @param path - the file's absolute path.
 * @param dark - whether the app is in dark mode.
 * @returns the route's URL.
 */
export function openRouteUrl(base: string, path: string, dark: boolean): string {
  return new URL(`api/hsf/office/open?${new URLSearchParams({ path, theme: dark ? 'dark' : 'light' }).toString()}`, base).href
}

type EditorState = { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'failed'; message: string }

const MESSAGE = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: 24, boxSizing: 'border-box',
  textAlign: 'center', color: 'var(--dsw-alias-label-secondary)',
} as const

/**
 * The editor body.
 * @param props - the standard document props.
 * @returns the framed editor, or a message.
 */
export function OfficeEditorBody(props: DocumentPreviewProps): ReactNode {
  const { content, resourceAddress, useResource } = props
  const file = useResource<'file'>(resourceAddress).value
  const path = file?.absolutePath
  const revision = content.kind === 'renderer' ? content.revision : 0
  const [state, setState] = useState<EditorState>({ kind: 'loading' })

  // The editor opens once per file. Its own saves change the file, which makes the tab reload; reopening then would
  // lose the editor's undo history, so a reload only confirms the version. The editor page itself reloads the file
  // when something else changes it.
  useEffect(() => {
    if (path === undefined) return undefined
    const controller = new AbortController()
    setState({ kind: 'loading' })
    const dark = document.body.hasAttribute('data-ds-dark-theme')
    fetch(openRouteUrl(document.baseURI, path, dark), { signal: controller.signal, credentials: 'same-origin' })
      .then(async (response) => {
        const body = await response.json() as { url?: string; error?: string }
        if (!response.ok || body.url === undefined) throw new Error(body.error ?? `The editor could not open (${String(response.status)}).`)
        setState({ kind: 'ready', url: body.url })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
      })
    return () => { controller.abort() }
  }, [path])

  const version = file?.version
  useEffect(() => {
    if (content.kind !== 'renderer' || version === undefined) return
    if (state.kind === 'ready') content.loaded(version)
    else if (state.kind === 'failed') content.failed()
    // `content` changes identity on every render; the revision, version and state are what matter.
  }, [revision, version, state.kind])

  if (content.kind !== 'renderer') return null
  if (state.kind === 'loading') return h('div', { style: MESSAGE }, 'Opening the editor…')
  if (state.kind === 'failed') {
    return h('div', { style: MESSAGE }, `${state.message} You can still pick another viewer from the menu above.`)
  }
  return h('iframe', {
    src: state.url, title: 'Office editor', allow: 'clipboard-read; clipboard-write',
    style: { width: '100%', height: '100%', border: 0, display: 'block' },
  })
}
