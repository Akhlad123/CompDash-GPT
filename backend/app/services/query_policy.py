from app.schemas.query_plan import FleetQueryPlan

TIME_DIMENSION = "quarter_first_interval"


class ClarificationRequired(Exception):
    def __init__(self, message: str) -> None:
        self.message = message
        super().__init__(message)


def enforce_fleet_policy(plan: FleetQueryPlan) -> None:
    time_sensitive_metrics = {"unit_count", "dc_ac_ratio", "stc_rating_w"}
    has_quarter = any(item.dimension == TIME_DIMENSION for item in plan.filters)
    if plan.metric in time_sensitive_metrics and not has_quarter:
        raise ClarificationRequired("Select a reporting quarter or explicitly request all reporting periods.")
    if plan.limit > 100:
        raise ValueError("Fleet query result limits cannot exceed 100 rows.")
