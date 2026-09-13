"""codeg-opencode-quota 公共模块：平台/路径/配置解析（Linux + macOS）。

被 updater / api / patch / repair 四个脚本 import（同目录即可）。
"""
import json
import os
import pathlib
import re
import shutil
import sys

IS_MACOS = sys.platform == "darwin"
DEFAULT_PROVIDER = "opencode-go"


def home():
    return pathlib.Path(os.path.expanduser("~"))


def lib_dir():
    """本工具安装目录（母本 js、html 备份、数据、dylib 备份等）。"""
    env = os.environ.get("CODEG_QUOTA_LIB_DIR")
    if env:
        return pathlib.Path(env)
    if IS_MACOS:
        return home() / ".local/share/codeg-opencode-quota"
    return pathlib.Path("/usr/local/share/codeg-opencode-quota")


def data_dir():
    """updater 输出的规范数据目录（json / history，api 从这里读取）。"""
    env = os.environ.get("CODEG_QUOTA_DATA_DIR")
    if env:
        return pathlib.Path(env)
    return lib_dir() / "data"


def web_root():
    """前端静态根：注入 js/html、镜像 json 的目标目录。

    Linux: codeg-server 的 web 目录；macOS: lib 下的 web 副本（浏览器模式用）。
    """
    env = os.environ.get("CODEG_QUOTA_WEB_ROOT")
    if env:
        return pathlib.Path(env)
    if IS_MACOS:
        return lib_dir() / "web"
    return codeg_static_dir()


def codeg_static_dir():
    """codeg 自身的 web 静态目录（Linux 服务端安装位置 / macOS app bundle 内）。"""
    env = os.environ.get("CODEG_STATIC_DIR")
    if env:
        return pathlib.Path(env)
    if IS_MACOS:
        for c in (pathlib.Path("/Applications/codeg.app/Contents/Resources/web"),
                  home() / "Applications/codeg.app/Contents/Resources/web"):
            if c.is_dir():
                return c
    return pathlib.Path("/usr/local/share/codeg/web")


def accounts_file():
    env = os.environ.get("OPENCODE_QUOTA_ACCOUNTS")
    if env:
        return pathlib.Path(env)
    return home() / ".config/opencode/quota-accounts.json"


def fallback_key_files():
    """quota-accounts.json 不存在/损坏时的单 key 回退来源。"""
    return [
        home() / ".config/opencode/opencode.jsonc",
        home() / ".codeg/opencode-go-key",
    ]


def _fallback_keys():
    for p in fallback_key_files():
        try:
            t = p.read_text(encoding="utf-8")
        except (OSError, ValueError):
            continue
        m = re.search(r'"apiKey"\s*:\s*"([^"]+)"', t)
        if m:
            return [("主号", m.group(1))]
        s = t.strip()
        if s.startswith("sk-") and "\n" not in s:
            return [("主号", s)]
    return []


def _accounts_from_section(accounts):
    return [(x.get("name", "账号%d" % (i + 1)), x.get("apiKey", ""))
            for i, x in enumerate(accounts) if isinstance(x, dict) and x.get("apiKey")]


def _parse_config_text(text):
    """-> v2 配置 dict（v1 裸列表升级为 opencode-go 段）；无法识别返回 None。"""
    d = json.loads(text)
    if isinstance(d, list):
        provs = [{"type": DEFAULT_PROVIDER, "accounts": d, "options": {}}] if d else []
        return {"version": 2, "providers": provs}
    if isinstance(d, dict) and isinstance(d.get("providers"), list):
        return d
    return None


def _fallback_config():
    acc = _fallback_keys()
    provs = [{"type": DEFAULT_PROVIDER,
              "accounts": [{"name": n, "apiKey": k} for n, k in acc],
              "options": {}}] if acc else []
    return {"version": 2, "providers": provs}


def load_config():
    """读配置（v1 自动升级为内存 v2）。

    文件缺失/损坏时回退到 key 文件（与 load_accounts 语义一致）；
    文件存在且可解析时以其为准（空 providers 就是空，不回退）。
    """
    f = accounts_file()
    if not f.exists():
        return _fallback_config()
    try:
        cfg = _parse_config_text(f.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print("opencode-quota: accounts file error: %s" % e, file=sys.stderr)
        return _fallback_config()
    if cfg is None:
        print("opencode-quota: accounts file has unknown shape", file=sys.stderr)
        return _fallback_config()
    return cfg


def provider_accounts(cfg, type_id):
    for p in cfg.get("providers", []):
        if isinstance(p, dict) and p.get("type") == type_id:
            return p.get("accounts") or []
    return []


def load_accounts(provider=DEFAULT_PROVIDER):
    """返回 [(name, api_key)]（兼容旧签名）。

    文件存在且可解析时以其为准——空列表就是空（保证"删除最后一个账号"生效）；
    仅当文件不存在/损坏，且是默认 provider 时，才回退到配置文件里的单 key。
    """
    f = accounts_file()
    if f.exists():
        try:
            cfg = _parse_config_text(f.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            print("opencode-quota: accounts file error: %s" % e, file=sys.stderr)
            cfg = None
        if cfg is not None:
            return _accounts_from_section(provider_accounts(cfg, provider))
    if provider == DEFAULT_PROVIDER:
        return _fallback_keys()
    return []


def save_accounts(acc, provider=DEFAULT_PROVIDER):
    """写回指定 provider 的账号段落（段落合并，保留其他 provider；v1→v2 前先备份）。"""
    f = accounts_file()
    cfg = None
    if f.exists():
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(d, list):
                bak = f.with_name(f.name + ".v1.bak")
                if not bak.exists():
                    shutil.copy2(f, bak)
                cfg = {"version": 2, "providers":
                       [{"type": DEFAULT_PROVIDER, "accounts": d, "options": {}}] if d else []}
            elif isinstance(d, dict) and isinstance(d.get("providers"), list):
                cfg = d
        except (OSError, ValueError):
            cfg = None
    if cfg is None:
        cfg = {"version": 2, "providers": []}
    cfg.setdefault("version", 2)
    provs = cfg.setdefault("providers", [])
    section = None
    for p in provs:
        if isinstance(p, dict) and p.get("type") == provider:
            section = p
            break
    if section is None:
        section = {"type": provider, "accounts": [], "options": {}}
        provs.append(section)
    section["accounts"] = [{"name": n, "apiKey": k} for n, k in acc]
    atomic_write_text(f, json.dumps(cfg, ensure_ascii=False, indent=2), mode=0o600)


def atomic_write_text(path, text, mode=None):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # 临时名带 pid：多个 updater 进程（daemon + api 触发的 --once）并发时互不踩踏
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    if mode is not None:
        os.chmod(tmp, mode)
    os.replace(tmp, path)


def safe_int(name, default, minimum=None):
    """读环境变量整数：非法值回退默认（避免 KeepAlive 死循环刷日志）。"""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        v = int(raw)
    except ValueError:
        print("opencode-quota: bad %s=%r, using %d" % (name, raw, default), file=sys.stderr)
        return default
    if minimum is not None and v < minimum:
        print("opencode-quota: %s=%d below minimum %d, using %d"
              % (name, v, minimum, default), file=sys.stderr)
        return default
    return v


def write_targets(basename):
    """数据文件要写往的路径列表：data_dir 恒写；web_root 存在时同时镜像。"""
    dirs = [data_dir()]
    wr = web_root()
    if wr.is_dir() and wr.resolve() != data_dir().resolve():
        dirs.append(wr)
    return [d / basename for d in dirs]


def codeg_db_path():
    """codeg 主数据库路径（供只读查询）。"""
    env = os.environ.get("CODEG_DB")
    if env:
        return pathlib.Path(env)
    if IS_MACOS:
        cands = [home() / "Library/Application Support/app.codeg/codeg.db",
                 home() / "Library/Application Support/codeg/codeg.db"]
    else:
        cands = [home() / ".local/share/codeg/codeg.db",
                 home() / ".codeg/codeg.db"]
    for c in cands:
        if c.is_file():
            return c
    return cands[0]


def read_codeg_service():
    """从 codeg.db app_metadata 读 (web_service_port, web_service_token)；失败 (None, None)。

    必须用 mode=ro（不能加 immutable=1，否则读不到 WAL 里的最新值）。
    """
    p = codeg_db_path()
    if not p.is_file():
        return (None, None)
    try:
        import sqlite3
        con = sqlite3.connect("file:%s?mode=ro" % p, uri=True, timeout=2)
        try:
            rows = dict(con.execute(
                "SELECT key, value FROM app_metadata "
                "WHERE key IN ('web_service_port','web_service_token')").fetchall())
        finally:
            con.close()
        try:
            port = int(rows.get("web_service_port") or 0) or None
        except (TypeError, ValueError):
            port = None
        token = (rows.get("web_service_token") or "").strip() or None
        return (port, token)
    except Exception as e:
        print("opencode-quota: codeg.db read failed: %s" % e, file=sys.stderr)
        return (None, None)
