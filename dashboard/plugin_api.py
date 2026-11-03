"""Backend API for the Status Telemetry Desktop plugin (`/api/plugins/status-telemetry`).

Provides read-only session cost, 7-day profile spend rollups (via the public
`hermes_state.SessionDB` API), and host physical memory stats (via `psutil`) so
the Desktop plugin operates 100% through `ctx.rest()` without touching raw
`window.hermesDesktop` internals.
"""

from __future__ import annotations

import time
from datetime import datetime
from typing import Any, Optional

import psutil
from fastapi import APIRouter, Query
from hermes_state import SessionDB

router = APIRouter()


@router.get("/hardware")
def get_host_hardware() -> dict[str, Any]:
    """Return host physical RAM usage in bytes and percentage."""
    try:
        mem = psutil.virtual_memory()
        return {
            "ok": True,
            "ram_total_bytes": int(mem.total),
            "ram_available_bytes": int(mem.available),
            "ram_used_bytes": int(mem.total - mem.available),
            "ram_percent": round(float(mem.percent), 1),
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@router.get("/telemetry")
def get_session_and_profile_telemetry(
    session_id: Optional[str] = Query(None),
    days: int = Query(7, ge=1, le=90),
) -> dict[str, Any]:
    """Return persisted session cost/token counters and a N-day local spend rollup."""
    cutoff = time.time() - (days * 86400)
    session_row: Optional[dict[str, Any]] = None
    daily_map: dict[str, dict[str, Any]] = {}
    totals = {
        "total_input": 0,
        "total_output": 0,
        "total_reasoning": 0,
        "total_cache_read": 0,
        "total_estimated_cost": 0.0,
        "total_actual_cost": 0.0,
        "total_sessions": 0,
        "total_api_calls": 0,
    }

    db = SessionDB()
    try:
        if session_id:
            session_row = db.get_session(session_id)
        recent = db.search_sessions(limit=250)
        if session_row is None and recent:
            session_row = recent[0]

        for row in recent:
            started = float(row.get("started_at") or 0.0)
            if started < cutoff:
                continue
            day_key = datetime.fromtimestamp(started).strftime("%Y-%m-%d")
            inp = int(row.get("input_tokens") or 0)
            out = int(row.get("output_tokens") or 0)
            reas = int(row.get("reasoning_tokens") or 0)
            cache_r = int(row.get("cache_read_tokens") or 0)
            est = float(row.get("estimated_cost_usd") or 0.0)
            act = float(row.get("actual_cost_usd") or 0.0)
            calls = int(row.get("api_call_count") or 0)

            bucket = daily_map.setdefault(
                day_key,
                {
                    "day": day_key,
                    "sessions": 0,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "estimated_cost": 0.0,
                    "actual_cost": 0.0,
                },
            )
            bucket["sessions"] += 1
            bucket["input_tokens"] += inp
            bucket["output_tokens"] += out
            bucket["estimated_cost"] += est
            bucket["actual_cost"] += act

            totals["total_sessions"] += 1
            totals["total_input"] += inp
            totals["total_output"] += out
            totals["total_reasoning"] += reas
            totals["total_cache_read"] += cache_r
            totals["total_estimated_cost"] += est
            totals["total_actual_cost"] += act
            totals["total_api_calls"] += calls
    finally:
        db.close()

    daily_sorted = [daily_map[k] for k in sorted(daily_map.keys())]
    slim_session = None
    if session_row:
        slim_session = {
            "id": session_row.get("id"),
            "model": session_row.get("model"),
            "billing_provider": session_row.get("billing_provider"),
            "input_tokens": int(session_row.get("input_tokens") or 0),
            "output_tokens": int(session_row.get("output_tokens") or 0),
            "reasoning_tokens": int(session_row.get("reasoning_tokens") or 0),
            "cache_read_tokens": int(session_row.get("cache_read_tokens") or 0),
            "cache_write_tokens": int(session_row.get("cache_write_tokens") or 0),
            "estimated_cost_usd": float(session_row.get("estimated_cost_usd") or 0.0),
            "actual_cost_usd": float(session_row.get("actual_cost_usd") or 0.0),
            "cost_status": session_row.get("cost_status"),
            "api_call_count": int(session_row.get("api_call_count") or 0),
            "tool_call_count": int(session_row.get("tool_call_count") or 0),
            "message_count": int(session_row.get("message_count") or 0),
        }

    return {
        "ok": True,
        "session": slim_session,
        "daily": daily_sorted,
        "totals": totals,
    }
