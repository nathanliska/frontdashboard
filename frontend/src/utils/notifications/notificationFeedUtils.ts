import type { ActivityEvent, Notification } from '../../api/notifications'
import { ROUTES } from '../../routes'
import { isOnly, primaryChangedField } from '../dashboard/changedFields'

type ActivityPresentation = {
  badge: string
  summary: string
  detail?: string
}

/** A collapsed run rendered as one line. Every row states its own count, so nothing sits beside it. */
export type ActivityRow = ActivityPresentation

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

/** A `dashboard.updated` whose only changed field is the layout — the shape a drag writes. */
function isLayoutEvent(event: ActivityEvent): boolean {
  if (event.event_type !== 'dashboard.updated') return false
  return primaryChangedField(payloadStrings(event.payload, 'changed_fields')) === 'layout'
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

const ACTIVITY_CATEGORIES = [
  {
    id: 'dashboards',
    label: 'Dashboards',
    eventTypes: ['dashboard.created', 'dashboard.updated', 'dashboard.deleted'],
  },
  {
    id: 'sharing',
    label: 'Sharing',
    eventTypes: ['dashboard.share_added', 'dashboard.share_updated', 'dashboard.share_removed'],
  },
  {
    id: 'lists',
    label: 'Lists',
    eventTypes: ['list.created', 'list.updated', 'list.deleted', 'list.reordered'],
  },
  {
    id: 'list-items',
    label: 'List items',
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
  /** Types to ask the endpoint for. Empty means "everything". */
  eventTypes: readonly string[]
}

export const ACTIVITY_FILTER_ALL = 'all'

// Categories only. Per-type rows made this 26 deep, which buries the thing you are looking for —
// and every type belongs to a category, so nothing here is unreachable without them.
export const ACTIVITY_FILTERS: readonly ActivityFilterOption[] = [
  { id: ACTIVITY_FILTER_ALL, label: 'All', eventTypes: [] },
  ...ACTIVITY_CATEGORIES.map((category) => ({
    id: category.id,
    label: category.label,
    eventTypes: category.eventTypes,
  })),
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
 * log.
 */
export function isOwnFeedActivity(
  event: ActivityEvent,
  viewerId: string | null,
  filterId: string = ACTIVITY_FILTER_ALL,
): boolean {
  if (viewerId === null || event.actor_id !== viewerId) return false
  const eventTypes = eventTypesForActivityFilter(filterId)
  if (eventTypes.length > 0) return eventTypes.includes(event.event_type)
  return true
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
      // Which field wins when a frame carries several is `feedPrecedence` in the vocabulary
      // table — adding a widget moves the layout too, and the widget is the truer sentence.
      switch (primaryChangedField(changedFields)) {
        case 'restored':
          return { badge: 'Dashboard', summary: `You restored ${name} from the trash.` }
        case 'name':
          return { badge: 'Dashboard', summary: `You renamed ${name}.` }
        case 'widgets': {
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
        case 'layout': {
          // Older rows carry no gesture, and neither do the layout writes nobody performed.
          const action = payloadString(payload, 'layout_action')
          if (action === 'moved' || action === 'resized') {
            const verb = action === 'moved' ? 'moved' : 'resized'
            return {
              badge: 'Dashboard',
              summary: `You ${verb} ${widgetLabel(payload)} on ${name}.`,
            }
          }
          return { badge: 'Dashboard', summary: `You rearranged widgets on ${name}.` }
        }
        default:
          return { badge: 'Dashboard', summary: `You updated ${name}.` }
      }
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
    case 'dashboard.share_removed': {
      const dashboardName = quoted(payloadString(payload, 'dashboard_name'), 'a dashboard')
      // Leaving logs the same type from the other side, like 'joined' on share_added: the actor
      // shed their own access rather than revoking someone else's.
      if (payloadString(payload, 'share_action') === 'left') {
        return { badge: 'Sharing', summary: `You left ${dashboardName}.` }
      }
      return {
        badge: 'Sharing',
        summary: `You removed access from ${dashboardName}.`,
      }
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

/** One feed row: a collapsed run, and every event it stands for. */
export type ActivityGroup = {
  /** The run's representative and `members[0]` — its newest event, since the feed is newest-first. */
  event: ActivityEvent
  /** Every event the row collapsed, newest first. A row that collapsed nothing holds just its own. */
  members: ActivityEvent[]
  /** Distinct entities the run touched. Toggling one checkbox ten times is one checkbox. */
  entities: number
}

/**
 * Types whose run is one sitting with a container, and the payload field naming it.
 *
 * A run here spans several entities, so what the row says is `formatActivityGroup`'s call.
 */
const COLLAPSE_SUBJECT_FIELD: Record<string, string> = {
  'list.item.checked': 'list_id',
  'list.item.reordered': 'list_id',
  'list.reordered': 'dashboard_id',
}

/**
 * Types whose run is one thing edited repeatedly, so every row in it reads identically.
 *
 * Keyed on the entity, which is what makes a plain "×N" true rather than a guess.
 */
const COLLAPSE_ON_ENTITY: ReadonlySet<string> = new Set([
  'list.updated',
  'list.item.updated',
  'calendar.event.updated',
  'calendar.event.occurrence.updated',
])

function collapseKey(event: ActivityEvent): string | null {
  if (COLLAPSE_ON_ENTITY.has(event.event_type)) return `${event.event_type}:${event.entity_id}`
  const subjectField = COLLAPSE_SUBJECT_FIELD[event.event_type]
  if (subjectField) {
    // No container id means no honest way to group it, so the event keeps its own row.
    const subject = payloadString(event.payload, subjectField)
    return subject ? `${event.event_type}:${subject}` : null
  }
  if (event.event_type !== 'dashboard.updated') return null
  const changedFields = payloadStrings(event.payload, 'changed_fields')
  if (isOnly(changedFields, 'layout')) return `dashboard.layout:${event.entity_id}`
  if (isOnly(changedFields, 'widgets')) {
    // Widgets alone means a reconfigure — adding and removing both move the layout. Keyed on the
    // widget, so the count names one thing edited repeatedly rather than a mixed bag.
    const widgetId = payloadString(event.payload, 'widget_id')
    return widgetId ? `dashboard.widget:${widgetId}` : null
  }
  return null
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
  let runEntities = new Set<string>()

  for (const event of events) {
    const key = collapseKey(event)
    const at = Date.parse(event.created_at)
    const last = groups[groups.length - 1]
    // NaN from an unparseable timestamp fails this, which starts a new row — the safe way to be
    // wrong, since it shows the event rather than hiding it inside a count.
    const withinWindow = runPreviousAt - at <= COLLAPSE_WINDOW_MS

    if (last && key !== null && key === runKey && withinWindow) {
      last.members.push(event)
      runEntities.add(event.entity_id)
      last.entities = runEntities.size
      runPreviousAt = at
      continue
    }
    groups.push({ event, members: [event], entities: 1 })
    runKey = key
    runPreviousAt = at
    runEntities = new Set([event.entity_id])
  }

  return groups
}

/**
 * How a collapsed run reads as one line.
 *
 * A run spanning several entities is summarized against what contains them, since naming the
 * newest would claim the others never happened. No branch carries a count: the disclosure states
 * it once, against the lines it reveals.
 */
export function formatActivityGroup({ event, members, entities }: ActivityGroup): ActivityRow {
  // A layout run collapses per dashboard, so its `entities` stays 1 however many widgets moved.
  // Naming the newest one would claim the rest never moved — the container sentence is the honest
  // one, and the disclosure names each widget.
  if (members.length > 1 && isLayoutEvent(event)) {
    const name = quoted(payloadString(event.payload, 'name'), 'a dashboard')
    return { badge: 'Dashboard', summary: `You rearranged widgets on ${name}.` }
  }
  if (entities > 1 && event.event_type === 'list.item.checked') {
    const listName = payloadString(event.payload, 'list_name')
    const location = listName ? ` in "${listName}"` : ''
    return {
      badge: 'List item',
      // "updated", not "checked": the same event type carries unchecking, and a run mixes both.
      // Uncounted because entities and events can disagree here; the disclosure states the number.
      summary: `You updated checkboxes${location}.`,
    }
  }
  return formatActivityEvent(event)
}
