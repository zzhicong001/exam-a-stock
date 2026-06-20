# 股票测验系统 — Cloudflare Workers + KV 部署指南（不再需要 Pages）

## 架构图

```
浏览器访问
    │
    ▼
┌──────────────────────────────────────┐
│  Cloudflare Worker                   │
│  (quiz-sync.zzhicong001.workers.dev) │
│                                      │
│  ┌─ 静态代理 ──────────────────────┐ │
│  │ / → index.html       GitHub Raw │ │
│  │ /questions.json →    GitHub Raw │ │
│  │ /fupan_imgs/* →      GitHub Raw │ │
│  │ 缓存：HTML 5min / 图片 1h      │ │
│  └────────────────────────────────┘ │
│                                      │
│  ┌─ API ───────────────────────────┐ │
│  │ /api/questions →     GitHub Raw │ │
│  │ /api/sync      →     KV         │ │
│  │ /api/data      →     KV         │ │
│  └────────────────────────────────┘ │
└──────────────────────────────────────┘
    │                    │
    ▼                    ▼
┌──────────┐    ┌──────────────────┐
│ GitHub   │    │ Cloudflare KV    │
│ raw      │    │ device:xxx       │
│ 题库 JSON│    │ 错题本/考试/设置 │
│ 图片文件 │    │ TTL 30天         │
│ HTML页面 │    └──────────────────┘
└──────────┘
```

**关键特性：**
- **不再需要 Pages**：Worker 一站式提供静态资源 + API 服务
- **git push 即更新**：推送 GitHub 后 Worker 自动在缓存过期（5分钟）后拉取新内容
- **题库来源 GitHub**：`/api/questions` 直接读取 GitHub 上的 questions.json，无需 KV 初始化
- **图片来源 GitHub**：fupan_imgs/ 文件代理自 GitHub Raw
- **用户数据存 KV**：跨设备同步错题本、考试记录、设置偏好

---

## 部署步骤

### 前置条件
- Cloudflare 账号
- `wrangler` CLI 已安装（`npm install -g wrangler`）
- GitHub 仓库 `zzhicong001/exam-a-stock` 已就绪

### 第 1 步：验证 KV 命名空间

确保 KV 已创建（通常只需创建一次）：

```powershell
cd H:\buddy\exam\worker
wrangler.cmd kv namespace create QUIZ_KV
```

如果已创建，可列出已有命名空间：

```powershell
wrangler.cmd kv namespace list
```

### 第 2 步：填 wrangler.toml 中的 KV ID

打开 `wrangler.toml`，确认 `id` 字段为你的 KV 命名空间 ID：

```toml
[[kv_namespaces]]
binding = "QUIZ_KV"
id = "your-kv-namespace-id-here"
```

### 第 3 步：部署 Worker

```powershell
# 进入 worker 目录
cd H:\buddy\exam\worker

# 如果 PowerShell 找不到 npm/node，先设置 PATH
$env:PATH = "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2;" + $env:PATH

# 部署
wrangler.cmd deploy
```

部署成功后输出 Worker URL，例如 `https://quiz-sync.zzhicong001.workers.dev`

### 第 4 步：验证部署

```bash
# 访问主页（应显示测验系统）
curl -s https://quiz-sync.zzhicong001.workers.dev/ | head -5

# 获取题库
curl -s https://quiz-sync.zzhicong001.workers.dev/api/questions | head -c 100

# 健康检查
curl https://quiz-sync.zzhicong001.workers.dev/ping
```

---

## 日常更新流程

### 更新题库（questions.json）
1. 编辑本地 `questions.json`
2. `git add questions.json && git commit -m "更新题库" && git push origin master`
3. 等待 5 分钟（Worker 缓存过期）→ 访问网站自动看到新题目

### 更新网页（index.html）
1. 编辑本地 `index.html`
2. 同样 git push
3. 等待 5 分钟 → 自动刷新

### 更新图片
1. 放入 `fupan_imgs/` 并 git push
2. 等待 1 小时（图片缓存）→ 自动显示

### 立即刷新缓存（可选）
如果需要立即看到更新，可以在 Worker 代码中降低 CACHE_TTL_HTML / CACHE_TTL_JSON 的值后重新部署，或等待缓存自然过期。

---

## 可选：绑定自定义域名

1. 在 Cloudflare Dashboard 中进入你的域名管理页
2. 左侧菜单 → Workers Routes
3. 添加路由：`exam.yourdomain.com/*` → 指向 `quiz-sync` Worker
4. DNS 添加 CNAME 记录：`exam` → `quiz-sync.zzhicong001.workers.dev`

---

## 如果 GitHub 不可用

Worker 有边缘缓存兜底。即使 GitHub 暂时不可达，缓存中的旧版本仍可正常访问。KV 数据（用户进度）不受影响。

---

## KV 数据清理

KV 数据 30 天自动过期。如需手动清理所有用户数据：
1. Cloudflare Dashboard → Workers & Pages → KV
2. 找到 `QUIZ_KV` 命名空间
3. 删除 `device:` 开头的所有 key
