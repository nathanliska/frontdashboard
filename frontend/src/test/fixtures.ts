import type { Dashboard, DashboardSummary } from '../api/dashboards'
import type { ListDetail, ListItem, ListSummary } from '../api/lists'

/**
 * Shared entity fixtures for tests.
 *
 * Each returns a complete, valid entity so a test only has to state the fields it is actually
 * about. Every factory takes `overrides` last and spreads them, so a test that cares about one
 * flag says so and nothing else. These deliberately mirror the generated contract shapes — if a
 * required field is added to the backend model, the type error lands here once instead of in
 * fifteen test files.
 */

export function makeDashboardSummary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    id: 'dash-1',
    user_id: 'user-1',
    name: 'Primary Dashboard',
    archived: false,
    access_description: 'Owned by you',
    is_shared: false,
    can_edit: true,
    can_manage_shares: true,
    is_favorite: false,
    version: 1,
    created_at: '2026-04-05T00:00:00Z',
    updated_at: '2026-04-05T00:00:00Z',
    ...overrides,
  }
}

/** The loaded editor dashboard — a summary plus its layout and widgets. */
export function makeDashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    id: 'dash-1',
    user_id: 'user-1',
    name: 'Primary Dashboard',
    archived: false,
    is_shared: false,
    can_edit: true,
    can_manage_shares: true,
    is_favorite: false,
    layout: [],
    version: 1,
    widgets: [],
    ...overrides,
  }
}

export function makeListSummary(overrides: Partial<ListSummary> = {}): ListSummary {
  return {
    id: 'list-1',
    dashboard_id: 'dash-1',
    name: 'Weekend chores',
    list_type: 'checklist',
    sort_order: 0,
    archived: false,
    created_by: 'user-1',
    created_at: '2026-04-21T00:00:00Z',
    updated_at: '2026-04-21T00:00:00Z',
    item_count: 1,
    ...overrides,
  }
}

export function makeListItem(overrides: Partial<ListItem> = {}): ListItem {
  return {
    id: 'item-1',
    list_id: 'list-1',
    text: 'Take out recycling',
    checked: false,
    sort_order: 0,
    due_date: null,
    priority: null,
    category: null,
    assigned_to: null,
    created_by: 'user-1',
    created_at: '2026-04-21T00:00:00Z',
    updated_at: '2026-04-21T00:00:00Z',
    ...overrides,
  }
}

/**
 * A list with its items. Pass `items` explicitly, or `itemIds` for the common case of "n items
 * whose identity is all the test cares about" — reorder tests in particular only need the ids.
 */
export function makeListDetail(
  overrides: Partial<ListDetail> & { itemIds?: string[] } = {},
): ListDetail {
  const { itemIds, ...rest } = overrides
  const items =
    rest.items ??
    (itemIds ?? ['item-1']).map((id, index) =>
      makeListItem({ id, text: id.toUpperCase(), sort_order: index }),
    )
  return {
    ...makeListSummary(),
    item_count: items.length,
    items,
    ...rest,
  }
}
