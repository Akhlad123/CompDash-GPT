from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, Request
from starlette.status import HTTP_404_NOT_FOUND

from app.analytics.polars_analysis import run_bounded_analysis
from app.core.auth import AuthenticatedUser, require_roles
from app.core.errors import ApiError
from app.schemas.analytics import AnalysisJobResult, BoundedAnalysisRequest

router = APIRouter(tags=["analytics"])
AnalyticsUser = Annotated[AuthenticatedUser, Depends(require_roles("analyst", "engineer", "admin"))]


def run_job(request: Request, job_id: str, payload: BoundedAnalysisRequest) -> None:
    request.app.state.analytics_jobs[job_id] = run_bounded_analysis(payload)


@router.post("/analytics/jobs", status_code=202)
def create_analytics_job(
    payload: BoundedAnalysisRequest,
    background_tasks: BackgroundTasks,
    request: Request,
    _: AnalyticsUser,
) -> dict[str, str]:
    job_id = str(uuid4())
    request.app.state.analytics_jobs[job_id] = {"status": "running"}
    background_tasks.add_task(run_job, request, job_id, payload)
    return {"job_id": job_id, "status": "running"}


@router.get("/analytics/jobs/{job_id}", response_model=AnalysisJobResult)
def get_analytics_job(job_id: str, request: Request, _: AnalyticsUser) -> AnalysisJobResult:
    result = request.app.state.analytics_jobs.get(job_id)
    if result is None:
        raise ApiError(status_code=HTTP_404_NOT_FOUND, error_type="https://compdash.internal/problems/analytics-job-not-found", title="Analytics job not found")
    if isinstance(result, dict):
        raise ApiError(status_code=HTTP_404_NOT_FOUND, error_type="https://compdash.internal/problems/analytics-job-running", title="Analytics job is still running")
    return result
