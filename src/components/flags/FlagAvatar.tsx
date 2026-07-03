import { cn } from '@/lib/utils'

/**
 * Small initials avatar used in cards + threads. "YOU" (the current user) gets
 * a soft ring, matching the mockup.
 */
export function FlagAvatar({
  initials,
  color,
  size = 18,
  isYou = false,
  className,
}: {
  initials: string
  color: string
  size?: number
  isYou?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-full font-bold text-white leading-none shrink-0',
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
      {initials}
    </span>
  )
}

export default FlagAvatar
