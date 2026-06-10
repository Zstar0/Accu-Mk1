"""Live-SENAITE integration tests for the sub-samples feature.

Excluded from the default pytest run; invoke explicitly with `-m integration`:

    docker exec accu-mk1-backend python -m pytest \\
        backend/tests/test_sub_samples_integration.py -v -m integration

Requirements:
  * A running SENAITE instance reachable at SENAITE_URL / SENAITE_BASE_URL.
    Defaults are wired in `sub_samples.senaite` (admin / dev creds for the
    local docker container).
  * Env var INTEGRATION_TEST_PARENT_SAMPLE_ID — a parent AR that exists in
    SENAITE with a Contact, SampleType, and (preferably) populated
    Accumark-custom fields. Defaults to "P-0071".
  * Env var INTEGRATION_TEST_RETEST_PARENT_SAMPLE_ID (optional) — a retest
    AR id like "P-XXXX-R01". Test 3 is skipped if not set or unreachable.

Pollution-tolerant by design: SENAITE's /delete returns 200 success:false
for ARs past sample_due, so secondaries pile up across runs. Local SENAITE
is disposable; tear it down to reset.
"""
import io
import os
import re
from datetime import datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from database import Base
from models import LimsSample, LimsSubSample  # noqa: F401  (registers tables)
from sub_samples import senaite, service


pytestmark = pytest.mark.integration


PARENT_ID_ENV = "INTEGRATION_TEST_PARENT_SAMPLE_ID"
RETEST_PARENT_ID_ENV = "INTEGRATION_TEST_RETEST_PARENT_SAMPLE_ID"
DEFAULT_PARENT_ID = "P-0071"


def _parent_id() -> str:
    return os.environ.get(PARENT_ID_ENV, DEFAULT_PARENT_ID)


def _retest_parent_id():
    return os.environ.get(RETEST_PARENT_ID_ENV)


def _to_uid(value: Any):
    """SENAITE returns reference fields as either a UID string or a
    {uid, url, ...} dict. Normalize."""
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get("uid")
    return value


@pytest.fixture(scope="module")
def parent_meta() -> dict:
    parent = _parent_id()
    try:
        meta = senaite.fetch_parent_metadata(parent)
    except Exception as e:
        pytest.skip(f"Cannot fetch parent {parent} from SENAITE: {e}")
    if not meta:
        pytest.skip(f"SENAITE returned empty metadata for {parent}")
    return meta


@pytest.fixture(scope="module")
def parent_create_args(parent_meta) -> dict:
    """Args ready to splat into senaite.create_secondary."""
    contact = _to_uid(parent_meta.get("Contact") or parent_meta.get("ContactUID"))
    if not contact:
        pytest.skip(
            f"Test parent {_parent_id()} has no Contact populated; integration "
            f"tests need a parent that mirrors a real client-receive flow."
        )
    sample_type = _to_uid(parent_meta.get("SampleType"))
    if not sample_type:
        pytest.skip(f"Test parent {_parent_id()} has no SampleType")
    return {
        "parent_sample_id": _parent_id(),
        "parent_uid": parent_meta["uid"],
        "client_uid": _to_uid(parent_meta.get("Client") or parent_meta.get("ClientUID")),
        "contact_uid": contact,
        "sample_type_uid": sample_type,
    }


def _next_seq_index(parent_sample_id: str) -> int:
    """Highest existing -SNN suffix on this parent. 0 if none."""
    existing = senaite.fetch_secondaries(parent_sample_id)
    pat = re.compile(rf"^{re.escape(parent_sample_id)}-S(\d{{2}})$")
    indices = []
    for it in existing:
        m = pat.match(it.get("id", ""))
        if m:
            indices.append(int(m.group(1)))
    return max(indices) if indices else 0


# ---------------------------------------------------------------------------
# Test 1: SENAITE's idserver yields sequential -S01..-S0N IDs
# ---------------------------------------------------------------------------
def test_create_three_secondaries_yields_sequential_SNN(parent_create_args):
    """Three sequential creates produce -SNN, -S(N+1), -S(N+2). Validates that
    the `^<parent>-S\\d{2}$` regex matches SENAITE's actual ID-server output."""
    parent_id = parent_create_args["parent_sample_id"]
    base = _next_seq_index(parent_id)
    expected = [f"{parent_id}-S{base + i + 1:02d}" for i in range(3)]
    actual = []
    for _ in range(3):
        result = senaite.create_secondary(**parent_create_args)
        actual.append(result.sample_id)
    assert actual == expected, (
        f"Expected sequential IDs starting after S{base:02d}: got {actual}, expected {expected}"
    )


# ---------------------------------------------------------------------------
# Test 2: silent-fallthrough guard
# ---------------------------------------------------------------------------
def test_create_secondary_silent_fallthrough_with_bad_parent_uid_raises(parent_create_args):
    """A bogus PrimaryAnalysisRequest UID still causes SENAITE to silently
    create a normal AR. create_secondary must catch this and raise
    SecondaryFalloutError with the orphan UID populated for manual cleanup."""
    args = dict(parent_create_args)
    args["parent_uid"] = "deadbeefdeadbeefdeadbeefdeadbeef"
    with pytest.raises(senaite.SecondaryFalloutError) as exc_info:
        senaite.create_secondary(**args)
    assert exc_info.value.orphan_uid, "orphan_uid must be populated for manual cleanup"
    assert exc_info.value.orphan_sample_id, "orphan_sample_id must be populated"


# ---------------------------------------------------------------------------
# Test 3: retest parent suffix-stripping
# ---------------------------------------------------------------------------
def test_create_secondary_against_retest_parent_strips_suffix():
    """SENAITE's idserver strips the -R\\d+ suffix when minting a secondary's
    id: a child of P-XXXX-R01 is P-XXXX-S01, NOT P-XXXX-R01-S01. This
    behavior is load-bearing for our regex."""
    retest = _retest_parent_id()
    if not retest:
        pytest.skip(f"{RETEST_PARENT_ID_ENV} not set; skipping retest-suffix test")
    try:
        meta = senaite.fetch_parent_metadata(retest)
    except Exception as e:
        pytest.skip(f"Cannot fetch retest parent {retest}: {e}")

    m = re.match(r"^(?P<base>.+)-R\d+$", retest)
    if not m:
        pytest.skip(f"{retest} does not look like a retest id (expected e.g. P-0071-R01)")
    base = m.group("base")

    contact = _to_uid(meta.get("Contact") or meta.get("ContactUID"))
    sample_type = _to_uid(meta.get("SampleType"))
    if not contact or not sample_type:
        pytest.skip(f"Retest parent {retest} missing Contact or SampleType")

    result = senaite.create_secondary(
        parent_sample_id=base,
        parent_uid=meta["uid"],
        client_uid=_to_uid(meta.get("Client") or meta.get("ClientUID")),
        contact_uid=contact,
        sample_type_uid=sample_type,
    )
    assert re.match(rf"^{re.escape(base)}-S\d{{2}}$", result.sample_id), (
        f"Expected {base}-Snn, got {result.sample_id}. SENAITE may have changed "
        f"its retest-suffix-stripping behavior."
    )


# ---------------------------------------------------------------------------
# Test 4: per-field fallback inheritance
# ---------------------------------------------------------------------------
def test_field_inheritance_carries_text_fields_skips_decimals(parent_meta, parent_create_args):
    """Text fields (ClientOrderNumber, ClientLot, CoaCompanyName) inherit
    through the per-field fallback in update_secondary_fields. Decimal fields
    (Analyte*DeclaredQuantity, DeclaredTotalQuantity) get rejected by Plone-5's
    isDecimal validator and are silently dropped — by design."""
    inherited = senaite.extract_inheritable_fields(parent_meta)

    text_keys = [
        k for k in ("ClientOrderNumber", "ClientLot", "CoaCompanyName")
        if k in inherited
    ]
    decimal_keys = [
        k for k in inherited
        if "DeclaredQuantity" in k or k == "DeclaredTotalQuantity"
    ]
    if not text_keys:
        pytest.skip(
            "Parent has no inheritable text fields (ClientOrderNumber/ClientLot/"
            "CoaCompanyName) populated; cannot validate inheritance"
        )

    result = senaite.create_secondary(**parent_create_args)
    senaite.update_secondary_fields(result.uid, inherited)

    child = senaite.fetch_parent_metadata(result.sample_id)
    for key in text_keys:
        actual = child.get(key)
        if isinstance(actual, dict):
            actual = actual.get("uid") or actual.get("title")
        assert actual, f"Text field {key} did not inherit (got {child.get(key)!r})"

    for key in decimal_keys:
        actual = child.get(key)
        is_empty = (
            actual is None
            or actual == ""
            or actual == 0
            or actual == "0"
            or actual == "0.0"
        )
        assert is_empty, (
            f"Decimal field {key} unexpectedly inherited as {actual!r} — "
            f"Plone-5 isDecimal validator behavior may have changed."
        )


# ---------------------------------------------------------------------------
# Test 5: HTML-form photo upload
# ---------------------------------------------------------------------------
def _make_test_jpeg() -> bytes:
    """Smallest valid JPEG we can produce. Prefers Pillow if available."""
    try:
        from PIL import Image
        buf = io.BytesIO()
        Image.new("RGB", (1, 1), "white").save(buf, format="JPEG")
        return buf.getvalue()
    except ImportError:
        # Hand-rolled minimal valid 1x1 white JPEG (~134 bytes).
        return bytes.fromhex(
            "ffd8ffe000104a46494600010100000100010000"
            "ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f14"
            "1d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434361f27393d"
            "38323c2e333432"
            "ffc00011080001000103012200021101031101"
            "ffc4001f0000010501010101010100000000000000000102030405060708090a0b"
            "ffc40014100100000000000000000000000000000000"
            "ffda000801010000003f00f7"
            "ffd9"
        )


def test_photo_upload_via_html_form_lands(parent_create_args):
    """Validates the CSRF preflight + multipart-form upload path. After upload
    the AR detail must list at least one attachment."""
    result = senaite.create_secondary(**parent_create_args)
    senaite.upload_photo(result.path, _make_test_jpeg(), filename="test_vial.jpg")

    detail = senaite.fetch_parent_metadata(result.sample_id)
    candidates = []
    for key in ("Attachment", "Attachments", "attachment", "attachments"):
        v = detail.get(key)
        if v:
            candidates.append((key, v))
    assert candidates, (
        f"Expected at least one attachment on {result.sample_id} after upload; "
        f"detail keys present: {sorted(detail.keys())[:30]}"
    )


# ---------------------------------------------------------------------------
# Test 6: drift reconciliation
# ---------------------------------------------------------------------------
@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()


def test_drift_reconciliation_inserts_senaite_only_secondaries(db_session, parent_create_args):
    """A secondary created in SENAITE bypassing our service must be discovered
    by service.list_sub_samples and inserted into lims_sub_samples with a
    fresh vial_sequence."""
    parent_id = parent_create_args["parent_sample_id"]

    parent_row = service.ensure_sample_row(db_session, parent_id)
    db_session.commit()

    # Backdate so list_sub_samples triggers reconciliation
    # (CACHE_FRESHNESS = 5 minutes in service.py).
    parent_row.last_synced_at = datetime.utcnow() - timedelta(hours=1)
    db_session.commit()

    rogue = senaite.create_secondary(**parent_create_args)

    parent_after, _subs = service.list_sub_samples(db_session, parent_id)
    assert parent_after is not None, "Parent row vanished after reconciliation"

    # Query lims_sub_samples directly. The reconciler accesses
    # parent.sub_samples to compute the local diff, which loads (and caches)
    # the collection while it is still empty; subsequently `db.add()`-ing a
    # LimsSubSample with `parent_sample_pk=parent.id` sets the FK column but
    # doesn't sync the cached relationship on the parent. The rows DO land in
    # lims_sub_samples (verified by WARN log in service.py:264) — that's the
    # actual claim under test, so we assert against the table.
    rogue_row = db_session.execute(
        select(LimsSubSample).where(LimsSubSample.external_lims_uid == rogue.uid)
    ).scalar_one_or_none()
    assert rogue_row is not None, (
        f"Reconciler did not insert SENAITE-only secondary {rogue.sample_id} "
        f"({rogue.uid}) into lims_sub_samples"
    )
    assert rogue_row.sample_id == rogue.sample_id
    assert rogue_row.parent_sample_pk == parent_after.id
    assert rogue_row.vial_sequence > 0, "vial_sequence must be assigned a positive value"
