# Review instructions

## What Important means here
Reserve Important for findings that would change a result a customer sees, a lab decision, or
production data: a wrong PASS/FAIL or spec judgement, a unit mismatch (EU/mL vs EU/vial, IU vs mg),
a status transition on the wrong tier (parent vs vial), a query that loops per vial or sub-sample,
a FastAPI route whose `response_model` drops a key the frontend reads, a startup migration that is
not safe to re-run, a SENAITE write, or a secret in code or logs. A change that alters behaviour for
existing callers of a shared path is Important unless the PR body records the Handler's sign-off.
Style, naming and refactoring suggestions are Nit at most.

## Cap the nits
Report at most five Nits per review.

## Do not report
- Anything `npm run check:all` enforces: typecheck, eslint, ast-grep, prettier, clippy
- `locales/*.json`, `package-lock.json`, any `*.lock`
- `docs/superpowers/**`, `.planning/**`, `test-data/**`, `backend/conformance_vendored/**`
- `src/lib/tauri-bindings.ts` (tauri-specta bindings)
- Desktop (`src-tauri/`) behaviour: the desktop build is not in use
- Test failures the PR's Verified block names as unchanged from base

## Always check
- New or changed API routes declare on the Pydantic response model every key the frontend reads
- LIMS-side tables use the `lims_` prefix; bare `samples` belongs to HPLC job samples
- Anything that iterates vials or sub-samples issues a bounded query, not one per row
- Schema changes are `ADD COLUMN IF NOT EXISTS` entries in `backend/database.py`, additive and safe to re-run
- The PR body has a Verified block naming a stack, a pasted test count and a screenshot, or ticks
  "No user-visible change"
- Behaviour claims cite `file:line` in the source, not an inference from a name

## Summary
Start with the count of Important findings and say plainly when there is nothing to fix.
