// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleMembersResourceEvent, resetMembersData, useDashboardMembers } from './membersData'

const { apiListDashboardMembers } = vi.hoisted(() => ({
  apiListDashboardMembers: vi.fn(),
}))

vi.mock('../api/dashboards', () => ({
  apiListDashboardMembers,
}))

function member(name: string) {
  return { user_id: `id-${name}`, display_name: name }
}

function MembersProbe() {
  const { data } = useDashboardMembers('dash-1')
  return (
    <div>
      {(data ?? []).map((m) => (
        <p key={m.user_id}>{m.display_name}</p>
      ))}
    </div>
  )
}

describe('membersData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetMembersData()
  })

  it('serves reopens from cache: one fetch across two mounts', async () => {
    apiListDashboardMembers.mockResolvedValue([member('Nathan'), member('Lilo')])

    const first = render(<MembersProbe />)
    await screen.findByText('Nathan')
    first.unmount()

    render(<MembersProbe />)
    await screen.findByText('Nathan')

    expect(apiListDashboardMembers).toHaveBeenCalledTimes(1)
  })

  it('refetches the roster when a share event names the dashboard', async () => {
    apiListDashboardMembers
      .mockResolvedValueOnce([member('Nathan')])
      .mockResolvedValueOnce([member('Nathan'), member('Newcomer')])

    render(<MembersProbe />)
    await screen.findByText('Nathan')

    act(() => {
      handleMembersResourceEvent({
        event_id: 1,
        event_type: 'dashboard.share_added',
        entity_type: 'dashboard',
        entity_id: 'dash-1',
        entity_version: 1,
        actor_id: 'someone-else',
        actor_display_name: 'Someone Else',
        payload: { dashboard_id: 'dash-1' },
        created_at: '2026-04-05T00:00:01Z',
      })
    })

    await screen.findByText('Newcomer')
    expect(apiListDashboardMembers).toHaveBeenCalledTimes(2)
  })

  it('leaves other dashboards’ rosters alone', async () => {
    apiListDashboardMembers.mockResolvedValue([member('Nathan')])

    render(<MembersProbe />)
    await screen.findByText('Nathan')

    act(() => {
      handleMembersResourceEvent({
        event_id: 1,
        event_type: 'dashboard.share_removed',
        entity_type: 'dashboard',
        entity_id: 'dash-other',
        entity_version: 1,
        actor_id: 'someone-else',
        actor_display_name: 'Someone Else',
        payload: { dashboard_id: 'dash-other' },
        created_at: '2026-04-05T00:00:01Z',
      })
    })

    await waitFor(() => expect(apiListDashboardMembers).toHaveBeenCalledTimes(1))
  })
})
