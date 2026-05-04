const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const Jimp = require('jimp');
const QrCode = require('qrcode-reader');
const sharp = require('sharp');

require('events').EventEmitter.defaultMaxListeners = 0;

// ================= CONFIGURATION =================
const ADMIN_GROUP_ID = '120363409663500630@g.us'; 
const PRIMARY_GROUP_ID = '120363408426078537@g.us';
const SECONDARY_GROUP_ID = '120363426296094605@g.us';

const ENABLE_FORWARD_TO_SECONDARY = true;
const DELAY_SECONDARY_MS = 60000; // ⏱ Atur Delay Grup Kedua (60000 = 60 detik)
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 Menit Anti-Duplikat

// ================= GLOBAL STATE =================
let adminSock = null;
const activeBots = new Map(); 
const pendingSetups = new Map(); 
const pendingApprovals = new Map(); 
const duplicateCache = new Map(); 
const allBotJids = new Set(); 

// ================= HELPER MEDIA & QR SCANNER =================
async function downloadMedia(mediaMsg, type) {
    try {
        const stream = await downloadContentFromMessage(mediaMsg, type);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        return buffer;
    } catch (err) {
        // Fallback jika downloadContentFromMessage gagal (biasanya karena stiker di-cache)
        const url = mediaMsg.url || (mediaMsg.directPath ? `https://mmg.whatsapp.net${mediaMsg.directPath}` : null);
        if (!url) throw err;
        return new Promise((resolve, reject) => {
            https.get(url, res => {
                const data = [];
                res.on('data', chunk => data.push(chunk));
                res.on('end', () => resolve(Buffer.concat(data)));
            }).on('error', reject);
        });
    }
}

async function detectQR(buffer) {
    try {
        const baseImg = sharp(buffer).flatten({ background: '#ffffff' });
        const meta = await baseImg.metadata();

        const decode = async (buf) => {
            const image = await Jimp.read(buf);
            return new Promise((resolve, reject) => {
                const qr = new QrCode();
                qr.callback = (e, v) => (e || !v) ? reject(e) : resolve(v.result);
                qr.decode(image.bitmap);
            });
        };

        const cw = Math.floor(meta.width * 0.7);
        const ch = Math.floor(meta.height * 0.6);

        // Eksekusi berbagai variasi kontras & ukuran agar QR stiker yang buram/kecil tetap terbaca
        const buffers = await Promise.all([
            baseImg.clone().png().toBuffer(),
            baseImg.clone().normalize().greyscale().linear(1.5, -50).png().toBuffer(),
            baseImg.clone().extract({ left: 0, top: 0, width: cw, height: ch }).resize(cw * 2).greyscale().threshold(140).png().toBuffer(),
            baseImg.clone().resize(meta.width * 2).greyscale().png().toBuffer() // Upscale untuk stiker resolusi rendah
        ]);

        return await Promise.any(buffers.map(decode));
    } catch {
        return null;
    }
}

// ================= IN-MEMORY ANTI DUPLIKAT =================
function isDuplicate(link) {
    let cleanLink = link.trim().replace(/\/$/, ''); 
    const hash = crypto.createHash('md5').update(cleanLink).digest('hex');
    
    if (duplicateCache.has(hash)) return true; 
    duplicateCache.set(hash, Date.now());
    setTimeout(() => duplicateCache.delete(hash), CACHE_TTL_MS);
    return false;
}

// ================= PUSAT EKSTRAKSI LINK (SUPER FAST) =================
// Fungsi ini otomatis menyaring dan mem-forward apa pun teks masuk (entah itu raw teks / hasil scan QR)
function processExtractedLink(sock, textRaw, label) {
    if (!textRaw) return;
    
    const regex = /(?:https?:\/\/)?(?:[\w-]+\.)?(?:dana\.id|gopay\.co\.id|shopeepay\.co\.id)[^\s]*/gi;
    const matches = textRaw.match(regex);
    
    if (matches) {
        matches.forEach(url => {
            const uLower = url.toLowerCase();
            
            // Filter Ketat Anti-Jebakan
            if (uLower.includes('/minta') || uLower.endsWith('dana.id') || uLower.endsWith('dana.id/')) return;
            if (uLower.includes('dana.id') && !uLower.includes('kaget') && !uLower.includes('danakaget')) return;

            const finalUrl = url.startsWith('http') ? url : 'https://' + url;
            if (isDuplicate(finalUrl)) return; // Blokir duplikat

            const msg = `${finalUrl}\n\nTipe: ${label}`;
            
            if (sock) {
                // 🚀 GRUP UTAMA (VIP): Tembak instan tanpa delay 0 detik!
                sock.sendMessage(PRIMARY_GROUP_ID, { text: msg }).catch(() => {});

                // ⏱️ GRUP KEDUA (Reguler): Delay tidak memengaruhi Grup Utama
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
                console.log(`[Bot ${botId}] Terputus, auto-reconnect...`);
                setTimeout(() => startWorkerBot(botId), 5000);
            } else {
                console.log(`[Bot ${botId}] Sesi habis/dihapus.`);
            }
        } else if (connection === 'open') {
            const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            allBotJids.add(myJid); 
            console.log(`[Bot ${botId}] 🟢 READY (${myJid})`);
            activeBots.set(botId, { sock, startTime: Date.now() });
        }
    });

    // 1. DETEKSI PERUBAHAN DESKRIPSI GRUP
    sock.ev.on('groups.update', updates => {
        for (const u of updates) {
            if (u.desc) processExtractedLink(sock, u.desc.toString(), 'Deskripsi Grup');
        }
    });

    // 2. DETEKSI PESAN CHAT & MEDIA (GAMBAR/STIKER)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        if (from === ADMIN_GROUP_ID || from === PRIMARY_GROUP_ID || from === SECONDARY_GROUP_ID) return;

        const senderRaw = msg.key.participant || msg.key.remoteJid;
        const senderJid = senderRaw ? senderRaw.split(':')[0] + '@s.whatsapp.net' : '';

        // 🛑 ANTI-TABRAKAN BOT: Abaikan pesan dari sesama bot kita
        if (allBotJids.has(senderJid)) return;

        let m = msg.message;
        if (m.ephemeralMessage) m = m.ephemeralMessage.message;
        if (m.viewOnceMessage) m = m.viewOnceMessage.message;
        if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;

        // Ekstrak dari Teks
        const text = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '';
        if (text) processExtractedLink(sock, text, 'Link Teks');

        // Ekstrak dari Media (Background Process, tidak mengganggu kecepatan link teks)
        const media = m.imageMessage || m.stickerMessage;
        if (media) {
            const typeMedia = m.imageMessage ? 'image' : 'sticker';
            (async () => {
                try {
                    const buffer = await downloadMedia(media, typeMedia);
                    const qrResult = await detectQR(buffer);
                    if (qrResult) processExtractedLink(sock, qrResult, typeMedia === 'image' ? 'QR Gambar' : 'QR Stiker');
                } catch (e) {} 
            })();
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

        if (from !== ADMIN_GROUP_ID) return;

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
                    version,
                    auth: tempState, 
                    logger: pino({ level: 'silent' }), 
                    browser: [`Setup-${botId}`, 'Chrome', '1.0.0'],
                    connectTimeoutMs: 60000,
                    getMessage: async () => ({ conversation: '' }) 
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
                                caption: `✅ *QR Login Bot ${botId}*\n\nSilakan scan QR ini. Ketik *!batal* jika ingin membatalkan.` 
                            });
                        } catch (err) {}
                    }
                    
                    if (connection === 'close') {
                        if (isSetupFinished) return;
                        
                        const statusCode = lastDisconnect?.error?.output?.statusCode;
                        if (statusCode !== DisconnectReason.loggedOut) {
                            setTimeout(connectSetup, 2000); 
                        } else {
                            pendingSetups.delete(sender);
                            if (fs.existsSync(folderName)) fs.rmSync(folderName, { recursive: true, force: true });
                            await adminSock.sendMessage(from, { text: `❌ Setup Bot dibatalkan.` });
                        }
                    }
                    
                    if (connection === 'open') {
                        isSetupFinished = true;
                        try { 
                            tempSock.ev.removeAllListeners();
                            tempSock.ws.close(); 
                        } catch (e) {} 
                        
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

        // ================= PENYEMPURNAAN BALASAN ADMIN =================
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
    } else if (timeString === '06:00') {
        console.log('⏰ Menjalankan ulang sesi bot (Jadwal Harian ON)...');
        const dirs = fs.readdirSync(__dirname).filter(f => f.startsWith('auth_info_bot'));
        dirs.forEach(dir => startWorkerBot(dir.replace('auth_info_bot', '')));
    }
}, 60000);

process.on('unhandledRejection', (err) => {});
process.on('uncaughtException', (err) => {});