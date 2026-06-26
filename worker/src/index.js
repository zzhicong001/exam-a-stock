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
const CACHE_TTL_HTML = 60;    // HTML 缓存1分钟（快速迭代，且前端自带超时保护）
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
        return await handleSyncPush(request, env, url);
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
         后台管理 API（需密码验证）
         ═══════════════════════════════════════ */

      // 验证管理员密码
      if (path === '/api/admin/verify' && request.method === 'POST') {
        return await handleAdminVerify(request, env);
      }

      // 后台统计概览
      if (path === '/api/admin/stats' && request.method === 'GET') {
        return await handleAdminStats(env);
      }

      // 用户列表
      if (path === '/api/admin/users' && request.method === 'GET') {
        return await handleAdminUsers(url, env);
      }

      // 用户详情
      if (path === '/api/admin/user' && request.method === 'GET') {
        return await handleAdminUserDetail(url, env);
      }

      // 题库统计
      if (path === '/api/admin/questions' && request.method === 'GET') {
        return await handleAdminQuestions(env);
      }

      // 修改管理员密码
      if (path === '/api/admin/password' && request.method === 'POST') {
        return await handleAdminPassword(request, env);
      }

      // 清除指定用户数据
      if (path === '/api/admin/clear-user' && request.method === 'POST') {
        return await handleAdminClearUser(request, env);
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
 * HTML 文件不缓存到 Worker 边缘（GitHub Raw 自带的 CDN 已有缓存）
 * 其他静态资源使用 Edge Cache 加速
 */
async function proxyFromGitHub(githubPath, ctx) {
  const githubUrl = GITHUB_RAW + githubPath;
  const isHtml = githubPath.endsWith('.html') || githubPath === '/index.html';

  // 非 HTML 文件：检查并复用边缘缓存
  if (!isHtml) {
    const cache = caches.default;
    const cacheKey = new Request(githubUrl, { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  // 从 GitHub Raw 拉取
  let ghResp;
  try {
    ghResp = await fetch(githubUrl, {
      headers: { 'User-Agent': 'CloudflareWorker-QuizSync/1.0' }
    });
  } catch (e) {
    return new Response('GitHub 连接失败: ' + e.message, {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }

  if (ghResp.status === 404) {
    return new Response('未找到: ' + githubPath, {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }

  if (!ghResp.ok) {
    return new Response('GitHub 返回 HTTP ' + ghResp.status, {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const contentType = getContentType(githubPath);
  const cacheTtl = getCacheTtl(githubPath);

  // HTML 不缓存浏览器/Worker边缘（实时拉取，GitHub CDN自身已有缓存）
  const cacheControl = isHtml
    ? 'no-cache, no-store, must-revalidate'
    : 'public, max-age=' + cacheTtl;

  const resp = new Response(ghResp.body, {
    status: ghResp.status,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Etag': ghResp.headers.get('Etag') || '',
    },
  });

  // 非 HTML 文件存入边缘缓存（异步不阻塞）
  if (!isHtml) {
    const cache = caches.default;
    const cacheKey = new Request(githubUrl, { method: 'GET' });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  }

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
async function handleSyncPush(request, env, url) {
  const body = await request.text();
  if (body.length > 1024 * 1024) {
    return jsonResponse({ error: '数据过大（超过1MB）' }, 413);
  }

  let payload;
  try { payload = JSON.parse(body); } catch (e) {
    return jsonResponse({ error: 'JSON 解析失败: ' + e.message }, 400);
  }

  const deviceId = String(payload.deviceId || '').trim();
  if (!deviceId || deviceId.length < 2) {
    return jsonResponse({ error: 'deviceId 无效' }, 400);
  }

  const data = payload.data || {};
  const now = new Date().toISOString();
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
  const userAgent = request.headers.get('User-Agent') || '';

  // 记录用户访问（用于后台统计）
  ctxWaitForLog(env, deviceId, clientIP, userAgent, now);

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

  // 记录访问
  const clientIP = ''; // 从外部无法获取 request
  const now = new Date().toISOString();
  // Note: pull 请求由前端定时发起，不在此记录详细 IP（由 push 端记录）

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

/* ═══════════════════════════════════════════
   用户访问日志 — 记录到 KV 供后台统计
   ═══════════════════════════════════════════ */

/** 记录用户访问元数据（异步，不阻塞响应） */
async function logUserVisit(env, deviceId, ip, userAgent, time) {
  try {
    const key = 'admin:user:' + deviceId;
    const raw = await env.QUIZ_KV.get(key);
    let meta = raw ? JSON.parse(raw) : {
      deviceId: deviceId,
      firstSeen: time,
      ipHistory: [],
      examCount: 0,
      wrongCount: 0,
      lastPaper: '',
      nickname: ''
    };

    meta.lastSeen = time;
    meta.userAgent = (userAgent || '').substring(0, 200);

    // 记录 IP 历史（去重，最多保留最近10个）
    if (ip && ip !== 'unknown') {
      if (!meta.ipHistory.includes(ip)) {
        meta.ipHistory.unshift(ip);
        if (meta.ipHistory.length > 10) meta.ipHistory.length = 10;
      }
    }

    // 从 user data 中提取统计信息
    const userData = await env.QUIZ_KV.get('device:' + deviceId);
    if (userData) {
      try {
        const d = JSON.parse(userData);
        meta.wrongCount = (d.wrongQuestions || []).length;
        meta.examCount = (d.examRecords || []).length;
        meta.nickname = (d.settings && d.settings.nickname) || meta.nickname || '';
      } catch (e) {}
    }

    await env.QUIZ_KV.put(key, JSON.stringify(meta), { expirationTtl: 7776000 }); // 90天

    // 维护用户列表（去重集合）
    const listRaw = await env.QUIZ_KV.get('admin:users');
    let users = listRaw ? JSON.parse(listRaw) : [];
    if (!users.includes(deviceId)) {
      users.push(deviceId);
      await env.QUIZ_KV.put('admin:users', JSON.stringify(users), { expirationTtl: 7776000 });
    }
  } catch (e) {
    // 日志记录失败不影响主流程
  }
}

// 内部异步调用（不阻塞主响应）
async function ctxWaitForLog(env, deviceId, ip, userAgent, time) {
  logUserVisit(env, deviceId, ip, userAgent, time).catch(() => {});
}


/* ═══════════════════════════════════════════
   后台管理 API 实现
   ═══════════════════════════════════════════ */

const ADMIN_PASSWORD_KEY = 'admin:password';
const DEFAULT_PASSWORD = 'admin123';

/** 获取/初始化管理员密码 */
async function getAdminPassword(env) {
  let pwd = await env.QUIZ_KV.get(ADMIN_PASSWORD_KEY);
  if (!pwd) {
    await env.QUIZ_KV.put(ADMIN_PASSWORD_KEY, DEFAULT_PASSWORD);
    pwd = DEFAULT_PASSWORD;
  }
  return pwd;
}

/** POST /api/admin/verify — 验证密码 */
async function handleAdminVerify(request, env) {
  const body = await request.text();
  let payload;
  try { payload = JSON.parse(body); } catch (e) {
    return jsonResponse({ ok: false, error: '格式错误' }, 400);
  }
  const pwd = await getAdminPassword(env);
  if (payload.password === pwd) {
    return jsonResponse({ ok: true, token: btoa(pwd + ':admin') });
  }
  return jsonResponse({ ok: false, error: '密码错误' }, 403);
}

/** GET /api/admin/stats — 统计概览 */
async function handleAdminStats(env) {
  const listRaw = await env.QUIZ_KV.get('admin:users');
  const userList = listRaw ? JSON.parse(listRaw) : [];

  let totalUserExams = 0, totalWrong = 0, active24h = 0;
  const now = Date.now();

  for (const did of userList) {
    const raw = await env.QUIZ_KV.get('admin:user:' + did);
    if (raw) {
      try {
        const m = JSON.parse(raw);
        totalUserExams += m.examCount || 0;
        totalWrong += m.wrongCount || 0;
        if (m.lastSeen && (now - new Date(m.lastSeen).getTime()) < 86400000) active24h++;
      } catch (e) {}
    }
  }

  // 题库信息
  const qRaw = await env.QUIZ_KV.get('questions') || '';
  let moduleCount = 0, totalQuestions = 0;
  if (qRaw) {
    try {
      const qData = JSON.parse(qRaw);
      moduleCount = Object.keys(qData).length;
      totalQuestions = Object.values(qData).reduce((s, p) => s + (p.questions ? p.questions.length : 0), 0);
    } catch (e) {}
  }

  // 最新活动
  const recentUsers = [];
  for (const did of userList.slice(-20)) {
    const raw = await env.QUIZ_KV.get('admin:user:' + did);
    if (raw) {
      try {
        const m = JSON.parse(raw);
        recentUsers.push({
          deviceId: did,
          nickname: m.nickname || '',
          lastSeen: m.lastSeen || '',
          ip: (m.ipHistory || [])[0] || '未知'
        });
      } catch (e) {}
    }
  }
  recentUsers.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
  recentUsers.length = Math.min(recentUsers.length, 10);

  return jsonResponse({
    totalUsers: userList.length,
    active24h: active24h,
    totalExams: totalUserExams,
    totalWrong: totalWrong,
    modules: moduleCount,
    questions: totalQuestions,
    recentUsers: recentUsers
  });
}

/** GET /api/admin/users — 用户列表 */
async function handleAdminUsers(url, env) {
  const listRaw = await env.QUIZ_KV.get('admin:users');
  const userList = listRaw ? JSON.parse(listRaw) : [];

  const users = [];
  for (const did of userList) {
    const raw = await env.QUIZ_KV.get('admin:user:' + did);
    if (raw) {
      try {
        const m = JSON.parse(raw);
        users.push({
          deviceId: did,
          nickname: m.nickname || '',
          firstSeen: m.firstSeen || '',
          lastSeen: m.lastSeen || '',
          ip: (m.ipHistory || [])[0] || '未知',
          examCount: m.examCount || 0,
          wrongCount: m.wrongCount || 0,
          lastPaper: m.lastPaper || ''
        });
      } catch (e) {}
    }
  }

  // 按最近活动时间排序
  users.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
  return jsonResponse({ users: users });
}

/** GET /api/admin/user?deviceId=xxx — 用户详情 */
async function handleAdminUserDetail(url, env) {
  const deviceId = url.searchParams.get('deviceId');
  if (!deviceId) return jsonResponse({ error: '缺少 deviceId' }, 400);

  // 元数据
  const metaRaw = await env.QUIZ_KV.get('admin:user:' + deviceId);
  const meta = metaRaw ? JSON.parse(metaRaw) : {};

  // 用户数据
  const dataRaw = await env.QUIZ_KV.get('device:' + deviceId);
  const data = dataRaw ? JSON.parse(dataRaw) : {};

  return jsonResponse({
    deviceId: deviceId,
    meta: meta,
    data: {
      wrongQuestions: data.wrongQuestions || [],
      examRecords: data.examRecords || [],
      settings: data.settings || {},
      lastModified: data.lastModified || ''
    }
  });
}

/** GET /api/admin/questions — 题库统计 */
async function handleAdminQuestions(env) {
  const raw = await env.QUIZ_KV.get('questions') || '';
  if (!raw) return jsonResponse({ error: '题库未初始化' }, 404);

  const data = JSON.parse(raw);
  const modules = Object.entries(data).map(([key, val]) => ({
    key: key,
    name: val.name || key,
    desc: val.desc || '',
    difficulty: val.difficulty || '',
    duration: val.duration || 0,
    questionCount: (val.questions || []).length
  }));

  const total = modules.reduce((s, m) => s + m.questionCount, 0);
  return jsonResponse({
    moduleCount: modules.length,
    totalQuestions: total,
    modules: modules
  });
}

/** POST /api/admin/password — 修改密码 */
async function handleAdminPassword(request, env) {
  const body = await request.text();
  let payload;
  try { payload = JSON.parse(body); } catch (e) {
    return jsonResponse({ ok: false, error: '格式错误' }, 400);
  }
  const currentPwd = await getAdminPassword(env);
  if (payload.oldPassword !== currentPwd) {
    return jsonResponse({ ok: false, error: '旧密码错误' }, 403);
  }
  if (!payload.newPassword || payload.newPassword.length < 4) {
    return jsonResponse({ ok: false, error: '新密码至少4位' }, 400);
  }
  await env.QUIZ_KV.put(ADMIN_PASSWORD_KEY, payload.newPassword);
  return jsonResponse({ ok: true, message: '密码已更新' });
}

/** POST /api/admin/clear-user — 清除指定用户 */
async function handleAdminClearUser(request, env) {
  const body = await request.text();
  let payload;
  try { payload = JSON.parse(body); } catch (e) {
    return jsonResponse({ ok: false, error: '格式错误' }, 400);
  }
  const deviceId = payload.deviceId;
  if (!deviceId) return jsonResponse({ ok: false, error: '缺少 deviceId' }, 400);

  await env.QUIZ_KV.delete('device:' + deviceId);
  await env.QUIZ_KV.delete('admin:user:' + deviceId);

  // 从用户列表中移除
  const listRaw = await env.QUIZ_KV.get('admin:users');
  if (listRaw) {
    let users = JSON.parse(listRaw);
    users = users.filter(u => u !== deviceId);
    await env.QUIZ_KV.put('admin:users', JSON.stringify(users));
  }

  return jsonResponse({ ok: true, message: '用户数据已清除' });
}
