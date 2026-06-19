# Cloudflare Pages 部署指引 — 股票知识点测验系统

> 仓库地址：https://github.com/zzhicong001/exam-a-stock.git
> 分支：master
> 项目类型：纯静态站点（HTML + JSON + 图片，无构建步骤）

---

## 一、前置确认

代码已成功推送至 GitHub，仓库根目录结构如下：

```
exam-a-stock/
├── index.html          ← Cloudflare Pages 入口文件
├── stock_quiz.html     ← 原始文件（与 index.html 内容一致）
├── questions.json      ← 题库数据
├── fupan_imgs/         ← 1184 张复盘图片
└── .gitignore
```

旧代码已通过 `git push --force` 全部清除，仓库现在是干净的全新内容。

---

## 二、在 Cloudflare 中创建 Pages 项目

### 方式 A：连接 GitHub（推荐，支持自动部署）

1. **登录 Cloudflare Dashboard**
   打开 https://dash.cloudflare.com/，使用你的 Cloudflare 账号登录。

2. **进入 Pages**
   左侧导航栏点击 **Workers & Pages** → 顶部切换到 **Pages** 标签。

3. **创建项目**
   点击 **Create a project** → 选择 **Connect to Git**。

4. **授权 GitHub**
   - 首次使用会弹出 GitHub 授权页面
   - 点击 **Authorize Cloudflare Pages**，授权访问你的 GitHub
   - 在仓库列表中选择 **Only select repositories**，勾选 `zzhicong001/exam-a-stock`
   - 回到 Cloudflare 后，选择 `exam-a-stock` 仓库

5. **配置构建（关键步骤）**

   | 配置项 | 填写值 |
   |--------|--------|
   | **Project name** | `exam-a-stock`（将决定你的子域名） |
   | **Production branch** | `master` |
   | **Framework preset** | `None` |
   | **Build command** | **留空**（纯静态，无需构建） |
   | **Build output directory** | `/`（根目录，或留空） |
   | **Root directory** | 留空 |

   ⚠️ 重要：本项目是纯静态站点，**不要填任何 build 命令**，Build output directory 填 `/` 或留空即可。

6. **环境变量**
   无需配置任何环境变量。

7. **保存并部署**
   点击 **Save and Deploy**。首次部署需要上传 1184 张图片（约 49MB），预计耗时 1-3 分钟。

### 方式 B：直接上传（无需 GitHub 连接）

如果你不想连接 GitHub，也可以直接拖拽上传：

1. 进入 **Workers & Pages** → **Pages** → **Create a project** → **Upload assets**
2. Project name 填 `exam-a-stock`
3. 将 `H:\buddy\exam` 目录下的所有文件（含 `index.html`、`questions.json`、`fupan_imgs/`）打包成 zip 后拖入
4. 点击 **Deploy site**

---

## 三、部署完成后的访问

部署成功后，Cloudflare 会分配一个地址：

```
https://exam-a-stock.pages.dev
```

直接访问即可使用测验系统。之后每次向 GitHub `master` 分支 push 新代码，Cloudflare 会自动触发重新部署。

---

## 四、常见问题排查

### 1. 图片不显示（404）
- 检查 `questions.json` 中图片路径是否为相对路径（如 `fupan_imgs/xxx.png`）
- 已确认：当前 `questions.json` 使用相对路径，部署后可正常访问

### 2. 中文文件名乱码
- GitHub 和 Cloudflare 均支持 UTF-8 文件名，无需特殊处理
- 若个别图片加载失败，检查文件名中的特殊字符（`&`、空格等）

### 3. 部署后页面空白
- 确认 `index.html` 位于仓库根目录（✅ 已确认）
- 打开浏览器开发者工具 Console 查看报错

### 4. 重新部署 / 回滚
- 进入项目 → **Deployments** 标签
- 可查看历史部署记录，点击任意记录右侧的 **...** → **Rollback to this deployment** 回滚

---

## 五、绑定自定义域名（可选）

1. 进入项目 → **Custom domains** 标签 → **Set up a custom domain**
2. 输入你的域名（需该域名已托管在 Cloudflare）
3. Cloudflare 会自动添加 CNAME 讎录，几分钟后生效

---

**部署遇到问题随时找我。**
