from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


def test_health_returns_service_metadata() -> None:
    app = create_app(Settings(app_name="CompDash Test API", environment="test", release="test-release"))

    with TestClient(app) as client:
        response = client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.headers["X-Correlation-ID"]
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "CompDash Test API"
    assert body["release"] == "test-release"
    assert body["timestamp"]


def test_readiness_returns_environment() -> None:
    app = create_app(Settings(environment="test"))

    with TestClient(app) as client:
        response = client.get("/api/v1/ready", headers={"X-Correlation-ID": "test-request"})

    assert response.status_code == 200
    assert response.headers["X-Correlation-ID"] == "test-request"
    body = response.json()
    assert body["status"] == "ready"
    assert body["environment"] == "test"
