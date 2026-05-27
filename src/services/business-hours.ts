import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  getBusinessHoursConfig, updateBusinessHoursConfig,
  getLabHolidays, createLabHoliday, deleteLabHoliday, generateFederalHolidays,
  type BusinessHoursConfig, type LabHoliday,
} from '@/lib/api'

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

export function useUpdateBusinessHoursConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: BusinessHoursConfig) => updateBusinessHoursConfig(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: businessHoursQueryKeys.config })
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

export function useGenerateFederalHolidays(year: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (targetYear: number) => generateFederalHolidays(targetYear),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: businessHoursQueryKeys.holidays(year) })
      toast.success(`Added ${result.added} federal holiday${result.added === 1 ? '' : 's'}`)
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export type { BusinessHoursConfig, LabHoliday }
