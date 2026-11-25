"""The units of a sample on a certificate: the dosage-form icon, the word for
one unit ("Vial", "Pen") and how many units carry a result the certificate
prints. COABuilder draws them in the first row of the page 1 results panel
("7 Vials" over "Variance", beside the form icon) and uses the word in run
rows ("HPLC, Pen 1"); this module is the one place Mk1 decides them.

Wire block (`sample_units` in the COA wire document), every key optional to
the reader:

    {"icon": "pen", "one": "Pen", "many": "Pens", "form": "Pen",
     "count": 7, "variance": true}

Handler rulings, 2026-11-13: the certificate says the form factor, the count
is every vial reported on the certificate, not the HPLC vials alone, and a
certificate without Variance captions the count with the form's name.

The count is a number on a certificate, so it is sent only when every vial of
the sample can be accounted for (see `_count`). Otherwise the block carries
no `count` and COABuilder prints its old header row.
"""
from sqlalchemy import select

from models import AnalysisProfile, LimsSampleForm, LimsSubSample
from sub_samples.variance_tests import _snapshot_profiles

DEFAULT_WORDS = ("Vial", "Vials")
# ponytail: keyed by the form's icon type (Settings, Sample Forms), the list
# the Handler pointed at. Add a wording field on the form if the lab needs a
# word the icon set does not cover. Keys are sample_forms.routes.FormIcon.
UNIT_WORDS = {
    "powder_vial": ("Vial", "Vials"),
    "liquid_vial": ("Vial", "Vials"),
    "pen": ("Pen", "Pens"),
    "nasal_spray": ("Nasal Spray", "Nasal Sprays"),
    "capsule": ("Capsule", "Capsules"),
    "tablet": ("Tablet", "Tablets"),
    "syringe": ("Syringe", "Syringes"),
    "other": ("Unit", "Units"),
}
UNASSIGNED_ROLE = "xtra"  # the reserved bucket for vials no test uses
HPLC_ROLE = "hplc"        # page 1: the HPLC (or Bacteriostatic Water) panel's vials


def _form(db, parent) -> tuple[str | None, str | None]:
    """(name, icon key) of the sample's dosage form; (None, None) with no form."""
    form_id = getattr(parent, "sample_form_id", None)
    if form_id is None:
        return None, None
    row = db.execute(
        select(LimsSampleForm.name, LimsSampleForm.icon).where(LimsSampleForm.id == form_id)
    ).first()
    return (row.name, row.icon) if row else (None, None)


def form_icon(db, parent) -> str | None:
    """The icon key of the sample's dosage form; None with no form or no icon."""
    return _form(db, parent)[1]


def unit_words(db, parent) -> tuple[str, str]:
    """("Vial", "Vials") for this sample's form; the default for no form, no
    icon or an icon without a word."""
    return UNIT_WORDS.get(form_icon(db, parent) or "", DEFAULT_WORDS)


def _roles(db, parent, keys) -> dict[str, str]:
    """{profile key: vial role} for the keys that have one. The registration
    snapshot wins over the live catalog, as it does for the seeder and the
    Variance resolver: a role renamed after registration must still match the
    vials the sample already has."""
    keys = {k for k in keys if isinstance(k, str)}
    if not keys:
        return {}
    roles = dict(db.execute(
        select(AnalysisProfile.key, AnalysisProfile.fulfillment_role)
        .where(AnalysisProfile.key.in_(keys))).all())
    for entry in _snapshot_profiles(getattr(parent, "catalog_snapshot", None),
                                    getattr(parent, "sample_id", None)):
        if isinstance(entry, dict) and entry.get("key") in keys and entry.get("fulfillment_role"):
            roles[entry["key"]] = entry["fulfillment_role"]
    return {k: r for k, r in roles.items() if isinstance(r, str) and r}


def _count(db, parent, doc, variance_keys) -> tuple[int, bool] | None:
    """(vials reported, any of them a Variance vial), or None when the count
    cannot be trusted.

    A vial counts when a test that PRINTS on this document used it:
    - the page 1 panel (role `hplc`), unless the document has no page 1;
    - a native section that printed (its profile's vial role).
    A Variance vial on a native role counts only when that profile printed
    Variance runs (`variance_keys`, from the builder's trace); the HPLC
    series always prints its in-set Variance vials.

    None, so that COABuilder keeps the old header row, when:
    - the parent is itself vial 1 (not container mode): other vials may be
      untracked, so Mk1 cannot say how many were used;
    - one role belongs to both a printed and a deferred section (whose vials
      are they?);
    - any assigned vial belongs to something this document does not describe
      (a legacy-keyed endotoxin or sterility bucket, a test that is not
      reported): the rule would have to guess.
    Skipped, not counted: unassigned vials, vials taken out of the variance
    set, and the vials of a deferred section.
    """
    if not getattr(parent, "container_mode", False):
        return None
    doc = doc or {}
    printed_keys = [s.get("profile_key") for s in doc.get("sections") or []
                    if isinstance(s, dict)]
    deferred_keys = list(doc.get("deferred_sections") or [])
    roles = _roles(db, parent, [*printed_keys, *deferred_keys, *variance_keys])
    printed = {roles[k] for k in printed_keys if k in roles}
    deferred = {roles[k] for k in deferred_keys if k in roles}
    with_runs = {roles[k] for k in variance_keys if k in roles}
    if (doc.get("legacy_rows") or {}).get("page1") != "none":
        printed.add(HPLC_ROLE)
    if printed & deferred:
        return None
    vials = db.execute(
        select(LimsSubSample).where(LimsSubSample.parent_sample_pk == parent.id)
    ).scalars().all()
    count, variance = 0, False
    for v in vials:
        role = v.assignment_role
        if not role or role == UNASSIGNED_ROLE:
            continue
        is_variance = v.assignment_kind == "variance"
        if is_variance and not v.in_variance_set:
            continue
        if role in deferred:
            continue
        if role not in printed:
            return None
        if is_variance and role != HPLC_ROLE and role not in with_runs:
            continue  # a replicate vial whose runs do not print (no Variance plan)
        count += 1
        variance = variance or is_variance
    return (count, variance) if count else None


def build_sample_units(db, parent, doc=None, *, single_vial: bool = False,
                       variance_keys=()) -> dict:
    """The wire block for a parent certificate built from `doc` (the native
    sections document, with `legacy_rows` when Mk1 supplies page 1), or for
    one vial's certificate (`single_vial`). `variance_keys`: the profile keys
    whose Variance runs printed (the builder's trace)."""
    name, icon = _form(db, parent)
    one, many = UNIT_WORDS.get(icon or "", DEFAULT_WORDS)
    out: dict = {"one": one, "many": many}
    if icon:
        out["icon"] = icon
    if name and name.strip():
        # The header's caption on a certificate without Variance (Handler,
        # 2026-11-13): "1 Vial" over "Lyophilized Powder".
        out["form"] = name.strip()
    if single_vial:
        out["count"] = 1
        out["variance"] = False
        return out
    counted = _count(db, parent, doc, variance_keys)
    if counted is not None:
        out["count"], out["variance"] = counted
    return out
