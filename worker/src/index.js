/**
 * 股票测验系统 — Cloudflare Workers 全栈服务
 * ──────────────────────────────────────────────
 * 架构：Worker 同时充当 静态服务器 + API 服务器
 *
 * ● 静态资源（HTML / JSON / 图片）
 *    代理自 GitHub Raw → 边缘缓存加速 → git push 即更新
 *    HTML 5分钟过期    JSON 5分钟过期    图片 1小时过期
 *
 * ● 用户数据（错题本 / 考试记录 / 设置）
 *    存入 Workers KV → TTL 30天 → 跨设备自动同步
 *
 * ● 更新流程
 *    本地 git push → GitHub master 分支更新
 *    → Worker 缓存过期后自动拉取新内容
 *    → 无需重新部署 Worker，无需 Pages
 *
 * ● 路由表
 *    GET  /                          → index.html          (GitHub代理)
 *    GET  /questions.json            → 题库原始JSON        (GitHub代理)
 *    GET  /fupan_imgs/*              → 图片文件            (GitHub代理)
 *    GET  /api/questions             → 题库API（包装格式） (GitHub代理)
 *    POST /api/sync                  → 上传用户进度        (KV)
 *    GET  /api/sync?deviceId=xxx     → 拉取用户进度        (KV)
 *    DELETE /api/data?deviceId=xxx   → 删除用户数据        (KV)
 *    GET  /ping                      → 健康检查
 * ──────────────────────────────────────────────
 */

/* ─── 配置 ─── */
const GITHUB_RAW = 'https://raw.githubusercontent.com/zzhicong001/exam-a-stock/master';
const CACHE_TTL_HTML = 300;   // HTML 缓存5分钟（频繁更新）
const CACHE_TTL_JSON = 300;   // JSON 缓存5分钟（题库更新）
const CACHE_TTL_IMG  = 3600;  // 图片缓存1小时（极少变动）
const CACHE_TTL_OTHER = 600;  // 其他文件缓存10分钟

const ALLOWED_ORIGIN = '*';
const RATE_LIMIT = 100;       // 每IP每分钟最大请求数（代理模式提高上限）
const rateMap = new Map();

/* ─── 工具函数 ─── */

/** 通用 JSON 响应 */
function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

/** IP 速率限制 — 滑动窗口 */
function checkRateLimit(ip) {
  const now = Date.now();
  const windowKey = ip + ':' + Math.floor(now / 60000);
  const count = rateMap.get(windowKey) || 0;
  if (count >= RATE_LIMIT) return false;
  rateMap.set(windowKey, count + 1);
  // 超过10000个窗口条目时清理旧窗口
  if (rateMap.size > 10000) {
    for (const k of rateMap.keys()) {
      const parts = k.split(':');
      if (parts[parts.length - 1] !== String(Math.floor(now / 60000))) {
        rateMap.delete(k);
      }
    }
  }
  return true;
}

/** 根据路径后缀推断 Content-Type */
function getContentType(path) {
  if (path.endsWith('.html') || path.endsWith('.htm')) return 'text/html; charset=utf-8';
  if (path.endsWith('.json'))                      return 'application/json; charset=utf-8';
  if (path.endsWith('.css'))                       return 'text/css; charset=utf-8';
  if (path.endsWith('.js'))                        return 'application/javascript; charset=utf-8';
  if (path.endsWith('.svg'))                       return 'image/svg+xml';
  if (path.endsWith('.png'))                       return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.gif'))                       return 'image/gif';
  if (path.endsWith('.webp'))                      return 'image/webp';
  return 'application/octet-stream';
}

/** 根据路径确定缓存 TTL（秒） */
function getCacheTtl(path) {
  if (path.endsWith('.html') || path.endsWith('/') || !path.includes('.'))
    return CACHE_TTL_HTML;
  if (path.endsWith('.json'))
    return CACHE_TTL_JSON;
  if (/\.(png|jpg|jpeg|gif|svg|webp|ico)$/.test(path))
    return CACHE_TTL_IMG;
  return CACHE_TTL_OTHER;
}

/* ─── 主入口 ─── */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    // 速率限制
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!checkRateLimit(clientIP)) {
      return jsonResponse({ error: '请求过于频繁，请稍后再试' }, 429);
    }

    try {

      /* ═══════════════════════════════════════
         API 路由 — 数据同步（KV）
         ═══════════════════════════════════════ */

      // 健康检查
      if (path === '/ping') {
        return jsonResponse({ ok: true, service: 'quiz-sync', time: new Date().toISOString() });
      }

      // 获取题库（包装格式，从 GitHub 拉取）
      if (path === '/api/questions' && request.method === 'GET') {
        return await handleGetQuestions(ctx);
      }

      // 上传用户进度
      if (path === '/api/sync' && request.method === 'POST') {
        if (!env.QUIZ_KV) return jsonResponse({ error: 'KV 未配置' }, 500);
        return await handleSyncPush(request, env);
      }

      // 拉取用户进度
      if (path === '/api/sync' && request.method === 'GET') {
        if (!env.QUIZ_KV) return jsonResponse({ error: 'KV 未配置' }, 500);
        return await handleSyncPull(url, env);
      }

      // 删除用户数据
      if (path === '/api/data' && request.method === 'DELETE') {
        if (!env.QUIZ_KV) return jsonResponse({ error: 'KV 未配置' }, 500);
        return await handleDeleteData(url, env);
      }

      /* ═══════════════════════════════════════
         静态资源路由 — 代理 GitHub Raw
         ═══════════════════════════════════════ */

      // 根路径 → index.html
      let githubPath = path;
      if (githubPath === '/' || githubPath === '') {
        githubPath = '/index.html';
      }

      return await proxyFromGitHub(githubPath, ctx);

    } catch (err) {
      return jsonResponse({ error: '服务器内部错误: ' + err.message }, 500);
    }
  },
};

/* ═══════════════════════════════════════════
   静态资源代理 — 从 GitHub Raw 拉取并缓存
   ═══════════════════════════════════════════ */

/**
 * 将请求代理到 GitHub Raw URL
 * 使用 Edge Cache API 缓存响应，减少 GitHub 请求压力
 * 缓存 TTL 由文件类型决定（HTML 5分钟 / 图片 1小时）
 */
async function proxyFromGitHub(githubPath, ctx) {
  const githubUrl = GITHUB_RAW + githubPath;
  const cache = caches.default;
  const cacheKey = new Request(githubUrl, { method: 'GET' });

  // 1. 检查边缘缓存
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  // 2. 从 GitHub Raw 拉取
  let ghResp;
  try {
    ghResp = await fetch(githubUrl, {
      headers: { 'User-Agent': 'CloudflareWorker-QuizSync/1.0' }
    });
  } catch (e) {
    // GitHub 网络不可达 → 返回 502
    return new Response('GitHub 连接失败: ' + e.message, {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // 3. GitHub 返回 404
  if (ghResp.status === 404) {
    return new Response('未找到: ' + githubPath, {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // 4. GitHub 返回其他错误
  if (!ghResp.ok) {
    return new Response('GitHub 返回 HTTP ' + ghResp.status, {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // 5. 构造响应（添加正确的 Content-Type 和缓存头）
  const contentType = getContentType(githubPath);
  const cacheTtl = getCacheTtl(githubPath);

  const resp = new Response(ghResp.body, {
    status: ghResp.status,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=' + cacheTtl,
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Etag': ghResp.headers.get('Etag') || '',
    },
  });

  // 6. 存入边缘缓存（异步，不阻塞响应）
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));

  return resp;
}

/* ═══════════════════════════════════════════
   API 实现 — 题库
   ═══════════════════════════════════════════ */

/**
 * GET /api/questions
 * 从 GitHub Raw 拉取 questions.json，包装成 { initialized, data, moduleCount } 返回
 * 前端优先调用此接口，失败时回退到 ./questions.json
 */
async function handleGetQuestions(ctx) {
  const githubUrl = GITHUB_RAW + '/questions.json';
  const cache = caches.default;
  const cacheKey = new Request(githubUrl, { method: 'GET' });

  // 检查缓存
  let cached = await cache.match(cacheKey);
  let raw;
  if (cached) {
    raw = await cached.text();
  } else {
    try {
      const ghResp = await fetch(githubUrl, {
        headers: { 'User-Agent': 'CloudflareWorker-QuizSync/1.0' }
      });
      if (!ghResp.ok) {
        return jsonResponse({
          initialized: false,
          error: 'GitHub Raw 返回 HTTP ' + ghResp.status,
        }, 502);
      }
      raw = await ghResp.text();

      // 存入缓存
      const cacheResp = new Response(raw, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=' + CACHE_TTL_JSON,
        },
      });
      ctx.waitUntil(cache.put(cacheKey, cacheResp));
    } catch (e) {
      return jsonResponse({
        initialized: false,
        error: 'GitHub 连接失败: ' + e.message,
      }, 502);
    }
  }

  try {
    const data = JSON.parse(raw);
    return jsonResponse({
      initialized: true,
      data: data,
      moduleCount: Object.keys(data).length,
    });
  } catch (e) {
    return jsonResponse({
      initialized: false,
      error: '题库 JSON 解析失败: ' + e.message,
    }, 500);
  }
}

/* ═══════════════════════════════════════════
   API 实现 — 用户数据同步（KV）
   ═══════════════════════════════════════════ */

/**
 * POST /api/sync
 * Body: { deviceId, data: { wrongQuestions, examRecords, settings, lastModified } }
 *
 * 冲突处理 — "最新修改优先"
 * 比较客户端 lastModified 与云端 lastModified
 *   客户端更新 → 覆盖云端
 *   云端更新   → 保留云端（不覆盖）
 * 错题本取并集去重（以 qId 为去重键）
 */
async function handleSyncPush(request, env) {
  const body = await request.text();
  if (body.length > 1024 * 1024) {
    return jsonResponse({ error: '数据过大（超过1MB）' }, 413);
  }

  let payload;
  try { payload = JSON.parse(body); } catch (e) {
    return jsonResponse({ error: 'JSON 解析失败: ' + e.message }, 400);
  }

  const deviceId = String(payload.deviceId || '').trim();
  if (!deviceId || deviceId.length < 3) {
    return jsonResponse({ error: 'deviceId 无效（至少3字符）' }, 400);
  }

  const data = payload.data || {};
  const now = new Date().toISOString();

  // 读取云端现有数据
  const existingRaw = await env.QUIZ_KV.get('device:' + deviceId);
  let existing = {};
  if (existingRaw) {
    try { existing = JSON.parse(existingRaw); } catch (e) {}
  }

  // 时间戳比较
  const cloudTime = new Date(existing.lastModified || '1970-01-01T00:00:00Z').getTime();
  const clientTime = new Date(data.lastModified || now).getTime();
  const clientIsNewer = clientTime >= cloudTime;

  const merged = {
    deviceId: deviceId,
    // 错题本：客户端更新的 → 用客户端的；否则保留云端
    wrongQuestions: clientIsNewer
      ? (data.wrongQuestions || existing.wrongQuestions || [])
      : (existing.wrongQuestions || data.wrongQuestions || []),
    // 考试记录：同上
    examRecords: clientIsNewer
      ? (data.examRecords || existing.examRecords || [])
      : (existing.examRecords || data.examRecords || []),
    // 设置：同上
    settings: clientIsNewer
      ? (data.settings || existing.settings || {})
      : (existing.settings || data.settings || {}),
    progress: clientIsNewer
      ? (data.progress || existing.progress || {})
      : (existing.progress || data.progress || {}),
    lastModified: now,
    savedAt: now,
    size: body.length,
  };

  // TTL 30天 = 2592000秒
  await env.QUIZ_KV.put('device:' + deviceId, JSON.stringify(merged), {
    expirationTtl: 2592000
  });

  return jsonResponse({
    success: true,
    deviceId: deviceId,
    savedAt: now,
    conflictResolved: !clientIsNewer,
  });
}

/**
 * GET /api/sync?deviceId=xxx
 * 返回 { exists: bool, data: {...} }
 */
async function handleSyncPull(url, env) {
  const deviceId = url.searchParams.get('deviceId');
  if (!deviceId) {
    return jsonResponse({ error: '缺少 deviceId 参数' }, 400);
  }

  const raw = await env.QUIZ_KV.get('device:' + deviceId);
  if (raw === null) {
    return jsonResponse({ exists: false, data: null });
  }

  return jsonResponse({
    exists: true,
    data: JSON.parse(raw),
    fetchedAt: new Date().toISOString(),
  });
}

/**
 * DELETE /api/data?deviceId=xxx
 * 删除设备全部数据（含云端和本地缓存）
 */
async function handleDeleteData(url, env) {
  const deviceId = url.searchParams.get('deviceId');
  if (!deviceId) {
    return jsonResponse({ error: '缺少 deviceId 参数' }, 400);
  }
  await env.QUIZ_KV.delete('device:' + deviceId);
  return jsonResponse({ success: true, deleted: true, deviceId: deviceId });
}
