"""Twin contract for the sample_meta wire block (read-independence spec
§2/§3, final review I2). The literal tuple/frozenset below are byte-identical
twins of coabuilder's tests/test_sample_meta_contract.py::
test_contract_literals_pinned -- move both sides together, never one alone.

Before this test existed, only the coab side pinned the literals; Mk1's own
test_sample_meta_producer.py merely asserted
`for k in SAMPLE_META_SCALARS: assert k in meta`, which is tautological --
a rename or removal of a scalar (or a role) on the Mk1 producer would ship
green with no test anywhere catching the twin going out of sync."""
from coa.sample_meta import ATTACHMENT_ROLES, SAMPLE_META_SCALARS

EXPECTED_SCALARS = (
    "SampleID", "SampleTypeTitle", "ClientSampleID", "DateReceived",
    "DeclaredTotalQuantity", "ClientLot", "BatchID",
    "CoaCompanyName", "CoaEmail", "CoaWebsite", "CoaAddress",
    "CompanyLogoUrl", "ChromatographBackgroundUrl",
)


def test_contract_literals_pinned():
    assert SAMPLE_META_SCALARS == EXPECTED_SCALARS
    assert ATTACHMENT_ROLES == frozenset({"sample_image", "chromatogram_csv"})
