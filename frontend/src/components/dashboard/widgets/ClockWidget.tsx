import { useEffect, useState } from 'react'
import type { ClockWidgetConfig } from '../../../api/dashboards'

function now() {
  return new Date()
}

function formatTime(
  date: Date,
  timeZone: string | undefined,
  options: Intl.DateTimeFormatOptions,
  locale?: string,
) {
  return new Intl.DateTimeFormat(locale, {
    ...options,
    ...(timeZone ? { timeZone } : {}),
  }).format(date)
}

export function ClockWidget({
  config,
  isSharedDashboard,
}: {
  config: ClockWidgetConfig
  isSharedDashboard: boolean
}) {
  const [date, setDate] = useState(now)
  const configuredTimezone = config.timezone || undefined
  const sharedTimezone = isSharedDashboard ? (configuredTimezone ?? 'UTC') : undefined
  const sharedLocale = isSharedDashboard ? 'en-US' : undefined

  // Tick every second
  useEffect(() => {
    const id = setInterval(() => setDate(now()), 1000)
    return () => clearInterval(id)
  }, [])

  const time = formatTime(
    date,
    sharedTimezone,
    { hour: '2-digit', minute: '2-digit' },
    sharedLocale,
  )
  const seconds = formatTime(date, sharedTimezone, { second: '2-digit' }, sharedLocale).slice(-2)
  const dateStr = formatTime(
    date,
    sharedTimezone,
    { weekday: 'long', month: 'long', day: 'numeric' },
    sharedLocale,
  )
  return (
    <div className="@container h-full flex flex-col items-center justify-center gap-1 select-none">
      <div className="flex items-end gap-1">
        {/* Fluid, not a step: the clock is the widest thing in its cell, so a jump between two
            fixed sizes reads as a snap while the grid is being dragged. */}
        <span
          className="font-semibold text-zinc-100 tabular-nums leading-none"
          style={{ fontSize: 'clamp(1.5rem, 18cqi, 2.25rem)' }}
        >
          {time}
        </span>
        <span className="@max-[180px]:hidden text-zinc-600 tabular-nums text-sm leading-none mb-0.5">
          {seconds}s
        </span>
      </div>
      <p className="@max-[180px]:hidden text-xs text-zinc-500">
        {dateStr}
        {sharedTimezone ? ` · ${sharedTimezone}` : ''}
      </p>
    </div>
  )
}
