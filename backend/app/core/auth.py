from __future__ import annotations

from functools import lru_cache
from typing import Annotated
from uuid import UUID

import jwt
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import InvalidTokenError, PyJWKClient
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from starlette.status import HTTP_401_UNAUTHORIZED, HTTP_403_FORBIDDEN, HTTP_503_SERVICE_UNAVAILABLE

from app.core.config import Settings, get_settings
from app.core.errors import ApiError

bearer_scheme = HTTPBearer(auto_error=False)


class AuthenticatedUser(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: UUID
    email: EmailStr | None = None
    display_name: str | None = Field(default=None, max_length=500)
    roles: frozenset[str] = Field(default_factory=frozenset)


@lru_cache
def get_jwks_client(jwks_url: str) -> PyJWKClient:
    return PyJWKClient(jwks_url, cache_jwk_set=True, lifespan=3_600)


def unauthorized_error(detail: str) -> ApiError:
    return ApiError(
        status_code=HTTP_401_UNAUTHORIZED,
        error_type="https://compdash.internal/problems/authentication-required",
        title="Authentication required",
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def validate_access_token(token: str, settings: Settings) -> AuthenticatedUser:
    if not settings.entra_is_configured:
        raise ApiError(
            status_code=HTTP_503_SERVICE_UNAVAILABLE,
            error_type="https://compdash.internal/problems/authentication-unavailable",
            title="Authentication is unavailable",
            detail="Microsoft Entra ID is not configured for this environment.",
        )

    try:
        signing_key = get_jwks_client(str(settings.entra_jwks_url)).get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=settings.entra_client_id,
            issuer=str(settings.entra_issuer),
            options={"require": ["exp", "iat", "iss", "aud", "oid"]},
        )
        roles_claim = claims.get("roles", [])
        if not isinstance(roles_claim, list) or not all(isinstance(role, str) for role in roles_claim):
            raise unauthorized_error("The access token roles claim is invalid.")
        object_id = claims["oid"]
        if not isinstance(object_id, str):
            raise unauthorized_error("The access token object ID claim is invalid.")
        return AuthenticatedUser(
            id=UUID(object_id),
            email=claims.get("preferred_username"),
            display_name=claims.get("name"),
            roles=frozenset(roles_claim),
        )
    except ApiError:
        raise
    except (InvalidTokenError, ValueError) as error:
        raise unauthorized_error("The access token is invalid or expired.") from error


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> AuthenticatedUser:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise unauthorized_error("A bearer access token is required.")
    return validate_access_token(credentials.credentials, settings)


def require_roles(*required_roles: str):
    required = frozenset(required_roles)

    async def authorize(user: Annotated[AuthenticatedUser, Depends(get_current_user)]) -> AuthenticatedUser:
        if required and not user.roles.intersection(required):
            raise ApiError(
                status_code=HTTP_403_FORBIDDEN,
                error_type="https://compdash.internal/problems/forbidden",
                title="Insufficient permissions",
                detail="Your assigned role cannot perform this action.",
            )
        return user

    return authorize
