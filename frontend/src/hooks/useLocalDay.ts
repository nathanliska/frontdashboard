import { useEffect, useState } from 'react'
import { dateKey, startOfDay } from '../utils/calendar/calendarUtils'

function currentDayKey(): string {
  return dateKey(startOfDay(new Date()))
}

function msUntilNextMidnight(): number {
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0)
  return next.getTime() - now.getTime()
}

/**
 * The current local calendar day as a 'YYYY-MM-DD' key. Re-renders consumers when the day rolls
 * over — at local midnight (DST-safe: the next midnight is recomputed from local Date parts, never
 * by adding 24h) and whenever a backgrounded tab becomes visible again (a display that slept
 * through midnight, which a setTimeout does not reliably fire across). Lets always-on dashboards
 * refresh day-dependent data instead of showing yesterday indefinitely.
 */
export function useLocalDay(): string {
  const [day, setDay] = useState(currentDayKey)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>

    const sync = () => {
      // Functional update returns the previous value when unchanged, so React bails out — a focus
      // event on the same day causes no re-render.
      setDay((prev) => {
        const next = currentDayKey()
        return next === prev ? prev : next
      })
    }

    const schedule = () => {
      // +1s guard so the timer can't fire a hair before midnight and read the old day.
      timer = setTimeout(() => {
        sync()
        schedule()
      }, msUntilNextMidnight() + 1000)
    }
    schedule()

    const onVisible = () => {
      if (document.visibilityState === 'visible') sync()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', sync)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', sync)
    }
  }, [])

  return day
}
