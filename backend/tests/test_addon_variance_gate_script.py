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


def test_role_codes_match_the_bench_routing():
    """main._ROLE_BENCH_KIND is the only code that names the four test role
    codes (vial_roles_seed seeds only the legacy five; endo85, pcr, usp71 are
    admin-minted). Importing main is what many tests here already do."""
    from main import _ROLE_BENCH_KIND
    assert set(gate.ROLES) <= set(_ROLE_BENCH_KIND)


def test_self_check_is_silent_when_clean(capsys):
    gate._self_check()
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
        gate._self_check(checks=_with_sql("3 vial roles", sql))


def test_self_check_catches_keys_out_of_step_with_the_role_map():
    drifted = [k for k in gate.KEYS if k != "heavy_metals"] + ["heavy-metals"]
    with pytest.raises(gate.GateError, match="keys and roles disagree"):
        gate._self_check(keys=drifted)


def test_self_check_catches_keys_drifted_from_the_code(monkeypatch):
    """The code renamed a key; the script did not."""
    renamed = (vt.VARIANCE_TEST_KEYS - {"heavy_metals"}) | {"heavy-metals"}
    monkeypatch.setattr(vt, "VARIANCE_TEST_KEYS", frozenset(renamed))
    with pytest.raises(gate.GateError, match="keys drifted from the code"):
        gate._self_check()


def test_unexpected_self_check_failure_prints_type_only(monkeypatch, capsys):
    def boom(*_a, **_k):
        raise ValueError("postgresql://user:secret@host/db")
    monkeypatch.setattr(gate, "_self_check", boom)
    with pytest.raises(SystemExit) as exit_:
        gate._self_check_or_exit()
    out = capsys.readouterr().out
    assert exit_.value.code == 1
    assert out.splitlines() == ["self-check failed: ValueError", "VERDICT: BLOCK (self-check)"]


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
    """The prod image before this release: a `sub_samples` package exists but
    has no `variance_tests` module, so the import raises ImportError
    ("cannot import name"). One plain line, exit 0."""
    (tmp_path / "sub_samples").mkdir()
    (tmp_path / "sub_samples" / "__init__.py").write_text("", encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, "-I", "-c", "import runpy, sys; sys.path.insert(0, sys.argv[2]); "
         "runpy.run_path(sys.argv[1], run_name='selfcheck')", str(SCRIPT), str(tmp_path)],
        capture_output=True, text=True, cwd=tmp_path, timeout=120,
    )
    assert proc.returncode == 0
    assert proc.stdout.splitlines() == [
        "self-check: the key list was NOT compared with the code on this run "
        "(ImportError; expected on the image before this release)"]
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
        (_profile_row("endotoxin-usp85-lal", role="endo"),
         "expected endo85 (do not change the catalog to pass this check"),
        (_profile_row("rapid-sterility-pcr", role_row=False), "no vial_roles row"),
        (_profile_row("heavy_metals", dim="kind"), "fulfillment_dim"),
        (_profile_row("heavy_metals", pid=None), "no catalog profile"),
    ]:
        rows = [r for r in good if r[0] != planted[0]] + [planted]
        tag, why = gate._judge_profiles(rows)
        assert tag == "BLOCK" and needle in why


def test_override_sentences_point_at_the_is_gate():
    for rows in ([], [("heavy_metals", 1, 0, 0, 0, ["P-0001"])]):
        _tag, why = gate._judge_overrides(rows)
        assert why.endswith(
            "Mk1 stores only variance_override; samples whose stored services map holds "
            "a four-test key are counted by the Integration Service gate's check B: run it too.")


def _dev_postgres_or_skip():
    from sqlalchemy import text

    from database import SessionLocal, engine
    if engine.url.host not in ("127.0.0.1", "localhost"):
        pytest.skip("the engine is not a local database")
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


def test_a_failed_check_does_not_poison_the_next(capsys):
    """Each check gets a fresh transaction: a check that fails is followed
    by one that reads normally in the same run."""
    _dev_postgres_or_skip()
    code = gate.run(checks=[
        ("planted error", "SELECT 1 / 0", gate._info_legacy),
        ("after it", "SELECT 1", gate._info_legacy),
    ])
    lines = capsys.readouterr().out.strip().splitlines()
    assert code == 1
    assert lines[0].startswith("ERROR planted error: ")
    assert lines[1].startswith("INFO after it: ")
    assert lines[2] == "    (1,)"
    assert lines[-1] == "VERDICT: BLOCK (planted error error)"


def test_a_cut_list_says_how_many_were_left_out(capsys):
    _dev_postgres_or_skip()
    gate.run(checks=[(
        "cut", "SELECT 'k', count(*), (array_agg(g ORDER BY g))[1:200] "
        "FROM generate_series(1, 250) g", gate._info_legacy)])
    assert "    (first 200 ids shown of 250)" in capsys.readouterr().out.splitlines()
