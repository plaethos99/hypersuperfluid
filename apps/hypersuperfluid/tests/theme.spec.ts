import { describe, expect, it } from 'vitest'
import { TOKENS } from '../src/client/theme.ts'

describe('Hypersuperfluid palette', () => {
  it('names a value for both palettes of every --dsw token', () => {
    expect(Object.keys(TOKENS).length).toBeGreaterThan(20)
    for (const [name, modes] of Object.entries(TOKENS)) {
      expect(name).toMatch(/^--dsw-(?:alias|specific)-[a-z0-9-]+$/u)
      expect(modes.light.trim()).not.toBe('')
      expect(modes.dark.trim()).not.toBe('')
    }
  })
})
