/**
 * What each `changed_fields` value means, in one place.
 *
 * A `dashboard.updated` frame says *what* changed but not what a client should do about it, and
 * the answer differed per value across five predicates in the store and two in the activity feed.
 * Each was individually right and collectively unreadable: nothing showed which combinations were
 * possible, so extending the vocabulary meant re-deriving all seven by hand.
 *
 * The two facts below decide every refetch question. The vocabulary itself is generated from the
 * backend enum, so a value here that no producer emits is a type error.
 *
 * Order is never significant. Rows already in the activity log carry `['widgets', 'layout']`
 * unsorted and are immutable, so no consumer may compare against an ordered array.
 */
import type { ChangedField } from '../../api/generated/contract'

interface ChangedFieldEffect {
  /**
   * The client can compute the new summary state itself, so the frame needs no `GET /dashboards`.
   * False means only the server knows the result — access flags, trash membership, sort position.
   */
  appliedLocally: boolean
  /**
   * The write modified the `dashboards` row, so its `updated_at` moved and any cached summary is
   * stale until touched. `widgets` alone writes only the widget row and moves nothing.
   */
  touchesDashboardRow: boolean
  /**
   * Feed precedence when a frame carries several — the greater number wins the summary line.
   * Adding a widget also moves the layout, and "added a widget" is the truer sentence.
   */
  feedPrecedence: number
  /**
   * The actor's own mutation response already carried this change, so echoing it back needs no
   * reload at all. False for anything whose effect the response body does not describe.
   */
  echoSuppressible: boolean
}

const EFFECTS: Record<ChangedField, ChangedFieldEffect> = {
  layout: {
    appliedLocally: true,
    touchesDashboardRow: true,
    feedPrecedence: 1,
    echoSuppressible: true,
  },
  widgets: {
    appliedLocally: true,
    touchesDashboardRow: false,
    feedPrecedence: 2,
    echoSuppressible: true,
  },
  name: {
    appliedLocally: false,
    touchesDashboardRow: true,
    feedPrecedence: 3,
    echoSuppressible: true,
  },
  restored: {
    appliedLocally: false,
    touchesDashboardRow: true,
    feedPrecedence: 4,
    echoSuppressible: true,
  },
  // Lives on `dashboard.share_*` frames, which every consumer identifies by event_type instead.
  // Present so the vocabulary is total; it never reaches a `dashboard.updated` predicate.
  shares: {
    appliedLocally: false,
    touchesDashboardRow: false,
    feedPrecedence: 0,
    echoSuppressible: false,
  },
}

function isKnown(field: string): field is ChangedField {
  return field in EFFECTS
}

/**
 * An unknown value fails safe: every capability reads false, so the caller refetches rather than
 * trusting a frame this build does not understand. A newer backend must not silence an old tab.
 */
const UNKNOWN_EFFECT: ChangedFieldEffect = {
  appliedLocally: false,
  touchesDashboardRow: false,
  feedPrecedence: 0,
  echoSuppressible: false,
}

function effectOf(field: string): ChangedFieldEffect {
  return isKnown(field) ? EFFECTS[field] : UNKNOWN_EFFECT
}

/** True when every field can be applied client-side, so no summaries refetch is needed. */
export function isFullyAppliedLocally(fields: readonly string[]): boolean {
  return fields.length > 0 && fields.every((field) => effectOf(field).appliedLocally)
}

/** True when some field moved the dashboard row, so a cached summary needs its version bumped. */
export function movesDashboardRow(fields: readonly string[]): boolean {
  return fields.some((field) => effectOf(field).touchesDashboardRow)
}

/** True when the actor's own mutation response already applied every field in the frame. */
export function isEchoSuppressible(fields: readonly string[]): boolean {
  return fields.length > 0 && fields.every((field) => effectOf(field).echoSuppressible)
}

/** True when `fields` is exactly this one value and nothing else. */
export function isOnly(fields: readonly string[], field: ChangedField): boolean {
  return fields.length === 1 && fields[0] === field
}

/** The value a human-readable summary should describe, or null when there is nothing to say. */
export function primaryChangedField(fields: readonly string[]): ChangedField | null {
  let best: ChangedField | null = null
  let bestPrecedence = 0
  for (const field of fields) {
    if (!isKnown(field)) continue
    const { feedPrecedence } = EFFECTS[field]
    if (feedPrecedence > bestPrecedence) {
      best = field
      bestPrecedence = feedPrecedence
    }
  }
  return best
}
