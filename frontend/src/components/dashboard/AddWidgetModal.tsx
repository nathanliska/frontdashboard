import { ArrowLeft, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { WidgetCreate } from '../../api/dashboards'
import { AddWidgetCalendarStep } from './widgets/AddWidgetCalendarStep'
import { AddWidgetListStep } from './widgets/AddWidgetListStep'
import { AddWidgetTypeStep } from './widgets/AddWidgetTypeStep'

export function AddWidgetModal({
  onAdd,
  onClose,
  dashboardId,
  existingListIds,
  isSharedDashboard,
  dashboardName,
}: {
  onAdd: (params: WidgetCreate) => Promise<void>
  onClose: () => void
  dashboardId: string
  existingListIds: string[]
  isSharedDashboard: boolean
  dashboardName?: string
}) {
  const [step, setStep] = useState<'pick-type' | 'pick-list' | 'pick-calendar'>('pick-type')
  const backdropRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    backdropRef.current?.focus()
  }, [])

  function handleEscape() {
    if (step !== 'pick-type') {
      setStep('pick-type')
      return
    }

    onClose()
  }

  return (
    <div
      ref={backdropRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          handleEscape()
        }
      }}
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose()
      }}
    >
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-sm mx-4">
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-zinc-800">
          {step !== 'pick-type' && (
            <button
              type="button"
              onClick={() => setStep('pick-type')}
              className="text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <ArrowLeft size={14} />
            </button>
          )}
          <h2 className="flex-1 text-sm font-semibold text-zinc-100">
            {step === 'pick-type'
              ? 'Add widget'
              : step === 'pick-list'
                ? 'Add a list'
                : 'Choose a calendar view'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-600 hover:text-zinc-300 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {step === 'pick-type' ? (
          <AddWidgetTypeStep
            isSharedDashboard={isSharedDashboard}
            dashboardName={dashboardName}
            onPickList={() => setStep('pick-list')}
            onPickCalendar={() => setStep('pick-calendar')}
            onAdd={onAdd}
          />
        ) : step === 'pick-list' ? (
          <AddWidgetListStep
            dashboardId={dashboardId}
            existingListIds={existingListIds}
            isSharedDashboard={isSharedDashboard}
            dashboardName={dashboardName}
            onAdd={onAdd}
          />
        ) : (
          <AddWidgetCalendarStep
            isSharedDashboard={isSharedDashboard}
            dashboardName={dashboardName}
            onAdd={onAdd}
          />
        )}
      </div>
    </div>
  )
}
