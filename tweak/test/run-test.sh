#!/usr/bin/env bash
# 端到端验证 dylib 注入：起一个测试用 api（:3081，假数据），用测试宿主模拟 codeg 桌面壳加载页面，
# 截图确认额度药丸渲染。产物：/tmp/codeg-quota-test.png
# 断言：宿主运行期间 :3081 必须收到 /quota.json 请求（否则药丸没挂上/取数失败，测试失败退出）。
set -euo pipefail
cd "$(dirname "$0")"

LIB="${CODEG_QUOTA_LIB_DIR:-$HOME/.local/share/codeg-opencode-quota}"
TEST_DATA=/tmp/quota-test-data
PY="${PY:-/usr/bin/python3}"

echo "==> 准备测试数据"
mkdir -p "$TEST_DATA"
cat > "$TEST_DATA/opencode-quota.json" <<'EOF'
{"accounts":[{"name":"主号","usage":{"rolling":{"percent":6,"resetsAt":"2026-09-13T18:00:00Z"},"weekly":{"percent":44,"resetsAt":"2026-09-15T00:00:00Z"},"monthly":{"percent":22,"resetsAt":"2026-10-01T00:00:00Z"}}}],"_fetchedAt":"2026-09-13T15:00:00Z"}
EOF
printf '{"t":1757772000,"a":[{"n":"主号","r":6,"w":44,"m":22}]}\n' > "$TEST_DATA/opencode-quota-history.jsonl"

API_LOG=/tmp/quota-test-api.log
if nc -z 127.0.0.1 3081 2>/dev/null; then
  echo "==> :3081 已有 api 在跑（用真实数据），直接复用"
  API_LOG="$HOME/Library/Logs/codeg-opencode-quota/api.log"
else
  echo "==> 启动测试 api :3081"
  CODEG_QUOTA_DATA_DIR="$TEST_DATA" OPENCODE_QUOTA_API_HOST=127.0.0.1 \
    "$PY" "$LIB/bin/codeg-opencode-quota-api" > "$API_LOG" 2>&1 &
  API_PID=$!
  trap 'kill $API_PID 2>/dev/null || true' EXIT
  sleep 1
fi
rm -f /tmp/codeg-quota-test.png
BEFORE=$(wc -l < "$API_LOG" 2>/dev/null || echo 0)

echo "==> 编译测试宿主"
clang -fobjc-arc -framework Cocoa -framework WebKit -o /tmp/codeg-quota-test-host test-host.m

echo "==> 运行（注入 dylib，5 秒后截图）"
CODEG_QUOTA_FORCE=1 \
CODEG_QUOTA_JS_FILE="$LIB/opencode-quota.js" \
DYLD_INSERT_LIBRARIES="$LIB/libcodegquota.dylib" \
  /tmp/codeg-quota-test-host

echo "==> 断言"
[ -s /tmp/codeg-quota-test.png ] || { echo "FAIL: 截图缺失"; exit 1; }
AFTER=$(wc -l < "$API_LOG")
if tail -n $((AFTER - BEFORE)) "$API_LOG" | grep -q "GET /quota.json"; then
  echo "PASS: 药丸已取数（:3081 收到 /quota.json）→ /tmp/codeg-quota-test.png"
else
  echo "FAIL: 宿主运行期间没有 /quota.json 请求，药丸未挂载" >&2
  exit 1
fi
