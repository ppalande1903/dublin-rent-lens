"""End-to-end pipeline: fetch -> clean -> reconstruct -> evaluate -> fit -> export JSON for the site.

    python -m rentlens.pipeline            # use cached raw files if present
    python -m rentlens.pipeline --refresh  # re-download from the CSO and PSRA
"""
from __future__ import annotations

import argparse
import json
import time
from datetime import date
from pathlib import Path

import pandas as pd

from . import data, districts, fair, forecast, metrics
from .metrics import last_full_year, qlabel, safe

SITE_DATA = data.ROOT / "site" / "data"


def current_t(today: date | None = None) -> int:
    today = today or date.today()
    return (today.year - 2007) * 4 + (today.month - 1) // 3 - 3


def dump(name: str, obj) -> None:
    SITE_DATA.mkdir(parents=True, exist_ok=True)
    (SITE_DATA / name).write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False))


def run(refresh: bool = False) -> dict:
    t0 = time.time()
    rents, sales = data.build(force_fetch=refresh)
    log = {"rents_rows": len(rents), "sales_rows": len(sales)}

    # ---- district series (official to 2021 Q4, reconstructed after) -------------------------
    dist = districts.reconstruct(rents)
    recon_eval = districts.validate(rents)
    tmax = int(rents.t.max())

    # ---- models ---------------------------------------------------------------------------
    fair_eval = fair.evaluate(rents)
    model, seg, mom = fair.fit_final(rents)
    now_t = min(current_t(), tmax + fair.MAX_AGE)
    nc = fair.nowcast(model, seg, mom, now_t)

    fc_eval = forecast.backtest(rents)
    fc = forecast.forecast(rents, fc_eval["resid_bands"])

    # ---- Dublin-wide ----------------------------------------------------------------------
    a = rents[(rents.level == "county") & (rents.ptype == "All property types")]
    dub = a[a.beds == "All bedrooms"].set_index("t")["rent"]
    by_beds = {b: [[int(t), round(v, 1)] for t, v in a[a.beds == b].set_index("t")["rent"].items()]
               for b in ["One bed", "Two bed", "Three bed", "Four plus bed"]}
    peak_t = int(dub.loc[:8].idxmax())
    trough_t = int(dub.loc[8:30].idxmin())
    dprices = metrics.dublin_prices(sales)

    dump("dublin.json", {
        "series": [[int(t), round(v, 1)] for t, v in dub.items()],
        "by_beds": by_beds,
        "forecast": [{k: safe(v) for k, v in r.items()} for r in fc[fc.district == "Dublin"].to_dict("records")],
        "latest": {"t": tmax, "rent": safe(dub[tmax]), "yoy": safe(metrics.growth(dub, tmax, 4)),
                   "five_year": safe(metrics.growth(dub, tmax, 20)), "ten_year": safe(metrics.growth(dub, tmax, 40))},
        "peak_2007_08": {"t": peak_t, "rent": safe(dub[peak_t])},
        "trough": {"t": trough_t, "rent": safe(dub[trough_t])},
        "prices": [[int(r.year), safe(r["median"]), int(r["count"])] for _, r in dprices.iterrows()],
    })

    # ---- districts --------------------------------------------------------------------------
    lfl = metrics.like_for_like(nc)
    year = last_full_year(tmax)
    y25 = metrics.yields(sales, dist, year)
    yp = metrics.yearly_prices(sales)
    nb_names = (rents[rents.level == "neighbourhood"].groupby("district")["area"]
                .apply(lambda s: sorted(set(s))).to_dict())
    out = []
    for d in data.DISTRICTS:
        s = dist[dist.district == d].set_index("t")
        rs = s["rent"]
        y = y25[y25.district == d]
        prices = yp[yp.district == d]
        p15 = prices.set_index("year")["median"]
        out.append({
            "id": d,
            "neighbourhoods": nb_names.get(d, []),
            "series": [[int(t), round(r.rent, 1), r.source[0]] for t, r in s.iterrows()],
            "latest": safe(rs.get(tmax)),
            "yoy": safe(metrics.growth(rs, tmax, 4)),
            "five_year": safe(metrics.growth(rs, tmax, 20)),
            "since_2015": safe(metrics.growth(rs, tmax, tmax - 29)),  # 2015 Q1 = t 29
            "forecast": [{k: safe(v) for k, v in r.items() if k != "district"} for r in fc[fc.district == d].to_dict("records")],
            "like_for_like": {f"{r.beds}|{r.ptype}": {"typical": safe(r.typical), "n_areas": r.n_areas}
                              for r in lfl[lfl.district == d].itertuples()},
            "sales": {
                "median_price": safe(y.median_price.iloc[0]) if len(y) else None,
                "n_sales": int(y.n_sales.iloc[0]) if len(y) else 0,
                "gross_yield": safe(y.gross_yield.iloc[0]) if len(y) else None,
                "price_to_rent": safe(y.price_to_rent.iloc[0]) if len(y) else None,
                "yearly": [[int(r.year), safe(r["median"]), int(r["count"])] for _, r in prices.iterrows()],
                "price_growth_since_2015": safe(p15[year] / p15[2015] - 1) if {2015, year} <= set(p15.index) else None,
            },
        })
    dump("districts.json", out)

    # ---- fair-rent checker ------------------------------------------------------------------
    segs = [[r.area, r.district, r.level[0], r.beds, r.ptype,
             round(r.typical), round(r.lo), round(r.hi), round(r.last_rent), int(r.t_anchor)]
            for r in nc.itertuples()]
    dump("segments.json", {"t": now_t, "cols": ["area", "district", "level", "beds", "ptype",
                                               "typical", "lo", "hi", "last_rent", "last_t"], "rows": segs})

    # ---- evaluation & meta --------------------------------------------------------------------
    dump("evaluation.json", {"fair_rent": fair_eval, "forecast": fc_eval, "reconstruction": recon_eval})
    meta = {
        "generated": date.today().isoformat(),
        "rent_data_to": qlabel(tmax), "rent_t": tmax,
        "nowcast_for": qlabel(now_t), "nowcast_t": now_t,
        "sales_to": sales.date.max().date().isoformat(),
        "yield_year": year,
        "n_segments": len(segs), "n_sales": len(sales), "n_rent_rows": len(rents),
        "runtime_s": round(time.time() - t0, 1),
    }
    dump("meta.json", meta)
    return {**log, **meta}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="re-download the raw data")
    print(json.dumps(run(ap.parse_args().refresh), indent=2))
