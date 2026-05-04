const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const Jimp = require('jimp');
const QrCode = require('qrcode-reader');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

require('events').EventEmitter.defaultMaxListeners = 0;

// ================= CONFIGURATION =================
const ADMIN_GROUP_ID = '120363426375691762@g.us'; // GANTI DENGAN ID GRUP ADMIN
const PRIMARY_GROUP_ID = '120363408426078537@g.us';
const SECONDARY_GROUP_ID = '120363426296094605@g.us';

const ENABLE_FORWARD_TO_SECONDARY = true;
const DELAY_MS = 1000;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 Menit

const VALID_DOMAINS = /(dana\.id|gopay\.co\.id|shopeepay\.co\.id)/i;

// ================= GLOBAL STATE (SHARED MEMORY) =================
let adminSock = null;
const activeBots = new Map(); // Menyimpan instance bot yang berjalan
const pendingSetups = new Map(); // Menyimpan proses scan QR yang belum selesai
const pendingApprovals = new Map(); // Menyimpan request menunggu persetujuan admin { messageId: botId }
const duplicateCache = new Map(); // In-Memory Cache super cepat

// ================= IN-MEMORY ANTI DUPLIKAT =================
function isDuplicate(link) {
    const hash = crypto.createHash('md5').update(link).digest('hex');
    if (duplicateCache.has(hash)) return true;
    
    duplicateCache.set(hash, Date.now());
    setTimeout(() => duplicateCache.delete(hash), CACHE_TTL_MS);
    return false;
}

// ================= SECONDARY SMART QUEUE =================
const secondaryQueue = [];
let isProcessingQueue = false;

async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (secondaryQueue.length > 0) {
        const msg = secondaryQueue.shift();
        try {
            // Gunakan bot admin atau bot pertama yang aktif untuk mem-forward ke secondary
            const forwarder = adminSock || activeBots.values().next().value?.sock;
            if (forwarder) await forwarder.sendMessage(SECONDARY_GROUP_ID, { text: msg });
        } catch (e) { console.error("Gagal forward ke secondary", e); }
        await new Promise(res => setTimeout(res, DELAY_MS));
    }
    isProcessingQueue = false;
}

function sendToSecondary(msg) {
    if (secondaryQueue.length >= 100) secondaryQueue.shift();
    secondaryQueue.push(msg);
    processQueue();
}

function sendOnce(text, label) {
    const key = text.trim();
    if (isDuplicate(key)) return;

    const msg = `${key}\n\nTipe: ${label}`;
    
    // Fast forward ke Primary menggunakan Admin bot atau bot yang tersedia
    const forwarder = adminSock || activeBots.values().next().value?.sock;
    if (forwarder) {
        forwarder.sendMessage(PRIMARY_GROUP_ID, { text: msg }).catch(() => {});
        if (ENABLE_FORWARD_TO_SECONDARY) sendToSecondary(msg);
    }
}

// ================= WORKER BOT MANAGER =================
async function startWorkerBot(botId) {
    if (activeBots.has(botId)) return; // Cegah double start

    const folderName = `auth_info_bot${botId}`;
    if (!fs.existsSync(folderName)) return; // Pastikan auth ada

    const { state, saveCreds } = await useMultiFileAuthState(folderName);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }), // Ganti ke 'silent' agar RDP tidak lag
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
            console.log(`[Bot ${botId}] 🟢 READY & TERINTEGRASI`);
            activeBots.set(botId, { sock, startTime: Date.now() });
        }
    });

    // Worker Bot Message Handler (Hanya deteksi link)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        if (from === ADMIN_GROUP_ID || from === PRIMARY_GROUP_ID || from === SECONDARY_GROUP_ID) return;

        let m = msg.message;
        if (m.ephemeralMessage) m = m.ephemeralMessage.message;
        if (m.viewOnceMessage) m = m.viewOnceMessage.message;
        if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;

        const text = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || '';
        
        // Ekstrak URL Super Cepat
        const regex = /(?:https?:\/\/)?(?:[\w-]+\.)?(?:dana\.id|gopay\.co\.id|shopeepay\.co\.id)[^\s]*/gi;
        const matches = text.match(regex);
        if (matches) {
            matches.forEach(u => {
                if (!u.includes('/minta') && !u.endsWith('dana.id') && !u.endsWith('dana.id/')) {
                    sendOnce(u.startsWith('http') ? u : 'https://' + u, 'Link');
                }
            });
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
            console.log('👑 SYSTEM CORE ADMIN READY!');
            // Auto-start semua bot yang foldernya ada
            const dirs = fs.readdirSync(__dirname).filter(f => f.startsWith('auth_info_bot'));
            dirs.forEach(dir => startWorkerBot(dir.replace('auth_info_bot', '')));
        }
    });

    adminSock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const from = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const sender = msg.key.participant || msg.key.remoteJid;

        // 0. FITUR CEK ID GRUP (Berfungsi di grup mana saja)
        if (text === '!idgrup' && from.endsWith('@g.us')) {
            await adminSock.sendMessage(from, { text: `*ID Grup Ini:*\n${from}` }, { quoted: msg });
            return;
        }

        // ============================================================
        // BATASAN ADMIN: Perintah di bawah ini HANYA jalan di Grup Admin
        // ============================================================
        if (from !== ADMIN_GROUP_ID) return;

        // 1. SISTEM PERSETUJUAN ADMIN (Quote Reply)
        const contextInfo = msg.message.extendedTextMessage?.contextInfo;
        if (contextInfo?.stanzaId && pendingApprovals.has(contextInfo.stanzaId)) {
            const botId = pendingApprovals.get(contextInfo.stanzaId);
            const action = text.trim().toLowerCase();

            if (action === 'oke' || action === 'iya') {
                pendingApprovals.delete(contextInfo.stanzaId);
                await adminSock.sendMessage(from, { text: `✅ Permintaan disetujui. Bot *${botId}* sedang dijalankan...` });
                startWorkerBot(botId);
            } else if (action === 'tidak') {
                pendingApprovals.delete(contextInfo.stanzaId);
                fs.rmSync(`auth_info_bot${botId}`, { recursive: true, force: true });
                await adminSock.sendMessage(from, { text: `❌ Permintaan ditolak. Sesi Bot *${botId}* dihapus.` });
            }
            return;
        }

        // 2. REQUEST TAMBAH BOT OLEH USER
        if (text.startsWith('!reqbot')) {
            const botId = text.split(' ')[1];
            if (!botId) return adminSock.sendMessage(from, { text: 'Format: !reqbot <id>' });
            if (activeBots.has(botId) || fs.existsSync(`auth_info_bot${botId}`)) {
                return adminSock.sendMessage(from, { text: '⚠️ Bot ID sudah ada/aktif.' });
            }

            const loadingMsg = await adminSock.sendMessage(from, { text: `⏳ Generate QR untuk Bot ${botId}...` });
            
            // Generate temporary socket untuk ambil QR
            const { state: tempState } = await useMultiFileAuthState(`auth_info_bot${botId}`);
            const tempSock = makeWASocket({ auth: tempState, logger: pino({ level: 'silent' }), browser: [`Setup-${botId}`, 'Chrome', '1.0.0'] });
            
            pendingSetups.set(sender, { sock: tempSock, botId });

            tempSock.ev.on('connection.update', async (update) => {
                const { connection, qr } = update;
                if (qr) {
                    const qrBuffer = await qrcode.toBuffer(qr, { scale: 6 });
                    await adminSock.sendMessage(from, { image: qrBuffer, caption: `QR Login untuk Bot *${botId}*\nKetik *!batal* untuk menggagalkan.` });
                }
                if (connection === 'open') {
                    // Berhasil scan, minta persetujuan admin
                    tempSock.ws.close(); // Tutup koneksi sementara
                    pendingSetups.delete(sender);
                    
                    const askMsg = await adminSock.sendMessage(from, { 
                        text: `🔔 *PERMOHONAN BOT BARU*\n\nUser: @${sender.split('@')[0]}\nBot ID: *${botId}*\nStatus: QR Berhasil di-scan.\n\n👉 *Admin*: Balas pesan ini dengan *OKE* untuk menyalakan atau *TIDAK* untuk menolak.`,
                        mentions: [sender]
                    });
                    pendingApprovals.set(askMsg.key.id, botId);
                }
            });
            return;
        }

        // 3. BATALKAN REQUEST OLEH USER
        if (text === '!batal') {
            if (pendingSetups.has(sender)) {
                const setup = pendingSetups.get(sender);
                setup.sock.ws.close();
                fs.rmSync(`auth_info_bot${setup.botId}`, { recursive: true, force: true });
                pendingSetups.delete(sender);
                await adminSock.sendMessage(from, { text: '❌ Proses dibatalkan oleh user.' });
            }
        }

        // 4. MANAJEMEN BOT (START / STOP / RESTART / LIST)
        if (text === '!list') {
            let reply = `*🔥 DAFTAR BOT AKTIF (${activeBots.size})*\n`;
            for (let [id, data] of activeBots.entries()) {
                const uptime = Math.floor((Date.now() - data.startTime) / 60000);
                reply += `\n🤖 Bot ID: *${id}*\n⏱ Uptime: ${uptime} Menit\n`;
            }
            await adminSock.sendMessage(from, { text: reply });
        }

        if (text.startsWith('!stop ')) {
            const id = text.split(' ')[1];
            if (activeBots.has(id)) {
                activeBots.get(id).sock.ws.close();
                activeBots.delete(id);
                await adminSock.sendMessage(from, { text: `🛑 Bot ${id} dihentikan.` });
            } else {
                await adminSock.sendMessage(from, { text: `⚠️ Bot ${id} tidak sedang aktif.` });
            }
        }

        if (text.startsWith('!start ')) {
            const id = text.split(' ')[1];
            if (!activeBots.has(id)) {
                await adminSock.sendMessage(from, { text: `🟢 Memulai bot ${id}...` });
                startWorkerBot(id);
            }
        }

        if (text.startsWith('!restart ')) {
            const id = text.split(' ')[1];
            await adminSock.sendMessage(from, { text: `🔄 Restarting bot ${id}...` });
            if (activeBots.has(id)) {
                activeBots.get(id).sock.ws.close();
                activeBots.delete(id);
            }
            setTimeout(() => startWorkerBot(id), 2000);
        }
        
        if (text === '!restartall') {
            await adminSock.sendMessage(from, { text: `🔄 Merestart semua bot & Core System...` });
            process.exit(0); // PM2 akan otomatis menghidupkan ulang keseluruhan sistem
        }
    });
}

startAdminBot();

// Prevent Crash
process.on('unhandledRejection', (err) => console.log('Unhandled Rejection:', err));
process.on('uncaughtException', (err) => console.log('Uncaught Exception:', err));