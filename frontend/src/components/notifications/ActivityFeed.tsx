import { ChevronDown, ChevronRight } from 'lucide-react'
import { memo, useCallback, useMemo, useState } from 'react'
import type { ActivityEvent } from '../../api/notifications'
import {
  type ActivityGroup,
  formatActivityEvent,
  formatActivityGroup,
  groupActivityEvents,
} from '../../utils/notifications/notificationFeedUtils'

type ActivityFeedProps = {
  activity: ActivityEvent[]
  loading: boolean
  emptyMessage?: string
}

export function ActivityFeed({
  activity,
  loading,
  emptyMessage = 'No activity yet.',
}: ActivityFeedProps) {
  // Openness belongs to the run, not the row: SSE grows a run at the front and "Load more" grows it
  // at the tail, so no single event id keeps identifying it. Asking whether a group still holds an
  // opened id survives growth at either end.
  const [openedIds, setOpenedIds] = useState<ReadonlySet<number>>(() => new Set())
  // Openness lives above the rows now, so a toggle re-renders the feed. Grouping answers to the
  // events alone and must not re-run for it.
  const groups = useMemo(() => groupActivityEvents(activity), [activity])

  const toggle = useCallback((group: ActivityGroup) => {
    setOpenedIds((previous) => {
      const next = new Set(previous)
      const wasOpen = group.members.some((member) => next.has(member.event_id))
      for (const member of group.members) next.delete(member.event_id)
      if (!wasOpen) next.add(group.event.event_id)
      return next
    })
  }, [])

  if (loading) {
    return (
      <div className="flex justify-center py-6">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
      </div>
    )
  }

  if (activity.length === 0) {
    return <p className="text-sm text-zinc-600 py-6 text-center">{emptyMessage}</p>
  }

  return (
    <div className="space-y-1">
      {groups.map((group) => (
        // Keyed on the run's oldest event, unique across rows and unchanged by a live arrival.
        <ActivityFeedItem
          key={group.members[group.members.length - 1].event_id}
          group={group}
          open={group.members.some((member) => openedIds.has(member.event_id))}
          onToggle={toggle}
        />
      ))}
    </div>
  )
}

// Memoized against the stable groups above, so a toggle re-renders the row it touched.
const ActivityFeedItem = memo(function ActivityFeedItem({
  group,
  open,
  onToggle,
}: {
  group: ActivityGroup
  open: boolean
  onToggle: (group: ActivityGroup) => void
}) {
  const { event, members } = group
  const presentation = formatActivityGroup(group)
  const membersId = `activity-run-${event.event_id}`

  return (
    <div className="flex items-start gap-3 px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-lg">
      <div className="flex-1 min-w-0">
        <span className="text-[10px] uppercase tracking-[0.14em] text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded-full">
          {presentation.badge}
        </span>
        <p className="text-sm text-zinc-200 mt-2">{presentation.summary}</p>
        {presentation.detail && (
          <p className="text-sm text-zinc-500 mt-0.5">{presentation.detail}</p>
        )}
        <p className="text-xs text-zinc-600 mt-1">{new Date(event.created_at).toLocaleString()}</p>

        {members.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => onToggle(group)}
              aria-expanded={open}
              aria-controls={membersId}
              className="mt-2 flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {/* The row's only count, naming the lines it reveals rather than the entities they
                  touched — two numbers that differ read as a miscount even when both are right. */}
              {open ? 'Hide' : 'Show'} {members.length} changes
            </button>
            {open && (
              <ul id={membersId} className="mt-1 space-y-1.5 border-l border-zinc-800 pl-3">
                {members.map((member) => (
                  <li key={member.event_id}>
                    <p className="text-sm text-zinc-300">{formatActivityEvent(member).summary}</p>
                    <p className="text-xs text-zinc-600">
                      {new Date(member.created_at).toLocaleString()}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  )
})
