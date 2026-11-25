import type { ReactNode } from 'react'
import {
  calculatePrep,
  extractionWater,
  fmt2,
  premixRows,
  PROTOCOL,
  type MixRow,
} from '@/lib/pcr-plate'

const TH = 'px-2.5 py-1 text-left text-[12px] font-normal text-foreground/80'
const TD = 'px-2.5 py-1 text-right font-mono text-[12px] tabular-nums'

/**
 * The calculation cards for one plate, as on Dennis's screen and by
 * SOP-MICRO2601 Rev E 8.1: the reaction count and elution water, the
 * reaction, one well set's premix, the IPC mix, the two assay mixes and the
 * reagent reference. Every figure comes from calculatePrep; the pipetting
 * column (x overage) is the one the analyst draws against.
 */
export function PcrCalculations({
  wells,
  samples,
  overage,
}: {
  /** Wells on the plate per well set, NPC included: the SOP's N. */
  wells: number
  /** Samples among them; the rest are controls. */
  samples: number
  overage: number
}) {
  const c = calculatePrep(wells, overage)
  const water = extractionWater(wells, overage)
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
      <Card
        title="Reactions"
        note={`Elution water is ${water.perExtraction} µL per extraction × ${overage}, warmed at 65 °C.`}
      >
        <Kv
          rows={[
            ['Samples on plate', String(samples)],
            ['Controls', String(wells - samples)],
            ['Reactions per well set (N)', String(c.reactions.perSet)],
            ['Reactions total, A + B', String(c.reactions.total)],
            ['Extractions (samples + NPC)', String(water.extractions)],
          ]}
          total={['Elution water, 65 °C', `${fmt2(water.pipette)} µL`]}
        />
      </Card>
      <Card title="Volume per well" unit="µL">
        <Kv
          rows={[
            ['Master mix 2.0 (2X)', fmt2(c.perWell.mm)],
            ['Duplex assay mix (10X)', fmt2(c.perWell.assayMix)],
            ['IPC mix', fmt2(c.perWell.ipcMix)],
            ['Premix per well', fmt2(c.perWell.premix)],
            ['Template (DNA / NPC)', fmt2(c.perWell.template)],
          ]}
          total={['Total per well', fmt2(c.perWell.total)]}
        />
      </Card>
      <Card
        title="Premix per well set"
        unit="µL"
        note="One tube per well set: make it twice, Set A (16S) and Set B (18S)."
      >
        <Mix rows={premixRows(c)} overage={overage} />
      </Card>
      <Card title="IPC mix, per set" unit="µL">
        <Mix rows={c.ipc} overage={overage} />
      </Card>
      <Card title="Set A assay mix: 16S" unit="µL">
        <Mix rows={c.bac} overage={overage} />
      </Card>
      <Card title="Set B assay mix: 18S" unit="µL">
        <Mix rows={c.fun} overage={overage} />
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
