from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from starlette.status import HTTP_422_UNPROCESSABLE_CONTENT

from app.core.auth import AuthenticatedUser, require_roles
from app.core.errors import ApiError
from app.db.dependencies import get_db_session
from app.schemas.telemetry_query import TelemetryPlanValidationResponse, TelemetryQueryPlan
from app.services.telemetry_kql import compile_telemetry_kql

router = APIRouter(tags=["telemetry-query"])
AnalyticsUser = Annotated[AuthenticatedUser, Depends(require_roles("analyst", "engineer", "admin"))]


@router.post("/catalog/telemetry-query/validate", response_model=TelemetryPlanValidationResponse)
def validate_telemetry_plan(
    plan: TelemetryQueryPlan,
    _: AnalyticsUser,
    session: Annotated[Session, Depends(get_db_session)],
) -> TelemetryPlanValidationResponse:
    try:
        kql, parameters, unit = compile_telemetry_kql(session, plan)
    except ValueError as error:
        raise ApiError(
            status_code=HTTP_422_UNPROCESSABLE_CONTENT,
            error_type="https://compdash.internal/problems/invalid-telemetry-query-plan",
            title="Invalid telemetry query plan",
            detail=str(error),
        ) from error
    return TelemetryPlanValidationResponse(kql=kql, parameters=parameters, metric_unit=unit)
