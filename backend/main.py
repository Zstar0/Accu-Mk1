"""
FastAPI backend for Accu-Mk1.
Provides REST API for scientific calculations, database access, and audit logging.
"""

import json
import os
import secrets
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Optional, Union

from fastapi import FastAPI, Depends, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import select, desc

from database import get_db, init_db
from models import AuditLog, Settings, Job, Sample, Result, Peptide, CalibrationCurve, HPLCAnalysis
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
    # Seed default settings
    from database import SessionLocal
    db = SessionLocal()
    try:
        seed_default_settings(db)
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


@app.post("/audit", response_model=AuditLogResponse)
async def create_audit_log(
    audit_data: AuditLogCreate,
    db: Session = Depends(get_db),
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
):
    """Get recent audit log entries."""
    stmt = select(AuditLog).order_by(desc(AuditLog.created_at)).limit(limit)
    result = db.execute(stmt)
    return result.scalars().all()


# --- Settings Endpoints ---

@app.get("/settings", response_model=list[SettingResponse])
async def get_settings(db: Session = Depends(get_db)):
    """Get all settings."""
    stmt = select(Settings).order_by(Settings.key)
    result = db.execute(stmt)
    return result.scalars().all()


@app.get("/settings/{key}", response_model=SettingResponse)
async def get_setting(key: str, db: Session = Depends(get_db)):
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
async def delete_setting(key: str, db: Session = Depends(get_db)):
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
async def get_watcher_status():
    """Get file watcher status."""
    return file_watcher.status()


@app.post("/watcher/start")
async def start_watcher(db: Session = Depends(get_db)):
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
async def stop_watcher():
    """Stop file watcher."""
    file_watcher.stop()
    return {"status": "stopped"}


@app.get("/watcher/files")
async def get_detected_files():
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
):
    """Get recent jobs."""
    stmt = select(Job).order_by(desc(Job.created_at)).limit(limit)
    result = db.execute(stmt)
    return result.scalars().all()


@app.get("/jobs/{job_id}", response_model=JobResponse)
async def get_job(job_id: int, db: Session = Depends(get_db)):
    """Get a single job by ID."""
    stmt = select(Job).where(Job.id == job_id)
    job = db.execute(stmt).scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    return job


@app.get("/jobs/{job_id}/samples", response_model=list[SampleResponse])
async def get_job_samples(job_id: int, db: Session = Depends(get_db)):
    """Get all samples for a job."""
    stmt = select(Sample).where(Sample.job_id == job_id).order_by(Sample.id)
    result = db.execute(stmt)
    return result.scalars().all()


@app.get("/jobs/{job_id}/samples-with-results", response_model=list[SampleWithResultsResponse])
async def get_job_samples_with_results(job_id: int, db: Session = Depends(get_db)):
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
):
    """Get recent samples."""
    stmt = select(Sample).order_by(desc(Sample.created_at)).limit(limit)
    result = db.execute(stmt)
    return result.scalars().all()


@app.get("/samples/{sample_id}", response_model=SampleResponse)
async def get_sample(sample_id: int, db: Session = Depends(get_db)):
    """Get a single sample by ID."""
    stmt = select(Sample).where(Sample.id == sample_id)
    sample = db.execute(stmt).scalar_one_or_none()
    if not sample:
        raise HTTPException(status_code=404, detail=f"Sample {sample_id} not found")
    return sample


@app.put("/samples/{sample_id}/approve", response_model=SampleResponse)
async def approve_sample(sample_id: int, db: Session = Depends(get_db)):
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
async def get_calculation_types():
    """Get list of available calculation types."""
    return CalculationEngine.get_available_types()


@app.post("/calculate/{sample_id}", response_model=CalculationSummaryResponse)
async def calculate_sample(
    sample_id: int,
    db: Session = Depends(get_db),
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
async def parse_hplc_peakdata(request: HPLCParseBrowserRequest):
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
        return CalibrationCurveResponse.model_validate(cal)
    return None


def _peptide_to_response(db: Session, peptide: Peptide) -> PeptideResponse:
    """Convert Peptide model to response with active calibration."""
    resp = PeptideResponse.model_validate(peptide)
    resp.active_calibration = _get_active_calibration(db, peptide.id)
    return resp


@app.get("/peptides", response_model=list[PeptideResponse])
async def get_peptides(db: Session = Depends(get_db)):
    """Get all peptides with their active calibration curves."""
    stmt = select(Peptide).order_by(Peptide.abbreviation)
    peptides = db.execute(stmt).scalars().all()
    return [_peptide_to_response(db, p) for p in peptides]


@app.post("/peptides", response_model=PeptideResponse, status_code=201)
async def create_peptide(data: PeptideCreate, db: Session = Depends(get_db)):
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
async def update_peptide(peptide_id: int, data: PeptideUpdate, db: Session = Depends(get_db)):
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
async def delete_peptide(peptide_id: int, db: Session = Depends(get_db)):
    """Delete a peptide and all its calibration curves."""
    peptide = db.execute(select(Peptide).where(Peptide.id == peptide_id)).scalar_one_or_none()
    if not peptide:
        raise HTTPException(404, f"Peptide {peptide_id} not found")

    db.delete(peptide)
    db.commit()
    return {"message": f"Peptide '{peptide.abbreviation}' deleted"}


@app.get("/peptides/{peptide_id}/calibrations", response_model=list[CalibrationCurveResponse])
async def get_calibrations(peptide_id: int, db: Session = Depends(get_db)):
    """Get all calibration curves for a peptide (newest first)."""
    peptide = db.execute(select(Peptide).where(Peptide.id == peptide_id)).scalar_one_or_none()
    if not peptide:
        raise HTTPException(404, f"Peptide {peptide_id} not found")

    stmt = (
        select(CalibrationCurve)
        .where(CalibrationCurve.peptide_id == peptide_id)
        .order_by(desc(CalibrationCurve.created_at))
    )
    return db.execute(stmt).scalars().all()


@app.post("/peptides/{peptide_id}/calibrations", response_model=CalibrationCurveResponse, status_code=201)
async def create_calibration(
    peptide_id: int,
    data: CalibrationDataInput,
    db: Session = Depends(get_db),
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
            reference_rt=peptide.reference_rt,
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


@app.get("/hplc/analyses/{analysis_id}", response_model=HPLCAnalysisResponse)
async def get_hplc_analysis(analysis_id: int, db: Session = Depends(get_db)):
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


# --- HPLC Weight Extraction from Lab Excel Files ---


PEPTIDES_ROOT = Path(
    r"C:\Users\forre\Valence Analytical\Communication site - Documents"
    r"\Analytical\Lab Reports\Purity and Quantity (HPLC)\Peptides"
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


def _find_sample_folder(sample_id: str) -> tuple[Optional[Path], Optional[str]]:
    """Search Peptides root for a folder matching the sample ID.

    Returns (sample_folder_path, peptide_folder_name) or (None, None).
    """
    if not PEPTIDES_ROOT.exists():
        return None, None
    # Search all peptide folders for a Raw Data subfolder matching sample_id
    for peptide_dir in PEPTIDES_ROOT.iterdir():
        if not peptide_dir.is_dir():
            continue
        raw_data = peptide_dir / "Raw Data"
        if not raw_data.exists():
            continue
        for sub in raw_data.iterdir():
            if sub.is_dir() and sample_id.upper() in sub.name.upper():
                return sub, peptide_dir.name
    return None, None


def _extract_weights_from_excel(excel_path: Path) -> dict:
    """
    Parse a lab HPLC Excel file for stock + dilution weights.

    Looks for:
    - Stock row: row where col E contains "Stock" (case-insensitive)
      → F = stock_vial_empty, G = stock_vial_with_diluent
    - Dilution rows: rows with numeric data in F, G, H starting after header row 9
      → F = dil_vial_empty, G = + diluent, H = + diluent + sample

    Also handles the alternate layout (Sheet2 / ReRun sheets) where:
    - Stock weights in rows with "Stock Vial+cap" label
    - Dilution weights in cols C, E, H
    """
    import openpyxl

    wb = openpyxl.load_workbook(str(excel_path), data_only=True, read_only=True)
    result = {
        "stock_vial_empty": None,
        "stock_vial_with_diluent": None,
        "dilution_rows": [],
    }

    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]

        # --- Try "Sample" sheet layout (F/G/H columns, Stock in row with "Stock" in col E) ---
        stock_empty = None
        stock_diluent = None
        dilutions = []

        for row in range(1, 40):
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
            # Real vial weights are 2000-6000mg and must increase:
            # empty < +diluent < +diluent+sample
            if (isinstance(f_val, (int, float)) and f_val > 2000
                    and isinstance(g_val, (int, float)) and g_val > f_val
                    and isinstance(h_val, (int, float)) and h_val >= g_val):
                # Get concentration label from col E
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

        # --- Try alternate layout (C/E/H columns) ---
        for row in range(1, 40):
            a_val = ws.cell(row=row, column=1).value  # col A
            b_val = ws.cell(row=row, column=2).value  # col B

            # Look for stock vial labels in col A
            if a_val and isinstance(a_val, str):
                lower = a_val.lower()
                if "stock vial+cap" in lower or "stock vial + cap" in lower:
                    if isinstance(b_val, (int, float)):
                        stock_empty = float(b_val)
                elif "stock peptide+vial" in lower or "stock vial+cap+diluent" in lower:
                    if isinstance(b_val, (int, float)):
                        stock_diluent = float(b_val)

        # Also scan for C/E/H dilution layout
        alt_dilutions = []
        for row in range(1, 40):
            a_val = ws.cell(row=row, column=1).value
            c_val = ws.cell(row=row, column=3).value  # col C
            e_val = ws.cell(row=row, column=5).value  # col E
            h_val = ws.cell(row=row, column=8).value  # col H

            if (isinstance(c_val, (int, float)) and c_val > 2000
                    and isinstance(e_val, (int, float)) and e_val > c_val
                    and isinstance(h_val, (int, float)) and h_val >= e_val):
                label = str(a_val) if a_val else f"Row {row}"
                if "stock" in label.lower():
                    # Stock row in C/E layout: C=empty, E=with diluent
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
async def get_sample_weights(sample_id: str):
    """
    Search the Peptides lab folder for a sample ID and extract weight data
    from the associated Excel workbook.
    """
    folder, peptide_folder = _find_sample_folder(sample_id)
    if not folder:
        return WeightExtractionResponse(
            found=False,
            error=f"No folder matching '{sample_id}' found in Peptides root"
        )

    # Find the lab workbook Excel file (P-XXXX_Samp_* or P-XXXX_Std_*)
    # Skip Agilent data exports (contain ".dx_" or "_PeakData" in name)
    excel_path = None
    search_dirs = [folder / "1290", folder]
    for search_dir in search_dirs:
        if not search_dir.exists():
            continue
        candidates = []
        for f in search_dir.iterdir():
            if f.suffix != ".xlsx" or f.name.startswith("~$"):
                continue
            # Skip Agilent instrument data exports
            if ".dx_" in f.name or "_PeakData" in f.name:
                continue
            candidates.append(f)
        # Prefer files matching P-XXXX_Samp_* or P-XXXX_Std_* patterns
        for c in candidates:
            if "_Samp_" in c.name or "_Std_" in c.name:
                excel_path = c
                break
        if not excel_path and candidates:
            excel_path = candidates[0]
        if excel_path:
            break

    if not excel_path:
        return WeightExtractionResponse(
            found=True,
            folder_name=folder.name,
            peptide_folder=peptide_folder,
            error="No Excel file found in sample folder"
        )

    try:
        weights = _extract_weights_from_excel(excel_path)
    except Exception as e:
        return WeightExtractionResponse(
            found=True,
            folder_name=folder.name,
            peptide_folder=peptide_folder,
            excel_filename=excel_path.name,
            error=f"Error parsing Excel: {e}"
        )

    return WeightExtractionResponse(
        found=True,
        folder_name=folder.name,
        peptide_folder=peptide_folder,
        excel_filename=excel_path.name,
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
async def get_explorer_environments(api_key: str = Depends(verify_api_key)):
    """Get list of available database environments."""
    from integration_db import get_available_environments, get_environment
    return EnvironmentListResponse(
        environments=get_available_environments(),
        current=get_environment()
    )


@app.post("/explorer/environments", response_model=ExplorerConnectionStatus)
async def set_explorer_environment(request: EnvironmentSwitchRequest, api_key: str = Depends(verify_api_key)):
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
async def get_explorer_status(api_key: str = Depends(verify_api_key)):
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
    api_key: str = Depends(verify_api_key),
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
async def get_order_ingestions(order_id: str, api_key: str = Depends(verify_api_key)):
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

