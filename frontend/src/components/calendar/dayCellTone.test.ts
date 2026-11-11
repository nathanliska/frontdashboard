import { expect, it } from 'vitest'
import { dayCellTone } from './dayCellTone'

it('draws no border on an ordinary day, and gives today a top edge', () => {
  expect(dayCellTone({ isToday: false })).toBe('border-transparent bg-zinc-950/40')
  expect(dayCellTone({ isToday: true })).toContain('shadow-[inset')
  // Selected wins the border, but today keeps its edge under it.
  expect(dayCellTone({ isToday: true, isSelected: true })).toMatch(
    /^border-sky-500\/40 .*shadow-\[inset/,
  )
})
