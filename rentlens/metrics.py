"""Descriptive metrics: growth, like-for-like rents, and rent-vs-buy gross yields per district."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .data import DISTRICTS

LIKE_FOR_LIKE = [("One bed", "Apartment"), ("Two bed", "Apartment"), ("Three bed", "Semi detached house")]


def qlabel(t: int) -> str:
    """Quarter index (0 = 2007 Q4) -> '2025 Q4'."""
    n = t + 3  # quarters since 2007 Q1
    return f"{2007 + n // 4} Q{n % 4 + 1}"


def last_full_year(t: int) -> int:
    """Latest calendar year fully covered by data ending at quarter t."""
    n = t + 3
    return 2007 + n // 4 if n % 4 == 3 else 2007 + n // 4 - 1


def growth(series: pd.Series, t: int, back: int) -> float | None:
    if t in series.index and (t - back) in series.index:
        return float(series[t] / series[t - back] - 1)
    return None


def like_for_like(nowcast: pd.DataFrame) -> pd.DataFrame:
    """Median nowcast typical rent across each district's neighbourhoods, for fixed unit types."""
    rows = []
    for beds, ptype in LIKE_FOR_LIKE:
        sub = nowcast[(nowcast.beds == beds) & (nowcast.ptype == ptype) & (nowcast.level != "county_town")]
        med = sub.groupby("district")["typical"].agg(["median", "count"])
        for d, r in med.iterrows():
            rows.append({"district": d, "beds": beds, "ptype": ptype, "typical": float(r["median"]), "n_areas": int(r["count"])})
    return pd.DataFrame(rows)


def yields(sales: pd.DataFrame, district_rent: pd.DataFrame, year: int) -> pd.DataFrame:
    """Gross yield = 12 x average monthly rent in `year` / median sale price in `year`, per district.

    Both sides are district averages across all property types, so this is a market-level
    indicator (how expensive buying is relative to renting), not a promise of any one property's return.
    """
    s = sales[sales.date.dt.year == year].groupby("district")["price"].agg(["median", "count"])
    r = district_rent[(district_rent.t >= (year - 2007) * 4 - 3) & (district_rent.t <= (year - 2007) * 4)]
    r = r.groupby("district")["rent"].mean()
    out = s.join(r, how="inner").rename(columns={"median": "median_price", "count": "n_sales", "rent": "avg_rent"})
    out["gross_yield"] = out["avg_rent"] * 12 / out["median_price"]
    out["price_to_rent"] = out["median_price"] / (out["avg_rent"] * 12)
    return out.reset_index()


def yearly_prices(sales: pd.DataFrame) -> pd.DataFrame:
    return (sales.assign(year=sales.date.dt.year).groupby(["district", "year"])["price"]
            .agg(["median", "count"]).reset_index())


def dublin_prices(sales: pd.DataFrame) -> pd.DataFrame:
    return sales.assign(year=sales.date.dt.year).groupby("year")["price"].agg(["median", "count"]).reset_index()


def ordered(df: pd.DataFrame, col: str = "district") -> pd.DataFrame:
    order = {d: i for i, d in enumerate(DISTRICTS)}
    return df.assign(_o=df[col].map(order)).sort_values("_o").drop(columns="_o")


def safe(x):
    """JSON-friendly float (None for NaN)."""
    if x is None:
        return None
    try:
        return None if np.isnan(x) else round(float(x), 4)
    except TypeError:
        return x
