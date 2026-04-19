# Handoff — Peptide / Compound Request Feature

**Date:** 2026-04-17
**Status:** Brainstorming + planning complete. Implementation not yet started.

---

## What we're building

Customers on the WordPress site can submit a request for Accumark to add testing for a peptide or compound that isn't yet in the catalog. The request becomes an Accu-Mk1 entity (canonical record in Postgres), a ClickUp task the lab works in, and — on completion — a new SENAITE Analysis Service (peptide path) plus a one-time $250 WooCommerce coupon issued to the requesting customer.

## Repos & branches

All three repos have a `feat/peptide-request-v1` branch off `master`, with planning artifacts committed.

| Repo | Path | Branch |
|---|---|---|
| Accu-Mk1 | `Accumark-Workspace/Accu-Mk1/` | `feat/peptide-request-v1` |
| integration-service | `Accumark-Workspace/integration-service/` | `feat/peptide-request-v1` |
| accumarklabs (WP + wpstar theme) | `\\wsl.localhost\docker-desktop-data\data\docker\volumes\DevKinsta\public\accumarklabs\` | `feat/peptide-request-v1` |

## Artifacts (all committed on the feature branch in each repo)

**In Accu-Mk1:**
- `docs/superpowers/specs/2026-04-17-peptide-request-design.md` — full design spec
- `docs/superpowers/specs/2026-04-17-peptide-request-contracts.md` — **frozen** HTTP contracts between all three systems (shared source of truth)
- `docs/superpowers/plans/2026-04-17-peptide-request.md` — Accu-Mk1 implementation plan (22 tasks)

**In integration-service:**
- `docs/superpowers/plans/2026-04-17-peptide-request.md` — integration-service plan (10 tasks)

**In accumarklabs:**
- `wp-content/themes/wpstar/docs/superpowers/plans/2026-04-17-peptide-request.md` — wpstar plan (10 tasks)

## Pinned decisions (don't re-litigate)

- **Shipping strategy:** big-bang v1 — all three repos ship together.
- **Canonical record:** Accu-Mk1 Postgres. Not ClickUp, not integration-service.
- **ClickUp credentials:** in Accu-Mk1 backend (LIMS-operational integration). ClickUp webhooks land on Accu-Mk1's public endpoint.
- **integration-service role:** thin proxy between WP and Accu-Mk1. Owns HMAC/nonce/JWT validation and WP + SENAITE + WC adapters. No peptide-request business logic.
- **Status source of truth:** ClickUp columns (tech moves cards). Accu-Mk1 maps column names → entity status enum via config-driven rule map.
- **Status enum (9 values):** `new` → `approved` → `ordering_standard` → `sample_prep_created` → `in_process` → `completed`. Off-ramps: `on_hold` (reversible), `rejected` (terminal), `cancelled` (terminal).
- **Peptide path on completion:** auto-clone BPC-157 SENAITE Analysis Service, rename to `{Name} - Identity (HPLC)` — this naming is load-bearing for downstream systems.
- **Non-peptide path on completion:** skip SENAITE automation (manual lab work), still issue the coupon.
- **Coupon:** single-use, full-cart, $250, no expiry, issued via WooCommerce REST. Shown on the WP customer's request detail page.
- **Customer notifications:** email on Approved / Rejected / Completed only.
- **Rejection reason:** free text, no picklist.
- **Form placement:** new `/portal/new-peptide-request/` page + CTA link from existing peptide order wizard.
- **No attachments** (explicitly removed from scope).

## Open items (to decide in plan/implementation phase, not now)

- ClickUp task auto-assignee (default: unassigned, techs pull from "New" column)
- integration-service ↔ Accu-Mk1 auth: shared secret token
- Exact WP email template copy
- ClickUp list + columns: one-time manual setup outside code

## Current workflow position

- ✅ Brainstorming complete (`superpowers:brainstorming`)
- ✅ Design spec written + reviewed + approved
- ✅ Contracts written + approved + **frozen** (2026-04-17)
- ✅ Three implementation plans written (`superpowers:writing-plans`)
- ✅ Feature branches created in all three repos
- ✅ All artifacts committed on feature branches
- ⏭ **Next:** Dispatch Accu-Mk1 implementation plan via `superpowers:subagent-driven-development`

## Resume instructions (read this to pick up)

1. **Invoke the superpowers:subagent-driven-development skill.**
2. **Read the Accu-Mk1 plan** at `docs/superpowers/plans/2026-04-17-peptide-request.md`. Extract all 22 tasks.
3. **Dispatch Task 0 (Branch setup) first** as an implementer subagent. The branch already exists — the `git show-ref` conditional in Task 0 Step 2 handles both "exists" and "doesn't exist" cases.
4. **Per task, follow the skill's loop:** implementer → spec reviewer → code quality reviewer → mark complete in TodoWrite → next task.
5. **Do not parallelize implementers within the Accu-Mk1 plan** — serial execution prevents git conflicts.
6. **After Accu-Mk1 chain is well underway or finished,** the integration-service and wpstar plans can run in fresh Claude sessions (separate terminals). Each has its own repo, its own branch, and references the same frozen contract doc.

## Context notes

- **Architectural memories already in my global memory** (`~/.claude/projects/C--Users-forre-OneDrive-Documents-GitHub-Accumark-Workspace/memory/`) — auto-loaded in any new session. Covers: Accu-Mk1 as primary LIMS, integration-service's narrow scope, SENAITE naming, non-peptide support.
- **Accu-Mk1's AGENTS.md** mandates GitNexus use before editing symbols. Subagent tasks reference this.
- **Accu-Mk1's default branch is `master`, not `main`.** The plan has been corrected for this.
- **Visual companion** session data lives in `.superpowers/brainstorm/` — added to `.gitignore`, not committed.
