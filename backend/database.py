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
