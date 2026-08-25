from app.schemas.engineering import EngineeringAssessmentRequest
from app.services.engineering import assess_engineering_metrics


def test_insufficient_sample_blocks_engineering_conclusions() -> None:
    result = assess_engineering_metrics(EngineeringAssessmentRequest(sample_count=2, availability_pct=50))

    assert result.findings[0].classification == "insufficient_data"
    assert result.findings[0].category == "data_quality"


def test_clipping_requires_effective_specification_version() -> None:
    result = assess_engineering_metrics(EngineeringAssessmentRequest(sample_count=20, clipping_duration_minutes=45))

    clipping = next(item for item in result.findings if item.category == "clipping")
    assert clipping.classification == "insufficient_data"


def test_weather_aligned_performance_is_calculated_not_root_cause() -> None:
    result = assess_engineering_metrics(EngineeringAssessmentRequest(sample_count=20, performance_ratio=0.81, weather_aligned=True, dc_ac_ratio=1.3))

    performance = next(item for item in result.findings if item.category == "performance")
    assert performance.classification == "calculated"
    assert "root cause" in performance.limitations[0]


def test_low_availability_is_prioritized() -> None:
    result = assess_engineering_metrics(EngineeringAssessmentRequest(sample_count=20, availability_pct=88))

    availability = next(item for item in result.findings if item.category == "availability")
    assert availability.severity == "critical"
