"""FastAPI router for the documents library. Thin shell over documents.service."""
from __future__ import annotations

import logging
import os
import re
import secrets
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth import get_current_user, require_admin, require_internal_service_token
from database import get_db
from documents import access, service
from documents.errors import BadRequestError, ConflictError, NotFoundError
from documents.models import Document, DocumentCategory, DocumentSpace
from documents.schemas import (CategoryCreate, CategoryOut, CategoryUpdate, DocumentCreate,
                               DocumentDetail, DocumentListOut, DocumentOut, DocumentPatch,
                               SpaceCreate, SpaceGrantsOut, SpaceGrantsReplace, SpaceOut,
                               SpaceUpdate)
from documents.storage import DocumentNotFound

router = APIRouter(prefix="/api", tags=["documents"])
logger = logging.getLogger(__name__)

_optional_bearer = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False)


_AGENT_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
_MIN_AGENT_TOKEN = 32


_SLUG_LIST = re.compile(r"^[a-z0-9][a-z0-9-]{0,59}(\+[a-z0-9][a-z0-9-]{0,59})*$")


@dataclass(frozen=True)
class AgentWriter:
    """A caller holding a documents-scoped agent token. Not a user: it has no id and
    no email, and it may author and archive but never delete. `spaces` is the slug
    allow-list it may publish into (spec 2026-10-06 section 7.1); absent = General."""
    name: str
    spaces: frozenset = frozenset({"general"})


def _agent_tokens() -> Dict[str, tuple]:
    """MK1_DOCUMENT_AGENT_TOKENS="jarvis:<token>:general+analytical,tars:<token>"
    -> {agent: (token, frozenset(slugs))}.

    These exist because the internal service token also opens the s2s order and
    sample endpoints, so it cannot live on a bot host. An agent token opens the
    documents API and nothing else, names the agent, and (optionally) names the
    spaces it may write to. A malformed entry is dropped (and logged), never
    half-accepted."""
    out: Dict[str, tuple] = {}
    for entry in os.environ.get("MK1_DOCUMENT_AGENT_TOKENS", "").split(","):
        entry = entry.strip()
        if not entry:
            continue
        name, sep, rest = entry.partition(":")
        tok, _, spaces = rest.partition(":")
        name, tok, spaces = name.strip(), tok.strip(), spaces.strip().lower()
        if not sep or not _AGENT_NAME.match(name) or len(tok) < _MIN_AGENT_TOKEN:
            logger.warning("documents.agent_token_ignored agent=%r reason=malformed", name[:40])
            continue
        if spaces and not _SLUG_LIST.match(spaces):
            logger.warning("documents.agent_token_ignored agent=%r reason=bad_spaces", name[:40])
            continue
        out[name] = (tok, frozenset(spaces.split("+")) if spaces else frozenset({"general"}))
    return out


def _match_agent(presented: str) -> Optional[AgentWriter]:
    found = None
    for name, (tok, spaces) in _agent_tokens().items():  # no early exit: same work for hit or miss
        if secrets.compare_digest(presented.encode(), tok.encode()):
            found = AgentWriter(name, spaces)
    return found


def agent_may_write(writer, space) -> bool:
    """Admins and the internal service token write anywhere; an agent only to its list."""
    if isinstance(writer, AgentWriter):
        return space.slug in writer.spaces
    return True


def _agent_may_see(writer, doc: Document) -> bool:
    """A hidden document must be 404 to an agent whose allow-list excludes its space."""
    if not isinstance(writer, AgentWriter):
        return True
    slug = doc.space.slug if doc.space is not None else "general"
    return slug in writer.spaces


def require_document_writer(
    x_service_token: Optional[str] = Header(None),
    token: Optional[str] = Depends(_optional_bearer),
    db: Session = Depends(get_db),
):
    """Writers are an admin login, an agent token, OR the internal service token
    (spec §5, §9). A present X-Service-Token is authoritative: a wrong one is 401
    even if a bearer is also sent. Returns the admin User, an AgentWriter, or None
    for internal-service callers."""
    if x_service_token is not None:
        agent = _match_agent(x_service_token)
        if agent is not None:
            return agent
        require_internal_service_token(x_service_token)
        return None
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "authentication required")
    user = get_current_user(token=token, db=db)
    return require_admin(user)


def require_document_admin_writer(writer=Depends(require_document_writer)):
    """Deleting a draft and managing categories: admins and the internal service
    only. Agents archive, they never delete (Handler ruling 2026-09-17)."""
    if isinstance(writer, AgentWriter):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "agent tokens cannot delete documents or manage categories")
    return writer


def _space_reader(
    request: Request,
    x_service_token: Optional[str] = Header(None),
    token: Optional[str] = Depends(_optional_bearer),
    db: Session = Depends(get_db),
):
    """GET /document-spaces: a login sees what it can read; an agent token sees its
    allow-list (the MCP's documents_spaces tool). Internal token: everything."""
    if x_service_token is not None:
        agent = _match_agent(x_service_token)
        if agent is not None:
            return agent
        require_internal_service_token(x_service_token)
        return None
    # Resolved through dependency_overrides so tests (and any future auth swap) apply.
    # get_current_user cannot be a plain Depends here: it would 401 agent-token callers.
    resolve = request.app.dependency_overrides.get(get_current_user, get_current_user)
    if resolve is get_current_user and not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "authentication required")
    return resolve() if resolve is not get_current_user else get_current_user(token=token, db=db)


def _reader_for(writer):
    """The identity the READ gate uses on a write route. Admin bearer: that user.
    Agent token or internal token: an unrestricted pseudo-reader (their allow-list,
    not their membership, governs writes), so the gate reduces to existence."""
    if writer is None or isinstance(writer, AgentWriter):
        return SimpleNamespace(id=0, role="admin", is_active=True)
    return writer


def _gate_write(db, writer, doc_id: int) -> Document:
    """Load the document and 404 (same text as a missing id) if the writer cannot see it."""
    doc = service.get_document(db, doc_id)
    if not _agent_may_see(writer, doc):
        raise NotFoundError(f"document {doc.id} not found")
    access.require_view(db, _reader_for(writer), doc)
    return doc


def _audit(writer, action: str, doc: Document) -> None:
    if isinstance(writer, AgentWriter):
        logger.info("documents.agent_write agent=%s action=%s code=%s revision=%s id=%s",
                    writer.name, action, doc.code, doc.revision, doc.id)


def _http(e: Exception) -> HTTPException:
    if isinstance(e, NotFoundError) or isinstance(e, DocumentNotFound):
        return HTTPException(status_code=404, detail=str(e))
    if isinstance(e, ConflictError):
        return HTTPException(status_code=409, detail=str(e))
    if isinstance(e, BadRequestError):
        return HTTPException(status_code=400, detail=str(e))
    if isinstance(e, HTTPException):
        return e
    if isinstance(e, IntegrityError):
        # Lost race on a unique constraint (two pushes computing the same
        # (code, revision), duplicate category name). Retryable, not a 500.
        logger.warning("documents integrity conflict: %s", e)
        return HTTPException(status_code=409, detail="conflicting write; retry")
    logger.exception("unhandled documents error")
    return HTTPException(status_code=500, detail="internal error")


def _cat_out(cat: DocumentCategory, count: int) -> CategoryOut:
    out = CategoryOut.model_validate(cat)
    out.document_count = count
    return out


def _space_out(sp: DocumentSpace, count: int, can_write: bool) -> SpaceOut:
    out = SpaceOut.model_validate(sp)
    out.document_count = count
    out.can_write = can_write
    return out


def _doc_out(doc: Document, revision_count: int) -> DocumentOut:
    return DocumentOut(
        id=doc.id, code=doc.code, revision=doc.revision, title=doc.title,
        description=doc.description, category_id=doc.category_id,
        category_name=doc.category.name, category_prefix=doc.category.code_prefix,
        space_id=doc.space_id,
        space_slug=doc.space.slug if doc.space is not None else "general",
        space_name=doc.space.name if doc.space is not None else "General",
        status=doc.status, effective_date=doc.effective_date, activated_at=doc.activated_at,
        retired_at=doc.retired_at, supersedes_id=doc.supersedes_id, author=doc.author,
        updated_by=doc.updated_by, co_author=doc.co_author,
        source_session=doc.source_session, created_by_user_id=doc.created_by_user_id,
        content_type=doc.content_type, size_bytes=doc.size_bytes,
        content_sha256=doc.content_sha256, created_at=doc.created_at,
        updated_at=doc.updated_at, revision_count=revision_count)


# --- categories -------------------------------------------------------------------------

@router.get("/document-categories", response_model=List[CategoryOut])
def list_categories(active_only: bool = False, db: Session = Depends(get_db),
                    user=Depends(get_current_user)):
    return [_cat_out(c, n) for c, n in service.list_categories(db, active_only=active_only)]


@router.post("/document-categories", response_model=CategoryOut, status_code=201)
def create_category(req: CategoryCreate, db: Session = Depends(get_db),
                    writer=Depends(require_document_admin_writer)):
    try:
        cat = service.create_category(db, name=req.name, code_prefix=req.code_prefix,
                                      description=req.description, sort_order=req.sort_order)
    except Exception as e:
        raise _http(e)
    return _cat_out(cat, 0)


@router.put("/document-categories/{category_id}", response_model=CategoryOut)
def update_category(category_id: int, req: CategoryUpdate, db: Session = Depends(get_db),
                    writer=Depends(require_document_admin_writer)):
    try:
        cat = service.update_category(db, category_id, **req.model_dump(exclude_unset=True))
        count = dict((c.id, n) for c, n in service.list_categories(db)).get(cat.id, 0)
    except Exception as e:
        raise _http(e)
    return _cat_out(cat, count)


@router.delete("/document-categories/{category_id}", status_code=204)
def delete_category(category_id: int, db: Session = Depends(get_db),
                    writer=Depends(require_document_admin_writer)):
    try:
        service.delete_category(db, category_id)
    except Exception as e:
        raise _http(e)
    return Response(status_code=204)


# --- spaces (spec 2026-10-06 section 8.1) ------------------------------------------------

@router.get("/document-spaces", response_model=List[SpaceOut])
def list_spaces(include_inactive: bool = False, db: Session = Depends(get_db),
                who=Depends(_space_reader)):
    rows = service.list_spaces(db, include_inactive=include_inactive)
    if isinstance(who, AgentWriter):
        return [_space_out(sp, n, True) for sp, n in rows if sp.slug in who.spaces]
    if who is None:
        return [_space_out(sp, n, True) for sp, n in rows]
    from groups.access import is_admin
    return [_space_out(sp, n, is_admin(who)) for sp, n in rows if access.can_view_space(db, who, sp)]


@router.post("/document-spaces", response_model=SpaceOut, status_code=201)
def create_space(req: SpaceCreate, db: Session = Depends(get_db),
                 writer=Depends(require_document_admin_writer)):
    try:
        sp = service.create_space(db, slug=req.slug, name=req.name, description=req.description,
                                  visibility=req.visibility, sort_order=req.sort_order)
    except Exception as e:
        raise _http(e)
    return _space_out(sp, 0, True)


@router.put("/document-spaces/{space_id}", response_model=SpaceOut)
def update_space(space_id: int, req: SpaceUpdate, db: Session = Depends(get_db),
                 writer=Depends(require_document_admin_writer)):
    try:
        sp = service.update_space(db, space_id, **req.model_dump(exclude_unset=True))
        count = dict((s.id, n) for s, n in service.list_spaces(db, include_inactive=True)).get(sp.id, 0)
    except Exception as e:
        raise _http(e)
    return _space_out(sp, count, True)


@router.get("/document-spaces/{space_id}/grants", response_model=SpaceGrantsOut)
def get_space_grants(space_id: int, db: Session = Depends(get_db),
                     writer=Depends(require_document_admin_writer)):
    try:
        return SpaceGrantsOut(space_id=space_id, group_ids=service.list_space_grants(db, space_id))
    except Exception as e:
        raise _http(e)


@router.put("/document-spaces/{space_id}/grants", response_model=SpaceGrantsOut)
def put_space_grants(space_id: int, req: SpaceGrantsReplace, db: Session = Depends(get_db),
                     writer=Depends(require_document_admin_writer)):
    try:
        ids = service.replace_space_grants(db, space_id, req.group_ids)
    except Exception as e:
        raise _http(e)
    return SpaceGrantsOut(space_id=space_id, group_ids=ids)


@router.delete("/document-spaces/{space_id}", status_code=204)
def delete_space(space_id: int, db: Session = Depends(get_db),
                 writer=Depends(require_document_admin_writer)):
    try:
        service.delete_space(db, space_id)
    except Exception as e:
        raise _http(e)
    return Response(status_code=204)


# --- documents ----------------------------------------------------------------------------

@router.get("/documents", response_model=DocumentListOut)
def list_documents(q: Optional[str] = None, category_id: Optional[int] = None,
                   statuses: List[str] = Query(default=["draft", "active"], alias="status"),
                   sort: str = "updated_at", page: int = 1, page_size: int = 50,
                   space_id: Optional[int] = None,
                   db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        rows, total = service.list_documents(db, q=q, category_id=category_id,
                                             statuses=tuple(statuses), sort=sort,
                                             page=page, page_size=page_size, space_id=space_id,
                                             visible_spaces=access.visible_space_ids(db, user))
    except Exception as e:
        raise _http(e)
    return DocumentListOut(items=[_doc_out(d, n) for d, n in rows], total=total,
                           page=max(1, page), page_size=max(1, min(200, page_size)))


@router.get("/documents/{doc_id}", response_model=DocumentDetail)
def get_document(doc_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        doc = service.get_document(db, doc_id)
        access.require_view(db, user, doc)
        revisions = service.get_revisions(db, doc.code)
    except Exception as e:
        raise _http(e)
    n = len(revisions)
    out = _doc_out(doc, n)
    return DocumentDetail(**out.model_dump(), revisions=[_doc_out(r, n) for r in revisions])


@router.get("/documents/{doc_id}/content")
def get_document_content(doc_id: int, db: Session = Depends(get_db),
                         user=Depends(get_current_user)):
    try:
        doc = service.get_document(db, doc_id)
        access.require_view(db, user, doc)
        data = service.read_content(doc)
    except Exception as e:
        raise _http(e)
    return Response(content=data, headers={
        "Content-Type": doc.content_type,
        "Content-Disposition": f'inline; filename="{doc.code}-r{doc.revision}.html"',
        "Content-Security-Policy": "sandbox allow-scripts",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=0",
    })


@router.post("/documents", response_model=DocumentOut, status_code=201)
def create_document(req: DocumentCreate, response: Response, db: Session = Depends(get_db),
                    writer=Depends(require_document_writer)):
    try:
        cat = None
        if req.category_id is not None or req.category:
            cat = service.resolve_category(db, category=req.category,
                                           category_id=req.category_id)
        space = None
        if req.space_id is not None or req.space:
            space = service.resolve_space(db, space=req.space, space_id=req.space_id)
        latest = service.latest_revision(db, req.code) if req.code else None
        if latest is not None:
            if not _agent_may_see(writer, latest) or not access.can_view_document(
                    db, _reader_for(writer), latest):
                raise NotFoundError(f"document {req.code!r} not found")
        else:
            target = space if space is not None else service.general_space(db)
            if not agent_may_write(writer, target):
                raise BadRequestError(f"space {target.slug!r} is not allowed for this agent")
        doc, created = service.create_document(
            db, title=req.title, html=req.html, category=cat, description=req.description,
            code=req.code, author=req.author, source_session=req.source_session,
            effective_date=req.effective_date, activate=req.activate,
            user_id=getattr(writer, "id", None),
            co_author=writer.name if isinstance(writer, AgentWriter) else None,
            space=space)
        n = service.revision_count(db, doc.code)
    except Exception as e:
        raise _http(e)
    if created:
        _audit(writer, "create", doc)
    if not created:
        response.status_code = 200
    return _doc_out(doc, n)


@router.patch("/documents/{doc_id}", response_model=DocumentOut)
def patch_document(doc_id: int, req: DocumentPatch, db: Session = Depends(get_db),
                   writer=Depends(require_document_writer)):
    try:
        doc = _gate_write(db, writer, doc_id)
        patch = req.model_dump(exclude_unset=True)
        move_to = patch.pop("space_id", None)
        if move_to is not None:
            if writer is None or isinstance(writer, AgentWriter):
                raise HTTPException(status.HTTP_403_FORBIDDEN,
                                    "only an admin login can move a document between spaces")
            service.move_document_space(db, doc.code, int(move_to), updated_by=writer.email)
            if not patch:
                doc = service.get_document(db, doc_id)
                return _doc_out(doc, service.revision_count(db, doc.code))
        # The actor comes from the credential, never from the request body alone:
        # an admin is their login; an agent is "<who it acted for> via <agent>".
        if isinstance(writer, AgentWriter):
            given = (patch.get("updated_by") or "").strip()[:150]
            patch["updated_by"] = f"{given} via {writer.name}" if given else writer.name
        elif writer is not None:
            patch["updated_by"] = writer.email
        doc = service.patch_document(db, doc_id, **patch)
        n = service.revision_count(db, doc.code)
    except Exception as e:
        raise _http(e)
    _audit(writer, "patch", doc)
    return _doc_out(doc, n)


@router.post("/documents/{doc_id}/activate", response_model=DocumentOut)
def activate_document(doc_id: int, db: Session = Depends(get_db),
                      writer=Depends(require_document_writer)):
    try:
        _gate_write(db, writer, doc_id)
        doc = service.activate_document(db, doc_id)
        n = service.revision_count(db, doc.code)
    except Exception as e:
        raise _http(e)
    _audit(writer, "activate", doc)
    return _doc_out(doc, n)


@router.delete("/documents/{doc_id}")
def delete_document(doc_id: int,
                    code: str = Query(..., description="must match the target's code"),
                    revision: int = Query(..., description="must match the target's revision"),
                    db: Session = Depends(get_db),
                    writer=Depends(require_document_admin_writer)):
    """Discard ONE draft revision. Anything in force is retired, not deleted.
    `code` and `revision` are a required match-check: an agent that guessed the
    id wrong fails closed here instead of destroying a real document."""
    try:
        _gate_write(db, writer, doc_id)
        return service.delete_document(db, doc_id, expect_code=code,
                                       expect_revision=revision)
    except Exception as e:
        raise _http(e)


@router.post("/documents/{doc_id}/retire", response_model=DocumentOut)
def retire_document(doc_id: int, db: Session = Depends(get_db),
                    writer=Depends(require_document_writer)):
    try:
        _gate_write(db, writer, doc_id)
        doc = service.retire_document(db, doc_id)
        n = service.revision_count(db, doc.code)
    except Exception as e:
        raise _http(e)
    _audit(writer, "retire", doc)
    return _doc_out(doc, n)
