// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { reorderIds, SortableList } from './SortableList'

describe('SortableList', () => {
  it('renders its children in order', () => {
    const items = [{ id: 'a' }, { id: 'b' }]
    const { getByText } = render(
      <SortableList items={items} onReorder={() => {}}>
        {(item) => <div>{item.id}</div>}
      </SortableList>,
    )
    expect(getByText('a')).toBeTruthy()
    expect(getByText('b')).toBeTruthy()
  })
})

describe('reorderIds', () => {
  it('moves an item forward (dragged onto a later item)', () => {
    // Dragging 'a' onto 'c': 'a' is removed and inserted at c's position.
    expect(reorderIds(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a'])
  })

  it('moves an item backward (dragged onto an earlier item)', () => {
    // Dragging 'c' onto 'a': 'c' is removed and inserted at a's position.
    expect(reorderIds(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
  })

  it('swaps adjacent items', () => {
    expect(reorderIds(['a', 'b', 'c'], 'a', 'b')).toEqual(['b', 'a', 'c'])
    expect(reorderIds(['a', 'b', 'c'], 'b', 'c')).toEqual(['a', 'c', 'b'])
  })

  it('moves an item across multiple positions in a larger list', () => {
    expect(reorderIds(['a', 'b', 'c', 'd', 'e'], 'a', 'd')).toEqual(['b', 'c', 'd', 'a', 'e'])
    expect(reorderIds(['a', 'b', 'c', 'd', 'e'], 'e', 'b')).toEqual(['a', 'e', 'b', 'c', 'd'])
  })

  it('returns null when activeId === overId (no-op drag)', () => {
    expect(reorderIds(['a', 'b', 'c'], 'b', 'b')).toBeNull()
  })

  it('returns null when activeId is not found', () => {
    expect(reorderIds(['a', 'b', 'c'], 'zzz', 'b')).toBeNull()
  })

  it('returns null when overId is not found', () => {
    expect(reorderIds(['a', 'b', 'c'], 'a', 'zzz')).toBeNull()
  })
})
