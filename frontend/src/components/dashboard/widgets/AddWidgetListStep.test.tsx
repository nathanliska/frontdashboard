// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { makeListSummary } from '../../../test/fixtures'
import { AddWidgetListStep } from './AddWidgetListStep'

vi.mock('../../../resources/listData', () => ({
  useListSummaries: () => ({
    data: [makeListSummary({ id: 'list-7', name: 'Groceries' })],
    loading: false,
  }),
}))

describe('AddWidgetListStep', () => {
  it('names an existing list by list_id, the field the server keys on', () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(
      <AddWidgetListStep
        dashboardId="dash-1"
        existingListIds={[]}
        isSharedDashboard={false}
        onAdd={onAdd}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Groceries/ }))

    expect(onAdd).toHaveBeenCalledWith({
      widget_type: 'list',
      list_id: 'list-7',
      config: { list_name: 'Groceries', list_type: 'checklist' },
    })
  })

  it('names no list when creating one, leaving the server to bind what it makes', () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(
      <AddWidgetListStep
        dashboardId="dash-1"
        existingListIds={[]}
        isSharedDashboard={false}
        onAdd={onAdd}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('Groceries'), { target: { value: 'Errands' } })
    fireEvent.click(screen.getByRole('button', { name: /Create list widget/ }))

    expect(onAdd).toHaveBeenCalledWith({
      widget_type: 'list',
      config: { name: 'Errands', list_type: 'checklist' },
    })
  })
})
