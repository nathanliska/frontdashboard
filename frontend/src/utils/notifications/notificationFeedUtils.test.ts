import { describe, expect, it } from 'vitest'
import type { ActivityEvent, Notification } from '../../api/notifications'
import { ROUTES } from '../../routes'
import {
  formatActivityEvent,
  getNotificationDestination,
  getNotificationTypeLabel,
} from './notificationFeedUtils'

function activityEvent(eventType: string, payload: Record<string, unknown> = {}): ActivityEvent {
  return {
    event_id: 1,
    event_type: eventType,
    entity_type: 'test',
    entity_id: 'entity-1',
    actor_id: 'user-1',
    actor_display_name: 'Example User',
    payload,
    created_at: '2026-07-17T18:51:34.000Z',
  }
}

describe('formatActivityEvent', () => {
  it.each([
    [
      'dashboard.updated',
      { name: 'Roadmap', changed_fields: ['name'] },
      'Dashboard',
      'You renamed "Roadmap".',
    ],
    [
      'dashboard.updated',
      { name: 'Roadmap', changed_fields: ['restored'] },
      'Dashboard',
      'You restored "Roadmap" from the trash.',
    ],
    ['list.reordered', { dashboard_name: 'Home' }, 'List', 'You reordered lists in "Home".'],
    ['list.reordered', {}, 'List', 'You reordered your lists.'],
    [
      'list.item.reordered',
      { list_name: 'Groceries' },
      'List item',
      'You reordered items in "Groceries".',
    ],
    ['list.item.reordered', {}, 'List item', 'You reordered items in a list.'],
    [
      'list.item.created',
      { text: 'Milk', list_name: 'Groceries' },
      'List item',
      'You added "Milk" to "Groceries".',
    ],
    [
      'list.item.updated',
      { text: 'Oat milk', list_name: 'Groceries' },
      'List item',
      'You updated "Oat milk" in "Groceries".',
    ],
    [
      'list.item.deleted',
      { text: 'Milk', list_name: 'Groceries' },
      'List item',
      'You deleted "Milk" from "Groceries".',
    ],
    ['list.item.checked', { values: { checked: true } }, 'List item', 'You checked a list item.'],
    [
      'list.item.checked',
      { values: { checked: false } },
      'List item',
      'You unchecked a list item.',
    ],
  ])('formats %s with user-facing copy', (eventType, payload, badge, summary) => {
    expect(formatActivityEvent(activityEvent(eventType, payload))).toEqual({ badge, summary })
  })
})

describe('getNotificationDestination', () => {
  function notification(type: string, referenceId: string | null = 'dash-1'): Notification {
    return {
      id: 'n-1',
      type,
      title: 'Title',
      body: 'Body',
      read_at: null,
      reference_type: referenceId === null ? null : 'dashboard',
      reference_id: referenceId,
      created_at: '2026-08-01T00:00:00.000Z',
    }
  }

  // Both name a dashboard the reader can no longer open, so following reference_id would 404.
  it.each(['dashboard.share_removed', 'dashboard.deleted'])(
    'sends %s to the dashboard index rather than the unreachable dashboard',
    (type) => {
      expect(getNotificationDestination(notification(type))).toBe(ROUTES.dashboards)
    },
  )

  it('still deep-links a notification whose dashboard is reachable', () => {
    expect(getNotificationDestination(notification('dashboard.share_added'))).toBe(
      ROUTES.dashboard('dash-1'),
    )
  })
})

describe('getNotificationTypeLabel', () => {
  it('names the trashed-dashboard type instead of falling back', () => {
    expect(getNotificationTypeLabel('dashboard.deleted')).toBe('Dashboard deleted')
    expect(getNotificationTypeLabel('something.unknown')).toBe('Notification')
  })
})
