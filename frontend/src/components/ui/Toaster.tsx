import { CheckCircle, Info, X, XCircle } from 'lucide-react'
import { useToastStore, type ToastType } from '../../stores/toast'
import { cn } from '../../utils/cn'

const ICONS: Record<ToastType, React.ElementType> = {
  success: CheckCircle,
  error: XCircle,
  info: Info,
}

const STYLES: Record<ToastType, string> = {
  success: 'border-green-500/30 bg-green-500/10 text-green-300',
  error: 'border-red-500/30 bg-red-500/10 text-red-300',
  info: 'border-zinc-700 bg-zinc-800 text-zinc-300',
}

export function Toaster() {
  const { toasts, dismiss } = useToastStore()

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => {
        const Icon = ICONS[t.type]
        return (
          <div
            key={t.id}
            className={cn(
              'flex items-start gap-2.5 px-4 py-3 rounded-lg border shadow-lg pointer-events-auto max-w-sm text-sm',
              STYLES[t.type],
            )}
          >
            <Icon size={15} className="shrink-0 mt-0.5" />
            <span className="flex-1">{t.message}</span>
            <button
              onClick={() => dismiss(t.id)}
              className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
              aria-label="Dismiss"
            >
              <X size={13} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
