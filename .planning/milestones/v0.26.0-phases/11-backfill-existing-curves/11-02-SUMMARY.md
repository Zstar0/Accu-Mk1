---
phase: 11
plan: 02
subsystem: hplc-calibration
tags: [calibration, edit-form, backfill, vendor, source-sample-id]
requires: [11-01]
provides: ["Extended CalibrationRow edit form with source_sample_id and vendor fields"]
affects: []
tech-stack:
  added: []
  patterns: ["Conditional view-mode render for optional metadata fields"]
key-files:
  created: []
  modified:
    - src/components/hplc/CalibrationPanel.tsx
decisions:
  - "vendor displayed in view mode below the stats grid (before notes) rather than inline in header row — keeps header clean, consistent with notes rendering pattern"
  - "source_sample_id already rendered in header row Sample field — Task 3 targeted vendor only for the new conditional block"
metrics:
  duration: "~2 min"
  completed: "2026-03-18"
---

# Phase 11 Plan 02: CalibrationRow Edit Form — Source Sample ID + Vendor Summary

Extended the CalibrationRow edit form with `source_sample_id` (font-mono) and `vendor` text inputs in a 2-col grid, wired to `handleSave` and `startEditing`, with conditional view-mode display of vendor.

## Objective

Add Source Sample ID and Vendor fields to CalibrationRow so lab staff can backfill existing curves by linking a standard sample ID (which triggers chromatogram auto-fetch on save) and recording vendor provenance.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Add editSourceSampleId + editVendor state, wire startEditing + handleSave | 38a26d2 | CalibrationPanel.tsx |
| 2 | Add Source Sample ID and Vendor input fields to edit form JSX (2-col grid) | 2c3e156 | CalibrationPanel.tsx |
| 3 | Display vendor in view mode (conditional render) | c581d58 | CalibrationPanel.tsx |

## What Was Built

**CalibrationPanel.tsx — CalibrationRow component:**

- Two new `useState` declarations: `editSourceSampleId` and `editVendor`
- `startEditing` initializes both from `calibration.source_sample_id ?? ''` and `calibration.vendor ?? ''`
- `handleSave` sends `source_sample_id: editSourceSampleId.trim() || null` and `vendor: editVendor.trim() || null` to `updateCalibration`
- Edit form: 2-column grid with Source Sample ID (font-mono, placeholder `P-0111`) and Vendor inputs, placed between Instrument/Analyte and Notes sections
- View mode: vendor shown conditionally below the stats grid using the same `border-t` block pattern as notes; `source_sample_id` was already rendered in the header row Sample field

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| vendor in view mode goes below stats grid (not inline in header) | Header row already crowded; vendor is secondary metadata, consistent with notes rendering pattern |
| source_sample_id Task 3 only added vendor block | source_sample_id was already conditionally rendered in the header Sample field — no duplication needed |

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written, with one clarification: Task 3's `source_sample_id` display was already present in the header row (`calibration.source_sample_id || linkedAnalyte?.sample_id`). Only the `vendor` conditional block was added to satisfy the task, avoiding duplicate rendering.

## Verification

All checks passed:
- `grep` confirms state declarations, startEditing init, handleSave inclusion, Label text, Input bindings, view mode display
- `npx tsc --noEmit` — zero errors

## Self-Check: PASSED
