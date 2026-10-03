# Document Annotations, Comments, and Edit Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Accu-Mk1 Documents viewer plannotator-style anchored comments, suggestions, quick labels, image attachments, a contents sidebar, agent participation through the API and the lab MCP, and an admin edit mode that saves as a revision.

**Architecture:** Two new Postgres tables (`document_comments`, `document_comment_attachments`) behind a new `/api/documents/...` comment router; a vendored MIT bridge script injected into the existing sandboxed `srcdoc` iframe at render time, talking to a new parent-side `useDocumentBridge` hook over validated postMessage; a right-hand comments panel built from Mk1's own UI kit; four new tools in `labmanager-mcp`; and three fenced bridge extensions (headings, edit mode, serialize/apply) that let an admin edit text natively and save it as the next draft revision.

**Tech Stack:** FastAPI + SQLAlchemy 2 (Postgres prod, SQLite tests), React 19.2 + Vite 7 + Tailwind 4 + TanStack Query 5 + radix/shadcn kit, vitest 4 + jsdom + Testing Library, Playwright, FastMCP (labmanager-mcp), `perfect-freehand` (the one new dependency).

**Spec:** `docs/superpowers/specs/2026-10-03-document-annotations-design.md` (committed on this branch as `7b5827e0`). Read it first; every task below cites the section it implements.

## Global Constraints

- Branch `feat/document-annotations`, worktree `C:/tmp/mk1-doc-annotations`, base `origin/master` v1.31.2 (`e5852180`). Commit with `git -C C:/tmp/mk1-doc-annotations commit -F <msgfile> -- <paths>`; never a bare `git commit -a`.
- Four PRs in order: Part 1 backend, Part 2 viewer, Part 3 MCP, Part 4 edit mode. Each part ends in a gate task. Do not start Part 4 before Part 2 has been proven on a devbox stack.
- Backend tests: ONE pytest process at a time (two suites deadlock on the shared dev Postgres). Gate on the failure-set diff against master, never on zero failures; the baseline has known failures.
- Frontend: `npm` only, never pnpm. `npm run check:all` is the gate (typecheck, eslint, ast-grep, prettier, rust, vitest). New files are LF. `backend/database.py` is CRLF; this plan does not touch it.
- No `lims_` prefix on the new tables. The documents router keeps its `/api` prefix (`APIRouter(prefix="/api")`), so every path in this plan carries `/api`.
- `DocumentOut` and `_doc_out` must BOTH name every new field, or FastAPI's `response_model` silently drops it.
- Vendored plannotator files live only under `src/vendor/plannotator/`, carry `LICENSE-MIT`, and are listed in `VENDORED.md` with upstream tag `v0.27.25` (`@plannotator/ui` 0.49.0, `@plannotator/core` 0.25.9). Every local change to a vendored file is fenced `// accumark: <name>` … `// /accumark`.
- The iframe sandbox stays exactly `sandbox="allow-scripts"`. Nothing in this plan adds `allow-same-origin`, popups, or top navigation.
- Spec caps, exact: quote 400 chars, selector 1024, tag 64, label 64, 16 additional targets, element context 2048 bytes, whole anchor 16384 bytes, attachment 10 MB, heading text 130 chars, 500 headings, serialized HTML 16 MB, ids 256 chars, draft selection text 10000 chars.
- Actors: any logged-in user or a per-agent `X-Service-Token` may comment and resolve; the bare internal service token is 403 on every comment route; editing or deleting a comment body is author or admin; `PUT …/content` and Apply are admin **user** only (an `AgentWriter` is 403).
- Secrets never enter the repo, the vault, or chat. Agent tokens are env on the hosts.

## Review Focus

Five inputs the spec implies but no happy-path test covers. Each has a pinned test in the owning task.

1. **A quote whose rendered text differs from its HTML source** (`&amp;`, `&nbsp;`, curly quotes). An agent quotes what it read; verification must compare unescaped, whitespace-collapsed text or every such quote is a false 400. Pinned in Task 2 (`test_quote_occurs_unescapes_entities_and_nbsp`).
2. **A drag selection longer than 400 characters.** The server rejects it; the composer must say so and disable Save instead of letting the user type a comment that cannot be posted. Pinned in Task 12 (`CommentComposer` over-cap test).
3. **A hostile document posting an absurd `resize` height** or a non-finite one. The hook must clamp to a sane range so the page does not grow a 10-million-pixel frame. Pinned in Task 11 (`clamps resize heights`).
4. **Leaving the viewer with unsaved edits** (revision select, Back, list click). The guard must ask before discarding. Pinned in Task 19 (`asks before leaving with unsaved edits`).
5. **A pinpoint on an element with no text** (an image or an SVG). The anchor has an element selector and an empty quote; the validator must accept it, and the panel must render the card without a quote line. Pinned in Task 2 (`test_anchor_with_element_and_empty_quote_is_valid`) and Task 13 (`renders an element-only card without a quote`).

## File Structure

**Backend (Part 1, Part 4):**
- `backend/documents/models.py` — add `DocumentComment`, `DocumentCommentAttachment`.
- `backend/documents/errors.py` — add `ForbiddenError`.
- `backend/documents/anchors.py` — NEW: anchor validator (upstream caps), HTML text extraction, quote verification.
- `backend/documents/labels.py` — NEW: the label catalog constant.
- `backend/documents/comments.py` — NEW: comment service (actors, create, list + numbering, patch, delete, status, attachments, linking, counts).
- `backend/documents/comment_export.py` — NEW: markdown export and the cross-document index.
- `backend/documents/comment_attachments_gc.py` — NEW: orphan sweep.
- `backend/documents/comment_routes.py` — NEW: `APIRouter(prefix="/api")` with every comment route; included in `main.py` BEFORE the documents router.
- `backend/documents/schemas.py` — add comment schemas; `DocumentOut.open_comment_count`.
- `backend/documents/routes.py` — `_doc_out` gains `open_comment_count`; `_http` maps `ForbiddenError`; Part 4 adds `PUT /documents/{doc_id}/content`.
- `backend/documents/service.py` — `delete_document` also removes the draft's comments; Part 4 adds `replace_draft_content`.
- `backend/main.py` — include the comment router; register the GC sweep.
- Tests: `backend/tests/test_documents_comments_models.py`, `test_documents_anchors.py`, `test_documents_comment_labels.py`, `test_documents_comments.py`, `test_documents_comment_attachments.py`, `test_documents_comment_export.py`, `test_documents_content_replace.py`.

**Frontend (Part 2, Part 4):**
- `src/vendor/plannotator/` — `LICENSE-MIT`, `VENDORED.md`, `bridge-script.ts`, `html-anchor.ts`, `srcdoc.ts`, `image-annotator/{index,Canvas,Toolbar}.tsx`, `image-annotator/{types,utils,strokeHistory}.ts`, `__tests__/html-anchor.test.ts`, `__tests__/bridge-harness.ts`, `__tests__/bridge-headings.test.ts`, `__tests__/bridge-edit-mode.test.ts`, `__tests__/bridge-asset.test.ts`.
- `scripts/build-bridge-asset.mts` — NEW: writes `public/pn-bridge.v1.js` from `BRIDGE_SCRIPT`.
- `public/pn-bridge.v1.js` — generated, committed.
- `src/lib/api-document-comments.ts` — NEW: types + fetchers.
- `src/services/document-comments.ts` — NEW: TanStack hooks.
- `src/components/documents/annotations/` — NEW: `useDocumentBridge.ts`, `bridge-messages.ts` (types + validators), `stripViewerInjection.ts`, `SelectionToolbar.tsx`, `CommentComposer.tsx`, `CommentsPanel.tsx`, `CommentCard.tsx`, `ContentsTab.tsx`, `EditModeBar.tsx` (Part 4), `__tests__/*`.
- `src/components/flags/CommentBody.tsx` — optional `resolveAttachmentUrl` prop.
- `src/components/documents/DocumentViewer.tsx` — layout, header toggles, injection, panel wiring, Part 4 edit mode.
- `src/components/documents/DocumentsPage.tsx` — Comments column.
- `src/lib/api-documents.ts` — `open_comment_count` on `DocumentRow`; Part 4 `replaceDraftContent`.
- Config: `eslint.config.js`, `.prettierignore`, `knip.json`, `sgconfig.yml`, `package.json` (dep + script).
- `e2e/documents-annotations.spec.ts` — Part 4.

**MCP (Part 3):** `labmanager-mcp/src/labmanager_mcp/tools/documents.py`, `tests/test_tools_documents.py`, `tests/test_server.py`.

---

# Part 1 — Backend (PR 1)

Everything in Part 1 runs against the SQLite in-memory engine. The one Postgres-only risk, JSONB plus CASCADE plus CHECK, is proven on a stack in Task 7. Run pytest from `C:/tmp/mk1-doc-annotations/backend` with the main checkout's venv: `C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest …`. Call that `$PY` below.

### Task 1: Models and the forbidden error

**Files:**
- Modify: `backend/documents/models.py` (append after `Document`)
- Modify: `backend/documents/errors.py`
- Create: `backend/tests/test_documents_comments_models.py`

**Interfaces:**
- Produces: `documents.models.DocumentComment`, `documents.models.DocumentCommentAttachment` (columns per spec §4.1, §4.2), `documents.errors.ForbiddenError`.
- Note: these are NEW tables, so boot's `create_all` creates them on prod exactly as it created `documents`. No `_run_migrations` entry is needed; that list is for ALTERs on existing tables.

- [ ] **Step 1: Write the failing model test**

```python
# backend/tests/test_documents_comments_models.py
"""document_comments / document_comment_attachments shape (spec 2026-10-03 §4)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import documents.models  # noqa: F401
    from documents import service, storage
    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    storage.set_storage_for_tests(storage.InMemoryDocumentStorage())
    service.seed_categories(s)
    doc, _ = service.create_document(
        s, title="A", html="<html><head><style>/* accumark-docs v1 */</style></head><body>x</body></html>",
        category=service.resolve_category(s, category="ART"), author="F")
    s.doc = doc
    yield s
    s.close()


def _comment(db, **over):
    from documents.models import DocumentComment
    row = DocumentComment(code=db.doc.code, document_id=db.doc.id, kind="comment",
                          body="hi", author_user_id=1)
    for k, v in over.items():
        setattr(row, k, v)
    db.add(row)
    db.commit()
    return row


def test_minimal_comment_persists_with_defaults(db):
    row = _comment(db)
    assert (row.status, row.kind, row.parent_id, row.anchor, row.label) == ("open", "comment", None, None, None)
    assert row.created_at and row.updated_at and row.edited_at is None


def test_anchor_round_trips_as_json(db):
    anchor = {"originalText": "x", "htmlAnchor": {"selector": "p", "tagName": "p"}}
    row = _comment(db, anchor=anchor)
    db.expire_all()
    from documents.models import DocumentComment
    assert db.get(DocumentComment, row.id).anchor == anchor


@pytest.mark.parametrize("over", [
    {"author_user_id": 1, "author_agent": "jarvis"},            # two authors
    {"author_user_id": None, "author_agent": None},             # no author
    {"kind": "suggestion", "suggested_text": None},             # suggestion needs text
    {"kind": "comment", "suggested_text": "x"},                 # comment may not carry text
    {"status": "closed"},                                       # bad status
    {"kind": "redline"},                                        # bad kind
])
def test_check_constraints_reject(db, over):
    with pytest.raises(IntegrityError):
        _comment(db, **over)
    db.rollback()


def test_attachment_row_persists_unlinked(db):
    from documents.models import DocumentCommentAttachment
    att = DocumentCommentAttachment(code=db.doc.code, comment_id=None, uploaded_by_user_id=1,
                                    filename="a.png", content_type="image/png", size_bytes=3,
                                    storage_key="documents/ART-0001/x.png")
    db.add(att)
    db.commit()
    assert att.id and att.comment_id is None


def test_forbidden_error_exists():
    from documents.errors import ForbiddenError
    assert issubclass(ForbiddenError, Exception)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd C:/tmp/mk1-doc-annotations/backend && $PY -m pytest tests/test_documents_comments_models.py -q`
Expected: FAIL, `ImportError: cannot import name 'DocumentComment'`.

- [ ] **Step 3: Add the models and the error**

Append to `backend/documents/models.py` (add `JSON` to the sqlalchemy import and `from sqlalchemy.dialects.postgresql import JSONB` below it):

```python
class DocumentComment(Base):
    """One comment or reply on a controlled document (spec 2026-10-03 §4.1).
    Identity is the CODE: comments outlive revisions and re-anchor by quoted
    text at render time. `document_id` records the revision it was made on;
    a discarded draft takes its comments with it (CASCADE)."""
    __tablename__ = "document_comments"
    __table_args__ = (
        CheckConstraint("kind IN ('comment','suggestion')", name="ck_document_comments_kind"),
        CheckConstraint("status IN ('open','resolved')", name="ck_document_comments_status"),
        # Exactly one author: a login OR a named agent token, never both, never neither.
        CheckConstraint("(author_user_id IS NULL) <> (author_agent IS NULL)",
                        name="ck_document_comments_one_author"),
        # A suggestion carries replacement text; a comment never does.
        CheckConstraint("(kind = 'suggestion') = (suggested_text IS NOT NULL)",
                        name="ck_document_comments_suggestion_text"),
        Index("ix_document_comments_code_status", "code", "status"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    document_id: Mapped[int] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True)
    parent_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("document_comments.id", ondelete="CASCADE"), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(12), nullable=False, default="comment")
    anchor: Mapped[Optional[dict]] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"), nullable=True)
    label: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    body: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    suggested_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    author_user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
    author_agent: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="open",
                                        server_default="open")
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    resolved_by_user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
    resolved_by_agent: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow,
                                                 onupdate=datetime.utcnow, nullable=False)
    edited_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    def __repr__(self) -> str:
        return f"<DocumentComment(id={self.id}, code='{self.code}', kind='{self.kind}', status='{self.status}')>"


class DocumentCommentAttachment(Base):
    """An image attached to a comment (spec §4.2). Same lifecycle as
    flag_attachments: uploaded unlinked, claimed when a saved body references
    `{attachment:ID}`, swept if still unlinked after 24h."""
    __tablename__ = "document_comment_attachments"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    comment_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("document_comments.id", ondelete="CASCADE"), nullable=True, index=True)
    uploaded_by_user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
    uploaded_by_agent: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
```

Append to `backend/documents/errors.py`:

```python
class ForbiddenError(Exception):
    """The actor exists but may not do this (edit another author's comment, etc.)."""
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd C:/tmp/mk1-doc-annotations/backend && $PY -m pytest tests/test_documents_comments_models.py -q`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/mk1-doc-annotations && git add backend/documents/models.py backend/documents/errors.py backend/tests/test_documents_comments_models.py && git commit -m "feat(documents): comment and comment-attachment models" -- backend/documents/models.py backend/documents/errors.py backend/tests/test_documents_comments_models.py
```

---

### Task 2: Anchor validator and quote verification

**Files:**
- Create: `backend/documents/anchors.py`
- Create: `backend/tests/test_documents_anchors.py`

**Interfaces:**
- Produces: `validate_anchor(raw) -> Optional[dict]` (raises `BadRequestError` over any cap), `is_quote_only(anchor) -> bool`, `document_text(html) -> str`, `quote_occurs(quote, html) -> bool`, `normalize(text) -> str`, plus the cap constants `MAX_TEXT=400`, `MAX_SELECTOR=1024`, `MAX_TAG=64`, `MAX_LABEL=64`, `MAX_TARGETS=16`, `MAX_CONTEXT_BYTES=2048`, `MAX_ANCHOR_BYTES=16384`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_documents_anchors.py
"""Anchor caps (spec §5) are the upstream caps in src/vendor/plannotator/html-anchor.ts,
enforced fail-closed; quote verification compares rendered text, not source bytes."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest


def _el(**over):
    d = {"selector": "body > main > p:nth-of-type(2)", "tagName": "p"}
    d.update(over)
    return d


def test_none_is_a_document_level_comment():
    from documents.anchors import validate_anchor
    assert validate_anchor(None) is None


def test_quote_only_anchor_is_valid_and_quote_only():
    from documents.anchors import is_quote_only, validate_anchor
    a = validate_anchor({"originalText": "the lab's calendar day"})
    assert a == {"originalText": "the lab's calendar day"}
    assert is_quote_only(a) is True


def test_dom_anchored_quote_is_not_quote_only_and_unknown_keys_drop():
    from documents.anchors import is_quote_only, validate_anchor
    a = validate_anchor({"originalText": "x", "htmlAnchor": _el(bogus=1), "surprise": True,
                         "elementContext": {"tag": "p", "heading": 'h2 "Rulings"', "evil": "<script>"}})
    assert a == {"originalText": "x", "htmlAnchor": _el(),
                 "elementContext": {"tag": "p", "heading": 'h2 "Rulings"'}}
    assert is_quote_only(a) is False


def test_anchor_with_element_and_empty_quote_is_valid():
    """Review Focus 5: a pinpoint on an image has an element and no text."""
    from documents.anchors import validate_anchor
    a = validate_anchor({"originalText": "", "htmlAnchor": _el(tagName="img", point={"x": 0.4, "y": 0.5})})
    assert a["htmlAnchor"]["point"] == {"x": 0.4, "y": 0.5}


def test_no_quote_and_no_element_is_rejected():
    from documents.anchors import validate_anchor
    from documents.errors import BadRequestError
    with pytest.raises(BadRequestError, match="quoted text or an element anchor"):
        validate_anchor({"originalText": "   "})


@pytest.mark.parametrize("raw, needle", [
    ({"originalText": "q" * 401}, "400"),
    ({"originalText": "q", "htmlAnchor": _el(selector="s" * 1025)}, "1024"),
    ({"originalText": "q", "htmlAnchor": _el(tagName="t" * 65)}, "64"),
    ({"originalText": "q", "htmlAdditionalTargets": [{"text": "t"}] * 17}, "16"),
    ({"originalText": "q", "htmlAdditionalTargets": [{"text": "t", "label": "l" * 65}]}, "64"),
    ({"originalText": "q", "elementContext": {"text": "c" * 2100}}, "2048"),
    ({"originalText": "q", "htmlAnchor": _el(point={"x": "1", "y": 2})}, "finite number"),
    ({"originalText": 5}, "must be a string"),
    ("not an object", "object or null"),
])
def test_caps_are_hard_400s(raw, needle):
    from documents.anchors import validate_anchor
    from documents.errors import BadRequestError
    with pytest.raises(BadRequestError, match=needle):
        validate_anchor(raw)


def test_whole_anchor_byte_budget():
    from documents.anchors import validate_anchor
    from documents.errors import BadRequestError
    big = {"originalText": "q", "htmlAdditionalTargets": [
        {"text": "t" * 400, "label": "l" * 64, "context": {"text": "c" * 600, "outline": "o" * 600}}
    ] * 16}
    with pytest.raises(BadRequestError, match="16384"):
        validate_anchor(big)


HTML = ("<!doctype html><html><head><style>p{color:red}</style></head><body>"
        "<h2>Limits</h2><p>Cd &amp; Pb limits use&nbsp;50% of   spec,\n per <em>USP</em>.</p>"
        "<script>var q = 'never quoted';</script></body></html>")


def test_quote_occurs_unescapes_entities_and_nbsp():
    """Review Focus 1: an agent quotes rendered text; source carries &amp; and &nbsp;."""
    from documents.anchors import quote_occurs
    assert quote_occurs("Cd & Pb limits use 50% of spec", HTML)
    assert quote_occurs("Cd &amp; Pb limits use 50% of spec", HTML)  # copied from source, still fine


def test_quote_occurs_collapses_whitespace_across_inline_tags():
    from documents.anchors import quote_occurs
    assert quote_occurs("of spec, per USP.", HTML)


def test_quote_in_script_or_style_does_not_count():
    from documents.anchors import quote_occurs
    assert not quote_occurs("never quoted", HTML)
    assert not quote_occurs("color:red", HTML)


def test_missing_quote_is_false_and_empty_quote_is_false():
    from documents.anchors import quote_occurs
    assert not quote_occurs("not in the document", HTML)
    assert not quote_occurs("   ", HTML)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd C:/tmp/mk1-doc-annotations/backend && $PY -m pytest tests/test_documents_anchors.py -q`
Expected: FAIL, `ModuleNotFoundError: No module named 'documents.anchors'`.

- [ ] **Step 3: Write the validator**

```python
# backend/documents/anchors.py
"""Anchor validation and quote verification (spec 2026-10-03 §5).

A Python port of the caps in src/vendor/plannotator/html-anchor.ts. Fail closed:
anything over a cap is a BadRequestError, never a silent truncation, so what is
stored is exactly what the viewer can read back.
"""
from __future__ import annotations

import json
import math
import re
from html import unescape
from html.parser import HTMLParser
from typing import Any, Optional

from documents.errors import BadRequestError

MAX_TEXT = 400
MAX_SELECTOR = 1024
MAX_TAG = 64
MAX_LABEL = 64
MAX_TARGETS = 16
MAX_CONTEXT_BYTES = 2048
MAX_ANCHOR_BYTES = 16 * 1024
CONTEXT_KEYS = frozenset({"tag", "id", "classes", "path", "role", "name", "attrs", "text",
                          "outline", "children", "rect", "landmark", "heading", "component",
                          "page"})
_WS = re.compile(r"\s+")


def _utf8_len(obj: Any) -> int:
    return len(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _text(value: Any, cap: int, field: str, *, required: bool) -> Optional[str]:
    if value is None:
        if required:
            raise BadRequestError(f"anchor.{field} is required")
        return None
    if not isinstance(value, str):
        raise BadRequestError(f"anchor.{field} must be a string")
    if len(value) > cap:
        raise BadRequestError(f"anchor.{field} is {len(value)} chars; the cap is {cap}")
    return value


def _point(value: Any) -> Optional[dict]:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise BadRequestError("anchor point must be an object")
    out = {}
    for k in ("x", "y"):
        v = value.get(k)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            raise BadRequestError(f"anchor point.{k} must be a finite number")
        out[k] = float(v)
    return out


def _element_anchor(value: Any, field: str = "htmlAnchor") -> dict:
    if not isinstance(value, dict):
        raise BadRequestError(f"anchor.{field} must be an object")
    selector = _text(value.get("selector"), MAX_SELECTOR, f"{field}.selector", required=True)
    tag = _text(value.get("tagName"), MAX_TAG, f"{field}.tagName", required=True)
    if not selector.strip() or not tag.strip():
        raise BadRequestError(f"anchor.{field} needs a selector and a tagName")
    out: dict = {"selector": selector, "tagName": tag}
    text = _text(value.get("text"), MAX_TEXT, f"{field}.text", required=False)
    if text is not None:
        out["text"] = text
    point = _point(value.get("point"))
    if point is not None:
        out["point"] = point
    return out


def _context(value: Any, field: str = "elementContext") -> dict:
    if not isinstance(value, dict):
        raise BadRequestError(f"anchor.{field} must be an object")
    out = {k: v for k, v in value.items() if k in CONTEXT_KEYS}
    size = _utf8_len(out)
    if size > MAX_CONTEXT_BYTES:
        raise BadRequestError(f"anchor.{field} is {size} bytes; the cap is {MAX_CONTEXT_BYTES}")
    return out


def _target(value: Any, i: int) -> dict:
    field = f"htmlAdditionalTargets[{i}]"
    if not isinstance(value, dict):
        raise BadRequestError(f"anchor.{field} must be an object")
    out: dict = {"text": _text(value.get("text"), MAX_TEXT, f"{field}.text", required=True)}
    label = _text(value.get("label"), MAX_LABEL, f"{field}.label", required=False)
    if label is not None:
        out["label"] = label
    if value.get("anchor") is not None:
        out["anchor"] = _element_anchor(value["anchor"], f"{field}.anchor")
    if value.get("context") is not None:
        out["context"] = _context(value["context"], f"{field}.context")
    return out


def validate_anchor(raw: Any) -> Optional[dict]:
    """None stays None (a document-level comment). Anything else must be a
    PersistedHtmlAnchor within every cap; unknown keys are dropped."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise BadRequestError("anchor must be an object or null")
    text = _text(raw.get("originalText"), MAX_TEXT, "originalText", required=True)
    out: dict = {"originalText": text}
    if raw.get("htmlAnchor") is not None:
        out["htmlAnchor"] = _element_anchor(raw["htmlAnchor"])
    targets = raw.get("htmlAdditionalTargets")
    if targets is not None:
        if not isinstance(targets, list):
            raise BadRequestError("anchor.htmlAdditionalTargets must be a list")
        if len(targets) > MAX_TARGETS:
            raise BadRequestError(
                f"anchor has {len(targets)} additional targets; the cap is {MAX_TARGETS}")
        out["htmlAdditionalTargets"] = [_target(t, i) for i, t in enumerate(targets)]
    if raw.get("elementContext") is not None:
        out["elementContext"] = _context(raw["elementContext"])
    if "htmlAnchor" not in out and not text.strip():
        raise BadRequestError("anchor needs quoted text or an element anchor")
    size = _utf8_len(out)
    if size > MAX_ANCHOR_BYTES:
        raise BadRequestError(f"anchor is {size} bytes; the cap is {MAX_ANCHOR_BYTES}")
    return out


def is_quote_only(anchor: Optional[dict]) -> bool:
    """True for an anchor that must be verified against the document text: a
    quote with no element anchor (the agent path, spec §5)."""
    return anchor is not None and "htmlAnchor" not in anchor


class _TextExtractor(HTMLParser):
    _SKIP = {"script", "style", "template", "noscript"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skip += 1

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def normalize(text: str) -> str:
    """Entities decoded, NBSP and every whitespace run collapsed to one space.
    Both sides of a comparison go through this, so what an agent read in
    rendered text matches the source however it was wrapped or escaped."""
    return _WS.sub(" ", unescape(text).replace("\xa0", " ")).strip()


def document_text(html: str) -> str:
    p = _TextExtractor()
    p.feed(html)
    p.close()
    return normalize(" ".join(p.parts))


def quote_occurs(quote: str, html: str) -> bool:
    q = normalize(quote)
    return bool(q) and q in document_text(html)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd C:/tmp/mk1-doc-annotations/backend && $PY -m pytest tests/test_documents_anchors.py -q`
Expected: all pass (the parametrized cap cases expand to nine).

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/mk1-doc-annotations && git add backend/documents/anchors.py backend/tests/test_documents_anchors.py && git commit -m "feat(documents): anchor validator with upstream caps and quote verification" -- backend/documents/anchors.py backend/tests/test_documents_anchors.py
```

---

### Task 3: Label catalog, the comment router skeleton, and route order

**Files:**
- Create: `backend/documents/labels.py`
- Create: `backend/documents/comment_routes.py` (skeleton: router, actor dependency, labels route)
- Create: `backend/tests/documents_comments_support.py` (shared fixture for Tasks 3–6 and 17)
- Create: `backend/tests/test_documents_comment_labels.py`
- Modify: `backend/documents/schemas.py` (append `CommentLabelOut`)
- Modify: `backend/main.py:128` (import) and `:624` (include BEFORE `documents_router`)

**Interfaces:**
- Produces: `labels.COMMENT_LABELS`, `labels.get_label(id)`, `labels.label_ids()`, `labels.labels_out()`; `comment_routes.router`; `comment_routes.require_comment_actor` returning `comments.Actor` (defined in Task 4; this task defines `Actor`, `actor_from_user`, `actor_from_agent` in a new `backend/documents/comments.py` that Task 4 then fills in).
- `GET /api/documents/comment-labels` → `List[CommentLabelOut]`.

- [ ] **Step 1: Write the shared fixture module**

```python
# backend/tests/documents_comments_support.py
"""Shared fixture for the document-comment test files. Not a test module."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

HTML = ("<!doctype html><html><head><title>t</title><style>/* accumark-docs v1 */</style></head>"
        "<body><h1>Audit</h1><h2>Rulings</h2>"
        "<p>Dedupe on an EXPLICIT code still behaves as before.</p>"
        "<p>Cd &amp; Pb limits use&nbsp;50% of spec.</p>"
        "<script>var x = 'never quoted';</script></body></html>")
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32
JPEG = b"\xff\xd8\xff" + b"0" * 32
GIF = b"GIF89a" + b"0" * 32
WEBP = b"RIFF" + b"0000" + b"WEBP" + b"0" * 32
NOT_IMAGE = b"%PDF-1.4 not an image"
AGENT_TOKEN = "j" * 40
OTHER_AGENT_TOKEN = "t" * 40
INTERNAL_TOKEN = "internal-token"

USER = SimpleNamespace(id=42, role="standard", email="t@x.t", first_name="Tess",
                       last_name="Tech", is_active=True)
OTHER = SimpleNamespace(id=43, role="standard", email="o@x.t", first_name="Olu",
                        last_name=None, is_active=True)
ADMIN = SimpleNamespace(id=1, role="admin", email="admin@x.t", first_name=None,
                        last_name=None, is_active=True)


@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import Base, get_db
    import models  # noqa: F401
    import documents.models  # noqa: F401
    import flags.models  # noqa: F401
    from documents import service, storage
    from documents.comments import actor_from_user
    from documents.comment_routes import require_comment_actor
    from documents.routes import require_document_writer
    from flags import seams as flag_seams

    monkeypatch.setenv("MK1_DOCUMENT_AGENT_TOKENS",
                       f"jarvis:{AGENT_TOKEN},tars:{OTHER_AGENT_TOKEN}")
    monkeypatch.setenv("ACCUMK1_INTERNAL_SERVICE_TOKEN", INTERNAL_TOKEN)
    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    shared = sessionmaker(bind=engine)()
    service.seed_categories(shared)
    storage.set_storage_for_tests(storage.InMemoryDocumentStorage())
    flag_seams.set_attachment_storage_for_tests(flag_seams.InMemoryAttachmentStorage())

    def _db():
        yield shared

    keys = (get_db, get_current_user, require_document_writer, require_comment_actor)
    saved = {k: app.dependency_overrides.get(k) for k in keys}
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: USER
    app.dependency_overrides[require_document_writer] = lambda: ADMIN

    def as_user(u):
        app.dependency_overrides[require_comment_actor] = lambda: actor_from_user(u)

    def real_actor():
        """Drop the override so X-Service-Token / bearer logic really runs."""
        app.dependency_overrides.pop(require_comment_actor, None)

    tc = TestClient(app)
    tc.db = shared
    tc.as_user = as_user
    tc.real_actor = real_actor
    as_user(USER)
    yield tc
    for k, v in saved.items():
        if v is None:
            app.dependency_overrides.pop(k, None)
        else:
            app.dependency_overrides[k] = v
    shared.close()


def publish(client, **over) -> dict:
    """Create ART-0001 (or the next revision when `code` is passed) as ADMIN."""
    body = {"title": "Audit", "html": HTML, "category": "ART", "author": "Forrest Parker"}
    body.update(over)
    r = client.post("/api/documents", json=body)
    assert r.status_code in (200, 201), r.text
    return r.json()


def comment(client, doc_id: int, **over) -> dict:
    body = {"kind": "comment", "body": "Which before?",
            "anchor": {"originalText": "still behaves as before"}}
    body.update(over)
    r = client.post(f"/api/documents/{doc_id}/comments", json=body)
    assert r.status_code == 201, r.text
    return r.json()
```

- [ ] **Step 2: Write the failing labels/route-order test**

```python
# backend/tests/test_documents_comment_labels.py
"""Label catalog (spec §4.3) and the literal-before-parameter route order (spec §6.2)."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from documents_comments_support import client  # noqa: F401,E402


def test_labels_are_served_with_tips(client):
    r = client.get("/api/documents/comment-labels")
    assert r.status_code == 200, r.text  # 422 here means /documents/{doc_id} swallowed the literal path
    ids = [l["id"] for l in r.json()]
    assert ids == ["clarify-this", "verify-this", "out-of-date", "needs-reference", "needs-example",
                   "out-of-scope", "needs-sign-off", "match-format", "nice-work"]
    by_id = {l["id"]: l for l in r.json()}
    assert by_id["verify-this"]["tip"].startswith("This reads as an assumption")
    assert by_id["nice-work"]["tip"] is None
    assert set(by_id["clarify-this"]) == {"id", "emoji", "text", "color", "tip"}


def test_label_lookup_helpers():
    from documents import labels
    assert labels.get_label("needs-tests") is None
    assert "out-of-scope" in labels.label_ids()
    assert labels.get_label("nice-work").emoji == "👍"
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd C:/tmp/mk1-doc-annotations/backend && $PY -m pytest tests/test_documents_comment_labels.py -q`
Expected: FAIL, `ModuleNotFoundError: No module named 'documents.comments'`.

- [ ] **Step 4: Write the catalog, the actor types, the router skeleton, and wire it in**

```python
# backend/documents/labels.py
"""Quick-label catalog (spec 2026-10-03 §4.3). A constant for v1, adapted from
plannotator's DEFAULT_QUICK_LABELS to lab documents. `tip` is the instruction
the export hands to the agent that revises the document. Moving this to
Settings later does not change the route shape."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Optional


@dataclass(frozen=True)
class CommentLabel:
    id: str
    emoji: str
    text: str
    color: str
    tip: Optional[str] = None


COMMENT_LABELS: tuple[CommentLabel, ...] = (
    CommentLabel("clarify-this", "❓", "Clarify this", "yellow",
                 "This passage is ambiguous. Rewrite it so a new technician reads it one way."),
    CommentLabel("verify-this", "🔍", "Verify this", "orange",
                 "This reads as an assumption. Verify it against the method, the instrument "
                 "output, or the data before the next revision, and say what you checked."),
    CommentLabel("out-of-date", "⏳", "Out of date", "amber",
                 "This no longer matches current practice or the current system. Update it to "
                 "what is true today and note the change."),
    CommentLabel("needs-reference", "📎", "Needs reference", "blue",
                 "Cite the SOP, method, specification, or source this statement rests on."),
    CommentLabel("needs-example", "🔬", "Needs example", "cyan",
                 "Too abstract. Add a worked example, sample values, or a specific scenario."),
    CommentLabel("out-of-scope", "🚫", "Out of scope", "red",
                 "This does not belong in this document. Remove it, or move it to the document "
                 "that owns it."),
    CommentLabel("needs-sign-off", "✍️", "Needs sign-off", "purple",
                 "This changes a controlled behaviour. Do not activate until the responsible "
                 "person has approved it."),
    CommentLabel("match-format", "🧬", "Match existing format", "teal",
                 "Follow the structure and vocabulary of the lab's existing SOPs and artifacts "
                 "instead of introducing a new layout."),
    CommentLabel("nice-work", "👍", "Nice work", "green", None),
)
_BY_ID = {label.id: label for label in COMMENT_LABELS}


def get_label(label_id: Optional[str]) -> Optional[CommentLabel]:
    return _BY_ID.get(label_id or "")


def label_ids() -> frozenset[str]:
    return frozenset(_BY_ID)


def labels_out() -> list[dict]:
    return [asdict(label) for label in COMMENT_LABELS]
```

Create `backend/documents/comments.py` with ONLY the actor types for now (Task 4 fills in the rest):

```python
# backend/documents/comments.py
"""Document comments service (spec 2026-10-03 §4, §5, §6). Authorship comes from
the credential, never the body."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class Actor:
    """Who is acting: a logged-in user OR a named agent token. Exactly one of
    user_id / agent is set, mirroring the DB CHECK on document_comments."""
    user_id: Optional[int]
    agent: Optional[str]
    display: str
    is_admin: bool


def display_name(user) -> str:
    """'First Last' when the row has them, else the email."""
    first = (getattr(user, "first_name", None) or "").strip()
    last = (getattr(user, "last_name", None) or "").strip()
    return (f"{first} {last}").strip() or getattr(user, "email", "") or "unknown"


def actor_from_user(user) -> Actor:
    return Actor(user_id=user.id, agent=None, display=display_name(user),
                 is_admin=getattr(user, "role", None) == "admin")


def actor_from_agent(name: str) -> Actor:
    return Actor(user_id=None, agent=name, display=name, is_admin=False)
```

Append to `backend/documents/schemas.py`:

```python
class CommentLabelOut(BaseModel):
    id: str
    emoji: str
    text: str
    color: str
    tip: Optional[str] = None
```

Create `backend/documents/comment_routes.py`:

```python
# backend/documents/comment_routes.py
"""Comment routes for the documents library (spec 2026-10-03 §6).

A SEPARATE router from documents.routes so its literal paths
(/documents/comments, /documents/comment-labels, /documents/comment-attachments/…)
can be included BEFORE /documents/{doc_id}; otherwise FastAPI parses the word
"comments" as a document id and answers 422. main.py includes this router first.
"""
from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth import get_current_user, require_internal_service_token
from database import get_db
from documents import labels
from documents.comments import Actor, actor_from_agent, actor_from_user
from documents.errors import BadRequestError, ConflictError, ForbiddenError, NotFoundError
from documents.routes import _match_agent
from documents.schemas import CommentLabelOut

router = APIRouter(prefix="/api", tags=["document-comments"])
logger = logging.getLogger(__name__)
_optional_bearer = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False)


def require_comment_actor(
    x_service_token: Optional[str] = Header(None),
    token: Optional[str] = Depends(_optional_bearer),
    db: Session = Depends(get_db),
) -> Actor:
    """Any logged-in user, or a per-agent token. The bare internal service token
    has no name and is refused: every comment has an author (spec §6.1)."""
    if x_service_token is not None:
        agent = _match_agent(x_service_token)
        if agent is not None:
            return actor_from_agent(agent)
        require_internal_service_token(x_service_token)  # 401 when it is not that token either
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "comments need a named author: use an agent token or a login")
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "authentication required")
    return actor_from_user(get_current_user(token=token, db=db))


def _http(e: Exception) -> HTTPException:
    if isinstance(e, NotFoundError):
        return HTTPException(status_code=404, detail=str(e))
    if isinstance(e, ForbiddenError):
        return HTTPException(status_code=403, detail=str(e))
    if isinstance(e, ConflictError):
        return HTTPException(status_code=409, detail=str(e))
    if isinstance(e, BadRequestError):
        return HTTPException(status_code=400, detail=str(e))
    if isinstance(e, HTTPException):
        return e
    if isinstance(e, IntegrityError):
        logger.warning("document comments integrity conflict: %s", e)
        return HTTPException(status_code=409, detail="conflicting write; retry")
    logger.exception("unhandled document comments error")
    return HTTPException(status_code=500, detail="internal error")


# --- literal paths FIRST (see module docstring) -----------------------------------------

@router.get("/documents/comment-labels", response_model=List[CommentLabelOut])
def list_comment_labels(user=Depends(get_current_user)):
    return labels.labels_out()
```

In `backend/main.py`, next to line 128 add:

```python
from documents.comment_routes import router as document_comments_router
```

and change line 624 so the comment router is included first:

```python
app.include_router(document_comments_router)  # literal /documents/comments* paths must beat /documents/{doc_id}
app.include_router(documents_router)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd C:/tmp/mk1-doc-annotations/backend && $PY -m pytest tests/test_documents_comment_labels.py tests/test_documents_routes.py -q`
Expected: labels tests pass; the existing documents route tests still pass (route order did not break `/documents/{doc_id}`).

- [ ] **Step 6: Commit**

```bash
cd C:/tmp/mk1-doc-annotations && git add backend/documents/labels.py backend/documents/comments.py backend/documents/comment_routes.py backend/documents/schemas.py backend/main.py backend/tests/documents_comments_support.py backend/tests/test_documents_comment_labels.py && git commit -m "feat(documents): comment label catalog, actor dependency, comment router mounted before /documents/{id}" -- backend/documents/labels.py backend/documents/comments.py backend/documents/comment_routes.py backend/documents/schemas.py backend/main.py backend/tests/documents_comments_support.py backend/tests/test_documents_comment_labels.py
```

---

### Task 4: Comment service and routes (create, list with numbering, replies, edit, delete, resolve)

**Files:**
- Modify: `backend/documents/comments.py` (fill in)
- Modify: `backend/documents/comment_routes.py` (add routes)
- Modify: `backend/documents/schemas.py` (comment schemas, `DocumentOut.open_comment_count`)
- Modify: `backend/documents/routes.py` (`_doc_out` signature, `_http` maps `ForbiddenError`, list/get pass counts)
- Modify: `backend/documents/service.py:428` (`delete_document` purges the draft's comments)
- Create: `backend/tests/test_documents_comments.py`

**Interfaces:**
- Produces (service): `create_comment(db, *, document_id, actor, kind="comment", body="", anchor=None, label=None, suggested_text=None, parent_id=None) -> DocumentComment`; `get_comment(db, comment_id) -> DocumentComment`; `list_comments(db, code, status="open") -> dict` (shape = `CommentListOut`); `patch_comment(db, comment_id, actor, *, body=None, suggested_text=None)`; `delete_comment(db, comment_id, actor) -> None`; `set_status(db, comment_id, actor, status) -> DocumentComment`; `open_comment_counts(db, codes) -> dict[str, int]`; `purge_for_document(db, document_id) -> list[str]` (returns blob keys to delete); `_link_attachments(db, code, comment_id, body)` is a stub here that Task 5 completes.
- Produces (routes): `GET/POST /api/documents/{doc_id}/comments`, `GET /api/documents/comments/{cid}`, `PATCH/DELETE /api/documents/comments/{cid}`, `POST /api/documents/comments/{cid}/resolve|reopen`.
- Produces (schemas): `CommentCreate`, `CommentPatch`, `CommentAttachmentOut`, `CommentOut`, `CommentListOut`; `DocumentOut.open_comment_count: int = 0`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_documents_comments.py
"""Comment lifecycle (spec §4.1, §5, §6.1, §6.2)."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from documents_comments_support import (  # noqa: E402
    ADMIN, AGENT_TOKEN, HTML, INTERNAL_TOKEN, OTHER, OTHER_AGENT_TOKEN, USER, client, comment,
    publish)  # noqa: F401


def test_create_lists_with_stable_numbers_and_author_display(client):
    doc = publish(client)
    a = comment(client, doc["id"])
    b = comment(client, doc["id"], body="second", anchor=None)
    assert (a["number"], b["number"]) == (1, 2)
    assert a["author"] == "Tess Tech" and a["author_user_id"] == 42 and a["author_agent"] is None
    assert a["anchor"] == {"originalText": "still behaves as before"} and b["anchor"] is None
    r = client.get(f"/api/documents/{doc['id']}/comments")
    assert r.status_code == 200
    body = r.json()
    assert [c["number"] for c in body["items"]] == [1, 2]
    assert (body["code"], body["latest_revision"], body["open_count"]) == (doc["code"], 1, 2)


def test_numbers_survive_resolve_and_delete(client):
    doc = publish(client)
    a = comment(client, doc["id"])
    b = comment(client, doc["id"], body="b")
    c = comment(client, doc["id"], body="c")
    assert client.post(f"/api/documents/comments/{a['id']}/resolve").status_code == 200
    assert client.delete(f"/api/documents/comments/{b['id']}").status_code == 204
    items = client.get(f"/api/documents/{doc['id']}/comments?status=all").json()["items"]
    assert [(i["id"], i["number"], i["status"]) for i in items] == [
        (a["id"], 1, "resolved"), (c["id"], 3, "open")]
    assert [i["number"] for i in client.get(f"/api/documents/{doc['id']}/comments").json()["items"]] == [3]


def test_comments_follow_the_code_across_revisions(client):
    r1 = publish(client)
    a = comment(client, r1["id"])
    r2 = publish(client, code=r1["code"], html=HTML.replace("Audit", "Audit v2"))
    assert r2["revision"] == 2
    b = comment(client, r2["id"], body="on r2")
    items = client.get(f"/api/documents/{r2['id']}/comments").json()["items"]
    assert [(i["id"], i["revision"]) for i in items] == [(a["id"], 1), (b["id"], 2)]
    # viewing r1 shows the same list; the anchors re-resolve client-side
    assert [i["id"] for i in client.get(f"/api/documents/{r1['id']}/comments").json()["items"]] == [a["id"], b["id"]]


def test_replies_nest_one_level_and_inherit_nothing(client):
    doc = publish(client)
    a = comment(client, doc["id"])
    reply = comment(client, doc["id"], parent_id=a["id"], body="because", anchor={"originalText": "ignored"})
    assert reply["parent_id"] == a["id"] and reply["anchor"] is None and reply["number"] is None
    r = client.post(f"/api/documents/{doc['id']}/comments",
                    json={"kind": "comment", "body": "deeper", "parent_id": reply["id"]})
    assert r.status_code == 400 and "replies cannot have replies" in r.text
    items = client.get(f"/api/documents/{doc['id']}/comments").json()["items"]
    assert [x["id"] for x in items[0]["replies"]] == [reply["id"]]
    r = client.post(f"/api/documents/comments/{reply['id']}/resolve")
    assert r.status_code == 400 and "top-level" in r.text


def test_suggestion_needs_replacement_and_comment_may_not_carry_one(client):
    doc = publish(client)
    s = comment(client, doc["id"], kind="suggestion", suggested_text="behaves as it did before 09-17",
                body="")
    assert s["kind"] == "suggestion" and s["suggested_text"].startswith("behaves")
    r = client.post(f"/api/documents/{doc['id']}/comments",
                    json={"kind": "suggestion", "body": "x", "anchor": {"originalText": "before"}})
    assert r.status_code == 400 and "suggested_text" in r.text
    r = client.post(f"/api/documents/{doc['id']}/comments",
                    json={"kind": "comment", "body": "x", "suggested_text": "y"})
    assert r.status_code == 400
    r = client.post(f"/api/documents/{doc['id']}/comments", json={"kind": "redline", "body": "x"})
    assert r.status_code == 400


def test_label_only_comment_is_allowed_and_unknown_label_is_400(client):
    doc = publish(client)
    c = comment(client, doc["id"], body="", label="verify-this")
    assert c["label"] == "verify-this" and c["body"] == ""
    r = client.post(f"/api/documents/{doc['id']}/comments", json={"kind": "comment", "body": "", "label": "needs-tests"})
    assert r.status_code == 400 and "label" in r.text
    r = client.post(f"/api/documents/{doc['id']}/comments", json={"kind": "comment", "body": ""})
    assert r.status_code == 400 and "body or a label" in r.text


def test_quote_only_anchor_is_verified_against_the_revision(client):
    doc = publish(client)
    r = client.post(f"/api/documents/{doc['id']}/comments",
                    json={"kind": "comment", "body": "x", "anchor": {"originalText": "words not in the doc"}})
    assert r.status_code == 400
    assert r.json()["detail"] == f'quote not found in {doc["code"]} r1: "words not in the doc"'
    # entities and nbsp in the source do not defeat a quote of the rendered text
    comment(client, doc["id"], anchor={"originalText": "Cd & Pb limits use 50% of spec"})
    # a DOM-anchored quote is trusted (it came from a real Range)
    comment(client, doc["id"], anchor={"originalText": "not verified", "htmlAnchor": {"selector": "p", "tagName": "p"}})


def test_anchor_caps_surface_as_400(client):
    doc = publish(client)
    r = client.post(f"/api/documents/{doc['id']}/comments",
                    json={"kind": "comment", "body": "x", "anchor": {"originalText": "q" * 401}})
    assert r.status_code == 400 and "400" in r.text


def test_missing_document_is_404(client):
    r = client.post("/api/documents/9999/comments", json={"kind": "comment", "body": "x"})
    assert r.status_code == 404


def test_edit_and_delete_are_author_or_admin(client):
    doc = publish(client)
    a = comment(client, doc["id"])
    client.as_user(OTHER)
    assert client.patch(f"/api/documents/comments/{a['id']}", json={"body": "hijack"}).status_code == 403
    assert client.delete(f"/api/documents/comments/{a['id']}").status_code == 403
    # anyone may resolve
    assert client.post(f"/api/documents/comments/{a['id']}/resolve").status_code == 200
    got = client.get(f"/api/documents/comments/{a['id']}").json()
    assert got["status"] == "resolved" and got["resolved_by"] == "Olu"
    assert client.post(f"/api/documents/comments/{a['id']}/reopen").status_code == 200
    client.as_user(USER)
    r = client.patch(f"/api/documents/comments/{a['id']}", json={"body": "clarified"})
    assert r.status_code == 200 and r.json()["body"] == "clarified" and r.json()["edited_at"]
    client.as_user(ADMIN)
    assert client.delete(f"/api/documents/comments/{a['id']}").status_code == 204
    assert client.get(f"/api/documents/comments/{a['id']}").status_code == 404


def test_agent_token_names_the_author_and_internal_token_is_refused(client):
    doc = publish(client)
    client.real_actor()
    r = client.post(f"/api/documents/{doc['id']}/comments", headers={"X-Service-Token": AGENT_TOKEN},
                    json={"kind": "comment", "body": "from jarvis", "author_user_id": 1})
    assert r.status_code == 201, r.text
    assert (r.json()["author"], r.json()["author_agent"], r.json()["author_user_id"]) == ("jarvis", "jarvis", None)
    r = client.post(f"/api/documents/{doc['id']}/comments", headers={"X-Service-Token": INTERNAL_TOKEN},
                    json={"kind": "comment", "body": "nameless"})
    assert r.status_code == 403 and "named author" in r.text
    r = client.post(f"/api/documents/{doc['id']}/comments", headers={"X-Service-Token": "wrong"},
                    json={"kind": "comment", "body": "x"})
    assert r.status_code == 401
    r = client.post(f"/api/documents/{doc['id']}/comments", json={"kind": "comment", "body": "x"})
    assert r.status_code == 401  # no credential at all


def test_agent_may_edit_only_its_own_comment(client):
    doc = publish(client)
    client.real_actor()
    mine = client.post(f"/api/documents/{doc['id']}/comments", headers={"X-Service-Token": AGENT_TOKEN},
                       json={"kind": "comment", "body": "mine"}).json()
    from documents_comments_support import OTHER_AGENT_TOKEN
    r = client.patch(f"/api/documents/comments/{mine['id']}", headers={"X-Service-Token": OTHER_AGENT_TOKEN},
                     json={"body": "stolen"})
    assert r.status_code == 403
    r = client.patch(f"/api/documents/comments/{mine['id']}", headers={"X-Service-Token": AGENT_TOKEN},
                     json={"body": "edited"})
    assert r.status_code == 200


def test_open_comment_count_rides_document_detail_and_list(client):
    doc = publish(client)
    comment(client, doc["id"])
    comment(client, doc["id"], body="b")
    resolved = comment(client, doc["id"], body="c")
    client.post(f"/api/documents/comments/{resolved['id']}/resolve")
    assert client.get(f"/api/documents/{doc['id']}").json()["open_comment_count"] == 2
    items = client.get("/api/documents").json()["items"]
    assert [i["open_comment_count"] for i in items if i["code"] == doc["code"]] == [2]


def test_discarding_a_draft_takes_its_comments(client):
    r1 = publish(client)
    from documents_comments_support import HTML
    draft = publish(client, code=r1["code"], html=HTML.replace("Audit", "draft"), activate=False)
    on_draft = comment(client, draft["id"], anchor=None)
    on_r1 = comment(client, r1["id"], anchor=None)
    r = client.delete(f"/api/documents/{draft['id']}?code={draft['code']}&revision=2")
    assert r.status_code == 200, r.text
    ids = [i["id"] for i in client.get(f"/api/documents/{r1['id']}/comments").json()["items"]]
    assert ids == [on_r1["id"]] and on_draft["id"] not in ids
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd C:/tmp/mk1-doc-annotations/backend && $PY -m pytest tests/test_documents_comments.py -q`
Expected: FAIL on every test with 404/405 (routes do not exist) or ImportError.

- [ ] **Step 3: Schemas**

Append to `backend/documents/schemas.py`, and add `open_comment_count: int = 0` as the last field of `DocumentOut` (before `class DocumentDetail`):

```python
class CommentCreate(BaseModel):
    parent_id: Optional[int] = None
    kind: str = "comment"                 # comment | suggestion
    anchor: Optional[dict] = None         # PersistedHtmlAnchor or null (document-level)
    label: Optional[str] = None
    body: str = ""
    suggested_text: Optional[str] = None


class CommentPatch(BaseModel):
    body: Optional[str] = None
    suggested_text: Optional[str] = None


class CommentAttachmentOut(BaseModel):
    id: int
    filename: str
    content_type: str
    size_bytes: int
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class CommentOut(BaseModel):
    id: int
    code: str
    document_id: int
    revision: int
    parent_id: Optional[int] = None
    number: Optional[int] = None          # top-level only; replies carry None
    kind: str
    anchor: Optional[dict] = None
    label: Optional[str] = None
    body: str
    suggested_text: Optional[str] = None
    author: str
    author_user_id: Optional[int] = None
    author_agent: Optional[str] = None
    status: str
    resolved_at: Optional[datetime] = None
    resolved_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    edited_at: Optional[datetime] = None
    attachments: List[CommentAttachmentOut] = Field(default_factory=list)
    replies: List["CommentOut"] = Field(default_factory=list)


class CommentListOut(BaseModel):
    items: List[CommentOut]
    code: str
    latest_revision: int
    open_count: int
```

- [ ] **Step 4: Service**

Append to `backend/documents/comments.py` (keep the actor block from Task 3 at the top; add these imports under it: `import logging`, `from datetime import datetime`, `from typing import Iterable`, `from sqlalchemy import delete, func, select`, `from sqlalchemy.orm import Session`, `from documents import anchors, labels`, `from documents.errors import BadRequestError, ForbiddenError, NotFoundError`, `from documents.models import Document, DocumentComment, DocumentCommentAttachment`):

```python
logger = logging.getLogger(__name__)
KINDS = ("comment", "suggestion")
STATUSES = ("open", "resolved")


def _doc(db: Session, document_id: int) -> Document:
    doc = db.get(Document, document_id)
    if doc is None:
        raise NotFoundError(f"document {document_id} not found")
    return doc


def get_comment(db: Session, comment_id: int) -> DocumentComment:
    row = db.get(DocumentComment, comment_id)
    if row is None:
        raise NotFoundError(f"comment {comment_id} not found")
    return row


def _can_edit(actor: Actor, row: DocumentComment) -> bool:
    if actor.is_admin:
        return True
    if actor.user_id is not None:
        return row.author_user_id == actor.user_id
    return actor.agent is not None and row.author_agent == actor.agent


def create_comment(db: Session, *, document_id: int, actor: Actor, kind: str = "comment",
                   body: str = "", anchor=None, label: Optional[str] = None,
                   suggested_text: Optional[str] = None,
                   parent_id: Optional[int] = None) -> DocumentComment:
    doc = _doc(db, document_id)
    if kind not in KINDS:
        raise BadRequestError(f"kind must be one of {KINDS}")
    body = (body or "").strip()
    if kind == "suggestion":
        if not (suggested_text or "").strip():
            raise BadRequestError("a suggestion needs suggested_text")
    elif suggested_text is not None:
        raise BadRequestError("only a suggestion carries suggested_text")
    if label is not None and label not in labels.label_ids():
        raise BadRequestError(f"unknown label {label!r}")
    parent = None
    if parent_id is not None:
        parent = get_comment(db, parent_id)
        if parent.code != doc.code:
            raise BadRequestError("a reply must be on the same document as its parent")
        if parent.parent_id is not None:
            raise BadRequestError("replies cannot have replies")
        anchor = None  # a reply inherits its parent's place in the UI; nothing stored
    else:
        anchor = anchors.validate_anchor(anchor)
        if anchors.is_quote_only(anchor):
            from documents.service import read_content  # local: service imports nothing from here
            html = read_content(doc).decode("utf-8", "replace")
            if not anchors.quote_occurs(anchor["originalText"], html):
                raise BadRequestError(
                    f'quote not found in {doc.code} r{doc.revision}: "{anchor["originalText"][:80]}"')
    if not body and label is None and kind == "comment":
        raise BadRequestError("a comment needs a body or a label")
    row = DocumentComment(code=doc.code, document_id=doc.id, parent_id=parent_id, kind=kind,
                          anchor=anchor, label=label, body=body,
                          suggested_text=(suggested_text.strip() if kind == "suggestion" else None),
                          author_user_id=actor.user_id, author_agent=actor.agent, status="open")
    db.add(row)
    db.flush()
    _link_attachments(db, row.code, row.id, row.body)
    db.commit()
    db.refresh(row)
    return row


def _link_attachments(db: Session, code: str, comment_id: int, body: str) -> None:
    """Completed in Task 5. Claims {attachment:ID} tokens for this code."""
    return None


def patch_comment(db: Session, comment_id: int, actor: Actor, *, body: Optional[str] = None,
                  suggested_text: Optional[str] = None) -> DocumentComment:
    row = get_comment(db, comment_id)
    if not _can_edit(actor, row):
        raise ForbiddenError("only the author or an admin may edit this comment")
    if suggested_text is not None and row.kind != "suggestion":
        raise BadRequestError("only a suggestion carries suggested_text")
    if body is not None:
        row.body = body.strip()
    if suggested_text is not None:
        if not suggested_text.strip():
            raise BadRequestError("a suggestion needs suggested_text")
        row.suggested_text = suggested_text.strip()
    row.edited_at = datetime.utcnow()
    _link_attachments(db, row.code, row.id, row.body)
    db.commit()
    db.refresh(row)
    return row


def _subtree_ids(db: Session, root_ids: Iterable[int]) -> list[int]:
    ids = list(root_ids)
    if not ids:
        return []
    replies = db.execute(select(DocumentComment.id).where(
        DocumentComment.parent_id.in_(ids))).scalars().all()
    return ids + list(replies)


def _attachment_keys(db: Session, comment_ids: list[int]) -> list[str]:
    if not comment_ids:
        return []
    return list(db.execute(select(DocumentCommentAttachment.storage_key).where(
        DocumentCommentAttachment.comment_id.in_(comment_ids))).scalars().all())


def _delete_rows(db: Session, comment_ids: list[int]) -> None:
    if not comment_ids:
        return
    db.execute(delete(DocumentCommentAttachment).where(
        DocumentCommentAttachment.comment_id.in_(comment_ids)))
    db.execute(delete(DocumentComment).where(DocumentComment.id.in_(comment_ids)))


def _delete_blobs(keys: list[str]) -> None:
    """Row first, bytes second: a failed blob delete leaves an inert orphan."""
    if not keys:
        return
    from flags import seams as flag_seams  # lazy: flags.seams imports documents.models
    storage = flag_seams.get_attachment_storage()
    for key in keys:
        try:
            storage.delete(key)
        except Exception as e:  # noqa: BLE001
            logger.warning("document comment attachment orphaned key=%s err=%s", key, e)


def delete_comment(db: Session, comment_id: int, actor: Actor) -> None:
    row = get_comment(db, comment_id)
    if not _can_edit(actor, row):
        raise ForbiddenError("only the author or an admin may delete this comment")
    ids = _subtree_ids(db, [row.id])
    keys = _attachment_keys(db, ids)
    _delete_rows(db, ids)
    db.commit()
    _delete_blobs(keys)


def purge_for_document(db: Session, document_id: int) -> list[str]:
    """Called by service.delete_document before the draft row goes: removes the
    draft's comments and their replies, returns blob keys for the caller to
    delete AFTER its own commit."""
    roots = db.execute(select(DocumentComment.id).where(
        DocumentComment.document_id == document_id)).scalars().all()
    ids = _subtree_ids(db, roots)
    keys = _attachment_keys(db, ids)
    _delete_rows(db, ids)
    return keys


def set_status(db: Session, comment_id: int, actor: Actor, status: str) -> DocumentComment:
    if status not in STATUSES:
        raise BadRequestError(f"status must be one of {STATUSES}")
    row = get_comment(db, comment_id)
    if row.parent_id is not None:
        raise BadRequestError("resolve the top-level comment, not a reply")
    if row.status != status:
        row.status = status
        if status == "resolved":
            row.resolved_at = datetime.utcnow()
            row.resolved_by_user_id = actor.user_id
            row.resolved_by_agent = actor.agent
        else:
            row.resolved_at = None
            row.resolved_by_user_id = None
            row.resolved_by_agent = None
        db.commit()
        db.refresh(row)
    return row


def open_comment_counts(db: Session, codes: Iterable[str]) -> dict[str, int]:
    codes = list(set(codes))
    if not codes:
        return {}
    rows = db.execute(select(DocumentComment.code, func.count()).where(
        DocumentComment.code.in_(codes), DocumentComment.status == "open",
        DocumentComment.parent_id.is_(None)).group_by(DocumentComment.code)).all()
    return {code: n for code, n in rows}


def _user_names(db: Session, ids: Iterable[Optional[int]]) -> dict[int, str]:
    from models import User
    wanted = [i for i in set(ids) if i is not None]
    if not wanted:
        return {}
    return {u.id: display_name(u) for u in db.execute(select(User).where(User.id.in_(wanted))).scalars()}


def _who(row_user_id, row_agent, names: dict[int, str]) -> Optional[str]:
    if row_agent:
        return row_agent
    if row_user_id is not None:
        return names.get(row_user_id, f"user {row_user_id}")
    return None


def _out(row: DocumentComment, *, number: Optional[int], revision: int, names: dict[int, str],
         attachments: list[DocumentCommentAttachment], replies: list[dict]) -> dict:
    return {
        "id": row.id, "code": row.code, "document_id": row.document_id, "revision": revision,
        "parent_id": row.parent_id, "number": number, "kind": row.kind, "anchor": row.anchor,
        "label": row.label, "body": row.body, "suggested_text": row.suggested_text,
        "author": _who(row.author_user_id, row.author_agent, names) or "unknown",
        "author_user_id": row.author_user_id, "author_agent": row.author_agent,
        "status": row.status, "resolved_at": row.resolved_at,
        "resolved_by": _who(row.resolved_by_user_id, row.resolved_by_agent, names),
        "created_at": row.created_at, "updated_at": row.updated_at, "edited_at": row.edited_at,
        "attachments": [{"id": a.id, "filename": a.filename, "content_type": a.content_type,
                         "size_bytes": a.size_bytes, "created_at": a.created_at} for a in attachments],
        "replies": replies,
    }


def comment_out(db: Session, row: DocumentComment) -> dict:
    """One comment (any level) in CommentOut shape, numbered within its code."""
    listing = list_comments(db, row.code, status="all")
    for item in listing["items"]:
        if item["id"] == row.id:
            return item
        for reply in item["replies"]:
            if reply["id"] == row.id:
                return reply
    raise NotFoundError(f"comment {row.id} not found")


def list_comments(db: Session, code: str, status: str = "open") -> dict:
    """Every top-level comment for the CODE (spec §4.1 numbering: 1-based position
    by created_at then id across ALL statuses, so a number never changes), then
    filtered, with replies nested and attachments attached."""
    if status not in STATUSES + ("all",):
        raise BadRequestError("status must be open, resolved, or all")
    tops = db.execute(select(DocumentComment).where(
        DocumentComment.code == code, DocumentComment.parent_id.is_(None)
    ).order_by(DocumentComment.created_at, DocumentComment.id)).scalars().all()
    numbered = [(i + 1, row) for i, row in enumerate(tops)]
    shown = [(n, r) for n, r in numbered if status == "all" or r.status == status]
    top_ids = [r.id for _, r in shown]
    replies = db.execute(select(DocumentComment).where(
        DocumentComment.parent_id.in_(top_ids)
    ).order_by(DocumentComment.created_at, DocumentComment.id)).scalars().all() if top_ids else []
    all_rows = [r for _, r in shown] + list(replies)
    atts: dict[int, list] = {}
    if all_rows:
        for a in db.execute(select(DocumentCommentAttachment).where(
                DocumentCommentAttachment.comment_id.in_([r.id for r in all_rows]))).scalars():
            atts.setdefault(a.comment_id, []).append(a)
    revisions = dict(db.execute(select(Document.id, Document.revision).where(
        Document.code == code)).all())
    names = _user_names(db, [r.author_user_id for r in all_rows] + [r.resolved_by_user_id for r in all_rows])
    by_parent: dict[int, list[dict]] = {}
    for r in replies:
        by_parent.setdefault(r.parent_id, []).append(_out(
            r, number=None, revision=revisions.get(r.document_id, 0), names=names,
            attachments=atts.get(r.id, []), replies=[]))
    items = [_out(r, number=n, revision=revisions.get(r.document_id, 0), names=names,
                  attachments=atts.get(r.id, []), replies=by_parent.get(r.id, []))
             for n, r in shown]
    latest = max(revisions.values()) if revisions else 0
    return {"items": items, "code": code, "latest_revision": latest,
            "open_count": sum(1 for _, r in numbered if r.status == "open")}
```

- [ ] **Step 5: Routes**

Append to `backend/documents/comment_routes.py` (add imports: `from fastapi import Query, Response`, `from documents import comments, service`, and `CommentCreate, CommentListOut, CommentOut, CommentPatch` from `documents.schemas`):

```python
# --- single comment by id (literal "comments" segment, declared before /documents/{doc_id}) ---

@router.get("/documents/comments/{comment_id}", response_model=CommentOut)
def get_comment(comment_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return comments.comment_out(db, comments.get_comment(db, comment_id))
    except Exception as e:
        raise _http(e)


@router.patch("/documents/comments/{comment_id}", response_model=CommentOut)
def patch_comment(comment_id: int, req: CommentPatch, db: Session = Depends(get_db),
                  actor: Actor = Depends(require_comment_actor)):
    try:
        row = comments.patch_comment(db, comment_id, actor, body=req.body,
                                     suggested_text=req.suggested_text)
        return comments.comment_out(db, row)
    except Exception as e:
        raise _http(e)


@router.delete("/documents/comments/{comment_id}", status_code=204)
def delete_comment(comment_id: int, db: Session = Depends(get_db),
                   actor: Actor = Depends(require_comment_actor)):
    try:
        comments.delete_comment(db, comment_id, actor)
    except Exception as e:
        raise _http(e)
    return Response(status_code=204)


@router.post("/documents/comments/{comment_id}/resolve", response_model=CommentOut)
def resolve_comment(comment_id: int, db: Session = Depends(get_db),
                    actor: Actor = Depends(require_comment_actor)):
    try:
        return comments.comment_out(db, comments.set_status(db, comment_id, actor, "resolved"))
    except Exception as e:
        raise _http(e)


@router.post("/documents/comments/{comment_id}/reopen", response_model=CommentOut)
def reopen_comment(comment_id: int, db: Session = Depends(get_db),
                   actor: Actor = Depends(require_comment_actor)):
    try:
        return comments.comment_out(db, comments.set_status(db, comment_id, actor, "open"))
    except Exception as e:
        raise _http(e)


# --- per revision ------------------------------------------------------------------------

@router.get("/documents/{doc_id}/comments", response_model=CommentListOut)
def list_comments(doc_id: int, status_filter: str = Query("open", alias="status"),
                  db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        doc = service.get_document(db, doc_id)
        return comments.list_comments(db, doc.code, status=status_filter)
    except Exception as e:
        raise _http(e)


@router.post("/documents/{doc_id}/comments", response_model=CommentOut, status_code=201)
def create_comment(doc_id: int, req: CommentCreate, db: Session = Depends(get_db),
                   actor: Actor = Depends(require_comment_actor)):
    try:
        row = comments.create_comment(
            db, document_id=doc_id, actor=actor, kind=req.kind, body=req.body,
            anchor=req.anchor, label=req.label, suggested_text=req.suggested_text,
            parent_id=req.parent_id)
        if actor.agent:
            logger.info("documents.agent_comment agent=%s code=%s comment=%s", actor.agent, row.code, row.id)
        return comments.comment_out(db, row)
    except Exception as e:
        raise _http(e)
```

- [ ] **Step 6: Counts on `DocumentOut`, `ForbiddenError` mapping, and the draft purge**

In `backend/documents/routes.py`:
- `_http`: add `if isinstance(e, ForbiddenError): return HTTPException(status_code=403, detail=str(e))` after the `NotFoundError` branch, and import `ForbiddenError` from `documents.errors`.
- `_doc_out(doc, revision_count, open_comments: int = 0)`: add `open_comment_count=open_comments` to the `DocumentOut(...)` call.
- `list_documents`: after the service call, `counts = comments.open_comment_counts(db, [d.code for d, _ in rows])` and build items with `_doc_out(d, n, counts.get(d.code, 0))`.
- `get_document`: `counts = comments.open_comment_counts(db, [doc.code])`; pass `counts.get(doc.code, 0)` to the main `_doc_out` (revisions keep the default 0).
- Add `from documents import comments` to the imports.

In `backend/documents/service.py` `delete_document`, right before `db.delete(doc)`:

```python
    from documents import comments as _comments  # local: comments imports this module lazily too
    comment_blob_keys = _comments.purge_for_document(db, doc.id)
```

and after the existing blob delete block at the end:

```python
    _comments._delete_blobs(comment_blob_keys)
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd C:/tmp/mk1-doc-annotations/backend && $PY -m pytest tests/test_documents_comments.py tests/test_documents_routes.py tests/test_documents_comment_labels.py -q`
Expected: all pass (14 new).

- [ ] **Step 8: Commit**

```bash
cd C:/tmp/mk1-doc-annotations && git add backend/documents/comments.py backend/documents/comment_routes.py backend/documents/schemas.py backend/documents/routes.py backend/documents/service.py backend/tests/test_documents_comments.py && git commit -m "feat(documents): comment service and routes with stable numbering, replies, resolve, author rules" -- backend/documents/comments.py backend/documents/comment_routes.py backend/documents/schemas.py backend/documents/routes.py backend/documents/service.py backend/tests/test_documents_comments.py
```

---

### Task 5: Attachments (upload, serve, link, garbage-collect)

**Files:**
- Modify: `backend/documents/comments.py` (attachment functions, real `_link_attachments`)
- Modify: `backend/documents/comment_routes.py` (two routes)
- Create: `backend/documents/comment_attachments_gc.py`
- Modify: `backend/main.py:487-496` (`_gc_job` also sweeps comment attachments)
- Create: `backend/tests/test_documents_comment_attachments.py`

**Interfaces:**
- Produces: `comments.add_attachment(db, *, doc, actor, data, filename) -> DocumentCommentAttachment`, `comments.get_attachment(db, attachment_id)`, `comments.MAX_ATTACHMENT_BYTES`, `comment_attachments_gc.gc_orphaned_comment_attachments(db, *, now, storage=None) -> int`.
- Routes: `POST /api/documents/{doc_id}/comment-attachments` (multipart `file`) → 201 `CommentAttachmentOut`; `GET /api/documents/comment-attachments/{attachment_id}` → bytes.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_documents_comment_attachments.py
"""Comment attachments (spec §4.2): sniffed, capped, linked by token, swept when orphaned."""
import io
import os
import sys
from datetime import datetime, timedelta

import pytest

sys.path.insert(0, os.path.dirname(__file__))
from documents_comments_support import (  # noqa: E402
    GIF, JPEG, NOT_IMAGE, PNG, WEBP, client, comment, publish)  # noqa: F401


def _upload(client, doc_id, data=PNG, name="shot.png"):
    return client.post(f"/api/documents/{doc_id}/comment-attachments",
                       files={"file": (name, io.BytesIO(data), "application/octet-stream")})


@pytest.mark.parametrize("data, ct", [(PNG, "image/png"), (JPEG, "image/jpeg"),
                                      (GIF, "image/gif"), (WEBP, "image/webp")])
def test_magic_bytes_decide_the_type_not_the_client(client, data, ct):
    doc = publish(client)
    r = _upload(client, doc["id"], data)
    assert r.status_code == 201, r.text
    assert r.json()["content_type"] == ct and r.json()["size_bytes"] == len(data)


def test_non_image_and_oversize_are_400(client, monkeypatch):
    doc = publish(client)
    assert _upload(client, doc["id"], NOT_IMAGE, "x.pdf").status_code == 400
    from documents import comments
    monkeypatch.setattr(comments, "MAX_ATTACHMENT_BYTES", 10)
    assert _upload(client, doc["id"], PNG).status_code == 400
    assert _upload(client, doc["id"], b"", "e.png").status_code == 400


def test_served_authenticated_inline_nosniff(client):
    doc = publish(client)
    aid = _upload(client, doc["id"]).json()["id"]
    r = client.get(f"/api/documents/comment-attachments/{aid}")
    assert r.status_code == 200 and r.content == PNG
    assert r.headers["content-type"].startswith("image/png")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["content-disposition"] == 'inline; filename="shot.png"'
    assert "private" in r.headers["cache-control"]
    assert client.get("/api/documents/comment-attachments/9999").status_code == 404


def test_body_token_links_the_upload_and_the_card_lists_it(client):
    doc = publish(client)
    aid = _upload(client, doc["id"]).json()["id"]
    c = comment(client, doc["id"], body=f"see {{attachment:{aid}}}")
    assert [a["id"] for a in c["attachments"]] == [aid]
    from documents.models import DocumentCommentAttachment
    assert client.db.get(DocumentCommentAttachment, aid).comment_id == c["id"]


def test_token_for_another_code_is_not_claimed(client):
    a = publish(client)
    from documents_comments_support import HTML
    b = publish(client, title="Other", html=HTML.replace("Audit", "Other"))
    aid = _upload(client, b["id"]).json()["id"]
    c = comment(client, a["id"], body=f"{{attachment:{aid}}}")
    assert c["attachments"] == []
    from documents.models import DocumentCommentAttachment
    assert client.db.get(DocumentCommentAttachment, aid).comment_id is None


def test_patch_relinks_and_delete_removes_rows_and_blobs(client):
    doc = publish(client)
    aid = _upload(client, doc["id"]).json()["id"]
    c = comment(client, doc["id"], body="no token yet")
    r = client.patch(f"/api/documents/comments/{c['id']}", json={"body": f"now {{attachment:{aid}}}"})
    assert [a["id"] for a in r.json()["attachments"]] == [aid]
    assert client.delete(f"/api/documents/comments/{c['id']}").status_code == 204
    assert client.get(f"/api/documents/comment-attachments/{aid}").status_code == 404
    from flags import seams
    from documents.models import DocumentCommentAttachment
    assert client.db.query(DocumentCommentAttachment).count() == 0


def test_gc_sweeps_only_unlinked_rows_past_the_cutoff(client):
    doc = publish(client)
    old = _upload(client, doc["id"]).json()["id"]
    fresh = _upload(client, doc["id"]).json()["id"]
    linked = _upload(client, doc["id"]).json()["id"]
    comment(client, doc["id"], body=f"{{attachment:{linked}}}")
    from documents.models import DocumentCommentAttachment
    row = client.db.get(DocumentCommentAttachment, old)
    row.created_at = datetime.utcnow() - timedelta(hours=30)
    client.db.commit()
    from documents.comment_attachments_gc import gc_orphaned_comment_attachments
    removed = gc_orphaned_comment_attachments(client.db, now=datetime.utcnow())
    assert removed == 1
    left = {a.id for a in client.db.query(DocumentCommentAttachment)}
    assert left == {fresh, linked}


def test_agent_uploads_are_stamped_with_the_agent(client):
    doc = publish(client)
    client.real_actor()
    from documents_comments_support import AGENT_TOKEN
    r = client.post(f"/api/documents/{doc['id']}/comment-attachments",
                    headers={"X-Service-Token": AGENT_TOKEN},
                    files={"file": ("a.png", io.BytesIO(PNG), "image/png")})
    assert r.status_code == 201
    from documents.models import DocumentCommentAttachment
    row = client.db.get(DocumentCommentAttachment, r.json()["id"])
    assert (row.uploaded_by_agent, row.uploaded_by_user_id) == ("jarvis", None)
    assert row.storage_key.startswith(f"documents/{doc['code']}/")
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd C:/tmp/mk1-doc-annotations/backend && $PY -m pytest tests/test_documents_comment_attachments.py -q`
Expected: FAIL (404/405 on the attachment routes).

- [ ] **Step 3: Service additions**

Append to `backend/documents/comments.py` and REPLACE the Task 4 stub `_link_attachments` with the real one below (add `import re` at the top):

```python
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
_ATTACHMENT_TOKEN = re.compile(r"\{attachment:(\d+)\}")
_EXT_FOR_CT = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}


def _sniff_image(data: bytes) -> str:
    """Magic bytes decide; the client's Content-Type is never trusted. Same four
    raster types as flag attachments (a copy, not an import: flags.service
    raises its own BadRequestError class, which our routes would not map)."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    raise BadRequestError("attachment must be a PNG, JPEG, GIF, or WEBP image")


def _attachment_storage():
    """The flag attachment seam, reused (spec §4.2). Imported lazily because
    flags/seams.py imports documents.models for the entity registration."""
    from flags import seams as flag_seams
    return flag_seams.get_attachment_storage()


def add_attachment(db: Session, *, doc: Document, actor: Actor, data: bytes,
                   filename: str) -> DocumentCommentAttachment:
    if not data:
        raise BadRequestError("empty upload")
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise BadRequestError("attachment exceeds 10 MB")
    content_type = _sniff_image(data)
    ext = _EXT_FOR_CT[content_type]
    key = _attachment_storage().save(f"documents/{doc.code}", data, f"upload{ext}")
    att = DocumentCommentAttachment(
        code=doc.code, comment_id=None, uploaded_by_user_id=actor.user_id,
        uploaded_by_agent=actor.agent, filename=(filename or f"upload{ext}")[:255],
        content_type=content_type, size_bytes=len(data), storage_key=key)
    db.add(att)
    db.commit()
    db.refresh(att)
    return att


def get_attachment(db: Session, attachment_id: int) -> DocumentCommentAttachment:
    att = db.get(DocumentCommentAttachment, attachment_id)
    if att is None:
        raise NotFoundError(f"attachment {attachment_id} not found")
    return att


def _link_attachments(db: Session, code: str, comment_id: int, body: str) -> None:
    """FK the {attachment:ID} tokens in a saved body back to the comment so
    they survive the orphan sweep. Only unlinked rows on THIS code are claimed."""
    ids = {int(m) for m in _ATTACHMENT_TOKEN.findall(body or "")}
    if not ids:
        return
    for att in db.execute(select(DocumentCommentAttachment).where(
            DocumentCommentAttachment.code == code,
            DocumentCommentAttachment.id.in_(ids),
            DocumentCommentAttachment.comment_id.is_(None))).scalars():
        att.comment_id = comment_id
```

- [ ] **Step 4: The GC module**

```python
# backend/documents/comment_attachments_gc.py
"""Orphaned comment-attachment sweep (spec §4.2), a sibling of flags/attachments_gc.py:
same 24h TTL, same storage seam, registered on the same scheduler job in main.py.
Lives in documents/ so flags/ never learns about document comments."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy import select

logger = logging.getLogger(__name__)
_ORPHAN_TTL = timedelta(hours=24)


def gc_orphaned_comment_attachments(db, *, now: datetime, storage=None) -> int:
    from documents.models import DocumentCommentAttachment
    if storage is None:
        from flags import seams as flag_seams
        storage = flag_seams.get_attachment_storage()
    cutoff = now - _ORPHAN_TTL
    rows = db.execute(select(DocumentCommentAttachment).where(
        DocumentCommentAttachment.comment_id.is_(None),
        DocumentCommentAttachment.created_at < cutoff)).scalars().all()
    removed = 0
    for row in rows:
        try:
            storage.delete(row.storage_key)
        except Exception:  # noqa: BLE001 — a storage miss never blocks the DB sweep
            logger.warning("comment attachment gc: storage delete failed for %s", row.storage_key)
        db.delete(row)
        removed += 1
    db.commit()
    return removed
```

In `backend/main.py` `_gc_job` (around line 490), add the second sweep inside the same `try`:

```python
    from documents import comment_attachments_gc as _comment_attachments_gc

    def _gc_job(now):
        db = _SessionLocal()
        try:
            _attachments_gc.gc_orphaned_attachments(db, now=now)
            _comment_attachments_gc.gc_orphaned_comment_attachments(db, now=now)
        finally:
            db.close()
```

- [ ] **Step 5: Routes**

Add to `backend/documents/comment_routes.py` (imports: `import re`, `from fastapi import File, UploadFile`, `from documents.schemas import CommentAttachmentOut`). The GET goes in the "literal paths FIRST" block; the POST goes after the per-revision routes:

```python
@router.get("/documents/comment-attachments/{attachment_id}")
def get_comment_attachment(attachment_id: int, db: Session = Depends(get_db),
                           user=Depends(get_current_user)):
    try:
        att = comments.get_attachment(db, attachment_id)
        data = comments._attachment_storage().fetch(att.storage_key)
    except Exception as e:
        from flags import seams as flag_seams
        if isinstance(e, flag_seams.AttachmentNotFound):
            raise HTTPException(status_code=404, detail="attachment file missing from storage")
        raise _http(e)
    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", att.filename or "") or "attachment"
    return Response(content=data, media_type=att.content_type, headers={
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": f'inline; filename="{safe_name}"',
        "Cache-Control": "private, max-age=0",
    })


# SYNC def so the blocking storage put runs in the threadpool (same rule as flags).
@router.post("/documents/{doc_id}/comment-attachments", response_model=CommentAttachmentOut,
             status_code=201)
def add_comment_attachment(doc_id: int, file: UploadFile = File(...),
                           db: Session = Depends(get_db),
                           actor: Actor = Depends(require_comment_actor)):
    try:
        doc = service.get_document(db, doc_id)
        data = file.file.read()
        att = comments.add_attachment(db, doc=doc, actor=actor, data=data,
                                      filename=file.filename or "upload")
        return CommentAttachmentOut.model_validate(att)
    except Exception as e:
        raise _http(e)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd C:/tmp/mk1-doc-annotations/backend && $PY -m pytest tests/test_documents_comment_attachments.py tests/test_documents_comments.py -q`
Expected: all pass (11 new).

- [ ] **Step 7: Commit**

```bash
cd C:/tmp/mk1-doc-annotations && git add backend/documents/comments.py backend/documents/comment_routes.py backend/documents/comment_attachments_gc.py backend/main.py backend/tests/test_documents_comment_attachments.py && git commit -m "feat(documents): comment image attachments on the flag storage seam, token linking, orphan sweep" -- backend/documents/comments.py backend/documents/comment_routes.py backend/documents/comment_attachments_gc.py backend/main.py backend/tests/test_documents_comment_attachments.py
```

---

### Task 6: Markdown export and the cross-document index

**Files:**
- Create: `backend/documents/comment_export.py`
- Modify: `backend/documents/comment_routes.py` (two routes)
- Modify: `backend/documents/schemas.py` (`CommentIndexRow`, `CommentIndexOut`)
- Create: `backend/tests/test_documents_comment_export.py`

**Interfaces:**
- Produces: `comment_export.export_markdown(db, code, status="open") -> str`; `comment_export.list_index(db, *, status="open", author_agent=None, code_prefix=None, limit=100) -> list[dict]`.
- Routes: `GET /api/documents/{doc_id}/comments/export?status=open` → `text/markdown`; `GET /api/documents/comments?status=&author_agent=&code_prefix=&limit=` → `CommentIndexOut`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_documents_comment_export.py
"""Agent-facing export (spec §6.3) and the cross-document index (spec §6.2)."""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(__file__))
from documents_comments_support import (  # noqa: E402
    AGENT_TOKEN, HTML, client, comment, publish)  # noqa: F401


def _stamp(db, comment_id, when):
    from documents.models import DocumentComment
    row = db.get(DocumentComment, comment_id)
    row.created_at = when
    db.commit()


def test_export_golden(client):
    r1 = publish(client)
    labelled = comment(client, r1["id"], body="Which \"before\"? Name the behaviour.",
                       label="clarify-this",
                       anchor={"originalText": "still behaves as before",
                               "htmlAnchor": {"selector": "body > p:nth-of-type(1)", "tagName": "p"},
                               "elementContext": {"tag": "p", "heading": 'h2 "Rulings"',
                                                  "path": "body > p"}})
    _stamp(client.db, labelled["id"], datetime(2026, 10, 3, 14, 2))
    client.real_actor()
    reply = client.post(f"/api/documents/{r1['id']}/comments", headers={"X-Service-Token": AGENT_TOKEN},
                        json={"kind": "comment", "parent_id": labelled["id"],
                              "body": "Meaning the pre-09-17 behaviour. Will state it."}).json()
    _stamp(client.db, reply["id"], datetime(2026, 10, 3, 14, 10))
    client.as_user(__import__("documents_comments_support").USER)
    r2 = publish(client, code=r1["code"], html=HTML.replace("Audit", "Audit v2"))
    sugg = comment(client, r2["id"], kind="suggestion", body="",
                   suggested_text="the lab's calendar day",
                   anchor={"originalText": "50% of spec"})
    _stamp(client.db, sugg["id"], datetime(2026, 10, 3, 14, 5))
    glob = comment(client, r2["id"], body="Section 4 has no owner named.", anchor=None)
    _stamp(client.db, glob["id"], datetime(2026, 10, 3, 14, 7))
    done = comment(client, r2["id"], body="resolved one", anchor=None)
    client.post(f"/api/documents/comments/{done['id']}/resolve")

    r = client.get(f"/api/documents/{r2['id']}/comments/export")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/markdown")
    assert r.text == (
        f'# Comments on {r1["code"]} "Audit"\n'
        "Latest revision: r2 (active). 3 open.\n"
        "\n"
        "## 1. ❓ Clarify this — Tess Tech, on r1, 2026-10-03 14:02\n"
        '> "still behaves as before"\n'
        'Where: h2 "Rulings" › body > p\n'
        'Which "before"? Name the behaviour.\n'
        "Agent tip: This passage is ambiguous. Rewrite it so a new technician reads it one way.\n"
        "Replies:\n"
        "- jarvis, 2026-10-03 14:10: Meaning the pre-09-17 behaviour. Will state it.\n"
        "\n"
        "## 2. Suggestion — Tess Tech, on r2, 2026-10-03 14:05\n"
        '> "50% of spec"\n'
        "Replace with:\n"
        '> "the lab\'s calendar day"\n'
        "\n"
        "## 3. Global — Tess Tech, on r2, 2026-10-03 14:07\n"
        "Section 4 has no owner named.\n"
        "\n"
        "---\n"
        "Address each item. Post the next revision with `documents_revise`. Then resolve what you "
        "handled with `documents_comment_resolve`, or answer with `documents_comment_reply` where "
        "you disagree. Do not edit comments you did not write.\n")
    assert "## 4." in client.get(f"/api/documents/{r2['id']}/comments/export?status=all").text


def test_export_lists_attachment_tokens(client):
    import io
    from documents_comments_support import PNG
    doc = publish(client)
    aid = client.post(f"/api/documents/{doc['id']}/comment-attachments",
                      files={"file": ("a.png", io.BytesIO(PNG), "image/png")}).json()["id"]
    comment(client, doc["id"], body=f"look {{attachment:{aid}}}", anchor=None)
    text = client.get(f"/api/documents/{doc['id']}/comments/export").text
    assert f"Attachments: {{attachment:{aid}}}" in text


def test_index_lists_open_comments_across_documents_with_filters(client):
    a = publish(client)
    b = publish(client, title="SOP one", html=HTML.replace("Audit", "SOP"), category="SOP")
    ca = comment(client, a["id"], body="on art", anchor=None)
    client.real_actor()
    cb = client.post(f"/api/documents/{b['id']}/comments", headers={"X-Service-Token": AGENT_TOKEN},
                     json={"kind": "comment", "body": "on sop by jarvis"}).json()
    r = client.get("/api/documents/comments")
    assert r.status_code == 200  # 422 means /documents/{doc_id} swallowed the literal path
    rows = r.json()["items"]
    assert [x["id"] for x in rows] == [cb["id"], ca["id"]]  # newest first
    assert rows[0]["code"] == b["code"] and rows[0]["title"] == "SOP one" and rows[0]["author"] == "jarvis"
    assert rows[0]["document_id"] == b["id"]
    assert [x["id"] for x in client.get("/api/documents/comments?author_agent=jarvis").json()["items"]] == [cb["id"]]
    assert [x["id"] for x in client.get("/api/documents/comments?code_prefix=ART").json()["items"]] == [ca["id"]]
    client.post(f"/api/documents/comments/{ca['id']}/resolve", headers={"X-Service-Token": AGENT_TOKEN})
    assert [x["id"] for x in client.get("/api/documents/comments").json()["items"]] == [cb["id"]]
    assert [x["id"] for x in client.get("/api/documents/comments?status=resolved").json()["items"]] == [ca["id"]]
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd C:/tmp/mk1-doc-annotations/backend && $PY -m pytest tests/test_documents_comment_export.py -q`
Expected: FAIL (404/422).

- [ ] **Step 3: Schemas**

Append to `backend/documents/schemas.py`:

```python
class CommentIndexRow(BaseModel):
    id: int
    code: str
    title: str
    document_id: int
    revision: int
    number: Optional[int] = None
    kind: str
    label: Optional[str] = None
    author: str
    status: str
    created_at: datetime
    body_excerpt: str


class CommentIndexOut(BaseModel):
    items: List[CommentIndexRow]
```

- [ ] **Step 4: The export module**

```python
# backend/documents/comment_export.py
"""Agent-facing views (spec §6.2 index, §6.3 export)."""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from documents import comments, labels
from documents.errors import BadRequestError
from documents.models import Document, DocumentComment

FOOTER = ("---\n"
          "Address each item. Post the next revision with `documents_revise`. Then resolve what you "
          "handled with `documents_comment_resolve`, or answer with `documents_comment_reply` where "
          "you disagree. Do not edit comments you did not write.\n")


def _when(dt) -> str:
    return dt.strftime("%Y-%m-%d %H:%M")


def _heading(item: dict) -> str:
    label = labels.get_label(item["label"])
    if item["kind"] == "suggestion":
        kind = "Suggestion"
    elif item["anchor"] is None:
        kind = "Global"
    elif label:
        kind = f"{label.emoji} {label.text}"
    else:
        kind = "Comment"
    if label and item["kind"] != "comment":
        kind = f"{kind} ({label.emoji} {label.text})"
    return f"## {item['number']}. {kind} — {item['author']}, on r{item['revision']}, {_when(item['created_at'])}"


def _where(anchor: Optional[dict]) -> Optional[str]:
    ctx = (anchor or {}).get("elementContext") or {}
    parts = [p for p in (ctx.get("heading"), ctx.get("path")) if p]
    return "Where: " + " › ".join(parts) if parts else None


def _entry(item: dict) -> str:
    lines = [_heading(item)]
    quote = (item["anchor"] or {}).get("originalText") if item["anchor"] else None
    if quote:
        lines.append(f'> "{quote}"')
    where = _where(item["anchor"])
    if where:
        lines.append(where)
    if item["body"]:
        lines.append(item["body"])
    if item["kind"] == "suggestion":
        lines.append("Replace with:")
        lines.append(f'> "{item["suggested_text"]}"')
    label = labels.get_label(item["label"])
    if label and label.tip:
        lines.append(f"Agent tip: {label.tip}")
    if item["attachments"]:
        lines.append("Attachments: " + " ".join(f"{{attachment:{a['id']}}}" for a in item["attachments"]))
    if item["replies"]:
        lines.append("Replies:")
        for r in item["replies"]:
            lines.append(f"- {r['author']}, {_when(r['created_at'])}: {r['body']}")
    return "\n".join(lines) + "\n"


def export_markdown(db: Session, code: str, status: str = "open") -> str:
    listing = comments.list_comments(db, code, status=status)
    latest = db.execute(select(Document).where(Document.code == code)
                        .order_by(Document.revision.desc()).limit(1)).scalars().first()
    if latest is None:
        raise BadRequestError(f"unknown document code {code!r}")
    head = (f'# Comments on {code} "{latest.title}"\n'
            f"Latest revision: r{latest.revision} ({latest.status}). {listing['open_count']} open.\n")
    body = "\n".join(_entry(item) for item in listing["items"])
    return head + "\n" + body + ("\n" if body else "") + FOOTER


def list_index(db: Session, *, status: str = "open", author_agent: Optional[str] = None,
               code_prefix: Optional[str] = None, limit: int = 100) -> list[dict]:
    if status not in comments.STATUSES + ("all",):
        raise BadRequestError("status must be open, resolved, or all")
    stmt = select(DocumentComment).where(DocumentComment.parent_id.is_(None))
    if status != "all":
        stmt = stmt.where(DocumentComment.status == status)
    if author_agent:
        stmt = stmt.where(DocumentComment.author_agent == author_agent)
    if code_prefix:
        stmt = stmt.where(DocumentComment.code.like(f"{code_prefix.upper()}-%"))
    rows = db.execute(stmt.order_by(DocumentComment.created_at.desc(), DocumentComment.id.desc())
                      .limit(max(1, min(500, limit)))).scalars().all()
    if not rows:
        return []
    codes = {r.code for r in rows}
    numbers: dict[int, int] = {}
    for code in codes:
        for item in comments.list_comments(db, code, status="all")["items"]:
            numbers[item["id"]] = item["number"]
    docs = {d.id: d for d in db.execute(select(Document).where(
        Document.id.in_({r.document_id for r in rows}))).scalars()}
    names = comments._user_names(db, [r.author_user_id for r in rows])
    out = []
    for r in rows:
        d = docs.get(r.document_id)
        out.append({"id": r.id, "code": r.code, "title": d.title if d else "", "document_id": r.document_id,
                    "revision": d.revision if d else 0, "number": numbers.get(r.id), "kind": r.kind,
                    "label": r.label, "author": comments._who(r.author_user_id, r.author_agent, names) or "unknown",
                    "status": r.status, "created_at": r.created_at, "body_excerpt": (r.body or "")[:140]})
    return out
```

- [ ] **Step 5: Routes**

Add to `backend/documents/comment_routes.py` (imports: `from fastapi.responses import PlainTextResponse`, `from documents import comment_export`, `CommentIndexOut` from schemas). The index route goes in the literal-first block ABOVE `/documents/comments/{comment_id}`; the export route goes with the per-revision routes:

```python
@router.get("/documents/comments", response_model=CommentIndexOut)
def comments_index(status_filter: str = Query("open", alias="status"),
                   author_agent: Optional[str] = None, code_prefix: Optional[str] = None,
                   limit: int = 100, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return {"items": comment_export.list_index(db, status=status_filter, author_agent=author_agent,
                                                   code_prefix=code_prefix, limit=limit)}
    except Exception as e:
        raise _http(e)


@router.get("/documents/{doc_id}/comments/export", response_class=PlainTextResponse)
def export_comments(doc_id: int, status_filter: str = Query("open", alias="status"),
                    db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        doc = service.get_document(db, doc_id)
        text = comment_export.export_markdown(db, doc.code, status=status_filter)
    except Exception as e:
        raise _http(e)
    return PlainTextResponse(text, media_type="text/markdown; charset=utf-8")
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd C:/tmp/mk1-doc-annotations/backend && $PY -m pytest tests/test_documents_comment_export.py -q`
Expected: 3 passed. If the golden differs only in the suggestion heading, fix `_heading` (a suggestion with no label prints exactly `Suggestion`).

- [ ] **Step 7: Commit**

```bash
cd C:/tmp/mk1-doc-annotations && git add backend/documents/comment_export.py backend/documents/comment_routes.py backend/documents/schemas.py backend/tests/test_documents_comment_export.py && git commit -m "feat(documents): agent-facing comment export and cross-document comment index" -- backend/documents/comment_export.py backend/documents/comment_routes.py backend/documents/schemas.py backend/tests/test_documents_comment_export.py
```

---

### Task 7: Part 1 gate — failure-set diff, stack proving, PR

**Files:** none new. Evidence goes in the PR body.

- [ ] **Step 1: Run the whole documents + flags test set**

Run: `cd C:/tmp/mk1-doc-annotations/backend && $PY -m pytest tests/test_documents*.py tests/test_flags_attachments*.py -q`
Expected: all pass.

- [ ] **Step 2: Baseline the master failure set, then the branch's, and diff**

Only ONE pytest process at a time (shared dev Postgres deadlock).

```bash
git -C C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1 worktree add C:/tmp/mk1-master-baseline origin/master
cd C:/tmp/mk1-master-baseline/backend && $PY -m pytest -q -p no:cacheprovider 2>&1 | grep -E "^FAILED" | sort > C:/tmp/mk1-baseline-fails.txt
cd C:/tmp/mk1-doc-annotations/backend && $PY -m pytest -q -p no:cacheprovider 2>&1 | grep -E "^FAILED" | sort > C:/tmp/mk1-branch-fails.txt
diff C:/tmp/mk1-baseline-fails.txt C:/tmp/mk1-branch-fails.txt && echo "FAILURE SET IDENTICAL"
git -C C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1 worktree remove C:/tmp/mk1-master-baseline
```

Expected: `FAILURE SET IDENTICAL`. Any new line in the branch file is a regression to fix before the PR.

- [ ] **Step 3: Prove Postgres on a devbox stack**

Invoke the `accumark-stack-platform` skill: create stack `doccomments` from the golden, mount this worktree for Mk1, boot. Then, from the stack's backend container, publish a document and run through the API with the stack admin bearer: create a quote-anchored comment, a suggestion, a reply, an attachment upload + token link, resolve, the index, the export, a draft delete with comments. Record each status code. Confirm in `psql`: `\d document_comments` shows the four CHECKs and `anchor jsonb`; `DELETE FROM documents WHERE id=<draft>` cascades its comments (`SELECT count(*) FROM document_comments WHERE document_id=<draft>` is 0). Teardown: `./bin/accumark-stack destroy doccomments --yes`.

- [ ] **Step 4: Push and open PR 1**

```bash
cd C:/tmp/mk1-doc-annotations && git push -u origin feat/document-annotations
gh pr create --repo Zstar0/Accu-Mk1 --base master --head feat/document-annotations --title "feat(documents): comments, attachments, labels, export (annotations part 1 of 4)" --body-file C:/tmp/pr1-body.md
```

`C:/tmp/pr1-body.md` names the spec path, lists the routes, states "no env change; new tables via create_all; comment images land under the flag attachment prefix at documents/<CODE>/", includes an **Evidence** section with the test counts, the failure-set diff line, and the stack status codes, and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 5: Branch for Part 2**

Part 2 builds on Part 1's routes. Create `feat/document-annotations-viewer` from this branch (`git -C C:/tmp/mk1-doc-annotations switch -c feat/document-annotations-viewer`) and retarget it to master once PR 1 merges.

# Part 2 — Viewer (PR 2)

Frontend commands run from `C:/tmp/mk1-doc-annotations` with npm. First time in this worktree: `npm install` (one-off; the worktree shares no `node_modules` with the main checkout). Vitest is run per file during tasks; `npm run check:all` is the gate in Task 15.

### Task 8: Vendor the plannotator core under MIT

**Files:**
- Create: `src/vendor/plannotator/LICENSE-MIT`, `VENDORED.md`, `bridge-script.ts`, `html-anchor.ts`, `srcdoc.ts`, `image-annotator/{index.tsx,Canvas.tsx,Toolbar.tsx,types.ts,utils.ts,strokeHistory.ts}`, `__tests__/html-anchor.test.ts`
- Modify: `eslint.config.js:98` (ignores), `.prettierignore`, `knip.json`, `sgconfig.yml`, `package.json` (dependency)

**Interfaces:**
- Produces: `@/vendor/plannotator/bridge-script` (`BRIDGE_SCRIPT`, `BRIDGE_PROTOCOL_VERSION`, `ANNOTATION_HIGHLIGHT_CSS`), `@/vendor/plannotator/html-anchor` (`HtmlElementAnchor`, `HtmlElementContext`, `parseHtmlElementAnchor`, `parseHtmlElementContext`, `buildPersistedHtmlAnchor`, caps), `@/vendor/plannotator/srcdoc` (`THEME_TOKENS`, `buildSrcdocInjection`, `injectIntoHead`, `resolveBridgeScriptUrl`), `@/vendor/plannotator/image-annotator` (`ImageAnnotator` with props `{ imageSrc, isOpen, onAccept(blob, hasDrawings, name), onClose, initialName? }`).

- [ ] **Step 1: Fetch upstream at the pinned tag and copy the files**

```bash
git clone --depth 1 --branch v0.27.25 https://github.com/backnotprop/plannotator.git C:/tmp/pn-upstream
cd C:/tmp/mk1-doc-annotations
mkdir -p src/vendor/plannotator/image-annotator src/vendor/plannotator/__tests__
cp C:/tmp/pn-upstream/LICENSE-MIT src/vendor/plannotator/LICENSE-MIT
cp C:/tmp/pn-upstream/packages/ui/components/html-viewer/bridge-script.ts src/vendor/plannotator/bridge-script.ts
cp C:/tmp/pn-upstream/packages/core/html-anchor.ts src/vendor/plannotator/html-anchor.ts
cp C:/tmp/pn-upstream/packages/ui/components/html-viewer/srcdoc.ts src/vendor/plannotator/srcdoc.ts
cp C:/tmp/pn-upstream/packages/core/html-anchor.test.ts src/vendor/plannotator/__tests__/html-anchor.test.ts
for f in index.tsx Canvas.tsx Toolbar.tsx types.ts utils.ts strokeHistory.ts; do cp "C:/tmp/pn-upstream/packages/ui/components/ImageAnnotator/$f" "src/vendor/plannotator/image-annotator/$f"; done
git -C C:/tmp/pn-upstream rev-parse HEAD
grep -n "export function parseHtmlElementAnchor\|export function parseHtmlElementContext\|export function buildPersistedHtmlAnchor" src/vendor/plannotator/html-anchor.ts
```

Expected: the three `export function` lines print. Record the commit hash for `VENDORED.md`.

- [ ] **Step 2: Write `VENDORED.md`**

```markdown
# Vendored from backnotprop/plannotator

Upstream: https://github.com/backnotprop/plannotator at tag `v0.27.25`
(commit `<hash from step 1>`; `@plannotator/ui` 0.49.0, `@plannotator/core` 0.25.9).
License: MIT (see LICENSE-MIT here). Upstream is dual MIT OR Apache-2.0; we take MIT.

| file | upstream path |
|---|---|
| bridge-script.ts | packages/ui/components/html-viewer/bridge-script.ts |
| html-anchor.ts | packages/core/html-anchor.ts |
| srcdoc.ts | packages/ui/components/html-viewer/srcdoc.ts |
| __tests__/html-anchor.test.ts | packages/core/html-anchor.test.ts (bun:test -> vitest) |
| image-annotator/* | packages/ui/components/ImageAnnotator/* |

## Local changes

Every change is fenced `// accumark: <name>` … `// /accumark`. Diff against upstream
by copying the upstream file over and `git diff`.

- srcdoc.ts `url-only`: the inline-script branch and the BRIDGE_SCRIPT import are
  removed so the 185 KB literal tree-shakes out of the app bundle; the bridge is
  always loaded by URL (spec §7.2).
- bridge-script.ts `headings` (Task 9), `edit-mode` and `serialize` (Task 18).
- image-annotator/index.tsx `local-shortcuts`: upstream imported ../../shortcuts,
  which is not vendored; a local keydown handler provides 1/2/3, Mod+Z,
  Mod+Shift+Z, Esc. `overlay-class`: `pn-visible-viewport-overlay` -> `fixed inset-0`.
- image-annotator/Toolbar.tsx `save-colour`: `bg-success text-success-foreground`
  (not in Mk1's theme) -> `bg-primary text-primary-foreground`.
- __tests__/html-anchor.test.ts: import source only.

Frozen at this tag. `BRIDGE_PROTOCOL_VERSION` is the drift check; the parent refuses
a bridge reporting another version.
```

- [ ] **Step 3: Apply the fenced edits**

`src/vendor/plannotator/srcdoc.ts`: change the import to `import { ANNOTATION_HIGHLIGHT_CSS } from "./bridge-script";` and replace `buildBridgeScriptTag` with:

```ts
// accumark: url-only
/** The bridge `<script>` element. Mk1 always serves the bridge as a static asset
 *  (spec §7.2: a srcdoc frame inherits the parent CSP), so the inline path is gone
 *  and `BRIDGE_SCRIPT` is not imported here, which lets the bundler drop it. */
export function buildBridgeScriptTag(bridgeScriptUrl?: string): string {
  if (!bridgeScriptUrl) {
    throw new Error("buildBridgeScriptTag: bridgeScriptUrl is required");
  }
  return `<script src="${escapeAttribute(bridgeScriptUrl)}"></script>`;
}
// /accumark
```

`src/vendor/plannotator/__tests__/html-anchor.test.ts`: change `from "bun:test"` to `from "vitest"` and `from "./html-anchor"` to `from "../html-anchor"`.

`src/vendor/plannotator/image-annotator/index.tsx`: delete the `useImageAnnotatorShortcuts` import and its call block; after `keyboardTargetIsInput` add:

```tsx
  // accumark: local-shortcuts
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (saving || keyboardTargetIsInput(event)) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (!mod && key === '1') setState((s) => ({ ...s, tool: 'pen' }));
      else if (!mod && key === '2') setState((s) => ({ ...s, tool: 'arrow' }));
      else if (!mod && key === '3') setState((s) => ({ ...s, tool: 'circle' }));
      else if (mod && key === 'z' && event.shiftKey) { if (state.futureStrokes.length) handleRedo(); }
      else if (mod && key === 'z') { if (state.strokes.length) handleUndo(); }
      else if (key === 'escape') { void handleAccept(); }
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // /accumark
```

and in its JSX replace `className="pn-visible-viewport-overlay z-[200] …"` with `className="fixed inset-0 z-[200] …"` (fence with a one-line `{/* accumark: overlay-class */}` comment above the element).

`src/vendor/plannotator/image-annotator/Toolbar.tsx`: in the Save button, `bg-success text-success-foreground` → `bg-primary text-primary-foreground`, with `{/* accumark: save-colour */}` above it.

- [ ] **Step 4: Exclude the vendor tree from lint, format, knip, ast-grep; add the dependency**

- `eslint.config.js` ignores: add `'src/vendor/**', // vendored MIT code, see src/vendor/plannotator/VENDORED.md`.
- `.prettierignore`: append `# Vendored MIT code (plannotator); keep upstream formatting diffable` and `src/vendor/`.
- `knip.json` `ignore`: add `"src/vendor/**"`.
- `sgconfig.yml` `languageGlobs.typescript`: add `- '!src/vendor/**'`.
- `npm install --save-exact perfect-freehand@1.2.2`.

- [ ] **Step 5: Verify**

Run: `npx vitest run src/vendor/plannotator/__tests__/html-anchor.test.ts` → all upstream cases pass.
Run: `npm run typecheck` → clean. If `noUnusedLocals` flags something inside a vendored file, remove the unused binding inside a fence; do not touch tsconfig.
Run: `npm run lint && npm run ast:lint && npm run format:check` → clean (vendor tree excluded). If ast-grep rejects the `!` glob, delete that line and confirm `npm run ast:lint` still passes on the vendor tree (its rules target app patterns).

- [ ] **Step 6: Commit**

```bash
cd C:/tmp/mk1-doc-annotations && git add src/vendor/plannotator eslint.config.js .prettierignore knip.json sgconfig.yml package.json package-lock.json && git commit -m "chore(vendor): plannotator bridge, anchor model, srcdoc injector, image annotator (MIT, v0.27.25)" -- src/vendor/plannotator eslint.config.js .prettierignore knip.json sgconfig.yml package.json package-lock.json
```

---

### Task 9: Bridge asset, the headings extension, and the jsdom harness

**Files:**
- Create: `scripts/build-bridge-asset.mts`, `public/pn-bridge.v1.js` (generated), `src/vendor/plannotator/__tests__/bridge-harness.ts`, `__tests__/bridge-asset.test.ts`, `__tests__/bridge-headings.test.ts`
- Modify: `src/vendor/plannotator/bridge-script.ts` (fenced `headings` extension), `package.json` scripts

**Interfaces:**
- Produces: `public/pn-bridge.v<BRIDGE_PROTOCOL_VERSION>.js` byte-identical to `BRIDGE_SCRIPT`; bridge message `plannotator-bridge-headings { headings: [{id, level, text}] }` after ready and after DOM mutations; `loadBridge(bodyHtml, headHtml?)` harness returning `{ posted, send(msg), tick(), last(type), dispose() }`.

- [ ] **Step 1: Write the asset test and the headings test (failing)**

```ts
// src/vendor/plannotator/__tests__/bridge-asset.test.ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_SCRIPT } from '../bridge-script'

describe('bridge asset', () => {
  it('public/pn-bridge.v<N>.js is byte-identical to BRIDGE_SCRIPT (run npm run build:bridge after editing the bridge)', () => {
    const asset = resolve(__dirname, '../../../../public', `pn-bridge.v${BRIDGE_PROTOCOL_VERSION}.js`)
    expect(readFileSync(asset, 'utf8')).toBe(BRIDGE_SCRIPT)
  })
})
```

```ts
// src/vendor/plannotator/__tests__/bridge-harness.ts
/**
 * Runs the real bridge IIFE inside vitest's jsdom window. In jsdom the top
 * window is its own `parent`, so the bridge's `parent.postMessage` lands on
 * this window (that is what a real parent would receive) and
 * `window.postMessage` plays the parent's role. Load ONCE per test file: the
 * IIFE registers global listeners that cannot be unregistered.
 */
import { BRIDGE_SCRIPT } from '../bridge-script'

export type BridgeMsg = { type: string } & Record<string, unknown>

export function loadBridge(bodyHtml: string, headHtml = '') {
  document.head.innerHTML = headHtml
  document.body.innerHTML = bodyHtml
  const posted: BridgeMsg[] = []
  const onMessage = (e: MessageEvent) => {
    const d = e.data as BridgeMsg | null
    if (d && typeof d.type === 'string' && d.type.startsWith('plannotator-bridge-')) posted.push(d)
  }
  window.addEventListener('message', onMessage)
  new Function(BRIDGE_SCRIPT)()
  const tick = () => new Promise<void>(r => setTimeout(r, 0))
  return {
    posted,
    tick,
    async send(msg: BridgeMsg) {
      window.postMessage(msg, '*')
      await tick()
      await tick()
    },
    last(type: string) {
      return [...posted].reverse().find(m => m.type === `plannotator-bridge-${type}`)
    },
    dispose() {
      window.removeEventListener('message', onMessage)
    },
  }
}
```

```ts
// src/vendor/plannotator/__tests__/bridge-headings.test.ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadBridge } from './bridge-harness'

let b: ReturnType<typeof loadBridge>

beforeAll(async () => {
  b = loadBridge('<h1>Title</h1><p>body</p><h2 id="own">Own</h2><h3>Deep <em>one</em></h3>')
  await b.tick()
  await b.tick()
})
afterAll(() => b.dispose())

describe('headings extension', () => {
  it('posts ready then the heading list, minting ids where the author gave none', () => {
    expect(b.last('ready')).toMatchObject({ protocolVersion: 1 })
    expect(b.last('headings')?.headings).toEqual([
      { id: 'pn-h-1', level: 1, text: 'Title' },
      { id: 'own', level: 2, text: 'Own' },
      { id: 'pn-h-2', level: 3, text: 'Deep one' },
    ])
    expect(document.querySelector('h1')?.id).toBe('pn-h-1')
  })

  it('re-posts after a mutation adds a heading, and not when nothing changed', async () => {
    const before = b.posted.filter(m => m.type === 'plannotator-bridge-headings').length
    document.body.insertAdjacentHTML('beforeend', '<h2>Added</h2>')
    await new Promise(r => setTimeout(r, 250))
    const after = b.posted.filter(m => m.type === 'plannotator-bridge-headings')
    expect(after.length).toBe(before + 1)
    expect(after.at(-1)?.headings).toHaveLength(4)
    document.body.insertAdjacentHTML('beforeend', '<p>no heading</p>')
    await new Promise(r => setTimeout(r, 250))
    expect(b.posted.filter(m => m.type === 'plannotator-bridge-headings').length).toBe(before + 1)
  })

  it('scroll-to-fragment scrolls a minted id into view', async () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView')
    await b.send({ type: 'plannotator-bridge-scroll-to-fragment', fragment: 'pn-h-2' })
    expect(spy).toHaveBeenCalled()
  })

  it('caps text at 130 chars and the list at 500', async () => {
    document.body.insertAdjacentHTML('beforeend', `<h4>${'x'.repeat(200)}</h4>`)
    await new Promise(r => setTimeout(r, 250))
    const list = b.last('headings')?.headings as Array<{ text: string }>
    expect(list.at(-1)?.text).toHaveLength(130)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/vendor/plannotator/__tests__/bridge-asset.test.ts src/vendor/plannotator/__tests__/bridge-headings.test.ts`
Expected: asset test fails (file missing); headings test fails (`last('headings')` undefined). If the harness itself throws on a missing browser API, add a minimal polyfill to `src/test/setup.ts` (the existing file already polyfills `scrollIntoView` and `ResizeObserver` is guarded by the bridge).

- [ ] **Step 3: Add the headings extension to the bridge**

In `src/vendor/plannotator/bridge-script.ts`, inside the IIFE, directly above `function watchPageMutations() {` (line ~4980), add:

```js
  // accumark: headings
  // Contents sidebar feed (spec §7.4 ext 1). Headings without an id get one so
  // the parent's existing scroll-to-fragment can reach them; the id is removed
  // again by serialize (Task 18). Debounced and deduplicated by content.
  var HEADINGS_MAX = 500, HEADING_TEXT_MAX = 130;
  var headingSeq = 0, headingsTimer = 0, lastHeadingsJson = '';
  function collectHeadings() {
    var out = [];
    var nodes = document.querySelectorAll('h1, h2, h3, h4');
    for (var i = 0; i < nodes.length && out.length < HEADINGS_MAX; i++) {
      var h = nodes[i];
      if (isViewerOverlayNode(h)) continue;
      if (!h.id) { headingSeq += 1; h.id = 'pn-h-' + headingSeq; }
      var text = (h.textContent || '').replace(/\\s+/g, ' ').trim();
      if (text.length > HEADING_TEXT_MAX) text = text.slice(0, HEADING_TEXT_MAX);
      out.push({ id: h.id, level: Number(h.tagName.charAt(1)) || 1, text: text });
    }
    return out;
  }
  function postHeadings() {
    headingsTimer = 0;
    var list = collectHeadings();
    var json = JSON.stringify(list);
    if (json === lastHeadingsJson) return;
    lastHeadingsJson = json;
    postToParent({ type: PREFIX + 'headings', headings: list });
  }
  function scheduleHeadings() {
    if (headingsTimer) return;
    headingsTimer = setTimeout(postHeadings, 150);
  }
  // /accumark
```

Note the `\\s` in the regex: the bridge is a JS template literal, so a backslash must be doubled to reach the frame as `\s`.

In `watchPageMutations`, inside the observer callback after `domGeneration += 1;`, add `scheduleHeadings(); // accumark: headings`. In `onReady`, after `watchPageMutations();`, add `postHeadings(); // accumark: headings`.

- [ ] **Step 4: Generate the asset**

```ts
// scripts/build-bridge-asset.mts
// Writes public/pn-bridge.v<N>.js from the vendored bridge string (spec §7.2).
// Node 22.6+ strips the .ts import's types natively; the dev boxes run Node 24.
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_SCRIPT } from '../src/vendor/plannotator/bridge-script.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(root, 'public', `pn-bridge.v${BRIDGE_PROTOCOL_VERSION}.js`)
writeFileSync(out, BRIDGE_SCRIPT)
console.log(`wrote ${out} (${BRIDGE_SCRIPT.length} chars)`)
```

`package.json` scripts: add `"build:bridge": "node scripts/build-bridge-asset.mts"`. Run `npm run build:bridge`. Add `public/pn-bridge.v1.js` to `.prettierignore` (generated) and `# generated by npm run build:bridge` next to it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/vendor/plannotator/__tests__/`
Expected: asset, headings, and html-anchor suites pass.

- [ ] **Step 6: Commit**

```bash
cd C:/tmp/mk1-doc-annotations && git add scripts/build-bridge-asset.mts public/pn-bridge.v1.js src/vendor/plannotator/bridge-script.ts src/vendor/plannotator/__tests__ package.json .prettierignore && git commit -m "feat(viewer): bridge served as a static asset; headings extension; jsdom bridge harness" -- scripts/build-bridge-asset.mts public/pn-bridge.v1.js src/vendor/plannotator/bridge-script.ts src/vendor/plannotator/__tests__ package.json .prettierignore
```

---

### Task 10: API client and TanStack hooks

**Files:**
- Create: `src/lib/api-document-comments.ts`, `src/services/document-comments.ts`, `src/lib/__tests__/api-document-comments.test.ts`
- Modify: `src/lib/api-documents.ts` (`DocumentRow.open_comment_count: number`)

**Interfaces:**
- Produces types `CommentKind`, `CommentStatus`, `CommentStatusFilter`, `HtmlElementAnchor`, `CommentAnchor`, `CommentAttachment`, `DocumentComment`, `CommentListResponse`, `CommentCreate`, `CommentPatch`, `CommentLabel`; functions `listDocumentComments(docId, status)`, `createDocumentComment(docId, body)`, `patchDocumentComment(id, body)`, `deleteDocumentComment(id)`, `setDocumentCommentStatus(id, status)`, `listCommentLabels()`, `addDocumentCommentAttachment(docId, blob, name)`, `fetchDocumentCommentAttachmentUrl(id)`; hooks `useDocumentComments(docId, status)`, `useCommentLabels()`, `useCreateComment(docId)`, `usePatchComment(docId)`, `useDeleteComment(docId)`, `useSetCommentStatus(docId)`, `commentKeys`.

- [ ] **Step 1: Write the failing client test**

```ts
// src/lib/__tests__/api-document-comments.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({
  apiFetch,
  API_BASE_URL: () => 'http://api',
  getBearerHeaders: (ct?: string) => (ct ? { Authorization: 'Bearer t', 'Content-Type': ct } : { Authorization: 'Bearer t' }),
}))

describe('api-document-comments', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    vi.stubGlobal('fetch', vi.fn())
  })

  it('lists by revision id with a status filter', async () => {
    const { listDocumentComments } = await import('@/lib/api-document-comments')
    apiFetch.mockResolvedValue({ items: [] })
    await listDocumentComments(7, 'all')
    expect(apiFetch).toHaveBeenCalledWith('/api/documents/7/comments?status=all')
  })

  it('create surfaces the server detail on a 400', async () => {
    const { createDocumentComment } = await import('@/lib/api-document-comments')
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false, status: 400, json: async () => ({ detail: 'quote not found in ART-0001 r1: "x"' }),
    })
    await expect(createDocumentComment(7, { body: 'b', anchor: { originalText: 'x' } }))
      .rejects.toThrow('quote not found in ART-0001 r1: "x"')
  })

  it('delete uses a raw DELETE (apiFetch would try to parse the 204 body)', async () => {
    const { deleteDocumentComment } = await import('@/lib/api-document-comments')
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 204 })
    await deleteDocumentComment(9)
    expect(fetch).toHaveBeenCalledWith('http://api/api/documents/comments/9', expect.objectContaining({ method: 'DELETE' }))
  })

  it('uploads an attachment as multipart field "file"', async () => {
    const { addDocumentCommentAttachment } = await import('@/lib/api-document-comments')
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: 3 }) })
    await addDocumentCommentAttachment(7, new Blob([new Uint8Array([1])]), 'shot.png')
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('http://api/api/documents/7/comment-attachments')
    expect((init.body as FormData).get('file')).toBeInstanceOf(Blob)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/__tests__/api-document-comments.test.ts` → FAIL, module not found.

- [ ] **Step 3: Write the client**

```ts
// src/lib/api-document-comments.ts
/**
 * Document comments API client (spec 2026-10-03 §6). A sibling of api-documents.ts.
 * Create/patch use raw fetch so the server's `detail` ("quote not found…",
 * "anchor is N bytes…") reaches the composer; apiFetch only reports the status.
 */
import { API_BASE_URL, apiFetch, getBearerHeaders } from '@/lib/api'

export type CommentKind = 'comment' | 'suggestion'
export type CommentStatus = 'open' | 'resolved'
export type CommentStatusFilter = CommentStatus | 'all'

export interface HtmlAnchorPoint {
  x: number
  y: number
}
export interface HtmlElementAnchor {
  selector: string
  tagName: string
  text?: string
  point?: HtmlAnchorPoint
}
export interface HtmlAnnotationTarget {
  label?: string
  text: string
  anchor?: HtmlElementAnchor
  context?: Record<string, unknown>
}
/** Stored verbatim as plannotator's PersistedHtmlAnchor; null = document-level. */
export interface CommentAnchor {
  originalText: string
  htmlAnchor?: HtmlElementAnchor
  htmlAdditionalTargets?: HtmlAnnotationTarget[]
  elementContext?: Record<string, unknown> & { heading?: string; path?: string }
}
export interface CommentAttachment {
  id: number
  filename: string
  content_type: string
  size_bytes: number
  created_at: string
}
export interface DocumentComment {
  id: number
  code: string
  document_id: number
  revision: number
  parent_id: number | null
  number: number | null
  kind: CommentKind
  anchor: CommentAnchor | null
  label: string | null
  body: string
  suggested_text: string | null
  author: string
  author_user_id: number | null
  author_agent: string | null
  status: CommentStatus
  resolved_at: string | null
  resolved_by: string | null
  created_at: string
  updated_at: string
  edited_at: string | null
  attachments: CommentAttachment[]
  replies: DocumentComment[]
}
export interface CommentListResponse {
  items: DocumentComment[]
  code: string
  latest_revision: number
  open_count: number
}
export interface CommentCreate {
  parent_id?: number
  kind?: CommentKind
  anchor?: CommentAnchor | null
  label?: string | null
  body: string
  suggested_text?: string | null
}
export interface CommentPatch {
  body?: string
  suggested_text?: string
}
export interface CommentLabel {
  id: string
  emoji: string
  text: string
  color: string
  tip: string | null
}

async function errorDetail(res: Response, ctx: string): Promise<string> {
  try {
    const j = (await res.json()) as { detail?: unknown }
    if (typeof j?.detail === 'string') return j.detail
  } catch {
    /* not json */
  }
  return `${ctx} failed: ${res.status}`
}

export function listDocumentComments(docId: number, status: CommentStatusFilter = 'open') {
  return apiFetch<CommentListResponse>(`/api/documents/${docId}/comments?status=${status}`)
}

export async function createDocumentComment(docId: number, body: CommentCreate): Promise<DocumentComment> {
  const path = `/api/documents/${docId}/comments`
  const res = await fetch(`${API_BASE_URL()}${path}`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await errorDetail(res, `POST ${path}`))
  return (await res.json()) as DocumentComment
}

export async function patchDocumentComment(id: number, body: CommentPatch): Promise<DocumentComment> {
  const path = `/api/documents/comments/${id}`
  const res = await fetch(`${API_BASE_URL()}${path}`, {
    method: 'PATCH',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await errorDetail(res, `PATCH ${path}`))
  return (await res.json()) as DocumentComment
}

export async function deleteDocumentComment(id: number): Promise<void> {
  const res = await fetch(`${API_BASE_URL()}/api/documents/comments/${id}`, {
    method: 'DELETE',
    headers: getBearerHeaders(),
  })
  if (!res.ok) throw new Error(`DELETE /api/documents/comments/${id} failed: ${res.status}`)
}

export function setDocumentCommentStatus(id: number, status: CommentStatus) {
  const verb = status === 'resolved' ? 'resolve' : 'reopen'
  return apiFetch<DocumentComment>(`/api/documents/comments/${id}/${verb}`, { method: 'POST' })
}

export function listCommentLabels() {
  return apiFetch<CommentLabel[]>('/api/documents/comment-labels')
}

export async function addDocumentCommentAttachment(
  docId: number,
  file: Blob,
  name = 'image.png'
): Promise<CommentAttachment> {
  const form = new FormData()
  form.append('file', file, name)
  const res = await fetch(`${API_BASE_URL()}/api/documents/${docId}/comment-attachments`, {
    method: 'POST',
    headers: getBearerHeaders(),
    body: form,
  })
  if (!res.ok) throw new Error(await errorDetail(res, 'attachment upload'))
  return (await res.json()) as CommentAttachment
}

const _urlCache = new Map<number, string>()
/** Bearer-authed blob URL for an attachment (the backend serves bytes, never public URLs). */
export async function fetchDocumentCommentAttachmentUrl(id: number): Promise<string | null> {
  const cached = _urlCache.get(id)
  if (cached) return cached
  const res = await fetch(`${API_BASE_URL()}/api/documents/comment-attachments/${id}`, {
    headers: getBearerHeaders(),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`fetchDocumentCommentAttachmentUrl failed: ${res.status}`)
  const url = URL.createObjectURL(await res.blob())
  _urlCache.set(id, url)
  return url
}
```

Add to `DocumentRow` in `src/lib/api-documents.ts`: `/** Open top-level comments on this code (spec §6.2). */ open_comment_count: number`.

- [ ] **Step 4: Write the hooks**

```ts
// src/services/document-comments.ts
/** TanStack Query hooks for document comments. Mirrors services/documents.ts. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  createDocumentComment,
  deleteDocumentComment,
  listCommentLabels,
  listDocumentComments,
  patchDocumentComment,
  setDocumentCommentStatus,
  type CommentCreate,
  type CommentPatch,
  type CommentStatus,
  type CommentStatusFilter,
} from '@/lib/api-document-comments'
import { documentKeys } from '@/services/documents'

export const commentKeys = {
  all: ['document-comments'] as const,
  list: (docId: number, status: CommentStatusFilter) =>
    ['document-comments', 'list', docId, status] as const,
  labels: ['document-comments', 'labels'] as const,
}

export function useDocumentComments(docId: number | null, status: CommentStatusFilter = 'open') {
  return useQuery({
    queryKey: commentKeys.list(docId ?? -1, status),
    queryFn: () => listDocumentComments(docId as number, status),
    enabled: docId != null,
    refetchOnWindowFocus: true, // no SSE in v1 (spec §2)
  })
}

export function useCommentLabels() {
  return useQuery({ queryKey: commentKeys.labels, queryFn: listCommentLabels, staleTime: Infinity })
}

function useInvalidateComments(docId: number) {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: commentKeys.all })
    void qc.invalidateQueries({ queryKey: documentKeys.detail(docId) })
    void qc.invalidateQueries({ queryKey: documentKeys.lists })
  }
}

export function useCreateComment(docId: number) {
  const invalidate = useInvalidateComments(docId)
  return useMutation({
    mutationFn: (body: CommentCreate) => createDocumentComment(docId, body),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  })
}

export function usePatchComment(docId: number) {
  const invalidate = useInvalidateComments(docId)
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: CommentPatch }) => patchDocumentComment(id, body),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteComment(docId: number) {
  const invalidate = useInvalidateComments(docId)
  return useMutation({
    mutationFn: (id: number) => deleteDocumentComment(id),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useSetCommentStatus(docId: number) {
  const invalidate = useInvalidateComments(docId)
  return useMutation({
    mutationFn: ({ id, status }: { id: number; status: CommentStatus }) =>
      setDocumentCommentStatus(id, status),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  })
}
```

- [ ] **Step 5: Run the test to verify it passes; typecheck**

Run: `npx vitest run src/lib/__tests__/api-document-comments.test.ts && npm run typecheck` → pass, clean.

- [ ] **Step 6: Commit**

```bash
cd C:/tmp/mk1-doc-annotations && git add src/lib/api-document-comments.ts src/services/document-comments.ts src/lib/__tests__/api-document-comments.test.ts src/lib/api-documents.ts && git commit -m "feat(viewer): document comments API client and query hooks" -- src/lib/api-document-comments.ts src/services/document-comments.ts src/lib/__tests__/api-document-comments.test.ts src/lib/api-documents.ts
```

---

### Task 11: The trust boundary: `useDocumentBridge`, message parsing, injection stripping

**Files:**
- Create: `src/components/documents/annotations/bridge-messages.ts`, `useDocumentBridge.ts`, `stripViewerInjection.ts`, `__tests__/bridge-messages.test.ts`, `__tests__/useDocumentBridge.test.tsx`, `__tests__/stripViewerInjection.test.ts`

**Interfaces:**
- Produces: `PN`, `parseBridgeMessage(data)`, types `Rect`, `BridgeHeading`, `BridgeSelection`; `useDocumentBridge(options): DocumentBridge` with `{ status, unavailable, headings, unanchoredIds, height, createMark, cancelSelection, removeMark, scrollTo, scrollToFragment, setEditMode, serialize, applyReplacement }`; `BridgeComment`; `openDocumentLink(href, open?)`; `stripViewerInjection(html, original)`, `INJECT_OPEN`, `INJECT_CLOSE`.
- Consumes: `parseHtmlElementAnchor`, `parseHtmlElementContext` from the vendored anchor module; `BRIDGE_PROTOCOL_VERSION` from the vendored bridge.

- [ ] **Step 1: Write the failing tests**

```ts
// src/components/documents/annotations/__tests__/bridge-messages.test.ts
import { describe, expect, it } from 'vitest'
import { parseBridgeMessage } from '../bridge-messages'

const t = (type: string, rest: Record<string, unknown> = {}) => ({ type: `plannotator-bridge-${type}`, ...rest })

describe('parseBridgeMessage', () => {
  it('rejects foreign and malformed messages', () => {
    expect(parseBridgeMessage(null)).toBeNull()
    expect(parseBridgeMessage({ type: 'other' })).toBeNull()
    expect(parseBridgeMessage(t('mark-click', { id: 'x'.repeat(257) }))).toBeNull()
    expect(parseBridgeMessage(t('selection', { text: 'a'.repeat(10_001), rect: { top: 0, left: 0, width: 1, height: 1 } }))).toBeNull()
    expect(parseBridgeMessage(t('headings', { headings: new Array(501).fill({ id: 'a', level: 1, text: 'b' }) }))).toBeNull()
    expect(parseBridgeMessage(t('headings', { headings: [{ id: 'a', level: 9, text: 'b' }] }))).toBeNull()
  })

  it('clamps resize heights', () => {
    expect(parseBridgeMessage(t('resize', { height: 1e9 }))).toEqual({ type: 'resize', height: 50_000 })
    expect(parseBridgeMessage(t('resize', { height: 5 }))).toEqual({ type: 'resize', height: 200 })
    expect(parseBridgeMessage(t('resize', { height: Number.NaN }))).toBeNull()
  })

  it('parses a selection and drops an invalid element anchor without dropping the selection', () => {
    const m = parseBridgeMessage(t('selection', {
      text: 'quoted', rect: { top: 1, left: 2, width: 3, height: 4 }, pinpoint: true,
      anchor: { selector: 'p', tagName: 'p' }, context: { tag: 'p', heading: 'h2 "X"' },
    }))
    expect(m).toMatchObject({ type: 'selection', selection: { text: 'quoted', pinpoint: true, anchor: { selector: 'p', tagName: 'p' } } })
    const bad = parseBridgeMessage(t('selection', { text: 'q', rect: { top: 0, left: 0, width: 0, height: 0 }, anchor: { selector: 5 } }))
    expect(bad).toMatchObject({ type: 'selection', selection: { anchor: null } })
  })

  it('parses unanchored ids, link clicks, and serialized html with caps', () => {
    expect(parseBridgeMessage(t('unanchored', { ids: ['1', 2, 'x'.repeat(300)] }))).toEqual({ type: 'unanchored', ids: ['1'] })
    expect(parseBridgeMessage(t('link-click', { href: 'https://a.b/c' }))).toEqual({ type: 'link-click', href: 'https://a.b/c' })
    expect(parseBridgeMessage(t('serialized', { html: '<p>x</p>', appliedId: '7' }))).toEqual({ type: 'serialized', html: '<p>x</p>', appliedId: '7' })
  })
})
```

```tsx
// src/components/documents/annotations/__tests__/useDocumentBridge.test.tsx
import { act, render, screen, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { BRIDGE_PROTOCOL_VERSION } from '@/vendor/plannotator/bridge-script'
import { openDocumentLink, useDocumentBridge, type BridgeComment, type DocumentBridge } from '../useDocumentBridge'

/** Reports the latest hook value on every render; the frame is read from the DOM by title. */
function Harness({ comments, onBridge, onSelection = () => {} }: {
  comments: BridgeComment[]
  onBridge: (b: DocumentBridge) => void
  onSelection?: (s: unknown) => void
}) {
  const ref = useRef<HTMLIFrameElement>(null)
  const bridge = useDocumentBridge({
    iframeRef: ref, documentKey: 'doc', comments, inputMethod: 'drag', annotateActive: true,
    onSelection, onMarkClick: () => {}, readyTimeoutMs: 200,
  })
  onBridge(bridge)
  return <iframe ref={ref} title="t" sandbox="allow-scripts" srcDoc="<p>x</p>" />
}

const theFrame = () => screen.getByTitle('t') as HTMLIFrameElement

function frameMessage(data: unknown, origin = 'null', source: Window | null = theFrame().contentWindow) {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source: source ?? undefined }))
}

const comment: BridgeComment = { id: '5', type: 'comment', originalText: 'hello', anchor: null, additionalAnchors: null, number: 1 }

describe('useDocumentBridge', () => {
  it('ignores messages from the wrong source or a non-null origin', () => {
    let bridge!: DocumentBridge
    const onSelection = vi.fn()
    render(<Harness comments={[]} onSelection={onSelection} onBridge={b => { bridge = b }} />)
    expect(theFrame().contentWindow).toBeTruthy()
    const sel = { type: 'plannotator-bridge-selection', text: 'q', rect: { top: 0, left: 0, width: 1, height: 1 } }
    act(() => frameMessage(sel, 'null', window))
    act(() => frameMessage(sel, 'https://evil.example'))
    expect(onSelection).not.toHaveBeenCalled()
    act(() => frameMessage(sel))
    expect(onSelection).toHaveBeenCalledTimes(1)
    expect(bridge.status).toBe('loading')
  })

  it('marks the bridge unavailable on a version mismatch', async () => {
    let bridge!: DocumentBridge
    render(<Harness comments={[]} onBridge={b => { bridge = b }} />)
    act(() => frameMessage({ type: 'plannotator-bridge-ready', protocolVersion: BRIDGE_PROTOCOL_VERSION + 1 }))
    await waitFor(() => expect(bridge.unavailable).toEqual({ kind: 'version-mismatch', reported: BRIDGE_PROTOCOL_VERSION + 1 }))
  })

  it('on ready replays every comment as find-and-mark, then numbering and the unanchored request', async () => {
    render(<Harness comments={[comment]} onBridge={() => {}} />)
    const post = vi.spyOn(theFrame().contentWindow!, 'postMessage')
    act(() => frameMessage({ type: 'plannotator-bridge-ready', protocolVersion: BRIDGE_PROTOCOL_VERSION }))
    await waitFor(() => expect(post).toHaveBeenCalled())
    const types = post.mock.calls.map(c => (c[0] as { type: string }).type.replace('plannotator-bridge-', ''))
    expect(types).toEqual(expect.arrayContaining(['set-input-method', 'set-annotate-mode', 'clear-marks', 'find-and-mark', 'sync-annotations', 'report-unanchored']))
    const fam = post.mock.calls.find(c => (c[0] as { type: string }).type === 'plannotator-bridge-find-and-mark')![0]
    expect(fam).toMatchObject({ id: '5', annotationType: 'comment', originalText: 'hello' })
    expect(post.mock.calls.every(c => c[1] === '*')).toBe(true)
  })

  it('times out to unavailable when no ready arrives', async () => {
    let bridge!: DocumentBridge
    render(<Harness comments={[]} onBridge={b => { bridge = b }} />)
    await waitFor(() => expect(bridge.unavailable).toEqual({ kind: 'timeout' }), { timeout: 1000 })
  })
})

describe('openDocumentLink', () => {
  it('opens only http(s) in a new tab', () => {
    const open = vi.fn()
    openDocumentLink('https://x.y/z', open)
    openDocumentLink('http://x.y/z', open)
    openDocumentLink('javascript:alert(1)', open)
    openDocumentLink('file:///etc/passwd', open)
    openDocumentLink('/relative', open)
    expect(open.mock.calls.map(c => c[0])).toEqual(['https://x.y/z', 'http://x.y/z'])
  })
})
```

```ts
// src/components/documents/annotations/__tests__/stripViewerInjection.test.ts
import { describe, expect, it } from 'vitest'
import { INJECT_CLOSE, INJECT_OPEN, stripViewerInjection } from '../stripViewerInjection'

const ORIGINAL = '<!doctype html><html><head><style>/* accumark-docs v1 */</style></head><body><p>Hi</p></body></html>'
const THEMED_ORIGINAL = '<!doctype html><html data-theme="light"><head></head><body><p>Hi</p></body></html>'

describe('stripViewerInjection', () => {
  it('removes the injection block, the bridge script tag, the stamp, and contenteditable; author bytes stay', () => {
    const viewed = ORIGINAL
      .replace('<html>', '<html data-theme="dark">')
      .replace('</head>', `${INJECT_OPEN}<style>:root{--pn-x:1}</style><script src="http://m/pn-bridge.v1.js"></script>${INJECT_CLOSE}</head>`)
      .replace('<body>', '<body contenteditable="true">')
    expect(stripViewerInjection(viewed, ORIGINAL)).toBe(ORIGINAL)
  })

  it('restores an author-set data-theme instead of removing it', () => {
    const viewed = THEMED_ORIGINAL.replace('data-theme="light"', 'data-theme="dark"')
    expect(stripViewerInjection(viewed, THEMED_ORIGINAL)).toBe(THEMED_ORIGINAL)
  })

  it('is a no-op on untouched html', () => {
    expect(stripViewerInjection(ORIGINAL, ORIGINAL)).toBe(ORIGINAL)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/components/documents/annotations/` → FAIL, modules not found.

- [ ] **Step 3: Write `bridge-messages.ts`**

```ts
// src/components/documents/annotations/bridge-messages.ts
/**
 * Shape-checking for messages from the sandboxed document frame (spec §7.3).
 * The frame is untrusted content: everything is validated and capped here,
 * anchors through the vendored upstream validators, before the app sees it.
 */
import {
  parseHtmlElementAnchor,
  parseHtmlElementContext,
  type HtmlElementAnchor,
  type HtmlElementContext,
} from '@/vendor/plannotator/html-anchor'

export const PN = 'plannotator-bridge-'
export const MAX_SELECTION_TEXT = 10_000
export const MAX_ID = 256
export const MAX_HEADINGS = 500
export const MAX_HEADING_TEXT = 130
export const MAX_SERIALIZED = 16 * 1024 * 1024
export const MIN_FRAME_HEIGHT = 200
export const MAX_FRAME_HEIGHT = 50_000

export interface Rect {
  top: number
  left: number
  width: number
  height: number
}
export interface BridgeHeading {
  id: string
  level: number
  text: string
}
export interface BridgeSelection {
  text: string
  rect: Rect
  anchor: HtmlElementAnchor | null
  context: HtmlElementContext | null
  pinpoint: boolean
  targetLabel?: string
  targetKey?: string
}

export type ParsedBridgeMessage =
  | { type: 'ready'; protocolVersion: number | undefined }
  | { type: 'selection'; selection: BridgeSelection }
  | { type: 'selection-rect'; rect: Rect }
  | { type: 'selection-clear' }
  | { type: 'mark-click'; id: string }
  | { type: 'mark-applied'; id: string; success: boolean }
  | { type: 'unanchored'; ids: string[] }
  | { type: 'resize'; height: number }
  | { type: 'link-click'; href: string }
  | { type: 'headings'; headings: BridgeHeading[] }
  | { type: 'serialized'; html: string; appliedId?: string }
  | { type: 'apply-failed'; id: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : null
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function rect(v: unknown): Rect | null {
  if (!isRecord(v)) return null
  const top = num(v.top)
  const left = num(v.left)
  const width = num(v.width)
  const height = num(v.height)
  if (top === null || left === null || width === null || height === null) return null
  return { top, left, width, height }
}

/** Returns null for anything unknown, malformed, or over a cap. */
export function parseBridgeMessage(data: unknown): ParsedBridgeMessage | null {
  if (!isRecord(data) || typeof data.type !== 'string' || !data.type.startsWith(PN)) return null
  const type = data.type.slice(PN.length)
  switch (type) {
    case 'ready':
      return { type, protocolVersion: num(data.protocolVersion) ?? undefined }
    case 'selection': {
      const text = typeof data.text === 'string' && data.text.length <= MAX_SELECTION_TEXT ? data.text : null
      const r = rect(data.rect)
      if (text === null || !r) return null
      return {
        type,
        selection: {
          text,
          rect: r,
          anchor: parseHtmlElementAnchor(data.anchor) ?? null,
          context: parseHtmlElementContext(data.context) ?? null,
          pinpoint: data.pinpoint === true,
          targetLabel: str(data.targetLabel, 64) ?? undefined,
          targetKey: str(data.targetKey, MAX_ID) ?? undefined,
        },
      }
    }
    case 'selection-rect': {
      const r = rect(data.rect)
      return r ? { type, rect: r } : null
    }
    case 'selection-clear':
      return { type }
    case 'mark-click': {
      const id = str(data.id, MAX_ID)
      return id ? { type, id } : null
    }
    case 'mark-applied': {
      const id = str(data.id, MAX_ID)
      return id ? { type, id, success: data.success === true } : null
    }
    case 'unanchored': {
      if (!Array.isArray(data.ids) || data.ids.length > 10_000) return null
      const ids = data.ids.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= MAX_ID)
      return { type, ids }
    }
    case 'resize': {
      const h = num(data.height)
      if (h === null) return null
      return { type, height: Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.round(h))) }
    }
    case 'link-click': {
      const href = str(data.href, 2048)
      return href ? { type, href } : null
    }
    case 'headings': {
      if (!Array.isArray(data.headings) || data.headings.length > MAX_HEADINGS) return null
      const headings: BridgeHeading[] = []
      for (const h of data.headings) {
        if (!isRecord(h)) return null
        const id = str(h.id, MAX_ID)
        const level = num(h.level)
        const text = typeof h.text === 'string' && h.text.length <= MAX_HEADING_TEXT ? h.text : null
        if (!id || level === null || level < 1 || level > 6 || text === null) return null
        headings.push({ id, level, text })
      }
      return { type, headings }
    }
    case 'serialized': {
      const html = typeof data.html === 'string' && data.html.length <= MAX_SERIALIZED ? data.html : null
      if (html === null) return null
      return { type, html, appliedId: str(data.appliedId, MAX_ID) ?? undefined }
    }
    case 'apply-failed': {
      const id = str(data.id, MAX_ID)
      return id ? { type, id } : null
    }
    default:
      return null
  }
}
```

If the vendored validators return `undefined` rather than `null` for a bad value, the `?? null` above already normalizes; if they THROW, wrap each call in a small `safe(() => …)` helper returning null.

- [ ] **Step 4: Write `useDocumentBridge.ts`**

```ts
// src/components/documents/annotations/useDocumentBridge.ts
/**
 * Parent side of the document frame protocol (spec §7.3). One listener, one
 * trust boundary: a message is handled only when it comes from THIS iframe's
 * window with the null origin a sandboxed srcdoc has, and parses cleanly.
 * Nothing here touches contentDocument; it cannot, and the design depends on
 * that staying true.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { BRIDGE_PROTOCOL_VERSION } from '@/vendor/plannotator/bridge-script'
import type { HtmlElementAnchor } from '@/vendor/plannotator/html-anchor'
import {
  MIN_FRAME_HEIGHT,
  PN,
  parseBridgeMessage,
  type BridgeHeading,
  type BridgeSelection,
  type Rect,
} from './bridge-messages'

export type { BridgeHeading, BridgeSelection, Rect } from './bridge-messages'

export interface BridgeComment {
  id: string
  type: 'comment' | 'deletion'
  originalText: string
  anchor: HtmlElementAnchor | null
  additionalAnchors: HtmlElementAnchor[] | null
  number: number
}
export type BridgeStatus = 'loading' | 'ready' | 'unavailable'
export interface BridgeUnavailable {
  kind: 'timeout' | 'version-mismatch'
  reported?: number
}
export interface UseDocumentBridgeOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>
  /** Changes whenever a new srcDoc loads; resets the handshake. */
  documentKey: string | number
  comments: BridgeComment[]
  inputMethod: 'drag' | 'pinpoint'
  annotateActive: boolean
  onSelection: (s: BridgeSelection | null) => void
  onSelectionRect?: (r: Rect) => void
  onMarkClick: (id: string) => void
  onSerialized?: (html: string, appliedId?: string) => void
  onApplyFailed?: (id: string) => void
  readyTimeoutMs?: number
}
export interface DocumentBridge {
  status: BridgeStatus
  unavailable: BridgeUnavailable | null
  headings: BridgeHeading[]
  unanchoredIds: ReadonlySet<string>
  height: number
  createMark: (id: string, type: 'comment' | 'deletion') => void
  cancelSelection: () => void
  removeMark: (id: string) => void
  scrollTo: (id: string) => void
  scrollToFragment: (id: string) => void
  setEditMode: (on: boolean) => void
  serialize: () => void
  applyReplacement: (id: string, text: string) => void
}

/** Only http(s), always in a new tab with no opener (spec §11). */
export function openDocumentLink(
  href: string,
  open: (url: string) => void = url => {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
) {
  if (/^https?:\/\//i.test(href)) open(href)
}

export function useDocumentBridge(options: UseDocumentBridgeOptions): DocumentBridge {
  const [status, setStatus] = useState<BridgeStatus>('loading')
  const [unavailable, setUnavailable] = useState<BridgeUnavailable | null>(null)
  const [headings, setHeadings] = useState<BridgeHeading[]>([])
  const [unanchoredIds, setUnanchored] = useState<ReadonlySet<string>>(() => new Set())
  const [height, setHeight] = useState(MIN_FRAME_HEIGHT)
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })

  const post = useCallback((msg: Record<string, unknown>) => {
    // '*' is required: a sandboxed srcdoc frame has an opaque origin, which no
    // concrete targetOrigin can name. The frame holds no secrets of ours.
    latest.current.iframeRef.current?.contentWindow?.postMessage(msg, '*')
  }, [])

  const replay = useCallback(() => {
    const { comments, inputMethod, annotateActive } = latest.current
    post({ type: `${PN}set-input-method`, method: inputMethod })
    post({ type: `${PN}set-annotate-mode`, active: annotateActive })
    post({ type: `${PN}clear-marks` })
    for (const c of comments) {
      post({
        type: `${PN}find-and-mark`,
        id: c.id,
        annotationType: c.type,
        originalText: c.originalText,
        anchor: c.anchor ?? undefined,
        additionalAnchors: c.additionalAnchors ?? undefined,
      })
    }
    post({ type: `${PN}sync-annotations`, annotations: comments.map(c => ({ id: c.id, number: c.number })) })
    post({ type: `${PN}report-unanchored` })
  }, [post])

  // A new document: start the handshake over.
  useEffect(() => {
    setStatus('loading')
    setUnavailable(null)
    setHeadings([])
    setUnanchored(new Set())
  }, [options.documentKey])

  // No ready within the timeout: the document renders without tools (spec §7.2).
  useEffect(() => {
    if (status !== 'loading') return
    const t = setTimeout(() => {
      setStatus('unavailable')
      setUnavailable({ kind: 'timeout' })
    }, options.readyTimeoutMs ?? 8000)
    return () => clearTimeout(t)
  }, [status, options.documentKey, options.readyTimeoutMs])

  // The trust boundary.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = latest.current.iframeRef.current
      if (!frame || e.source !== frame.contentWindow || e.origin !== 'null') return
      const m = parseBridgeMessage(e.data)
      if (!m) return
      switch (m.type) {
        case 'ready':
          if (m.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
            setStatus('unavailable')
            setUnavailable({ kind: 'version-mismatch', reported: m.protocolVersion })
            return
          }
          setStatus('ready')
          setUnavailable(null)
          replay()
          return
        case 'selection':
          latest.current.onSelection(m.selection)
          return
        case 'selection-rect':
          latest.current.onSelectionRect?.(m.rect)
          return
        case 'selection-clear':
          latest.current.onSelection(null)
          return
        case 'mark-click':
          latest.current.onMarkClick(m.id)
          return
        case 'unanchored':
          setUnanchored(new Set(m.ids))
          return
        case 'resize':
          setHeight(m.height)
          return
        case 'link-click':
          openDocumentLink(m.href)
          return
        case 'headings':
          setHeadings(m.headings)
          return
        case 'serialized':
          latest.current.onSerialized?.(m.html, m.appliedId)
          return
        case 'apply-failed':
          latest.current.onApplyFailed?.(m.id)
          return
        default:
          return
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [replay])

  // Re-sync marks when the comment set or the mode changes.
  const commentsKey = JSON.stringify(options.comments.map(c => [c.id, c.type, c.number, c.originalText]))
  useEffect(() => {
    if (status === 'ready') replay()
  }, [status, commentsKey, options.inputMethod, options.annotateActive, replay])

  return {
    status,
    unavailable,
    headings,
    unanchoredIds,
    height,
    createMark: (id, type) => post({ type: `${PN}create-mark`, id, annotationType: type }),
    cancelSelection: () => post({ type: `${PN}cancel-selection` }),
    removeMark: id => post({ type: `${PN}remove-mark`, id }),
    scrollTo: id => {
      post({ type: `${PN}scroll-to`, id })
      post({ type: `${PN}focus-mark`, id })
    },
    scrollToFragment: id => post({ type: `${PN}scroll-to-fragment`, fragment: id }),
    setEditMode: on => post({ type: `${PN}set-edit-mode`, on }),
    serialize: () => post({ type: `${PN}serialize` }),
    applyReplacement: (id, text) => post({ type: `${PN}apply-replacement`, id, text }),
  }
}
```

Before relying on `scroll-to`, confirm its payload field by reading the handler in the vendored bridge (`grep -n "type === PREFIX + 'scroll-to'" -A 12 src/vendor/plannotator/bridge-script.ts`); it reads `e.data.id`. If it reads another name, change the `scrollTo` post to match.

- [ ] **Step 5: Write `stripViewerInjection.ts`**

```ts
// src/components/documents/annotations/stripViewerInjection.ts
/**
 * Undo what the viewer added before a serialized document is saved (spec §7.4):
 * the injection block, the bridge script tag, the theme stamp, and the editable
 * attribute. The bridge strips its own overlay nodes and minted heading ids;
 * both sides strip so a miss on one side cannot leak viewer markup into a revision.
 */
export const INJECT_OPEN = '<!--pn-inject-->'
export const INJECT_CLOSE = '<!--/pn-inject-->'
const BRIDGE_SCRIPT_TAG = /<script\b[^>]*\bsrc=["'][^"']*\/pn-bridge\.v\d+\.js["'][^>]*>\s*<\/script>/gi
const HTML_DATA_THEME = /(<html\b[^>]*?)\s+data-theme=(["'])([^"']*)\2/i

export function stripViewerInjection(html: string, original: string): string {
  let out = html
  const a = out.indexOf(INJECT_OPEN)
  const b = out.indexOf(INJECT_CLOSE)
  if (a !== -1 && b > a) out = out.slice(0, a) + out.slice(b + INJECT_CLOSE.length)
  out = out.replace(BRIDGE_SCRIPT_TAG, '')
  const authored = original.match(HTML_DATA_THEME)?.[3]
  out = out.replace(HTML_DATA_THEME, (_m, before: string, q: string) =>
    authored === undefined ? before : `${before} data-theme=${q}${authored}${q}`
  )
  out = out.replace(/\s+contenteditable=(["'])[^"']*\1/gi, '')
  return out
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/components/documents/annotations/ && npm run typecheck` → pass, clean.

- [ ] **Step 7: Commit**

```bash
cd C:/tmp/mk1-doc-annotations && git add src/components/documents/annotations && git commit -m "feat(viewer): useDocumentBridge trust boundary, message parsing, injection stripping" -- src/components/documents/annotations
```

---

### Task 12: Selection toolbar and comment composer

**Files:**
- Create: `src/components/documents/annotations/SelectionToolbar.tsx`, `CommentComposer.tsx`, `__tests__/CommentComposer.test.tsx`, `__tests__/SelectionToolbar.test.tsx`

**Interfaces:**
- `SelectionToolbar({ rect, labels, onComment, onSuggest, onLabel, onThumbsUp })` — absolutely positioned inside a `relative` container; digits 1–9,0 pick labels while mounted.
- `CommentComposer({ open, rect, mode, quote, labels, initialLabel, onSubmit, onCancel, uploadImage })` where `mode: 'comment' | 'suggestion' | 'global'`, `onSubmit({ body, suggested_text?, label? }) => Promise<void>`, `uploadImage(blob, name) => Promise<number>` returns the attachment id. Over-cap rule: when `mode !== 'global'` and `quote.length > 400`, show the cap message and disable Save (Review Focus 2).

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/documents/annotations/__tests__/CommentComposer.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CommentComposer } from '../CommentComposer'

const labels = [{ id: 'verify-this', emoji: '🔍', text: 'Verify this', color: 'orange', tip: null }]
const rect = { top: 10, left: 10, width: 50, height: 10 }

describe('CommentComposer', () => {
  it('Ctrl+Enter submits the body and the chosen label', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<CommentComposer open rect={rect} mode="comment" quote="q" labels={labels} initialLabel={labels[0]} onSubmit={onSubmit} onCancel={() => {}} uploadImage={async () => 1} />)
    const ta = screen.getByPlaceholderText('Add a comment…')
    await userEvent.type(ta, 'why?')
    fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ body: 'why?', suggested_text: undefined, label: 'verify-this' }))
  })

  it('pasting an image uploads it and inserts the token at the caret', async () => {
    const uploadImage = vi.fn().mockResolvedValue(42)
    render(<CommentComposer open rect={rect} mode="comment" quote="q" labels={labels} onSubmit={async () => {}} onCancel={() => {}} uploadImage={uploadImage} />)
    const ta = screen.getByPlaceholderText('Add a comment…') as HTMLTextAreaElement
    const file = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })
    fireEvent.paste(ta, { clipboardData: { files: [file] } })
    await waitFor(() => expect(ta.value).toBe('{attachment:42}'))
    expect(uploadImage).toHaveBeenCalledWith(file, 'shot.png')
  })

  it('suggestion mode requires replacement text', async () => {
    const onSubmit = vi.fn()
    render(<CommentComposer open rect={rect} mode="suggestion" quote="old words" labels={labels} onSubmit={onSubmit} onCancel={() => {}} uploadImage={async () => 1} />)
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    await userEvent.clear(screen.getByLabelText('Replace with'))
    await userEvent.type(screen.getByLabelText('Replace with'), 'new words')
    expect(save).toBeEnabled()
  })

  it('refuses a quote over 400 characters with a clear message', () => {
    render(<CommentComposer open rect={rect} mode="comment" quote={'x'.repeat(401)} labels={labels} onSubmit={async () => {}} onCancel={() => {}} uploadImage={async () => 1} />)
    expect(screen.getByText(/Selection is 401 characters; the limit is 400/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('Escape cancels', () => {
    const onCancel = vi.fn()
    render(<CommentComposer open rect={rect} mode="global" quote="" labels={labels} onSubmit={async () => {}} onCancel={onCancel} uploadImage={async () => 1} />)
    fireEvent.keyDown(screen.getByPlaceholderText('Add a comment…'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
  })
})
```

```tsx
// src/components/documents/annotations/__tests__/SelectionToolbar.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SelectionToolbar } from '../SelectionToolbar'

const labels = [
  { id: 'clarify-this', emoji: '❓', text: 'Clarify this', color: 'yellow', tip: null },
  { id: 'verify-this', emoji: '🔍', text: 'Verify this', color: 'orange', tip: null },
]

describe('SelectionToolbar', () => {
  it('offers comment, suggest, label, and thumbs-up; digit keys pick labels', () => {
    const onLabel = vi.fn()
    const onComment = vi.fn()
    render(<SelectionToolbar rect={{ top: 100, left: 20, width: 10, height: 10 }} labels={labels} onComment={onComment} onSuggest={() => {}} onLabel={onLabel} onThumbsUp={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    expect(onComment).toHaveBeenCalled()
    fireEvent.keyDown(window, { key: '2' })
    expect(onLabel).toHaveBeenCalledWith(labels[1])
    const bar = screen.getByRole('toolbar')
    expect(bar.style.top).toBe('60px')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/components/documents/annotations/__tests__/CommentComposer.test.tsx src/components/documents/annotations/__tests__/SelectionToolbar.test.tsx` → FAIL, modules not found.

- [ ] **Step 3: Write the toolbar**

```tsx
// src/components/documents/annotations/SelectionToolbar.tsx
import { useEffect } from 'react'
import { MessageSquare, Pencil, Tag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { CommentLabel } from '@/lib/api-document-comments'
import type { Rect } from './bridge-messages'

interface Props {
  /** Selection rect already offset into the positioning container's coordinates. */
  rect: Rect
  labels: CommentLabel[]
  onComment: () => void
  onSuggest: () => void
  onLabel: (label: CommentLabel) => void
  onThumbsUp: () => void
}

/** Floats above a selection or a pinpointed element (spec §8). */
export function SelectionToolbar({ rect, labels, onComment, onSuggest, onLabel, onThumbsUp }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (!/^[0-9]$/.test(e.key)) return
      const i = e.key === '0' ? 9 : Number(e.key) - 1
      const label = labels[i]
      if (label) {
        e.preventDefault()
        onLabel(label)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [labels, onLabel])

  return (
    <div
      role="toolbar"
      aria-label="Annotate selection"
      data-testid="selection-toolbar"
      className="absolute z-20 flex items-center gap-0.5 rounded-md border bg-popover p-1 shadow-md"
      style={{ top: Math.max(0, rect.top - 40), left: Math.max(0, rect.left) }}
    >
      <Button size="sm" variant="ghost" onClick={onComment}>
        <MessageSquare className="mr-1 h-4 w-4" />
        Comment
      </Button>
      <Button size="sm" variant="ghost" onClick={onSuggest}>
        <Pencil className="mr-1 h-4 w-4" />
        Suggest edit
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost">
            <Tag className="mr-1 h-4 w-4" />
            Label
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {labels.map((l, i) => (
            <DropdownMenuItem key={l.id} onSelect={() => onLabel(l)}>
              <span className="mr-2">{l.emoji}</span>
              {l.text}
              <span className="ml-auto pl-4 text-xs text-muted-foreground">{(i + 1) % 10}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button size="sm" variant="ghost" aria-label="Nice work" onClick={onThumbsUp}>
        👍
      </Button>
    </div>
  )
}
```

- [ ] **Step 4: Write the composer**

```tsx
// src/components/documents/annotations/CommentComposer.tsx
import { useEffect, useRef, useState } from 'react'
import { ImagePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import type { CommentLabel } from '@/lib/api-document-comments'
import { ImageAnnotator } from '@/vendor/plannotator/image-annotator'
import type { Rect } from './bridge-messages'

export const MAX_QUOTE = 400

export type ComposerMode = 'comment' | 'suggestion' | 'global'
export interface ComposerSubmit {
  body: string
  suggested_text?: string
  label?: string | null
}
interface Props {
  open: boolean
  /** Null for a global comment: the composer docks top-right of the container. */
  rect: Rect | null
  mode: ComposerMode
  quote: string
  labels: CommentLabel[]
  initialLabel?: CommentLabel | null
  onSubmit: (v: ComposerSubmit) => Promise<void>
  onCancel: () => void
  /** Uploads and returns the attachment id. */
  uploadImage: (blob: Blob, name: string) => Promise<number>
}

/** The comment / suggestion / global composer (spec §8). */
export function CommentComposer({ open, rect, mode, quote, labels, initialLabel = null, onSubmit, onCancel, uploadImage }: Props) {
  const [body, setBody] = useState('')
  const [replacement, setReplacement] = useState(quote)
  const [label, setLabel] = useState<CommentLabel | null>(initialLabel)
  const [saving, setSaving] = useState(false)
  const [draw, setDraw] = useState<{ src: string; name: string } | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setBody('')
    setReplacement(quote)
    setLabel(initialLabel)
    queueMicrotask(() => taRef.current?.focus())
  }, [open, quote, initialLabel])

  const overCap = mode !== 'global' && quote.length > MAX_QUOTE
  const needsReplacement = mode === 'suggestion' && !replacement.trim()
  const canSave = !saving && !overCap && !needsReplacement && (mode === 'suggestion' || body.trim().length > 0 || label !== null)

  const insertAtCaret = (text: string) => {
    const ta = taRef.current
    const at = ta?.selectionStart ?? body.length
    setBody(b => b.slice(0, at) + text + b.slice(at))
    queueMicrotask(() => {
      ta?.focus()
      ta?.setSelectionRange(at + text.length, at + text.length)
    })
  }
  const upload = async (blob: Blob, name: string) => {
    try {
      const id = await uploadImage(blob, name)
      insertAtCaret(`{attachment:${id}}`)
    } catch {
      /* the mutation hook toasts; the token simply is not inserted */
    }
  }
  const submit = async () => {
    if (!canSave) return
    setSaving(true)
    try {
      await onSubmit({
        body: body.trim(),
        suggested_text: mode === 'suggestion' ? replacement.trim() : undefined,
        label: label?.id ?? null,
      })
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null
  const anchorStyle = rect
    ? { top: rect.top + rect.height, left: rect.left, width: Math.max(1, rect.width), height: 1 }
    : { top: 8, right: 8, width: 1, height: 1 }

  return (
    <>
      <Popover open modal={false} onOpenChange={o => !o && onCancel()}>
        <PopoverAnchor asChild>
          <span aria-hidden className="absolute" style={anchorStyle} />
        </PopoverAnchor>
        <PopoverContent align="start" className="w-[380px] p-3" onEscapeKeyDown={onCancel}>
          {mode !== 'global' && quote && (
            <p className="mb-2 line-clamp-2 border-l-2 pl-2 text-xs text-muted-foreground">“{quote}”</p>
          )}
          {overCap && (
            <p role="alert" className="mb-2 text-xs text-destructive">
              Selection is {quote.length} characters; the limit is {MAX_QUOTE}. Select less text.
            </p>
          )}
          {label && (
            <button type="button" className="mb-2 rounded-full border px-2 py-0.5 text-xs" onClick={() => setLabel(null)} title="Remove label">
              {label.emoji} {label.text} ×
            </button>
          )}
          {!label && labels.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {labels.map(l => (
                <button key={l.id} type="button" className="rounded-full border px-2 py-0.5 text-xs hover:bg-muted" onClick={() => setLabel(l)}>
                  {l.emoji} {l.text}
                </button>
              ))}
            </div>
          )}
          {mode === 'suggestion' && (
            <div className="mb-2 text-xs">
              <span className="mb-1 block text-muted-foreground">Replace with</span>
              <Textarea aria-label="Replace with" value={replacement} rows={2} onChange={e => setReplacement(e.target.value)} />
            </div>
          )}
          <Textarea
            ref={taRef}
            value={body}
            rows={3}
            placeholder="Add a comment…"
            onChange={e => setBody(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onCancel()
              } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void submit()
              }
            }}
            onPaste={e => {
              const img = Array.from(e.clipboardData?.files ?? []).find(f => f.type.startsWith('image/'))
              if (img) {
                e.preventDefault()
                void upload(img, img.name || 'pasted.png')
              }
            }}
            onDrop={e => {
              const img = Array.from(e.dataTransfer?.files ?? []).find(f => f.type.startsWith('image/'))
              if (img) {
                e.preventDefault()
                void upload(img, img.name || 'dropped.png')
              }
            }}
          />
          <div className="mt-2 flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0]
                if (f) setDraw({ src: URL.createObjectURL(f), name: f.name })
                e.target.value = ''
              }}
            />
            <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()} title="Attach an image (draw on it first)">
              <ImagePlus className="h-4 w-4" />
            </Button>
            <span className="ml-auto text-xs text-muted-foreground">Ctrl+Enter</span>
            <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button size="sm" disabled={!canSave} onClick={() => void submit()}>Save</Button>
          </div>
        </PopoverContent>
      </Popover>
      {draw && (
        <ImageAnnotator
          imageSrc={draw.src}
          isOpen
          initialName={draw.name}
          onAccept={async (blob, _drew, name) => {
            await upload(blob, name.endsWith('.png') ? name : `${name}.png`)
          }}
          onClose={() => {
            URL.revokeObjectURL(draw.src)
            setDraw(null)
          }}
        />
      )}
    </>
  )
}
```

- [ ] **Step 5: Run the tests to verify they pass; typecheck**

Run: `npx vitest run src/components/documents/annotations/__tests__/CommentComposer.test.tsx src/components/documents/annotations/__tests__/SelectionToolbar.test.tsx && npm run typecheck`
Expected: pass. If radix Popover complains in jsdom about `ResizeObserver`, the existing `src/test/setup.ts` polyfill covers it.

- [ ] **Step 6: Commit**

```bash
cd C:/tmp/mk1-doc-annotations && git add src/components/documents/annotations && git commit -m "feat(viewer): selection toolbar and comment composer with labels, suggestions, image attachments" -- src/components/documents/annotations
```

---

### Task 13: Comments panel, cards, contents tab, attachment resolver

**Files:**
- Create: `src/components/documents/annotations/label-colors.ts`, `CommentCard.tsx`, `CommentsPanel.tsx`, `ContentsTab.tsx`, `__tests__/CommentsPanel.test.tsx`
- Modify: `src/components/flags/CommentBody.tsx` (optional `resolveAttachmentUrl` prop)

**Interfaces:**
- `CommentBody` gains `resolveAttachmentUrl?: (id: number) => Promise<string | null>` (default: the flags resolver).
- `CommentsPanel({ docId, currentRevision, comments, labels, filter, onFilterChange, unanchoredIds, selectedId, onSelect, onGlobalComment, headings, onNavigateHeading, me, isAdmin, onApply? })`.
- `CommentCard({ c, currentRevision, labels, lost, selected, canEdit, isAdmin, onFocus, actions: { reply, resolve, reopen, edit, remove, apply? } })`.
- `ContentsTab({ headings, onNavigate })`.
- `labelStyle(color, dark) -> { backgroundColor, color }`.

- [ ] **Step 1: Write the failing panel test**

```tsx
// src/components/documents/annotations/__tests__/CommentsPanel.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DocumentComment } from '@/lib/api-document-comments'
import { CommentsPanel } from '../CommentsPanel'

vi.mock('@/lib/api-document-comments', async orig => ({
  ...(await orig()),
  fetchDocumentCommentAttachmentUrl: vi.fn().mockResolvedValue(null),
}))

const base = (over: Partial<DocumentComment>): DocumentComment => ({
  id: 1, code: 'ART-0001', document_id: 10, revision: 1, parent_id: null, number: 1, kind: 'comment',
  anchor: { originalText: 'quoted' }, label: null, body: 'hello', suggested_text: null, author: 'Tess Tech',
  author_user_id: 42, author_agent: null, status: 'open', resolved_at: null, resolved_by: null,
  created_at: '2026-10-03T14:00:00', updated_at: '2026-10-03T14:00:00', edited_at: null, attachments: [], replies: [], ...over,
})
const labels = [{ id: 'verify-this', emoji: '🔍', text: 'Verify this', color: 'orange', tip: null }]

function renderPanel(comments: DocumentComment[], unanchored: string[] = []) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <CommentsPanel docId={10} currentRevision={2} comments={comments} labels={labels} filter="open" onFilterChange={() => {}}
        unanchoredIds={new Set(unanchored)} selectedId={null} onSelect={() => {}} onGlobalComment={() => {}}
        headings={[{ id: 'pn-h-1', level: 1, text: 'Title' }, { id: 'own', level: 2, text: 'Sub' }]} onNavigateHeading={() => {}}
        me={{ id: 42 }} isAdmin={false} />
    </QueryClientProvider>
  )
}

describe('CommentsPanel', () => {
  it('orders cards by number, shows the agent author and "on rN", and groups lost ones', () => {
    renderPanel([
      base({ id: 3, number: 3, author: 'jarvis', author_user_id: null, author_agent: 'jarvis', revision: 1 }),
      base({ id: 1, number: 1 }),
      base({ id: 2, number: 2, anchor: { originalText: 'gone' } }),
    ], ['2'])
    const cards = screen.getAllByTestId('comment-card')
    expect(cards.map(c => c.getAttribute('data-number'))).toEqual(['1', '3', '2'])
    expect(within(cards[1]).getByText('jarvis')).toBeInTheDocument()
    expect(within(cards[1]).getByText('on r1')).toBeInTheDocument()
    const lost = screen.getByRole('region', { name: 'Lost its place' })
    expect(within(lost).getByText('“gone”')).toBeInTheDocument()
  })

  it('renders an element-only card without a quote', () => {
    renderPanel([base({ anchor: { originalText: '', htmlAnchor: { selector: 'img', tagName: 'img' } } })])
    const card = screen.getByTestId('comment-card')
    expect(within(card).queryByText(/“/)).toBeNull()
    expect(within(card).getByText('img')).toBeInTheDocument()
  })

  it('shows a label chip with the catalog colour and a suggestion with its replacement', () => {
    renderPanel([
      base({ label: 'verify-this' }),
      base({ id: 2, number: 2, kind: 'suggestion', body: '', suggested_text: 'new words', anchor: { originalText: 'old words' } }),
    ])
    expect(screen.getByText('🔍 Verify this')).toBeInTheDocument()
    expect(screen.getByText('new words')).toBeInTheDocument()
  })

  it('the Contents tab lists headings indented by level', async () => {
    renderPanel([])
    const user = (await import('@testing-library/user-event')).default
    await user.click(screen.getByRole('tab', { name: 'Contents' }))
    const items = screen.getAllByRole('button', { name: /Title|Sub/ })
    expect(items).toHaveLength(2)
    expect(items[1].className).toContain('pl-5')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/documents/annotations/__tests__/CommentsPanel.test.tsx` → FAIL, module not found.

- [ ] **Step 3: `CommentBody` resolver prop**

In `src/components/flags/CommentBody.tsx` add the prop and use it:

```tsx
export function CommentBody({
  body,
  mentions,
  users,
  resolveAttachmentUrl = fetchFlagAttachmentUrl,
}: {
  body: string
  mentions: number[]
  users: UserMap
  /** Document comments serve their images from another route (spec 2026-10-03 §8). */
  resolveAttachmentUrl?: (id: number) => Promise<string | null>
}) {
```

and in the effect replace `fetchFlagAttachmentUrl(id)` with `resolveAttachmentUrl(id)` and add `resolveAttachmentUrl` to the dependency array. The existing `CommentBody.test.tsx` must still pass unchanged.

- [ ] **Step 4: Label colours**

```ts
// src/components/documents/annotations/label-colors.ts
/** plannotator's LABEL_COLOR_MAP (MIT), keyed by the catalog's `color`. */
export const LABEL_COLOR_MAP: Record<string, { bg: string; text: string; darkText: string }> = {
  blue: { bg: 'rgba(59,130,246,0.15)', text: '#2563eb', darkText: '#60a5fa' },
  red: { bg: 'rgba(239,68,68,0.15)', text: '#dc2626', darkText: '#f87171' },
  orange: { bg: 'rgba(249,115,22,0.15)', text: '#ea580c', darkText: '#fb923c' },
  yellow: { bg: 'rgba(234,179,8,0.15)', text: '#ca8a04', darkText: '#facc15' },
  purple: { bg: 'rgba(147,51,234,0.15)', text: '#9333ea', darkText: '#a78bfa' },
  teal: { bg: 'rgba(20,184,166,0.15)', text: '#0d9488', darkText: '#2dd4bf' },
  pink: { bg: 'rgba(236,72,153,0.15)', text: '#db2777', darkText: '#f472b6' },
  green: { bg: 'rgba(34,197,94,0.15)', text: '#16a34a', darkText: '#4ade80' },
  cyan: { bg: 'rgba(8,145,178,0.15)', text: '#0891b2', darkText: '#22d3ee' },
  amber: { bg: 'rgba(180,83,9,0.15)', text: '#b45309', darkText: '#fbbf24' },
}

export function labelStyle(color: string, dark: boolean): { backgroundColor: string; color: string } {
  const c = LABEL_COLOR_MAP[color]
  if (!c) return { backgroundColor: 'rgba(128,128,128,0.15)', color: '#666' }
  return { backgroundColor: c.bg, color: dark ? c.darkText : c.text }
}
```

- [ ] **Step 5: The card**

```tsx
// src/components/documents/annotations/CommentCard.tsx
import { useState } from 'react'
import { Check, Pencil, Reply, RotateCcw, Trash2, Wand2 } from 'lucide-react'
import { CommentBody } from '@/components/flags/CommentBody'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { fetchDocumentCommentAttachmentUrl, type CommentLabel, type DocumentComment } from '@/lib/api-document-comments'
import { labelStyle } from './label-colors'

export interface CardActions {
  reply: (c: DocumentComment, body: string) => Promise<void>
  resolve: (c: DocumentComment) => void
  reopen: (c: DocumentComment) => void
  edit: (c: DocumentComment, body: string) => Promise<void>
  remove: (c: DocumentComment) => void
  /** Part 4: admins apply a suggestion into a draft. */
  apply?: (c: DocumentComment) => void
}
interface Props {
  c: DocumentComment
  currentRevision: number
  labels: Map<string, CommentLabel>
  lost: boolean
  selected: boolean
  canEdit: boolean
  isAdmin: boolean
  dark: boolean
  onFocus: () => void
  actions: CardActions
}

const when = (iso: string) => iso.slice(0, 16).replace('T', ' ')

export function CommentCard({ c, currentRevision, labels, lost, selected, canEdit, isAdmin, dark, onFocus, actions }: Props) {
  const [replying, setReplying] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const label = c.label ? labels.get(c.label) : undefined
  const quote = c.anchor?.originalText ?? ''
  const elementTag = c.anchor?.htmlAnchor?.tagName
  const heading = c.anchor?.elementContext?.heading

  return (
    <article
      data-testid="comment-card"
      data-number={c.number ?? ''}
      aria-current={selected || undefined}
      className={`rounded-md border p-2 text-sm ${selected ? 'ring-2 ring-ring' : ''} ${lost ? 'opacity-80' : ''}`}
      onClick={onFocus}
    >
      <header className="mb-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {c.number != null && (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 font-mono text-[11px] text-primary-foreground">{c.number}</span>
        )}
        {label && (
          <span className="rounded-full px-2 py-0.5" style={labelStyle(label.color, dark)}>{label.emoji} {label.text}</span>
        )}
        {c.kind === 'suggestion' && <span className="rounded-full border px-2 py-0.5">Suggestion</span>}
        <span className="font-medium text-foreground">{c.author}</span>
        {c.revision !== currentRevision && <span>on r{c.revision}</span>}
        <span>{when(c.created_at)}</span>
        {c.edited_at && <span>(edited)</span>}
      </header>
      {quote ? (
        <blockquote className="mb-1 border-l-2 pl-2 text-xs text-muted-foreground">“{quote}”</blockquote>
      ) : elementTag ? (
        <p className="mb-1 text-xs text-muted-foreground">
          <span className="rounded bg-muted px-1 font-mono">{elementTag}</span>
          {heading ? ` in ${heading}` : ''}
        </p>
      ) : null}
      {c.kind === 'suggestion' && (
        <p className="mb-1 rounded bg-muted/50 p-1 text-xs">
          <span className="text-muted-foreground">Replace with: </span>
          <span className="font-medium">{c.suggested_text}</span>
        </p>
      )}
      {editing ? (
        <div className="mb-1">
          <Textarea value={draft} rows={3} onChange={e => setDraft(e.target.value)} />
          <div className="mt-1 flex justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            <Button size="sm" onClick={() => void actions.edit(c, draft).then(() => setEditing(false))}>Save</Button>
          </div>
        </div>
      ) : (
        c.body && <CommentBody body={c.body} mentions={[]} users={new Map()} resolveAttachmentUrl={fetchDocumentCommentAttachmentUrl} />
      )}
      {c.replies.length > 0 && (
        <ul className="mt-1 space-y-1 border-l pl-2">
          {c.replies.map(r => (
            <li key={r.id} className="text-xs">
              <span className="font-medium">{r.author}</span> <span className="text-muted-foreground">{when(r.created_at)}</span>
              <CommentBody body={r.body} mentions={[]} users={new Map()} resolveAttachmentUrl={fetchDocumentCommentAttachmentUrl} />
            </li>
          ))}
        </ul>
      )}
      {replying && (
        <div className="mt-1">
          <Textarea value={draft} rows={2} placeholder="Reply…" onChange={e => setDraft(e.target.value)} />
          <div className="mt-1 flex justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={() => setReplying(false)}>Cancel</Button>
            <Button size="sm" disabled={!draft.trim()} onClick={() => void actions.reply(c, draft).then(() => { setReplying(false); setDraft('') })}>Reply</Button>
          </div>
        </div>
      )}
      <footer className="mt-1 flex flex-wrap items-center gap-1" onClick={e => e.stopPropagation()}>
        <Button size="sm" variant="ghost" aria-label="Reply" onClick={() => { setDraft(''); setReplying(v => !v) }}><Reply className="h-3.5 w-3.5" /></Button>
        {c.status === 'open' ? (
          <Button size="sm" variant="ghost" aria-label="Resolve" onClick={() => actions.resolve(c)}><Check className="h-3.5 w-3.5" /></Button>
        ) : (
          <Button size="sm" variant="ghost" aria-label="Reopen" onClick={() => actions.reopen(c)}><RotateCcw className="h-3.5 w-3.5" /></Button>
        )}
        {canEdit && (
          <>
            <Button size="sm" variant="ghost" aria-label="Edit" onClick={() => { setDraft(c.body); setEditing(true) }}><Pencil className="h-3.5 w-3.5" /></Button>
            <Button size="sm" variant="ghost" aria-label="Delete" onClick={() => actions.remove(c)}><Trash2 className="h-3.5 w-3.5" /></Button>
          </>
        )}
        {isAdmin && c.kind === 'suggestion' && c.status === 'open' && actions.apply && !lost && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => actions.apply?.(c)}><Wand2 className="mr-1 h-3.5 w-3.5" />Apply</Button>
        )}
      </footer>
    </article>
  )
}
```

- [ ] **Step 6: The contents tab and the panel**

```tsx
// src/components/documents/annotations/ContentsTab.tsx
import type { BridgeHeading } from './bridge-messages'

const INDENT: Record<number, string> = { 1: 'pl-2', 2: 'pl-5', 3: 'pl-8', 4: 'pl-11' }

export function ContentsTab({ headings, onNavigate }: { headings: BridgeHeading[]; onNavigate: (id: string) => void }) {
  if (headings.length === 0) return <p className="p-3 text-xs text-muted-foreground">No headings in this document.</p>
  return (
    <ul className="py-1">
      {headings.map(h => (
        <li key={h.id}>
          <button
            type="button"
            className={`w-full truncate py-1 pr-2 text-left text-sm hover:bg-muted ${INDENT[h.level] ?? 'pl-11'} ${h.level <= 1 ? 'text-foreground/90' : 'text-muted-foreground'}`}
            onClick={() => onNavigate(h.id)}
          >
            {h.text}
          </button>
        </li>
      ))}
    </ul>
  )
}
```

```tsx
// src/components/documents/annotations/CommentsPanel.tsx
import { useMemo } from 'react'
import { Globe } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTheme } from '@/hooks/use-theme'
import type { CommentLabel, CommentStatusFilter, DocumentComment } from '@/lib/api-document-comments'
import { useCreateComment, useDeleteComment, usePatchComment, useSetCommentStatus } from '@/services/document-comments'
import type { BridgeHeading } from './bridge-messages'
import { CommentCard, type CardActions } from './CommentCard'
import { ContentsTab } from './ContentsTab'

interface Props {
  docId: number
  currentRevision: number
  comments: DocumentComment[]
  labels: CommentLabel[]
  filter: CommentStatusFilter
  onFilterChange: (f: CommentStatusFilter) => void
  unanchoredIds: ReadonlySet<string>
  selectedId: string | null
  onSelect: (id: string) => void
  onGlobalComment: () => void
  headings: BridgeHeading[]
  onNavigateHeading: (id: string) => void
  me: { id?: number | null } | null
  isAdmin: boolean
  onApply?: (c: DocumentComment) => void
}

export function CommentsPanel(p: Props) {
  const { theme } = useTheme()
  const dark = theme === 'dark' || (theme === 'system' && (window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false))
  const create = useCreateComment(p.docId)
  const patch = usePatchComment(p.docId)
  const remove = useDeleteComment(p.docId)
  const setStatus = useSetCommentStatus(p.docId)
  const labelMap = useMemo(() => new Map(p.labels.map(l => [l.id, l])), [p.labels])
  const sorted = useMemo(() => [...p.comments].sort((a, b) => (a.number ?? 0) - (b.number ?? 0)), [p.comments])
  const placed = sorted.filter(c => !p.unanchoredIds.has(String(c.id)))
  const lost = sorted.filter(c => p.unanchoredIds.has(String(c.id)))

  const actions: CardActions = {
    reply: async (c, body) => { await create.mutateAsync({ parent_id: c.id, body }) },
    resolve: c => setStatus.mutate({ id: c.id, status: 'resolved' }),
    reopen: c => setStatus.mutate({ id: c.id, status: 'open' }),
    edit: async (c, body) => { await patch.mutateAsync({ id: c.id, body }) },
    remove: c => {
      if (window.confirm(`Delete comment ${c.number ?? ''}${c.replies.length ? ' and its replies' : ''}?`)) remove.mutate(c.id)
    },
    apply: p.onApply,
  }
  const canEdit = (c: DocumentComment) => p.isAdmin || (p.me?.id != null && c.author_user_id === p.me.id)
  const card = (c: DocumentComment, isLost: boolean) => (
    <CommentCard key={c.id} c={c} currentRevision={p.currentRevision} labels={labelMap} lost={isLost}
      selected={p.selectedId === String(c.id)} canEdit={canEdit(c)} isAdmin={p.isAdmin} dark={dark}
      onFocus={() => { if (!isLost) p.onSelect(String(c.id)); else toast.message('This comment lost its place on this revision') }}
      actions={actions} />
  )

  return (
    <Tabs defaultValue="comments" className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-2 py-1">
        <TabsList>
          <TabsTrigger value="comments">Comments</TabsTrigger>
          <TabsTrigger value="contents">Contents</TabsTrigger>
        </TabsList>
        <Select value={p.filter} onValueChange={v => p.onFilterChange(v as CommentStatusFilter)}>
          <SelectTrigger className="ml-auto h-7 w-[110px] text-xs" aria-label="Filter comments"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={p.onGlobalComment}><Globe className="mr-1 h-3.5 w-3.5" />Global comment</Button>
      </div>
      <TabsContent value="comments" className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {placed.length === 0 && lost.length === 0 && <p className="text-xs text-muted-foreground">No {p.filter === 'all' ? '' : p.filter} comments.</p>}
        {placed.map(c => card(c, false))}
        {lost.length > 0 && (
          <section aria-label="Lost its place" className="space-y-2 border-t pt-2">
            <h4 className="text-xs font-medium text-muted-foreground">Lost its place on this revision</h4>
            {lost.map(c => card(c, true))}
          </section>
        )}
      </TabsContent>
      <TabsContent value="contents" className="min-h-0 flex-1 overflow-y-auto">
        <ContentsTab headings={p.headings} onNavigate={p.onNavigateHeading} />
      </TabsContent>
    </Tabs>
  )
}
```

- [ ] **Step 7: Run the tests; typecheck**

Run: `npx vitest run src/components/documents/annotations/__tests__/CommentsPanel.test.tsx src/components/flags/__tests__/CommentBody.test.tsx && npm run typecheck` → pass, clean.

- [ ] **Step 8: Commit**

```bash
cd C:/tmp/mk1-doc-annotations && git add src/components/documents/annotations src/components/flags/CommentBody.tsx && git commit -m "feat(viewer): comments panel with cards, lost-its-place group, contents tab" -- src/components/documents/annotations src/components/flags/CommentBody.tsx
```

---

### Task 14: Wire the viewer and the list page

**Files:**
- Modify: `src/components/documents/DocumentViewer.tsx` (rewrite body), `src/components/documents/DocumentsPage.tsx` (Comments column), `src/components/documents/documents-utils.ts` (`readThemeTokens`, `buildViewerSrcDoc`)
- Create: `src/components/documents/__tests__/DocumentViewer.test.tsx`, `src/lib/__tests__/documents-utils-injection.test.ts`

**Interfaces:**
- `buildViewerSrcDoc(html, mode, tokens) -> string`: stamps the theme, then splices `INJECT_OPEN + buildSrcdocInjection({...}) + INJECT_CLOSE` into the head with the bridge URL `/pn-bridge.v<N>.js` resolved against `document.baseURI`.
- `readThemeTokens() -> Record<string, string>` from the Mk1 root for `THEME_TOKENS`.
- Open comments with an anchor map to `BridgeComment` with `type = kind === 'suggestion' ? 'deletion' : 'comment'`; only OPEN comments get marks.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/__tests__/documents-utils-injection.test.ts
import { describe, expect, it } from 'vitest'
import { buildViewerSrcDoc } from '@/components/documents/documents-utils'
import { INJECT_CLOSE, INJECT_OPEN } from '@/components/documents/annotations/stripViewerInjection'

describe('buildViewerSrcDoc', () => {
  it('stamps the theme and injects the bridge by absolute URL inside markers, before </head>', () => {
    const out = buildViewerSrcDoc('<html><head><title>t</title></head><body>b</body></html>', 'dark', { '--primary': 'oklch(0.5 0 0)' })
    expect(out).toMatch(/<html data-theme="dark">/)
    const start = out.indexOf(INJECT_OPEN)
    const end = out.indexOf(INJECT_CLOSE)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    expect(out.indexOf('</head>')).toBeGreaterThan(end)
    const block = out.slice(start, end)
    expect(block).toMatch(/<script src="http:\/\/[^"]+\/pn-bridge\.v\d+\.js"><\/script>/)
    expect(block).toContain('--pn-primary: oklch(0.5 0 0)')
    expect(block).not.toContain('--primary:')
    expect(block).not.toContain('plannotator-bridge-ready') // the bridge body is not inlined
  })
})
```

```tsx
// src/components/documents/__tests__/DocumentViewer.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/services/documents', () => ({
  useDocument: () => ({ data: { id: 10, code: 'ART-0001', revision: 2, title: 'Audit', status: 'active', category_name: 'Artifact', author: 'F', co_author: null, updated_at: '2026-10-03', updated_by: null, effective_date: '2026-10-03', revisions: [], open_comment_count: 2 }, isLoading: false, error: null }),
  useDocumentContent: () => ({ data: '<html><head></head><body><p>hi</p></body></html>', isLoading: false, error: null }),
  useDocumentCategories: () => ({ data: [] }),      // RetitleDialog
  usePatchDocument: () => ({ mutate: vi.fn(), isPending: false }),
  documentKeys: { detail: (id: number) => ['documents', 'detail', id], lists: ['documents', 'list'] },
}))
vi.mock('@/components/flags/EntityFlagButton', () => ({ EntityFlagButton: () => null })) // needs the flags stack; not under test
vi.mock('@/services/document-comments', () => ({
  useDocumentComments: () => ({ data: { items: [], code: 'ART-0001', latest_revision: 2, open_count: 2 } }),
  useCommentLabels: () => ({ data: [] }),
  useCreateComment: () => ({ mutateAsync: vi.fn() }),
  usePatchComment: () => ({ mutateAsync: vi.fn() }),
  useDeleteComment: () => ({ mutate: vi.fn() }),
  useSetCommentStatus: () => ({ mutate: vi.fn() }),
}))
vi.mock('@/store/auth-store', () => ({ useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 1, role: 'admin' } }) }))

describe('DocumentViewer', () => {
  it('renders the sandboxed frame with the injected bridge and the Comments toggle with its count', async () => {
    const { DocumentViewer } = await import('@/components/documents/DocumentViewer')
    render(<QueryClientProvider client={new QueryClient()}><DocumentViewer id={10} /></QueryClientProvider>)
    const frame = screen.getByTitle('Audit') as HTMLIFrameElement
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('srcdoc')).toContain('/pn-bridge.v')
    expect(frame.getAttribute('srcdoc')).toContain('<!--pn-inject-->')
    expect(screen.getByRole('button', { name: /Comments \(2\)/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Select' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Pinpoint' })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/__tests__/documents-utils-injection.test.ts src/components/documents/__tests__/DocumentViewer.test.tsx` → FAIL.

- [ ] **Step 3: Injection helpers in `documents-utils.ts`**

Append (imports at the top of the file: `import { BRIDGE_PROTOCOL_VERSION } from '@/vendor/plannotator/bridge-script'`, `import { THEME_TOKENS, buildSrcdocInjection, injectIntoHead, resolveBridgeScriptUrl } from '@/vendor/plannotator/srcdoc'`, `import { INJECT_CLOSE, INJECT_OPEN } from '@/components/documents/annotations/stripViewerInjection'`):

```ts
export const BRIDGE_ASSET_PATH = `/pn-bridge.v${BRIDGE_PROTOCOL_VERSION}.js`

/** Mk1's theme tokens, read from the app root, for the viewer's --pn-* namespace. */
export function readThemeTokens(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement)
  const out: Record<string, string> = {}
  for (const t of THEME_TOKENS) {
    const v = cs.getPropertyValue(t).trim()
    if (v) out[t] = v
  }
  return out
}

/**
 * The frame document (spec §7.1): theme stamped, then the viewer's style +
 * bridge <script src> spliced before </head> between markers that
 * stripViewerInjection removes again on save. Stored bytes are never touched.
 */
export function buildViewerSrcDoc(html: string, mode: DocTheme, tokens: Record<string, string>): string {
  const injection = buildSrcdocInjection({
    tokens,
    isLight: mode === 'light',
    hostTheme: false,
    diffActive: false,
    bridgeScriptUrl: resolveBridgeScriptUrl(BRIDGE_ASSET_PATH, document.baseURI),
  })
  return injectIntoHead(stampDocumentTheme(html, mode), `${INJECT_OPEN}${injection}${INJECT_CLOSE}`)
}
```

- [ ] **Step 4: Rewrite `DocumentViewer.tsx`**

Keep `usePrefersDark` and the header as they are; replace the component body from `const srcDoc = useMemo(` down with this (new imports: `useCallback`, `useEffect`, `useRef`; `MessageSquareText`, `MousePointerClick`, `TextCursor` from lucide; `ToggleGroup, ToggleGroupItem` from `@/components/ui/toggle-group`; `ResizableHandle, ResizablePanel, ResizablePanelGroup` from `@/components/ui/resizable`; `Sheet, SheetContent` from `@/components/ui/sheet`; `toast` from sonner; `addDocumentCommentAttachment`, types from `@/lib/api-document-comments`; hooks from `@/services/document-comments`; `buildViewerSrcDoc, readThemeTokens` from documents-utils; `useDocumentBridge, type BridgeComment, type BridgeSelection` from `./annotations/useDocumentBridge`; `SelectionToolbar`, `CommentComposer, type ComposerMode`, `CommentsPanel`):

```tsx
  const user = useAuthStore(s => s.user)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [inputMethod, setInputMethod] = useState<'drag' | 'pinpoint'>('drag')
  const [filter, setFilter] = useState<CommentStatusFilter>('open')
  const [panelOpen, setPanelOpen] = useState(false)
  const [selection, setSelection] = useState<BridgeSelection | null>(null)
  const [composer, setComposer] = useState<{ mode: ComposerMode; label: CommentLabel | null } | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 767px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const on = () => setNarrow(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  const commentsQ = useDocumentComments(id, filter)
  const labelsQ = useCommentLabels()
  const createComment = useCreateComment(id)
  const labels = labelsQ.data ?? []
  const comments = commentsQ.data?.items ?? []
  const openCount = commentsQ.data?.open_count ?? detail.data?.open_comment_count ?? 0
  useEffect(() => {
    if (detail.data && detail.data.open_comment_count > 0) setPanelOpen(true)
  }, [detail.data])

  const srcDoc = useMemo(
    () => (content.data ? buildViewerSrcDoc(content.data, mode, readThemeTokens()) : ''),
    [content.data, mode]
  )

  // Only OPEN comments carry marks; resolved ones stay in the panel under the filter.
  const bridgeComments = useMemo<BridgeComment[]>(
    () =>
      comments.flatMap(c => {
        const anchor = c.anchor
        const number = c.number
        if (c.status !== 'open' || !anchor || number == null) return []
        const additional = (anchor.htmlAdditionalTargets ?? []).flatMap(t => (t.anchor ? [t.anchor] : []))
        return [{
          id: String(c.id),
          type: c.kind === 'suggestion' ? 'deletion' : 'comment',
          originalText: anchor.originalText,
          anchor: anchor.htmlAnchor ?? null,
          additionalAnchors: additional.length ? additional : null,
          number,
        } satisfies BridgeComment]
      }),
    [comments]
  )

  const bridge = useDocumentBridge({
    iframeRef,
    documentKey: `${id}:${mode}`,
    comments: bridgeComments,
    inputMethod,
    annotateActive: true,
    onSelection: s => {
      setSelection(s)
      if (!s) setComposer(null)
    },
    onSelectionRect: r => setSelection(s => (s ? { ...s, rect: r } : s)),
    onMarkClick: markId => {
      setSelectedId(markId)
      setPanelOpen(true)
    },
  })

  const frameOffset = () => {
    const f = iframeRef.current
    return f ? { top: f.offsetTop, left: f.offsetLeft } : { top: 0, left: 0 }
  }
  const stageRect = selection ? { ...selection.rect, top: selection.rect.top + frameOffset().top, left: selection.rect.left + frameOffset().left } : null

  const uploadImage = useCallback(async (blob: Blob, name: string) => (await addDocumentCommentAttachment(id, blob, name)).id, [id])

  const submitComment = async (v: { body: string; suggested_text?: string; label?: string | null }, m: ComposerMode) => {
    const anchor = m === 'global' || !selection ? null : {
      originalText: selection.text,
      htmlAnchor: selection.anchor ?? undefined,
      elementContext: selection.context ?? undefined,
    }
    const created = await createComment.mutateAsync({
      kind: m === 'suggestion' ? 'suggestion' : 'comment',
      body: v.body,
      suggested_text: m === 'suggestion' ? v.suggested_text : undefined,
      label: v.label ?? null,
      anchor,
    })
    if (anchor) bridge.createMark(String(created.id), m === 'suggestion' ? 'deletion' : 'comment')
    bridge.cancelSelection()
    setComposer(null)
    setSelection(null)
    setPanelOpen(true)
  }
  const quickLabel = (label: CommentLabel) => void submitComment({ body: '', label: label.id }, 'comment')

  const panel = doc && (
    <CommentsPanel docId={id} currentRevision={doc.revision} comments={comments} labels={labels} filter={filter} onFilterChange={setFilter}
      unanchoredIds={bridge.unanchoredIds} selectedId={selectedId}
      onSelect={markId => { setSelectedId(markId); bridge.scrollTo(markId) }}
      onGlobalComment={() => { setSelection(null); setComposer({ mode: 'global', label: null }) }}
      headings={bridge.headings} onNavigateHeading={bridge.scrollToFragment}
      me={user ? { id: user.id } : null} isAdmin={isAdmin} />
  )
```

Header additions, inside the `ml-auto` group before `EntityFlagButton`:

```tsx
              <ToggleGroup type="single" value={inputMethod} onValueChange={v => v && setInputMethod(v as 'drag' | 'pinpoint')} aria-label="Annotation mode" size="sm">
                <ToggleGroupItem value="drag" aria-label="Select"><TextCursor className="h-4 w-4" /></ToggleGroupItem>
                <ToggleGroupItem value="pinpoint" aria-label="Pinpoint"><MousePointerClick className="h-4 w-4" /></ToggleGroupItem>
              </ToggleGroup>
              <Button variant={panelOpen ? 'secondary' : 'outline'} size="sm" onClick={() => setPanelOpen(o => !o)}>
                <MessageSquareText className="mr-1 h-4 w-4" />
                Comments ({openCount})
              </Button>
```

Body: replace the bare `<iframe …/>` with:

```tsx
        <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize={72} minSize={40}>
            <div className="h-full overflow-y-auto">
              {bridge.status === 'unavailable' && (
                <p role="status" className="border-b bg-muted px-3 py-1 text-xs text-muted-foreground">
                  Annotation tools did not load{bridge.unavailable?.kind === 'version-mismatch' ? ` (bridge version ${bridge.unavailable.reported ?? 'none'})` : ''}. The document is shown read-only; global comments still work.
                </p>
              )}
              <div ref={stageRef} className="relative">
                <iframe ref={iframeRef} title={doc?.title ?? `Document ${id}`} sandbox="allow-scripts" srcDoc={srcDoc}
                  className="block w-full border-0 bg-background" style={{ height: bridge.height }} />
                {selection && !composer && bridge.status === 'ready' && stageRect && (
                  <SelectionToolbar rect={stageRect} labels={labels}
                    onComment={() => setComposer({ mode: 'comment', label: null })}
                    onSuggest={() => setComposer({ mode: 'suggestion', label: null })}
                    onLabel={quickLabel}
                    onThumbsUp={() => { const l = labels.find(x => x.id === 'nice-work'); if (l) quickLabel(l) }} />
                )}
                {composer && (
                  <CommentComposer open rect={composer.mode === 'global' ? null : stageRect} mode={composer.mode}
                    quote={composer.mode === 'global' ? '' : (selection?.text ?? '')} labels={labels} initialLabel={composer.label}
                    onSubmit={v => submitComment(v, composer.mode)}
                    onCancel={() => { setComposer(null); bridge.cancelSelection() }}
                    uploadImage={uploadImage} />
                )}
              </div>
            </div>
          </ResizablePanel>
          {panelOpen && !narrow && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={28} minSize={20}>{panel}</ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
        {narrow && (
          <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
            <SheetContent side="right" className="w-[92vw] p-0">{panel}</SheetContent>
          </Sheet>
        )}
```

Check `src/store/auth-store.ts` for the user's id field name; if it is not `id`, adapt the `me` prop.

- [ ] **Step 5: Comments column on the list page**

In `src/components/documents/DocumentsPage.tsx`, import `MessageSquareText` from lucide and add this column right after the `threads` column:

```tsx
      {
        id: 'comments',
        header: 'Comments',
        size: 90,
        enableSorting: false,
        cell: ({ row }) => {
          const n = row.original.open_comment_count
          if (!n) return null
          return (
            <span
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium"
              aria-label={`${n} open comment${n === 1 ? '' : 's'} on ${row.original.code}`}
            >
              <MessageSquareText className="h-3 w-3" />
              {n}
            </span>
          )
        },
      },
```

- [ ] **Step 6: Run the tests; typecheck; format**

Run: `npx vitest run src/lib/__tests__/documents-utils-injection.test.ts src/components/documents/__tests__/DocumentViewer.test.tsx src/lib/__tests__/documents-utils.test.ts src/store/__tests__/ui-store-documents.test.ts && npm run typecheck && npm run format`
Expected: pass; clean; prettier rewrites only the new app files (vendor is ignored).

- [ ] **Step 7: Commit**

```bash
cd C:/tmp/mk1-doc-annotations && git add src/components/documents src/lib/__tests__/documents-utils-injection.test.ts && git commit -m "feat(viewer): annotations in the document viewer; comments column on the library list" -- src/components/documents src/lib/__tests__/documents-utils-injection.test.ts
```

---

### Task 15: Part 2 gate — check:all, bundle check, stack proving, PR

- [ ] **Step 1: Full frontend gate**

Run: `cd C:/tmp/mk1-doc-annotations && npm run check:all`
Expected: clean. (`rust:*` steps need the cargo env the script sources; they run against unchanged Rust and pass.)

- [ ] **Step 2: Prove the bridge literal is not in the app bundle**

```bash
cd C:/tmp/mk1-doc-annotations && npm run build && grep -l "data-plannotator-overlay-host" dist/assets/*.js; echo "exit=$?"; ls -la dist/pn-bridge.v1.js
```

Expected: no app chunk matches (`exit=1`), and `dist/pn-bridge.v1.js` exists (copied from `public/`). If a chunk matches, the inline branch crept back into `srcdoc.ts` or something imports `BRIDGE_SCRIPT` at runtime; fix within the fence.

- [ ] **Step 3: Stack proving (the only place the CSP and real browser behaviour are settled)**

Invoke the `accumark-stack-platform` skill with this worktree mounted; log in as the stack admin in a real browser. Checklist, each item recorded with a screenshot or a status line:
1. Open a document: the bridge banner must NOT appear; DevTools network shows `pn-bridge.v1.js` 200 from the Mk1 origin.
2. Select text → toolbar → Comment → Save: marker 1 appears in the document; card 1 in the panel.
3. Pinpoint mode → click an image or a table → Comment: card shows the element tag, no quote.
4. Label chip: one click creates a label-only comment.
5. Suggest edit: replacement saved; marker renders strikethrough.
6. Paste an image into the composer: token inserted, image renders in the card; click → lightbox. Then Images → draw → Save: drawn image attached.
7. Global comment: appears without a marker.
8. Reload the page: markers restored with the same numbers.
9. Through the MCP-less path, POST a new revision via `curl` to `/api/documents` with one commented sentence moved and one removed: open the new revision; one comment re-anchors, one lands in "Lost its place".
10. Contents tab lists the headings; a click scrolls the frame.
11. Resolve / reopen / reply / edit / delete each work; non-author sees no Edit/Delete.
12. A link inside the document opens in a new tab; nothing navigates the Mk1 shell.

- [ ] **Step 4: PR 2**

Push `feat/document-annotations-viewer` and open the PR against `feat/document-annotations` (retarget to master when PR 1 merges), with the gate output, the bundle grep line, and the stack checklist as **Evidence**, ending with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

# Part 3 — Lab MCP tools (PR 3, repo `labmanager-mcp`)

Repo: `C:/Users/forre/OneDrive/Documents/GitHub/labmanager-mcp`. Tests: `python -m pytest tests -q` from the repo root (its own venv). The bot host never pulls master; staging and cutover use the existing `C:/tmp/jarvis/roll_stage.sh` and `roll_cutover.sh`. `server.py` has mixed line endings; edit it with the Edit tool, never a byte-level script.

### Task 16: Four comment tools

**Files:**
- Modify: `src/labmanager_mcp/tools/documents.py` (functions + `register`)
- Modify: `tests/test_tools_documents.py`, `tests/test_server.py` (`DOCUMENT_TOOLS`)

**Interfaces:**
- Produces module functions `latest_document_id(client, code) -> int`, `export_comments(client, code, status="open") -> str`, `comments_index(client, status="open", author_agent=None, code_prefix=None, limit=100) -> dict`, `create_comment(client, code, body, quote=None, kind="comment", suggested_text=None, label=None, reply_to=None) -> dict`, `reply_comment(client, comment_id, body) -> dict`, `resolve_comment(client, comment_id) -> dict`, `get_comment(client, comment_id) -> dict`.
- Registers tools `documents_comments`, `documents_comment_create`, `documents_comment_reply`, `documents_comment_resolve`.
- Consumes (Part 1 routes): `GET /api/documents?q=&status=…`, `GET /api/documents/{id}/comments/export`, `GET /api/documents/comments`, `GET /api/documents/comments/{cid}`, `POST /api/documents/{id}/comments`, `POST /api/documents/comments/{cid}/resolve`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_tools_documents.py` (the `FakeClient` / `FakeResp` at the top of that file are reused; `FakeClient.get_json` returns `{"items": []}` so the tests below build a richer fake where needed):

```python
# ------------------------------------------------- comments (spec 2026-10-03 §9)

class RoutedClient(FakeClient):
    """A fake that answers GETs by path so code -> latest revision resolution and
    reply -> parent lookups are testable."""

    def __init__(self, routes: dict, post_resp=None):
        super().__init__(post_resp)
        self.routes = routes

    def get_json(self, path, **kw):
        self._record("GET", path, **kw)
        return self.routes[path]

    def get(self, path, **kw):
        self._record("GET", path, **kw)
        body = self.routes[path]
        r = FakeResp(200, body if isinstance(body, dict) else None, text=body if isinstance(body, str) else "")
        return r


DOC_LIST = {"items": [{"id": 77, "code": "ART-0004", "revision": 3},
                      {"id": 12, "code": "ART-0040", "revision": 1}]}


def test_latest_document_id_matches_the_exact_code_not_a_prefix():
    c = RoutedClient({"/api/documents": DOC_LIST})
    assert documents.latest_document_id(c, "ART-0004") == 77
    assert c.calls[0]["params"] == [("q", "ART-0004"), ("status", "draft"), ("status", "active"),
                                    ("status", "retired"), ("page_size", 20)]
    with pytest.raises(RuntimeError, match="ART-9999"):
        documents.latest_document_id(c, "ART-9999")


def test_export_is_a_bearer_read_of_the_latest_revision():
    c = RoutedClient({"/api/documents": DOC_LIST, "/api/documents/77/comments/export": "# Comments on ART-0004"})
    out = documents.export_comments(c, "ART-0004")
    assert out.startswith("# Comments on ART-0004")
    export_call = c.calls[-1]
    assert export_call["path"] == "/api/documents/77/comments/export"
    assert export_call["params"] == {"status": "open"} and export_call["service"] is False


def test_index_passes_filters_and_drops_none():
    c = RoutedClient({"/api/documents/comments": {"items": [{"id": 1}]}})
    out = documents.comments_index(c, author_agent="jarvis", code_prefix=None, limit=10)
    assert out == {"items": [{"id": 1}]}
    assert c.calls[-1]["params"] == {"status": "open", "author_agent": "jarvis", "limit": 10}


def test_create_builds_a_quote_only_anchor_and_posts_on_the_service_token():
    c = RoutedClient({"/api/documents": DOC_LIST}, post_resp=FakeResp(201, {"id": 5, "number": 2}))
    out = documents.create_comment(c, "ART-0004", "this contradicts the method", quote="50% of spec",
                                   label="verify-this")
    assert out == {"id": 5, "number": 2}
    post = c.calls[-1]
    assert (post["verb"], post["path"], post["service"]) == ("POST", "/api/documents/77/comments", True)
    assert post["json"] == {"kind": "comment", "body": "this contradicts the method",
                            "anchor": {"originalText": "50% of spec"}, "label": "verify-this"}


def test_create_without_quote_is_a_global_comment_and_suggestion_carries_text():
    c = RoutedClient({"/api/documents": DOC_LIST}, post_resp=FakeResp(201, {"id": 6}))
    documents.create_comment(c, "ART-0004", "no owner named")
    assert c.calls[-1]["json"] == {"kind": "comment", "body": "no owner named", "anchor": None}
    documents.create_comment(c, "ART-0004", "", quote="old", kind="suggestion", suggested_text="new")
    assert c.calls[-1]["json"] == {"kind": "suggestion", "body": "", "anchor": {"originalText": "old"},
                                   "suggested_text": "new"}


def test_create_surfaces_the_backend_detail_on_a_bad_quote():
    c = RoutedClient({"/api/documents": DOC_LIST},
                     post_resp=FakeResp(400, {"detail": 'quote not found in ART-0004 r3: "nope"'}))
    with pytest.raises(RuntimeError, match='quote not found in ART-0004 r3: "nope"'):
        documents.create_comment(c, "ART-0004", "x", quote="nope")


def test_reply_resolves_the_parent_document_and_posts_parent_id():
    c = RoutedClient({"/api/documents/comments/5": {"id": 5, "document_id": 77, "code": "ART-0004"}},
                     post_resp=FakeResp(201, {"id": 9, "parent_id": 5}))
    out = documents.reply_comment(c, 5, "Will state it.")
    assert out["parent_id"] == 5
    post = c.calls[-1]
    assert (post["path"], post["service"]) == ("/api/documents/77/comments", True)
    assert post["json"] == {"kind": "comment", "body": "Will state it.", "parent_id": 5}


def test_resolve_posts_on_the_service_token():
    c = FakeClient(FakeResp(200, {"id": 5, "status": "resolved"}))
    assert documents.resolve_comment(c, 5)["status"] == "resolved"
    assert c.calls == [{"verb": "POST", "path": "/api/documents/comments/5/resolve", "json": None,
                        "params": None, "service": True}]


def test_body_is_required_for_a_comment_and_text_for_a_suggestion():
    c = RoutedClient({"/api/documents": DOC_LIST})
    with pytest.raises(ValueError, match="body"):
        documents.create_comment(c, "ART-0004", "   ")
    with pytest.raises(ValueError, match="suggested_text"):
        documents.create_comment(c, "ART-0004", "", quote="q", kind="suggestion")
```

In `tests/test_server.py`, extend `DOCUMENT_TOOLS` with `"documents_comments", "documents_comment_create", "documents_comment_reply", "documents_comment_resolve"`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd C:/Users/forre/OneDrive/Documents/GitHub/labmanager-mcp && python -m pytest tests/test_tools_documents.py tests/test_server.py -q`
Expected: FAIL, `AttributeError: module 'labmanager_mcp.tools.documents' has no attribute 'latest_document_id'`, and the inventory test lists 4 missing tools.

- [ ] **Step 3: Write the functions**

Add to `src/labmanager_mcp/tools/documents.py` after `archive_document` (before `register`):

```python
# ---------------------------------------------------------------- comments (spec 2026-10-03 §9)

_COMMENTS = "/api/documents/comments"


def latest_document_id(client, code: str) -> int:
    """The list route returns the latest revision per code; q= is a prefix
    search, so match the exact code from the items."""
    code = (code or "").strip().upper()
    if not code:
        raise ValueError("code is required, e.g. ART-0004")
    items = client.get_json(_DOCS, params=[("q", code), ("status", "draft"), ("status", "active"),
                                           ("status", "retired"), ("page_size", 20)])["items"]
    for item in items:
        if item.get("code") == code:
            return int(item["id"])
    raise RuntimeError(f"no document with code {code}")


def export_comments(client, code: str, status: str = "open") -> str:
    """The markdown an agent revises from: numbered items, quotes, element
    context, label tips, suggestions, attachment tokens, replies."""
    doc_id = latest_document_id(client, code)
    resp = client.get(f"{_DOCS}/{doc_id}/comments/export", params={"status": status})
    if resp.status_code >= 400:
        _json_or_raise(resp, "export_comments")
    return resp.text


def comments_index(client, status: str = "open", author_agent=None, code_prefix=None,
                   limit: int = 100) -> dict:
    """Open comments across the library, newest first, for finding work."""
    params = {"status": status, "limit": limit}
    if author_agent:
        params["author_agent"] = author_agent
    if code_prefix:
        params["code_prefix"] = code_prefix
    return client.get_json(_COMMENTS, params=params)


def get_comment(client, comment_id: int) -> dict:
    return client.get_json(f"{_COMMENTS}/{comment_id}")


def create_comment(client, code: str, body: str, quote=None, kind: str = "comment",
                   suggested_text=None, label=None, reply_to=None) -> dict:
    """Start a comment on the latest revision of `code`. `quote` is the exact
    rendered text to anchor on; the backend verifies it occurs in the
    document (400 names the quote when it does not). No quote = document-level."""
    if kind not in ("comment", "suggestion"):
        raise ValueError("kind must be 'comment' or 'suggestion'")
    body = (body or "").strip()
    if kind == "suggestion" and not (suggested_text or "").strip():
        raise ValueError("a suggestion needs suggested_text (the replacement for the quote)")
    if kind == "comment" and not body and not label:
        raise ValueError("body is required for a comment (or pass a label)")
    payload = {"kind": kind, "body": body,
               "anchor": {"originalText": quote} if (quote or "").strip() else None}
    if suggested_text is not None:
        payload["suggested_text"] = suggested_text
    if label is not None:
        payload["label"] = label
    if reply_to is not None:
        payload["parent_id"] = int(reply_to)
    doc_id = latest_document_id(client, code)
    return _json_or_raise(client.post(f"{_DOCS}/{doc_id}/comments", json=payload, service=True),
                          "create_comment")


def reply_comment(client, comment_id: int, body: str) -> dict:
    """A reply lives under its parent's document; look the parent up first."""
    body = (body or "").strip()
    if not body:
        raise ValueError("body is required")
    parent = get_comment(client, comment_id)
    payload = {"kind": "comment", "body": body, "parent_id": int(comment_id)}
    return _json_or_raise(client.post(f"{_DOCS}/{parent['document_id']}/comments", json=payload,
                                      service=True), "reply_comment")


def resolve_comment(client, comment_id: int) -> dict:
    return _json_or_raise(client.post(f"{_COMMENTS}/{comment_id}/resolve", service=True),
                          "resolve_comment")
```

- [ ] **Step 4: Register the tools**

Inside `register`, after `documents_archive`, add (descriptions through `mcp.tool(description=...)`: an f-string is NOT a docstring, FastMCP would see nothing):

```python
    _LOOP = ("Address each numbered item. Post the next revision with documents_revise, "
             "then resolve what you handled with documents_comment_resolve, or answer with "
             "documents_comment_reply where you disagree. Never edit comments you did not write.")

    @mcp.tool(description=(
        "Comments on controlled documents. With a code (ART-0004, SOP-0001): the open "
        "comments on its latest revision as markdown, each with its number, the quoted text, "
        "where it sits, the label's instruction, any suggested replacement, attachment tokens, "
        "and replies. Without a code: open comments across the whole library, newest first, "
        "for finding work. " + _LOOP))
    def documents_comments(code: str | None = None, status: str = "open",
                           author_agent: str | None = None, code_prefix: str | None = None):
        if code:
            return export_comments(client, code, status=status)
        return comments_index(client, status=status, author_agent=author_agent,
                              code_prefix=code_prefix)

    @mcp.tool(description=(
        "Start a comment on a controlled document (its latest revision). `quote` is the EXACT "
        "rendered text to anchor on, copied from the document; the backend refuses a quote it "
        "cannot find. Omit `quote` for a document-level note. kind='suggestion' with "
        "`suggested_text` proposes a replacement for the quote. `label` is one of: clarify-this, "
        "verify-this, out-of-date, needs-reference, needs-example, out-of-scope, needs-sign-off, "
        "match-format, nice-work. You are named as the author."))
    def documents_comment_create(code: str, body: str, quote: str | None = None,
                                 kind: str = "comment", suggested_text: str | None = None,
                                 label: str | None = None) -> dict:
        return create_comment(client, code, body, quote=quote, kind=kind,
                              suggested_text=suggested_text, label=label)

    @mcp.tool(description="Reply under an existing comment (by its id from documents_comments).")
    def documents_comment_reply(comment_id: int, body: str) -> dict:
        return reply_comment(client, comment_id, body)

    @mcp.tool(description=(
        "Mark a comment resolved after the revision that addresses it has been posted. "
        "Idempotent. Resolve only items you actually handled."))
    def documents_comment_resolve(comment_id: int) -> dict:
        return resolve_comment(client, comment_id)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd C:/Users/forre/OneDrive/Documents/GitHub/labmanager-mcp && python -m pytest tests -q`
Expected: all pass, including `test_all_tools_registered` with the four new names and `test_no_document_tool_can_delete_anything` (no delete tool was added).

- [ ] **Step 6: Commit, stage, cut over**

```bash
cd C:/Users/forre/OneDrive/Documents/GitHub/labmanager-mcp && git add src/labmanager_mcp/tools/documents.py tests/test_tools_documents.py tests/test_server.py && git commit -m "feat(documents): comment tools: read export/index, create with quote anchor, reply, resolve" -- src/labmanager_mcp/tools/documents.py tests/test_tools_documents.py tests/test_server.py
```

Push on the release branch, open the PR. Only after Mk1 PR 1 is deployed: stage with `C:/tmp/jarvis/roll_stage.sh`, prove through Jarvis's real token on a stack (`documents_comments` on a code with comments → markdown; `documents_comment_create` with a good quote → 201 and the comment shows `author=jarvis` in the Mk1 UI; with a bad quote → the 400 detail is returned verbatim; `documents_comment_reply` and `documents_comment_resolve` → the card updates), then `roll_cutover.sh`. The bot's `LABMGR_MK1_SERVICE_TOKEN` is already the per-agent token; no env change.

# Part 4 — Edit mode (PR 4)

Branch `feat/document-annotations-edit` from the viewer branch. Backend commands as in Part 1, frontend as in Part 2.

### Task 17: Draft content replace route

**Files:**
- Modify: `backend/documents/service.py` (add `replace_draft_content`), `backend/documents/routes.py` (dependency + route), `backend/documents/schemas.py` (`DocumentContentReplace`)
- Create: `backend/tests/test_documents_content_replace.py`

**Interfaces:**
- Produces: `service.replace_draft_content(db, doc_id, *, html, updated_by) -> tuple[Document, bool]` (`changed` False on identical bytes); `routes.require_document_admin_user`; `PUT /api/documents/{doc_id}/content` body `{html}` → `DocumentOut` (200).
- Rules (spec §10.3): 404 unknown; 409 unless `status == 'draft'` and nothing supersedes it; identical bytes = no-op; else new blob, row updated, COMMIT, old blob deleted best-effort; admin bearer only (agent token 403, internal token 403, standard user 403).

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_documents_content_replace.py
"""Draft in-place content replace (spec 2026-10-03 §10.3)."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from documents_comments_support import (  # noqa: E402
    ADMIN, AGENT_TOKEN, HTML, INTERNAL_TOKEN, USER, client, publish)  # noqa: F401

NEW = HTML.replace("Dedupe on an EXPLICIT code", "Dedupe on an explicit code")


def _as_admin_bearer(client):
    from main import app
    from documents.routes import require_document_admin_user
    app.dependency_overrides[require_document_admin_user] = lambda: ADMIN


def _put(client, doc_id, html=NEW):
    return client.put(f"/api/documents/{doc_id}/content", json={"html": html})


def test_replaces_a_draft_in_place_and_drops_the_old_blob(client):
    r1 = publish(client)
    draft = publish(client, code=r1["code"], html=HTML.replace("Audit", "draft"), activate=False)
    _as_admin_bearer(client)
    from documents.models import Document
    from documents.storage import DocumentNotFound, get_storage
    old_key = client.db.get(Document, draft["id"]).storage_key
    r = _put(client, draft["id"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["id"], body["revision"], body["status"]) == (draft["id"], 2, "draft")
    assert body["updated_by"] == "admin@x.t" and body["content_sha256"] != draft["content_sha256"]
    row = client.db.get(Document, draft["id"])
    assert row.storage_key != old_key and row.size_bytes == len(NEW.encode())
    assert get_storage().fetch(row.storage_key) == NEW.encode()
    try:
        get_storage().fetch(old_key)
        assert False, "old blob should be gone"
    except DocumentNotFound:
        pass
    assert client.get(f"/api/documents/{draft['id']}/content").text == NEW


def test_identical_bytes_are_a_no_op(client):
    r1 = publish(client)
    draft = publish(client, code=r1["code"], html=HTML.replace("Audit", "draft"), activate=False)
    _as_admin_bearer(client)
    before = client.get(f"/api/documents/{draft['id']}").json()
    r = _put(client, draft["id"], HTML.replace("Audit", "draft"))
    assert r.status_code == 200
    after = client.get(f"/api/documents/{draft['id']}").json()
    assert after["content_sha256"] == before["content_sha256"] and after["updated_at"] == before["updated_at"]


def test_active_and_superseded_drafts_are_409_and_missing_is_404(client):
    r1 = publish(client)
    _as_admin_bearer(client)
    r = _put(client, r1["id"])
    assert r.status_code == 409 and "new revision" in r.text
    d2 = publish(client, code=r1["code"], html=HTML.replace("Audit", "d2"), activate=False)
    d3 = publish(client, code=r1["code"], html=HTML.replace("Audit", "d3"), activate=False)
    assert d3["supersedes_id"] == d2["id"]
    assert _put(client, d2["id"]).status_code == 409
    assert _put(client, d3["id"]).status_code == 200
    assert _put(client, 9999).status_code == 404


def test_validation_still_applies(client):
    r1 = publish(client)
    draft = publish(client, code=r1["code"], html=HTML.replace("Audit", "draft"), activate=False)
    _as_admin_bearer(client)
    assert _put(client, draft["id"], "not html").status_code == 400


def test_only_an_admin_bearer_may_replace_content(client):
    r1 = publish(client)
    draft = publish(client, code=r1["code"], html=HTML.replace("Audit", "draft"), activate=False)
    from main import app
    from documents.routes import require_document_admin_user
    app.dependency_overrides.pop(require_document_admin_user, None)
    assert client.put(f"/api/documents/{draft['id']}/content", json={"html": NEW},
                      headers={"X-Service-Token": AGENT_TOKEN}).status_code == 403
    assert client.put(f"/api/documents/{draft['id']}/content", json={"html": NEW},
                      headers={"X-Service-Token": INTERNAL_TOKEN}).status_code == 403
    assert client.put(f"/api/documents/{draft['id']}/content", json={"html": NEW}).status_code == 401
    # a standard-role bearer: patch the name the dependency resolves at call time
    import documents.routes as routes_mod
    saved = routes_mod.get_current_user
    routes_mod.get_current_user = lambda token, db: USER
    try:
        r = client.put(f"/api/documents/{draft['id']}/content", json={"html": NEW},
                       headers={"Authorization": "Bearer anything"})
        assert r.status_code == 403
    finally:
        routes_mod.get_current_user = saved
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd C:/tmp/mk1-doc-annotations/backend && $PY -m pytest tests/test_documents_content_replace.py -q` → FAIL (405/404; `require_document_admin_user` missing).

- [ ] **Step 3: Service**

Append to `backend/documents/service.py`:

```python
def replace_draft_content(db: Session, doc_id: int, *, html, updated_by: Optional[str]) -> tuple[Document, bool]:
    """In-place content replace for a DRAFT only (spec §10.3). Anything that was
    ever active is immutable: an edit to it is a new revision through
    create_document. Blob ordering mirrors delete_document: write the new
    bytes, commit the row, THEN best-effort delete the old blob, so a failed
    delete leaves an orphan and never a row pointing at missing bytes."""
    doc = get_document(db, doc_id)
    if doc.status != "draft":
        raise ConflictError(
            f"only a draft takes in-place content (this revision is {doc.status}); "
            f"save it as a new revision instead")
    dependent = db.execute(
        select(Document.id).where(Document.supersedes_id == doc.id).limit(1)
    ).scalar_one_or_none()
    if dependent is not None:
        raise ConflictError(f"revision {doc.id} is superseded by {dependent}; edit that one")
    data = validate_html(html)
    sha = hashlib.sha256(data).hexdigest()
    if sha == doc.content_sha256:
        return doc, False
    old_key = doc.storage_key
    doc.storage_key = get_storage().save(doc.code, doc.revision, data)
    doc.size_bytes = len(data)
    doc.content_sha256 = sha
    if updated_by:
        doc.updated_by = updated_by
    doc.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(doc)
    if old_key != doc.storage_key:
        try:
            get_storage().delete(old_key)
        except Exception as e:  # noqa: BLE001
            logging.getLogger(__name__).warning("documents blob orphaned key=%s err=%s", old_key, e)
    return doc, True
```

- [ ] **Step 4: Schema, dependency, route**

`backend/documents/schemas.py`:

```python
class DocumentContentReplace(BaseModel):
    html: str
```

`backend/documents/routes.py`, after `require_document_admin_writer`:

```python
def require_document_admin_user(
    x_service_token: Optional[str] = Header(None),
    token: Optional[str] = Depends(_optional_bearer),
    db: Session = Depends(get_db),
):
    """Content edits are a human path (spec §10): an admin LOGIN only. Agents
    revise through POST /documents; the service token has no author."""
    if x_service_token is not None:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "content edits need an admin login, not a service or agent token")
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "authentication required")
    return require_admin(get_current_user(token=token, db=db))
```

and the route, after `activate_document`:

```python
@router.put("/documents/{doc_id}/content", response_model=DocumentOut)
def replace_document_content(doc_id: int, req: DocumentContentReplace,
                             db: Session = Depends(get_db),
                             admin=Depends(require_document_admin_user)):
    try:
        doc, changed = service.replace_draft_content(db, doc_id, html=req.html,
                                                     updated_by=admin.email)
        n = service.revision_count(db, doc.code)
    except Exception as e:
        raise _http(e)
    if changed:
        logger.info("documents.content_replaced id=%s code=%s r%s by=%s", doc.id, doc.code,
                    doc.revision, admin.email)
    return _doc_out(doc, n)
```

Add `DocumentContentReplace` to the schemas import.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd C:/tmp/mk1-doc-annotations/backend && $PY -m pytest tests/test_documents_content_replace.py tests/test_documents_routes.py -q` → pass.

- [ ] **Step 6: Commit**

```bash
cd C:/tmp/mk1-doc-annotations && git add backend/documents/service.py backend/documents/routes.py backend/documents/schemas.py backend/tests/test_documents_content_replace.py && git commit -m "feat(documents): admin-only in-place content replace for drafts" -- backend/documents/service.py backend/documents/routes.py backend/documents/schemas.py backend/tests/test_documents_content_replace.py
```

---

### Task 18: Bridge extensions: edit mode, serialize, apply-replacement

**Files:**
- Modify: `src/vendor/plannotator/bridge-script.ts` (fenced `edit-mode` block + three handlers + two gates), `public/pn-bridge.v1.js` (regenerate), `VENDORED.md`
- Create: `src/vendor/plannotator/__tests__/bridge-edit-mode.test.ts`

**Interfaces:**
- Inbound: `set-edit-mode {on}`, `serialize`, `apply-replacement {id, text}`. Outbound: `serialized {html, appliedId?}`, `apply-failed {id}`.
- While edit mode is on: the body is `contenteditable`, drag selections are NOT posted, pinpoint is off (the parent also posts `set-annotate-mode {active:false}`).
- `serialize` output: `<!doctype html>\n` + the document with every viewer-owned node removed, `contenteditable` and the two body data attributes removed, and every `pn-h-*` id removed.

- [ ] **Step 1: Write the failing test**

```ts
// src/vendor/plannotator/__tests__/bridge-edit-mode.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadBridge } from './bridge-harness'

let b: ReturnType<typeof loadBridge>

beforeAll(async () => {
  b = loadBridge('<h2>Section</h2><p>Hello world, hello <em>again</em>.</p>', '<title>t</title><style>p{color:red}</style>')
  await b.tick()
})
afterAll(() => b.dispose())

describe('edit-mode extension', () => {
  it('toggles contenteditable on the body', async () => {
    await b.send({ type: 'plannotator-bridge-set-edit-mode', on: true })
    expect(document.body.getAttribute('contenteditable')).toBe('true')
    await b.send({ type: 'plannotator-bridge-set-edit-mode', on: false })
    expect(document.body.hasAttribute('contenteditable')).toBe(false)
  })

  it('serialize returns a doctype-prefixed document with viewer nodes, the editable flag and minted ids gone', async () => {
    await b.send({ type: 'plannotator-bridge-set-edit-mode', on: true })
    expect(document.querySelector('[data-plannotator-overlay-host]')).not.toBeNull()
    await b.send({ type: 'plannotator-bridge-serialize' })
    const html = b.last('serialized')?.html as string
    expect(html.startsWith('<!doctype html>\n<html')).toBe(true)
    expect(html).toContain('<p>Hello world, hello <em>again</em>.</p>')
    expect(html).toContain('<style>p{color:red}</style>')
    expect(html).toContain('<h2>Section</h2>')
    expect(html).not.toMatch(/contenteditable|data-plannotator-|pn-h-/)
    // the live document keeps its overlay and its editable flag
    expect(document.querySelector('[data-plannotator-overlay-host]')).not.toBeNull()
    expect(document.body.getAttribute('contenteditable')).toBe('true')
    await b.send({ type: 'plannotator-bridge-set-edit-mode', on: false })
  })

  it('apply-replacement swaps the restored range for the text and serializes with appliedId', async () => {
    await b.send({ type: 'plannotator-bridge-find-and-mark', id: 'c1', annotationType: 'deletion', originalText: 'world', anchor: null, additionalAnchors: null })
    expect(b.last('mark-applied')).toMatchObject({ id: 'c1', success: true })
    await b.send({ type: 'plannotator-bridge-apply-replacement', id: 'c1', text: 'there' })
    const msg = b.last('serialized')
    expect(msg?.appliedId).toBe('c1')
    expect(msg?.html as string).toContain('<p>Hello there, hello <em>again</em>.</p>')
    expect(document.body.textContent).toContain('Hello there')
  })

  it('apply-replacement on an unknown or dead id posts apply-failed', async () => {
    await b.send({ type: 'plannotator-bridge-apply-replacement', id: 'nope', text: 'x' })
    expect(b.last('apply-failed')).toMatchObject({ id: 'nope' })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/vendor/plannotator/__tests__/bridge-edit-mode.test.ts` → FAIL (`contenteditable` never set; no `serialized` message).

- [ ] **Step 3: Add the extension**

In `src/vendor/plannotator/bridge-script.ts`, directly below the `// /accumark` of the headings block, add:

```js
  // accumark: edit-mode
  // Admin edit mode (spec §7.4 ext 2+3, §10). Native contenteditable on the
  // body; drag-selection posting is gated off (see the mouseup listener and
  // handleSelection); the parent disarms pinpoint via set-annotate-mode.
  var editModeActive = false;
  function setEditMode(on) {
    editModeActive = !!on;
    if (!document.body) return;
    if (editModeActive) {
      document.body.setAttribute('contenteditable', 'true');
      if (pendingSelection) postToParent({ type: PREFIX + 'selection-clear' });
      pendingSelection = null;
      pendingRange = null;
      clearMultiTargets();
      clearPendingPin();
      try { window.getSelection().removeAllRanges(); } catch (ex) {}
      renderAnnotationOverlay();
    } else {
      document.body.removeAttribute('contenteditable');
    }
  }
  var VIEWER_NODE_SELECTOR = '[data-plannotator-overlay-host],[data-plannotator-pinpoint-box],' +
    '[data-plannotator-pinpoint-label],[data-plannotator-vim-ui],[data-plannotator-vim-badge],' +
    '[data-plannotator-vim-cursor],[data-plannotator-vim-reticle],[data-plannotator-print-layer],' +
    '[data-plannotator-live-css],[data-plannotator-marker]';
  function serializeDocument() {
    var root = document.documentElement.cloneNode(true);
    var junk = root.querySelectorAll(VIEWER_NODE_SELECTOR);
    for (var i = 0; i < junk.length; i++) junk[i].parentNode.removeChild(junk[i]);
    var body = root.querySelector('body');
    if (body) {
      body.removeAttribute('contenteditable');
      body.removeAttribute('data-plannotator-pinpoint-cursor');
      body.removeAttribute('data-plannotator-frame-inert');
    }
    var minted = root.querySelectorAll('[id^="pn-h-"]');
    for (var j = 0; j < minted.length; j++) minted[j].removeAttribute('id');
    return '<!doctype html>\\n' + root.outerHTML;
  }
  function applyReplacement(id, text) {
    var record = findAnnRecord(id);
    if (!record) return false;
    var target = null;
    for (var i = 0; i < record.targets.length; i++) {
      var t = record.targets[i];
      if (t.kind === 'range' && rangeAlive(t.range)) { target = t.range; break; }
    }
    if (!target) return false;
    try {
      target.deleteContents();
      target.insertNode(document.createTextNode(text));
    } catch (ex) {
      return false;
    }
    removeAnnRecord(id);
    renderAnnotationOverlay();
    return true;
  }
  // /accumark
```

(`\\n` is doubled because the bridge is a template literal.)

In the second `message` listener (the `type === PREFIX + 'create-mark'` chain), add before its final `else` branch:

```js
    // accumark: edit-mode handlers
    else if (type === PREFIX + 'set-edit-mode') {
      setEditMode(e.data.on === true);
    }
    else if (type === PREFIX + 'serialize') {
      postToParent({ type: PREFIX + 'serialized', html: serializeDocument() });
    }
    else if (type === PREFIX + 'apply-replacement') {
      var applyOk = typeof e.data.id === 'string' && typeof e.data.text === 'string'
        && applyReplacement(e.data.id, e.data.text);
      if (applyOk) postToParent({ type: PREFIX + 'serialized', html: serializeDocument(), appliedId: e.data.id });
      else postToParent({ type: PREFIX + 'apply-failed', id: e.data.id });
    }
    // /accumark
```

Two gates: as the first statement of the `document.addEventListener('mouseup', function() {` handler (line ~1506) add `if (editModeActive) return; // accumark: edit-mode`, and as the first statement of `function handleSelection(modeOverride, extras) {` (line ~442) add the same line.

Append to `VENDORED.md` under Local changes: `- bridge-script.ts \`edit-mode\`: set-edit-mode / serialize / apply-replacement handlers and the two selection gates (Task 18).`

- [ ] **Step 4: Regenerate the asset and run the suites**

Run: `npm run build:bridge && npx vitest run src/vendor/plannotator/__tests__/` → every vendor suite passes, including the asset equality test and the headings test (unchanged behaviour).

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/mk1-doc-annotations && git add src/vendor/plannotator public/pn-bridge.v1.js && git commit -m "feat(viewer): bridge edit mode, serialize, and apply-replacement extensions" -- src/vendor/plannotator public/pn-bridge.v1.js
```

---

### Task 19: Edit mode in the viewer, Apply on suggestions

**Files:**
- Create: `src/components/documents/annotations/EditModeBar.tsx`, `src/components/documents/__tests__/DocumentViewer.edit.test.tsx`
- Modify: `src/lib/api-documents.ts` (`replaceDraftContent`, `createDocumentRevision`), `src/services/documents.ts` (`useReplaceDraftContent`, `useCreateRevision`), `src/components/documents/DocumentViewer.tsx`

**Interfaces:**
- `replaceDraftContent(id, html) -> Promise<DocumentRow>` (`PUT /api/documents/{id}/content`); `createDocumentRevision(code, html) -> Promise<DocumentRow>` (`POST /api/documents {code, html, activate:false}`).
- Viewer: `Edit` (admin, bridge ready) → `bridge.setEditMode(true)`, annotate off; `EditModeBar` with Save / Cancel; Save → `bridge.serialize()` → `onSerialized(html)` → `stripViewerInjection(html, content.data)` → draft: PUT, else: POST new draft and `navigateToDocument(new.id)`; Cancel → `setEditMode(false)` and reload the frame; unsaved guard on Back, revision select, and `beforeunload`; `onApply(c)` → `bridge.applyReplacement(String(c.id), c.suggested_text)` → same save path → resolve only after a 2xx; `apply-failed` → toast.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/documents/__tests__/DocumentViewer.edit.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const replace = vi.hoisted(() => vi.fn())
const createRev = vi.hoisted(() => vi.fn())
const navigate = vi.hoisted(() => vi.fn())
const clear = vi.hoisted(() => vi.fn())
const setStatus = vi.hoisted(() => vi.fn())
let docStatus = 'draft'

vi.mock('@/services/documents', () => ({
  useDocument: () => ({ data: { id: 10, code: 'ART-0001', revision: 2, title: 'Audit', status: docStatus, category_name: 'Artifact', author: 'F', co_author: null, updated_at: '2026-10-03', updated_by: null, effective_date: null, revisions: [{ id: 9, revision: 1, status: 'active', created_at: '2026-10-01' }, { id: 10, revision: 2, status: docStatus, created_at: '2026-10-03' }], open_comment_count: 0 }, isLoading: false, error: null }),
  useDocumentContent: () => ({ data: '<html><head></head><body><p>hi</p></body></html>', isLoading: false, error: null }),
  useDocumentCategories: () => ({ data: [] }),      // RetitleDialog
  usePatchDocument: () => ({ mutate: vi.fn(), isPending: false }),
  useReplaceDraftContent: () => ({ mutateAsync: replace }),
  useCreateRevision: () => ({ mutateAsync: createRev }),
  documentKeys: { detail: (id: number) => ['documents', 'detail', id], lists: ['documents', 'list'], content: (id: number) => ['documents', 'content', id] },
}))
vi.mock('@/components/flags/EntityFlagButton', () => ({ EntityFlagButton: () => null }))
vi.mock('@/services/document-comments', () => ({
  useDocumentComments: () => ({ data: { items: [{ id: 5, number: 1, kind: 'suggestion', status: 'open', anchor: { originalText: 'hi' }, suggested_text: 'hello', body: '', author: 'T', author_user_id: 1, author_agent: null, label: null, replies: [], attachments: [], created_at: '2026-10-03T10:00:00', updated_at: '', edited_at: null, resolved_at: null, resolved_by: null, code: 'ART-0001', document_id: 10, revision: 2, parent_id: null }], code: 'ART-0001', latest_revision: 2, open_count: 1 } }),
  useCommentLabels: () => ({ data: [] }),
  useCreateComment: () => ({ mutateAsync: vi.fn() }),
  usePatchComment: () => ({ mutateAsync: vi.fn() }),
  useDeleteComment: () => ({ mutate: vi.fn() }),
  useSetCommentStatus: () => ({ mutate: setStatus, mutateAsync: setStatus }),
}))
vi.mock('@/store/auth-store', () => ({ useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 1, role: 'admin' } }) }))
vi.mock('@/store/ui-store', () => ({ useUIStore: (sel: (s: unknown) => unknown) => sel({ clearDocumentViewer: clear, navigateToDocument: navigate }) }))

function frameSays(data: unknown) {
  const frame = screen.getByTitle('Audit') as HTMLIFrameElement
  window.dispatchEvent(new MessageEvent('message', { data, origin: 'null', source: frame.contentWindow ?? undefined }))
}
const ready = () => frameSays({ type: 'plannotator-bridge-ready', protocolVersion: 1 })

async function renderViewer() {
  const { DocumentViewer } = await import('@/components/documents/DocumentViewer')
  render(<QueryClientProvider client={new QueryClient()}><DocumentViewer id={10} /></QueryClientProvider>)
  await waitFor(() => expect(screen.getByTitle('Audit')).toBeInTheDocument())
  act(ready)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled())
}

describe('DocumentViewer edit mode', () => {
  beforeEach(() => { replace.mockReset().mockResolvedValue({ id: 10 }); createRev.mockReset().mockResolvedValue({ id: 11 }); navigate.mockReset(); clear.mockReset(); setStatus.mockReset().mockResolvedValue({}); docStatus = 'draft' })

  it('Save on a draft PUTs the stripped html in place', async () => {
    await renderViewer()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByText('Editing · unsaved')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    act(() => frameSays({ type: 'plannotator-bridge-serialized', html: '<!doctype html>\n<html data-theme="dark"><head><!--pn-inject--><style></style><!--/pn-inject--></head><body contenteditable="true"><p>edited</p></body></html>' }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith({ id: 10, html: '<!doctype html>\n<html><head></head><body><p>edited</p></body></html>' }))
    await waitFor(() => expect(screen.queryByText('Editing · unsaved')).toBeNull())
  })

  it('Save on an active revision POSTs a new draft and navigates to it', async () => {
    docStatus = 'active'
    await renderViewer()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    act(() => frameSays({ type: 'plannotator-bridge-serialized', html: '<html><head></head><body><p>edited</p></body></html>' }))
    await waitFor(() => expect(createRev).toHaveBeenCalledWith({ code: 'ART-0001', html: '<html><head></head><body><p>edited</p></body></html>' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(11))
  })

  it('asks before leaving with unsaved edits', async () => {
    await renderViewer()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }))
    expect(confirm).toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }))
    expect(clear).toHaveBeenCalled()
  })

  it('Apply sends apply-replacement, saves, then resolves; apply-failed only toasts', async () => {
    await renderViewer()
    fireEvent.click(screen.getByRole('button', { name: /Comments/ }))
    const frame = screen.getByTitle('Audit') as HTMLIFrameElement
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }))
    expect(post).toHaveBeenCalledWith({ type: 'plannotator-bridge-apply-replacement', id: '5', text: 'hello' }, '*')
    act(() => frameSays({ type: 'plannotator-bridge-serialized', html: '<html><head></head><body><p>hello</p></body></html>', appliedId: '5' }))
    await waitFor(() => expect(replace).toHaveBeenCalled())
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith({ id: 5, status: 'resolved' }))
    setStatus.mockClear()
    act(() => frameSays({ type: 'plannotator-bridge-apply-failed', id: '5' }))
    expect(setStatus).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/components/documents/__tests__/DocumentViewer.edit.test.tsx` → FAIL (no Edit button, missing hooks).

- [ ] **Step 3: API + hooks**

`src/lib/api-documents.ts`:

```ts
/** Admin-only in-place content replace for a DRAFT (spec 2026-10-03 §10.3). */
export function replaceDraftContent(id: number, html: string): Promise<DocumentRow> {
  return apiFetch<DocumentRow>(`/api/documents/${id}/content`, {
    method: 'PUT',
    body: JSON.stringify({ html }),
  })
}

/** The next revision of `code` as a DRAFT; title and description are inherited. */
export function createDocumentRevision(code: string, html: string): Promise<DocumentRow> {
  return apiFetch<DocumentRow>('/api/documents', {
    method: 'POST',
    body: JSON.stringify({ code, html, activate: false }),
  })
}
```

`src/services/documents.ts`:

```ts
export function useReplaceDraftContent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, html }: { id: number; html: string }) => replaceDraftContent(id, html),
    onSuccess: (_row, { id }) => {
      qc.invalidateQueries({ queryKey: documentKeys.content(id) })
      qc.invalidateQueries({ queryKey: documentKeys.detail(id) })
      qc.invalidateQueries({ queryKey: documentKeys.lists })
      toast.success('Draft updated')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useCreateRevision() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ code, html }: { code: string; html: string }) => createDocumentRevision(code, html),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: documentKeys.lists })
      toast.success('Saved as a new draft revision')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}
```

- [ ] **Step 4: The bar**

```tsx
// src/components/documents/annotations/EditModeBar.tsx
import { Button } from '@/components/ui/button'

export function EditModeBar({ saving, onSave, onCancel }: { saving: boolean; onSave: () => void; onCancel: () => void }) {
  return (
    <div role="status" className="flex items-center gap-2 border-b bg-amber-100 px-3 py-1 text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">
      <span className="font-medium">Editing · unsaved</span>
      <span className="text-muted-foreground">Click into the page and change text. Ctrl+B and Ctrl+I work.</span>
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onCancel} disabled={saving}>Cancel</Button>
      <Button size="sm" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
    </div>
  )
}
```

- [ ] **Step 5: Wire the viewer**

In `DocumentViewer.tsx` (new imports: `EditModeBar`, `stripViewerInjection`, `useReplaceDraftContent`, `useCreateRevision`, `useSetCommentStatus`, `FilePenLine` from lucide, `toast`), rename the existing `editing` state to `retitling`, then add:

```tsx
  const [editMode, setEditMode] = useState(false)
  const [saving, setSaving] = useState(false)
  const [frameKey, setFrameKey] = useState(0)
  const pendingApply = useRef<number | null>(null)
  const replaceContent = useReplaceDraftContent()
  const createRevision = useCreateRevision()
  const setCommentStatus = useSetCommentStatus(id)

  const guardLeave = () => !editMode || window.confirm('Discard unsaved edits?')
  useEffect(() => {
    if (!editMode) return
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [editMode])

  const enterEdit = () => { setEditMode(true); setSelection(null); setComposer(null); bridge.setEditMode(true) }
  const exitEdit = () => { setEditMode(false); bridge.setEditMode(false) }
  const cancelEdit = () => { exitEdit(); setFrameKey(k => k + 1) }

  const saveSerialized = async (html: string): Promise<boolean> => {
    if (!doc || !content.data) return false
    const clean = stripViewerInjection(html, content.data)
    setSaving(true)
    try {
      if (doc.status === 'draft') {
        await replaceContent.mutateAsync({ id: doc.id, html: clean })
        exitEdit()
        setFrameKey(k => k + 1)
      } else {
        const created = await createRevision.mutateAsync({ code: doc.code, html: clean })
        exitEdit()
        navigateToDocument(created.id)
      }
      return true
    } catch {
      return false
    } finally {
      setSaving(false)
    }
  }
```

Pass to the bridge hook: `annotateActive: !editMode`, `documentKey: `${id}:${mode}:${frameKey}``, and

```tsx
    onSerialized: (html, appliedId) => {
      void saveSerialized(html).then(ok => {
        const applied = pendingApply.current
        pendingApply.current = null
        if (ok && appliedId && applied != null && String(applied) === appliedId) {
          setCommentStatus.mutate({ id: applied, status: 'resolved' })
        }
      })
    },
    onApplyFailed: () => {
      pendingApply.current = null
      toast.error('That suggestion lost its place in this revision')
    },
```

Header: the Back button's `onClick` becomes `() => { if (guardLeave()) clear() }`; the revision `Select`'s `onValueChange` becomes `v => { if (guardLeave()) navigateToDocument(Number(v)) }`; add, for admins, next to "Edit details": `<Button variant="outline" size="sm" disabled={bridge.status !== 'ready' || editMode} onClick={enterEdit}><FilePenLine className="mr-1 h-4 w-4" />Edit</Button>`. Render `{editMode && <EditModeBar saving={saving} onSave={() => bridge.serialize()} onCancel={cancelEdit} />}` directly under the header. Give the iframe `key={frameKey}` so Cancel reloads the untouched srcDoc. Pass `onApply={c => { if (!c.suggested_text) return; pendingApply.current = c.id; bridge.applyReplacement(String(c.id), c.suggested_text) }}` to `CommentsPanel`.

- [ ] **Step 6: Run the tests; full gate**

Run: `npx vitest run src/components/documents && npm run check:all` → pass, clean.

- [ ] **Step 7: Commit**

```bash
cd C:/tmp/mk1-doc-annotations && git add src/components/documents src/lib/api-documents.ts src/services/documents.ts && git commit -m "feat(viewer): admin edit mode saving as draft or new revision; apply suggestion" -- src/components/documents src/lib/api-documents.ts src/services/documents.ts
```

---

### Task 20: End-to-end proof on a devbox stack, final gates, PR 4

**Files:**
- Create: `e2e/documents-annotations.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
// e2e/documents-annotations.spec.ts
import { test, expect, type Page } from './fixtures/auth'

/**
 * The whole loop (spec 2026-10-03 §12): comment, reload, re-anchor, MCP-shaped
 * revision, lost-its-place, apply suggestion, resolve. Runs against a devbox
 * stack (see e2e/README.md). Needs E2E_BACKEND_URL and an admin login; it
 * publishes its own document through the API.
 */
const BACKEND = process.env.E2E_BACKEND_URL ?? 'http://localhost:8012'
const HTML = (variant: string) =>
  `<!doctype html><html><head><title>e2e</title><style>/* accumark-docs v1 */</style></head><body><h1>E2E ${variant}</h1><h2>Rulings</h2><p>Dedupe on an EXPLICIT code still behaves as before.</p><p>Cd and Pb limits use fifty percent of spec.</p></body></html>`

async function api(page: Page, method: string, path: string, body?: unknown) {
  const token = await page.evaluate(() => localStorage.getItem('accu_mk1_auth_token'))
  const res = await page.request.fetch(`${BACKEND}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: body === undefined ? undefined : JSON.stringify(body),
  })
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy()
  return res.json()
}

test('annotate, reload, revise, lose a place, apply, resolve', async ({ page }) => {
  await page.goto('/#reports/documents')
  const doc = await api(page, 'POST', '/api/documents', { title: `E2E ${Date.now()}`, html: HTML('one'), category: 'ART', author: 'e2e' })

  await page.goto(`/#reports/documents?id=${doc.id}`)
  const frame = page.frameLocator('iframe[title]')
  await expect(frame.locator('h1')).toHaveText('E2E one')

  // 1. select text inside the frame -> toolbar -> comment with a label
  const p = frame.locator('p').first()
  await p.dblclick() // selects a word; the bridge posts the selection on mouseup
  await page.getByRole('toolbar', { name: 'Annotate selection' }).getByRole('button', { name: 'Comment' }).click()
  await page.getByPlaceholder('Add a comment…').fill('Which before?')
  await page.getByRole('button', { name: /Verify this/ }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('comment-card').first()).toContainText('Which before?')

  // 2. a suggestion through the API with a quote-only anchor (the agent path)
  await api(page, 'POST', `/api/documents/${doc.id}/comments`, {
    kind: 'suggestion', body: '', anchor: { originalText: 'fifty percent of spec' }, suggested_text: '50% of spec',
  })
  // 3. a comment that will lose its place
  await api(page, 'POST', `/api/documents/${doc.id}/comments`, { kind: 'comment', body: 'doomed', anchor: { originalText: 'E2E one' } })

  // 4. reload: markers restored, numbered
  await page.reload()
  await expect(page.getByTestId('comment-card')).toHaveCount(3)
  await expect(page.getByTestId('comment-card').nth(0)).toHaveAttribute('data-number', '1')

  // 5. a new revision with the heading changed: comment 3 loses its place
  const r2 = await api(page, 'POST', '/api/documents', { code: doc.code, html: HTML('two'), author: 'e2e', activate: true })
  await page.goto(`/#reports/documents?id=${r2.id}`)
  await expect(frame.locator('h1')).toHaveText('E2E two')
  const lost = page.getByRole('region', { name: 'Lost its place' })
  await expect(lost).toContainText('doomed')
  await expect(page.getByTestId('comment-card').filter({ hasText: 'Which before?' })).toContainText('on r1')

  // 6. apply the suggestion as admin: creates a draft r3, navigates, resolves
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByText('Saved as a new draft revision')).toBeVisible()
  await expect(frame.locator('p').nth(1)).toContainText('50% of spec')
  await page.getByLabel('Filter comments').click()
  await page.getByRole('option', { name: 'Resolved' }).click()
  await expect(page.getByTestId('comment-card').filter({ hasText: '50% of spec' })).toBeVisible()
})
```

- [ ] **Step 2: Run it against a stack**

Source the stack env and run: `. /c/tmp/<stack>-e2e.env && npx playwright test e2e/documents-annotations.spec.ts --headed`. If the double-click selection does not reach the bridge in Chromium, replace it with `await p.selectText()` (Playwright's `locator.selectText()`), then dispatch `mouseup` via `await p.dispatchEvent('mouseup')`.

- [ ] **Step 3: Manual edit-mode pass on the same stack (not automatable in jsdom)**

1. Open an active document, Edit, change a number in a table cell with the keyboard, Save: a draft r(n+1) opens; Download it and confirm the file has no `pn-inject`, no `contenteditable`, no `pn-h-` ids, and the edited number.
2. Edit the draft again, Save: same revision id, hash changed, old blob gone (`aws s3 ls` under the documents prefix on the stack's bucket, or the filesystem dir).
3. Edit, then change the revision selector: the confirm dialog appears; Cancel keeps you in edit mode.
4. Edit, Cancel: the frame reloads with the original text.
5. Apply a suggestion on an active revision: a draft is created with the replacement in place and the suggestion shows Resolved.
6. Confirm an agent token gets 403 on `PUT …/content` (`curl -X PUT -H "X-Service-Token: …"`).

- [ ] **Step 4: Gates and PR 4**

Backend failure-set diff as in Task 7 (branch vs master). `npm run check:all`. Push `feat/document-annotations-edit`, open the PR with the e2e result and the manual checklist as **Evidence**, ending with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Deploy order per spec §13: PR 1 (backend) → PR 2 (viewer) → MCP cutover → PR 4. Post-deploy smoke on prod: one comment on an existing document, one image attachment (the first PutObject under `<flag prefix>/documents/`), reload, resolve; the bridge banner on prod means the nginx CSP needs `script-src 'self'`, not a code change.
