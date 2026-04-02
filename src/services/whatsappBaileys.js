const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

// Store sessions per store
const sessions = {};
const AUTH_DIR = path.join(__dirname, '../../wa-sessions');

function getSession(storeId) {
  return sessions[storeId] || null;
}

async function startSession(storeId, onQR, onConnected, onDisconnected) {
  // Clean up existing session
  if (sessions[storeId]?.sock) {
    try { sessions[storeId].sock.end(); } catch (e) {}
  }

  const sessionDir = path.join(AUTH_DIR, storeId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['MyMarket', 'Chrome', '120.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 30000,
    emitOwnEvents: false,
    generateHighQualityLinkPreview: false,
  });

  sessions[storeId] = {
    sock,
    status: 'connecting',
    qr: null,
    phone: null,
    name: null,
    lastConnected: null,
  };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Generate QR code as data URL
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        sessions[storeId].qr = qrDataUrl;
        sessions[storeId].status = 'waiting_qr';
        if (onQR) onQR(qrDataUrl);
      } catch (e) {
        console.log('[WA-Baileys] QR error:', e.message);
      }
    }

    if (connection === 'open') {
      const user = sock.user;
      sessions[storeId].status = 'connected';
      sessions[storeId].qr = null;
      sessions[storeId].phone = user?.id?.split(':')[0] || user?.id?.split('@')[0] || 'unknown';
      sessions[storeId].name = user?.name || '';
      sessions[storeId].lastConnected = new Date().toISOString();
      console.log(`[WA-Baileys] Connected: ${sessions[storeId].phone} (${sessions[storeId].name})`);
      if (onConnected) onConnected(sessions[storeId]);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[WA-Baileys] Disconnected: code=${statusCode}, reconnect=${shouldReconnect}`);
      sessions[storeId].status = 'disconnected';
      sessions[storeId].qr = null;

      if (shouldReconnect) {
        // Auto-reconnect after 5 seconds
        setTimeout(() => {
          console.log('[WA-Baileys] Auto-reconnecting...');
          startSession(storeId, onQR, onConnected, onDisconnected);
        }, 5000);
      } else {
        // Logged out — clear session files
        try {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch (e) {}
        sessions[storeId].status = 'logged_out';
        if (onDisconnected) onDisconnected('logged_out');
      }
    }
  });

  return sessions[storeId];
}

async function sendMessage(storeId, phone, message) {
  const session = sessions[storeId];
  if (!session || session.status !== 'connected') {
    return { success: false, reason: 'WhatsApp not connected. Scan QR code first.' };
  }

  // Normalize phone number for WhatsApp
  let num = String(phone).replace(/[\s\-\+\(\)]/g, '');
  if (num.startsWith('00213')) num = num.substring(2);
  else if (num.startsWith('0')) num = '213' + num.substring(1);
  else if (!num.startsWith('213') && num.length <= 10) num = '213' + num;

  const jid = num + '@s.whatsapp.net';

  try {
    // Rate limit: wait 2 seconds between messages
    await delay(2000);
    
    const result = await session.sock.sendMessage(jid, { text: message });
    console.log(`[WA-Baileys] Sent to ${num}`);
    return { success: true, messageId: result.key.id, to: num };
  } catch (e) {
    console.error(`[WA-Baileys] Send error:`, e.message);
    return { success: false, reason: e.message };
  }
}

async function disconnectSession(storeId) {
  const session = sessions[storeId];
  if (!session?.sock) return;
  try {
    await session.sock.logout();
    session.sock.end();
  } catch (e) {}
  
  const sessionDir = path.join(AUTH_DIR, storeId);
  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
  
  sessions[storeId] = { status: 'disconnected', qr: null, phone: null, name: null };
}

function getStatus(storeId) {
  const s = sessions[storeId];
  if (!s) return { status: 'not_started', connected: false };
  return {
    status: s.status,
    connected: s.status === 'connected',
    phone: s.phone,
    name: s.name,
    qr: s.qr,
    lastConnected: s.lastConnected,
  };
}

// Try to restore existing sessions on server start
async function restoreSessions() {
  if (!fs.existsSync(AUTH_DIR)) { fs.mkdirSync(AUTH_DIR, { recursive: true }); return; }
  const dirs = fs.readdirSync(AUTH_DIR);
  for (const storeId of dirs) {
    const sessionDir = path.join(AUTH_DIR, storeId);
    if (fs.statSync(sessionDir).isDirectory()) {
      console.log(`[WA-Baileys] Restoring session for store: ${storeId}`);
      try {
        await startSession(storeId);
      } catch (e) {
        console.log(`[WA-Baileys] Failed to restore ${storeId}:`, e.message);
      }
    }
  }
}

module.exports = {
  startSession,
  sendMessage,
  disconnectSession,
  getStatus,
  getSession,
  restoreSessions,
};
