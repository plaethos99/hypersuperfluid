/**
 * The Hypersuperfluid look: a midnight-navy dark palette and a cool near-white light one, drawn from the mark's navy
 * field, with its gold ring as the one accent and sapphire for links. It is an override layer over DSH's own light and
 * dark palettes (`ctx.theme.overrideTokens`), so the person's Light, Dark or System choice keeps working; every token
 * names both modes. Text colours keep at least 4.5:1 contrast on their surfaces.
 * @module hypersuperfluid/client/theme
 */

import type { ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'

/** Override-layer source name. */
export const THEME_SOURCE = 'hypersuperfluid'

const pair = (light: string, dark: string) => ({ light, dark })

/** The palette, as `--dsw-*` alias tokens. */
export const TOKENS: ThemeTokenOverrides = {
  // Surfaces: a quiet near-white canvas, and navy layers that lift by small steps in the dark.
  '--dsw-alias-bg-base': pair('#fcfcfd', '#0d121b'),
  '--dsw-alias-bg-layer-1': pair('#ffffff', '#131a26'),
  '--dsw-alias-bg-layer-2': pair('#ffffff', '#182030'),
  '--dsw-alias-bg-layer-3': pair('#ffffff', '#1e2738'),
  '--dsw-alias-bg-module-platform': pair('#f2f4f7', '#182030'),
  '--dsw-alias-bg-overlay': pair('#ffffff', '#161d2b'),
  '--dsw-specific-sidebar-fill': pair('#f4f5f8', '#0a0e15'),
  '--dsw-alias-markdown-code-block': pair('#f5f7fa', '#0a0f17'),
  '--dsw-alias-card-fill': pair('#ffffff', '#151c29'),
  '--dsw-alias-card-fill-hover': pair('#f6f7f9', '#1a2232'),
  // Hairlines: thinner and cooler than the defaults.
  '--dsw-alias-border-l1': pair('rgba(15, 23, 42, 0.05)', 'rgba(148, 170, 210, 0.07)'),
  '--dsw-alias-border-l2': pair('rgba(15, 23, 42, 0.08)', 'rgba(148, 170, 210, 0.11)'),
  '--dsw-alias-border-l3': pair('rgba(15, 23, 42, 0.11)', 'rgba(148, 170, 210, 0.15)'),
  '--dsw-alias-border-l4': pair('rgba(15, 23, 42, 0.16)', 'rgba(148, 170, 210, 0.22)'),
  // Text: ink on light, soft white on navy.
  '--dsw-alias-label-primary': pair('#0f1623', '#e9edf4'),
  '--dsw-alias-label-secondary': pair('#475164', '#aab4c5'),
  '--dsw-alias-label-tertiary': pair('#636d80', '#8590a3'),
  // Hover and pressed states.
  '--dsw-alias-interactive-bg-hover': pair('rgba(15, 23, 42, 0.045)', 'rgba(148, 170, 210, 0.08)'),
  '--dsw-alias-interactive-bg-active': pair('rgba(15, 23, 42, 0.08)', 'rgba(148, 170, 210, 0.13)'),
  // Primary buttons stay monochrome; the accent is the mark's gold, deepened in light mode for contrast.
  '--dsw-alias-brand-primary': pair('#111827', '#f1f4f9'),
  '--dsw-alias-state-business-primary': pair('#8f620a', '#e5b54a'),
  '--dsw-alias-link': pair('#2c5bcc', '#8fb0ff'),
  '--dsw-alias-trajectory-accent': pair('#8f620a', '#e5b54a'),
  // DSH's general accent (carets, rails, badges, icons) follows the gold.
  '--dsw-alias-brand-primary-new-colorprimary-new-color': pair('#8f620a', '#e5b54a'),
  // The last DeepSeek-blue spots: badge fills such as "Preview" (gold text on a gold tint, 4.7:1 light and 7:1 dark),
  // the action in toasts (which sit on a dark fill in both modes), a highlighted bubble, and the shimmering
  // "working" label.
  '--dsw-alias-state-business-tertiary': pair('#fbf3df', '#33290f'),
  '--dsw-alias-toast-action': pair('#e5b54a', '#e5b54a'),
  '--dsw-specific-bubble-highlight': pair('#f6e7c1', '#2a354b'),
  '--dsw-alias-label-deep-diving': pair('#7a5410', '#d8ae52'),
  '--dsw-alias-label-deep-diving-shimmer': pair('#d9b45e', '#f3d58e'),
  // The send button carries a white arrow, so it takes a sapphire deep enough for it rather than the gold.
  '--dsw-alias-button-info-fill': pair('#2c5bcc', '#3a6ad8'),
  '--dsw-alias-button-info-hover': pair('#234aa8', '#4a78e4'),
  // DSH's flat greys in dark mode, mapped onto the navy scale; light keeps DSH's value unless noted.
  '--dsw-specific-input-major': pair('var(--dsw-static-neutral-bluish-00)', '#182030'),
  '--dsw-specific-bubble': pair('#f0f2f5', '#1c2535'),
  '--dsw-specific-sidebar-nav-item-active-accent': pair('#e9ecf1', '#1f2839'),
  '--dsw-specific-selector': pair('var(--dsw-static-neutral-bluish-60)', '#222c3f'),
  '--dsw-specific-tip': pair('var(--dsw-static-neutral-bluish-60)', '#222c3f'),
  '--dsw-specific-login-input': pair('var(--dsw-static-neutral-bluish-50)', '#101621'),
  '--dsw-specific-guide-hero': pair('var(--dsw-static-neutral-200)', '#26314a'),
  '--dsw-alias-button-elevated-fill': pair('var(--dsw-static-neutral-bluish-00)', '#1d2637'),
  '--dsw-alias-button-floating-fill': pair('var(--dsw-static-neutral-bluish-00)', '#1c2535'),
  '--dsw-alias-button-floating-hover': pair('var(--dsw-static-neutral-bluish-75)', '#253045'),
  '--dsw-alias-interactive-bg-hover-solid': pair('var(--dsw-static-neutral-bluish-75)', '#222c3f'),
  '--dsw-alias-hovercard-bg': pair('var(--dsw-static-neutral-bluish-850)', '#1c2535'),
  '--dsw-alias-tooltip-bg': pair('var(--dsw-static-neutral-bluish-850)', '#2a354b'),
  '--dsw-alias-bg-multi-select': pair('var(--dsw-static-neutral-bluish-60)', '#1a2131'),
  '--dsw-alias-bg-document-preview': pair('var(--dsw-static-neutral-bluish-100)', '#111724'),
  '--dsw-alias-illustration-background': pair('var(--dsw-static-neutral-bluish-55)', '#1c2535'),
  '--dsw-alias-onboarding-secondary-fill': pair('var(--dsw-static-neutral-bluish-00)', '#2a354b'),
  '--dsw-alias-markdown-inline-code': pair('var(--dsw-static-neutral-50)', '#1c2433'),
  '--dsw-alias-markdown-code-block-banner': pair('var(--dsw-static-neutral-bluish-50)', '#131a27'),
  '--dsw-alias-markdown-code-segment-selected': pair('var(--dsw-static-neutral-bluish-00)', '#253045'),
  '--dsw-alias-markdown-code-segment-unselected': pair('var(--dsw-static-neutral-bluish-75)', '#101621'),
  '--dsw-alias-markdown-citation': pair('var(--dsw-static-neutral-bluish-100)', '#253045'),
  '--dsw-alias-markdown-placeholder': pair('var(--dsw-static-neutral-bluish-60)', '#1c2535'),
  '--dsw-alias-markdown-tag': pair('var(--dsw-static-neutral-bluish-75)', '#1c2535'),
  // Slimmer-looking scrollbars: quieter thumbs in both modes.
  '--dsw-alias-scrollbar-bg-l1': pair('rgba(15, 23, 42, 0.12)', '#263046'),
  '--dsw-alias-scrollbar-bg-l2': pair('rgba(15, 23, 42, 0.18)', '#33405a'),
  '--dsw-alias-scrollbar-hover-l1': pair('rgba(15, 23, 42, 0.24)', '#33405a'),
  '--dsw-alias-scrollbar-hover-l2': pair('rgba(15, 23, 42, 0.30)', '#44516d'),
}

/** Touches the theme tokens cannot reach: text selection. */
export const THEME_STYLE = [
  '::selection{background:rgba(229,181,74,.28)}',
  'body[data-ds-dark-theme] ::selection{background:rgba(229,181,74,.32)}',
].join('')
