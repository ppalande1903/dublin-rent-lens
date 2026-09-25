"""Download and tidy the two public datasets behind Dublin Rent Lens.

* RTB Average Monthly Rent Report (CSO table RIQ02): quarterly average rent by
  location, bedrooms and property type, 2007 Q4 onwards.
* Property Price Register (PSRA): every residential sale in Ireland since 2010.

Both are fetched from their official endpoints; nothing is scraped.
"""
from __future__ import annotations

import csv
import io
import json
import re
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
PROCESSED = ROOT / "data" / "processed"

RTB_URL = "https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadDataset/RIQ02/JSON-stat/2.0/en"
PPR_URL = "https://www.propertypriceregister.ie/website/npsra/ppr/npsra-ppr.nsf/Downloads/PPR-ALL.zip/$FILE/PPR-ALL.zip"

# Dublin postal districts as they appear in both datasets. Odd numbers north of the Liffey.
DISTRICTS = ["D1", "D2", "D3", "D4", "D5", "D6", "D6W", "D7", "D8", "D9", "D10", "D11", "D12",
             "D13", "D14", "D15", "D16", "D17", "D18", "D20", "D22", "D24"]
VAT_RATE = 0.135  # VAT on new residential property; PPR marks some new-build prices "VAT exclusive"


def fetch(force: bool = False) -> None:
    """Download the raw files into data/raw (skipped if present unless force=True)."""
    RAW.mkdir(parents=True, exist_ok=True)
    for url, name in ((RTB_URL, "RIQ02.json"), (PPR_URL, "PPR-ALL.zip")):
        path = RAW / name
        if path.exists() and not force:
            continue
        r = requests.get(url, timeout=300, headers={"User-Agent": "dublin-rent-lens (open-data research)"})
        r.raise_for_status()
        path.write_bytes(r.content)


# ---------------------------------------------------------------- rents
def district_code(text: str) -> str | None:
    """'Dublin 6W' -> 'D6W', 'Rathmines, Dublin 6' -> 'D6', 'Swords, Dublin' -> None."""
    m = re.search(r"\bDublin\s+(6W|\d{1,2})\b", text, flags=re.I)
    if not m:
        return None
    code = "D" + m.group(1).upper()
    return code if code in DISTRICTS else None


def parse_location(label: str) -> dict:
    """Split an RTB location label into level / district / neighbourhood."""
    label = re.sub(r"\s+,", ",", label.strip())
    if label == "Dublin":
        return {"level": "county", "district": None, "area": "Dublin"}
    if "Dublin" not in label:
        return {"level": "other", "district": None, "area": label}
    code = district_code(label)
    if "," not in label:
        return {"level": "district", "district": code, "area": label}
    area = label.split(",")[0].strip()
    if code is None:  # e.g. "Swords, Dublin": a town in county Dublin outside the postal districts
        return {"level": "county_town", "district": None, "area": area}
    return {"level": "neighbourhood", "district": code, "area": area}


def load_rents(path: Path | None = None) -> pd.DataFrame:
    """Decode the JSON-stat cube into a tidy DataFrame of Dublin rents."""
    js = json.loads((path or RAW / "RIQ02.json").read_text())
    ids, sizes = js["id"], js["size"]
    labels = {k: list(js["dimension"][k]["category"]["label"].values()) for k in ids}
    values = np.array([np.nan if v is None else v for v in js["value"]], dtype=float).reshape(sizes)

    t_dim, bed_dim, type_dim, loc_dim = ids[1], ids[2], ids[3], ids[4]
    rows = []
    cube = values[0]  # single statistic
    for li, loc in enumerate(labels[loc_dim]):
        info = parse_location(loc)
        if info["level"] == "other":
            continue
        block = cube[:, :, :, li]
        ti, bi, pi = np.nonzero(~np.isnan(block))
        for t, b, p in zip(ti, bi, pi):
            rows.append((labels[t_dim][t], labels[bed_dim][b], labels[type_dim][p], loc,
                         info["level"], info["district"], info["area"], block[t, b, p]))
    df = pd.DataFrame(rows, columns=["quarter", "beds", "ptype", "location", "level", "district", "area", "rent"])
    df["qdate"] = pd.PeriodIndex(df["quarter"].str.replace("Q", "-Q"), freq="Q").to_timestamp()
    df["t"] = (df["qdate"].dt.year - 2007) * 4 + df["qdate"].dt.quarter - 4  # 0 = 2007 Q4
    # RTB publishes both "Clondalkin, Dublin 22" and no plain "Dublin 22": promote it to district level
    only = df[(df.level == "neighbourhood")].groupby("district")["area"].nunique()
    no_district_rows = set(DISTRICTS) - set(df.loc[df.level == "district", "district"].dropna())
    for d in no_district_rows:
        if only.get(d) == 1:
            df.loc[(df.district == d) & (df.level == "neighbourhood"), "level"] = "district"
    return df.sort_values(["location", "beds", "ptype", "t"]).reset_index(drop=True)


# ---------------------------------------------------------------- sales
def sale_district(address: str, eircode: str) -> str | None:
    key = (eircode or "").replace(" ", "").upper()[:3]
    if re.fullmatch(r"D\d\d|D6W", key):
        code = "D" + key[1:].lstrip("0") if key != "D6W" else "D6W"
        return code if code in DISTRICTS else None
    return district_code(address or "")


def load_sales(path: Path | None = None) -> pd.DataFrame:
    """Dublin residential sales at full market price, VAT-inclusive, with postal district."""
    z = zipfile.ZipFile(path or RAW / "PPR-ALL.zip")
    name = next(n for n in z.namelist() if n.lower().endswith(".csv"))
    reader = csv.reader(io.StringIO(z.read(name).decode("latin-1")))
    next(reader)
    rows = []
    for date, address, county, eircode, price, not_full, vat_excl, desc, _size in reader:
        if county != "Dublin" or not_full.strip().lower() == "yes":
            continue
        d = sale_district(address, eircode)
        if d is None:
            continue
        p = float(re.sub(r"[^\d.]", "", price) or "nan")
        if vat_excl.strip().lower() == "yes":
            p *= 1 + VAT_RATE
        rows.append((date, d, p, "new" if desc.lower().startswith("new") else "second-hand"))
    df = pd.DataFrame(rows, columns=["date", "district", "price", "kind"])
    df["date"] = pd.to_datetime(df["date"], format="%d/%m/%Y")
    # drop obvious non-residential / data-entry outliers (bulk portfolio sales, typos)
    df = df[(df.price >= 50_000) & (df.price <= 5_000_000)]
    return df.sort_values("date").reset_index(drop=True)


def build(force_fetch: bool = False) -> tuple[pd.DataFrame, pd.DataFrame]:
    fetch(force_fetch)
    PROCESSED.mkdir(parents=True, exist_ok=True)
    rents, sales = load_rents(), load_sales()
    rents.to_parquet(PROCESSED / "rents.parquet", index=False)
    sales.to_parquet(PROCESSED / "sales.parquet", index=False)
    return rents, sales
