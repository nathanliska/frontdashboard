import { describe, expect, it } from 'vitest'
import {
  isEchoSuppressible,
  isFullyAppliedLocally,
  isOnly,
  movesDashboardRow,
  primaryChangedField,
} from './changedFields'

// Every combination a backend producer actually emits, with the answers the store must give.
// Sourced from the seven `changed_fields` sites in dashboards.py and invites.py.
const EMITTED = [
  { fields: ['layout'], appliedLocally: true, movesRow: true, primary: 'layout' },
  { fields: ['widgets'], appliedLocally: true, movesRow: false, primary: 'widgets' },
  { fields: ['widgets', 'layout'], appliedLocally: true, movesRow: true, primary: 'widgets' },
  { fields: ['name'], appliedLocally: false, movesRow: true, primary: 'name' },
  { fields: ['restored'], appliedLocally: false, movesRow: true, primary: 'restored' },
  { fields: ['shares'], appliedLocally: false, movesRow: false, primary: null },
] as const

describe('changed_fields vocabulary', () => {
  it.each(EMITTED)('classifies $fields', ({ fields, appliedLocally, movesRow, primary }) => {
    expect(isFullyAppliedLocally(fields)).toBe(appliedLocally)
    expect(movesDashboardRow(fields)).toBe(movesRow)
    expect(primaryChangedField(fields)).toBe(primary)
  })

  it('is order independent, because logged rows are unsorted and immutable', () => {
    for (const { fields } of EMITTED) {
      const reversed = [...fields].reverse()
      expect(isFullyAppliedLocally(reversed)).toBe(isFullyAppliedLocally(fields))
      expect(movesDashboardRow(reversed)).toBe(movesDashboardRow(fields))
      expect(isEchoSuppressible(reversed)).toBe(isEchoSuppressible(fields))
      expect(primaryChangedField(reversed)).toBe(primaryChangedField(fields))
    }
  })

  it('widgets alone moves no dashboard row, so a skipped reload needs no summary touch', () => {
    // The distinction the five old predicates encoded by hand: a widget-config write touches the
    // widget row only, so `updated_at` never moves and a locally-patched summary is already right.
    expect(isFullyAppliedLocally(['widgets'])).toBe(true)
    expect(movesDashboardRow(['widgets'])).toBe(false)
    expect(movesDashboardRow(['widgets', 'layout'])).toBe(true)
  })

  describe('an unrecognised value fails safe', () => {
    // A newer backend must never talk an older tab out of refetching.
    const unknown = ['teleported']

    it('is not applied locally', () => expect(isFullyAppliedLocally(unknown)).toBe(false))
    it('does not claim to move the row', () => expect(movesDashboardRow(unknown)).toBe(false))
    it('is not echo suppressible', () => expect(isEchoSuppressible(unknown)).toBe(false))
    it('has no summary to render', () => expect(primaryChangedField(unknown)).toBe(null))

    it('poisons an otherwise locally-applicable set', () => {
      expect(isFullyAppliedLocally(['layout', 'teleported'])).toBe(false)
      expect(isEchoSuppressible(['layout', 'teleported'])).toBe(false)
    })
  })

  it('treats an empty set as nothing to act on', () => {
    expect(isFullyAppliedLocally([])).toBe(false)
    expect(isEchoSuppressible([])).toBe(false)
    expect(movesDashboardRow([])).toBe(false)
    expect(primaryChangedField([])).toBe(null)
  })

  it('suppresses a local echo for every value except shares', () => {
    expect(isEchoSuppressible(['layout'])).toBe(true)
    expect(isEchoSuppressible(['widgets'])).toBe(true)
    expect(isEchoSuppressible(['name'])).toBe(true)
    expect(isEchoSuppressible(['restored'])).toBe(true)
    // Share frames are identified by event_type, so this never gates a real decision — but
    // add/remove flip is_shared, which no dashboard mutation response carries.
    expect(isEchoSuppressible(['shares'])).toBe(false)
  })

  it('isOnly is exact, not a membership test', () => {
    expect(isOnly(['layout'], 'layout')).toBe(true)
    expect(isOnly(['widgets', 'layout'], 'layout')).toBe(false)
    expect(isOnly([], 'layout')).toBe(false)
  })
})
