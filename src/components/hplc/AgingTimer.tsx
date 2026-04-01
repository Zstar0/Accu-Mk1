import { useState, useEffect } from 'react'

interface AgingTimerProps {
  dateReceived: string | null
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

  if (hours >= 24) return 'text-red-500 animate-pulse'
  if (hours >= 20) return 'text-orange-500'
  if (hours >= 12) return 'text-yellow-500'
  return 'text-green-500'
}

export function AgingTimer({ dateReceived, className = '' }: AgingTimerProps) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now())
    }, 60_000)
    return () => clearInterval(id)
  }, [])

  if (!dateReceived) {
    return (
      <span className={`font-mono text-sm tabular-nums text-zinc-400 ${className}`}>—</span>
    )
  }

  const received = new Date(dateReceived).getTime()
  const ageMs = now - received
  const colorClass = getAgeColor(ageMs)

  return (
    <span className={`font-mono text-sm tabular-nums ${colorClass} ${className}`}>
      {formatAge(ageMs)}
    </span>
  )
}
