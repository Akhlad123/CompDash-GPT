from __future__ import annotations

from functools import lru_cache

from pydantic import Field, HttpUrl, ValidationError, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_prefix="COMPDASH_ASK_",
        extra="ignore",
    )

    app_name: str = "CompDash Ask API"
    environment: str = Field(default="development", pattern="^(development|test|staging|production)$")
    api_v1_prefix: str = "/api/v1"
    allowed_origins: list[HttpUrl] = Field(default_factory=list)
    log_level: str = Field(default="INFO", pattern="^(DEBUG|INFO|WARNING|ERROR|CRITICAL)$")
    release: str = "0.1.0"
    entra_tenant_id: str | None = Field(default=None, min_length=1, max_length=100)
    entra_client_id: str | None = Field(default=None, min_length=1, max_length=100)
    entra_issuer: HttpUrl | None = None
    entra_jwks_url: HttpUrl | None = None
    database_url: str | None = Field(default=None, min_length=1, max_length=2_048)
    redis_url: str | None = Field(default=None, min_length=1, max_length=2_048)
    query_cache_ttl_seconds: int = Field(default=300, ge=1, le=3_600)

    @model_validator(mode="after")
    def validate_production_auth(self) -> Settings:
        if self.environment == "production" and not self.entra_is_configured:
            raise ValueError("Microsoft Entra ID configuration is required in production")
        if self.environment == "production" and (not self.database_url or not self.redis_url):
            raise ValueError("PostgreSQL and Redis configuration are required in production")
        return self

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def entra_is_configured(self) -> bool:
        return all(
            [
                self.entra_tenant_id,
                self.entra_client_id,
                self.entra_issuer,
                self.entra_jwks_url,
            ]
        )


@lru_cache
def get_settings() -> Settings:
    try:
        return Settings()
    except ValidationError as error:
        raise RuntimeError("Invalid CompDash Ask API configuration") from error
