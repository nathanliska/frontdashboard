import { describe, expect, it } from 'vitest'
import type { DashboardWidget } from '../../api/dashboards'
import { boundListId } from './widgetBinding'

function widget(overrides: Partial<DashboardWidget>): DashboardWidget {
  return {
    id: 'w-1',
    dashboard_id: 'dash-1',
    widget_type: 'list',
    config: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as DashboardWidget
}

describe('boundListId', () => {
  it('reads the list a widget shows', () => {
    expect(boundListId(widget({ list_id: 'l-1' }))).toBe('l-1')
  })

  it('answers null for a widget that binds no list', () => {
    expect(boundListId(widget({ widget_type: 'clock' }))).toBeNull()
    expect(boundListId(widget({ list_id: null }))).toBeNull()
  })
})
