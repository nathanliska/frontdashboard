import { describe, expect, it } from 'vitest'
import type { ActivityEvent } from '../../api/notifications'
import { formatActivityEvent } from './notificationFeedUtils'

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
    ['dashboard.updated', { name: 'Roadmap' }, 'Dashboard', 'You updated "Roadmap".'],
    ['list.reordered', {}, 'List', 'You reordered your lists.'],
    ['list.item.reordered', {}, 'List item', 'You reordered items in a list.'],
    ['list.item.checked', { values: { checked: true } }, 'List item', 'You checked a list item.'],
    [
      'list.item.checked',
      { values: { checked: false } },
      'List item',
      'You unchecked a list item.',
    ],
    ['membership.added', {}, 'Membership', 'You added a member.'],
    ['membership.removed', {}, 'Membership', 'You removed a member.'],
    ['membership.role_changed', {}, 'Membership', "You changed a member's role."],
  ])('formats %s with user-facing copy', (eventType, payload, badge, summary) => {
    expect(formatActivityEvent(activityEvent(eventType, payload))).toEqual({ badge, summary })
  })
})
