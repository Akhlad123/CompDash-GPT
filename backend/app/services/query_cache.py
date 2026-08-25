import hashlib
import json
from typing import Any

from redis import Redis


class QueryCache:
    def __init__(self, redis_url: str | None = None, ttl_seconds: int = 300) -> None:
        self.values: dict[str, dict[str, object]] = {}
        self.redis = Redis.from_url(redis_url, decode_responses=True) if redis_url else None
        self.ttl_seconds = ttl_seconds

    def key(self, *, user_id: str, plan: dict[str, Any]) -> str:
        payload = json.dumps({"user_id": user_id, "plan": plan, "catalog_version": "v1"}, sort_keys=True, separators=(",", ":"))
        return f"compdash:query:{hashlib.sha256(payload.encode()).hexdigest()}"

    def get(self, key: str) -> dict[str, object] | None:
        if self.redis is None:
            return self.values.get(key)
        payload = self.redis.get(key)
        return json.loads(payload) if payload else None

    def set(self, key: str, value: dict[str, object]) -> None:
        if self.redis is None:
            self.values[key] = value
            return
        self.redis.setex(key, self.ttl_seconds, json.dumps(value, separators=(",", ":")))
