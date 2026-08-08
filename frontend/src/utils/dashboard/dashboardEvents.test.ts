import { beforeEach, describe, expect, it } from 'vitest'
import type { Dashboard, DashboardSummary } from '../../api/dashboards'
import type { SseEvent } from '../../hooks/useSSE'
import { useAuthStore } from '../../stores/auth'
import {
  affectsTrash,
  applyLocalDashboardSummaryUpdate,
  canSkipDashboardSummaryReload,
  canSuppressLocalDashboardEcho,
  consumePendingDashboardMutationEcho,
  getEventDashboardId,
  isDashboardShareEvent,
  isLayoutOnlyDashboardEvent,
  patchWidgetConfig,
  sortDashboardSummaries,
} from './dashboardEvents'
import {
  __resetPendingDashboardMutationsForTests,
  recordPendingDashboardMutation,
} from './dashboardMutation'

function event(overrides: Partial<SseEvent> = {}): SseEvent {
  return {
    event_id: 1,
    event_type: 'dashboard.updated',
    entity_type: 'dashboard',
    entity_id: 'dash-1',
    entity_version: 2,
    actor_id: 'user-1',
    actor_display_name: 'Ada',
    created_at: '2026-04-05T12:00:00Z',
    payload: {},
    ...overrides,
  } as SseEvent
}

function summary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    id: 'dash-1',
    user_id: 'user-1',
    name: 'Primary',
    access_description: 'Owned by you',
    is_shared: false,
    can_edit: true,
    can_manage_shares: true,
    is_favorite: false,
    version: 1,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

describe('reading the frame', () => {
  it('takes the id from the entity for a dashboard frame, and the payload otherwise', () => {
    expect(getEventDashboardId(event())).toBe('dash-1')
    expect(
      getEventDashboardId(
        event({ entity_type: 'list', entity_id: 'list-9', payload: { dashboard_id: 'dash-7' } }),
      ),
    ).toBe('dash-7')
    expect(getEventDashboardId(event({ entity_type: 'list', entity_id: 'l', payload: {} }))).toBe(
      null,
    )
  })

  it('recognises all three share event types and nothing else', () => {
    for (const t of ['dashboard.share_added', 'dashboard.share_updated', 'dashboard.share_removed'])
      expect(isDashboardShareEvent(event({ event_type: t as SseEvent['event_type'] }))).toBe(true)
    expect(isDashboardShareEvent(event())).toBe(false)
  })

  it('gates the layout-only shortcut on the event type, not just the fields', () => {
    expect(isLayoutOnlyDashboardEvent(event({ payload: { changed_fields: ['layout'] } }))).toBe(
      true,
    )
    expect(
      isLayoutOnlyDashboardEvent(event({ payload: { changed_fields: ['layout', 'widgets'] } })),
    ).toBe(false)
    // Same fields, wrong type: a created frame must not take the version-guard shortcut.
    expect(
      isLayoutOnlyDashboardEvent(
        event({ event_type: 'dashboard.created', payload: { changed_fields: ['layout'] } }),
      ),
    ).toBe(false)
  })

  it('treats a deleted or restored frame as touching the trash', () => {
    expect(affectsTrash(event({ event_type: 'dashboard.deleted' }))).toBe(true)
    expect(affectsTrash(event({ payload: { changed_fields: ['restored'] } }))).toBe(true)
    expect(affectsTrash(event({ payload: { changed_fields: ['layout'] } }))).toBe(false)
  })
})

describe('summary ordering', () => {
  it('puts favorites first, then most recently updated', () => {
    const sorted = sortDashboardSummaries([
      summary({ id: 'a', updated_at: '2026-04-01T00:00:00Z' }),
      summary({ id: 'b', updated_at: '2026-04-03T00:00:00Z' }),
      summary({ id: 'c', is_favorite: true, updated_at: '2026-01-01T00:00:00Z' }),
    ])
    expect(sorted.map((s) => s.id)).toEqual(['c', 'b', 'a'])
  })

  it('does not mutate its input', () => {
    const input = [summary({ id: 'a' }), summary({ id: 'b', is_favorite: true })]
    sortDashboardSummaries(input)
    expect(input.map((s) => s.id)).toEqual(['a', 'b'])
  })
})

describe('local summary touch', () => {
  const layoutEvent = event({ entity_version: 5, payload: { changed_fields: ['layout'] } })

  it('advances version and updated_at for a layout change', () => {
    const [touched] = applyLocalDashboardSummaryUpdate([summary()], layoutEvent)
    expect(touched.version).toBe(5)
    expect(touched.updated_at).toBe('2026-04-05T12:00:00Z')
  })

  it('never moves the version backwards', () => {
    const [touched] = applyLocalDashboardSummaryUpdate([summary({ version: 9 })], layoutEvent)
    expect(touched.version).toBe(9)
  })

  it('leaves widget-only frames alone, because the dashboard row did not move', () => {
    const before = [summary()]
    const after = applyLocalDashboardSummaryUpdate(
      before,
      event({ payload: { changed_fields: ['widgets'] } }),
    )
    expect(after).toBe(before)
  })

  it('returns the same reference when nothing actually changed, so the store can skip its set', () => {
    const before = [summary({ version: 5, updated_at: '2026-04-05T12:00:00Z' })]
    expect(applyLocalDashboardSummaryUpdate(before, layoutEvent)).toBe(before)
  })

  it('re-sorts after a touch, since updated_at drives the order', () => {
    const before = [
      summary({ id: 'other', updated_at: '2026-04-04T00:00:00Z' }),
      summary({ id: 'dash-1', updated_at: '2026-04-01T00:00:00Z' }),
    ]
    expect(applyLocalDashboardSummaryUpdate(before, layoutEvent).map((s) => s.id)).toEqual([
      'dash-1',
      'other',
    ])
  })
})

describe('echo suppression', () => {
  beforeEach(() => {
    __resetPendingDashboardMutationsForTests()
    useAuthStore.setState({ user: { id: 'user-1' } as never })
  })

  it('consumes the entry, so a second ask is false', () => {
    recordPendingDashboardMutation('cm-1')
    const frame = event({ payload: { client_mutation_id: 'cm-1' } })
    expect(consumePendingDashboardMutationEcho(frame)).toBe(true)
    expect(consumePendingDashboardMutationEcho(frame)).toBe(false)
  })

  it('ignores a frame from another actor even with a matching id', () => {
    recordPendingDashboardMutation('cm-1')
    expect(
      consumePendingDashboardMutationEcho(
        event({ actor_id: 'user-2', payload: { client_mutation_id: 'cm-1' } }),
      ),
    ).toBe(false)
  })

  it('suppresses created, deleted and share_updated outright', () => {
    for (const t of ['dashboard.created', 'dashboard.deleted', 'dashboard.share_updated'])
      expect(
        canSuppressLocalDashboardEcho(event({ event_type: t as SseEvent['event_type'] })),
      ).toBe(true)
  })

  it('does not suppress share_added or share_removed — they flip is_shared', () => {
    for (const t of ['dashboard.share_added', 'dashboard.share_removed'])
      expect(
        canSuppressLocalDashboardEcho(event({ event_type: t as SseEvent['event_type'] })),
      ).toBe(false)
  })

  it('refuses to suppress an updated frame carrying a value this build does not know', () => {
    // The cast is the point: ChangedField stops a *consumer* naming a value no producer emits,
    // but a newer backend can still put one on the wire, and types do not reach that.
    const fromNewerBackend = event({
      payload: { changed_fields: ['teleported'] as never },
    })
    expect(canSuppressLocalDashboardEcho(fromNewerBackend)).toBe(false)
  })
})

describe('skipping the summaries reload', () => {
  it('skips only for frames the client can apply itself', () => {
    expect(canSkipDashboardSummaryReload(event({ payload: { changed_fields: ['layout'] } }))).toBe(
      true,
    )
    expect(canSkipDashboardSummaryReload(event({ payload: { changed_fields: ['name'] } }))).toBe(
      false,
    )
    expect(canSkipDashboardSummaryReload(event({ payload: { changed_fields: [] } }))).toBe(false)
  })
})

describe('widget config patch', () => {
  const dashboard = {
    id: 'dash-1',
    widgets: [
      { id: 'w1', config: { view: 'week' } },
      { id: 'w2', config: { view: 'day' } },
    ],
    version: 3,
  } as unknown as Dashboard

  const patchEvent = event({
    payload: { changed_fields: ['widgets'], widget_id: 'w1', config: { view: 'month' } },
  })

  it('replaces only the named widget and leaves version alone', () => {
    const next = patchWidgetConfig(dashboard, patchEvent)
    expect(next?.widgets[0].config).toEqual({ view: 'month' })
    expect(next?.widgets[1]).toBe(dashboard.widgets[1])
    // Bumping it would let a stale layout save claim to be current.
    expect(next?.version).toBe(3)
  })

  it('declines when the frame also moved the layout', () => {
    expect(
      patchWidgetConfig(
        dashboard,
        event({
          payload: {
            changed_fields: ['widgets', 'layout'],
            widget_id: 'w1',
            config: { view: 'month' },
          },
        }),
      ),
    ).toBe(null)
  })

  it('declines for an unknown widget, a missing payload, or no dashboard', () => {
    expect(
      patchWidgetConfig(
        dashboard,
        event({ payload: { changed_fields: ['widgets'], widget_id: 'nope', config: {} } }),
      ),
    ).toBe(null)
    expect(patchWidgetConfig(dashboard, event({ payload: { changed_fields: ['widgets'] } }))).toBe(
      null,
    )
    expect(patchWidgetConfig(null, patchEvent)).toBe(null)
  })
})
