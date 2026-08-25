from datetime import UTC

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.catalog import Metric
from app.schemas.telemetry_query import TelemetryQueryPlan

METRIC_COLUMNS = {
    "production_energy_kwh": "energy_produced_kwh",
    "average_dc_voltage_v": "avg_dc_voltage_v",
    "clipping_duration_minutes": "clipping_duration_minutes",
    "availability_pct": "availability_pct",
}
DIMENSION_COLUMNS = {
    "site_id_telemetry": "site_id",
    "product_type_telemetry": "product_type",
    "micro_serial": "micro_serial",
    "timestamp_utc": "day",
}
AGGREGATIONS = {"sum": "sum", "average": "avg", "minimum": "min", "maximum": "max"}


def compile_telemetry_kql(session: Session, plan: TelemetryQueryPlan) -> tuple[str, dict[str, object], str]:
    metric = session.scalar(select(Metric).where(Metric.key == plan.metric, Metric.enabled.is_(True)))
    if metric is None or metric.dataset.key != plan.source:
        raise ValueError("The requested telemetry metric is not approved.")
    column = METRIC_COLUMNS[plan.metric]
    start = plan.start_at.astimezone(UTC).isoformat()
    end = plan.end_at.astimezone(UTC).isoformat()
    parameters: dict[str, object] = {"start_at": start, "end_at": end}
    declarations = ["start_at:datetime", "end_at:datetime"]
    for filter_index, item in enumerate(plan.filters):
        parameter_name = f"filter_{filter_index}"
        parameters[parameter_name] = item.values
        declarations.append(f"{parameter_name}:dynamic")
    lines = [
        f"declare query_parameters({', '.join(declarations)});",
        "telemetry_daily",
        "| where day >= start_at and day < end_at",
        f"| where isnotnull({column})",
    ]
    for filter_index, item in enumerate(plan.filters):
        column_name = DIMENSION_COLUMNS[item.dimension]
        parameter_name = f"filter_{filter_index}"
        lines.append(f"| where array_index_of({parameter_name}, {column_name}) >= 0")
    group_columns = [DIMENSION_COLUMNS[item] for item in plan.group_by]
    aggregation = AGGREGATIONS[plan.aggregation]
    if group_columns:
        lines.append(f"| summarize result={aggregation}({column}) by {', '.join(group_columns)}")
    else:
        lines.append(f"| summarize result={aggregation}({column})")
    lines.extend(["| order by result desc", f"| take {plan.limit}"])
    return "\n".join(lines), parameters, metric.unit
