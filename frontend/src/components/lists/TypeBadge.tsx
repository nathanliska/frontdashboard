import type { ListType } from '../../api/lists'
import { cn } from '../../utils/shared/cn'

export function TypeBadge({ type }: { type: ListType }) {
  const colors: Record<ListType, string> = {
    checklist: 'text-blue-400 bg-blue-400/10',
    grocery: 'text-green-400 bg-green-400/10',
    todo: 'text-purple-400 bg-purple-400/10',
  }

  return (
    <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', colors[type])}>
      {type}
    </span>
  )
}
