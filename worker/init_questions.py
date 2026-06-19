# -*- coding: utf-8 -*-
"""
初始化题库到 Cloudflare Workers KV
将 questions.json 上传到 Worker 的 /api/init-questions 接口
"""
import json, sys, urllib.request, urllib.error

WORKER_URL = 'https://quiz-sync.zzhicong001.workers.dev'
QUESTIONS_FILE = r'H:\buddy\exam\questions.json'

print(f'读取题库文件: {QUESTIONS_FILE}')
with open(QUESTIONS_FILE, 'r', encoding='utf-8') as f:
    raw = f.read()

print(f'题库大小: {len(raw)/1024:.1f} KB')
print(f'上传到: {WORKER_URL}/api/init-questions')

try:
    req = urllib.request.Request(
        WORKER_URL + '/api/init-questions',
        data=raw.encode('utf-8'),
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read().decode('utf-8'))
        if result.get('success'):
            print(f'\n✅ 题库初始化成功！')
            print(f'   模块数: {result["moduleCount"]}')
            print(f'   总题量: {result["totalQuestions"]}')
            print(f'   数据大小: {result["size"]}')
        else:
            print(f'\n❌ 初始化失败: {result}')
            sys.exit(1)
except urllib.error.HTTPError as e:
    body = e.read().decode('utf-8', errors='replace')
    print(f'\n❌ HTTP {e.code}: {body}')
    sys.exit(1)
except Exception as e:
    print(f'\n❌ 错误: {e}')
    sys.exit(1)
