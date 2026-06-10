"""
PostgreSQL database setup using SQLAlchemy 2.0.
Connects to accumark_mk1 database on the shared PostgreSQL server.
"""

import logging
import os
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

log = logging.getLogger(__name__)

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


def seed_federal_holidays(conn, year: int) -> int:
    """Insert any missing federal holiday rows for `year`.

    Idempotent via ON CONFLICT (holiday_date) DO NOTHING. `conn` is a SQLAlchemy
    Connection; the caller owns the transaction (engine.begin() at startup, or the
    request session's connection in the generate-federal endpoint). Returns the
    number of rows actually inserted. Shared by startup seeding and the endpoint.
    """
    from sqlalchemy import text
    from holidays_us import us_federal_holidays

    added = 0
    for d, name in sorted(us_federal_holidays(year).items()):
        result = conn.execute(
            text(
                "INSERT INTO lab_holidays (holiday_date, name, source, created_at) "
                "VALUES (:d, :n, 'federal', NOW()) "
                "ON CONFLICT (holiday_date) DO NOTHING"
            ),
            {"d": d, "n": name},
        )
        added += result.rowcount or 0
    return added


def _seed_federal_holidays_window() -> None:
    """First-boot-ONLY seed of federal holidays for the rolling window
    (current + next 2 years), gated by a settings flag.

    Why first-boot-only: deleting a federal row is how the lab opts out of a
    holiday it works. If this re-ran every boot, ON CONFLICT DO NOTHING would
    re-insert any deleted (absent) row — resurrecting opt-outs. The settings
    flag makes the seeder a no-op after the first successful run, so deletions
    survive restarts. New years enter coverage only via the explicit
    POST /lab-holidays/generate-federal action. Wrapped so a failure never
    blocks boot.
    """
    from sqlalchemy import text
    from datetime import date as _date

    try:
        with engine.begin() as conn:
            already = conn.execute(
                text("SELECT value FROM settings WHERE key='business_hours_federal_initial_seeded'")
            ).scalar()
            if already == "true":
                return
            base = _date.today().year
            for year in (base, base + 1, base + 2):
                seed_federal_holidays(conn, year)
            conn.execute(
                text(
                    "INSERT INTO settings (key, value, updated_at) "
                    "VALUES ('business_hours_federal_initial_seeded', 'true', NOW()) "
                    "ON CONFLICT (key) DO UPDATE SET value='true', updated_at=NOW()"
                )
            )
    except Exception as e:
        log.warning("federal_holiday_seed_skipped err=%s", e)


def init_db():
    """Initialize database tables."""
    # Import models to register them with Base
    import models  # noqa: F401
    # Run column migrations before create_all so ORM mappings match the DB schema
    _run_migrations()
    Base.metadata.create_all(bind=engine)
    _seed_federal_holidays_window()


def _run_migrations():
    """Run lightweight ALTER TABLE migrations for new columns on existing tables.

    Uses IF NOT EXISTS so these are safe to re-run on every startup.
    """
    from sqlalchemy import text
    migrations = [
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS senaite_password_encrypted TEXT",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100)",
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
        # Bind Benzyl Alcohol to its SENAITE analysis service (slot 1) so the
        # Import Curves dialog and any other UI keyed on peptide.analytes can
        # surface it. The peptide row above is created via raw SQL (no UI
        # path), which doesn't insert peptide_analytes — recreating BA via
        # the wizard isn't a fix because the create form doesn't expose
        # analyte_class. Lookup by abbreviation + keyword keeps it
        # environment-agnostic. Silently no-ops on a fresh install where
        # the SENAITE-synced analysis_services row doesn't exist yet; the
        # next startup picks it up. Safe to re-run.
        """
        INSERT INTO peptide_analytes (peptide_id, analysis_service_id, slot, created_at)
        SELECT p.id, ans.id, 1, NOW()
        FROM peptides p
        JOIN analysis_services ans ON ans.keyword = 'Benzyl_Alcohol_Assay'
        WHERE p.abbreviation = 'Benzyl Alcohol'
        ON CONFLICT (peptide_id, slot) DO NOTHING
        """,
        # Phase 25: vial assignment role columns
        # lims_samples: parent AR's role. Defaults to 'hplc' per the
        # "primary always HPLC for now" rule. Backfilled to 'hplc' for
        # all existing rows.
        "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS assignment_role VARCHAR(8) DEFAULT 'hplc'",
        "UPDATE lims_samples SET assignment_role = 'hplc' WHERE assignment_role IS NULL",
        # lims_sub_samples: nullable. NULL means "auto-assign hasn't run yet".
        "ALTER TABLE lims_sub_samples ADD COLUMN IF NOT EXISTS assignment_role VARCHAR(8)",
        # Variance set membership + lock state (worksheet-variance design 2026-06-02)
        "ALTER TABLE lims_sub_samples ADD COLUMN IF NOT EXISTS in_variance_set BOOLEAN NOT NULL DEFAULT TRUE",
        "ALTER TABLE lims_sub_samples ADD COLUMN IF NOT EXISTS variance_exclusion_reason TEXT",
        "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS in_variance_set BOOLEAN NOT NULL DEFAULT TRUE",
        "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS variance_exclusion_reason TEXT",
        "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS variance_locked_at TIMESTAMP",
        "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS variance_locked_by_user_id INTEGER REFERENCES users(id)",
        # Backfill — non-HPLC sub-samples are not variance candidates by default.
        # Idempotent: re-running matches no rows once already flipped.
        """UPDATE lims_sub_samples
              SET in_variance_set = FALSE,
                  variance_exclusion_reason = 'auto: assignment_role != hplc'
            WHERE assignment_role IN ('endo', 'ster', 'xtra')
              AND in_variance_set = TRUE""",
        # ── SLA tiers (revises the former sla_targets model) ──
        # Drop the old per-(service,priority) model and its indexes.
        "DROP TABLE IF EXISTS sla_targets CASCADE",
        # Named SLA tier = a turnaround target. Referenced by service groups and
        # by the priority map. Raw DDL before create_all so the seed/index below
        # can run on first boot; the SlaTier ORM model maps the same table.
        """
        CREATE TABLE IF NOT EXISTS sla_tiers (
            id                  SERIAL PRIMARY KEY,
            name                VARCHAR(100) NOT NULL,
            target_minutes      INTEGER NOT NULL,
            business_hours_only BOOLEAN NOT NULL DEFAULT FALSE,
            is_default          BOOLEAN NOT NULL DEFAULT FALSE,
            created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """,
        # At most one default (catch-all) tier.
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_sla_tier_single_default ON sla_tiers (is_default) WHERE is_default",
        # Sparse priority -> tier override map. A row exists ONLY for priorities
        # that override; absence means "does not override".
        """
        CREATE TABLE IF NOT EXISTS sla_priority_tiers (
            priority    VARCHAR(20) PRIMARY KEY,
            sla_tier_id INTEGER NOT NULL REFERENCES sla_tiers(id) ON DELETE CASCADE,
            updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """,
        # Service groups reference a tier (NULL -> resolves to the default tier).
        "ALTER TABLE service_groups ADD COLUMN IF NOT EXISTS sla_tier_id INTEGER REFERENCES sla_tiers(id) ON DELETE SET NULL",
        # Seed the default tier at 48h (2d). Idempotent — only inserts when no
        # default exists yet, so it sets the starting target on a fresh DB.
        """
        INSERT INTO sla_tiers (name, target_minutes, business_hours_only, is_default, created_at, updated_at)
        SELECT 'Standard', 2880, FALSE, TRUE, NOW(), NOW()
        WHERE NOT EXISTS (SELECT 1 FROM sla_tiers WHERE is_default)
        """,
        # D2: per-tier amber threshold (idempotent ALTER, existing rows get 20).
        "ALTER TABLE sla_tiers ADD COLUMN IF NOT EXISTS amber_threshold_percent INTEGER NOT NULL DEFAULT 20",
        # Multi-tier follow-on: priority overrides can now be scoped to a single
        # service group. service_group_id IS NULL preserves the original
        # "applies globally" semantics for any existing rows. Precedence on the
        # frontend resolver becomes (priority, group_id) > (priority, NULL) >
        # group's own tier > default. The old PRIMARY KEY (priority) no longer
        # suffices because multiple rows can share a priority; a SERIAL `id`
        # becomes the new PK, and two PARTIAL UNIQUE indexes enforce
        # one-global-per-priority + one-per-(priority,group). Each statement is
        # idempotent or harmless when re-run (per-statement isolation already
        # in place below).
        "ALTER TABLE sla_priority_tiers ADD COLUMN IF NOT EXISTS service_group_id INTEGER REFERENCES service_groups(id) ON DELETE CASCADE",
        "ALTER TABLE sla_priority_tiers DROP CONSTRAINT IF EXISTS sla_priority_tiers_pkey",
        "ALTER TABLE sla_priority_tiers ADD COLUMN IF NOT EXISTS id SERIAL",
        "ALTER TABLE sla_priority_tiers ADD CONSTRAINT sla_priority_tiers_pkey PRIMARY KEY (id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_sla_priority_global ON sla_priority_tiers (priority) WHERE service_group_id IS NULL",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_sla_priority_per_group ON sla_priority_tiers (priority, service_group_id) WHERE service_group_id IS NOT NULL",
        # ── Business-hours SLA calendar (sub-project B) ──
        """
        CREATE TABLE IF NOT EXISTS business_hours_config (
            id           INTEGER PRIMARY KEY,
            open_time    TIME NOT NULL,
            close_time   TIME NOT NULL,
            timezone     VARCHAR(64) NOT NULL DEFAULT 'America/Los_Angeles',
            working_days JSON NOT NULL,
            created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """,
        # Seed the singleton: 09:00-17:00, Mon-Fri, Pacific. Idempotent.
        """
        INSERT INTO business_hours_config (id, open_time, close_time, timezone, working_days, created_at, updated_at)
        SELECT 1, '09:00', '17:00', 'America/Los_Angeles', '[0,1,2,3,4]', NOW(), NOW()
        WHERE NOT EXISTS (SELECT 1 FROM business_hours_config)
        """,
        """
        CREATE TABLE IF NOT EXISTS lab_holidays (
            id           SERIAL PRIMARY KEY,
            holiday_date DATE NOT NULL UNIQUE,
            name         VARCHAR(100) NOT NULL,
            source       VARCHAR(10) NOT NULL DEFAULT 'custom',
            created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """,
        # ── COA roll-up Phase 1: pins + per-generation manifest + reportable sidecar ──
        # See docs/superpowers/specs/2026-06-02-coa-rollup-override-design.md
        # Manager intent: one pin per (parent, analyte), upserted from the
        # COA Sources override panel. Audit history lives in SampleActivityLog.
        """
        CREATE TABLE IF NOT EXISTS coa_result_pins (
            id                    SERIAL PRIMARY KEY,
            parent_sample_id      TEXT NOT NULL,
            analyte_keyword       TEXT NOT NULL,
            mode                  TEXT NOT NULL
                                  CHECK (mode IN ('pin', 'auto', 'variance_set')),
            source_sample_id      TEXT,
            source_analysis_uid   TEXT,
            reason                TEXT,
            pinned_by_user_id     INTEGER REFERENCES users(id),
            pinned_at             TIMESTAMP NOT NULL DEFAULT NOW(),
            UNIQUE (parent_sample_id, analyte_keyword)
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_coa_result_pins_parent ON coa_result_pins (parent_sample_id)",
        # Frozen per-generation manifest. generation_id is the integration-DB
        # coa_generations.id (UUID); no FK because the two databases are
        # separate (IS migrations gated on Phase 3b).
        """
        CREATE TABLE IF NOT EXISTS coa_generation_sources (
            id                          SERIAL PRIMARY KEY,
            generation_id               UUID NOT NULL,
            generation_number           INTEGER NOT NULL,
            parent_sample_id            TEXT NOT NULL,
            analyte_keyword             TEXT NOT NULL,
            source_sample_id            TEXT NOT NULL,
            source_analysis_uid         TEXT NOT NULL,
            result_value                TEXT,
            result_unit                 TEXT,
            candidates_count            INTEGER NOT NULL,
            resolution_mode             TEXT NOT NULL
                                        CHECK (resolution_mode IN
                                          ('auto', 'pin', 'variance_set',
                                           'stale_pin_fallback')),
            candidates_snapshot         JSONB,
            created_at                  TIMESTAMP NOT NULL DEFAULT NOW(),
            UNIQUE (generation_id, analyte_keyword)
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_coa_generation_sources_parent ON coa_generation_sources (parent_sample_id)",
        "CREATE INDEX IF NOT EXISTS ix_coa_generation_sources_gen ON coa_generation_sources (generation_id)",
        # Per-instance "fit to report" boolean. SENAITE analyses have no Mk1
        # mirror table, so the flag lives in a sidecar keyed by
        # (sample_id, analysis_uid). Default TRUE — absence of a row means
        # the analysis IS reportable. Rows are only inserted on flip.
        """
        CREATE TABLE IF NOT EXISTS analysis_reportable (
            sample_id           TEXT NOT NULL,
            analysis_uid        TEXT NOT NULL,
            reportable          BOOLEAN NOT NULL DEFAULT TRUE,
            reason              TEXT,
            changed_by_user_id  INTEGER REFERENCES users(id),
            changed_at          TIMESTAMP NOT NULL DEFAULT NOW(),
            PRIMARY KEY (sample_id, analysis_uid)
        )
        """,
        # ── Mk1-native analyses (spec 2026-06-02-mk1-native-analyses-design.md) ──
        # Polymorphic host: each row belongs to either a parent (lims_sample_pk) or
        # a sub-sample (lims_sub_sample_pk), enforced by CHECK + the partial unique
        # indexes below. Service identity is denormalized for fast filtering.
        """
        CREATE TABLE IF NOT EXISTS lims_analyses (
            id                    SERIAL PRIMARY KEY,
            lims_sample_pk        INTEGER REFERENCES lims_samples(id) ON DELETE CASCADE,
            lims_sub_sample_pk    INTEGER REFERENCES lims_sub_samples(id) ON DELETE CASCADE,
            CHECK ((lims_sample_pk IS NULL) <> (lims_sub_sample_pk IS NULL)),

            analysis_service_id   INTEGER NOT NULL REFERENCES analysis_services(id) ON DELETE RESTRICT,
            keyword               TEXT NOT NULL,
            title                 TEXT NOT NULL,

            result_value          TEXT,
            result_unit           TEXT,

            review_state          TEXT NOT NULL DEFAULT 'unassigned'
                                  CONSTRAINT lims_analyses_review_state_check
                                  CHECK (review_state IN (
                                      'unassigned', 'assigned', 'to_be_verified',
                                      'verified', 'published', 'rejected', 'retracted',
                                      'promoted', 'variance_verified'
                                  )),

            method_id             INTEGER REFERENCES hplc_methods(id) ON DELETE SET NULL,
            instrument_id         INTEGER REFERENCES instruments(id) ON DELETE SET NULL,
            analyst_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,

            captured_at           TIMESTAMP,
            submitted_at          TIMESTAMP,
            verified_at           TIMESTAMP,
            published_at          TIMESTAMP,

            retested              BOOLEAN NOT NULL DEFAULT FALSE,
            retest_of_id          INTEGER REFERENCES lims_analyses(id) ON DELETE SET NULL,

            reportable            BOOLEAN NOT NULL DEFAULT TRUE,
            reportable_reason     TEXT,

            created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at            TIMESTAMP NOT NULL DEFAULT NOW(),
            created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_lims_analyses_sample        ON lims_analyses (lims_sample_pk)",
        "CREATE INDEX IF NOT EXISTS ix_lims_analyses_sub_sample    ON lims_analyses (lims_sub_sample_pk)",
        "CREATE INDEX IF NOT EXISTS ix_lims_analyses_keyword       ON lims_analyses (keyword)",
        "CREATE INDEX IF NOT EXISTS ix_lims_analyses_review_state  ON lims_analyses (review_state)",
        # One non-retest row per (host, keyword). Retests share keyword but
        # are linked via retest_of_id and excluded from the uniqueness check
        # via the partial index predicate.
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_analyses_sub_service_root
            ON lims_analyses (lims_sub_sample_pk, keyword)
            WHERE retest_of_id IS NULL AND lims_sub_sample_pk IS NOT NULL
        """,
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_analyses_parent_service_root
            ON lims_analyses (lims_sample_pk, keyword)
            WHERE retest_of_id IS NULL AND lims_sample_pk IS NOT NULL
        """,
        # Per-transition audit log. Every state change writes a row.
        """
        CREATE TABLE IF NOT EXISTS lims_analysis_transitions (
            id                SERIAL PRIMARY KEY,
            analysis_id       INTEGER NOT NULL REFERENCES lims_analyses(id) ON DELETE CASCADE,
            from_state        TEXT,
            to_state          TEXT NOT NULL,
            transition_kind   TEXT NOT NULL
                              CHECK (transition_kind IN
                                  ('assign','submit','verify','retract','reject',
                                   'retest','publish','reset','auto','variance_verify')),
            user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
            reason            TEXT,
            occurred_at       TIMESTAMP NOT NULL DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_lims_analysis_transitions_analysis ON lims_analysis_transitions (analysis_id)",
        # Phase 4a: promotion link table. Records which vial-tier source rows
        # contributed to a parent-tier canonical result, and how (chosen vs
        # reference vs aggregated_in). Written atomically by promote_to_parent.
        """
        CREATE TABLE IF NOT EXISTS lims_analysis_promotions (
            id                       SERIAL PRIMARY KEY,
            parent_analysis_id       INTEGER NOT NULL
                                     REFERENCES lims_analyses(id) ON DELETE CASCADE,
            source_analysis_id       INTEGER NOT NULL
                                     REFERENCES lims_analyses(id) ON DELETE CASCADE,
            contribution_kind        TEXT NOT NULL
                                     CHECK (contribution_kind IN
                                         ('chosen', 'aggregated_in', 'reference')),
            promoted_by_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
            promoted_at              TIMESTAMP NOT NULL DEFAULT NOW(),
            reason                   TEXT,
            UNIQUE (parent_analysis_id, source_analysis_id)
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_lims_analysis_promotions_parent ON lims_analysis_promotions (parent_analysis_id)",
        "CREATE INDEX IF NOT EXISTS ix_lims_analysis_promotions_source ON lims_analysis_promotions (source_analysis_id)",
        # Sub-sample event log: lightweight audit for actions with no other trail.
        # Writers: set_assignment_role, update_sub_sample, delete_pristine_analysis.
        """
        CREATE TABLE IF NOT EXISTS lims_sub_sample_events (
            id              SERIAL PRIMARY KEY,
            sub_sample_pk   INTEGER NOT NULL REFERENCES lims_sub_samples(id) ON DELETE CASCADE,
            event           TEXT NOT NULL,
            details         JSONB,
            user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at      TIMESTAMP NOT NULL DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_lims_sub_sample_events_sub ON lims_sub_sample_events (sub_sample_pk)",
        # result-type Task 1: result type + options on analysis_services
        "ALTER TABLE analysis_services ADD COLUMN IF NOT EXISTS result_type TEXT",
        "ALTER TABLE analysis_services ADD COLUMN IF NOT EXISTS result_options JSONB",
        # senaite-writeback: retracted/rejected parent rows must not block
        # re-promotion — "retract the parent row, then re-promote" is the
        # documented undo. Rebuild the parent-tier root index with a state
        # exclusion (drop+create is idempotent as a pair).
        # native-manage-analyses: retracted/rejected vial rows must not block
        # re-adding the same service (mirrors the parent-tier index fix).
        "DROP INDEX IF EXISTS uq_lims_analyses_sub_service_root",
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_analyses_sub_service_root
            ON lims_analyses (lims_sub_sample_pk, keyword)
            WHERE retest_of_id IS NULL AND lims_sub_sample_pk IS NOT NULL
              AND review_state NOT IN ('retracted', 'rejected')
        """,
        "DROP INDEX IF EXISTS uq_lims_analyses_parent_service_root",
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_analyses_parent_service_root
            ON lims_analyses (lims_sample_pk, keyword)
            WHERE retest_of_id IS NULL AND lims_sample_pk IS NOT NULL
              AND review_state NOT IN ('retracted', 'rejected')
        """,
        # Sub-sample 'promoted' workflow state. Re-create the review_state CHECK
        # to allow 'promoted', then backfill: sub-samples promoted under the old
        # model were left at 'to_be_verified'; defensively re-home any stray
        # vial-tier 'verified' rows (verification is now parent-only).
        "ALTER TABLE lims_analyses DROP CONSTRAINT IF EXISTS lims_analyses_review_state_check",
        """
        ALTER TABLE lims_analyses ADD CONSTRAINT lims_analyses_review_state_check
            CHECK (review_state IN (
                'unassigned', 'assigned', 'to_be_verified', 'verified',
                'published', 'rejected', 'retracted', 'promoted'
            ))
        """,
        # Old model left promoted sub-samples at 'to_be_verified' — re-home them.
        """
        UPDATE lims_analyses SET review_state='promoted'
         WHERE lims_sub_sample_pk IS NOT NULL
           AND review_state='to_be_verified'
           AND id IN (SELECT source_analysis_id FROM lims_analysis_promotions)
        """,
        # Defensive: a promoted sub-sample should never be 'verified' — re-home it.
        """
        UPDATE lims_analyses SET review_state='promoted'
         WHERE lims_sub_sample_pk IS NOT NULL
           AND review_state='verified'
           AND id IN (SELECT source_analysis_id FROM lims_analysis_promotions)
        """,
        # Defensive: a vial-tier 'verified' that was never promoted shouldn't exist — reopen it.
        """
        UPDATE lims_analyses SET review_state='to_be_verified'
         WHERE lims_sub_sample_pk IS NOT NULL
           AND review_state='verified'
           AND id NOT IN (SELECT source_analysis_id FROM lims_analysis_promotions)
        """,
        # Sub-vial support: tag a wizard session to the specific vial it was prepped for
        "ALTER TABLE wizard_sessions ADD COLUMN IF NOT EXISTS lims_sub_sample_pk INTEGER",
        # PCR sterility analyses (PCR-BACTERIA/PCR-FUNGI) were left ungrouped in the
        # catalog. They are Microbiology analyses; grouping them here makes the HPLC
        # vial analyte mirror's exclude-Microbiology filter correctly drop them.
        # Idempotent via the uq_service_group_member unique constraint; a no-op where
        # those services or the group don't exist (e.g. fresh installs).
        """
        INSERT INTO service_group_members (service_group_id, analysis_service_id)
        SELECT g.id, s.id
        FROM service_groups g
        JOIN analysis_services s ON s.keyword IN ('PCR-BACTERIA', 'PCR-FUNGI')
        WHERE g.name = 'Microbiology'
        ON CONFLICT (service_group_id, analysis_service_id) DO NOTHING
        """,
        # Per-substance purity/quantity services. Derived from the per-peptide
        # identity services (ID_<X>) so the keyword suffix + peptide_id are
        # authoritative (the suffix is NOT derivable from the peptide name, e.g.
        # ID_TB500BETA4). The HPLC vial analyte mirror seeds these so a blend
        # vial's purity/quantity rows name the real substance instead of the
        # generic "Analyte N". Idempotent via NOT EXISTS (analysis_services.keyword
        # is not unique). No-op for the pre-existing PUR_BPC157/QTY_BPC157 and on
        # fresh installs with no identity services.
        """
        INSERT INTO analysis_services (title, keyword, category, unit, peptide_id, active, created_at, updated_at)
        SELECT p.name || ' - Purity', 'PUR_' || substring(idsvc.keyword from 4), 'HPLC', '%',
               idsvc.peptide_id, TRUE, NOW(), NOW()
        FROM analysis_services idsvc
        JOIN peptides p ON p.id = idsvc.peptide_id
        WHERE left(idsvc.keyword, 3) = 'ID_' AND idsvc.peptide_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM analysis_services x
            WHERE x.keyword = 'PUR_' || substring(idsvc.keyword from 4))
        """,
        """
        INSERT INTO analysis_services (title, keyword, category, unit, peptide_id, active, created_at, updated_at)
        SELECT p.name || ' - Quantity', 'QTY_' || substring(idsvc.keyword from 4), 'HPLC', 'mg',
               idsvc.peptide_id, TRUE, NOW(), NOW()
        FROM analysis_services idsvc
        JOIN peptides p ON p.id = idsvc.peptide_id
        WHERE left(idsvc.keyword, 3) = 'ID_' AND idsvc.peptide_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM analysis_services x
            WHERE x.keyword = 'QTY_' || substring(idsvc.keyword from 4))
        """,
        # Group all per-substance purity/quantity services into Analytics
        # (consistent with the ID_<X> identity services). Idempotent.
        """
        INSERT INTO service_group_members (service_group_id, analysis_service_id)
        SELECT g.id, s.id
        FROM service_groups g
        JOIN analysis_services s ON left(s.keyword, 4) IN ('PUR_', 'QTY_')
        WHERE g.name = 'Analytics'
        ON CONFLICT (service_group_id, analysis_service_id) DO NOTHING
        """,
        # Variance addon Phase 1: 'variance_verified' sub-sample state +
        # 'variance_verify' audit kind. Drop+recreate both CHECKs (idempotent).
        "ALTER TABLE lims_analyses DROP CONSTRAINT IF EXISTS lims_analyses_review_state_check",
        """
        ALTER TABLE lims_analyses ADD CONSTRAINT lims_analyses_review_state_check
            CHECK (review_state IN (
                'unassigned', 'assigned', 'to_be_verified', 'verified',
                'published', 'rejected', 'retracted', 'promoted',
                'variance_verified'
            ))
        """,
        "ALTER TABLE lims_analysis_transitions DROP CONSTRAINT IF EXISTS lims_analysis_transitions_transition_kind_check",
        """
        ALTER TABLE lims_analysis_transitions ADD CONSTRAINT lims_analysis_transitions_transition_kind_check
            CHECK (transition_kind IN
                ('assign','submit','verify','retract','reject',
                 'retest','publish','reset','auto','variance_verify'))
        """,
        # Variance addon: lab-side override until WP variance addon ships.
        "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS variance_override TEXT",
    ]
    # Per-statement isolation: a failure in one statement (e.g., a table that
    # create_all hasn't built yet on first run) must not skip subsequent
    # statements. The previous bulk try/except wrapped the whole loop and
    # silently dropped every migration after the first failure.
    with engine.connect() as conn:
        for sql in migrations:
            try:
                conn.execute(text(sql))
                conn.commit()
            except Exception as e:
                conn.rollback()
                log.warning("migration_skipped sql=%r err=%s", sql[:80], e)
