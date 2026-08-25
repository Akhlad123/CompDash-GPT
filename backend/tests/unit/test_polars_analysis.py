from app.analytics.polars_analysis import run_bounded_analysis
from app.schemas.analytics import BoundedAnalysisRequest


HASH = "a" * 64


def test_irradiance_energy_returns_reproducible_insight() -> None:
    result = run_bounded_analysis(BoundedAnalysisRequest(analysis_type="irradiance_energy", query_hash=HASH, rows=[{"irradiance_w_m2": 100.0, "energy_kwh": 1.0}, {"irradiance_w_m2": 200.0, "energy_kwh": 2.0}, {"irradiance_w_m2": 300.0, "energy_kwh": 3.0}]))

    assert result.status == "completed"
    assert result.query_hash == HASH
    assert result.artifacts[0].payload["sample_count"] == 3
    assert result.artifacts[0].payload["pearson_correlation"] == 1.0


def test_peer_comparison_requires_variation() -> None:
    result = run_bounded_analysis(BoundedAnalysisRequest(analysis_type="peer_comparison", query_hash=HASH, rows=[{"site_id": "A", "performance_value": 1.0}, {"site_id": "B", "performance_value": 1.0}, {"site_id": "C", "performance_value": 1.0}]))

    assert result.status == "failed"
    assert result.artifacts[0].artifact_type == "warning"


def test_analysis_rejects_missing_columns() -> None:
    result = run_bounded_analysis(BoundedAnalysisRequest(analysis_type="irradiance_energy", query_hash=HASH, rows=[{"energy_kwh": 1.0}, {"energy_kwh": 2.0}, {"energy_kwh": 3.0}]))

    assert result.status == "failed"
    assert "irradiance_w_m2" in str(result.artifacts[0].payload["message"])
