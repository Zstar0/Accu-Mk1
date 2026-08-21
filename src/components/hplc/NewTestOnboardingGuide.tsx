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
// Static in-app copy of the "Bringing a New Test Online" operations guide.
// Content parity is with the published guide document; if the launch process
// changes (new field, new phase, new trap), update both.
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

function PhaseHeading({
  num,
  title,
  chip,
}: {
  num?: string
  title: string
  chip: string
}) {
  return (
    <div className="mt-8 flex flex-wrap items-baseline gap-3 border-b-2 border-foreground/80 pb-2">
      {num && (
        <span className="font-mono text-lg font-bold text-primary">{num}</span>
      )}
      <h3 className="text-base font-semibold">{title}</h3>
      <span className="ml-auto whitespace-nowrap border px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wider text-muted-foreground">
        {chip}
      </span>
    </div>
  )
}

function StepHeading({
  id,
  title,
  where,
}: {
  id: string
  title: string
  where: string
}) {
  return (
    <div className="mt-5">
      <h4 className="text-sm font-semibold">
        <span className="mr-1.5 font-mono text-primary">{id}</span>
        {title}
      </h4>
      <p className="mt-0.5 text-xs text-muted-foreground">{where}</p>
    </div>
  )
}

function LifecycleDiagram() {
  return (
    <figure className="my-4">
      <div className="overflow-x-auto">
        <svg
          viewBox="0 0 880 235"
          role="img"
          aria-label="Order lifecycle: a WordPress order flows through the Integration Service to Accu-Mk1, where check-in seeds vials and analyses, the bench produces results, and the COA prints armed sections."
          className="block h-auto w-full min-w-[640px] text-foreground"
          fontSize="12.5"
          fill="none"
          strokeWidth="1.4"
        >
          <defs>
            <marker
              id="ntg-arr"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" fill="currentColor" stroke="none" />
            </marker>
          </defs>
          <g stroke="currentColor">
            <rect x="8" y="30" width="150" height="58" />
            <rect x="228" y="30" width="150" height="58" />
            <rect x="448" y="30" width="150" height="58" />
            <rect x="668" y="30" width="204" height="58" />
            <rect x="228" y="150" width="150" height="58" />
            <rect x="448" y="150" width="150" height="58" />
            <rect x="668" y="150" width="204" height="58" />
          </g>
          <g fill="currentColor" stroke="none">
            <text x="83" y="53" textAnchor="middle" fontWeight="600">
              WP storefront
            </text>
            <text x="303" y="53" textAnchor="middle" fontWeight="600">
              Integration Service
            </text>
            <text x="523" y="53" textAnchor="middle" fontWeight="600">
              Accu-Mk1 sample
            </text>
            <text x="770" y="53" textAnchor="middle" fontWeight="600">
              Check-in
            </text>
            <text x="303" y="173" textAnchor="middle" fontWeight="600">
              COA
            </text>
            <text x="523" y="173" textAnchor="middle" fontWeight="600">
              Parent tier
            </text>
            <text x="770" y="173" textAnchor="middle" fontWeight="600">
              Bench
            </text>
          </g>
          <g
            className="text-muted-foreground"
            fill="currentColor"
            stroke="none"
          >
            <text x="83" y="70" textAnchor="middle">
              wizard card + line item
            </text>
            <text x="303" y="70" textAnchor="middle">
              validates + stores order
            </text>
            <text x="523" y="70" textAnchor="middle">
              parent placeholder rows
            </text>
            <text x="770" y="70" textAnchor="middle">
              vials roled + analyses seeded
            </text>
            <text x="303" y="190" textAnchor="middle">
              armed sections print
            </text>
            <text x="523" y="190" textAnchor="middle">
              promote → verify
            </text>
            <text x="770" y="190" textAnchor="middle">
              results on the vial
            </text>
            <text x="190" y="50" textAnchor="middle">
              order
            </text>
            <text x="410" y="50" textAnchor="middle">
              signal
            </text>
            <text x="630" y="50" textAnchor="middle">
              receive
            </text>
            <text x="784" y="120" textAnchor="start">
              enter + verify
            </text>
            <text x="636" y="171" textAnchor="middle">
              promote
            </text>
            <text x="416" y="171" textAnchor="middle">
              verified rows
            </text>
          </g>
          <g stroke="currentColor" markerEnd="url(#ntg-arr)">
            <line x1="158" y1="59" x2="222" y2="59" />
            <line x1="378" y1="59" x2="442" y2="59" />
            <line x1="598" y1="59" x2="662" y2="59" />
            <line x1="770" y1="88" x2="770" y2="144" />
            <line x1="668" y1="179" x2="604" y2="179" />
            <line x1="448" y1="179" x2="384" y2="179" />
          </g>
          <g
            className="text-primary"
            stroke="currentColor"
            strokeDasharray="4 3"
          >
            <line x1="83" y1="30" x2="83" y2="12" />
            <line x1="303" y1="30" x2="303" y2="12" />
            <line x1="523" y1="30" x2="523" y2="12" />
            <line x1="83" y1="12" x2="523" y2="12" />
          </g>
          <text
            x="300"
            y="8"
            textAnchor="middle"
            className="text-primary"
            fill="currentColor"
            stroke="none"
            fontFamily="monospace"
            fontSize="11"
          >
            profile key — one string, matched verbatim at every hop
          </text>
        </svg>
      </div>
      <figcaption className="mt-1.5 text-xs text-muted-foreground">
        The life of an ordered test. This guide configures every box; the
        profile key is the single identity that ties them together. Nothing is
        seeded before check-in — that gap is by design, not a failure.
      </figcaption>
    </figure>
  )
}

function IdentityDiagram() {
  return (
    <figure className="my-4">
      <div className="overflow-x-auto">
        <svg
          viewBox="0 0 880 150"
          role="img"
          aria-label="The profile key string appears in four places: the WordPress Test Services row, the order payload, the IS registry, and the Mk1 analysis profile — all matched verbatim."
          className="block h-auto w-full min-w-[640px] text-foreground"
          fontSize="12.5"
          fill="none"
          strokeWidth="1.4"
        >
          <defs>
            <marker
              id="ntg-arr2"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" fill="currentColor" stroke="none" />
            </marker>
          </defs>
          <g stroke="currentColor">
            <rect x="8" y="45" width="158" height="56" />
            <rect x="230" y="45" width="158" height="56" />
            <rect x="452" y="45" width="158" height="56" />
            <rect x="674" y="45" width="198" height="56" />
          </g>
          <g fill="currentColor" stroke="none">
            <text x="87" y="67" textAnchor="middle" fontWeight="600">
              WP Test Services
            </text>
            <text x="309" y="67" textAnchor="middle" fontWeight="600">
              Order payload
            </text>
            <text x="531" y="67" textAnchor="middle" fontWeight="600">
              IS registry
            </text>
            <text x="773" y="67" textAnchor="middle" fontWeight="600">
              Mk1 profile.key
            </text>
          </g>
          <g
            className="text-muted-foreground"
            fill="currentColor"
            stroke="none"
          >
            <text x="87" y="84" textAnchor="middle">
              Profile Key field
            </text>
            <text x="309" y="84" textAnchor="middle">
              {'services{ key: true }'}
            </text>
            <text x="531" y="84" textAnchor="middle">
              recognized key set
            </text>
            <text x="773" y="84" textAnchor="middle">
              seeding · demand · COA section
            </text>
            <text x="195" y="38" textAnchor="middle" fontSize="11">
              sent verbatim
            </text>
            <text x="417" y="38" textAnchor="middle" fontSize="11">
              validated against
            </text>
            <text x="639" y="38" textAnchor="middle" fontSize="11">
              synced from
            </text>
          </g>
          <g stroke="currentColor" markerEnd="url(#ntg-arr2)">
            <line x1="166" y1="73" x2="224" y2="73" />
            <line x1="388" y1="73" x2="446" y2="73" />
            <line x1="610" y1="73" x2="668" y2="73" />
          </g>
          <text
            x="440"
            y="132"
            textAnchor="middle"
            className="text-primary"
            fill="currentColor"
            stroke="none"
            fontFamily="monospace"
            fontSize="13"
            fontWeight="600"
          >
            {'"moisture" == "moisture" == "moisture" == "moisture"'}
          </text>
        </svg>
      </div>
      <figcaption className="mt-1.5 text-xs text-muted-foreground">
        Why the key is typed twice but must exist once: WordPress sends it, the
        IS validates it against the set it synced from Mk1, and Mk1 routes
        seeding, vial demand, and the COA section by it. Any drift breaks the
        chain silently at the weakest hop.
      </figcaption>
    </figure>
  )
}

const CHECKLIST: React.ReactNode[] = [
  <>
    Service keyword is final, UPPERCASE, and its unit is filled (or genuinely
    unitless).
  </>,
  <>
    Qualitative services: option label = option value = the spec’s equals
    string, exactly.
  </>,
  <>
    An active spec exists for every member service at the right tier; LOQ set if
    results should censor to “&lt; LOQ”.
  </>,
  <>
    Profile key is final, lowercase_underscored, and owns its own fulfillment
    role.
  </>,
  <>Vials required ≥ 1 on the profile.</>,
  <>Profile members are non-empty and in certificate print order.</>,
  <>Vial role: department and boxable verified after auto-mint.</>,
  <>
    COA section title, sort order, and chrome (basis/method/prep/footnotes)
    filled.
  </>,
  <>IS registry recognizes the key (scheduled sync or admin refresh).</>,
  <>Shadow product exists and is linked; row price matches product price.</>,
  <>
    Test Services row: Profile Key verbatim, Wire Key empty, Vials equals the
    profile’s vials required.
  </>,
  <>
    One dev-stack order proven: card → line item → check-in → roled vial →
    placeholders → result → verified → promoted → parent verified.
  </>,
  <>
    Archetype armed <em>last</em>; COA section and verify page render correctly.
  </>,
]

export function NewTestOnboardingGuide() {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <CircleHelp className="mr-1 h-4 w-4" />
          New Test Guide
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] w-[90vw] overflow-y-auto sm:max-w-[90vw]">
        <DialogHeader>
          <DialogTitle className="text-xl">
            Bringing a New Test Online
          </DialogTitle>
          <DialogDescription>
            Every step to take a new analysis from nothing to a paid, ordered,
            bench-fulfilled, certificate-printed test — across Accu-Mk1, the
            Integration Service, and the WordPress storefront. Work the phases
            in order: the sequence is load-bearing.
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 text-sm leading-relaxed [&_p]:my-2">
          <LifecycleDiagram />

          {/* ── The model ── */}
          <PhaseHeading
            title="The four concepts, one job each"
            chip="Read first"
          />
          <div className="my-3 grid gap-2 sm:grid-cols-2">
            {[
              [
                'Analysis Service',
                'One measured result: a keyword, a title, a unit, a result type. What the bench fills in and what prints as a row on the certificate.',
              ],
              [
                'Analysis Profile',
                'The unit of sale and of reporting. One product = one profile. It owns the member services, the vial demand, and the COA section.',
              ],
              [
                'Vial Role',
                'The physical vial the customer ships. Auto-minted from the profile’s fulfillment role. Drives inbox lane, assignment spot, and boxing.',
              ],
              [
                'Department',
                'The bench that does the work. Routes the inbox lane and the assignment-page section. Members carry their own department.',
              ],
            ].map(([t, d]) => (
              <div key={t} className="border p-3">
                <div className="text-sm font-semibold">{t}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{d}</div>
              </div>
            ))}
          </div>
          <Callout tone="rule" label="Rule — one string rules everything">
            <p>
              The <strong>profile key</strong> (e.g. <Code>heavy_metals</Code>,{' '}
              <Code>moisture</Code>) is typed in two places by hand: the Mk1
              Analysis Profile’s <Code>key</Code> and the WordPress Test
              Services row’s <strong>Profile Key</strong>. They must match{' '}
              <em>verbatim</em>. Everything between them — the order payload,
              the IS registry, placeholder seeding, vial demand, and the COA
              section lookup — matches on that exact string. Lowercase with
              underscores, and{' '}
              <strong>never change it after the first sale</strong>: stored
              orders are never rewritten.
            </p>
          </Callout>

          {/* ── Phase 1 ── */}
          <PhaseHeading
            num="1"
            title="Build the catalog in Accu-Mk1"
            chip="Accu-Mk1 · LIMS menu"
          />
          <p className="text-muted-foreground">
            Everything in this phase is admin-only and inert until an order
            carries the key — safe to build ahead of time.
          </p>

          <StepHeading
            id="1.1"
            title="Department — only if it’s a new bench"
            where="Where: LIMS → Departments"
          />
          <p>
            If the test runs on an existing bench (Analytical, Microbiology,
            Heavy Metals…), skip this. A new department gets its own inbox lane
            and its own section on the assignment page the moment it exists.
          </p>

          <StepHeading
            id="1.2"
            title="Analysis Service(s) — one per measured result"
            where="Where: LIMS → Analysis Services → New"
          />
          <FieldTable
            rows={[
              [
                'Keyword',
                <>
                  UPPERCASE, stable, e.g. <Code>MOISTURE-KF</Code>. The
                  cross-system join key — COABuilder and the spec engine index
                  results by it.{' '}
                  <strong>Immutable once any analysis references it.</strong>
                </>,
              ],
              [
                'Title',
                <>
                  The human name that prints as the row’s Test name on the
                  certificate, e.g. <em>Residual Moisture (Karl Fischer)</em>.
                </>,
              ],
              [
                'Unit',
                <>
                  The reporting unit, e.g. <Code>% w/w</Code>, <Code>µg/g</Code>
                  . Only leave blank if the result is genuinely unitless (pH). A
                  blank unit prints blank on the COA and is only logged as a
                  warning — it will not stop the certificate.
                </>,
              ],
              ['Department', 'The bench that performs it.'],
              [
                'Result type',
                'Numeric entry, or a select with result options for qualitative tests (see trap below).',
              ],
            ]}
          />
          <Callout tone="trap" label="Trap — qualitative result strings">
            <p>
              For a select-type service, the stored option <em>value</em> is the
              exact string the spec engine compares (case-insensitively) against
              the specification’s <em>equals</em> string. A mismatch does{' '}
              <strong>not</strong> fail safe — it prints{' '}
              <em>Does Not Conform</em> and flips the whole certificate to
              FAILED. Make the option{' '}
              <strong>label and value the identical reporting string</strong>{' '}
              (e.g. <Code>Not Detected</Code> / <Code>Not Detected</Code>), and
              use that same string in the spec’s equals rule. The reporting
              string is a lab ruling — write it down once and reuse it exactly.
            </p>
          </Callout>

          <StepHeading
            id="1.3"
            title="Specification — the pass/fail rule"
            where="Where: LIMS → Analysis Services → open the service → Specifications"
          />
          <FieldTable
            rows={[
              [
                'Rule kind',
                <>
                  <Code>range</Code> (min and/or max) for numeric results;{' '}
                  <Code>equals</Code> for qualitative.
                </>,
              ],
              [
                'Limits + unit',
                'The spec’s unit is the unit-coherence anchor — keep it identical to the service unit.',
              ],
              [
                'LOQ',
                <>
                  Optional, range rules only. When set, results below it print
                  as <Code>&lt; LOQ</Code> (display-time censoring — the verdict
                  is always computed on the raw number) and the section gains an
                  LOQ column.
                </>,
              ],
              [
                'Tier',
                'Wildcard (all matrices) covers most tests. File matrix-specific or peptide-specific rows only when limits genuinely differ; the resolver picks the most specific tier.',
              ],
            ]}
          />
          <Callout tone="rule" label="Rule — no spec, no certificate">
            <p>
              COA generation is fail-closed: a verified result whose service has{' '}
              <strong>
                no resolvable active spec aborts the entire certificate
              </strong>
              , naming the service and the tiers it consulted. File the spec
              before results exist, not after the abort. Specs have no edit flow
              — to change one, deactivate it and create a replacement.
            </p>
          </Callout>

          <StepHeading
            id="1.4"
            title="Analysis Profile — the sellable unit"
            where="Where: LIMS → Analysis Profiles → New (this page)"
          />
          <FieldTable
            rows={[
              [
                'Key',
                <>
                  The wire identity — lowercase, underscores, e.g.{' '}
                  <Code>moisture</Code>. Matched verbatim by WordPress and the
                  IS. <strong>Final after first sale.</strong>
                </>,
              ],
              ['Name', 'Lab-facing display name.'],
              [
                'Fulfillment',
                <>
                  Dimension <Code>role</Code> + a role code.{' '}
                  <strong>Give a new family its own role code</strong> (e.g.{' '}
                  <Code>hm</Code>, <Code>kf</Code>) — typing a new code here
                  auto-mints the Vial Role. Demand per role is MAX across
                  profiles, not SUM: two profiles sharing a role share one vial.
                  Own role = additive demand.
                </>,
              ],
              [
                'Vials required',
                <>
                  <strong>Set it to 1 or more.</strong> New rows default to 0,
                  and a profile with 0 vials silently plans nothing — the order
                  bills and no vial is ever requested.
                </>,
              ],
              [
                'Role department / boxable',
                'Department routes the minted role’s inbox lane; boxable controls whether its vials appear in the boxing flow.',
              ],
              [
                'Ride hosts',
                'Leave empty for a standalone test with its own vial. Only used when this profile should ride along inside another role’s vial. Endotoxin and sterility vials never host riders.',
              ],
              [
                'SLA tier',
                'Optional — set if turnaround differs from the group default.',
              ],
              [
                'COA section fields',
                'Section title, sort order, basis note, method text, prep text, footnotes — safe to fill in now. All display chrome is inert until the profile is armed (phase 5).',
              ],
            ]}
          />
          <Callout
            tone="note"
            label="Note — the COA archetype is deliberately absent at create"
          >
            <p>
              A new profile always starts <strong>unreported</strong>: its
              results cannot print on any certificate until you arm it by
              setting the COA archetype, and the create form refuses the field.
              That is phase 5, the very last step — arming is retroactive and
              fail-closed, so it waits until the whole pipeline is proven.
            </p>
          </Callout>

          <StepHeading
            id="1.5"
            title="Members — before anything is sold"
            where="Where: the profile’s Members editor"
          />
          <p>
            Add every service the profile includes, in the order the rows should
            print on the certificate.
          </p>
          <Callout tone="trap" label="Trap — an empty profile seeds nothing">
            <p>
              If an order arrives while the profile has zero members, the order
              signal seeds <strong>nothing, silently</strong> — no placeholder,
              no vial analysis, no error. Members must exist before the
              WordPress row goes live. (Manage Analyses refuses to add an empty
              profile to a sample, but the order path has no such guard.)
            </p>
          </Callout>

          <StepHeading
            id="1.6"
            title="Vial Role check — verify the auto-mint"
            where="Where: LIMS → Vial Roles"
          />
          <p>
            The role minted by step 1.4 gets its label from the profile name and
            department from the profile form. Confirm: department is right
            (inbox lane), boxable is what you want (unboxable vials are
            invisible to the boxing flow), and variance eligibility is off
            unless ruled otherwise.
          </p>

          {/* ── Phase 2 ── */}
          <PhaseHeading
            num="2"
            title="Let the Integration Service learn the key"
            chip="Integration Service"
          />
          <p>
            The IS validates every incoming order’s service keys against its
            catalog registry, which syncs from Mk1’s profile list at startup and
            on a schedule. Once phase 1 is saved, the new key becomes a
            recognized order key on the next sync —{' '}
            <strong>no IS deploy, no code change</strong>.
          </p>
          <ul className="my-2 list-disc space-y-1 pl-5">
            <li>
              To pick the key up immediately instead of waiting for the
              scheduled sync: <Code>POST /admin/refresh-catalog</Code> on the
              IS.
            </li>
            <li>
              Registry recognition means “this key is real”, not “this key is
              sellable” — inactive profiles are still recognized so historical
              orders keep validating.
            </li>
            <li>
              Native (Mk1-origin) keys are deliberately never mapped into
              SENAITE. The analyses live as Mk1 rows only; an order that is
              native-only is normal.
            </li>
          </ul>

          {/* ── Phase 3 ── */}
          <PhaseHeading
            num="3"
            title="Put it on sale in WordPress"
            chip="WP Admin"
          />

          <StepHeading
            id="3.1"
            title="The shadow product — WooCommerce product"
            where="Where: WP Admin → Products → Add New"
          />
          <p>
            Create a simple product for the test: name and price. This product
            is what the order’s add-on line item binds to — the line item takes{' '}
            <em>its</em> name and price, and rate agreements resolve against it.
            Keep it in <strong>draft</strong> while configuring; the Test
            Services page can link draft products, so nothing is
            customer-visible yet.
          </p>

          <StepHeading
            id="3.2"
            title="The Test Services row"
            where="Where: WP Admin → WooCommerce → Test Services → Add Service"
          />
          <FieldTable
            rows={[
              [
                'Service Name',
                <>
                  The wizard card label, e.g. <em>Residual Moisture</em>.
                </>,
              ],
              ['Price (USD)', 'Keep identical to the linked product’s price.'],
              ['Tooltip', 'Customer-facing one-liner on the card.'],
              [
                'Type',
                <>
                  Start as <strong>Addon — Coming Soon</strong>: fully
                  configured but not orderable. Flip to <strong>Addon</strong>{' '}
                  only at go-live (phase 5).
                </>,
              ],
              [
                'Profile Key',
                <>
                  <strong>The Mk1 profile key, verbatim</strong> (
                  <Code>moisture</Code>). The row’s wire identity: the wizard
                  card, the order payload, billing resolution, and the vials
                  lookup all key off it.
                </>,
              ],
              [
                'Vials',
                <>
                  How many vials the customer is told to ship. Display-only —
                  the lab plans its own demand from the Mk1 catalog — so keep it
                  equal to the profile’s <em>vials required</em> or the customer
                  ships the wrong count.
                </>,
              ],
              [
                'Wire Key',
                <>
                  <strong>Leave empty for catalog rows.</strong> It exists only
                  for the five legacy services; the admin page warns on any
                  value outside that canonical set.
                </>,
              ],
              [
                'Linked Product',
                <>
                  <strong>The shadow product from 3.1 — required.</strong> A
                  catalog row with no linked product cannot bill as its own line
                  item.
                </>,
              ],
              [
                'Coming Soon Label',
                'Optional card ribbon while the row is coming-soon.',
              ],
            ]}
          />
          <Callout
            tone="trap"
            label="Trap — keys and names are not interchangeable"
          >
            <p>
              The Profile Key is the identity; the Service Name is decoration.
              Never assume a name normalizes into the key (
              <em>Heavy Metals Panel</em> ≠ <Code>heavy_metals</Code> — that
              exact mismatch once made an add-on bill into the base price with
              zero vials). And never rename the five <strong>legacy</strong>{' '}
              rows (HPLC, Bac Water, Endotoxin, Sterility, Variance) — their
              identity still derives from the name.
            </p>
          </Callout>
          <Callout tone="trap" label="Trap — name collisions with legacy cards">
            <p>
              While a row is being configured, a Service Name containing
              “sterility” or “endotoxin” can be picked up by the legacy wizard
              cards’ name-matching and hijack their label and price. The{' '}
              <strong>Addon — Coming Soon</strong> type keeps the row out of
              every card, bundle, and wiring path until it’s ready — one more
              reason to configure in that state.
            </p>
          </Callout>

          {/* ── Phase 4 ── */}
          <PhaseHeading
            num="4"
            title="Prove it end-to-end before go-live"
            chip="Dev stack"
          />
          <p>
            Run one order through the whole pipe on a dev stack (flip the row to{' '}
            <em>Addon</em> there). <em>Accepted</em> from the IS means the order
            was received — not that every service will be fulfilled. Walk the
            chain:
          </p>
          <ol className="my-2 list-decimal space-y-1.5 pl-5">
            <li>
              <strong>Order it</strong> in the wizard: the card renders, the
              vial ship-count includes the new test, checkout shows its own line
              item at the right price.
            </li>
            <li>
              <strong>Before check-in, expect nothing.</strong> Seeding is
              check-in-triggered by design; a sample with no vials and no native
              analyses right after ordering is correct.
            </li>
            <li>
              <strong>Check the sample in.</strong> Now verify: a vial exists
              with the new role, the parent sample carries an <em>ordered</em>{' '}
              placeholder row per member service, and the vial carries the
              member analyses.
            </li>
            <li>
              <strong>Bench pass:</strong> the vial appears in the right
              department’s inbox lane and assignment section; enter a result,
              verify it, promote to parent.
            </li>
            <li>
              <strong>Parent pass:</strong> the promoted parent row lands as{' '}
              <em>parent to verify</em> — verify it. Only <em>verified</em>{' '}
              parent rows can print.
            </li>
          </ol>
          <Callout tone="expect" label="What good looks like">
            <p>
              One vial with the new role · parent placeholder per member ·
              result → verified → promoted → parent verified · and the COA still
              prints <em>without</em> the new section — because the profile
              isn’t armed yet. That’s the correct pre-arming state.
            </p>
          </Callout>

          {/* ── Phase 5 ── */}
          <PhaseHeading
            num="5"
            title="Arm the certificate — always last"
            chip="Accu-Mk1 → COA"
          />
          <p className="text-xs text-muted-foreground">
            Where: LIMS → Analysis Profiles → edit the profile → COA Section →
            archetype (edit-only; <Code>limit_table</Code> is the archetype for
            tabular result sections)
          </p>
          <p>
            Setting the archetype flips the profile from unreported to reported,{' '}
            <strong>retroactively and fail-closed</strong>:
          </p>
          <ul className="my-2 list-disc space-y-1.5 pl-5">
            <li>
              Every certificate generated from now on for an order that bought
              this profile <strong>must</strong> have a verified parent row for
              every member — otherwise generation aborts with an explicit error
              naming the profile and service. That’s protection, not breakage: a
              paid test never silently falls off a certificate.
            </li>
            <li>
              Until armed, the profile is silently skipped on every COA —
              results can exist, verify, and promote, and still not print. If a
              section is “missing”, check the archetype first.
            </li>
          </ul>
          <ol className="my-2 list-decimal space-y-1.5 pl-5">
            <li>
              Arm the archetype on the dev stack, regenerate the test order’s
              COA, and check the section: title, row order, unit, spec, verdict,
              and the verify page rendering.
            </li>
            <li>
              Repeat the configuration in production in the same phase order,
              arm, and finally flip the WordPress row’s Type from{' '}
              <em>Addon — Coming Soon</em> to <strong>Addon</strong>. The test
              is live.
            </li>
          </ol>

          <IdentityDiagram />

          {/* ── Checklist ── */}
          <PhaseHeading
            title="Pre-flight checklist"
            chip="Before flipping to Addon"
          />
          <ol className="my-3 space-y-0">
            {CHECKLIST.map((item, i) => (
              <li
                key={i}
                className="flex gap-3 border-b py-2 text-sm last:border-b-0"
              >
                <span className="min-w-7 pt-px font-mono text-xs text-primary">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ol>

          <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
            Sequence recap:{' '}
            <strong>
              Mk1 catalog → IS recognition → WP row (coming-soon) → end-to-end
              proof → arm the archetype → flip to Addon.
            </strong>{' '}
            Configuring WordPress first sells a test the lab can’t fulfill;
            arming the archetype early blocks certificates on unfinished
            results. Keys are permanent the moment the first order carries them.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default NewTestOnboardingGuide
