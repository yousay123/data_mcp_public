import json
import logging
import sys
import time
import uuid
from dataclasses import dataclass
from typing import Any


logger = logging.getLogger("ksher_agent_data_mcp.audit")
if not logger.handlers:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)
logger.propagate = False
logger.setLevel(logging.INFO)


@dataclass(frozen=True)
class AuditEvent:
    event_type: str
    union_id: str | None
    feishu_user_id: str | None
    lark_app_id: str | None
    email: str | None
    status: str
    detail: dict[str, Any]


class AuditLogger:
    def emit(self, event: AuditEvent) -> str:
        audit_id = f"audit_{uuid.uuid4().hex}"
        payload = {
            "audit_id": audit_id,
            "event_time_ms": int(time.time() * 1000),
            "event_type": event.event_type,
            "union_id": event.union_id,
            "feishu_user_id": event.feishu_user_id,
            "lark_app_id": event.lark_app_id,
            "email": event.email,
            "status": event.status,
            "detail": event.detail,
        }
        logger.info(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        return audit_id


audit_logger = AuditLogger()
