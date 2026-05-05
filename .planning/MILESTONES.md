# Milestones

Historical record of shipped milestones.

| Version | Name | Shipped | Phases | Plans | Archive |
|---------|------|---------|--------|-------|---------|
| v0.28.0 | Worksheet Feature | 2026-04-06 | 4 | 12 | [→](milestones/v0.28.0-ROADMAP.md) |
| v0.26.0 | Standard Sample Preps & Calibration Curve Chromatograms | 2026-03-20 | 8 | 17 | [→](milestones/v0.26.0-ROADMAP.md) |
| v0.12.0 | Analysis Results & Workflow Actions | 2026-02-25 | 3 | 8 | [→](milestones/v0.12.0-ROADMAP.md) |
| v0.11.0 | New Analysis Wizard | 2026-02-20 | 5 | 9 | [→](milestones/v0.11.0-new-analysis-wizard.md) |

---

## v0.28.0 — Worksheet Feature (Shipped: 2026-04-06)

**Phases:** 4 (15–18) | **Plans:** 12 | **Files changed:** 74 | **Lines:** +16,290 / -492

**Key accomplishments:**

- Service Groups admin system with M2M membership editor and SENAITE analyst proxy
- Received Samples Inbox with priority queue, aging timers, SLA color coding, and bulk actions
- Worksheet Detail drawer with item management, reassignment, and completion workflow
- Worksheets List page with live KPI stats, status/analyst filters, and drill-through navigation
- Method-instrument M2M relationships with bulk assignment and auto-fill
- UX polish: drag-and-drop grip handles, clickable sample IDs, prep status color coding

---

## v0.26.0 — Standard Sample Preps & Calibration Curve Chromatograms (Shipped: 2026-03-20)

**Phases:** 8 (09, 10, 10.5, 11, 12, 13, 13.5, 14) | **Plans:** 17

Note: 10.5 and 13.5 were inserted during execution; phase 14 directory exists but never received plan files (work was completed under earlier phases). Backfilled retroactively from `ROADMAP.md` history (commit `8f3a589^`).

**Key accomplishments:**

- CalibrationCurve schema, standard prep flag in wizard, standard badge + filter
- Auto-create curves from completed standard HPLC runs with full provenance
- Backfill UI for existing curves: link Sample ID, fetch chromatogram from SharePoint, edit metadata
- HPLC results persistence: provenance enrichment of `hplc_analyses` rows, chromatogram storage
- Same-method identity check via standard injection RT extraction
- Side-by-side chromatogram comparison in HPLC flyout
- HPLC audit trail with debug log, source file checksums, visible warnings

---

## v0.12.0 — Analysis Results & Workflow Actions (Shipped: 2026-02-25)

**Phases:** 3 (06–08) | **Plans:** 8

**Key accomplishments:**

- Data foundation: uid/keyword model, backend result endpoints, AnalysisTable component extraction
- Click-to-edit result cells with inline editing
- State-aware per-row action menus for all four SENAITE workflow transitions (submit, verify, retract, reject) with sample-level refresh
- Bulk selection via checkboxes with floating batch action toolbar and sequential bulk processing
