from typing import Any, Optional
from pydantic import BaseModel, ConfigDict


class ConformanceRow(BaseModel):
    model_config = ConfigDict(extra="allow")
    test_name: str = ""
    analyte_name: str = ""
    test_type: str = ""
    specification: str = ""
    result: str = ""
    status: str = ""
    conforms: Optional[bool] = None
    unit: str = ""


class ConformanceResponse(BaseModel):
    sample_id: str
    engine: str  # "peptide" | "generic"
    matrix: str
    overall_pass: bool
    overall_status_badge: str
    results_table: list[ConformanceRow]
    addon_results: list[dict[str, Any]]
    nonconformance_reasons: list[str]
