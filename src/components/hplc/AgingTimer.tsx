import { useState, useEffect } from 'react'

interface AgingTimerProps {
  dateReceived: string | null
  compact?: boolean
  className?: string
}

function formatAge(ageMs: number): string {
  const totalMinutes = Math.floor(ageMs / 60_000)
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

  const received = new Date(dateReceived).getTime()
  const ageMs = now - received
  const colorClass = getAgeColor(ageMs)

  return (
    <span className={`font-mono ${sizeClass} tabular-nums ${colorClass} ${className}`}>
      {formatAge(ageMs)}
    </span>
  )
}
