import type { ActivityEvent, Notification } from '../../api/notifications'
import { ROUTES } from '../../routes'

type ActivityPresentation = {
  badge: string
  summary: string
  detail?: string
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function payloadBoolean(payload: Record<string, unknown>, key: string): boolean | null {
  const value = payload[key]
  return typeof value === 'boolean' ? value : null
}

function quoted(value: string | null, fallback: string): string {
  return value ? `"${value}"` : fallback
}

export function getNotificationTypeLabel(type: string): string {
  switch (type) {
    case 'dashboard.share_added':
      return 'Access added'
    case 'dashboard.share_updated':
      return 'Access updated'
    case 'dashboard.share_removed':
      return 'Access removed'
    default:
      return 'Notification'
  }
}

export function getNotificationDestination(notification: Notification): string | null {
  if (notification.type === 'dashboard.share_removed') {
    return ROUTES.dashboards
  }
  if (notification.reference_type === 'dashboard' && notification.reference_id) {
    return ROUTES.dashboard(notification.reference_id)
  }
  return null
}

export function formatActivityEvent(event: ActivityEvent): ActivityPresentation {
  const { payload } = event

  switch (event.event_type) {
    case 'dashboard.created':
      return {
        badge: 'Dashboard',
        summary: `You created ${quoted(payloadString(payload, 'name'), 'a dashboard')}.`,
      }
    case 'dashboard.deleted':
      return {
        badge: 'Dashboard',
        summary: `You deleted ${quoted(payloadString(payload, 'name'), 'a dashboard')}.`,
      }
    case 'dashboard.updated':
      return {
        badge: 'Dashboard',
        summary: `You updated ${quoted(payloadString(payload, 'name'), 'a dashboard')}.`,
      }
    case 'dashboard.share_added':
      return {
        badge: 'Sharing',
        summary: `You granted ${payloadString(payload, 'role') ?? 'shared'} access to ${quoted(payloadString(payload, 'dashboard_name'), 'a dashboard')}.`,
      }
    case 'dashboard.share_updated':
      return {
        badge: 'Sharing',
        summary: `You changed access on ${quoted(payloadString(payload, 'dashboard_name'), 'a dashboard')}.`,
        detail: payloadString(payload, 'role')
          ? `New role: ${payloadString(payload, 'role')}.`
          : undefined,
      }
    case 'dashboard.share_removed':
      return {
        badge: 'Sharing',
        summary: `You removed access from ${quoted(payloadString(payload, 'dashboard_name'), 'a dashboard')}.`,
      }
    case 'list.created':
      return {
        badge: 'List',
        summary: `You created ${quoted(payloadString(payload, 'name'), 'a list')}.`,
      }
    case 'list.updated':
      return {
        badge: 'List',
        summary: `You renamed ${quoted(payloadString(payload, 'name'), 'a list')}.`,
      }
    case 'list.archived': {
      const archived = payloadBoolean(payload, 'archived')
      return {
        badge: 'List',
        summary:
          archived === false
            ? `You unarchived ${quoted(payloadString(payload, 'name'), 'a list')}.`
            : `You archived ${quoted(payloadString(payload, 'name'), 'a list')}.`,
      }
    }
    case 'list.deleted':
      return {
        badge: 'List',
        summary: `You deleted ${quoted(payloadString(payload, 'name'), 'a list')}.`,
      }
    case 'list.reordered':
      return {
        badge: 'List',
        summary: 'You reordered your lists.',
      }
    case 'list.item.created':
      return {
        badge: 'List item',
        summary: `You added ${quoted(payloadString(payload, 'text'), 'a list item')}.`,
      }
    case 'list.item.updated':
      return {
        badge: 'List item',
        summary: 'You updated a list item.',
      }
    case 'list.item.checked': {
      const checked = payload.values
      const checkedValue =
        typeof checked === 'object' && checked !== null
          ? payloadBoolean(checked as Record<string, unknown>, 'checked')
          : null
      return {
        badge: 'List item',
        summary: checkedValue === false ? 'You unchecked a list item.' : 'You checked a list item.',
      }
    }
    case 'list.item.deleted':
      return {
        badge: 'List item',
        summary: 'You deleted a list item.',
      }
    case 'list.item.reordered':
      return {
        badge: 'List item',
        summary: 'You reordered items in a list.',
      }
    case 'membership.added':
      return {
        badge: 'Membership',
        summary: 'You added a member.',
      }
    case 'membership.removed':
      return {
        badge: 'Membership',
        summary: 'You removed a member.',
      }
    case 'membership.role_changed':
      return {
        badge: 'Membership',
        summary: "You changed a member's role.",
      }
    case 'calendar.event.created':
      return {
        badge: 'Calendar',
        summary: `You created ${quoted(payloadString(payload, 'title'), 'an event')}.`,
      }
    case 'calendar.event.updated':
      return {
        badge: 'Calendar',
        summary: `You updated ${quoted(payloadString(payload, 'title'), 'an event')}.`,
      }
    case 'calendar.event.deleted':
      return {
        badge: 'Calendar',
        summary: `You deleted ${quoted(payloadString(payload, 'title'), 'an event')}.`,
      }
    case 'calendar.event.occurrence.updated':
      return {
        badge: 'Calendar',
        summary: `You updated an occurrence of ${quoted(payloadString(payload, 'title'), 'an event')}.`,
      }
    case 'calendar.event.occurrence.cancelled':
      return {
        badge: 'Calendar',
        summary: `You cancelled an occurrence of ${quoted(payloadString(payload, 'title'), 'an event')}.`,
      }
    default:
      return {
        badge: 'Activity',
        summary: event.event_type,
      }
  }
}
