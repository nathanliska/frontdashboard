import { ACTIVITY_FILTERS } from '../../utils/notifications/notificationFeedUtils'

type ActivityFilterProps = {
  value: string
  onChange: (filterId: string) => void
}

/**
 * Narrows the activity feed to one category.
 *
 * Chips rather than a dropdown: the active filter has to be readable without opening anything,
 * or a narrowed feed reads as activity having gone missing. Six fit on one line; per-type rows
 * would not, which is why they are gone.
 */
export function ActivityFilter({ value, onChange }: ActivityFilterProps) {
  return (
    <fieldset className="flex flex-wrap items-center gap-1.5 border-0 p-0 m-0">
      <legend className="sr-only">Filter activity</legend>
      {ACTIVITY_FILTERS.map((option) => {
        const active = option.id === value
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            aria-pressed={active}
            className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
              active
                ? 'border-zinc-600 bg-zinc-800 text-zinc-100'
                : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
            }`}
          >
            {option.label}
          </button>
        )
      })}
    </fieldset>
  )
}
