/**
 * The storyboard board: a `*.storyboard.json` file shown as scene cards, each with its start and end frame. Proceed
 * draws the frames still missing in the person's Google Flow or Grok Imagine window; the host writes each picture and
 * its progress into the file, so the board updates as the file changes. The buttons call the host's owner-only
 * routes under `/api/hsf/creative/` (`src/creative/index.ts`).
 * @module hypersuperfluid/client/storyboard
 */

import { createElement as h, useCallback, useEffect, useState, type ReactNode } from 'react'
import type { DocumentPreviewDefinition, DocumentPreviewProps } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { UNREADABLE_STYLE, unreadableMessage } from './unreadable.ts'
import { fileMediaUrl } from '@deepseek-ai/dsh-util-workspace-path'

/** Renderer identity, shared by the definition and its keyed body. */
export const STORYBOARD_ID = '@deepseek-ai/dsh-hypersuperfluid/storyboard'

/** The preview definition: the compound suffix wins over DSH's JSON view, which stays in the viewer menu. */
export const storyboardDefinition: DocumentPreviewDefinition = {
  id: STORYBOARD_ID,
  extensions: ['storyboard.json'],
  priority: 'extension',
  title: () => 'Storyboard',
  loading: 'renderer',
  wrap: false,
}

/** A frame as the board reads it. */
export interface BoardFrame { prompt: string; image?: string; status?: string; error?: string; source?: string }
/** A scene as the board reads it. */
export interface BoardScene { id: string; title: string; action?: string; seconds?: number; start: BoardFrame; end: BoardFrame }
/** The file as the board reads it. */
export interface Board { title: string; aspect: string; style?: string; scenes: BoardScene[] }
/** The host's answer about the services and the run. */
export interface CreativeStatus {
  flow: 'closed' | 'signin' | 'ready'
  grok: 'closed' | 'signin' | 'ready'
  run: { total: number; done: number; failed: number; current?: string; note?: string; finished: boolean; error?: string } | null
}

/**
 * A route's address.
 * @param base - the document base URI.
 * @param route - the route below `api/hsf/creative/`.
 * @param query - its parameters.
 * @returns the URL.
 */
export function creativeUrl(base: string, route: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, value)
  return new URL(`api/hsf/creative/${route}?${params.toString()}`, base).href
}

/**
 * A frame picture's absolute path: the storyboard's folder plus the frame's relative path, with the storyboard's
 * own separator.
 */
export function framePath(storyboardPath: string, image: string): string {
  const separator = storyboardPath.includes('\\') && !storyboardPath.includes('/') ? '\\' : '/'
  const cut = Math.max(storyboardPath.lastIndexOf('/'), storyboardPath.lastIndexOf('\\'))
  return `${storyboardPath.slice(0, cut)}${separator}${image.split('/').join(separator)}`
}

/** CSS aspect-ratio for a storyboard aspect such as 16:9. */
export function aspectRatio(aspect: string): string {
  const [width, height] = aspect.split(':')
  return width !== undefined && height !== undefined ? `${width} / ${height}` : '16 / 9'
}

/** Frames drawn and frames in the board. */
export function progressOf(board: Board): { drawn: number; total: number } {
  let drawn = 0
  for (const scene of board.scenes) for (const frame of [scene.start, scene.end]) if (frame.status === 'done' && frame.image !== undefined) drawn++
  return { drawn, total: board.scenes.length * 2 }
}

const SERVICE_TEXT = { closed: 'not open', signin: 'sign in and open a project', ready: 'ready' } as const
const GROK_TEXT = { closed: 'not open', signin: 'sign in', ready: 'ready' } as const

const STYLE = `
.hsf-sb{height:100%;overflow:auto;padding:14px;box-sizing:border-box;font:13px/1.45 system-ui,'Segoe UI',sans-serif;color:var(--dsw-alias-label-primary)}
.hsf-sb-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-bottom:10px}
.hsf-sb-title{font-size:16px;font-weight:600;margin-right:auto}
.hsf-sb-meta{color:var(--dsw-alias-label-secondary);font-size:12px}
.hsf-sb-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:12px;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-fill-secondary, rgba(127,127,127,.08))}
.hsf-sb-svc{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.hsf-sb-dot{width:8px;height:8px;border-radius:50%;background:#9aa3b2}.hsf-sb-dot.ready{background:#2fa36b}.hsf-sb-dot.signin{background:#d99a1e}
.hsf-sb button{font:inherit;font-size:12px;padding:4px 10px;border-radius:7px;border:1px solid var(--dsw-alias-separator-primary, rgba(127,127,127,.35));background:transparent;color:inherit;cursor:pointer}
.hsf-sb button:disabled{opacity:.5;cursor:default}
.hsf-sb button.primary{background:var(--dsw-alias-accent-primary, #c9a227);border-color:transparent;color:#111;font-weight:600}
.hsf-sb-note{font-size:12px;color:var(--dsw-alias-label-secondary);flex-basis:100%}
.hsf-sb-note.bad{color:#d14343}
.hsf-sb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:12px}
.hsf-sb-card{border:1px solid var(--dsw-alias-separator-primary, rgba(127,127,127,.25));border-radius:12px;padding:10px;display:flex;flex-direction:column;gap:8px}
.hsf-sb-card h4{margin:0;font-size:13px;display:flex;gap:6px;align-items:baseline}
.hsf-sb-card h4 span{color:var(--dsw-alias-label-tertiary);font-weight:400;font-size:11px}
.hsf-sb-action{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}
.hsf-sb-frames{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.hsf-sb-frame{display:flex;flex-direction:column;gap:4px;min-width:0}
.hsf-sb-pic{position:relative;border-radius:8px;overflow:hidden;background:rgba(127,127,127,.12);display:flex;align-items:center;justify-content:center;text-align:center}
.hsf-sb-pic img{width:100%;height:100%;object-fit:cover;display:block}
.hsf-sb-pic .msg{padding:8px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.hsf-sb-pic .msg.bad{color:#d14343}
.hsf-sb-pic.drawing{animation:hsf-sb-pulse 1.4s ease-in-out infinite}
@keyframes hsf-sb-pulse{50%{opacity:.55}}
.hsf-sb-label{font-size:11px;color:var(--dsw-alias-label-tertiary);display:flex;justify-content:space-between}
.hsf-sb-prompt{font-size:11px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.hsf-sb-card footer{display:flex;justify-content:flex-end}
`

type Loaded = { kind: 'loading' } | { kind: 'ready'; board: Board } | { kind: 'failed'; message: string }

async function post(url: string): Promise<void> {
  const response = await fetch(url, { method: 'POST', credentials: 'same-origin' })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `The request failed (${String(response.status)}).`)
  }
}

function FrameView(props: { path: string; frame: BoardFrame; label: string; aspect: string; version: string }): ReactNode {
  const { path, frame, label, aspect, version } = props
  const drawing = frame.status === 'drawing'
  const url = frame.image !== undefined && frame.status === 'done' ? fileMediaUrl(document.baseURI, framePath(path, frame.image)) : undefined
  let inner: ReactNode
  if (url !== undefined && !drawing) inner = h('img', { src: `${url}&v=${encodeURIComponent(version)}`, alt: frame.prompt, loading: 'lazy' })
  else if (drawing) inner = h('div', { className: 'msg' }, 'Drawing…')
  else if (frame.status === 'failed') inner = h('div', { className: 'msg bad', title: frame.error }, `Not drawn: ${frame.error ?? 'failed'}`)
  else inner = h('div', { className: 'msg' }, 'Not drawn yet')
  return h('div', { className: 'hsf-sb-frame' },
    h('div', { className: 'hsf-sb-label' }, h('span', null, label), frame.source === undefined ? null : h('span', null, frame.source === 'flow' ? 'Flow' : 'Grok')),
    h('div', { className: `hsf-sb-pic${drawing ? ' drawing' : ''}`, style: { aspectRatio: aspectRatio(aspect) } }, inner),
    h('div', { className: 'hsf-sb-prompt', title: frame.prompt }, frame.prompt))
}

/**
 * The board body.
 * @param props - the standard document props.
 * @returns the board, or a message.
 */
export function StoryboardBody(props: DocumentPreviewProps): ReactNode {
  const { content, resourceAddress, useResource } = props
  const resource = useResource<'file'>(resourceAddress)
  const file = resource.value
  const unreadable = unreadableMessage(resource)
  const path = file?.absolutePath
  const version = file?.version
  const revision = content.kind === 'renderer' ? content.revision : 0
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' })
  const [status, setStatus] = useState<CreativeStatus | undefined>(undefined)
  const [problem, setProblem] = useState<string | undefined>(undefined)

  // The file: read again whenever it changes (the host writes each frame's progress into it).
  useEffect(() => {
    if (path === undefined) return undefined
    const url = fileMediaUrl(document.baseURI, path)
    if (url === undefined) { setLoaded({ kind: 'failed', message: 'Storyboards open only in the app on the computer that holds them.' }); return undefined }
    const controller = new AbortController()
    fetch(`${url}&v=${encodeURIComponent(version ?? '')}`, { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`The storyboard could not be read (${String(response.status)}).`)
        const board = await response.json() as Board
        if (!Array.isArray(board.scenes)) throw new Error('This file is not a storyboard: it has no scenes.')
        setLoaded({ kind: 'ready', board })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoaded({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
      })
    return () => { controller.abort() }
  }, [path, version, revision])

  useEffect(() => {
    if (content.kind !== 'renderer' || version === undefined) return
    if (loaded.kind === 'ready') content.loaded(version)
    else if (loaded.kind === 'failed') content.failed()
    // `content` changes identity on every render; the revision, version and state are what matter.
  }, [revision, version, loaded.kind])

  // The services and the run: often while drawing or waiting for a sign-in, rarely otherwise.
  const refresh = useCallback(async () => {
    if (path === undefined) return
    const response = await fetch(creativeUrl(document.baseURI, 'status', { path }), { credentials: 'same-origin', cache: 'no-store' })
    if (response.ok) setStatus(await response.json() as CreativeStatus)
  }, [path])
  const running = status?.run !== null && status?.run !== undefined && !status.run.finished
  const waiting = status !== undefined && status.flow !== 'ready' && status.grok !== 'ready'
  useEffect(() => {
    void refresh().catch(() => {})
    const timer = setInterval(() => { void refresh().catch(() => {}) }, running ? 1500 : waiting ? 3000 : 10_000)
    return () => { clearInterval(timer) }
  }, [refresh, running, waiting])

  const act = (route: string, query: Record<string, string | undefined>): void => {
    setProblem(undefined)
    post(creativeUrl(document.baseURI, route, query))
      .then(refresh)
      .catch((error: unknown) => { setProblem(error instanceof Error ? error.message : String(error)) })
  }

  if (content.kind !== 'renderer') return null
  if (unreadable !== undefined) return h('div', { style: UNREADABLE_STYLE }, unreadable)
  if (loaded.kind === 'loading' || path === undefined) return h('div', { className: 'hsf-sb' }, h('style', null, STYLE), 'Loading the storyboard…')
  if (loaded.kind === 'failed') {
    return h('div', { className: 'hsf-sb' }, h('style', null, STYLE), `${loaded.message} You can still pick another viewer from the menu above.`)
  }

  const board = loaded.board
  const { drawn, total } = progressOf(board)
  const run = status?.run ?? null
  const progress = running && run !== null
    ? `Drawing ${run.current ?? ''}… ${String(run.done)} of ${String(run.total)} done.${run.note === undefined ? '' : ` ${run.note}`}`
    : run?.note
  const note = problem ?? run?.error ?? progress
  const bad = problem !== undefined || run?.error !== undefined
  const ready = status !== undefined && (status.flow === 'ready' || status.grok === 'ready')

  return h('div', { className: 'hsf-sb' },
    h('style', null, STYLE),
    h('div', { className: 'hsf-sb-head' },
      h('div', { className: 'hsf-sb-title' }, board.title),
      h('div', { className: 'hsf-sb-meta' }, `${String(board.scenes.length)} scenes · ${board.aspect} · ${String(drawn)} of ${String(total)} frames drawn`)),
    board.style === undefined ? null : h('p', { className: 'hsf-sb-action', style: { marginBottom: 10 } }, `Style: ${board.style}`),
    h('div', { className: 'hsf-sb-bar' },
      h('span', { className: 'hsf-sb-svc' }, h('span', { className: `hsf-sb-dot ${status?.flow ?? ''}` }), `Flow: ${status === undefined ? '…' : SERVICE_TEXT[status.flow]}`),
      status?.flow === 'ready' ? null : h('button', { type: 'button', onClick: () => { act('open', { service: 'flow' }) } }, 'Open Flow'),
      h('span', { className: 'hsf-sb-svc' }, h('span', { className: `hsf-sb-dot ${status?.grok ?? ''}` }), `Grok: ${status === undefined ? '…' : GROK_TEXT[status.grok]}`),
      status?.grok === 'ready' ? null : h('button', { type: 'button', onClick: () => { act('open', { service: 'grok' }) } }, 'Open Grok'),
      h('span', { style: { flex: 1 } }),
      running
        ? h('button', { type: 'button', onClick: () => { act('stop', { path }) } }, 'Stop')
        : h('button', {
          type: 'button', className: 'primary', disabled: !ready || drawn === total,
          title: ready ? undefined : 'Open Flow or Grok Imagine and sign in first',
          onClick: () => { act('draw', { path }) },
        }, drawn === 0 ? 'Proceed: draw the frames' : drawn === total ? 'All frames drawn' : 'Proceed: draw the rest'),
      note === undefined ? null : h('div', { className: `hsf-sb-note${bad ? ' bad' : ''}` }, note)),
    h('div', { className: 'hsf-sb-grid' }, board.scenes.map((scene, index) => h('section', { key: scene.id, className: 'hsf-sb-card' },
      h('h4', null, `${String(index + 1)}. ${scene.title}`, scene.seconds === undefined ? null : h('span', null, `${String(scene.seconds)} s`)),
      scene.action === undefined ? null : h('p', { className: 'hsf-sb-action' }, scene.action),
      h('div', { className: 'hsf-sb-frames' },
        h(FrameView, { path, frame: scene.start, label: 'Start', aspect: board.aspect, version: version ?? '' }),
        h(FrameView, { path, frame: scene.end, label: 'End', aspect: board.aspect, version: version ?? '' })),
      h('footer', null, h('button', {
        type: 'button', disabled: running || !ready,
        onClick: () => { act('draw', { path, scene: scene.id, redraw: '1' }) },
      }, scene.start.image === undefined && scene.end.image === undefined ? 'Draw this scene' : 'Redraw')),
    ))))
}
