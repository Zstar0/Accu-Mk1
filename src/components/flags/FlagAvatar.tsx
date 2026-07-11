import { useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Small avatar used in cards + threads. Shows the user's Slack profile photo
 * when `avatarUrl` is set, otherwise the colored-initials circle. "YOU" (the
 * current user) gets a soft ring, matching the mockup. Falls back to initials
 * if the photo is absent OR fails to load (only Slack-linked users have photos
 * — everyone else keeps initials by design).
 */
export function FlagAvatar({
  initials,
  color,
  size = 18,
  isYou = false,
  avatarUrl,
  className,
}: {
  initials: string
  color: string
  size?: number
  isYou?: boolean
  avatarUrl?: string | null
  className?: string
}) {
  const [broken, setBroken] = useState(false)
  const showPhoto = !!avatarUrl && !broken
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center overflow-hidden rounded-full font-bold text-white leading-none shrink-0',
        isYou && 'ring-2 ring-emerald-400/60',
        className
      )}
      style={{
        backgroundColor: color,
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
      }}
    >
      {showPhoto ? (
        <img
          src={avatarUrl ?? undefined}
          alt=""
          width={size}
          height={size}
          className="h-full w-full rounded-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        initials
      )}
    </span>
  )
}

export default FlagAvatar
