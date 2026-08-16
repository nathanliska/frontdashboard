import { describe, expect, it } from 'vitest'
import { participantColor, participantInitial } from './participantPalette'

describe('participantColor', () => {
  it('is deterministic: the same id always maps to the same color', () => {
    const id = 'e6f9a2b4-0000-4000-8000-1234567890ab'
    expect(participantColor(id)).toBe(participantColor(id))
  })

  it('returns a hex color for any id', () => {
    for (const id of ['a', 'b', 'c', 'e6f9a2b4-0000-4000-8000-1234567890ab']) {
      expect(participantColor(id)).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})

describe('participantInitial', () => {
  it('upper-cases the first character and survives blanks', () => {
    expect(participantInitial('miranda')).toBe('M')
    expect(participantInitial('  zoe')).toBe('Z')
    expect(participantInitial('')).toBe('?')
    expect(participantInitial('   ')).toBe('?')
  })
})
