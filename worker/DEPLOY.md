# 股票测验系统 — Cloudflare Workers 部署说明

## 架构

```
┌─────────────────┐     API 请求      ┌──────────────────────┐
│  Cloudflare     │ ◄──────────────► │  Cloudflare Workers   │
│  Pages (静态)    │                  │  quiz-sync            │
│  index.html     │                  │  ├─ /api/questions    │
│  fupan_imgs/    │                  │  ├─ /api/sync         │
│  questions.json │                  │  └─ /api/data         │
└─────────────────┘                  └────────┬─────────────┘
                                              │
                                     ┌────────▼─────────────┐
                                     │  Workers KV           │
                                     │  ├─ questions (题库)  │
                                     │  └─ device:{id} (进度)│
                                     └──────────────────────┘
```

- **Cloudflare Pages**: 托管静态资源（HTML、图片、questions.json 备用）
- **Cloudflare Workers**: 提供 REST API，处理数据同步
- **Workers KV**: 存储题库和用户进度数据

---

## 部署步骤

### 第 1 步：部署 Worker（已完成 ✅）

```powershell
cd H:\buddy\exam\worker
wrangler.cmd deploy
```

Worker 地址: `https://quiz-sync.zzhicong001.workers.dev`

### 第 2 步：初始化题库到 KV

```powershell
# 用 Python 上传题库（推荐）
"C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\python.exe" "H:\buddy\exam\worker\init_questions.py"

# 或用 curl（手动）
curl -X POST https://quiz-sync.zzhicong001.workers.dev/api/init-questions \
  -H "Content-Type: application/json" \
  -d @H:\buddy\exam\questions.json
```

验证题库已上传：
```
curl https://quiz-sync.zzhicong001.workers.dev/api/questions
```

### 第 3 步：前端部署

前端 `index.html` 仍部署在 Cloudflare Pages（已部署）。
`WORKER_URL` 已硬编码为 `https://quiz-sync.zzhicong001.workers.dev`。

每次修改 index.html 后：
```bash
cd H:\buddy\exam
git add -A && git commit -m "update" && git push origin master
```
Cloudflare Pages 会自动重新部署。

---

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 服务信息页 |
| GET | `/ping` | 健康检查 |
| GET | `/api/questions` | 获取题库 |
| POST | `/api/init-questions` | 初始化题库（body=完整JSON） |
| POST | `/api/sync` | 上传进度 `{deviceId, data}` |
| GET | `/api/sync?deviceId=xxx` | 拉取进度 |
| DELETE | `/api/data?deviceId=xxx` | 删除设备数据 |

---

## 数据同步流程

### 自动同步（默认开启）
1. 首次访问 → 自动生成 UUID 设备 ID
2. 页面加载 → 从云端拉取最新数据
3. 答题/标记错题/交卷/改设置 → 2秒后自动上传
4. 顶栏显示同步状态（☁️已同步/🔄同步中/📴离线）

### 跨设备同步
1. 在设备 A 上答题（自动同步到云端）
2. 在设备 B 打开网站 → 点「🔄 同步」
3. 看到设备 B 的短码（如 `A1B2`）
4. 如需同步设备 A 的数据：在设备 B 的同步弹窗中粘贴设备 A 的完整 ID → 点「拉取该设备数据」

### 冲突处理
- 采用「最新修改优先」策略
- 每次写入记录 `lastModified` 时间戳
- 云端时间更新 → 覆盖本地
- 本地时间更新 → 覆盖云端
- 错题本取并集去重（以 qId 为准）

---

## KV 数据结构

```
Key: questions
Value: 完整 questions.json

Key: device:{uuid}
Value: {
  deviceId: "xxxx-xxxx-xxxx",
  wrongQuestions: [...],
  examRecords: [...],
  progress: {...},
  settings: { theme, fontSize, shuffle, nickname },
  lastModified: "2026-06-20T...",
  savedAt: "2026-06-20T...",
  size: 12345
}
TTL: 30天（2592000秒）
```

---

## 更新题库

当 questions.json 更新后，重新上传到 KV：

```powershell
"C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\python.exe" "H:\buddy\exam\worker\init_questions.py"
```

同时 git push 更新 Pages 上的备份文件。

---

## 更新 Worker 代码

修改 `worker/src/index.js` 后：

```powershell
cd H:\buddy\exam\worker
wrangler.cmd deploy
```

---

## 安全说明

- 设备 ID 是唯一凭证，不要泄露给他人
- KV 数据 TTL 30天自动过期
- 速率限制：每 IP 每分钟 60 次请求
- 无用户认证，ID 即钥匙
