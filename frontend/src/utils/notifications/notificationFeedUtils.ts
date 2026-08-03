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

function payloadStrings(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key]
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []
}

const WIDGET_LABELS: Record<string, string> = {
  agenda: 'an Agenda widget',
  calendar: 'a Calendar widget',
  clock: 'a Clock widget',
  list: 'a List widget',
}

function widgetLabel(payload: Record<string, unknown>): string {
  return WIDGET_LABELS[payloadString(payload, 'widget_type') ?? ''] ?? 'a widget'
}

/**
 * Reads a raw event type back as English.
 *
 * Retired types survive in old rows — `event_type` is a plain string column, so the feed keeps
 * serving them — and printing `list.archived` at a household user is worse than losing precision.
 */
function humanizeEventType(eventType: string): string {
  const words = eventType.replace(/[._]/g, ' ').trim()
  if (!words) return 'You made a change.'
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`
}

/** Names which occurrence of a series was touched, since one event can have many. */
function occurrenceLabel(payload: Record<string, unknown>): string {
  const start = payloadString(payload, 'occurrence_start')
  const at = start ? new Date(start) : null
  if (at === null || Number.isNaN(at.getTime())) return 'occurrence'
  return `${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(at)} occurrence`
}

/**
 * Event types the activity feed leaves out of its default view. Must match
 * `FEED_HIDDEN_EVENT_TYPES` in the backend's `routers/notifications.py`: a type hidden on one
 * side only either never appears, or appears live and then vanishes on the next reload.
 */
export const FEED_HIDDEN_EVENT_TYPES: ReadonlySet<string> = new Set(['list.item.checked'])

/**
 * What one event type is called inside its own category. Every EventType needs an entry, or it
 * is unreachable in the filter — pinned by `test_activity.py`.
 */
const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  'dashboard.created': 'Created',
  'dashboard.updated': 'Changed',
  'dashboard.deleted': 'Trashed',
  'dashboard.share_added': 'Access granted',
  'dashboard.share_updated': 'Access changed',
  'dashboard.share_removed': 'Access removed',
  'list.created': 'Created',
  'list.updated': 'Renamed',
  'list.deleted': 'Deleted',
  'list.reordered': 'Reordered',
  'list.item.created': 'Added',
  'list.item.updated': 'Edited',
  'list.item.checked': 'Checked off',
  'list.item.deleted': 'Deleted',
  'list.item.reordered': 'Reordered',
  'calendar.event.created': 'Created',
  'calendar.event.updated': 'Updated',
  'calendar.event.deleted': 'Deleted',
  'calendar.event.occurrence.updated': 'Occurrence updated',
  'calendar.event.occurrence.cancelled': 'Occurrence cancelled',
}

const ACTIVITY_CATEGORIES = [
  {
    id: 'dashboards',
    label: 'Dashboards',
    allLabel: 'All dashboard activity',
    eventTypes: ['dashboard.created', 'dashboard.updated', 'dashboard.deleted'],
  },
  {
    id: 'sharing',
    label: 'Sharing',
    allLabel: 'All sharing activity',
    eventTypes: ['dashboard.share_added', 'dashboard.share_updated', 'dashboard.share_removed'],
  },
  {
    id: 'lists',
    label: 'Lists',
    allLabel: 'All list activity',
    eventTypes: ['list.created', 'list.updated', 'list.deleted', 'list.reordered'],
  },
  {
    id: 'list-items',
    label: 'List items',
    allLabel: 'All list item activity',
    eventTypes: [
      'list.item.created',
      'list.item.updated',
      'list.item.checked',
      'list.item.deleted',
      'list.item.reordered',
    ],
  },
  {
    id: 'calendar',
    label: 'Calendar',
    allLabel: 'All calendar activity',
    eventTypes: [
      'calendar.event.created',
      'calendar.event.updated',
      'calendar.event.deleted',
      'calendar.event.occurrence.updated',
      'calendar.event.occurrence.cancelled',
    ],
  },
] as const

/** One choice in the activity filter. `group` is the heading it sits under, null for the default. */
export type ActivityFilterOption = {
  id: string
  label: string
  group: string | null
  /** Types to ask the endpoint for. Empty means "whatever it shows by default". */
  eventTypes: readonly string[]
}

export const ACTIVITY_FILTER_ALL = 'all'

export const ACTIVITY_FILTERS: readonly ActivityFilterOption[] = [
  { id: ACTIVITY_FILTER_ALL, label: 'All activity', group: null, eventTypes: [] },
  ...ACTIVITY_CATEGORIES.flatMap((category) => [
    {
      id: category.id,
      label: category.allLabel,
      group: category.label,
      eventTypes: category.eventTypes,
    },
    ...category.eventTypes.map((eventType) => ({
      id: eventType,
      label: ACTIVITY_TYPE_LABELS[eventType] ?? eventType,
      group: category.label,
      eventTypes: [eventType],
    })),
  ]),
]

/** The types a filter asks the endpoint for; empty for the unfiltered default. */
export function eventTypesForActivityFilter(filterId: string): readonly string[] {
  return ACTIVITY_FILTERS.find((option) => option.id === filterId)?.eventTypes ?? []
}

/**
 * Whether a live SSE frame belongs in `viewerId`'s activity feed as it is currently filtered.
 *
 * Mirrors `GET /api/activity` exactly, because anything else appends a row the next load takes
 * away: frames fan out to everyone who can see the dashboard while the feed is the reader's own
 * log, and naming types overrides the default hiding rather than narrowing it.
 */
export function isOwnFeedActivity(
  event: ActivityEvent,
  viewerId: string | null,
  filterId: string = ACTIVITY_FILTER_ALL,
): boolean {
  if (viewerId === null || event.actor_id !== viewerId) return false
  const eventTypes = eventTypesForActivityFilter(filterId)
  if (eventTypes.length > 0) return eventTypes.includes(event.event_type)
  return !FEED_HIDDEN_EVENT_TYPES.has(event.event_type)
}

export function getNotificationTypeLabel(type: string): string {
  switch (type) {
    case 'dashboard.share_added':
      return 'Access added'
    case 'dashboard.share_updated':
      return 'Access updated'
    case 'dashboard.share_removed':
      return 'Access removed'
    case 'dashboard.deleted':
      return 'Dashboard deleted'
    default:
      return 'Notification'
  }
}

// Both types name a dashboard the reader can no longer open, so they route to the index rather
// than to a reference_id that now 404s.
const UNREACHABLE_REFERENCE_TYPES = new Set(['dashboard.share_removed', 'dashboard.deleted'])

export function getNotificationDestination(notification: Notification): string | null {
  if (UNREACHABLE_REFERENCE_TYPES.has(notification.type)) {
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
    case 'dashboard.updated': {
      const changedFields = payloadStrings(payload, 'changed_fields')
      const name = quoted(payloadString(payload, 'name'), 'a dashboard')
      if (changedFields.includes('restored')) {
        return { badge: 'Dashboard', summary: `You restored ${name} from the trash.` }
      }
      if (changedFields.includes('name')) {
        return { badge: 'Dashboard', summary: `You renamed ${name}.` }
      }
      // Before 'layout': adding and removing a widget move it too, and it is the lesser half of
      // what happened.
      if (changedFields.includes('widgets')) {
        const widget = widgetLabel(payload)
        const action = payloadString(payload, 'widget_action')
        if (action === 'added') {
          return { badge: 'Dashboard', summary: `You added ${widget} to ${name}.` }
        }
        if (action === 'removed') {
          return { badge: 'Dashboard', summary: `You removed ${widget} from ${name}.` }
        }
        return { badge: 'Dashboard', summary: `You reconfigured ${widget} on ${name}.` }
      }
      if (changedFields.includes('layout')) {
        return { badge: 'Dashboard', summary: `You rearranged widgets on ${name}.` }
      }
      return { badge: 'Dashboard', summary: `You updated ${name}.` }
    }
    case 'dashboard.share_added': {
      const dashboardName = quoted(payloadString(payload, 'dashboard_name'), 'a dashboard')
      const role = payloadString(payload, 'role')
      // Redeeming an invite logs the same type from the other side: the actor gained the access.
      if (payloadString(payload, 'share_action') === 'joined') {
        return {
          badge: 'Sharing',
          summary: role
            ? `You joined ${dashboardName} as ${role}.`
            : `You joined ${dashboardName}.`,
        }
      }
      return {
        badge: 'Sharing',
        summary: `You granted ${role ?? 'shared'} access to ${dashboardName}.`,
      }
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
        summary: payloadBoolean(payload, 'restored')
          ? `You restored ${quoted(payloadString(payload, 'name'), 'a list')} from the trash.`
          : `You created ${quoted(payloadString(payload, 'name'), 'a list')}.`,
      }
    case 'list.updated':
      return {
        badge: 'List',
        summary: `You renamed ${quoted(payloadString(payload, 'name'), 'a list')}.`,
      }
    case 'list.deleted':
      return {
        badge: 'List',
        summary: `You deleted ${quoted(payloadString(payload, 'name'), 'a list')}.`,
      }
    case 'list.reordered':
      return {
        badge: 'List',
        summary: payloadString(payload, 'dashboard_name')
          ? `You reordered lists in ${quoted(payloadString(payload, 'dashboard_name'), 'a dashboard')}.`
          : 'You reordered your lists.',
      }
    case 'list.item.created': {
      const item = quoted(payloadString(payload, 'text'), 'a list item')
      const listName = payloadString(payload, 'list_name')
      return {
        badge: 'List item',
        summary: listName ? `You added ${item} to "${listName}".` : `You added ${item}.`,
      }
    }
    case 'list.item.updated': {
      const item = quoted(payloadString(payload, 'text'), 'a list item')
      const listName = payloadString(payload, 'list_name')
      return {
        badge: 'List item',
        summary: listName ? `You updated ${item} in "${listName}".` : `You updated ${item}.`,
      }
    }
    case 'list.item.checked': {
      const checked = payload.values
      const checkedValue =
        typeof checked === 'object' && checked !== null
          ? payloadBoolean(checked as Record<string, unknown>, 'checked')
          : null
      const item = quoted(payloadString(payload, 'text'), 'a list item')
      const listName = payloadString(payload, 'list_name')
      const location = listName ? ` in "${listName}"` : ''
      return {
        badge: 'List item',
        summary:
          checkedValue === false
            ? `You unchecked ${item}${location}.`
            : `You checked ${item}${location}.`,
      }
    }
    case 'list.item.deleted': {
      const item = quoted(payloadString(payload, 'text'), 'a list item')
      const listName = payloadString(payload, 'list_name')
      return {
        badge: 'List item',
        summary: listName ? `You deleted ${item} from "${listName}".` : `You deleted ${item}.`,
      }
    }
    case 'list.item.reordered':
      return {
        badge: 'List item',
        summary: `You reordered items in ${quoted(payloadString(payload, 'list_name'), 'a list')}.`,
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
        summary: `You updated the ${occurrenceLabel(payload)} of ${quoted(payloadString(payload, 'title'), 'an event')}.`,
      }
    case 'calendar.event.occurrence.cancelled':
      return {
        badge: 'Calendar',
        summary: `You cancelled the ${occurrenceLabel(payload)} of ${quoted(payloadString(payload, 'title'), 'an event')}.`,
      }
    default:
      return {
        badge: 'Activity',
        summary: humanizeEventType(event.event_type),
      }
  }
}

/** One feed row: the newest event of a collapsed run, and how many events it stands for. */
export type ActivityGroup = {
  event: ActivityEvent
  count: number
}

/**
 * The key a run of events collapses on, or null for an event that always gets its own row.
 *
 * Only coordinate churn collapses — tidying a dashboard emits one event per drag, all reading
 * alike. Anything a person decided to do once stays countable on its own.
 */
function collapseKey(event: ActivityEvent): string | null {
  if (event.event_type !== 'dashboard.updated') return null
  const changedFields = payloadStrings(event.payload, 'changed_fields')
  const layoutOnly = changedFields.length === 1 && changedFields[0] === 'layout'
  return layoutOnly ? `dashboard.layout:${event.entity_id}` : null
}

/**
 * How far apart two events can be and still read as one sitting of tidying. Without a bound,
 * a rearrange on Monday and another on Friday collapse into one row dated Friday, and Monday's
 * is simply gone from the timeline.
 */
const COLLAPSE_WINDOW_MS = 5 * 60 * 1000

/**
 * Collapse adjacent runs of the same churn into one row each, keeping feed order.
 *
 * Adjacent and within `COLLAPSE_WINDOW_MS`, so neither an unrelated event nor a gap in time
 * merges across. The feed is newest-first, so the run's representative is its newest event.
 */
export function groupActivityEvents(events: ActivityEvent[]): ActivityGroup[] {
  const groups: ActivityGroup[] = []
  let runKey: string | null = null
  let runPreviousAt = 0

  for (const event of events) {
    const key = collapseKey(event)
    const at = Date.parse(event.created_at)
    const last = groups[groups.length - 1]
    // NaN from an unparseable timestamp fails this, which starts a new row — the safe way to be
    // wrong, since it shows the event rather than hiding it inside a count.
    const withinWindow = runPreviousAt - at <= COLLAPSE_WINDOW_MS

    if (last && key !== null && key === runKey && withinWindow) {
      last.count += 1
      runPreviousAt = at
      continue
    }
    groups.push({ event, count: 1 })
    runKey = key
    runPreviousAt = at
  }

  return groups
}
