"""provider 适配器：key 型供应商（opencode-go / deepseek / …）。

统一模型：**窗口（window）**是唯一渲染单元——
  kind=percent  百分比条（direction=used 越高越糟 / left 越低越糟）
  kind=money    金额显示（余额这类，无进度条）
  kind=budget   金额 + 限额条（value/limit）
  kind=count    纯数字（只进弹层）
本地数据源（cc-switch / codeg-usage）在 _codeg_quota_sources.py，不走本模块注册表。

每个 key 型 provider 实现：
  fetch(key) -> 原始上游响应
  normalize(raw) -> {"windows": [...], "extra": {...}|None}
  validate(key)（默认 = fetch+normalize，失败抛 ValueError）
账号配置里以 type_id 引用（见 _codeg_quota_common.load_config）。
"""
import json
import re
import time
import urllib.error
import urllib.request


class WindowSpec:
    """provider 声明的窗口定义（静态元数据，随适配器注册）。"""

    def __init__(self, id, label, primary=False, kind="percent", direction="used",
                 resets=None, alert=None, pill=True):
        self.id = id
        self.label = label          # {"zh": ..., "en": ...}
        self.primary = primary      # 主窗口：驱动药丸/旧镜像 r/默认告警
        self.kind = kind
        self.direction = direction
        self.resets = resets        # 5h | daily | weekly | monthly | None
        self.alert = alert or {}    # {"pct": [80]} | {"below": 10, "runOutHours": 24}
        self.pill = pill            # 是否参与药丸显示

    def to_json(self):
        return {"id": self.id, "label": self.label, "primary": self.primary,
                "kind": self.kind, "direction": self.direction,
                "resets": self.resets, "alert": self.alert, "pill": self.pill}


class KeyAdapter:
    type_id = ""
    display_name = {}
    key_pattern = re.compile(r".+")
    default_interval_s = 60
    windows = []  # [WindowSpec]

    def validate(self, key):
        """校验 key 可用性；失败抛 ValueError。"""
        return self.normalize(self.fetch(key))

    def fetch(self, key):
        raise NotImplementedError

    def normalize(self, raw):
        """-> {"windows": [窗口 dict], "extra": {额外字段}|None}"""
        raise NotImplementedError

    def _window(self, spec, **values):
        w = {"id": spec.id, "label": spec.label, "kind": spec.kind,
             "direction": spec.direction, "primary": spec.primary,
             "resetsAt": values.pop("resetsAt", None), "alert": spec.alert,
             "pill": spec.pill, "resets": spec.resets}
        w.update(values)
        return w


def _get_json(url, key, timeout=15, retries=2):
    """GET + JSON。TLS/连接类瞬断（如 EOF in violation of protocol）自动重试；
    HTTP 错误（401/4xx/5xx）立即抛出，不拿无效 key 反复打。"""
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "Authorization": "Bearer " + key, "Accept": "application/json",
                "User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError:
            raise
        except Exception as e:
            last = e
            if attempt + 1 < retries:
                time.sleep(1.5)
    raise last


class OpenCodeGoAdapter(KeyAdapter):
    type_id = "opencode-go"
    display_name = {"zh": "OpenCode Go", "en": "OpenCode Go"}
    key_pattern = re.compile(r"sk-[A-Za-z0-9_-]{8,}")
    default_interval_s = 60
    URL = "https://opencode.ai/zen/go/v1/usage"
    windows = [
        WindowSpec("rolling", {"zh": "5小时", "en": "5-hour"}, primary=True,
                   resets="5h", alert={"pct": [80]}),
        WindowSpec("weekly", {"zh": "每周", "en": "Weekly"},
                   resets="weekly", alert={"pct": [90]}),
        WindowSpec("monthly", {"zh": "每月", "en": "Monthly"},
                   resets="monthly", alert={"pct": [95]}),
    ]

    def fetch(self, key):
        return _get_json(self.URL, key)

    def normalize(self, raw):
        usage = raw.get("usage", raw)
        out = []
        for spec in self.windows:
            d = usage.get(spec.id)
            if not isinstance(d, dict):
                raise ValueError("unexpected usage response (missing %s)" % spec.id)
            out.append(self._window(spec, percent=d.get("percent"),
                                    resetsAt=d.get("resetsAt")))
        return {"windows": out, "extra": {"usage": usage}}


class DeepSeekAdapter(KeyAdapter):
    type_id = "deepseek"
    display_name = {"zh": "DeepSeek", "en": "DeepSeek"}
    key_pattern = re.compile(r"sk-[A-Za-z0-9_-]{8,}")
    default_interval_s = 300
    URL = "https://api.deepseek.com/user/balance"
    windows = [
        WindowSpec("balance", {"zh": "余额", "en": "Balance"}, primary=True,
                   kind="money", direction="left",
                   alert={"below": 10, "runOutHours": 24}),
    ]

    def fetch(self, key):
        return _get_json(self.URL, key)

    def normalize(self, raw):
        infos = raw.get("balance_infos")
        if not isinstance(infos, list) or not infos:
            raise ValueError("no balance info (is_available=%s)" % raw.get("is_available"))
        pick = None
        for i in infos:
            if isinstance(i, dict) and i.get("currency") == "CNY":
                pick = i
                break
        if pick is None:
            pick = infos[0]
        total = float(pick.get("total_balance") or 0)
        spec = self.windows[0]
        window = self._window(spec, value=total, unit=pick.get("currency"))
        extra = {"balance": {
            "currency": pick.get("currency"),
            "total": total,
            "toppedUp": float(pick.get("topped_up_balance") or 0),
            "granted": float(pick.get("granted_balance") or 0),
            "available": bool(raw.get("is_available")),
        }}
        return {"windows": [window], "extra": extra}


class OpenRouterAdapter(KeyAdapter):
    type_id = "openrouter"
    display_name = {"zh": "OpenRouter", "en": "OpenRouter"}
    key_pattern = re.compile(r"sk-or-[A-Za-z0-9_-]{8,}")
    default_interval_s = 300
    URL = "https://openrouter.ai/api/v1/credits"
    windows = [
        WindowSpec("credits", {"zh": "余额", "en": "Credits"}, primary=True,
                   kind="money", direction="left",
                   alert={"below": 5, "runOutHours": 24}),
    ]

    def fetch(self, key):
        return _get_json(self.URL, key)

    def normalize(self, raw):
        d = raw.get("data", raw)
        if not isinstance(d, dict):
            raise ValueError("unexpected credits response")
        total = float(d.get("total_credits") or 0)
        used = float(d.get("total_usage") or 0)
        remain = round(total - used, 6)
        spec = self.windows[0]
        window = self._window(spec, value=remain, unit="USD")
        extra = {"balance": {"currency": "USD", "total": remain,
                             "toppedUp": total, "granted": 0.0, "available": True}}
        return {"windows": [window], "extra": extra}


ADAPTERS = {}
for _cls in (OpenCodeGoAdapter, DeepSeekAdapter, OpenRouterAdapter):
    ADAPTERS[_cls.type_id] = _cls()


def get_adapter(type_id):
    return ADAPTERS.get(type_id)


def build_account_entries(providers_cfg, only_types=None, prev_by_key=None):
    """按配置构建账号输出条目（含 windows/镜像/error）。only_types=None 表示全部。

    抓取失败时若上次有数据则沿用（保留 windows，标记 stale + error），避免药丸退化成"—"。
    """
    entries = []
    for prov in providers_cfg.get("providers", []):
        if not isinstance(prov, dict):
            continue
        ptype = prov.get("type") or ""
        if only_types is not None and ptype not in only_types:
            continue
        adapter = get_adapter(ptype)
        accounts = [x for x in (prov.get("accounts") or [])
                    if isinstance(x, dict) and x.get("apiKey")]
        for x in accounts:
            name = x.get("name") or "账号"
            if adapter is None:
                entries.append({"provider": ptype, "name": name,
                                "error": "unknown provider type: %s" % ptype})
                continue
            try:
                norm = adapter.normalize(adapter.fetch(x["apiKey"]))
                entry = {"provider": ptype, "name": name,
                         "windows": norm["windows"], "error": None}
                if norm.get("extra"):
                    entry.update(norm["extra"])
                entries.append(entry)
            except Exception as e:
                msg = str(e)[:120]
                prev = (prev_by_key or {}).get((ptype, name))
                if prev and prev.get("windows"):
                    entry = dict(prev)
                    entry["error"] = msg
                    entry["stale"] = True
                    entries.append(entry)
                else:
                    entries.append({"provider": ptype, "name": name, "error": msg})
    return entries
