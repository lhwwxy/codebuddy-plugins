# codebuddy-plugins

> [lhwwxy](https://github.com/lhwwxy) 的个人 CodeBuddy 插件市场（marketplace）。

## 安装插件

```sh
codebuddy plugin marketplace add lhwwxy/codebuddy-plugins
codebuddy plugin install agentic-router@lhwwxy-plugins
```

## 收录的插件

| 插件 | 版本 | 说明 |
|---|---|---|
| [agentic-router](https://github.com/lhwwxy/CodeBuddy-agentic-router) | 0.1.0 | 学习型智能路由：评估任务类型与复杂度 → 四专家（rule/UCB/LinUCB/k-NN）+ EXP3 推荐档位 → 分发 lite/reasoning 子代理执行 → 结果回流数据飞轮，越用越准 |

## 结构

```
codebuddy-plugins/
├── .codebuddy-plugin/
│   └── marketplace.json    # 市场清单（插件版本随源仓库同步）
├── plugins/
│   └── agentic-router/     # 插件副本（来源：CodeBuddy-agentic-router 仓库）
└── scripts/
    └── sync.sh             # 从插件仓库一键同步副本 + 版本号
```

## 发布流程（维护者）

1. 在插件仓库 `CodeBuddy-agentic-router` 开发并升版本（`plugin.json` 的 `version` 必须递增，CodeBuddy 按版本号区分缓存）
2. 本仓库执行 `scripts/sync.sh`（同步副本 + marketplace.json 版本号）
3. 提交推送两个仓库，插件仓库打 tag：`agentic-router--v<版本>`
4. 用户侧 `codebuddy plugin update agentic-router` 即可升级
