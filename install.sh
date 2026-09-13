#!/usr/bin/env bash
# codeg-opencode-quota-widget 一键安装
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "请用 root 运行"; exit 1; }

SRC="$(cd "$(dirname "$0")" && pwd)"
WEB_DIR="${CODEG_STATIC_DIR:-/usr/local/share/codeg/web}"
MASTER_DIR="/usr/local/share/codeg-opencode-quota"
ACCOUNTS_FILE="/root/.config/opencode/quota-accounts.json"
FALLBACK_CONFIG="/root/.config/opencode/opencode.jsonc"

echo "==> 安装前端与后端脚本"
mkdir -p "$MASTER_DIR"
cp "$SRC/web/opencode-quota.js" "$MASTER_DIR/opencode-quota.js"
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

if [ ! -f "$ACCOUNTS_FILE" ]; then
  echo "==> 生成账号配置文件模板"
  KEY="$(grep -oP '"apiKey"\s*:\s*"\K[^"]+' "$FALLBACK_CONFIG" 2>/dev/null | head -1 || true)"
  if [ -n "${KEY:-}" ]; then
    python3 -c "
import json
json.dump([{'name':'主号','apiKey':'''+\"$KEY\"+'''}], open('$ACCOUNTS_FILE','w'), ensure_ascii=False, indent=2)
"
    echo "已从 opencode.jsonc 导入主号 Key"
  else
    printf '[\n  {\n    "name": "主号",\n    "apiKey": "sk-xxxx"\n  }\n]\n' > "$ACCOUNTS_FILE"
    echo "请编辑 $ACCOUNTS_FILE 填入你的 sk-... Key"
  fi
  chmod 600 "$ACCOUNTS_FILE"
fi

echo "==> 注入前端并启动服务"
systemctl daemon-reload
/usr/local/bin/codeg-opencode-quota-patch
systemctl enable --now codeg-opencode-quota.service codeg-opencode-quota-api.service

echo "==> 完成！浏览器 Ctrl+F5 硬刷新 codeg 页面即可看到额度药丸"
echo "    数据接口: http://<host>:3080/opencode-quota.json"
