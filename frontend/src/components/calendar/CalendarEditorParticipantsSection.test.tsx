// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CalendarEditorParticipantsSection } from './CalendarEditorParticipantsSection'

vi.mock('../../api/dashboards', () => ({
  apiListDashboardMembers: vi.fn(),
}))

import { apiListDashboardMembers } from '../../api/dashboards'

const mockedList = vi.mocked(apiListDashboardMembers)

function member(name: string) {
  return { user_id: `id-${name}`, display_name: name }
}

beforeEach(() => {
  mockedList.mockReset()
})

describe('CalendarEditorParticipantsSection', () => {
  it('lists members as toggle chips and reports toggles', async () => {
    mockedList.mockResolvedValue([member('Owner'), member('Zoe')])
    const onToggle = vi.fn()
    render(
      <CalendarEditorParticipantsSection
        dashboardId="d1"
        selected={[]}
        initialParticipants={[]}
        onToggle={onToggle}
      />,
    )

    const zoe = await screen.findByRole('button', { name: /Zoe/ })
    expect(zoe).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(zoe)
    expect(onToggle).toHaveBeenCalledWith('id-Zoe')
  })

  it('renders a selected former member as a removable greyed chip', async () => {
    mockedList.mockResolvedValue([member('Owner'), member('Ada')])
    const onToggle = vi.fn()
    render(
      <CalendarEditorParticipantsSection
        dashboardId="d1"
        selected={['id-Zoe']}
        initialParticipants={[{ user_id: 'id-Zoe', display_name: 'Zoe' }]}
        onToggle={onToggle}
      />,
    )

    const former = await screen.findByRole('button', { name: /Zoe.*former/ })
    expect(former).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(former)
    expect(onToggle).toHaveBeenCalledWith('id-Zoe')
  })

  it('a deselected former member disappears rather than becoming addable', async () => {
    mockedList.mockResolvedValue([member('Owner'), member('Ada')])
    render(
      <CalendarEditorParticipantsSection
        dashboardId="d1"
        selected={[]}
        initialParticipants={[{ user_id: 'id-Zoe', display_name: 'Zoe' }]}
        onToggle={vi.fn()}
      />,
    )

    await screen.findByRole('button', { name: /Ada/ })
    expect(screen.queryByRole('button', { name: /Zoe/ })).not.toBeInTheDocument()
  })

  it('hides rather than mislabels when the members fetch fails', async () => {
    mockedList.mockRejectedValue(new Error('boom'))
    const { container } = render(
      <CalendarEditorParticipantsSection
        dashboardId="d1"
        selected={['id-Ada']}
        initialParticipants={[{ user_id: 'id-Ada', display_name: 'Ada' }]}
        onToggle={vi.fn()}
      />,
    )

    // With an empty member list Ada would render greyed "(former)" — a current member, lied about.
    await waitFor(() => expect(mockedList).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the caller is alone on the dashboard', async () => {
    mockedList.mockResolvedValue([member('Owner')])
    const { container } = render(
      <CalendarEditorParticipantsSection
        dashboardId="d1"
        selected={[]}
        initialParticipants={[]}
        onToggle={vi.fn()}
      />,
    )

    await waitFor(() => expect(mockedList).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
