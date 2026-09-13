#!/usr/bin/env bash
# codeg-opencode-quota-widget 安装（Linux + macOS）
set -euo pipefail

usage() {
  cat <<'EOF'
用法:
  Linux : sudo ./install.sh
  macOS : ./install.sh [--browser] [--desktop-tweak]
    --browser        额外安装"浏览器模式"：本机/局域网 :3080 提供打补丁的 codeg web UI（launchd 常驻）
    --desktop-tweak  额外给 codeg.app 桌面版注入额度药丸（dylib + ad-hoc 重签，见 README 风险说明）
EOF
}

SRC="$(cd "$(dirname "$0")" && pwd)"
WITH_BROWSER=0
WITH_TWEAK=0
for a in "$@"; do
  case "$a" in
    --browser) WITH_BROWSER=1 ;;
    --desktop-tweak) WITH_TWEAK=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $a（支持 --browser / --desktop-tweak）" >&2; exit 1 ;;
  esac
done

detect_python() {
  if [ -x /usr/bin/python3 ]; then echo /usr/bin/python3
  else command -v python3; fi
}

# sed 替换值转义：先做 XML 转义（plist 里 & < 非法），再做 sed 替换转义（& | \）
esc() {
  local v="$1"
  v="${v//&/&amp;}"
  v="${v//</&lt;}"
  v="${v//\\/\\\\}"
  v="${v//&/\\&}"
  v="${v//|/\\|}"
  printf '%s' "$v"
}

bootstrap_agent() {
  local label="$1" plist="$2"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load -w "$plist"
}

render_plist() {
  # render_plist <template> <dest> [额外的 s|@@KEY@@|value|g ...]
  local tpl="$1" dest="$2"; shift 2
  local expr=(-e "s|@@PY@@|$(esc "$PY")|g" -e "s|@@LIB@@|$(esc "$LIB")|g" \
              -e "s|@@LOGDIR@@|$(esc "$LOGDIR")|g" -e "s|@@HOME@@|$(esc "$HOME")|g")
  local kv
  for kv in "$@"; do expr+=(-e "$kv"); done
  sed "${expr[@]}" "$tpl" > "$dest"
}

install_accounts_template() {
  # $1 = 装着 _codeg_quota_common.py 的目录
  "$PY" - "$1" <<'PYEOF'
import json, pathlib, sys
sys.path.insert(0, sys.argv[1])
import _codeg_quota_common as c
f = c.accounts_file()
if not f.exists():
    acc = c.load_accounts()
    if acc:
        c.save_accounts(acc)
        print("    已导入 %d 个账号 Key -> %s" % (len(acc), f))
    else:
        c.save_accounts([("主号", "sk-xxxx")])
        print("    请编辑 %s 填入你的 sk-... Key" % f)
else:
    print("    账号配置已存在: %s" % f)
PYEOF
}

# ---------------------------------------------------------------- macOS
install_macos() {
  PY="$(detect_python)"
  [ -n "$PY" ] || { echo "找不到 python3（需要 Xcode CLT 或 Homebrew python）" >&2; exit 1; }
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
  install_accounts_template "$LIB/bin"

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
    STAGE_SRC="$APP/Contents/Resources/web"
    [ -d "$STAGE_SRC" ] || STAGE_SRC="$("$PY" -c "import sys; sys.path.insert(0, '$LIB/bin'); import _codeg_quota_common as c; print(c.codeg_static_dir())")"
    if [ ! -d "$STAGE_SRC" ]; then
      echo "    找不到 codeg web 静态目录（$STAGE_SRC），跳过浏览器模式" >&2
    else
      mkdir -p "$WEBROOT"
      rsync -a --delete "$STAGE_SRC/" "$WEBROOT/"
      CODEG_QUOTA_WEB_ROOT="$WEBROOT" "$PY" "$LIB/bin/codeg-opencode-quota-patch"
      "$PY" -c "import sys; sys.path.insert(0, '$LIB/bin'); import _codeg_quota_common as c, plistlib; print(plistlib.loads(open('$APP/Contents/Info.plist','rb').read()).get('CFBundleShortVersionString','?'))" > "$LIB/web.version" 2>/dev/null || true

      SERVER_PLIST="$AGENTS/app.codeg.opencode-quota.server.plist"
      TOKEN=""
      if [ -f "$SERVER_PLIST" ]; then
        TOKEN="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:CODEG_TOKEN' "$SERVER_PLIST" 2>/dev/null || true)"
      fi
      [ -n "$TOKEN" ] || TOKEN="$(uuidgen | tr 'A-Z' 'a-z')"
      SERVER_BIN="${CODEG_SERVER_BIN:-$APP/Contents/MacOS/codeg-server}"
      render_plist "$SRC/launchd/app.codeg.opencode-quota.server.plist.in" \
                   "$SERVER_PLIST" \
                   "s|@@CODEG_SERVER@@|$(esc "$SERVER_BIN")|g" \
                   "s|@@WEBROOT@@|$(esc "$WEBROOT")|g" \
                   "s|@@TOKEN@@|$TOKEN|g"
      chmod 600 "$SERVER_PLIST"
      bootstrap_agent app.codeg.opencode-quota.server "$SERVER_PLIST"
      # repair agent 同时负责 codeg 升级后刷新 web 副本（未装桌面注入时只做这件事）
      render_plist "$SRC/launchd/app.codeg.opencode-quota.repair.plist.in" \
                   "$AGENTS/app.codeg.opencode-quota.repair.plist" \
                   "s|@@APP@@|$(esc "$APP")|g"
      bootstrap_agent app.codeg.opencode-quota.repair "$AGENTS/app.codeg.opencode-quota.repair.plist"
      echo "    浏览器访问: http://127.0.0.1:3080/ （局域网内其他设备可用本机 IP 访问）"
      echo "    登录 token: $TOKEN（首次访问登录页填入）"
    fi
  fi

  if [ "$WITH_TWEAK" = 1 ]; then
    command -v clang >/dev/null || { echo "需要 clang（装 Xcode Command Line Tools: xcode-select --install）" >&2; exit 1; }
    command -v codesign >/dev/null || { echo "需要 codesign（macOS 自带，异常环境请检查 PATH）" >&2; exit 1; }
    echo "==> 桌面注入：编译 dylib"
    clang -fobjc-arc -dynamiclib -framework Foundation \
      -install_name @rpath/libcodegquota.dylib \
      -o "$LIB/libcodegquota.dylib" "$SRC/tweak/codeg-quota-inject.m"
    cp "$SRC/tweak/quota-tweak.entitlements" "$LIB/"
    printf '%s\n' "$APP" > "$LIB/app-path.txt"

    echo "==> 桌面注入：备份并注入 $APP（ad-hoc 重签）"
    "$PY" "$LIB/bin/codeg-opencode-quota-repair" --force --app "$APP"

    render_plist "$SRC/launchd/app.codeg.opencode-quota.repair.plist.in" \
                 "$AGENTS/app.codeg.opencode-quota.repair.plist" \
                 "s|@@APP@@|$(esc "$APP")|g"
    bootstrap_agent app.codeg.opencode-quota.repair "$AGENTS/app.codeg.opencode-quota.repair.plist"
    cat <<EOT

    注意（实验性）:
      - codeg 已被 ad-hoc 重签：macOS 可能重新弹窗询问文件夹/钥匙串权限，重新授权即可
      - 需要重启 codeg 才能看到药丸（当前窗口不会热加载）
      - codeg 自动更新后 repair agent 会自动重新注入
      - 出问题回滚: $LIB/bin/codeg-opencode-quota-repair --remove（或见 README）
EOT
  fi

  echo "==> 完成。日志目录: $LOGDIR"
}

# ---------------------------------------------------------------- Linux
install_linux() {
  [ "$(id -u)" -eq 0 ] || { echo "请用 root 运行"; exit 1; }
  if [ "$WITH_BROWSER" = 1 ] || [ "$WITH_TWEAK" = 1 ]; then
    echo "    注意: --browser / --desktop-tweak 仅 macOS 支持，Linux 下已忽略" >&2
  fi
  PY="$(detect_python)"
  [ -n "$PY" ] || { echo "找不到 python3" >&2; exit 1; }
  LIB="/usr/local/share/codeg-opencode-quota"
  LOGDIR="/var/log/codeg-opencode-quota"
  WEB_DIR="${CODEG_STATIC_DIR:-/usr/local/share/codeg/web}"
  # 服务以 root 运行（HOME=/root）；显式固定账号路径，避免 sudo -E 时 HOME 指向用户家目录
  export OPENCODE_QUOTA_ACCOUNTS="${OPENCODE_QUOTA_ACCOUNTS:-/root/.config/opencode/quota-accounts.json}"

  echo "==> 安装前端与后端脚本"
  mkdir -p "$LIB" "$LOGDIR"
  cp "$SRC/web/opencode-quota.js" "$LIB/opencode-quota.js"
  cp "$SRC/web/opencode-quota.js" "$WEB_DIR/opencode-quota.js"
  cp "$SRC/bin/"* /usr/local/bin/
  rm -f /usr/local/bin/codeg-opencode-quota-repair   # macOS 专用
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
  install_accounts_template /usr/local/bin

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
