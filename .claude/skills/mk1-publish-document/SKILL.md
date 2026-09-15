---
name: mk1-publish-document
description: Publish an HTML page (a Claude artifact, a converted SOP, any report) into the Accu-Mk1 Documents library so it is listed under Reports → Documents and viewable in the app. Use when asked to "save this to Mk1", "publish this artifact to Accumark", "add this SOP to the library", or to push a new revision of an existing document code. Read-only otherwise; never edits Mk1 code.
---

# Publish a document to Accu-Mk1

One script, stdlib only: `scripts/publish_document.py`.

## Steps

1. Build the page as usual (artifact fragment or full HTML).
2. Dry run first — proves the theme inlines and shows the payload:
   `python .claude/skills/mk1-publish-document/scripts/publish_document.py PAGE.html --title "..." --category ART --description "..." --dry-run`
3. Publish (needs `MK1_API_BASE_URL` and `ACCUMK1_INTERNAL_SERVICE_TOKEN` in the environment; both already exist on prod and the stacks — never paste the token into chat):
   `python .claude/skills/mk1-publish-document/scripts/publish_document.py PAGE.html --title "..." --category ART --description "..." --session <claude session id>`
4. Report the printed `CODE rN id=… open: #reports/documents?id=…` line to the Handler.

## Rules

- `--category` is the prefix (`ART`, `SOP`) or the category name. Categories are managed in Mk1 Settings → Documents.
- Re-publishing with `--code ART-0012` creates the **next revision** and retires the previous active one. Identical bytes are a no-op (the server answers 200 with the existing revision).
- SOPs and anything awaiting review: add `--draft`; an admin activates in Mk1, or re-run with the code and no `--draft`.
- On this machine bare `python` can hang; run the script with the backend venv interpreter `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe`, or any Python 3.9+ (stdlib only).
- The script refuses to publish if the page contains obviously secret-shaped strings (AWS/Stripe/GitHub/Slack tokens, private-key blocks, bearer tokens, `password=`). It is a speed bump, not a control — DB URLs with inline passwords and bare hex tokens are not caught; read the page before publishing.
- The theme (`src/docs-theme/accumark-docs.css`) is inlined once; a page that already carries an `accumark-docs` marker is left as is.
- Session id: pass `--session` with the current Claude Code session id (it is the folder name inside the scratchpad path) so the library records provenance.
