# -*- coding: utf-8 -*-
"""
根据题干和 source 重新匹配图片，更新 questions.json。

匹配策略（优先级从高到低）：
1. 找到题目 source 对应的 docx 文档名
2. 在该文档的所有图片中，用题干关键词与图片上下文做相似度匹配
3. 取最相关的 1-2 张图片
4. 如果 source 对应的文档无图片，或匹配度太低，则不分配图片（移除错误图片）
"""
import json, os, re, sys
from difflib import SequenceMatcher

# 加载数据
with open(r'H:\buddy\exam\questions.json', 'r', encoding='utf-8') as f:
    questions = json.load(f)
with open(r'H:\buddy\exam\img_hash_map.json', 'r', encoding='utf-8') as f:
    img_map = json.load(f)

# 按 doc_name 分组图片
doc_to_imgs = {}
for img_fn, info in img_map.items():
    dn = info['doc_name']
    if dn not in doc_to_imgs:
        doc_to_imgs[dn] = []
    doc_to_imgs[dn].append({'filename': img_fn, 'all_text': info['all_text'], 'prev_text': info['prev_text'], 'next_text': info['next_text'], 'index': info['index_in_doc']})

print(f"题库模块数: {len(questions)}")
print(f"有上下文的图片: {len(img_map)} 张")
print(f"涉及的文档: {len(doc_to_imgs)} 个")

# 清理 source 名，用于匹配 doc_name
def clean_source(src):
    s = re.sub(r'\.docx?$', '', src)
    s = re.sub(r'\(\d{4}\.\d{1,2}\.\d{1,2}\)?$', '', s)
    s = s.strip()
    return s

# 提取题干关键词
def get_keywords(q_text):
    # 去标点，分词（简单按空格和标点）
    text = re.sub(r'[，。、；：？！""''（）()\[\]【】《》\s]+', ' ', q_text)
    words = [w.strip() for w in text.split() if len(w.strip()) >= 2]
    return words

# 计算文本相似度
def similarity(text1, text2):
    if not text1 or not text2:
        return 0
    return SequenceMatcher(None, text1, text2).ratio()

# 关键词匹配分数
def keyword_score(keywords, img_text):
    if not img_text or not keywords:
        return 0
    score = 0
    for kw in keywords:
        if kw in img_text:
            score += len(kw)  # 长关键词权重更高
    return score

total_questions = 0
total_changed = 0
total_images_before = 0
total_images_after = 0
change_log = []

for pk, pv in questions.items():
    for q in pv.get('questions', []):
        total_questions += 1
        old_imgs = q.get('images', [])
        total_images_before += len(old_imgs)

        src = q.get('source', '')
        src_clean = clean_source(src)
        q_text = q.get('q', '')
        keywords = get_keywords(q_text)
        analysis = q.get('analysis', '')
        all_q_text = q_text + ' ' + analysis

        # 找对应文档
        best_doc = None
        best_doc_score = 0
        for doc_name in doc_to_imgs:
            # 精确匹配
            if src_clean == doc_name:
                best_doc = doc_name
                best_doc_score = 100
                break
            # 包含匹配
            if src_clean and (src_clean in doc_name or doc_name in src_clean):
                score = len(src_clean) if len(src_clean) > best_doc_score else best_doc_score
                if score > best_doc_score:
                    best_doc = doc_name
                    best_doc_score = score

        new_imgs = []

        if best_doc and best_doc in doc_to_imgs:
            # 在该文档的图片中找最匹配的
            candidates = doc_to_imgs[best_doc]
            scored = []
            for img in candidates:
                kw_score = keyword_score(keywords, img['all_text'])
                sim_score = similarity(all_q_text[:200], img['all_text'][:200]) * 10
                total_score = kw_score + sim_score
                scored.append((total_score, img))

            scored.sort(key=lambda x: -x[0])

            # 取前2张，要求分数>0
            for score, img in scored[:2]:
                if score > 0:
                    new_imgs.append(f"fupan_imgs/{img['filename']}")

            # 如果没有关键词匹配但文档有图片，按 index 取最接近的
            if not new_imgs and candidates:
                # 取文档中第一张图作为兜底（如果文档只有1-2张图）
                if len(candidates) <= 2:
                    for img in candidates:
                        new_imgs.append(f"fupan_imgs/{img['filename']}")
        else:
            # source 没有对应文档或有文档但无图片：不分配图片
            pass

        # 记录变更
        if new_imgs != old_imgs:
            total_changed += 1
            change_log.append({
                'qid': q.get('id'),
                'paper': pk,
                'source': src[:50],
                'old': old_imgs,
                'new': new_imgs,
                'doc_matched': best_doc
            })

        q['images'] = new_imgs
        total_images_after += len(new_imgs)

print(f"\n=== 匹配结果 ===")
print(f"总题目: {total_questions}")
print(f"变更题目: {total_changed}")
print(f"图片总数: {total_images_before} -> {total_images_after}")
print(f"移除图片: {total_images_before - total_images_after}")

# 保存更新后的 questions.json
with open(r'H:\buddy\exam\questions.json', 'w', encoding='utf-8') as f:
    json.dump(questions, f, ensure_ascii=False, indent=2)
print("\n已更新 questions.json")

# 保存变更日志
with open(r'H:\buddy\exam\image_change_log.json', 'w', encoding='utf-8') as f:
    json.dump(change_log, f, ensure_ascii=False, indent=2)
print(f"变更日志: {len(change_log)} 条，已保存 image_change_log.json")

# 统计变更类型
added = sum(1 for c in change_log if len(c['new']) > len(c['old']))
removed = sum(1 for c in change_log if len(c['new']) < len(c['old']))
replaced = sum(1 for c in change_log if len(c['new']) == len(c['old']) and c['new'] != c['old'])
print(f"\n变更类型: 新增图片 {added} 题, 移除图片 {removed} 题, 替换图片 {replaced} 题")
