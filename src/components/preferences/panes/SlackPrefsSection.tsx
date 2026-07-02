import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingsSection } from '../shared/SettingsComponents'
import {
  useSlackPrefs,
  useUpdateSlackPrefs,
  useTestSlackDm,
} from '@/services/slack-prefs'
import type { SlackDmPrefs } from '@/lib/slack-prefs-api'

/** Per-user Slack DM notification prefs (spec 2026-07-02). Server-stored —
 *  the backend notifier is the consumer. Category toggles save on change. */

const CATEGORIES = [
  'notify_assigned',
  'notify_mentioned',
  'notify_raised_activity',
  'notify_watching_activity',
  'notify_status_changes',
] as const

export function SlackPrefsSection() {
  const { t } = useTranslation()
  const prefsQuery = useSlackPrefs()
  const update = useUpdateSlackPrefs()
  const testDm = useTestSlackDm()
  const [memberIdDraft, setMemberIdDraft] = useState<string | null>(null)

  if (prefsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    )
  }
  const prefs = prefsQuery.data
  if (!prefs) return null

  const memberId = memberIdDraft ?? prefs.slack_member_id ?? ''

  return (
    <SettingsSection title={t('preferences.slack.title')}>
      <p className="text-sm text-muted-foreground">
        {t('preferences.slack.blurb')}
      </p>

      <div className="flex items-center justify-between py-1.5">
        <span className="text-sm">{t('preferences.slack.master')}</span>
        <Switch
          checked={prefs.enabled}
          onCheckedChange={v => update.mutate({ enabled: v })}
        />
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {prefs.linked
            ? `${t('preferences.slack.linked')}${
                prefs.slack_display_name
                  ? ` → ${prefs.slack_display_name}`
                  : ''
              }`
            : t('preferences.slack.notLinked')}
        </span>
        <Input
          value={memberId}
          onChange={e => setMemberIdDraft(e.target.value)}
          onBlur={() => {
            if (memberIdDraft !== null)
              update.mutate({ slack_member_id: memberIdDraft.trim() || null })
          }}
          placeholder={t('preferences.slack.memberIdPlaceholder')}
          className="h-8 w-56 text-xs"
        />
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          disabled={testDm.isPending}
          onClick={() => testDm.mutate()}
        >
          {t('preferences.slack.sendTest')}
        </Button>
      </div>
      {testDm.data && (
        <p
          className={
            testDm.data.ok
              ? 'text-xs text-emerald-600'
              : 'text-xs text-destructive'
          }
        >
          {testDm.data.ok
            ? t('preferences.slack.testOk')
            : (testDm.data.detail ?? t('preferences.slack.testFail'))}
        </p>
      )}

      <div className="space-y-1 pt-1">
        {CATEGORIES.map(key => (
          <div key={key} className="flex items-center justify-between py-1">
            <span className="text-sm">{t(`preferences.slack.${key}`)}</span>
            <Switch
              checked={prefs[key as keyof SlackDmPrefs] as boolean}
              disabled={!prefs.enabled}
              onCheckedChange={v => update.mutate({ [key]: v })}
            />
          </div>
        ))}
      </div>
    </SettingsSection>
  )
}

export default SlackPrefsSection
