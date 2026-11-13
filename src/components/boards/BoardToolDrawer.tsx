import { useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  ClipboardList,
  FileText,
  FlaskConical,
  Frame,
  Link,
  Package,
  StickyNote,
  Type,
  User,
  type LucideIcon,
} from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { DRAWER_MIME, type DrawerKind } from './board-mapping'

const CHIPS: { kind: DrawerKind; label: string; icon: LucideIcon }[] = [
  { kind: 'frame', label: 'Frame', icon: Frame },
  { kind: 'text', label: 'Text', icon: Type },
  { kind: 'note', label: 'Note', icon: StickyNote },
  { kind: 'link', label: 'Link', icon: Link },
  { kind: 'person', label: 'Person', icon: User },
  { kind: 'document', label: 'Document', icon: FileText },
  { kind: 'sample', label: 'Sample', icon: FlaskConical },
  { kind: 'order', label: 'Order', icon: Package },
  { kind: 'worksheet', label: 'Worksheet', icon: ClipboardList },
]

const COLLAPSED_KEY = 'boards:drawer:collapsed'
const HINT = 'Drag onto the board, or click to place at the centre'
const FOCUS =
  'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1'

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

/** Editors drag an item type onto the canvas, or click it to place it at the view centre. */
export function BoardToolDrawer({
  canEdit,
  onPlace,
}: {
  canEdit: boolean
  onPlace: (kind: DrawerKind) => void
}) {
  // Read once into state (React Compiler: no impure reads during render).
  const [collapsed, setCollapsed] = useState(readCollapsed)
  if (!canEdit) return null

  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    try {
      window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
    } catch {
      /* private mode or blocked storage: the choice just is not remembered */
    }
  }

  return (
    <TooltipProvider>
      <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border bg-background/95 p-1 shadow-sm backdrop-blur">
        {!collapsed && (
          <>
            {CHIPS.map(({ kind, label, icon: Icon }) => (
              <Tooltip key={kind}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    draggable
                    data-kind={kind}
                    aria-label={label}
                    onDragStart={e => {
                      e.dataTransfer.setData(DRAWER_MIME, kind)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onClick={() => onPlace(kind)}
                    className={`${FOCUS} flex h-8 w-8 cursor-grab items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground active:cursor-grabbing`}
                  >
                    <Icon className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <span className="font-medium">{label}</span>
                  <span className="block opacity-80">{HINT}</span>
                </TooltipContent>
              </Tooltip>
            ))}
            <span className="mx-0.5 h-5 w-px bg-border" />
          </>
        )}
        {/* One chevron in a stable slot, so keyboard focus survives the toggle. */}
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? 'Show tools' : 'Hide tools'}
          aria-expanded={!collapsed}
          className={`${FOCUS} flex h-8 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground`}
        >
          {collapsed ? (
            <>
              <ChevronUp className="h-4 w-4" />
              Tools
            </>
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </button>
      </div>
    </TooltipProvider>
  )
}
