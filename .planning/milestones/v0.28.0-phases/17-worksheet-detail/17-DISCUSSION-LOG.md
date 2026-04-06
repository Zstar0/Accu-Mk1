# Phase 17: Worksheet Detail - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-01
**Phase:** 17-worksheet-detail
**Areas discussed:** Detail view format, Floating clipboard, Navigation

---

## Detail View Format

| Option | Description | Selected |
|--------|-------------|----------|
| Standalone page | Full page at /worksheet-detail route | |
| Floating drawer overlay | Slide-out drawer accessible from any page via FAB | ✓ |
| Tab in inbox page | Detail as a tab alongside inbox | |

**User's choice:** Floating drawer overlay
**Notes:** User explicitly described wanting "a floating icon in the bottom right that looks like a clipboard" that "can work on any page of the site giving quick access to the worksheet items." This is the primary UX innovation for Phase 17.

---

## Key Decisions from User

- FAB with clipboard icon, bottom-right, visible on every page
- Opens current worksheet as overlay/drawer
- Works on any page — global app-shell feature
- Same item format as sidebar but with more actions (notes, add, reassign, complete)

## Claude's Discretion

- Drawer width and animation
- FAB badge design
- Mini inbox modal implementation
- Completed worksheet visibility

## Deferred Ideas

None
