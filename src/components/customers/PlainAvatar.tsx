import { useState } from 'react'
import { cn } from '@/lib/utils'

const COLORS = [
  'bg-violet-500',
  'bg-rose-500',
  'bg-amber-600',
  'bg-emerald-600',
  'bg-sky-600',
  'bg-fuchsia-600',
]

function colorFor(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length] ?? 'bg-violet-500'
}

/** Image avatar, or the first initial on a color derived from the name. */
export function PlainAvatar({
  name,
  url,
  size = 32,
}: {
  name: string
  url?: string | null
  size?: number
}) {
  const [broken, setBroken] = useState(false)
  const style = { width: size, height: size }
  if (url && !broken) {
    return (
      <img
        src={url}
        alt=""
        style={style}
        className="shrink-0 rounded-md object-cover"
        onError={() => setBroken(true)}
      />
    )
  }
  return (
    <span
      aria-hidden
      style={style}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md text-sm font-semibold text-white',
        colorFor(name)
      )}
    >
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}
