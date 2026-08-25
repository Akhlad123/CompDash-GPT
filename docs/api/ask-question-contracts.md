# Ask-a-Question API Contract

## Contract rules

- All endpoints use `/api/v1` and require Microsoft Entra bearer authentication except health endpoints.
- The browser submits a `QuestionRequest` and receives an `AnalysisRun` through REST plus server-sent events.
- Analysis outputs are typed artifacts: KPI, table, chart, insight, citation, clarification, or warning.
- Table artifacts return columns, row count, and a cursor. Rows are fetched through a paginated endpoint and are never embedded unbounded in an assistant response.
- `AssistantResponse` includes narrative, confidence, uncertainty reasons, assumptions, data freshness, citations, suggested follow-ups, and artifacts.
- Errors use `ProblemDetails` with a correlation ID.

## Initial endpoint set

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/conversations` | Create a user-owned conversation. |
| POST | `/conversations/{id}/questions` | Start an analysis run from a `QuestionRequest`. |
| GET | `/analysis-runs/{id}` | Recover current run state and final response. |
| GET | `/analysis-runs/{id}/events` | Stream accepted, planning, clarification, artifact, completion, and failure events. |
| GET | `/analysis-artifacts/{id}/rows` | Retrieve cursor-paginated table rows. |
| POST | `/analysis-runs/{id}/cancel` | Request cancellation. |
| POST | `/analysis-runs/{id}/feedback` | Submit answer quality feedback. |

## Query safety boundary

Models produce typed semantic query plans, not executable SQL or KQL. Server-side compilers resolve only approved metrics, dimensions, relationships, and filters before executing parameterized, read-only queries with enforced time, row, scan, and timeout budgets.
