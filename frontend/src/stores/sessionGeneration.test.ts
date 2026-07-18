import { describe, expect, it } from 'vitest'
import { bumpSessionGeneration, currentSessionGeneration } from './sessionGeneration'

describe('sessionGeneration', () => {
  it('advances monotonically on each bump', () => {
    const start = currentSessionGeneration()
    bumpSessionGeneration()
    expect(currentSessionGeneration()).toBe(start + 1)
    bumpSessionGeneration()
    expect(currentSessionGeneration()).toBe(start + 2)
  })
})
