import { describe, expect, it } from 'vitest'
import type { DashboardWidget } from '../../api/dashboards'
import { boundListId } from './widgetBinding'

function widget(overrides: Partial<DashboardWidget>): DashboardWidget {
  return {
    id: 'w-1',
    dashboard_id: 'dash-1',
    widget_type: 'list',
    widget_version: 1,
    config: {},
    resource_type: null,
    resource_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as DashboardWidget
}

describe('boundListId', () => {
  it('reads list_id, and prefers it over the generic pair', () => {
    expect(boundListId(widget({ list_id: 'l-1' }))).toBe('l-1')
    expect(boundListId(widget({ list_id: 'l-1', resource_type: 'list', resource_id: 'l-2' }))).toBe(
      'l-1',
    )
  })

  it('falls back to the generic pair when a response carries no list_id', () => {
    expect(boundListId(widget({ resource_type: 'list', resource_id: 'l-2' }))).toBe('l-2')
  })

  it('answers null for a widget that binds no list', () => {
    expect(boundListId(widget({ widget_type: 'clock' }))).toBeNull()
    expect(boundListId(widget({ resource_type: 'calendar_event', resource_id: 'e-1' }))).toBeNull()
  })
})
