import type { ReactNode } from 'react'
import type { Mock } from 'vitest'

type SortableListProps = {
  items: { id: string }[]
  onReorder: (orderedIds: string[]) => void
  children: (item: { id: string }) => ReactNode
  disabled?: boolean
}

/**
 * A deterministic stand-in for `SortableList` / `useSortableRow`.
 *
 * SortableList's own drag-end → `onReorder(orderedIds)` math is covered by SortableList.test.tsx,
 * and simulating a real dnd-kit keyboard drag in jsdom is flaky. This replacement still renders
 * every row through the caller's `children`, so per-row handle assertions exercise the real page
 * and row logic, and it captures the `disabled` flag and `onReorder` callback the page wired up so
 * a test can invoke that callback directly.
 *
 * Use from a `vi.mock` factory, passing a spy created with `vi.hoisted`:
 *
 *     vi.mock('../components/lists/SortableList', async () => {
 *       const { sortableListMock } = await import('../test/sortable-list')
 *       return sortableListMock(sortableListSpy)
 *     })
 */
export function sortableListMock(spy: Mock) {
  return {
    SortableList: (props: SortableListProps) => {
      spy(props.disabled, props.onReorder)
      return props.items.map((item) => props.children(item))
    },
    useSortableRow: (_id: string, disabled?: boolean) => ({
      setNodeRef: () => {},
      style: {},
      attributes: {},
      listeners: {},
      isDragging: false,
      disabled,
    }),
  }
}

/** The `onReorder` callback the component under test handed to SortableList. */
export function capturedOnReorder(spy: Mock): (orderedIds: string[]) => void {
  return spy.mock.calls[0][1] as (orderedIds: string[]) => void
}
