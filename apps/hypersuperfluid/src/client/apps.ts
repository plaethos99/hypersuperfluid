/**
 * Apps: Word, Excel, PowerPoint and Storyboard, each with New and the folder's recent files. The same view shows in
 * two places:
 * - **Apps in the left sidebar**, a page that opens the chosen file in the current chat's side panel and returns to
 *   that chat;
 * - **Apps in the side panel's new-tab menu**, a tab that opens the file beside itself.
 * Either way the file opens in the side panel next to the chat (the Office editor, or the storyboard board), and what
 * the person then asks in chat is carried out there: the agent's `side_panel` tool lists what is open.
 * Files are listed and made by the host's owner-only routes under `/api/hsf/apps/` (`src/apps/index.ts`).
 * @module hypersuperfluid/client/apps
 */

import { createElement as h, useCallback, useEffect, useState, type ReactNode } from 'react'

/** The page's and the tab type's identity. */
export const APPS_ID = '@deepseek-ai/dsh-hypersuperfluid/apps'
/** The side panel tab kind. */
export const APPS_KIND = 'hsf-apps'

/** One app as the view shows it. */
export interface AppCard {
  readonly id: 'word' | 'excel' | 'powerpoint' | 'storyboard'
  readonly label: string
  readonly blurb: string
  readonly letter: string
  readonly color: string
}

/** The four apps, in the order shown. */
export const APP_CARDS: readonly AppCard[] = [
  { id: 'word', label: 'Word', blurb: 'Documents, letters, reports', letter: 'W', color: '#2b579a' },
  { id: 'excel', label: 'Excel', blurb: 'Spreadsheets, tables, budgets', letter: 'X', color: '#217346' },
  { id: 'powerpoint', label: 'PowerPoint', blurb: 'Slides and decks', letter: 'P', color: '#c43e1c' },
  { id: 'storyboard', label: 'Storyboard', blurb: 'Scenes with start and end frames', letter: 'S', color: '#7c5cd6' },
]

/** One file as the host lists it. */
export interface ListedFile { readonly path: string; readonly name: string; readonly app: AppCard['id']; readonly modified: number }

/** A route under `api/hsf/apps/`. */
export function appsUrl(base: string, route: 'files' | 'new', query: Record<string, string>): string {
  return new URL(`api/hsf/apps/${route}?${new URLSearchParams(query).toString()}`, base).href
}

/** A file's folder relative to the listed folder, for a second line ("" at the top). */
export function relativeFolder(root: string, path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const folder = path.slice(0, cut)
  const trimmed = root.replace(/[\\/]+$/u, '')
  return folder.length > trimmed.length && folder.toLowerCase().startsWith(trimmed.toLowerCase()) ? folder.slice(trimmed.length + 1) : ''
}

/** "3 min ago", "yesterday", or the date. */
export function whenText(modified: number, now = Date.now()): string {
  const minutes = Math.round((now - modified) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${String(minutes)} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${String(hours)} h ago`
  if (hours < 48) return 'yesterday'
  return new Date(modified).toLocaleDateString()
}

/** The app glyph: a rounded square with the app's letter. */
export function AppGlyph({ card, size = 28 }: { card: AppCard; size?: number }): ReactNode {
  return h('span', {
    'aria-hidden': true,
    style: {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, flex: 'none',
      borderRadius: Math.round(size * 0.24), background: card.color, color: '#fff', fontWeight: 700, fontSize: Math.round(size * 0.5),
    },
  }, card.letter)
}

/** The sidebar icon: four small app squares. */
export function AppsIcon({ size = 16 }: { size?: number }): ReactNode {
  const square = (x: number, y: number, fill: string): ReactNode => h('rect', { key: `${String(x)}${String(y)}`, x, y, width: 6.5, height: 6.5, rx: 1.6, fill })
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true },
    APP_CARDS.map((card, index) => square(index % 2 === 0 ? 1 : 8.5, index < 2 ? 1 : 8.5, card.color)))
}

const STYLE = `
.hsf-apps{height:100%;overflow:auto;box-sizing:border-box;padding:16px;font:13px/1.45 system-ui,'Segoe UI',sans-serif;color:var(--dsw-alias-label-primary)}
.hsf-apps.page{max-width:980px;margin:0 auto;padding:28px 24px}
.hsf-apps h2{margin:0 0 4px;font-size:20px}
.hsf-apps .lead{margin:0 0 16px;color:var(--dsw-alias-label-secondary)}
.hsf-apps-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(260px,100%),1fr));gap:12px}
.hsf-app{border:1px solid var(--dsw-alias-separator-primary, rgba(127,127,127,.25));border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px}
.hsf-app-head{display:flex;align-items:center;gap:10px}
.hsf-app-head b{font-size:14px;display:block}
.hsf-app-head small{color:var(--dsw-alias-label-secondary)}
.hsf-app-head .grow{flex:1;min-width:0}
.hsf-apps button{font:inherit;font-size:12px;padding:4px 10px;border-radius:7px;border:1px solid var(--dsw-alias-separator-primary, rgba(127,127,127,.35));background:transparent;color:inherit;cursor:pointer}
.hsf-apps button.primary{background:var(--dsw-alias-accent-primary, #c9a227);border-color:transparent;color:#111;font-weight:600}
.hsf-apps button:disabled{opacity:.5;cursor:default}
.hsf-app-new{display:flex;gap:6px}
.hsf-app-new input{flex:1;min-width:0;font:inherit;font-size:12px;padding:4px 8px;border-radius:7px;border:1px solid var(--dsw-alias-separator-primary, rgba(127,127,127,.35));background:transparent;color:inherit}
.hsf-app-files{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.hsf-app-files li button{all:unset;box-sizing:border-box;width:100%;display:flex;gap:8px;align-items:baseline;padding:5px 6px;border-radius:6px;cursor:pointer}
.hsf-app-files li button:hover,.hsf-app-files li button:focus-visible{background:rgba(127,127,127,.12)}
.hsf-app-files .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hsf-app-files .meta{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.hsf-app-empty{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:2px 6px}
.hsf-apps .note{margin-top:14px;font-size:12px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.hsf-apps .bad{color:#d14343}
`

/** What the view needs from where it is shown. */
export interface AppsViewProps {
  /** The folder files are listed from and made in; undefined while unknown. */
  readonly folder: string | undefined
  /** Opens a file in the side panel. */
  readonly open: (path: string) => void
  /** A full page (the left sidebar's) rather than a narrow tab. */
  readonly page?: boolean
  /** Shown instead of the apps when there is no folder to work in. */
  readonly missing?: ReactNode
}

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `The request failed (${String(response.status)}).`)
  return body
}

interface AppTileProps { card: AppCard; files: readonly ListedFile[]; folder: string; open: (path: string) => void; created: () => void }

function AppTile(props: AppTileProps): ReactNode {
  const { card, files, folder, open, created } = props
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const make = (): void => {
    setBusy(true)
    setProblem(undefined)
    fetch(appsUrl(document.baseURI, 'new', { dir: folder, app: card.id, name }), { method: 'POST', credentials: 'same-origin' })
      .then(response => json<{ path: string }>(response))
      .then(({ path }) => { setNaming(false); setName(''); created(); open(path) })
      .catch((error: unknown) => { setProblem(error instanceof Error ? error.message : String(error)) })
      .finally(() => { setBusy(false) })
  }
  const mine = files.filter(file => file.app === card.id).slice(0, 6)
  return h('section', { className: 'hsf-app', 'aria-label': card.label },
    h('div', { className: 'hsf-app-head' },
      h(AppGlyph, { card }),
      h('div', { className: 'grow' }, h('b', null, card.label), h('small', null, card.blurb)),
      naming ? null : h('button', { type: 'button', className: 'primary', onClick: () => { setNaming(true) } }, 'New')),
    naming
      ? h('form', { className: 'hsf-app-new', onSubmit: (event: { preventDefault: () => void }) => { event.preventDefault(); make() } },
        h('input', {
          autoFocus: true, value: name, placeholder: card.id === 'storyboard' ? 'Name, e.g. Product launch' : `Name, e.g. ${card.label === 'Excel' ? 'Budget 2027' : 'Quarterly report'}`,
          'aria-label': `Name of the new ${card.label} file`, onChange: (event: { target: { value: string } }) => { setName(event.target.value) },
        }),
        h('button', { type: 'submit', className: 'primary', disabled: busy }, busy ? 'Creating…' : 'Create'),
        h('button', { type: 'button', disabled: busy, onClick: () => { setNaming(false); setProblem(undefined) } }, 'Cancel'))
      : null,
    problem === undefined ? null : h('div', { className: 'bad', style: { fontSize: 12 } }, problem),
    mine.length === 0
      ? h('div', { className: 'hsf-app-empty' }, `No ${card.label} files here yet.`)
      : h('ul', { className: 'hsf-app-files' }, mine.map(file => h('li', { key: file.path },
        h('button', { type: 'button', title: file.path, onClick: () => { open(file.path) } },
          h('span', { className: 'name' }, file.name),
          h('span', { className: 'meta' }, [relativeFolder(folder, file.path), whenText(file.modified)].filter(part => part !== '').join(' · ')))))))
}

/**
 * The apps: one tile per app with New and its recent files.
 * @param props - where files live and how to open one.
 * @returns the view.
 */
export function AppsView(props: AppsViewProps): ReactNode {
  const { folder, open, page = false, missing } = props
  const [files, setFiles] = useState<readonly ListedFile[]>([])
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const load = useCallback(() => {
    if (folder === undefined) return
    fetch(appsUrl(document.baseURI, 'files', { dir: folder }), { credentials: 'same-origin', cache: 'no-store' })
      .then(response => json<{ files: ListedFile[] }>(response))
      .then((body) => { setFiles(body.files); setProblem(undefined) })
      .catch((error: unknown) => { setProblem(error instanceof Error ? error.message : String(error)) })
  }, [folder])
  useEffect(() => {
    load()
    const timer = setInterval(load, 15_000)
    return () => { clearInterval(timer) }
  }, [load])
  return h('div', { className: `hsf-apps${page ? ' page' : ''}` },
    h('style', null, STYLE),
    page ? h('h2', null, 'Apps') : null,
    h('p', { className: 'lead' }, 'Open or create a file: it opens in the side panel next to your chat, and what you ask in the chat is done there.'),
    folder === undefined
      ? missing ?? h('p', null, 'Open a chat first: files are made in its folder.')
      : h('div', { className: 'hsf-apps-grid' }, APP_CARDS.map(card => h(AppTile, { key: card.id, card, files, folder, open, created: load }))),
    folder === undefined ? null : h('div', { className: 'note' }, problem === undefined ? `Files in ${folder}` : h('span', { className: 'bad' }, problem)))
}
