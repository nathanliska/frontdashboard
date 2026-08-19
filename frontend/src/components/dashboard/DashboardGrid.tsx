import { memo, useCallback, useMemo, useState } from 'react'
import { GridLayout, type Layout } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import type { Dashboard, DashboardWidget, LayoutItem } from '../../api/dashboards'
import { useContainerSize } from '../../hooks/useContainerSize'
import { confirm } from '../../stores/confirm'
import { useDashboardStore } from '../../stores/dashboard'
import { WidgetContainer } from './WidgetContainer'

function sameLayout(a: LayoutItem[], b: Layout): boolean {
  if (a.length !== b.length) return false

  const byId = new Map(a.map((item) => [item.i, item]))
  return b.every((item) => {
    const current = byId.get(item.i)
    return (
      current != null &&
      current.x === item.x &&
      current.y === item.y &&
      current.w === item.w &&
      current.h === item.h
    )
  })
}

function mobileStackLayout(layout: LayoutItem[]): LayoutItem[] {
  const sorted = [...layout].sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y
    if (a.x !== b.x) return a.x - b.x
    return a.i.localeCompare(b.i)
  })

  let nextY = 0
  return sorted.map((item) => {
    const normalized = {
      ...item,
      x: 0,
      y: nextY,
      w: 1,
    }
    nextY += Math.max(1, item.h)
    return normalized
  })
}

const DashboardGridContent = memo(function DashboardGridContent({
  widget,
  dashboardId,
  isSharedDashboard,
  canEdit,
  removeWidget,
}: {
  widget: DashboardWidget
  dashboardId: string
  isSharedDashboard: boolean
  canEdit: boolean
  removeWidget: (widgetId: string) => Promise<boolean>
}) {
  const handleRemove = useCallback(async () => {
    if (await confirm('Remove this widget from the dashboard?', { confirmLabel: 'Remove' })) {
      void removeWidget(widget.id)
    }
  }, [removeWidget, widget.id])

  return (
    <WidgetContainer
      widget={widget}
      dashboardId={dashboardId}
      isSharedDashboard={isSharedDashboard}
      canEdit={canEdit}
      onRemove={handleRemove}
    />
  )
})

export function DashboardGrid({ dashboard, canEdit }: { dashboard: Dashboard; canEdit: boolean }) {
  const saveLayout = useDashboardStore((s) => s.saveLayout)
  const removeWidget = useDashboardStore((s) => s.removeWidget)
  // Measured rather than queried in CSS: react-grid-layout takes a column count and a row height
  // as numbers, so this one cannot move into `@container`.
  const [containerRef, { width: containerWidth }] = useContainerSize({ width: 1200, height: 800 })
  const [draftLayout, setDraftLayout] = useState<LayoutItem[]>(dashboard.layout)
  const [draftBaseVersion, setDraftBaseVersion] = useState(dashboard.version)
  const activeLayout = useMemo(
    () => (draftBaseVersion === dashboard.version ? draftLayout : dashboard.layout),
    [dashboard.layout, dashboard.version, draftBaseVersion, draftLayout],
  )
  const isMobile = containerWidth < 640
  // Above the mobile breakpoint the column count is always the canonical 12. The tablet band used
  // to render at 6, which is not a projection but a remap: react-grid-layout clamps every item
  // whose x + w exceeds cols, and those corrections arrive through onLayoutChange like a user
  // drag — so a single touch on a tablet persisted a 6-column arrangement over the canonical one
  //. Only density is allowed to vary by width; the grid the layout is expressed in is not.
  const cols = isMobile ? 1 : 12
  const presentedLayout = useMemo(
    () => (isMobile ? mobileStackLayout(activeLayout) : activeLayout),
    [activeLayout, isMobile],
  )
  const rowHeight = isMobile ? 64 : containerWidth < 960 ? 72 : 80
  const margin =
    containerWidth < 640 ? ([8, 8] as [number, number]) : ([12, 12] as [number, number])
  const containerPadding = [0, 0] as [number, number]

  const handleLayoutChange = useCallback(
    (newLayout: Layout) => {
      // The mobile layout is a derived projection (mobileStackLayout), not a user arrangement, so
      // it must never be written back to the canonical draft; read-only views can't edit either.
      // Enabling real mobile editing later means giving mobile its own persisted per-breakpoint
      // layout (see docs/designs/dashboard-layout-save-correctness-design.md) — not deleting this
      // guard.
      if (isMobile || !canEdit) return
      setDraftBaseVersion(dashboard.version)
      setDraftLayout([...newLayout] as unknown as LayoutItem[])
    },
    [canEdit, dashboard.version, isMobile],
  )

  const handleLayoutStop = useCallback(
    (newLayout: Layout) => {
      if (!canEdit || isMobile) return
      setDraftBaseVersion(dashboard.version)
      setDraftLayout([...newLayout] as unknown as LayoutItem[])
      if (sameLayout(dashboard.layout, newLayout)) return
      void saveLayout([...newLayout] as unknown as LayoutItem[])
    },
    [canEdit, dashboard.layout, dashboard.version, isMobile, saveLayout],
  )

  if (dashboard.widgets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-zinc-600">
        <p className="text-sm">No widgets yet.</p>
        <p className="text-xs mt-1">
          {canEdit
            ? 'Use the button above to add your first widget.'
            : 'An editor can add widgets to this dashboard.'}
        </p>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="w-full">
      <GridLayout
        layout={presentedLayout as unknown as Layout}
        width={containerWidth}
        gridConfig={{ cols, rowHeight, margin, containerPadding }}
        dragConfig={{ enabled: canEdit && !isMobile, handle: '.drag-handle' }}
        resizeConfig={{ enabled: canEdit && !isMobile }}
        onLayoutChange={handleLayoutChange}
        onDragStop={handleLayoutStop}
        onResizeStop={handleLayoutStop}
        className="w-full"
      >
        {dashboard.widgets.map((widget) => (
          // react-grid-layout needs a DOM element as the direct child so it can attach drag props.
          <div key={widget.id}>
            <DashboardGridContent
              widget={widget}
              dashboardId={dashboard.id}
              isSharedDashboard={dashboard.is_shared}
              canEdit={canEdit}
              removeWidget={removeWidget}
            />
          </div>
        ))}
      </GridLayout>
    </div>
  )
}
