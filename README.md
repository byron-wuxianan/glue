# 胶水采购需求管理系统 - 多人在线版

## 功能

- 🔐 用户登录/注册（多用户共享数据）
- 📊 机型及月生产数量管理
- 📋 BOM 配置（机型 × 位置 × 胶水用量）
- 📦 库存盘点及采购需求计算
- ☁️ 数据实时同步（SQLite 云端数据库）

## 本地开发

```bash
# 安装依赖
npm install

# 初始化数据库（从 database.js 导入初始数据）
npm run init

# 启动服务
npm start
```

访问 http://localhost:3001

## 部署到 Render.com

### 步骤 1：创建 GitHub 仓库

1. 访问 https://github.com/new
2. 创建一个新仓库（例如 `glue-management`）
3. 不要勾选 "Initialize with README"

### 步骤 2：推送代码到 GitHub

```bash
cd glue-calculator/
git init
git add .
git commit -m "初始提交"
git remote add origin https://github.com/你的用户名/你的仓库名.git
git push -u origin main
```

### 步骤 3：部署到 Render.com

1. 访问 https://dashboard.render.com
2. 点击 "New +" → "Web Service"
3. 连接你的 GitHub 仓库
4. 配置：
   - **Name**: `glue-management`（或你喜欢的名字）
   - **Environment**: `Node`
   - **Build Command**: `npm install && npm run init`
   - **Start Command**: `npm start`
   - **Plan**: Free
5. 点击 "Create Web Service"

部署完成后，Render.com 会给你一个网址（例如 `https://glue-management.onrender.com`），所有人可以通过这个网址访问系统。

## 默认账号

- 用户名：`admin`
- 密码：`admin123`

登录后可以在登录界面注册新用户。

## 目录结构

```
glue-calculator/
├── server.js          # 后端服务（Express + SQLite）
├── init-db.js         # 数据库初始化脚本
├── package.json       # Node.js 依赖
├── index.html         # 前端页面
├── chart.umd.min.js   # Chart.js 本地文件
├── database.js        # 初始数据（46机型、85种胶水）
└── glue.db            # SQLite 数据库（部署后自动生成）
```
