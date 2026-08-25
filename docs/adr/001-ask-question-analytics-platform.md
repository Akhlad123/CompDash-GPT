# ADR 001: Ask-a-Question Analytics Platform

## Status
Accepted

## Decision
The Ask a Question route will migrate from browser DuckDB and a Netlify LLM fallback to a private Azure-managed analytics platform. The React page remains the only existing UI page changed and adopts a feature-local module under `src/features/ask-question/`.

PostgreSQL with pgvector is the system of record for application state, semantic catalog, governance, audit records, and approved document retrieval. Azure Data Explorer is the telemetry-serving engine for raw and curated telemetry at 100M+ rows. FastAPI owns API contracts, authorization, orchestration, streaming, and governed execution. LangGraph produces typed tool decisions and QueryPlans; deterministic compilers execute parameterized read-only SQL/KQL only from approved semantic catalog definitions.

## Consequences
- The browser never receives AI credentials, database credentials, model-generated SQL/KQL, or unbounded row sets.
- Existing pages retain their present client-side data paths.
- All answers must expose scope, time range, source freshness, confidence, assumptions, and caveats.
- Technical-document answers require citations with document version and page/chunk provenance.
- Azure-managed services and remote CI/CD avoid requiring Docker Desktop, local databases, or privileged installs on company laptops.
