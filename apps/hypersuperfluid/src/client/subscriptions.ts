/**
 * Settings → Subscriptions: the vendors' command-line agents the agent can hand work to on the person's own plans,
 * whether each is installed and signed in, and a Sign in button that opens the vendor's own login in a terminal
 * window. The desktop app does the work (`apps/desktop/src/subscriptions.ts`) over `window.dshDesktop.subscriptions`;
 * in a browser, the page lists the commands to run instead. The page never sees a token.
 * @module hypersuperfluid/client/subscriptions
 */

import { createElement as h, useCallback, useEffect, useState, type ReactNode } from 'react'

/** One tool, as the desktop app reports it. */
export interface SubscriptionInfo {
  readonly id: string
  readonly tool: string
  readonly label: string
  readonly plan: string
  readonly signInCommand: string
  readonly installed: boolean
  readonly note?: string
}

/** The result of a check. */
export interface SubscriptionCheck {
  readonly id: string
  readonly state: 'signed-in' | 'signed-out' | 'not-installed' | 'unknown'
  readonly detail: string
}

/** The desktop bridge. */
export interface SubscriptionsBridge {
  list(): Promise<readonly SubscriptionInfo[]>
  check(id: string): Promise<SubscriptionCheck>
  signIn(id: string): Promise<{ readonly opened: boolean; readonly detail: string }>
}

/**
 * The desktop bridge, when this page runs in the desktop app.
 * @returns the bridge, or undefined in a browser or an older desktop build.
 */
export function desktopBridge(): SubscriptionsBridge | undefined {
  const desktop = (globalThis as { dshDesktop?: { subscriptions?: SubscriptionsBridge } }).dshDesktop
  const bridge = desktop?.subscriptions
  return bridge !== undefined && typeof bridge.list === 'function' ? bridge : undefined
}

/** What a browser shows: the same tools, with the command to type. */
export const BROWSER_TOOLS: readonly SubscriptionInfo[] = [
  { id: 'grok', tool: 'grok', label: 'Grok Build', plan: 'xAI Grok subscription', signInCommand: 'grok login', installed: false },
  { id: 'agy', tool: 'agy', label: 'Google Antigravity', plan: 'Google account', signInCommand: 'agy (run it once)', installed: false },
  { id: 'gemini-cli', tool: 'gemini_cli', label: 'Gemini CLI', plan: 'Google account', signInCommand: 'gemini (run it once)', installed: false },
  { id: 'opencode', tool: 'opencode', label: 'OpenCode', plan: 'OpenCode providers', signInCommand: 'opencode auth login', installed: false },
  { id: 'hermes', tool: 'hermes', label: 'Hermes Agent', plan: 'the model Hermes is set up with', signInCommand: 'hermes model', installed: false },
]

/** Stylesheet for the page, scoped by the `hsf-subs` prefix. */
export const SUBSCRIPTIONS_STYLE = [
  '.hsf-subs{display:flex;flex-direction:column;width:100%;color:var(--dsw-alias-label-primary)}',
  '.hsf-subs-intro{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);padding:4px 0 12px}',
  '.hsf-subs-row{display:flex;gap:12px;align-items:flex-start;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
  '.hsf-subs-row:last-child{border-bottom:none}',
  '.hsf-subs-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
  '.hsf-subs-title{display:flex;align-items:center;gap:8px;font-size:14px;line-height:22px}',
  '.hsf-subs-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.hsf-subs-sub code{font-family:ui-monospace,Consolas,monospace;font-size:12px}',
  '.hsf-subs-note{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label)}',
  '.hsf-subs-detail{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
  '.hsf-subs-pill{font-size:12px;line-height:18px;padding:0 8px;border-radius:999px;white-space:nowrap;',
  'background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}',
  '.hsf-subs-pill[data-state=signed-in]{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}',
  '.hsf-subs-pill[data-state=signed-out]{color:var(--dsw-alias-state-warn-label)}',
  '.hsf-subs-actions{display:flex;gap:8px;flex-shrink:0}',
  '.hsf-subs-button{height:32px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md,8px);font:inherit;font-size:13px;cursor:pointer;',
  'background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}',
  '.hsf-subs-button[data-primary]{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}',
  '.hsf-subs-button:disabled{opacity:.5;cursor:default}',
  '@media (hover:hover){.hsf-subs-button:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.hsf-subs-button[data-primary]:not(:disabled):hover{opacity:.85;background:var(--dsw-alias-label-primary)}}',
  '@media (max-width:560px){.hsf-subs-row{flex-direction:column}}',
].join('')

/** The status pill's text. */
export function statusLabel(info: SubscriptionInfo, check: SubscriptionCheck | undefined, checking: boolean): string {
  if (!info.installed) return 'Not installed'
  if (checking) return 'Checking…'
  switch (check?.state) {
    case 'signed-in': return 'Signed in'
    case 'signed-out': return 'Not signed in'
    case 'not-installed': return 'Not installed'
    case 'unknown': return 'Unknown'
    default: return 'Installed'
  }
}

function pillState(info: SubscriptionInfo, check: SubscriptionCheck | undefined): string {
  if (!info.installed) return 'not-installed'
  return check?.state ?? 'installed'
}

interface RowProps {
  readonly info: SubscriptionInfo
  readonly bridge: SubscriptionsBridge | undefined
  readonly check: SubscriptionCheck | undefined
  readonly checking: boolean
  readonly message: string | undefined
  readonly onCheck: (id: string) => void
  readonly onSignIn: (id: string) => void
}

function Row({ info, bridge, check, checking, message, onCheck, onSignIn }: RowProps): ReactNode {
  const installed = info.installed
  const detail = message ?? (check !== undefined && check.state !== 'signed-in' ? check.detail : undefined)
  return h('div', { className: 'hsf-subs-row', 'data-tool': info.id },
    h('div', { className: 'hsf-subs-text' },
      h('div', { className: 'hsf-subs-title' },
        h('span', null, info.label),
        bridge === undefined ? null : h('span', { className: 'hsf-subs-pill', 'data-state': pillState(info, check) }, statusLabel(info, check, checking))),
      h('div', { className: 'hsf-subs-sub' }, `Uses your ${info.plan}. Agent tool `, h('code', null, info.tool), '. Sign in with ', h('code', null, info.signInCommand), '.'),
      info.note === undefined ? null : h('div', { className: 'hsf-subs-note' }, info.note),
      bridge !== undefined && !installed
        ? h('div', { className: 'hsf-subs-detail' }, 'Install it from its vendor, then restart the app so the agent gets the tool.')
        : null,
      detail === undefined ? null : h('div', { className: 'hsf-subs-detail', role: 'status' }, detail)),
    bridge === undefined ? null : h('div', { className: 'hsf-subs-actions' },
      h('button', {
        type: 'button', className: 'hsf-subs-button', 'data-primary': check?.state === 'signed-in' ? undefined : '',
        disabled: !installed, onClick: () => { onSignIn(info.id) },
      }, check?.state === 'signed-in' ? 'Sign in again' : 'Sign in'),
      h('button', { type: 'button', className: 'hsf-subs-button', disabled: !installed || checking, onClick: () => { onCheck(info.id) } }, 'Check')))
}

/**
 * The Subscriptions settings section.
 * @param props - unused slot props.
 * @returns the section.
 */
export function SubscriptionsSection(_props: object): ReactNode {
  const [bridge] = useState(desktopBridge)
  const [tools, setTools] = useState<readonly SubscriptionInfo[] | undefined>(bridge === undefined ? BROWSER_TOOLS : undefined)
  const [checks, setChecks] = useState<Readonly<Record<string, SubscriptionCheck>>>({})
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set())
  const [messages, setMessages] = useState<Readonly<Record<string, string>>>({})
  const [error, setError] = useState<string | undefined>(undefined)

  const runCheck = useCallback((id: string) => {
    if (bridge === undefined) return
    setChecking(current => new Set(current).add(id))
    setMessages(({ [id]: _dropped, ...rest }) => rest)
    void bridge.check(id)
      .then((result) => { setChecks(current => ({ ...current, [id]: result })) })
      .catch((cause: unknown) => { setMessages(current => ({ ...current, [id]: `Check failed: ${String(cause)}` })) })
      .finally(() => { setChecking((current) => { const next = new Set(current); next.delete(id); return next }) })
  }, [bridge])

  const runSignIn = useCallback((id: string) => {
    if (bridge === undefined) return
    void bridge.signIn(id)
      .then((result) => { setMessages(current => ({ ...current, [id]: result.detail })) })
      .catch((cause: unknown) => { setMessages(current => ({ ...current, [id]: `Could not open the sign-in: ${String(cause)}` })) })
  }, [bridge])

  useEffect(() => {
    if (bridge === undefined) return
    let live = true
    bridge.list()
      .then((list) => {
        if (!live) return
        setTools(list)
        // Opening a session spends nothing, so the page checks every installed tool when it opens.
        for (const tool of list) if (tool.installed) runCheck(tool.id)
      })
      .catch((cause: unknown) => { if (live) setError(String(cause)) })
    return () => { live = false }
  }, [bridge, runCheck])

  const intro = bridge === undefined
    ? 'These tools sign in on the computer that runs Hypersuperfluid. Open a terminal there and run each tool\'s sign-in command, then restart the app.'
    : 'Chat with these vendors\' own agents on your plans: after signing in, pick "<tool> · your plan" in the chat\'s model picker. The agent can also hand them tasks. Sign in opens the vendor\'s login in a terminal window; the login stays in the vendor\'s program, and this app never sees it. Check opens a session without sending a prompt, so it spends nothing.'
  return h('div', { className: 'hsf-subs' },
    h('div', { className: 'hsf-subs-intro' }, intro),
    error === undefined ? null : h('div', { className: 'hsf-subs-note', role: 'alert' }, `Could not list the tools: ${error}`),
    tools === undefined
      ? h('div', { className: 'hsf-subs-detail' }, 'Looking for installed tools…')
      : tools.map(info => h(Row, {
        key: info.id, info, bridge, check: checks[info.id], checking: checking.has(info.id), message: messages[info.id],
        onCheck: runCheck, onSignIn: runSignIn,
      })))
}
