import type { ReactNode } from 'react'
import { calculatePrep, fmt2, PROTOCOL, type MixRow } from '@/lib/pcr-plate'

const TH = 'px-2.5 py-1 text-left text-[12px] font-normal text-foreground/80'
const TD = 'px-2.5 py-1 text-right font-mono text-[12px] tabular-nums'

/**
 * The seven calculation cards for one plate, as on Dennis's screen: well
 * counts, the reaction, the two assay mixes, bulk volumes, the IPC mix and
 * the reagent reference. Every figure comes from calculatePrep; the pipetting
 * column (x overage) is the one the analyst draws against.
 */
export function PcrCalculations({
  wells,
  overage,
}: {
  /** Wells on the plate, NPC included. */
  wells: number
  overage: number
}) {
  const c = calculatePrep(wells, overage)
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
      <Card
        title="Well counts"
        note="MM and IPC = 2N + 4 · BAC and FUN = N + 2"
      >
        <Kv
          rows={[
            ['Wells on plate (N)', String(wells)],
            ['Master mix wells', String(c.wells.mm)],
            ['BAC wells', String(c.wells.bac)],
            ['FUN wells', String(c.wells.fun)],
            ['IPC wells', String(c.wells.ipc)],
          ]}
        />
      </Card>
      <Card title="Volume per well" unit="µL">
        <Kv
          rows={[
            ['Master mix', fmt2(c.perWell.mm)],
            ['Assay mix', fmt2(c.perWell.assayMix)],
            ['IPC mix', fmt2(c.perWell.ipcMix)],
            ['Template', fmt2(c.perWell.template)],
          ]}
          total={['Total per well', fmt2(c.perWell.total)]}
        />
      </Card>
      <Card title="BAC mix: 16S" unit="µL">
        <Mix rows={c.bac} overage={overage} />
      </Card>
      <Card title="FUN mix: 18S" unit="µL">
        <Mix rows={c.fun} overage={overage} />
      </Card>
      <Card
        title="Bulk volumes needed"
        unit="µL"
        note="Bulk = volume per well × wells of that kind"
      >
        <Kv
          rows={[
            ['Master mix', fmt2(c.bulk.mm)],
            ['BAC mix', fmt2(c.bulk.bac)],
            ['FUN mix', fmt2(c.bulk.fun)],
            ['IPC mix', fmt2(c.bulk.ipc)],
          ]}
        />
      </Card>
      <Card
        title="IPC mix"
        unit="µL"
        note="IPC runs at 0.6× rather than 1× to preserve reagent, previously validated as fit for purpose."
      >
        <Mix rows={c.ipc} overage={overage} />
      </Card>
      <Card title="Reagent reference">
        <Kv rows={PROTOCOL.reagents} />
      </Card>
    </div>
  )
}

function Card({
  title,
  unit,
  note,
  children,
}: {
  title: string
  unit?: string
  note?: string
  children: ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-[5px] border bg-card">
      <h4 className="flex items-baseline justify-between gap-2 border-b bg-muted/60 px-2.5 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {title}
        {unit && (
          <span className="font-mono text-[10px] font-normal normal-case tracking-normal">
            {unit}
          </span>
        )}
      </h4>
      {children}
      {note && (
        <p className="border-t bg-muted/30 px-2.5 py-1.5 text-[11px] leading-snug text-muted-foreground">
          {note}
        </p>
      )}
    </section>
  )
}

function Kv({
  rows,
  total,
}: {
  rows: [string, string][]
  total?: [string, string]
}) {
  return (
    <table className="w-full border-collapse">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k} className="border-b border-border/60 last:border-b-0">
            <th className={TH}>{k}</th>
            <td className={TD}>{v}</td>
          </tr>
        ))}
        {total && (
          <tr className="border-t-2 font-semibold">
            <th className={TH}>{total[0]}</th>
            <td className={`${TD} bg-teal-500/[0.06]`}>{total[1]}</td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

function Mix({ rows, overage }: { rows: MixRow[]; overage: number }) {
  const HEAD =
    'px-2.5 py-1 text-right text-[9.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground'
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b bg-muted/40">
          <th className={`${HEAD} text-left`}>Component</th>
          <th className={HEAD}>Calculated</th>
          <th
            className={`${HEAD} bg-teal-500/10 text-teal-800 dark:text-teal-200`}
          >
            × {overage}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.name} className="border-b border-border/60">
            <th className={TH}>{r.name}</th>
            <td className={TD}>{fmt2(r.base)}</td>
            <td className={`${TD} bg-teal-500/[0.06] font-semibold`}>
              {fmt2(r.pipette)}
            </td>
          </tr>
        ))}
        <tr className="border-t-2 font-semibold">
          <th className={TH}>Total</th>
          <td className={TD}>{fmt2(rows.reduce((a, r) => a + r.base, 0))}</td>
          <td className={`${TD} bg-teal-500/[0.06]`}>
            {fmt2(rows.reduce((a, r) => a + r.pipette, 0))}
          </td>
        </tr>
      </tbody>
    </table>
  )
}

export default PcrCalculations
