#!/usr/bin/env bash
# codeg-opencode-quota-widget 安装（Linux + macOS）
#
# 用法:
#   Linux : sudo ./install.sh
#   macOS : ./install.sh [--browser] [--desktop-tweak]
#     --browser        额外安装"浏览器模式"：本机 :3080 提供打补丁的 codeg web UI（launchd 常驻）
#     --desktop-tweak  额外给 codeg.app 桌面版注入额度药丸（dylib + ad-hoc 重签，见 README 风险说明）
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
WITH_BROWSER=0
WITH_TWEAK=0
for a in "$@"; do
  case "$a" in
    --browser) WITH_BROWSER=1 ;;
    --desktop-tweak) WITH_TWEAK=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数: $a（支持 --browser / --desktop-tweak）" >&2; exit 1 ;;
  esac
done

detect_python() {
  if [ -x /usr/bin/python3 ]; then echo /usr/bin/python3
  else command -v python3; fi
}

bootstrap_agent() {
  local label="$1" plist="$2"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load -w "$plist"
}

render_plist() {
  # render_plist <template> <dest> [额外的 s|@@KEY@@|value|g ...]
  local tpl="$1" dest="$2"; shift 2
  local expr=(-e "s|@@PY@@|$PY|g" -e "s|@@LIB@@|$LIB|g" -e "s|@@LOGDIR@@|$LOGDIR|g" -e "s|@@HOME@@|$HOME|g")
  local kv
  for kv in "$@"; do expr+=(-e "$kv"); done
  sed "${expr[@]}" "$tpl" > "$dest"
}

install_accounts_template() {
  "$PY" - "$LIB" <<'PYEOF'
import json, pathlib, sys
lib = pathlib.Path(sys.argv[1]); sys.path.insert(0, str(lib / "bin"))
import _codeg_quota_common as c
f = c.accounts_file()
if not f.exists():
    acc = c.load_accounts()
    f.parent.mkdir(parents=True, exist_ok=True)
    if acc:
        json.dump([{"name": n, "apiKey": k} for n, k in acc], open(f, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=2)
        print("    已导入 %d 个账号 Key -> %s" % (len(acc), f))
    else:
        json.dump([{"name": "主号", "apiKey": "sk-xxxx"}], open(f, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=2)
        print("    请编辑 %s 填入你的 sk-... Key" % f)
    f.chmod(0o600)
else:
    print("    账号配置已存在: %s" % f)
PYEOF
}

# ---------------------------------------------------------------- macOS
install_macos() {
  PY="$(detect_python)"
  LIB="$HOME/.local/share/codeg-opencode-quota"
  LOGDIR="$HOME/Library/Logs/codeg-opencode-quota"
  AGENTS="$HOME/Library/LaunchAgents"
  APP="${CODEG_APP:-/Applications/codeg.app}"
  echo "==> macOS 用户级安装（无需 sudo）: $LIB"
  mkdir -p "$LIB/bin" "$LOGDIR" "$AGENTS"

  echo "==> 安装脚本与前端母本"
  cp "$SRC/bin/"* "$LIB/bin/"
  chmod +x "$LIB/bin/codeg-opencode-quota-"*
  cp "$SRC/web/opencode-quota.js" "$LIB/opencode-quota.js"

  echo "==> 账号配置"
  install_accounts_template

  echo "==> 安装 launchd 服务（updater / api）"
  render_plist "$SRC/launchd/app.codeg.opencode-quota.updater.plist.in" \
               "$AGENTS/app.codeg.opencode-quota.updater.plist"
  render_plist "$SRC/launchd/app.codeg.opencode-quota.api.plist.in" \
               "$AGENTS/app.codeg.opencode-quota.api.plist"
  bootstrap_agent app.codeg.opencode-quota.updater "$AGENTS/app.codeg.opencode-quota.updater.plist"
  bootstrap_agent app.codeg.opencode-quota.api "$AGENTS/app.codeg.opencode-quota.api.plist"

  if [ "$WITH_BROWSER" = 1 ]; then
    echo "==> 浏览器模式：准备打补丁的 web 副本"
    WEBROOT="$LIB/web"
    STAGE_SRC="$("$PY" -c "import sys; sys.path.insert(0, '$LIB/bin'); import _codeg_quota_common as c; print(c.codeg_static_dir())")"
    if [ ! -d "$STAGE_SRC" ]; then
      echo "    找不到 codeg web 静态目录（$STAGE_SRC），跳过浏览器模式" >&2
    else
      mkdir -p "$WEBROOT"
      rsync -a --delete "$STAGE_SRC/" "$WEBROOT/"
      CODEG_QUOTA_WEB_ROOT="$WEBROOT" "$PY" "$LIB/bin/codeg-opencode-quota-patch"

      SERVER_BIN="${CODEG_SERVER_BIN:-$APP/Contents/MacOS/codeg-server}"
      TOKEN="$(uuidgen | tr 'A-Z' 'a-z')"
      render_plist "$SRC/launchd/app.codeg.opencode-quota.server.plist.in" \
                   "$AGENTS/app.codeg.opencode-quota.server.plist" \
                   "s|@@CODEG_SERVER@@|$SERVER_BIN|g" \
                   "s|@@WEBROOT@@|$WEBROOT|g" \
                   "s|@@TOKEN@@|$TOKEN|g"
      bootstrap_agent app.codeg.opencode-quota.server "$AGENTS/app.codeg.opencode-quota.server.plist"
      echo "    浏览器访问: http://127.0.0.1:3080/"
      echo "    登录 token: $TOKEN（首次访问登录页填入）"
    fi
  fi

  if [ "$WITH_TWEAK" = 1 ]; then
    echo "==> 桌面注入：编译 dylib"
    clang -fobjc-arc -dynamiclib -framework Foundation -framework WebKit \
      -install_name @rpath/libcodegquota.dylib \
      -o "$LIB/libcodegquota.dylib" "$SRC/tweak/codeg-quota-inject.m"
    cp "$SRC/tweak/quota-tweak.entitlements" "$LIB/"

    echo "==> 桌面注入：备份并注入 $APP（ad-hoc 重签）"
    "$PY" "$LIB/bin/codeg-opencode-quota-repair" --force --app "$APP"

    render_plist "$SRC/launchd/app.codeg.opencode-quota.repair.plist.in" \
                 "$AGENTS/app.codeg.opencode-quota.repair.plist" \
                 "s|@@APP@@|$APP|g"
    bootstrap_agent app.codeg.opencode-quota.repair "$AGENTS/app.codeg.opencode-quota.repair.plist"
    cat <<'EOT'

    注意（实验性）:
      - codeg 已被 ad-hoc 重签：macOS 可能重新弹窗询问文件夹/钥匙串权限，重新授权即可
      - 需要重启 codeg 才能看到药丸（当前窗口不会热加载）
      - codeg 自动更新后 repair agent 会自动重新注入
      - 出问题回滚: codeg-opencode-quota-repair --remove（或见 README）
EOT
  fi

  echo "==> 完成。日志目录: $LOGDIR"
}

# ---------------------------------------------------------------- Linux
install_linux() {
  [ "$(id -u)" -eq 0 ] || { echo "请用 root 运行"; exit 1; }
  PY="$(detect_python)"
  LIB="/usr/local/share/codeg-opencode-quota"
  LOGDIR="/var/log/codeg-opencode-quota"
  WEB_DIR="${CODEG_STATIC_DIR:-/usr/local/share/codeg/web}"

  echo "==> 安装前端与后端脚本"
  mkdir -p "$LIB" "$LOGDIR"
  cp "$SRC/web/opencode-quota.js" "$LIB/opencode-quota.js"
  cp "$SRC/web/opencode-quota.js" "$WEB_DIR/opencode-quota.js"
  cp "$SRC/bin/"* /usr/local/bin/
  chmod +x /usr/local/bin/codeg-opencode-quota-updater \
           /usr/local/bin/codeg-opencode-quota-api \
           /usr/local/bin/codeg-opencode-quota-patch

  echo "==> 安装 systemd 服务"
  cp "$SRC/systemd/codeg-opencode-quota.service" \
     "$SRC/systemd/codeg-opencode-quota-api.service" \
     /etc/systemd/system/
  mkdir -p /etc/systemd/system/codeg.service.d
  cp "$SRC/systemd/11-opencode-quota.conf" /etc/systemd/system/codeg.service.d/

  echo "==> 账号配置"
  install_accounts_template

  echo "==> 注入前端并启动服务"
  systemctl daemon-reload
  /usr/local/bin/codeg-opencode-quota-patch
  systemctl enable --now codeg-opencode-quota.service codeg-opencode-quota-api.service

  echo "==> 完成！浏览器 Ctrl+F5 硬刷新 codeg 页面即可看到额度药丸"
  echo "    数据接口: http://<host>:3080/opencode-quota.json"
}

case "$(uname -s)" in
  Darwin) install_macos ;;
  Linux) install_linux ;;
  *) echo "不支持的平台: $(uname -s)" >&2; exit 1 ;;
esac
