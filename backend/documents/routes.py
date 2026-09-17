"""FastAPI router for the documents library. Thin shell over documents.service."""
from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth import get_current_user, require_admin, require_internal_service_token
from database import get_db
from documents import service
from documents.errors import BadRequestError, ConflictError, NotFoundError
from documents.models import Document, DocumentCategory
from documents.schemas import (CategoryCreate, CategoryOut, CategoryUpdate, DocumentCreate,
                               DocumentDetail, DocumentListOut, DocumentOut, DocumentPatch)
from documents.storage import DocumentNotFound

router = APIRouter(prefix="/api", tags=["documents"])
logger = logging.getLogger(__name__)

_optional_bearer = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False)


def require_document_writer(
    x_service_token: Optional[str] = Header(None),
    token: Optional[str] = Depends(_optional_bearer),
    db: Session = Depends(get_db),
):
    """Writers are an admin login OR the internal service token (spec §5, §9).
    A present X-Service-Token is authoritative: a wrong one is 401 even if a
    bearer is also sent. Returns the admin User, or None for service callers."""
    if x_service_token is not None:
        require_internal_service_token(x_service_token)
        return None
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "authentication required")
    user = get_current_user(token=token, db=db)
    return require_admin(user)


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


def _doc_out(doc: Document, revision_count: int) -> DocumentOut:
    return DocumentOut(
        id=doc.id, code=doc.code, revision=doc.revision, title=doc.title,
        description=doc.description, category_id=doc.category_id,
        category_name=doc.category.name, category_prefix=doc.category.code_prefix,
        status=doc.status, effective_date=doc.effective_date, activated_at=doc.activated_at,
        retired_at=doc.retired_at, supersedes_id=doc.supersedes_id, author=doc.author,
        updated_by=doc.updated_by,
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
                    writer=Depends(require_document_writer)):
    try:
        cat = service.create_category(db, name=req.name, code_prefix=req.code_prefix,
                                      description=req.description, sort_order=req.sort_order)
    except Exception as e:
        raise _http(e)
    return _cat_out(cat, 0)


@router.put("/document-categories/{category_id}", response_model=CategoryOut)
def update_category(category_id: int, req: CategoryUpdate, db: Session = Depends(get_db),
                    writer=Depends(require_document_writer)):
    try:
        cat = service.update_category(db, category_id, **req.model_dump(exclude_unset=True))
        count = dict((c.id, n) for c, n in service.list_categories(db)).get(cat.id, 0)
    except Exception as e:
        raise _http(e)
    return _cat_out(cat, count)


@router.delete("/document-categories/{category_id}", status_code=204)
def delete_category(category_id: int, db: Session = Depends(get_db),
                    writer=Depends(require_document_writer)):
    try:
        service.delete_category(db, category_id)
    except Exception as e:
        raise _http(e)
    return Response(status_code=204)


# --- documents ----------------------------------------------------------------------------

@router.get("/documents", response_model=DocumentListOut)
def list_documents(q: Optional[str] = None, category_id: Optional[int] = None,
                   statuses: List[str] = Query(default=["draft", "active"], alias="status"),
                   sort: str = "updated_at", page: int = 1, page_size: int = 50,
                   db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        rows, total = service.list_documents(db, q=q, category_id=category_id,
                                             statuses=tuple(statuses), sort=sort,
                                             page=page, page_size=page_size)
    except Exception as e:
        raise _http(e)
    return DocumentListOut(items=[_doc_out(d, n) for d, n in rows], total=total,
                           page=max(1, page), page_size=max(1, min(200, page_size)))


@router.get("/documents/{doc_id}", response_model=DocumentDetail)
def get_document(doc_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        doc = service.get_document(db, doc_id)
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
        doc, created = service.create_document(
            db, title=req.title, html=req.html, category=cat, description=req.description,
            code=req.code, author=req.author, source_session=req.source_session,
            effective_date=req.effective_date, activate=req.activate,
            user_id=getattr(writer, "id", None))
        n = service.revision_count(db, doc.code)
    except Exception as e:
        raise _http(e)
    if not created:
        response.status_code = 200
    return _doc_out(doc, n)


@router.patch("/documents/{doc_id}", response_model=DocumentOut)
def patch_document(doc_id: int, req: DocumentPatch, db: Session = Depends(get_db),
                   writer=Depends(require_document_writer)):
    try:
        patch = req.model_dump(exclude_unset=True)
        # A logged-in admin is named by their login, never by the request body.
        if writer is not None:
            patch["updated_by"] = writer.email
        doc = service.patch_document(db, doc_id, **patch)
        n = service.revision_count(db, doc.code)
    except Exception as e:
        raise _http(e)
    return _doc_out(doc, n)


@router.post("/documents/{doc_id}/activate", response_model=DocumentOut)
def activate_document(doc_id: int, db: Session = Depends(get_db),
                      writer=Depends(require_document_writer)):
    try:
        doc = service.activate_document(db, doc_id)
        n = service.revision_count(db, doc.code)
    except Exception as e:
        raise _http(e)
    return _doc_out(doc, n)


@router.post("/documents/{doc_id}/retire", response_model=DocumentOut)
def retire_document(doc_id: int, db: Session = Depends(get_db),
                    writer=Depends(require_document_writer)):
    try:
        doc = service.retire_document(db, doc_id)
        n = service.revision_count(db, doc.code)
    except Exception as e:
        raise _http(e)
    return _doc_out(doc, n)
