import os
import pytest
from backend.peptide_request_config import get_config, PeptideRequestConfig


def test_missing_required_env_raises(monkeypatch):
    monkeypatch.delenv("CLICKUP_LIST_ID", raising=False)
    with pytest.raises(RuntimeError, match="CLICKUP_LIST_ID"):
        get_config()


def test_default_column_map_covers_all_statuses(monkeypatch):
    monkeypatch.setenv("CLICKUP_LIST_ID", "list_123")
    monkeypatch.setenv("CLICKUP_API_TOKEN", "tok")
    monkeypatch.setenv("CLICKUP_WEBHOOK_SECRET", "sec")
    cfg = get_config()
    expected_statuses = {
        "new", "approved", "ordering_standard", "sample_prep_created",
        "in_process", "on_hold", "completed", "rejected", "cancelled",
    }
    assert set(cfg.column_map.values()) == expected_statuses


def test_map_status_is_case_insensitive_and_whitespace_tolerant(monkeypatch):
    monkeypatch.setenv("CLICKUP_LIST_ID", "l")
    monkeypatch.setenv("CLICKUP_API_TOKEN", "t")
    monkeypatch.setenv("CLICKUP_WEBHOOK_SECRET", "s")
    cfg = get_config()
    assert cfg.map_column_to_status("  ORDERING standard  ") == "ordering_standard"
    assert cfg.map_column_to_status("NEW") == "new"


def test_unmapped_column_returns_none(monkeypatch):
    monkeypatch.setenv("CLICKUP_LIST_ID", "l")
    monkeypatch.setenv("CLICKUP_API_TOKEN", "t")
    monkeypatch.setenv("CLICKUP_WEBHOOK_SECRET", "s")
    cfg = get_config()
    assert cfg.map_column_to_status("random column") is None


def _set_required_env(monkeypatch):
    monkeypatch.setenv("CLICKUP_LIST_ID", "l")
    monkeypatch.setenv("CLICKUP_API_TOKEN", "t")
    monkeypatch.setenv("CLICKUP_WEBHOOK_SECRET", "s")


def test_senaite_clone_enabled_defaults_false(monkeypatch):
    _set_required_env(monkeypatch)
    monkeypatch.delenv("PEPTIDE_SENAITE_CLONE_ENABLED", raising=False)
    assert get_config().senaite_clone_enabled is False


@pytest.mark.parametrize("value", ["true", "TRUE", "True", "1", "yes", "on"])
def test_senaite_clone_enabled_truthy_values(monkeypatch, value):
    _set_required_env(monkeypatch)
    monkeypatch.setenv("PEPTIDE_SENAITE_CLONE_ENABLED", value)
    assert get_config().senaite_clone_enabled is True


@pytest.mark.parametrize("value", ["false", "0", "no", "off", "", "bogus"])
def test_senaite_clone_enabled_falsy_values(monkeypatch, value):
    _set_required_env(monkeypatch)
    monkeypatch.setenv("PEPTIDE_SENAITE_CLONE_ENABLED", value)
    assert get_config().senaite_clone_enabled is False


def test_coupon_enabled_defaults_false(monkeypatch):
    _set_required_env(monkeypatch)
    monkeypatch.delenv("PEPTIDE_COUPON_ENABLED", raising=False)
    assert get_config().coupon_enabled is False


@pytest.mark.parametrize("value", ["true", "TRUE", "True", "1", "yes", "on"])
def test_coupon_enabled_truthy_values(monkeypatch, value):
    _set_required_env(monkeypatch)
    monkeypatch.setenv("PEPTIDE_COUPON_ENABLED", value)
    assert get_config().coupon_enabled is True


@pytest.mark.parametrize("value", ["false", "0", "no", "off", "", "bogus"])
def test_coupon_enabled_falsy_values(monkeypatch, value):
    _set_required_env(monkeypatch)
    monkeypatch.setenv("PEPTIDE_COUPON_ENABLED", value)
    assert get_config().coupon_enabled is False
