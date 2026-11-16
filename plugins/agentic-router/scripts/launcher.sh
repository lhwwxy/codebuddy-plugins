#!/bin/sh
# agentic-router 稳定启动器（供 settings.json 全局 hooks 使用——CodeBuddy IDE 聊天生效）
#
# 作用：settings 里的 hook 命令需要一个不随插件版本变化的稳定路径。
# 本脚本总是解析 marketplace 缓存中已安装的最新版本执行，插件升级后自动跟随，
# 无需修改 settings.json。数据目录（飞轮）与插件版共用，双通道同源。
#
# 用法（settings.json 的 hooks.<事件>[].hooks[].command）：
#   sh /Users/<you>/.codebuddy/plugins/data/agentic-router-<marketplace>/launcher.sh
# 可用环境变量覆盖默认值：
#   AGENTIC_ROUTER_MARKET  marketplace 名（默认 lhwwxy-plugins）
#   AGENTIC_ROUTER_DEV     开发目录兜底路径（未安装 marketplace 版时使用）

MARKET="${AGENTIC_ROUTER_MARKET:-lhwwxy-plugins}"
DATA="$HOME/.codebuddy/plugins/data/agentic-router-$MARKET"
CACHE="$HOME/.codebuddy/plugins/cache/$MARKET/agentic-router"

LATEST=$(ls -d "$CACHE"/*/ 2>/dev/null | sort -V | tail -1)
if [ -n "$LATEST" ]; then
  SCRIPT="${LATEST}scripts/router.mjs"
else
  SCRIPT="${AGENTIC_ROUTER_DEV:-$HOME/Desktop/工作/codebuddy/CodeBuddy-agentic-router}/scripts/router.mjs"
fi

exec env AGENTIC_ROUTER_HOME="${AGENTIC_ROUTER_HOME:-$DATA}" node "$SCRIPT"
