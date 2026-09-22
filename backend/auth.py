"""
Authentication module for Accu-Mk1.
Provides JWT-based user authentication with bcrypt password hashing.

Usage:
    from auth import get_current_user, require_admin, create_access_token
"""

import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from database import get_db

# ── Configuration ─────────────────────────────────────────────

SECRET_KEY = os.environ.get("JWT_SECRET", "dev-secret-change-in-production")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.environ.get("JWT_EXPIRE_MINUTES", 10080))  # Default: 7 days

# Which system an account may reach. Every LIMS endpoint resolves its caller via
# get_current_user, which refuses 'finance'; the Workbench keeps its own allowlist.
SCOPES = ("lab", "finance", "both")
LAB_SCOPES = ("lab", "both")

# ── Password hashing ─────────────────────────────────────────

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(
        plain_password.encode("utf-8"),
        hashed_password.encode("utf-8"),
    )

def get_password_hash(password: str) -> str:
    return bcrypt.hashpw(
        password.encode("utf-8"),
        bcrypt.gensalt(),
    ).decode("utf-8")

# ── JWT tokens ────────────────────────────────────────────────

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def token_claims_for(user) -> dict:
    """Claims for a login token. Accu-Mk1 ignores everything but `sub` (it re-reads
    the DB); the rest lets a federated app (Workbench) verify a request locally."""
    return {
        "sub": str(user.id),
        "email": user.email,
        "scope": user.scope,
        "role": user.role,
        "first_name": user.first_name,
        "last_name": user.last_name,
    }

# ── Pydantic schemas ─────────────────────────────────────────

class UserCreate(BaseModel):
    email: str
    password: str
    role: str = "standard"
    scope: str = "lab"

class UserRead(BaseModel):
    id: int
    email: str
    role: str
    is_active: bool
    created_at: datetime
    senaite_configured: bool = False
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    scope: str = "lab"

    class Config:
        from_attributes = True

class UserUpdate(BaseModel):
    email: Optional[str] = None
    role: Optional[str] = None
    is_active: Optional[bool] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    scope: Optional[str] = None

class MeUpdate(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None

class PasswordChange(BaseModel):
    current_password: str
    new_password: str

class SenaiteCredentials(BaseModel):
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserRead

# ── Dependencies ──────────────────────────────────────────────

def get_current_user_any_scope(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    """Dependency: identity only — any scope. Use ONLY for self-service auth routes
    (/auth/me, change-password, directory). Everything else uses get_current_user."""
    from models import User

    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        sub = payload.get("sub")
        if sub is None:
            raise credentials_exception
        user_id = int(sub)
    except (JWTError, ValueError):
        raise credentials_exception

    user = db.query(User).filter(User.id == user_id).first()
    if user is None or not user.is_active:
        raise credentials_exception

    return user


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    """Dependency: the lab-scoped caller. The single fence for every LIMS endpoint —
    finance-only accounts authenticate but are refused here. Same (token, db)
    signature as before: documents/routes.py calls it directly."""
    user = get_current_user_any_scope(token=token, db=db)
    if user.scope not in LAB_SCOPES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is not authorized for the lab system",
        )
    return user


def require_admin(current_user=Depends(get_current_user)):
    """Dependency: require admin role."""
    if current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return current_user


def require_internal_service_token(
    x_service_token: str = Header(None),
) -> None:
    """Dependency: validate a shared-secret internal service token via X-Service-Token header.

    Used for server-to-server calls from the integration-service (WP bridge). Compares
    against ACCUMK1_INTERNAL_SERVICE_TOKEN using timing-safe comparison.
    """
    expected = os.environ.get("ACCUMK1_INTERNAL_SERVICE_TOKEN")
    if not expected:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "internal service auth not configured",
        )
    if not x_service_token or not secrets.compare_digest(x_service_token, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid service token")


# ── Admin seed ────────────────────────────────────────────────

def seed_admin_user(db: Session):
    """Create default admin user if no users exist."""
    from models import User

    user_count = db.query(User).count()
    if user_count > 0:
        return

    default_email = "admin@accumark.local"
    default_password = secrets.token_urlsafe(12)

    admin = User(
        email=default_email,
        hashed_password=get_password_hash(default_password),
        role="admin",
        is_active=True,
    )
    db.add(admin)
    db.commit()

    print("\n" + "=" * 60)
    print("  FIRST RUN: Default admin account created")
    print(f"  Email:    {default_email}")
    print(f"  Password: {default_password}")
    print("  ** Change this password after first login **")
    print("=" * 60 + "\n")
