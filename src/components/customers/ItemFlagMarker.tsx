import { Flag } from 'lucide-react'

/** Passive "has open flags" marker for a ticket or CRM row. It sits inside the
 *  row's button, so it is not itself clickable; the slide-out's Flag pill
 *  opens the flags. */
export function ItemFlagMarker({ count }: { count: number }) {
  if (count <= 0) return null
  const label = `${count} open flag${count === 1 ? '' : 's'}`
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 text-xs text-red-500"
      aria-label={label}
      title={label}
    >
      <Flag className="h-3 w-3" fill="currentColor" />
      {count > 1 ? count : null}
    </span>
  )
}
