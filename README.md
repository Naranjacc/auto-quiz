# auto-quiz 🚀

> 微信答题自动化工具 —— 一键抓包、题库匹配、自动答题

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)

---

## ⚠️ 重要声明

**本工具不含任何答题链接、二维码、题库内容。** 工具只提供自动答题引擎。你需要自行准备：

| 需要自行上传 | 格式 | 说明 |
|-------------|------|------|
| 🔗 **答题链接 / 二维码** | URL 或图片 | 微信答题 H5 的入口链接或二维码截图 |
| 📚 **题库（参考答案）** | JSON / Markdown / Word | 你的题目和答案数据，见[题库格式](#题库) |
| 🔑 **LLM API Key（可选）** | DeepSeek API Key | 用于语义匹配，没有也能离线运行 |

工具是枪，弹药自己装。

---

## 它是干什么的

微信生态里有大量我的答题、党建答题、职业考试。auto-quiz 通过 MITM 代理自动抓取微信答题凭证，结合**你的题库** + LLM 语义匹配，自动完成答题。

**核心能力：**
- 🔍 MITM 代理一键抓取微信 OAuth 凭证（`wxc`、`uuid`、`userId`）
- 📚 4 层字符串匹配（精确 → 关键词 → 模糊 → 子串）+ 可导入自定义题库
- 🧠 BGE 向量语义搜索 + DeepSeek LLM 兜底（离线可用）
- 📊 答案→选项交叉验证门（KB 答案不在选项中自动拒绝）
- ⚡ 可配置速度/准确率（fast / medium / slow / accuracy 0-1）

## 快速开始

### 1. 准备材料

把以下 3 样东西准备好：
- 📱 **答题二维码或链接**（截图或 URL）
- 📚 **题库文件**（JSON / Markdown / Word，格式见[题库](#题库)）
- 🔑 **DeepSeek API Key**（可选，没有也能用离线模式）

### 2. 安装

```bash
git clone https://github.com/your-username/auto-quiz.git
cd auto-quiz
npm install

# 安装 mitmproxy（Windows）
winget install mitmproxy.mitmproxy
# 或从 https://mitmproxy.org 下载
```

### 3. 导入题库

```bash
# JSON 格式
node src/cli.js kb import ./my-answers.json

# Markdown 格式 (**Q:** ... **A:** ...)
node src/cli.js kb import ./my-answers.md

# Word 格式
node scripts/import_docx.js ./my-answers.docx

# 查看导入结果
node src/cli.js kb stats
```

### 4. 配置（可选）

```bash
# 设置 LLM API Key（可选，提升匹配准确率）
node src/cli.js setup
```

### 5. 运行

```bash
# 一键抓包 + 答题
node watch.cjs <你的profile名称>

# 手机操作：
# 1. WiFi 代理 → 电脑IP:8899
# 2. 微信打开答题链接/扫码
# 3. 点"开始答题"
# → 自动完成！
```

## 架构

```
┌─────────────────────────────────────────────────────┐
│                   watch.cjs (一键入口)                │
│  启动 mitmproxy → 监听答题链接 → 捕获凭证 → 自动答题   │
└──────────┬──────────────────────────┬───────────────┘
           │                          │
    ┌──────▼──────┐           ┌──────▼──────┐
    │  mitmproxy   │           │  Node Proxy  │
    │  (优先)      │           │  (兜底)      │
    │  Python      │           │  Node.js     │
    └──────┬───────┘           └──────┬───────┘
           │                          │
           └──────────┬───────────────┘
                      │
              ┌───────▼────────┐
              │  API Session    │
              │  答题引擎       │
              └───────┬────────┘
                      │
        ┌─────────────┼─────────────┐
        │             │             │
   ┌────▼────┐  ┌────▼────┐  ┌────▼────┐
   │ KB 匹配  │  │ BGE 向量 │  │  LLM    │
   │ 4层字符串 │  │ 语义搜索 │  │ DeepSeek│
   │ (离线)   │  │ (离线*  │  │ (在线)  │
   └────┬────┘  └────┬────┘  └────┬────┘
        │             │             │
        └─────────────┼─────────────┘
                      │
              ┌───────▼────────┐
              │  答案验证门      │
              │  KB答案∈选项?    │
              └───────┬────────┘
                      │
              ┌───────▼────────┐
              │  提交答案        │
              └────────────────┘
```

### 答题 Pipeline

```
题目 → ① 字符串匹配(exact/keyword/fuzzy/substring)
          ↓ score ≥ 0.25 + 答案在选项中？
     → ② BGE 向量搜索 (离线向量相似度)
          ↓ score ≥ 0.55 + 答案在选项中？
     → ③ KB Top-K fallback (离线兜底)
          ↓ score ≥ 0.45 + 答案唯一匹配？
     → ④ LLM 推理 (DeepSeek，在线)
          ↓
     → ⑤ 随机选择 (最后兜底)
```

### 文件地图

```
src/
├── api/
│   ├── client.js          # 签名算法 + API 客户端
│   └── session.js         # 答题引擎 (核心)
├── engine/
│   ├── llm.js             # LLM 调用 + 答案解析
│   └── matcher.js         # 答案匹配入口
├── kb/
│   ├── manager.js         # 题库 CRUD
│   ├── search.js          # 4层字符串匹配
│   ├── semantic-search.js # 语义搜索 + 融合
│   └── embedder.js        # BGE 向量引擎
├── capture/
│   ├── ca.js              # CA 证书生成
│   └── proxy.js           # Node.js MITM 代理(兜底)
├── browser/
│   ├── launcher.js        # Playwright 浏览器启动
│   ├── extractor.js       # 题目提取 + QR 解析
│   └── scraper.js         # 网页抓取
├── cli.js                 # CLI (12 命令)
├── server.js              # Dashboard 服务器
├── config.js              # 配置管理
├── profile.js             # Profile 管理
├── batch.js               # 批量 SAZ 导入
└── types.js               # 类型定义

scripts/
├── capture_addon.py       # mitmproxy Addon (自动凭据提取)
└── import_docx.js         # Word 题库导入

tests/
├── run.js                 # 集成测试 (12 cases)
├── e2e_test.js            # E2E 测试
└── kb_test.js             # KB 单元测试

data/kb/                   # 你的题库（自行导入，JSON, id → {question, answer, tags}）
watch.cjs                  # 一键答题脚本
```

## CLI 命令

```bash
node src/cli.js capture              # 启动抓包代理 (mitmproxy 模式)
node src/cli.js capture --web        # 启动抓包代理 (mitmweb 浏览器 UI)
node src/cli.js capture --engine node  # 纯 Node.js 代理

node src/cli.js run <profile>        # 用已保存的 profile 答题
node src/cli.js run <profile> --speed fast   # 极速模式 (更少延迟)
node src/cli.js run <profile> --accuracy 0.8 # 80% 准确率 (随机扰动)

node src/cli.js profile list         # 列出所有 profile
node src/cli.js profile add <name>   # 添加 profile
node src/cli.js profile setup <name> # 交互式设置 profile

node src/cli.js kb stats             # 题库统计
node src/cli.js kb import <file>     # 导入题库 (JSON/Markdown)
node src/cli.js kb search <query>    # 搜索题库

node src/cli.js setup                # 配置向导
node src/cli.js parse <qrcode.png>   # 解析 QR 码
node src/cli.js batch <file>         # 批量导入 SAZ 文件
```

## 配置

配置文件：`~/.auto-quiz.json`

```json
{
  "apiKey": "sk-xxx",
  "llmApiKey": "sk-xxx",
  "llmEndpoint": "https://api.deepseek.com/v1/chat/completions",
  "accuracy": 0.9,
  "speed": "medium"
}
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `apiKey` / `llmApiKey` | - | LLM API Key（DeepSeek） |
| `llmEndpoint` | deepseek | LLM 端点 |
| `accuracy` | 0.9 | 准确率 (0-1)，1=100% 用 KB 答案 |
| `speed` | medium | 速度：fast / medium / slow |
| `kbDir` | ./data/kb | 题库目录 |

## Profile 管理

Profile 存储答题站点的完整配置：`~/.auto-quiz/profiles.json`

```json
{
  "我的答题": {
    "session": {
      "userId": "1132825654",
      "uuid": "...",
      "wxc": "..."
    },
    "quizApi": "https://xxx.quiz.com/api"
  }
}
```

Profile 通过 `capture` 命令自动创建 → `run` 命令直接复用。

## 题库

题库为 JSON 文件，每条格式：

```json
{
  "id": "uuid-v4",
  "question": "安全生产法规定，生产经营单位的主要负责人对本单位的安全生产工作（  ）",
  "answer": "全面负责",
  "tags": ["安全", "法律法规"],
  "source": "我的答题",
  "createdAt": "2026-06-15T00:00:00.000Z",
  "hitCount": 5
}
```

支持导入格式：
- **JSON**：`[{question, answer, tags?}]`
- **Markdown**：`**Q:** ... **A:** ...` 或 `## 问题` / `## 答案` 对
- **Word**：`node scripts/import_docx.js <file.docx>`

## FAQ

### Q: 工具自带题库吗？
**不带。** 你需要自行上传答题链接、二维码和参考答案（题库）。工具只提供自动答题引擎。详见[重要声明](#️-重要声明)。

### Q: 没有 LLM API Key 能用吗？
能。离线模式用 4 层字符串匹配 + BGE 向量搜索（首次需下载模型，之后纯离线）。

### Q: BGE 模型下载失败？
国内网络 HuggingFace 被墙。已配置 `HF_ENDPOINT=https://hf-mirror.com` 镜像。
如果镜像也挂了，自动降级到离线 KB Top-K 匹配。

### Q: mitmproxy 证书怎么装？
- Windows: 首次运行后到 `C:\Users\<你>\.mitmproxy\mitmproxy-ca-cert.pem` 双击安装
- 手机: 代理连上后访问 `mitm.it` 下载安装

### Q: 支持哪些答题平台？
理论上支持所有微信 OAuth 授权的答题 H5。

### Q: 题库从哪里来？
常见来源：从答题平台手动整理、从已有文档导入（支持 JSON/Markdown/Word）、与他人共享题库。格式见[题库](#题库)。

## License

MIT — 随意使用、修改、分发。

---

🤖 本项目开发由 [Musk PM 模式](https://github.com/your-username/auto-quiz/blob/master/CLAUDE.md) 驱动 —— 6 阶段编排，零容忍冗余。
