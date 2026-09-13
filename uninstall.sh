#!/usr/bin/env bash
# codeg-opencode-quota-widget 卸载
set -euo pipefail
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
      "$WEB_DIR/opencode-quota.js" \
      "$WEB_DIR/opencode-quota.json"
rm -rf /usr/local/share/codeg-opencode-quota

echo "==> 清理 html 注入标签"
for f in "$WEB_DIR"/*.html; do
  [ -f "$f" ] || continue
  sed -i 's|<script src="/opencode-quota.js"></script>||g' "$f"
done

systemctl daemon-reload
echo "==> 卸载完成（账号配置文件 /root/.config/opencode/quota-accounts.json 已保留）"
