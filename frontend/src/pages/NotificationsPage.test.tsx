import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
      notifications: [],
      unreadCount: 0,
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
          event_type: 'list.created',
          group_id: null,
          entity_type: 'list',
          entity_id: 'list-1',
          actor_id: 'user-1',
          actor_display_name: 'Example User',
          payload: {},
          created_at: '2026-04-06T12:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          event_id: 2,
          event_type: 'list.updated',
          group_id: null,
          entity_type: 'list',
          entity_id: 'list-1',
          actor_id: 'user-1',
          actor_display_name: 'Example User',
          payload: {},
          created_at: '2026-04-06T12:05:00.000Z',
        },
      ])

    render(<NotificationsPage />)

    fireEvent.click(screen.getByRole('button', { name: /^activity$/i }))

    await screen.findByText('list.created')

    act(() => {
      window.dispatchEvent(new Event(APP_RESYNC_EVENT))
    })

    await screen.findByText('list.updated')
    await waitFor(() => {
      expect(mockedApiGetActivity).toHaveBeenCalledTimes(2)
    })
  })
})
