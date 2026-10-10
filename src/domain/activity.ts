import type { Attempt } from '../shared/types'

export const ACTIVITY_WEEKS = 26
export type ActivityLevel = 0 | 1 | 2 | 3 | 4

export interface ActivityDay {
  /** A local calendar key, never derived from an ISO/UTC date. */
  key: string
  date: Date
  count: number
  level: ActivityLevel
  attempts: Attempt[]
}

export function activityIntensity(count: number): ActivityLevel {
  if (!Number.isFinite(count) || count < 1) return 0
  if (count < 2) return 1
  if (count < 4) return 2
  if (count < 7) return 3
  return 4
}

export function localActivityKey(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function submissionTime(value: string): number {
  // Persisted submissions are ISO instants. Reject ambiguous dates and rollover
  // values (Date.parse alone would accept e.g. February 30 as a March date).
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) return NaN
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const monthLength = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  if (
    !monthLength ||
    day < 1 ||
    day > monthLength ||
    Number(hourText) > 23 ||
    Number(minuteText) > 59 ||
    Number(secondText) > 59
  )
    return NaN
  return Date.parse(value)
}

/**
 * The current local week and preceding 25 weeks, Sunday first, through today.
 * Only successful persisted attempts belong in this input; drafts have no role.
 * Calendar arithmetic (rather than 24-hour durations) preserves DST boundaries.
 */
export function buildActivityDays(attempts: readonly Attempt[], now: Date): ActivityDay[] {
  if (!Number.isFinite(now.getTime())) return []
  const today = new Date(now)
  today.setHours(12, 0, 0, 0)
  const cursor = new Date(today)
  cursor.setDate(cursor.getDate() - cursor.getDay() - (ACTIVITY_WEEKS - 1) * 7)
  const days: ActivityDay[] = []
  const byKey = new Map<string, ActivityDay>()
  while (cursor <= today) {
    const day: ActivityDay = {
      key: localActivityKey(cursor),
      date: new Date(cursor),
      count: 0,
      level: 0,
      attempts: [],
    }
    days.push(day)
    byKey.set(day.key, day)
    cursor.setDate(cursor.getDate() + 1)
  }

  for (const attempt of attempts) {
    const timestamp = submissionTime(attempt.submittedAt)
    // Compare exact instants, so even a future time later today is excluded.
    if (!Number.isFinite(timestamp) || timestamp > now.getTime()) continue
    const day = byKey.get(localActivityKey(new Date(timestamp)))
    if (day) day.attempts.push(attempt)
  }
  for (const day of days) {
    day.attempts.sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt))
    day.count = day.attempts.length
    day.level = activityIntensity(day.count)
  }
  return days
}
