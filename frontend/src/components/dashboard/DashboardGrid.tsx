import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import GridLayout, { WidthProvider, type Layout } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import type { Dashboard, DashboardWidget, LayoutItem } from '../../api/dashboards'
import { confirm } from '../../stores/confirm'
import { useDashboardStore } from '../../stores/dashboard'
import { WidgetContainer } from './WidgetContainer'

const ResponsiveGrid = WidthProvider(GridLayout)

function sameLayout(a: LayoutItem[], b: Layout[]): boolean {
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
  removeWidget: (widgetId: string) => Promise<void>
}) {
  const handleRemove = useCallback(async () => {
    if (await confirm('Remove this widget from the dashboard?')) {
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
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(1200)
  const [draftLayout, setDraftLayout] = useState<LayoutItem[]>(dashboard.layout)
  const [draftBaseVersion, setDraftBaseVersion] = useState(dashboard.version)
  const activeLayout = useMemo(
    () => (draftBaseVersion === dashboard.version ? draftLayout : dashboard.layout),
    [dashboard.layout, dashboard.version, draftBaseVersion, draftLayout],
  )
  const isMobile = containerWidth < 640
  const cols = isMobile ? 1 : containerWidth < 960 ? 6 : 12
  const presentedLayout = useMemo(
    () => (isMobile ? mobileStackLayout(activeLayout) : activeLayout),
    [activeLayout, isMobile],
  )
  const rowHeight = isMobile ? 64 : containerWidth < 960 ? 72 : 80
  const margin =
    containerWidth < 640 ? ([8, 8] as [number, number]) : ([12, 12] as [number, number])
  const containerPadding = [0, 0] as [number, number]

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const handleLayoutChange = useCallback(
    (newLayout: Layout[]) => {
      setDraftBaseVersion(dashboard.version)
      setDraftLayout(newLayout as LayoutItem[])
    },
    [dashboard.version],
  )

  const handleLayoutStop = useCallback(
    (newLayout: Layout[]) => {
      if (!canEdit || isMobile) return
      setDraftBaseVersion(dashboard.version)
      setDraftLayout(newLayout as LayoutItem[])
      if (sameLayout(dashboard.layout, newLayout)) return
      void saveLayout(newLayout as LayoutItem[])
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
      <ResponsiveGrid
        layout={presentedLayout}
        cols={cols}
        rowHeight={rowHeight}
        margin={margin}
        containerPadding={containerPadding}
        isDraggable={canEdit && !isMobile}
        isResizable={canEdit && !isMobile}
        draggableHandle=".drag-handle"
        onLayoutChange={handleLayoutChange}
        onDragStop={handleLayoutStop}
        onResizeStop={handleLayoutStop}
        className="w-full"
        compactType="vertical"
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
      </ResponsiveGrid>
    </div>
  )
}
