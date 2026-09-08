"""_native_placeholders_at_registration_bg — the registration-signal fallback
must log when IS has no services for the sample (it used to return silently:
2026-09-08 multi-sample race) and must delegate seeding to order_seed."""
import logging
from unittest.mock import patch

import main


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

    class _Q:
        def filter_by(self, **kw):
            return self

        def one_or_none(self):
            return fake_parent

    class _Session:
        def query(self, *a):
            return _Q()

        def commit(self):
            pass

        def rollback(self):
            pass

        def close(self):
            pass

    with patch("sub_samples.service.fetch_sample_services",
               return_value={"services": {"sterility_pcr": True}, "package": "core"}), \
         patch("database.SessionLocal", return_value=_Session()), \
         patch("main.seed_parent_from_services",
               return_value={"created": 1, "existing": 0, "skipped": 0}) as seed:
        main._native_placeholders_at_registration_bg("P-7777")
    seed.assert_called_once()
    kwargs = seed.call_args.kwargs
    assert kwargs["parent"] is fake_parent
    assert kwargs["services"] == {"sterility_pcr": True}
    assert kwargs["package"] == "core"
    assert kwargs["source"] == "registration_signal"
