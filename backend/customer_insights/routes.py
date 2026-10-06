"""/reports/customers/* API (spec section 4). Shared by the UI and labmanager-mcp."""
from __future__ import annotations

import csv
import io
from datetime import date, datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import get_current_user
from customer_insights import metrics, rules, sources
from database import get_db

router = APIRouter(prefix="/reports/customers", tags=["customer-insights"])
Period = Literal["30d", "90d", "6m", "1y", "all"]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _tz(db: Session) -> str:
    import scheduled_publish as _sp
    return _sp.lab_tz(db)


class KpiInt(BaseModel):
    value: int
    prior: Optional[int] = None


class KpiMoney(BaseModel):
    value: str
    prior: Optional[str] = None


class KpiFloat(BaseModel):
    value: Optional[float] = None
    prior: Optional[float] = None


class Kpis(BaseModel):
    active_customers: KpiInt
    revenue: KpiMoney
    paid_orders: KpiInt
    aov: KpiMoney
    repeat_rate: KpiFloat
    median_days_to_second: KpiFloat


class MonthRevenue(BaseModel):
    month: str
    new: str
    returning: str


class Concentration(BaseModel):
    top10_share: float
    top_decile_share: float
    repeat_share: float
    median_ltv: str
    mean_ltv: str
    customers: int


class Attach(BaseModel):
    test: str
    new: float
    returning: float


class FirstOrder(BaseModel):
    kind: str
    customers: int
    repeat_rate: Optional[float] = None


class Meta(BaseModel):
    tz: str
    synced_at: Optional[str] = None


class SummaryResponse(Meta):
    kpis: Kpis
    revenue_by_month: list[MonthRevenue]
    concentration: Concentration
    attach: list[Attach]
    first_order: list[FirstOrder]


class CohortRow(BaseModel):
    cohort: str
    size: int
    cells: list[Optional[float]]


class CohortsResponse(Meta):
    months: list[str]
    rows: list[CohortRow]


class MonthSpend(BaseModel):
    month: str
    spend: str


class CustomerRow(BaseModel):
    key: str
    name: str
    email: Optional[str] = None
    company: Optional[str] = None
    period_spend: str
    prior_spend: str
    delta_pct: Optional[float] = None
    lifetime: str
    orders: int
    samples: int
    usual_gap_days: Optional[float] = None
    last_order_at: Optional[str] = None
    top_tests: list[str]
    status: str
    monthly: list[MonthSpend]


class AtRiskRow(CustomerRow):
    spend_12m: str
    overdue: float


class AtRiskResponse(Meta):
    rows: list[AtRiskRow]


class ListResponse(Meta):
    rows: list[CustomerRow]
    total: int
    page: int
    page_size: int


class OrderRow(BaseModel):
    customer_key: str
    order_id: int
    order_number: str
    paid_at: str
    net: str
    discount: str
    coupons: list[str]
    categories: list[str]
    samples: int
    tests: list[str]


class OrdersResponse(Meta):
    rows: list[OrderRow]
    total: int
    page: int
    page_size: int


def _ctx(db: Session, period: Optional[str], start: Optional[date], end: Optional[date], exclude: bool):
    now, tz = _now(), _tz(db)
    lo, hi = rules.resolve_period(period, start, end, now, tz)
    ds = metrics.scope(sources.load_dataset(db, now), exclude_launch=exclude)
    meta = {"tz": tz, "synced_at": ds.synced_at.isoformat() if ds.synced_at else None}
    return ds, lo, hi, tz, meta


@router.get("/summary", response_model=SummaryResponse)
def customers_summary(period: Period = "90d", start: Optional[date] = None, end: Optional[date] = None,
                      exclude_launch_accounts: bool = False, db: Session = Depends(get_db),
                      _u=Depends(get_current_user)):
    ds, lo, hi, tz, meta = _ctx(db, period, start, end, exclude_launch_accounts)
    return {**meta, **metrics.summary(ds, start=lo, end=hi, tz=tz)}


@router.get("/cohorts", response_model=CohortsResponse)
def customers_cohorts(exclude_launch_accounts: bool = True, db: Session = Depends(get_db),
                      _u=Depends(get_current_user)):
    ds, _lo, hi, tz, meta = _ctx(db, "all", None, None, exclude_launch_accounts)
    return {**meta, **metrics.cohorts(ds, end=hi, tz=tz)}


@router.get("/at-risk", response_model=AtRiskResponse)
def customers_at_risk(exclude_launch_accounts: bool = False, db: Session = Depends(get_db),
                      _u=Depends(get_current_user)):
    ds, _lo, hi, tz, meta = _ctx(db, "all", None, None, exclude_launch_accounts)
    return {**meta, "rows": metrics.at_risk(ds, end=hi, tz=tz)}


@router.get("/list", response_model=ListResponse)
def customers_list(period: Period = "90d", start: Optional[date] = None, end: Optional[date] = None,
                   exclude_launch_accounts: bool = False, search: str = "", sort: str = "period_spend",
                   dir: Literal["asc", "desc"] = "desc", page: int = Query(1, ge=1),
                   page_size: int = Query(50, ge=1, le=200), db: Session = Depends(get_db),
                   _u=Depends(get_current_user)):
    ds, lo, hi, tz, meta = _ctx(db, period, start, end, exclude_launch_accounts)
    rows = metrics.customer_rows(ds, start=lo, end=hi, tz=tz)
    q = search.strip().lower()
    if q:
        rows = [r for r in rows if q in " ".join(str(r.get(f) or "") for f in ("name", "email", "company", "key")).lower()]
    money_fields = {"period_spend", "prior_spend", "lifetime"}

    def keyf(r):
        v = r.get(sort)
        if sort in money_fields:
            return float(v)
        return (v is None, v if v is not None else 0)

    rows.sort(key=keyf, reverse=(dir == "desc"))
    total = len(rows)
    return {**meta, "rows": rows[(page - 1) * page_size: page * page_size], "total": total,
            "page": page, "page_size": page_size}


@router.get("/orders", response_model=OrdersResponse)
def customers_orders(period: Period = "all", start: Optional[date] = None, end: Optional[date] = None,
                     exclude_launch_accounts: bool = False, format: Literal["json", "csv"] = "json",
                     page: int = Query(1, ge=1), page_size: int = Query(500, ge=1, le=5000),
                     db: Session = Depends(get_db), _u=Depends(get_current_user)):
    ds, lo, hi, _tz_, meta = _ctx(db, period, start, end, exclude_launch_accounts)
    rows = metrics.order_rows(ds, start=lo, end=hi)
    if format == "csv":
        buf = io.StringIO()
        fields = list(OrderRow.model_fields)
        w = csv.DictWriter(buf, fieldnames=fields)
        w.writeheader()
        for r in rows:
            w.writerow({**r, "coupons": ";".join(r["coupons"]), "categories": ";".join(r["categories"]),
                        "tests": ";".join(r["tests"])})
        return Response(buf.getvalue(), media_type="text/csv",
                        headers={"Content-Disposition": "attachment; filename=customer-orders.csv"})
    return {**meta, "rows": rows[(page - 1) * page_size: page * page_size], "total": len(rows),
            "page": page, "page_size": page_size}


class Identity(BaseModel):
    key: str
    name: str
    email: Optional[str] = None
    company: Optional[str] = None
    wc_id: Optional[int] = None
    since: str


class DossierKpis(BaseModel):
    lifetime: str
    rank: int
    customers: int
    orders: int
    avg_order: str
    samples: int
    samples_per_order: float
    usual_gap_days: Optional[float] = None
    gap_iqr: Optional[list[float]] = None
    nonconforming_rate: Optional[float] = None
    lab_nonconforming_rate: Optional[float] = None
    on_time_rate: Optional[float] = None
    lab_on_time_rate: Optional[float] = None


class MonthSpendSamples(BaseModel):
    month: str
    spend: str
    samples: int


class TestShare(BaseModel):
    test: str
    share: float
    all_share: float


class AnalyteRate(BaseModel):
    product: str
    coas: int
    pass_rate: float


class RecentOrder(BaseModel):
    order_number: str
    paid_at: str
    coas: int
    failed: int
    sla: Optional[str] = None


class DossierResponse(Meta):
    identity: Identity
    kpis: DossierKpis
    status: str
    days_since_last: Optional[float] = None
    overdue: float
    spend_delta_pct: Optional[float] = None
    monthly: list[MonthSpendSamples]
    order_dates: list[str]
    test_mix: list[TestShare]
    analytes: list[AnalyteRate]
    recent: list[RecentOrder]
    orders: list[OrderRow]


# Declared LAST: FastAPI matches in order, so every fixed path above wins over the key.
@router.get("/{customer_key}", response_model=DossierResponse)
def customer_dossier(customer_key: str, db: Session = Depends(get_db), _u=Depends(get_current_user)):
    ds, _lo, hi, tz, meta = _ctx(db, "all", None, None, False)
    d = metrics.dossier(ds, customer_key.strip().lower() if customer_key.startswith("email:") else customer_key,
                        end=hi, tz=tz)
    if d is None:
        raise HTTPException(status_code=404, detail="customer not found")
    return {**meta, **d}
