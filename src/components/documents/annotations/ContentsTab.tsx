// src/components/documents/annotations/ContentsTab.tsx
import type { BridgeHeading } from './bridge-messages'

const INDENT: Record<number, string> = {
  1: 'pl-2',
  2: 'pl-5',
  3: 'pl-8',
  4: 'pl-11',
}

export function ContentsTab({
  headings,
  onNavigate,
}: {
  headings: BridgeHeading[]
  onNavigate: (id: string) => void
}) {
  if (headings.length === 0)
    return (
      <p className="p-3 text-xs text-muted-foreground">
        No headings in this document.
      </p>
    )
  return (
    <ul className="py-1">
      {headings.map(h => (
        <li key={h.id}>
          <button
            type="button"
            className={`w-full truncate py-1 pr-2 text-left text-sm hover:bg-muted ${INDENT[h.level] ?? 'pl-11'} ${h.level <= 1 ? 'text-foreground/90' : 'text-muted-foreground'}`}
            onClick={() => onNavigate(h.id)}
          >
            {h.text}
          </button>
        </li>
      ))}
    </ul>
  )
}
