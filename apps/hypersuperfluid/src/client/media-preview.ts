/**
 * Video and audio previews in the right sidebar. The player streams the file from the app's authenticated file
 * route (`/api/file`), so nothing is read into memory first. That route serves files up to the app's media size
 * limit; a larger or unplayable file shows a short explanation instead of a broken player.
 * @module hypersuperfluid/client/media-preview
 */

import { createElement as h, useEffect, useState, type ReactNode } from 'react'
import type { DocumentPreviewDefinition, DocumentPreviewProps } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { UNREADABLE_STYLE, unreadableMessage } from './unreadable.ts'
import { fileMediaUrl } from '@deepseek-ai/dsh-util-workspace-path'

/** Renderer identity, shared by the definition and its keyed body. */
export const MEDIA_PREVIEW_ID = '@deepseek-ai/dsh-hypersuperfluid/media-preview'

/** Video suffixes the browser engine plays. */
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'mov', 'ogv'] as const
/** Audio suffixes the browser engine plays. */
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus'] as const

/** The preview definition. */
export const mediaPreviewDefinition: DocumentPreviewDefinition = {
  id: MEDIA_PREVIEW_ID,
  extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS],
  binaryExtensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS],
  priority: 'extension',
  title: () => 'Player',
  loading: 'renderer',
  wrap: false,
}

/** The suffix of a path, lower-cased. */
export function extensionOf(path: string): string {
  const name = path.replaceAll('\\', '/').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Whether a suffix is audio rather than video. */
export function isAudio(path: string): boolean {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(extensionOf(path))
}

const BOX = 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100%;padding:16px;box-sizing:border-box'

/**
 * The player body.
 * @param props - the standard document props.
 * @returns a video or audio element, or a message.
 */
export function MediaPreviewBody(props: DocumentPreviewProps): ReactNode {
  const { content, resourceAddress, useResource } = props
  const resource = useResource<'file'>(resourceAddress)
  const file = resource.value
  const unreadable = unreadableMessage(resource)
  const [failed, setFailed] = useState(false)
  const path = file?.absolutePath
  const url = path === undefined ? undefined : fileMediaUrl(document.baseURI, path)
  const revision = content.kind === 'renderer' ? content.revision : 0
  useEffect(() => { setFailed(false) }, [url, revision])
  if (content.kind !== 'renderer') return null
  if (unreadable !== undefined) return h('div', { style: UNREADABLE_STYLE }, unreadable)
  if (file === undefined) return h('div', { style: cssOf(BOX) }, 'Loading…')
  if (url === undefined) {
    return h('div', { style: cssOf(BOX) }, 'This file can only be played from the app on the computer that holds it.')
  }
  if (failed) {
    return h('div', { style: cssOf(BOX) },
      h('div', null, 'This file can\'t be played here.'),
      h('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, textAlign: 'center' } },
        'It may be larger than the preview limit or use a codec the app can\'t decode. Open it in your media player instead.'))
  }
  const media = {
    src: url, controls: true, preload: 'metadata',
    onLoadedMetadata: () => { content.loaded(file.version) },
    onError: () => { setFailed(true); content.failed() },
  }
  return h('div', { style: cssOf(BOX) },
    isAudio(path ?? '')
      ? h('audio', { ...media, style: { width: '100%', maxWidth: 560 } })
      : h('video', { ...media, playsInline: true, style: { maxWidth: '100%', maxHeight: '100%', borderRadius: 8, background: '#000' } }))
}

/** Turns a `a:b;c:d` style string into a React style object. */
export function cssOf(style: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon <= 0) continue
    const name = declaration.slice(0, colon).trim().replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase())
    result[name] = declaration.slice(colon + 1).trim()
  }
  return result
}
