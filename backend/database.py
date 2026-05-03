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
engine = create_engine(DATABASE_URL, pool_pre_ping=True, echo=False, pool_size=10, max_overflow=20)

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
        "ALTER TABLE peptides ADD COLUMN IF NOT EXISTS is_blend BOOLEAN DEFAULT FALSE",
        "ALTER TABLE peptide_analytes ADD COLUMN IF NOT EXISTS component_peptide_id INTEGER REFERENCES peptides(id) ON DELETE SET NULL",
        # Multi-vial blend support
        "ALTER TABLE peptides ADD COLUMN IF NOT EXISTS prep_vial_count INTEGER DEFAULT 1",
        "ALTER TABLE wizard_sessions ADD COLUMN IF NOT EXISTS vial_params JSONB",
        "ALTER TABLE wizard_measurements ADD COLUMN IF NOT EXISTS vial_number INTEGER DEFAULT 1",
        "ALTER TABLE blend_components ADD COLUMN IF NOT EXISTS vial_number INTEGER DEFAULT 1",
        # Phase 09: CalibrationCurve chromatogram storage
        "ALTER TABLE calibration_curves ADD COLUMN IF NOT EXISTS chromatogram_data JSON",
        "ALTER TABLE calibration_curves ADD COLUMN IF NOT EXISTS source_sharepoint_folder VARCHAR(1000)",
        # Phase 09: Standard prep metadata on wizard sessions
        "ALTER TABLE wizard_sessions ADD COLUMN IF NOT EXISTS is_standard BOOLEAN DEFAULT FALSE",
        "ALTER TABLE wizard_sessions ADD COLUMN IF NOT EXISTS manufacturer VARCHAR(200)",
        "ALTER TABLE wizard_sessions ADD COLUMN IF NOT EXISTS standard_notes TEXT",
        "ALTER TABLE wizard_sessions ADD COLUMN IF NOT EXISTS instrument_name VARCHAR(200)",
        # Instrument FK columns on calibration_curves and wizard_sessions
        "ALTER TABLE calibration_curves ADD COLUMN IF NOT EXISTS instrument_id INTEGER REFERENCES instruments(id)",
        "ALTER TABLE calibration_curves ALTER COLUMN instrument TYPE VARCHAR(100)",
        "ALTER TABLE wizard_sessions ADD COLUMN IF NOT EXISTS instrument_id INTEGER REFERENCES instruments(id)",
        # Backfill instrument_id on existing calibration_curves by matching stored instrument string
        # Matches on exact name first, then falls back to model substring match
        """
        UPDATE calibration_curves cc
        SET instrument_id = i.id
        FROM instruments i
        WHERE cc.instrument_id IS NULL
          AND cc.instrument IS NOT NULL
          AND (cc.instrument = i.name OR cc.instrument ILIKE '%' || i.model || '%')
        """,
        # Backfill instrument_id on wizard_sessions from instrument_name
        """
        UPDATE wizard_sessions ws
        SET instrument_id = i.id
        FROM instruments i
        WHERE ws.instrument_id IS NULL
          AND ws.instrument_name IS NOT NULL
          AND (ws.instrument_name = i.name OR ws.instrument_name ILIKE '%' || i.model || '%')
        """,
        # Fix FK constraint: allow cascade SET NULL when calibration curve is deleted
        """DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.table_constraints
                       WHERE constraint_name = 'wizard_sessions_calibration_curve_id_fkey'
                       AND table_name = 'wizard_sessions') THEN
                ALTER TABLE wizard_sessions DROP CONSTRAINT wizard_sessions_calibration_curve_id_fkey;
                ALTER TABLE wizard_sessions ADD CONSTRAINT wizard_sessions_calibration_curve_id_fkey
                    FOREIGN KEY (calibration_curve_id) REFERENCES calibration_curves(id) ON DELETE SET NULL;
            END IF;
        END $$""",
        # Phase 10.5: HPLC results provenance columns
        "ALTER TABLE hplc_analyses ADD COLUMN IF NOT EXISTS calibration_curve_id INTEGER REFERENCES calibration_curves(id) ON DELETE SET NULL",
        "ALTER TABLE hplc_analyses ADD COLUMN IF NOT EXISTS sample_prep_id INTEGER",
        "ALTER TABLE hplc_analyses ADD COLUMN IF NOT EXISTS instrument_id INTEGER REFERENCES instruments(id)",
        "ALTER TABLE hplc_analyses ADD COLUMN IF NOT EXISTS source_sharepoint_folder VARCHAR(1000)",
        "ALTER TABLE hplc_analyses ADD COLUMN IF NOT EXISTS chromatogram_data JSON",
        "ALTER TABLE hplc_analyses ADD COLUMN IF NOT EXISTS run_group_id VARCHAR(200)",
        # Peptide HPLC aliases — alternate names used in chromatogram filenames
        "ALTER TABLE peptides ADD COLUMN IF NOT EXISTS hplc_aliases JSON",
        # Customer-facing display aliases — approved alternate names shown on COA
        "ALTER TABLE peptides ADD COLUMN IF NOT EXISTS display_aliases JSON",
        # Per-sample analyte display-alias picks (denormalized — survives changes to peptides.display_aliases)
        """
        CREATE TABLE IF NOT EXISTS sample_analyte_aliases (
            id SERIAL PRIMARY KEY,
            senaite_sample_id VARCHAR(100) NOT NULL,
            slot INTEGER NOT NULL CHECK (slot >= 1 AND slot <= 4),
            alias VARCHAR(200) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_by_user_id INTEGER,
            updated_by_email VARCHAR(320),
            CONSTRAINT uq_sample_analyte_slot UNIQUE (senaite_sample_id, slot)
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_sample_analyte_aliases_sample_id ON sample_analyte_aliases (senaite_sample_id)",
        # Phase 13.5: Debug log persistence for audit trail
        "ALTER TABLE hplc_analyses ADD COLUMN IF NOT EXISTS debug_log JSON",
        # User tracking columns
        "ALTER TABLE peptides ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER",
        "ALTER TABLE peptides ADD COLUMN IF NOT EXISTS created_by_email VARCHAR(320)",
        "ALTER TABLE peptides ADD COLUMN IF NOT EXISTS updated_by_user_id INTEGER",
        "ALTER TABLE peptides ADD COLUMN IF NOT EXISTS updated_by_email VARCHAR(320)",
        "ALTER TABLE calibration_curves ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER",
        "ALTER TABLE calibration_curves ADD COLUMN IF NOT EXISTS created_by_email VARCHAR(320)",
        "ALTER TABLE calibration_curves ADD COLUMN IF NOT EXISTS updated_by_user_id INTEGER",
        "ALTER TABLE calibration_curves ADD COLUMN IF NOT EXISTS updated_by_email VARCHAR(320)",
        "ALTER TABLE hplc_analyses ADD COLUMN IF NOT EXISTS processed_by_user_id INTEGER",
        "ALTER TABLE hplc_analyses ADD COLUMN IF NOT EXISTS processed_by_email VARCHAR(320)",
        # Phase 17: Worksheet item SENAITE received date + prep status
        "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS date_received TIMESTAMP",
        "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS prep_status VARCHAR(20) DEFAULT 'ready'",
        # Phase 15: AnalysisService peptide link
        "ALTER TABLE analysis_services ADD COLUMN IF NOT EXISTS peptide_id INTEGER REFERENCES peptides(id) ON DELETE SET NULL",
        # Phase 17: Worksheet completion tracking
        "ALTER TABLE worksheets ADD COLUMN IF NOT EXISTS completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL",
        "ALTER TABLE worksheets ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP",
        # Method-Instrument M2M migration: move from hplc_methods.instrument_id FK to junction table
        """DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'hplc_methods' AND column_name = 'instrument_id')
            THEN
                CREATE TABLE IF NOT EXISTS instrument_methods (
                    id SERIAL PRIMARY KEY,
                    instrument_id INTEGER NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
                    method_id INTEGER NOT NULL REFERENCES hplc_methods(id) ON DELETE CASCADE,
                    CONSTRAINT uq_instrument_method UNIQUE (instrument_id, method_id)
                );
                INSERT INTO instrument_methods (instrument_id, method_id)
                SELECT instrument_id, id FROM hplc_methods
                WHERE instrument_id IS NOT NULL
                ON CONFLICT DO NOTHING;
                ALTER TABLE hplc_methods DROP COLUMN instrument_id;
            END IF;
        END $$""",
        # Sub-Samples feature: LIMS-side master table + sub-samples table
        """
        CREATE TABLE IF NOT EXISTS lims_samples (
            id SERIAL PRIMARY KEY,
            sample_id VARCHAR(100) NOT NULL UNIQUE,
            external_lims_uid VARCHAR(100),
            external_lims_system VARCHAR(50) DEFAULT 'senaite',
            client_id VARCHAR(100),
            client_uid VARCHAR(100),
            contact_uid VARCHAR(100),
            sample_type VARCHAR(100),
            status VARCHAR(50),
            peptide_name VARCHAR(200),
            client_sample_id VARCHAR(200),
            date_sampled TIMESTAMP,
            date_received TIMESTAMP,
            is_retest BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_lims_samples_external_lims_uid ON lims_samples (external_lims_uid)",
        """
        CREATE TABLE IF NOT EXISTS lims_sub_samples (
            id SERIAL PRIMARY KEY,
            parent_sample_pk INTEGER NOT NULL REFERENCES lims_samples(id) ON DELETE CASCADE,
            external_lims_uid VARCHAR(100) NOT NULL UNIQUE,
            sample_id VARCHAR(100) NOT NULL UNIQUE,
            vial_sequence INTEGER NOT NULL,
            received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            received_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            photo_external_uid VARCHAR(100),
            remarks TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT uq_lims_parent_vial_sequence UNIQUE (parent_sample_pk, vial_sequence)
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_lims_sub_samples_parent_pk ON lims_sub_samples (parent_sample_pk)",
        # Analyte class discriminator: distinguishes peptide rows from non-peptide HPLC analytes (e.g. Benzyl Alcohol additive in Bac Water).
        # Backfills existing rows to 'peptide' on add; new non-peptide entries set 'additive' explicitly.
        "ALTER TABLE peptides ADD COLUMN IF NOT EXISTS analyte_class VARCHAR(20) NOT NULL DEFAULT 'peptide'",
        # Rename short 'BA' abbreviation from earlier dev iterations to the spelled-out form.
        # Safe no-op on fresh installs (no row matches) and on already-renamed deployments.
        """
        UPDATE peptides SET abbreviation='Benzyl Alcohol'
        WHERE abbreviation='BA' AND name='Benzyl Alcohol'
        """,
        # Seed Benzyl Alcohol as a non-peptide analyte for Bacteriostatic Water HPLC processing.
        # Idempotent via abbreviation unique constraint. Explicit values for active/created_at/
        # updated_at because those columns are NOT NULL without DB-level defaults (ORM defaults
        # only apply on the Python side, not on raw SQL inserts).
        """
        INSERT INTO peptides (name, abbreviation, is_blend, analyte_class, active, created_at, updated_at)
        VALUES ('Benzyl Alcohol', 'Benzyl Alcohol', FALSE, 'additive', TRUE, NOW(), NOW())
        ON CONFLICT (abbreviation) DO NOTHING
        """,
        # Phase 25: vial assignment role columns
        # lims_samples: parent AR's role. Defaults to 'hplc' per the
        # "primary always HPLC for now" rule. Backfilled to 'hplc' for
        # all existing rows.
        "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS assignment_role VARCHAR(8) DEFAULT 'hplc'",
        "UPDATE lims_samples SET assignment_role = 'hplc' WHERE assignment_role IS NULL",
        # lims_sub_samples: nullable. NULL means "auto-assign hasn't run yet".
        "ALTER TABLE lims_sub_samples ADD COLUMN IF NOT EXISTS assignment_role VARCHAR(8)",
    ]
    try:
        with engine.connect() as conn:
            for sql in migrations:
                conn.execute(text(sql))
            conn.commit()
    except Exception:
        pass  # Table may not exist yet on first run — create_all handles it
