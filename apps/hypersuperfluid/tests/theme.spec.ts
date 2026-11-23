import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TOKENS } from '../src/client/theme.ts'

/** Reads the `--dsw-*` values of one rule in the Web shell's first-paint stylesheet. */
function firstPaint(selector: string): Record<string, string> {
  const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8')
  const start = html.indexOf(`${selector} {`)
  expect(start, `apps/web/index.html has a "${selector}" rule`).toBeGreaterThanOrEqual(0)
  const body = html.slice(start, html.indexOf('}', start))
  const declarations = [...body.matchAll(/(--dsw-[a-z0-9-]+):\s*([^;]+);/gu)]
  return Object.fromEntries(declarations.map(match => [match[1] as string, (match[2] as string).trim()]))
}

describe('Hypersuperfluid palette', () => {
  it('names a value for both palettes of every --dsw token', () => {
    expect(Object.keys(TOKENS).length).toBeGreaterThan(20)
    for (const [name, modes] of Object.entries(TOKENS)) {
      expect(name).toMatch(/^--dsw-(?:alias|specific)-[a-z0-9-]+$/u)
      expect(modes.light.trim()).not.toBe('')
      expect(modes.dark.trim()).not.toBe('')
    }
  })

  it('paints the first frame of the Web shell in the same colours', () => {
    const light = firstPaint('html body')
    const dark = firstPaint('html body[data-ds-dark-theme]')
    expect(Object.keys(light).length).toBeGreaterThanOrEqual(5)
    expect(Object.keys(dark)).toEqual(Object.keys(light))
    for (const [name, value] of Object.entries(light)) expect(value, `${name} (light)`).toBe(TOKENS[name as keyof typeof TOKENS]?.light)
    for (const [name, value] of Object.entries(dark)) expect(value, `${name} (dark)`).toBe(TOKENS[name as keyof typeof TOKENS]?.dark)
  })
})
