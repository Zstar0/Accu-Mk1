---
name: mk1-publish-document
description: Publish an HTML page (a Claude artifact, a converted SOP, any report) into the Accu-Mk1 Documents library so it is listed under Reports → Documents and viewable in the app. Use when asked to "save this to Mk1", "publish this artifact to Accumark", "add this SOP to the library", or to push a new revision of an existing document code. Read-only otherwise; never edits Mk1 code.
---

# Publish a document to Accu-Mk1

One script, stdlib only: `scripts/publish_document.py`.

## Steps

1. Build the page as usual (artifact fragment or full HTML).
2. Dry run first — shows the payload:
   `python .claude/skills/mk1-publish-document/scripts/publish_document.py PAGE.html --title "..." --category ART --description "..." --dry-run`
3. Publish (needs `MK1_API_BASE_URL` and `ACCUMK1_INTERNAL_SERVICE_TOKEN` in the environment; both already exist on prod and the stacks — never paste the token into chat):
   `python .claude/skills/mk1-publish-document/scripts/publish_document.py PAGE.html --title "..." --category ART --space <slug> --description "..." --session <claude session id>`
4. Report the printed `CODE rN id=… open: #reports/documents?id=…` line to the Handler.

## Rules

- `--category` is the prefix (`ART`, `SOP`) or the category name. Categories are managed in Mk1 Settings → Documents.
- `--space` is the slug of the space the document belongs to (default `general`). Spaces decide who can read the document; categories decide what kind it is. A revision (`--code`) always stays in its space; an admin moves it from the viewer. If the server answers `400 space 'x' is not allowed for this agent`, the token's allow-list on prod needs the slug added (Handler, `MK1_DOCUMENT_AGENT_TOKENS` third segment); do not retry with another space.
- Re-publishing with `--code ART-0012` creates the **next revision** and retires the previous active one. Identical bytes are a no-op (the server answers 200 with the existing revision).
- SOPs and anything awaiting review: add `--draft`; an admin activates in Mk1, or re-run with the code and no `--draft`.
- On this machine bare `python` can hang; run the script with the backend venv interpreter `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe`, or any Python 3.9+ (stdlib only).
- The script refuses to publish if the page contains obviously secret-shaped strings (AWS/Stripe/GitHub/Slack tokens, private-key blocks, bearer tokens, `password=`). It is a speed bump, not a control — DB URLs with inline passwords and bare hex tokens are not caught; read the page before publishing.
- The house theme (`backend/documents/accumark-docs.css`, v2) is inlined by the SERVER when the document is created; a page that already carries an `accumark-docs` marker is left as is. Send the page as written: plain semantic markup using the components below, NO `<style>` of your own and no colors or fonts of your own. Page CSS wins over the theme, so private CSS is exactly what makes a document drift from the house look.
- Session id: pass `--session` with the current Claude Code session id (it is the folder name inside the scratchpad path) so the library records provenance.
- Author: pass `--author` with the name of the PERSON who asked for the document, not the agent. It is what the list and the document header show. The agent's identity is already captured by `--session`.

## How documents should look (accumark-docs v2)

The house look is the AccuVerify Integration Guide: Poppins headings, Open Sans body, JetBrains Mono metadata, a teal accent, light and dark themes handled by the theme. Build pages from these classes and nothing else.

| Need | Markup |
|---|---|
| Page column | `<main>` (one 840px reading column). Long docs: `<div class="shell"><nav class="toc">...</nav><main>...</main></div>` |
| Header | `<header class="top"><p class="eyebrow">Accumark Labs · Topic</p><h1>Title</h1><p class="lede">One or two sentences.</p><ul class="meta"><li><b>Updated</b> 2026-10-09</li></ul></header>` |
| Section | `<section><h2>Heading</h2><p>...</p></section>`; sub-heads `<h3>` |
| Big divider | `<div class="part"><div class="part-head"><p class="eyebrow">Part 1</p><h2>Title</h2><p>Intro</p></div>...sections...</div>` |
| Numbered steps | `<ol class="steps"><li>Do this.</li></ol>` (teal-ringed number circles) |
| Checklist | `<ul class="check"><li>Item</li></ul>`; `<li class="done">` for a ticked box |
| Callouts | `<div class="note"><strong>Title</strong><span>Body</span></div>`; add `warn`, `stop` or `ok` (amber, red, green). The first `<strong>` is the title; use `<b>` for bold inside the body |
| Cards | `<div class="paths"><div class="path-card"><span class="k">Path A</span><h3>Title</h3><p>Text</p><a class="go" href="#x">Link &rarr;</a></div></div>` |
| Two options | `<div class="split"><div class="opt"><h4>A. Name</h4><span class="sub">One line</span>...</div></div>` |
| Flow | `<div class="flow"><div><b>Stage</b>What happens<span class="w">where</span></div></div>` (auto-numbered) |
| Label rows | `<div class="facts"><div><b>Label</b><span>Value</span></div></div>` |
| KPI tiles | `<div class="kpis"><div class="kpi"><span class="label">On time</span><span class="value">56%</span><span class="sub">lab 58%</span></div></div>`; `value bad` / `value good` color the number |
| Status chips | `<span class="chip crit">High</span>`; also `ser`, `warn`, `good`, `info`; wrap a row in `<div class="chips">` |
| UI names | `<span class="ui">Save</span>`, primary button `<span class="ui primary">Install Now</span>`, menu path `<span class="crumb">Plugins<span>&rsaquo;</span>Add New</span>` |
| Tables | `<div class="tablewrap"><table>...</table></div>`; wide reports `<table class="wide">` |
| Code | `<code>` inline, `<pre><code>` blocks, `<kbd>` keys |
| SOP control block | `<dl class="doc-control"><div><dt>Code</dt><dd>SOP-0001</dd></div></dl>` |
| Long prose (SOPs) | `<article class="prose">` around plain HTML |
| Footer | `<footer>Sources, caveats</footer>` |

Rules: sentence case headings; no em dashes; no emoji; no inline `style=` colors. If a page needs something these do not cover, ask the Handler before inventing a style, so the component can be added to the theme for everyone.
