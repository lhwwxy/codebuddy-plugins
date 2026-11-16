#!/usr/bin/env bash
# 并发压测：多个 hook 进程同时写 catalog.json / turns.json，
# 验证 tmp 唯一后缀修复后不再出现 rename ENOENT（修复前必现于 router.log）
set -e
cd "$(dirname "$0")/.."
export AGENTIC_ROUTER_HOME="$(mktemp -d /tmp/cb-race-XXXX)"
SID="race-test"

echo '{"hook_event_name":"SessionStart","session_id":"'$SID'","cwd":"'"$PWD"'","source":"startup"}' | node scripts/router.mjs

echo "--- 并发 10 个 UserPromptSubmit ---"
for i in 1 2 3 4 5 6 7 8 9 10; do
  echo '{"hook_event_name":"UserPromptSubmit","session_id":"'$SID'","cwd":"'"$PWD"'","prompt":"帮我重构这段代码并优化性能测试场景'$i'"}' | node scripts/router.mjs > /dev/null &
done
wait
echo "--- 并发 10 个 Stop ---"
for i in 1 2 3 4 5 6 7 8 9 10; do
  echo '{"hook_event_name":"Stop","session_id":"'$SID'","stop_hook_active":false}' | node scripts/router.mjs > /dev/null &
done
wait

ERRS=$(grep -c "hook failed" "$AGENTIC_ROUTER_HOME/router.log" || true)
TMPS=$(ls "$AGENTIC_ROUTER_HOME" | grep -c "\.tmp$" || true)
echo "hook 失败数: $ERRS（期望 0）"
echo "残留 tmp 文件: $TMPS（期望 0）"
ls "$AGENTIC_ROUTER_HOME"
if [ "$ERRS" = "0" ] && [ "$TMPS" = "0" ]; then
  echo "✅ 并发压测通过：无 rename 竞态错误，无残留 tmp 文件"
  rm -rf "$AGENTIC_ROUTER_HOME"
else
  echo "✗ 存在问题，数据目录保留: $AGENTIC_ROUTER_HOME"
  exit 1
fi
