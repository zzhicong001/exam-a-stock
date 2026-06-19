/**
 * 股票测验系统 — Cloudflare Workers 后端服务
 *
 * API 路由:
 *   GET  /                      服务信息页
 *   GET  /ping                  健康检查
 *   GET  /api/questions         获取题库（从 KV 读取）
 *   POST /api/init-questions    初始化题库到 KV（仅需执行一次）
 *   POST /api/sync              同步用户数据 { deviceId, data }
 *   GET  /api/sync?deviceId=xxx 拉取用户数据
 *   DELETE /api/data?deviceId=xxx  清除用户数据
 *
 * KV 键结构:
 *   questions            → 完整题库 JSON
 *   device:{deviceId}    → { wrongQuestions, settings, progress, lastModified }
 */

const ALLOWED_ORIGIN = '*';
const RATE_LIMIT = 60; // 每 IP 每分钟
const rateMap = new Map();

// ========== 工具函数 ==========
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders() },
  });
}

function checkRateLimit(ip) {
  const now = Date.now();
  const windowKey = ip + ':' + Math.floor(now / 60000);
  const count = rateMap.get(windowKey) || 0;
  if (count >= RATE_LIMIT) return false;
  rateMap.set(windowKey, count + 1);
  if (rateMap.size > 10000) {
    for (const k of rateMap.keys()) {
      const parts = k.split(':');
      if (parts[parts.length - 1] !== String(Math.floor(now / 60000))) rateMap.delete(k);
    }
  }
  return true;
}

// ========== 主入口 ==========
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!checkRateLimit(clientIP)) {
      return jsonResponse({ error: '请求过于频繁，请稍后再试' }, 429);
    }

    if (!env.QUIZ_KV) {
      return jsonResponse({ error: 'KV 存储未配置' }, 500);
    }

    // ---------- 路由 ----------
    try {
      // 根路径：服务信息
      if (path === '/' || path === '') {
        return htmlResponse(servicePage());
      }

      // 健康检查
      if (path === '/ping') {
        return jsonResponse({ ok: true, service: 'quiz-sync', time: new Date().toISOString() });
      }

      // 获取题库
      if (path === '/api/questions' && request.method === 'GET') {
        return await handleGetQuestions(env);
      }

      // 初始化题库
      if (path === '/api/init-questions' && request.method === 'POST') {
        return await handleInitQuestions(request, env);
      }

      // 同步数据
      if (path === '/api/sync') {
        if (request.method === 'POST') {
          return await handleSyncPush(request, env);
        } else if (request.method === 'GET') {
          return await handleSyncPull(url, env);
        }
      }

      // 删除数据
      if (path === '/api/data' && request.method === 'DELETE') {
        return await handleDeleteData(url, env);
      }

      // 404
      return jsonResponse({ error: '接口不存在: ' + path }, 404);
    } catch (err) {
      return jsonResponse({ error: '服务器内部错误: ' + err.message }, 500);
    }
  },
};

// ========== API 处理函数 ==========

/** GET /api/questions — 获取题库 */
async function handleGetQuestions(env) {
  const raw = await env.QUIZ_KV.get('questions');
  if (raw === null) {
    return jsonResponse({
      error: '题库尚未初始化，请先调用 POST /api/init-questions 上传题库',
      initialized: false,
    }, 404);
  }
  const data = JSON.parse(raw);
  return jsonResponse({ initialized: true, data, moduleCount: Object.keys(data).length });
}

/** POST /api/init-questions — 初始化题库（body 为完整 questions.json） */
async function handleInitQuestions(request, env) {
  const body = await request.text();
  if (body.length > 25 * 1024 * 1024) {
    return jsonResponse({ error: '题库数据过大（超过25MB）' }, 413);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return jsonResponse({ error: '题库 JSON 格式错误: ' + e.message }, 400);
  }
  await env.QUIZ_KV.put('questions', body);
  const total = Object.values(parsed).reduce((s, p) => s + (p.questions?.length || 0), 0);
  return jsonResponse({
    success: true,
    message: '题库已初始化',
    moduleCount: Object.keys(parsed).length,
    totalQuestions: total,
    size: (body.length / 1024).toFixed(1) + ' KB',
  });
}

/** POST /api/sync — 上传同步数据 { deviceId, data } */
async function handleSyncPush(request, env) {
  const body = await request.text();
  if (body.length > 1024 * 1024) {
    return jsonResponse({ error: '数据过大（超过1MB）' }, 413);
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (e) {
    return jsonResponse({ error: 'JSON 格式错误' }, 400);
  }

  const deviceId = String(payload.deviceId || '').trim();
  if (!deviceId || deviceId.length < 3) {
    return jsonResponse({ error: 'deviceId 无效（至少3个字符）' }, 400);
  }

  const data = payload.data || {};
  const now = new Date().toISOString();

  // 读取现有数据做合并（最新修改优先）
  const existingRaw = await env.QUIZ_KV.get('device:' + deviceId);
  let existing = {};
  if (existingRaw) {
    try { existing = JSON.parse(existingRaw); } catch (e) {}
  }

  // 冲突处理：如果云端有更新的数据，保留较新的字段
  const cloudModified = existing.lastModified || '1970-01-01T00:00:00Z';
  const clientModified = data.lastModified || now;
  const useClientData = clientModified >= cloudModified;

  const merged = {
    deviceId: deviceId,
    wrongQuestions: useClientData ? (data.wrongQuestions ?? existing.wrongQuestions ?? [])
                                  : (existing.wrongQuestions ?? data.wrongQuestions ?? []),
    examRecords: useClientData ? (data.examRecords ?? existing.examRecords ?? [])
                               : (existing.examRecords ?? data.examRecords ?? []),
    progress: useClientData ? (data.progress ?? existing.progress ?? {})
                            : (existing.progress ?? data.progress ?? {}),
    settings: useClientData ? (data.settings ?? existing.settings ?? {})
                            : (existing.settings ?? data.settings ?? {}),
    lastModified: now,
    savedAt: now,
    size: body.length,
  };

  await env.QUIZ_KV.put('device:' + deviceId, JSON.stringify(merged), { expirationTtl: 2592000 });

  return jsonResponse({
    success: true,
    deviceId: deviceId,
    savedAt: now,
    size: body.length,
    conflictResolved: !useClientData,
  });
}

/** GET /api/sync?deviceId=xxx — 拉取同步数据 */
async function handleSyncPull(url, env) {
  const deviceId = url.searchParams.get('deviceId');
  if (!deviceId) {
    return jsonResponse({ error: '缺少 deviceId 参数' }, 400);
  }

  const raw = await env.QUIZ_KV.get('device:' + deviceId);
  if (raw === null) {
    return jsonResponse({ exists: false, data: null });
  }

  const data = JSON.parse(raw);
  return jsonResponse({
    exists: true,
    data: data,
    fetchedAt: new Date().toISOString(),
  });
}

/** DELETE /api/data?deviceId=xxx — 删除用户数据 */
async function handleDeleteData(url, env) {
  const deviceId = url.searchParams.get('deviceId');
  if (!deviceId) {
    return jsonResponse({ error: '缺少 deviceId 参数' }, 400);
  }
  await env.QUIZ_KV.delete('device:' + deviceId);
  return jsonResponse({ success: true, deleted: true, deviceId: deviceId });
}

// ========== 服务信息页 ==========
function servicePage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>股票测验云同步服务</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0f172a;color:#e2e8f0}
.card{background:#1e293b;border-radius:16px;padding:40px;max-width:520px;width:90%}
h1{font-size:24px;margin-bottom:6px}
.sub{color:#94a3b8;margin-bottom:24px;font-size:14px}
.section{background:#334155;border-radius:10px;padding:16px;margin-bottom:12px}
.section h3{font-size:14px;color:#60a5fa;margin-bottom:10px}
.api{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:13px}
.method{padding:2px 8px;border-radius:4px;font-weight:700;font-size:11px}
.m-get{background:#10b981;color:#fff}
.m-post{background:#3b82f6;color:#fff}
.m-delete{background:#ef4444;color:#fff}
code{background:#0f172a;padding:2px 6px;border-radius:4px;font-size:12px}
.note{font-size:12px;color:#64748b;margin-top:16px;text-align:center}
</style>
</head>
<body>
<div class="card">
<h1>🔄 股票测验云同步服务</h1>
<p class="sub">Cloudflare Workers + KV · 运行中</p>
<div class="section">
<h3>API 接口</h3>
<div class="api"><span class="method m-get">GET</span> <code>/api/questions</code> 获取题库</div>
<div class="api"><span class="method m-post">POST</span> <code>/api/sync</code> 上传进度数据</div>
<div class="api"><span class="method m-get">GET</span> <code>/api/sync?deviceId=xxx</code> 拉取进度数据</div>
<div class="api"><span class="method m-delete">DELETE</span> <code>/api/data?deviceId=xxx</code> 清除数据</div>
<div class="api"><span class="method m-get">GET</span> <code>/ping</code> 健康检查</div>
</div>
<div class="section">
<h3>数据同步流程</h3>
<div style="font-size:13px;line-height:1.8;color:#cbd5e1">
1. 前端生成设备 ID（UUID）<br>
2. 页面加载时从云端拉取最新数据<br>
3. 答题/标记/交卷后自动上传到云端<br>
4. 换设备输入相同 ID 即可同步
</div>
</div>
<p class="note">前端页面请访问 Cloudflare Pages 地址</p>
</div>
</body>
</html>`;
}
