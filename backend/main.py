"""
FastAPI backend for Accu-Mk1.
Provides REST API for scientific calculations, database access, and audit logging.
"""

import json
import os
import secrets
import subprocess
import sys
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Optional, Union

from fastapi import FastAPI, Depends, HTTPException, Header, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import select, desc

from database import get_db, init_db
from models import AuditLog, Settings, Job, Sample, Result, Peptide, CalibrationCurve, HPLCAnalysis, User, SharePointFileCache
from auth import (
    get_current_user, require_admin, create_access_token,
    verify_password, get_password_hash, seed_admin_user,
    UserCreate, UserRead, UserUpdate, PasswordChange, TokenResponse,
)
from parsers import parse_txt_file
from parsers.peakdata_csv_parser import parse_hplc_files, calculate_purity
from calculations import CalculationEngine
from calculations.calibration import calculate_calibration_curve
from calculations.hplc_processor import (
    process_hplc_analysis, AnalysisInput, WeightInputs, CalibrationParams, PeptideParams
)
from file_watcher import FileWatcher


# --- API Key Configuration ---

# API key can be set via environment variable, or uses a default for development
# In production, set ACCU_MK1_API_KEY to a secure random value
API_KEY = os.environ.get("ACCU_MK1_API_KEY", "ak_dev_accumark_2024")


async def verify_api_key(x_api_key: Optional[str] = Header(None, alias="X-API-Key")):
    """
    Validate API key from X-API-Key header.
    Returns None if valid, raises HTTPException if invalid.
    """
    if not x_api_key:
        raise HTTPException(
            status_code=401,
            detail="API key required. Add your API key in Settings.",
            headers={"WWW-Authenticate": "API-Key"}
        )
    
    # Constant-time comparison to prevent timing attacks
    if not secrets.compare_digest(x_api_key, API_KEY):
        raise HTTPException(
            status_code=401,
            detail="Invalid API key. Check your API key in Settings.",
            headers={"WWW-Authenticate": "API-Key"}
        )
    
    return x_api_key



# --- Pydantic schemas ---

class HealthResponse(BaseModel):
    """Health check response."""
    status: str
    version: str


class AuditLogCreate(BaseModel):
    """Schema for creating an audit log entry."""
    operation: str
    entity_type: str
    entity_id: Optional[str] = None
    details: Optional[dict] = None


class AuditLogResponse(BaseModel):
    """Schema for audit log response."""
    id: int
    timestamp: datetime
    operation: str
    entity_type: str
    entity_id: Optional[str]
    details: Optional[dict]
    created_at: datetime

    class Config:
        from_attributes = True


class SettingUpdate(BaseModel):
    """Schema for updating a setting."""
    value: str


class SettingResponse(BaseModel):
    """Schema for setting response."""
    id: int
    key: str
    value: str
    updated_at: datetime

    class Config:
        from_attributes = True


# --- Import schemas ---

class ParsePreviewResponse(BaseModel):
    """Schema for file parse preview response."""
    filename: str
    headers: list[str]
    rows: list[dict[str, Union[str, int, float, None]]]
    row_count: int
    errors: list[str]


class BatchImportRequest(BaseModel):
    """Schema for batch import request."""
    file_paths: list[str]


class FileData(BaseModel):
    """Schema for file data from browser."""
    filename: str
    headers: list[str]
    rows: list[dict[str, Union[str, int, float, None]]]
    row_count: int


class BatchImportDataRequest(BaseModel):
    """Schema for batch import with pre-parsed data from browser."""
    files: list[FileData]


class SampleSummary(BaseModel):
    """Summary of a created sample."""
    id: int
    filename: str
    row_count: int


class ImportResultResponse(BaseModel):
    """Schema for batch import result response."""
    job_id: int
    samples_created: int
    samples: list[SampleSummary]
    errors: list[str]


class JobResponse(BaseModel):
    """Schema for job response."""
    id: int
    status: str
    source_directory: Optional[str]
    created_at: datetime
    completed_at: Optional[datetime]

    class Config:
        from_attributes = True


class SampleResponse(BaseModel):
    """Schema for sample response."""
    id: int
    job_id: int
    filename: str
    status: str
    input_data: Optional[dict]
    rejection_reason: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class RejectRequest(BaseModel):
    """Schema for sample rejection request."""
    reason: str


# --- Calculation schemas ---

class CalculationResultResponse(BaseModel):
    """Schema for a single calculation result."""
    calculation_type: str
    input_summary: dict
    output_values: dict
    warnings: list[str]
    success: bool
    error: Optional[str] = None


class CalculationSummaryResponse(BaseModel):
    """Schema for calculation summary response."""
    sample_id: int
    results: list[CalculationResultResponse]
    total_calculations: int
    successful: int
    failed: int


class CalculationPreviewRequest(BaseModel):
    """Schema for calculation preview request."""
    data: dict
    calculation_type: str


class ResultResponse(BaseModel):
    """Schema for stored result response."""
    id: int
    sample_id: int
    calculation_type: str
    input_data: Optional[dict]
    output_data: Optional[dict]
    created_at: datetime

    class Config:
        from_attributes = True


class SampleWithResultsResponse(BaseModel):
    """Schema for sample with calculated results flattened for UI."""
    id: int
    job_id: int
    filename: str
    status: str
    rejection_reason: Optional[str] = None
    created_at: datetime
    # Flattened calculation results for easy UI consumption
    purity: Optional[float] = None
    retention_time: Optional[float] = None
    compound_id: Optional[str] = None
    has_results: bool = False

    class Config:
        from_attributes = True


# --- Default settings ---

DEFAULT_SETTINGS = {
    "report_directory": "",
    "column_mappings": '{"peak_area": "Area", "retention_time": "RT", "compound_name": "Name"}',
    "compound_ranges": '{}',
    "calibration_slope": "1.0",
    "calibration_intercept": "0.0",
}


# --- App lifecycle ---

def seed_default_settings(db: Session):
    """Seed default settings if they don't exist."""
    for key, value in DEFAULT_SETTINGS.items():
        existing = db.execute(select(Settings).where(Settings.key == key)).scalar_one_or_none()
        if not existing:
            setting = Settings(key=key, value=value)
            db.add(setting)
    db.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize database on startup and seed defaults."""
    init_db()
    # Seed default settings and admin user
    from database import SessionLocal
    db = SessionLocal()
    try:
        seed_default_settings(db)
        seed_admin_user(db)
    finally:
        db.close()
    yield


# --- FastAPI app ---

app = FastAPI(
    title="Accu-Mk1 Backend",
    description="Backend API for lab purity calculations and SENAITE integration",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS configuration for browser and Tauri frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:1420",      # Tauri dev server
        "http://127.0.0.1:1420",
        "http://localhost:5173",      # Vite default
        "http://127.0.0.1:5173",
        "http://localhost:3100",      # Docker local test
        "http://127.0.0.1:3100",
        "https://accumk1.valenceanalytical.com",  # Production
        "tauri://localhost",          # Tauri production (v1)
        "https://tauri.localhost",    # Tauri production (v2)
        "http://tauri.localhost",     # Tauri production fallback
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global file watcher instance
file_watcher = FileWatcher()


# --- Endpoints ---

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint to verify backend is running."""
    return HealthResponse(status="ok", version="0.1.0")


# --- Auth Endpoints ---

@app.post("/auth/login", response_model=TokenResponse)
async def login(
    form_data: UserCreate,
    db: Session = Depends(get_db),
):
    """Authenticate user and return JWT access token."""
    user = db.query(User).filter(User.email == form_data.email).first()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Account is deactivated",
        )

    access_token = create_access_token(data={"sub": str(user.id)})
    return TokenResponse(
        access_token=access_token,
        user=UserRead.model_validate(user),
    )


@app.get("/auth/me", response_model=UserRead)
async def get_me(current_user=Depends(get_current_user)):
    """Get current authenticated user info."""
    return UserRead.model_validate(current_user)


@app.put("/auth/change-password")
async def change_password(
    data: PasswordChange,
    current_user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Change current user's password (requires current password)."""
    if not verify_password(data.current_password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="Current password is incorrect")

    if len(data.new_password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")

    current_user.hashed_password = get_password_hash(data.new_password)
    db.commit()
    return {"message": "Password changed successfully"}


# --- Admin User Management ---

@app.get("/auth/users", response_model=list[UserRead])
async def list_users(
    admin=Depends(require_admin),
    db: Session = Depends(get_db),
):
    """List all users (admin only)."""
    users = db.query(User).order_by(User.created_at.desc()).all()
    return [UserRead.model_validate(u) for u in users]


@app.post("/auth/users", response_model=UserRead)
async def create_user(
    data: UserCreate,
    admin=Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Create a new user (admin only)."""
    existing = db.query(User).filter(User.email == data.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    if data.role not in ("standard", "admin"):
        raise HTTPException(status_code=400, detail="Role must be 'standard' or 'admin'")

    if len(data.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")

    user = User(
        email=data.email,
        hashed_password=get_password_hash(data.password),
        role=data.role,
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return UserRead.model_validate(user)


@app.put("/auth/users/{user_id}", response_model=UserRead)
async def update_user(
    user_id: int,
    data: UserUpdate,
    admin=Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Update a user (admin only). Can change role and active status."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if data.role is not None:
        if data.role not in ("standard", "admin"):
            raise HTTPException(status_code=400, detail="Role must be 'standard' or 'admin'")
        user.role = data.role

    if data.is_active is not None:
        user.is_active = data.is_active

    if data.email is not None:
        existing = db.query(User).filter(User.email == data.email, User.id != user_id).first()
        if existing:
            raise HTTPException(status_code=400, detail="Email already in use")
        user.email = data.email

    db.commit()
    db.refresh(user)
    return UserRead.model_validate(user)


@app.post("/auth/users/{user_id}/reset-password")
async def admin_reset_password(
    user_id: int,
    admin=Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Reset a user's password (admin only). Returns temporary password."""
    import secrets as _secrets

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    temp_password = _secrets.token_urlsafe(12)
    user.hashed_password = get_password_hash(temp_password)
    db.commit()

    print(f"\n[ADMIN RESET] Password reset for {user.email}: {temp_password}\n")

    return {
        "message": f"Password reset for {user.email}",
        "temporary_password": temp_password,
    }


@app.post("/audit", response_model=AuditLogResponse)
async def create_audit_log(
    audit_data: AuditLogCreate,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Create a new audit log entry."""
    audit_log = AuditLog(
        operation=audit_data.operation,
        entity_type=audit_data.entity_type,
        entity_id=audit_data.entity_id,
        details=audit_data.details,
    )
    db.add(audit_log)
    db.commit()
    db.refresh(audit_log)
    return audit_log


@app.get("/audit", response_model=list[AuditLogResponse])
async def get_audit_logs(
    limit: int = 50,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Get recent audit log entries."""
    stmt = select(AuditLog).order_by(desc(AuditLog.created_at)).limit(limit)
    result = db.execute(stmt)
    return result.scalars().all()


# --- Settings Endpoints ---

@app.get("/settings", response_model=list[SettingResponse])
async def get_settings(db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    """Get all settings."""
    stmt = select(Settings).order_by(Settings.key)
    result = db.execute(stmt)
    return result.scalars().all()


@app.get("/settings/{key}", response_model=SettingResponse)
async def get_setting(key: str, db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    """Get a single setting by key."""
    stmt = select(Settings).where(Settings.key == key)
    setting = db.execute(stmt).scalar_one_or_none()
    if not setting:
        raise HTTPException(status_code=404, detail=f"Setting '{key}' not found")
    return setting


@app.put("/settings/{key}", response_model=SettingResponse)
async def update_setting(
    key: str,
    data: SettingUpdate,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Create or update a setting by key."""
    stmt = select(Settings).where(Settings.key == key)
    setting = db.execute(stmt).scalar_one_or_none()

    if setting:
        # Update existing
        setting.value = data.value
    else:
        # Create new
        setting = Settings(key=key, value=data.value)
        db.add(setting)

    db.commit()
    db.refresh(setting)
    return setting


@app.delete("/settings/{key}")
async def delete_setting(key: str, db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    """Delete a setting by key."""
    stmt = select(Settings).where(Settings.key == key)
    setting = db.execute(stmt).scalar_one_or_none()
    if not setting:
        raise HTTPException(status_code=404, detail=f"Setting '{key}' not found")

    db.delete(setting)
    db.commit()
    return {"message": f"Setting '{key}' deleted"}


# --- File Watcher Endpoints ---

@app.get("/watcher/status")
async def get_watcher_status(_current_user=Depends(get_current_user)):
    """Get file watcher status."""
    return file_watcher.status()


@app.post("/watcher/start")
async def start_watcher(db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    """Start file watcher using report_directory from settings."""
    # Get report_directory from settings
    setting = db.execute(
        select(Settings).where(Settings.key == "report_directory")
    ).scalar_one_or_none()
    if not setting or not setting.value:
        raise HTTPException(400, "report_directory not configured")

    if not os.path.isdir(setting.value):
        raise HTTPException(400, f"Directory does not exist: {setting.value}")

    file_watcher.start(setting.value)
    return {"status": "started", "watching": setting.value}


@app.post("/watcher/stop")
async def stop_watcher(_current_user=Depends(get_current_user)):
    """Stop file watcher."""
    file_watcher.stop()
    return {"status": "stopped"}


@app.get("/watcher/files")
async def get_detected_files(_current_user=Depends(get_current_user)):
    """Get and clear list of detected files."""
    files = file_watcher.get_detected_files()
    return {"files": files, "count": len(files)}


# --- Import Endpoints ---

def _get_column_mappings(db: Session) -> dict:
    """Get column mappings from settings."""
    stmt = select(Settings).where(Settings.key == "column_mappings")
    setting = db.execute(stmt).scalar_one_or_none()
    if setting and setting.value:
        try:
            return json.loads(setting.value)
        except json.JSONDecodeError:
            return {}
    return {}


@app.post("/import/file", response_model=ParsePreviewResponse)
async def import_file_preview(
    file_path: str,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """
    Preview a single file parse without saving.

    Returns the first rows of parsed data for user review.
    """
    column_mappings = _get_column_mappings(db)
    result = parse_txt_file(file_path, column_mappings)

    # Limit preview to first 10 rows
    preview_rows = result.rows[:10]

    return ParsePreviewResponse(
        filename=result.filename,
        headers=result.raw_headers,
        rows=preview_rows,
        row_count=result.row_count,
        errors=result.errors,
    )


@app.post("/import/batch", response_model=ImportResultResponse)
async def import_batch(
    request: BatchImportRequest,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """
    Import multiple files and create a job with samples.

    Creates:
    - One Job record for the batch
    - One Sample record per file with parsed data stored in input_data
    """
    errors: list[str] = []
    samples: list[SampleSummary] = []
    column_mappings = _get_column_mappings(db)

    # Determine source directory from first file
    source_dir = None
    if request.file_paths:
        first_path = Path(request.file_paths[0])
        source_dir = str(first_path.parent) if first_path.parent else None

    # Create Job
    job = Job(
        status="pending",
        source_directory=source_dir,
    )
    db.add(job)
    db.flush()  # Get job.id without committing

    # Create audit log for job creation
    audit_log = AuditLog(
        operation="create",
        entity_type="job",
        entity_id=str(job.id),
        details={"file_count": len(request.file_paths)},
    )
    db.add(audit_log)

    # Process each file
    for file_path in request.file_paths:
        result = parse_txt_file(file_path, column_mappings)

        if result.errors:
            # Include file-specific errors in response
            for error in result.errors:
                errors.append(f"{result.filename}: {error}")

        # Create Sample with parsed data
        sample = Sample(
            job_id=job.id,
            filename=result.filename,
            status="pending" if not result.errors else "error",
            input_data={
                "rows": result.rows,
                "headers": result.raw_headers,
                "row_count": result.row_count,
            },
        )
        db.add(sample)
        db.flush()

        samples.append(SampleSummary(
            id=sample.id,
            filename=result.filename,
            row_count=result.row_count,
        ))

        # Create audit log for sample creation
        sample_audit = AuditLog(
            operation="create",
            entity_type="sample",
            entity_id=str(sample.id),
            details={
                "job_id": job.id,
                "filename": result.filename,
                "row_count": result.row_count,
            },
        )
        db.add(sample_audit)

    # Update job status based on results
    if errors:
        job.status = "completed_with_errors"
    else:
        job.status = "imported"

    db.commit()

    return ImportResultResponse(
        job_id=job.id,
        samples_created=len(samples),
        samples=samples,
        errors=errors,
    )


@app.post("/import/batch-data", response_model=ImportResultResponse)
async def import_batch_data(
    request: BatchImportDataRequest,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """
    Import pre-parsed file data from browser.

    This endpoint accepts already-parsed data from the frontend,
    useful when files are selected via browser file input (no file path access).
    """
    errors: list[str] = []
    samples: list[SampleSummary] = []

    # Create Job
    job = Job(
        status="pending",
        source_directory="browser-upload",
    )
    db.add(job)
    db.flush()

    # Create audit log for job creation
    audit_log = AuditLog(
        operation="create",
        entity_type="job",
        entity_id=str(job.id),
        details={"file_count": len(request.files), "source": "browser-upload"},
    )
    db.add(audit_log)

    # Process each file's data
    for file_data in request.files:
        # Create Sample with parsed data
        sample = Sample(
            job_id=job.id,
            filename=file_data.filename,
            status="pending",
            input_data={
                "rows": file_data.rows,
                "headers": file_data.headers,
                "row_count": file_data.row_count,
            },
        )
        db.add(sample)
        db.flush()

        samples.append(SampleSummary(
            id=sample.id,
            filename=file_data.filename,
            row_count=file_data.row_count,
        ))

        # Create audit log for sample creation
        sample_audit = AuditLog(
            operation="create",
            entity_type="sample",
            entity_id=str(sample.id),
            details={
                "job_id": job.id,
                "filename": file_data.filename,
                "row_count": file_data.row_count,
            },
        )
        db.add(sample_audit)

    # Update job status
    job.status = "imported"
    db.commit()

    return ImportResultResponse(
        job_id=job.id,
        samples_created=len(samples),
        samples=samples,
        errors=errors,
    )


# --- Job and Sample Endpoints ---

@app.get("/jobs", response_model=list[JobResponse])
async def get_jobs(
    limit: int = 50,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Get recent jobs."""
    stmt = select(Job).order_by(desc(Job.created_at)).limit(limit)
    result = db.execute(stmt)
    return result.scalars().all()


@app.get("/jobs/{job_id}", response_model=JobResponse)
async def get_job(job_id: int, db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    """Get a single job by ID."""
    stmt = select(Job).where(Job.id == job_id)
    job = db.execute(stmt).scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    return job


@app.get("/jobs/{job_id}/samples", response_model=list[SampleResponse])
async def get_job_samples(job_id: int, db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    """Get all samples for a job."""
    stmt = select(Sample).where(Sample.job_id == job_id).order_by(Sample.id)
    result = db.execute(stmt)
    return result.scalars().all()


@app.get("/jobs/{job_id}/samples-with-results", response_model=list[SampleWithResultsResponse])
async def get_job_samples_with_results(job_id: int, db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    """
    Get all samples for a job with their calculation results flattened.

    Returns samples with key calculation values (purity, retention_time, compound_id)
    extracted from Result records for easy UI consumption in batch review tables.
    """
    # Verify job exists
    job_stmt = select(Job).where(Job.id == job_id)
    job = db.execute(job_stmt).scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")

    # Get all samples for the job
    stmt = select(Sample).where(Sample.job_id == job_id).order_by(Sample.id)
    samples = db.execute(stmt).scalars().all()

    # Build response with flattened results
    response: list[SampleWithResultsResponse] = []
    for sample in samples:
        # Get the most recent purity result for this sample
        result_stmt = (
            select(Result)
            .where(Result.sample_id == sample.id)
            .where(Result.calculation_type == "purity")
            .order_by(desc(Result.created_at))
            .limit(1)
        )
        purity_result = db.execute(result_stmt).scalar_one_or_none()

        # Extract values from result output_data
        purity: Optional[float] = None
        retention_time: Optional[float] = None
        compound_id: Optional[str] = None
        has_results = False

        if purity_result and purity_result.output_data:
            has_results = True
            values = purity_result.output_data.get("values", {})
            # Extract purity percentage
            if "purity_percent" in values:
                purity = values["purity_percent"]
            # Extract matched compound info
            if "matched_compound" in values:
                compound_id = values["matched_compound"]
            if "retention_time" in values:
                retention_time = values["retention_time"]

        response.append(SampleWithResultsResponse(
            id=sample.id,
            job_id=sample.job_id,
            filename=sample.filename,
            status=sample.status,
            rejection_reason=sample.rejection_reason,
            created_at=sample.created_at,
            purity=purity,
            retention_time=retention_time,
            compound_id=compound_id,
            has_results=has_results,
        ))

    return response


@app.get("/samples", response_model=list[SampleResponse])
async def get_samples(
    limit: int = 50,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Get recent samples."""
    stmt = select(Sample).order_by(desc(Sample.created_at)).limit(limit)
    result = db.execute(stmt)
    return result.scalars().all()


@app.get("/samples/{sample_id}", response_model=SampleResponse)
async def get_sample(sample_id: int, db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    """Get a single sample by ID."""
    stmt = select(Sample).where(Sample.id == sample_id)
    sample = db.execute(stmt).scalar_one_or_none()
    if not sample:
        raise HTTPException(status_code=404, detail=f"Sample {sample_id} not found")
    return sample


@app.put("/samples/{sample_id}/approve", response_model=SampleResponse)
async def approve_sample(sample_id: int, db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    """
    Approve a sample.

    Sets status to 'approved' and clears any rejection reason.
    Creates an audit log entry.
    """
    stmt = select(Sample).where(Sample.id == sample_id)
    sample = db.execute(stmt).scalar_one_or_none()
    if not sample:
        raise HTTPException(status_code=404, detail=f"Sample {sample_id} not found")

    old_status = sample.status
    sample.status = "approved"
    sample.rejection_reason = None

    # Create audit log
    audit = AuditLog(
        operation="approve",
        entity_type="sample",
        entity_id=str(sample_id),
        details={"old_status": old_status, "new_status": "approved"},
    )
    db.add(audit)
    db.commit()
    db.refresh(sample)

    return sample


@app.put("/samples/{sample_id}/reject", response_model=SampleResponse)
async def reject_sample(
    sample_id: int,
    request: RejectRequest,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """
    Reject a sample with a reason.

    Sets status to 'rejected' and stores the rejection reason.
    Creates an audit log entry.
    """
    stmt = select(Sample).where(Sample.id == sample_id)
    sample = db.execute(stmt).scalar_one_or_none()
    if not sample:
        raise HTTPException(status_code=404, detail=f"Sample {sample_id} not found")

    old_status = sample.status
    sample.status = "rejected"
    sample.rejection_reason = request.reason

    # Create audit log
    audit = AuditLog(
        operation="reject",
        entity_type="sample",
        entity_id=str(sample_id),
        details={
            "old_status": old_status,
            "new_status": "rejected",
            "reason": request.reason,
        },
    )
    db.add(audit)
    db.commit()
    db.refresh(sample)

    return sample


# --- Calculation Endpoints ---

def _get_calculation_settings(db: Session) -> dict:
    """Load all settings relevant to calculations as a dict."""
    stmt = select(Settings)
    settings = db.execute(stmt).scalars().all()
    return {s.key: s.value for s in settings}


@app.get("/calculations/types", response_model=list[str])
async def get_calculation_types(_current_user=Depends(get_current_user)):
    """Get list of available calculation types."""
    return CalculationEngine.get_available_types()


@app.post("/calculate/{sample_id}", response_model=CalculationSummaryResponse)
async def calculate_sample(
    sample_id: int,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """
    Run all applicable calculations for a sample.

    Loads sample data, runs calculations based on settings,
    stores results in Result table, and returns summary.
    """
    # Load sample
    stmt = select(Sample).where(Sample.id == sample_id)
    sample = db.execute(stmt).scalar_one_or_none()
    if not sample:
        raise HTTPException(status_code=404, detail=f"Sample {sample_id} not found")

    if not sample.input_data:
        raise HTTPException(
            status_code=400,
            detail=f"Sample {sample_id} has no input data"
        )

    # Load settings
    settings = _get_calculation_settings(db)

    # Create engine and run calculations
    engine = CalculationEngine(settings)
    calc_results = engine.calculate_all(sample.input_data)

    # Store results and create audit logs
    stored_results: list[CalculationResultResponse] = []
    for calc_result in calc_results:
        # Create Result record
        result = Result(
            sample_id=sample_id,
            calculation_type=calc_result.calculation_type,
            input_data=calc_result.input_summary,
            output_data={
                "values": calc_result.output_values,
                "warnings": calc_result.warnings,
                "success": calc_result.success,
                "error": calc_result.error,
            },
        )
        db.add(result)
        db.flush()

        # Create audit log
        audit = AuditLog(
            operation="calculate",
            entity_type="result",
            entity_id=str(result.id),
            details={
                "sample_id": sample_id,
                "calculation_type": calc_result.calculation_type,
                "success": calc_result.success,
            },
        )
        db.add(audit)

        stored_results.append(CalculationResultResponse(
            calculation_type=calc_result.calculation_type,
            input_summary=calc_result.input_summary,
            output_values=calc_result.output_values,
            warnings=calc_result.warnings,
            success=calc_result.success,
            error=calc_result.error,
        ))

    # Update sample status
    sample.status = "calculated"
    db.commit()

    successful = sum(1 for r in stored_results if r.success)
    failed = len(stored_results) - successful

    return CalculationSummaryResponse(
        sample_id=sample_id,
        results=stored_results,
        total_calculations=len(stored_results),
        successful=successful,
        failed=failed,
    )


@app.post("/calculate/preview", response_model=CalculationResultResponse)
async def preview_calculation(
    request: CalculationPreviewRequest,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """
    Run a calculation without saving (for testing/preview).

    Useful for testing formulas with custom data before applying to samples.
    """
    settings = _get_calculation_settings(db)
    engine = CalculationEngine(settings)

    try:
        result = engine.calculate(request.data, request.calculation_type)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return CalculationResultResponse(
        calculation_type=result.calculation_type,
        input_summary=result.input_summary,
        output_values=result.output_values,
        warnings=result.warnings,
        success=result.success,
        error=result.error,
    )


@app.get("/samples/{sample_id}/results", response_model=list[ResultResponse])
async def get_sample_results(
    sample_id: int,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Get all calculation results for a sample."""
    # Verify sample exists
    stmt = select(Sample).where(Sample.id == sample_id)
    sample = db.execute(stmt).scalar_one_or_none()
    if not sample:
        raise HTTPException(status_code=404, detail=f"Sample {sample_id} not found")

    stmt = select(Result).where(Result.sample_id == sample_id).order_by(Result.created_at)
    results = db.execute(stmt).scalars().all()
    return results


# --- HPLC Analysis Endpoints ---

class HPLCFileInput(BaseModel):
    """A single file's content for HPLC parsing."""
    filename: str
    content: str


class HPLCParseBrowserRequest(BaseModel):
    """Request to parse HPLC PeakData files from browser upload."""
    files: list[HPLCFileInput]


class PeakResponse(BaseModel):
    """Response for a single chromatographic peak."""
    height: float
    area: float
    area_percent: float
    begin_time: float
    end_time: float
    retention_time: float
    is_solvent_front: bool
    is_main_peak: bool


class InjectionResponse(BaseModel):
    """Response for one injection's parsed data."""
    injection_name: str
    peaks: list[PeakResponse]
    total_area: float
    main_peak_index: int


class PurityResponse(BaseModel):
    """Purity calculation result."""
    purity_percent: Optional[float]
    individual_values: list[float]
    injection_names: list[str]
    rsd_percent: Optional[float]
    error: Optional[str] = None


class HPLCParseResponse(BaseModel):
    """Response from parsing HPLC files."""
    injections: list[InjectionResponse]
    purity: PurityResponse
    errors: list[str]


@app.post("/hplc/parse-files", response_model=HPLCParseResponse)
async def parse_hplc_peakdata(request: HPLCParseBrowserRequest, _current_user=Depends(get_current_user)):
    """
    Parse HPLC PeakData CSV files and calculate purity.

    Accepts file contents from browser upload, parses peak tables,
    identifies main peaks (excluding solvent front), and averages
    Area% across injections for purity calculation.
    """
    files_data = [{"filename": f.filename, "content": f.content} for f in request.files]
    result = parse_hplc_files(files_data)

    # Calculate purity from parsed injections
    purity = calculate_purity(result.injections)

    # Build response
    injections_resp = []
    for inj in result.injections:
        peaks_resp = [
            PeakResponse(
                height=p.height,
                area=p.area,
                area_percent=p.area_percent,
                begin_time=p.begin_time,
                end_time=p.end_time,
                retention_time=p.retention_time,
                is_solvent_front=p.is_solvent_front,
                is_main_peak=p.is_main_peak,
            )
            for p in inj.peaks
        ]
        injections_resp.append(InjectionResponse(
            injection_name=inj.injection_name,
            peaks=peaks_resp,
            total_area=inj.total_area,
            main_peak_index=inj.main_peak_index,
        ))

    return HPLCParseResponse(
        injections=injections_resp,
        purity=PurityResponse(**purity),
        errors=result.errors,
    )


# --- Peptide & Calibration Endpoints ---

class PeptideCreate(BaseModel):
    """Schema for creating a peptide."""
    name: str
    abbreviation: str
    reference_rt: Optional[float] = None
    rt_tolerance: float = 0.5
    diluent_density: float = 997.1


class PeptideUpdate(BaseModel):
    """Schema for updating a peptide."""
    name: Optional[str] = None
    abbreviation: Optional[str] = None
    reference_rt: Optional[float] = None
    rt_tolerance: Optional[float] = None
    diluent_density: Optional[float] = None
    active: Optional[bool] = None


class CalibrationCurveResponse(BaseModel):
    """Schema for calibration curve response."""
    id: int
    peptide_id: int
    slope: float
    intercept: float
    r_squared: float
    standard_data: Optional[dict]
    source_filename: Optional[str]
    source_path: Optional[str] = None
    source_date: Optional[datetime] = None
    sharepoint_url: Optional[str] = None
    is_active: bool
    created_at: datetime

    class Config:
        from_attributes = True


class PeptideResponse(BaseModel):
    """Schema for peptide response."""
    id: int
    name: str
    abbreviation: str
    reference_rt: Optional[float]
    rt_tolerance: float
    diluent_density: float
    active: bool
    created_at: datetime
    updated_at: datetime
    active_calibration: Optional[CalibrationCurveResponse] = None

    class Config:
        from_attributes = True


class CalibrationDataInput(BaseModel):
    """Schema for manual calibration data entry."""
    concentrations: list[float]
    areas: list[float]
    source_filename: Optional[str] = None


def _cal_to_response(cal: CalibrationCurve) -> CalibrationCurveResponse:
    """Convert CalibrationCurve model to response with SharePoint URL."""
    resp = CalibrationCurveResponse.model_validate(cal)
    # Prefer stored webUrl from Graph API; fall back to computed URL for legacy records
    if cal.sharepoint_url:
        resp.sharepoint_url = cal.sharepoint_url
    elif cal.source_path:
        from sharepoint import get_sharepoint_file_url
        resp.sharepoint_url = get_sharepoint_file_url(cal.source_path)
    return resp


def _get_active_calibration(db: Session, peptide_id: int) -> Optional[CalibrationCurveResponse]:
    """Get the active calibration curve for a peptide."""
    stmt = (
        select(CalibrationCurve)
        .where(CalibrationCurve.peptide_id == peptide_id)
        .where(CalibrationCurve.is_active == True)
        .order_by(desc(CalibrationCurve.created_at))
        .limit(1)
    )
    cal = db.execute(stmt).scalar_one_or_none()
    if cal:
        return _cal_to_response(cal)
    return None


def _peptide_to_response(db: Session, peptide: Peptide) -> PeptideResponse:
    """Convert Peptide model to response with active calibration."""
    resp = PeptideResponse.model_validate(peptide)
    resp.active_calibration = _get_active_calibration(db, peptide.id)
    return resp


@app.get("/peptides", response_model=list[PeptideResponse])
async def get_peptides(db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    """Get all peptides with their active calibration curves."""
    stmt = select(Peptide).order_by(Peptide.abbreviation)
    peptides = db.execute(stmt).scalars().all()
    return [_peptide_to_response(db, p) for p in peptides]


@app.post("/peptides", response_model=PeptideResponse, status_code=201)
async def create_peptide(data: PeptideCreate, db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    """Create a new peptide."""
    # Check uniqueness
    existing = db.execute(
        select(Peptide).where(Peptide.abbreviation == data.abbreviation)
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(400, f"Peptide with abbreviation '{data.abbreviation}' already exists")

    peptide = Peptide(
        name=data.name,
        abbreviation=data.abbreviation,
        reference_rt=data.reference_rt,
        rt_tolerance=data.rt_tolerance,
        diluent_density=data.diluent_density,
    )
    db.add(peptide)
    db.commit()
    db.refresh(peptide)
    return _peptide_to_response(db, peptide)


@app.put("/peptides/{peptide_id}", response_model=PeptideResponse)
async def update_peptide(peptide_id: int, data: PeptideUpdate, db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    """Update a peptide."""
    peptide = db.execute(select(Peptide).where(Peptide.id == peptide_id)).scalar_one_or_none()
    if not peptide:
        raise HTTPException(404, f"Peptide {peptide_id} not found")

    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(peptide, field, value)

    db.commit()
    db.refresh(peptide)
    return _peptide_to_response(db, peptide)


@app.delete("/peptides/{peptide_id}")
async def delete_peptide(peptide_id: int, db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    """Delete a peptide and all its calibration curves."""
    peptide = db.execute(select(Peptide).where(Peptide.id == peptide_id)).scalar_one_or_none()
    if not peptide:
        raise HTTPException(404, f"Peptide {peptide_id} not found")

    db.delete(peptide)
    db.commit()
    return {"message": f"Peptide '{peptide.abbreviation}' deleted"}


@app.get("/peptides/{peptide_id}/calibrations", response_model=list[CalibrationCurveResponse])
async def get_calibrations(peptide_id: int, db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    """Get all calibration curves for a peptide (newest first)."""
    peptide = db.execute(select(Peptide).where(Peptide.id == peptide_id)).scalar_one_or_none()
    if not peptide:
        raise HTTPException(404, f"Peptide {peptide_id} not found")

    stmt = (
        select(CalibrationCurve)
        .where(CalibrationCurve.peptide_id == peptide_id)
        .order_by(desc(CalibrationCurve.created_at))
    )
    cals = db.execute(stmt).scalars().all()
    return [_cal_to_response(c) for c in cals]


@app.post("/peptides/{peptide_id}/calibrations", response_model=CalibrationCurveResponse, status_code=201)
async def create_calibration(
    peptide_id: int,
    data: CalibrationDataInput,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """
    Create a calibration curve from concentration/area pairs.

    Calculates linear regression and stores the curve.
    Automatically sets this as the active calibration for the peptide.
    """
    peptide = db.execute(select(Peptide).where(Peptide.id == peptide_id)).scalar_one_or_none()
    if not peptide:
        raise HTTPException(404, f"Peptide {peptide_id} not found")

    try:
        regression = calculate_calibration_curve(data.concentrations, data.areas)
    except ValueError as e:
        raise HTTPException(400, str(e))

    # Deactivate existing active curves
    active_cals = db.execute(
        select(CalibrationCurve)
        .where(CalibrationCurve.peptide_id == peptide_id)
        .where(CalibrationCurve.is_active == True)
    ).scalars().all()
    for cal in active_cals:
        cal.is_active = False

    # Create new active curve
    curve = CalibrationCurve(
        peptide_id=peptide_id,
        slope=regression["slope"],
        intercept=regression["intercept"],
        r_squared=regression["r_squared"],
        standard_data={
            "concentrations": data.concentrations,
            "areas": data.areas,
        },
        source_filename=data.source_filename,
        is_active=True,
    )
    db.add(curve)
    db.commit()
    db.refresh(curve)
    return curve


@app.post("/peptides/{peptide_id}/calibrations/{calibration_id}/activate", response_model=CalibrationCurveResponse)
async def activate_calibration(
    peptide_id: int,
    calibration_id: int,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """
    Set a specific calibration curve as the active one for a peptide.
    Deactivates all other curves for that peptide.
    """
    peptide = db.execute(select(Peptide).where(Peptide.id == peptide_id)).scalar_one_or_none()
    if not peptide:
        raise HTTPException(404, f"Peptide {peptide_id} not found")

    target = db.execute(
        select(CalibrationCurve)
        .where(CalibrationCurve.id == calibration_id)
        .where(CalibrationCurve.peptide_id == peptide_id)
    ).scalar_one_or_none()
    if not target:
        raise HTTPException(404, f"Calibration {calibration_id} not found for peptide {peptide_id}")

    # Deactivate all curves for this peptide
    all_cals = db.execute(
        select(CalibrationCurve).where(CalibrationCurve.peptide_id == peptide_id)
    ).scalars().all()
    for cal in all_cals:
        cal.is_active = False

    # Activate the target
    target.is_active = True

    # Update peptide's reference RT from this curve's RT data
    if target.standard_data and target.standard_data.get("rts"):
        rts = target.standard_data["rts"]
        if rts:
            peptide.reference_rt = round(sum(rts) / len(rts), 4)

    db.commit()
    db.refresh(target)
    return _cal_to_response(target)


# --- Full HPLC Analysis Endpoint ---

class HPLCWeightsInput(BaseModel):
    """Five balance weights from the tech."""
    stock_vial_empty: float
    stock_vial_with_diluent: float
    dil_vial_empty: float
    dil_vial_with_diluent: float
    dil_vial_with_diluent_and_sample: float


class HPLCAnalyzeRequest(BaseModel):
    """Request to run a full HPLC analysis."""
    sample_id_label: str
    peptide_id: int
    weights: HPLCWeightsInput
    injections: list[dict]  # Parsed injection data from /hplc/parse-files


class HPLCAnalysisResponse(BaseModel):
    """Full analysis result."""
    id: int
    sample_id_label: str
    peptide_id: int
    peptide_abbreviation: str
    purity_percent: Optional[float]
    quantity_mg: Optional[float]
    identity_conforms: Optional[bool]
    identity_rt_delta: Optional[float]
    dilution_factor: Optional[float]
    stock_volume_ml: Optional[float]
    avg_main_peak_area: Optional[float]
    concentration_ug_ml: Optional[float]
    calculation_trace: Optional[dict]
    created_at: datetime


@app.post("/hplc/analyze", response_model=HPLCAnalysisResponse, status_code=201)
async def run_hplc_analysis(
    request: HPLCAnalyzeRequest,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """
    Run a complete HPLC analysis: purity + quantity + identity.

    Requires parsed injection data (from /hplc/parse-files), peptide selection,
    and 5 balance weights for dilution factor calculation.
    """
    # Load peptide
    peptide = db.execute(select(Peptide).where(Peptide.id == request.peptide_id)).scalar_one_or_none()
    if not peptide:
        raise HTTPException(404, f"Peptide {request.peptide_id} not found")

    # Load active calibration
    cal = db.execute(
        select(CalibrationCurve)
        .where(CalibrationCurve.peptide_id == peptide.id)
        .where(CalibrationCurve.is_active == True)
        .order_by(desc(CalibrationCurve.created_at))
        .limit(1)
    ).scalar_one_or_none()
    if not cal:
        raise HTTPException(400, f"No active calibration curve for peptide '{peptide.abbreviation}'")

    # Resolve reference RT: prefer peptide setting, fall back to calibration standard RTs
    ref_rt = peptide.reference_rt
    if ref_rt is None and cal.standard_data:
        cal_rts = cal.standard_data.get("rts", [])
        if cal_rts:
            ref_rt = round(sum(cal_rts) / len(cal_rts), 4)
            # Persist so future analyses don't need this fallback
            peptide.reference_rt = ref_rt
            db.flush()

    # Build analysis input
    analysis_input = AnalysisInput(
        injections=request.injections,
        weights=WeightInputs(
            stock_vial_empty=request.weights.stock_vial_empty,
            stock_vial_with_diluent=request.weights.stock_vial_with_diluent,
            dil_vial_empty=request.weights.dil_vial_empty,
            dil_vial_with_diluent=request.weights.dil_vial_with_diluent,
            dil_vial_with_diluent_and_sample=request.weights.dil_vial_with_diluent_and_sample,
        ),
        calibration=CalibrationParams(slope=cal.slope, intercept=cal.intercept),
        peptide=PeptideParams(
            reference_rt=ref_rt,
            rt_tolerance=peptide.rt_tolerance,
            diluent_density=peptide.diluent_density,
        ),
    )

    # Run analysis
    result = process_hplc_analysis(analysis_input)

    # Store in database
    analysis = HPLCAnalysis(
        sample_id_label=request.sample_id_label,
        peptide_id=peptide.id,
        stock_vial_empty=request.weights.stock_vial_empty,
        stock_vial_with_diluent=request.weights.stock_vial_with_diluent,
        dil_vial_empty=request.weights.dil_vial_empty,
        dil_vial_with_diluent=request.weights.dil_vial_with_diluent,
        dil_vial_with_diluent_and_sample=request.weights.dil_vial_with_diluent_and_sample,
        dilution_factor=result.get("dilution_factor"),
        stock_volume_ml=result.get("stock_volume_ml"),
        avg_main_peak_area=result.get("avg_main_peak_area"),
        concentration_ug_ml=result.get("concentration_ug_ml"),
        purity_percent=result.get("purity_percent"),
        quantity_mg=result.get("quantity_mg"),
        identity_conforms=result.get("identity_conforms"),
        identity_rt_delta=result.get("identity_rt_delta"),
        calculation_trace=result.get("calculation_trace"),
        raw_data={"injections": request.injections},
    )
    db.add(analysis)

    # Audit log
    audit = AuditLog(
        operation="hplc_analysis",
        entity_type="hplc_analysis",
        entity_id=request.sample_id_label,
        details={
            "peptide": peptide.abbreviation,
            "purity": result.get("purity_percent"),
            "quantity_mg": result.get("quantity_mg"),
            "identity_conforms": result.get("identity_conforms"),
        },
    )
    db.add(audit)
    db.commit()
    db.refresh(analysis)

    return HPLCAnalysisResponse(
        id=analysis.id,
        sample_id_label=analysis.sample_id_label,
        peptide_id=peptide.id,
        peptide_abbreviation=peptide.abbreviation,
        purity_percent=analysis.purity_percent,
        quantity_mg=analysis.quantity_mg,
        identity_conforms=analysis.identity_conforms,
        identity_rt_delta=analysis.identity_rt_delta,
        dilution_factor=analysis.dilution_factor,
        stock_volume_ml=analysis.stock_volume_ml,
        avg_main_peak_area=analysis.avg_main_peak_area,
        concentration_ug_ml=analysis.concentration_ug_ml,
        calculation_trace=analysis.calculation_trace,
        created_at=analysis.created_at,
    )


# --- HPLC Analysis History Endpoints ---

class HPLCAnalysisListItem(BaseModel):
    """Summary item for analysis history list."""
    id: int
    sample_id_label: str
    peptide_abbreviation: str
    purity_percent: Optional[float]
    quantity_mg: Optional[float]
    identity_conforms: Optional[bool]
    created_at: datetime

    class Config:
        from_attributes = True


class HPLCAnalysisListResponse(BaseModel):
    """Paginated list of analyses."""
    items: list[HPLCAnalysisListItem]
    total: int


@app.get("/hplc/analyses", response_model=HPLCAnalysisListResponse)
async def get_hplc_analyses(
    search: Optional[str] = None,
    peptide_id: Optional[int] = None,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """
    List HPLC analyses with optional search and filtering.

    Query params:
    - search: Filter by sample_id_label (partial match)
    - peptide_id: Filter by peptide
    - limit/offset: Pagination
    """
    from sqlalchemy import func

    base = select(HPLCAnalysis)
    count_base = select(func.count(HPLCAnalysis.id))

    if search:
        base = base.where(HPLCAnalysis.sample_id_label.ilike(f"%{search}%"))
        count_base = count_base.where(HPLCAnalysis.sample_id_label.ilike(f"%{search}%"))
    if peptide_id is not None:
        base = base.where(HPLCAnalysis.peptide_id == peptide_id)
        count_base = count_base.where(HPLCAnalysis.peptide_id == peptide_id)

    total = db.execute(count_base).scalar() or 0

    stmt = base.order_by(desc(HPLCAnalysis.created_at)).offset(offset).limit(limit)
    analyses = db.execute(stmt).scalars().all()

    # Build list items with peptide abbreviation
    items = []
    for a in analyses:
        peptide = db.execute(select(Peptide).where(Peptide.id == a.peptide_id)).scalar_one_or_none()
        items.append(HPLCAnalysisListItem(
            id=a.id,
            sample_id_label=a.sample_id_label,
            peptide_abbreviation=peptide.abbreviation if peptide else "?",
            purity_percent=a.purity_percent,
            quantity_mg=a.quantity_mg,
            identity_conforms=a.identity_conforms,
            created_at=a.created_at,
        ))

    return HPLCAnalysisListResponse(items=items, total=total)


@app.delete("/hplc/analyses/{analysis_id}")
async def delete_hplc_analysis(analysis_id: int, db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    """Delete an HPLC analysis and its related audit log entries."""
    analysis = db.execute(
        select(HPLCAnalysis).where(HPLCAnalysis.id == analysis_id)
    ).scalar_one_or_none()
    if not analysis:
        raise HTTPException(404, f"HPLC Analysis {analysis_id} not found")

    sample_label = analysis.sample_id_label

    # Delete related audit logs
    audit_logs = db.execute(
        select(AuditLog).where(
            AuditLog.entity_type == "hplc_analysis",
            AuditLog.entity_id == sample_label,
        )
    ).scalars().all()
    for log in audit_logs:
        db.delete(log)

    db.delete(analysis)
    db.commit()
    return {"message": f"Analysis {analysis_id} ({sample_label}) deleted"}


@app.get("/hplc/analyses/{analysis_id}", response_model=HPLCAnalysisResponse)
async def get_hplc_analysis(analysis_id: int, db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    """Get full detail of a single HPLC analysis including calculation trace."""
    analysis = db.execute(
        select(HPLCAnalysis).where(HPLCAnalysis.id == analysis_id)
    ).scalar_one_or_none()
    if not analysis:
        raise HTTPException(404, f"HPLC Analysis {analysis_id} not found")

    peptide = db.execute(
        select(Peptide).where(Peptide.id == analysis.peptide_id)
    ).scalar_one_or_none()

    return HPLCAnalysisResponse(
        id=analysis.id,
        sample_id_label=analysis.sample_id_label,
        peptide_id=analysis.peptide_id,
        peptide_abbreviation=peptide.abbreviation if peptide else "?",
        purity_percent=analysis.purity_percent,
        quantity_mg=analysis.quantity_mg,
        identity_conforms=analysis.identity_conforms,
        identity_rt_delta=analysis.identity_rt_delta,
        dilution_factor=analysis.dilution_factor,
        stock_volume_ml=analysis.stock_volume_ml,
        avg_main_peak_area=analysis.avg_main_peak_area,
        concentration_ug_ml=analysis.concentration_ug_ml,
        calculation_trace=analysis.calculation_trace,
        created_at=analysis.created_at,
    )


# --- Peptide Seed from Lab Folder ---


class SeedPeptidesResponse(BaseModel):
    """Response from running the peptide seed/scan."""
    success: bool
    output: str
    errors: str


# ── Excel calibration parsing helpers (shared with seed script) ──

def _is_number(v) -> bool:
    """Check if a value is a numeric value."""
    if v is None:
        return False
    if isinstance(v, (int, float)):
        return True
    if isinstance(v, str):
        try:
            float(v)
            return True
        except ValueError:
            return False
    return False


def _to_float(v) -> float:
    if isinstance(v, (int, float)):
        return float(v)
    return float(str(v))


def _try_extract_calibration(ws, filename: str, max_rows: int = 25) -> dict | None:
    """
    Try to extract calibration data from a worksheet by scanning for headers
    or falling back to known fixed layouts.
    """
    # 1. Dynamic Header Scan
    conc_col = None
    area_col = None
    rt_col = None
    header_row = None

    # Scan top 20 rows for headers using substring matching
    # This catches variants like "Actual Concentration", "Target Conc. (µg/mL)", etc.
    found_headers = False

    # Patterns: if ANY keyword appears in the cell value, it's a match.
    # Listed most-specific first to avoid false positives.
    _conc_keywords = ("actual concentration", "actual (ug", "actual (\u00b5g",
                      "concentration", "target conc", "target (ug", "target (\u00b5g",
                      "std. conc", "std conc", "amount", "cal level", "level")
    _area_keywords = ("peak area", "area")
    _rt_keywords   = ("ret. time", "ret time", "ret_time", "rt")
    # Words that disqualify a cell even if it contains a keyword
    _area_exclude  = ("area %", "area%", "area purity", "purity")

    for r_idx, row in enumerate(ws.iter_rows(min_row=1, max_row=20, values_only=False), start=1):
        for cell in row:
            if not cell.value or not isinstance(cell.value, str):
                continue
            val = cell.value.lower().strip()

            # --- Concentration column (prefer "actual" over "target") ---
            if conc_col is None or ("actual" in val and "target" not in val):
                for kw in _conc_keywords:
                    if kw in val:
                        conc_col = cell.column
                        break

            # --- Area column (exclude "Area %" / "Area Purity") ---
            if area_col is None:
                if not any(ex in val for ex in _area_exclude):
                    for kw in _area_keywords:
                        if kw in val:
                            area_col = cell.column
                            break

            # --- RT column ---
            if rt_col is None:
                for kw in _rt_keywords:
                    if kw in val:
                        rt_col = cell.column
                        break

        if conc_col and area_col:
            header_row = r_idx
            found_headers = True
            break
            
    # DEBUG: Log if headers not found for KPV
    if not found_headers and "KPV" in filename and ws.title not in ("Sequence", "Instrument Method"):
         # Grab first row as sample
         row1 = [c.value for c in next(ws.iter_rows(min_row=1, max_row=1)) if c.value]
         print(f"[DEBUG-KPV] {filename}/{ws.title}: No headers found. Row 1: {row1}")
    
    # If headers found, extract data below
    if found_headers:
        concentrations = []
        areas = []
        rts = []
        
        # Scan data rows below header (stop after 2 consecutive empty rows)
        consecutive_empty = 0
        for r in range(header_row + 1, header_row + 1 + max_rows):
            conc_val = ws.cell(row=r, column=conc_col).value
            area_val = ws.cell(row=r, column=area_col).value
            
            if not _is_number(conc_val) or not _is_number(area_val):
                consecutive_empty += 1
                if consecutive_empty >= 2:
                    break
                continue
            
            c = _to_float(conc_val)
            a = _to_float(area_val)
            
            if c <= 0 or a <= 0:
                consecutive_empty += 1
                if consecutive_empty >= 2:
                    break
                continue
            
            consecutive_empty = 0  # Reset on valid row
            concentrations.append(c)
            areas.append(a)
            
            if rt_col:
                rt_val = ws.cell(row=r, column=rt_col).value
                if _is_number(rt_val) and _to_float(rt_val) > 0:
                    rts.append(_to_float(rt_val))

        if len(concentrations) >= 3:
            # Check for linearity/validity (simple check)
            max_c = max(concentrations)
            min_c = min(concentrations)
            if max_c > min_c: # Just ensure some spread
                 return {
                    "concentrations": concentrations,
                    "areas": areas,
                    "rts": rts,
                    "format": "dynamic_header",
                    "n_points": len(concentrations),
                }

    # 2. Fallback to fixed layouts (if dynamic failed)
    layouts = [
        ("new_S_U", 2, 19, 21),     # B, S, U
        ("old_J_L", 2, 10, 12),     # B, J, L
        ("older_B_G", 2, 7, None),  # B, G, no RT
    ]

    for fmt_name, c_col, a_col, r_col in layouts:
        concentrations = []
        areas = []
        rts = []

        for row in range(2, 2 + max_rows):
            conc_val = ws.cell(row=row, column=c_col).value
            area_val = ws.cell(row=row, column=a_col).value

            if not _is_number(conc_val) or not _is_number(area_val):
                continue

            conc = _to_float(conc_val)
            area = _to_float(area_val)

            if conc <= 0 or area <= 0:
                continue

            concentrations.append(conc)
            areas.append(area)

            if r_col is not None:
                rt_val = ws.cell(row=row, column=r_col).value
                if _is_number(rt_val) and _to_float(rt_val) > 0:
                    rts.append(_to_float(rt_val))

        if len(concentrations) >= 3:
            # Simple validity check: range of areas should be somewhat large spread
            # if max_area <= min_area * 1.5, likely just noise or same sample repeated
            max_conc_area = areas[concentrations.index(max(concentrations))]
            min_conc_area = areas[concentrations.index(min(concentrations))]
            if max_conc_area <= min_conc_area * 1.05: # lenient
                continue

            return {
                "concentrations": concentrations,
                "areas": areas,
                "rts": rts,
                "format": fmt_name,
                "n_points": len(concentrations),
            }

    return None


def _parse_calibration_excel_bytes(data: bytes, filename: str) -> dict | None:
    """Parse calibration data from Excel file bytes (downloaded from SharePoint)."""
    import openpyxl
    from io import BytesIO

    skip_sheets = {"Dissolution method", "Dissolution Method"}
    skip_prefixes = ("SOP CalStds", "SOP_CalStds")

    try:
        wb = openpyxl.load_workbook(BytesIO(data), data_only=True, read_only=True)
    except Exception:
        return None

    for sheet_name in wb.sheetnames:
        if sheet_name in skip_sheets:
            continue
        if any(sheet_name.startswith(p) for p in skip_prefixes):
            continue

        ws = wb[sheet_name]
        try:
            result = _try_extract_calibration(ws, filename)
        except Exception as e:
            # Catch worksheet access errors
            print(f"[ERROR] failed parsing sheet {sheet_name} in {filename}: {e}")
            continue

        if result:
            result["sheet"] = sheet_name
            result["filename"] = filename
            wb.close()
            return result

    wb.close()
    return None


@app.post("/hplc/seed-peptides", response_model=SeedPeptidesResponse)
async def seed_peptides_from_sharepoint(
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """
    Scan the SharePoint Peptides folder and import peptides + ALL calibration curves.

    - Discovers peptide folders dynamically (no hardcoded map).
    - Scans entire peptide folder for .xlsx files.
    - Parses each for concentration/area/RT data.
    - Creates new peptides and imports ALL valid calibration curves.
    - For existing peptides, imports any new calibrations not yet in DB.
    - Most recent calibration (by filename sort) is set as active.
    """
    import sharepoint as sp
    from calculations.calibration import calculate_calibration_curve

    log_lines = []
    error_lines = []

    def log(msg: str):
        print(msg)  # Ensure it shows in docker logs
        log_lines.append(msg)

    try:
        # 1. List all folders in the Peptides root
        peptide_folders = await sp.list_folder("")
        peptide_dirs = [f for f in peptide_folders if f["type"] == "folder"]
        log(f"Found {len(peptide_dirs)} folders in Peptides root\n")

        # 2. Get existing peptides from DB
        existing_peptides = {
            p.abbreviation: p
            for p in db.execute(select(Peptide).order_by(Peptide.abbreviation)).scalars().all()
        }
        log(f"Existing peptides in DB: {len(existing_peptides)} ({', '.join(existing_peptides.keys()) or 'none'})\n")

        created = 0
        calibrations_added = 0
        skipped = 0
        no_cal_data = []

        for folder in sorted(peptide_dirs, key=lambda f: f["name"]):
            folder_name = folder["name"]
            abbreviation = folder_name.strip()

            # Skip known non-peptide folders
            skip_names = {"Templates", "Blends", "_Templates", "Archive"}
            if folder_name in skip_names:
                log(f"[SKIP] {folder_name}/ — non-peptide folder")
                continue

            log(f"\n--- {folder_name} ---")

            # 3. Find ALL Excel files in the peptide folder
            cal_files = []
            try:
                all_xlsx = await sp.list_files_recursive(
                    folder_name,
                    extensions=[".xlsx"],
                    root="peptides",
                )
                for item in all_xlsx:
                    fn = item["name"]
                    if fn.startswith("~$"):
                        continue
                    # Skip Agilent data exports
                    if ".dx_" in fn or "_PeakData" in fn:
                        continue
                    cal_files.append(item)
            except Exception as e:
                log(f"  [ERROR] Failed to list files: {e}")

            # 4. Download and parse calibration files (skip already-imported paths)
            cal_files.sort(key=lambda f: f["name"])
            parsed_cals = []

            # Pre-load known source_paths to skip downloads (from file cache + calibration curves)
            known_paths = set(
                r[0] for r in db.execute(
                    select(SharePointFileCache.source_path)
                    .where(SharePointFileCache.peptide_abbreviation == abbreviation)
                ).all()
            )
            peptide = existing_peptides.get(abbreviation)
            if peptide:
                # Also include paths from calibration curves (covers pre-cache data)
                known_paths.update(
                    r[0] for r in db.execute(
                        select(CalibrationCurve.source_path)
                        .where(CalibrationCurve.peptide_id == peptide.id)
                        .where(CalibrationCurve.source_path.isnot(None))
                    ).all()
                )

            for cal_file in cal_files:
                file_path = cal_file.get("path", cal_file["name"])
                if file_path in known_paths:
                    log(f"  [SKIP] Already imported: {cal_file['name']}")
                    continue
                try:
                    file_bytes, filename = await sp.download_file(cal_file["id"])
                    result = _parse_calibration_excel_bytes(file_bytes, filename)
                    produced_cal = result is not None
                    if result:
                        result["_sharepoint_path"] = file_path
                        result["_last_modified"] = cal_file.get("last_modified")
                        result["_web_url"] = cal_file.get("web_url")
                        parsed_cals.append(result)
                    # Cache this path so we never re-download it
                    db.add(SharePointFileCache(
                        source_path=file_path,
                        peptide_abbreviation=abbreviation,
                        produced_calibration=produced_cal,
                    ))
                except Exception as e:
                    log(f"  [WARN] Failed to download/parse {cal_file['name']}: {e}")

            # 5. Get or create peptide
            peptide = existing_peptides.get(abbreviation)
            is_new = peptide is None

            if is_new:
                # Extract reference RT from most recent calibration
                ref_rt = None
                if parsed_cals:
                    last_cal = parsed_cals[-1]
                    if last_cal.get("rts"):
                        ref_rt = round(sum(last_cal["rts"]) / len(last_cal["rts"]), 4)

                peptide = Peptide(
                    name=folder_name,
                    abbreviation=abbreviation,
                    reference_rt=ref_rt,
                    rt_tolerance=0.5,
                    diluent_density=997.1,
                )
                db.add(peptide)
                db.flush()
                created += 1
                existing_peptides[abbreviation] = peptide
                log(f"  Created peptide (id={peptide.id})")
            else:
                log(f"  [EXISTS] {abbreviation} (id={peptide.id})")
                # Update reference RT if not set and we have new calibration data
                if peptide.reference_rt is None and parsed_cals:
                    last_cal = parsed_cals[-1]
                    if last_cal.get("rts"):
                        ref_rt = round(sum(last_cal["rts"]) / len(last_cal["rts"]), 4)
                        peptide.reference_rt = ref_rt
                        log(f"  Updated reference RT: {ref_rt}")

            # 6. Get existing calibration source filenames for this peptide
            existing_cal_filenames = set()
            existing_cals = db.execute(
                select(CalibrationCurve)
                .where(CalibrationCurve.peptide_id == peptide.id)
            ).scalars().all()
            for ec in existing_cals:
                if ec.source_filename:
                    existing_cal_filenames.add(ec.source_filename)

            # 7. Import all parsed calibrations that aren't already in DB
            new_cals_for_peptide = []
            for cal_data in parsed_cals:
                source = f"{cal_data['filename']}[{cal_data['sheet']}]"
                if source in existing_cal_filenames:
                    log(f"  [EXISTS] Calibration: {source}")
                    continue

                try:
                    cal_result = calculate_calibration_curve(
                        cal_data["concentrations"],
                        cal_data["areas"],
                    )
                    cal_curve = CalibrationCurve(
                        peptide_id=peptide.id,
                        slope=cal_result["slope"],
                        intercept=cal_result["intercept"],
                        r_squared=cal_result["r_squared"],
                        standard_data={
                            "concentrations": cal_data["concentrations"],
                            "areas": cal_data["areas"],
                            "rts": cal_data.get("rts", []),
                        },
                        source_filename=source,
                        source_path=cal_data.get("_sharepoint_path"),
                        source_date=(
                            datetime.fromisoformat(cal_data["_last_modified"].replace("Z", "+00:00"))
                            if cal_data.get("_last_modified")
                            else None
                        ),
                        sharepoint_url=cal_data.get("_web_url"),
                        is_active=False,  # Will activate the most recent below
                    )
                    db.add(cal_curve)
                    new_cals_for_peptide.append(cal_curve)
                    calibrations_added += 1
                    log(f"  + Calibration: {source} "
                        f"(slope={cal_result['slope']:.4f}, R²={cal_result['r_squared']:.6f})")
                except Exception as e:
                    error_lines.append(f"Calibration error for {abbreviation} ({source}): {e}")
                    log(f"  [ERROR] Calibration {source}: {e}")

            # 8. Set the most recent calibration as active
            if new_cals_for_peptide:
                # Deactivate all existing
                for ec in existing_cals:
                    ec.is_active = False
                # Activate the last (most recent by filename sort)
                db.flush()
                new_cals_for_peptide[-1].is_active = True
                log(f"  ✓ Active: {new_cals_for_peptide[-1].source_filename}")

            if not parsed_cals and is_new:
                no_cal_data.append(folder_name)
                log(f"  No calibration data found")

            if not is_new and not new_cals_for_peptide and not parsed_cals:
                skipped += 1

        db.commit()

        # Summary
        log(f"\n{'=' * 60}")
        log(f"SUMMARY")
        log(f"  Peptides created:      {created}")
        log(f"  Calibrations added:    {calibrations_added}")
        log(f"  Skipped (no changes):  {skipped}")
        log(f"  No calibration data:   {len(no_cal_data)}")
        if no_cal_data:
            log(f"    {', '.join(no_cal_data)}")
        log(f"  Total in DB:           {len(existing_peptides)}")

        return SeedPeptidesResponse(
            success=True,
            output="\n".join(log_lines),
            errors="\n".join(error_lines),
        )
    except Exception as e:
        db.rollback()
        return SeedPeptidesResponse(
            success=False,
            output="\n".join(log_lines),
            errors=f"SharePoint scan failed: {e}\n" + "\n".join(error_lines),
        )


@app.get("/hplc/seed-peptides/stream")
async def seed_peptides_stream(
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """
    SSE streaming version of seed-peptides.
    Imports ALL calibration curves per peptide.
    Sends each log line as a server-sent event for real-time progress display.
    """
    from starlette.responses import StreamingResponse
    import sharepoint as sp
    import asyncio
    from calculations.calibration import calculate_calibration_curve

    async def event_generator():
        def send_event(event_type: str, data: dict) -> str:
            """Format an SSE event and log to console."""
            if event_type == "log":
                import sys
                msg = data.get("message", "")
                level = data.get("level", "info")
                # Print to stderr to ensure it shows up in docker logs immediately
                print(f"[{level.upper()}] {msg}", file=sys.stderr)
            
            payload = json.dumps(data)
            return f"event: {event_type}\ndata: {payload}\n\n"

        created = 0
        calibrations_added = 0
        skipped = 0
        no_cal_data = []
        error_lines = []

        try:
            # 1. List all folders in the Peptides root
            yield send_event("log", {"message": "Connecting to SharePoint...", "level": "info"})
            await asyncio.sleep(0)  # flush

            peptide_folders = await sp.list_folder("")
            peptide_dirs = [f for f in peptide_folders if f["type"] == "folder"]
            total = len(peptide_dirs)
            yield send_event("log", {"message": f"Found {total} folders in Peptides root", "level": "info"})
            yield send_event("progress", {"current": 0, "total": total, "phase": "scanning"})

            # 2. Get existing peptides from DB
            existing_peptides = {
                p.abbreviation: p
                for p in db.execute(select(Peptide).order_by(Peptide.abbreviation)).scalars().all()
            }
            yield send_event("log", {
                "message": f"Existing peptides in DB: {len(existing_peptides)} ({', '.join(existing_peptides.keys()) or 'none'})",
                "level": "info",
            })

            processed = 0
            for folder in sorted(peptide_dirs, key=lambda f: f["name"]):
                processed += 1
                folder_name = folder["name"]
                abbreviation = folder_name.strip()

                # Skip known non-peptide folders
                skip_names = {"Templates", "Blends", "_Templates", "Archive"}
                if folder_name in skip_names:
                    yield send_event("log", {"message": f"[SKIP] {folder_name}/ — non-peptide folder", "level": "dim"})
                    yield send_event("progress", {"current": processed, "total": total, "phase": "scanning"})
                    continue

                yield send_event("log", {"message": f"--- {folder_name} ---", "level": "heading"})
                yield send_event("progress", {"current": processed, "total": total, "phase": f"Processing {folder_name}"})

                # 3. Find ALL Excel files in the peptide folder
                cal_files = []
                try:
                    yield send_event("log", {"message": f"  Scanning for Excel files...", "level": "dim"})
                    all_xlsx = await sp.list_files_recursive(
                        folder_name,
                        extensions=[".xlsx"],
                        root="peptides",
                    )
                    for item in all_xlsx:
                        fn = item["name"]
                        if fn.startswith("~$"):
                            continue
                        if ".dx_" in fn or "_PeakData" in fn:
                            continue
                        cal_files.append(item)
                    if cal_files:
                        yield send_event("log", {"message": f"  Found {len(cal_files)} Excel file(s)", "level": "info"})
                except Exception as e:
                    yield send_event("log", {"message": f"  [ERROR] File listing failed: {e}", "level": "error"})
                    import sys
                    print(f"[ERROR] list_files_recursive failed for {folder_name}: {e}", file=sys.stderr)

                # 4. Download and parse calibration files (skip already-imported paths)
                cal_files.sort(key=lambda f: f["name"])
                parsed_cals = []

                # Pre-load known source_paths to skip downloads (from file cache + calibration curves)
                known_paths = set(
                    r[0] for r in db.execute(
                        select(SharePointFileCache.source_path)
                        .where(SharePointFileCache.peptide_abbreviation == abbreviation)
                    ).all()
                )
                peptide = existing_peptides.get(abbreviation)
                if peptide:
                    # Also include paths from calibration curves (covers pre-cache data)
                    known_paths.update(
                        r[0] for r in db.execute(
                            select(CalibrationCurve.source_path)
                            .where(CalibrationCurve.peptide_id == peptide.id)
                            .where(CalibrationCurve.source_path.isnot(None))
                        ).all()
                    )

                skipped_count = 0
                for cal_file in cal_files:
                    file_path = cal_file.get("path", cal_file["name"])
                    if file_path in known_paths:
                        skipped_count += 1
                        continue
                    try:
                        yield send_event("log", {"message": f"  Downloading {cal_file['name']}...", "level": "dim"})
                        file_bytes, filename = await sp.download_file(cal_file["id"])
                        result = _parse_calibration_excel_bytes(file_bytes, filename)
                        produced_cal = result is not None
                        if result:
                            result["_sharepoint_path"] = file_path
                            result["_last_modified"] = cal_file.get("last_modified")
                            result["_web_url"] = cal_file.get("web_url")
                            parsed_cals.append(result)
                        # Cache this path so we never re-download it
                        db.add(SharePointFileCache(
                            source_path=file_path,
                            peptide_abbreviation=abbreviation,
                            produced_calibration=produced_cal,
                        ))
                    except Exception as e:
                        yield send_event("log", {"message": f"  [WARN] Failed: {cal_file['name']}: {e}", "level": "warn"})

                if skipped_count:
                    yield send_event("log", {"message": f"  [SKIP] {skipped_count} file(s) already imported", "level": "dim"})

                # 5. Get or create peptide
                peptide = existing_peptides.get(abbreviation)
                is_new = peptide is None

                if is_new:
                    ref_rt = None
                    if parsed_cals:
                        last_cal = parsed_cals[-1]
                        if last_cal.get("rts"):
                            ref_rt = round(sum(last_cal["rts"]) / len(last_cal["rts"]), 4)

                    peptide = Peptide(
                        name=folder_name,
                        abbreviation=abbreviation,
                        reference_rt=ref_rt,
                        rt_tolerance=0.5,
                        diluent_density=997.1,
                    )
                    db.add(peptide)
                    db.flush()
                    created += 1
                    existing_peptides[abbreviation] = peptide
                    yield send_event("log", {"message": f"  ✓ Created peptide (id={peptide.id})", "level": "success"})
                else:
                    yield send_event("log", {
                        "message": f"  [EXISTS] {abbreviation} (id={peptide.id})",
                        "level": "dim",
                    })
                    # Update reference RT if not set and we have new calibration data
                    if peptide.reference_rt is None and parsed_cals:
                        last_cal = parsed_cals[-1]
                        if last_cal.get("rts"):
                            ref_rt = round(sum(last_cal["rts"]) / len(last_cal["rts"]), 4)
                            peptide.reference_rt = ref_rt
                            yield send_event("log", {
                                "message": f"  Updated reference RT: {ref_rt}",
                                "level": "success",
                            })

                # 6. Check existing calibration source filenames
                existing_cal_filenames = set()
                existing_cals = db.execute(
                    select(CalibrationCurve)
                    .where(CalibrationCurve.peptide_id == peptide.id)
                ).scalars().all()
                for ec in existing_cals:
                    if ec.source_filename:
                        existing_cal_filenames.add(ec.source_filename)

                # 7. Import all new calibrations
                new_cals_for_peptide = []
                for cal_data in parsed_cals:
                    source = f"{cal_data['filename']}[{cal_data['sheet']}]"
                    if source in existing_cal_filenames:
                        yield send_event("log", {"message": f"  [EXISTS] Cal: {source}", "level": "dim"})
                        continue

                    try:
                        cal_result = calculate_calibration_curve(
                            cal_data["concentrations"],
                            cal_data["areas"],
                        )
                        cal_curve = CalibrationCurve(
                            peptide_id=peptide.id,
                            slope=cal_result["slope"],
                            intercept=cal_result["intercept"],
                            r_squared=cal_result["r_squared"],
                            standard_data={
                                "concentrations": cal_data["concentrations"],
                                "areas": cal_data["areas"],
                                "rts": cal_data.get("rts", []),
                            },
                            source_filename=source,
                            source_path=cal_data.get("_sharepoint_path"),
                            source_date=(
                                datetime.fromisoformat(cal_data["_last_modified"].replace("Z", "+00:00"))
                                if cal_data.get("_last_modified")
                                else None
                            ),
                            sharepoint_url=cal_data.get("_web_url"),
                            is_active=False,
                        )
                        db.add(cal_curve)
                        new_cals_for_peptide.append(cal_curve)
                        calibrations_added += 1
                        yield send_event("log", {
                            "message": f"  + Cal: {source} (slope={cal_result['slope']:.4f}, R²={cal_result['r_squared']:.6f})",
                            "level": "success",
                        })
                    except Exception as e:
                        error_lines.append(f"Calibration error for {abbreviation} ({source}): {e}")
                        yield send_event("log", {"message": f"  ✗ Cal error {source}: {e}", "level": "error"})

                # 8. Set the most recent as active
                if new_cals_for_peptide:
                    for ec in existing_cals:
                        ec.is_active = False
                    db.flush()
                    new_cals_for_peptide[-1].is_active = True
                    yield send_event("log", {
                        "message": f"  ✓ Active: {new_cals_for_peptide[-1].source_filename}",
                        "level": "success",
                    })

                if not parsed_cals and is_new:
                    no_cal_data.append(folder_name)
                    yield send_event("log", {
                        "message": f"  No calibration data found",
                        "level": "warn",
                    })

                if not is_new and not new_cals_for_peptide and not parsed_cals:
                    skipped += 1

                # Commit after each peptide so progress is saved incrementally
                db.commit()
                yield send_event("refresh", {})

            # Summary
            yield send_event("log", {"message": "=" * 50, "level": "info"})
            yield send_event("log", {"message": "SUMMARY", "level": "heading"})
            yield send_event("log", {"message": f"  Peptides created:    {created}", "level": "success" if created else "info"})
            yield send_event("log", {"message": f"  Calibrations added:  {calibrations_added}", "level": "success" if calibrations_added else "info"})
            yield send_event("log", {"message": f"  Skipped (no changes):{skipped}", "level": "dim"})
            yield send_event("log", {"message": f"  No calibration data: {len(no_cal_data)}", "level": "warn" if no_cal_data else "info"})
            yield send_event("log", {"message": f"  Total in DB:         {len(existing_peptides)}", "level": "info"})

            yield send_event("done", {
                "success": True,
                "created": created,
                "calibrations": calibrations_added,
                "skipped": skipped,
                "total": len(existing_peptides),
            })

        except Exception as e:
            db.rollback()
            yield send_event("log", {"message": f"✗ FAILED: {e}", "level": "error"})
            yield send_event("done", {"success": False, "error": str(e)})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )




class DilutionRow(BaseModel):
    """One dilution level's weights from the Excel file."""
    label: str
    concentration: Optional[str] = None
    dil_vial_empty: float
    dil_vial_with_diluent: float
    dil_vial_with_diluent_and_sample: float


class WeightExtractionResponse(BaseModel):
    """Extracted weight data from a lab Excel file."""
    found: bool
    folder_name: Optional[str] = None
    peptide_folder: Optional[str] = None
    excel_filename: Optional[str] = None
    stock_vial_empty: Optional[float] = None
    stock_vial_with_diluent: Optional[float] = None
    dilution_rows: list[DilutionRow] = []
    error: Optional[str] = None


def _extract_weights_from_excel_bytes(data: bytes) -> dict:
    """
    Parse a lab HPLC Excel file (bytes) for stock + dilution weights.

    Tries multiple layout strategies in order:
    1. F/G/H columns with "Stock" label in col E
    2. Header-label scan: finds rows with "vial and cap" / "vial cap and diluent" headers
    3. Alternate layout: A/B labels for stock, C/E/H for dilution data
    """
    import openpyxl
    from io import BytesIO

    wb = openpyxl.load_workbook(BytesIO(data), data_only=True, read_only=True)
    result = {
        "stock_vial_empty": None,
        "stock_vial_with_diluent": None,
        "dilution_rows": [],
    }

    max_scan_row = 70  # Some files have weight data past row 40

    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]

        # --- Strategy 1: "Sample" sheet layout (F/G/H columns, Stock in row with "Stock" in col E) ---
        stock_empty = None
        stock_diluent = None
        dilutions = []

        for row in range(1, max_scan_row):
            e_val = ws.cell(row=row, column=5).value  # col E
            f_val = ws.cell(row=row, column=6).value  # col F
            g_val = ws.cell(row=row, column=7).value  # col G
            h_val = ws.cell(row=row, column=8).value  # col H

            # Check for stock row
            if e_val and isinstance(e_val, str) and "stock" in e_val.lower():
                if isinstance(f_val, (int, float)) and isinstance(g_val, (int, float)):
                    stock_empty = float(f_val)
                    stock_diluent = float(g_val)
                continue

            # Check for dilution data rows (need F, G, H all numeric)
            if (isinstance(f_val, (int, float)) and f_val > 2000
                    and isinstance(g_val, (int, float)) and g_val > f_val
                    and isinstance(h_val, (int, float)) and h_val >= g_val):
                conc_label = str(e_val) if e_val else f"Row {row}"
                dilutions.append({
                    "label": conc_label,
                    "concentration": conc_label,
                    "dil_vial_empty": float(f_val),
                    "dil_vial_with_diluent": float(g_val),
                    "dil_vial_with_diluent_and_sample": float(h_val),
                })

        if dilutions:
            result["stock_vial_empty"] = stock_empty
            result["stock_vial_with_diluent"] = stock_diluent
            result["dilution_rows"] = dilutions
            wb.close()
            return result

        # --- Strategy 2: Header-label scan ---
        # Look for header rows containing weight-related labels, then read data from the row below.
        # Handles layouts like:
        #   Row 55: "Weight Vial and cap (mg)" | "Weight of Vial cap and Diluent (mg)" | "Weight of ... and sample (mg)"
        #   Row 56: 2758.79                    | 4139.42                                | 4262.24
        #   Row 59: "Weight Sample Vial and cap (mg)" | "Weight of Vial cap and Diluent (mg)"
        #   Row 60: 5462                              | 6450.26
        dil_header_row = None
        stock_header_row = None

        for row in range(1, max_scan_row):
            a_val = ws.cell(row=row, column=1).value
            if not a_val or not isinstance(a_val, str):
                continue
            lower = a_val.lower()

            # Dilution weights header: contains "vial" + "cap" but NOT "sample vial"
            if "weight" in lower and "vial" in lower and "cap" in lower and "sample" not in lower:
                # Check if col B or C also has a weight-related header (confirming this is a header row)
                b_val = ws.cell(row=row, column=2).value
                c_val = ws.cell(row=row, column=3).value
                has_dil_header = False
                for check in (b_val, c_val):
                    if check and isinstance(check, str) and "diluent" in check.lower():
                        has_dil_header = True
                        break
                if has_dil_header:
                    dil_header_row = row

            # Stock weights header: contains "sample vial" + "cap"
            if "weight" in lower and "sample vial" in lower and "cap" in lower:
                b_val = ws.cell(row=row, column=2).value
                if b_val and isinstance(b_val, str) and "diluent" in b_val.lower():
                    stock_header_row = row

        label_dilutions = []
        if dil_header_row:
            # Determine which columns have data by checking the header row
            # Find columns containing "vial and cap", "diluent", "sample" in the header
            empty_col = None
            diluent_col = None
            sample_col = None
            for col in range(1, 10):
                hdr = ws.cell(row=dil_header_row, column=col).value
                if not hdr or not isinstance(hdr, str):
                    continue
                h_lower = hdr.lower()
                if "sample" in h_lower and "diluent" in h_lower:
                    sample_col = col
                elif "diluent" in h_lower:
                    diluent_col = col
                elif "vial" in h_lower and "cap" in h_lower:
                    empty_col = col

            if empty_col and diluent_col and sample_col:
                # Read data row(s) below header
                for data_row in range(dil_header_row + 1, dil_header_row + 5):
                    ev = ws.cell(row=data_row, column=empty_col).value
                    dv = ws.cell(row=data_row, column=diluent_col).value
                    sv = ws.cell(row=data_row, column=sample_col).value
                    if (isinstance(ev, (int, float)) and ev > 1000
                            and isinstance(dv, (int, float)) and dv > ev
                            and isinstance(sv, (int, float)) and sv >= dv):
                        label_dilutions.append({
                            "label": f"Row {data_row}",
                            "concentration": f"Row {data_row}",
                            "dil_vial_empty": float(ev),
                            "dil_vial_with_diluent": float(dv),
                            "dil_vial_with_diluent_and_sample": float(sv),
                        })
                    else:
                        break  # Stop on first non-data row

        if stock_header_row:
            # Read stock data from the row below the stock header
            for data_row in range(stock_header_row + 1, stock_header_row + 3):
                sv_empty = ws.cell(row=data_row, column=1).value
                sv_dil = ws.cell(row=data_row, column=2).value
                if isinstance(sv_empty, (int, float)) and isinstance(sv_dil, (int, float)):
                    stock_empty = float(sv_empty)
                    stock_diluent = float(sv_dil)
                    break

        if label_dilutions:
            result["stock_vial_empty"] = stock_empty
            result["stock_vial_with_diluent"] = stock_diluent
            result["dilution_rows"] = label_dilutions
            wb.close()
            return result

        # --- Strategy 3: Alternate layout (A/B labels for stock, C/E/H for dilution) ---
        stock_empty = None
        stock_diluent = None
        for row in range(1, max_scan_row):
            a_val = ws.cell(row=row, column=1).value
            b_val = ws.cell(row=row, column=2).value

            if a_val and isinstance(a_val, str):
                lower = a_val.lower()
                if "stock vial+cap" in lower or "stock vial + cap" in lower:
                    if isinstance(b_val, (int, float)):
                        stock_empty = float(b_val)
                elif "stock peptide+vial" in lower or "stock vial+cap+diluent" in lower:
                    if isinstance(b_val, (int, float)):
                        stock_diluent = float(b_val)

        alt_dilutions = []
        for row in range(1, max_scan_row):
            a_val = ws.cell(row=row, column=1).value
            c_val = ws.cell(row=row, column=3).value
            e_val = ws.cell(row=row, column=5).value
            h_val = ws.cell(row=row, column=8).value

            if (isinstance(c_val, (int, float)) and c_val > 2000
                    and isinstance(e_val, (int, float)) and e_val > c_val
                    and isinstance(h_val, (int, float)) and h_val >= e_val):
                label = str(a_val) if a_val else f"Row {row}"
                if "stock" in label.lower():
                    if stock_empty is None:
                        stock_empty = float(c_val)
                        stock_diluent = float(e_val)
                else:
                    alt_dilutions.append({
                        "label": label,
                        "concentration": label,
                        "dil_vial_empty": float(c_val),
                        "dil_vial_with_diluent": float(e_val),
                        "dil_vial_with_diluent_and_sample": float(h_val),
                    })

        if alt_dilutions:
            result["stock_vial_empty"] = stock_empty
            result["stock_vial_with_diluent"] = stock_diluent
            result["dilution_rows"] = alt_dilutions
            wb.close()
            return result

    wb.close()
    return result


@app.get("/hplc/weights/{sample_id}", response_model=WeightExtractionResponse)
async def get_sample_weights(sample_id: str, _current_user=Depends(get_current_user)):
    """
    Search SharePoint Peptides folder for a sample ID and extract weight data
    from the associated Excel workbook.

    Scans each peptide subfolder's Raw Data directory for a folder matching
    the sample ID, then downloads and parses the lab Excel file.
    """
    import sharepoint as sp

    # 1. Search SharePoint for the sample folder
    try:
        sample_info = await sp.search_sample_folder(sample_id)
    except Exception as e:
        return WeightExtractionResponse(
            found=False,
            error=f"SharePoint search error: {e}"
        )

    if not sample_info:
        return WeightExtractionResponse(
            found=False,
            error=f"No folder matching '{sample_id}' found in Peptides root"
        )

    folder_name = sample_info["name"]
    peptide_folder = sample_info["peptide_folder"]
    sample_path = sample_info["path"]

    # 2. List files in the sample folder (and 1290 subfolder)
    try:
        all_files = await sp.list_files_recursive(sample_path, extensions=[".xlsx"])
    except Exception as e:
        return WeightExtractionResponse(
            found=True,
            folder_name=folder_name,
            peptide_folder=peptide_folder,
            error=f"Error listing files: {e}"
        )

    # Filter to lab workbook files (not Agilent data exports)
    excel_candidates = []
    for f in all_files:
        name = f["name"]
        if name.startswith("~$"):
            continue
        if ".dx_" in name or "_PeakData" in name:
            continue
        excel_candidates.append(f)

    if not excel_candidates:
        return WeightExtractionResponse(
            found=True,
            folder_name=folder_name,
            peptide_folder=peptide_folder,
            error="No Excel file found in sample folder"
        )

    # Prefer _Samp_ or _Std_ files
    chosen = None
    for c in excel_candidates:
        if "_Samp_" in c["name"] or "_Std_" in c["name"]:
            chosen = c
            break
    if not chosen:
        chosen = excel_candidates[0]

    # 3. Download and parse the Excel file
    try:
        file_bytes, filename = await sp.download_file(chosen["id"])
    except Exception as e:
        return WeightExtractionResponse(
            found=True,
            folder_name=folder_name,
            peptide_folder=peptide_folder,
            excel_filename=chosen["name"],
            error=f"Error downloading Excel: {e}"
        )

    try:
        weights = _extract_weights_from_excel_bytes(file_bytes)
    except Exception as e:
        return WeightExtractionResponse(
            found=True,
            folder_name=folder_name,
            peptide_folder=peptide_folder,
            excel_filename=filename,
            error=f"Error parsing Excel: {e}"
        )

    return WeightExtractionResponse(
        found=True,
        folder_name=folder_name,
        peptide_folder=peptide_folder,
        excel_filename=filename,
        stock_vial_empty=weights["stock_vial_empty"],
        stock_vial_with_diluent=weights["stock_vial_with_diluent"],
        dilution_rows=[DilutionRow(**d) for d in weights["dilution_rows"]],
    )


# --- Explorer Endpoints (Integration Service Database) ---

from integration_db import fetch_orders, fetch_ingestions_for_order, test_connection


class ExplorerOrderResponse(BaseModel):
    """Schema for order from Integration Service database."""
    id: str
    order_id: str
    order_number: str
    status: str
    samples_expected: int
    samples_delivered: int
    error_message: Optional[str] = None
    payload: Optional[dict] = None
    created_at: datetime
    updated_at: datetime
    completed_at: Optional[datetime] = None


class ExplorerIngestionResponse(BaseModel):
    """Schema for ingestion from Integration Service database."""
    id: str
    sample_id: str
    coa_version: int
    order_ref: Optional[str] = None
    status: str
    s3_key: Optional[str] = None
    verification_code: Optional[str] = None
    error_message: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    completed_at: Optional[datetime] = None
    processing_time_ms: Optional[int] = None


class ExplorerConnectionStatus(BaseModel):
    """Schema for database connection status."""
    connected: bool
    environment: Optional[str] = None
    database: Optional[str] = None
    host: Optional[str] = None
    wordpress_host: Optional[str] = None
    error: Optional[str] = None


class EnvironmentSwitchRequest(BaseModel):
    """Schema for environment switch request."""
    environment: str


class EnvironmentListResponse(BaseModel):
    """Schema for available environments response."""
    environments: list[str]
    current: str


@app.get("/explorer/environments", response_model=EnvironmentListResponse)
async def get_explorer_environments(_current_user=Depends(get_current_user)):
    """Get list of available database environments."""
    from integration_db import get_available_environments, get_environment
    return EnvironmentListResponse(
        environments=get_available_environments(),
        current=get_environment()
    )


@app.post("/explorer/environments", response_model=ExplorerConnectionStatus)
async def set_explorer_environment(request: EnvironmentSwitchRequest, _current_user=Depends(get_current_user)):
    """
    Switch to a different database environment.
    
    Returns the new connection status after switching.
    """
    from integration_db import set_environment
    try:
        set_environment(request.environment)
        result = test_connection()
        return ExplorerConnectionStatus(**result)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        return ExplorerConnectionStatus(connected=False, error=str(e))


@app.get("/explorer/status", response_model=ExplorerConnectionStatus)
async def get_explorer_status(_current_user=Depends(get_current_user)):
    """Test connection to Integration Service database."""
    try:
        result = test_connection()
        return ExplorerConnectionStatus(**result)
    except Exception as e:
        return ExplorerConnectionStatus(connected=False, error=str(e))


@app.get("/explorer/orders", response_model=list[ExplorerOrderResponse])
async def get_explorer_orders(
    search: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    _current_user=Depends(get_current_user),
):
    """
    Get orders from Integration Service database.
    
    Query params:
    - search: Filter by order_id or order_number (partial match)
    - limit: Max records to return (default 50)
    - offset: Pagination offset (default 0)
    """
    try:
        orders = fetch_orders(search=search, limit=limit, offset=offset)
        # Convert UUID to string for JSON serialization
        for order in orders:
            order['id'] = str(order['id'])
        return orders
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail=f"Failed to connect to Integration Service database: {e}"
        )


@app.get("/explorer/orders/{order_id}/ingestions", response_model=list[ExplorerIngestionResponse])
async def get_order_ingestions(order_id: str, _current_user=Depends(get_current_user)):
    """
    Get all ingestions for an order from Integration Service database.
    
    Args:
        order_id: The WordPress order ID (e.g., "12345")
    """
    try:
        ingestions = fetch_ingestions_for_order(order_id)
        # Convert UUID to string for JSON serialization
        for ing in ingestions:
            ing['id'] = str(ing['id'])
        return ingestions
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail=f"Failed to connect to Integration Service database: {e}"
        )


# ── SharePoint Integration ─────────────────────────────────────────

import sharepoint as sp


@app.get("/sharepoint/status")
async def sharepoint_status(_current_user=Depends(get_current_user)):
    """Test SharePoint connection and return site info."""
    return await sp.verify_connection()


@app.get("/sharepoint/browse")
async def sharepoint_browse(
    path: str = "",
    root: str = "lims",
    _current_user=Depends(get_current_user),
):
    """
    Browse folders/files in SharePoint.

    Args:
        path: Relative path within the root (empty = root itself)
        root: Which root — 'lims' (LIMS CSVs) or 'peptides'
    """
    try:
        if root == "lims":
            items = await sp.list_lims_folder(path)
        else:
            items = await sp.list_folder(path)
        return {"path": path, "root": root, "items": items}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SharePoint error: {e}")


@app.get("/sharepoint/sample/{sample_id}/files")
async def sharepoint_sample_files(
    sample_id: str,
    _current_user=Depends(get_current_user),
):
    """
    Find a sample folder and list all CSV/Excel files within it.
    Searches the Peptides root for a sample ID match.
    """
    try:
        result = await sp.get_sample_files(sample_id)
        if not result:
            raise HTTPException(status_code=404, detail=f"Sample '{sample_id}' not found")
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SharePoint error: {e}")


@app.get("/sharepoint/download/{item_id}")
async def sharepoint_download(
    item_id: str,
    _current_user=Depends(get_current_user),
):
    """
    Download a file from SharePoint by its item ID.
    Returns the raw file content.
    """
    from fastapi.responses import Response

    try:
        content, filename = await sp.download_file(item_id)

        # Determine content type
        if filename.lower().endswith(".csv"):
            media_type = "text/csv"
        elif filename.lower().endswith(".xlsx"):
            media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        else:
            media_type = "application/octet-stream"

        return Response(
            content=content,
            media_type=media_type,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SharePoint download error: {e}")


@app.post("/sharepoint/download-batch")
async def sharepoint_download_batch(
    file_ids: list[str],
    _current_user=Depends(get_current_user),
):
    """
    Download multiple files from SharePoint and return their contents.
    Used to fetch all CSVs for HPLC analysis in one request.
    """
    try:
        results = []
        for item_id in file_ids:
            content, filename = await sp.download_file(item_id)
            results.append({
                "id": item_id,
                "filename": filename,
                "content": content.decode("utf-8", errors="replace"),
            })
        return {"files": results}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SharePoint batch download error: {e}")
