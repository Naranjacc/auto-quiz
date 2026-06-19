# auto-quiz — Musk PM Mode

> ⚠️ 本项目开发遵循 Musk PM 多 Agent 编排模式。
> 6 阶段流程：Deconstruct → Simplify → Optimize → Assign → Monitor → Report

---

## 项目架构

```
src/
├── api/
│   ├── client.js        ← 签名算法 + API 客户端
│   └── session.js       ← 答题引擎 (核心)
├── engine/
│   ├── llm.js           ← LLM 调用 + 答案解析
│   └── matcher.js       ← 答案匹配入口
├── kb/
│   ├── manager.js       ← 题库 CRUD
│   ├── search.js        ← 4层字符串匹配
│   ├── semantic-search.js ← 语义搜索 + 融合
│   └── embedder.js      ← BGE 向量引擎
├── capture/
│   ├── ca.js            ← CA 证书生成
│   └── proxy.js         ← Node.js MITM 代理 (兜底)
├── cli.js               ← CLI (12 命令)
├── server.js            ← Dashboard 服务器
└── config.js            ← 配置管理
scripts/
├── capture_addon.py     ← mitmproxy 自动凭据提取
└── import_docx.js       ← Word 题库导入
tests/
└── run.js               ← 集成测试 (12 cases)
data/kb/                 ← 你的题库（JSON 格式，自行上传）
watch.cjs                ← 一键答题脚本
```

## 已知踩坑记录（别重犯）

| 问题 | 教训 |
|------|------|
| 微信 App ID 硬编码在 `client.js` | 所有第三方 ID → `process.env.XXX \|\| ''` |
| 396 条题库直接提交 | `data/kb/*.json` 进 `.gitignore`，只留 `.gitkeep` |
| API 变更后测试挂了 | `add()` 返回 string 不是 object，改完代码必须跑 `npm test` |
| GitHub push 前没扫敏感信息 | push 前 `grep` 扫 `ghp_`/`sk-`/App ID |

## 当前优先级

1. [P0] E2E 验证 KB 匹配准确率
2. [P1] 重建 Web Dashboard
3. [P2] 题库管理 UI + 历史持久化
