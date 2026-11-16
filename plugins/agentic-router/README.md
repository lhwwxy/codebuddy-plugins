# CodeBuddy-agentic-router

> CodeBuddy（Craft/Code）插件：**学习型智能路由**。评估任务类型与复杂度 → 推荐档位与执行方案 → 分发 lite/reasoning 子代理执行 → 结果回流数据飞轮，随使用越学越准。
>
> 核心算法（分类器 + UCB/LinUCB/k-NN 四专家 + EXP3 元选择器 + 奖励飞轮）与
> [dsh-agentic-router](https://github.com/lhwwxy/dsh-agentic-router)（DeepSeek Harness 版）同源，MIT。

## 工作原理

```
用户提交任务
  ↓ UserPromptSubmit hook（<1ms）
  分类（code/write/summarize/research/agentic/qa + 复杂度 0~1）
  → 四专家并行推荐 → EXP3 元选择器决策 → 建议档位（fast/mid/strong）
  ↓ 注入推荐方案到上下文（极简闲聊不注入）
主 agent 一句话告知用户方案 → 用户确认/调整（human-in-the-loop）
  ↓ 按步骤分发子代理（task 工具，真实按档位执行）
  · router-lite    → lite 模型（检索/阅读/总结）
  · router-strong  → reasoning 模型（编码/重构/验证）
  ↓ PostToolUse hook：工具失败计数
  ↓ Stop hook：回合结算（干净收尾 1 分起，工具失败 −0.2/次，延迟分档扣分）
  → 飞轮更新（UCB/LinUCB/k-NN/EXP3）→ rewards.jsonl 落盘 → 下次推荐更准
```

- **模型目录**：每 24h 自动刷新一次（解析 `~/.codebuddy/settings.json` 与项目 `.codebuddy/settings*.json` 中的模型引用），缓存于插件数据目录
- **数据飞轮**：决策 `decisions.jsonl`、奖励 `rewards.jsonl`、回合状态 `turns.json`、目录 `catalog.json`，全部本地明文，可审计；会话启动时自动压实（各保留最近 1000 行）
- **fail-open**：hook 任何异常只写 `router.log`，绝不阻塞你的对话

## 安装

### 本地测试（不进缓存）

```sh
codebuddy --plugin-dir /path/to/CodeBuddy-agentic-router
```

### 经 marketplace 安装

```sh
codebuddy plugin marketplace add lhwwxy/codebuddy-plugins
codebuddy plugin install agentic-router@lhwwxy-plugins
```

安装后用 `/plugin` 可查看与启停；升级用 `codebuddy plugin update agentic-router`（插件更新按 plugin.json 的 version 区分缓存）。

## 上架到插件市场

> 实际 marketplace 仓库：**[lhwwxy/codebuddy-plugins](https://github.com/lhwwxy/codebuddy-plugins)**
> （含 `scripts/sync.sh`，插件发布后一键同步副本过去）

1. 本仓库（插件本体）推到 GitHub：`lhwwxy/CodeBuddy-agentic-router`
2. marketplace 仓库结构：

   ```
   codebuddy-plugins/
   ├── .codebuddy-plugin/
   │   └── marketplace.json
   └── plugins/
       └── agentic-router/      # 插件本体（整目录复制或符号链接）
   ```

   `marketplace.json` 示例：

   ```json
   {
     "name": "lhwwxy-plugins",
     "description": "个人 CodeBuddy 插件市场",
     "owner": { "name": "lhwwxy" },
     "plugins": [
       {
         "name": "agentic-router",
         "source": "./plugins/agentic-router",
         "description": "学习型智能路由：评估任务 → 档位推荐 → 子代理执行 → 飞轮学习"
       }
     ]
   }
   ```

3. 发布版本打 tag：`agentic-router--v0.1.0`（缓存按版本号区分，**每次改动必须升版本**，否则用户看不到更新）
4. 用户即可两行命令安装（见上）

提交官方市场 `codebuddy-plugins-official` 收录可再提 PR 扩大曝光。

## 目录结构

```
CodeBuddy-agentic-router/
├── .codebuddy-plugin/
│   └── plugin.json        # 插件清单
├── hooks/
│   └── hooks.json         # 五个事件挂载（UserPromptSubmit/PostToolUse/Stop/SessionStart/SessionEnd）
├── scripts/
│   ├── router.mjs         # hook 入口：事件分发 + 决策 + 结算 + 目录探测
│   ├── classify.js        # 任务分类 + 复杂度（vendor 自 dsh-agentic-router）
│   ├── strategies.js      # 四专家 + 奖励 + 飞轮更新（vendor）
│   ├── meta.js            # EXP3 元选择器，γ=0.05 混合探索（vendor）
│   └── store.js           # JSONL 持久化（vendor，数据目录适配 CODEBUDDY_PLUGIN_DATA）
└── agents/
    ├── router-lite.md     # 轻量档子代理（model: lite）
    └── router-strong.md   # 强力档子代理（model: reasoning）
```

## 数据位置

`${CODEBUDDY_PLUGIN_DATA}`（默认 `~/.codebuddy/plugins/data/agentic-router/`）：

> 注意：`--plugin-dir` 本地测试时目录名会带 `-inline` 后缀，即 `~/.codebuddy/plugins/data/agentic-router-inline/`；经 marketplace 安装后则是 `agentic-router/`。排查数据时请先 `ls ~/.codebuddy/plugins/data/` 确认实际目录名。

| 文件 | 内容 |
|---|---|
| `decisions.jsonl` | 每次任务的类型/复杂度/四专家推荐/元选择/最终档位 |
| `rewards.jsonl` | 每回合奖励明细（重放即恢复学习状态） |
| `turns/<会话id>.json` | 进行中回合状态（按会话分文件防并发丢更新；会话结束自动删除，7 天残留兜底清理） |
| `catalog.json` | 模型目录缓存（24h TTL） |
| `router.log` | 运行日志（>1MB 自动清空） |

## 设计边界

- 主对话模型不切换：路由发生在子代理分发层（task 工具按调用指定模型），主 agent 保持当前模型
- 奖励信号目前覆盖工具失败与延迟；token 成本与人类 👍/👎 反馈待 CodeBuddy 提供对应 hook/接口后接入
- 模型目录来自配置文件解析（无运行时 API），探测到的是"配置了什么"
- hook 为独立进程，回合状态经 `turns.json` 跨进程传递（按 session_id 隔离）

## License

MIT
