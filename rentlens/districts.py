"""Reconstruct Dublin postal-district rent series after the RTB stopped publishing them.

The RTB report carries "Dublin 8"-style district averages only up to 2021 Q4, but keeps publishing
the neighbourhoods inside each district (Rialto, Inchicore, ...). We extend each district by chaining:
from the last official value, each quarter moves by the average log change of the district's
neighbourhoods observed in both quarters (a chain-linked index, like the CSO's own price indices).

`validate()` measures how well this works where the truth is known: it rebuilds 2014-2021 from a
2013 anchor using only neighbourhoods and compares against the official district figures.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .data import DISTRICTS


def _all(rents: pd.DataFrame) -> pd.DataFrame:
    return rents[(rents.beds == "All bedrooms") & (rents.ptype == "All property types")]


def _chain_growth(nb: pd.DataFrame) -> pd.Series:
    """Mean log change across neighbourhoods present in consecutive quarters, indexed by the later quarter."""
    wide = np.log(nb.pivot_table(index="t", columns="location", values="rent")).sort_index()
    return wide.diff().mean(axis=1, skipna=True).where(wide.diff().notna().sum(axis=1) > 0)


def reconstruct(rents: pd.DataFrame, cutover: int | None = None) -> pd.DataFrame:
    """Long table (district, t, rent, source) covering every quarter. With `cutover`, official values after
    that quarter are ignored (used for validation)."""
    a = _all(rents)
    out = []
    for d in DISTRICTS:
        off = a[(a.level == "district") & (a.district == d)].set_index("t")["rent"].sort_index()
        nb = a[(a.level == "neighbourhood") & (a.district == d)]
        growth = _chain_growth(nb) if len(nb) else pd.Series(dtype=float)
        last_official = off.index.max() if cutover is None else min(off.index.max(), cutover)
        for t, v in off.loc[:last_official].items():
            out.append((d, int(t), float(v), "official"))
        level = np.log(off.loc[last_official])
        for t in sorted(x for x in growth.index if x > last_official):
            g = growth.get(t)
            if pd.isna(g):
                continue
            level += g
            out.append((d, int(t), float(np.exp(level)), "reconstructed"))
    return pd.DataFrame(out, columns=["district", "t", "rent", "source"])


def validate(rents: pd.DataFrame, cutover: int = 24) -> dict:
    """Rebuild the years after `cutover` (default 2013 Q4) and compare with the official series."""
    a = _all(rents)
    rec = reconstruct(rents, cutover=cutover)
    rec = rec[rec.source == "reconstructed"]
    off = a[a.level == "district"][["district", "t", "rent"]].rename(columns={"rent": "official"})
    m = rec.merge(off, on=["district", "t"])
    m["ape"] = (m["rent"] - m["official"]).abs() / m["official"] * 100
    m["years_out"] = (m["t"] - cutover) / 4
    by_year = m.assign(y=np.ceil(m.years_out).astype(int)).groupby("y")["ape"].mean()
    return {"quarters_compared": len(m), "mape": float(m.ape.mean()), "median_ape": float(m.ape.median()),
            "mape_by_years_since_anchor": {int(k): float(v) for k, v in by_year.items()}}
