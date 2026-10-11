# Pixiv Telegram Downloader & Ugoira Bot 部署指南

本项目是一个专为 Telegram 设计的 **Pixiv 画作解析与动图下载机器人**。只要向机器人发送 Pixiv 的分享链接或作品 ID，机器人将自动获取高清大图、多图相册，或将 **Ugoira 动态图片使用 FFmpeg 无缝转换为 MP4/GIF** 发回给用户。

---

## 🌟 核心特性

1. **全自动链接解析**: 识别 `pixiv.net/artworks/{id}`、`pixiv.me/{id}`、`pixiv.net/i/{id}` 或纯数字 ID。
2. **Ugoira 动图合成**: 自动下载 ZIP 帧序列与毫秒级延迟表，通过 FFmpeg 原生渲染为 H.264 MP4 视频与调色板优化 GIF。
3. **防盗链穿透**: 自动注入 `Referer: https://www.pixiv.net/` 请求头，彻底解决 Telegram 直接发送 `i.pximg.net` 导致的 `403 Forbidden` 报错。
4. **多图相册支持**: 漫画与多图作品自动打包为 Telegram MediaGroup 发送，并提供原画下载入口。
5. **极简部署**: 支持 Docker 容器化一键部署（内置 FFmpeg），不污染宿主机环境。

---

## 🛠️ 第一步：获取 Telegram Bot Token

1. 在 Telegram 中搜索官方机器人 [@BotFather](https://t.me/BotFather) 并点击 `Start`。
2. 发送指令 `/newbot`。
3. 输入你的机器人昵称（例如：`MyPixivDownloaderBot`）。
4. 输入你的机器人用户名（必须以 `bot` 结尾，例如：`mypixiv_download_bot`）。
5. @BotFather 会生成一段 **HTTP API Token**（格式如：`718293849:AAHfkjshd..._s982`）。
6. 将 Token 填入本项目配置中。

---

## 🚀 第二步：在你的服务器上一键部署

### 方式 A：Docker 推荐方式（最省心，已内置 FFmpeg）

1. 连接到你的 Linux 服务器（Ubuntu / Debian / CentOS）：
```bash
mkdir -p /opt/pixiv-bot && cd /opt/pixiv-bot
```

2. 将导出的源码文件上传或解压到该目录。

3. 编辑环境配置文件 `.env`：
```bash
nano .env
# 配置 TELEGRAM_BOT_TOKEN、BOT_PASSWORD、Pixiv Cookie 和目标群组 ID
TELEGRAM_BOT_TOKEN=你的机器人Token
BOT_PASSWORD=请设置一个足够强的密码
PIXIV_COOKIE=
GROUP_CHAT_ID=-1001234567890
```

将机器人拉入目标群组并授予发消息权限。`GROUP_CHAT_ID` 填写该群组的 Telegram chat ID（通常以 `-100` 开头）；解析结果仍会回复原聊天，并额外只转发到此指定群组。留空时不进行群组转发。修改 `.env` 后重启容器生效。

首次使用时，请在与机器人的私聊中发送 `/password 你的密码`。只有验证通过的 Telegram 用户才能使用机器人；密码验证仅限私聊，授权在机器人重启后清除。`BOT_PASSWORD` 必须设置，否则机器人不会启动。

4. 启动容器：
```bash
docker compose up -d --build
```

5. 查看实时日志确认是否启动：
```bash
docker compose logs -f
```
出现 `✅ 机器人启动成功，正在轮询监听消息...` 即表示部署成功！

### 方式 A-2：发布到 GitHub Container Registry

项目已包含 GitHub Actions 工作流。将源码推送到 GitHub 仓库的 `main` 或 `master` 分支后，Actions 会自动构建并推送 `linux/amd64` 与 `linux/arm64` 镜像到 GHCR；推送 `v*` 标签也会发布对应版本标签。

首次推送源码前，确认上传这些文件：`bot.ts`、`package.json`、`package-lock.json`、`tsconfig.json`、`Dockerfile`、`.dockerignore`、`.gitignore`、`.env.example`、`docker-compose.yml`、`docker-compose.ghcr.yml`、`README.md` 和 `.github/workflows/publish-image.yml`。不要上传 `.env`、`node_modules/`、`dist/` 或 `data/`。`.gitignore` 已忽略这些本地文件；若 `.env` 以前已被 Git 跟踪，先运行 `git rm --cached .env` 并提交删除记录。

在项目目录首次推送源码（先在 GitHub 创建一个空仓库，并把下面地址换成自己的仓库地址）：
```powershell
git init -b main
git add .
git status --short
git commit -m "Prepare Docker image publishing"
git remote add origin https://github.com/<用户名>/<仓库名>.git
git push -u origin main
```

然后到 GitHub 仓库的 **Actions** 页面等待 `Publish Docker image` 成功。默认分支对应的镜像地址为 `ghcr.io/<用户名>/<仓库名>:latest`。如果服务器需要匿名拉取，进入该仓库的 **Packages** 设置，将镜像可见性设为 Public；否则服务器需先登录 GHCR。

服务器部署时，用 `.env.example` 创建服务器自己的 `.env`，填写 Telegram Token、机器人密码、Pixiv Cookie、群组 ID 和镜像名，例如 `GHCR_IMAGE=ghcr.io/<用户名>/<仓库名>:latest`，再执行：
```bash
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
docker compose -f docker-compose.ghcr.yml logs -f
```
服务器只需 `docker-compose.ghcr.yml` 和含有真实配置的 `.env`；源码不必放到服务器。运行数据保存在 Docker 命名卷 `pixiv_data` 中。

---

### 方式 B：Node.js 原生运行（适合已有 Node 环境）

1. 安装 FFmpeg：
```bash
# Ubuntu / Debian:
sudo apt update && sudo apt install -y ffmpeg

# CentOS:
sudo dnf install -y epel-release
sudo dnf install -y ffmpeg
```

2. 安装 Node.js 20+ 并安装依赖：
```bash
npm install
```

3. 使用 PM2 守护进程运行：
```bash
npm install -g pm2
pm2 start bot.ts --name pixiv-bot --interpreter tsx
pm2 save
pm2 startup
```

---

## ❓ 常见问题 FAQ

- **Q1: 为什么普通机器人转发 Pixiv 图片会报 403 Forbidden？**  
  因为 Pixiv 的图片源站 `i.pximg.net` 设置了严格的防盗链规则。直接将图片 URL 交给 Telegram 服务器拉取时，Telegram 请求头中没有 `Referer`，就会被拦截。本项目通过在本地服务器流式下载或通过代理中继解决了此问题。

- **Q2: Ugoira 动图为什么需要 FFmpeg？**  
  Pixiv 的动图不是普通的 GIF，而是一个包含多张单独 JPG/PNG 的 ZIP 压缩包加上一份每帧延迟列表。本项目自动解压并使用 FFmpeg 的 concat 滤镜将所有帧严格按照画师设定的延迟毫秒精准拼装为 MP4，画质极高且体积极小。
