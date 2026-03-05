"""
PostgreSQL database setup using SQLAlchemy 2.0.
Connects to accumark_mk1 database on the shared PostgreSQL server.
"""

import os
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

# Load .env file if python-dotenv is available
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass


class Base(DeclarativeBase):
    """Base class for all SQLAlchemy models."""
    pass


def get_database_url() -> str:
    """Build PostgreSQL connection URL from environment variables."""
    host = os.environ.get("MK1_DB_HOST", "localhost")
    port = os.environ.get("MK1_DB_PORT", "5432")
    name = os.environ.get("MK1_DB_NAME", "accumark_mk1")
    user = os.environ.get("MK1_DB_USER", "postgres")
    password = os.environ.get("MK1_DB_PASSWORD", "accumark_dev_secret")
    return f"postgresql+psycopg2://{user}:{password}@{host}:{port}/{name}"


DATABASE_URL = get_database_url()
engine = create_engine(DATABASE_URL, pool_pre_ping=True, echo=False)

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
    import models  # noqa: F401
    # Run column migrations before create_all so ORM mappings match the DB schema
    _run_migrations()
    Base.metadata.create_all(bind=engine)


def _run_migrations():
    """Run lightweight ALTER TABLE migrations for new columns on existing tables.

    Uses IF NOT EXISTS so these are safe to re-run on every startup.
    """
    from sqlalchemy import text
    migrations = [
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS senaite_password_encrypted TEXT",
    ]
    try:
        with engine.connect() as conn:
            for sql in migrations:
                conn.execute(text(sql))
            conn.commit()
    except Exception:
        pass  # Table may not exist yet on first run — create_all handles it
