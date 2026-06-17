# Handoff: Variance COA — mean-based model shipped + PDF/digital polish

*Created 2026-06-16. Paste this into a fresh session to resume with full context.*

---

You're picking up the variance-COA work. The lab's decision is **fully implemented and running on local docker** (COABuilder `2.26.0` on `:5000`): variance lots certify on the **mean**, identity is **strict**, the page-1 results table + headline cards + digital verify panel all agree, and a **"Variance / N Vials" caption** sits to the right of the vial icon. Work is at a clean stop; remaining items are eyeball/position tuning, the customer-facing detail pages (user is designing those), a few lab confirmations, and the prod-deploy decision. Your job is to drive whatever the user asks next.

## Working directories

| Repo / dir | Path | Branch | Latest commit |
|---|---|---|---|
| **COABuilder** (active checkout) | `C:/tmp/coabuilder-variance` | `feat/coa-identity-na-variance` | `b66635c` (pushed; `logs/` dirty, ignore) |
| **Accu-Mk1** (FE+BE, design docs) | `C:/tmp/accu-mk1-wave1` | `subsample-features` | `7afa7e2` (pushed) |
| accumarklabs (WP verify page) | DevKinsta / `accumarklabs.local` | — | untouched this session (see gotchas) |
| integration-service | `…/Accumark-Workspace/integration-service` | — | untouched this session |

COABuilder remote: `github.com/ValenceAnalytical/coabuilder`. All COABuilder commits pushed.

## What's on the branch

**Layer 1 — Conformance model (the lab decision):**
- `dad6917` purity verdict worst-case → **mean-based** (`mean(identity-passing) ≥ spec`); identity already **strict** (any vial miss → whole COA fails, wrong-molecule purity/qty excluded from the mean); page-1 result cell shows `mean X · SD Y · %RSD Z% · n=N` (per-analyte + single-peptide).
- `b33d3d6` same for **blend** total + blend purity rows (per-vial sum / mass-weighted; a vial counts only if all components present + identity-passing).
- `29ce4f3` verdict on the **EXACT unrounded mean** ("don't round before or after the mean"); 2-dp display is cosmetic only. `deed665` boundary test.
- Helpers in `conformance.py`: `_variance_stats`, `_stat_line`, `_blend_variance_points`, plus `canonical.variance_vial_count`.

**Layer 2 — Reconciliation (badge/panel/headline all agree):**
- `965517e` digital COA / verify panel: dropped the parent `digital` override so the verify page renders the final mean/strict verdict (was the single parent figure → P-0149-style contradiction, now both-directions). Identity's parent snapshot moved to internal `_parent_id`; the blend-identity composite now reads each row's strict `conforms` (was parent-only → would stay CONFORMS when a vial component failed).
- `7d3d0c9` (2.24.0) page-1 **headline cards** ("Total Quantity"/"Total Purity") now show the certified **mean** for variance (single = analyte mean; blend = blend mean) — they were the parent figure, contradicting the table on the same cert.

**Layer 3 — "Variance / N Vials" caption (this session's polish, several iterations):**
- `5241c9e`→`b66635c` (2.23.0–2.26.0): caption near the vial icon. N = parent + distinct replicate vials. Big detour: the **caption was first wired into dead files** (`pdf_layout.json` + `platypus_generator.py`) — see gotcha. Real fix added a `VARIANCE_LABEL` **frame** to `Templates/Single & Blend Unified Page 1/layout.json`. Final form: two explicit fields (`variance_word`="Variance" / `variance_count`="N Vials") for a deterministic two-line stack, positioned to the **right** of the (background-baked) vial icon at `x=532`.

## Critical operational gotchas

| Gotcha | Why it matters | How to handle |
|---|---|---|
| **The active PDF generator is `FrameBasedPDFGenerator` (`src/coabuilder_core/generator.py`)** — it reads `Templates/<template>/layout.json` **frames** and resolves fields via `getattr(data, field_name)` (snake_case). | `pdf_layout.json` and `platypus_generator.py` at the repo root are **DEAD/legacy** — editing them renders nothing. This burned a full debug cycle. | Add/position PDF fields as **frames** in `Templates/Single & Blend Unified Page 1/layout.json`. New visual element = new frame; a new data field just needs a snake_case `CoAData` attr (auto-resolved). |
| **`:5000` is a BAKED image, no bind mount.** | Every code OR layout change is invisible until you rebuild + recreate. `:5528` (`accumark-subvial-coabuilder`) bind-mounts but wave1 doesn't call it. | `cd /c/tmp/coabuilder-variance && docker build -t coabuilder-coabuilder:latest .` then `docker compose -f "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/coabuilder/docker-compose.yml" -p coabuilder up -d --no-build --force-recreate coabuilder`. Verify `curl -s http://localhost:5000/version`. |
| **`coa_data` is frozen per generation.** | Rebuilding `:5000` does NOT update existing COAs. A verify code (e.g. old `RCHM-W2S2`) is a snapshot of its generation. | To see ANY change you must **regenerate** the COA (Mk1 app → `:5000`). Newest P-0149 code wins; check `coa_generations` by `created_at`. |
| **The vial icon is background art** (baked into `Single & Blend Unified Page 1 Background.pdf`), not a layout image. | "Move the icon" requests can't be done via layout/config. | Only the caption frame is movable. Moving the icon = editing the background PDF in a design tool (user's side). |
| **`get_field_value` returns `""` for falsy values → frame's lines get filtered → frame not drawn.** | This is *why* the caption is correctly blank on non-variance COAs (variance_word/count are ""). Don't "fix" it. | Rely on it for conditional fields. |
| **`git add -A` stages `logs/coabuilder.log`.** | One commit this session picked it up; it's noise. | Stage explicit paths; keep `logs/` out. |
| **Two pre-existing test issues (NOT regressions):** `scripts/test_json_load.py` `sys.exit(1)`s at import; `tests/test_generic_page2_layout.py::...test_ph_not_duplicated_on_page2` ModuleNotFoundError in host env. | A bare `pytest` looks broken. | Run `pytest tests/` and `--deselect` the page2 test (see verification). |
| `·` (U+00B7) renders fine in the Inter font on the PDF. | Earlier worry about glyph tofu — confirmed OK. | No separator swap needed. |

## Infrastructure state

- **`coabuilder_service`** — `:5000`, running **2.26.0** (rebuilt this session from `C:/tmp/coabuilder-variance`). This is what the wave1 Mk1 backend calls (`COA_BUILDER_URL=http://host.docker.internal:5000`). Baked image `coabuilder-coabuilder:latest`. Rebuild = the two-command sequence in the gotchas table.
- **`accu-mk1-frontend`** `:3101` (Vite) / `:3100`; **`accu-mk1-backend`** `:8012` — wave1 Mk1 app, where COAs are generated. (No `--reload` on backend; restart after BE edits.)
- **`accumark_postgres`** — DBs `accumark_mk1` and `accumark_integration` (the latter holds `coa_generations.coa_data` JSONB + `verification_code`). Queried via `docker exec accumark_postgres psql -U postgres -d accumark_integration …` (worked this session).
- Redundant `accumark-subvial-*` / `accumark-host-*` stacks are up — ignore; wave1 + `:5000` is the live path.
- `accumarklabs.local` (DevKinsta WP) renders the AccuVerify page from `coa_data`. **Not verified this session** that its renderer reads per-row `conforms` faithfully (see outstanding).

## Verification commands (re-run, don't trust stale numbers)

| Layer | Run command |
|---|---|
| Branch / version | `git -C /c/tmp/coabuilder-variance log --oneline -3` (expect `b66635c`) · `curl -s http://localhost:5000/version` (expect `2.26.0`) |
| COABuilder tests | `cd /c/tmp/coabuilder-variance && python -m pytest tests/ -q --deselect "tests/test_generic_page2_layout.py::TestRenderedPdfHasNoPhLeak::test_ph_not_duplicated_on_page2"` (host python; ~67 passed, 1 deselected) |
| Variance test files | `python -m pytest tests/test_variance_stats_render.py tests/test_variance_blend_render.py tests/test_digital_coa_reconcile.py tests/test_variance_series_render.py tests/test_variance_report.py -q` |
| Latest P-0149 generations | `docker exec accumark_postgres psql -U postgres -d accumark_integration -tA -c "SELECT generation_number, verification_code, created_at, coa_data->>'overall_status', (coa_data->'results')::text LIKE '%mean %' FROM coa_generations WHERE sample_id='P-0149' ORDER BY created_at DESC LIMIT 5;"` |
| Inspect a generation's results | `docker exec accumark_postgres psql -U postgres -d accumark_integration -tA -c "SELECT jsonb_pretty(coa_data->'results') FROM coa_generations WHERE verification_code='<CODE>';"` |

## Outstanding items the user may want next

1. **Eyeball the caption position** — regenerate a variance COA and check `Variance / N Vials` clears the vial icon at `x=532`. Nudge via the `VARIANCE_LABEL` frame in the config manager (`frame_layout_editor`), or ask me to set `x` + rebuild. Box right edge ~575; "Variance" ~34pt wide.
2. **Variance detail pages** (customer-facing) — USER is designing these in Claude Design (`accumark-labs-design-system`). Per-vial data is already in `coa_data['variance_report']`. Not started in code.
3. **Confirm with the lab: blend-total parent point = Σ components, not `PEPT-Total`** — the displayed blend-total mean may differ slightly from the `PEPT-Total` headline. Confirm acceptable when a real blend sample lands.
4. **Real blend variance sample** — the blend path is only synthetic-fixture tested (`test_variance_blend_render.py`). Need a real `PB-####`-style variance sample to validate the Mk1→COABuilder data shape.
5. **WP verify-page check** — confirm `accumarklabs.local` AccuVerify renders `coa_data.results` per-row `conforms`/`status` + the "Peptide Blend" pseudo-analyte. The COABuilder source is reconciled; this is the one link not visible from COABuilder. Post-deploy / quick manual check.
6. **PROD DEPLOY decision** — the branch was held from prod for the badge/panel contradiction, which is now **resolved**. Before lifting the hold: items 3–5 + a regen eyeball. Then deploy via the `accumark-deploy` skill (carries JWT_SECRET consistency + WP "Variance" data setup from older handoffs). Branch is `feat/coa-identity-na-variance`.
7. **Design doc / spec** lives at `accu-mk1-wave1/docs/superpowers/specs/2026-06-15-variance-coa-mean-model-design.md` — update if the model evolves.

## User collaboration preferences

- **Exact mean, no rounding before/after** for the verdict; 2-dp display is cosmetic. Mean-based purity/quantity; identity strict (any vial identity miss → whole COA fails, no exclude-to-salvage).
- **TDD on conformance logic** (the user's explicit preference); a failing test defaults to "test is stale," not "code is wrong" — update stale assertions to the new model.
- **Per-logical-unit commits with detailed bodies; push after committing** for backup. Trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Layout positioning is the user's `frame_layout_editor` config manager's job** — provide the data binding (snake_case `CoAData` attr) + a sensible default frame; they fine-tune.
- **Defers compliance/domain semantics to the lab** (Levi Fried / Josh Cosgrove / Dennis Nguyen via Slack) — arm them with options + worked examples, don't force a decision.
- Confirm before prod / irreversible; local branch commits + `:5000` rebuilds are fine to do directly. Never run GitNexus `--embeddings` (the stale-index advisory on every Bash is benign).

## Recommended first action in the new session

Confirm state, then ask: `git -C /c/tmp/coabuilder-variance log --oneline -3` (expect `b66635c`) and `curl -s http://localhost:5000/version` (expect `2.26.0`). Then ask the user whether they've regenerated + eyeballed the caption position (item 1) and which outstanding item to tackle — most likely the caption nudge, the detail pages, or the prod-deploy go/no-go. Do NOT deploy to prod without the item 3–5 confirmations.
