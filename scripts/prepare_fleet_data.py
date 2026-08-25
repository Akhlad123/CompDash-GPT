"""
Pre-process the master Fleet dataset (Excel or CSV — can grow to ~950 MB over
2-3 years of cumulative quarterly history) into a compact, HIGHLY-COMPRESSED
Parquet file (zstd) for bundling as a static asset in CompDash GPT
(public/fleet-data/fleet_data.parquet), and join in precomputed irradiance.

Why Parquet instead of CSV: this dataset is dominated by low-cardinality
categorical columns (country, region, wafer, product type) which Parquet's
columnar + dictionary + zstd encoding compresses ~6x better than CSV
(measured: 157,788 rows -> 32.1 MB CSV vs 5.4 MB Parquet/zstd). A full
2-3 year, ~950 MB raw Excel history is expected to compress to roughly
60-100 MB Parquet — safe to fetch into browser memory for a local-only app.

Run this whenever the Fleet source file is refreshed for a new quarter, and
again after fetch_irradiance.py produces/updates irradiance_lookup.csv.

Usage:
    py prepare_fleet_data.py
    py prepare_fleet_data.py --input "C:/path/to/latest_export.csv"
    py prepare_fleet_data.py --input file1.xlsx --add file2.xlsx --add file3.xlsx

Output:
    public/fleet-data/fleet_data.parquet   (gitignored — proprietary data)
"""
import argparse
import shutil
import tempfile
from pathlib import Path

import pandas as pd

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
_FLEET_DIR = Path(
    r"C:\Users\makhlad\OneDrive - Enphase Energy\Desktop\Enphase docs\IQ9\Data analytics"
    r"\Fleet data\Compdash GPT fleet data"
)
DEFAULT_SOURCES = [
    _FLEET_DIR / "Fleet Dasboard PCU_Downloads_Aug-Dec 2023.xlsx",
    _FLEET_DIR / "Fleet Dasboard PCU_Downloads_Q1 Q2 2024.xlsx",
    _FLEET_DIR / "Fleet Dasboard PCU_Downloads_Q3 Q4 2024.xlsx",
    _FLEET_DIR / "Fleet Dasboard PCU_Downloads_2025.xlsx",
    _FLEET_DIR / "Fleet Dasboard PCU_Downloads_Jan-Aug 2026.xlsx",
]
SHEET_NAME = 0

IRRADIANCE_CSV = Path(__file__).parent.parent.parent / "Fleet data analytics" / "irradiance" / "irradiance_lookup.csv"
OUTPUT_PARQUET = Path(__file__).parent.parent / "public" / "fleet-data" / "fleet_data.parquet"

GRID_DECIMALS = 1

# Ported from Fleet data analytics/Q1 and Q2-26/Fleet data Q1 and Q2-26 analytics.py
REGION_BUNDLES = [
    ("North America", {"United States", "Puerto Rico", "Canada"}),
    ("France and Spain", {"France", "Spain"}),
    ("Germany", {"Germany"}),
    ("Netherlands and UK", {"Netherlands", "United Kingdom"}),
    ("Australia and New Zealand", {"Australia", "New Zealand"}),
    ("Emerging Market (India, Brazil, Thailand)", {"India", "Brazil", "Thailand"}),
]

REGION_POWER_BINS = {
    "North America": ([0, 401, 426, 451, 476, 99999],
                       ["<=400 W", "401-425 W", "426-450 W", "451-475 W", ">475 W"]),
    "France and Spain": ([0, 401, 426, 476, 501, 99999],
                          ["<=400 W", "401-425 W", "426-475 W", "476-500 W", ">500 W"]),
    "Germany": ([0, 401, 426, 451, 476, 99999],
                ["<=400 W", "401-425 W", "426-450 W", "451-475 W", ">475 W"]),
    "Netherlands and UK": ([0, 401, 426, 451, 476, 99999],
                            ["<=400 W", "401-425 W", "426-450 W", "451-475 W", ">475 W"]),
    "Australia and New Zealand": ([0, 401, 426, 451, 476, 99999],
                                   ["<=400 W", "401-425 W", "426-450 W", "451-475 W", ">475 W"]),
    "Emerging Market (India, Brazil, Thailand)": ([0, 501, 551, 601, 651, 99999],
                                                    ["<=500 W", "501-550 W", "551-600 W", "601-650 W", ">650 W"]),
}

ALLOWED_MICROS = {
    "IQ7A", "IQ8P", "IQ8HC", "IQ8MC", "IQ8PLUS", "IQ8AC", "IQ7+", "IQ7",
    "IQ7X", "IQ8", "IQ8M", "IQ8X", "IQ8P-3P", "IQ9N-3P-277", "IQ7HS",
    "IQ7AM", "IQ7XS", "IQ9N", "IQ7PD", "IQ8H", "IQ7AS", "IQ8H-3P", "IQ8D",
    "IQ8A", "IQ9N-3P", "IQ9S-3P", "IQ7PLUS",
}

COLUMN_MAP = {
    "Site ID": "site_id",
    "Country": "country",
    "TSS region": "tss_region",
    "TSS country": "tss_country",
    "Device Type Name": "device_type_name",
    "Product Type": "product_type",
    "PV Module Make": "pv_module_make",
    "PV Module Model Name": "pv_module_model",
    "VOC": "voc",
    "ISC": "isc",
    "Module wafer": "module_wafer",
    "STC Rating2": "stc_rating2",
    "STC MWdc": "stc_mwdc",
    "Mwac": "mwac",
    "DC/AC": "dc_ac_ratio",
    "Unit Count": "unit_count",
    "Power Bucket": "power_bucket",
    "First Interval Date - Quarter": "quarter_first_interval",
    "Device Created - Quarter": "quarter_device_created",
    "City": "city",
    "State": "state",
    "Zip": "zip_code",
    "Latitude": "latitude",
    "Longitude": "longitude",
    "Circuit Phase": "circuit_phase",
    "Production EIM Config": "production_eim_config",
    "Consumption EIM Config": "consumption_eim_config",
    "Model Name": "model_name",
}


def assign_region(country: str) -> str | None:
    for name, countries in REGION_BUNDLES:
        if country in countries:
            return name
    return None


def assign_power_block(region: str | None, power_w) -> str | None:
    if region is None or pd.isna(power_w):
        return None
    bins, labels = REGION_POWER_BINS.get(region, (None, None))
    if bins is None:
        return None
    for i in range(len(labels)):
        if bins[i] <= power_w < bins[i + 1]:
            return labels[i]
    return None


def load_source(source_path: Path) -> pd.DataFrame:
    size_mb = source_path.stat().st_size / 1e6
    print(f"Reading master source ({size_mb:.1f} MB): {source_path.name}")

    # keep_default_na=False prevents pandas from treating the TSS region code
    # "NA" (North America) as NaN. We provide our own na_values list that does
    # NOT include "NA".
    _na_vals = ["", "#N/A", "#N/A N/A", "#NA", "-1.#IND", "-1.#QNAN",
                "-NaN", "-nan", "1.#IND", "1.#QNAN", "<NA>", "N/A",
                "NULL", "NaN", "None", "n/a", "nan", "null"]

    if source_path.suffix.lower() == ".csv":
        return pd.read_csv(source_path, usecols=list(COLUMN_MAP.keys()),
                           keep_default_na=False, na_values=_na_vals)

    tmp = tempfile.mktemp(suffix=source_path.suffix)
    shutil.copy2(source_path, tmp)
    try:
        df = pd.read_excel(tmp, sheet_name=SHEET_NAME, usecols=list(COLUMN_MAP.keys()),
                           keep_default_na=False, na_values=_na_vals)
    finally:
        Path(tmp).unlink(missing_ok=True)
    return df


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--input", type=Path, default=None,
        help="Primary Fleet source file (.xlsx or .csv). Omit to use all DEFAULT_SOURCES.",
    )
    parser.add_argument(
        "--add", type=Path, action="append", default=[],
        help="Additional Fleet source files to concatenate (repeatable).",
    )
    args = parser.parse_args()

    # Determine list of source files
    if args.input is not None:
        sources = [args.input] + args.add
    elif len(args.add) > 0:
        sources = args.add
    else:
        sources = [p for p in DEFAULT_SOURCES if p.exists()]
        if not sources:
            print("ERROR: No default source files found. Use --input to specify.")
            return

    # Load and concatenate all sources
    frames = []
    for src in sources:
        if not src.exists():
            print(f"  WARNING: {src} not found — skipping")
            continue
        part = load_source(src)
        print(f"  loaded {len(part)} rows from {src.name}")
        frames.append(part)

    if not frames:
        print("ERROR: No data loaded.")
        return

    df = pd.concat(frames, ignore_index=True)
    print(f"  total: {len(df)} rows from {len(frames)} file(s)")

    # Deduplicate: same (Site ID, serial/device) across quarters is expected,
    # but exact duplicate rows (all columns identical) should be dropped.
    before = len(df)
    df = df.drop_duplicates()
    if len(df) < before:
        print(f"  dropped {before - len(df)} exact duplicate rows")

    df = df.dropna(subset=["Site ID"])
    df = df[df["Product Type"].isin(ALLOWED_MICROS)]
    print(f"  {len(df)} rows after filtering to ALLOWED_MICROS + valid Site ID")

    df["Site ID"] = df["Site ID"].astype("int64")
    df = df.rename(columns=COLUMN_MAP)

    df["region_bundle"] = df["country"].apply(assign_region)
    df["power_block"] = df.apply(
        lambda r: assign_power_block(r["region_bundle"], r["stc_rating2"]), axis=1
    )

    # Average days per month (Gregorian, accounts for leap years: 365.25/12).
    # Weights for JAN-DEC to convert kWh/m²/day → kWh/m²/month for each month,
    # then average the 12 monthly totals to get a representative monthly value.
    MONTH_DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    MONTH_COLS = [f'ghi_{m}' for m in ['jan','feb','mar','apr','may','jun',
                                        'jul','aug','sep','oct','nov','dec']]

    if IRRADIANCE_CSV.exists():
        irr = pd.read_csv(IRRADIANCE_CSV)
        if 'ghi_jan' not in irr.columns:
            print("  WARNING: irradiance_lookup.csv is in old annual format — "
                  "re-run fetch_irradiance.py to regenerate with monthly values. "
                  "Irradiance column will be empty this run.")
            df["irr_ann_kwh_m2_month"] = pd.NA
        else:
            df["grid_lat"] = df["latitude"].round(GRID_DECIMALS)
            df["grid_lon"] = df["longitude"].round(GRID_DECIMALS)
            df = df.merge(irr[["grid_lat", "grid_lon"] + MONTH_COLS],
                          on=["grid_lat", "grid_lon"], how="left")
            df = df.drop(columns=["grid_lat", "grid_lon"])
            # irr_ann_kwh_m2_month = weighted mean of monthly GHI values
            df["irr_ann_kwh_m2_month"] = sum(
                df[col].fillna(0) * days
                for col, days in zip(MONTH_COLS, MONTH_DAYS)
            ) / sum(MONTH_DAYS)
            # Set to NaN where no irradiance data was matched (all months were 0 after fillna)
            no_data = df[MONTH_COLS].isna().all(axis=1)
            df.loc[no_data, "irr_ann_kwh_m2_month"] = pd.NA
            df = df.drop(columns=MONTH_COLS)
            matched = df["irr_ann_kwh_m2_month"].notna().sum()
            print(f"  irradiance joined: {matched}/{len(df)} rows matched "
                  f"({'PARTIAL — run fetch_irradiance.py fully for complete coverage' if matched < len(df) else 'complete'})")
    else:
        df["irr_ann_kwh_m2_month"] = pd.NA
        print("  WARNING: irradiance_lookup.csv not found — irradiance column will be empty")

    # Coerce mixed-type object columns (e.g. city/state/zip with occasional
    # numeric-looking values) to plain strings so PyArrow can serialize them.
    for col in df.select_dtypes(include=["object", "str"]).columns:
        df[col] = df[col].apply(lambda v: str(v) if pd.notna(v) else None)

    OUTPUT_PARQUET.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(OUTPUT_PARQUET, compression="zstd", index=False)
    size_mb = OUTPUT_PARQUET.stat().st_size / 1e6
    print(f"Done. Wrote {len(df)} rows, {len(df.columns)} columns to {OUTPUT_PARQUET} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
