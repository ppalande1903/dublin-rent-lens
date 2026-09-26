from datetime import date

import numpy as np
import pandas as pd
import pytest

from rentlens import data, districts, fair
from rentlens.metrics import last_full_year, qlabel, yields
from rentlens.pipeline import current_t


# ------------------------------------------------------------------ parsing
@pytest.mark.parametrize("label,expected", [
    ("Dublin", ("county", None, "Dublin")),
    ("Dublin 6W", ("district", "D6W", "Dublin 6W")),
    ("Rathmines, Dublin 6", ("neighbourhood", "D6", "Rathmines")),
    ("Kilmainham , Dublin 8", ("neighbourhood", "D8", "Kilmainham")),
    ("Swords, Dublin", ("county_town", None, "Swords")),
    ("Cork City", ("other", None, "Cork City")),
])
def test_parse_location(label, expected):
    info = data.parse_location(label)
    assert (info["level"], info["district"], info["area"]) == expected


@pytest.mark.parametrize("address,eircode,expected", [
    ("5 Main St, Dublin 8", "", "D8"),
    ("Apt 2, Somewhere, Co. Dublin", "D08 X2Y3", "D8"),
    ("Anywhere", "D6W AB12", "D6W"),
    ("Swords, Co. Dublin", "K67 AB12", None),
    ("Something, Dublin 19", "", None),  # no such postal district
])
def test_sale_district(address, eircode, expected):
    assert data.sale_district(address, eircode) == expected


def test_quarter_helpers():
    assert qlabel(0) == "2007 Q4"
    assert qlabel(72) == "2025 Q4"
    assert current_t(date(2026, 9, 25)) == 75  # 2026 Q3
    assert qlabel(current_t(date(2026, 1, 1))) == "2026 Q1"
    assert last_full_year(72) == 2025 and last_full_year(71) == 2024


# ------------------------------------------------------------------ synthetic rents
def _synthetic(n_q=40, seed=0):
    """Two districts, each with two neighbourhoods; district series stop half way, like the real data."""
    rng = np.random.default_rng(seed)
    rows = []
    for d, base in (("D1", 1000), ("D2", 1500)):
        growth = np.cumsum(rng.normal(0.01, 0.005, n_q))
        dist_level = base * np.exp(growth)
        for t in range(n_q):
            common = dict(beds="All bedrooms", ptype="All property types", district=d, t=t)
            if t < n_q // 2:
                rows.append({**common, "location": f"Dublin {d[1:]}", "level": "district", "area": f"Dublin {d[1:]}",
                             "rent": dist_level[t]})
            for k, mult in enumerate((0.9, 1.1)):
                rows.append({**common, "location": f"N{k}, Dublin {d[1:]}", "level": "neighbourhood", "area": f"N{k}",
                             "rent": dist_level[t] * mult * np.exp(rng.normal(0, 0.003))})
    for t in range(n_q):
        rows.append(dict(beds="All bedrooms", ptype="All property types", district=None, t=t, location="Dublin",
                         level="county", area="Dublin", rent=1200 * np.exp(0.01 * t)))
    return pd.DataFrame(rows)


def test_reconstruct_extends_every_district_without_gaps(monkeypatch):
    monkeypatch.setattr(districts, "DISTRICTS", ["D1", "D2"])
    rents = _synthetic()
    rec = districts.reconstruct(rents)
    for d in ("D1", "D2"):
        s = rec[rec.district == d].sort_values("t")
        assert s.t.tolist() == list(range(40))
        assert set(s[s.t >= 20].source) == {"reconstructed"}
    # the chain follows the true growth closely when neighbourhoods move with their district
    v = districts.validate(rents, cutover=10)
    assert v["mape"] < 1.0


def test_pairs_never_use_anchors_after_the_cutoff():
    seg = pd.DataFrame({"location": "A", "district": "D1", "level": "neighbourhood", "area": "A",
                        "beds": "One bed", "ptype": "Apartment", "t": range(20), "logr": np.linspace(7, 7.5, 20)})
    mom = pd.DataFrame({"district": "D1", "t": range(20), "mom_4q": 0.04, "mom_1q": 0.01})
    pairs = fair.make_pairs(seg, mom, range(16, 20), anchor_max_t=15)
    assert len(pairs) == 4
    assert (pairs.t_anchor <= 15).all()
    assert (pairs.age == pairs.t - pairs.t_anchor).all()
    assert pairs.age.tolist() == [1, 2, 3, 4]


def test_conformal_calibration_reaches_nominal_coverage():
    rng = np.random.default_rng(1)
    n = 3000
    df = pd.DataFrame({
        "location": rng.choice(list("ABCDE"), n), "district": "D1", "level": "neighbourhood",
        "beds": "One bed", "ptype": "Apartment", "age": rng.integers(1, 5, n), "anchor": 7.0,
        "mom_4q": rng.normal(0.05, 0.02, n), "mom_1q": 0.01, "t_anchor": 10, "qtr": 0,
    })
    df["drift"] = df["mom_4q"] * df["age"] / 4
    df["logr"] = df["anchor"] + df["drift"] + rng.normal(0, 0.03, n)
    df["y"] = df["logr"] - df["anchor"] - df["drift"]
    train, cal, test = df.iloc[:1500], df.iloc[1500:2250], df.iloc[2250:]
    m = fair.FairRentModel().fit(train)
    m.calibrate(cal)
    p = m.predict_log(test)
    coverage = ((test.logr >= p.lo) & (test.logr <= p.hi)).mean()
    assert 0.74 <= coverage <= 0.88


# ------------------------------------------------------------------ rent vs buy
def test_yields_use_only_the_given_years_quarters_and_sales():
    # 2024 is t = 65..68 (Q1..Q4); t = 64 is 2023 Q4 and t = 69 is 2025 Q1, which must not leak in.
    rent = pd.DataFrame({"district": "D1", "t": [64, 65, 66, 67, 68, 69], "rent": [9999, 1900, 2000, 2000, 2100, 9999]})
    sales = pd.DataFrame({
        "district": ["D1", "D1", "D1", "D1", "D2"],
        "date": pd.to_datetime(["2024-02-01", "2024-06-01", "2024-11-30", "2025-01-15", "2024-05-01"]),
        "price": [300_000, 400_000, 500_000, 9_999_999, 350_000],
    })
    out = yields(sales, rent, 2024)
    assert out.district.tolist() == ["D1"]  # D2 has sales but no rent, so it is dropped
    row = out.iloc[0]
    assert row.avg_rent == 2000 and row.median_price == 400_000 and row.n_sales == 3
    assert row.gross_yield == pytest.approx(0.06)
    assert row.price_to_rent == pytest.approx(1 / 0.06)
