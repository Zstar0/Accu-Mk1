/**
 * Provenance of ONE revision (backend documents/provenance.py), shared by the
 * full viewer and the read-only embed. Every value carries the server's word
 * on how it was established; nothing here upgrades a claim to "verified".
 * No links: a reference to the source record grants nothing and is shown as text.
 */
import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import type { DocumentRow } from '@/lib/api-documents'

/** Server timestamps are naive UTC; shown as such rather than guessed into local time. */
const utc = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`

export function DocumentProvenanceDetails({ doc }: { doc: DocumentRow }) {
  const { t } = useTranslation()
  const p = doc.provenance
  if (!p) return null
  const k = (key: string) => t(`documentProvenance.${key}`)
  const rows: [string, string][] = []
  if (p.requested_by)
    rows.push([
      k('requestedBy'),
      `${p.requested_by.label} [${k(p.requested_by.verified ? 'verifiedLogin' : 'supplied')}]`,
    ])
  rows.push([
    k('createdBy'),
    `${p.creator.label} [${k(`creator.${p.creator.kind}`)}]`,
  ])
  if (p.source) {
    rows.push([
      k('source'),
      `${p.source.system_label} [${k(p.source.verified ? 'verified' : 'reported')}]`,
    ])
    const record = [
      p.source.record_type,
      p.source.record_label,
      p.source.record_id,
    ].filter(Boolean)
    if (record.length) rows.push([k('record'), record.join(' · ')])
    if (p.source.run_id) rows.push([k('run'), p.source.run_id])
  }
  rows.push([k('revision'), `${doc.revision} · ${utc(doc.created_at)}`])
  if (p.content_edited)
    rows.push([
      k('contentEdited'),
      `${p.content_edited.by} · ${utc(p.content_edited.at)}`,
    ])
  return (
    <details className="border-b px-4 py-1.5 text-xs" data-provenance>
      <summary className="cursor-pointer text-muted-foreground">
        {k('title')}
      </summary>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-all">{value}</dd>
          </Fragment>
        ))}
      </dl>
    </details>
  )
}
