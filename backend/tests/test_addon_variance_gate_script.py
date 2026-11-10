"""The owner-run add-on Variance gate (scripts/addon_variance_gate.py).

The script runs on the prod image BEFORE this branch, so it carries its
own constants. These tests import the branch's real constants and fail
loudly on a rename, prove the self-check catches planted faults, and run
every check read-only against the dev Postgres."""

import subprocess
import sys
from pathlib import Path

import pytest

from scripts import addon_variance_gate as gate
from sub_samples import variance_tests as vt
from sub_samples.service import derive_variance_demand
from throughput import HPLC_CATEGORIES

BACKEND = Path(__file__).resolve().parents[1]
SCRIPT = BACKEND / "scripts" / "addon_variance_gate.py"


def test_constants_match_the_code():
    assert gate.KEYS == sorted(vt.VARIANCE_TEST_KEYS)
    assert gate.LEGACY_BUCKETS == sorted(vt.LEGACY_BUCKETS)
    assert (gate.RUN_LABEL_VIAL, gate.RUN_LABEL_DIGEST) == (vt.RUN_LABEL_VIAL, vt.RUN_LABEL_DIGEST)
    assert gate.HPLC_CATEGORIES == sorted(HPLC_CATEGORIES)
    # The legacy override keys are the ones today's demand path reads.
    legacy = derive_variance_demand({"variance": {k: 2 for k in gate.LEGACY_VARIANCE_KEYS}})
    assert (legacy["endo"], legacy["ster"]) == (1, 1)
    assert not set(gate.ROLES) & vt.LEGACY_BUCKETS


def test_self_check_is_silent_when_clean(capsys):
    gate.self_check()
    assert capsys.readouterr().out == ""


def _with_sql(label, sql):
    return [(lb, sql if lb == label else s, j) for lb, s, j in gate.CHECKS]


@pytest.mark.parametrize("sql, message", [
    ("SELECT 1 FROM vial_roles; DELETE FROM vial_roles", "more than one statement"),
    ("DELETE FROM vial_roles", "not a SELECT"),
    ("SELECT 1 FROM vial_roles WHERE id IN (SELECT 1) FOR UPDATE", "write word"),
    ("SELECT nextval('x') FROM vial_roles", "write word"),
    ("SELECT ls.contact_email FROM lims_samples ls", "customer field"),
    ("SELECT count(*) FROM sample_preps", "customer field or table"),
    ("SELECT * FROM lims_samples", "whole row"),
    ("SELECT ls.catalog_snapshot FROM lims_samples ls", "whole row"),
])
def test_self_check_catches_planted_faults(sql, message):
    with pytest.raises(gate.GateError, match=message):
        gate.self_check(checks=_with_sql("3 vial roles", sql))


def test_self_check_catches_a_drifted_key():
    drifted = [k for k in gate.KEYS if k != "heavy_metals"] + ["heavy-metals"]
    with pytest.raises(gate.GateError, match="keys"):
        gate.self_check(keys=drifted)


def test_selfcheck_run_prints_nothing_and_exits_0():
    proc = subprocess.run(  # brief step 2
        [sys.executable, "-c", "import runpy; runpy.run_path("
         "'scripts/addon_variance_gate.py', run_name='selfcheck')"],
        capture_output=True, text=True, cwd=BACKEND, timeout=120,
    )
    assert (proc.returncode, proc.stdout, proc.stderr) == (0, "", "")


def test_failed_self_check_prints_block_verdict(tmp_path):
    """A mutant with a write statement, run as `__main__` the way the owner
    runs it: the self-check fails, the verdict is printed, exit 1, no
    traceback."""
    src = SCRIPT.read_text(encoding="utf-8")
    mutant = tmp_path / "gate_mutant.py"
    mutant.write_text(src.replace('"SELECT r.id, r.code', '"UPDATE r.id, r.code', 1),
                      encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, "-I", str(mutant)],
        capture_output=True, text=True, cwd=tmp_path, timeout=120,
    )
    lines = proc.stdout.strip().splitlines()
    assert proc.returncode == 1
    assert lines[-1] == "VERDICT: BLOCK (self-check)"
    assert "3 vial roles: not a SELECT" in lines[-2]
    assert "Traceback" not in proc.stdout + proc.stderr


def test_old_image_prints_one_line_that_keys_were_not_compared(tmp_path):
    """Isolated from backend/ (as on the prod image before this release, where
    sub_samples.variance_tests does not exist): one plain line, exit 0."""
    proc = subprocess.run(
        [sys.executable, "-I", "-c", "import runpy, sys; runpy.run_path(sys.argv[1], "
         "run_name='selfcheck')", str(SCRIPT)],
        capture_output=True, text=True, cwd=tmp_path, timeout=120,
    )
    assert proc.returncode == 0
    assert proc.stdout.splitlines() == [
        "self-check: the key list was NOT compared with the code on this run "
        "(ModuleNotFoundError; expected on the image before this release)"]
    assert proc.stderr == ""


def _profile_row(key, **kw):
    row = dict(pid=1, name="n", active=True, dim="role", role=gate.ROLE_BY_KEY[key],
               vials=1, analytical=None, archetype="limit_table", role_row=True)
    row.update(kw)
    return (key, row["pid"], row["name"], row["active"], row["dim"], row["role"],
            row["vials"], row["analytical"], row["archetype"], row["role_row"])


def test_profile_rule_mirrors_the_resolver():
    good = [_profile_row(k) for k in gate.KEYS if k != "heavy_metals"]
    good.append(_profile_row("heavy_metals", vials=2, analytical=1))
    assert gate._judge_profiles(good)[0] == "PASS"
    for planted, needle in [
        (_profile_row("sterility-usp71", vials=2), "2 analytical vials"),
        (_profile_row("sterility-usp71", vials=2, analytical=2), "2 analytical vials"),
        (_profile_row("endotoxin-usp85-lal", role="endo"), "expected endo85"),
        (_profile_row("rapid-sterility-pcr", role_row=False), "no vial_roles row"),
        (_profile_row("heavy_metals", dim="kind"), "fulfillment_dim"),
        (_profile_row("heavy_metals", pid=None), "no catalog profile"),
    ]:
        rows = [r for r in good if r[0] != planted[0]] + [planted]
        tag, why = gate._judge_profiles(rows)
        assert tag == "BLOCK" and needle in why


def _dev_postgres_or_skip():
    from sqlalchemy import text

    from database import SessionLocal
    try:
        db = SessionLocal()
        try:
            db.execute(text("SELECT 1"))
        finally:
            db.close()
    except Exception as exc:
        pytest.skip(f"dev Postgres unreachable ({type(exc).__name__})")


def test_every_check_runs_read_only_on_dev_postgres(capsys):
    _dev_postgres_or_skip()
    code = gate.run()
    out = capsys.readouterr().out
    assert "ERROR" not in out
    assert out.strip().splitlines()[-1].startswith("VERDICT: ")
    assert code in (0, 2)
    for label, _sql, _judge in gate.CHECKS:
        assert any(line.split(" ", 1)[1].startswith(f"{label}:")
                   for line in out.splitlines() if line[:5] in ("PASS ", "BLOCK", "INFO "))


def test_a_write_is_refused_by_the_read_only_transaction(capsys):
    """Bypasses the self-check on purpose: Postgres itself refuses the
    write, the check errors (exit 1, named in the verdict), and only the
    exception type is printed."""
    _dev_postgres_or_skip()
    code = gate.run(checks=[("planted write", "CREATE TEMP TABLE zz_gate_t18 (x int)",
                             gate._info_legacy)])
    out = capsys.readouterr().out
    assert code == 1
    assert out.splitlines()[0].startswith("ERROR planted write: ")
    assert "read-only" not in out and "zz_gate_t18" not in out
    assert out.strip().splitlines()[-1] == "VERDICT: BLOCK (planted write error)"
