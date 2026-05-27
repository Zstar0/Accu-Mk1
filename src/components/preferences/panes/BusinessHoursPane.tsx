import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { SettingsSection } from '../shared/SettingsComponents'
import { useAuthStore } from '@/store/auth-store'
import {
  useBusinessHoursConfig, useUpdateBusinessHoursConfig,
  useLabHolidays, useCreateLabHoliday, useDeleteLabHoliday, useGenerateFederalHolidays,
} from '@/services/business-hours'
import type { BusinessHoursConfig, LabHoliday } from '@/lib/api'

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

function hhmm(value: string): string {
  return value.slice(0, 5) // "09:00:00" -> "09:00"
}

export function BusinessHoursPane() {
  const { t } = useTranslation()
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')
  const configQuery = useBusinessHoursConfig()
  const [year, setYear] = useState(new Date().getFullYear())
  const holidaysQuery = useLabHolidays(year)

  if (configQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (configQuery.isError || !configQuery.data) {
    return <p className="text-sm text-destructive">{t('preferences.businessHours.loadError')}</p>
  }

  return (
    <div className="space-y-8">
      {!isAdmin && (
        <p className="text-sm text-muted-foreground">{t('preferences.businessHours.readOnly')}</p>
      )}

      <ScheduleSection config={configQuery.data} readOnly={!isAdmin} />

      <HolidaysSection
        year={year}
        onYearChange={setYear}
        readOnly={!isAdmin}
        isLoading={holidaysQuery.isLoading}
        isError={holidaysQuery.isError}
        holidays={holidaysQuery.data ?? []}
      />
    </div>
  )
}

function ScheduleSection({ config, readOnly }: { config: BusinessHoursConfig; readOnly: boolean }) {
  const { t } = useTranslation()
  const update = useUpdateBusinessHoursConfig()
  const [open, setOpen] = useState(hhmm(config.open_time))
  const [close, setClose] = useState(hhmm(config.close_time))
  const [tz, setTz] = useState(config.timezone)
  const [days, setDays] = useState<number[]>(config.working_days)

  const toggleDay = (idx: number) => {
    setDays(prev => (prev.includes(idx) ? prev.filter(d => d !== idx) : [...prev, idx].sort((a, b) => a - b)))
  }

  const save = () => {
    update.mutate({ open_time: open, close_time: close, timezone: tz, working_days: days })
  }

  return (
    <SettingsSection title={t('preferences.businessHours.schedule')}>
      <p className="text-sm text-muted-foreground">{t('preferences.businessHours.scheduleDescription')}</p>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('preferences.businessHours.openTime')}</span>
          <Input className="h-8 w-32" type="time" value={open} disabled={readOnly}
            onChange={e => setOpen(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('preferences.businessHours.closeTime')}</span>
          <Input className="h-8 w-32" type="time" value={close} disabled={readOnly}
            onChange={e => setClose(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('preferences.businessHours.timezone')}</span>
          <Input className="h-8 w-56" value={tz} disabled={readOnly}
            onChange={e => setTz(e.target.value)} />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t('preferences.businessHours.timezoneHint')}</p>
      <div className="space-y-2">
        <span className="text-sm text-muted-foreground">{t('preferences.businessHours.workingDays')}</span>
        <div className="flex flex-wrap gap-3">
          {DAY_KEYS.map((dayKey, idx) => (
            <label key={dayKey} className="flex items-center gap-1.5 text-sm">
              <Checkbox checked={days.includes(idx)} disabled={readOnly}
                onCheckedChange={() => toggleDay(idx)} />
              {t(`preferences.businessHours.${dayKey}`)}
            </label>
          ))}
        </div>
      </div>
      {!readOnly && (
        <Button size="sm" onClick={save} disabled={update.isPending}>
          {t('preferences.businessHours.save')}
        </Button>
      )}
    </SettingsSection>
  )
}

function HolidaysSection({
  year, onYearChange, readOnly, isLoading, isError, holidays,
}: {
  year: number
  onYearChange: (y: number) => void
  readOnly: boolean
  isLoading: boolean
  isError: boolean
  holidays: LabHoliday[]
}) {
  const { t } = useTranslation()
  const createHoliday = useCreateLabHoliday(year)
  const deleteHoliday = useDeleteLabHoliday(year)
  const generateFederal = useGenerateFederalHolidays()
  const [newDate, setNewDate] = useState('')
  const [newName, setNewName] = useState('')

  const addClosure = () => {
    if (!newDate || !newName.trim()) return
    createHoliday.mutate({ holiday_date: newDate, name: newName.trim() }, {
      onSuccess: () => { setNewDate(''); setNewName('') },
    })
  }

  return (
    <SettingsSection title={t('preferences.businessHours.holidays')}>
      <p className="text-sm text-muted-foreground">{t('preferences.businessHours.holidaysDescription')}</p>

      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{t('preferences.businessHours.year')}</span>
        <Input className="h-8 w-24" type="number" min={2000} value={String(year)}
          onChange={e => onYearChange(parseInt(e.target.value, 10) || year)} />
        {!readOnly && (
          <Button size="sm" variant="outline" disabled={generateFederal.isPending}
            onClick={() => generateFederal.mutate(year)}>
            {t('preferences.businessHours.generateFederal', { year })}
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
      ) : isError ? (
        <p className="text-sm text-destructive">{t('preferences.businessHours.loadError')}</p>
      ) : holidays.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('preferences.businessHours.noHolidays')}</p>
      ) : (
        <div className="space-y-1">
          {holidays.map(h => (
            <div key={h.id} className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
              <span className="w-28 font-mono text-xs">{h.holiday_date}</span>
              <span className="flex-1">{h.name}</span>
              <Badge variant="outline" className="text-[10px]">
                {h.source === 'federal'
                  ? t('preferences.businessHours.federalTag')
                  : t('preferences.businessHours.customTag')}
              </Badge>
              {!readOnly && (
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                  aria-label={t('preferences.businessHours.removeClosure')}
                  onClick={() => deleteHoliday.mutate(h.holiday_date)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {!readOnly && (
        <div className="flex flex-wrap items-end gap-2 pt-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('preferences.businessHours.date')}</span>
            <Input className="h-8 w-40" type="date" value={newDate}
              onChange={e => setNewDate(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('preferences.businessHours.closureName')}</span>
            <Input className="h-8 w-64" value={newName}
              placeholder={t('preferences.businessHours.closureNamePlaceholder')}
              onChange={e => setNewName(e.target.value)} />
          </label>
          <Button size="sm" disabled={createHoliday.isPending || !newDate || !newName.trim()} onClick={addClosure}>
            <Plus className="mr-1 h-4 w-4" /> {t('preferences.businessHours.addClosure')}
          </Button>
        </div>
      )}
    </SettingsSection>
  )
}
