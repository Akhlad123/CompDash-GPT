from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session
from starlette.status import HTTP_422_UNPROCESSABLE_CONTENT

from app.core.auth import AuthenticatedUser, require_roles
from app.core.errors import ApiError
from app.db.dependencies import get_db_session
from app.schemas.query_plan import FleetQueryPlan, FleetQueryResult, QueryPlanValidationResponse
from app.services.fleet_query import compile_fleet_query, execute_fleet_query
from app.services.query_policy import ClarificationRequired
from app.services.query_cache import QueryCache
from app.services.audit import record_audit_event

router = APIRouter(tags=["fleet-query"])

AnalyticsUser = Annotated[AuthenticatedUser, Depends(require_roles("analyst", "engineer", "admin"))]


def compile_or_error(session: Session, plan: FleetQueryPlan):
    try:
        return compile_fleet_query(session, plan)
    except ClarificationRequired:
        return None
    except ValueError as error:
        raise ApiError(
            status_code=HTTP_422_UNPROCESSABLE_CONTENT,
            error_type="https://compdash.internal/problems/invalid-query-plan",
            title="Invalid fleet query plan",
            detail=str(error),
        ) from error


@router.post("/catalog/fleet-query/validate", response_model=QueryPlanValidationResponse)
def validate_fleet_plan(
    plan: FleetQueryPlan,
    _: AnalyticsUser,
    session: Annotated[Session, Depends(get_db_session)],
) -> QueryPlanValidationResponse:
    compiled = compile_or_error(session, plan)
    if compiled is None:
        return QueryPlanValidationResponse(
            sql="",
            parameters={},
            metric_unit="",
            required_clarification="Select a reporting quarter or explicitly request all reporting periods.",
        )
    return QueryPlanValidationResponse(
        sql=compiled.sql,
        parameters=compiled.parameters,
        metric_unit=compiled.metric_unit,
    )


@router.post("/catalog/fleet-query/execute", response_model=FleetQueryResult)
def run_fleet_plan(
    plan: FleetQueryPlan,
    request: Request,
    user: AnalyticsUser,
    session: Annotated[Session, Depends(get_db_session)],
) -> FleetQueryResult:
    compiled = compile_or_error(session, plan)
    if compiled is None:
        return FleetQueryResult(columns=[], rows=[], row_count=0, metric_unit="")
    cache = request.app.state.query_cache
    if not isinstance(cache, QueryCache):
        raise RuntimeError("Query cache is unavailable")
    cache_key = cache.key(user_id=str(user.id), plan=plan.model_dump(mode="json"))
    cached = cache.get(cache_key)
    if cached is not None:
        record_audit_event(session, action="fleet_query", outcome="cache_hit", user_id=user.id, metadata={"metric": plan.metric})
        session.commit()
        return FleetQueryResult.model_validate(cached)
    rows, _ = execute_fleet_query(session, plan)
    columns = list(rows[0].keys()) if rows else [*plan.group_by, "result"]
    response = FleetQueryResult(columns=columns, rows=rows, row_count=len(rows), metric_unit=compiled.metric_unit)
    cache.set(cache_key, response.model_dump(mode="json"))
    record_audit_event(session, action="fleet_query", outcome="executed", user_id=user.id, metadata={"metric": plan.metric, "row_count": response.row_count})
    session.commit()
    return response
