"""The units of a sample on a certificate: the dosage-form icon, the word for
one unit ("Vial", "Pen") and how many units carry a result the certificate
prints. COABuilder draws them in the first row of the page 1 results panel
("7 Vials" over "Variance", beside the form icon) and uses the word in run
rows ("HPLC, Pen 1"); this module is the one place Mk1 decides them.

Wire block (`sample_units` in the COA wire document), every key optional to
the reader:

    {"icon": "pen", "one": "Pen", "many": "Pens", "count": 7, "variance": true}

Handler rulings, 2026-11-13: the certificate says the form factor, and the
count is every vial reported on the certificate, not the HPLC vials alone.
"""
from sqlalchemy import select

from models import AnalysisProfile, LimsSampleForm, LimsSubSample

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


def form_icon(db, parent) -> str | None:
    """The icon key of the sample's dosage form; None with no form or no icon."""
    form_id = getattr(parent, "sample_form_id", None)
    if form_id is None:
        return None
    return db.execute(
        select(LimsSampleForm.icon).where(LimsSampleForm.id == form_id)
    ).scalar_one_or_none()


def unit_words(db, parent) -> tuple[str, str]:
    """("Vial", "Vials") for this sample's form; the default for no form, no
    icon or an icon without a word."""
    return UNIT_WORDS.get(form_icon(db, parent) or "", DEFAULT_WORDS)


def _deferred_roles(db, doc) -> set[str]:
    keys = list((doc or {}).get("deferred_sections") or [])
    if not keys:
        return set()
    return {r for r in db.execute(
        select(AnalysisProfile.fulfillment_role).where(AnalysisProfile.key.in_(keys))
    ).scalars().all() if r}


def build_sample_units(db, parent, doc=None, *, single_vial: bool = False) -> dict:
    """The wire block for a parent certificate built from `doc` (the native
    sections document), or for one vial's certificate (`single_vial`).

    A vial counts when a test uses it and that test prints on this
    certificate: it has a role other than the unassigned bucket, its role is
    not one of a deferred section's, and it was not taken out of the variance
    set. A parent that is itself vial 1 (not container mode) counts as one.
    With nothing to count the block carries no `count` and COABuilder keeps
    the old header row.
    """
    icon = form_icon(db, parent)
    one, many = UNIT_WORDS.get(icon or "", DEFAULT_WORDS)
    out: dict = {"one": one, "many": many}
    if icon:
        out["icon"] = icon
    if single_vial:
        out["count"] = 1
        out["variance"] = False
        return out
    deferred = _deferred_roles(db, doc)
    vials = db.execute(
        select(LimsSubSample).where(LimsSubSample.parent_sample_pk == parent.id)
    ).scalars().all()
    used = [
        v for v in vials
        if v.assignment_role and v.assignment_role != UNASSIGNED_ROLE
        and v.assignment_role not in deferred
        and not (v.assignment_kind == "variance" and not v.in_variance_set)
    ]
    count = len(used)
    if used and not getattr(parent, "container_mode", True):
        count += 1  # the parent is vial 1 and carries the core results
    if count:
        out["count"] = count
        out["variance"] = any(v.assignment_kind == "variance" for v in used)
    return out
