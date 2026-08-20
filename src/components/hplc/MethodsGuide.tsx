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
// Static in-app guide for the methods / instruments workflow: what a method
// is, the draft → active → retired lifecycle, service coverage + defaults,
// bench stamping, and revisions. Sibling of NewTestOnboardingGuide (analysis
// profiles page); if the lifecycle rules change, update this copy too.
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

export function MethodsGuide() {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <CircleHelp className="mr-1 h-4 w-4" />
          Methods Guide
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] w-[90vw] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-xl">
            Methods &amp; Instruments — the Lifecycle
          </DialogTitle>
          <DialogDescription>
            How an analytical method goes from a draft to the document the
            bench stamps and the certificate prints: create, link coverage,
            attach the SOP, activate, stamp, revise.
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 text-sm leading-relaxed [&_p]:my-2">
          {/* ── The model ── */}
          <div className="mt-2 rounded-md border bg-muted/30 px-4 py-3">
            <p className="m-0 font-semibold">Five concepts, one job each</p>
            <ul className="my-2 list-disc space-y-1 pl-5 text-muted-foreground">
              <li>
                <strong className="text-foreground">Method</strong> — a
                controlled document: a named procedure with a{' '}
                <Code>code</Code>, a technique, and numbered revisions. Only
                one revision of a code is ever <em>active</em>.
              </li>
              <li>
                <strong className="text-foreground">Instrument</strong> — a
                piece of equipment registered here in Mk1. Link instruments to
                the methods that run on them.
              </li>
              <li>
                <strong className="text-foreground">Covered Services</strong>{' '}
                — the analysis services a method is approved to test. Coverage
                is what makes a method eligible for stamping.
              </li>
              <li>
                <strong className="text-foreground">Default</strong> — per
                service, the one method the bench applies automatically. Other
                covered methods stay pickable as overrides.
              </li>
              <li>
                <strong className="text-foreground">Stamping</strong> —
                recording which method + instrument produced an analysis row.
                The certificate prints the stamped method&apos;s name.
              </li>
            </ul>
          </div>

          {/* ── 1 Create ── */}
          <StepHeading num="1" title="Create the method — it starts as a draft" />
          <p>
            <strong>New Method</strong> mints a <strong>draft</strong>. Drafts
            are invisible to the bench — no picker, no default resolution, no
            bulk apply — until you activate them. Use the draft window to get
            the document right.
          </p>
          <FieldTable
            rows={[
              [
                'Name',
                'Human-readable procedure title — this is what the certificate prints.',
              ],
              [
                <Code key="c">Code</Code>,
                <>
                  Document control number, e.g. <Code>AM-ELEM-001</Code>. All
                  revisions of a method share its code; only one revision per
                  code can be active.
                </>,
              ],
              [
                'Technique',
                'Free text: HPLC, ICP-MS, MP-AES, qPCR… Used for filtering and context, not validation.',
              ],
              ['Department', 'Owning department (optional).'],
              [
                'Instrument',
                'The instrument the method runs on. More can be linked later from the method panel.',
              ],
              [
                'Covered Services',
                'Link the analysis services this method tests, right from the create form — or later via Edit on the method panel.',
              ],
            ]}
          />

          {/* ── 2 Coverage ── */}
          <StepHeading num="2" title="Link coverage and set defaults" />
          <p>
            Open the method → <strong>Edit</strong> → <strong>Covered
            Services</strong> → <em>Add service…</em>. Tick{' '}
            <strong>Default</strong> on each service where this method is the
            one the bench should auto-apply. Link changes save immediately —
            the Save button only governs the method&apos;s fields.
          </p>
          <Callout tone="rule" label="One default per service">
            <p>
              A service can have exactly one default method. Setting a second
              is rejected and names the method that already holds it — move
              the default there first, or leave this method as a non-default
              option.
            </p>
          </Callout>

          {/* ── 3 Attach ── */}
          <StepHeading num="3" title="Attach the SOP" />
          <p>
            The <strong>Attachments</strong> block on the method panel takes
            the SOP / procedure PDF. Uploads work in any status; deleting an
            attachment is draft-only — issued documents keep their record.
          </p>

          {/* ── 4 Activate ── */}
          <StepHeading num="4" title="Activate" />
          <p>
            <strong>Activate</strong> issues the document: the method appears
            in bench pickers and default resolution, and its controlled
            content locks (name, code, technique, reference, procedure
            summary, run parameters). Notes, department, and instrument links
            stay editable.
          </p>
          <Callout tone="trap" label="Forgot to activate?">
            <p>
              A linked-but-draft method behaves like it doesn&apos;t exist:
              worksheet bulk-apply reports every row as skipped, and the
              per-row picker won&apos;t offer it. If a method you just made
              isn&apos;t showing up anywhere, check its status badge first.
            </p>
          </Callout>

          {/* ── 5 Bench ── */}
          <StepHeading num="5" title="Stamp at the bench" />
          <p>Three ways method + instrument get onto analysis rows:</p>
          <ul className="my-2 list-disc space-y-1 pl-5">
            <li>
              <strong>Worksheet apply bar</strong> — pick a method (+
              instrument) in the worksheet drawer and apply to the whole
              sheet. Only rows whose service is <em>covered</em> by the method
              are stamped; the result reports what was skipped and why.
            </li>
            <li>
              <strong>Per-row override</strong> — the wrench on a row opens a
              dialog scoped to that row&apos;s service coverage.
            </li>
            <li>
              <strong>At submit</strong> — result submission can carry
              method/instrument with it.
            </li>
          </ul>
          <Callout tone="note" label="Stamping is state-guarded">
            <p>
              Rows still in <Code>unassigned</Code>, <Code>assigned</Code>, or{' '}
              <Code>to_be_verified</Code> accept stamps. Verified and
              published rows are locked — re-stamping history is not allowed.
            </p>
          </Callout>

          {/* ── 6 Revise ── */}
          <StepHeading num="6" title="Revise, don't edit" />
          <p>
            Issued content is immutable — a change to the procedure means a{' '}
            <strong>New Revision</strong>. That clones the content, service
            links, and instrument links into a fresh draft (rev N+1). Edit it,
            then <strong>Activate</strong>: the old revision retires
            automatically and its <em>defaults move to the new revision</em>.
            Rows stamped with the old revision keep pointing at it — history
            is preserved.
          </p>
          <Callout tone="note" label="Certificates print the name only">
            <p>
              The COA prints the method <em>name</em>, not the revision
              number, so rev 1 and rev 2 certificates look identical today.
              Traceability to the exact revision lives on the analysis row.
            </p>
          </Callout>

          {/* ── 7 Retire / delete ── */}
          <StepHeading num="7" title="Retire — almost never delete" />
          <p>
            <strong>Retire</strong> pulls a method from the bench without
            touching history. <strong>Delete</strong> is only for mistakes:
            it&apos;s blocked (409) once any analysis row references the
            method, because deleting a stamped method would erase
            traceability.
          </p>

          <Callout tone="expect" label="The happy path, end to end">
            <p>
              New Method (draft, with code + services) → link instrument →
              attach SOP → <strong>Activate</strong> → bench stamps it via
              the worksheet apply bar → certificate prints its name. Procedure
              changes → New Revision → Activate. Sunset → Retire.
            </p>
          </Callout>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default MethodsGuide
