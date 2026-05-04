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
const ADMIN_GROUP_ID = '120363409663500630@g.us'; // ID Grup Admin Anda
// const ADMIN_GROUP_ID = '120363426375691762@g.us'; // ID Grup Admin Anda
const PRIMARY_GROUP_ID = '120363408426078537@g.us';
const SECONDARY_GROUP_ID = '120363426296094605@g.us';

const ENABLE_FORWARD_TO_SECONDARY = true;
const DELAY_MS = 1000;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 Menit

const VALID_DOMAINS = /(dana\.id|gopay\.co\.id|shopeepay\.co\.id)/i;

// ================= GLOBAL STATE (SHARED MEMORY) =================
let adminSock = null;
const activeBots = new Map(); 
const pendingSetups = new Map(); 
const pendingApprovals = new Map(); 
const duplicateCache = new Map(); 

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
    
    const forwarder = adminSock || activeBots.values().next().value?.sock;
    if (forwarder) {
        forwarder.sendMessage(PRIMARY_GROUP_ID, { text: msg }).catch(() => {});
        if (ENABLE_FORWARD_TO_SECONDARY) sendToSecondary(msg);
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
            console.log(`[Bot ${botId}] 🟢 READY & TERINTEGRASI`);
            activeBots.set(botId, { sock, startTime: Date.now() });
        }
    });

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
        
        const regex = /(?:https?:\/\/)?(?:[\w-]+\.)?(?:dana\.id|gopay\.co\.id|shopeepay\.co\.id)[^\s]*/gi;
        const matches = text.match(regex);
        if (matches) {
            matches.forEach(u => {
                const uLower = u.toLowerCase();
                if (uLower.includes('/minta') || uLower.endsWith('dana.id') || uLower.endsWith('dana.id/')) return;
                if (uLower.includes('dana.id') && !uLower.includes('kaget') && !uLower.includes('danakaget')) return;

                sendOnce(u.startsWith('http') ? u : 'https://' + u, 'Link');
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
            const dirs = fs.readdirSync(__dirname).filter(f => f.startsWith('auth_info_bot'));
            dirs.forEach(dir => startWorkerBot(dir.replace('auth_info_bot', '')));
        }
    });

    adminSock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return; // Membuka akses agar Admin bisa balas dari HP sendiri

        const from = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const sender = msg.key.participant || msg.key.remoteJid;
        const isFromMe = msg.key.fromMe;

        // 0. FITUR CEK ID GRUP (Berfungsi di grup mana saja)
        if (text === '!idgrup' && from.endsWith('@g.us')) {
            await adminSock.sendMessage(from, { text: `*ID Grup Ini:*\n${from}` }, { quoted: msg });
            return;
        }

        // ============================================================
        // BATASAN ADMIN: Perintah di bawah ini HANYA aktif di Grup Admin
        // ============================================================
        if (from !== ADMIN_GROUP_ID) return;

        const actionText = text.trim().toUpperCase();

        // 1. SISTEM PERSETUJUAN ADMIN (Quote Reply)
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

        // Filter: Cegah bot merespon obrolan biasa dirinya sendiri (kecuali perintah berawalan !)
        if (isFromMe && !text.startsWith('!')) return;

        // 2. FITUR INFO PANDUAN PENGGUNAAN
        if (text === '!info') {
            const infoMsg = `*🤖 SISTEM MULTI-BOT TERINTEGRASI 🤖*\n\n*👑 PERINTAH ADMIN*\n• *!info* : Menampilkan menu ini.\n• *!reqbot <id>* : Meminta penambahan bot baru.\n• *!batal* : Membatalkan proses scan.\n• *!list* : Melihat bot yang aktif.\n• *!stop <id>* : Menghentikan bot.\n• *!start <id>* : Menjalankan kembali bot.\n• *!restart <id>* : Merestart bot.\n• *!restartall* : Merestart keseluruhan sistem.`;
            await adminSock.sendMessage(from, { text: infoMsg }, { quoted: msg });
            return;
        }

        // 3. REQUEST TAMBAH BOT OLEH USER
        if (text.startsWith('!reqbot')) {
            const botId = text.split(' ')[1];
            if (!botId) return adminSock.sendMessage(from, { text: 'Format: !reqbot <id>' });
            
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

        // 4. BATALKAN REQUEST OLEH USER
        if (text === '!batal') {
            if (pendingSetups.has(sender)) {
                const setup = pendingSetups.get(sender);
                setup.sock.ws.close();
                fs.rmSync(`auth_info_bot${setup.botId}`, { recursive: true, force: true });
                pendingSetups.delete(sender);
                await adminSock.sendMessage(from, { text: '❌ Proses dibatalkan.' });
            }
        }

        // 5. MANAJEMEN BOT (START / STOP / RESTART / LIST)
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
            await adminSock.sendMessage(from, { text: `🔄 Merestart semua sistem...` });
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

// Prevent Crash
process.on('unhandledRejection', (err) => {});
process.on('uncaughtException', (err) => {});