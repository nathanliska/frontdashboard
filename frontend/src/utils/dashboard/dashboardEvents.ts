/**
 * Reading a dashboard SSE frame: what it refers to, and what the client owes it.
 *
 * Each takes a frame and returns an answer, so they can be exercised without a store. All are
 * pure but one: `isOwnDashboardEcho` reads the auth store for the signed-in user.
 *
 * Which fields imply what is the vocabulary table's job
 * ([FDR-008 §10](../../../../docs/fdr/FDR-008-realtime-sse.md)); this layer decides what the
 * *store* does with that answer.
 */
import type { Dashboard, DashboardSummary } from '../../api/dashboards'
import type { SseEvent } from '../../hooks/useSSE'
import { useAuthStore } from '../../stores/auth'
import { isOwnFrame } from '../shared/clientInstance'
import {
  isEchoSuppressible,
  isFullyAppliedLocally,
  isOnly,
  movesDashboardRow,
} from './changedFields'

export function getEventDashboardId(event: SseEvent): string | null {
  if (event.entity_type === 'dashboard') {
    return event.entity_id
  }

  return event.payload.dashboard_id ?? null
}

function getDashboardEventChangedFields(event: SseEvent): string[] {
  return event.payload.changed_fields ?? []
}

export function isDashboardShareEvent(event: SseEvent): boolean {
  return (
    event.event_type === 'dashboard.share_added' ||
    event.event_type === 'dashboard.share_updated' ||
    event.event_type === 'dashboard.share_removed'
  )
}

export function isLayoutOnlyDashboardEvent(event: SseEvent): boolean {
  return (
    event.event_type === 'dashboard.updated' &&
    isOnly(getDashboardEventChangedFields(event), 'layout')
  )
}

/** True when the client can settle this frame without a `GET /dashboards`. */
export function canSkipDashboardSummaryReload(event: SseEvent): boolean {
  return (
    event.event_type === 'dashboard.updated' &&
    isFullyAppliedLocally(getDashboardEventChangedFields(event))
  )
}

/**
 * A skipped reload still leaves a stale `updated_at`, but only where the write moved the row.
 * A widget-config change writes the widget alone, so there is nothing to touch.
 */
function shouldApplyLocalDashboardSummaryTouch(event: SseEvent): boolean {
  const changedFields = getDashboardEventChangedFields(event)
  return (
    event.event_type === 'dashboard.updated' &&
    isFullyAppliedLocally(changedFields) &&
    movesDashboardRow(changedFields)
  )
}

export function sortDashboardSummaries(summaries: DashboardSummary[]): DashboardSummary[] {
  return [...summaries].sort((a, b) => {
    if (a.is_favorite !== b.is_favorite) return Number(b.is_favorite) - Number(a.is_favorite)
    return b.updated_at.localeCompare(a.updated_at)
  })
}

/** Returns the same array reference when nothing changed, so the store can skip the `set`. */
export function applyLocalDashboardSummaryUpdate(
  summaries: DashboardSummary[],
  event: SseEvent,
): DashboardSummary[] {
  if (!shouldApplyLocalDashboardSummaryTouch(event)) return summaries

  const dashboardId = getEventDashboardId(event)
  if (!dashboardId) return summaries

  let didChange = false
  const nextSummaries = summaries.map((summary) => {
    if (summary.id !== dashboardId) return summary
    const nextVersion =
      event.entity_version > summary.version ? event.entity_version : summary.version
    if (summary.version === nextVersion && summary.updated_at === event.created_at) {
      return summary
    }
    didChange = true
    return {
      ...summary,
      version: nextVersion,
      updated_at: event.created_at,
    }
  })

  return didChange ? sortDashboardSummaries(nextSummaries) : summaries
}

/** True when the frame echoes a write this tab issued; a pure check, safe to ask repeatedly. */
export function isOwnDashboardEcho(event: SseEvent): boolean {
  return isOwnFrame(event, useAuthStore.getState().user?.id)
}

/**
 * True when the actor's own echo needs no reload, the mutation response having applied it already.
 * Suppressing obliges the caller to have patched whatever a refetch would have refreshed.
 */
export function canSuppressLocalDashboardEcho(event: SseEvent): boolean {
  if (event.event_type === 'dashboard.created' || event.event_type === 'dashboard.deleted') {
    return true
  }

  // A role change alters nothing this client caches: summaries key access flags off share
  // *existence* (is_shared/access_description), not role, and the settings modal already applied
  // the PATCH response. Add/remove echoes still reload — they flip is_shared.
  if (event.event_type === 'dashboard.share_updated') return true

  // Leaving is the actor shedding their own row: the store already dropped the summary, so unlike
  // an owner's removal there is no is_shared flip left to fetch.
  if (event.event_type === 'dashboard.share_removed') {
    return event.payload.share_action === 'left'
  }

  if (event.event_type !== 'dashboard.updated') return false

  return isEchoSuppressible(getDashboardEventChangedFields(event))
}

/** True when the frame moves a dashboard into or out of the trash. */
export function affectsTrash(event: SseEvent): boolean {
  return (
    event.event_type === 'dashboard.deleted' ||
    (event.event_type === 'dashboard.updated' &&
      getDashboardEventChangedFields(event).includes('restored'))
  )
}

/**
 * The dashboard with one widget's config replaced, or null when the frame does not apply.
 *
 * `version` is deliberately untouched: only layout writes bump it, and it is what `PUT /layout`
 * compares to detect a concurrent edit. Writing it here would let a stale layout save claim to be
 * current — which is why a frame carrying `'layout'` too is excluded rather than patched.
 */
export function patchWidgetConfig(dashboard: Dashboard | null, event: SseEvent): Dashboard | null {
  if (!isOnly(getDashboardEventChangedFields(event), 'widgets')) return null
  if (!dashboard) return null

  const widgetId = event.payload.widget_id
  const config = event.payload.config
  if (!widgetId || !config) return null
  if (!dashboard.widgets.some((widget) => widget.id === widgetId)) return null

  return {
    ...dashboard,
    widgets: dashboard.widgets.map((widget) =>
      widget.id === widgetId ? { ...widget, config } : widget,
    ),
  }
}
