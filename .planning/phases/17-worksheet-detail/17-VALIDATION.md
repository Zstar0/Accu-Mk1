---
phase: 17
slug: worksheet-detail
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-01
---

# Phase 17 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 17-01-01 | 01 | 1 | WSHT-01 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 17-01-02 | 01 | 1 | WSHT-02 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 17-02-01 | 02 | 1 | WSHT-03 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 17-02-02 | 02 | 1 | WSHT-04 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 17-03-01 | 03 | 2 | WSHT-05 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 17-03-02 | 03 | 2 | WSHT-06 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 17-04-01 | 04 | 2 | WSHT-07 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 17-04-02 | 04 | 2 | WSHT-08 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Test stubs for worksheet drawer components
- [ ] Test stubs for new backend endpoints (complete, reassign)
- [ ] Shared fixtures for worksheet mock data

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| FAB visible on all pages | WSHT-01 | Visual/layout verification | Navigate to 3+ different pages, confirm clipboard FAB in bottom-right |
| Drawer slide animation | WSHT-01 | Animation timing | Click FAB, verify smooth slide-out from right |
| DnD add samples | WSHT-05 | Drag interaction | Open mini inbox, drag card to worksheet items list |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
