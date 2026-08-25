from __future__ import annotations

import polars as pl

from app.schemas.analytics import AnalysisJobResult, AnalyticalArtifact, BoundedAnalysisRequest

ANALYSIS_FUNCTION_VERSION = "1.0.0"


def run_bounded_analysis(request: BoundedAnalysisRequest) -> AnalysisJobResult:
    frame = pl.DataFrame(request.rows)
    if frame.height > 50_000:
        return _failure(request.query_hash, "The bounded extract exceeds the 50,000 row analytical limit.")
    if request.analysis_type == "irradiance_energy":
        return _irradiance_energy(frame, request.query_hash)
    return _peer_comparison(frame, request.query_hash)


def _irradiance_energy(frame: pl.DataFrame, query_hash: str) -> AnalysisJobResult:
    required = {"irradiance_w_m2", "energy_kwh"}
    if not required.issubset(frame.columns):
        return _failure(query_hash, "Irradiance-energy analysis requires irradiance_w_m2 and energy_kwh columns.")
    clean = frame.select(["irradiance_w_m2", "energy_kwh"]).drop_nulls()
    if clean.height < 3:
        return _failure(query_hash, "At least three valid irradiance-energy observations are required.")
    correlation = clean.select(pl.corr("irradiance_w_m2", "energy_kwh").alias("correlation")).item()
    if correlation is None:
        return _failure(query_hash, "The input does not contain enough variation to calculate correlation.")
    artifact = AnalyticalArtifact(
        title="Irradiance and Energy Relationship",
        artifact_type="insight",
        payload={
            "sample_count": clean.height,
            "pearson_correlation": round(float(correlation), 4),
            "interpretation": "Correlation describes association and does not establish production-loss causality.",
        },
    )
    return _completed(query_hash, [artifact])


def _peer_comparison(frame: pl.DataFrame, query_hash: str) -> AnalysisJobResult:
    required = {"site_id", "performance_value"}
    if not required.issubset(frame.columns):
        return _failure(query_hash, "Peer comparison requires site_id and performance_value columns.")
    clean = frame.select(["site_id", "performance_value"]).drop_nulls()
    if clean.height < 3:
        return _failure(query_hash, "At least three valid site observations are required for peer comparison.")
    mean = clean.select(pl.col("performance_value").mean()).item()
    standard_deviation = clean.select(pl.col("performance_value").std()).item()
    if mean is None or standard_deviation is None or standard_deviation == 0:
        return _failure(query_hash, "Peer comparison requires measurable variation across sites.")
    ranked = clean.with_columns(((pl.col("performance_value") - mean) / standard_deviation).alias("z_score")).sort("z_score").head(10)
    artifact = AnalyticalArtifact(
        title="Peer Performance Comparison",
        artifact_type="chart",
        payload={
            "sample_count": clean.height,
            "mean": round(float(mean), 4),
            "standard_deviation": round(float(standard_deviation), 4),
            "lowest_peers": ranked.to_dicts(),
            "interpretation": "Low peer ranking is a screening signal, not a root-cause conclusion.",
        },
    )
    return _completed(query_hash, [artifact])


def _completed(query_hash: str, artifacts: list[AnalyticalArtifact]) -> AnalysisJobResult:
    return AnalysisJobResult(status="completed", analysis_function_version=ANALYSIS_FUNCTION_VERSION, query_hash=query_hash, artifacts=artifacts)


def _failure(query_hash: str, message: str) -> AnalysisJobResult:
    return AnalysisJobResult(status="failed", analysis_function_version=ANALYSIS_FUNCTION_VERSION, query_hash=query_hash, artifacts=[AnalyticalArtifact(title="Analysis unavailable", artifact_type="warning", payload={"message": message})])
