/**
 * Reading text out of model content.
 * @module hypersuperfluid/content
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/**
 * @param blocks - a child's output or a tool's content.
 * @returns its text blocks joined, leaving out images and other kinds.
 */
export function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}
