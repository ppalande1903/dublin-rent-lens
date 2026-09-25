"""Fair-rent model: what does a segment (area x bedrooms x property type) typically rent for *now*?

RTB data lags by a few quarters, so this is a nowcast. For each segment we take its most recent
observed average rent (the "anchor") and predict the log growth since then with gradient-boosted
quantile regression. Features describe who the segment is (district, area, beds, type) and what the
market was doing when the anchor was observed (district momentum), plus how stale the anchor is.

Predicting growth rather than the level lets trees handle a trend they can't extrapolate, and the
anchor carries each segment's own history. Prediction intervals are conformalised on a held-out year
(CQR, Romano et al. 2019) so the 80% range really covers ~80% of outcomes.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

from .districts import reconstruct

BEDS = ["One bed", "Two bed", "Three bed", "Four plus bed", "All bedrooms"]
PTYPES = ["Apartment", "Terrace house", "Semi detached house", "Detached house", "Other flats", "All property types"]
MAX_AGE = 6          # anchor may be up to 6 quarters old
LOW, HIGH = 0.10, 0.90
CAT = ["location", "district", "level", "beds", "ptype"]
NUM = ["age", "anchor", "mom_4q", "mom_1q", "drift", "t_anchor", "qtr"]


def segments(rents: pd.DataFrame) -> pd.DataFrame:
    """Segment-level rows (specific beds and property type) for Dublin areas."""
    d = rents[rents.level.isin(["district", "neighbourhood", "county_town"])
              & rents.beds.isin(BEDS) & rents.ptype.isin(PTYPES)].copy()
    d["district"] = d["district"].fillna("Co. Dublin")
    d["logr"] = np.log(d["rent"])
    return d[["location", "district", "level", "area", "beds", "ptype", "t", "logr"]]


def district_momentum(rents: pd.DataFrame) -> pd.DataFrame:
    """Log growth of each district's all-beds/all-types average over the last 1 and 4 quarters, by quarter."""
    county = rents[(rents.beds == "All bedrooms") & (rents.ptype == "All property types") & (rents.level == "county")]
    county = county.assign(district="Co. Dublin")[["district", "t", "rent"]]  # stands in for towns outside the districts
    base = pd.concat([reconstruct(rents)[["district", "t", "rent"]], county])
    base = base.groupby(["district", "t"])["rent"].mean().unstack("t").sort_index(axis=1)
    lr = np.log(base)
    m4 = (lr - lr.shift(4, axis=1)).stack().rename("mom_4q")
    m1 = (lr - lr.shift(1, axis=1)).stack().rename("mom_1q")
    return pd.concat([m4, m1], axis=1).reset_index()


def make_pairs(seg: pd.DataFrame, mom: pd.DataFrame, targets_t, anchor_max_t: int | None = None) -> pd.DataFrame:
    """(anchor, target) pairs: for each target quarter, the segment's latest observation 1..MAX_AGE quarters
    earlier. With anchor_max_t, anchors may not be later than that quarter (no peeking past a cutoff)."""
    key = ["location", "beds", "ptype"]
    out = []
    targets = seg[seg.t.isin(targets_t)]
    grp = seg.groupby(key)
    hist = {k: g.sort_values("t")[["t", "logr"]].to_numpy() for k, g in grp}
    for row in targets.itertuples(index=False):
        h = hist[(row.location, row.beds, row.ptype)]
        limit = row.t - 1 if anchor_max_t is None else min(row.t - 1, anchor_max_t)
        prior = h[(h[:, 0] <= limit) & (h[:, 0] >= row.t - MAX_AGE)]
        if not len(prior):
            continue
        ta, la = prior[-1]
        out.append((row.location, row.district, row.level, row.area, row.beds, row.ptype,
                    int(ta), la, row.t - int(ta), row.t, row.logr))
    df = pd.DataFrame(out, columns=["location", "district", "level", "area", "beds", "ptype",
                                    "t_anchor", "anchor", "age", "t", "logr"])
    df = df.merge(mom.rename(columns={"t": "t_anchor"}), on=["district", "t_anchor"], how="left")
    df["qtr"] = (df["t"] + 3) % 4  # quarter of year of the target (0 = Q1)
    df["drift"] = df["mom_4q"].fillna(0) * df["age"] / 4  # baseline: district's trailing growth continues
    df["y"] = df["logr"] - df["anchor"] - df["drift"]    # the model learns a correction to that baseline
    return df


def _features(df: pd.DataFrame, cats: dict) -> pd.DataFrame:
    X = df[CAT + NUM].copy()
    for c in CAT:
        X[c] = pd.Categorical(X[c], categories=cats[c])
    return X


@dataclass
class FairRentModel:
    cats: dict = field(default_factory=dict)
    models: dict = field(default_factory=dict)
    qhat: float = 0.0  # CQR widening (in log space)

    def fit(self, pairs: pd.DataFrame) -> "FairRentModel":
        self.cats = {c: sorted(pairs[c].astype(str).unique()) for c in CAT}
        X = _features(pairs, self.cats)
        for name, q in (("lo", LOW), ("mid", 0.5), ("hi", HIGH)):
            m = HistGradientBoostingRegressor(loss="quantile", quantile=q, max_iter=400, learning_rate=0.05,
                                              max_leaf_nodes=31, min_samples_leaf=40,
                                              categorical_features="from_dtype", random_state=7)
            self.models[name] = m.fit(X, pairs["y"])
        return self

    def predict_log(self, pairs: pd.DataFrame) -> pd.DataFrame:
        X = _features(pairs, self.cats)
        lo, mid, hi = (self.models[k].predict(X) for k in ("lo", "mid", "hi"))
        lo, hi = np.minimum(lo, mid), np.maximum(hi, mid)  # guard against quantile crossing
        a = (pairs["anchor"] + pairs["drift"]).to_numpy()
        return pd.DataFrame({"lo": a + lo - self.qhat, "mid": a + mid, "hi": a + hi + self.qhat}, index=pairs.index)

    def calibrate(self, pairs: pd.DataFrame) -> float:
        """Split-conformal widening so [lo, hi] reaches the nominal coverage on held-out data."""
        self.qhat = 0.0
        p = self.predict_log(pairs)
        scores = np.maximum(p["lo"] - pairs["logr"], pairs["logr"] - p["hi"]).to_numpy()
        n, alpha = len(scores), 1 - (HIGH - LOW)
        level = min(1.0, np.ceil((n + 1) * (1 - alpha)) / n)
        self.qhat = float(np.quantile(scores, level, method="higher"))
        return self.qhat


def mape(actual_log, pred_log) -> float:
    a, p = np.exp(actual_log), np.exp(pred_log)
    return float(np.mean(np.abs(p - a) / a) * 100)


def evaluate(rents: pd.DataFrame) -> dict:
    """Train <= 2023, calibrate on 2024, test on 2025 with anchors frozen at 2024 Q4 (a true nowcast)."""
    seg, mom = segments(rents), district_momentum(rents)
    tmax = int(seg.t.max())
    test_t = range(tmax - 3, tmax + 1)
    cal_t = range(tmax - 7, tmax - 3)
    train = make_pairs(seg, mom, range(0, tmax - 7))
    cal = make_pairs(seg, mom, cal_t, anchor_max_t=tmax - 8)
    test = make_pairs(seg, mom, test_t, anchor_max_t=tmax - 4)

    model = FairRentModel().fit(train)
    qhat = model.calibrate(cal)
    pred = model.predict_log(test)

    # baselines: (1) carry the last value forward; (2) carry forward x the district's trailing 4q growth
    carry = test["anchor"]
    drift = test["anchor"] + test["drift"]
    covered = ((test["logr"] >= pred["lo"]) & (test["logr"] <= pred["hi"])).mean()
    width = (np.exp(pred["hi"]) - np.exp(pred["lo"])) / np.exp(pred["mid"])

    by_age = []
    for age, g in test.groupby("age"):
        if len(g) < 20:  # too few to report
            continue
        by_age.append({"age": int(age), "n": len(g), "model": mape(g.logr, pred.loc[g.index, "mid"]),
                       "carry_forward": mape(g.logr, carry[g.index]), "district_drift": mape(g.logr, drift[g.index])})
    return {
        "train_rows": len(train), "cal_rows": len(cal), "test_rows": len(test),
        "test_quarters": [int(t) for t in test_t],
        "mape": {"model": mape(test.logr, pred["mid"]), "carry_forward": mape(test.logr, carry),
                 "district_drift": mape(test.logr, drift)},
        "interval": {"nominal": HIGH - LOW, "coverage": float(covered), "median_rel_width": float(width.median()),
                     "conformal_widening_log": qhat},
        "by_age": by_age,
    }


def fit_final(rents: pd.DataFrame) -> tuple[FairRentModel, pd.DataFrame, pd.DataFrame]:
    """Fit on everything, calibrate on the latest year, and return (model, segments, momentum)."""
    seg, mom = segments(rents), district_momentum(rents)
    tmax = int(seg.t.max())
    # conformal offset from a held-out final year, then refit on everything so the latest growth is learned
    probe = FairRentModel().fit(make_pairs(seg, mom, range(0, tmax - 3)))
    qhat = probe.calibrate(make_pairs(seg, mom, range(tmax - 3, tmax + 1), anchor_max_t=tmax - 4))
    model = FairRentModel().fit(make_pairs(seg, mom, range(0, tmax + 1)))
    model.qhat = qhat
    return model, seg, mom


def nowcast(model: FairRentModel, seg: pd.DataFrame, mom: pd.DataFrame, target_t: int) -> pd.DataFrame:
    """Predict every segment's typical rent at target_t from its latest observation."""
    key = ["location", "district", "level", "area", "beds", "ptype"]
    last = seg.sort_values("t").groupby(["location", "beds", "ptype"]).tail(1)
    last = last[last.t >= target_t - MAX_AGE]  # only segments with a recent enough observation
    df = last.rename(columns={"t": "t_anchor", "logr": "anchor"})[key + ["t_anchor", "anchor"]].copy()
    df["t"] = target_t
    df["age"] = target_t - df["t_anchor"]
    df = df.merge(mom.rename(columns={"t": "t_anchor"}), on=["district", "t_anchor"], how="left")
    df["qtr"] = (df["t"] + 3) % 4
    df["drift"] = df["mom_4q"].fillna(0) * df["age"] / 4
    p = model.predict_log(df)
    df["typical"], df["lo"], df["hi"] = np.exp(p["mid"]), np.exp(p["lo"]), np.exp(p["hi"])
    df["last_rent"] = np.exp(df["anchor"])
    return df
