const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const Jimp = require('jimp');
const jsQR = require('jsqr');
const sharp = require('sharp');

require('events').EventEmitter.defaultMaxListeners = 0;

// ================= SILENCER (MEMBUNGKAM LOG INTERNAL BAILEYS) =================
const originalConsoleLog = console.log;
console.log = function() {
    const firstArg = arguments[0];
    // Cegah log sampah dari sistem Signal Baileys muncul di RDP
    if (typeof firstArg === 'string' && (firstArg.includes('Closing session: SessionEntry') || firstArg.includes('Closing open session'))) {
        return; 
    }
    originalConsoleLog.apply(console, arguments);
};

// ================= CONFIGURATION =================
const ADMIN_GROUP_ID = '120363409663500630@g.us'; 
const PRIMARY_GROUP_ID = '120363408426078537@g.us';
const SECONDARY_GROUP_ID = '120363426296094605@g.us';

// const PRIMARY_GROUP_ID = '120363426296094605@g.us';
// const SECONDARY_GROUP_ID = '120363408426078537@g.us';

const ENABLE_FORWARD_TO_SECONDARY = true;
const DELAY_SECONDARY_MS = 1000; 
const CACHE_TTL_MS = 1 * 60 * 1000; 
const VALID_DOMAINS = /(dana\.id|gopay\.co\.id|shopeepay\.co\.id)/i;

// ================= GLOBAL STATE =================
let adminSock = null;
const activeBots = new Map(); 
const pendingSetups = new Map(); 
const pendingApprovals = new Map(); 
const duplicateCache = new Map(); 
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

        const scale = Math.max(1, 1000 / Math.max(newW, newH));
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
            img: upscaledImg.clone().extract({ left: Math.floor((finalW - size)/2), top: Math.floor((finalH - size)/2), width: size, height: size })
        });
        
        crops.push({
            img: upscaledImg.clone().extract({ left: 0, top: 0, width: finalW, height: Math.floor(finalH * 0.7) })
        });

        for (let i = 0; i < crops.length; i++) {
            const imgObj = crops[i].img.resize(800, 800, { fit: 'inside', withoutEnlargement: true });
            
            const filters = [
                imgObj.clone(),
                imgObj.clone().normalize().greyscale(),
                imgObj.clone().greyscale().threshold(140)
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
                sock.sendMessage(PRIMARY_GROUP_ID, { text: msg }).catch(() => {});
                if (ENABLE_FORWARD_TO_SECONDARY) {
                    setTimeout(() => {
                        sock.sendMessage(SECONDARY_GROUP_ID, { text: msg }).catch(() => {});
                    }, DELAY_SECONDARY_MS);
                }
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

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }), 
        browser: [`WaBot-${botId}`, 'Chrome', '1.0.0'],
        getMessage: async () => ({ conversation: '' }),
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            activeBots.delete(botId);
            if (reason !== DisconnectReason.loggedOut) {
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
        if (from === PRIMARY_GROUP_ID || from === SECONDARY_GROUP_ID) return;

        const senderRaw = msg.key.participant || msg.key.remoteJid;
        const senderJid = senderRaw ? senderRaw.split(':')[0] + '@s.whatsapp.net' : '';

        if (allBotJids.has(senderJid)) return;

        let m = msg.message;
        if (m.ephemeralMessage) m = m.ephemeralMessage.message;
        if (m.viewOnceMessage) m = m.viewOnceMessage.message;
        if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
        if (m.viewOnceMessageV2Extension) m = m.viewOnceMessageV2Extension.message;
        if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;

        const text = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '';
        if (text) processExtractedLink(sock, text, 'Link Teks');

        const imageMsg = m.imageMessage;
        const stickerMsg = m.stickerMessage;

        if (imageMsg || stickerMsg) {
            const mediaMsg = imageMsg || stickerMsg;
            const typeMedia = imageMsg ? 'image' : 'sticker';
            
            downloadMedia(mediaMsg, typeMedia).then(buffer => {
                detectQR(buffer).then(qrData => {
                    if (qrData) processExtractedLink(sock, qrData, typeMedia === 'image' ? 'QR Gambar' : 'QR Stiker');
                }).catch(() => {});
            }).catch(() => {});
        }
    });
}

// ================= ADMIN SYSTEM =================
async function startAdminBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_admin');
    const { version } = await fetchLatestBaileysVersion();

    adminSock = makeWASocket({
        version, auth: state, logger: pino({ level: 'silent' }), browser: ['MasterCore', 'Chrome', '1.0.0']
    });

    adminSock.ev.on('creds.update', saveCreds);
    adminSock.ev.on('connection.update', (update) => {
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
            dirs.forEach(dir => startWorkerBot(dir.replace('auth_info_bot', '')));
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

        if (from !== ADMIN_GROUP_ID && from.endsWith('@g.us')) return;

        const actionText = text.trim().toUpperCase();
        const contextInfo = msg.message.extendedTextMessage?.contextInfo;
        
        if (contextInfo?.stanzaId && pendingApprovals.has(contextInfo.stanzaId)) {
            const botId = pendingApprovals.get(contextInfo.stanzaId);

            if (actionText === 'OKE' || actionText === 'IYA') {
                pendingApprovals.delete(contextInfo.stanzaId);
                await adminSock.sendMessage(from, { text: `✅ Permintaan disetujui. Bot *${botId}* sedang dijalankan...` });
                startWorkerBot(botId);
            } else if (actionText === 'TIDAK') {
                pendingApprovals.delete(contextInfo.stanzaId);
                fs.rmSync(`auth_info_bot${botId}`, { recursive: true, force: true });
                await adminSock.sendMessage(from, { text: `❌ Permintaan ditolak. Sesi Bot *${botId}* dihapus.` });
            }
            return;
        }

        if (isFromMe && !text.startsWith('!')) return;

        if (text === '!info') {
            const infoMsg = `*🤖 SISTEM MULTI-BOT TERINTEGRASI 🤖*\n\n*👑 PERINTAH ADMIN*\n• *!info* : Menampilkan menu ini.\n• *!reqbot <id>* : Meminta penambahan bot.\n• *!batal* : Membatalkan proses scan.\n• *!list* : Melihat bot yang aktif.\n• *!stop <id>* : Menghentikan bot.\n• *!start <id>* : Menjalankan kembali bot.\n• *!restart <id>* : Merestart bot.\n• *!restartall* : Merestart keseluruhan sistem.`;
            await adminSock.sendMessage(from, { text: infoMsg }, { quoted: msg });
            return;
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
                    version, auth: tempState, logger: pino({ level: 'silent' }), browser: [`Setup-${botId}`, 'Chrome', '1.0.0']
                });
                
                tempSock.ev.on('creds.update', tempSaveCreds);
                pendingSetups.set(sender, { sock: tempSock, botId });

                tempSock.ev.on('connection.update', async (update) => {
                    const { connection, qr, lastDisconnect } = update;
                    if (qr) {
                        try {
                            const qrBuffer = await qrcode.toBuffer(qr, { scale: 6 });
                            await adminSock.sendMessage(from, { image: qrBuffer, caption: `✅ *QR Login Bot ${botId}*\n\nSilakan scan QR ini. Ketik *!batal* jika ingin membatalkan.` });
                        } catch (err) {}
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
                        try { tempSock.ev.removeAllListeners(); tempSock.ws.close(); } catch (e) {} 
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
                activeBots.get(id).sock.ws.close();
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
            if (!id) return adminSock.sendMessage(from, { text: '⚠️ Format yang benar: !restart <id>' });
            
            if (activeBots.has(id)) {
                await adminSock.sendMessage(from, { text: `🔄 Restarting bot ${id}...` });
                activeBots.get(id).sock.ws.close();
                activeBots.delete(id);
                setTimeout(() => startWorkerBot(id), 2000);
            } else {
                await adminSock.sendMessage(from, { text: `⚠️ Bot ${id} sedang tidak aktif. Ketik *!start ${id}* untuk menghidupkan.` });
            }
        }
        
        if (text === '!restartall') {
            await adminSock.sendMessage(from, { text: `🔄 Merestart semua sistem... Tunggu beberapa detik.` });
            process.exit(0); 
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
            try { data.sock.ws.close(); } catch (e) {}
            activeBots.delete(id);
        }
    } else if (timeString === '05:00') {
        console.log('⏰ Menjalankan ulang sesi bot (Jadwal Harian ON)...');
        const dirs = fs.readdirSync(__dirname).filter(f => f.startsWith('auth_info_bot'));
        dirs.forEach(dir => startWorkerBot(dir.replace('auth_info_bot', '')));
    }
}, 60000);

process.on('unhandledRejection', (err) => {});
process.on('uncaughtException', (err) => {});