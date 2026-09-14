"""_native_placeholders_at_registration_bg — the registration-signal fallback
must log when IS has no services for the sample (it used to return silently:
2026-09-08 multi-sample race) and must delegate seeding to order_seed."""
import logging
from unittest.mock import patch

from sqlalchemy.exc import IntegrityError

import main


class _Q:
    def __init__(self, parent):
        self._parent = parent

    def filter_by(self, **kw):
        return self

    def one_or_none(self):
        return self._parent


class _Session:
    """Minimal fake SessionLocal() — query().filter_by().one_or_none() finds
    a truthy parent so the flow reaches seed_parent_from_services."""

    def __init__(self, parent=None):
        self._parent = parent if parent is not None else object()

    def query(self, *a):
        return _Q(self._parent)

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


def test_logs_warning_when_is_has_no_services(caplog):
    with patch("sub_samples.service.fetch_sample_services", return_value=None), \
         patch("main.seed_parent_from_services") as seed:
        with caplog.at_level(logging.WARNING):
            main._native_placeholders_at_registration_bg("P-7777")
    assert any("registry.native_placeholder_seed_skipped" in r.getMessage()
               and "P-7777" in r.getMessage() for r in caplog.records)
    seed.assert_not_called()


def test_delegates_to_seed_parent_from_services():
    fake_parent = object()

    with patch("sub_samples.service.fetch_sample_services",
               return_value={"services": {"sterility_pcr": True}, "package": "core"}), \
         patch("database.SessionLocal", return_value=_Session(fake_parent)), \
         patch("main.seed_parent_from_services",
               return_value={"created": 1, "existing": 0, "skipped": 0}) as seed:
        main._native_placeholders_at_registration_bg("P-7777")
    seed.assert_called_once()
    kwargs = seed.call_args.kwargs
    assert kwargs["parent"] is fake_parent
    assert kwargs["services"] == {"sterility_pcr": True}
    assert kwargs["package"] == "core"
    assert kwargs["source"] == "registration_signal"


# ═══════════════════════════════════════════════════════════════════════════
# Fix round 1, finding 1: D3 — the fallback races the primary seed (order
# upsert) for every sample but the last of a multi-sample order; losing that
# race raises IntegrityError on uq_lims_analyses_parent_service_ordered and
# is benign, not a real failure. Must log at INFO under a distinct reason,
# never as the WARNING-level native_placeholder_seed_failed.
# ═══════════════════════════════════════════════════════════════════════════

def test_race_lost_to_primary_seed_logs_skipped_at_info(caplog):
    race_err = IntegrityError(
        "INSERT INTO lims_analyses ...", {},
        Exception("duplicate key value violates unique constraint "
                  "\"uq_lims_analyses_parent_service_ordered\""),
    )
    with (
        patch("sub_samples.service.fetch_sample_services",
              return_value={"services": {"sterility_pcr": True}, "package": "core"}),
        patch("database.SessionLocal", return_value=_Session()),
        patch("main.seed_parent_from_services", side_effect=race_err),
        caplog.at_level(logging.INFO),
    ):
        main._native_placeholders_at_registration_bg("P-7778")

    skipped = [r for r in caplog.records
               if "registry.native_placeholder_seed_skipped" in r.getMessage()
               and "reason=race_lost_to_primary_seed" in r.getMessage()]
    assert len(skipped) == 1
    assert skipped[0].levelno == logging.INFO

    failed = [r for r in caplog.records
              if "registry.native_placeholder_seed_failed" in r.getMessage()
              and r.levelno >= logging.WARNING]
    assert failed == []


def test_non_race_exception_still_logs_failure_at_warning(caplog):
    with (
        patch("sub_samples.service.fetch_sample_services",
              return_value={"services": {"sterility_pcr": True}, "package": "core"}),
        patch("database.SessionLocal", return_value=_Session()),
        patch("main.seed_parent_from_services", side_effect=RuntimeError("catalog lookup boom")),
        caplog.at_level(logging.INFO),
    ):
        main._native_placeholders_at_registration_bg("P-7779")

    failed = [r for r in caplog.records
              if "registry.native_placeholder_seed_failed" in r.getMessage()]
    assert len(failed) == 1
    assert failed[0].levelno == logging.WARNING

    skipped = [r for r in caplog.records
               if "reason=race_lost_to_primary_seed" in r.getMessage()]
    assert skipped == []
