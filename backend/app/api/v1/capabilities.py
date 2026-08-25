from fastapi import APIRouter

router = APIRouter(tags=["capabilities"])


@router.get("/capabilities")
def get_capabilities() -> dict[str, object]:
    return {"tools": ["fleet_analytics", "telemetry_plan_validation", "document_retrieval", "solar_engineering_assessment"], "max_result_rows": 100, "telemetry_enabled": False, "document_retrieval_enabled": True}


@router.get("/data-freshness")
def get_data_freshness() -> dict[str, object]:
    return {"sources": [{"source": "fleet_postgres", "status": "unknown"}, {"source": "telemetry_adx", "status": "unknown"}]}
