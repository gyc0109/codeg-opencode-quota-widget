"""本地数据源：cc-switch 网关统计、codeg 自身 token 用量。

源没有账号概念，各自产出一个数据块，由 updater 写入 opencode-quota-sources.json：
  {"schema":2, "_fetchedAt":..., "sources": {"<source_id>": {ok, stale, ...}}}
collect() 的异常由调用方兜底（保留上次数据并标 stale），源内部只负责查询。
"""
import datetime
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import _codeg_quota_common as common  # noqa: E402


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


class SourceAdapter:
    source_id = ""
    display_name = {}
    default_interval_s = 60

    def collect(self, prev):
        """-> 数据块 dict；失败抛异常（调用方保留 prev 并标 stale）。"""
        raise NotImplementedError


class CCSwitchSource(SourceAdapter):
    """CC Switch（本机多供应商网关）本地统计：实时逐请求日志 + 健康度 + 限额。"""

    source_id = "cc-switch"
    display_name = {"zh": "CC Switch 网关", "en": "CC Switch"}
    default_interval_s = 60
    ERR = "(status_code>=400 OR status_code IS NULL OR status_code=0)"

    def db_path(self):
        import os
        env = os.environ.get("CODEG_QUOTA_CCSWITCH_DB")
        if env:
            return pathlib.Path(env)
        return pathlib.Path.home() / ".cc-switch/cc-switch.db"

    def _connect(self):
        import sqlite3
        last = None
        for attempt in (0, 1):
            con = None
            try:
                con = sqlite3.connect("file:%s?mode=ro" % self.db_path(), uri=True, timeout=3)
                con.execute("SELECT count(*) FROM proxy_request_logs").fetchone()
                return con
            except sqlite3.OperationalError as e:
                last = e
                if con is not None:
                    try:
                        con.close()
                    except Exception:
                        pass
                if attempt == 0:
                    time.sleep(1)
        raise RuntimeError("cc-switch db unavailable: %s" % last)

    def collect(self, prev):
        now = datetime.datetime.now()
        today = int(now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
        month = int(now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp())
        hour = int(time.time()) - 3600
        con = self._connect()
        try:
            def q(sql, args=()):
                return con.execute(sql, args).fetchall()
            t_req, t_err, t_cost = q(
                "SELECT count(*), sum(CASE WHEN %s THEN 1 ELSE 0 END), "
                "COALESCE(sum(CAST(total_cost_usd AS REAL)),0) FROM proxy_request_logs "
                "WHERE created_at >= ?" % self.ERR, (today,))[0]
            h_req, h_err = q(
                "SELECT count(*), sum(CASE WHEN %s THEN 1 ELSE 0 END) FROM proxy_request_logs "
                "WHERE created_at >= ?" % self.ERR, (hour,))[0]
            (m_cost,) = q(
                "SELECT COALESCE(sum(CAST(total_cost_usd AS REAL)),0) FROM proxy_request_logs "
                "WHERE created_at >= ?", (month,))[0]
            models = q(
                "SELECT app_type, COALESCE(model,''), count(*), "
                "sum(CASE WHEN %s THEN 1 ELSE 0 END), "
                "COALESCE(sum(CAST(total_cost_usd AS REAL)),0), "
                "COALESCE(sum(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0) "
                "FROM proxy_request_logs WHERE created_at >= ? "
                "GROUP BY app_type, model ORDER BY 3 DESC LIMIT 8" % self.ERR, (today,))
            health = q(
                "SELECT h.provider_id, h.app_type, h.is_healthy, h.consecutive_failures, "
                "COALESCE(h.last_error,''), COALESCE(h.last_success_at,''), COALESCE(p.name,'') "
                "FROM provider_health h LEFT JOIN providers p "
                "ON p.id = h.provider_id AND p.app_type = h.app_type")
            limits = q(
                "SELECT id, app_type, COALESCE(name,''), limit_daily_usd, limit_monthly_usd "
                "FROM providers WHERE limit_daily_usd IS NOT NULL OR limit_monthly_usd IS NOT NULL")
            per = q(
                "SELECT provider_id, app_type, "
                "COALESCE(sum(CASE WHEN created_at >= ? THEN CAST(total_cost_usd AS REAL) END),0), "
                "COALESCE(sum(CASE WHEN created_at >= ? THEN CAST(total_cost_usd AS REAL) END),0) "
                "FROM proxy_request_logs WHERE created_at >= ? "
                "GROUP BY provider_id, app_type", (today, month, month))
        finally:
            con.close()
        per_map = dict(((r[0], r[1]), (r[2], r[3])) for r in per)

        lim_out = []
        for pid, app, name, dl, ml in limits:
            spent_t, spent_m = per_map.get((pid, app), (0.0, 0.0))
            if dl is not None and _f(dl) > 0:
                lim_out.append({"providerId": pid, "app": app, "name": name or pid[:8],
                                "window": "daily", "kind": "budget",
                                "value": round(spent_t, 4), "limit": _f(dl), "unit": "USD"})
            if ml is not None and _f(ml) > 0:
                lim_out.append({"providerId": pid, "app": app, "name": name or pid[:8],
                                "window": "monthly", "kind": "budget",
                                "value": round(spent_m, 4), "limit": _f(ml), "unit": "USD"})

        hist = list((prev or {}).get("hist") or [])
        hist.append({"t": int(time.time()), "cost": round(_f(t_cost), 4),
                     "err": int(t_err or 0), "req": int(t_req or 0)})
        hist = hist[-180:]

        return {
            "fetchedAt": now_iso(), "ok": True, "stale": False,
            "day": now.strftime("%Y-%m-%d"),
            "totals": {
                "today": {"requests": int(t_req or 0), "errors": int(t_err or 0),
                          "errorRate": round((t_err or 0) / t_req, 4) if t_req else 0.0,
                          "cost": round(_f(t_cost), 4), "unit": "USD"},
                "hour": {"requests": int(h_req or 0), "errors": int(h_err or 0),
                         "errorRate": round((h_err or 0) / h_req, 4) if h_req else 0.0},
                "month": {"cost": round(_f(m_cost), 4), "unit": "USD"},
            },
            "health": [{"providerId": r[0], "app": r[1], "healthy": bool(r[2]),
                        "consecutiveFailures": int(r[3] or 0), "lastError": r[4][:200],
                        "lastSuccessAt": r[5], "name": r[6] or (r[0] or "")[:8]} for r in health],
            "limits": lim_out,
            "models": [{"app": r[0], "model": r[1], "requests": int(r[2]), "errors": int(r[3] or 0),
                        "cost": round(_f(r[4]), 4), "tokens": int(r[5] or 0)} for r in models],
            "hist": hist,
        }


class CodegUsageSource(SourceAdapter):
    """codeg 自身 token 用量：走 GUI 的本地 HTTP API（fact 数据在 GUI 进程内）。"""

    source_id = "codeg-usage"
    display_name = {"zh": "codeg 用量", "en": "codeg usage"}
    default_interval_s = 300

    def _service(self):
        port, token = common.read_codeg_service()
        if port and token:
            return port, token
        try:
            import plistlib
            pl = pathlib.Path.home() / "Library/LaunchAgents/app.codeg.opencode-quota.server.plist"
            d = plistlib.loads(pl.read_bytes())
            env = d.get("EnvironmentVariables") or {}
            p2 = int(env.get("CODEG_PORT") or 0)
            t2 = (env.get("CODEG_TOKEN") or "").strip()
            if p2 and t2:
                return p2, t2
        except Exception:
            pass
        return None, None

    def _post(self, port, token, cmd, body):
        import urllib.request
        req = urllib.request.Request(
            "http://127.0.0.1:%d/api/%s" % (port, cmd),
            data=json.dumps(body).encode(),
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode())

    def collect(self, prev):
        port, token = self._service()
        if not port:
            raise RuntimeError("codeg web service not found")
        now = datetime.datetime.now()
        off = now.astimezone().strftime("%z") or "+0000"
        tz = off[:3] + ":" + off[3:]
        tz_min = int((now.astimezone().utcoffset() or datetime.timedelta()).total_seconds() // 60)

        def iso(dt):
            return dt.strftime("%Y-%m-%dT%H:%M:%S") + tz

        def report(start):
            return self._post(port, token, "token_usage_report", {"filter": {
                "start": iso(start), "end": iso(now), "bucket": "day",
                "tzOffsetMinutes": tz_min}}).get("totals") or {}

        def day_start(days):
            return (now - datetime.timedelta(days=days)).replace(
                hour=0, minute=0, second=0, microsecond=0)

        today = report(day_start(0))
        d30 = self._post(port, token, "token_usage_report", {"filter": {
            "start": iso(day_start(30)), "end": iso(now), "bucket": "day",
            "tzOffsetMinutes": tz_min}})
        facets = self._post(port, token, "token_usage_facets", {})

        def totals(t):
            return {"totalTokens": int(t.get("total_tokens") or 0),
                    "inputTokens": int(t.get("input_tokens") or 0),
                    "outputTokens": int(t.get("output_tokens") or 0),
                    "cacheReadTokens": int(t.get("cache_read_tokens") or 0),
                    "cacheCreationTokens": int(t.get("cache_creation_tokens") or 0),
                    "turns": int(t.get("turn_count") or 0),
                    "conversations": int(t.get("conversation_count") or 0)}

        return {
            "fetchedAt": now_iso(), "ok": True, "stale": False,
            "totals": {"today": totals(today), "d30": totals(d30.get("totals") or {})},
            "series": [{"day": s.get("bucket_key"), "tokens": int(s.get("total_tokens") or 0),
                        "turns": int(s.get("turn_count") or 0)}
                       for s in (d30.get("series") or [])],
            "byModel": [{"key": m.get("key") or m.get("label") or "?",
                         "tokens": int(m.get("total_tokens") or 0),
                         "turns": int(m.get("turn_count") or 0)}
                        for m in (d30.get("by_model") or [])][:10],
            "byAgent": [{"key": a.get("key") or a.get("label") or "?",
                         "tokens": int(a.get("total_tokens") or 0),
                         "turns": int(a.get("turn_count") or 0)}
                        for a in (d30.get("by_agent") or [])][:10],
            "facets": {"models": [(f.get("key") or f.get("label") or "") if isinstance(f, dict)
                                  else str(f) for f in (facets.get("models") or [])][:20]},
        }


SOURCES = {}
for _cls in (CCSwitchSource, CodegUsageSource):
    SOURCES[_cls.source_id] = _cls()


def refresh_sources(prev_doc, only_ids=None):
    """采集各源；失败保留上次数据并标 stale。返回完整 sources 文档。"""
    prev_sources = dict((prev_doc or {}).get("sources") or {})
    out = dict(prev_sources)
    for sid, src in SOURCES.items():
        if only_ids is not None and sid not in only_ids:
            continue
        prev_block = prev_sources.get(sid)
        try:
            out[sid] = src.collect(prev_block)
        except Exception as e:
            old = dict(prev_block or {})
            old["stale"] = True
            old.setdefault("ok", False)
            old["error"] = str(e)[:160]
            out[sid] = old
    return {"schema": 2, "_fetchedAt": now_iso(), "sources": out}


def sources_due(last_run):
    now = time.time()
    due = set()
    for sid, src in SOURCES.items():
        if now - last_run.get(sid, 0) >= src.default_interval_s:
            due.add(sid)
    return due
