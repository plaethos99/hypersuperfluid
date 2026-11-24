/**
 * Puts Apps in the left sidebar (a page) and in the side panel's new-tab menu (a tab), and works out which chat and
 * folder a file opened from the page belongs to.
 * @module hypersuperfluid/client/apps-register
 */

import { createElement as h, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { APPS_ID, APPS_KIND, AppsIcon, AppsView } from './apps.ts'

/** The part of the session list this reads. */
export interface SessionRows {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, {
    readonly updatedAt?: number
    readonly cwd?: string
    readonly origin?: string
    readonly retainedBy?: Readonly<Record<string, number | undefined>>
    readonly projectionValues?: Readonly<Record<string, unknown>>
  } | undefined>>
  readonly projectionsBySession?: Readonly<Record<string, { readonly values?: Readonly<Record<string, unknown>> } | undefined>>
}

/** A Session's working folder, as the app's own views read it. */
export function folderOf(list: SessionRows, sessionId: string): string | undefined {
  const projected = list.projectionsBySession?.[sessionId]?.values?.workingDirectory
    ?? list.byId[sessionId]?.projectionValues?.workingDirectory
  return typeof projected === 'string' && projected !== '' ? projected : list.byId[sessionId]?.cwd
}

/**
 * The chat a file opened from the Apps page goes to: the one the main view shows (or showed last), else the most
 * recently active one. Subagents never.
 */
export function currentSession(list: SessionRows): string | undefined {
  const rows = list.ids.flatMap((id) => {
    const row = list.byId[id]
    return row === undefined || row.origin === 'subagent' ? [] : [{ id, row }]
  })
  const shown = rows.find(({ row }) => (row.retainedBy?.mainView ?? 0) > 0)
  if (shown !== undefined) return shown.id
  return rows.sort((left, right) => (right.row.updatedAt ?? 0) - (left.row.updatedAt ?? 0))[0]?.id
}

/** The browser's sessions service, read untyped: the host's service of the same name has another type here. */
function browserSessions(scope: object): { readonly list: { getSnapshot(): SessionRows } } {
  const value: unknown = (scope as Record<string, unknown>).sessions
  return value as { readonly list: { getSnapshot(): SessionRows } }
}

interface TabBodyProps {
  readonly sessionId: SessionId
  readonly useTabInfo: () => { readonly tab: { readonly actions: { openResource(address: string): void } } }
  readonly folder: (sessionId: SessionId) => string | undefined
}

function AppsTab(props: TabBodyProps): ReactNode {
  const { tab } = props.useTabInfo()
  const folder = props.folder(props.sessionId)
  return h(AppsView, { folder, open: (path: string) => { tab.actions.openResource(fileAddressFor(props.sessionId, folder, path)) } })
}

function AppsTabTitle(): ReactNode {
  return h('span', null, 'Apps')
}

interface PageProps {
  readonly target: () => { readonly sessionId: SessionId; readonly folder: string | undefined } | undefined
  readonly open: (sessionId: SessionId, folder: string | undefined, path: string) => void
  readonly newChat: () => void
}

function AppsPage(props: PageProps): ReactNode {
  const target = props.target()
  return h(AppsView, {
    page: true,
    folder: target?.folder,
    open: (path: string) => { if (target !== undefined) props.open(target.sessionId, target.folder, path) },
    missing: h('p', null, 'Start a chat first: files are made in its folder and open beside it. ',
      h('button', { type: 'button', className: 'primary', onClick: props.newChat }, 'New chat')),
  })
}

/**
 * Registers the Apps page, its sidebar row, and the side panel tab type.
 * @param ctx - the client plugin's context.
 */
export function registerApps(ctx: Context): void {
  ctx.inject(['sidebarRight', 'sidebarRightTabs', 'sessions', 'uiWorkspace', 'slots'], (scope) => {
    // The browser's sessions service; the host's service of the same name has another type in this package's view.
    const sessions = browserSessions(scope)
    const rows = (): SessionRows => sessions.list.getSnapshot()
    const folder = (sessionId: SessionId): string | undefined => folderOf(rows(), sessionId)

    scope.effect(() => scope.sidebarRightTabs.register({
      id: APPS_ID,
      kind: APPS_KIND,
      priority: 'extension',
      title: () => 'Apps',
      guide: [{ id: 'apps', order: 5, title: () => 'Apps', description: () => 'Word, Excel, PowerPoint and storyboards, edited from chat', icon: AppsIcon as never }],
    }), 'hsf-apps: tab type')
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: APPS_ID, inject: () => ({ folder }),
    }, AppsTab as never)), 'hsf-apps: tab body')
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register({
      name: 'sidebar.right.pane.tab.title', key: APPS_ID,
    }, AppsTabTitle)), 'hsf-apps: tab title')

    const target = (): { sessionId: SessionId; folder: string | undefined } | undefined => {
      const sessionId = currentSession(rows()) as SessionId | undefined
      return sessionId === undefined ? undefined : { sessionId, folder: folder(sessionId) }
    }
    const open = (sessionId: SessionId, where: string | undefined, path: string): void => {
      // Back to the chat, with the file in its side panel.
      scope.uiWorkspace.openSession(sessionId)
      scope.sidebarRight.openResourceIn(sessionId, fileAddressFor(sessionId, where, path))
      if (!scope.sidebarRight.isExpanded()) scope.sidebarRight.toggleExpanded()
    }
    scope.effect(() => scope.slots.inject('main', () => scope.slots.register({
      name: 'main', key: APPS_ID,
      inject: (): PageProps => ({ target, open, newChat: () => { scope.uiWorkspace.startSession() } }),
    }, AppsPage as never)), 'hsf-apps: page')
    scope.effect(() => scope.slots.inject('sidebar.panellist', () => scope.slots.register({
      name: 'sidebar.panellist', id: APPS_ID, order: 5, label: () => 'Apps',
    }, AppsIcon as never)), 'hsf-apps: sidebar row')
  })
}
