import { useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { Plus, FileSpreadsheet, Pencil, Check, X, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { PriorityBadge } from '@/components/hplc/PriorityBadge'
import { AgingTimer } from '@/components/hplc/AgingTimer'
import type { WorksheetUser, InboxPriority } from '@/lib/api'

export interface WorksheetSummaryItem {
  sample_id: string
  sample_uid: string
  service_group_id: number | null
  group_name: string
  priority: string
  added_at: string | null
}

export interface WorksheetSummary {
  id: number
  title: string
  status: string
  assigned_analyst: number | null
  assigned_analyst_email: string | null
  item_count: number
  items: WorksheetSummaryItem[]
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

function WorksheetDropZone({
  worksheet,
  users,
  onRename,
  onAssignTech,
  onDelete,
}: {
  worksheet: WorksheetSummary
  users: WorksheetUser[]
  onRename: (id: number, title: string) => void
  onAssignTech: (id: number, analystId: number) => void
  onDelete: (id: number) => void
  onRemoveItem: (worksheetId: number, sampleUid: string, serviceGroupId: number) => void
}) {
  const { isOver, setNodeRef } = useDroppable({ id: `worksheet-${worksheet.id}` })
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(worksheet.title)
  const [confirmDelete, setConfirmDelete] = useState(false)

  function handleSaveTitle() {
    const trimmed = editTitle.trim()
    if (trimmed && trimmed !== worksheet.title) {
      onRename(worksheet.id, trimmed)
    }
    setEditing(false)
  }

  return (
    <div
      ref={setNodeRef}
      className={`group rounded-lg border p-3 transition-all duration-200 ${
        isOver
          ? 'border-primary bg-primary/5 shadow-sm'
          : 'border-border hover:border-primary/20'
      }`}
    >
      {/* Title row */}
      <div className="flex items-center gap-1.5 mb-1.5">
        <FileSpreadsheet className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        {editing ? (
          <div className="flex items-center gap-1 flex-1 min-w-0">
            <Input
              value={editTitle}
              onChange={e => setEditTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveTitle(); if (e.key === 'Escape') setEditing(false) }}
              className="h-5 text-xs px-1 py-0"
              autoFocus
            />
            <button onClick={handleSaveTitle} className="text-primary hover:text-primary/80">
              <Check className="h-3 w-3" />
            </button>
            <button onClick={() => setEditing(false)} className="text-muted-foreground hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <>
            <span className="text-xs font-medium truncate flex-1">{worksheet.title}</span>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => { setEditTitle(worksheet.title); setEditing(true) }}
                className="text-muted-foreground/40 hover:text-muted-foreground"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                onClick={() => setConfirmDelete(true)}
                className="text-muted-foreground/40 hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 shrink-0">
              {worksheet.item_count}
            </Badge>
          </>
        )}
      </div>

      {/* Tech assignment */}
      <div className="mb-2">
        <Select
          value={worksheet.assigned_analyst != null ? String(worksheet.assigned_analyst) : ''}
          onValueChange={value => onAssignTech(worksheet.id, Number(value))}
        >
          <SelectTrigger
            size="sm"
            className="h-5 text-[10px] border-transparent bg-transparent shadow-none hover:border-border w-full"
          >
            <SelectValue placeholder="Assign tech…" />
          </SelectTrigger>
          <SelectContent>
            {users.map(user => (
              <SelectItem key={user.id} value={String(user.id)}>{user.email}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Existing items */}
      {worksheet.items.length > 0 && (
        <div className="space-y-1">
          {worksheet.items.map((item, i) => (
            <div key={i} className="group/item flex items-center gap-1.5 text-[10px]">
              <button
                onClick={() => {
                  if (item.service_group_id != null) {
                    onRemoveItem(worksheet.id, item.sample_uid, item.service_group_id)
                  }
                }}
                className="opacity-0 group-hover/item:opacity-100 text-muted-foreground/40 hover:text-destructive transition-opacity shrink-0"
                aria-label={`Remove ${item.sample_id} from worksheet`}
              >
                <X className="h-3 w-3" />
              </button>
              <span className="font-mono text-muted-foreground">{item.sample_id}</span>
              <span className="text-muted-foreground/50">·</span>
              <span className="truncate text-muted-foreground">{item.group_name}</span>
              <div className="flex-1" />
              <PriorityBadge priority={item.priority as InboxPriority} />
              <AgingTimer dateReceived={item.added_at} compact />
            </div>
          ))}
        </div>
      )}

      {worksheet.items.length === 0 && (
        <p className="text-[10px] text-muted-foreground/50 italic">Empty — drop items here</p>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete worksheet?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete <span className="font-medium">{worksheet.title}</span> and
              return its {worksheet.item_count} item{worksheet.item_count !== 1 ? 's' : ''} to the inbox.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => onDelete(worksheet.id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

interface WorksheetDropPanelProps {
  worksheets: WorksheetSummary[]
  users: WorksheetUser[]
  loading?: boolean
  onRename: (id: number, title: string) => void
  onAssignTech: (id: number, analystId: number) => void
  onDelete: (id: number) => void
  onRemoveItem: (worksheetId: number, sampleUid: string, serviceGroupId: number) => void
}

export function WorksheetDropPanel({ worksheets, users, loading, onRename, onAssignTech, onDelete, onRemoveItem }: WorksheetDropPanelProps) {
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
          {/* New worksheet drop zone */}
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
              <WorksheetDropZone
                key={ws.id}
                worksheet={ws}
                users={users}
                onRename={onRename}
                onAssignTech={onAssignTech}
                onDelete={onDelete}
                onRemoveItem={onRemoveItem}
              />
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
