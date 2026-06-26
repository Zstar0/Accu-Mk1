import { useState, useEffect } from 'react'

interface AgingTimerProps {
  dateReceived: string | null
  compact?: boolean
  className?: string
}

/**
 * Parse a backend `date_received` to epoch ms, honoring the API contract that
 * timestamps are UTC (ISO 8601). A date-TIME string with no zone is read by JS
 * as browser-LOCAL, which made a just-received sample show a negative age (≈ −1
 * timezone offset, e.g. −5h in CDT). Treat a zone-less datetime as UTC by
 * appending "Z". Date-only strings are already UTC per the JS spec — leave them.
 */
export function parseReceivedAtMs(dateReceived: string): number {
  const hasTime = dateReceived.includes('T')
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(dateReceived)
  const normalized = hasTime && !hasZone ? `${dateReceived}Z` : dateReceived
  return new Date(normalized).getTime()
}

export function formatAge(ageMs: number): string {
  // Clamp negatives to 0: a sample received "now" can read as a sub-minute
  // negative from clock skew, and any residual must never render as "-5h -59m".
  const ms = Math.max(0, ageMs)
  const totalMinutes = Math.floor(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remainingHours = hours % 24
    return `${days}d ${remainingHours}h`
  }

  return `${hours}h ${minutes}m`
}

function getAgeColor(ageMs: number): string {
  const hours = ageMs / (1000 * 60 * 60)

  if (hours > 48) return 'text-red-400'
  if (hours > 24) return 'text-amber-400'
  return 'text-muted-foreground'
}

export function AgingTimer({ dateReceived, compact, className = '' }: AgingTimerProps) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now())
    }, 60_000)
    return () => clearInterval(id)
  }, [])

  const sizeClass = compact ? 'text-[10px]' : 'text-sm'

  if (!dateReceived) {
    return (
      <span className={`font-mono ${sizeClass} tabular-nums text-zinc-400 ${className}`}>—</span>
    )
  }

  const received = parseReceivedAtMs(dateReceived)
  const ageMs = now - received
  const colorClass = getAgeColor(ageMs)

  return (
    <span className={`font-mono ${sizeClass} tabular-nums ${colorClass} ${className}`}>
      {formatAge(ageMs)}
    </span>
  )
}
