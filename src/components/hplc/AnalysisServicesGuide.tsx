import { useState } from 'react'
import { CircleHelp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

// ─────────────────────────────────────────────────────────────────────────────
// Static in-app guide for the Analysis Services catalog: what a service is,
// keyword discipline, origin (SENAITE legacy vs Mk1 native), local overrides,
// specs, and how services relate to profiles, methods, and certificates.
// Sibling of MethodsGuide / NewTestOnboardingGuide; keep the family in sync
// when catalog rules change.
// ─────────────────────────────────────────────────────────────────────────────

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
      {children}
    </code>
  )
}

type CalloutTone = 'trap' | 'rule' | 'note' | 'expect'

const CALLOUT_STYLES: Record<CalloutTone, { box: string; label: string }> = {
  trap: {
    box: 'border-destructive/60 bg-destructive/10',
    label: 'text-destructive',
  },
  rule: {
    box: 'border-amber-500/60 bg-amber-500/10',
    label: 'text-amber-600 dark:text-amber-400',
  },
  note: {
    box: 'border-primary/60 bg-primary/10',
    label: 'text-primary',
  },
  expect: {
    box: 'border-emerald-500/60 bg-emerald-500/10',
    label: 'text-emerald-600 dark:text-emerald-400',
  },
}

function Callout({
  tone,
  label,
  children,
}: {
  tone: CalloutTone
  label: string
  children: React.ReactNode
}) {
  const s = CALLOUT_STYLES[tone]
  return (
    <div className={`my-3 border-l-2 px-3 py-2 text-sm ${s.box}`}>
      <span
        className={`mb-1 block text-[0.68rem] font-semibold uppercase tracking-wider ${s.label}`}
      >
        {label}
      </span>
      <div className="space-y-1.5 [&_p]:m-0">{children}</div>
    </div>
  )
}

function StepHeading({ num, title }: { num: string; title: string }) {
  return (
    <div className="mt-6 flex items-baseline gap-3 border-b border-border pb-1.5">
      <span className="font-mono text-base font-bold text-primary">{num}</span>
      <h3 className="text-base font-semibold">{title}</h3>
    </div>
  )
}

function FieldTable({ rows }: { rows: [React.ReactNode, React.ReactNode][] }) {
  return (
    <div className="my-3 overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-44">Field</TableHead>
            <TableHead>What to enter</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(([field, what], i) => (
            <TableRow key={i}>
              <TableCell className="whitespace-nowrap align-top font-medium">
                {field}
              </TableCell>
              <TableCell className="whitespace-normal text-muted-foreground">
                {what}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function AnalysisServicesGuide() {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <CircleHelp className="mr-1 h-4 w-4" />
          Services Guide
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] w-[90vw] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-xl">
            Analysis Services — the Catalog
          </DialogTitle>
          <DialogDescription>
            A service is one orderable, benchable, reportable test. Everything
            else in the system hangs off this catalog: profiles bundle
            services, methods cover them, worksheets fulfill them, and
            certificates print them.
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 text-sm leading-relaxed [&_p]:my-2">
          {/* ── The model ── */}
          <div className="mt-2 rounded-md border bg-muted/30 px-4 py-3">
            <p className="m-0 font-semibold">How a service relates to everything else</p>
            <ul className="my-2 list-disc space-y-1 pl-5 text-muted-foreground">
              <li>
                <strong className="text-foreground">Keyword</strong> — the
                service&apos;s permanent identity. It joins results across
                Mk1, the certificate builder, and the storefront wiring.
              </li>
              <li>
                <strong className="text-foreground">Profiles</strong> — bundle
                services into what a customer orders. A service not in any
                profile can still be added to samples as an add-on.
              </li>
              <li>
                <strong className="text-foreground">Methods</strong> — cover
                services (Methods page) so the bench can stamp which procedure
                + instrument produced each result.
              </li>
              <li>
                <strong className="text-foreground">Specs</strong> — the
                per-service acceptance criteria live here, on the service, in
                the Specs section of the panel.
              </li>
              <li>
                <strong className="text-foreground">Origin</strong> —{' '}
                <Code>SENAITE</Code> rows are legacy clones from the old LIMS;{' '}
                <Code>Mk1</Code> rows are native. All new services are native.
              </li>
            </ul>
          </div>

          {/* ── 1 Create ── */}
          <StepHeading num="1" title="Create a service" />
          <p>
            <strong>New Service</strong> creates an Mk1-native row. The
            catalog is Mk1-owned now — there is no SENAITE sync to wait for.
          </p>
          <FieldTable
            rows={[
              ['Title', 'Display name — what the table, bench, and certificate show.'],
              [
                <Code key="k">Keyword</Code>,
                'Permanent join key (e.g. STERILITY-2, LEAD-PPM). Choose it like a database column name: stable, unambiguous, never recycled.',
              ],
              ['Category', 'Grouping for filtering and reporting.'],
              ['Unit', 'Result unit as printed (%, EU/mL, CFU…).'],
              [
                'Result type',
                'Numeric by default; select / multiselect take a list of allowed options for pick-list results.',
              ],
              ['Department', 'Owning department (optional).'],
              [
                'Peptide link',
                'For peptide-specific services, link the peptide via the panel — it keeps the peptide name in sync automatically.',
              ],
            ]}
          />

          {/* ── 2 Keyword discipline ── */}
          <StepHeading num="2" title="Keyword discipline" />
          <Callout tone="trap" label="Keywords are load-bearing">
            <p>
              Downstream systems index results by this exact string. On
              SENAITE-origin rows the keyword is locked here — it belongs to
              the legacy system. On Mk1 rows it stays editable only until
              analyses reference the service; after that the backend refuses
              the change. Never repurpose a keyword for a different assay —
              retire the service and create a new one.
            </p>
          </Callout>

          {/* ── 3 Legacy rows + overrides ── */}
          <StepHeading num="3" title="Legacy SENAITE rows and local overrides" />
          <p>
            Rows marked <Code>SENAITE</Code> were cloned from the old LIMS.
            You can still edit their title, category, or unit — doing so
            converts that field to a <strong>local override</strong>: Mk1&apos;s
            value wins from then on, and the row shows an override marker in
            the table. The keyword stays SENAITE-owned.
          </p>
          <Callout tone="note" label="The sync is retired">
            <p>
              The catalog no longer pulls from SENAITE — the sync affordance
              was removed as part of the phase-out. Existing legacy rows
              remain and keep working; new tests are born native.
            </p>
          </Callout>

          {/* ── 4 Specs ── */}
          <StepHeading num="4" title="Specs" />
          <p>
            The <strong>Specs</strong> section on the service panel holds the
            acceptance criteria (per-peptide where applicable) that
            conformance checks and certificates evaluate against. Specs are
            owned here, on the service — not in the certificate builder.
          </p>

          {/* ── 5 Methods ── */}
          <StepHeading num="5" title="Method coverage and the default" />
          <p>
            Which procedures can test this service is configured from the{' '}
            <strong>Methods</strong> page (a method&apos;s Covered Services
            list). Mark one covered method as the service&apos;s{' '}
            <strong>Default</strong> and the bench auto-applies it when
            stamping. If a default&apos;s method is retired later, the service
            simply resolves to no default — nothing blocks the bench.
          </p>

          {/* ── 6 Retire ── */}
          <StepHeading num="6" title="Deactivate, don't delete" />
          <p>
            Deactivating a service hides it from ordering and provisioning
            while history stays intact. Deleting is for mistakes only — a
            service that analyses already reference should never be deleted.
          </p>

          <Callout tone="expect" label="The happy path, end to end">
            <p>
              New Service (native, deliberate keyword) → specs in the panel →
              method coverage + default on the Methods page → profile bundles
              it for ordering → check-in provisions it onto vials → the bench
              stamps and submits → the certificate prints it.
            </p>
          </Callout>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default AnalysisServicesGuide
