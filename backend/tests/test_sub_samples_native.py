# backend/tests/test_sub_samples_native.py
"""Phase 5d unit tests for the Model-D cutover helpers.

These four helpers are the spine of the wizard write-path cutover:
  - native_create_enabled(): reads the feature flag
  - is_native_vial(sub): per-row provenance discriminator
  - generate_native_uid(): mk1://{uuid} external_lims_uid for native vials
  - next_native_sample_id(parent, seq): {parent}-S{NN} id, SENAITE-identical
"""
from __future__ import annotations

import pytest

from sub_samples.native import (
    generate_native_uid,
    is_native_vial,
    native_create_enabled,
    next_native_sample_id,
)


class _FakeSub:
    def __init__(self, external_lims_uid):
        self.external_lims_uid = external_lims_uid


# ── flag ──────────────────────────────────────────────────────────

def test_flag_defaults_on(monkeypatch):
    """As of 1.0.2 native create is the default (post-cutover); only an
    explicit '0' opts back into the legacy SENAITE-secondary path."""
    monkeypatch.delenv("SUBSAMPLE_NATIVE_CREATE", raising=False)
    assert native_create_enabled() is True


def test_flag_on_when_1(monkeypatch):
    monkeypatch.setenv("SUBSAMPLE_NATIVE_CREATE", "1")
    assert native_create_enabled() is True


def test_flag_off_when_0(monkeypatch):
    monkeypatch.setenv("SUBSAMPLE_NATIVE_CREATE", "0")
    assert native_create_enabled() is False


# ── provenance predicate ──────────────────────────────────────────

def test_is_native_true_for_mk1_prefix():
    assert is_native_vial(_FakeSub("mk1://abc123")) is True


def test_is_native_false_for_senaite_uid():
    assert is_native_vial(_FakeSub("a8c27e69bfa84ff1bf16a3e370a44456")) is False


def test_is_native_false_for_none():
    assert is_native_vial(_FakeSub(None)) is False


# ── native UID ────────────────────────────────────────────────────

def test_generate_native_uid_has_prefix():
    uid = generate_native_uid()
    assert uid.startswith("mk1://")
    assert len(uid) > len("mk1://")


def test_generate_native_uid_is_unique():
    assert generate_native_uid() != generate_native_uid()


# ── sample_id generator ───────────────────────────────────────────

def test_next_native_sample_id_zero_pads():
    assert next_native_sample_id("P-0142", 1) == "P-0142-S01"
    assert next_native_sample_id("P-0142", 4) == "P-0142-S04"
    assert next_native_sample_id("BW-0013", 12) == "BW-0013-S12"
