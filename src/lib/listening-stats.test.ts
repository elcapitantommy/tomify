import { describe, expect, it } from 'vitest'
import { calendarPeriod, listenedFor, monthPeriod, wrappedSeasonYear } from './listening-stats'

describe('listening stats periods', () => {
  it('works out this week (from Monday), this month and this year in local time', () => {
    const now = new Date(2026, 9, 21, 15, 30) // a Wednesday
    expect(calendarPeriod('week', now)).toEqual({ from: new Date(2026, 9, 19).getTime(), to: new Date(2026, 9, 26).getTime() })
    expect(calendarPeriod('week', new Date(2026, 9, 25, 23)), 'Sunday is the end of the week').toEqual(calendarPeriod('week', now))
    expect(calendarPeriod('month', now)).toEqual({ from: new Date(2026, 9, 1).getTime(), to: new Date(2026, 10, 1).getTime() })
    expect(calendarPeriod('year', now)).toEqual({ from: new Date(2026, 0, 1).getTime(), to: new Date(2027, 0, 1).getTime() })
  })

  it('reads a chosen month, including December', () => {
    expect(monthPeriod('2025-12')).toEqual({ from: new Date(2025, 11, 1).getTime(), to: new Date(2026, 0, 1).getTime() })
    expect(monthPeriod('')).toBeNull()
  })

  it('offers Wrapped on Home in December and January only', () => {
    expect(wrappedSeasonYear(new Date(2026, 11, 2))).toBe(2026)
    expect(wrappedSeasonYear(new Date(2027, 0, 20))).toBe(2026)
    expect(wrappedSeasonYear(new Date(2026, 9, 20))).toBeNull()
  })

  it('shows minutes under an hour and hours above', () => {
    expect(listenedFor(1500)).toBe('25 minutes')
    expect(listenedFor(5400)).toBe('1.5 hours')
    expect(listenedFor(72000)).toBe('20 hours')
  })
})
