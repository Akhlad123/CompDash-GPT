from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class TelemetryRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    timestamp_utc: datetime
    site_id: str = Field(min_length=1, max_length=200)
    micro_serial: str = Field(min_length=1, max_length=200)
    dc_voltage_v: float | None = Field(default=None, ge=0, le=1_000)
    dc_current_a: float | None = Field(default=None, ge=0, le=100)
    dc_power_w: float | None = Field(default=None, ge=0, le=100_000)
    ac_power_w: float | None = Field(default=None, ge=0, le=100_000)
    energy_produced_kwh: float | None = Field(default=None, ge=0)
    ambient_temperature_c: float | None = Field(default=None, ge=-80, le=100)
    grid_voltage_v: float | None = Field(default=None, ge=0, le=1_000)
    operating_state: str | None = Field(default=None, max_length=100)
    product_type: str | None = Field(default=None, max_length=100)
    ghi_w_m2: float | None = Field(default=None, ge=0, le=2_000)
    poa_irradiance_w_m2: float | None = Field(default=None, ge=0, le=2_000)
    ingestion_id: UUID

    @field_validator("timestamp_utc")
    @classmethod
    def timestamp_must_include_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("timestamp_utc must include a UTC offset")
        return value.astimezone(UTC)


class TelemetryValidationResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    accepted: list[TelemetryRecord]
    rejected: list[dict[str, object]]


def validate_telemetry_records(records: list[dict[str, object]]) -> TelemetryValidationResult:
    accepted: list[TelemetryRecord] = []
    rejected: list[dict[str, object]] = []
    seen: set[tuple[str, str, UUID]] = set()
    for index, record in enumerate(records):
        try:
            parsed = TelemetryRecord.model_validate(record)
            key = (parsed.site_id, parsed.micro_serial, parsed.ingestion_id)
            if key in seen:
                raise ValueError("duplicate site, microinverter, and ingestion identifier")
            seen.add(key)
            accepted.append(parsed)
        except ValueError as error:
            rejected.append({"index": index, "reason": str(error)})
    return TelemetryValidationResult(accepted=accepted, rejected=rejected)
