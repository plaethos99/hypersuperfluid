/**
 * The Hypersuperfluid brand, browser half: the sidebar mark and name, the home-screen mark and headline, the welcome
 * text, and the tab title and icon. DSH's own colours stay. Every contribution is an owned effect, so unloading the
 * plugin restores the previous state. The images are generated into `brand-assets.ts` by `branding/render-brand.mjs`.
 * @module hypersuperfluid/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { LanguageRegistration, LocaleDict } from '@deepseek-ai/dsh-client-locale/client'
import { createElement as h } from 'react'
import { BRAND, EMBLEM, SMALL_MARK } from './brand-assets.ts'

/** Services this plugin needs. */
export const inject = ['slots', 'locale']

/** Below this edge the ring would only take room from the wings, so the tighter crop is drawn. */
const EMBLEM_MIN_EDGE = 96
const TITLE_REPLACED = /DeepSeek Harness|DSH Local Build/g
const STYLE = ".hsf-brand-name{font:600 17px/1 Inter,'Segoe UI Variable Display','Segoe UI',system-ui,sans-serif;letter-spacing:-.01em;white-space:nowrap;color:var(--dsw-alias-label-primary)}"

const EN_TEXT: Record<string, LocaleDict> = {
  conversation: { 'hero.headline': 'What should we get done?' },
  'settings.models': {
    welcomeTitle: `Welcome to ${BRAND}`,
    welcomeBody: `${BRAND} works like an expert colleague across code, DevOps, ERP and embedded systems, and it learns how you like things done. Describe a task or point it at a folder. It checks with you before anything that is hard to undo.`,
    welcomeContinue: 'Get started',
  },
}
const ZH_TEXT: Record<string, LocaleDict> = {
  conversation: { 'hero.headline': '今天要完成什么？' },
  'settings.models': { welcomeTitle: `欢迎使用 ${BRAND}`, welcomeContinue: '开始使用' },
}
/**
 * Browsers request regional tags; a registered regional variant wins over the built-in base language and falls back
 * to it, so these variants carry only the brand text.
 */
const LANGUAGES: ReadonlyArray<LanguageRegistration & { readonly text: Record<string, LocaleDict> }> = [
  { id: 'en-US', label: 'English (US)', fallback: 'en', text: EN_TEXT },
  { id: 'en-GB', label: 'English (UK)', fallback: 'en', text: EN_TEXT },
  { id: 'en-IN', label: 'English (India)', fallback: 'en', text: EN_TEXT },
  { id: 'zh-CN', label: '简体中文', fallback: 'zh', text: ZH_TEXT },
]

function mark(src: string, size: number, className?: string) {
  return h('img', {
    src, width: size, height: size, alt: '', draggable: false, className,
    style: { display: 'block', width: size, height: size, borderRadius: Math.round(size * 0.22) },
  })
}

function SidebarMark({ size }: SidebarBrandMarkOwnerProps) {
  return mark(SMALL_MARK, size)
}

function HeroMark({ size, className }: HeroBrandMarkOwnerProps) {
  return mark(size >= EMBLEM_MIN_EDGE ? EMBLEM : SMALL_MARK, size, className)
}

function BrandName() {
  return h('span', { className: 'hsf-brand-name' }, BRAND)
}

/** Brands the document: stylesheet, tab title and favicon. */
function brandDocument(): () => void {
  const style = document.createElement('style')
  style.dataset.hsfBrand = ''
  style.textContent = STYLE
  document.head.appendChild(style)
  const fixTitle = (): void => {
    if (TITLE_REPLACED.test(document.title)) document.title = document.title.replace(TITLE_REPLACED, BRAND)
    TITLE_REPLACED.lastIndex = 0
  }
  fixTitle()
  const observer = new MutationObserver(fixTitle)
  observer.observe(document.head, { childList: true, subtree: true, characterData: true })
  const previous = Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel~='icon']"))
  previous.forEach(link => link.remove())
  const icon = document.createElement('link')
  icon.rel = 'icon'
  icon.type = 'image/webp'
  icon.href = SMALL_MARK
  document.head.appendChild(icon)
  return () => {
    observer.disconnect()
    style.remove()
    icon.remove()
    previous.forEach(link => document.head.appendChild(link))
  }
}

/**
 * @param ctx - the client root context.
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, SidebarMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, BrandName)
    }))
  ctx.slots.inject('conversation.hero.brand.mark', function* () {
    yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, HeroMark)
  })
  for (const { text, ...language } of LANGUAGES) {
    ctx.effect(() => ctx.locale.addLanguage(language), `hsf-brand: language ${language.id}`)
    for (const [ns, dict] of Object.entries(text)) {
      ctx.effect(() => ctx.locale.register(ns, language.id, dict), `hsf-brand: ${ns} ${language.id}`)
    }
  }
  ctx.effect(brandDocument, 'hsf-brand: document title, favicon and style')
}
