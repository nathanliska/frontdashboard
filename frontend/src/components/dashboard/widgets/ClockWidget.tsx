import { useEffect, useRef, useState } from 'react'

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
  config: Record<string, unknown>
  isSharedDashboard: boolean
}) {
  const [date, setDate] = useState(now)
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(300)
  const configuredTimezone =
    typeof config.timezone === 'string' && config.timezone ? config.timezone : undefined
  const sharedTimezone = isSharedDashboard ? (configuredTimezone ?? 'UTC') : undefined
  const sharedLocale = isSharedDashboard ? 'en-US' : undefined

  // Tick every second
  useEffect(() => {
    const id = setInterval(() => setDate(now()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
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
  const isTiny = containerWidth < 180

  return (
    <div
      ref={containerRef}
      className="h-full flex flex-col items-center justify-center gap-1 select-none"
    >
      <div className="flex items-end gap-1">
        <span
          className="font-semibold text-zinc-100 tabular-nums leading-none"
          style={{ fontSize: isTiny ? '1.5rem' : '2.25rem' }}
        >
          {time}
        </span>
        {!isTiny && (
          <span className="text-zinc-600 tabular-nums text-sm leading-none mb-0.5">{seconds}s</span>
        )}
      </div>
      {!isTiny && (
        <p className="text-xs text-zinc-500">
          {dateStr}
          {sharedTimezone ? ` · ${sharedTimezone}` : ''}
        </p>
      )}
    </div>
  )
}
