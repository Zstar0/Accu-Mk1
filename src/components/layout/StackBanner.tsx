import { useEffect, useState } from 'react'
import { healthCheck, type StackInfo } from '@/lib/api'

/**
 * DEV STACK bar. Renders only when /health reports a `stack` (the backend runs
 * inside an accumark-stack dev stack), so prod and the desktop app against prod
 * never show it. Same wording and colour as the WordPress banner mu-plugin.
 */
export function StackBanner() {
  const [stack, setStack] = useState<StackInfo | null>(null)

  useEffect(() => {
    let alive = true
    healthCheck()
      .then(h => {
        if (alive) setStack(h.stack ?? null)
      })
      .catch(() => {
        /* no backend, no banner */
      })
    return () => {
      alive = false
    }
  }, [])

  if (!stack) return null

  return (
    <div
      role="note"
      aria-label={`Dev stack ${stack.name}`}
      className="flex h-6 shrink-0 select-none items-center justify-center gap-4 bg-amber-500 font-mono text-xs font-semibold tracking-wide text-amber-950"
    >
      <span>
        DEV STACK <b className="font-extrabold">{stack.name}</b>
      </span>
      {Object.entries(stack.links).map(([label, url]) => (
        <a
          key={label}
          href={url}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:opacity-75"
        >
          {label}
        </a>
      ))}
    </div>
  )
}
