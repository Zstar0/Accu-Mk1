import {
  CAL_STOCK_AS_TOP_PCT,
  type CalInputs,
  type CalLevelInputs,
  type CalLevelWorked,
  type CalWorked,
} from '@/lib/hplc-calibration'
import {
  ComputedCell,
  HeadCell,
  InputCell,
  fmtDp,
} from '@/components/hplc/prep/HplcSheetCells'
import { onSheetKey } from '@/components/hplc/prep/hplc-sheet-keys'
import { CalNumberBox } from './CalCells'
import { HelpLabel } from './CalTip'
import { Step, type CalCommit } from './HplcCalStandardSection'
import {
  DILUTION_COLUMNS,
  PEAK_COLUMNS,
  STOCK_COLUMNS,
} from './cal-sheet-columns'

const WEIGH_FIELDS = [
  'vial_mg',
  'vial_diluent_mg',
  'vial_diluent_std_mg',
] as const

/** "Level 3, 1000 ug/mL", or "Level 3" before a target is typed: the
 *  position keeps two levels with one target apart. */
// eslint-disable-next-line react-refresh/only-export-components
export function levelName(target: unknown, i: number) {
  return typeof target === 'number' && Number.isFinite(target)
    ? `Level ${i + 1}, ${fmtDp(target, 0)} ug/mL`
    : `Level ${i + 1}`
}

/**
 * The warning flags on the Step 3 boxes, by "<level>:<field>", each with the
 * warning texts that name it (cal.js marks, 248): a repeated weight marks
 * the boxes that repeat it, a backwards weighing or a volume off plan the
 * box that weighed it.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function boxFlags(inputs: CalInputs, worked: CalWorked) {
  const raw = inputs.levels ?? []
  const flags = new Map<string, string[]>()
  const add = (i: number, f: string, t: string) =>
    flags.set(`${i}:${f}`, [...(flags.get(`${i}:${f}`) ?? []), t])
  const key = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? v.toFixed(6) : null
  for (const w of worked.warnings) {
    const i = w.level
    if (i === null) continue
    const L = raw[i] ?? {}
    if (w.code === 'same_weight_row') {
      const keys = WEIGH_FIELDS.map(f => key(L[f]))
      WEIGH_FIELDS.forEach((f, j) => {
        const k = keys[j]
        if (k !== null && keys.filter(x => x === k).length > 1)
          add(i, f, w.text)
      })
    } else if (w.code === 'same_weight_next') {
      const N = raw[i + 1] ?? {}
      for (const f of WEIGH_FIELDS) {
        const a = key(L[f])
        if (a !== null && L[f] !== 0 && a === key(N[f])) {
          add(i, f, w.text)
          add(i + 1, f, w.text)
        }
      }
    } else if (w.code.endsWith('_diluent') && w.code !== 'net_partial')
      add(i, 'vial_diluent_mg', w.text)
    else if (w.code.endsWith('_standard')) add(i, 'vial_diluent_std_mg', w.text)
  }
  return flags
}

const levelValue = (L: CalLevelWorked, key: string) =>
  L[key as keyof CalLevelWorked] as number | null

const TABLE = 'w-full border-collapse'
const WRAP = 'overflow-x-auto rounded-md border'

/** What the keys do in the Step 3 and 4 tables (onSheetKey): the order goes
 *  down a column, as the lab tool's does (round 2 I-1). */
const KEYS_HINT =
  'Tab and Enter go down a column, then to the top of the next one; Shift+Tab and Shift+Enter go back up. The arrow keys move along a row (Left, Right) and between rows (Up, Down); while you edit a value, Left and Right first move through its text.'
const KeysHint = () => (
  <p className="mb-2 text-xs text-muted-foreground" data-testid="keys-hint">
    {KEYS_HINT}
  </p>
)

/** Steps 2, 3 and 4, and the curve line. */
export function HplcCalTables({
  inputs,
  worked,
  replicate,
  onCommit,
  onRefused,
}: {
  inputs: CalInputs
  worked: CalWorked
  replicate: boolean
  onCommit: CalCommit
  onRefused: (key: string, on: boolean) => void
}) {
  const stock = inputs.stock ?? {}
  const raw = inputs.levels ?? []
  const flags = boxFlags(inputs, worked)
  const top = worked.stock_as_top
  const fit = worked.fit
  const range = worked.range

  return (
    <>
      <Step
        no="Step 2"
        title="Stock"
        sub="Weigh the empty stock vial and cap, add the standard and weigh again, add 1 mL of diluent (more only if it will not dissolve) and weigh again. The stock is the standard's weight over the diluent that went in."
      >
        <div className={WRAP}>
          <table className={TABLE} onKeyDown={onSheetKey}>
            <thead>
              <tr>
                {STOCK_COLUMNS.map(c => (
                  <HeadCell key={c.key} col={c} />
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {STOCK_COLUMNS.map(c =>
                  c.kind === 'input' ? (
                    <InputCell key={c.key}>
                      <CalNumberBox
                        label={`Stock, ${c.label}`}
                        field={c.key}
                        bound={c.key}
                        value={stock[c.key as keyof typeof stock]}
                        disabled={replicate}
                        help={c.title}
                        onCommit={v => onCommit('stock', 0, c.key, v)}
                        onRefused={on => onRefused(`stock.${c.key}`, on)}
                      />
                    </InputCell>
                  ) : (
                    <ComputedCell
                      key={c.key}
                      value={worked[c.key as keyof CalWorked] as number | null}
                      dp={c.dp ?? 2}
                    />
                  )
                )}
              </tr>
            </tbody>
          </table>
        </div>
      </Step>

      <Step
        no="Step 3"
        title="Serial dilution"
        sub="Each level is made from the one above it (the first from the stock). Weigh the vial, add the planned diluent and weigh, add the standard (Std to add) and weigh."
        extra={
          <span className="flex flex-wrap items-center gap-3 text-xs">
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={top}
                disabled={replicate}
                aria-describedby="cal-stock-top-help"
                onChange={e =>
                  onCommit('sheet', 0, 'stock_as_top', e.target.checked)
                }
              />
              <HelpLabel
                label="Stock is the top level"
                lines={[
                  'The stock lands at the top target (e.g. 995 for 1000): use it as the first level, an aliquot into a conical tube, no weighings, and dilute the next level from the stock.',
                ]}
              />
              <span id="cal-stock-top-help" className="sr-only">
                The stock lands at the top target: use it as the first level, an
                aliquot, no weighings, and dilute the next level from the stock.
              </span>
            </label>
            {top && (
              <span className="inline-flex items-center gap-1.5">
                <HelpLabel
                  label="Aliquot (uL)"
                  lines={[
                    "What is taken from the stock vial for the top level's injection: it counts against the stock remaining",
                  ]}
                />
                <CalNumberBox
                  label="Aliquot (uL)"
                  field="top_aliquot_ul"
                  bound="top_aliquot_ul"
                  value={inputs.top_aliquot_ul}
                  placeholder="150"
                  disabled={replicate}
                  help="What is taken from the stock vial for the top level's injection: it counts against the stock remaining"
                  onCommit={v => onCommit('sheet', 0, 'top_aliquot_ul', v)}
                  onRefused={on => onRefused('sheet.top_aliquot_ul', on)}
                />
              </span>
            )}
          </span>
        }
      >
        {worked.stock_near_top && (
          <p
            className="mb-2 text-xs text-sky-700 dark:text-sky-300"
            data-testid="stock-top-hint"
          >
            {`The stock is ${fmtDp(worked.stock_conc_ug_ml, 2)} ug/mL, within ${CAL_STOCK_AS_TOP_PCT} % of the ${fmtDp(worked.levels[0]?.target, 0)} ug/mL level: tick "Stock is the top level" to use it directly (an aliquot, no weighings) and dilute the next level from the stock.`}
          </p>
        )}
        <KeysHint />
        <div className={WRAP}>
          <table className={TABLE} onKeyDown={onSheetKey}>
            <thead>
              <tr>
                {DILUTION_COLUMNS.map(c => (
                  <HeadCell key={c.key} col={c} />
                ))}
              </tr>
            </thead>
            <tbody>
              {worked.levels.map((L, i) => {
                const own: CalLevelInputs = raw[i] ?? {}
                const name = levelName(own.target, i)
                const fromStock = top && i === 0
                const stockNote = fromStock
                  ? `The stock itself: ${fmtDp(worked.stock_conc_ug_ml, 2)} ug/mL, a ${fmtDp(worked.top_aliquot_ul, 0)} uL aliquot into a conical tube, no weighings; the next level is diluted from the stock.`
                  : undefined
                return (
                  <tr
                    key={i}
                    data-problem={L.problem ?? undefined}
                    className={
                      L.problem
                        ? 'bg-red-500/[0.07]'
                        : fromStock
                          ? 'bg-sky-500/[0.07]'
                          : ''
                    }
                  >
                    {DILUTION_COLUMNS.map(c => {
                      if (c.kind === 'input') {
                        const weigh = c.key !== 'target'
                        const flag = flags.get(`${i}:${c.key}`)
                        return (
                          <InputCell key={c.key}>
                            <CalNumberBox
                              label={`${name}, ${c.label}`}
                              field={c.key}
                              bound={c.key}
                              value={
                                weigh && fromStock
                                  ? null
                                  : own[c.key as keyof CalLevelInputs]
                              }
                              placeholder={
                                weigh && fromStock ? 'stock' : undefined
                              }
                              disabled={replicate || (weigh && fromStock)}
                              help={weigh && fromStock ? stockNote : c.title}
                              flag={flag?.join(' ')}
                              onCommit={v => onCommit('level', i, c.key, v)}
                              onRefused={on =>
                                onRefused(`level.${i}.${c.key}`, on)
                              }
                            />
                          </InputCell>
                        )
                      }
                      const off =
                        (c.key === 'actual_diluent_ul' &&
                          worked.warnings.find(
                            w =>
                              w.level === i && w.code === 'volume_off_diluent'
                          )) ||
                        (c.key === 'actual_std_ul' &&
                          worked.warnings.find(
                            w =>
                              w.level === i && w.code === 'volume_off_standard'
                          ))
                      return (
                        <ComputedCell
                          key={c.key}
                          value={levelValue(L, c.key)}
                          dp={c.dp ?? 2}
                          mark={!!off}
                          markTitle={off ? off.text : undefined}
                        />
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Step>

      <Step
        no="Step 4"
        title="Peak areas and the curve"
        sub="From the run: the peak area, purity and retention time of each level. The curve is peak area against the actual concentration."
      >
        <KeysHint />
        <div className={WRAP}>
          <table className={TABLE} onKeyDown={onSheetKey}>
            <thead>
              <tr>
                {PEAK_COLUMNS.map(c => (
                  <HeadCell key={c.key} col={c} />
                ))}
              </tr>
            </thead>
            <tbody>
              {worked.levels.map((L, i) => {
                const name = levelName(L.target, i)
                return (
                  <tr key={i} className={L.problem ? 'bg-red-500/[0.07]' : ''}>
                    {PEAK_COLUMNS.map(c =>
                      c.kind === 'input' ? (
                        <InputCell key={c.key}>
                          <CalNumberBox
                            label={`${name}, ${c.label}`}
                            field={c.key}
                            bound={c.key}
                            value={levelValue(L, c.key)}
                            disabled={false}
                            help={c.title}
                            onCommit={v => onCommit('level', i, c.key, v)}
                            onRefused={on =>
                              onRefused(`level.${i}.${c.key}`, on)
                            }
                          />
                        </InputCell>
                      ) : (
                        <ComputedCell
                          key={c.key}
                          value={levelValue(L, c.key)}
                          dp={c.dp ?? 2}
                        />
                      )
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <dl
          className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs"
          data-testid="curve-summary"
        >
          {(
            [
              [
                'Slope',
                fmtDp(fit.slope, 6),
                'Peak area per ug/mL (Excel SLOPE over the levels with a peak area)',
              ],
              ['Intercept', fmtDp(fit.intercept, 6), ''],
              ['R²', fmtDp(fit.r2, 6), ''],
              ['Points', fit.n ? String(fit.n) : '-', ''],
              [
                'Range',
                range && range.low !== null && range.high !== null
                  ? `${fmtDp(range.low, 4)} to ${fmtDp(range.high, 4)} ug/mL`
                  : '-',
                'The concentrations the curve was fitted over: a sample outside it is extrapolated',
              ],
              [
                'Average RT',
                worked.rt_avg !== null ? `${fmtDp(worked.rt_avg, 4)} min` : '-',
                "The workbook's N27: the mean retention time over every level with an RT typed. The curve is filed with the mean over the levels in the fit, which can differ when a level has an RT but no peak area.",
              ],
              ['RT %RSD', fmtDp(worked.rt_rsd_pct, 3), ''],
            ] as [string, string, string][]
          ).map(([label, value, help]) => (
            <div key={label} className="flex items-baseline gap-1.5">
              <dt className="text-muted-foreground">
                <HelpLabel label={label} lines={help ? [help] : []} />
              </dt>
              <dd className="font-mono font-semibold" data-stat={label}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </Step>
    </>
  )
}
