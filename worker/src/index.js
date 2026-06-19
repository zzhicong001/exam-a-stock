/**
 * Cloudflare Workers + KV 股票测验云同步服务
 *
 * API:
 *   POST /sync/{id}   保存答题进度数据（body: JSON）
 *   GET  /sync/{id}   读取答题进度数据
 *   DELETE /sync/{id}  删除数据
 *   GET  /ping        健康检查
 *
 * {id} 为用户自定义数字 ID（1-999999）
 * 数据存储在 KV 中，key 格式: quiz_sync:{id}
 * TTL: 30 天（2592000 秒），自动过期清理
 */

// 允许的跨域源（部署后改为你的 Pages 域名）
const ALLOWED_ORIGIN = '*';

// 简单的速率限制（每 IP 每分钟最多 30 次）
const RATE_LIMIT = 30;
const rateMap = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // 健康检查
    if (path === '/ping') {
      return jsonResponse({ ok: true, service: 'quiz-sync', time: new Date().toISOString() });
    }

    // 速率限制
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    const now = Date.now();
    const windowKey = clientIP + ':' + Math.floor(now / 60000);
    const count = rateMap.get(windowKey) || 0;
    if (count >= RATE_LIMIT) {
      return jsonResponse({ error: '请求过于频繁，请稍后再试' }, 429);
    }
    rateMap.set(windowKey, count + 1);
    // 清理旧窗口（简单 GC）
    if (rateMap.size > 10000) {
      for (const k of rateMap.keys()) {
        if (!k.startsWith(clientIP + ':' + Math.floor(now / 60000))) {
          rateMap.delete(k);
        }
      }
    }

    // 路由匹配 /sync/{id}
    const match = path.match(/^\/sync\/(\d{1,8})$/);
    if (!match) {
      return jsonResponse({ error: '路径格式错误，应为 /sync/{数字ID}' }, 404);
    }

    const userId = match[1];
    const kvKey = 'quiz_sync:' + userId;

    // 检查 KV 绑定
    if (!env.QUIZ_KV) {
      return jsonResponse({ error: 'KV 存储未配置，请联系管理员' }, 500);
    }

    try {
      if (request.method === 'GET') {
        // 读取数据
        const data = await env.QUIZ_KV.get(kvKey);
        if (data === null) {
          return jsonResponse({ exists: false, data: null });
        }
        const parsed = JSON.parse(data);
        return jsonResponse({ exists: true, data: parsed, fetchedAt: new Date().toISOString() });

      } else if (request.method === 'POST') {
        // 写入数据
        const body = await request.text();
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          return jsonResponse({ error: '请求体不是有效的 JSON' }, 400);
        }

        // 数据大小限制（KV 单值最大 25MB，我们限制 1MB）
        if (body.length > 1048576) {
          return jsonResponse({ error: '数据过大（超过1MB），请减少同步内容' }, 413);
        }

        // 添加元数据
        parsed._meta = {
          userId: userId,
          savedAt: new Date().toISOString(),
          size: body.length
        };

        // 写入 KV，TTL 30天
        await env.QUIZ_KV.put(kvKey, JSON.stringify(parsed), { expirationTtl: 2592000 });

        return jsonResponse({
          success: true,
          userId: userId,
          savedAt: parsed._meta.savedAt,
          size: body.length
        });

      } else if (request.method === 'DELETE') {
        // 删除数据
        await env.QUIZ_KV.delete(kvKey);
        return jsonResponse({ success: true, deleted: true });

      } else {
        return jsonResponse({ error: '不支持的请求方法: ' + request.method }, 405);
      }

    } catch (err) {
      return jsonResponse({ error: '服务器内部错误: ' + err.message }, 500);
    }
  }
};

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
    status: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
  });
}
