/**
 * ReadSourceBanner — subtle summary shown on the parent sample page when
 * basic-info was read from the Mk1 registry (source==='mk1') instead of
 * live SENAITE. Zero visual change in the default `senaite` read mode.
 *
 * Deliberately presentational/props-only so it's trivially unit-testable;
 * `SampleDetails` feeds it `read_source`/`registry_missing`/`field_sources`
 * straight off the resolved sample data (see Task 4's `SenaiteLookupResult`).
 */
interface Props {
  readSource: 'mk1' | undefined
  registryMissing: boolean | undefined
  fieldSources: Record<string, 'mk1' | 'senaite'> | undefined
}

export function ReadSourceBanner({
  readSource,
  registryMissing,
  fieldSources,
}: Props) {
  if (readSource !== 'mk1') return null

  if (registryMissing) {
    return (
      <p className="font-mono text-[10px] text-muted-foreground/70">
        reading from Accu-Mk1 — no registry row, showing SENAITE
      </p>
    )
  }

  const sources = fieldSources ?? {}
  const total = Object.keys(sources).length
  const fromMk1 = Object.values(sources).filter(s => s === 'mk1').length

  return (
    <p className="font-mono text-[10px] text-muted-foreground/70">
      reading basic-info from Accu-Mk1 — {fromMk1}/{total} fields
    </p>
  )
}
