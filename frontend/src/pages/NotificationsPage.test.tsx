// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGetActivity } from '../api/notifications'
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
      // The store outlives each test: an uncleared feed lets the next test skip its fetch and
      // still render, which looks like a pass.
      activity: [],
      activityLoaded: false,
      activityLoading: false,
      activityFailed: false,
      activityHasMore: false,
      activityLoadingMore: false,
    })
  })

  const ACTIVITY_PAGE = [
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
  ]

  function renderPage() {
    return render(
      <MemoryRouter initialEntries={['/notifications']}>
        <Routes>
          <Route path="/notifications" element={<NotificationsPage />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('fetches activity the first time the tab is opened', async () => {
    mockedApiGetActivity.mockResolvedValue(ACTIVITY_PAGE)
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: /^activity$/i }))

    await screen.findByText('You granted viewer access to "Roadmap".')
    expect(mockedApiGetActivity).toHaveBeenCalledTimes(1)
  })

  it('does not refetch activity when the tab is revisited', async () => {
    // The feed is cached in the store and SSE keeps it current, so switching back must cost nothing.
    mockedApiGetActivity.mockResolvedValue(ACTIVITY_PAGE)
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: /^activity$/i }))
    await screen.findByText('You granted viewer access to "Roadmap".')

    fireEvent.click(screen.getByRole('button', { name: /^notifications/i }))
    fireEvent.click(screen.getByRole('button', { name: /^activity$/i }))
    await screen.findByText('You granted viewer access to "Roadmap".')

    expect(mockedApiGetActivity).toHaveBeenCalledTimes(1)
  })

  it('refetches when the caller forces it, which is how a resync recovers', async () => {
    // Staleness is the stream's call (`useSSE` owns the resync); what the store owes it is a way
    // past the cache.
    mockedApiGetActivity.mockResolvedValue(ACTIVITY_PAGE)
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: /^activity$/i }))
    await screen.findByText('You granted viewer access to "Roadmap".')

    await act(async () => {
      await useNotificationsStore.getState().loadActivity({ force: true })
    })

    await waitFor(() => {
      expect(mockedApiGetActivity).toHaveBeenCalledTimes(2)
    })
  })

  it.each([
    {
      buttonName: /dashboard shared with you/i,
      destinationPath: '/dashboard/:id',
      destinationLabel: 'Dashboard route',
      expectedNotificationId: 'notif-1',
    },
    {
      buttonName: /dashboard access removed/i,
      destinationPath: '/dashboards',
      destinationLabel: 'Dashboards route',
      expectedNotificationId: 'notif-2',
    },
  ])(
    'opens the correct destination and marks the notification read',
    async ({ buttonName, destinationPath, destinationLabel, expectedNotificationId }) => {
      const markRead = vi.fn().mockResolvedValue(undefined)
      useNotificationsStore.setState({ markRead })

      render(
        <MemoryRouter initialEntries={['/notifications']}>
          <Routes>
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path={destinationPath} element={<p>{destinationLabel}</p>} />
          </Routes>
        </MemoryRouter>,
      )

      fireEvent.click(screen.getByRole('button', { name: buttonName }))

      await screen.findByText(destinationLabel)
      expect(markRead).toHaveBeenCalledWith(expectedNotificationId)
    },
  )
})
