from __future__ import annotations

import re
from typing import Literal
from typing_extensions import TypedDict

from langgraph.graph import END, START, StateGraph
from sqlalchemy.orm import Session

from app.schemas.query_plan import FleetFilter, FleetQueryPlan
from app.services.fleet_query import execute_fleet_query
from app.services.query_policy import ClarificationRequired


class AnalysisState(TypedDict, total=False):
    question: str
    metric: str
    aggregation: Literal["sum", "average", "minimum", "maximum", "count"]
    group_by: list[str]
    filters: list[dict[str, object]]
    plan: FleetQueryPlan
    status: Literal["clarification_required", "completed", "failed"]
    clarification: str
    result_rows: list[dict[str, object | None]]
    metric_unit: str
    error: str


def classify_intent(state: AnalysisState) -> AnalysisState:
    question = state["question"].lower()
    metric = ""
    if any(token in question for token in ["dc/ac", "dc ac", "dc-ac", "oversizing"]):
        metric = "dc_ac_ratio"
    elif any(token in question for token in ["unit", "microinverter count", "inverter count"]):
        metric = "unit_count"
    elif any(token in question for token in ["irradiance", "irradiation", "ghi"]):
        metric = "irradiation_monthly_kwh_m2"
    elif any(token in question for token in ["stc", "module power", "wattage"]):
        metric = "stc_rating_w"
    if not metric:
        return {"status": "failed", "error": "I could not match this question to an approved fleet metric."}
    aggregation: Literal["sum", "average", "minimum", "maximum", "count"] = "average"
    if metric == "unit_count" and any(token in question for token in ["total", "how many", "count"]):
        aggregation = "sum"
    elif any(token in question for token in ["highest", "maximum", "max"]):
        aggregation = "maximum"
    elif any(token in question for token in ["lowest", "minimum", "min"]):
        aggregation = "minimum"
    return {"metric": metric, "aggregation": aggregation}


def resolve_scope(state: AnalysisState) -> AnalysisState:
    question = state["question"]
    lower = question.lower()
    filters: list[dict[str, object]] = []
    quarter = re.search(r"20\d{2}\s*-\s*Q[1-4]", question, flags=re.IGNORECASE)
    if quarter:
        filters.append({"dimension": "quarter_first_interval", "values": [quarter.group(0).upper()]})
    known_geographies = {"germany": "Germany", "north america": "North America", "europe": "Europe"}
    for phrase, value in known_geographies.items():
        if phrase in lower:
            dimension = "country" if phrase == "germany" else "region_bundle"
            filters.append({"dimension": dimension, "values": [value]})
            break
    group_by = ["country"] if "by country" in lower else ["region_bundle"] if "by region" in lower else []
    return {"filters": filters, "group_by": group_by}


def build_plan(state: AnalysisState) -> AnalysisState:
    if state.get("status") == "failed":
        return {}
    filters = [FleetFilter.model_validate(item) for item in state.get("filters", [])]
    return {
        "plan": FleetQueryPlan(
            source="fleet_snapshot",
            metric=state["metric"],
            aggregation=state["aggregation"],
            group_by=state.get("group_by", []),
            filters=filters,
        )
    }


def run_fleet_tool(session: Session):
    def execute(state: AnalysisState) -> AnalysisState:
        if state.get("status") == "failed":
            return {}
        try:
            rows, compiled = execute_fleet_query(session, state["plan"])
        except ClarificationRequired as error:
            return {"status": "clarification_required", "clarification": error.message}
        except ValueError as error:
            return {"status": "failed", "error": str(error)}
        return {"status": "completed", "result_rows": rows, "metric_unit": compiled.metric_unit}

    return execute


def build_analysis_graph(session: Session):
    graph = StateGraph(AnalysisState)
    graph.add_node("classify_intent", classify_intent)
    graph.add_node("resolve_scope", resolve_scope)
    graph.add_node("build_plan", build_plan)
    graph.add_node("run_fleet_tool", run_fleet_tool(session))
    graph.add_edge(START, "classify_intent")
    graph.add_edge("classify_intent", "resolve_scope")
    graph.add_edge("resolve_scope", "build_plan")
    graph.add_edge("build_plan", "run_fleet_tool")
    graph.add_edge("run_fleet_tool", END)
    return graph.compile()


def run_analysis_graph(session: Session, question: str) -> AnalysisState:
    return build_analysis_graph(session).invoke({"question": question})
