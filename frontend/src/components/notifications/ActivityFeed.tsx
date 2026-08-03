import type { ActivityEvent } from '../../api/notifications'
import {
  type ActivityGroup,
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
      {groupActivityEvents(activity).map((group) => (
        <ActivityFeedItem key={group.event.event_id} group={group} />
      ))}
    </div>
  )
}

export function ActivityFeedItem({ group }: { group: ActivityGroup }) {
  const { event } = group
  const presentation = formatActivityGroup(group)

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
      </div>
    </div>
  )
}
