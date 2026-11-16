#!/usr/bin/env node
// CodeBuddy-agentic-router —— hook 入口脚本
//
// 事件分发（stdin JSON → 按 hook_event_name 处理，fail-open：任何异常不阻塞用户）：
//   UserPromptSubmit  分类+复杂度评估 → 四专家+EXP3 决策 → stdout 注入"分解+档位推荐"上下文
//   PostToolUse      工具失败计数（奖励负信号）
//   Stop             回合结算：奖励计算 → 飞轮更新（UCB/LinUCB/k-NN/EXP3）→ rewards.jsonl
//   SessionStart     模型目录 24h 惰性刷新（解析 CodeBuddy 配置文件）+ JSONL 压实
//   SessionEnd       兜底结算未闭合的回合
//
// 数据目录：${CODEBUDDY_PLUGIN_DATA}（插件更新保留）；决策/奖励全部本地 JSONL 落盘，可审计。
// 核心算法 vendor 自 dsh-agentic-router（classify/strategies/meta/store，MIT）。

import { readFileSync, writeFileSync, appendFileSync, renameSync, statSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { classify, featuresOf } from './classify.js'
import {
  recommendRule, recommendUcb, recommendLin, recommendKnn,
  rewardOf, applyReward, tierOf,
} from './strategies.js'
import { metaPick, DEFAULT_WEIGHTS } from './meta.js'
import { Store } from './store.js'

const CATALOG_TTL_MS = 24 * 3600 * 1000 // 模型目录：每天首次使用时自动刷新
const MAX_REWARD_LINES = 1000          // 奖励/决策 JSONL 压实上限（会话启动时执行）
const LIN_GRADUATION = 50
const KNN_GRADUATION = 30

// ---- 基础设施 ----

// 数据目录优先级（与 store.js defaultHome 一致）：AGENTIC_ROUTER_HOME（本地测试）
// > CODEBUDDY_PLUGIN_DATA（插件运行时）> ~/.codebuddy/plugins/data/agentic-router
const store = new Store()

function log(msg) {
  try { appendFileSync(join(store.home, 'router.log'), new Date().toISOString() + ' ' + msg + '\n') } catch { /* 日志尽力而为 */ }
}

function readStdinJson() {
  try {
    const raw = readFileSync(0, 'utf8')
    return raw.trim() ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

function atomicWriteJson(p, obj) {
  // 并发 hook 进程会同时写同一目标文件，tmp 名必须唯一（否则 rename 时他人已把 tmp 挪走 → ENOENT）
  const tmp = p + '.' + process.pid + '-' + Date.now() + '.tmp'
  writeFileSync(tmp, JSON.stringify(obj, null, 2))
  renameSync(tmp, p)
}

// ---- 飞轮状态（跨进程：每次事件重放 rewards.jsonl，行数有压实上限所以很快）----

function freshFlywheel() {
  return {
    ucb: { total: 0, arms: {} },
    lin: {
      total: 0,
      tierN: { fast: 0, mid: 0, strong: 0 },
      tierW: { fast: new Array(9).fill(0), mid: new Array(9).fill(0), strong: new Array(9).fill(0) },
    },
    knn: { pool: [] },
    exp3: { total: 0, weights: { ...DEFAULT_WEIGHTS } },
  }
}

function loadFlywheel() {
  const st = freshFlywheel()
  for (const rec of store.loadJsonl('rewards.jsonl')) {
    if (rec && typeof rec.reward === 'number' && Array.isArray(rec.f)) {
      try { applyReward(st, rec) } catch { /* 跳过坏记录 */ }
    }
  }
  return st
}

// ---- 回合状态（跨进程持久：turns/<会话>.json，按会话分文件）----
// 分文件原因：并发会话若共用一张整表，多个 hook 进程对同一文件做读-改-写会
// 互相覆盖（后写者赢，丢其它会话的更新）；按会话拆分后，不同会话写不同文件，
// 同一会话内事件由 agent 循环顺序触发，天然无竞争。

function safeSid(sid) { return String(sid).replace(/[^A-Za-z0-9_.-]/g, '_') }
function turnsDir() { return join(store.home, 'turns') }
function turnsPath(sid) { return join(turnsDir(), safeSid(sid) + '.json') }
function loadTurns(sid) {
  mkdirSync(turnsDir(), { recursive: true })
  return readJsonSafe(turnsPath(sid)) || { seq: 0, open: null }
}
function saveTurns(sid, t) {
  mkdirSync(turnsDir(), { recursive: true })
  atomicWriteJson(turnsPath(sid), t)
}

// ---- 模型目录（探测源：CodeBuddy 配置文件；别名恒可用）----

function catalogPath() { return join(store.home, 'catalog.json') }

// task 工具的模型别名对任何安装恒可用：lite=快档 / default=中档 / reasoning=强档
const ALIASES = { fast: 'lite', mid: 'default', strong: 'reasoning' }

function probeCatalog(cwd) {
  const base = cwd || process.cwd()
  const sources = [
    join(homedir(), '.codebuddy', 'settings.json'),
    join(base, '.codebuddy', 'settings.json'),
    join(base, '.codebuddy', 'settings.local.json'),
  ]
  const ids = new Set()
  for (const p of sources) {
    const s = readJsonSafe(p)
    if (!s || typeof s !== 'object') continue
    if (typeof s.model === 'string' && s.model) ids.add(s.model)
    if (s.variantModels && typeof s.variantModels === 'object') {
      for (const v of Object.values(s.variantModels)) if (typeof v === 'string' && v) ids.add(v)
    }
    const subs = s.subagents && s.subagents.agents
    if (subs && typeof subs === 'object') {
      for (const a of Object.values(subs)) {
        const m = a && a.model
        if (typeof m === 'string' && m && m !== 'inherit') ids.add(m)
      }
    }
  }
  const tiers = { fast: [], mid: [], strong: [] }
  for (const id of ids) { const t = tierOf(id); if (tiers[t]) tiers[t].push(id) }
  return { ts: Date.now(), models: [...ids].sort(), tiers, aliases: ALIASES, source: 'codebuddy-settings' }
}

function catalog(cwd) {
  const c = readJsonSafe(catalogPath())
  if (c && typeof c.ts === 'number' && Date.now() - c.ts < CATALOG_TTL_MS) return c
  const fresh = probeCatalog(cwd)
  saveCatalog(fresh)
  log('catalog probed: ' + fresh.models.length + ' models')
  return fresh
}

function saveCatalog(c) { atomicWriteJson(catalogPath(), c) }

// ---- 事件处理 ----

// UserPromptSubmit：决策 + 注入推荐方案（exit 0 的 stdout 会自动进入模型上下文）
function onUserPromptSubmit(input) {
  const sid = input.session_id
  const text = typeof input.prompt === 'string' ? input.prompt : ''
  if (!sid || !text) return
  catalog(input.cwd)

  const cls = classify(text)
  const f = featuresOf(cls, text)
  const st = loadFlywheel()
  const exp3 = {
    ...st.exp3,
    linGraduated: st.lin.total >= LIN_GRADUATION,
    knnGraduated: st.knn.pool.length >= KNN_GRADUATION,
  }
  const recs = {
    rule: recommendRule(cls),
    ucb: recommendUcb(cls, st.ucb),
    lin: recommendLin(cls, f, st.lin),
    knn: recommendKnn(cls, f, st.knn),
  }
  const meta = metaPick(recs, exp3)
  const chosenRec = meta.byName[meta.chosen] || recs.rule
  const banditTier = chosenRec.tier || 'mid'
  // 护栏：bandit 冷启动探索可能对高复杂度任务推荐 fast（误导执行）。
  // 学习照常记录 banditTier，但注入给用户的建议档位设下限——高复杂度任务至少混合档。
  const tier = (cls.complexity >= 0.7 && banditTier === 'fast') ? 'mid' : banditTier

  // 记录 open turn（供 PostToolUse/Stop 归属）
  const s = loadTurns(sid)
  // 去重：同一 prompt 极短时间内的重复触发（插件 hooks 与 settings hooks 双注册、
  // 或 hook 重复配置）只处理一次——防止 seq 跳号与重复决策
  if (s.open && Date.now() - s.open.t0 < 1500 && s.open.promptPreview === text.slice(0, 100)) return
  // 补结算：上回合 Stop 丢失（agent 异常等）时不丢奖励——新回合开始意味着上回合已结束
  if (s.open) {
    const missed = s.open
    s.open = null
    settleTurn(sid, missed, 'clean-close')
  }
  s.seq += 1
  s.open = {
    turn: s.seq, t0: Date.now(), clsType: cls.type, complexity: cls.complexity,
    f, chosen: meta.chosen, tier, toolErrors: 0, promptPreview: text.slice(0, 100),
    ucbTier: recs.ucb.tier, linTier: recs.lin.tier, pool: meta.pool, pChosen: meta.ps[meta.chosen] || 0,
  }
  saveTurns(sid, s)

  store.appendJsonl('decisions.jsonl', {
    ts: Date.now(), sessionId: sid, turn: s.seq, taskType: cls.type,
    complexity: cls.complexity, tier, banditTier, metaChosen: meta.chosen,
    agent: input.agent_type || (process.env.CODEBUDDY_PLUGIN_ROOT ? 'cli' : 'settings-hook'),
    recs: {
      rule: recs.rule.tier, ucb: recs.ucb.tier, lin: recs.lin.tier, knn: String(recs.knn.tier),
    },
    promptPreview: text.slice(0, 100),
  })

  // 极简闲聊不打扰：只记录不注入（降低上下文噪音）
  const trivial = cls.complexity < 0.2 && cls.type !== 'code' && cls.type !== 'agentic'
  if (trivial) return
  process.stdout.write(buildAdvice(cls, tier, input.agent_type))
}

// 推荐方案文本（模型可见）。按运行环境适配：
//   CLI（插件 hooks，agent_type=cli 或设置了 CODEBUDDY_PLUGIN_ROOT）→ 有 router-lite/strong 子代理可分发
//   IDE 聊天（settings 全局 hooks）→ 无插件子代理，转为档位建议由用户手动切模型
function buildAdvice(cls, tier, agentType) {
  const isCli = agentType ? agentType === 'cli' : Boolean(process.env.CODEBUDDY_PLUGIN_ROOT)
  const plan = isCli
    ? (tier === 'fast'
        ? '各步骤均分发 router-lite 子代理（lite 模型，低成本低延迟）'
        : tier === 'strong'
          ? '重型步骤（编写/修改代码、运行与验证）分发 router-strong 子代理（reasoning 模型）；轻量步骤（检索/阅读/总结）分发 router-lite'
          : '重型步骤分发 router-strong，其余分发 router-lite；若执行中发现任务整体简单，可全部降为 router-lite')
    : (tier === 'fast'
        ? '适合轻量档：建议用户切换到 lite 模型（IDE 模型选择器），或直接以轻量方式完成'
        : tier === 'strong'
          ? '适合强力档：建议用户切换到 reasoning 模型后继续；若当前已是强模型则直接执行'
          : '适合混合档：重型步骤建议 reasoning、其余 lite，由用户按需切换模型')
  const action = isCli
    ? '请用一句话把该方案告知用户；用户认可（或未明确反对）后，用 task 工具把对应步骤分发到上述子代理执行。'
    : '请用一句话把该建议告知用户；用户认可后以对应档位完成（模型切换由用户操作，未切换时直接高效执行）。'
  return [
    '<agentic-router 推荐方案（路由插件自动评估，非用户输入）>',
    '任务评估: 类型=' + cls.type + '，复杂度=' + cls.complexity + ' → 建议档位: ' + tier,
    '执行建议: ' + plan,
    action + '用户另行指定模型/方式时，以用户为准。',
    '</agentic-router>',
  ].join('\n') + '\n'
}

// PostToolUse：工具失败计数（保守判定，只认明确错误结构）
function onPostToolUse(input) {
  if (!isToolError(input.tool_response)) return
  const s = loadTurns(input.session_id)
  if (s.open) {
    // 去重：双注册下同一工具失败会被重复触发，300ms 内只记一次
    const now = Date.now()
    if (s.open.lastErrAt && now - s.open.lastErrAt < 300) return
    s.open.lastErrAt = now
    s.open.toolErrors = (s.open.toolErrors || 0) + 1
    saveTurns(input.session_id, s)
    log('tool error: ' + input.tool_name + ' on ' + input.session_id + ' #' + s.open.toolErrors)
  }
}

function isToolError(r) {
  if (r == null || typeof r !== 'object') return false
  if (r.ok === false || r.success === false || r.isError === true) return true
  if (r.status === 'error' || r.status === 'failed') return true
  if (typeof r.error === 'string' && r.error) return true
  if (r.error && typeof r.error === 'object') return true
  return false
}

// Stop / SessionEnd：回合结算 → 奖励 → 飞轮更新
function settleTurn(sid, td, tag) {
  const dtMs = Date.now() - td.t0
  const r = rewardOf(td, tag, dtMs)
  const rec = {
    turn: sid + '/' + td.turn, reward: r.reward, tag, breakdown: r.breakdown,
    chosen: td.chosen, pool: td.pool, pChosen: td.pChosen,
    clsType: td.clsType, ucbTier: td.ucbTier, linTier: td.linTier, f: td.f,
  }
  const st = loadFlywheel()
  applyReward(st, rec)
  store.appendJsonl('rewards.jsonl', rec)
  log('reward ' + rec.reward + ' (' + tag + ') on ' + rec.turn + ' toolErrors=' + (td.toolErrors || 0) + ' dt=' + dtMs + 'ms')
}

function finalize(input, tag) {
  const sid = input.session_id
  const s = loadTurns(sid)
  if (!s.open) return
  const td = s.open
  s.open = null
  saveTurns(sid, s)
  settleTurn(sid, td, tag)
}

// SessionStart：目录惰性刷新 + JSONL 压实 + 日志轮转 + 过期回合文件清理
// （stdout 留空——本事件 stdout 也会进上下文）
function onSessionStart(input) {
  catalog(input.cwd)
  store.compactJsonl('rewards.jsonl', MAX_REWARD_LINES)
  store.compactJsonl('decisions.jsonl', MAX_REWARD_LINES)
  try {
    const p = join(store.home, 'router.log')
    if (statSync(p).size > 1024 * 1024) writeFileSync(p, '')
  } catch { /* 尽力而为 */ }
  // 清理 7 天前的残留回合文件（会话异常退出未触发 SessionEnd 时兜底，防无限累积）
  try {
    if (existsSync(turnsDir())) {
      for (const f of readdirSync(turnsDir())) {
        const fp = join(turnsDir(), f)
        try { if (Date.now() - statSync(fp).mtimeMs > 7 * 24 * 3600 * 1000) rmSync(fp, { force: true }) } catch { /* 单文件尽力而为 */ }
      }
    }
  } catch { /* 尽力而为 */ }
}

// ---- 分发（fail-open：任何异常只记日志，永远 exit 0）----

try {
  const input = readStdinJson()
  switch (input.hook_event_name) {
    case 'UserPromptSubmit': onUserPromptSubmit(input); break
    case 'PostToolUse': onPostToolUse(input); break
    case 'Stop': finalize(input, 'clean-close'); break
    case 'SessionEnd':
      finalize(input, 'clean-close')
      // 会话结束即删除回合文件（防止 turns/ 目录随会话数无限增长）
      try { rmSync(turnsPath(input.session_id), { force: true }) } catch { /* 尽力而为 */ }
      break
    case 'SessionStart': onSessionStart(input); break
    default: break
  }
} catch (e) {
  log('hook failed: ' + String(e && e.stack ? e.stack : e))
}
