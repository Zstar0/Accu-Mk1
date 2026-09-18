import { useQuery } from '@tanstack/react-query'
import { getBusinessHoursConfig, getLabHolidays } from '@/lib/api'
import type { LabCalendar } from '@/lib/endo-prep'

/**
 * The lab's working calendar for due-date arithmetic: business-hours config
 * (time zone + working days) plus every lab holiday for last year, this year
 * and next. One cached query for the whole app; the endo prep line and the
 * bench sheet both read it.
 */
export function useLabCalendar(): {
  calendar: LabCalendar | null
  isLoading: boolean
} {
  const year = new Date().getFullYear()
  const q = useQuery({
    queryKey: ['lab-calendar', year],
    queryFn: async (): Promise<LabCalendar> => {
      const [config, ...years] = await Promise.all([
        getBusinessHoursConfig(),
        getLabHolidays(year - 1),
        getLabHolidays(year),
        getLabHolidays(year + 1),
      ])
      const holidays = new Map<string, string>()
      for (const list of years)
        for (const h of list) holidays.set(h.holiday_date, h.name)
      return {
        timezone: config.timezone,
        workingDays: config.working_days,
        holidays,
      }
    },
    staleTime: 60 * 60 * 1000,
  })
  return { calendar: q.data ?? null, isLoading: q.isLoading }
}
