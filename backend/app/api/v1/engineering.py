from typing import Annotated

from fastapi import APIRouter, Depends

from app.core.auth import AuthenticatedUser, require_roles
from app.schemas.engineering import EngineeringAssessmentRequest, EngineeringAssessmentResponse
from app.services.engineering import assess_engineering_metrics

router = APIRouter(tags=["engineering"])
Engineer = Annotated[AuthenticatedUser, Depends(require_roles("engineer", "admin"))]


@router.post("/engineering/assessments", response_model=EngineeringAssessmentResponse)
def create_engineering_assessment(payload: EngineeringAssessmentRequest, _: Engineer) -> EngineeringAssessmentResponse:
    return assess_engineering_metrics(payload)
