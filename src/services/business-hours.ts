import { useEffect, useSyncExternalStore } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  getBusinessHoursConfig, updateBusinessHoursConfig,
  getLabHolidays, createLabHoliday, deleteLabHoliday, generateFederalHolidays,
  type BusinessHoursConfig, type LabHoliday,
} from '@/lib/api'
import { slaQueryKeys } from '@/services/sla'
import { businessDayMinutes } from '@/lib/sla-format'
import { labClockState, setLabClockState } from '@/lib/lab-clock'

export const businessHoursQueryKeys = {
  config: ['business-hours', 'config'] as const,
  holidays: (year: number) => ['business-hours', 'holidays', year] as const,
}

export function useBusinessHoursConfig() {
  return useQuery({
    queryKey: businessHoursQueryKeys.config,
    queryFn: getBusinessHoursConfig,
    staleTime: 1000 * 60 * 5,
  })
}

/** Minutes in one business day (open..close), for sizing the durations of
 *  business-hours SLA tiers. Undefined until the config loads. */
export function useBusinessDayMinutes(): number | undefined {
  return businessDayMinutes(useBusinessHoursConfig().data)
}

// One timer for every SLA cell on the page: the moon only needs to notice the
// lab opening or closing, so a shared minute tick is enough.
const tickListeners = new Set<() => void>()
let tickMinute = Math.floor(Date.now() / 60_000)
let tickTimer: ReturnType<typeof setInterval> | null = null
function subscribeMinute(cb: () => void) {
  tickListeners.add(cb)
  if (!tickTimer) {
    tickTimer = setInterval(() => {
      tickMinute = Math.floor(Date.now() / 60_000)
      tickListeners.forEach(l => l())
    }, 60_000)
  }
  return () => {
    tickListeners.delete(cb)
    if (tickListeners.size === 0 && tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }
  }
}
const getMinute = () => tickMinute

/** Mount once for signed-in users (next to WorkflowStatesLoader): keeps the
 *  lab-clock store current from the business-hours config, this year's and
 *  next year's holidays (so a December night resumes after New Year's, not on
 *  it) and a shared minute tick. SLA cells read it with `useLabClockState`
 *  and never touch React Query themselves. */
export function LabClockFeeder() {
  const cfg = useBusinessHoursConfig().data
  const year = new Date().getFullYear()
  const thisYear = useLabHolidays(year).data
  const nextYear = useLabHolidays(year + 1).data
  const minute = useSyncExternalStore(subscribeMinute, getMinute, getMinute)
  useEffect(() => {
    if (!cfg) {
      setLabClockState(null)
      return
    }
    const holidays = new Set(
      [...(thisYear ?? []), ...(nextYear ?? [])].map(h => h.holiday_date)
    )
    setLabClockState(labClockState(new Date(minute * 60_000), cfg, holidays))
  }, [cfg, thisYear, nextYear, minute])
  return null
}

export function useUpdateBusinessHoursConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: BusinessHoursConfig) => updateBusinessHoursConfig(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: businessHoursQueryKeys.config })
      // Tiers carry the business-day length derived from this config.
      qc.invalidateQueries({ queryKey: slaQueryKeys.tiers })
      toast.success('Business hours saved')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useLabHolidays(year: number) {
  return useQuery({
    queryKey: businessHoursQueryKeys.holidays(year),
    queryFn: () => getLabHolidays(year),
    staleTime: 1000 * 60 * 5,
  })
}

export function useCreateLabHoliday(year: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: { holiday_date: string; name: string }) => createLabHoliday(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: businessHoursQueryKeys.holidays(year) })
      toast.success('Closure added')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteLabHoliday(year: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (holidayDate: string) => deleteLabHoliday(holidayDate),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: businessHoursQueryKeys.holidays(year) })
      toast.success('Closure removed')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useGenerateFederalHolidays() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (targetYear: number) => generateFederalHolidays(targetYear),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: businessHoursQueryKeys.holidays(result.year) })
      toast.success(`Added ${result.added} federal holiday${result.added === 1 ? '' : 's'}`)
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export type { BusinessHoursConfig, LabHoliday }
