import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { apiGetActivity } from '../api/notifications'
import { APP_RESYNC_EVENT } from '../hooks/useSSE'
import { useNotificationsStore } from '../stores/notifications'
import { NotificationsPage } from './NotificationsPage'

vi.mock('../api/notifications', async () => {
  const actual =
    await vi.importActual<typeof import('../api/notifications')>('../api/notifications')
  return {
    ...actual,
    apiGetActivity: vi.fn(),
  }
})

const mockedApiGetActivity = vi.mocked(apiGetActivity)

describe('NotificationsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    useNotificationsStore.setState({
      notifications: [
        {
          id: 'notif-1',
          type: 'dashboard.share_added',
          title: 'Dashboard shared with you',
          body: 'Alex gave you viewer access to "Roadmap".',
          reference_type: 'dashboard',
          reference_id: 'dash-1',
          read_at: null,
          created_at: '2026-04-06T12:00:00.000Z',
        },
        {
          id: 'notif-2',
          type: 'dashboard.share_removed',
          title: 'Dashboard access removed',
          body: 'Alex removed your access to "Roadmap".',
          reference_type: 'dashboard',
          reference_id: 'dash-1',
          read_at: null,
          created_at: '2026-04-06T12:05:00.000Z',
        },
      ],
      unreadCount: 2,
      panelOpen: false,
      load: vi.fn().mockResolvedValue(undefined),
      loadUnreadCount: vi.fn().mockResolvedValue(undefined),
      markRead: vi.fn().mockResolvedValue(undefined),
      markAllRead: vi.fn().mockResolvedValue(undefined),
      setPanelOpen: vi.fn(),
      addFromSse: vi.fn(),
    })
  })

  it('reloads the activity tab when a resync occurs', async () => {
    mockedApiGetActivity
      .mockResolvedValueOnce([
        {
          event_id: 1,
          event_type: 'dashboard.share_added',
          entity_type: 'dashboard',
          entity_id: 'dash-1',
          actor_id: 'user-1',
          actor_display_name: 'Example User',
          payload: { dashboard_name: 'Roadmap', role: 'viewer' },
          created_at: '2026-04-06T12:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          event_id: 2,
          event_type: 'list.created',
          entity_type: 'list',
          entity_id: 'list-1',
          actor_id: 'user-1',
          actor_display_name: 'Example User',
          payload: { name: 'Chores' },
          created_at: '2026-04-06T12:05:00.000Z',
        },
      ])

    render(
      <MemoryRouter initialEntries={['/notifications']}>
        <Routes>
          <Route path="/notifications" element={<NotificationsPage />} />
        </Routes>
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: /^activity$/i }))

    await screen.findByText('You granted viewer access to "Roadmap".')

    act(() => {
      window.dispatchEvent(new Event(APP_RESYNC_EVENT))
    })

    await screen.findByText('You created "Chores".')
    await waitFor(() => {
      expect(mockedApiGetActivity).toHaveBeenCalledTimes(2)
    })
  })

  it('opens dashboard notifications and marks them read when clicked', async () => {
    const markRead = vi.fn().mockResolvedValue(undefined)
    useNotificationsStore.setState({ markRead })

    render(
      <MemoryRouter initialEntries={['/notifications']}>
        <Routes>
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/dashboard/:id" element={<p>Dashboard route</p>} />
        </Routes>
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: /dashboard shared with you/i }))

    await screen.findByText('Dashboard route')
    expect(markRead).toHaveBeenCalledWith('notif-1')
  })

  it('sends removed-access notifications back to the dashboards page', async () => {
    const markRead = vi.fn().mockResolvedValue(undefined)
    useNotificationsStore.setState({ markRead })

    render(
      <MemoryRouter initialEntries={['/notifications']}>
        <Routes>
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/dashboards" element={<p>Dashboards route</p>} />
        </Routes>
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: /dashboard access removed/i }))

    await screen.findByText('Dashboards route')
    expect(markRead).toHaveBeenCalledWith('notif-2')
  })
})
