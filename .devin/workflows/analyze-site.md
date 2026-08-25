---
description: How the "Analyze Site" workflow works on the Ask A Question page
---

# Analyze Site Workflow

When a user asks **"Analyze site 12345"** (or "deep dive site X", "investigate site X", "tell me everything about site X"), the system triggers a comprehensive multi-step analysis workflow.

## Trigger Phrases

- "Analyze site 12345"
- "Deep dive site S001"
- "Investigate site 98765"
- "Tell me everything about site 12345"
- "Site analysis for 12345"

## Workflow Steps (Executed Automatically)

### Step 1: Fleet Metadata Lookup
- **Query**: `get_site_summary` equivalent — fetches all fleet rows for the site
- **Data returned**: Country, region, city/state, lat/lon, product type (e.g. IQ8HC), device type, model name, PV module make/model, wafer technology, STC rating (W), MWdc, MWac, DC/AC ratio, unit count, Voc, Isc, annual irradiance, quarter of first interval
- **If site not found**: Reports "site not found in fleet data" and stops

### Step 2: Telemetry Availability Check
- **Query**: Counts distinct serial numbers, total readings, SKU count, first/last reading dates, and days of data coverage
- **If no telemetry**: The workflow stops here and provides only fleet-based observations
- **If telemetry exists**: Continues to Steps 3–6

### Step 3: Site-Level Energy Production
- **Query**: Aggregated site energy — total kWh, MWh, average AC power (W), average DC power (W), average/max temperature (°C), average AC/DC voltages
- **Purpose**: Understand the site's overall energy output and operating conditions

### Step 4: Per-Microinverter Energy Breakdown
- **Query**: Energy per serial number — kWh, reading count, avg AC/DC power, avg/max temperature, avg DC voltage/current
- **Purpose**: Identify top 5 and bottom 5 performers by energy output
- **Engineering insight**: Large spread between top and bottom suggests shading, soiling, orientation issues, or module mismatch

### Step 5: Anomaly Detection (Z-Score)
- **Query**: Z-score analysis across all microinverters at the site
- **Thresholds**: Alert (|z| ≥ 2.0), Warning (|z| ≥ 1.5), Normal
- **Output**: Count of alerts/warnings/normal, plus specific serial numbers flagged
- **Engineering insight**: Alert-level micros may have degraded modules, connector issues, or partial shading

### Step 6: Clipping Analysis
- **Query**: Finds telemetry readings where AC power exceeds 280W
- **Output**: Count of high-power readings, number of unique inverters affected
- **Engineering insight**: Persistent clipping suggests the DC/AC ratio may be too high for the inverter model, or the system is undersized on the AC side

## LLM Explanation

After all 6 steps complete, the results are fed to the LLM explainer with a **specialized system prompt** (`SITE_ANALYSIS_SYSTEM`) that instructs it to produce a structured engineering report with:

1. **Site Overview** — Location, inverter, module specs
2. **Telemetry Status** — Data coverage
3. **Energy Production** — Site-level totals
4. **Microinverter Performance** — Top/bottom performers
5. **Anomaly Assessment** — Flagged inverters with z-scores
6. **Clipping Analysis** — Clipping extent
7. **Engineering Observations** — 2-3 actionable recommendations

The LLM is given 1500 tokens (vs 300 for normal queries) and 90s timeout to produce this comprehensive report.

## Technical Files

- **Tool**: `src/lib/analyticsTools/siteAnalysisTool.ts` — multi-step execution logic
- **Registry**: `src/lib/analyticsTools/index.ts` — tool registration
- **Intent Router**: `src/lib/intentRouter.ts` — `site_analysis` intent + few-shot examples
- **Dispatcher**: `src/lib/toolDispatcher.ts` — `analyze_site` param mapping
- **Explainer**: `src/lib/explainer.ts` — `SITE_ANALYSIS_SYSTEM` prompt + increased token budget

## Example Output Structure

```json
{
  "site_id": "12345",
  "_analysis_type": "comprehensive_site_analysis",
  "fleet_summary": {
    "country": "US", "region": "NA", "city": "San Jose", "state": "CA",
    "product_type": "IQ8HC", "pv_module_make": "Canadian Solar",
    "stc_rating_w": 430, "dc_ac_ratio": 1.45, "unit_count": 22,
    "irradiance_kwh_m2_month": 165.3
  },
  "telemetry_available": true,
  "telemetry_overview": {
    "microinverter_count": 22, "total_readings": 158400,
    "days_of_data": 180
  },
  "site_energy": { "total_energy_kwh": 12450.3, "avg_ac_power_w": 245.1 },
  "top_performers": [ ... ],
  "bottom_performers": [ ... ],
  "anomaly_summary": { "alerts": 1, "warnings": 2, "normal": 19 },
  "anomaly_alerts": [ { "serial_number": "SN123", "z_score": -2.45, "energy_kwh": 380 } ],
  "clipping_summary": { "high_power_readings": 42, "note": "..." }
}
```
