import { describe, expect, it } from 'vitest'
import type { ActivityEvent, Notification } from '../../api/notifications'
import { ROUTES } from '../../routes'
import {
  formatActivityEvent,
  formatActivityGroup,
  getNotificationDestination,
  getNotificationTypeLabel,
  groupActivityEvents,
  isOwnFeedActivity,
} from './notificationFeedUtils'

function activityEvent(
  eventType: string,
  payload: Record<string, unknown> = {},
  overrides: Partial<ActivityEvent> = {},
): ActivityEvent {
  return {
    event_id: 1,
    event_type: eventType,
    entity_type: 'test',
    entity_id: 'entity-1',
    actor_id: 'user-1',
    actor_display_name: 'Example User',
    payload,
    created_at: '2026-07-17T18:51:34.000Z',
    ...overrides,
  }
}

function checkedEvent(
  eventId: number,
  listId = 'list-1',
  text = 'Milk',
  createdAt = '2026-07-17T18:51:34.000Z',
): ActivityEvent {
  return activityEvent(
    'list.item.checked',
    { list_id: listId, list_name: 'Groceries', text, values: { checked: true } },
    { event_id: eventId, entity_id: `item-${eventId}`, created_at: createdAt },
  )
}

function layoutEvent(
  eventId: number,
  dashboardId = 'dash-1',
  createdAt = '2026-07-17T18:51:34.000Z',
): ActivityEvent {
  return activityEvent(
    'dashboard.updated',
    { name: 'Home', changed_fields: ['layout'] },
    { event_id: eventId, entity_id: dashboardId, created_at: createdAt },
  )
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
    [
      'dashboard.updated',
      { name: 'Roadmap', changed_fields: ['layout'] },
      'Dashboard',
      'You rearranged widgets on "Roadmap".',
    ],
    [
      'dashboard.updated',
      {
        name: 'Roadmap',
        changed_fields: ['widgets', 'layout'],
        widget_action: 'added',
        widget_type: 'agenda',
      },
      'Dashboard',
      'You added an Agenda widget to "Roadmap".',
    ],
    [
      'dashboard.updated',
      {
        name: 'Roadmap',
        changed_fields: ['widgets', 'layout'],
        widget_action: 'removed',
        widget_type: 'list',
      },
      'Dashboard',
      'You removed a List widget from "Roadmap".',
    ],
    [
      'dashboard.updated',
      { name: 'Roadmap', changed_fields: ['widgets'], widget_type: 'clock' },
      'Dashboard',
      'You reconfigured a Clock widget on "Roadmap".',
    ],
    [
      'dashboard.updated',
      { changed_fields: ['widgets'], widget_type: 'something-new' },
      'Dashboard',
      'You reconfigured a widget on a dashboard.',
    ],
    [
      'dashboard.share_added',
      { dashboard_name: 'Kitchen', role: 'editor' },
      'Sharing',
      'You granted editor access to "Kitchen".',
    ],
    [
      'dashboard.share_added',
      { dashboard_name: 'Kitchen', role: 'editor', share_action: 'joined' },
      'Sharing',
      'You joined "Kitchen" as editor.',
    ],
    [
      'calendar.event.occurrence.updated',
      { title: 'Dentist' },
      'Calendar',
      'You updated the occurrence of "Dentist".',
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

  it('names which occurrence of a series was touched', () => {
    const { summary } = formatActivityEvent(
      activityEvent('calendar.event.occurrence.cancelled', {
        title: 'Dentist',
        occurrence_start: '2026-08-05T09:00:00.000Z',
      }),
    )

    // Asserted by shape, not by exact text: the date is rendered in the reader's own locale and
    // timezone, neither of which the test runner pins.
    expect(summary).toMatch(/^You cancelled the .+ occurrence of "Dentist"\.$/)
    expect(summary).not.toBe('You cancelled the occurrence of "Dentist".')
  })

  it('reads a retired event type back as English rather than printing its identifier', () => {
    // Archive is gone but its rows survive — `event_type` is a plain string column.
    expect(formatActivityEvent(activityEvent('list.archived', { name: 'Chores' }))).toEqual({
      badge: 'Activity',
      summary: 'List archived.',
    })
  })
})

describe('groupActivityEvents', () => {
  it('collapses a run of layout churn on one dashboard into a single counted row', () => {
    const groups = groupActivityEvents([layoutEvent(5), layoutEvent(4), layoutEvent(3)])

    expect(groups).toHaveLength(1)
    expect(groups[0].count).toBe(3)
    // Newest-first feed, so the run is dated by the newest event in it.
    expect(groups[0].event.event_id).toBe(5)
  })

  it('does not merge across an unrelated event, or across dashboards', () => {
    const groups = groupActivityEvents([
      layoutEvent(6),
      activityEvent('list.created', { name: 'Chores' }, { event_id: 5 }),
      layoutEvent(4),
      layoutEvent(3, 'dash-2'),
    ])

    expect(groups.map((group) => [group.event.event_id, group.count])).toEqual([
      [6, 1],
      [5, 1],
      [4, 1],
      [3, 1],
    ])
  })

  it('does not merge two sittings days apart into one row dated by the newer', () => {
    const groups = groupActivityEvents([
      layoutEvent(2, 'dash-1', '2026-07-17T18:51:34.000Z'),
      layoutEvent(1, 'dash-1', '2026-07-13T09:00:00.000Z'),
    ])

    expect(groups.map((group) => [group.event.event_id, group.count])).toEqual([
      [2, 1],
      [1, 1],
    ])
  })

  it('starts a new row rather than hiding an event behind an unparseable timestamp', () => {
    const groups = groupActivityEvents([
      layoutEvent(2, 'dash-1', 'not-a-date'),
      layoutEvent(1, 'dash-1', 'not-a-date'),
    ])

    expect(groups).toHaveLength(2)
  })

  it('leaves a decision someone made twice as two rows', () => {
    const added = (eventId: number) =>
      activityEvent(
        'dashboard.updated',
        { name: 'Home', changed_fields: ['widgets', 'layout'], widget_action: 'added' },
        { event_id: eventId },
      )

    expect(groupActivityEvents([added(2), added(1)])).toHaveLength(2)
  })
})

describe('isOwnFeedActivity', () => {
  it('keeps the reader’s own visible events', () => {
    expect(isOwnFeedActivity(layoutEvent(1), 'user-1')).toBe(true)
  })

  it('drops a co-editor’s event, which the feed would render as "You…"', () => {
    expect(isOwnFeedActivity(layoutEvent(1), 'user-2')).toBe(false)
  })

  it('keeps checkbox churn, which the endpoint also serves', () => {
    const checked = activityEvent('list.item.checked', { values: { checked: true } })
    expect(isOwnFeedActivity(checked, 'user-1')).toBe(true)
  })

  it('drops everything when nobody is signed in', () => {
    expect(isOwnFeedActivity(layoutEvent(1), null)).toBe(false)
  })
})

describe('collapsing checkbox churn', () => {
  it('collapses a run on one list, keyed on the list rather than the item', () => {
    const groups = groupActivityEvents([
      checkedEvent(5, 'list-1', 'Bread'),
      checkedEvent(4, 'list-1', 'Eggs'),
      checkedEvent(3, 'list-1', 'Milk'),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].count).toBe(3)
  })

  it('does not merge two different lists', () => {
    const groups = groupActivityEvents([checkedEvent(2, 'list-1'), checkedEvent(1, 'list-2')])

    expect(groups.map((group) => group.count)).toEqual([1, 1])
  })

  it('summarizes the run against the list, because each event names a different item', () => {
    const [group] = groupActivityEvents([
      checkedEvent(5, 'list-1', 'Bread'),
      checkedEvent(4, 'list-1', 'Eggs'),
      checkedEvent(3, 'list-1', 'Milk'),
    ])
    const row = formatActivityGroup(group)

    // Naming the newest would claim the other two never happened.
    expect(row.summary).toBe('You updated 3 checkboxes in "Groceries".')
  })

  it('still names the item when the run is one event', () => {
    const [group] = groupActivityEvents([checkedEvent(1, 'list-1', 'Milk')])

    expect(formatActivityGroup(group).summary).toBe('You checked "Milk" in "Groceries".')
  })

  it('leaves layout churn on the counted-badge shape, where every event said the same thing', () => {
    const [group] = groupActivityEvents([layoutEvent(2), layoutEvent(1)])
    const row = formatActivityGroup(group)

    expect(row.summary).toBe('You rearranged widgets on "Home" 2 times.')
  })
})

describe('counting what a collapsed run actually touched', () => {
  function toggle(eventId: number, itemId: string): ActivityEvent {
    return activityEvent(
      'list.item.checked',
      { list_id: 'list-1', list_name: 'Groceries', text: 'Milk', values: { checked: true } },
      { event_id: eventId, entity_id: itemId, created_at: '2026-07-17T18:51:34.000Z' },
    )
  }

  it('counts checkboxes, not events, when one item is toggled more than once', () => {
    const [group] = groupActivityEvents([
      toggle(3, 'item-a'),
      toggle(2, 'item-b'),
      toggle(1, 'item-a'),
    ])

    expect(group.count).toBe(3)
    expect(group.entities).toBe(2)
    expect(formatActivityGroup(group).summary).toBe('You updated 2 checkboxes in "Groceries".')
  })

  it('reads as the item itself when a run only ever touched one', () => {
    const [group] = groupActivityEvents([
      toggle(3, 'item-a'),
      toggle(2, 'item-a'),
      toggle(1, 'item-a'),
    ])
    const row = formatActivityGroup(group)

    // "3 checkboxes" would be three items; it was one, three times.
    expect(row.summary).toBe('You checked "Milk" in "Groceries" 3 times.')
  })

  it('collapses repeated edits to one entity, where every row reads alike', () => {
    const edit = (eventId: number) =>
      activityEvent(
        'list.item.updated',
        { list_name: 'Chores', text: 'Vacuum' },
        { event_id: eventId, entity_id: 'item-a', created_at: '2026-07-17T18:51:34.000Z' },
      )
    const [group] = groupActivityEvents([edit(2), edit(1)])

    expect(formatActivityGroup(group).summary).toBe('You updated "Vacuum" in "Chores" 2 times.')
  })

  it('does not merge edits to two different items', () => {
    const edit = (eventId: number, itemId: string) =>
      activityEvent(
        'list.item.updated',
        { text: 'Vacuum' },
        { event_id: eventId, entity_id: itemId },
      )
    expect(groupActivityEvents([edit(2, 'item-a'), edit(1, 'item-b')])).toHaveLength(2)
  })
})

describe('collapsing reorder churn', () => {
  function reorderEvent(eventId: number, listId = 'list-1'): ActivityEvent {
    return activityEvent(
      'list.item.reordered',
      { list_id: listId, list_name: 'Chores' },
      { event_id: eventId, created_at: '2026-07-17T18:51:34.000Z' },
    )
  }

  it('collapses a run of item reorders on one list', () => {
    const groups = groupActivityEvents([reorderEvent(3), reorderEvent(2), reorderEvent(1)])

    expect(groups).toHaveLength(1)
    expect(groups[0].count).toBe(3)
  })

  it('keeps the counted badge, because every row in the run says the same thing', () => {
    const [group] = groupActivityEvents([reorderEvent(2), reorderEvent(1)])
    const row = formatActivityGroup(group)

    expect(row.summary).toBe('You reordered items in "Chores" 2 times.')
  })

  it('does not merge reorders of two different lists', () => {
    const groups = groupActivityEvents([reorderEvent(2, 'list-1'), reorderEvent(1, 'list-2')])

    expect(groups.map((group) => group.count)).toEqual([1, 1])
  })

  it('collapses list reorders on the dashboard that holds them', () => {
    const listReorder = (eventId: number) =>
      activityEvent(
        'list.reordered',
        { dashboard_id: 'dash-1', dashboard_name: 'Home' },
        { event_id: eventId, created_at: '2026-07-17T18:51:34.000Z' },
      )
    const groups = groupActivityEvents([listReorder(2), listReorder(1)])

    expect(groups).toHaveLength(1)
    expect(formatActivityGroup(groups[0]).summary).toBe('You reordered lists in "Home" 2 times.')
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
