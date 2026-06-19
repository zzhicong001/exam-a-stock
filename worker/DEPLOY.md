# Cloudflare Workers + KV 云同步服务部署指引

## 功能

用户输入自定义数字 ID（如 `888`），即可在任意设备存取答题进度数据（错题本、主题、字体、随机排序偏好）。

**API 接口：**
| 方法 | 路径 | 功能 |
|------|------|------|
| `POST` | `/sync/{id}` | 保存进度数据（body: JSON） |
| `GET` | `/sync/{id}` | 读取进度数据 |
| `DELETE` | `/sync/{id}` | 删除数据 |
| `GET` | `/ping` | 健康检查 |

数据存储在 Cloudflare KV 中，TTL 30 天自动过期。

---

## 部署步骤（约 5 分钟）

### 第 1 步：安装 Wrangler CLI

```bash
npm install -g wrangler
```

### 第 2 步：登录 Cloudflare

```bash
wrangler login
```

浏览器会打开授权页面，点击 **Allow** 即可。

### 第 3 步：创建 KV 命名空间

```bash
cd H:\buddy\exam\worker
wrangler kv namespace create QUIZ_KV
```

输出类似：
```
[[kv_namespaces]]
binding = "QUIZ_KV"
id = "abc123def456..."  ← 复制这个 ID
```

### 第 4 步：填入 KV ID

打开 `wrangler.toml`，把 `id = "在此填入你的KV命名空间ID"` 替换为上一步得到的真实 ID。

### 第 5 步：部署

```bash
wrangler deploy
```

部署成功后会输出 Worker 的访问地址，类似：
```
https://quiz-sync.<你的子域名>.workers.dev
```

### 第 6 步：验证

```bash
# 健康检查
curl https://quiz-sync.xxx.workers.dev/ping

# 写入测试
curl -X POST https://quiz-sync.xxx.workers.dev/sync/12345 \
  -H "Content-Type: application/json" \
  -d '{"test":"hello"}'

# 读取测试
curl https://quiz-sync.xxx.workers.dev/sync/12345
```

### 第 7 步：配置前端

打开 `index.html`，找到 `WORKER_URL` 变量，替换为你的 Worker 地址：

```javascript
const WORKER_URL = 'https://quiz-sync.xxx.workers.dev';
```

---

## 使用流程

1. **PC 端答题后** → 点「🔄 同步」→ 输入数字 ID（如 `888`）→ 点「上传到云端」
2. **手机端打开** → 点「🔄 同步」→ 输入相同数字 ID `888` → 点「从云端下载」
3. 数据自动同步：错题本、主题、字体、随机排序偏好

---

## 免费额度

- Cloudflare Workers 免费版：每天 100,000 次请求
- KV 免费版：每天 100,000 次读 + 1,000 次写 + 1GB 存储
- 足够个人使用，不会超限

## 安全说明

- 数字 ID 即为存取凭证，建议用不易猜测的数字（如 6 位数）
- 每个请求有速率限制（每 IP 每分钟 30 次）
- 数据 TTL 30 天自动过期，不会永久占用存储
