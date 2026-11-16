#!/usr/bin/env bash
# 同步插件仓库最新代码到本 marketplace（发布前执行）
# 用法：scripts/sync.sh [插件仓库路径]
set -e
SRC="${1:-$(dirname "$0")/../../CodeBuddy-agentic-router}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DST="$ROOT/plugins/agentic-router"

if [ ! -f "$SRC/.codebuddy-plugin/plugin.json" ]; then
  echo "✗ 源目录不是插件仓库：$SRC（未找到 .codebuddy-plugin/plugin.json）"
  exit 1
fi

VER=$(python3 -c "import json;print(json.load(open('$SRC/.codebuddy-plugin/plugin.json'))['version'])")
echo "同步 agentic-router v$VER → $DST"
mkdir -p "$DST"
rsync -a --delete \
  --exclude '.git' --exclude '.DS_Store' --exclude '*.tmp' --exclude 'node_modules' \
  "$SRC/" "$DST/"

# marketplace.json 里的版本号与插件保持一致
python3 - "$VER" <<'PY'
import json, sys
ver = sys.argv[1]
p = '.codebuddy-plugin/marketplace.json'
d = json.load(open(p))
for pl in d['plugins']:
    if pl['name'] == 'agentic-router':
        pl['version'] = ver
json.dump(d, open(p, 'w'), ensure_ascii=False, indent=2)
print('marketplace.json 版本已同步为', ver)
PY

echo ""
echo "后续步骤："
echo "  1) 确认改动: git -C \"$ROOT\" status"
echo "  2) 提交推送: git -C \"$ROOT\" add -A && git -C \"$ROOT\" commit -m \"agentic-router v$VER\" && git -C \"$ROOT\" push"
echo "  3) 插件仓库打 tag: git -C \"$SRC\" tag agentic-router--v$VER && git -C \"$SRC\" push --tags"
