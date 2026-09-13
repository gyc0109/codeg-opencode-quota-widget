"""codeg-opencode-quota 公共模块：平台/路径/配置解析（Linux + macOS）。

被 updater / api / patch 三个脚本 import（同目录即可）。
"""
import json
import os
import pathlib
import re
import sys

IS_MACOS = sys.platform == "darwin"


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
    env = os.environ.get("CODEG_STATIC_DIR")
    if env:
        return pathlib.Path(env)
    return pathlib.Path("/usr/local/share/codeg/web")


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
    """quota-accounts.json 不存在时的单 key 回退来源。"""
    return [
        home() / ".config/opencode/opencode.jsonc",
        home() / ".codeg/opencode-go-key",
    ]


def load_accounts():
    """返回 [(name, api_key)]；账号文件 → 回退配置文件里的单 key。"""
    try:
        d = json.loads(accounts_file().read_text(encoding="utf-8"))
        acc = [(x.get("name", "账号%d" % (i + 1)), x.get("apiKey", ""))
               for i, x in enumerate(d) if isinstance(x, dict) and x.get("apiKey")]
        if acc:
            return acc
    except FileNotFoundError:
        pass
    except Exception as e:
        print("opencode-quota: accounts file error: %s" % e, file=sys.stderr)
    for p in fallback_key_files():
        try:
            t = p.read_text(encoding="utf-8")
        except OSError:
            continue
        m = re.search(r'"apiKey"\s*:\s*"([^"]+)"', t)
        if m:
            return [("主号", m.group(1))]
        s = t.strip()
        if s.startswith("sk-") and "\n" not in s:
            return [("主号", s)]
    return []


def write_targets(basename):
    """数据文件要写往的目录列表：data_dir 恒写；web_root 存在时同时镜像。"""
    dirs = [data_dir()]
    wr = web_root()
    try:
        if wr.is_dir() and wr.resolve() != data_dir().resolve():
            dirs.append(wr)
    except OSError:
        pass
    return [(d / basename, d) for d in dirs]
