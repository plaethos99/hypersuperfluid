/**
 * What a file view says when its file cannot be read (moved, deleted, or refused), instead of loading forever: the
 * file resource then has no value and a failure.
 * @module hypersuperfluid/client/unreadable
 */

/** The part of a resource snapshot this needs. */
export interface FileSnapshot {
  readonly status: string
  readonly value: unknown
  readonly failure?: { readonly message: string } | undefined
}

/**
 * @param snapshot - the file resource's state.
 * @returns a message when the file cannot be read, else undefined.
 */
export function unreadableMessage(snapshot: FileSnapshot): string | undefined {
  if (snapshot.value !== undefined || snapshot.status !== 'failed') return undefined
  const reason = snapshot.failure?.message.trim()
  return `This file can't be opened${reason === undefined || reason === '' ? '' : ` (${reason.replace(/\.$/u, '')})`}. It may have been moved or deleted.`
}

/** How the message is laid out: centred in the tab, in the secondary label colour. */
export const UNREADABLE_STYLE = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: 24, boxSizing: 'border-box',
  textAlign: 'center', color: 'var(--dsw-alias-label-secondary)',
} as const
