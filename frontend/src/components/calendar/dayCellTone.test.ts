import { expect, it } from 'vitest'
import { dayCellTone } from './dayCellTone'

it('draws no border on an ordinary day, and lets selection win over today', () => {
  expect(dayCellTone({ isToday: false })).toBe('border-transparent bg-zinc-950/40')
  expect(dayCellTone({ isToday: true })).toBe('border-zinc-600 bg-zinc-900')
  expect(dayCellTone({ isToday: true, isSelected: true })).toBe('border-sky-500/40 bg-sky-500/6')
})
