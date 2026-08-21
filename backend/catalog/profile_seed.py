"""Seed analysis_profiles from the hardcoded PRODUCT_REGISTRY.

The registry in sub_samples/product_registry.py IS the profile concept, written
in Python instead of rows — its own docstring says "Adding a product = add one
ProductDef". This promotes it to data with no behavior change, proven by
test_profile_parity.py.

Idempotent: only inserts profiles whose key is absent, so a later admin edit
survives a restart.
"""
import logging

from sqlalchemy.orm import Session

log = logging.getLogger(__name__)


def seed_profiles_from_registry(db: Session) -> None:
    from models import AnalysisProfile
    from sub_samples.product_registry import PRODUCT_REGISTRY

    existing = {k for (k,) in db.query(AnalysisProfile.key).all()}
    created = 0
    for i, (key, pdef) in enumerate(PRODUCT_REGISTRY.items()):
        if key in existing:
            continue
        db.add(AnalysisProfile(
            key=pdef.key,
            name=pdef.label,
            is_addon=pdef.is_addon,
            vials_required=0,          # wired to real demand in spec 3
            fulfillment_role=pdef.fulfillment_role,
            fulfillment_dim=pdef.fulfillment_dim,
            sort_order=i,
        ))
        created += 1
    db.commit()
    if created:
        log.info("catalog.profile_seed created=%s", created)
