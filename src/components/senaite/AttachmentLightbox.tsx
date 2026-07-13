import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

/** Metadata shown in the lightbox footer. Every field is optional — rows
 *  render only when their value is present, so each attachment flavor
 *  (SENAITE attachment, packaging photo, vial attachment, check-in photo)
 *  passes whatever it actually knows. */
export interface AttachmentLightboxMeta {
  filename?: string
  /** Small badge next to the filename, e.g. "Sample Image", "Packaging". */
  badge?: string
  contentType?: string
  sizeBytes?: number
  /** ISO timestamp of when the image was captured/uploaded. */
  takenAt?: string
  /** Label for the takenAt row (defaults to "Taken"). */
  takenAtLabel?: string
  /** ISO timestamp of when the image was assigned to the parent via
   *  Select Vial Image. Optional — Mk1 does not record this for existing
   *  parent attachments, so the row degrades to just the source vial. */
  assignedAt?: string
  /** Vial the assigned image came from (parsed from the filename). */
  sourceVialId?: string
  /** Uploader/receiver display name — who created the image. */
  createdBy?: string
  /** Free-text remark shown under the metadata row. */
  caption?: string
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Backend timestamps are UTC but often serialized without a zone suffix —
 *  parsing those with `new Date()` would mislabel them as local time. */
export function parseUtcDate(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso)
  const d = new Date(hasZone ? iso : `${iso}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Select Vial Image uploads snapshot files named
 *  `{vialSampleId}-vial-photo.{ext}` (e.g. `PB-0075-S03-vial-photo.jpg`).
 *  Returns the source vial's sample_id, or null when the filename doesn't
 *  follow that convention. */
export function parseAssignedVialFilename(
  filename: string | null | undefined
): string | null {
  if (!filename) return null
  const m = /^(.+-S\d{2,})-vial-photo\.[A-Za-z0-9]+$/.exec(filename)
  return m?.[1] ?? null
}

export function AttachmentLightbox({
  open,
  onOpenChange,
  src,
  alt,
  meta,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  src: string | null
  alt?: string
  meta: AttachmentLightboxMeta
}) {
  // Size/type fall back to the already-loaded image bytes (object URLs are
  // in-memory — this fetch never hits the network).
  const [derived, setDerived] = useState<{ size?: number; type?: string }>({})
  const needsDerived = meta.sizeBytes == null || !meta.contentType
  useEffect(() => {
    if (!open || !src || !needsDerived) return
    let cancelled = false
    fetch(src)
      .then(r => r.blob())
      .then(b => {
        if (!cancelled) setDerived({ size: b.size, type: b.type || undefined })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [open, src, needsDerived])

  const contentType = meta.contentType || derived.type
  const sizeBytes = meta.sizeBytes ?? derived.size
  const taken = parseUtcDate(meta.takenAt)
  const assigned = parseUtcDate(meta.assignedAt)
  const title = meta.filename || alt || 'Attachment'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[96vw] sm:max-w-[96vw] w-[96vw] h-[94vh] p-0 gap-0 flex flex-col overflow-hidden">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <div className="flex-1 min-h-0 flex items-center justify-center bg-black/60">
          {src && (
            <img
              src={src}
              alt={alt ?? title}
              className="max-h-full max-w-full object-contain"
            />
          )}
        </div>
        <div className="shrink-0 border-t border-border bg-background px-4 py-3 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-foreground truncate">
              {title}
            </span>
            {meta.badge && (
              <Badge variant="secondary" className="text-[10px] shrink-0">
                {meta.badge}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-x-4 gap-y-1 flex-wrap font-mono text-xs text-muted-foreground">
            {contentType && <span>{contentType}</span>}
            {sizeBytes != null && <span>{formatBytes(sizeBytes)}</span>}
            {taken && (
              <span>
                {meta.takenAtLabel ?? 'Taken'} {taken.toLocaleString()}
              </span>
            )}
            {meta.createdBy && <span>by {meta.createdBy}</span>}
            {(assigned || meta.sourceVialId) && (
              <span className="text-foreground">
                {assigned
                  ? `Assigned ${assigned.toLocaleString()}`
                  : 'Assigned'}
                {meta.sourceVialId ? ` · from ${meta.sourceVialId}` : ''}
              </span>
            )}
          </div>
          {meta.caption && (
            <p className="text-xs text-muted-foreground">{meta.caption}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Image thumbnail that opens the lightbox on click. Drop-in replacement for
 *  a bare `<img>` in the Attachments section — same className applies to the
 *  inner image. */
export function ZoomableImage({
  src,
  alt,
  className,
  meta,
}: {
  src: string
  alt: string
  className?: string
  meta: AttachmentLightboxMeta
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="View full size"
        className="block cursor-zoom-in rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <img src={src} alt={alt} className={className} />
      </button>
      <AttachmentLightbox
        open={open}
        onOpenChange={setOpen}
        src={src}
        alt={alt}
        meta={meta}
      />
    </>
  )
}
