import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Switch } from '@/components/ui/switch'
import { SettingsSection } from '../shared/SettingsComponents'
import { useAuthStore } from '@/store/auth-store'
import { getSetting, updateSetting } from '@/lib/api'

const KEY = 'checkin_multi_order_enabled'

export function CheckInPane() {
  const { t } = useTranslation()
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['setting', KEY],
    queryFn: () =>
      getSetting(KEY)
        .then(s => s.value === 'true')
        .catch(() => false),
  })

  const mutation = useMutation({
    mutationFn: (v: boolean) => updateSetting(KEY, String(v)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['setting', KEY] })
    },
  })

  return (
    <div className="space-y-8">
      <SettingsSection title={t('preferences.checkIn.section')}>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <span className="text-sm font-medium text-foreground">
              {t('preferences.checkIn.multiOrderLabel')}
            </span>
            <p className="text-sm text-muted-foreground">
              {t('preferences.checkIn.multiOrderDescription')}
            </p>
          </div>
          <Switch
            checked={query.data ?? false}
            disabled={!isAdmin || query.isLoading || mutation.isPending}
            onCheckedChange={(v: boolean) => mutation.mutate(v)}
          />
        </div>
      </SettingsSection>
    </div>
  )
}
