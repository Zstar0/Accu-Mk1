# Phase 16: Received Samples Inbox - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-01
**Phase:** 16-received-samples-inbox
**Areas discussed:** Inbox architecture, Analyst source, Expandable rows, Priority system, Aging timer, Bulk actions, Worksheet creation

---

## Analyst Source

| Option | Description | Selected |
|--------|-------------|----------|
| SENAITE LabContacts | Pull from SENAITE API | |
| AccuMark local users | Use AccuMark's user table | ✓ |

**User's choice:** AccuMark local users
**Notes:** Decided during Phase 15 live testing — SENAITE Analyst field is read-only. User stated "we should just use our user list in accumk1" and confirmed long-term SENAITE phaseout direction.

---

## Key Decisions from User's Original Spec

All major architectural decisions were provided in the user's detailed spec at milestone creation:
- 30s polling interval
- Expandable rows with service group grouping
- Priority levels (normal/high/expedited)
- SLA aging timer with 4-tier color coding
- Bulk toolbar pattern
- Stale data guard on worksheet creation
- Pages under HPLC Automation nav

---

## Claude's Discretion

- Table column widths and responsive behavior
- Loading/error/empty state designs
- Worksheet creation dialog styling
- Whether to show sample count on nav item

## Deferred Ideas

- Auto-suggest tech assignments (WAUT-01)
- Auto-prioritize nearing SLA (WAUT-02)
- SENAITE state change notifications (WAUT-03)
