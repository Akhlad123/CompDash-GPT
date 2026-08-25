"""
Pre-process RMA CSV data into a compact Parquet file for CompDash GPT.

Keeps only Microinverter RMA records and extracts the product family
from the Replacement Model string (e.g. "IQ8HC-72-M-US" → "IQ8HC").

Input:  Two CSV files in the RMA data folder (Aug 2023–Jun 2025 & Jul 2025–Aug 2026)
Output: public/fleet-data/rma_data.parquet  (gitignored — proprietary data)

Usage:
    py prepare_rma_data.py
"""
import re
from pathlib import Path

import pandas as pd

_RMA_DIR = Path(
    r"C:\Users\makhlad\OneDrive - Enphase Energy\Desktop\Enphase docs\IQ9"
    r"\Data analytics\Fleet data\Compdash GPT fleet data\RMA data"
)

RMA_SOURCES = [
    _RMA_DIR / "RMA Data_Aug 2023_June 2025.csv",
    _RMA_DIR / "RMA Data_July 2025_Aug 2026.csv",
]

OUTPUT_PARQUET = Path(__file__).parent.parent / "public" / "fleet-data" / "rma_data.parquet"

# Columns we need (using exact CSV header names)
USE_COLS = [
    "Enlighten Site ID",
    "Replacement Model",
    "Returned Part Number/ Installed Product ID SKU",  # Column N
    "Product Type",               # Column W — Microinverter, Gateway, etc.
    "State",                       # Column Z
    "Country",                     # Column AA
    "Region2",                     # Column AC
    "Created Date",
    "RMA Type",
    "Returned Part Number_Product Family",
    "Returned Part Number_Product Type",
]

COLUMN_MAP = {
    "Enlighten Site ID": "site_id",
    "Replacement Model": "replacement_model",
    "Returned Part Number/ Installed Product ID SKU": "returned_sku",
    "Product Type": "rma_product_type",
    "State": "state",
    "Country": "country",
    "Region2": "region",
    "Created Date": "created_date",
    "RMA Type": "rma_type",
    "Returned Part Number_Product Family": "returned_product_family",
    "Returned Part Number_Product Type": "returned_part_type",
}

# Known microinverter product family prefixes to extract from Replacement Model
_MICRO_FAMILIES = [
    "IQ9S", "IQ9N", "IQ8PLUS", "IQ8HC", "IQ8MC", "IQ8AC", "IQ8P",
    "IQ8H", "IQ8M", "IQ8X", "IQ8D", "IQ8A", "IQ8",
    "IQ7PLUS", "IQ7XS", "IQ7HS", "IQ7AM", "IQ7AS", "IQ7PD",
    "IQ7A", "IQ7X", "IQ7+", "IQ7",
    "M250", "M215", "S280", "S270", "S230",
]

def extract_product_family(model: str) -> str | None:
    """Extract the microinverter product family from a Replacement Model string."""
    if not isinstance(model, str) or not model.strip():
        return None
    upper = model.upper().strip()
    for fam in _MICRO_FAMILIES:
        if upper.startswith(fam.upper()):
            return fam
    return None


def normalize_product_family(fam: str | None) -> str | None:
    """Map legacy model prefixes to their canonical product type names."""
    if fam is None:
        return None
    mapping = {
        "M215": "M215",
        "M250": "M250",
        "S280": "S280",
        "S270": "S270",
        "S230": "S230",
        "IQ7+": "IQ7PLUS",
        "IQ7PLUS": "IQ7PLUS",
        "IQ8PLUS": "IQ8PLUS",
    }
    return mapping.get(fam, fam)


def main():
    frames = []
    for src in RMA_SOURCES:
        if not src.exists():
            print(f"  WARNING: {src} not found — skipping")
            continue
        size_mb = src.stat().st_size / 1e6
        print(f"Reading {src.name} ({size_mb:.1f} MB)...")
        df = pd.read_csv(
            src,
            usecols=USE_COLS,
            dtype=str,  # read everything as string to avoid mixed-type warnings
            low_memory=False,
        )
        print(f"  loaded {len(df)} rows")
        frames.append(df)

    if not frames:
        print("ERROR: No RMA data files found.")
        return

    df = pd.concat(frames, ignore_index=True)
    print(f"Total: {len(df)} rows from {len(frames)} file(s)")

    # Rename columns
    df = df.rename(columns=COLUMN_MAP)

    # Keep all product types (Microinverter, Gateway, etc.) — no filtering
    df["rma_product_type"] = df["rma_product_type"].str.strip()
    print(f"  Product types: {df['rma_product_type'].value_counts().to_string()}")

    # Drop rows without a valid numeric site ID
    df = df.dropna(subset=["site_id"])
    def clean_site_id(x):
        if not isinstance(x, str):
            return None
        x = x.strip()
        try:
            return str(int(float(x)))
        except (ValueError, OverflowError):
            return None
    df["site_id"] = df["site_id"].apply(clean_site_id)
    df = df[df["site_id"].notna() & (df["site_id"] != "")]
    print(f"  with valid site_id: {len(df)} rows")

    # Extract replacement product family from Replacement Model
    df["replacement_family"] = df["replacement_model"].apply(extract_product_family)
    df["replacement_family"] = df["replacement_family"].apply(normalize_product_family)

    # Also extract from the returned part number product family
    df["returned_family_clean"] = df["returned_product_family"].apply(
        lambda x: normalize_product_family(x.strip()) if isinstance(x, str) and x.strip() else None
    )

    # Parse created_date to extract year-quarter for time-based analysis
    df["created_date_parsed"] = pd.to_datetime(df["created_date"], format="mixed", errors="coerce")
    df["rma_quarter"] = df["created_date_parsed"].dt.to_period("Q").astype(str)
    df = df.drop(columns=["created_date_parsed"])

    # Dedup exact duplicate rows
    before = len(df)
    df = df.drop_duplicates()
    if len(df) < before:
        print(f"  dropped {before - len(df)} exact duplicates")

    print(f"\nFinal: {len(df)} RMA rows")
    print(f"  Distinct sites: {df['site_id'].nunique()}")
    print(f"  Replacement families: {df['replacement_family'].value_counts().head(15).to_string()}")

    # Write Parquet
    OUTPUT_PARQUET.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(OUTPUT_PARQUET, compression="zstd", index=False)
    size_mb = OUTPUT_PARQUET.stat().st_size / 1e6
    print(f"\nDone. Wrote {len(df)} rows to {OUTPUT_PARQUET} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
