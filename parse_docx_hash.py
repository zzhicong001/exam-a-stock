# -*- coding: utf-8 -*-
"""
用图片内容 MD5 hash 精确匹配 docx 图片与磁盘图片文件。
遍历磁盘图片，计算 MD5；遍历 docx 提取图片 blob，计算 MD5；建立映射。
"""
import json, os, re, hashlib
from docx import Document
from docx.opc.constants import RELATIONSHIP_TYPE as RT

BASE_DIR = r'E:\炒股\复盘哥'
FUPAN_DIR = r'H:\buddy\exam\fupan_imgs'
OUTPUT = r'H:\buddy\exam\img_hash_map.json'

# 1. 计算磁盘图片的 MD5
print("计算磁盘图片 MD5...")
disk_hashes = {}
for i, fn in enumerate(os.listdir(FUPAN_DIR)):
    fp = os.path.join(FUPAN_DIR, fn)
    try:
        with open(fp, 'rb') as f:
            md5 = hashlib.md5(f.read()).hexdigest()
        disk_hashes[md5] = fn
    except:
        pass
    if (i+1) % 200 == 0:
        print(f"  {i+1}/{len(os.listdir(FUPAN_DIR))}...", flush=True)
print(f"磁盘图片 hash: {len(disk_hashes)} 个")

# 2. 遍历 docx，提取图片 blob，计算 MD5，找上下文
print("\n解析 docx 图片...")
all_docs = []
for root, dirs, files in os.walk(BASE_DIR):
    for fn in files:
        if fn.endswith('.docx') and not fn.startswith('~$'):
            all_docs.append(os.path.join(root, fn))
print(f"待解析: {len(all_docs)} 个 docx")

img_map = {}  # md5 -> { disk_filename, doc_name, prev_text, next_text, index_in_doc }
processed = 0

for doc_path in all_docs:
    doc_name = os.path.basename(doc_path).replace('.docx', '').replace('.doc', '').strip()
    try:
        doc = Document(doc_path)
    except:
        continue

    # 提取段落（文本+图片标记）
    paragraphs = []
    img_count = 0
    for para in doc.paragraphs:
        text = para.text.strip()
        has_img = False
        for run in para.runs:
            if run.element.findall('.//{http://schemas.openxmlformats.org/drawingml/2006/main}blip'):
                has_img = True
                break
            if run.element.findall('.//{urn:schemas-microsoft-com:vml}imagedata'):
                has_img = True
                break
        if has_img:
            paragraphs.append({'type': 'image', 'text': text, 'img_idx': img_count})
            img_count += 1
        elif text:
            paragraphs.append({'type': 'text', 'text': text})

    # 提取所有图片关系并按出现顺序排列
    image_blobs = []
    for rel in doc.part.rels.values():
        if rel.reltype == RT.IMAGE:
            try:
                image_blobs.append(rel.target_part.blob)
            except:
                pass

    # 为每个图片位置找上下文
    img_idx = 0
    for i, p in enumerate(paragraphs):
        if p['type'] != 'image':
            continue
        # 找前后文本
        prev_texts = []
        for j in range(i-1, max(i-4, -1), -1):
            if paragraphs[j]['type'] == 'text' and paragraphs[j]['text']:
                prev_texts.insert(0, paragraphs[j]['text'])
        next_texts = []
        for j in range(i+1, min(i+4, len(paragraphs))):
            if paragraphs[j]['type'] == 'text' and paragraphs[j]['text']:
                next_texts.append(paragraphs[j]['text'])

        prev_text = ' '.join(prev_texts)[-300:] if prev_texts else ''
        next_text = ' '.join(next_texts)[:300] if next_texts else ''
        all_text = (prev_text + ' ' + next_text).strip()

        # 用 blob hash 匹配磁盘文件
        if img_idx < len(image_blobs):
            blob = image_blobs[img_idx]
            md5 = hashlib.md5(blob).hexdigest()
            if md5 in disk_hashes:
                disk_fn = disk_hashes[md5]
                img_map[disk_fn] = {
                    'doc_name': doc_name,
                    'prev_text': prev_text,
                    'next_text': next_text,
                    'all_text': all_text,
                    'index_in_doc': img_idx,
                    'md5': md5
                }
        img_idx += 1

    processed += 1
    if processed % 200 == 0:
        print(f"  {processed}/{len(all_docs)}...", flush=True)

print(f"\n解析完成: {processed} 文档")
print(f"hash 匹配成功的图片: {len(img_map)} / {len(disk_hashes)} 磁盘图片")

with open(OUTPUT, 'w', encoding='utf-8') as f:
    json.dump(img_map, f, ensure_ascii=False, indent=2)
print(f"已保存: {OUTPUT}")

# 统计
matched_docs = set(v['doc_name'] for v in img_map.values())
print(f"匹配涉及的文档: {len(matched_docs)} 个")
