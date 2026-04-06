# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v0.28.0 — Worksheet Feature

**Shipped:** 2026-04-06
**Phases:** 4 | **Plans:** 12 | **Files:** 74 changed (+16,290 / -492)

### What Was Built
- Service Groups admin system with M2M membership editor
- Received Samples Inbox with priority queue, aging timers, SLA color coding, bulk actions
- Worksheet Detail drawer with item management, reassignment, completion
- Worksheets List page with live KPI stats, status/analyst filters
- Method-instrument M2M relationships with bulk assignment
- UX polish: drag-and-drop, clickable sample IDs, prep status color coding

### What Worked
- Fast execution: 4 phases in ~5 days, clean plan-to-execution pipeline
- Drawer pattern for worksheet detail kept navigation simple (no full page context switch)
- Staging worksheet pattern (__inbox_staging__) cleanly solved bulk pre-assignment before worksheet exists
- Stale data guard on worksheet creation caught real edge cases

### What Was Inefficient
- SENAITE analyst field turned out to be read-only after initial plan assumed push capability — required pivot to local-only assignment (Phase 15-04)
- Several post-execution fixes needed for edge cases (drag overlay snapping, scroll, collision guards) suggesting UX testing could be more thorough during planning

### Patterns Established
- Worksheet drawer pattern (FAB + Sheet) for detail views within list context
- Service group color badges as visual grouping pattern across inbox and worksheet views
- Aging timer with SLA color thresholds (green/yellow/orange/red) as reusable component

### Key Lessons
1. Verify SENAITE field writability early — read-only fields can't be discovered from API docs alone, need actual PUT test
2. Drag-and-drop UX needs explicit grip handle restriction and overlay positioning — defaults are poor
3. KPI stats derived from existing query data (no separate endpoint) keeps architecture simple

### Cost Observations
- Model mix: ~70% sonnet (execution), ~30% opus (planning/orchestration)
- Notable: Phase 18 (Worksheets List) completed in a single plan — well-scoped phase

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Change |
|-----------|--------|-------|------------|
| v0.28.0 | 4 | 12 | Drawer pattern for detail views, local-first assignment model |

### Top Lessons (Verified Across Milestones)

1. Verify external API field writability before planning push operations
2. Single-plan phases are efficient when scope is naturally tight
