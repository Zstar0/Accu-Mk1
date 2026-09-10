import json
from pathlib import Path

import pytest

from priority.resolver import PriorityInfo, resolve

FIXTURE = Path(__file__).parent / "fixtures" / "priority_cases.json"
DATA = json.loads(FIXTURE.read_text())
PRIOS = {p["key"]: PriorityInfo(**p) for p in DATA["priorities"]}


@pytest.mark.parametrize("case", DATA["cases"], ids=[c["name"] for c in DATA["cases"]])
def test_resolver_matches_fixture(case):
    eff = resolve(case["explicit"], PRIOS)
    assert (eff.key, eff.rank, eff.source_level) == (
        case["expect"]["key"], case["expect"]["rank"], case["expect"]["source_level"]
    )


def test_source_id_comes_from_explicit_ids():
    eff = resolve({"order": "high"}, PRIOS, explicit_ids={"order": "42"})
    assert eff.source_level == "order" and eff.source_id == "42"


def test_no_default_row_raises():
    with pytest.raises(ValueError):
        resolve({}, {"high": PriorityInfo("high", 10, True, False)})
