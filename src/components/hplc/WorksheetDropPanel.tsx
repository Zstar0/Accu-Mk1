import { useDroppable } from '@dnd-kit/core'
import { Plus, FileSpreadsheet } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'

export interface WorksheetSummary {
  id: number
  title: string
  status: string
  item_count: number
  items: { sample_id: string; group_name: string }[]
}

function NewWorksheetDropZone() {
  const { isOver, setNodeRef } = useDroppable({ id: 'new-worksheet' })

  return (
    <div
      ref={setNodeRef}
      className={`rounded-lg border-2 border-dashed p-4 text-center transition-all duration-200 ${
        isOver
          ? 'border-primary bg-primary/10 shadow-inner'
          : 'border-muted-foreground/20 hover:border-muted-foreground/40'
      }`}
    >
      <Plus className={`mx-auto h-5 w-5 mb-1.5 transition-colors ${isOver ? 'text-primary' : 'text-muted-foreground/40'}`} />
      <p className={`text-xs font-medium transition-colors ${isOver ? 'text-primary' : 'text-muted-foreground'}`}>
        {isOver ? 'Drop to create worksheet' : 'New Worksheet'}
      </p>
      <p className="text-[10px] text-muted-foreground/60 mt-0.5">
        Drag items here
      </p>
    </div>
  )
}

function WorksheetDropZone({ worksheet }: { worksheet: WorksheetSummary }) {
  const { isOver, setNodeRef } = useDroppable({ id: `worksheet-${worksheet.id}` })

  return (
    <div
      ref={setNodeRef}
      className={`rounded-lg border p-3 transition-all duration-200 ${
        isOver
          ? 'border-primary bg-primary/5 shadow-sm'
          : 'border-border hover:border-primary/20'
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <FileSpreadsheet className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium truncate flex-1">{worksheet.title}</span>
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
          {worksheet.item_count}
        </Badge>
      </div>

      {/* Show existing items */}
      {worksheet.items.length > 0 && (
        <div className="space-y-0.5">
          {worksheet.items.map((item, i) => (
            <div key={i} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="font-mono">{item.sample_id}</span>
              <span className="text-muted-foreground/50">·</span>
              <span className="truncate">{item.group_name}</span>
            </div>
          ))}
        </div>
      )}

      {worksheet.items.length === 0 && (
        <p className="text-[10px] text-muted-foreground/50 italic">Empty — drop items here</p>
      )}
    </div>
  )
}

interface WorksheetDropPanelProps {
  worksheets: WorksheetSummary[]
  loading?: boolean
}

export function WorksheetDropPanel({ worksheets, loading }: WorksheetDropPanelProps) {
  const openWorksheets = worksheets.filter(w => w.status === 'open')

  return (
    <div className="flex h-full flex-col border-l bg-background">
      {/* Header */}
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Worksheets</h3>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          Drag analysis groups here to assign
        </p>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-3 p-4">
          {/* New worksheet drop zone — always at top */}
          <NewWorksheetDropZone />

          {/* Divider */}
          {openWorksheets.length > 0 && (
            <div className="flex items-center gap-2 pt-1">
              <div className="h-px flex-1 bg-border" />
              <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
                Open ({openWorksheets.length})
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>
          )}

          {/* Existing worksheets */}
          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-16 rounded-lg bg-muted/30 animate-pulse" />
              ))}
            </div>
          ) : (
            openWorksheets.map(ws => (
              <WorksheetDropZone key={ws.id} worksheet={ws} />
            ))
          )}

          {!loading && openWorksheets.length === 0 && (
            <p className="text-xs text-muted-foreground/50 text-center py-4 italic">
              No open worksheets yet
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
