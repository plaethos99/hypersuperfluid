import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { BROWSER_TOOLS, desktopBridge, statusLabel, SubscriptionsSection, type SubscriptionInfo } from '../src/client/subscriptions.ts'

const grok: SubscriptionInfo = { id: 'grok', tool: 'grok', label: 'Grok Build', plan: 'xAI Grok subscription', signInCommand: 'grok login', installed: true }

afterEach(() => { delete (globalThis as { dshDesktop?: unknown }).dshDesktop })

describe('Settings → Subscriptions', () => {
  it('names each state', () => {
    expect(statusLabel({ ...grok, installed: false }, undefined, false)).toBe('Not installed')
    expect(statusLabel(grok, undefined, true)).toBe('Checking…')
    expect(statusLabel(grok, { id: 'grok', state: 'signed-in', detail: '' }, false)).toBe('Signed in')
    expect(statusLabel(grok, { id: 'grok', state: 'signed-out', detail: '' }, false)).toBe('Not signed in')
  })

  it('uses the desktop bridge only when it is there', () => {
    expect(desktopBridge()).toBeUndefined()
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = { protocolVersion: 1 }
    expect(desktopBridge()).toBeUndefined()
    const bridge = { list: async () => [], check: async () => ({ id: '', state: 'unknown', detail: '' }), signIn: async () => ({ opened: false, detail: '' }) }
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = { protocolVersion: 1, subscriptions: bridge }
    expect(desktopBridge()).toBe(bridge)
  })

  it('lists the commands to run when it is not in the desktop app', () => {
    const html = renderToStaticMarkup(createElement(SubscriptionsSection, {}))
    for (const tool of BROWSER_TOOLS) expect(html).toContain(tool.signInCommand)
    expect(html).not.toContain('<button')
  })

  it('offers Sign in and Check in the desktop app', () => {
    const bridge = { list: async () => [grok], check: async () => ({ id: 'grok', state: 'signed-in' as const, detail: '' }), signIn: async () => ({ opened: true, detail: '' }) }
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = { protocolVersion: 1, subscriptions: bridge }
    // The first render waits for the list.
    expect(renderToStaticMarkup(createElement(SubscriptionsSection, {}))).toContain('Looking for installed tools')
  })
})
