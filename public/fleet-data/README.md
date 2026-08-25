# Fleet Data Repository

## Location
All fleet Parquet files go here:

```
C:\Users\makhlad\PycharmProjects\PythonProject\CompDash GPT\public\fleet-data\
```

## Current data
- **2025:** Q1, Q2, Q3, Q4 (from `Module pairing fleet data for 2025.xlsx`)
- **2026:** Q1, Q2 (from `Module pairing data - Q1 and Q2 2026.xlsx`)
- **Total:** 606,254 rows, 27 columns, 21 MB Parquet
- **Irradiance coverage:** 94.8% (574,512/606,254 rows)

---

## How to add a new quarter (step-by-step)

### Step 1: Place the Excel file
Save the new quarter Excel in the fleet data folder:
```
C:\Users\makhlad\OneDrive - Enphase Energy\Desktop\Enphase docs\IQ9\
  Data analytics\Fleet data\<YEAR> fleet data\<filename>.xlsx
```

### Step 2: Register the new file in the script
Open `CompDash GPT\scripts\prepare_fleet_data.py` and add the new path
to the `DEFAULT_SOURCES` list (around line 35):
```python
DEFAULT_SOURCES = [
    Path(r"...\2025 fleet data\Module pairing fleet data for 2025.xlsx"),
    Path(r"...\2026 fleet data\Module pairing data - Q1 and Q2 2026.xlsx"),
    Path(r"...\2027 fleet data\<new_file>.xlsx"),   # ← add new entry
]
```

### Step 3: (Optional) Fetch irradiance for new grid cells
If the new quarter has sites in new geographic locations, run the irradiance
fetcher to fill in their solar resource values:
```
cd "C:\Users\makhlad\PycharmProjects\PythonProject\Fleet data analytics\irradiance"
py fetch_irradiance.py
```
- This is **resumable** — re-running skips cells already in the lookup CSV.
- Takes ~30 min for ~13K new grid cells (NASA POWER API, 4 threads).
- Can be skipped; the Parquet will just have `null` irradiance for new cells.

### Step 4: Generate the combined Parquet
```
cd "C:\Users\makhlad\PycharmProjects\PythonProject\CompDash GPT"
py scripts/prepare_fleet_data.py
```
This will:
1. Read all files listed in `DEFAULT_SOURCES`
2. Concatenate them and drop exact duplicate rows
3. Filter to allowed microinverter types + valid Site IDs
4. Join irradiance data from `irradiance_lookup.csv`
5. Write compressed Parquet to `public/fleet-data/fleet_data.parquet`

### Step 5: Verify
```
py -3 -c "import pandas as pd; df=pd.read_parquet('public/fleet-data/fleet_data.parquet'); print(f'Rows: {len(df):,}'); print(df['quarter_first_interval'].value_counts().sort_index())"
```

### Step 6: Restart the dev server
The app fetches the Parquet on startup. Just refresh the browser.

### Alternative: One-off without editing the script
```
py scripts/prepare_fleet_data.py --input "path\to\file1.xlsx" --add "path\to\file2.xlsx" --add "path\to\file3.xlsx"
```

---

## Required Excel columns
The source Excel must have these columns (case-sensitive):
`Site ID`, `Country`, `TSS region`, `TSS country`, `Device Type Name`,
`Product Type`, `PV Module Make`, `PV Module Model Name`, `Voc`, `Isc`,
`Module wafer`, `STC Rating2`, `STC MWdc`, `Mwac`, `DC/AC`, `Unit Count`,
`Power Bucket`, `First Interval Date | Quarter`, `Device Created | Quarter`,
`City`, `State`, `Zip Code`, `Latitude`, `Longitude`

---

## Browser-only vs local backend

| Factor | Browser-only (current) | Local backend |
|--------|----------------------|---------------|
| **Current** | 21 MB Parquet → ~80 MB in-memory (606K rows) | Same data, served from disk |
| **Projected 1 GB raw** | ~60–100 MB Parquet → ~300–500 MB in browser | Streamed, no browser RAM hit |
| **Query speed** | DuckDB-WASM: < 1s per query up to ~500 MB | DuckDB native: 3–5× faster |

**Verdict:** Keep browser-only for now. Switch to local backend only when
Parquet exceeds ~500 MB (i.e. ~3–5 GB raw Excel).

## File format
- **Parquet** with zstd compression, dictionary-encoded categorical columns
- Typically 6× smaller than equivalent CSV
- DuckDB-WASM reads it directly via `read_parquet()` — no JS-side parsing
