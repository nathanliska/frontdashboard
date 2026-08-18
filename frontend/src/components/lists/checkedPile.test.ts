import { describe, expect, it } from 'vitest'
import { makeListItem } from '../../test/fixtures'
import { findCheckedMatch, matchesItemText, mergeActiveOrder, partitionItems } from './checkedPile'

describe('partitionItems', () => {
  it('splits the zones without reordering either', () => {
    const items = [
      makeListItem({ id: 'a', sort_order: 0 }),
      makeListItem({ id: 'b', sort_order: 1, checked: true }),
      makeListItem({ id: 'c', sort_order: 2 }),
      makeListItem({ id: 'd', sort_order: 3, checked: true }),
    ]
    const { active, pile } = partitionItems(items)
    expect(active.map((i) => i.id)).toEqual(['a', 'c'])
    // The order the user set, kept: the pile is the rest of the list, not a log of one trip.
    expect(pile.map((i) => i.id)).toEqual(['b', 'd'])
  })

  it('never re-sorts, so it cannot disagree with the order the server sent', () => {
    // sort_order deliberately contradicts the array order. The server orders the rows; a
    // partition that sorted by any field of its own would silently reshuffle them here.
    const items = [
      makeListItem({ id: 'second', sort_order: 9, checked: true }),
      makeListItem({ id: 'first', sort_order: 0, checked: true }),
    ]
    expect(partitionItems(items).pile.map((i) => i.id)).toEqual(['second', 'first'])
  })
})

describe('mergeActiveOrder', () => {
  it('holds checked items at their stored positions while actives reorder around them', () => {
    const items = [
      makeListItem({ id: 'a', sort_order: 0 }),
      makeListItem({ id: 'b', sort_order: 1, checked: true }),
      makeListItem({ id: 'c', sort_order: 2 }),
      makeListItem({ id: 'd', sort_order: 3 }),
    ]
    // Drag "d" above "a" in the active zone: full set keeps "b" second.
    expect(mergeActiveOrder(items, ['d', 'a', 'c'])).toEqual(['d', 'b', 'a', 'c'])
  })

  it('is the identity when nothing is checked', () => {
    const items = [
      makeListItem({ id: 'a', sort_order: 0 }),
      makeListItem({ id: 'b', sort_order: 1 }),
    ]
    expect(mergeActiveOrder(items, ['b', 'a'])).toEqual(['b', 'a'])
  })

  it('refuses the merge when a row was checked mid-drag', () => {
    const items = [
      makeListItem({ id: 'a', sort_order: 0 }),
      makeListItem({ id: 'b', sort_order: 1, checked: true }),
      makeListItem({ id: 'c', sort_order: 2 }),
    ]
    // The drag started while "b" was still active, so its id has nowhere to land.
    expect(mergeActiveOrder(items, ['c', 'b', 'a'])).toBeNull()
  })

  it('refuses the merge when a row was removed mid-drag', () => {
    const items = [
      makeListItem({ id: 'a', sort_order: 0 }),
      makeListItem({ id: 'c', sort_order: 2 }),
    ]
    expect(mergeActiveOrder(items, ['c', 'b', 'a'])).toBeNull()
  })
})

describe('matchesItemText', () => {
  it('is trimmed and case-insensitive', () => {
    expect(matchesItemText('  Milk ', 'milk')).toBe(true)
    expect(matchesItemText('Milk', 'Milkshake')).toBe(false)
  })
})

describe('findCheckedMatch', () => {
  it('resurrects the first of two same-named rows in list order, on any surface', () => {
    const items = [
      makeListItem({ id: 'first', text: 'Milk', sort_order: 0, checked: true }),
      makeListItem({ id: 'active', text: 'Eggs', sort_order: 1 }),
      makeListItem({ id: 'second', text: 'milk', sort_order: 2, checked: true }),
    ]
    expect(findCheckedMatch(items, ' MILK ')?.id).toBe('first')
    expect(findCheckedMatch(items, 'Eggs')).toBeUndefined()
  })
})
