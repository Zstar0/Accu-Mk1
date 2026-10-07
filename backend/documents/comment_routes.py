# backend/documents/comment_routes.py
"""Comment routes for the documents library (spec 2026-10-03 §6).

A SEPARATE router from documents.routes so its literal paths
(/documents/comments, /documents/comment-labels, /documents/comment-attachments/…)
can be included BEFORE /documents/{doc_id}; otherwise FastAPI parses the word
"comments" as a document id and answers 422. main.py includes this router first.
"""
from __future__ import annotations

import logging
import re
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import PlainTextResponse
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from auth import get_current_user, require_internal_service_token
from database import get_db
from documents import comment_export, comments, labels, service
from documents.comments import Actor, actor_from_agent, actor_from_user
from documents.routes import _http, _match_agent
from documents.schemas import (CommentAttachmentOut, CommentCreate, CommentIndexOut, CommentLabelOut, CommentListOut,
                               CommentOut, CommentPatch)

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
            return actor_from_agent(agent.name)  # _match_agent returns an AgentWriter (spaces)
        require_internal_service_token(x_service_token)  # 401 when it is not that token either
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "comments need a named author: use an agent token or a login")
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "authentication required")
    return actor_from_user(get_current_user(token=token, db=db))


# --- literal paths FIRST (see module docstring) -----------------------------------------

@router.get("/documents/comment-labels", response_model=List[CommentLabelOut])
def list_comment_labels(user=Depends(get_current_user)):
    return labels.labels_out()


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


# --- single comment by id (literal "comments" segment, declared before /documents/{doc_id}) ---

@router.get("/documents/comments", response_model=CommentIndexOut)
def comments_index(status_filter: str = Query("open", alias="status"),
                   author_agent: Optional[str] = None, code_prefix: Optional[str] = None,
                   limit: int = 100, db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        return {"items": comment_export.list_index(db, status=status_filter, author_agent=author_agent,
                                                   code_prefix=code_prefix, limit=limit)}
    except Exception as e:
        raise _http(e)


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

@router.get("/documents/{doc_id}/comments/export", response_class=PlainTextResponse)
def export_comments(doc_id: int, status_filter: str = Query("open", alias="status"),
                    db: Session = Depends(get_db), user=Depends(get_current_user)):
    try:
        doc = service.get_document(db, doc_id)
        text = comment_export.export_markdown(db, doc.code, status=status_filter)
    except Exception as e:
        raise _http(e)
    return PlainTextResponse(text, media_type="text/markdown; charset=utf-8")


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
