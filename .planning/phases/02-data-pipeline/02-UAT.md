---
status: complete
phase: 02-data-pipeline
source: [02-01-SUMMARY.md, 02-02-SUMMARY.md, 02-03-SUMMARY.md, 02-05-SUMMARY.md, 02-06-SUMMARY.md, 02-07-SUMMARY.md]
started: 2026-01-16T15:10:00Z
completed: 2026-01-16T15:35:00Z
---

## Current Test

number: complete
name: All tests passed
expected: N/A
awaiting: N/A

## Tests

### 1. Settings UI Access
expected: Open Preferences (gear icon), navigate to "Data Pipeline" pane. You should see fields for Report Directory and Column Mappings.
result: PASS
notes: Required backend to be running first (pip install -r requirements.txt, then uvicorn)

### 2. Settings Save/Load
expected: Enter a report directory path (e.g., "C:\Reports"), save, close preferences, reopen - the value should persist.
result: PASS

### 3. File Selection UI
expected: Main window shows FileSelector component. Click "Select Files" or drag-drop area to choose .txt files.
result: PASS

### 4. File Preview
expected: After selecting a .txt file (tab-delimited HPLC export), click Preview. A table displays with column headers and data rows.
result: PASS

### 5. Batch Import
expected: With preview showing, click Import. Toast notification shows success/failure. Files imported as Job with Samples.
result: PASS
notes: Required new /import/batch-data endpoint to accept parsed data from browser (browser can't send file paths)

### 6. Backend Health Check
expected: With backend running on port 8009, visit http://127.0.0.1:8009/health - returns {"status": "ok", "version": "0.1.0"}.
result: PASS

### 7. Settings API
expected: GET http://127.0.0.1:8009/settings returns list of all settings including report_directory, column_mappings.
result: PASS

### 8. Jobs API
expected: After importing files, GET http://127.0.0.1:8009/jobs returns list with your import job.
result: PASS

### 9. File Watcher Start
expected: Configure report_directory in settings to an existing folder. POST http://127.0.0.1:8009/watcher/start - watcher starts monitoring that directory.
result: PASS
notes: Required upgrading watchdog to 6.0.0 for Python 3.13 compatibility

### 10. File Watcher Detection
expected: With watcher running, drop a .txt file into the watched directory. GET http://127.0.0.1:8009/watcher/files returns the new file path.
result: PASS
notes: Watcher stops on uvicorn reload - needs restart after code changes

### 11. Calculate Sample
expected: With imported samples and calibration settings configured, POST http://127.0.0.1:8009/calculate/{sample_id} returns calculation results including purity.
result: PASS
notes: Required adding column mapping transformation in CalculationEngine

## Summary

total: 11
passed: 11
issues: 0
pending: 0
skipped: 0

## Gaps

None - all tests passed.

## Fixes Applied During UAT

1. **Backend not running** - User must start backend manually with `uvicorn main:app --port 8009 --reload`
2. **watchdog compatibility** - Upgraded from 4.0.0 to 6.0.0 for Python 3.13 support
3. **Browser file import** - Added `/import/batch-data` endpoint to accept pre-parsed data (browsers can't send file paths)
4. **Database schema** - Deleted old database to recreate with updated schema (input_data column)
5. **Column mappings** - Added `_apply_column_mappings()` to CalculationEngine to transform raw column names to internal names
