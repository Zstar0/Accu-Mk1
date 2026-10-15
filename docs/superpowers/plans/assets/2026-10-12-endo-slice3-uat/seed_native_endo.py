"""Endo slice 3 rehearsal seed: a native ENDOTOXIN-USP85LAL data set on a devbox stack.

The 2026-09-11 golden holds only the SENAITE-born ENDO-LAL service, so no Box 3 row could
be promoted without this. It builds, in production's shape (task-9-ops.md, facts gathered
read-only from production on 2026-10-12):

- the Mk1-native service ENDOTOXIN-USP85LAL (EU/mL, numeric, Microbiology);
- its COA profile `endotoxin-usp85-lal` (limit_table, vial role endo85, member: the service);
- its active EU/mL specs: catch-all 0-5 (LOQ 2.5), Bacteriostatic Water 0-0.25 (LOQ 0.2),
  BPC-157 0-40 (LOQ 2.5), GHK-Cu 0-64 (LOQ 3.75); the Peptide 0-350 EU/vial row only with
  --with-eu-vial (the rehearsal adds it through the spec editor as its own step);
- three endotoxin cartridges (0.05, 0.01, 0.005), a reader with a serial, and an active
  "Endotoxin" method revision that is the native service's default;
- native vials (role endo85, one live native analysis each) and one open 2 mL worksheet,
  "Endo s3 rehearsal (2 mL)", with weights, typed readings and a reader import.

Every write goes through the app's own API with a token minted inside the container, except
one: lims_samples.sample_type_title. The golden has it empty on every parent, its only
writer is the SENAITE basic-info sync, and the stack's SENAITE holds none of these ARs. The
seed sets it on the parents it uses, only where it is empty ('Peptide' or
'Bacteriostatic Water', the titles production carries). Without it every spec lookup runs
with no matrix.

Run it inside the stack's backend container, from /tmp (never /app: uvicorn reloads on
any new file there):

    C=accumark-<stack>-accu-mk1-backend
    docker cp stack_api.py $C:/tmp/stack_api.py
    docker cp seed_native_endo.py $C:/tmp/seed_native_endo.py
    docker exec -w /app -e PYTHONPATH=/app $C python /tmp/seed_native_endo.py [--with-eu-vial]

Re-runnable: every step finds its row by natural key (keyword, profile key, spec scope and
unit, cartridge sensitivity, reader serial, sample id, worksheet title) before it creates
one, and a row that already holds a reading is left alone. A read-only preflight runs first:
it stops, writing nothing, when a chosen vial is already on another open worksheet in the
Microbiology scope (the add would 409) or holds another live endotoxin analysis, and it
picks the SENAITE-born row at run time. After that the seed stops at the first refused
request and prints it.

Method on a stack whose active "Endotoxin" method predates this seed (endov2: linked to
ENDO-LAL as its default, locked because active): the seed makes a new revision, adds the
native service as a default link and activates it. That branch did not run on endos3
(no such method there); check its output when it runs.
"""
import json
import sys

sys.path.insert(0, "/tmp")
import stack_api as s  # noqa: E402
from sqlalchemy import text  # noqa: E402

from database import SessionLocal  # noqa: E402

KEYWORD = "ENDOTOXIN-USP85LAL"
TITLE = "Endotoxin USP85 LAL"
PROFILE_KEY = "endotoxin-usp85-lal"
ROLE = "endo85"
WS_TITLE = "Endo s3 rehearsal (2 mL)"
READER_SERIAL = "STACK-READER-0001"
LAMBDAS = (0.05, 0.01, 0.005)

# Vials: sample id -> (parent sample type, role in the rehearsal).
VIALS = {
    "P-0144-S02": ("Peptide", "eligible peptide, '<' reading by reader import (BPC-157: per-peptide EU/mL row)"),
    "BW-0010-S01": ("Bacteriostatic Water", "eligible bac water, '<0.1' on the 0.005"),
    "P-0146-S01": ("Peptide", "Invalid: reader record with spike recovery 40 %"),
    "P-0114-S01": ("Peptide", "inconclusive: 1:5000 total, LOQ 500 EU/vial"),
    "P-0115-S02": ("Peptide", "parent already holds a result (sibling S01 promoted the old way)"),
    "P-0120-S01": ("Peptide", "numeric reading, the concurrency row"),
    "P-0121-S01": ("Peptide", "numeric reading, spare"),
    "P-0123-S01": ("Peptide", "numeric reading, spare"),
}
# The old-way sibling: promoted from the sample page's endpoint, EU/mL, no limits.
OLD_WAY = ("P-0115-S01", "1.2")
# A golden vial whose only endotoxin analysis is SENAITE-born ENDO-LAL: chosen at run time
# (preflight below), P-0155-S02 when it is free. On endov2 the v2 UAT worksheet already
# holds the golden's endo vials, and the add would 409 on the open-worksheet guard.
PREFERRED_SENAITE_BORN = "P-0155-S02"
SENAITE_FILL = (10, None, None, 0.05, "<0.05")

# Row fills: (weight mg, total dilution, prep_steps, cartridge sensitivity, typed reading).
# A None reading means it comes from the reader import below.
FILLS = {
    "P-0144-S02": (10, None, None, 0.05, None),
    "BW-0010-S01": (None, None, None, 0.005, "<0.1"),
    "P-0146-S01": (10, None, None, 0.05, None),
    # The LOQ is lambda x total x water, independent of the weight: 0.05 x 5000 x 2 = 500.
    # Step 1 at 1:50 keeps every tube under 1.5 mL (20 + 980, 20 + 980, 125 + 125 uL).
    "P-0114-S01": (100, 5000, [[20, 50], None, None], 0.05, "<0.05"),
    "P-0115-S02": (10, None, None, 0.05, "<0.05"),
    "P-0120-S01": (10, None, None, 0.05, "0.08"),
    "P-0121-S01": (10, None, None, 0.05, "0.1"),
    "P-0123-S01": (5, None, None, 0.05, "0.06"),
}
# Reader import: sample id -> (test id, reading, spike recovery %, sample CV, spike CV).
READER = {
    "P-0144-S02": ("T-S3-A", "<0.05", 95, 3.0, 4.0),
    "P-0146-S01": ("T-S3-INV", "<0.05", 40, 3.0, 4.0),
}

c = s.client()
db = SessionLocal()


def ok(r, *codes):
    if r.status_code not in (codes or (200, 201)):
        s.show(r)
        raise SystemExit(f"stopped at {r.request.method} {r.request.url.path}")
    return r.json() if r.content else None


def q(sql, **kw):
    """Read-only lookups by natural key."""
    return db.execute(text(sql), kw).mappings().all()


def step(msg):
    print(f"- {msg}")


def vial(sid):
    return q("""SELECT ss.id, ss.assignment_role, ss.external_lims_uid, p.sample_id AS parent
                FROM lims_sub_samples ss JOIN lims_samples p ON p.id = ss.parent_sample_pk
                WHERE ss.sample_id = :s""", s=sid)[0]


def live_endo(vial_pk):
    return q("""SELECT a.id, a.review_state, s.keyword, s.origin FROM lims_analyses a
                JOIN analysis_services s ON s.id = a.analysis_service_id
                WHERE a.lims_sub_sample_pk = :v AND NOT a.retested
                  AND a.review_state NOT IN ('rejected', 'retracted') AND s.keyword ILIKE '%ENDO%'
                ORDER BY a.id""", v=vial_pk)


micro = q("SELECT id FROM departments WHERE name = 'Microbiology'")[0]["id"]


def held_elsewhere(sid):
    """Open worksheets other than the seed's that hold this vial in the Microbiology scope:
    create-from-drop and add-group refuse it with 409 (their open-worksheet guard)."""
    uid = vial(sid)["external_lims_uid"] or f"mk1://{sid}"
    return [r["title"] for r in q(
        """SELECT DISTINCT w.title FROM worksheet_items i JOIN worksheets w ON w.id = i.worksheet_id
           WHERE w.status = 'open' AND w.title <> :t AND i.sample_uid = :u
             AND (i.department_id = :d OR i.service_group_id = 2)""", t=WS_TITLE, u=uid, d=micro)]


# 0. Preflight, before any write: every chosen vial is free, and the SENAITE-born row is
#    picked (the one already on the seed's worksheet, else the first free golden vial whose
#    only live endotoxin analysis is SENAITE-born ENDO-LAL). A stack that cannot take the
#    seed stops here, not half-seeded.
problems = []
for sid in [*VIALS, OLD_WAY[0]]:
    rows = live_endo(vial(sid)["id"])
    if len(rows) > 1 or any(r["keyword"] != KEYWORD for r in rows):
        problems.append(f"{sid} holds other live endotoxin analyses: {[dict(r) for r in rows]}")
for sid in VIALS:
    if held_elsewhere(sid):
        problems.append(f"{sid} is already on open worksheet(s) {held_elsewhere(sid)}")
candidates = [r["sample_id"] for r in q(
    """SELECT ss.sample_id FROM lims_sub_samples ss
       JOIN lims_analyses a ON a.lims_sub_sample_pk = ss.id AND NOT a.retested
            AND a.review_state NOT IN ('rejected', 'retracted')
       JOIN analysis_services s ON s.id = a.analysis_service_id AND s.keyword ILIKE '%ENDO%'
       GROUP BY ss.sample_id
       HAVING count(*) = 1 AND bool_and(s.keyword = 'ENDO-LAL' AND s.origin = 'senaite')
       ORDER BY ss.sample_id <> :p, ss.sample_id""", p=PREFERRED_SENAITE_BORN)]
ours = {r["sample_id"] for r in q("""SELECT i.sample_id FROM worksheet_items i JOIN worksheets w
                                      ON w.id = i.worksheet_id WHERE w.title = :t AND w.status = 'open'""",
                                   t=WS_TITLE)}
SENAITE_BORN = (next((x for x in candidates if x in ours), None)
                or next((x for x in candidates if not held_elsewhere(x)), None))
if SENAITE_BORN is None:
    problems.append("no free vial whose only live endotoxin analysis is SENAITE-born ENDO-LAL")
if problems:
    raise SystemExit("preflight refused, nothing written:\n  " + "\n  ".join(problems))
FILLS[SENAITE_BORN] = SENAITE_FILL
step(f"preflight OK; SENAITE-born row: {SENAITE_BORN}")

# 1. The native service.
svc = next((x for x in ok(c.get("/analysis-services", params={"search": KEYWORD}))
            if x["keyword"] == KEYWORD), None)
if svc is None:
    svc = ok(c.post("/analysis-services", json={
        "title": TITLE, "keyword": KEYWORD, "category": "Microbiology", "unit": "EU/mL",
        "department_id": micro, "result_type": "numeric"}))
    step(f"service created: {svc['id']} {KEYWORD}")
else:
    step(f"service exists: {svc['id']} {KEYWORD} origin={svc.get('origin')} unit={svc.get('unit')}")
SVC = svc["id"]

# 2. The COA profile (arming is a separate PATCH, as the route requires).
prof = next((p for p in ok(c.get("/analysis-profiles")) if p["key"] == PROFILE_KEY), None)
if prof is None:
    prof = ok(c.post("/analysis-profiles", json={
        "key": PROFILE_KEY, "name": TITLE, "is_addon": True, "vials_required": 1,
        "fulfillment_role": ROLE, "fulfillment_dim": "role", "role_department_id": micro,
        "role_boxable": True, "coa_section_title": "Endotoxin"}))
    step(f"profile created: {prof['id']} {PROFILE_KEY}")
members = ok(c.get(f"/analysis-profiles/{prof['id']}/members"))
if SVC not in members:
    ok(c.put(f"/analysis-profiles/{prof['id']}/members", json={"analysis_service_ids": members + [SVC]}))
    step(f"profile members: {members + [SVC]}")
if prof.get("coa_archetype") != "limit_table":
    ok(c.patch(f"/analysis-profiles/{prof['id']}", json={"coa_archetype": "limit_table"}))
    step("profile armed: limit_table")

# 3. Specs, EU/mL (the EU/vial row only on request).
pep = {r["name"]: r["id"] for r in q("SELECT id, name FROM peptides WHERE name IN ('BPC-157', 'GHK-Cu')")}
SPECS = [
    {"rule_kind": "range", "min_value": "0", "max_value": "5", "unit": "EU/mL", "loq": "2.5"},
    {"matrix": "Bacteriostatic Water", "rule_kind": "range", "min_value": "0", "max_value": "0.25",
     "unit": "EU/mL", "loq": "0.2"},
    {"peptide_id": pep["BPC-157"], "rule_kind": "range", "min_value": "0", "max_value": "40",
     "unit": "EU/mL", "loq": "2.5"},
    {"peptide_id": pep["GHK-Cu"], "rule_kind": "range", "min_value": "0", "max_value": "64",
     "unit": "EU/mL", "loq": "3.75"},
]
if "--with-eu-vial" in sys.argv:
    SPECS.append({"matrix": "Peptide", "rule_kind": "range", "min_value": "0", "max_value": "350",
                  "unit": "EU/vial"})


def scope(x):
    return (x.get("matrix"), x.get("peptide_id"), (x.get("unit") or "").strip().lower())


have = {scope(x) for x in ok(c.get(f"/analysis-services/{SVC}/specs"))}
for spec in SPECS:
    if scope(spec) not in have:
        made = ok(c.post(f"/analysis-services/{SVC}/specs", json=spec))
        step(f"spec created: {made['id']} {scope(spec)} {spec['min_value']}-{spec['max_value']}")

# 4. Cartridges, by sensitivity.
carts = {}
for ct in ok(c.get("/consumables", params={"kind": "endo_cartridge"})):
    lam = (ct.get("specs") or {}).get("sensitivity_eu_ml")
    if lam in LAMBDAS and ct.get("active", True):
        carts.setdefault(lam, ct["id"])
for lam in LAMBDAS:
    if lam not in carts:
        carts[lam] = ok(c.post("/consumables", json={
            "kind": "endo_cartridge", "name": f"Endosafe cartridge {lam} EU/mL",
            "manufacturer": "Charles River", "part_number": f"STACK-PLACEHOLDER-{lam}",
            "specs": {"sensitivity_eu_ml": lam}}))["id"]
        step(f"cartridge created: {carts[lam]} ({lam})")

# 5. The reader.
inst = next((i for i in ok(c.get("/instruments")) if i.get("serial_number") == READER_SERIAL), None)
if inst is None:
    inst = ok(c.post("/instruments", json={
        "name": "EndoScan-V reader (stack)", "instrument_type": "Endotoxin reader",
        "brand": "Charles River", "model": "Endosafe nexgen-MCS", "department_id": micro,
        "serial_number": READER_SERIAL}))
    step(f"reader created: {inst['id']}")

# 6. The method: an active revision that is the native service's default.
links_wanted = [{"consumable_type_id": carts[0.05], "is_default": True},
                {"consumable_type_id": carts[0.01], "is_default": False},
                {"consumable_type_id": carts[0.005], "is_default": False}]
default = q("""SELECT m.id, m.revision FROM method_services ms JOIN hplc_methods m ON m.id = ms.method_id
               WHERE ms.analysis_service_id = :s AND ms.is_default AND m.status = 'active'""", s=SVC)
if default:
    METHOD = default[0]["id"]
    step(f"method exists: {METHOD} rev {default[0]['revision']} (native default)")
else:
    older = q("""SELECT id FROM hplc_methods WHERE status = 'active' AND name ILIKE 'Endotoxin%'
                 ORDER BY id DESC LIMIT 1""")
    draft = q("""SELECT m.id FROM hplc_methods m JOIN method_services ms ON ms.method_id = m.id
                 WHERE m.status = 'draft' AND ms.analysis_service_id = :s ORDER BY m.id DESC LIMIT 1""", s=SVC)
    if draft:
        m = {"id": draft[0]["id"]}
        step(f"method draft reused: {m['id']}")
    elif older:
        # endov2's shape: a new revision keeps its links; the native service joins as default.
        m = ok(c.post(f"/hplc/methods/{older[0]['id']}/new-revision"))
        step(f"method new revision: {m['id']} from {older[0]['id']}")
    else:
        m = ok(c.post("/hplc/methods", json={"name": "Endotoxin", "instrument_ids": [inst["id"]],
                                             "technique": "LAL kinetic chromogenic",
                                             "department_id": micro}))
        step(f"method created: {m['id']}")
    links = [x for x in ok(c.get(f"/hplc/methods/{m['id']}/services"))
             if x["analysis_service_id"] != SVC]
    ok(c.put(f"/hplc/methods/{m['id']}/services",
             json=[{"analysis_service_id": x["analysis_service_id"], "is_default": x["is_default"]}
                   for x in links] + [{"analysis_service_id": SVC, "is_default": True}]))
    if not ok(c.get(f"/hplc/methods/{m['id']}/consumables")):
        ok(c.put(f"/hplc/methods/{m['id']}/consumables", json=links_wanted))
    act = ok(c.post(f"/hplc/methods/{m['id']}/activate"))
    METHOD = act["id"]
    step(f"method activated: {METHOD} rev {act.get('revision')} status {act.get('status')}")

# 7. Parent sample types (the one SQL write; see the docstring).
parents = {sid.rsplit("-S", 1)[0]: st for sid, (st, _why) in VIALS.items()}
parents[OLD_WAY[0].rsplit("-S", 1)[0]] = "Peptide"
for parent, st in parents.items():
    res = db.execute(text("""UPDATE lims_samples SET sample_type_title = :t
                             WHERE sample_id = :s AND coalesce(btrim(sample_type_title), '') = ''"""),
                     {"t": st, "s": parent})
    if res.rowcount:
        step(f"sample_type_title {parent} = {st}")
db.commit()


# 8. Vials: role endo85 and one live native analysis each.
native_ids = {}
for sid in [*VIALS, OLD_WAY[0]]:
    v = vial(sid)
    if v["assignment_role"] != ROLE:
        ok(c.patch(f"/api/sub-samples/{sid}/assignment", json={"role": ROLE}))
        step(f"role {sid}: {v['assignment_role']} -> {ROLE}")
    rows = live_endo(v["id"])
    if not rows:
        made = ok(c.post("/api/lims-analyses", json={
            "host_kind": "sub_sample", "host_pk": v["id"], "analysis_service_id": SVC,
            "keyword": KEYWORD, "title": TITLE}))
        step(f"native analysis {sid}: {made['id']}")
        rows = live_endo(v["id"])
    if len(rows) != 1 or rows[0]["keyword"] != KEYWORD:
        raise SystemExit(f"{sid}: expected one live native endotoxin analysis, found {rows}")
    native_ids[sid] = rows[0]["id"]

# 9. The old-way promote that makes P-0115 hold a result (the sample page's request).
holder = q("""SELECT a.id, a.review_state FROM lims_analyses a JOIN lims_samples p ON p.id = a.lims_sample_pk
              WHERE p.sample_id = :p AND a.lims_sub_sample_pk IS NULL AND a.analysis_service_id = :s
                AND a.provenance = 'canonical' AND a.review_state NOT IN ('rejected', 'retracted')""",
           p=OLD_WAY[0].rsplit("-S", 1)[0], s=SVC)
if not holder:
    aid = native_ids[OLD_WAY[0]]
    state = q("SELECT review_state FROM lims_analyses WHERE id = :i", i=aid)[0]["review_state"]
    if state in ("unassigned", "assigned"):
        ok(c.post(f"/api/lims-analyses/{aid}/transitions",
                  json={"kind": "submit", "result_value": OLD_WAY[1]}))
    pr = ok(c.post("/api/lims-analyses/promote", json={
        "keyword": KEYWORD, "result_value": OLD_WAY[1], "result_unit": "EU/mL",
        "method_id": None, "instrument_id": None,
        "sources": [{"analysis_id": aid, "contribution_kind": "chosen"}],
        "reason": "Single-vial promote from AnalysisTable"}))
    step(f"old-way promote {OLD_WAY[0]} {OLD_WAY[1]} EU/mL -> parent {pr['parent']['id']} "
         f"{pr['parent']['review_state']}")


# 10. The worksheet: native rows first; the SENAITE-born row joins after the first reading
#     has pinned the method (a worksheet that mixes both services resolves no method).
def worksheet():
    w = q("SELECT id FROM worksheets WHERE title = :t AND status = 'open' ORDER BY id DESC LIMIT 1", t=WS_TITLE)
    return ok(c.get(f"/worksheets/{w[0]['id']}")) if w else None


def drop_body(sid, keyword, title):
    v = vial(sid)
    return {"sample_uid": v["external_lims_uid"] or f"mk1://{sid}", "sample_id": sid,
            "service_group_id": 2, "department_id": micro,
            "analyses": [{"title": title, "keyword": keyword, "peptide_name": None, "method": None}]}


ws = worksheet()
native_vials = list(VIALS)
if ws is None:
    made = ok(c.post("/worksheets/create-from-drop", json=drop_body(native_vials[0], KEYWORD, TITLE)))
    ok(c.put(f"/worksheets/{made['id']}", json={"title": WS_TITLE}))
    step(f"worksheet created: {made['id']} {WS_TITLE}")
    ws = worksheet()
WS = ws["id"]


def add(sid, keyword, title):
    global ws
    if not any(it["sample_id"] == sid for it in ws["items"]):
        ok(c.post(f"/worksheets/{WS}/add-group", json=drop_body(sid, keyword, title)))
        step(f"worksheet {WS}: added {sid}")
        ws = worksheet()


def fill(sid):
    global ws
    it = next(i for i in ws["items"] if i["sample_id"] == sid)
    if it.get("result_reading") is not None:
        return
    wt, total, steps, lam, reading = FILLS[sid]
    body = {"cartridge_type_id": carts[lam]}
    if wt is not None:
        body["prep_weight_mg"] = wt
    if total is not None:
        body["prep_total_dilution"] = total
    if steps is not None:
        body["prep_steps"] = steps
    if reading is not None:
        body["result_reading"] = reading
    ok(c.patch(f"/worksheets/{WS}/items/{it['id']}", json=body))
    step(f"row {sid}: {body}")


for sid in native_vials:
    add(sid, KEYWORD, TITLE)
for sid in native_vials:
    fill(sid)
ws = worksheet()


def record(test_id, result, recovery, sample_cv, spike_cv):
    """Shaped like src/lib/endo-reader.ts toReaderRecord; the server recomputes valid/why."""
    return {"test_id": test_id, "result": result, "reader": READER_SERIAL, "slot": 1,
            "operator": "S3 rehearsal", "tested_at": "2026-10-13T10:00:00-07:00",
            "software": "EndoScan-V", "cartridge_lot": "1111111111",
            "cartridge_expiry": "2028-06-01T00:00:00-07:00", "cartridge_range": "5 - 0.05",
            "spike_level": 0.8, "recovery": recovery, "rec_min": 50, "rec_max": 200,
            "sample_cv": sample_cv, "spike_cv": spike_cv, "cv_limit": 25,
            "reader_pass": recovery >= 50, "valid": recovery >= 50, "why": [],
            "file_name": "s3-rehearsal-export.csv"}


by = {i["sample_id"]: i for i in ws["items"]}
tests = [{"item_id": by[sid]["id"], "reading": rd, "record": record(tid, rd, rec, scv, kcv),
          "cartridge_type_id": carts[0.05], "replace": False}
         for sid, (tid, rd, rec, scv, kcv) in READER.items() if by[sid].get("result_reading") is None]
if tests:
    imp = ok(c.post(f"/worksheets/{WS}/reader-import",
                    json={"file_name": "s3-rehearsal-export.csv", "tests": tests}))
    step(f"reader import: applied {imp['applied']}")

add(SENAITE_BORN, "ENDO-LAL", "Endotoxin")
ws = worksheet()
fill(SENAITE_BORN)

# 11. Check what the worksheet serves.
ws = worksheet()
print(json.dumps({"worksheet": WS, "title": ws["title"], "endo_prep": ws.get("endo_prep"),
                  "endo_method_id": ws.get("endo_method_id"), "service": SVC, "profile": prof["id"],
                  "method": METHOD, "cartridges": carts, "reader": inst["id"]}, default=str))
bad = []
for it in sorted(ws["items"], key=lambda i: i["id"]):
    ea = it.get("endo_analysis")
    rd = it.get("result_reader") or {}
    print(f"  item {it['id']} {it['sample_id']}: reading={it.get('result_reading')} "
          f"cartridge={it.get('cartridge_type_id')} total={it.get('prep_total_dilution')} "
          f"reader={rd.get('test_id')} valid={rd.get('valid')} endo_analysis={ea}")
    want_native = it["sample_id"] != SENAITE_BORN
    if ea is None or ea.get("native") is not want_native:
        bad.append(it["sample_id"])
if ws.get("endo_prep") != "2ml" or bad:
    raise SystemExit(f"worksheet check failed: endo_prep={ws.get('endo_prep')} rows={bad}")
print("seed OK")
