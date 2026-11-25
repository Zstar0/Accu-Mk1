# COA Text Variants per Sample Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The lab can give an analysis profile its own certificate text for one sample form, so a nasal spray heavy metals COA prints the nasal prep text and no powder basis note or footnotes, without touching the default.

**Architecture:** A new table `analysis_profile_coa_variants` with three routes that mirror the spec routes. `build_native_sections` loads the active variant for the sample's form and resolves each section field through it, with a guard on the two fields that describe the limits. The profile editor gets its own section, built on a pure logic module so every rule is unit tested without rendering.

**Tech Stack:** FastAPI, SQLAlchemy 2, Postgres (SQLite in unit tests), React, TanStack Query, Radix ToggleGroup and Select, Vitest, pytest.

**Spec:** `docs/superpowers/specs/2026-10-30-coa-text-variants-design.md`. The approved layout is `docs/superpowers/specs/2026-10-30-coa-text-variants-mockup.html`; where they differ, the spec wins. Read the spec's "Profile editor" section before Tasks 5 to 9.

## Global Constraints

- Additive only. Profile columns are untouched. No COA Builder, Integration Service or WordPress change. The wire document gets no new key.
- A profile with no variants, or a sample with no form, must build sections byte for byte as today.
- The variant is picked by the same `sample_form_id` the spec tier uses, including the guard that drops it for a non-Peptide matrix.
- On screen the word is "version". "Variant" is only for code and schema.
- No em dashes in any copy, comment, doc or commit message.
- Mk1 frontend is npm only.
- Backend tests run in the `coavar` stack container against a scratch DB, one suite at a time, never against the host dev Postgres. Bare `python` on the laptop hangs.
- Gate on failure-set diff against the base commit, never on zero failures (the suite has known baseline failures).
- Git in this repo: `git -c core.autocrlf=true add|diff|commit`, and `git commit -- <paths>`. Never pass that flag to merge or checkout. Run `sed -i 's/\r$//'` on each new file before `add`, because the Write tool produces CRLF here.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never push, merge or deploy without the Handler's word. Deploys go after lab hours.
- Never print secrets. Do not grep a stack `.env`.
- Line numbers below are from `origin/master` at 1.56.1. `backend/main.py` sits 15 lines later than the spec's citations.

## Review Focus

Things the spec implies but does not list as tests. Each has a test in the task named.

1. **A save that fails (macro typo 400, 409 from a colleague, network).** The card stays open with its edits and "Unsaved" tag, and the server's message shows in a toast. (Task 8)
2. **Two profiles on one sample, only one with a variant.** The other section is unchanged. (Task 3)
3. **A member the lab withdrew from this sample, or a per-vial certificate that does not carry it.** The guard counts printed rows only, so a member with no form rule that did not print does not hold the limit text back. (Task 3)
4. **Bad writes that would otherwise 500 on Postgres or print a blank line.** Reactivating into an occupied slot is 409, `active: null` is 422, text over the column length is 422, whitespace-only text is 400. (Task 4)
5. **A form deactivated after its variant was made.** The variant keeps printing and its card stays in the editor, but the form does not appear in the picker. (Tasks 3 and 8)

## Before Task 1

The spec's Rollout step 1 is a gate before building: Josh confirms that the default prep he set at 19:09:59 on 10-30 is the wording he wants for powder. The draft reply to him is unsent. If it is wrong, correct the default first (a normal logged profile edit). Start Task 1 once he has answered, or once the Handler waives the wait.

---

### Task 1: Branch, stack and test runner

No product code. The deliverable is a runner that gets a known test file green in the stack.

**Files:**
- Create: `C:\tmp\cv-pytest.sh` (outside the repo)

**Interfaces:**
- Produces: `bash /c/tmp/cv-pytest.sh <pytest args>`, which later tasks use. Referred to as `$RUN` below.

- [ ] **Step 1: Make the feature branch and bring in master**

```bash
git -C /c/tmp/Accu-Mk1-coa-variants switch -c feat/coa-text-variants
git -C /c/tmp/Accu-Mk1-coa-variants merge origin/master --no-edit
```
Expected: the merge is clean, because the branch only adds docs.

- [ ] **Step 2: Install frontend dependencies**

Run from the worktree: `npm ci`. Expected: `node_modules` exists (it is empty today).

- [ ] **Step 3: Create the stack**

```bash
ssh forrestparker@100.73.137.3 'cd ~/accumark-stack && ./bin/accumark-stack create coavar && ./bin/accumark-stack validate coavar' < /dev/null
```
Expected: validate reports 19/19. If the devbox has no address pool left, stop and report it. Never reclaim another agent's stack.

- [ ] **Step 4: Make the scratch DB**

```bash
ssh forrestparker@100.73.137.3 'docker exec accumark-coavar-postgres sh -c "pg_dump -U postgres -Fc accumark_mk1 > /tmp/mk1.dump && createdb -U postgres mk1_scratch && pg_restore -U postgres --no-owner -d mk1_scratch /tmp/mk1.dump"' < /dev/null
```
Never use `pg_restore --clean`. An empty DB fails collection, so this must be a restore.

- [ ] **Step 5: Write the runner**

```bash
#!/usr/bin/env bash
# Copies the working tree's backend into the coavar stack and runs pytest there.
DEV=forrestparker@100.73.137.3; C=accumark-coavar-accu-mk1-backend
tar -C /c/tmp/Accu-Mk1-coa-variants --exclude=.venv --exclude=__pycache__ --exclude=.env -cf - backend \
  | ssh $DEV "docker exec -i $C sh -c 'rm -rf /tmp/cv && mkdir -p /tmp/cv && tar -x -C /tmp/cv'"
ssh $DEV "docker exec -w /tmp/cv/backend -e MK1_DB_NAME=mk1_scratch $C python -m pytest $* -q -p no:cacheprovider -W ignore" < /dev/null
```

- [ ] **Step 6: Check it**

Run: `bash /c/tmp/cv-pytest.sh tests/test_spec_rules.py`
Expected: all pass.

### Task 2: The variant table

**Files:**
- Modify: `backend/models.py`, new class directly after `AnalysisProfile`
- Test: `backend/tests/test_profile_coa_variant_model.py`

**Interfaces:**
- Produces: `models.AnalysisProfileCoaVariant` with columns `id`, `analysis_profile_id`, `sample_form_id`, `coa_section_title`, `coa_basis_note`, `coa_method_text`, `coa_prep_text`, `coa_footnotes`, `active`, `created_at`, `updated_at`, `updated_by_id`.

- [ ] **Step 1: Write the failing tests**

```python
import pytest
from sqlalchemy.exc import IntegrityError

from models import AnalysisProfile, AnalysisProfileCoaVariant, LimsSampleForm


def _prof_and_form(db):
    prof = AnalysisProfile(key="heavy_metals", name="Heavy Metals", is_addon=True)
    form = LimsSampleForm(name="Nasal Spray", route="nasal_inhaled")
    db.add_all([prof, form]); db.flush()
    return prof, form


def test_one_active_variant_per_profile_and_form(db_session):
    prof, form = _prof_and_form(db_session)
    db_session.add(AnalysisProfileCoaVariant(analysis_profile_id=prof.id, sample_form_id=form.id))
    db_session.flush()
    db_session.add(AnalysisProfileCoaVariant(analysis_profile_id=prof.id, sample_form_id=form.id))
    with pytest.raises(IntegrityError):
        db_session.flush()


def test_a_switched_off_variant_frees_the_slot(db_session):
    prof, form = _prof_and_form(db_session)
    db_session.add(AnalysisProfileCoaVariant(analysis_profile_id=prof.id, sample_form_id=form.id,
                                             active=False))
    db_session.add(AnalysisProfileCoaVariant(analysis_profile_id=prof.id, sample_form_id=form.id))
    db_session.flush()


def test_the_three_states_survive_a_round_trip(db_session):
    prof, form = _prof_and_form(db_session)
    v = AnalysisProfileCoaVariant(analysis_profile_id=prof.id, sample_form_id=form.id,
                                  coa_basis_note="", coa_method_text=None, coa_prep_text="Diluted",
                                  coa_footnotes=[])
    db_session.add(v); db_session.flush(); db_session.expire(v)
    assert v.active is True
    assert v.coa_basis_note == ""
    assert v.coa_method_text is None
    assert v.coa_prep_text == "Diluted"
    assert v.coa_footnotes == []
```

- [ ] **Step 2: Run them to see them fail**

Run: `$RUN tests/test_profile_coa_variant_model.py`
Expected: FAIL at import, `AnalysisProfileCoaVariant` not found.

- [ ] **Step 3: Implement the model**

`__tablename__ = "analysis_profile_coa_variants"`. Types and lengths are in the spec's Data table.
- `analysis_profile_id`: `ForeignKey("analysis_profiles.id", ondelete="CASCADE")`, NOT NULL.
- `sample_form_id`: `ForeignKey("lims_sample_forms.id")`, NOT NULL.
- `coa_footnotes`: `JSONB().with_variant(JSON(), "sqlite")`, nullable, as on the profile.
- `active`: Boolean, NOT NULL, `default=True`, `server_default=text("true")`.
- `created_at`, `updated_at`, `updated_by_id`: copy `AnalysisProfile`'s definitions.
- `__table_args__`: `Index("uq_analysis_profile_coa_variants_form", "analysis_profile_id", "sample_form_id", unique=True, postgresql_where=text("active"), sqlite_where=text("active"))`.

No relationship on `AnalysisProfile`, and no raw DDL in `database.py`: `create_all` builds a new table and its declared indexes on the next boot (spec, Data). A docstring states the three field states.

- [ ] **Step 4: Run them to see them pass**

Run: `$RUN tests/test_profile_coa_variant_model.py`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git -c core.autocrlf=true add backend/models.py backend/tests/test_profile_coa_variant_model.py
git -c core.autocrlf=true commit -m "feat(coa): analysis_profile_coa_variants table" -- backend/models.py backend/tests/test_profile_coa_variant_model.py
```

### Task 3: The section builder prints the variant

**Files:**
- Modify: `backend/coa/native_sections.py` (form settled at 366-368, row loop tracking at 494-496, section dict at 514-529)
- Test: `backend/tests/test_native_sections_coa_variants.py`

**Interfaces:**
- Consumes: `AnalysisProfileCoaVariant` (Task 2).
- Produces: nothing new on the wire. Log line `native_section_variant_limits_guard sample=%s profile=%s`.

- [ ] **Step 1: Write the failing tests**

```python
from coa.native_sections import build_native_sections
from models import AnalysisProfileCoaVariant, AnalysisServiceSpec, LimsAnalysis, LimsSampleForm
from tests.test_native_sections import (_add_parent_row, _mk_native_profile, _mk_peptide,
                                        _nasal_parent, _order_lookup)

NOTES = [{"label": "Basis:", "text": "USP<232>"}]


def _hm(db, *, specs=False):
    prof, svcs = _mk_native_profile(db, key="heavy_metals", specs=specs,
                                    services=[("HM-PB", "mk1"), ("HM-AS", "mk1")])
    prof.coa_basis_note = "Limits scale with dose"
    prof.coa_method_text = "MP-AES"
    prof.coa_prep_text = "Hot block digestion"
    prof.coa_footnotes = NOTES
    db.flush()
    return prof, svcs


def _variant(db, prof, form_id, **fields):
    db.add(AnalysisProfileCoaVariant(analysis_profile_id=prof.id, sample_form_id=form_id, **fields))
    db.flush()


def _section(db, parent, monkeypatch, **kw):
    _order_lookup(monkeypatch)
    return build_native_sections(db, parent, **kw)["sections"][0]


def _assert_default_text(sec):
    assert sec["method_text"] == "MP-AES"
    assert sec["prep_text"] == "Hot block digestion"
    assert sec["footnotes"] == NOTES


def test_no_variant_keeps_key_order_and_text(db_session, monkeypatch):
    prof, svcs = _hm(db_session)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    sec = _section(db_session, parent, monkeypatch)
    assert list(sec) == ["profile_key", "title", "archetype", "sort_order", "basis_note",
                         "method_text", "prep_text", "footnotes", "rows"]
    assert sec["title"] == prof.name
    assert sec["basis_note"] is None    # the 1.55.0 hide
    _assert_default_text(sec)


def test_custom_text_prints_with_macros_filled(db_session, monkeypatch):
    prof, svcs = _hm(db_session)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    for row in db_session.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id):
        row.lod, row.lod_unit = 0.05, "ppm"
    _variant(db_session, prof, parent.sample_form_id, coa_section_title="Metals (Nasal)",
             coa_prep_text="Diluted 1:10. [LOD {lod}.]", coa_method_text="ICP",
             coa_basis_note="Report only", coa_footnotes=[{"label": "a", "text": "[LOD {lod}.]"}])
    sec = _section(db_session, parent, monkeypatch)
    assert sec["title"] == "Metals (Nasal)"
    assert sec["prep_text"] == "Diluted 1:10. LOD 0.05 ppm."
    assert sec["method_text"] == "ICP"
    assert sec["basis_note"] == "Report only"    # a custom note overrides the hide
    assert sec["footnotes"] == [{"label": "a", "text": "LOD 0.05 ppm."}]


def test_leave_off_gives_none_and_empty_list(db_session, monkeypatch):
    prof, svcs = _hm(db_session)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    _variant(db_session, prof, parent.sample_form_id, coa_basis_note="", coa_method_text="",
             coa_prep_text="", coa_footnotes=[])
    sec = _section(db_session, parent, monkeypatch)
    assert sec["basis_note"] is None and sec["method_text"] is None and sec["prep_text"] is None
    assert sec["footnotes"] == []


def test_same_as_default_keeps_the_basis_note_hide(db_session, monkeypatch):
    prof, svcs = _hm(db_session)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    _variant(db_session, prof, parent.sample_form_id, coa_prep_text="Diluted")
    sec = _section(db_session, parent, monkeypatch)
    assert sec["basis_note"] is None
    assert sec["prep_text"] == "Diluted"
    assert sec["footnotes"] == NOTES


def test_default_prints_for_another_form(db_session, monkeypatch):
    prof, svcs = _hm(db_session, specs=True)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    _variant(db_session, prof, parent.sample_form_id, coa_prep_text="Diluted")
    pen = LimsSampleForm(name="Pen", route="injectable")
    db_session.add(pen); db_session.flush()
    parent.sample_form_id = pen.id
    db_session.flush()
    _assert_default_text(_section(db_session, parent, monkeypatch))


def test_default_prints_with_no_form(db_session, monkeypatch):
    prof, svcs = _hm(db_session, specs=True)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    _variant(db_session, prof, parent.sample_form_id, coa_prep_text="Diluted")
    parent.sample_form_id = None
    db_session.flush()
    _assert_default_text(_section(db_session, parent, monkeypatch))


def test_default_prints_for_a_non_peptide_matrix_with_a_form(db_session, monkeypatch):
    prof, svcs = _hm(db_session, specs=True)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    _variant(db_session, prof, parent.sample_form_id, coa_prep_text="Diluted")
    parent.sample_type_title = "Bacteriostatic Water"
    db_session.flush()
    _assert_default_text(_section(db_session, parent, monkeypatch))


def test_default_prints_for_an_inactive_variant(db_session, monkeypatch):
    prof, svcs = _hm(db_session)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    _variant(db_session, prof, parent.sample_form_id, coa_prep_text="Diluted", active=False)
    _assert_default_text(_section(db_session, parent, monkeypatch))


def test_a_deactivated_form_keeps_its_variant(db_session, monkeypatch):
    prof, svcs = _hm(db_session)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    _variant(db_session, prof, parent.sample_form_id, coa_prep_text="Diluted")
    db_session.get(LimsSampleForm, parent.sample_form_id).active = False
    db_session.flush()
    assert _section(db_session, parent, monkeypatch)["prep_text"] == "Diluted"


def test_a_second_profile_on_the_sample_is_unchanged(db_session, monkeypatch):
    prof, svcs = _hm(db_session)
    other, other_svcs = _mk_native_profile(db_session, key="other_panel", sort=20, specs=False,
                                           services=[("OT-1", "mk1")])
    other.coa_prep_text = "Other prep"
    parent = _nasal_parent(db_session, svcs + other_svcs, form_row_svcs=svcs + other_svcs)
    _variant(db_session, prof, parent.sample_form_id, coa_prep_text="Diluted")
    monkeypatch.setattr("coa.native_sections.fetch_sample_services",
                        lambda sample_id: {"services": {"heavy_metals": True, "other_panel": True},
                                           "package": None})
    first, second = build_native_sections(db_session, parent)["sections"]
    assert first["prep_text"] == "Diluted"
    assert second["prep_text"] == "Other prep"


def test_a_vial_certificate_uses_the_parents_form(db_session, monkeypatch):
    prof, svcs = _hm(db_session)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    _variant(db_session, prof, parent.sample_form_id, coa_prep_text="Diluted")
    ids = {r.id for r in db_session.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id)}
    assert _section(db_session, parent, monkeypatch, vial_parent_ids=ids)["prep_text"] == "Diluted"


def test_guard_a_row_on_general_limits_keeps_default_limit_text(db_session, monkeypatch, caplog):
    prof, svcs = _hm(db_session, specs=True)    # wildcard on both, form row only on HM-PB
    parent = _nasal_parent(db_session, svcs, form_row_svcs=[svcs[0]])
    _variant(db_session, prof, parent.sample_form_id, coa_prep_text="Diluted", coa_method_text="ICP",
             coa_section_title="Metals (Nasal)", coa_basis_note="", coa_footnotes=[])
    with caplog.at_level("WARNING", logger="coa.native_sections"):
        sec = _section(db_session, parent, monkeypatch)
    assert sec["title"] == "Metals (Nasal)"
    assert sec["prep_text"] == "Diluted" and sec["method_text"] == "ICP"
    assert sec["basis_note"] == "Limits scale with dose"
    assert sec["footnotes"] == NOTES
    assert sum("native_section_variant_limits_guard" in r.getMessage()
               for r in caplog.records) == 1


def test_guard_a_peptide_tier_row_keeps_default_limit_text(db_session, monkeypatch, caplog):
    from decimal import Decimal
    peptide = _mk_peptide(db_session, "BPC157")
    prof, svcs = _hm(db_session)
    svcs[1].peptide_id = peptide.id
    db_session.add(AnalysisServiceSpec(analysis_service_id=svcs[1].id, peptide_id=peptide.id,
                                       rule_kind="range", max_value=Decimal("100"), unit="ppm"))
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    _variant(db_session, prof, parent.sample_form_id, coa_basis_note="", coa_footnotes=[])
    with caplog.at_level("WARNING", logger="coa.native_sections"):
        sec = _section(db_session, parent, monkeypatch)
    assert sec["basis_note"] == "Limits scale with dose" and sec["footnotes"] == NOTES
    assert any("native_section_variant_limits_guard" in r.getMessage() for r in caplog.records)


def test_guard_stays_quiet_when_the_variant_overrides_no_limit_field(db_session, monkeypatch, caplog):
    prof, svcs = _hm(db_session, specs=True)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=[svcs[0]])
    _variant(db_session, prof, parent.sample_form_id, coa_prep_text="Diluted")
    with caplog.at_level("WARNING", logger="coa.native_sections"):
        _section(db_session, parent, monkeypatch)
    assert not any("native_section_variant_limits_guard" in r.getMessage() for r in caplog.records)


def test_guard_counts_printed_rows_only_withdrawn_member(db_session, monkeypatch):
    prof, svcs = _hm(db_session, specs=True)
    parent = _nasal_parent(db_session, [svcs[0]], form_row_svcs=[svcs[0]])
    _add_parent_row(db_session, parent, svcs[1], state="rejected", provenance="ordered")
    _variant(db_session, prof, parent.sample_form_id, coa_basis_note="", coa_footnotes=[])
    sec = _section(db_session, parent, monkeypatch)
    assert [r["keyword"] for r in sec["rows"]] == ["HM-PB"]
    assert sec["basis_note"] is None and sec["footnotes"] == []


def test_guard_counts_printed_rows_only_vial_scope(db_session, monkeypatch):
    prof, svcs = _hm(db_session, specs=True)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=[svcs[0]])
    _variant(db_session, prof, parent.sample_form_id, coa_basis_note="", coa_footnotes=[])
    pb = db_session.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id, keyword="HM-PB").one()
    sec = _section(db_session, parent, monkeypatch, vial_parent_ids={pb.id})
    assert sec["basis_note"] is None and sec["footnotes"] == []
```

- [ ] **Step 2: Run them to see them fail**

Run: `$RUN tests/test_native_sections_coa_variants.py`
Expected: the variant tests FAIL (`prep_text` is the default). The default-text tests already pass, which is correct.

- [ ] **Step 3: Implement in `backend/coa/native_sections.py`**

Two helpers next to `_section_footnotes`:

```python
def _coa_variants_for_form(db: Session, profiles, sample_form_id) -> dict:
    """The active COA text variants for this form and these profiles, in one
    query, keyed by profile id. No form, no query."""

def _variant_text(override: Optional[str], default: Optional[str], values: dict) -> Optional[str]:
    """NULL prints the default. '' resolves to None (left off). Text is the variant's own."""
    if override is None:
        return resolve(default, values)
    return resolve(override, values) or None
```

Load after `form_tier` is set: `variants = _coa_variants_for_form(db, profiles, sample_form_id)`.

In the row loop, next to `all_form_report_only`: start `all_rows_form_judged = True`, and after each printed row add `all_rows_form_judged = all_rows_form_judged and spec.sample_form_id == sample_form_id`.

Before `sections.append`, and in the section dict:

```python
variant = variants.get(prof.id)
limit_variant = variant if all_rows_form_judged else None
if (variant is not None and limit_variant is None
        and (variant.coa_basis_note is not None or variant.coa_footnotes is not None)):
    log.warning("native_section_variant_limits_guard sample=%s profile=%s", sample_id, prof.key)
basis_override = limit_variant.coa_basis_note if limit_variant else None
notes_override = limit_variant.coa_footnotes if limit_variant else None
```

```python
"title": (variant.coa_section_title if variant else None) or prof.coa_section_title or prof.name,
"basis_note": _variant_text(basis_override,
                            None if all_form_report_only else prof.coa_basis_note, values),
"method_text": _variant_text(variant.coa_method_text if variant else None,
                             prof.coa_method_text, values),
"prep_text": _variant_text(variant.coa_prep_text if variant else None,
                           prof.coa_prep_text, values),
"footnotes": _section_footnotes(notes_override if notes_override is not None
                                else prof.coa_footnotes, values),
```
Import the model inside the helper, as this module does for other models. The log fires only when a limit field was actually held back (Ruling: a variant that overrides neither has no fallback to report).

- [ ] **Step 4: Run them to see them pass, with the existing section suites**

Run: `$RUN tests/test_native_sections_coa_variants.py tests/test_native_sections.py tests/test_coa_text_macros_sections.py tests/test_per_vial_certificates.py`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git -c core.autocrlf=true add backend/coa/native_sections.py backend/tests/test_native_sections_coa_variants.py
git -c core.autocrlf=true commit -m "feat(coa): sections print a sample form's COA text variant" -- backend/coa/native_sections.py backend/tests/test_native_sections_coa_variants.py
```

### Task 4: Routes, audit and profile delete

**Files:**
- Modify: `backend/main.py`: pydantic models after `AnalysisProfileResponse` (3171), helpers after `_validate_coa_text_macros` (21755), routes after `delete_analysis_profile` (22002), and that route itself
- Test: `backend/tests/test_profile_coa_variant_routes.py`

**Interfaces:**
- Consumes: `AnalysisProfileCoaVariant` (Task 2).
- Produces:
  - `GET /analysis-profiles/{profile_id}/coa-variants`: active rows, ordered by form `sort_order` then id.
  - `POST /analysis-profiles/{profile_id}/coa-variants`: body `{sample_form_id, coa_section_title?, coa_basis_note?, coa_method_text?, coa_prep_text?, coa_footnotes?}`, returns 201.
  - `PATCH /analysis-profile-coa-variants/{variant_id}`: body is any of the five `coa_*` fields and `active`.
  - Response: `{id, analysis_profile_id, sample_form_id, sample_form_name, coa_section_title, coa_basis_note, coa_method_text, coa_prep_text, coa_footnotes, active, updated_at}`. Every key must be declared on the response model, or FastAPI drops it.

- [ ] **Step 1: Write the failing tests**

Copy the `db_session` and `client` fixtures from `backend/tests/test_service_spec_routes.py:24-58`, then:

```python
@pytest.fixture
def profile(db_session):
    p = AnalysisProfile(key="heavy_metals", name="Heavy Metals", is_addon=True)
    db_session.add(p); db_session.commit()
    return p

@pytest.fixture
def nasal(db_session):
    f = LimsSampleForm(name="Nasal Spray", route="nasal_inhaled")
    db_session.add(f); db_session.commit()
    return f

def _post(client, profile, nasal, **fields):
    return client.post(f"/analysis-profiles/{profile.id}/coa-variants",
                       json={"sample_form_id": nasal.id, **fields})

def _log(db, action):
    return db.query(CatalogChangeLog).filter_by(entity_type="profile_coa_variant", action=action).all()

def test_create_returns_the_form_name_and_three_states(client, profile, nasal):
    r = _post(client, profile, nasal, coa_basis_note="", coa_prep_text="Diluted", coa_footnotes=[])
    assert r.status_code == 201
    body = r.json()
    assert body["sample_form_name"] == "Nasal Spray"
    assert body["coa_basis_note"] == "" and body["coa_prep_text"] == "Diluted"
    assert body["coa_method_text"] is None and body["coa_footnotes"] == [] and body["active"] is True

def test_create_404_unknown_profile(client, nasal):
    r = client.post("/analysis-profiles/999/coa-variants", json={"sample_form_id": nasal.id})
    assert r.status_code == 404

@pytest.mark.parametrize("body", [{}, {"sample_form_id": 999}])
def test_create_400_missing_or_unknown_form(client, profile, body):
    assert client.post(f"/analysis-profiles/{profile.id}/coa-variants", json=body).status_code == 400

def test_second_active_variant_409_until_the_first_is_switched_off(client, profile, nasal):
    first = _post(client, profile, nasal).json()
    r = _post(client, profile, nasal)
    assert r.status_code == 409
    assert r.json()["detail"] == "an active version already exists for this form; stop using it first"
    client.patch(f"/analysis-profile-coa-variants/{first['id']}", json={"active": False})
    assert _post(client, profile, nasal).status_code == 201

def test_list_returns_active_only(client, profile, nasal):
    first = _post(client, profile, nasal).json()
    client.patch(f"/analysis-profile-coa-variants/{first['id']}", json={"active": False})
    second = _post(client, profile, nasal).json()
    r = client.get(f"/analysis-profiles/{profile.id}/coa-variants")
    assert [v["id"] for v in r.json()] == [second["id"]]

def test_patch_null_means_default_and_omitted_is_unchanged(client, profile, nasal):
    v = _post(client, profile, nasal, coa_prep_text="Diluted", coa_method_text="ICP").json()
    r = client.patch(f"/analysis-profile-coa-variants/{v['id']}", json={"coa_prep_text": None})
    assert r.json()["coa_prep_text"] is None and r.json()["coa_method_text"] == "ICP"

def test_patch_cannot_move_the_form(client, profile, nasal, db_session):
    pen = LimsSampleForm(name="Pen", route="injectable")
    db_session.add(pen); db_session.commit()
    v = _post(client, profile, nasal).json()
    r = client.patch(f"/analysis-profile-coa-variants/{v['id']}", json={"sample_form_id": pen.id})
    assert r.json()["sample_form_id"] == nasal.id

def test_patch_404_unknown_variant(client):
    assert client.patch("/analysis-profile-coa-variants/999", json={"active": False}).status_code == 404

@pytest.mark.parametrize("fields", [
    {"coa_section_title": ""}, {"coa_section_title": "   "}, {"coa_basis_note": "   "},
    {"coa_prep_text": "Has {lot}"}, {"coa_footnotes": [{"label": "L {lod}", "text": "t"}]},
    {"coa_footnotes": [{"label": "only label", "text": ""}]}, {"coa_footnotes": "nope"},
])
def test_bad_text_400_on_create_and_patch(client, profile, nasal, fields):
    assert _post(client, profile, nasal, **fields).status_code == 400
    v = _post(client, profile, nasal).json()
    assert client.patch(f"/analysis-profile-coa-variants/{v['id']}", json=fields).status_code == 400

def test_good_macros_and_empty_footnotes_are_accepted(client, profile, nasal):
    r = _post(client, profile, nasal, coa_prep_text="[LOD {lod}.]", coa_footnotes=[])
    assert r.status_code == 201

def test_text_over_the_column_length_is_422(client, profile, nasal):
    assert _post(client, profile, nasal, coa_basis_note="x" * 201).status_code == 422
    assert _post(client, profile, nasal, coa_section_title="x" * 201).status_code == 422

def test_reactivating_into_an_occupied_slot_is_409(client, profile, nasal):
    first = _post(client, profile, nasal).json()
    client.patch(f"/analysis-profile-coa-variants/{first['id']}", json={"active": False})
    _post(client, profile, nasal)
    r = client.patch(f"/analysis-profile-coa-variants/{first['id']}", json={"active": True})
    assert r.status_code == 409

def test_active_null_is_422(client, profile, nasal):
    v = _post(client, profile, nasal).json()
    assert client.patch(f"/analysis-profile-coa-variants/{v['id']}", json={"active": None}).status_code == 422

def test_audit_rows(client, profile, nasal, db_session):
    v = _post(client, profile, nasal, coa_prep_text="Diluted").json()
    [created] = _log(db_session, "create")
    assert created.entity_pk == v["id"]
    assert created.details["changed"]["coa_prep_text"] == {"before": None, "after": "Diluted"}
    client.patch(f"/analysis-profile-coa-variants/{v['id']}", json={"coa_prep_text": "Diluted"})
    assert _log(db_session, "update") == []
    client.patch(f"/analysis-profile-coa-variants/{v['id']}", json={"coa_prep_text": "New", "active": False})
    [updated] = _log(db_session, "update")
    assert set(updated.details["changed"]) == {"coa_prep_text", "active"}

def test_profile_delete_logs_each_variant(client, profile, nasal, db_session):
    first = _post(client, profile, nasal).json()
    client.patch(f"/analysis-profile-coa-variants/{first['id']}", json={"active": False})
    _post(client, profile, nasal)
    assert client.delete(f"/analysis-profiles/{profile.id}").status_code == 204
    assert len(_log(db_session, "delete")) == 2
```

- [ ] **Step 2: Run them to see them fail**

Run: `$RUN tests/test_profile_coa_variant_routes.py`
Expected: FAIL with 404s on the new routes.

- [ ] **Step 3: Implement**

- `ProfileCoaVariantFields(BaseModel)`: `coa_section_title` and `coa_basis_note` as `Optional[str] = Field(None, max_length=200)`, `coa_method_text` and `coa_prep_text` as `Optional[str] = None`, `coa_footnotes: Optional[Any] = None`.
- `ProfileCoaVariantCreate(ProfileCoaVariantFields)`: adds `sample_form_id: Optional[int] = None`. Optional so a missing form is the spec's 400, not pydantic's 422.
- `ProfileCoaVariantPatch(ProfileCoaVariantFields)`: adds `active: Optional[bool] = None`.
- `ProfileCoaVariantResponse`: the keys in Interfaces.
- `COA_VARIANT_LOG_FIELDS = ("analysis_profile_id", "sample_form_id", "coa_section_title", "coa_basis_note", "coa_method_text", "coa_prep_text", "coa_footnotes", "active")`.
- `_validate_coa_variant_fields(fields: dict) -> None`: a blank `coa_section_title` is 400 with "coa_section_title cannot be blank; send null for same as default". A whitespace-only `coa_basis_note`, `coa_method_text` or `coa_prep_text` is 400 with "<field> is only whitespace; send '' to leave it off". Then call `_validate_coa_footnotes` when the key is present, and `_validate_coa_text_macros(fields)`.
- `_coa_variant_response(db, v) -> ProfileCoaVariantResponse`: the `_spec_response` pattern (main.py:4741).
- Routes: `Depends(get_current_user)`, the same as the profile routes. POST and PATCH `flush()` inside `try`, and on `IntegrityError` `rollback` and raise 409 with the exact detail from the test. POST calls `log_create(db, v, COA_VARIANT_LOG_FIELDS, entity_type="profile_coa_variant", entity_pk=v.id, user_id=getattr(current_user, "id", None))` after the flush. PATCH uses `model_dump(exclude_unset=True)`, raises 422 "active cannot be null" on an explicit null, calls `apply_and_log` with the same entity type, and sets `updated_by_id` only when something changed.
- `delete_analysis_profile`: before the `log_delete` of the profile, call `log_delete(db, v, COA_VARIANT_LOG_FIELDS, entity_type="profile_coa_variant", entity_pk=v.id, user_id=...)` for every variant of the profile, active or not. Keep the rest of the route.

- [ ] **Step 4: Run them to see them pass**

Run: `$RUN tests/test_profile_coa_variant_routes.py tests/test_service_spec_routes.py`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git -c core.autocrlf=true add backend/main.py backend/tests/test_profile_coa_variant_routes.py
git -c core.autocrlf=true commit -m "feat(coa): routes and audit for COA text variants" -- backend/main.py backend/tests/test_profile_coa_variant_routes.py
```

### Task 5: Frontend API and the logic module

Everything the editor decides lives here as pure functions, so Tasks 7 to 9 only draw it.

**Files:**
- Create: `src/lib/api-profile-coa-variants.ts`, `src/services/profile-coa-variants.ts`, `src/components/hplc/coa-variant-logic.ts`
- Test: `src/test/coa-variant-logic.test.ts`

**Interfaces:**
- Consumes: the routes in Task 4.
- Produces, `api-profile-coa-variants.ts` (imports `API_BASE_URL`, `getBearerHeaders`, `extractErrorMessage` from `@/lib/api`):
  ```ts
  export interface ProfileCoaVariantFields {
    coa_section_title: string | null
    coa_basis_note: string | null
    coa_method_text: string | null
    coa_prep_text: string | null
    coa_footnotes: { label: string; text: string }[] | null
  }
  export interface ProfileCoaVariant extends ProfileCoaVariantFields {
    id: number; analysis_profile_id: number; sample_form_id: number
    sample_form_name: string; active: boolean; updated_at: string | null
  }
  listProfileCoaVariants(profileId: number): Promise<ProfileCoaVariant[]>
  createProfileCoaVariant(profileId: number, data: ProfileCoaVariantFields & { sample_form_id: number }): Promise<ProfileCoaVariant>
  patchProfileCoaVariant(variantId: number, data: Partial<ProfileCoaVariantFields> & { active?: boolean }): Promise<ProfileCoaVariant>
  ```
- Produces, `services/profile-coa-variants.ts`: `profileCoaVariantKeys.forProfile(id) = ['profile-coa-variants', id]`, and `useProfileCoaVariants(profileId: number | null)`, enabled only with an id.
- Produces, `coa-variant-logic.ts`:
  ```ts
  export type CoaField = keyof ProfileCoaVariantFields
  export type CoaTextField = Exclude<CoaField, 'coa_footnotes'>
  export type FieldChoice = 'default' | 'custom' | 'off'
  export type Footnote = { label: string; text: string }
  export type CoaDefaults = Pick<AnalysisProfile, 'name' | CoaField>
  export interface VariantDraft {
    variantId: number | null; formId: number; formName: string
    choices: Record<CoaField, FieldChoice>
    texts: Record<CoaTextField, string | null>  // null = never prefilled or typed
    footnotes: Footnote[] | null
  }
  export const COA_FIELD_ROWS: { field: CoaField; label: string; short: string; limits: boolean; canLeaveOff: boolean }[]
  export const COA_MACRO_HINT = 'Macros: {lod}. Wrap optional text in [ ], for example [LOD {lod}.]'
  export const UNSAVED_VERSION_PROMPT = 'You have unsaved COA text for a sample form. Leave without saving it?'
  export function newDraft(formId: number, formName: string): VariantDraft
  export function draftFromVariant(v: ProfileCoaVariant): VariantDraft
  export function setChoice(d: VariantDraft, field: CoaField, choice: FieldChoice, defaults: CoaDefaults): VariantDraft
  export function draftToWire(d: VariantDraft): ProfileCoaVariantFields
  export function draftErrors(d: VariantDraft): Partial<Record<CoaField, string>>
  export function isDraftDirty(d: VariantDraft, saved: ProfileCoaVariant | null): boolean
  export function summaryLine(w: ProfileCoaVariantFields): string
  export function overrideLine(v: ProfileCoaVariant): string | null
  export interface MemberRules { serviceId: number; name: string; rules: AnalysisServiceSpecRecord[] | undefined; failed: boolean }
  export type RuleStatus =
    | { kind: 'loading' } | { kind: 'unknown' }
    | { kind: 'ok'; count: number; peptideRule: boolean; allReportOnly: boolean }
    | { kind: 'held'; missing: { serviceId: number; name: string }[]; peptideRule: boolean }
  export function memberRuleStatus(formId: number, members: MemberRules[], membersLoading: boolean): RuleStatus
  export function guardMessage(status: RuleStatus, formName: string): string
  export function heldNote(status: RuleStatus): string | null
  export interface PreviewPiece { text: string | null; missing: string; tag: string }
  export interface CoaPreview {
    title: PreviewPiece; basis: PreviewPiece; method: PreviewPiece; prep: PreviewPiece
    footnotes: { items: Footnote[]; tag: string }; macroNote: boolean
  }
  export function buildPreview(d: VariantDraft, defaults: CoaDefaults, status: RuleStatus): CoaPreview
  ```

- [ ] **Step 1: Write the failing tests**

```ts
const DEFAULTS: CoaDefaults = {
  name: 'Heavy Metals', coa_section_title: null, coa_basis_note: 'Basis: USP<232>',
  coa_method_text: 'MP-AES', coa_prep_text: 'Hot block digestion',
  coa_footnotes: [{ label: 'Basis:', text: 'Limits per USP<232>.' }],
}
const NASAL = newDraft(4, 'Nasal Spray')
const rule = (over: Partial<AnalysisServiceSpecRecord>) =>
  ({ sample_form_id: 4, peptide_id: null, rule_kind: 'informational', ...over }) as AnalysisServiceSpecRecord
const member = (name: string, rules: AnalysisServiceSpecRecord[] | undefined, failed = false): MemberRules =>
  ({ serviceId: name.length, name, rules, failed })

describe('wire mapping', () => {
  it('maps default to null, off to empty, custom to trimmed text', () => {
    let d = setChoice(NASAL, 'coa_basis_note', 'off', DEFAULTS)
    d = setChoice(d, 'coa_footnotes', 'off', DEFAULTS)
    d = setChoice(d, 'coa_prep_text', 'custom', DEFAULTS)
    d = { ...d, texts: { ...d.texts, coa_prep_text: '  Diluted  ' } }
    expect(draftToWire(d)).toEqual({
      coa_section_title: null, coa_basis_note: '', coa_method_text: null,
      coa_prep_text: 'Diluted', coa_footnotes: [],
    })
  })
  it('reads null, empty and text back into choices', () => {
    const d = draftFromVariant({ ...baseVariant, coa_basis_note: '', coa_prep_text: 'Diluted', coa_footnotes: [] })
    expect(d.choices).toMatchObject({ coa_section_title: 'default', coa_basis_note: 'off', coa_prep_text: 'custom', coa_footnotes: 'off' })
    expect(d.texts.coa_prep_text).toBe('Diluted')
  })
  it('prefills the first Custom from the saved Default and keeps typed text across switches', () => {
    let d = setChoice(NASAL, 'coa_prep_text', 'custom', DEFAULTS)
    expect(d.texts.coa_prep_text).toBe('Hot block digestion')
    d = { ...d, texts: { ...d.texts, coa_prep_text: 'Typed' } }
    d = setChoice(setChoice(d, 'coa_prep_text', 'off', DEFAULTS), 'coa_prep_text', 'custom', DEFAULTS)
    expect(d.texts.coa_prep_text).toBe('Typed')
  })
  it('prefills a custom title from the profile name when the Default title is blank', () => {
    expect(setChoice(NASAL, 'coa_section_title', 'custom', DEFAULTS).texts.coa_section_title).toBe('Heavy Metals')
  })
  it('prefills custom footnotes with a copy of the Default rows', () => {
    const d = setChoice(NASAL, 'coa_footnotes', 'custom', DEFAULTS)
    expect(d.footnotes).toEqual(DEFAULTS.coa_footnotes)
    expect(d.footnotes).not.toBe(DEFAULTS.coa_footnotes)
  })
})

describe('draftErrors', () => {
  it('blocks blank Custom text, with its message', () => {
    let d = setChoice(NASAL, 'coa_prep_text', 'custom', DEFAULTS)
    d = { ...d, texts: { ...d.texts, coa_prep_text: '   ' } }
    expect(draftErrors(d)).toEqual({ coa_prep_text: 'Type the text, or choose Leave off' })
  })
  it('has its own message for the title', () => {
    let d = setChoice(NASAL, 'coa_section_title', 'custom', DEFAULTS)
    d = { ...d, texts: { ...d.texts, coa_section_title: '' } }
    expect(draftErrors(d)).toEqual({ coa_section_title: 'Type the title, or choose Same as default' })
  })
  it('blocks Custom footnotes with no filled-in rows', () => {
    const d = { ...setChoice(NASAL, 'coa_footnotes', 'custom', DEFAULTS), footnotes: [{ label: ' ', text: '' }] }
    expect(draftErrors(d)).toEqual({ coa_footnotes: 'Type the text, or choose Leave off' })
  })
  it('lets a half-filled footnote through for the backend to reject, as the Default does', () => {
    const d = { ...setChoice(NASAL, 'coa_footnotes', 'custom', DEFAULTS), footnotes: [{ label: 'a', text: '' }] }
    expect(draftErrors(d)).toEqual({})
    expect(draftToWire(d).coa_footnotes).toEqual([{ label: 'a', text: '' }])
  })
})

describe('isDraftDirty', () => {
  it('is clean for an untouched new card', () => expect(isDraftDirty(NASAL, null)).toBe(false))
  it('is clean after flipping a choice and back', () => {
    const d = setChoice(setChoice(NASAL, 'coa_prep_text', 'off', DEFAULTS), 'coa_prep_text', 'default', DEFAULTS)
    expect(isDraftDirty(d, null)).toBe(false)
  })
  it('is dirty against the saved row', () => {
    const saved = { ...baseVariant, coa_prep_text: 'Diluted' }
    expect(isDraftDirty(draftFromVariant(saved), saved)).toBe(false)
    expect(isDraftDirty(setChoice(draftFromVariant(saved), 'coa_prep_text', 'off', DEFAULTS), saved)).toBe(true)
  })
})

describe('summary lines', () => {
  it('summarizes the card', () => {
    expect(summaryLine({ ...allNull, coa_basis_note: '', coa_prep_text: 'x' })).toBe('Overrides: basis note left off, prep custom')
    expect(summaryLine(allNull)).toBe('Same as default (no changes yet)')
  })
  it('names what a form overrides, for the Default block', () => {
    const v = { ...baseVariant, coa_basis_note: '', coa_prep_text: 'x', coa_footnotes: [] }
    expect(overrideLine(v)).toBe('Nasal Spray overrides basis note, prep and footnotes')
    expect(overrideLine(baseVariant)).toBeNull()
  })
})

describe('guard line', () => {
  it('is green only when every call worked and every member has a rule', () => {
    const s = memberRuleStatus(4, [member('Arsenic', [rule({})]), member('Lead', [rule({ rule_kind: 'range' })])], false)
    expect(s).toMatchObject({ kind: 'ok', count: 2, peptideRule: false, allReportOnly: false })
    expect(guardMessage(s, 'Nasal Spray')).toBe("All 2 services have a Nasal Spray rule, so this version's basis note and footnotes print.")
  })
  it('counts one service in the singular', () => {
    expect(guardMessage(memberRuleStatus(4, [member('Arsenic', [rule({})])], false), 'Nasal Spray'))
      .toBe("The 1 service has a Nasal Spray rule, so this version's basis note and footnotes print.")
  })
  it('is never green on a failed call or with no members', () => {
    const failed = memberRuleStatus(4, [member('Arsenic', [rule({})]), member('Lead', undefined, true)], false)
    expect(failed.kind).toBe('unknown')
    expect(memberRuleStatus(4, [], false).kind).toBe('unknown')
    expect(guardMessage(failed, 'Nasal Spray')).toBe('Could not confirm the Nasal Spray rules.')
  })
  it('says it is checking while anything loads', () => {
    expect(memberRuleStatus(4, [member('Arsenic', undefined)], false).kind).toBe('loading')
    expect(memberRuleStatus(4, [], true).kind).toBe('loading')
    expect(guardMessage({ kind: 'loading' }, 'Nasal Spray')).toBe('Checking the Nasal Spray rules...')
  })
  it('does not count another form or a peptide row as a rule, and names who is missing', () => {
    const s = memberRuleStatus(4, [member('Arsenic', [rule({ sample_form_id: 9 })]), member('Lead', [rule({})])], false)
    expect(s).toMatchObject({ kind: 'held', missing: [{ name: 'Arsenic' }] })
    expect(guardMessage(s, 'Nasal Spray')).toBe(
      'Arsenic has no Nasal Spray rule, so it is judged on its general limits. A Nasal Spray COA that includes it keeps the Default basis note and footnotes. Title, method and prep still use this version.')
    expect(heldNote(s)).toBe('Held: the Default prints on a COA that includes Arsenic')
  })
  it('words several missing services', () => {
    const s = memberRuleStatus(4, [member('Arsenic', []), member('Lead', [])], false)
    expect(guardMessage(s, 'Nasal Spray')).toBe(
      'Arsenic and Lead have no Nasal Spray rule, so they are judged on their general limits. A Nasal Spray COA that includes any of them keeps the Default basis note and footnotes. Title, method and prep still use this version.')
    expect(heldNote(s)).toBe('Held: the Default prints on a COA that includes Arsenic or Lead')
  })
  it('adds the peptide sentence to either line, only when a member has a peptide rule', () => {
    const s = memberRuleStatus(4, [member('Arsenic', [rule({}), rule({ sample_form_id: null, peptide_id: 7 })])], false)
    expect(guardMessage(s, 'Nasal Spray')).toMatch(/ A peptide-specific rule also keeps the Default basis note and footnotes\.$/)
  })
})

describe('buildPreview', () => {
  const ok = { kind: 'ok', count: 2, peptideRule: false, allReportOnly: false } as const
  const held = { kind: 'held', missing: [{ serviceId: 1, name: 'Arsenic' }], peptideRule: false } as const
  const off = setChoice(setChoice(NASAL, 'coa_basis_note', 'off', DEFAULTS), 'coa_footnotes', 'off', DEFAULTS)

  it('tags Default, the form name, and what is missing', () => {
    const p = buildPreview(off, DEFAULTS, ok)
    expect(p.title).toMatchObject({ text: 'Heavy Metals', tag: 'Default' })
    expect(p.prep).toMatchObject({ text: 'Hot block digestion', tag: 'Default' })
    expect(p.basis).toMatchObject({ text: null, missing: 'no basis note', tag: 'Nasal Spray' })
    expect(p.footnotes).toEqual({ items: [], tag: 'Nasal Spray' })
  })
  it('holds the limit fields back with Default, held, but not prep', () => {
    let d = setChoice(off, 'coa_prep_text', 'custom', DEFAULTS)
    d = { ...d, texts: { ...d.texts, coa_prep_text: 'Diluted' } }
    const p = buildPreview(d, DEFAULTS, held)
    expect(p.basis).toMatchObject({ text: 'Basis: USP<232>', tag: 'Default, held' })
    expect(p.footnotes).toEqual({ items: DEFAULTS.coa_footnotes, tag: 'Default, held' })
    expect(p.prep).toMatchObject({ text: 'Diluted', tag: 'Nasal Spray' })
  })
  it('follows the 1.55.0 hide for a basis note on Same as default', () => {
    const p = buildPreview(NASAL, DEFAULTS, { ...ok, allReportOnly: true })
    expect(p.basis).toMatchObject({ text: null, missing: 'no basis note', tag: 'Default, hidden: every row is report only' })
    expect(buildPreview(NASAL, DEFAULTS, ok).basis).toMatchObject({ text: 'Basis: USP<232>', tag: 'Default' })
  })
  it('notes a macro, which prints as typed', () => {
    let d = setChoice(NASAL, 'coa_prep_text', 'custom', DEFAULTS)
    d = { ...d, texts: { ...d.texts, coa_prep_text: '[LOD {lod}.]' } }
    const p = buildPreview(d, DEFAULTS, ok)
    expect(p.prep.text).toBe('[LOD {lod}.]')
    expect(p.macroNote).toBe(true)
    expect(buildPreview(NASAL, DEFAULTS, ok).macroNote).toBe(false)
  })
})
```

`baseVariant` is a `ProfileCoaVariant` for form 4, "Nasal Spray", with all five fields null. `allNull` is the same five fields alone.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/test/coa-variant-logic.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the three files**

`COA_FIELD_ROWS`, in print order. `short` feeds the summary lines.

| field | label | short | limits | canLeaveOff |
|---|---|---|---|---|
| `coa_section_title` | Section title | title | false | false |
| `coa_basis_note` | Basis note | basis note | true | true |
| `coa_method_text` | Method | method | false | true |
| `coa_prep_text` | Sample prep | prep | false | true |
| `coa_footnotes` | Footnotes | footnotes | true | true |

Details the tests do not settle:
- `draftToWire` cleans footnotes exactly as `handleSave` does: drop rows blank on both sides, trim the rest. Custom text is trimmed.
- `summaryLine` and `overrideLine` list fields in print order, so the spec's example reads "basis note, prep and footnotes" here.
- `isDraftDirty` compares `JSON.stringify` of `draftToWire(d)` with the saved row's five fields, in a fixed key order. A null `saved` means all five null.
- `memberRuleStatus`, in this order: any `failed` is `unknown`; `membersLoading` or any `rules` undefined is `loading`; no members is `unknown`. A member has a rule when a row has `sample_form_id === formId` and `peptide_id == null`. `allReportOnly` is true when every member's form rows are all `informational`.
- `buildPreview`: a limit field that is overridden while `status.kind === 'held'` shows the Default's value tagged `Default, held`. While `loading` or `unknown`, it shows the choice (the guard line carries the warning). A blank custom piece shows as missing. Missing labels are `no basis note`, `no method line`, `no prep line`. Title has no missing state: `coa_section_title || name`. `macroNote` is true when any shown text contains `{lod}`.

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run src/test/coa-variant-logic.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
sed -i 's/\r$//' src/lib/api-profile-coa-variants.ts src/services/profile-coa-variants.ts src/components/hplc/coa-variant-logic.ts src/test/coa-variant-logic.test.ts
git -c core.autocrlf=true add src/lib/api-profile-coa-variants.ts src/services/profile-coa-variants.ts src/components/hplc/coa-variant-logic.ts src/test/coa-variant-logic.test.ts
git -c core.autocrlf=true commit -m "feat(mk1): API and logic for COA text versions" -- src/lib/api-profile-coa-variants.ts src/services/profile-coa-variants.ts src/components/hplc/coa-variant-logic.ts src/test/coa-variant-logic.test.ts
```

### Task 6: Pull out the footnote editor

A move with no behavior change. The existing Default tests are the proof, so nothing new is written first.

**Files:**
- Create: `src/components/hplc/FootnoteListEditor.tsx`
- Modify: `src/components/hplc/AnalysisProfilesPage.tsx` (helpers at 460-486, markup in the Footnotes block)

**Interfaces:**
- Produces: `FootnoteListEditor({ value, onChange, header }: { value: Footnote[]; onChange: (next: Footnote[]) => void; header?: ReactNode })`. `Footnote` comes from `coa-variant-logic.ts`.

- [ ] **Step 1: Run the Default tests to see them pass before the move**

Run: `npx vitest run src/test/analysis-profiles-coa-display.test.tsx`
Expected: all pass.

- [ ] **Step 2: Move the code**

The component owns the Add Footnote button, the rows, and the add, remove, update and move logic, with the same aria labels and test-visible text. `header` renders to the left of the button. The page passes its existing "Footnotes" label and tooltip as `header`, plus `value={form.coa_footnotes}` and `onChange={next => setForm(f => ({ ...f, coa_footnotes: next }))}`, and deletes the four helpers.

- [ ] **Step 3: Run the Default tests to see them still pass, unchanged**

Run: `npx vitest run src/test/analysis-profiles-coa-display.test.tsx`
Expected: all pass, with no edit to the test file.

- [ ] **Step 4: Commit**

```bash
sed -i 's/\r$//' src/components/hplc/FootnoteListEditor.tsx
git -c core.autocrlf=true add src/components/hplc/FootnoteListEditor.tsx src/components/hplc/AnalysisProfilesPage.tsx
git -c core.autocrlf=true commit -m "refactor(mk1): shared footnote list editor" -- src/components/hplc/FootnoteListEditor.tsx src/components/hplc/AnalysisProfilesPage.tsx
```

### Task 7: The version editor card body

**Files:**
- Create: `src/components/hplc/CoaVariantEditor.tsx`
- Test: `src/components/hplc/__tests__/CoaVariantEditor.test.tsx`

**Interfaces:**
- Consumes: `coa-variant-logic.ts` (Task 5), `FootnoteListEditor` (Task 6), `listServiceSpecs` from `@/lib/api`.
- Produces:
  ```ts
  export interface CoaVariantEditorProps {
    draft: VariantDraft; onChange: (next: VariantDraft) => void
    defaults: CoaDefaults
    savedMemberIds: number[]; membersLoading: boolean
    services: Pick<AnalysisServiceRecord, 'id' | 'title'>[]
    dirty: boolean; saving: boolean
    onSave: () => void; onCancel: () => void
    onStop?: () => void  // existing versions only
    onAddRule: (serviceId: number) => void
  }
  export function CoaVariantEditor(props: CoaVariantEditorProps): JSX.Element
  ```

- [ ] **Step 1: Write the failing tests**

Render through a small stateful harness that holds the draft, inside a `QueryClientProvider` with `retry: false`. Mock `listServiceSpecs` per service id. Members are Arsenic (1) and Lead (2). The Default is the `DEFAULTS` from Task 5.

```tsx
it('shows the Default text tagged under Same as default', async () => {
  renderEditor()
  expect(within(row('Sample prep')).getByText('Hot block digestion')).toBeVisible()
  expect(within(row('Sample prep')).getByText('Default')).toBeVisible()
  expect(within(row('Section title')).getByText('Heavy Metals')).toBeVisible()
})
it('says when the Default is blank', () => {
  renderEditor({ defaults: { ...DEFAULTS, coa_prep_text: null } })
  expect(within(row('Sample prep')).getByText('The Default is blank, so nothing prints')).toBeVisible()
})
it('labels the limit fields and gives the title no Leave off', () => {
  renderEditor()
  expect(within(row('Basis note')).getByText('describes the limits')).toBeVisible()
  expect(within(row('Footnotes')).getByText('describes the limits')).toBeVisible()
  expect(within(row('Section title')).queryByRole('radio', { name: /Leave off/ })).toBeNull()
})
it('Leave off explains itself, and clicking the active choice keeps it', async () => {
  renderEditor()
  await pick('Sample prep', 'Leave off')
  expect(within(row('Sample prep')).getByText('Not printed on Nasal Spray COAs')).toBeVisible()
  await pick('Sample prep', 'Leave off')
  expect(within(row('Sample prep')).getByText('Not printed on Nasal Spray COAs')).toBeVisible()
})
it('Custom prefills, and typed text survives switching away and back', async () => {
  renderEditor()
  await pick('Sample prep', 'Custom')
  const box = within(row('Sample prep')).getByRole('textbox')
  expect(box).toHaveValue('Hot block digestion')
  await user.clear(box); await user.type(box, 'Diluted')
  await pick('Sample prep', 'Leave off'); await pick('Sample prep', 'Custom')
  expect(within(row('Sample prep')).getByRole('textbox')).toHaveValue('Diluted')
})
it('blocks Save on blank Custom text, with the message', async () => {
  renderEditor({ dirty: true })
  await pick('Sample prep', 'Custom')
  await user.clear(within(row('Sample prep')).getByRole('textbox'))
  expect(screen.getByText('Type the text, or choose Leave off')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Save Nasal Spray text' })).toBeDisabled()
})
it('keeps Save disabled until something changed', () => {
  renderEditor({ dirty: false })
  expect(screen.getByRole('button', { name: 'Save Nasal Spray text' })).toBeDisabled()
})
it('hides the guard line while both limit fields are on Same as default', async () => {
  specsFor({ 1: [formRule], 2: [formRule] })
  renderEditor()
  await waitFor(() => expect(listServiceSpecs).toHaveBeenCalledTimes(2))
  expect(screen.queryByTestId('coa-variant-guard')).toBeNull()
})
it('is green when every member has a rule', async () => {
  specsFor({ 1: [formRule], 2: [formRule] })
  renderEditor(); await pick('Basis note', 'Leave off')
  expect(await screen.findByText("All 2 services have a Nasal Spray rule, so this version's basis note and footnotes print.")).toBeVisible()
})
it('is amber naming the service, marks overridden limit fields Held, and links to the rule', async () => {
  const onAddRule = vi.fn()
  specsFor({ 1: [], 2: [formRule] })
  renderEditor({ onAddRule }); await pick('Basis note', 'Leave off')
  expect(await screen.findByText(/^Arsenic has no Nasal Spray rule/)).toBeVisible()
  expect(within(row('Basis note')).getByText('Held: the Default prints on a COA that includes Arsenic')).toBeVisible()
  expect(within(row('Footnotes')).queryByText(/^Held:/)).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Add the rule' }))
  expect(onAddRule).toHaveBeenCalledWith(1)
})
it('is never green when a call fails', async () => {
  specsFor({ 1: [formRule], 2: new Error('boom') })
  renderEditor(); await pick('Basis note', 'Leave off')
  expect(await screen.findByText('Could not confirm the Nasal Spray rules.')).toBeVisible()
})
it('is never green with no members', async () => {
  renderEditor({ savedMemberIds: [] }); await pick('Basis note', 'Leave off')
  expect(screen.getByText('Could not confirm the Nasal Spray rules.')).toBeVisible()
})
it('previews what prints, with tags', async () => {
  specsFor({ 1: [], 2: [formRule] })
  renderEditor(); await pick('Basis note', 'Leave off')
  const preview = screen.getByTestId('coa-variant-preview')
  expect(within(preview).getByText('What prints on a Nasal Spray COA')).toBeVisible()
  expect(await within(preview).findByText('Default, held')).toBeVisible()
  expect(within(preview).getByText('Arsenic')).toBeVisible()
})
it('Stop using appears only for existing versions', () => {
  renderEditor({ onStop: undefined })
  expect(screen.queryByRole('button', { name: 'Stop using this version' })).toBeNull()
})
```

These helpers are local to the test file, and Tasks 8 and 9 define their own copies: `renderEditor(overrides)` renders the harness, `specsFor(map)` makes `listServiceSpecs` resolve or reject per service id, `row(label)` finds the element with `data-testid="coa-variant-row-<field>"` by its label, `pick(label, choice)` clicks the radio named `<label>: <choice>`. `formRule` is a `rule({})` from Task 5.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/components/hplc/__tests__/CoaVariantEditor.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `CoaVariantEditor`**

Order from the top: guard line, macro hint (`COA_MACRO_HINT`, `data-testid="coa-variant-macro-hint"`), five field rows, preview, buttons. All copy comes from the logic module or the spec's Profile editor section.
- Rules: `useQueries` over `savedMemberIds` with key `['analysis-services', id, 'specs']` and `queryFn: () => listServiceSpecs(id)`. That key is the one `ServiceSpecsSection` invalidates, and its other readers (`ServiceEndoJudgedPanel`, `EndoResultsBox`, `AnalysisServiceLink`) cache the same raw array, so the entries agree. This component only mounts while a card is open, which gives the spec's "only while an editor is open". Build `MemberRules[]` with names from `services`, falling back to `Service <id>`, then call `memberRuleStatus`.
- Guard line `data-testid="coa-variant-guard"`: shows when `coa_basis_note` or `coa_footnotes` is not `default`. Amber for `held`, green for `ok`, muted for `loading` and `unknown`. One "Add the rule" button per missing service. With several missing, its text is `Add the rule: <name>`. The test above uses one.
- Field row: `ToggleGroup type="single"`, `variant="outline"`, `size="sm"`, `onValueChange={v => { if (v) onChange(setChoice(draft, field, v as FieldChoice, defaults)) }}`. Each `ToggleGroupItem` has `aria-label="<label>: <choice>"`, with choices "Same as default", "Custom" and "Leave off" (`canLeaveOff` only).
- Under the control: Same as default shows the Default's text grayed with a "Default" `Badge` (the title uses `coa_section_title || name`). Custom shows `Input maxLength={200}` for title and basis note, `Textarea` for method and prep, `FootnoteListEditor` for footnotes, then the `draftErrors` message. Leave off shows `Not printed on <form> COAs`. `heldNote(status)` shows under an overridden limit field.
- Preview `data-testid="coa-variant-preview"`: caption `What prints on a <form> COA`, then the pieces of `buildPreview` with a `Badge` tag each (a piece with no text shows its `missing` label, and no footnotes shows `no footnotes`), then the saved members as rows with a dash for the result, then `{lod} fills in from each sample's results` when `macroNote`.
- Buttons: `Save <form> text` (disabled when `!dirty`, `saving`, or `draftErrors` is non-empty), Cancel, and `Stop using this version` when `onStop` is set.

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run src/components/hplc/__tests__/CoaVariantEditor.test.tsx`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
sed -i 's/\r$//' src/components/hplc/CoaVariantEditor.tsx src/components/hplc/__tests__/CoaVariantEditor.test.tsx
git -c core.autocrlf=true add src/components/hplc/CoaVariantEditor.tsx src/components/hplc/__tests__/CoaVariantEditor.test.tsx
git -c core.autocrlf=true commit -m "feat(mk1): COA text version editor with guard line and preview" -- src/components/hplc/CoaVariantEditor.tsx src/components/hplc/__tests__/CoaVariantEditor.test.tsx
```

### Task 8: The section: cards, add form, save, stop

**Files:**
- Create: `src/components/hplc/ProfileCoaVariantsSection.tsx`
- Test: `src/components/hplc/__tests__/ProfileCoaVariantsSection.test.tsx`

**Interfaces:**
- Consumes: `CoaVariantEditor` (Task 7), `useProfileCoaVariants` and the API functions (Task 5), `useSampleForms` from `@/services/sample-forms`, `SampleFormIcon` and `SampleFormIconById`, `useUIStore.navigateToAnalysisService`.
- Produces:
  ```ts
  export function ProfileCoaVariantsSection(props: {
    profile: AnalysisProfile
    savedMemberIds: number[]; membersLoading: boolean
    services: Pick<AnalysisServiceRecord, 'id' | 'title'>[]
    onDirtyChange: (dirty: boolean) => void
  }): JSX.Element
  ```

- [ ] **Step 1: Write the failing tests**

Mock `@/lib/api-profile-coa-variants`, `@/lib/api-sample-forms` (`listSampleForms`) and `listServiceSpecs`, and spy on `window.confirm`. Forms: Pen (id 3), Nasal Spray (id 4), Capsule (id 5, inactive). Saved version: Nasal Spray with `coa_basis_note: ''`, `coa_prep_text: 'Diluted'`.

```tsx
it('lists each version with its summary and an intro line', async () => {
  renderSection()
  expect(await screen.findByText('Overrides: basis note left off, prep custom')).toBeVisible()
  expect(screen.getByText('Every sample prints the Default text above. A form listed here prints its own version instead, field by field.')).toBeVisible()
})
it('the picker lists active forms with no version', async () => {
  renderSection(); await openPicker()
  expect(screen.getByRole('option', { name: /Pen/ })).toBeVisible()
  expect(screen.queryByRole('option', { name: /Nasal Spray/ })).toBeNull()
  expect(screen.queryByRole('option', { name: /Capsule/ })).toBeNull()
})
it('keeps a version whose form was deactivated', async () => {
  formsAre([{ ...NASAL_FORM, active: false }, PEN])
  renderSection()
  expect(await screen.findByText('Nasal Spray')).toBeVisible()
})
it('a new form writes nothing until Save, then POSTs all five fields', async () => {
  renderSection(); await pickForm('Pen')
  expect(createProfileCoaVariant).not.toHaveBeenCalled()
  await pick('Sample prep', 'Leave off')
  await user.click(screen.getByRole('button', { name: 'Save Pen text' }))
  expect(createProfileCoaVariant).toHaveBeenCalledWith(1, {
    sample_form_id: 3, coa_section_title: null, coa_basis_note: null,
    coa_method_text: null, coa_prep_text: '', coa_footnotes: null,
  })
})
it('Save on an existing version PATCHes all five fields, null for Same as default', async () => {
  renderSection(); await openCard('Nasal Spray')
  await pick('Sample prep', 'Same as default')
  await user.click(screen.getByRole('button', { name: 'Save Nasal Spray text' }))
  expect(patchProfileCoaVariant).toHaveBeenCalledWith(11, {
    coa_section_title: null, coa_basis_note: '', coa_method_text: null,
    coa_prep_text: null, coa_footnotes: null,
  })
})
it('opening another card keeps the first card edits and its Unsaved tag', async () => {
  renderSection(); await openCard('Nasal Spray'); await pick('Method', 'Leave off')
  await pickForm('Pen')
  expect(within(card('Nasal Spray')).getByText('Unsaved')).toBeVisible()
  expect(within(card('Nasal Spray')).getByText(/method left off/)).toBeVisible()
  await openCard('Nasal Spray')
  expect(within(row('Method')).getByText('Not printed on Nasal Spray COAs')).toBeVisible()
})
it('Cancel drops the edits and closes the card', async () => {
  renderSection(); await openCard('Nasal Spray'); await pick('Method', 'Leave off')
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(within(card('Nasal Spray')).queryByText('Unsaved')).toBeNull()
  expect(within(card('Nasal Spray')).getByText('Overrides: basis note left off, prep custom')).toBeVisible()
})
it('a failed save keeps the card, the edits and the tag, and shows the server message', async () => {
  vi.mocked(patchProfileCoaVariant).mockRejectedValueOnce(new Error('unknown COA text macro {lot}; supported: {lod}'))
  renderSection(); await openCard('Nasal Spray'); await pick('Method', 'Leave off')
  await user.click(screen.getByRole('button', { name: 'Save Nasal Spray text' }))
  expect(toast.error).toHaveBeenCalledWith('unknown COA text macro {lot}; supported: {lod}')
  expect(within(row('Method')).getByText('Not printed on Nasal Spray COAs')).toBeVisible()
  expect(within(card('Nasal Spray')).getByText('Unsaved')).toBeVisible()
})
it('Stop using asks first, then PATCHes active false', async () => {
  confirmReturns(false); renderSection(); await openCard('Nasal Spray')
  await user.click(screen.getByRole('button', { name: 'Stop using this version' }))
  expect(window.confirm).toHaveBeenCalledWith('Stop using the Nasal Spray version? Nasal Spray COAs go back to the Default text. Published COAs stay as they are until they are regenerated.')
  expect(patchProfileCoaVariant).not.toHaveBeenCalled()
  confirmReturns(true)
  await user.click(screen.getByRole('button', { name: 'Stop using this version' }))
  expect(patchProfileCoaVariant).toHaveBeenCalledWith(11, { active: false })
})
it('Add the rule asks first when there are unsaved edits', async () => {
  specsFor({ 1: [] })
  renderSection(); await openCard('Nasal Spray'); await pick('Method', 'Leave off')
  confirmReturns(false)
  await user.click(await screen.findByRole('button', { name: 'Add the rule' }))
  expect(useUIStore.getState().analysisServiceTargetId).toBeNull()
  confirmReturns(true)
  await user.click(screen.getByRole('button', { name: 'Add the rule' }))
  expect(useUIStore.getState().analysisServiceTargetId).toBe(1)
})
it('reports dirty to the page', async () => {
  const onDirtyChange = vi.fn()
  renderSection({ onDirtyChange }); await openCard('Nasal Spray')
  expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  await pick('Method', 'Leave off')
  expect(onDirtyChange).toHaveBeenLastCalledWith(true)
})
```

Helpers, local to the file: `card(name)` maps the name to its form id and finds `data-testid="coa-variant-card-<formId>"`. `openCard(name)` clicks Edit in that card. `openPicker()` clicks Add form and opens the Select. `pickForm(name)` does that and picks the option. `formsAre(list)` sets what `listSampleForms` resolves. `confirmReturns(bool)` sets the `window.confirm` spy. `renderSection(overrides)` renders with profile id 1, saved member 1 and service Arsenic, inside a `QueryClientProvider` with `retry: false`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/components/hplc/__tests__/ProfileCoaVariantsSection.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

- Heading "COA text by sample form", the intro line, and an "Add form" button. Same `border-t pt-5 space-y-4` wrapper as Members.
- State: `drafts: Record<string, VariantDraft>` keyed `v<id>` or `new-<formId>`, and one `openKey`. Opening a card seeds its draft once with `draftFromVariant`, and an existing draft is kept. A closed card with a draft shows the draft's summary, `summaryLine(draftToWire(draft))`.
- Cards: active variants in server order, then new drafts. Each shows `SampleFormIconById` (for a new draft, the picked form's id), the name, the summary, an "Unsaved" `Badge` when dirty, and Edit (hidden while open). Each card has `data-testid="coa-variant-card-<formId>"`.
- Picker: copy the inline `Select` at ServiceSpecsSection.tsx:438-460, fed by `useSampleForms()`, filtered to `active` forms with no active version and no open new draft. Picking creates `newDraft(form.id, form.name)` and opens it. See `ServiceSpecsSection.test.tsx` for driving the Radix Select in jsdom.
- Save: the Create or Patch with `draftToWire(draft)`. On success: toast `<form> text saved`, drop the draft, close the card, invalidate `profileCoaVariantKeys.forProfile(profile.id)`. On failure: `toast.error(message)`, and keep everything.
- Cancel: drop the draft and close the card. A new card disappears.
- Stop: `window.confirm` with the exact text, then PATCH `{ active: false }`, drop the draft, invalidate.
- Dirty: `anyDirty` over all drafts via `isDraftDirty`. `useEffect` calls `onDirtyChange(anyDirty)`. "Add the rule" asks through `window.confirm` when `anyDirty`, with `UNSAVED_VERSION_PROMPT`, the same message as the panel close, then calls `navigateToAnalysisService`.
- `defaults` is `profile`, so inherited and prefilled text always come from the saved row.

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run src/components/hplc/__tests__/ProfileCoaVariantsSection.test.tsx`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
sed -i 's/\r$//' src/components/hplc/ProfileCoaVariantsSection.tsx src/components/hplc/__tests__/ProfileCoaVariantsSection.test.tsx
git -c core.autocrlf=true add src/components/hplc/ProfileCoaVariantsSection.tsx src/components/hplc/__tests__/ProfileCoaVariantsSection.test.tsx
git -c core.autocrlf=true commit -m "feat(mk1): COA text by sample form section" -- src/components/hplc/ProfileCoaVariantsSection.tsx src/components/hplc/__tests__/ProfileCoaVariantsSection.test.tsx
```

### Task 9: Wire it into the profile panel

**Files:**
- Modify: `src/components/hplc/AnalysisProfilesPage.tsx`
- Test: `src/test/analysis-profiles-coa-variants.test.tsx` (mocks modeled on `src/test/analysis-profiles-coa-display.test.tsx:9-90`, plus `@/lib/api-profile-coa-variants` and `@/lib/api-sample-forms`)

**Interfaces:**
- Consumes: `ProfileCoaVariantsSection` (Task 8), `useProfileCoaVariants`, `overrideLine`, `COA_MACRO_HINT`, `UNSAVED_VERSION_PROMPT`.

- [ ] **Step 1: Write the failing tests**

```tsx
it('heads the block Default text, with one line per form that overrides something', async () => {
  await openProfile()
  expect(await screen.findByRole('heading', { name: 'Default text' })).toBeVisible()
  expect(await screen.findByText('Nasal Spray overrides basis note and prep')).toBeVisible()
})
it('shows the section between Save Changes and Members, in edit mode only', async () => {
  await openProfile()
  const section = await screen.findByRole('heading', { name: 'COA text by sample form' })
  const save = screen.getByRole('button', { name: 'Save Changes' })
  const members = screen.getByRole('heading', { name: 'Members' })
  expect(save.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(section.compareDocumentPosition(members) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})
it('is absent on the create panel', async () => {
  await openCreate()
  expect(screen.queryByRole('heading', { name: 'COA text by sample form' })).toBeNull()
})
it('closing with unsaved version edits asks; cancelling keeps the panel and the edits', async () => {
  await openProfile(); await dirtyTheCard(); confirmReturns(false)
  await user.click(closeButton())
  expect(window.confirm).toHaveBeenCalledWith(UNSAVED_VERSION_PROMPT)
  expect(screen.getByText('Edit: Heavy Metals')).toBeVisible()
  expect(screen.getByText('Unsaved')).toBeVisible()
})
it('closing with no unsaved edits does not ask', async () => {
  await openProfile()
  await user.click(closeButton())
  expect(window.confirm).not.toHaveBeenCalled()
  expect(screen.queryByText('Edit: Heavy Metals')).toBeNull()
})
it('after Save Changes with the prompt cancelled, the cards show the new Default', async () => {
  vi.mocked(updateAnalysisProfile).mockResolvedValue({ ...PROFILE, coa_method_text: 'New method' })
  await openProfile(); await dirtyTheCard(); confirmReturns(false)
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() => expect(window.confirm).toHaveBeenCalled())
  expect(screen.getByText('Edit: Heavy Metals')).toBeVisible()
  expect(within(row('Method')).getByText('New method')).toBeVisible()
})
it('an unsaved Members edit does not change the guard line; Save Members does', async () => {
  // Saved member: Arsenic, which has a rule. Lead has none.
  await openProfile(); await pick('Basis note', 'Leave off')
  expect(await screen.findByText(/^The 1 service has a Nasal Spray rule/)).toBeVisible()
  await addMember('Lead')
  expect(screen.getByText(/^The 1 service has a Nasal Spray rule/)).toBeVisible()
  await user.click(screen.getByRole('button', { name: /Save Members/ }))
  expect(await screen.findByText(/^Lead has no Nasal Spray rule/)).toBeVisible()
})
```

`dirtyTheCard()` opens the Nasal Spray card and picks Sample prep: Leave off. Method stays on Same as default, so the Save Changes test can read the inherited Default in that row. `closeButton()` is the button named "Close panel". `openProfile()` and `openCreate()` open the panel from the list, as in `analysis-profiles-coa-display.test.tsx`. `addMember(name)` adds a service through the Members search without saving.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/test/analysis-profiles-coa-variants.test.tsx`
Expected: FAIL, heading not found.

- [ ] **Step 3: Implement in `AnalysisProfilesPage.tsx`**

- Rename today's `closePanel` to `resetPanel` (body unchanged, plus `setSavedMemberIds([])` and `variantEditsDirty.current = false`). Add `const closePanel = () => { if (variantEditsDirty.current && !window.confirm(UNSAVED_VERSION_PROMPT)) return; resetPanel() }`. `const variantEditsDirty = useRef(false)` is a ref so `handleSave`'s closure reads the latest value.
- `handleDelete` (line 410) calls `resetPanel`, because the profile is gone. `handleSave`, the overlay's `onClick` and the header X keep `closePanel`. The header X has no accessible name today: give it `aria-label="Close panel"`. Task 6 moved the lines after 486, so the anchors below are by content.
- `handleSave`, edit branch: `const saved = await updateAnalysisProfile(...)`, then `setEditingProfile(saved)` before `refreshProfiles()` and `closePanel()`.
- `const [savedMemberIds, setSavedMemberIds] = useState<number[]>([])`. Set it from `memberIds` in `openEdit`, and from `deduped` in `handleSaveMembers` after the PUT succeeds. Do not derive it from `selectedOrder`.
- `const { data: coaVariants = [] } = useProfileCoaVariants(editingProfile?.id ?? null)`.
- COA display block (the `<div>` holding `data-testid="coa-macro-hint"`): add a heading `Default text` (`<h4 className="text-sm font-semibold">`) above the macro hint, then one `<p className="text-xs text-muted-foreground">` per non-null `overrideLine(v)`. Render the hint from `COA_MACRO_HINT`.
- After the `{/* Save profile button */}` block, before the `{/* Membership editor` comment:
  ```tsx
  {editingProfile && (
    <ProfileCoaVariantsSection
      key={editingProfile.id}
      profile={editingProfile}
      savedMemberIds={savedMemberIds}
      membersLoading={loadingMembers}
      services={allServices}
      onDirtyChange={handleVariantsDirty}
    />
  )}
  ```
  `handleVariantsDirty` is a `useCallback` that writes the ref.

- [ ] **Step 4: Run the new tests and every existing profile page test**

Run: `npx vitest run src/test/analysis-profiles-coa-variants.test.tsx src/test/analysis-profiles-coa-display.test.tsx src/test/analysis-profiles-fulfillment.test.tsx src/test/analysis-profiles-help-guide.test.tsx src/test/analysis-profiles-ride-hosts.test.tsx src/test/coa-method-text-suggest.test.tsx`
Expected: all pass. The older files do not mock the new API module, so its fetch fails and the section shows no cards. That must not break them. If it does, add the mock to those files; do not change their assertions.

- [ ] **Step 5: Commit**

```bash
sed -i 's/\r$//' src/test/analysis-profiles-coa-variants.test.tsx
git -c core.autocrlf=true add src/components/hplc/AnalysisProfilesPage.tsx src/test/analysis-profiles-coa-variants.test.tsx
git -c core.autocrlf=true commit -m "feat(mk1): COA text versions in the profile panel" -- src/components/hplc/AnalysisProfilesPage.tsx src/test/analysis-profiles-coa-variants.test.tsx
```

### Task 10: Gates and rehearsal on Postgres

Unit tests run on SQLite and jsdom. This task proves what they cannot: the table on Postgres, the cascade, the real route responses, a rendered certificate, and the panel in a browser. Nothing is pushed.

**Files:**
- Create: `C:\tmp\coavar-verified.md` (outside the repo, the PR's `## Verified` block)

- [ ] **Step 1: Frontend gates**

Run: `npm run typecheck`, then `npx eslint` and `npx prettier --check` on every file this branch touches, then `npx vitest run`.
Expected: typecheck clean, no new lint or format findings on touched files (the repo as a whole has baseline findings, so `check:all` is not the gate), and the failed-file set matches `origin/master`'s. Known load flakes pass when run alone.

- [ ] **Step 2: Frontend image build**

```bash
docker build --platform linux/amd64 --build-arg ENV_FILE=.env.production -t mk1-frontend-buildcheck:local -f Dockerfile .
docker image rm mk1-frontend-buildcheck:local
```
Expected: the build succeeds.

- [ ] **Step 3: Backend failure-set diff**

Restore `mk1_scratch` fresh before each run. Run the full suite on `origin/master`, then on the branch, one at a time, with `git archive <sha> backend .claude/skills/mk1-publish-document` unpacked into the container and `python -m pytest tests -q -p no:cacheprovider -W ignore -rfE`. Then:
```bash
comm -13 base.failed branch.failed
```
on the sorted `^(FAILED|ERROR) tests/` lines with messages stripped. Expected: empty.

- [ ] **Step 4: Mount the branch on the stack**

Stage with `git ls-files -z -co --exclude-standard | tar -cz --null -T - | ssh forrestparker@100.73.137.3 'mkdir -p ~/worktrees/Accu-Mk1-coavar && tar -xz -C ~/worktrees/Accu-Mk1-coavar'`, then `./bin/accumark-stack mount coavar --mk1 ~/worktrees/Accu-Mk1-coavar`. Expected: the backend boots and `\d analysis_profile_coa_variants` in `accumark_mk1` shows the partial unique index `uq_analysis_profile_coa_variants_form ... WHERE active` and the FK with `ON DELETE CASCADE`.

- [ ] **Step 5: Seed and smoke the deployed routes**

Copy the rehearsal scripts from `Accumark-Workspace/sample-forms-release/rehearsal/scripts/` to the devbox and use `api.sh`, `seed.sh` and `results.sh` (the golden has no heavy metals services and no sample types; see the memory note `reference_native_coa_stack_rehearsal_recipe`). Over HTTP:
- POST a Nasal Spray version with `coa_prep_text`, `coa_basis_note: ""`, `coa_footnotes: []`. Expected: 201, and the body includes `sample_form_name` (the response model trap).
- POST it again. Expected: 409 with the exact detail.
- Create a throwaway profile with a version, DELETE the profile. Expected: 204, the variant row is gone, and `catalog_change_log` has its `delete` row.

- [ ] **Step 6: Build and render a nasal and a powder certificate**

Run `sections.py` in the backend container for one nasal sample and one powder sample. Expected: nasal has the version's prep, `basis_note` null and `footnotes` empty. Powder has the default text. Remove the Nasal Spray rule from one metal: nasal keeps the version's prep, prints the default basis note and footnotes, and the backend log has `native_section_variant_limits_guard`. Then `coab_render.py` and `pdftoppm -f 2 -l 2 -png` for both, and look at the pages. Expected: the nasal page shows no empty gap where the basis note and footnotes were.

- [ ] **Step 7: Walk the panel in a browser**

Forward the stack's frontend to the laptop (`ssh -N -L <port>:localhost:<port> forrestparker@100.73.137.3`) and use the built-in browser on `http://localhost:<port>`, signing in with the stack's own test account from `accumark-stack creds coavar`, without printing it. On Analysis Profiles, open the seeded Heavy Metals profile and walk it against the mockup: Add form, each choice on each field, guard line green and amber, "Add the rule", Save, Unsaved tag, Cancel, Stop using, closing with unsaved edits. Check for console errors. Take a screenshot of the open card.

- [ ] **Step 8: Write the evidence, hold the push**

Write `C:\tmp\coavar-verified.md` with the stack name, the SHA, the test results and the screenshot and certificate evidence, in the shape `.github/workflows/pr-evidence.yml` requires. Report to the Handler. Do not push. On their word: merge `origin/master` in again (CI requires it on an open PR, and master will have moved), rerun the targeted tests, push, open the PR against `master` with that block, and bind it. Destroy the stack only after the PR merges (`./bin/accumark-stack destroy coavar --yes`).

---

## After the build (needs the Handler, not part of the tasks)

From the spec's Rollout. Deploy with the `accumark-deploy` skill after lab hours; it owns the version bump.

1. Ship Mk1 only. No COA Builder, IS or WP release.
2. Josh adds the Heavy Metals / Nasal Spray version: his prep wording, basis note Leave off, footnotes Leave off, method Same as default or Custom. No seed data.
3. Build one nasal and one powder sample's sections read-only on prod, in a transaction that is rolled back. Confirm each prints what it should before anyone regenerates a nasal COA.
4. The four 10-30 nasal COAs (PB-1084, PB-1083, PB-1082, P-5401) are correct as published, and may be regenerated only after step 3.
