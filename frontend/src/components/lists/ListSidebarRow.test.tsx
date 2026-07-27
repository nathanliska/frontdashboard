// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ListSummary } from '../../api/lists'
import { ListSidebarRow } from './ListSidebarRow'

function makeList(
  overrides: Partial<ListSummary> = {},
): Pick<ListSummary, 'id' | 'name' | 'list_type' | 'item_count'> {
  return {
    id: 'a',
    name: 'A',
    list_type: 'todo',
    item_count: 0,
    ...overrides,
  }
}

describe('ListSidebarRow drag handle keyboard wiring', () => {
  it("invokes dnd-kit's onKeyDown activator AND suppresses row navigation on the same keydown", () => {
    const onKeyDown = vi.fn()
    const onSelect = vi.fn()

    render(
      <ListSidebarRow
        list={makeList()}
        selectedId={null}
        onSelect={onSelect}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        sortable={{
          setNodeRef: () => {},
          style: {},
          attributes: {},
          listeners: { onKeyDown },
          isDragging: false,
        }}
      />,
    )

    const handle = screen.getByLabelText('Reorder list')
    fireEvent.keyDown(handle, { key: ' ' })

    // dnd-kit's KeyboardSensor activator must still fire (keyboard drag pickup).
    expect(onKeyDown).toHaveBeenCalledTimes(1)
    // The row's own navigation handler must not fire for a keydown on the handle.
    expect(onSelect).not.toHaveBeenCalled()
  })
})
