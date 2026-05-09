const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
// const Jimp = require('jimp');
const jsQR = require('jsqr');
const sharp = require('sharp');

sharp.cache(false);
sharp.concurrency(1);

const mediaQueue = [];
let processingQueue = false;

// ================= BLOCK STDERR BAILEYS =================
const originalStderrWrite = process.stderr.write.bind(process.stderr);

process.stderr.write = (chunk, encoding, callback) => {

    const text = chunk?.toString?.() || '';

    if (
        text.includes('Closing open session') ||
        text.includes('Closing session: SessionEntry')
    ) {
        return true;
    }

    return originalStderrWrite(chunk, encoding, callback);
};

require('events').EventEmitter.defaultMaxListeners = 0;



// ================= SILENCER (MEMBUNGKAM LOG INTERNAL BAILEYS) =================
const originalConsoleLog = console.log;
console.log = function () {
    const firstArg = arguments[0];
    // Cegah log sampah dari sistem Signal Baileys muncul di RDP
    if (typeof firstArg === 'string' && (firstArg.includes('Closing session: SessionEntry') || firstArg.includes('Closing open session'))) {
        return;
    }
    originalConsoleLog.apply(console, arguments);
};
const originalConsoleError = console.error;

console.error = function (...args) {

    const text = args
        .map(a =>
            typeof a === 'string'
                ? a
                : JSON.stringify(a)
        )
        .join(' ');

    if (
        text.includes('Closing open session') ||
        text.includes('Closing session: SessionEntry')
    ) {
        return;
    }

    originalConsoleError.apply(console, args);
};

const DEFAULT_ADMIN_GROUP = '120363429956751358@g.us';
const DEFAULT_FORWARD_GROUP = '120363408426078537@g.us';
const CONFIG_FILE = './config.json';

// ======== TAMBAHKAN BARIS INI KEMBALI ========
// const CACHE_TTL_MS = 1 * 60 * 1000; // 1 Menit Anti Duplikat
const CACHE_TTL_MS = 20 * 1000;
// =============================================

// Inisialisasi State Default
let configData = {
    adminGroups: [DEFAULT_ADMIN_GROUP],
    forwardGroups: [DEFAULT_FORWARD_GROUP],
    forwardMode: true, // true = all, false = single/priority
    priorityForwardGroup: null
};

async function processMediaQueue() {

    if (processingQueue) return;

    processingQueue = true;

    while (mediaQueue.length > 0) {

        const item = mediaQueue.shift();

        try {

            const qrData = await detectQR(item.buffer);

            if (qrData) {
                processExtractedLink(
                    item.sock,
                    qrData,
                    item.label
                );
            }

        } catch (e) { }

    }

    processingQueue = false;
}

// Auto-Load Data saat bot menyala
if (fs.existsSync(CONFIG_FILE)) {
    try {
        configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
        console.error("Gagal membaca config.json, menggunakan default.");
    }
} else {
    saveConfig(); // Buat file jika belum ada
}

// Fungsi untuk menyimpan perubahan ke JSON
function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2));
}
const VALID_DOMAINS = /(dana\.id|gopay\.co\.id|shopeepay\.co\.id)/i;

// ================= GLOBAL STATE =================
let adminSock = null;
const activeBots = new Map();
const pendingSetups = new Map();
const pendingApprovals = new Map();
const duplicateCache = new Map();
setInterval(() => {

    const now = Date.now();

    for (const [key, time] of duplicateCache.entries()) {

        if (now - time > CACHE_TTL_MS) {
            duplicateCache.delete(key);
        }

    }

}, 30000);
const allBotJids = new Set();

// ================= HELPER MEDIA & SMART QR SCANNER =================
async function downloadMedia(mediaMsg, type) {
    try {
        if (mediaMsg.mediaKey) {
            const stream = await downloadContentFromMessage(mediaMsg, type);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }
            return buffer;
        }

        let downloadUrl = mediaMsg.url || (mediaMsg.directPath ? `https://mmg.whatsapp.net${mediaMsg.directPath}` : null);
        if (downloadUrl) {
            return new Promise((resolve, reject) => {
                https.get(downloadUrl, (res) => {
                    const data = [];
                    res.on('data', chunk => data.push(chunk));
                    res.on('end', () => resolve(Buffer.concat(data)));
                }).on('error', err => reject(err));
            });
        }
        throw new Error('Tidak ada url atau mediaKey');
    } catch (error) { throw error; }
}

async function detectQR(buffer) {
    try {
        const baseImg = sharp(buffer).flatten({ background: '#ffffff' });
        const meta = await baseImg.metadata();
        const w = meta.width;
        const h = meta.height;

        if (!w || !h) return null;

        const paddedImg = baseImg.extend({
            top: 60, bottom: 60, left: 60, right: 60,
            background: '#ffffff'
        });

        const newW = w + 120;
        const newH = h + 120;

        // const scale = Math.max(1, 1000 / Math.max(newW, newH));
        const scale = Math.max(1, 700 / Math.max(newW, newH));
        const finalW = Math.floor(newW * scale);
        const finalH = Math.floor(newH * scale);

        const upscaledImg = paddedImg.resize(finalW, finalH, {
            kernel: sharp.kernel.nearest
        });

        let crops = [
            { img: upscaledImg.clone() }
        ];

        const minDim = Math.min(finalW, finalH);
        const size = Math.floor(minDim * 0.85);

        crops.push({
            img: upscaledImg.clone().extract({ left: Math.floor((finalW - size) / 2), top: Math.floor((finalH - size) / 2), width: size, height: size })
        });

        crops.push({
            img: upscaledImg.clone().extract({ left: 0, top: 0, width: finalW, height: Math.floor(finalH * 0.7) })
        });

        for (let i = 0; i < crops.length; i++) {
            // const imgObj = crops[i].img.resize(800, 800, { fit: 'inside', withoutEnlargement: true });
            const imgObj = crops[i].img.resize(600, 600, { fit: 'inside', withoutEnlargement: true });

            // const filters = [
            //     imgObj.clone(),
            //     imgObj.clone().normalize().greyscale(),
            //     imgObj.clone().greyscale().threshold(140)
            // ];
            const filters = [
                imgObj,
                imgObj.clone().greyscale(),
            ];

            for (let j = 0; j < filters.length; j++) {
                try {
                    const { data, info } = await filters[j]
                        .ensureAlpha()
                        .raw()
                        .toBuffer({ resolveWithObject: true });

                    const clampedArray = new Uint8ClampedArray(data);
                    const decoded = jsQR(clampedArray, info.width, info.height);

                    if (decoded && decoded.data) {
                        return decoded.data; // Langsung return hasil tanpa console.log
                    }
                } catch (err) {
                    continue;
                }
            }
        }
        return null;
    } catch (e) {
        return null; // Error diam-diam tanpa console.log
    }
}

// async function detectQR(buffer) {
//     try {
//         console.log(`\n[DEBUG-QR] Memulai scan media...`);
//         const baseImg = sharp(buffer);
//         const meta = await baseImg.metadata();
//         const w = meta.width;
//         const h = meta.height;

//         if (!w || !h) return null;

//         // KUNCI: Potong gambar menjadi beberapa area agar fokus ke QR
//         let crops = [ baseImg.clone() ]; // 1. Scan Full Layar

//         if (w >= 300 && h >= 300) {
//             const size = Math.floor(Math.min(w, h) * 0.9);
//             // 2. Scan Khusus Tengah (Bagus untuk Screenshot DANA)
//             crops.push(baseImg.clone().extract({ left: Math.floor((w - size)/2), top: Math.floor((h - size)/2), width: size, height: size })); 
//             // 3. Scan Khusus Atas (Bagus untuk Stiker)
//             crops.push(baseImg.clone().extract({ left: 0, top: 0, width: w, height: Math.floor(h * 0.7) })); 
//         }

//         for (let i = 0; i < crops.length; i++) {
//             // Resize gambar max 800px dan paksa format warna menjadi RGBA (Syarat mutlak jsQR)
//             const imgObj = crops[i].resize(800, 800, { fit: 'inside', withoutEnlargement: true }).ensureAlpha();

//             // Variasi Kontras Warna untuk menebus gambar buram
//             const filters = [
//                 imgObj.clone(), // Normal
//                 imgObj.clone().normalize().greyscale(), // Hitam Putih Tajam
//                 imgObj.clone().greyscale().linear(1.5, -50) // Gelap Terang
//             ];

//             for (let j = 0; j < filters.length; j++) {
//                 // Ekstrak pixel mentah (Jauh lebih cepat dari Jimp)
//                 const { data, info } = await filters[j].raw().toBuffer({ resolveWithObject: true });
//                 const clampedArray = new Uint8ClampedArray(data);

//                 // Tembak menggunakan jsQR
//                 const decoded = jsQR(clampedArray, info.width, info.height);

//                 if (decoded && decoded.data) {
//                     console.log(`[DEBUG-QR] ✅ QR Terbaca! ->`, decoded.data);
//                     return decoded.data;
//                 }
//             }
//         }
//         console.log(`[DEBUG-QR] ❌ GAGAL. QR tidak ditemukan di media ini.`);
//         return null;
//     } catch (e) {
//         console.log(`[DEBUG-QR] ❌ Error saat scan:`, e.message);
//         return null;
//     }
// }

// ================= IN-MEMORY ANTI DUPLIKAT =================
function isDuplicate(link) {
    let cleanLink = link.trim().replace(/\/$/, '');
    const hash = crypto.createHash('md5').update(cleanLink).digest('hex');

    if (duplicateCache.has(hash)) return true;
    duplicateCache.set(hash, Date.now());
    setTimeout(() => duplicateCache.delete(hash), CACHE_TTL_MS);
    return false;
}

// ================= PUSAT EKSTRAKSI LINK =================
function processExtractedLink(sock, textRaw, label) {
    if (!textRaw) return;

    const regex = /(?:https?:\/\/)?(?:[\w-]+\.)?(?:dana\.id|gopay\.co\.id|shopeepay\.co\.id)[^\s]*/gi;
    const matches = textRaw.match(regex);

    if (matches) {
        matches.forEach(url => {
            const uLower = url.toLowerCase();

            if (uLower.includes('/minta') || uLower.endsWith('dana.id') || uLower.endsWith('dana.id/')) return;
            if (uLower.includes('dana.id') && !uLower.includes('kaget') && !uLower.includes('danakaget')) return;

            const finalUrl = url.startsWith('http') ? url : 'https://' + url;

            if (isDuplicate(finalUrl)) return;

            // LOG INI SAJA YANG TAMPIL DI RDP
            console.log(`\n🚀 [BERHASIL!] Menemukan dan meneruskan: ${finalUrl} (Dari ${label})`);
            const msg = `${finalUrl}\n\nTipe: ${label}`;

            if (sock) {
                let targets = [];
                // Cek mode forward
                if (configData.forwardMode === true) {
                    targets = configData.forwardGroups; // Kirim ke semua
                } else if (configData.forwardMode === false && configData.priorityForwardGroup) {
                    targets = [configData.priorityForwardGroup]; // Kirim ke 1 grup prioritas
                }

                // Kirim secara asinkronus (berbarengan, tanpa await agar sangat cepat)
                // targets.forEach(target => {
                //     sock.sendMessage(target, { text: msg }).catch(() => { });
                // });
                Promise.allSettled(
                    targets.map(target =>
                        sock.sendMessage(target, { text: msg })
                    )
                ).catch(() => { });
            }
        });
    }
}

// ================= WORKER BOT MANAGER =================
async function startWorkerBot(botId) {
    if (activeBots.has(botId)) return;

    const folderName = `auth_info_bot${botId}`;
    if (!fs.existsSync(folderName)) return;

    const { state, saveCreds } = await useMultiFileAuthState(folderName);
    const { version } = await fetchLatestBaileysVersion();

    // const sock = makeWASocket({
    //     version,
    //     auth: state,
    //     logger: pino({ level: 'silent' }),
    //     browser: [`WaBot-${botId}`, 'Chrome', '1.0.0'],
    //     getMessage: async () => ({ conversation: '' }),
    // });

    const sock = makeWASocket({
        version,
        auth: state,
        // logger: pino({ level: 'silent' }),
        logger: pino({
            enabled: false
        }),

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
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            activeBots.delete(botId);
            // if (reason !== DisconnectReason.loggedOut) {
            //     setTimeout(() => startWorkerBot(botId), 5000);
            // }
            if (
                reason !== DisconnectReason.loggedOut &&
                !global.isRestartingAll
            ) {
                setTimeout(() => startWorkerBot(botId), 5000);
            }
        } else if (connection === 'open') {
            const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            allBotJids.add(myJid);
            console.log(`[Bot ${botId}] 🟢 READY (${myJid})`);
            activeBots.set(botId, { sock, startTime: Date.now() });
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
        // Cegah worker bot memproses pesan dari daftar grup forward agar tidak terjadi looping
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

        const text = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '';
        if (text) processExtractedLink(sock, text, 'Link Teks');

        const imageMsg = m.imageMessage;
        const stickerMsg = m.stickerMessage;
        const videoMsg = null;

        if (imageMsg || stickerMsg) {
            const mediaMsg = imageMsg || stickerMsg;
            const typeMedia = imageMsg ? 'image' : 'sticker';

            // downloadMedia(mediaMsg, typeMedia).then(buffer => {
            //     detectQR(buffer).then(qrData => {
            //         if (qrData) processExtractedLink(sock, qrData, typeMedia === 'image' ? 'QR Gambar' : 'QR Stiker');
            //     }).catch(() => { });
            // }).catch(() => { });
            downloadMedia(mediaMsg, typeMedia).then(buffer => {
                if (mediaQueue.length > 30) return;

                mediaQueue.push({
                    sock,
                    buffer,
                    label: typeMedia === 'image'
                        ? 'QR Gambar'
                        : 'QR Stiker'
                });

                processMediaQueue();

            }).catch(() => { });
        }
    });
}

// ================= ADMIN SYSTEM =================
async function startAdminBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_admin');
    const { version } = await fetchLatestBaileysVersion();

    // adminSock = makeWASocket({
    //     version, auth: state, logger: pino({ level: 'silent' }), browser: ['MasterCore', 'Chrome', '1.0.0']
    // });

    adminSock = makeWASocket({
        version,
        auth: state,
        // logger: pino({ level: 'silent' }),
        logger: pino({
            enabled: false
        }),

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
            // dirs.forEach(dir => startWorkerBot(dir.replace('auth_info_bot', '')));
            for (const dir of dirs) {
                const id = dir.replace('auth_info_bot', '');

                if (!activeBots.has(id)) {
                    await startWorkerBot(id);
                }

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
        const isFromMe = msg.key.fromMe;

        if (text === '!idgrup' && from.endsWith('@g.us')) {
            await adminSock.sendMessage(from, { text: `*ID Grup Ini:*\n${from}` }, { quoted: msg });
            return;
        }

        // Cek apakah pesan berasal dari salah satu grup admin terdaftar
        // const isAnyAdminGroup = configData.adminGroups.includes(from);
        // const isDefaultAdminGroup = (from === DEFAULT_ADMIN_GROUP);
        const isAnyAdminGroup = configData.adminGroups.includes(from);
        const isDefaultAdminGroup = (from === DEFAULT_ADMIN_GROUP);

        // Hak akses
        const LIMITED_COMMANDS = ['!list', '!restart', '!restartall'];
        const DEFAULT_ONLY_COMMANDS = [
            '!info',
            '!reqbot',
            '!batal',
            '!stop',
            '!start',
            '!addadmin',
            '!deladmin',
            '!listadmin',
            '!addforward',
            '!delforward',
            '!listforward',
            '!mode'
        ];

        // Tolak command jika bukan grup admin
        if (text.startsWith('!') && !isAnyAdminGroup) return;

        // Grup admin tambahan hanya boleh command tertentu
        if (
            !isDefaultAdminGroup &&
            text.startsWith('!')
        ) {
            const cmd = text.split(' ')[0].toLowerCase();

            if (!LIMITED_COMMANDS.includes(cmd)) {
                return adminSock.sendMessage(from, {
                    text:
                        `⚠️ Grup Admin Tambahan hanya bisa menggunakan:
                            • !list
                            • !restart <id>
                            • !restartall`
                });
            }
        }

        // Abaikan jika pesan dari grup biasa (bukan grup admin)
        if (!isAnyAdminGroup && from.endsWith('@g.us') && text.startsWith('!')) return;

        const actionText = text.trim().toUpperCase();
        const contextInfo = msg.message.extendedTextMessage?.contextInfo;

        // HAPUS atau comment baris 'if (isFromMe...)' agar akun bot sendiri bisa pakai perintah jika dia ada di grup admin

        if (text === '!info') {

            if (!isDefaultAdminGroup) {
                return adminSock.sendMessage(from, {
                    text: '⚠️ Menu info hanya tersedia di Grup Admin Utama.'
                });
            }
            const infoMsg = `*🤖 SISTEM MULTI-BOT TERINTEGRASI 🤖*
*👑 PERINTAH WORKER BOT*
• *!reqbot <id>* : Meminta penambahan bot.
• *!batal* : Membatalkan proses scan QR.
• *!list* : Melihat bot yang aktif.
• *!stop <id>* : Menghentikan bot.
• *!start <id>* : Menjalankan kembali bot.
• *!restart <id>* : Merestart bot.

*⚙️ MANAJEMEN ADMIN GRUP (Hanya Default Admin)*
• *!addadmin <id_grup@g.us>* : Menambah grup admin.
• *!deladmin <id_grup@g.us>* : Menghapus grup admin.
• *!listadmin* : Lihat daftar grup admin.

*🚀 MANAJEMEN FORWARD GRUP (Hanya Default Admin)*
• *!addforward <id_grup@g.us>* : Menambah grup forward.
• *!delforward <id_grup@g.us>* : Menghapus grup forward.
• *!listforward* : Lihat daftar grup & mode saat ini.
• *!mode true* : Forward ke SEMUA grup terdaftar.
• *!mode false <id_grup@g.us>* : Forward HANYA ke 1 grup (Prioritas).

*🔄 SISTEM*
• *!info* : Menampilkan menu ini.
• *!restartall* : Merestart keseluruhan sistem (Soft-Restart).`;

            await adminSock.sendMessage(from, { text: infoMsg }, { quoted: msg });
            return;
        }

        // ================= FITUR MANAJEMEN GRUP =================
        const args = text.split(' ');
        const command = args[0].toLowerCase();

        // Pengecekan otoritas: Perintah setting HANYA untuk Default Admin Group
        const isSettingCommand = ['!addadmin', '!deladmin', '!addforward', '!delforward', '!mode'].includes(command);

        if (isSettingCommand && !isDefaultAdminGroup) {
            return adminSock.sendMessage(from, { text: '⚠️ *Akses Ditolak!*\nPerintah ini hanya dapat dijalankan di Grup Admin Utama.' });
        }

        if (command === '!addadmin') {
            const targetId = args[1];
            if (!targetId || !targetId.endsWith('@g.us')) return adminSock.sendMessage(from, { text: '⚠️ Format: !addadmin <id_grup@g.us>' });
            if (configData.adminGroups.includes(targetId)) return adminSock.sendMessage(from, { text: '⚠️ Grup sudah menjadi admin.' });

            configData.adminGroups.push(targetId);
            saveConfig();
            return adminSock.sendMessage(from, { text: `✅ Berhasil menambahkan ${targetId} ke daftar Grup Admin.` });
        }

        if (command === '!deladmin') {
            const targetId = args[1];
            if (!targetId) return adminSock.sendMessage(from, { text: '⚠️ Format: !deladmin <id_grup>' });
            if (targetId === DEFAULT_ADMIN_GROUP) return adminSock.sendMessage(from, { text: '⚠️ Tidak dapat menghapus Grup Admin Utama!' });

            configData.adminGroups = configData.adminGroups.filter(id => id !== targetId);
            saveConfig();
            return adminSock.sendMessage(from, { text: `✅ Berhasil menghapus ${targetId} dari daftar Grup Admin.` });
        }

        if (command === '!listadmin') {
            let msgText = `*👑 DAFTAR GRUP ADMIN (${configData.adminGroups.length})*\n`;
            configData.adminGroups.forEach((id, i) => msgText += `\n${i + 1}. ${id} ${id === DEFAULT_ADMIN_GROUP ? '(🌟 Default)' : ''}`);
            return adminSock.sendMessage(from, { text: msgText });
        }

        if (command === '!addforward') {
            const targetId = args[1];
            if (!targetId || !targetId.endsWith('@g.us')) return adminSock.sendMessage(from, { text: '⚠️ Format: !addforward <id_grup@g.us>' });
            if (configData.forwardGroups.includes(targetId)) return adminSock.sendMessage(from, { text: '⚠️ Grup sudah ada di daftar forward.' });

            configData.forwardGroups.push(targetId);
            saveConfig();
            return adminSock.sendMessage(from, { text: `✅ Berhasil menambahkan ${targetId} ke daftar Forward.` });
        }

        if (command === '!delforward') {
            const targetId = args[1];
            if (!targetId) return adminSock.sendMessage(from, { text: '⚠️ Format: !delforward <id_grup>' });
            if (targetId === DEFAULT_FORWARD_GROUP) return adminSock.sendMessage(from, { text: '⚠️ Tidak disarankan menghapus Grup Forward Utama, gunakan !mode false untuk menonaktifkan sementara.' });

            configData.forwardGroups = configData.forwardGroups.filter(id => id !== targetId);
            saveConfig();
            return adminSock.sendMessage(from, { text: `✅ Berhasil menghapus ${targetId} dari daftar Forward.` });
        }

        if (command === '!listforward') {
            let msgText = `*🚀 DAFTAR GRUP FORWARD (${configData.forwardGroups.length})*\nMode Saat Ini: *${configData.forwardMode ? 'ALL (Semua Grup)' : 'SINGLE (Prioritas)'}*\n`;
            if (!configData.forwardMode) msgText += `Target Prioritas: ${configData.priorityForwardGroup}\n`;
            configData.forwardGroups.forEach((id, i) => msgText += `\n${i + 1}. ${id}`);
            return adminSock.sendMessage(from, { text: msgText });
        }

        if (command === '!mode') {
            const modeVal = args[1]?.toLowerCase();
            const targetId = args[2];

            if (modeVal === 'true') {
                configData.forwardMode = true;
                configData.priorityForwardGroup = null;
                saveConfig();
                return adminSock.sendMessage(from, { text: '✅ Mode Forward: *TRUE*\nBot akan mengirim link ke SEMUA grup forward yang terdaftar.' });
            } else if (modeVal === 'false') {
                if (!targetId || !targetId.endsWith('@g.us')) return adminSock.sendMessage(from, { text: '⚠️ Format: !mode false <id_grup_prioritas@g.us>\nGrup lain akan dinonaktifkan sementara.' });

                configData.forwardMode = false;
                configData.priorityForwardGroup = targetId;
                saveConfig();
                return adminSock.sendMessage(from, { text: `✅ Mode Forward: *FALSE*\nBot HANYA akan mengirim link ke: ${targetId}` });
            } else {
                return adminSock.sendMessage(from, { text: '⚠️ Format salah. Gunakan:\n!mode true\n!mode false <id_grup>' });
            }
        }

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
                const { version } = await fetchLatestBaileysVersion();
                const { state: tempState, saveCreds: tempSaveCreds } = await useMultiFileAuthState(folderName);

                const tempSock = makeWASocket({
                    version, auth: tempState, logger: pino({ enabled: false }), browser: [`Setup-${botId}`, 'Chrome', '1.0.0']
                });

                tempSock.ev.on('creds.update', tempSaveCreds);
                pendingSetups.set(sender, { sock: tempSock, botId });

                tempSock.ev.on('connection.update', async (update) => {
                    const { connection, qr, lastDisconnect } = update;
                    if (qr) {
                        try {
                            const qrBuffer = await qrcode.toBuffer(qr, { scale: 6 });
                            await adminSock.sendMessage(from, { image: qrBuffer, caption: `✅ *QR Login Bot ${botId}*\n\nSilakan scan QR ini. Ketik *!batal* jika ingin membatalkan.` });
                        } catch (err) { }
                    }
                    if (connection === 'close') {
                        if (isSetupFinished) return;
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
                        try { tempSock.ev.removeAllListeners(); tempSock.ws.close(); } catch (e) { }
                        pendingSetups.delete(sender);

                        const askMsg = await adminSock.sendMessage(from, {
                            text: `🔔 *PERMOHONAN BOT BARU*\n\nUser: @${sender.split('@')[0]}\nBot ID: *${botId}*\n\n👉 Balas (Quote) pesan ini dengan *OKE* untuk menyalakan atau *TIDAK* untuk menolak.`,
                            mentions: [sender]
                        });
                        pendingApprovals.set(askMsg.key.id, botId);
                    }
                });
            }
            connectSetup();
            return;
        }

        if (text === '!batal') {
            if (pendingSetups.has(sender)) {
                const setup = pendingSetups.get(sender);
                setup.sock.ws.close();
                fs.rmSync(`auth_info_bot${setup.botId}`, { recursive: true, force: true });
                pendingSetups.delete(sender);
                await adminSock.sendMessage(from, { text: '❌ Proses dibatalkan.' });
            }
        }

        if (text === '!list') {
            let reply = `*🔥 DAFTAR BOT AKTIF (${activeBots.size})*\n`;
            for (let [id, data] of activeBots.entries()) {
                const uptime = Math.floor((Date.now() - data.startTime) / 60000);
                reply += `\n🤖 Bot ID: *${id}*\n⏱ Uptime: ${uptime} Menit\n`;
            }
            await adminSock.sendMessage(from, { text: reply });
        }

        if (text.startsWith('!stop')) {
            const id = text.split(' ')[1];
            if (!id) return adminSock.sendMessage(from, { text: '⚠️ Format yang benar: !stop <id>' });

            if (activeBots.has(id)) {
                // activeBots.get(id).sock.ws.close();
                const botData = activeBots.get(id);

                botData.sock.ev.removeAllListeners();
                botData.sock.end(new Error('manual stop'));

                activeBots.delete(id);
                await adminSock.sendMessage(from, { text: `🛑 Bot ${id} berhasil dihentikan.` });
            } else {
                await adminSock.sendMessage(from, { text: `⚠️ Bot ${id} tidak sedang aktif saat ini.` });
            }
        }

        if (text.startsWith('!start')) {
            const id = text.split(' ')[1];
            if (!id) return adminSock.sendMessage(from, { text: '⚠️ Format yang benar: !start <id>' });

            if (!activeBots.has(id)) {
                if (fs.existsSync(`auth_info_bot${id}`)) {
                    await adminSock.sendMessage(from, { text: `🟢 Memulai bot ${id}...` });
                    startWorkerBot(id);
                } else {
                    await adminSock.sendMessage(from, { text: `❌ Gagal: Sesi untuk Bot ${id} tidak ditemukan. Harus didaftarkan dulu dengan *!reqbot ${id}*` });
                }
            } else {
                await adminSock.sendMessage(from, { text: `⚠️ Gagal: Bot ${id} sudah dalam keadaan berjalan.` });
            }
        }

        if (text.startsWith('!restart')) {

            const id = text.split(' ')[1];

            if (!id) {
                return adminSock.sendMessage(from, {
                    text: '⚠️ Format yang benar: !restart <id>'
                });
            }

            if (!activeBots.has(id)) {
                return adminSock.sendMessage(from, {
                    text: `⚠️ Bot ${id} tidak aktif.`
                });
            }

            await adminSock.sendMessage(from, {
                text: `🔄 Restarting bot ${id}...`
            });

            try {

                const botData = activeBots.get(id);

                // cegah reconnect loop
                botData.sock.ev.removeAllListeners();

                // matikan socket
                botData.sock.end(new Error('manual restart'));

            } catch (e) { }

            activeBots.delete(id);

            setTimeout(async () => {

                try {
                    await startWorkerBot(id);
                } catch (e) { }

            }, 3000);

            return;
        }

        if (text === '!restartall') {

            await adminSock.sendMessage(from, {
                text: '🔄 Restart seluruh sistem dimulai...'
            });

            console.log('🔄 SOFT RESTART DIMULAI');

            // Matikan semua reconnect sementara
            global.isRestartingAll = true;

            // Tutup semua worker
            for (const [id, data] of activeBots.entries()) {
                try {
                    data.sock.ev.removeAllListeners();
                    data.sock.end(new Error('restart'));
                } catch (e) { }

                activeBots.delete(id);
            }

            // Bersihkan cache memory
            duplicateCache.clear();
            allBotJids.clear();

            // Tunggu sebentar
            await new Promise(r => setTimeout(r, 3000));

            // Jalankan ulang semua worker
            const dirs = fs.readdirSync(__dirname)
                .filter(f => f.startsWith('auth_info_bot'));

            for (const dir of dirs) {
                const id = dir.replace('auth_info_bot', '');

                try {
                    await startWorkerBot(id);

                    // delay kecil agar CPU tidak spike
                    await new Promise(r => setTimeout(r, 1000));

                } catch (e) {
                    console.log(`❌ Gagal restart bot ${id}`);
                }
            }

            global.isRestartingAll = false;

            await adminSock.sendMessage(from, {
                text: `✅ Restart selesai.\nBot aktif: ${activeBots.size}`
            });

            console.log('✅ SOFT RESTART SELESAI');

            return;
        }
    });
}

startAdminBot();

// ================= JADWAL OTOMATIS =================
setInterval(() => {
    const now = new Date();
    const options = { timeZone: 'Asia/Jakarta', hour12: false, hour: '2-digit', minute: '2-digit' };
    const timeString = now.toLocaleTimeString('en-US', options);

    if (timeString === '04:50') {
        console.log('⏰ Menghentikan sesi bot (Jadwal Harian OFF)...');
        for (let [id, data] of activeBots.entries()) {
            try { data.sock.ws.close(); } catch (e) { }
            activeBots.delete(id);
        }
    } else if (timeString === '05:00') {
        console.log('⏰ Menjalankan ulang sesi bot (Jadwal Harian ON)...');
        const dirs = fs.readdirSync(__dirname).filter(f => f.startsWith('auth_info_bot'));
        dirs.forEach(dir => startWorkerBot(dir.replace('auth_info_bot', '')));
    }
}, 60000);

// process.on('unhandledRejection', (err) => { });
// process.on('uncaughtException', (err) => { });

// ================= MONITOR RAM =================
setInterval(() => {

    const used = process.memoryUsage();

    console.log(
        `🧠 RAM: ${(used.heapUsed / 1024 / 1024).toFixed(0)} MB`
    );

}, 60000);

process.on('unhandledRejection', (err) => {

    const msg = err?.message || '';

    if (
        msg.includes('Closing open session') ||
        msg.includes('Closing session')
    ) {
        return;
    }

    console.log('UnhandledRejection:', msg);

});

process.on('uncaughtException', (err) => {

    const msg = err?.message || '';

    if (
        msg.includes('Closing open session') ||
        msg.includes('Closing session')
    ) {
        return;
    }

    console.log('UncaughtException:', msg);

});