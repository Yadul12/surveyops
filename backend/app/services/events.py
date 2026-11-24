import json
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import redis

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger("surveyops.events")

EVENT_CHANNEL = "surveyops:live_events"


def get_redis_client() -> Optional[redis.Redis]:
    redis_url = settings.effective_redis_url
    if not redis_url:
        return None
    try:
        return redis.Redis.from_url(redis_url, decode_responses=True, socket_connect_timeout=2)
    except Exception:
        return None


def publish_live_event(event_type: str, payload: Dict[str, Any]) -> None:
    message = {
        "event_type": event_type,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": payload,
    }
    try:
        client = get_redis_client()
        if client is not None:
            client.publish(EVENT_CHANNEL, json.dumps(message, default=str))
            # Also push to recent ring buffer so new SSE/WS clients see immediate history
            client.lpush("surveyops:recent_events", json.dumps(message, default=str))
            client.ltrim("surveyops:recent_events", 0, 49)
    except Exception as exc:
        logger.debug("Live event publish skipped: %s", exc)


def get_recent_events(limit: int = 20) -> list[dict]:
    try:
        client = get_redis_client()
        if client is not None:
            raw_items = client.lrange("surveyops:recent_events", 0, limit - 1)
            return [json.loads(item) for item in raw_items]
    except Exception:
        pass
    return []
