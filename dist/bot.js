import { Bot, InputFile, InlineKeyboard } from 'grammy';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { timingSafeEqual } from 'crypto';
import util from 'util';
import AdmZip from 'adm-zip';
import dotenv from 'dotenv';
dotenv.config();
const execAsync = util.promisify(exec);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const BOT_PASSWORD = process.env.BOT_PASSWORD || '';
if (!BOT_TOKEN) {
    console.error('❌ 请在 .env 中配置 TELEGRAM_BOT_TOKEN');
    process.exit(1);
}
if (!BOT_PASSWORD) {
    console.error('❌ 请在 .env 中配置 BOT_PASSWORD');
    process.exit(1);
}
const bot = new Bot(BOT_TOKEN);
const authorizedUserIds = new Set();
bot.use(async (ctx, next) => {
    const messageText = ctx.message && 'text' in ctx.message ? ctx.message.text : undefined;
    const chatId = ctx.chat?.id;
    const messageId = ctx.message?.message_id;
    const passwordCommand = messageText?.match(/^\/password(?:@\w+)?(?:\s+([\s\S]*))?$/);
    if (passwordCommand) {
        if (ctx.chat?.type !== 'private') {
            if (chatId !== undefined && messageId !== undefined) {
                await ctx.api.deleteMessage(chatId, messageId).catch(() => { });
            }
            await ctx.reply('🔐 请在与机器人的私聊中发送密码，不能在群组中验证。');
            return;
        }
        const submittedPassword = (passwordCommand[1] || '').trim();
        const submittedBuffer = Buffer.from(submittedPassword);
        const expectedBuffer = Buffer.from(BOT_PASSWORD);
        const isValid = submittedBuffer.length === expectedBuffer.length && timingSafeEqual(submittedBuffer, expectedBuffer);
        if (chatId !== undefined && messageId !== undefined) {
            await ctx.api.deleteMessage(chatId, messageId).catch(() => { });
        }
        if (isValid && ctx.from) {
            authorizedUserIds.add(ctx.from.id);
            await ctx.reply('✅ 密码正确，已授权使用机器人。');
        }
        else {
            await ctx.reply('❌ 密码错误。请发送 <code>/password 密码值</code> 重试。', { parse_mode: 'HTML' });
        }
        return;
    }
    if (ctx.from && authorizedUserIds.has(ctx.from.id)) {
        await next();
        return;
    }
    if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: '请先私聊机器人发送 /password 密码值', show_alert: true }).catch(() => { });
    }
    else if (messageText && (/^\//.test(messageText) || extractPixivId(messageText))) {
        await ctx.reply('🔒 请先私聊机器人发送 <code>/password 密码值</code> 完成验证。', { parse_mode: 'HTML' });
    }
});
const parseTaskQueue = [];
let activeParseTask = null;
let nextParseTaskId = 1;
function enqueueParseTask(chatId, userId, run) {
    parseTaskQueue.push({ id: nextParseTaskId++, chatId, userId, run });
    if (!activeParseTask) {
        void drainParseQueue();
    }
}
async function drainParseQueue() {
    while (parseTaskQueue.length > 0) {
        const task = parseTaskQueue.shift();
        if (!task)
            continue;
        const abortController = new AbortController();
        activeParseTask = {
            id: task.id,
            chatId: task.chatId,
            userId: task.userId,
            abortController
        };
        try {
            await task.run(abortController.signal);
        }
        finally {
            if (activeParseTask?.id === task.id) {
                activeParseTask = null;
            }
        }
    }
}
function stopCurrentParseTask(chatId, userId) {
    if (!activeParseTask)
        return false;
    const isSameChat = activeParseTask.chatId === chatId;
    const isSameUser = activeParseTask.userId === userId;
    if (!isSameChat && !isSameUser)
        return false;
    activeParseTask.abortController.abort();
    return true;
}
const SUBSCRIPTION_FILE = path.join(path.resolve(process.env.DATA_DIR || './data'), 'subscriptions.json');
const GROUP_CHAT_ID = Number(process.env.GROUP_CHAT_ID);
function getConfiguredTargetChatIds(originalChatId) {
    if (!Number.isSafeInteger(GROUP_CHAT_ID) || GROUP_CHAT_ID === 0 || GROUP_CHAT_ID === originalChatId)
        return [];
    return [GROUP_CHAT_ID];
}
async function relayToConfiguredChats(ctx, originalChatId, sendAction) {
    const targetIds = getConfiguredTargetChatIds(originalChatId);
    for (const targetChatId of targetIds) {
        try {
            await sendAction(targetChatId);
        }
        catch (e) {
            console.warn(`转发到目标聊天 ${targetChatId} 失败:`, e.message);
        }
    }
}
async function relayTextToConfiguredChats(ctx, originalChatId, text, options) {
    await relayToConfiguredChats(ctx, originalChatId, async (targetChatId) => {
        await ctx.api.sendMessage(targetChatId, text, options);
    });
}
function loadSubscriptions() {
    try {
        if (!fs.existsSync(SUBSCRIPTION_FILE))
            return {};
        const raw = fs.readFileSync(SUBSCRIPTION_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    catch (e) {
        console.warn('读取订阅缓存失败:', e.message);
        return {};
    }
}
function saveSubscriptions(data) {
    try {
        fs.writeFileSync(SUBSCRIPTION_FILE, JSON.stringify(data, null, 2), 'utf8');
    }
    catch (e) {
        console.warn('保存订阅缓存失败:', e.message);
    }
}
function listSubscriptions(chatId) {
    const data = loadSubscriptions();
    return data[String(chatId)] || [];
}
function setSubscription(chatId, artistId, artistName) {
    const data = loadSubscriptions();
    const key = String(chatId);
    const entries = data[key] || [];
    const exists = entries.some((item) => item.artistId === artistId);
    if (exists)
        return false;
    entries.push({ artistId, artistName, addedAt: Date.now() });
    data[key] = entries;
    saveSubscriptions(data);
    return true;
}
function removeSubscription(chatId, artistId) {
    const data = loadSubscriptions();
    const key = String(chatId);
    const entries = data[key] || [];
    const next = entries.filter((item) => item.artistId !== artistId);
    if (next.length === entries.length)
        return false;
    if (next.length === 0) {
        delete data[key];
    }
    else {
        data[key] = next;
    }
    saveSubscriptions(data);
    return true;
}
async function notifySubscribedArtists(chatId, illust) {
    if (!illust?.userId)
        return;
    const subs = listSubscriptions(chatId);
    if (!subs.length)
        return;
    const targetArtistId = String(illust.userId || illust.author?.id || '');
    const targetArtistName = illust.userName || illust.author?.name || '画师';
    const matched = subs.find((item) => item.artistId === targetArtistId);
    if (!matched)
        return;
    const channel = `https://www.pixiv.net/users/${targetArtistId}`;
    await bot.api.sendMessage(chatId, `🔔 你订阅的画师 <b>${escapeHtml(targetArtistName)}</b> 发布了新作品：\n🆔 <code>${targetArtistId}</code>\n🔗 <a href="${channel}">查看主页</a>`, {
        parse_mode: 'HTML'
    }).catch(() => { });
}
// 持久化存储目录与动态 Cookie 管理
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}
const COOKIE_FILE = path.join(DATA_DIR, 'cookie.txt');
// 启动时优先读取已保存的 cookie.txt，其次读取环境变量
let currentPixivCookie = '';
if (fs.existsSync(COOKIE_FILE)) {
    try {
        currentPixivCookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
        console.log('📦 已从本地持久化文件加载 Pixiv Cookie');
    }
    catch (e) {
        console.warn('读取本地 Cookie 文件失败:', e.message);
    }
}
if (!currentPixivCookie && process.env.PIXIV_COOKIE) {
    currentPixivCookie = process.env.PIXIV_COOKIE.trim();
}
function getPixivHeaders(referer) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': referer || 'https://www.pixiv.net/',
    };
    if (currentPixivCookie) {
        headers['Cookie'] = currentPixivCookie.startsWith('PHPSESSID=')
            ? currentPixivCookie
            : `PHPSESSID=${currentPixivCookie}`;
    }
    return headers;
}
function runShellCommand(command, signal) {
    return new Promise((resolve, reject) => {
        const child = exec(command, { maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => {
            if (signal?.aborted) {
                reject(new Error('任务已被取消'));
                return;
            }
            if (error) {
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
        if (signal) {
            const onAbort = () => {
                if (!child.killed) {
                    child.kill('SIGTERM');
                }
                reject(new Error('任务已被取消'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
            child.on('exit', () => {
                signal.removeEventListener('abort', onAbort);
            });
        }
    });
}
// 缓存与流式下载图片 Buffer（彻底规避 Telegram WEBPAGE_CURL_FAILED 错误）
async function fetchImageBuffer(url, referer = 'https://www.pixiv.net/', signal) {
    if (!url)
        return null;
    if (signal?.aborted)
        return null;
    try {
        const res = await axios.get(url, {
            responseType: 'arraybuffer',
            headers: getPixivHeaders(referer),
            timeout: 15000,
            signal,
        });
        return Buffer.from(res.data);
    }
    catch (error) {
        if (signal?.aborted || error?.code === 'ERR_CANCELED' || error?.message === '任务已被取消') {
            return null;
        }
        return null;
    }
}
function extractPixivId(text) {
    if (!text)
        return null;
    const match = text.match(/(?:artworks\/|illust_id=|i\/|pixiv\.net\/[^\d]*|\b)([0-9]{6,12})\b/i);
    return match ? match[1] : null;
}
function formatArtworkCaption(illust) {
    const title = illust.title || illust.illustTitle || '无标题';
    const authorName = illust.userName || illust.author?.name || '未知画师';
    const authorId = illust.userId || illust.author?.id || '';
    const id = illust.id || illust.illustId;
    const isR18 = illust.xRestrict === 1 || illust.xRestrict === 2;
    const tags = (illust.tags?.tags || illust.tags || [])
        .slice(0, 6)
        .map((t) => `#${(typeof t === 'string' ? t : t.tag).replace(/[\s\-]/g, '_')}`)
        .join(' ');
    return [
        `🎨 <b>${escapeHtml(title)}</b> ${isR18 ? '🔞 [R-18]' : ''}`,
        `👤 画师: <a href="https://www.pixiv.net/users/${authorId}">${escapeHtml(authorName)}</a>`,
        `🆔 作品 ID: <code>${id}</code> | 页数: <b>${illust.pageCount || 1}P</b>`,
        illust.width && illust.height ? `📐 尺寸: ${illust.width}x${illust.height}` : '',
        tags ? `🏷️ ${tags}` : '',
        `🔗 <a href="https://www.pixiv.net/artworks/${id}">在 Pixiv 原站查看</a>`
    ].filter(Boolean).join('\n');
}
function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
async function fetchArtworkDetails(illustId, signal) {
    if (signal?.aborted) {
        throw new Error('任务已被取消');
    }
    try {
        const res = await axios.get(`https://www.pixiv.net/ajax/illust/${illustId}`, {
            headers: getPixivHeaders(`https://www.pixiv.net/artworks/${illustId}`),
            timeout: 10000,
            signal,
        });
        if (res.data?.body) {
            return res.data.body;
        }
    }
    catch (err) {
        if (signal?.aborted || err?.code === 'ERR_CANCELED' || err?.message === '任务已被取消') {
            throw new Error('任务已被取消');
        }
        console.warn(`Pixiv Ajax 直接获取受限，切换为镜像解析: ${err.message}`);
    }
    return {
        id: illustId,
        title: `Pixiv Artwork #${illustId}`,
        userName: 'Pixiv Artist',
        userId: '0',
        pageCount: 1,
        illustType: 0,
        width: 1920,
        height: 1080,
        tags: ['pixiv', 'illustration'],
        urls: {
            original: `https://pixiv.cat/${illustId}.jpg`
        }
    };
}
// 将 Ugoira 动图下载并转换为 MP4 / GIF (全面优化大文件下载超时、FFmpeg 缓冲与 50MB 限制)
async function convertUgoira(illustId, outputType, signal) {
    if (signal?.aborted) {
        return { ok: false, isCookieMissing: false, error: '任务已被取消' };
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ugoira-${illustId}-`));
    const zipPath = path.join(tmpDir, 'ugoira.zip');
    const extractDir = path.join(tmpDir, 'frames');
    const outputPath = path.join(tmpDir, `result.${outputType}`);
    try {
        // 1. 获取 Ugoira 元数据 (帧间隔与时间)
        let metaRes;
        try {
            metaRes = await axios.get(`https://www.pixiv.net/ajax/illust/${illustId}/ugoira_meta`, {
                headers: getPixivHeaders(`https://www.pixiv.net/artworks/${illustId}`),
                timeout: 15000,
                signal,
            });
        }
        catch (e) {
            if (signal?.aborted || e?.code === 'ERR_CANCELED' || e?.message === '任务已被取消') {
                return { ok: false, isCookieMissing: false, error: '任务已被取消' };
            }
            const is404 = e.response?.status === 404;
            return { ok: false, isCookieMissing: is404, error: is404 ? '需要登录 Cookie 才能获取帧列表' : (e.message || '网络连接超时') };
        }
        const meta = metaRes.data?.body;
        if (!meta || (!meta.src && !meta.originalSrc) || !meta.frames || meta.frames.length === 0) {
            return { ok: false, isCookieMissing: true, error: '未获取到关键帧数据' };
        }
        // 2. 下载 ZIP 压缩包 (优先使用官方 Web 优化流 meta.src，体积小且不丢帧；大文件超时设为 120 秒)
        const downloadUrl = meta.src || meta.originalSrc;
        console.log(`📥 正在下载 Ugoira 动图 ZIP: ${downloadUrl}`);
        const zipDownload = await axios.get(downloadUrl, {
            responseType: 'arraybuffer',
            headers: getPixivHeaders('https://www.pixiv.net/'),
            timeout: 120000,
            signal,
        });
        fs.writeFileSync(zipPath, Buffer.from(zipDownload.data));
        // 3. 解压缩帧文件
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(extractDir, true);
        // 4. 构建 FFmpeg concat demuxer 输入清单文件 (按 Pixiv 官方指定每帧精确毫秒延迟)
        const concatFilePath = path.join(tmpDir, 'input.txt');
        let concatContent = '';
        let totalDurationMs = 0;
        for (const frame of meta.frames) {
            const frameDelaySec = (frame.delay || 80) / 1000;
            totalDurationMs += (frame.delay || 80);
            concatContent += `file '${path.join(extractDir, frame.file)}'\n`;
            concatContent += `duration ${frameDelaySec.toFixed(4)}\n`;
        }
        if (meta.frames.length > 0) {
            concatContent += `file '${path.join(extractDir, meta.frames[meta.frames.length - 1].file)}'\n`;
        }
        fs.writeFileSync(concatFilePath, concatContent, 'utf8');
        // 5. 调用 FFmpeg 渲染 (添加 scale 限制最大宽度 1920，避免 4K 动图导致文件超 50MB 无法发送；添加 maxBuffer 防止管道溢出)
        if (outputType === 'mp4') {
            await runShellCommand(`ffmpeg -y -loglevel warning -f concat -safe 0 -i "${concatFilePath}" -vf "scale='min(1920,iw)':-2" -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 23 -movflags +faststart "${outputPath}"`, signal);
            // 如果生成的 MP4 超过 48MB (Telegram Bot 上限为 50MB)，进行二次自适应降采样压缩
            const stat = fs.statSync(outputPath);
            if (stat.size > 48 * 1024 * 1024) {
                console.log(`⚠️ MP4 体积过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，执行自动画质压缩以适应 Telegram 50MB 限制...`);
                const compressedPath = path.join(tmpDir, 'compressed.mp4');
                await runShellCommand(`ffmpeg -y -loglevel warning -i "${outputPath}" -vf "scale='min(1280,iw)':-2" -c:v libx264 -preset veryfast -crf 28 "${compressedPath}"`, signal);
                fs.renameSync(compressedPath, outputPath);
            }
        }
        else {
            const palettePath = path.join(tmpDir, 'palette.png');
            await runShellCommand(`ffmpeg -y -loglevel warning -f concat -safe 0 -i "${concatFilePath}" -vf "fps=15,scale='min(800,iw)':-2:flags=lanczos,palettegen" "${palettePath}"`, signal);
            await runShellCommand(`ffmpeg -y -loglevel warning -f concat -safe 0 -i "${concatFilePath}" -i "${palettePath}" -lavfi "fps=15,scale='min(800,iw)':-2 [x]; [x][1:v] paletteuse" "${outputPath}"`, signal);
        }
        return { ok: true, filePath: outputPath, duration: Math.max(1, Math.round(totalDurationMs / 1000)) };
    }
    catch (error) {
        if (signal?.aborted || error?.message === '任务已被取消') {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            return { ok: false, isCookieMissing: false, error: '任务已被取消' };
        }
        console.error('Ugoira 转换报错:', error);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return { ok: false, isCookieMissing: false, error: error.message || '转码处理异常' };
    }
}
// 构建单页逐页翻页键盘 (上一页 / 当前页 / 下一页)
function buildPageKeyboard(illustId, currentPage, totalPages) {
    const kb = new InlineKeyboard();
    if (currentPage > 0) {
        kb.text('⬅️ 上一页', `page:${illustId}:${currentPage - 1}:${totalPages}`);
    }
    else {
        kb.text('⏹️ 首页', 'noop');
    }
    kb.text(`📖 ${currentPage + 1} / ${totalPages}P`, 'noop');
    if (currentPage < totalPages - 1) {
        kb.text('下一页 ➡️', `page:${illustId}:${currentPage + 1}:${totalPages}`);
    }
    else {
        kb.text('末页 ⏹️', 'noop');
    }
    kb.row();
    if (totalPages > 10) {
        const currentBatch = Math.floor(currentPage / 10);
        const totalBatches = Math.ceil(totalPages / 10);
        kb.text(`📚 批次导航 (第 ${currentBatch + 1}/${totalBatches} 批)`, `batchNav:${illustId}:${currentBatch}:${totalPages}`);
        kb.row();
    }
    kb.text(`⬇️ 下载第 ${currentPage + 1}P 原图`, `doc:${illustId}:${currentPage}`);
    kb.url('🔗 Pixiv 原网', `https://www.pixiv.net/artworks/${illustId}`);
    return kb;
}
function buildPageDownloadButtons(illustId, totalPages, startPage = 0) {
    const kb = new InlineKeyboard();
    const pageStart = startPage;
    const pageEnd = Math.min(totalPages, startPage + 10);
    for (let page = pageStart; page < pageEnd; page++) {
        kb.text(`P${page + 1}`, `doc:${illustId}:${page}`);
        if ((page - pageStart + 1) % 5 === 0) {
            kb.row();
        }
    }
    if ((pageEnd - pageStart) % 5 !== 0) {
        kb.row();
    }
    const currentBatch = Math.floor(pageStart / 10);
    const totalBatches = Math.ceil(totalPages / 10);
    if (pageStart > 0) {
        kb.text('⬅️ 上一批', `pageDownloadBatch:${illustId}:${Math.max(0, pageStart - 10)}:${totalPages}`);
    }
    else {
        kb.text('⏹️ 首页', 'noop');
    }
    kb.text(`📦 第 ${currentBatch + 1}/${totalBatches} 批`, 'noop');
    if (pageEnd < totalPages) {
        kb.text('下一批 ➡️', `pageDownloadBatch:${illustId}:${pageEnd}:${totalPages}`);
    }
    else {
        kb.text('末页 ⏹️', 'noop');
    }
    kb.row();
    kb.text('📥 获取全部', `all:${illustId}:${totalPages}`);
    kb.row();
    kb.text(`⬇️ 下载第 ${pageStart + 1}P 原图`, `doc:${illustId}:${pageStart}`);
    kb.url('🔗 Pixiv 原网', `https://www.pixiv.net/artworks/${illustId}`);
    return kb;
}
// 构建整批相册翻页键盘 (上一批 / 下一批)
function buildBatchKeyboard(illustId, currentBatch, totalBatches, totalPages) {
    const kb = new InlineKeyboard();
    const startP = currentBatch * 10 + 1;
    const endP = Math.min(totalPages, (currentBatch + 1) * 10);
    for (let page = startP - 1; page < endP; page++) {
        kb.text(`P${page + 1}`, `doc:${illustId}:${page}`);
        if ((page - (startP - 1) + 1) % 5 === 0) {
            kb.row();
        }
    }
    if ((endP - (startP - 1)) % 5 !== 0) {
        kb.row();
    }
    if (currentBatch > 0) {
        kb.text('⬅️ 上一批', `album:${illustId}:${currentBatch - 1}:${totalPages}`);
    }
    else {
        kb.text('⏹️ 首页', 'noop');
    }
    kb.text(`📦 第 ${currentBatch + 1} / ${totalBatches} 批`, 'noop');
    if (currentBatch < totalBatches - 1) {
        kb.text('下一批 ➡️', `album:${illustId}:${currentBatch + 1}:${totalPages}`);
    }
    else {
        kb.text('末页 ⏹️', 'noop');
    }
    kb.row();
    kb.text('📥 获取全部', `all:${illustId}:${totalPages}`);
    kb.text('📦 ZIP 下载', `zip:${illustId}`);
    kb.row();
    kb.text(`⬇️ 下载第 ${startP}P 原图`, `doc:${illustId}:${startP - 1}`);
    kb.url('🔗 Pixiv 原网', `https://www.pixiv.net/artworks/${illustId}`);
    return kb;
}
function buildZipKeyboard(illustId) {
    const kb = new InlineKeyboard();
    kb.text('📦 下载整作品 ZIP', `zip:${illustId}`);
    kb.url('🔗 Pixiv 原网', `https://www.pixiv.net/artworks/${illustId}`);
    return kb;
}
bot.command('start', async (ctx) => {
    await ctx.reply(`👋 <b>欢迎使用 Pixiv 原画 & 动图解析下载机器人！</b>\n\n` +
        `• 发送分享链接或作品 ID 即可自动解析下载\n` +
        `• 支持多图相册分批推送与单页逐页翻页\n` +
        `• 发送 <code>/cookie</code> 可在线配置 Pixiv Cookie 解锁 R-18`, { parse_mode: 'HTML' });
});
bot.command('help', async (ctx) => {
    await ctx.reply(`💡 <b>Pixiv Bot 使用帮助:</b>\n\n` +
        `• 发送分享链接即自动解析下载\n` +
        `• 多图作品支持【上一页/下一页】与【上一批/下一批】相册\n` +
        `• 发送 <code>/stop</code> 可中断当前解析任务\n` +
        `• 发送 <code>/queue</code> 查看任务队列\n` +
        `• 发送 <code>/status</code> 查看当前状态\n` +
        `• 发送 <code>/cancel</code> 取消当前任务\n` +
        `• 解析结果会同步转发到 .env 中配置的群组\n` +
        `• 发送 <code>/sub 画师ID</code> 订阅画师更新\n` +
        `• 发送 <code>/subs</code> 列出已订阅画师\n` +
        `• 发送 <code>/cookie</code> 可在线配置 Pixiv Cookie`, { parse_mode: 'HTML' });
});
bot.command('chatid', async (ctx) => {
    await ctx.reply(`💬 当前聊天 ID：<code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' });
});
bot.command('groupid', async (ctx) => {
    await ctx.reply(`👥 当前群组 ID：<code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' });
});
bot.command('queue', async (ctx) => {
    const totalQueue = parseTaskQueue.length;
    const current = activeParseTask && activeParseTask.chatId === ctx.chat.id && activeParseTask.userId === (ctx.from?.id ?? 0)
        ? `当前处理中: #${activeParseTask.id}`
        : '当前无你自己的正在处理任务';
    await ctx.reply(`📋 <b>任务队列状态</b>\n\n• 总排队数: <code>${totalQueue}</code>\n• ${current}`, { parse_mode: 'HTML' });
});
bot.command('status', async (ctx) => {
    const userId = ctx.from?.id ?? 0;
    const isActive = activeParseTask && activeParseTask.chatId === ctx.chat.id && activeParseTask.userId === userId;
    const queueCount = parseTaskQueue.filter((task) => task.chatId === ctx.chat.id && task.userId === userId).length;
    await ctx.reply(`🟢 <b>当前状态</b>\n\n` +
        `• 处理状态: ${isActive ? '运行中' : '空闲'}\n` +
        `• 你所在聊天的待处理任务: <code>${queueCount}</code>\n` +
        `• 可用命令: <code>/queue</code> / <code>/cancel</code> / <code>/stop</code>`, { parse_mode: 'HTML' });
});
bot.command('cancel', async (ctx) => {
    const userId = ctx.from?.id ?? 0;
    const current = activeParseTask && activeParseTask.chatId === ctx.chat.id && activeParseTask.userId === userId;
    const removed = parseTaskQueue.filter((task) => task.chatId === ctx.chat.id && task.userId === userId);
    if (!current && removed.length === 0) {
        await ctx.reply('ℹ️ 当前没有可取消的任务。');
        return;
    }
    if (current) {
        stopCurrentParseTask(ctx.chat.id, userId);
    }
    const nextQueue = parseTaskQueue.filter((task) => !(task.chatId === ctx.chat.id && task.userId === userId));
    parseTaskQueue.length = 0;
    for (const task of nextQueue)
        parseTaskQueue.push(task);
    await ctx.reply(`🛑 已取消你当前聊天中的任务，剩余排队数：<code>${parseTaskQueue.length}</code>`, { parse_mode: 'HTML' });
});
bot.command('stop', async (ctx) => {
    const stopped = stopCurrentParseTask(ctx.chat.id, ctx.from?.id ?? 0);
    if (!stopped) {
        await ctx.reply('ℹ️ 当前没有正在解析的任务，或该任务不属于当前聊天。');
        return;
    }
    await ctx.reply('⏹️ 已停止当前解析任务，后续任务将按队列继续执行。');
});
bot.command('sub', async (ctx) => {
    const text = ctx.message?.text || '';
    const args = text.trim().split(/\s+/).slice(1);
    const artistId = args[0]?.trim();
    if (!artistId) {
        await ctx.reply(`📌 用法：<code>/sub 画师ID</code>\n例如：<code>/sub 123456</code>`, { parse_mode: 'HTML' });
        return;
    }
    const added = setSubscription(ctx.chat.id, artistId, args.slice(1).join(' ') || undefined);
    if (!added) {
        await ctx.reply(`ℹ️ 已经订阅过画师 <code>${artistId}</code> 了。`, { parse_mode: 'HTML' });
        return;
    }
    await ctx.reply(`✅ 已订阅画师 <code>${artistId}</code>，该画师有新作品时会通知你。`, { parse_mode: 'HTML' });
});
bot.command('unsub', async (ctx) => {
    const text = ctx.message?.text || '';
    const artistId = text.trim().split(/\s+/).slice(1).join(' ').trim();
    if (!artistId) {
        await ctx.reply(`📌 用法：<code>/unsub 画师ID</code>`, { parse_mode: 'HTML' });
        return;
    }
    const removed = removeSubscription(ctx.chat.id, artistId);
    await ctx.reply(removed ? `✅ 已取消订阅 <code>${artistId}</code>。` : `ℹ️ 当前没有订阅 <code>${artistId}</code>。`, { parse_mode: 'HTML' });
});
bot.command('subs', async (ctx) => {
    const entries = listSubscriptions(ctx.chat.id);
    if (!entries.length) {
        await ctx.reply('📭 你当前还没有订阅任何画师。\n用法：<code>/sub 画师ID</code>', { parse_mode: 'HTML' });
        return;
    }
    const lines = entries.map((item) => `• <code>${item.artistId}</code>${item.artistName ? ` — ${escapeHtml(item.artistName)}` : ''}`);
    await ctx.reply(`📚 <b>已订阅画师</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
});
// 在线动态配置或查看 Pixiv Cookie (热生效，免重启容器)
bot.command('cookie', async (ctx) => {
    const text = ctx.message?.text || '';
    const parts = text.trim().split(/\s+/);
    const arg = parts.slice(1).join(' ').trim();
    if (arg.toLowerCase() === 'clear' || arg === '清除' || arg === '删除') {
        currentPixivCookie = '';
        if (fs.existsSync(COOKIE_FILE)) {
            try {
                fs.unlinkSync(COOKIE_FILE);
            }
            catch { }
        }
        await ctx.reply('🗑️ <b>Pixiv Cookie 已成功清除！</b>\n当前已恢复为免登录公开镜像模式。', { parse_mode: 'HTML' });
        return;
    }
    if (arg) {
        let cleanCookie = arg;
        if (!cleanCookie.includes('=')) {
            cleanCookie = `PHPSESSID=${cleanCookie}`;
        }
        currentPixivCookie = cleanCookie;
        try {
            fs.writeFileSync(COOKIE_FILE, cleanCookie, 'utf8');
        }
        catch (e) {
            console.error('写入 Cookie 文件失败:', e);
        }
        if (ctx.message) {
            await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => { });
        }
        await ctx.reply(`✅ <b>Pixiv Cookie 已成功配置并保存！</b>\n\n` +
            `⚡ <b>即刻生效</b>：无需重启或重新构建 Docker 容器！\n` +
            `🔓 已解锁权限：支持直接解析 R-18 限制级画作与完整 Ugoira 动图 MP4。\n\n` +
            `💡 <i>安全提示：包含 Cookie 的消息已自动撤回。若需清除请发送 <code>/cookie clear</code>。</i>`, { parse_mode: 'HTML' });
        return;
    }
    const hasCookie = Boolean(currentPixivCookie);
    const statusDisplay = hasCookie
        ? '已配置 (已启用全权限及 R-18 动图解析)'
        : '未配置 (当前仅支持全年龄公开画作)';
    await ctx.reply(`🔐 <b>Pixiv Cookie 在线配置中心</b>\n\n` +
        `• <b>当前状态:</b> <code>${statusDisplay}</code>\n\n` +
        `📌 <b>如何设置 Cookie:</b>\n` +
        `发送指令：<code>/cookie 您的PHPSESSID值</code>\n` +
        `例如：<code>/cookie 10381692_a8b9c0d1e2f3...</code>\n\n` +
        `🗑️ <b>如何清除 Cookie:</b>\n` +
        `发送指令：<code>/cookie clear</code>`, { parse_mode: 'HTML' });
});
bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    const illustId = extractPixivId(text);
    if (!illustId)
        return;
    enqueueParseTask(ctx.chat.id, ctx.from?.id ?? 0, async (signal) => {
        const statusMsg = await ctx.reply(`⏳ 正在解析 Pixiv 作品 <code>#${illustId}</code>...`, {
            parse_mode: 'HTML',
            reply_to_message_id: ctx.message.message_id
        });
        try {
            const illust = await fetchArtworkDetails(illustId, signal);
            if (signal.aborted || illust?.error === '任务已被取消') {
                throw new Error('任务已被取消');
            }
            const caption = formatArtworkCaption(illust);
            const isUgoira = illust.illustType === 2;
            const pageCount = illust.pageCount || 1;
            const keyboard = new InlineKeyboard()
                .url('🔗 Pixiv 原网', `https://www.pixiv.net/artworks/${illustId}`)
                .text('⬇️ 下载无损原图 (文件)', `doc:${illustId}:0`)
                .text('📦 下载整作品 ZIP', `zip:${illustId}`);
            if (isUgoira) {
                await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, `🎞️ 正在从 Pixiv 获取关键帧并使用 FFmpeg 渲染动图 (MP4)...`, { parse_mode: 'HTML' });
                const ugoiraResult = await convertUgoira(illustId, 'mp4', signal);
                if (ugoiraResult.ok) {
                    try {
                        await ctx.replyWithVideo(new InputFile(ugoiraResult.filePath), {
                            caption: caption,
                            parse_mode: 'HTML',
                            duration: ugoiraResult.duration,
                            reply_markup: keyboard
                        });
                        await relayToConfiguredChats(ctx, ctx.chat.id, async (targetChatId) => {
                            await ctx.api.sendVideo(targetChatId, new InputFile(ugoiraResult.filePath), {
                                caption: caption,
                                parse_mode: 'HTML',
                                duration: ugoiraResult.duration,
                                reply_markup: keyboard
                            });
                        });
                    }
                    catch (sendErr) {
                        console.warn(`replyWithVideo 发送失败 (${sendErr.message})，降级为文档模式发送 MP4...`);
                        await ctx.replyWithDocument(new InputFile(ugoiraResult.filePath, `pixiv_${illustId}_animation.mp4`), {
                            caption: caption,
                            parse_mode: 'HTML',
                            reply_markup: keyboard
                        });
                        await relayToConfiguredChats(ctx, ctx.chat.id, async (targetChatId) => {
                            await ctx.api.sendDocument(targetChatId, new InputFile(ugoiraResult.filePath, `pixiv_${illustId}_animation.mp4`), {
                                caption: caption,
                                parse_mode: 'HTML',
                                reply_markup: keyboard
                            });
                        });
                    }
                    fs.rmSync(path.dirname(ugoiraResult.filePath), { recursive: true, force: true });
                    await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id).catch(() => { });
                    return;
                }
                else {
                    const failedUgoira = ugoiraResult;
                    if (failedUgoira.error === '任务已被取消') {
                        throw new Error('任务已被取消');
                    }
                    console.warn(`Ugoira 处理失败 (${failedUgoira.error})，回退为单图预览模式`);
                    let failureTip = '';
                    if (failedUgoira.isCookieMissing && !currentPixivCookie) {
                        failureTip = `\n\n⚠️ <i>注意：此作品属于 R-18 动态画作，Pixiv 官方需要登录权限。请发送 <code>/cookie 您的PHPSESSID</code> 配置后重试。</i>`;
                    }
                    else {
                        failureTip = `\n\n⚠️ <i>提示：此动图帧文件较大 (${escapeHtml(failedUgoira.error)})，已为您发送封面预览图。您可点击下方按钮下载原始文件或前往原站查看。</i>`;
                    }
                    const fallbackBuf = await fetchImageBuffer(`https://pixiv.cat/${illustId}.jpg`, 'https://www.pixiv.net/', signal) ||
                        await fetchImageBuffer(`https://pixiv.cat/${illustId}.gif`, 'https://www.pixiv.net/', signal);
                    if (fallbackBuf) {
                        await ctx.replyWithPhoto(new InputFile(fallbackBuf, `${illustId}.jpg`), {
                            caption: caption + failureTip,
                            parse_mode: 'HTML',
                            reply_markup: keyboard
                        });
                        await relayToConfiguredChats(ctx, ctx.chat.id, async (targetChatId) => {
                            await ctx.api.sendPhoto(targetChatId, new InputFile(fallbackBuf, `${illustId}.jpg`), {
                                caption: caption + failureTip,
                                parse_mode: 'HTML',
                                reply_markup: keyboard
                            });
                        });
                    }
                    else {
                        const fallbackText = caption + failureTip + `\n\n🔗 <a href="https://pixiv.cat/${illustId}.jpg">点击查看镜像图片</a>`;
                        await ctx.reply(fallbackText, {
                            parse_mode: 'HTML',
                            reply_markup: keyboard
                        });
                        await relayTextToConfiguredChats(ctx, ctx.chat.id, fallbackText, {
                            parse_mode: 'HTML',
                            reply_markup: keyboard
                        });
                    }
                    await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id).catch(() => { });
                    return;
                }
            }
            await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, `📥 正在获取原画高清数据并传送至 Telegram...`, { parse_mode: 'HTML' });
            if (pageCount === 1) {
                const originalUrl = illust.urls?.original;
                let imgBuf = originalUrl ? await fetchImageBuffer(originalUrl, `https://www.pixiv.net/artworks/${illustId}`, signal) : null;
                if (!imgBuf) {
                    imgBuf = await fetchImageBuffer(`https://pixiv.cat/${illustId}.jpg`, 'https://www.pixiv.net/', signal);
                }
                if (imgBuf) {
                    await ctx.replyWithPhoto(new InputFile(imgBuf, `${illustId}.jpg`), {
                        caption: caption,
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    });
                    await relayToConfiguredChats(ctx, ctx.chat.id, async (targetChatId) => {
                        await ctx.api.sendPhoto(targetChatId, new InputFile(imgBuf, `${illustId}.jpg`), {
                            caption: caption,
                            parse_mode: 'HTML',
                            reply_markup: keyboard
                        });
                    });
                }
                else {
                    const fallbackText = caption + `\n\n🔗 镜像地址: https://pixiv.cat/${illustId}.jpg`;
                    await ctx.reply(fallbackText, {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    });
                    await relayTextToConfiguredChats(ctx, ctx.chat.id, fallbackText, {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    });
                }
            }
            else {
                const totalPages = pageCount;
                const totalBatches = Math.ceil(totalPages / 10);
                const firstBatchCount = Math.min(totalPages, 10);
                const mediaGroup = [];
                for (let i = 0; i < firstBatchCount; i++) {
                    if (signal.aborted) {
                        throw new Error('任务已被取消');
                    }
                    const pageOriginal = illust.urls?.original ? illust.urls.original.replace(/_p0\./, `_p${i}.`) : null;
                    let pBuf = pageOriginal ? await fetchImageBuffer(pageOriginal, `https://www.pixiv.net/artworks/${illustId}`, signal) : null;
                    if (!pBuf) {
                        pBuf = await fetchImageBuffer(`https://pixiv.cat/${illustId}-${i + 1}.jpg`, 'https://www.pixiv.net/', signal);
                    }
                    if (pBuf) {
                        mediaGroup.push({
                            type: 'photo',
                            media: new InputFile(pBuf, `${illustId}_p${i}.jpg`),
                            caption: mediaGroup.length === 0 ? caption : undefined,
                            parse_mode: mediaGroup.length === 0 ? 'HTML' : undefined
                        });
                    }
                }
                if (mediaGroup.length === 1) {
                    await ctx.replyWithPhoto(mediaGroup[0].media, {
                        caption: caption,
                        parse_mode: 'HTML',
                        reply_markup: buildPageDownloadButtons(illustId, totalPages)
                    });
                    await relayToConfiguredChats(ctx, ctx.chat.id, async (targetChatId) => {
                        await ctx.api.sendPhoto(targetChatId, mediaGroup[0].media, {
                            caption: caption,
                            parse_mode: 'HTML',
                            reply_markup: buildPageDownloadButtons(illustId, totalPages)
                        });
                    });
                }
                else if (mediaGroup.length > 1) {
                    await ctx.replyWithMediaGroup(mediaGroup);
                    await relayToConfiguredChats(ctx, ctx.chat.id, async (targetChatId) => {
                        await ctx.api.sendMediaGroup(targetChatId, mediaGroup);
                    });
                    if (totalPages > 10) {
                        const batchText = `📚 <b>${escapeHtml(illust.title || illustId)}</b> (全 ${totalPages}P)\n` +
                            `已发送: 第 <b>1</b> / ${totalBatches} 批 (第 1 - ${firstBatchCount} 张)\n` +
                            `👇 请选择要下载的页码，或继续获取全部：`;
                        const batchKeyboard = buildBatchKeyboard(illustId, 0, totalBatches, totalPages);
                        await ctx.reply(batchText, {
                            parse_mode: 'HTML',
                            reply_markup: batchKeyboard
                        });
                        await relayTextToConfiguredChats(ctx, ctx.chat.id, batchText, {
                            parse_mode: 'HTML',
                            reply_markup: batchKeyboard
                        });
                    }
                    else {
                        const pageText = `📖 <b>原图下载面板</b> (全 ${totalPages}P)\n点击下方序号即可下载当前页原图：`;
                        const pageKeyboard = buildPageDownloadButtons(illustId, totalPages);
                        await ctx.reply(pageText, {
                            parse_mode: 'HTML',
                            reply_markup: pageKeyboard
                        });
                        await relayTextToConfiguredChats(ctx, ctx.chat.id, pageText, {
                            parse_mode: 'HTML',
                            reply_markup: pageKeyboard
                        });
                    }
                }
                else {
                    const fallbackText = caption + `\n\n🔗 查看画集: https://pixiv.cat/${illustId}-1.jpg`;
                    await ctx.reply(fallbackText, {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    });
                    await relayTextToConfiguredChats(ctx, ctx.chat.id, fallbackText, {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    });
                }
            }
            await notifySubscribedArtists(ctx.chat.id, illust).catch(() => { });
            await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id).catch(() => { });
        }
        catch (error) {
            if (signal.aborted || error.message === '任务已被取消') {
                await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id).catch(() => { });
                return;
            }
            console.error('解析错误:', error);
            await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, `❌ <b>解析失败:</b> ${escapeHtml(error.message || '未知异常')}`, { parse_mode: 'HTML' });
        }
    });
});
// 处理内联按钮交互回调 (分页翻页 / 相册批次 / 无损原图下载)
bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data)
        return;
    if (data === 'noop') {
        await ctx.answerCallbackQuery();
        return;
    }
    // 1. 单页逐页翻页 (上一页 / 下一页)
    if (data.startsWith('page:')) {
        const [, illustId, pageStr, totalPagesStr] = data.split(':');
        const targetPage = parseInt(pageStr, 10);
        const totalPages = parseInt(totalPagesStr, 10) || 1;
        await ctx.answerCallbackQuery({ text: `正在翻至第 ${targetPage + 1} / ${totalPages} 页...` });
        const pUrl = `https://pixiv.cat/${illustId}-${targetPage + 1}.jpg`;
        let imgBuf = await fetchImageBuffer(pUrl);
        if (!imgBuf) {
            await ctx.reply(`⚠️ 加载第 ${targetPage + 1}P 失败，可能需要登录权限或图片正在生成缓存。`);
            return;
        }
        const caption = `🎨 <b>Pixiv #${illustId}</b> · 第 <b>${targetPage + 1} / ${totalPages}</b> 页\n` +
            `🔗 <a href="https://www.pixiv.net/artworks/${illustId}">在 Pixiv 原站查看</a>`;
        const newKb = buildPageKeyboard(illustId, targetPage, totalPages);
        try {
            await ctx.editMessageMedia({
                type: 'photo',
                media: new InputFile(imgBuf, `${illustId}_p${targetPage}.jpg`),
                caption: caption,
                parse_mode: 'HTML'
            }, { reply_markup: newKb });
        }
        catch {
            await ctx.replyWithPhoto(new InputFile(imgBuf, `${illustId}_p${targetPage}.jpg`), {
                caption: caption,
                parse_mode: 'HTML',
                reply_markup: newKb
            });
        }
        return;
    }
    // 2. 整批相册翻页 (上一批 10P / 下一批 10P)
    if (data.startsWith('album:')) {
        const [, illustId, batchStr, totalPagesStr] = data.split(':');
        const targetBatch = parseInt(batchStr, 10);
        const totalPages = parseInt(totalPagesStr, 10) || 1;
        const totalBatches = Math.ceil(totalPages / 10);
        const startIdx = targetBatch * 10;
        const endIdx = Math.min(totalPages, (targetBatch + 1) * 10);
        await ctx.answerCallbackQuery({ text: `正在拉取第 ${targetBatch + 1} 批相册 (第 ${startIdx + 1}-${endIdx}P)...` });
        const waitMsg = await ctx.reply(`⏳ 正在下载并打包第 <b>${targetBatch + 1} / ${totalBatches}</b> 批相册 (第 ${startIdx + 1} - ${endIdx}P)...\\n请稍候...`, { parse_mode: 'HTML' });
        const mediaGroup = [];
        for (let i = startIdx; i < endIdx; i++) {
            const pUrl = `https://pixiv.cat/${illustId}-${i + 1}.jpg`;
            const pBuf = await fetchImageBuffer(pUrl);
            if (pBuf) {
                mediaGroup.push({
                    type: 'photo',
                    media: new InputFile(pBuf, `${illustId}_p${i}.jpg`),
                    caption: mediaGroup.length === 0 ? `🎨 Pixiv #${illustId} (第 ${startIdx + 1}-${endIdx}P)` : undefined,
                    parse_mode: mediaGroup.length === 0 ? 'HTML' : undefined
                });
            }
        }
        if (mediaGroup.length > 1) {
            await ctx.replyWithMediaGroup(mediaGroup);
        }
        else if (mediaGroup.length === 1) {
            await ctx.replyWithPhoto(mediaGroup[0].media);
        }
        await ctx.reply(`📚 <b>Pixiv #${illustId}</b> (全 ${totalPages}P)\n` +
            `已发送: 第 <b>${targetBatch + 1}</b> / ${totalBatches} 批 (第 ${startIdx + 1} - ${endIdx} 张)\n` +
            `👇 使用下方按钮可切换上一批/下一批相册：`, {
            parse_mode: 'HTML',
            reply_markup: buildBatchKeyboard(illustId, targetBatch, totalBatches, totalPages)
        });
        await ctx.api.deleteMessage(waitMsg.chat.id, waitMsg.message_id).catch(() => { });
        return;
    }
    // 3. 获取全部图片（整套图集全量下载）
    if (data.startsWith('all:')) {
        const [, illustId, totalPagesStr] = data.split(':');
        const totalPages = parseInt(totalPagesStr, 10) || 1;
        await ctx.answerCallbackQuery({ text: `正在获取全部 ${totalPages} 页原图...` });
        const waitMsg = await ctx.reply(`⏳ 正在获取 <b>Pixiv #${illustId}</b> 全部 ${totalPages} 页原图，可能需要一点时间...`, {
            parse_mode: 'HTML'
        });
        let currentBatch = [];
        for (let page = 0; page < totalPages; page++) {
            const pUrl = `https://pixiv.cat/${illustId}-${page + 1}.jpg`;
            const pBuf = await fetchImageBuffer(pUrl);
            if (!pBuf)
                continue;
            currentBatch.push({
                type: 'photo',
                media: new InputFile(pBuf, `${illustId}_p${page}.jpg`),
                caption: currentBatch.length === 0 ? `🎨 Pixiv #${illustId} · 全部 ${totalPages}P` : undefined,
                parse_mode: currentBatch.length === 0 ? 'HTML' : undefined
            });
            if (currentBatch.length === 10) {
                await ctx.replyWithMediaGroup(currentBatch);
                currentBatch = [];
            }
        }
        if (currentBatch.length > 0) {
            await ctx.replyWithMediaGroup(currentBatch);
        }
        await ctx.api.deleteMessage(waitMsg.chat.id, waitMsg.message_id).catch(() => { });
        return;
    }
    // 4. 整作品 ZIP 下载
    if (data.startsWith('zip:')) {
        const [, illustId] = data.split(':');
        await ctx.answerCallbackQuery({ text: `正在打包整作品 ZIP...` });
        const waitMsg = await ctx.reply(`📦 正在生成 <b>Pixiv #${illustId}</b> 全作品 ZIP，请稍候...`, { parse_mode: 'HTML' });
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pixiv-zip-${illustId}-`));
        const zipPath = path.join(tmpDir, `${illustId}.zip`);
        try {
            const details = await fetchArtworkDetails(illustId);
            const totalPages = details?.pageCount || 1;
            const zip = new AdmZip();
            for (let page = 0; page < totalPages; page++) {
                const pageUrl = details?.urls?.original?.includes('_p0.')
                    ? details.urls.original.replace(/_p0\./, `_p${page}.`)
                    : `https://pixiv.cat/${illustId}-${page + 1}.jpg`;
                const buf = await fetchImageBuffer(pageUrl, `https://www.pixiv.net/artworks/${illustId}`);
                if (!buf)
                    continue;
                zip.addFile(`pixiv_${illustId}_p${page + 1}.jpg`, buf);
            }
            if (zip.getEntries().length === 0) {
                throw new Error('未获取到任何页面内容');
            }
            zip.writeZip(zipPath);
            await ctx.replyWithDocument(new InputFile(zipPath, `${illustId}_all_pages.zip`), {
                caption: `📦 Pixiv #${illustId} 整作品 ZIP`,
                parse_mode: 'HTML'
            });
        }
        catch (e) {
            await ctx.reply(`❌ ZIP 打包失败: ${escapeHtml(e.message || '未知错误')}`, { parse_mode: 'HTML' });
        }
        finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            await ctx.api.deleteMessage(waitMsg.chat.id, waitMsg.message_id).catch(() => { });
        }
        return;
    }
    // 5. 批次导航快捷切换
    if (data.startsWith('batchNav:')) {
        const [, illustId, batchStr, totalPagesStr] = data.split(':');
        const currentBatch = parseInt(batchStr, 10);
        const totalPages = parseInt(totalPagesStr, 10) || 1;
        const totalBatches = Math.ceil(totalPages / 10);
        await ctx.answerCallbackQuery();
        await ctx.reply(`📦 <b>相册批次导航面板</b> (全 ${totalPages}P)\n选择需要获取的相册批次：`, {
            parse_mode: 'HTML',
            reply_markup: buildBatchKeyboard(illustId, currentBatch, totalBatches, totalPages)
        });
        return;
    }
    // 5. 批次分页下载入口
    if (data.startsWith('pageDownloadBatch:')) {
        const [, illustId, startStr, totalPagesStr] = data.split(':');
        const startPage = parseInt(startStr, 10) || 0;
        const totalPages = parseInt(totalPagesStr, 10) || 1;
        await ctx.answerCallbackQuery({ text: `正在显示第 ${startPage + 1} 页起的下载面板...` });
        await ctx.reply(`📄 <b>下载页码面板</b> (第 ${startPage + 1} - ${Math.min(totalPages, startPage + 10)}P)
点击下方序号即可下载当前页原图：`, {
            parse_mode: 'HTML',
            reply_markup: buildPageDownloadButtons(illustId, totalPages, startPage)
        });
        return;
    }
    // 6. 下载无损原图
    if (data.startsWith('doc:')) {
        const parts = data.split(':');
        const id = parts[1];
        const pageIndex = parts[2] ? parseInt(parts[2], 10) : 0;
        await ctx.answerCallbackQuery({ text: `正在下载第 ${pageIndex + 1}P 无损文档原图...` });
        try {
            const pageSuffix = pageIndex > 0 ? `-${pageIndex + 1}` : '';
            const docBuf = await fetchImageBuffer(`https://pixiv.cat/${id}${pageSuffix}.jpg`);
            if (docBuf) {
                await ctx.replyWithDocument(new InputFile(docBuf, `pixiv_${id}_p${pageIndex}.jpg`), {
                    caption: `📄 Pixiv #${id} (第 ${pageIndex + 1}P) 无损原画文档`
                });
            }
            else {
                await ctx.reply(`❌ 下载失败，作品可能需要 Pixiv 登录权限。`);
            }
        }
        catch (e) {
            await ctx.reply(`❌ 发送原图文件失败: ${e.message}`);
        }
        return;
    }
});
console.log('🚀 Pixiv Telegram Bot 正在启动...');
bot.start({
    onStart: (botInfo) => {
        console.log(`✅ 机器人 @${botInfo.username} 启动成功，正在轮询监听消息...`);
    }
});
