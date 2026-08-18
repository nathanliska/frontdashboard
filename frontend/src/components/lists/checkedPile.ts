import { useSyncExternalStore } from 'react'
import type { ListItem } from '../../api/lists'

/** The one dedupe rule every add box shares: trimmed, case-insensitive equality. */
export function matchesItemText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * The row a re-typed name resurrects, on every surface: the FIRST match in list
 * order, so two same-named rows (possible on purpose, via Escape) resolve the same
 * way in the widget as on the list page.
 */
export function findCheckedMatch(items: ListItem[], text: string): ListItem | undefined {
  return partitionItems(items).pile.find((item) => matchesItemText(item.text, text))
}

/**
 * Split items into the active zone and the checked pile, both in stored order.
 *
 * Display-only: neither half's `sort_order` is touched, which is what lets an
 * unchecked item land back at its remembered place in the active zone — and why
 * the pile keeps the order the user dragged rather than one the app invents.
 */
export function partitionItems(items: ListItem[]): { active: ListItem[]; pile: ListItem[] } {
  const active: ListItem[] = []
  const pile: ListItem[] = []
  for (const item of items) {
    ;(item.checked ? pile : active).push(item)
  }
  return { active, pile }
}

/**
 * Rebuild the full ordered id set the reorder endpoint requires from a drag
 * within the active zone: checked items hold their stored positions, and the
 * gaps are filled with the new active order.
 *
 * Returns null when the drag snapshot no longer lines up with `items` — someone
 * checked or removed a row mid-drag. The caller must resync rather than submit,
 * because the nearest valid id set is the stored order, and sending that would
 * discard the drag behind a silent 204.
 */
export function mergeActiveOrder(items: ListItem[], activeIds: string[]): string[] | null {
  const queue = [...activeIds]
  const merged = items.map((item) => (item.checked ? item.id : (queue.shift() ?? '')))
  if (queue.length > 0 || merged.includes('')) return null
  return merged
}

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // Private modes may refuse storage; the toggle then just doesn't persist.
  }
}

// Same-tab writers notify through this set; the 'storage' event only covers other tabs.
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback)
  window.addEventListener('storage', callback)
  return () => {
    listeners.delete(callback)
    window.removeEventListener('storage', callback)
  }
}

/** Pile display is a per-device preference: on unless explicitly switched off. */
function isPileEnabled(listId: string): boolean {
  return storageGet(`listPile:${listId}`) !== '0'
}

export function setPileEnabled(listId: string, enabled: boolean): void {
  storageSet(`listPile:${listId}`, enabled ? null : '0')
  emit()
}

/** Collapsed by default: the pile is reference material, not the working set. */
function isPileExpanded(listId: string): boolean {
  return storageGet(`listPileExpanded:${listId}`) === '1'
}

export function setPileExpanded(listId: string, expanded: boolean): void {
  storageSet(`listPileExpanded:${listId}`, expanded ? '1' : null)
  emit()
}

/**
 * Subscribed reads, so every surface re-renders on a toggle — and, because the
 * snapshot closes over `listId`, a route param change re-reads the new list's
 * preference where a useState initializer would have kept the old one.
 */
export function usePileEnabled(listId: string): boolean {
  return useSyncExternalStore(subscribe, () => isPileEnabled(listId))
}

export function usePileExpanded(listId: string): boolean {
  return useSyncExternalStore(subscribe, () => isPileExpanded(listId))
}
