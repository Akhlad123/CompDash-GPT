import pytest
from pydantic import ValidationError

from app.core.config import Settings


def test_production_requires_shared_state_dependencies() -> None:
    with pytest.raises(ValidationError):
        Settings(environment="production", entra_tenant_id="tenant", entra_client_id="client", entra_issuer="https://login.microsoftonline.com/tenant/v2.0", entra_jwks_url="https://login.microsoftonline.com/tenant/discovery/v2.0/keys")
