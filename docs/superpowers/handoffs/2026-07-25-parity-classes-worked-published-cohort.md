# Handoff: Read-flip parity — fresh cohort GREEN, published cohort 254 → 29

*Created 2026-07-25. Paste this into a fresh session to resume with full context.*

---

You're picking up the SENAITE phase-out **section-2 read-flip**. Status: **two prod deploys shipped and verified (Mk1 1.6.1, 1.6.2), three prod data repairs applied, fresh cohort GREEN, published cohort down to 29 real diffs — the flip is still BLOCKED and there is NO partial-flip path.** Your job is to drive whatever the user asks next.

## Working directories

| Repo / dir | Path | Branch | Latest commit |
|---|---|---|---|
| Active worktree | `C:\tmp\Accu-Mk1-shadow-reg` | `fix/contact-fullname-collapse` | `f541e52` (3 commits ahead of master, **unpushed**) |
| Main checkout = deploy source | `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1` | detached @ `9ba3e79` | `9ba3e79` (= origin/master) |
| Prior worktree (read-flip, merged) | `C:\tmp\Accu-Mk1-parent-readflip` | `feat/parent-ar-read-flip` | merged as PR #80 |
| Backend venv (ALL pytest runs) | `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe` | — | worktrees have **no** venv/node_modules |
| Prod droplet | `ssh root@165.227.241.81` (`/root/accu-mk1`) | — | Mk1 **1.6.2** |

Earlier docs: `C:\tmp\Accu-Mk1-parent-readflip\docs\superpowers\handoffs\2026-07-25-parity-diff-class-triage.md` (the original triage) and `C:\tmp\Accu-Mk1-shadow-reg\docs\superpowers\handoffs\2026-07-25-shadow-analyses-at-registration.md`.

## What's on the branch

**Layer 1 — shadow-at-registration (shipped as 1.6.1, merged PR #81).** The parent-analysis mirror hooks are event-driven, so a freshly REGISTERED sample had zero shadow rows and `build_native_details` returned an EMPTY analyses list. Hooked the IS creation signal (`POST /s2s/lims-samples`) — the only true creation-time hook — via `BackgroundTasks`, calling new pure-DB `parent_mirror.sync_parent_shadows_from_items`. Also healed the backlog with the pre-existing `backfill_parent_analysis_shadows` (555 created / 8632 updated / 0 errors).

**Layer 2 — basic-info backfill + the regression it caused.** Ran `backfill_lims_sample_basic_info` (1823 updated / 0 errors): `sample_type_title` 296 → 0 NULL, `date_received` drift cleared. **It also degraded 1738 rows** — `_populate_basic_info` reads SENAITE's `ContactFullName`, which is doubled (`"X X"`), clobbering mk1's clean value on a user-visible field. Repaired in prod (collapsed 1738, 0 remaining), then fixed in code and shipped as **1.6.2** (`_collapse_self_doubled` + parity rule `contact_fullname_senaite_doubling`).

**Layer 3 — published-cohort parity classes (committed, NOT deployed — harness-only, zero runtime impact).**
- `36afa70`: `attachment_type_native_only` (14, senaite-blank gated) + `mi_senaite_placeholder` (71, placeholder ALLOWLIST `{'Manual'}` only).
- `f541e52`: `canonical_verified_vs_senaite_published` (68, gated on the mk1 sample already being published).
- All three fired at **exactly** their predicted counts against live prod — no over-matching.
- **#7 fixed in prod data**: `analysis_services` id 76 (`PEPT-Total`) seed `mg/mL` → `mg` **plus** 587 canonical `lims_analyses.result_unit` rows. Seed fix was essential — rows minted hours earlier still carried `mg/mL`.

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| **A data fix without its write-source fix DECAYS** | Hit 3× today (contact, PEPT-Total, ANALYTE-text). Rows get repaired, a live path keeps writing the wrong value, and it looks like success | Before any backfill: find what writes the value and check `created_at` on the newest wrong rows |
| **Backfill checkpoint + log live INSIDE the container** | `ssh host 'cat /tmp/x.json'` reads the HOST path and finds nothing → looks dead | `docker exec accu-mk1-backend cat /tmp/ckpt.json`. Also: `ps` is NOT installed in that container, and buffered stdout means an empty log proves nothing. **Advancing checkpoint = the real health signal** |
| **`nohup … &` over ssh dies with the session** | Long backfills silently stop | Use `docker exec -d` |
| **`created: 0` in backfill stats is AMBIGUOUS** | Can mean "already done by an earlier pass", not "nothing needed". Caused a mis-diagnosis + accidental concurrent double-run today | Verify against real rows, not the stats line |
| **`_populate_basic_info` clobbers mk1-better fields** | It rewrites the FULL field set from SENAITE. `contact_title` is the known casualty (now guarded in 1.6.2) | Before re-running the basic-info backfill, check whether any OTHER field is mk1-authoritative |
| **The flip has NO per-cohort path** | "fresh" and "published" are sample POPULATIONS, not pages. `sample_details` serves both | Only `sample_details` remains (`samples_list` + `worksheets_inbox` went mk1 in v1.1.x). Published's 29 is the sole blocker |
| **Measure a parity class's SHAPE before ruling it** | The triage said "rule all 93 M/I diffs". Measuring split them 71 placeholder / 17 real competing method / 5 real conflicting instruments — a blanket rule would have buried 22 real findings | Group by the SENAITE-side value first |
| **Worktrees have no `.venv` / `node_modules`** | `npx tsc` and pytest fail there | Run pytest with the main checkout's venv (path above). `test_httpx_shared_ssl` FAILS in the main checkout only (it scans `.venv` msal BOM files) — not a regression |
| **`scripts/*.sh` are CRLF in the repo** | bash chokes on deploy.sh | `sed -i 's/\r$//' scripts/*.sh` before deploy; `git checkout -- scripts/*.sh` after |
| **Deploy from the MAIN checkout, not a worktree** | Worktree has no `backend/.env` → preflight fails | `git checkout <merged-sha>` in the main checkout, deploy there |
| **502 during a deploy is the restart window** | Looks identical to a failed deploy from outside | Check `docker ps` on the droplet — containers "Up N seconds" on the new tag = normal |
| **3 `test_clickup_task_retry` failures are flaky** | Appear intermittently in full-suite runs | Verified: pass standalone on branch AND master. Not a regression |

## Infrastructure state

- **Prod droplet `165.227.241.81`**: `accu-mk1-frontend` + `accu-mk1-backend` **1.6.2** (Up ~14h), `integration-service` 1.0.10 (healthy), `coabuilder_service` 2.28.3, `senaite` (reports **unhealthy** — long-standing, not investigated today), `redis`.
- **Read source (prod `settings.registry_read_source`)**: `{"sample_details":"senaite","samples_list":"mk1","worksheets_inbox":"mk1"}` — **`sample_details` is the only page left to flip.**
- **Nightly reconcile rider**: `MK1_PARENT_MIRROR_RECONCILE_ENABLED` **unset (off)** — Handler decision 2026-07-25, stays off through the soak week.
- **The IS→Mk1 dual-write creation signal is LIVE** (prod IS has `app/adapters/accumk1.py`, `ACCUMK1_*` env set, 306+ minted `native_id`s). Older memory calling it "dormant" was stale.
- The running container's `/app/scripts/parity_sample_details.py` was hand-copied ahead of the image to test the new rules; it self-heals on the next deploy. Diagnostic-only, zero runtime impact.

## Verification commands (re-run, don't trust stale numbers)

| Layer | Run command |
|---|---|
| Prod version | `curl -s https://accumk1.valenceanalytical.com/api/health` |
| Parity — fresh (was GREEN, 0/30) | `ssh root@165.227.241.81 "docker exec -w /app -e PYTHONPATH=/app accu-mk1-backend python -m scripts.parity_sample_details --in-process --limit 30 --strict --out /tmp/p.json"` |
| Parity — published (29 real) | same but `--samples P-1525,P-1523,P-1522,P-1521,P-1517,PB-0279,P-1507,P-1495,P-1489,P-1487,P-1486,P-1478,PB-0276,PB-0275,PB-0274` |
| Read parity JSON | in-container python → `real_diff_sample_count`, `field_classification_counts`, `known_expected_rule_counts`. **Trust the JSON, not the shell exit code through ssh/docker** |
| Backend suite | `cd C:\tmp\Accu-Mk1-shadow-reg\backend && <main-checkout venv python> -m pytest tests/ -q --tb=no -p no:warnings` → diff FAILED names vs master run in the SAME venv (63-name set; the v1.4.0 60-name baseline is STALE) |
| Parity unit tests | same venv, `-m pytest tests/test_parity_sample_details.py -q` (46 tests) |

## Outstanding items the user may want next

1. **#9 `ANALYTE-*` unit `'text'` (4 parity diffs, 60 rows) — DIAGNOSED, needs the code fix FIRST.** Seed is correct (`%`/`mg`), SENAITE is correct, but `'text'` rows are STILL being written (newest 2026-07-24 07:01, after 1.5.6). 1.5.6 fixed DISPLAY (`_parent_quantity_unit`), not the WRITE path. **Hypothesis (unverified):** on a keyword-translated promote (`ID_X` → `ANALYTE-N-PUR/QTY`) the unit rides from the SOURCE identity row (whose service unit genuinely is `'text'`) instead of the TARGET service. Confirm in `promote_to_parent` + the keyword-translation path, fix, *then* rewrite the 60 rows.
2. **#8 `ENDO-LAL` `EU/mg` vs `EU/mL` (2) — LAB CALL.** EU/mg is legitimate for a SOLID, EU/mL for a solution. Depends on sample form. (An earlier claim in this session that it was a "flat data error" was overconfident and is retracted.)
3. **The 22 M/I conflicts — Handler ACCEPTED 2026-07-25, will fix later.** 17 method (mk1 purity method vs SENAITE `MET-HPLC-ID-1290A`) + 5 instrument (`HPLC 1290b` vs `HPLC 1290a`). Real traceability/ISO-17025 question: which method+instrument actually ran a published sample.
4. **Push + PR the branch.** 3 commits unpushed on `fix/contact-fullname-collapse`. Harness-only, no deploy urgency, can ride the next release.
5. **`download_url` (1) — explained, benign.** SENAITE legitimately holds multiple same-filename attachments (vial-photo retakes are frozen snapshots by design), and the harness pairs on `(filename, content_type)` first-come/first-served. Optional harness improvement: prefer a `senaite_attachment_uid` match before filename.
6. **Cover the non-signal create path** (rows minted by a backfill, e.g. P-1558 — already healed manually). Rider would cover it; blast radius was 1/1822, so probably not worth code.
7. Enable the reconcile rider **after** the soak week.

## User collaboration preferences

- **Additive-only**: production-behavior changes need explicit sign-off; dry-run/inspect first. Held all session.
- **Honest status over optimistic framing.** Surface regressions and retractions plainly — the user responded well to "I caused this" and to corrections of my own earlier claims. Do NOT report a metric improvement without checking *why* it improved (contact "cleared" today only because mk1 data had been degraded).
- **Verify in the running container, not by version string** — user explicitly asked for this on the 1.6.2 deploy.
- Conversational clarification over MCQ; **full absolute paths** in every reference.
- Deploys: merge-first (PR → master → deploy FROM the merged commit in the main checkout). Section deploys get MINOR bumps; fixes get PATCH.
- Backfills: off-hours, throttled (`--sleep 0.5` floor), serial.
- User tracks context % and will say when there's room to continue.

## Recommended first action in the new session

Confirm state, then go straight at item 1 — read `promote_to_parent` and the keyword-translation path in `C:\tmp\Accu-Mk1-shadow-reg\backend\lims_analyses\service.py` to find where `result_unit` is taken on a translated promote. Start with:

```bash
curl -s https://accumk1.valenceanalytical.com/api/health
cd /c/tmp/Accu-Mk1-shadow-reg && git log --oneline -4 && git status --short
```

Do NOT rewrite the 60 `'text'` rows before the write path is fixed — that mistake has already been made three times this session.
