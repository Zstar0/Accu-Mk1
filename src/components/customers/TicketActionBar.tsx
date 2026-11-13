import { useEffect, useState } from 'react'
import { MoreHorizontal, NotebookPen, Reply } from 'lucide-react'
import { SNOOZE_PRESETS } from './snooze-presets'

const TYPING = 'input, textarea, select, [contenteditable="true"]'
const MORE = [
  ['done', 'Mark done'],
  ['waiting_for_customer', 'Waiting for customer'],
  ['snooze:1h', 'Snooze for 1 hour'],
  ['snooze:tomorrow', 'Snooze until tomorrow 8 am'],
  ['snooze:monday', 'Snooze until Monday 8 am'],
  ['todo', 'Back to Todo'],
] as const

/** Plain's bottom bar: Reply (R), Add note (N), More. Keys ignored while typing. */
export function TicketActionBar({
  customerFirstName,
  onOpen,
  onMore,
}: {
  customerFirstName: string
  onOpen: (tab: 'reply' | 'note') => void
  onMore: (action: string, until?: string) => void
}) {
  const [menu, setMenu] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.target instanceof Element && e.target.closest(TYPING)) return
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        onOpen('reply')
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        onOpen('note')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onOpen])

  const btn =
    'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm hover:bg-[var(--pv-surface)]'
  const kbd =
    'rounded border border-[var(--pv-border)] px-1 text-xs text-[var(--pv-ink-3)]'
  return (
    <div className="relative flex justify-center p-3">
      <div className="flex items-center gap-1 rounded-xl border border-[var(--pv-border)] bg-[var(--pv-card)] p-1 shadow-sm">
        <button
          type="button"
          className={btn}
          aria-label={`Reply to ${customerFirstName}`}
          onClick={() => onOpen('reply')}
        >
          <Reply className="h-4 w-4 text-[var(--pv-accent)]" /> Reply to{' '}
          {customerFirstName}{' '}
          <kbd aria-hidden className={kbd}>
            R
          </kbd>
        </button>
        <button
          type="button"
          className={btn}
          aria-label="Add note"
          onClick={() => onOpen('note')}
        >
          <NotebookPen className="h-4 w-4 text-[var(--pv-note-ink)]" /> Add note{' '}
          <kbd aria-hidden className={kbd}>
            N
          </kbd>
        </button>
        <button
          type="button"
          className={btn}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu(m => !m)}
        >
          <MoreHorizontal className="h-4 w-4" /> More
        </button>
      </div>
      {menu && (
        <div
          role="menu"
          className="absolute bottom-14 z-10 flex min-w-56 flex-col rounded-lg border border-[var(--pv-border)] bg-[var(--pv-card)] p-1 shadow-lg"
        >
          {MORE.map(([value, label]) => (
            <button
              key={value}
              role="menuitem"
              type="button"
              className={btn}
              onClick={() => {
                setMenu(false)
                const preset = SNOOZE_PRESETS[value]
                onMore(
                  preset ? 'snoozed' : value,
                  preset ? preset() : undefined
                )
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
