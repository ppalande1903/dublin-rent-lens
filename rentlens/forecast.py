"""Four-quarter rent forecasts for each Dublin postal district.

One global gradient-boosted model learns next-quarter log growth from each district's recent growth
(lags), the Dublin-wide growth, and seasonality, pooling information across all 22 districts. It is
applied recursively for horizons 1-4 and backtested with a rolling origin against two baselines:
"no change" and "last year's growth continues". Prediction intervals come from the backtest's own
error distribution at each horizon (empirical quantiles), so they are as wide as the model has
actually been wrong.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

from .data import DISTRICTS
from .districts import reconstruct

LAGS = 4
H = 4


def district_series(rents: pd.DataFrame) -> pd.DataFrame:
    """Wide table: rows = quarter index t, columns = districts + 'Dublin', values = log average rent."""
    base = rents[(rents.beds == "All bedrooms") & (rents.ptype == "All property types")]
    d = reconstruct(rents).pivot_table(index="t", columns="district", values="rent")
    d["Dublin"] = base[base.level == "county"].set_index("t")["rent"]
    d = d[[c for c in DISTRICTS if c in d.columns] + ["Dublin"]].sort_index()
    return np.log(d.interpolate(limit_area="inside"))


def _rows(lr: pd.DataFrame, t_end: int) -> pd.DataFrame:
    """Training rows up to t_end: features at t, target = growth from t to t+1."""
    g = lr.diff()
    out = []
    for d in lr.columns.drop("Dublin"):
        for t in range(lr.index.min() + LAGS + 1, t_end):
            if t + 1 > t_end:
                break
            feats = [g.at[t - k, d] for k in range(LAGS)] + [g.at[t - k, "Dublin"] for k in range(2)]
            y = lr.at[t + 1, d] - lr.at[t, d]
            if np.isnan(feats).any() or np.isnan(y):
                continue
            out.append([d, (t + 1 + 3) % 4, *feats, y])
    cols = ["district", "qtr"] + [f"g{k}" for k in range(LAGS)] + ["dub0", "dub1", "y"]
    df = pd.DataFrame(out, columns=cols)
    df["district"] = pd.Categorical(df["district"], categories=list(lr.columns.drop("Dublin")))
    return df


def _model() -> HistGradientBoostingRegressor:
    return HistGradientBoostingRegressor(max_iter=300, learning_rate=0.04, max_leaf_nodes=15,
                                         min_samples_leaf=25, l2_regularization=1.0,
                                         categorical_features="from_dtype", random_state=7)


def _recursive(model, lr: pd.DataFrame, t0: int, horizon: int = H) -> pd.DataFrame:
    """Forecast log rent for t0+1..t0+horizon for every district, feeding predictions back in."""
    hist = lr.loc[:t0].copy()
    dists = list(lr.columns.drop("Dublin"))
    for h in range(1, horizon + 1):
        g = hist.diff()
        t = t0 + h - 1
        X = pd.DataFrame([[d, (t + 1 + 3) % 4, *[g.at[t - k, d] for k in range(LAGS)],
                           *[g.at[t - k, "Dublin"] for k in range(2)]] for d in dists],
                         columns=["district", "qtr"] + [f"g{k}" for k in range(LAGS)] + ["dub0", "dub1"])
        X["district"] = pd.Categorical(X["district"], categories=dists)
        step = model.predict(X)
        new = hist.loc[t].copy()
        new[dists] = hist.loc[t, dists].to_numpy() + step
        new["Dublin"] = hist.at[t, "Dublin"] + float(np.nanmean(step))  # Dublin moves with the districts
        hist.loc[t + 1] = new
    return hist.loc[t0 + 1:t0 + horizon]


def backtest(rents: pd.DataFrame, origins: int = 12) -> dict:
    """Rolling-origin evaluation over the last `origins` quarters with enough future data."""
    lr = district_series(rents)
    dists = list(lr.columns.drop("Dublin"))
    tmax = int(lr.index.max())
    errs = {m: {h: [] for h in range(1, H + 1)} for m in ("model", "naive", "drift")}
    log_resid = {h: [] for h in range(1, H + 1)}
    for t0 in range(tmax - H - origins + 1, tmax - H + 1):
        m = _model().fit(*_split(_rows(lr, t0)))
        fc = _recursive(m, lr, t0)
        yoy = (lr.loc[t0, dists] - lr.loc[t0 - 4, dists]) / 4
        for h in range(1, H + 1):
            actual = lr.loc[t0 + h, dists]
            preds = {"model": fc.loc[t0 + h, dists], "naive": lr.loc[t0, dists], "drift": lr.loc[t0, dists] + yoy * h}
            for name, p in preds.items():
                ok = actual.notna() & p.notna()
                errs[name][h].extend((np.abs(np.exp(p[ok]) - np.exp(actual[ok])) / np.exp(actual[ok]) * 100).tolist())
            ok = actual.notna()
            log_resid[h].extend((actual[ok] - preds["model"][ok]).tolist())
    table = [{"h": h, **{name: float(np.mean(errs[name][h])) for name in errs}, "n": len(errs["model"][h])}
             for h in range(1, H + 1)]
    bands = {h: [float(np.quantile(log_resid[h], 0.1)), float(np.quantile(log_resid[h], 0.9))] for h in log_resid}
    return {"origins": origins, "by_horizon": table, "resid_bands": bands}


def _split(df: pd.DataFrame):
    return df.drop(columns="y"), df["y"]


def forecast(rents: pd.DataFrame, bands: dict) -> pd.DataFrame:
    """Final forecast from the latest quarter, with backtest-calibrated 80% bands."""
    lr = district_series(rents)
    t0 = int(lr.index.max())
    m = _model().fit(*_split(_rows(lr, t0)))
    fc = _recursive(m, lr, t0)
    rows = []
    for h, t in enumerate(fc.index, start=1):
        lo, hi = bands[h]
        for d in fc.columns:
            v = fc.at[t, d]
            rows.append({"district": d, "t": int(t), "h": h, "mid": float(np.exp(v)),
                         "lo": float(np.exp(v + lo)), "hi": float(np.exp(v + hi))})
    return pd.DataFrame(rows)
