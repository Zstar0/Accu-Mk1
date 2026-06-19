from models import AnalysisService


def test_analysis_service_has_variance_capable_default_false():
    svc = AnalysisService(title="pH Determination", keyword="PH-DETERM")
    assert hasattr(svc, "variance_capable")
    assert "variance_capable" in AnalysisService.__table__.columns
    col = AnalysisService.__table__.columns["variance_capable"]
    assert col.nullable is False
    assert col.server_default is not None
    assert AnalysisService(title="x", keyword="y").variance_capable in (False, None)
