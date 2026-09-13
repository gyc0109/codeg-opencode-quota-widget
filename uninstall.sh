#!/usr/bin/env bash
# codeg-opencode-quota-widget 卸载（Linux + macOS）
# macOS 会同时移除 dylib 注入（有同版本官方备份则整体还原 codeg.app；
# 未注入过则完全不动 codeg.app）。
set -euo pipefail

detect_python() {
  if [ -x /usr/bin/python3 ]; then echo /usr/bin/python3
  else command -v python3; fi
}

uninstall_macos() {
  PY="$(detect_python)"
  LIB="${CODEG_QUOTA_LIB_DIR:-$HOME/.local/share/codeg-opencode-quota}"
  AGENTS="$HOME/Library/LaunchAgents"

  echo "==> 停止并移除 launchd 服务"
  for label in updater api server repair; do
    launchctl bootout "gui/$(id -u)/app.codeg.opencode-quota.$label" 2>/dev/null || true
    rm -f "$AGENTS/app.codeg.opencode-quota.$label.plist"
  done

  KEEP_LIB=0
  if [ -x "$LIB/bin/codeg-opencode-quota-repair" ]; then
    echo "==> 移除桌面注入（未注入过则跳过）"
    if ! "$PY" "$LIB/bin/codeg-opencode-quota-repair" --remove; then
      echo "    注入移除失败：保留 $LIB 以便重试（可手动执行 repair --remove）" >&2
      KEEP_LIB=1
    fi
  fi

  echo "==> 清理文件"
  if [ "$KEEP_LIB" = 1 ]; then
    echo "    （保留 $LIB）"
  else
    rm -rf "$LIB"
  fi
  rm -rf "$HOME/Library/Logs/codeg-opencode-quota"
  echo "==> 卸载完成（账号配置文件 ~/.config/opencode/quota-accounts.json 已保留）"
  echo "    若 codeg.app 曾被注入且无官方备份，重装官方包可完全恢复签名"
}

uninstall_linux() {
  [ "$(id -u)" -eq 0 ] || { echo "请用 root 运行"; exit 1; }
  WEB_DIR="${CODEG_STATIC_DIR:-/usr/local/share/codeg/web}"

  echo "==> 停止并移除服务"
  systemctl disable --now codeg-opencode-quota.service codeg-opencode-quota-api.service 2>/dev/null || true
  rm -f /etc/systemd/system/codeg-opencode-quota.service \
        /etc/systemd/system/codeg-opencode-quota-api.service \
        /etc/systemd/system/codeg.service.d/11-opencode-quota.conf

  echo "==> 移除脚本与前端"
  rm -f /usr/local/bin/codeg-opencode-quota-updater \
        /usr/local/bin/codeg-opencode-quota-api \
        /usr/local/bin/codeg-opencode-quota-patch \
        /usr/local/bin/codeg-opencode-quota-repair \
        /usr/local/bin/_codeg_quota_common.py \
        "$WEB_DIR/opencode-quota.js" \
        "$WEB_DIR/opencode-quota.json" \
        "$WEB_DIR/opencode-quota-history.jsonl"
  rm -rf /usr/local/share/codeg-opencode-quota
  rm -rf /var/log/codeg-opencode-quota

  echo "==> 清理 html 注入标签（递归）"
  find "$WEB_DIR" -name "*.html" -exec \
    sed -i 's|<script src="/opencode-quota.js"></script>||g' {} +

  systemctl daemon-reload
  echo "==> 卸载完成（账号配置文件 /root/.config/opencode/quota-accounts.json 已保留）"
}

case "$(uname -s)" in
  Darwin) uninstall_macos ;;
  Linux) uninstall_linux ;;
  *) echo "不支持的平台: $(uname -s)" >&2; exit 1 ;;
esac
