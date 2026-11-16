#!/usr/bin/env bash
# 冒烟测试：模拟 CodeBuddy hook 事件流，验证决策→工具失败→结算→飞轮全链路
set -e
cd "$(dirname "$0")/.."
export AGENTIC_ROUTER_HOME="$(mktemp -d /tmp/cb-router-test-XXXX)"
SID="test-session-1"

run() { echo "$1" | node scripts/router.mjs; }

echo "=== 1. SessionStart（应生成 catalog.json，无 stdout）==="
OUT=$(run "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$SID\",\"cwd\":\"$(pwd)\",\"source\":\"startup\"}")
if [ -z "$OUT" ]; then echo "stdout 为空 ✓"; else echo "⚠ stdout 非空: $OUT"; fi
if [ -f "$AGENTIC_ROUTER_HOME/catalog.json" ]; then echo "catalog.json 生成 ✓"; else echo "✗ catalog 缺失"; exit 1; fi

echo "=== 2. UserPromptSubmit（复杂代码任务 → 应注入推荐方案，且护栏生效不推荐全 lite）==="
OUT=$(run "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$SID\",\"cwd\":\"$(pwd)\",\"agent_type\":\"cli\",\"prompt\":\"重构下面这段 Python 代码，使其支持多线程并发执行并安全处理异常：\\n\\n\`\`\`python\\nimport time\\ndef fetch(url):\\n    time.sleep(1)\\n\`\`\`\"}")
echo "$OUT" | head -5
if echo "$OUT" | grep -q "agentic-router 推荐方案"; then echo "注入推荐 ✓"; else echo "✗ 未注入"; exit 1; fi
if echo "$OUT" | grep -q "router-lite"; then echo "CLI 文案含子代理分发 ✓"; else echo "✗ CLI 文案应含 router-lite"; exit 1; fi
if ! echo "$OUT" | grep -q "各步骤均分发 router-lite"; then echo "高复杂度护栏 ✓（未推荐全 lite）"; else echo "✗ 高复杂度任务不应全 lite"; exit 1; fi
if [ -f "$AGENTIC_ROUTER_HOME/decisions.jsonl" ]; then echo "decisions.jsonl 落盘 ✓"; else echo "✗ decisions 缺失"; exit 1; fi
OUT2=$(run "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"ide-s1\",\"cwd\":\"$(pwd)\",\"agent_type\":\"ide\",\"prompt\":\"帮我重构这段代码并优化性能，需要仔细分析调用链路\"}")
if echo "$OUT2" | grep -q "建议用户切换"; then echo "IDE 文案自适应 ✓"; else echo "✗ IDE 文案应为手动切模型建议"; exit 1; fi
run "{\"hook_event_name\":\"Stop\",\"session_id\":\"ide-s1\",\"stop_hook_active\":false}" > /dev/null

echo "=== 3. UserPromptSubmit（极简闲聊 → 只记录不注入）==="
OUT=$(run "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$SID\",\"cwd\":\"$(pwd)\",\"prompt\":\"你好\"}")
[ -z "$OUT" ] && echo "无注入 ✓" || echo "✗ 极简任务不应注入: $OUT"

echo "=== 4. PostToolUse（工具失败 ×2 → 计数）==="
run "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"$SID\",\"tool_name\":\"Bash\",\"tool_input\":{},\"tool_response\":{\"ok\":false,\"error\":\"command not found\"}}" > /dev/null
run "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"$SID\",\"tool_name\":\"Read\",\"tool_input\":{},\"tool_response\":{\"status\":\"error\"}}" > /dev/null
python3 -c "
import json,os
t=json.load(open(os.environ['AGENTIC_ROUTER_HOME']+'/turns/$SID.json'))
open_turn=t['open']
assert open_turn['toolErrors']==2, 'toolErrors 应为 2，实际 %s' % open_turn['toolErrors']
print('toolErrors=2 ✓（当前回合档位: %s，类型: %s）' % (open_turn['tier'], open_turn['clsType']))
"

echo "=== 5. Stop（结算 → rewards.jsonl；test3 的 prompt 已补结算 turn1）==="
run "{\"hook_event_name\":\"Stop\",\"session_id\":\"$SID\",\"stop_hook_active\":false}" > /dev/null
python3 -c "
import json,os
home=os.environ['AGENTIC_ROUTER_HOME']
rewards=[json.loads(l) for l in open(home+'/rewards.jsonl') if l.strip()]
# turn1（代码任务）被 test3 的 prompt 补结算 + turn2（你好，本回合 Stop）= 2 条
assert len(rewards)==2, '应有 2 条奖励（含 1 条补结算），实际 %d' % len(rewards)
r=rewards[-1]
# 干净收尾 1 分 − 工具失败 0.2×2 = 0.6
assert r['reward']==0.6, 'reward 应为 0.6，实际 %s' % r['reward']
assert r['breakdown']['toolErrors']==2
print('reward=0.6 ✓（本回合 toolErrors=2；另有补结算 1 条）')
"

echo "=== 6. 再来一轮回合（飞轮重放生效：ucb.total 递增）==="
run "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$SID\",\"cwd\":\"$(pwd)\",\"prompt\":\"帮我总结这个项目的架构，并列出三个可以优化的点\"}" > /dev/null
run "{\"hook_event_name\":\"Stop\",\"session_id\":\"$SID\",\"stop_hook_active\":false}" > /dev/null
python3 -c "
import json,os
home=os.environ['AGENTIC_ROUTER_HOME']
rewards=[json.loads(l) for l in open(home+'/rewards.jsonl') if l.strip()]
assert len(rewards)==3, '应有 3 条奖励，实际 %d' % len(rewards)
t=json.load(open(home+'/turns/$SID.json'))
assert t['open'] is None, '回合状态应已闭合'
print('三回合奖励落盘 ✓，turns 状态闭合 ✓')
"

echo "=== 7. SessionEnd（兜底结算未闭合回合）==="
run "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$SID\",\"cwd\":\"$(pwd)\",\"prompt\":\"帮我搭建一个博客系统并部署\"}" > /dev/null
run "{\"hook_event_name\":\"SessionEnd\",\"session_id\":\"$SID\",\"reason\":\"clear\"}" > /dev/null
python3 -c "
import json,os
home=os.environ['AGENTIC_ROUTER_HOME']
rewards=[json.loads(l) for l in open(home+'/rewards.jsonl') if l.strip()]
assert len(rewards)==4, 'SessionEnd 应兜底结算，实际 %d 条' % len(rewards)
print('SessionEnd 兜底结算 ✓（共 %d 条奖励）' % len(rewards))
"

echo "=== 8. 并发会话压力（多会话并行写，分文件后无丢更新；SessionEnd 清理文件）==="
for i in 1 2 3 4 5 6; do
  (run "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"par-$i\",\"cwd\":\"$(pwd)\",\"prompt\":\"并发测试任务 $i：帮我优化这段代码并验证\"}" > /dev/null) &
done
wait
python3 -c "
import json,os,glob
files=glob.glob(os.environ['AGENTIC_ROUTER_HOME']+'/turns/par-*.json')
assert len(files)==6, '6 个并发会话应各有一条回合记录（整表方案会丢），实际 %d' % len(files)
for f in files:
    t=json.load(open(f))
    assert t['seq']==1 and t['open'], f + ' 状态异常'
print('6 会话并行无丢失 ✓（按会话分文件生效）')
"
for i in 1 2 3 4 5 6; do
  run "{\"hook_event_name\":\"SessionEnd\",\"session_id\":\"par-$i\",\"reason\":\"clear\"}" > /dev/null
done
python3 -c "
import glob,os
files=glob.glob(os.environ['AGENTIC_ROUTER_HOME']+'/turns/par-*.json')
assert len(files)==0, 'SessionEnd 后会话文件应删除，剩余 %d' % len(files)
print('SessionEnd 清理会话文件 ✓')
"

echo ""
echo "✅ 全部冒烟测试通过。数据目录: $AGENTIC_ROUTER_HOME"
rm -rf "$AGENTIC_ROUTER_HOME"
