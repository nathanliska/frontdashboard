import { ListFilter } from 'lucide-react'
import { useId } from 'react'
import {
  ACTIVITY_FILTERS,
  type ActivityFilterOption,
} from '../../utils/notifications/notificationFeedUtils'

type ActivityFilterSelectProps = {
  value: string
  onChange: (filterId: string) => void
}

/** Splits the flat option list into the headless options and the `optgroup`s, preserving order. */
function partitionByGroup(
  options: readonly ActivityFilterOption[],
): [ActivityFilterOption[], [string, ActivityFilterOption[]][]] {
  const ungrouped: ActivityFilterOption[] = []
  const groups = new Map<string, ActivityFilterOption[]>()

  for (const option of options) {
    if (option.group === null) {
      ungrouped.push(option)
      continue
    }
    const existing = groups.get(option.group)
    if (existing) {
      existing.push(option)
    } else {
      groups.set(option.group, [option])
    }
  }

  return [ungrouped, [...groups]]
}

// The option list is a module constant, so its shape is too.
const [UNGROUPED_FILTERS, GROUPED_FILTERS] = partitionByGroup(ACTIVITY_FILTERS)

/**
 * Narrows the activity feed to one category or one event type.
 *
 * A native select rather than an icon menu: it renders its own current value, and a filter you
 * can't see the state of reads as activity having gone missing.
 */
export function ActivityFilterSelect({ value, onChange }: ActivityFilterSelectProps) {
  const selectId = useId()

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <ListFilter size={14} className="text-zinc-500" aria-hidden="true" />
      <label htmlFor={selectId} className="sr-only">
        Filter activity
      </label>
      <select
        id={selectId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300 transition-colors hover:border-zinc-700 focus:border-zinc-600 focus:outline-none"
      >
        {UNGROUPED_FILTERS.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
        {GROUPED_FILTERS.map(([group, options]) => (
          <optgroup key={group} label={group}>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  )
}
