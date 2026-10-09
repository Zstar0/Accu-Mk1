# AI review as documents - design

Date: 2026-10-09. Status: approved in conversation (Handler: "yes go ahead, native"), extends `2026-10-08-customer-ai-review-design.md` (shipped in Mk1 1.40.0).

## 1. Intent

The 1.40.0 review card is hard to read: long undifferentiated paragraphs and inline citation chips. Each AI review becomes a styled document in the Mk1 Documents library, shown inside its own "AI review" tab on the customer page, so the team reads it like a report, discusses it with comments and annotations, and keeps every review as a revision.

### Rulings (Handler, 2026-10-09)

- Publish reviews into the Documents system, in a new space.
- The space is readable by everyone for now (company visibility).
- The AI review moves from a card above the tabs into its own tab after Support, and the tab renders the document.
- Built natively, same process as 1.40.0.
- (Carried from 2026-10-08) no staff names; on demand only; admin-only generation.

### Out of scope

Changing the agent, its tools, limits or citation checks; restricting the space; scheduled reviews; editing reviews from the card.

## 2. Findings that shape the design

- `documents.service.create_document(db, *, title, html, category, description, code, author, source_session, space, ...)` creates revision 1 of a new code or the next revision of an existing one; identical bytes are a no-op; the server inlines the `accumark-docs` theme. `create_space(db, slug, name, description, visibility="company")` and `create_category(db, name, code_prefix)` exist; General is seeded at boot by `seed_spaces`.
- The repo skill `.claude/skills/mk1-publish-document` publishes over HTTP with the internal service token; the backend can call the service in-process instead (no token needed).
- `DocumentViewer({ id })` renders a revision in a sandboxed `srcdoc` frame (`sandbox="allow-scripts"`, no same-origin). Its chrome uses the global UI store: a back button (`clearDocumentViewer`) and revision switching (`navigateToDocument`).
- Links clicked inside a document are relayed by the bridge and opened only if `http(s)`, in a new tab (`openDocumentLink`). Mk1 hash routes exist for deep links: `#dashboard/sample-details?id=P-0091`, `#accumark-tools/order-explorer?id=<order>`, `#accumark-tools/customer-detail?id=<n>`.
- The 1.40.0 review leaked a staff name ("Scott's Sep 17 reply"): the prompt-only rule did not hold. The dossier's `identity.rep` and ticket/CRM authors carry staff names into the model's context.
- `customer_ai_reviews` already exists in prod; new columns need `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `database._run_migrations`.

## 3. Design

### 3.1 Review shape (submit_review)

```json
{
  "headline": "<1-2 sentences, max 300 chars>",
  "sentiment": {"score": -2..2, "trend": "improving|steady|declining", "reason": "...", "citations": [...]},
  "open_issues": [{"title": "<max 80>", "detail": "<max 400>", "severity": "high|medium|low", "citations": [...]}],
  "shortfalls":  [{"title": "...", "detail": "...", "severity": "...", "theme": "turnaround|coa_quality|communication|billing|other", "citations": [...]}],
  "strengths":   [{"title": "...", "detail": "...", "citations": [...]}],
  "next_steps":  [{"title": "...", "detail": "...", "citations": [...]}]
}
```

Validation keeps the existing citation rules (ledger-only, dropped and counted, max 8 items). Missing `severity` defaults to `medium`, missing `theme` to `other`; `title` is required (an item without one is invalid). Text is trimmed to the limits.

### 3.2 No-names scrub (enforced, not only prompted)

After validation and before publishing, every headline, reason, title and detail is scrubbed: whole-word, case-sensitive matches of staff names become "the team". Staff names = Mk1 `users` first and last names (3+ chars) and full names, the dossier `identity.rep`, Plain entry authors with `author_kind == "agent"`, and Close `who` on outbound items, collected by the tools during the run. Full names are replaced before single names. The count is stored as `names_scrubbed`. A customer who shares a staff first name may also be replaced (accepted: errs toward privacy). The prompt rule stays.

### 3.3 The document

- Space `customer-reviews` ("Customer reviews", visibility `company`), category "Customer review" prefix `CR`; both created on first publish if missing (idempotent).
- One code per customer. The first successful run creates `CR-NNNN`; later runs pass that code, creating the next revision. The code and the document id are stored on the run row.
- Title "Customer review: <customer name>"; author = the admin who clicked Generate (their display name, else email); description "AI review · <model> · <N> lookups · $<cost>"; `source_session` = `ai-review-run-<id>`.
- HTML is rendered by the backend from the validated review; every model string is escaped with `html.escape`. Layout: header (customer, sentiment chip, generated date), serif headline, metric cards (lifetime spend and rank, spend change, on-time rate vs lab, days since last order vs usual gap: all from the dossier, never from the model), "Needs attention" cards sorted by severity, "Where we fell short" grouped by theme, next steps as a checklist, "Going well", a sources footer. Citations render as links: tickets to their Plain URL, CRM items to the lead URL when known, samples to `<MK1_PUBLIC_URL>/#dashboard/sample-details?id=<id>`, orders to `#accumark-tools/order-explorer?id=<order_id>`. `MK1_PUBLIC_URL` defaults to `https://accumk1.valenceanalytical.com`.
- Publishing happens in the runner after a `done` run. A publish failure keeps the run `done` and records `document_error`; the tab still shows the summary.

### 3.4 Storage changes

`customer_ai_reviews` gains `document_id` (int), `document_code` (varchar 32), `names_scrubbed` (int, default 0), `document_error` (text). Model columns plus four idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` strings in `_run_migrations`. `to_dict` and the `Run` response model declare them.

### 3.5 UI

- Customer page: a new admin-only tab "AI review" after Support (value `ai-review`, added to the `customerDetailTab` union; non-admins fall back to `orders`). The card above the tabs is removed. The guest view moves its AI review block after Support.
- Tab content: a summary bar (sentiment chip, headline, counts, generated date and age, Generate/Regenerate with the live progress list, cost and lookups) and, below it, the latest review document rendered with `DocumentViewer` in an embedded mode. Runs without a document (1.40.0 runs, or a publish failure) show "No review document yet: Regenerate to create one" with any `document_error`.
- `DocumentViewer` gains optional props `embedded?: boolean` (hides the back-to-library button) and `onNavigate?: (id) => void` (used for revision switching and post-edit navigation; defaults to the global `navigateToDocument`). The Documents page is unchanged.
- An "Open in Documents" link opens `#reports/documents?id=<id>`.

## 4. Testing

- Validation of the new shape (defaults, required title, trims), and that 1.40.0-shaped submissions fail cleanly.
- Scrub: full name before first name, possessives, word boundaries, count.
- Renderer: every section present; model text with `<script>` and quotes is escaped; metric cards from dossier values; citation links per kind.
- Publish: first run creates `CR-` in the `customer-reviews` company space; second run creates revision 2 of the same code; publish failure records `document_error` and keeps `done`.
- Migrations: the ALTER strings are present.
- Frontend: tab admin-only; summary states (empty, running, done with document, done without document); `DocumentViewer` embedded hides the back button and uses `onNavigate`.
- Live: a run on Triumphant Labs (wc:1572) read by the Handler in the tab.
- Gates: backend failure set equal to master's; tsc; eslint; fresh whole-branch review.

## 5. Rollout

Merge, release, full deploy after hours (columns added at startup; space and category created on first publish). Prod smoke: one run on wc:1572, open the tab. Rollback: redeploy 1.40.0 (extra columns are ignored).
