import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { CSSProperties, ReactNode } from 'react'

export type SortableRow = {
  setNodeRef: (node: HTMLElement | null) => void
  style: CSSProperties
  attributes: Partial<DraggableAttributes>
  listeners: DraggableSyntheticListeners
  isDragging: boolean
}

/**
 * Compute the reordered id array for a drag-end move, or null when it's a
 * no-op / unresolvable (activeId === overId, or either id not found).
 *
 * Uses dnd-kit's standard arrayMove semantics: remove the active item, then
 * insert it at the over item's index (as computed in the original array).
 */
export function reorderIds(ids: string[], activeId: string, overId: string): string[] | null {
  if (activeId === overId) return null
  const from = ids.indexOf(activeId)
  const to = ids.indexOf(overId)
  if (from === -1 || to === -1) return null
  const next = [...ids]
  next.splice(to, 0, next.splice(from, 1)[0])
  return next
}

export function useSortableRow(id: string, disabled?: boolean): SortableRow {
  const { setNodeRef, transform, transition, attributes, listeners, isDragging } = useSortable({
    id,
    disabled,
  })
  return {
    setNodeRef,
    style: { transform: CSS.Transform.toString(transform), transition } as const,
    attributes,
    listeners,
    isDragging,
  }
}

export function SortableList<T extends { id: string }>({
  items,
  onReorder,
  children,
  disabled = false,
}: {
  items: T[]
  onReorder: (orderedIds: string[]) => void
  children: (item: T) => ReactNode
  disabled?: boolean
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over) return
    const ids = items.map((i) => i.id)
    const next = reorderIds(ids, String(active.id), String(over.id))
    if (next) onReorder(next)
  }

  if (disabled) {
    return <>{items.map((item) => children(item))}</>
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        {items.map((item) => children(item))}
      </SortableContext>
    </DndContext>
  )
}
