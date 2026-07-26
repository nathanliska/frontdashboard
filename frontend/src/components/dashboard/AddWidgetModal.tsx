import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import type { WidgetCreate } from '../../api/dashboards'
import { Dialog } from '../ui/Dialog'
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

  function handleEscape() {
    if (step !== 'pick-type') {
      setStep('pick-type')
      return
    }

    onClose()
  }

  const title =
    step === 'pick-type'
      ? 'Add widget'
      : step === 'pick-list'
        ? 'Add a list'
        : 'Choose a calendar view'

  return (
    <Dialog
      title={title}
      onClose={onClose}
      onEscape={handleEscape}
      contentClassName="max-w-sm"
      headerAccessory={
        step !== 'pick-type' ? (
          <button
            type="button"
            aria-label="Back to widget types"
            onClick={() => setStep('pick-type')}
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <ArrowLeft size={14} />
          </button>
        ) : undefined
      }
    >
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
    </Dialog>
  )
}
