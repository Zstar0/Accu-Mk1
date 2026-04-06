# Phase 15: Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-31
**Phase:** 15-foundation
**Areas discussed:** Service Group Admin Placement, Group Color System, Nav Structure, SENAITE Analyst Assignment, Data Model

---

## Service Group Admin Placement

| Option | Description | Selected |
|--------|-------------|----------|
| Tab on AnalysisServicesPage | Add as tab alongside existing services table | |
| Separate LIMS sub-item | Own nav entry under LIMS section | ✓ |
| Section within hplc-analysis | Under HPLC Automation with worksheets | |

**User's choice:** Separate LIMS sub-item (recommended — service groups are a cross-cutting admin concept)
**Notes:** Auto-selected. Follows existing pattern where each admin entity (Instruments, Methods, Peptides, Analysis Services) has its own sub-item.

---

## Group Color System

| Option | Description | Selected |
|--------|-------------|----------|
| Predefined palette | 8-10 named Tailwind color keys | ✓ |
| Free-form color picker | User chooses any hex color | |

**User's choice:** Predefined palette (recommended — ensures visual consistency across inbox and worksheets)
**Notes:** Auto-selected. Colors map to Tailwind badge classes for consistent rendering.

---

## Navigation Structure

| Option | Description | Selected |
|--------|-------------|----------|
| Under hplc-analysis | Add Inbox + Worksheets as sub-items of HPLC Automation | ✓ |
| Own top-level section | Worksheets gets its own sidebar section | |

**User's choice:** Under hplc-analysis (per user spec: "should live in the HPLC Automation section of Nav")
**Notes:** Directly specified by user in milestone context.

---

## SENAITE Analyst Assignment

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse existing update pattern | Same httpx POST to /update/{uid} as method-instrument | ✓ |
| New dedicated endpoint pattern | Custom SENAITE API call | |

**User's choice:** Reuse existing update pattern (per user spec referencing main.py lines 9892-9950)
**Notes:** Username vs UID format must be verified in this phase.

---

## Claude's Discretion

- Slide-out panel layout details
- Loading/error state patterns
- Nav item icon choices
- Whether service groups is a LIMS sub-item or section within Analysis Services page

## Deferred Ideas

None
