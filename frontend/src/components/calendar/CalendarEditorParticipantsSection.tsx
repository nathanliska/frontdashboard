import { useEffect, useState } from 'react'
import { apiListDashboardMembers } from '../../api/dashboards'
import type {
  CalendarEventParticipantResponse,
  DashboardMemberResponse,
} from '../../api/generated/contract'
import { participantColor, participantInitial } from '../../utils/participantPalette'

/**
 * Toggle-chip picker over the dashboard's members. A former member — named on the event but no
 * longer a member — renders greyed while selected and disappears once deselected: keepable,
 * never re-addable, mirroring the API's write rule (FDR-006 §6).
 */
export function CalendarEditorParticipantsSection({
  dashboardId,
  selected,
  initialParticipants,
  onToggle,
}: {
  dashboardId: string | null
  selected: string[]
  initialParticipants: CalendarEventParticipantResponse[]
  onToggle: (userId: string) => void
}) {
  const [members, setMembers] = useState<DashboardMemberResponse[] | null>(null)

  useEffect(() => {
    if (!dashboardId) return
    let cancelled = false
    apiListDashboardMembers(dashboardId)
      .then((loaded) => {
        if (!cancelled) setMembers(loaded)
      })
      .catch(() => {
        // Stay hidden on failure: with an empty member list every selected participant would
        // read as "(former)", so no picker beats a lying one. The draft passes through untouched.
      })
    return () => {
      cancelled = true
    }
  }, [dashboardId])

  const memberIds = new Set((members ?? []).map((member) => member.user_id))
  const formerSelected = initialParticipants.filter(
    (participant) => selected.includes(participant.user_id) && !memberIds.has(participant.user_id),
  )

  if (members === null || (members.length <= 1 && formerSelected.length === 0)) {
    // Alone on the dashboard there is no one to point at; a one-chip picker is noise.
    return null
  }

  return (
    <fieldset className="rounded-xl border border-zinc-800 bg-zinc-900/30 px-3 py-2.5">
      <legend className="px-0.5 text-xs text-zinc-500">For</legend>
      <div className="flex flex-wrap gap-1.5">
        {members.map((member) => {
          const isSelected = selected.includes(member.user_id)
          return (
            <button
              key={member.user_id}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onToggle(member.user_id)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                isSelected
                  ? 'border-zinc-500 bg-zinc-800 text-zinc-100'
                  : 'border-zinc-800 bg-zinc-900/50 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
              }`}
            >
              <span
                className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold text-zinc-950"
                style={{ backgroundColor: participantColor(member.user_id) }}
              >
                {participantInitial(member.display_name)}
              </span>
              {member.display_name}
            </button>
          )
        })}
        {formerSelected.map((participant) => (
          <button
            key={participant.user_id}
            type="button"
            aria-pressed="true"
            onClick={() => onToggle(participant.user_id)}
            className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-500"
          >
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-zinc-700 text-[9px] font-semibold text-zinc-300">
              {participantInitial(participant.display_name)}
            </span>
            {participant.display_name}
            <span className="text-zinc-600">(former)</span>
          </button>
        ))}
      </div>
    </fieldset>
  )
}
