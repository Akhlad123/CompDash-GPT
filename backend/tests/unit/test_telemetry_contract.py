from uuid import uuid4

from app.schemas.telemetry import validate_telemetry_records


def valid_record() -> dict[str, object]:
    return {
        "timestamp_utc": "2026-07-27T12:00:00+00:00",
        "site_id": "DE-1",
        "micro_serial": "123456789012",
        "dc_voltage_v": 42.5,
        "dc_current_a": 9.1,
        "energy_produced_kwh": 1.2,
        "ingestion_id": str(uuid4()),
    }


def test_validates_utc_telemetry_record() -> None:
    result = validate_telemetry_records([valid_record()])

    assert len(result.accepted) == 1
    assert result.accepted[0].timestamp_utc.tzinfo is not None
    assert result.rejected == []


def test_quarantines_invalid_and_duplicate_records() -> None:
    record = valid_record()
    invalid = {**valid_record(), "timestamp_utc": "2026-07-27T12:00:00"}
    result = validate_telemetry_records([record, record, invalid])

    assert len(result.accepted) == 1
    assert len(result.rejected) == 2
