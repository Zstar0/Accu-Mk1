"""
SQLite database setup using SQLAlchemy 2.0.
Database file stored at ./data/accu-mk1.db relative to working directory.
"""

import os
from pathlib import Path
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker


class Base(DeclarativeBase):
    """Base class for all SQLAlchemy models."""
    pass


def get_database_path() -> Path:
    """Get the database file path, creating data directory if needed."""
    data_dir = Path("./data")
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir / "accu-mk1.db"


# Create engine with SQLite
DATABASE_URL = f"sqlite:///{get_database_path()}"
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},  # Required for SQLite with FastAPI
    echo=False,
)

# Session maker for dependency injection
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db():
    """
    Dependency that provides a database session.
    Use with FastAPI Depends().
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """Initialize database tables."""
    # Import models to register them with Base
    import models
    Base.metadata.create_all(bind=engine)

    # Migrations: add new columns to existing tables
    from sqlalchemy import text
    with engine.connect() as conn:
        # Add source_path column to calibration_curves (added Feb 2026)
        try:
            conn.execute(text("ALTER TABLE calibration_curves ADD COLUMN source_path VARCHAR(1000)"))
            conn.commit()
        except Exception:
            pass  # Column already exists
        try:
            conn.execute(text("ALTER TABLE calibration_curves ADD COLUMN source_date DATETIME"))
            conn.commit()
        except Exception:
            pass  # Column already exists
        try:
            conn.execute(text("ALTER TABLE calibration_curves ADD COLUMN sharepoint_url VARCHAR(2000)"))
            conn.commit()
        except Exception:
            pass  # Column already exists
        # Standard metadata columns (added Feb 2026)
        new_cols = [
            "ALTER TABLE calibration_curves ADD COLUMN instrument VARCHAR(10)",
            "ALTER TABLE calibration_curves ADD COLUMN vendor VARCHAR(100)",
            "ALTER TABLE calibration_curves ADD COLUMN lot_number VARCHAR(100)",
            "ALTER TABLE calibration_curves ADD COLUMN batch_number VARCHAR(100)",
            "ALTER TABLE calibration_curves ADD COLUMN cap_color VARCHAR(50)",
            "ALTER TABLE calibration_curves ADD COLUMN run_date DATETIME",
            "ALTER TABLE calibration_curves ADD COLUMN standard_weight_mg FLOAT",
            "ALTER TABLE calibration_curves ADD COLUMN stock_concentration_ug_ml FLOAT",
            "ALTER TABLE calibration_curves ADD COLUMN diluent VARCHAR(200)",
            "ALTER TABLE calibration_curves ADD COLUMN column_type VARCHAR(200)",
            "ALTER TABLE calibration_curves ADD COLUMN wavelength_nm FLOAT",
            "ALTER TABLE calibration_curves ADD COLUMN flow_rate_ml_min FLOAT",
            "ALTER TABLE calibration_curves ADD COLUMN injection_volume_ul FLOAT",
            "ALTER TABLE calibration_curves ADD COLUMN operator VARCHAR(100)",
            "ALTER TABLE calibration_curves ADD COLUMN notes TEXT",
        ]
        for sql in new_cols:
            try:
                conn.execute(text(sql))
                conn.commit()
            except Exception:
                pass  # Column already exists
