// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { makeListItem } from '../../test/fixtures'
import { ListItemRow } from './ListItemRow'

function renderRow(item = makeListItem({ text: 'Buy milk' }), overrides = {}) {
  const handlers = {
    onToggleChecked: vi.fn().mockResolvedValue(undefined),
    onRename: vi.fn().mockResolvedValue(undefined),
    onSetDueDate: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
  render(
    <ul>
      <ListItemRow item={item} {...handlers} />
    </ul>,
  )
  return handlers
}

describe('ListItemRow due dates', () => {
  it('offers a way to set a due date when the item has none', () => {
    renderRow()
    expect(screen.getByRole('button', { name: 'Set due date' })).toBeInTheDocument()
  })

  it('sends the picked day as a bare YYYY-MM-DD string', async () => {
    // The backend column is a DATE and the agenda compares it as a string, so a timestamp here
    // would break the TODAY/OVERDUE split.
    const handlers = renderRow()

    fireEvent.click(screen.getByRole('button', { name: 'Set due date' }))
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-08-04' } })

    expect(handlers.onSetDueDate).toHaveBeenCalledWith('item-1', '2026-08-04')
  })

  it('clearing the input sends null rather than an empty string', async () => {
    const handlers = renderRow(makeListItem({ due_date: '2026-08-04' }))

    fireEvent.click(screen.getByRole('button', { name: /Change due date/ }))
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '' } })

    // An empty string would fail contract validation; null is what clears the column.
    expect(handlers.onSetDueDate).toHaveBeenCalledWith('item-1', null)
  })

  it('shows an existing due date without shifting it a day', () => {
    // `new Date('2026-08-04')` is UTC midnight, which renders as 3 Aug anywhere west of
    // Greenwich. The value is a calendar day and has to display as the day that was picked.
    renderRow(makeListItem({ due_date: '2026-08-04' }))
    expect(screen.getByRole('button', { name: /Change due date/ })).toHaveTextContent('Aug 4')
  })

  it('does not flag a checked item as overdue', () => {
    // A done item with a past date needs no attention, so it must not be styled as outstanding.
    renderRow(makeListItem({ due_date: '2020-01-01', checked: true }))
    const badge = screen.getByRole('button', { name: /Change due date/ })
    expect(badge.className).not.toContain('text-red-400')
  })

  it('flags an unchecked past-due item as overdue', () => {
    renderRow(makeListItem({ due_date: '2020-01-01', checked: false }))
    const badge = screen.getByRole('button', { name: /Change due date/ })
    expect(badge.className).toContain('text-red-400')
  })

  it('the date control is reachable without disturbing the text editor', () => {
    // The text input saves on blur. If the picker lived inside the editor, clicking it would
    // submit the rename and unmount the picker before a date could be chosen.
    const handlers = renderRow()

    fireEvent.click(screen.getByRole('button', { name: 'Set due date' }))

    expect(screen.getByLabelText('Due date')).toBeInTheDocument()
    expect(handlers.onRename).not.toHaveBeenCalled()
  })
})
