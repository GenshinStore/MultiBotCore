const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    downloadContentFromMessage
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const jsQR = require('jsqr');
const sharp = require('sharp');

sharp.cache(false);
sharp.concurrency(1);

require('events').EventEmitter.defaultMaxListeners = 0;

// ================= BLOCK LOG SAMPAH BAILEYS =================
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, encoding, callback) => {
    const text = chunk?.toString?.() || '';
    if (text.includes('Closing open session') || text.includes('Closing session: SessionEntry')) return true;
    return originalStderrWrite(chunk, encoding, callback);
};

const originalConsoleLog = console.log;
console.log = function () {
    const firstArg = arguments[0];
    if (typeof firstArg === 'string' && (
        firstArg.includes('Closing session: SessionEntry') ||
        firstArg.includes('Closing open session')
    )) return;
    originalConsoleLog.apply(console, arguments);
};

const originalConsoleError = console.error;
console.error = function (...args) {
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    if (text.includes('Closing open session') || text.includes('Closing session: SessionEntry')) return;
    originalConsoleError.apply(console, args);
};

// ================= KONSTANTA & CONFIG =================
const DEFAULT_ADMIN_GROUP = '120363429956751358@g.us';
const DEFAULT_FORWARD_GROUP = '120363408426078537@g.us';
const CONFIG_FILE = './config.json';
const CACHE_TTL_MS = 20 * 1000;

let configData = {
    adminGroups: [DEFAULT_ADMIN_GROUP],
    forwardGroups: [DEFAULT_FORWARD_GROUP],
    forwardMode: true,
    priorityForwardGroup: null
};

// saveConfig didefinisikan sebelum dipakai agar aman
function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2));
}

if (fs.existsSync(CONFIG_FILE)) {
    try {
        configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
        console.error('Gagal membaca config.json, menggunakan default.');
    }
} else {
    saveConfig();
}

// ================= GLOBAL STATE =================
let adminSock = null;
const activeBots = new Map();
const pendingSetups = new Map();
const pendingApprovals = new Map();
const duplicateCache = new Map();
const allBotJids = new Set();

// [FIX] Hanya gunakan satu mekanisme cleanup cache (interval),
// setTimeout per-entry di isDuplicate dihapus karena redundan
setInterval(() => {
    const now = Date.now();
    for (const [key, time] of duplicateCache.entries()) {
        if (now - time > CACHE_TTL_MS) duplicateCache.delete(key);
    }
}, 10000);

// ================= MEDIA QUEUE =================
const mediaQueue = [];
let processingQueue = false;

async function processMediaQueue() {
    if (processingQueue) return;
    processingQueue = true;
    while (mediaQueue.length > 0) {
        const item = mediaQueue.shift();
        try {
            const qrData = await detectQR(item.buffer);
            if (qrData) processExtractedLink(item.sock, qrData, item.label);
        } catch { }
    }
    processingQueue = false;
}

// ================= DOWNLOAD MEDIA =================
async function downloadMedia(mediaMsg, type) {
    try {
        if (mediaMsg.mediaKey) {
            const stream = await downloadContentFromMessage(mediaMsg, type);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            return buffer;
        }
        const downloadUrl = mediaMsg.url ||
            (mediaMsg.directPath ? `https://mmg.whatsapp.net${mediaMsg.directPath}` : null);
        if (downloadUrl) {
            return new Promise((resolve, reject) => {
                https.get(downloadUrl, (res) => {
                    const data = [];
                    res.on('data', chunk => data.push(chunk));
                    res.on('end', () => resolve(Buffer.concat(data)));
                }).on('error', reject);
            });
        }
        throw new Error('Tidak ada url atau mediaKey');
    } catch (error) {
        throw error;
    }
}

// ================= SMART QR SCANNER =================
async function detectQR(buffer) {
    try {
        const baseImg = sharp(buffer).flatten({ background: '#ffffff' });
        const meta = await baseImg.metadata();
        const w = meta.width;
        const h = meta.height;
        if (!w || !h) return null;

        const paddedImg = baseImg.extend({ top: 60, bottom: 60, left: 60, right: 60, background: '#ffffff' });
        const newW = w + 120;
        const newH = h + 120;
        const scale = Math.max(1, 700 / Math.max(newW, newH));
        const finalW = Math.floor(newW * scale);
        const finalH = Math.floor(newH * scale);
        const upscaledImg = paddedImg.resize(finalW, finalH, { kernel: sharp.kernel.nearest });

        const minDim = Math.min(finalW, finalH);
        const size = Math.floor(minDim * 0.85);

        const crops = [
            { img: upscaledImg.clone() },
            { img: upscaledImg.clone().extract({ left: Math.floor((finalW - size) / 2), top: Math.floor((finalH - size) / 2), width: size, height: size }) },
            { img: upscaledImg.clone().extract({ left: 0, top: 0, width: finalW, height: Math.floor(finalH * 0.7) }) }
        ];

        for (const crop of crops) {
            const imgObj = crop.img.resize(600, 600, { fit: 'inside', withoutEnlargement: true });
            const filters = [imgObj, imgObj.clone().greyscale()];
            for (const filter of filters) {
                try {
                    const { data, info } = await filter.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
                    const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height);
                    if (decoded?.data) return decoded.data;
                } catch {
                    continue;
                }
            }
        }
        return null;
    } catch {
        return null;
    }
}

// ================= ANTI DUPLIKAT =================
// [FIX] setTimeout dihapus — cleanup ditangani oleh setInterval di atas
function isDuplicate(link) {
    const hash = crypto.createHash('md5').update(link.trim().replace(/\/$/, '')).digest('hex');
    if (duplicateCache.has(hash)) return true;
    duplicateCache.set(hash, Date.now());
    return false;
}

// ================= PROSES & FORWARD LINK =================
// [FIX] Kirim URL saja (tanpa "\n\nTipe: label") agar tidak memicu WA link preview
// [FIX] forEach fire-and-forget menggantikan Promise.allSettled agar tidak ada overhead wrapper
function processExtractedLink(sock, textRaw, label) {
    if (!textRaw) return;

    const regex = /(?:https?:\/\/)?(?:[\w-]+\.)?(?:dana\.id|gopay\.co\.id|shopeepay\.co\.id)[^\s]*/gi;
    const matches = textRaw.match(regex);
    if (!matches) return;

    matches.forEach(url => {
        const uLower = url.toLowerCase();
        if (uLower.includes('/minta') || uLower.endsWith('dana.id') || uLower.endsWith('dana.id/')) return;
        if (uLower.includes('dana.id') && !uLower.includes('kaget') && !uLower.includes('danakaget')) return;

        const finalUrl = url.startsWith('http') ? url : 'https://' + url;
        if (isDuplicate(finalUrl)) return;

        console.log(`\n🚀 [BERHASIL!] ${finalUrl} (${label})`);

        if (!sock) return;

        let targets = [];
        if (configData.forwardMode === true) {
            targets = configData.forwardGroups;
        } else if (configData.forwardMode === false && configData.priorityForwardGroup) {
            targets = [configData.priorityForwardGroup];
        }

        // Fire-and-forget: kirim URL murni tanpa teks tambahan
        // targets.forEach(target => {
        //     sock.sendMessage(target, { text: finalUrl }).catch(() => { });
        // });
        targets.forEach(target => {
            sock.sendMessage(target, {
                text: `${finalUrl}\n\nTipe: ${label}`
            }).catch(() => { });
        });
    });
}

// ================= WORKER BOT =================
async function startWorkerBot(botId) {
    if (activeBots.has(botId)) return true;

    return new Promise(async (resolve) => {
        const folderName = `auth_info_bot${botId}`;
        if (!fs.existsSync(folderName)) {
            console.log(`[Bot ${botId}] Session tidak ditemukan`);
            return resolve(false);
        }

        try {
            const { state, saveCreds } = await useMultiFileAuthState(folderName);
            const { version } = await fetchLatestBaileysVersion();

            const sock = makeWASocket({
                version,
                auth: state,
                logger: pino({ enabled: false }),
                browser: [`WaBot-${botId}`, 'Chrome', '1.0.0'],
                getMessage: async () => ({ conversation: '' }),
                markOnlineOnConnect: false,
                syncFullHistory: false,
                emitOwnEvents: false,
                fireInitQueries: false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 15000,
                connectTimeoutMs: 15000,
                keepAliveIntervalMs: 10000,
                retryRequestDelayMs: 250,
                maxMsgRetryCount: 1,
                // [FIX] Cegah link preview server-side pada pesan yang dikirim bot
                patchMessageBeforeSending: (msg) => {
                    if (msg.message?.extendedTextMessage) {
                        msg.message.extendedTextMessage.contextInfo = null;
                    }
                    return msg;
                }
            });

            let isResolved = false;

            // [FIX] Gunakan end(Error) bukan ws.close(), timeout diperpendek 30s → 20s
            const timeout = setTimeout(() => {
                if (isResolved) return;
                isResolved = true;
                console.log(`[Bot ${botId}] ❌ Timeout connect`);
                try { sock.end(new Error('connect timeout')); } catch { }
                resolve(false);
            }, 20000);

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;

                if (connection === 'close') {
                    activeBots.delete(botId);
                    const reason = lastDisconnect?.error?.output?.statusCode;
                    console.log(`[Bot ${botId}] 🔴 Connection Closed`);

                    if (!isResolved) {
                        isResolved = true;
                        clearTimeout(timeout);
                        resolve(false);
                    }

                    if (reason !== DisconnectReason.loggedOut && !global.isRestartingAll) {
                        console.log(`[Bot ${botId}] ♻️ Reconnecting...`);
                        setTimeout(() => startWorkerBot(botId), 5000);
                    }

                } else if (connection === 'open') {
                    const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                    allBotJids.add(myJid);
                    activeBots.set(botId, { sock, startTime: Date.now() });
                    console.log(`[Bot ${botId}] 🟢 READY (${myJid})`);

                    if (!isResolved) {
                        isResolved = true;
                        clearTimeout(timeout);
                        resolve(true);
                    }
                }
            });

            sock.ev.on('groups.update', updates => {
                for (const u of updates) {
                    if (u.desc) processExtractedLink(sock, u.desc.toString(), 'Deskripsi Grup');
                }
            });

            sock.ev.on('messages.upsert', async ({ messages, type }) => {
                if (type !== 'notify') return;

                const msg = messages[0];
                if (!msg.message || msg.key.fromMe) return;

                const from = msg.key.remoteJid;
                if (configData.forwardGroups.includes(from) || from === configData.priorityForwardGroup) return;

                const senderRaw = msg.key.participant || msg.key.remoteJid;
                const senderJid = senderRaw ? senderRaw.split(':')[0] + '@s.whatsapp.net' : '';
                if (allBotJids.has(senderJid)) return;

                let m = msg.message;
                if (!m) return;
                if (m.ephemeralMessage) m = m.ephemeralMessage.message;
                if (m.viewOnceMessage) m = m.viewOnceMessage.message;
                if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
                if (m.viewOnceMessageV2Extension) m = m.viewOnceMessageV2Extension.message;
                if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;

                const text = m.conversation || m.extendedTextMessage?.text ||
                    m.imageMessage?.caption || m.videoMessage?.caption || '';
                if (text) processExtractedLink(sock, text, 'Link Teks');

                const imageMsg = m.imageMessage;
                const stickerMsg = m.stickerMessage;

                if (imageMsg || stickerMsg) {
                    const mediaMsg = imageMsg || stickerMsg;
                    const typeMedia = imageMsg ? 'image' : 'sticker';

                    downloadMedia(mediaMsg, typeMedia).then(buffer => {
                        if (mediaQueue.length > 30) return;
                        mediaQueue.push({
                            sock,
                            buffer,
                            label: typeMedia === 'image' ? 'QR Gambar' : 'QR Stiker'
                        });
                        processMediaQueue();
                    }).catch(() => { });
                }
            });

        } catch (err) {
            console.log(`[Bot ${botId}] ❌ Error:`, err.message);
            resolve(false);
        }
    });
}

// ================= ADMIN BOT =================
async function startAdminBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_admin');
    const { version } = await fetchLatestBaileysVersion();

    adminSock = makeWASocket({
        version,
        auth: state,
        logger: pino({ enabled: false }),
        browser: ['MasterCore', 'Chrome', '1.0.0'],
        markOnlineOnConnect: false,
        syncFullHistory: false,
        emitOwnEvents: false,
        fireInitQueries: false,
        defaultQueryTimeoutMs: 15000,
        connectTimeoutMs: 15000,
        keepAliveIntervalMs: 10000,
    });

    adminSock.ev.on('creds.update', saveCreds);

    adminSock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) qrcodeTerminal.generate(qr, { small: true });

        if (connection === 'close') {
            if (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                setTimeout(startAdminBot, 3000);
            } else {
                console.log('Admin logout. Hapus auth_info_admin');
                process.exit(1);
            }
        } else if (connection === 'open') {
            const myJid = adminSock.user.id.split(':')[0] + '@s.whatsapp.net';
            allBotJids.add(myJid);
            console.log('👑 SYSTEM CORE ADMIN READY!');

            const dirs = fs.readdirSync(__dirname).filter(f => f.startsWith('auth_info_bot'));
            for (const dir of dirs) {
                const id = dir.replace('auth_info_bot', '');
                if (!activeBots.has(id)) await startWorkerBot(id);
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    });

    adminSock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const sender = msg.key.participant || msg.key.remoteJid;

        // ===== !idgrup =====
        if (text === '!idgrup' && from.endsWith('@g.us')) {
            await adminSock.sendMessage(from, { text: `*ID Grup Ini:*\n${from}` }, { quoted: msg });
            return;
        }

        const isAnyAdminGroup = configData.adminGroups.includes(from);
        const isDefaultAdminGroup = from === DEFAULT_ADMIN_GROUP;

        if (text.startsWith('!') && !isAnyAdminGroup) return;

        // [FIX] Handler OKE/TIDAK untuk approval reqbot
        // Harus dicek sebelum parsing command lainnya
        const quotedMsgId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
        if (quotedMsgId && pendingApprovals.has(quotedMsgId)) {
            const pendingBotId = pendingApprovals.get(quotedMsgId);
            const response = text.trim().toUpperCase();
            if (response === 'OKE') {
                pendingApprovals.delete(quotedMsgId);
                await adminSock.sendMessage(from, { text: `🟢 Menjalankan Bot ${pendingBotId}...` });
                startWorkerBot(pendingBotId);
            } else if (response === 'TIDAK') {
                pendingApprovals.delete(quotedMsgId);
                const folder = `auth_info_bot${pendingBotId}`;
                if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
                await adminSock.sendMessage(from, { text: `❌ Bot ${pendingBotId} ditolak dan sesi dihapus.` });
            }
            return;
        }

        // Grup admin tambahan hanya boleh command terbatas
        const LIMITED_COMMANDS = ['!list', '!restart', '!restartall'];
        if (!isDefaultAdminGroup && text.startsWith('!')) {
            const cmd = text.split(' ')[0].toLowerCase();
            if (!LIMITED_COMMANDS.includes(cmd)) {
                return adminSock.sendMessage(from, {
                    text: `⚠️ Grup Admin Tambahan hanya bisa menggunakan:\n• !list\n• !restart <id>\n• !restartall`
                });
            }
        }

        const args = text.split(' ');
        const command = args[0].toLowerCase();

        const isSettingCommand = ['!addadmin', '!deladmin', '!addforward', '!delforward', '!mode'].includes(command);
        if (isSettingCommand && !isDefaultAdminGroup) {
            return adminSock.sendMessage(from, {
                text: '⚠️ *Akses Ditolak!*\nPerintah ini hanya dapat dijalankan di Grup Admin Utama.'
            });
        }

        // ===== !info =====
        if (text === '!info') {
            if (!isDefaultAdminGroup) {
                return adminSock.sendMessage(from, { text: '⚠️ Menu info hanya tersedia di Grup Admin Utama.' });
            }
            await adminSock.sendMessage(from, {
                text: `*🤖 SISTEM MULTI-BOT TERINTEGRASI 🤖*

*👑 PERINTAH WORKER BOT*
• *!reqbot <id>* : Meminta penambahan bot.
• *!batal* : Membatalkan proses scan QR.
• *!list* : Melihat bot yang aktif.
• *!stop <id>* : Menghentikan bot.
• *!start <id>* : Menjalankan kembali bot.
• *!restart <id>* : Merestart bot.

*⚙️ MANAJEMEN ADMIN GRUP*
• *!addadmin <id@g.us>* : Menambah grup admin.
• *!deladmin <id@g.us>* : Menghapus grup admin.
• *!listadmin* : Lihat daftar grup admin.

*🚀 MANAJEMEN FORWARD GRUP*
• *!addforward <id@g.us>* : Menambah grup forward.
• *!delforward <id@g.us>* : Menghapus grup forward.
• *!listforward* : Lihat daftar grup & mode.
• *!mode true* : Forward ke SEMUA grup.
• *!mode false <id@g.us>* : Forward ke 1 grup prioritas.

*🔄 SISTEM*
• *!info* : Menampilkan menu ini.
• *!restartall* : Soft-Restart seluruh sistem.`
            }, { quoted: msg });
            return;
        }

        // ===== !addadmin =====
        if (command === '!addadmin') {
            const targetId = args[1];
            if (!targetId?.endsWith('@g.us')) return adminSock.sendMessage(from, { text: '⚠️ Format: !addadmin <id_grup@g.us>' });
            if (configData.adminGroups.includes(targetId)) return adminSock.sendMessage(from, { text: '⚠️ Grup sudah menjadi admin.' });
            configData.adminGroups.push(targetId);
            saveConfig();
            return adminSock.sendMessage(from, { text: `✅ Berhasil menambahkan ${targetId} ke daftar Grup Admin.` });
        }

        // ===== !deladmin =====
        if (command === '!deladmin') {
            const targetId = args[1];
            if (!targetId) return adminSock.sendMessage(from, { text: '⚠️ Format: !deladmin <id_grup>' });
            if (targetId === DEFAULT_ADMIN_GROUP) return adminSock.sendMessage(from, { text: '⚠️ Tidak dapat menghapus Grup Admin Utama!' });
            configData.adminGroups = configData.adminGroups.filter(id => id !== targetId);
            saveConfig();
            return adminSock.sendMessage(from, { text: `✅ Berhasil menghapus ${targetId} dari daftar Grup Admin.` });
        }

        // ===== !listadmin =====
        if (command === '!listadmin') {
            let msgText = `*👑 DAFTAR GRUP ADMIN (${configData.adminGroups.length})*\n`;
            configData.adminGroups.forEach((id, i) => {
                msgText += `\n${i + 1}. ${id}${id === DEFAULT_ADMIN_GROUP ? ' (🌟 Default)' : ''}`;
            });
            return adminSock.sendMessage(from, { text: msgText });
        }

        // ===== !addforward =====
        if (command === '!addforward') {
            const targetId = args[1];
            if (!targetId?.endsWith('@g.us')) return adminSock.sendMessage(from, { text: '⚠️ Format: !addforward <id_grup@g.us>' });
            if (configData.forwardGroups.includes(targetId)) return adminSock.sendMessage(from, { text: '⚠️ Grup sudah ada di daftar forward.' });
            configData.forwardGroups.push(targetId);
            saveConfig();
            return adminSock.sendMessage(from, { text: `✅ Berhasil menambahkan ${targetId} ke daftar Forward.` });
        }

        // ===== !delforward =====
        if (command === '!delforward') {
            const targetId = args[1];
            if (!targetId) return adminSock.sendMessage(from, { text: '⚠️ Format: !delforward <id_grup>' });
            if (targetId === DEFAULT_FORWARD_GROUP) return adminSock.sendMessage(from, { text: '⚠️ Tidak disarankan menghapus Grup Forward Utama. Gunakan !mode false untuk menonaktifkan sementara.' });
            configData.forwardGroups = configData.forwardGroups.filter(id => id !== targetId);
            saveConfig();
            return adminSock.sendMessage(from, { text: `✅ Berhasil menghapus ${targetId} dari daftar Forward.` });
        }

        // ===== !listforward =====
        if (command === '!listforward') {
            let msgText = `*🚀 DAFTAR GRUP FORWARD (${configData.forwardGroups.length})*\nMode: *${configData.forwardMode ? 'ALL (Semua Grup)' : 'SINGLE (Prioritas)'}*\n`;
            if (!configData.forwardMode) msgText += `Target Prioritas: ${configData.priorityForwardGroup}\n`;
            configData.forwardGroups.forEach((id, i) => msgText += `\n${i + 1}. ${id}`);
            return adminSock.sendMessage(from, { text: msgText });
        }

        // ===== !mode =====
        if (command === '!mode') {
            const modeVal = args[1]?.toLowerCase();
            const targetId = args[2];
            if (modeVal === 'true') {
                configData.forwardMode = true;
                configData.priorityForwardGroup = null;
                saveConfig();
                return adminSock.sendMessage(from, { text: '✅ Mode Forward: *TRUE*\nBot akan mengirim link ke SEMUA grup forward yang terdaftar.' });
            } else if (modeVal === 'false') {
                if (!targetId?.endsWith('@g.us')) return adminSock.sendMessage(from, { text: '⚠️ Format: !mode false <id_grup@g.us>' });
                configData.forwardMode = false;
                configData.priorityForwardGroup = targetId;
                saveConfig();
                return adminSock.sendMessage(from, { text: `✅ Mode Forward: *FALSE*\nBot HANYA akan mengirim link ke: ${targetId}` });
            } else {
                return adminSock.sendMessage(from, { text: '⚠️ Format salah. Gunakan:\n!mode true\n!mode false <id_grup>' });
            }
        }

        // ===== !reqbot =====
        if (text.startsWith('!reqbot')) {
            const botId = text.split(' ')[1];
            if (!botId) return adminSock.sendMessage(from, { text: '⚠️ Format: !reqbot <id>' });

            const folderName = `auth_info_bot${botId}`;
            if (activeBots.has(botId) || fs.existsSync(folderName)) {
                return adminSock.sendMessage(from, { text: `⚠️ Bot ID ${botId} sudah ada/aktif.` });
            }

            await adminSock.sendMessage(from, { text: `⏳ Generate QR untuk Bot ${botId}...` });
            let isSetupFinished = false;

            async function connectSetup() {
                if (isSetupFinished) return;
                const { version: v } = await fetchLatestBaileysVersion();
                const { state: tempState, saveCreds: tempSaveCreds } = await useMultiFileAuthState(folderName);

                const tempSock = makeWASocket({
                    version: v, auth: tempState,
                    logger: pino({ enabled: false }),
                    browser: [`Setup-${botId}`, 'Chrome', '1.0.0']
                });

                tempSock.ev.on('creds.update', tempSaveCreds);
                pendingSetups.set(sender, { sock: tempSock, botId });

                tempSock.ev.on('connection.update', async (update) => {
                    const { connection, qr, lastDisconnect } = update;

                    if (qr) {
                        try {
                            const qrBuffer = await qrcode.toBuffer(qr, { scale: 6 });
                            await adminSock.sendMessage(from, {
                                image: qrBuffer,
                                caption: `✅ *QR Login Bot ${botId}*\n\nSilakan scan QR ini. Ketik *!batal* untuk membatalkan.`
                            });
                        } catch { }
                    }

                    if (connection === 'close') {
                        if (isSetupFinished) return;
                        // [FIX] Cek apakah sudah dibatalkan lewat !batal (entry sudah dihapus dari Map)
                        if (!pendingSetups.has(sender)) return;
                        if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                            setTimeout(connectSetup, 2000);
                        } else {
                            pendingSetups.delete(sender);
                            if (fs.existsSync(folderName)) fs.rmSync(folderName, { recursive: true, force: true });
                            await adminSock.sendMessage(from, { text: `❌ Setup Bot dibatalkan.` });
                        }
                    }

                    if (connection === 'open') {
                        isSetupFinished = true;
                        // [FIX] Gunakan end() bukan ws.close()
                        try { tempSock.ev.removeAllListeners(); tempSock.end(new Error('setup done')); } catch { }
                        pendingSetups.delete(sender);

                        const askMsg = await adminSock.sendMessage(from, {
                            text: `🔔 *PERMOHONAN BOT BARU*\n\nUser: @${sender.split('@')[0]}\nBot ID: *${botId}*\n\n👉 Balas (Quote) pesan ini dengan *OKE* untuk menyalakan atau *TIDAK* untuk menolak.`,
                            mentions: [sender]
                        });
                        // Simpan ID pesan agar handler di atas bisa mencocokkan balasan OKE/TIDAK
                        pendingApprovals.set(askMsg.key.id, botId);
                    }
                });
            }
            connectSetup();
            return;
        }

        // ===== !batal =====
        // [FIX] Hapus dari Map DULU sebelum close, agar connectSetup
        // tidak masuk loop reconnect ketika socket ditutup
        if (text === '!batal') {
            if (pendingSetups.has(sender)) {
                const setup = pendingSetups.get(sender);
                pendingSetups.delete(sender);
                try {
                    setup.sock.ev.removeAllListeners();
                    setup.sock.end(new Error('user cancelled'));
                } catch { }
                const folder = `auth_info_bot${setup.botId}`;
                if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
                await adminSock.sendMessage(from, { text: '❌ Proses dibatalkan.' });
            }
            return;
        }

        // ===== !list =====
        if (text === '!list') {
            let reply = `*🔥 DAFTAR BOT AKTIF (${activeBots.size})*\n`;
            for (const [id, data] of activeBots.entries()) {
                const uptime = Math.floor((Date.now() - data.startTime) / 60000);
                reply += `\n🤖 Bot ID: *${id}*\n⏱ Uptime: ${uptime} Menit\n`;
            }
            await adminSock.sendMessage(from, { text: reply });
            return;
        }

        // ===== !stop =====
        if (text.startsWith('!stop')) {
            const id = text.split(' ')[1];
            if (!id) return adminSock.sendMessage(from, { text: '⚠️ Format yang benar: !stop <id>' });

            if (activeBots.has(id)) {
                const botData = activeBots.get(id);
                botData.sock.ev.removeAllListeners();
                botData.sock.end(new Error('manual stop'));
                activeBots.delete(id);
                await adminSock.sendMessage(from, { text: `🛑 Bot ${id} berhasil dihentikan.` });
            } else {
                await adminSock.sendMessage(from, { text: `⚠️ Bot ${id} tidak sedang aktif.` });
            }
            return;
        }

        // ===== !start =====
        if (text.startsWith('!start')) {
            const id = text.split(' ')[1];
            if (!id) return adminSock.sendMessage(from, { text: '⚠️ Format yang benar: !start <id>' });

            if (!activeBots.has(id)) {
                if (fs.existsSync(`auth_info_bot${id}`)) {
                    await adminSock.sendMessage(from, { text: `🟢 Memulai bot ${id}...` });
                    startWorkerBot(id);
                } else {
                    await adminSock.sendMessage(from, { text: `❌ Sesi Bot ${id} tidak ditemukan. Daftarkan dulu dengan *!reqbot ${id}*` });
                }
            } else {
                await adminSock.sendMessage(from, { text: `⚠️ Bot ${id} sudah berjalan.` });
            }
            return;
        }

        // ===== !restart =====
        if (text.startsWith('!restart ')) {
            const id = text.split(' ')[1];
            if (!id) return adminSock.sendMessage(from, { text: '⚠️ Format yang benar: !restart <id>' });
            if (!activeBots.has(id)) return adminSock.sendMessage(from, { text: `⚠️ Bot ${id} tidak aktif.` });

            await adminSock.sendMessage(from, { text: `🔄 Restarting bot ${id}...` });
            try {
                const botData = activeBots.get(id);
                botData.sock.ev.removeAllListeners();
                botData.sock.end(new Error('manual restart'));
            } catch { }
            activeBots.delete(id);

            // [FIX] Diperpendek 3000 → 1500ms
            setTimeout(async () => { try { await startWorkerBot(id); } catch { } }, 1500);
            return;
        }

        // ===== !restartall =====
        if (text === '!restartall') {
            await adminSock.sendMessage(from, { text: '🔄 Restart seluruh sistem dimulai...' });
            console.log('🔄 SOFT RESTART DIMULAI');
            global.isRestartingAll = true;

            const botIds = [...activeBots.keys()];

            for (const id of botIds) {
                try {
                    const botData = activeBots.get(id);
                    if (botData?.sock) {
                        botData.sock.ev.removeAllListeners();
                        try { botData.sock.end(new Error('restartall')); } catch { }
                    }
                } catch { }
            }

            activeBots.clear();
            duplicateCache.clear();

            // [FIX] Jangan hapus JID admin bot agar filter anti-loop tetap berjalan
            allBotJids.clear();
            if (adminSock?.user?.id) {
                allBotJids.add(adminSock.user.id.split(':')[0] + '@s.whatsapp.net');
            }

            console.log('⏳ Menunggu socket benar-benar mati...');
            // [FIX] Diperpendek 10000 → 5000ms
            await new Promise(r => setTimeout(r, 5000));

            console.log('🚀 Menjalankan ulang worker...');
            let successCount = 0;

            for (const id of botIds) {
                try {
                    await startWorkerBot(id);
                    successCount++;
                    console.log(`✅ Restart bot ${id}`);
                    // [FIX] Diperpendek 3000 → 1500ms
                    await new Promise(r => setTimeout(r, 1500));
                } catch (e) {
                    console.log(`❌ Gagal restart bot ${id}:`, e.message);
                }
            }

            global.isRestartingAll = false;
            await adminSock.sendMessage(from, {
                text: `✅ Restart selesai.\nBerhasil: ${successCount}/${botIds.length}\nBot aktif: ${activeBots.size}`
            });
            console.log('✅ SOFT RESTART SELESAI');
            return;
        }
    });
}

startAdminBot();

// ================= JADWAL HARIAN =================
// [FIX] Pakai removeAllListeners + end + isRestartingAll flag agar
// tidak memicu loop auto-reconnect saat jadwal stop dijalankan
setInterval(() => {
    const now = new Date();
    const timeString = now.toLocaleTimeString('en-US', {
        timeZone: 'Asia/Jakarta', hour12: false,
        hour: '2-digit', minute: '2-digit'
    });

    if (timeString === '04:50') {
        console.log('⏰ Menghentikan sesi bot (Jadwal Harian OFF)...');
        global.isRestartingAll = true;
        for (const [, data] of activeBots.entries()) {
            try {
                data.sock.ev.removeAllListeners();
                data.sock.end(new Error('scheduled stop'));
            } catch { }
        }
        activeBots.clear();
        global.isRestartingAll = false;
        console.log('⏰ Semua bot dihentikan.');

    } else if (timeString === '05:00') {
        console.log('⏰ Menjalankan ulang sesi bot (Jadwal Harian ON)...');
        const dirs = fs.readdirSync(__dirname).filter(f => f.startsWith('auth_info_bot'));
        dirs.forEach(dir => startWorkerBot(dir.replace('auth_info_bot', '')));
    }
}, 60000);

// ================= MONITOR RAM =================
setInterval(() => {
    const used = process.memoryUsage();
    console.log(`🧠 RAM: ${(used.heapUsed / 1024 / 1024).toFixed(0)} MB`);
}, 60000);

// ================= ERROR HANDLER =================
process.on('unhandledRejection', (err) => {
    const msg = err?.message || '';
    if (msg.includes('Closing open session') || msg.includes('Closing session')) return;
    console.log('UnhandledRejection:', msg);
});

process.on('uncaughtException', (err) => {
    const msg = err?.message || '';
    if (msg.includes('Closing open session') || msg.includes('Closing session')) return;
    console.log('UncaughtException:', msg);
});