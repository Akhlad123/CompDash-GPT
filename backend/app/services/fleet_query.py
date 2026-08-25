from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.catalog import Dimension, Metric
from app.schemas.query_plan import FleetQueryPlan
from app.services.query_policy import enforce_fleet_policy

FLEET_TABLE = "fleet_snapshot_data"
METRIC_COLUMNS = {
    "unit_count": "unit_count",
    "dc_ac_ratio": "dc_ac_ratio",
    "irradiation_monthly_kwh_m2": "irr_ann_kwh_m2_month",
    "stc_rating_w": "stc_rating2",
}
DIMENSION_COLUMNS = {
    "site_id": "site_id",
    "country": "country",
    "region_bundle": "region_bundle",
    "product_type": "product_type",
    "quarter_first_interval": "quarter_first_interval",
}
AGGREGATION_EXPRESSIONS = {
    "sum": "SUM({column})",
    "average": "AVG({column})",
    "minimum": "MIN({column})",
    "maximum": "MAX({column})",
}


@dataclass(frozen=True)
class CompiledFleetQuery:
    sql: str
    parameters: dict[str, object]
    metric_unit: str


def compile_fleet_query(session: Session, plan: FleetQueryPlan) -> CompiledFleetQuery:
    enforce_fleet_policy(plan)
    metric = _get_enabled_metric(session, plan.metric)
    if metric.dataset.key != plan.source:
        raise ValueError("The metric is not available from the requested data source.")
    _validate_dimensions(session, plan)
    metric_column = METRIC_COLUMNS.get(plan.metric)
    if metric_column is None:
        raise ValueError("The metric does not have an approved fleet query mapping.")
    parameters: dict[str, object] = {}
    where_parts = [f"{metric_column} IS NOT NULL"]
    for filter_index, item in enumerate(plan.filters):
        column = DIMENSION_COLUMNS[item.dimension]
        placeholders: list[str] = []
        for value_index, value in enumerate(item.values):
            parameter_name = f"filter_{filter_index}_{value_index}"
            parameters[parameter_name] = value
            placeholders.append(f":{parameter_name}")
        where_parts.append(f"{column} IN ({', '.join(placeholders)})")
    group_columns = [DIMENSION_COLUMNS[key] for key in plan.group_by]
    select_group_columns = ", ".join(group_columns)
    if plan.aggregation == "count":
        aggregate_expression = "COUNT(DISTINCT site_id)"
    else:
        template = AGGREGATION_EXPRESSIONS[plan.aggregation]
        aggregate_expression = template.format(column=metric_column)
    select_parts = [*group_columns, f"{aggregate_expression} AS result"]
    query = f"SELECT {', '.join(select_parts)} FROM {FLEET_TABLE} WHERE {' AND '.join(where_parts)}"
    if group_columns:
        query += f" GROUP BY {select_group_columns}"
    query += f" ORDER BY result {'ASC' if plan.order == 'ascending' else 'DESC'} LIMIT :limit"
    parameters["limit"] = plan.limit
    return CompiledFleetQuery(sql=query, parameters=parameters, metric_unit=metric.unit)


def execute_fleet_query(session: Session, plan: FleetQueryPlan) -> tuple[list[dict[str, object | None]], CompiledFleetQuery]:
    compiled = compile_fleet_query(session, plan)
    result = session.execute(text(compiled.sql), compiled.parameters)
    rows = [dict(row) for row in result.mappings()]
    return rows, compiled


def _get_enabled_metric(session: Session, metric_key: str) -> Metric:
    metric = session.query(Metric).filter(Metric.key == metric_key, Metric.enabled.is_(True)).one_or_none()
    if metric is None:
        raise ValueError("The requested metric is not approved for analytics.")
    return metric


def _validate_dimensions(session: Session, plan: FleetQueryPlan) -> None:
    requested = set(plan.group_by)
    requested.update(item.dimension for item in plan.filters)
    if not requested:
        return
    dimensions = session.query(Dimension).filter(Dimension.key.in_(requested), Dimension.enabled.is_(True)).all()
    available = {dimension.key for dimension in dimensions}
    invalid = requested.difference(available)
    unsupported = requested.difference(DIMENSION_COLUMNS)
    if invalid or unsupported:
        raise ValueError("One or more requested dimensions are not approved for fleet analytics.")
    if any(dimension.dataset.key != plan.source for dimension in dimensions):
        raise ValueError("All dimensions must belong to the requested data source.")
