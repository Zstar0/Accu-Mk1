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
from sqlalchemy.orm import Session

from auth import get_current_user, require_internal_service_token
from database import get_db
from documents import labels
from documents.comments import Actor, actor_from_agent, actor_from_user
from documents.routes import _http, _match_agent
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


# --- literal paths FIRST (see module docstring) -----------------------------------------

@router.get("/documents/comment-labels", response_model=List[CommentLabelOut])
def list_comment_labels(user=Depends(get_current_user)):
    return labels.labels_out()
