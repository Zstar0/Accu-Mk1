import { useAuthStore } from '@/store/auth-store'
import { useUIStore } from '@/store/ui-store'
import type { ActivityItem, FlagStatus } from '@/lib/flags-api'
import { flagTypeDef } from '@/components/flags/flag-catalog'
import { useFlagTypesMap } from '@/services/flag-types'
import { useItemKindLabels } from '@/services/item-kinds'
import { entityDisplayLabel } from '@/components/flags/flag-entity'
import {
  useFlagUsers,
  nameForUser,
  initialsForUser,
  avatarColor,
  avatarUrlForUser,
} from '@/components/flags/flag-users'
import { relativeTime } from '@/components/flags/flag-format'
import { STATUS_LABELS } from '@/components/flags/flag-status'
import { FlagAvatar } from '@/components/flags/FlagAvatar'
import { activityVerb } from '@/components/flags/flag-activity'

/** One line in the Activity feed: actor → verb → flag → entity → time. Clicking
 *  opens that flag's thread. */
export function FlagActivityRow({ item }: { item: ActivityItem }) {
  const users = useFlagUsers()
  const typesMap = useFlagTypesMap()
  const kindLabels = useItemKindLabels()
  const me = useAuthStore(state => state.user?.id ?? null)

  const def = typesMap[item.flag.type] ?? flagTypeDef(item.flag.type)
  const actor =
    item.actor_id == null
      ? 'System'
      : item.actor_id === me
        ? 'You'
        : nameForUser(users, item.actor_id)
  const verb = activityVerb(item, me, {
    nameOf: id => (id == null ? 'someone' : nameForUser(users, id)),
    statusLabelOf: slug => STATUS_LABELS[slug as FlagStatus] ?? slug,
  })
  const entity = entityDisplayLabel(item.flag, kindLabels)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => useUIStore.getState().openFlagThread(item.flag.id)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          useUIStore.getState().openFlagThread(item.flag.id)
        }
      }}
      className="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/60"
    >
      <FlagAvatar
        initials={initialsForUser(users, item.actor_id, me)}
        color={avatarColor(item.actor_id)}
        avatarUrl={avatarUrlForUser(users, item.actor_id)}
        isYou={item.actor_id != null && item.actor_id === me}
      />
      <span className="min-w-0 flex-1 truncate text-[13px]">
        <span className="font-semibold text-foreground">{actor}</span>{' '}
        <span className="text-muted-foreground">{verb}</span>{' '}
        <span
          className="font-medium text-foreground"
          style={{ borderBottom: `2px solid ${def.color}` }}
        >
          {item.flag.title}
        </span>
        <span className="text-muted-foreground"> · {entity}</span>
      </span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {relativeTime(item.created_at)}
      </span>
    </div>
  )
}

export default FlagActivityRow
