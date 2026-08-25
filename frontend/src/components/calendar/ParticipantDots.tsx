import type { CalendarEventParticipantResponse } from '../../api/generated/contract'
import { participantColor, participantInitial } from '../../utils/participantPalette'

const MAX_DOTS = 3

/**
 * The at-a-glance answer to "whose thing is this": colored initial-dots, capped with a +N
 * overflow. Full names ride the title attribute; screen readers get one combined label.
 */
export function ParticipantDots({
  participants,
  size = 'sm',
}: {
  participants: CalendarEventParticipantResponse[]
  size?: 'xs' | 'sm'
}) {
  if (participants.length === 0) return null

  const shown = participants.slice(0, MAX_DOTS)
  const overflow = participants.length - shown.length
  const names = participants.map((participant) => participant.display_name).join(', ')
  const dotClass = size === 'xs' ? 'h-3.5 w-3.5 text-[8px]' : 'h-5 w-5 text-[10px]'

  return (
    <span
      className="inline-flex shrink-0 items-center -space-x-1"
      role="img"
      aria-label={`For ${names}`}
      title={names}
    >
      {shown.map((participant) => (
        <span
          key={participant.user_id}
          className={`${dotClass} inline-flex items-center justify-center rounded-full font-semibold text-zinc-950 ring-1 ring-zinc-950`}
          style={{ backgroundColor: participantColor(participant.user_id) }}
        >
          {participantInitial(participant.display_name)}
        </span>
      ))}
      {overflow > 0 && (
        <span
          className={`${dotClass} inline-flex items-center justify-center rounded-full bg-zinc-700 font-semibold text-zinc-200 ring-1 ring-zinc-950`}
        >
          +{overflow}
        </span>
      )}
    </span>
  )
}

/**
 * The pill-sized variant: bare color dots, no initials — for one-line surfaces where a word
 * barely fits. Decorative by design; the pill's own title/label carries the names.
 */
export function ParticipantMicroDots({
  participants,
}: {
  participants: Pick<CalendarEventParticipantResponse, 'user_id'>[]
}) {
  if (participants.length === 0) return null
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {participants.slice(0, MAX_DOTS).map((participant) => (
        <span
          key={participant.user_id}
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: participantColor(participant.user_id) }}
        />
      ))}
    </span>
  )
}
