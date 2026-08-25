# Telemetry Data Lake Layout

Raw immutable telemetry objects use this ADLS Gen2 path:

`telemetry/raw/schema_version=v1/event_date=YYYY-MM-DD/site_id=<site>/part-<ingestion-id>.parquet`

Quarantine objects use:

`telemetry/quarantine/schema_version=v1/event_date=YYYY-MM-DD/ingestion_id=<uuid>/rejected.jsonl`

Curated rollups use:

`telemetry/curated/grain=daily/event_date=YYYY-MM-DD/part-<job-id>.parquet`

All timestamps are normalized to UTC before storage. Writes are immutable. Replay/idempotency is keyed by the telemetry source ingestion identifier and validated before load into ADX.
