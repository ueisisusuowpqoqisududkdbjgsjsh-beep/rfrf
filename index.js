require("dotenv").config();
const admin = require("firebase-admin");
const { TonClient, WalletContractV5R1, internal, toNano } = require("@ton/ton");
const { mnemonicToWalletKey } = require("@ton/crypto");
const TelegramBot = require('node-telegram-bot-api');

process.stdin.resume();
process.on('SIGTERM', () => { console.log('⚠️ SIGTERM - IGNORING'); });
process.on('SIGINT',  () => { console.log('⚠️ SIGINT - IGNORING');  });

setInterval(() => {
  console.log('💓 BOT ALIVE - ' + new Date().toISOString());
  const fs = require('fs');
  try { fs.writeFileSync('/tmp/bot-alive.txt', Date.now().toString()); } catch(e) {}
}, 5 * 60 * 1000);

// ==========================
// 🔹 Logging
// ==========================
let logCounter = 0;
function smartLog(...args) { if (++logCounter <= 50) console.log(...args); }
setInterval(() => { logCounter = 0; }, 5 * 60 * 1000);

// ==========================
// 🔹 Admin settings
// ==========================
const ADMIN_CHAT_ID = "1111087186";
const ADMIN_CHAT_IDS = ["6970148965", "1111087186"];
const isAdminId = (id) => ADMIN_CHAT_IDS.includes(String(id));

// ==========================
// 🔹 Processing settings
// ==========================
const MAX_RETRIES         = 3;
const RETRY_DELAY         = 10000;

let PROCESSING_MODE       = 'batch';
let BATCH_SIZE            = 10;
const BATCH_FLUSH_SECONDS = 120;
const BATCH_BETWEEN_DELAY = 3000;
let SINGLE_DELAY_MS       = 3000;

let MAX_WITHDRAWAL_AMOUNT = 10;
let MIN_WITHDRAWAL_AMOUNT = 0.5;
let MAX_BALANCE_BUFFER    = 0;
let BAMBOO_TO_TON_RATE    = 50000;
let DAILY_LIMIT           = 2;
let DAILY_COOLDOWN_HOURS  = 24;
let systemPaused          = false;

// ==========================
// 🔹 Withdrawal & deposit system control
// ==========================
let WITHDRAWAL_ENABLED = true;
let DEPOSIT_ENABLED    = true;  // ✅ Deposit monitoring enabled

// ==========================
// 🔹 Bot / channel / links settings
// ==========================
const BOT_NAME                = "PMT GRAM";
const BOT_URL                 = "https://t.me/Pmt_Gram_Bot/app";
const WITHDRAWAL_CHANNEL_URL  = "https://t.me/Pmt_Payout";
const WITHDRAWAL_CHANNEL_ID   = "@Pmt_Payout";
const PAYMENT_IMAGE_URL       = "https://res.cloudinary.com/q1tmmkbe/image/upload/v1787631390/ChatGPT_Image_Aug_25_2026_07_17_31_AM.png";
const WELCOME_IMAGE_URL       = PAYMENT_IMAGE_URL;

// ==========================
// 🔹 Amount rounding function
// ==========================
function roundAmount(amount) {
  try {
    const n = typeof amount === 'string' ? parseFloat(amount) : Number(amount);
    if (isNaN(n) || n <= 0) return 0;
    const r = Math.floor(n * 1000) / 1000;
    return r < 0.001 ? 0.001 : r;
  } catch { return 0.001; }
}

function todayKeyCairo() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseLogLimitArg(value) {
  if (!value) return null;
  const raw = String(value).trim().toLowerCase();
    if (['all'].includes(raw)) return 'all';
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return null;
  return Math.min(n, 1000);
}

function getLogLimitLabel(limit) {
    return limit === 'all' ? 'All activities' : `Last ${limit} activities`;
}

function getActivityTimestamp(entry) {
  if (entry?.ts) return Number(entry.ts) || 0;
  if (entry?.timestamp) return Number(entry.timestamp) || 0;
  if (entry?.date) {
    const parsed = Date.parse(entry.date);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function formatCompactNumber(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function firstNumeric(entry, keys) {
  for (const key of keys) {
    if (entry[key] !== undefined && entry[key] !== null && entry[key] !== '') {
      const n = Number(entry[key]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function formatActivityValue(entry) {
  const lines = [];
  const requested = firstNumeric(entry, ['amount_requested', 'amtRequested', 'requestedAmount', 'withdrawRequested']);
  const net = firstNumeric(entry, ['amount_net', 'amt', 'netAmount', 'withdrawNet']);
  const fee = firstNumeric(entry, ['fee', 'withdrawFee']);

  if (requested !== null || net !== null || fee !== null) {
    const parts = [];
        if (requested !== null) parts.push(`Requested ${formatCompactNumber(requested)} TON`);
        if (net !== null) parts.push(`Net ${formatCompactNumber(net)} TON`);
        if (fee !== null) parts.push(`Fee ${formatCompactNumber(fee)} TON`);
        lines.push(`💎 <b>Withdrawal value:</b> ${parts.join(' | ')}`);
  }

  const deposit = firstNumeric(entry, ['deposit', 'tonAdded', 'depositAmount']);
    if (deposit !== null) lines.push(`📥 <b>Deposit:</b> ${formatCompactNumber(deposit)} TON`);

  const tonReward = firstNumeric(entry, ['rewardTon', 'tonReward', 'reward_ton', 'ton_reward', 'tonPrize', 'earnedTon']);
    if (tonReward !== null) lines.push(`🎁 <b>TON Reward:</b> ${formatCompactNumber(tonReward)} TON`);

  const bambooReward = firstNumeric(entry, ['rewardBamboo', 'bambooReward', 'reward_bamboo', 'bamboo_reward', 'bambooEarned']);
    if (bambooReward !== null) lines.push(`🎍 <b>Bamboo Reward:</b> ${formatCompactNumber(bambooReward, 0)}`);

  const coinsReward = firstNumeric(entry, ['rewardCoins', 'coinsReward', 'reward_coins', 'coins_reward', 'coinsEarned']);
    if (coinsReward !== null) lines.push(`🪙 <b>Coins Reward:</b> ${formatCompactNumber(coinsReward, 0)}`);

  const genericReward = firstNumeric(entry, ['reward', 'rewardAmount', 'amountReward', 'prize', 'earned']);
  if (genericReward !== null && tonReward === null && bambooReward === null && coinsReward === null) {
    const unit = entry.rewardUnit || entry.unit || entry.currency || '';
        lines.push(`🎁 <b>Reward:</b> ${formatCompactNumber(genericReward)}${unit ? ' ' + escapeHtml(unit) : ''}`);
  }

  const amount = firstNumeric(entry, ['amount']);
  if (amount !== null && deposit === null && genericReward === null && requested === null && net === null) {
        lines.push(`💎 <b>Value:</b> ${formatCompactNumber(amount)} TON`);
  }

  const price = firstNumeric(entry, ['price', 'cost']);
    if (price !== null) lines.push(`💳 <b>Price:</b> ${formatCompactNumber(price)} TON`);

    if (!lines.length) return '🎁 <b>Reward:</b> —';
  return lines.join('\n  ');
}

function formatActivityBalances(entry) {
  const lines = [];
  const tonBefore = firstNumeric(entry, ['tonBalance_before', 'ton_before']);
  const tonAfter = firstNumeric(entry, ['tonBalance_after', 'ton_after']);
  if (tonBefore !== null || tonAfter !== null) {
        lines.push(`💰 <b>TON Balance:</b> ${tonBefore !== null ? formatCompactNumber(tonBefore) : '—'} → ${tonAfter !== null ? formatCompactNumber(tonAfter) : '—'}`);
  }
  const bambooBefore = firstNumeric(entry, ['bamboo_before', 'bambooBalance_before']);
  const bambooAfter = firstNumeric(entry, ['bamboo_after', 'bambooBalance_after']);
  if (bambooBefore !== null || bambooAfter !== null) {
    lines.push(`🎍 <b>Bamboo:</b> ${bambooBefore !== null ? formatCompactNumber(bambooBefore, 0) : '—'} → ${bambooAfter !== null ? formatCompactNumber(bambooAfter, 0) : '—'}`);
  }
  const coinsBefore = firstNumeric(entry, ['coins_before', 'coinsBalance_before']);
  const coinsAfter = firstNumeric(entry, ['coins_after', 'coinsBalance_after']);
  if (coinsBefore !== null || coinsAfter !== null) {
    lines.push(`🪙 <b>Coins:</b> ${coinsBefore !== null ? formatCompactNumber(coinsBefore, 0) : '—'} → ${coinsAfter !== null ? formatCompactNumber(coinsAfter, 0) : '—'}`);
  }
  return lines.join('\n  ');
}

async function showLogLimitChooser(bot, chatId, userId) {
  await adminReply(bot, chatId,
        `📋 <b>User Log</b> <code>${escapeHtml(userId)}</code>\n\n` +
        `Choose the number of activities to display, or use:\n` +
    `<code>/logs ${escapeHtml(userId)} 100</code>\n` +
    `<code>/logs ${escapeHtml(userId)} all</code>`,
    {
      reply_markup: {
        inline_keyboard: [
          [
                        { text: 'Last 30', callback_data: `log_limit:${userId}:30` },
                        { text: 'Last 100', callback_data: `log_limit:${userId}:100` },
          ],
          [
                        { text: 'Last 200', callback_data: `log_limit:${userId}:200` },
                        { text: 'All activities', callback_data: `log_limit:${userId}:all` },
          ],
        ],
      },
    }
  );
}

async function sendUserLogs(bot, chatId, userId, limitOption = 30) {
  const limit = limitOption === 'all' ? 'all' : (parseLogLimitArg(limitOption) || 30);
    await adminReply(bot, chatId, `🔍 Fetching ${getLogLimitLabel(limit)} for user <code>${escapeHtml(userId)}</code>...`);

  const logRef = db.ref(`users/${userId}/log`);
  const [logSnap, wdSnap, depSnap] = await Promise.all([
    limit === 'all' ? logRef.once('value') : logRef.limitToLast(limit).once('value'),
    db.ref(`users/${userId}/wdHistory`).once('value'),
    db.ref(`users/${userId}/deposits`).once('value'),
  ]);

  const logs     = logSnap.val()  || {};
  const wdHist   = wdSnap.val()   || {};
  const deposits = depSnap.val()  || {};

  const totalDep  = Object.values(deposits).reduce((s, d) => s + Number(d.amount || d.tonAdded || 0), 0);
  const totalPaid = Object.values(wdHist).filter(w => w.status === 'paid').reduce((s, w) => s + Number(w.sentAmount || 0), 0);
  const paidCount = Object.values(wdHist).filter(w => w.status === 'paid').length;

  let text =
        `📊 <b>Financial Log — User <code>${escapeHtml(userId)}</code></b>\n` +
    `${'━'.repeat(30)}\n\n` +
        `📥 Total deposits: <b>${totalDep.toFixed(4)} TON</b>\n` +
        `📤 Total withdrawn: <b>${totalPaid.toFixed(4)} TON</b>\n` +
        `✅ Successful withdrawals: <b>${paidCount}</b>\n\n` +
    `${'─'.repeat(30)}\n` +
    `📋 <b>${getLogLimitLabel(limit)}:</b>\n\n`;

  const logEntries = Object.entries(logs)
    .sort((a, b) => getActivityTimestamp(b[1]) - getActivityTimestamp(a[1]));

  if (!logEntries.length) {
        text += `<i>No activity log</i>`;
  } else {
    logEntries.forEach(([, entry]) => {
      const ts = getActivityTimestamp(entry);
      const date = ts ? new Date(ts).toISOString().substring(0, 16).replace('T', ' ') : (entry.date ? String(entry.date).substring(0, 16).replace('T', ' ') : '—');
            const type = escapeHtml(entry.type || entry.activityName || entry.name || 'Activity');
      const cat  = entry.taskCategory || entry.category ? escapeHtml(entry.taskCategory || entry.category) : '';
      const tid  = entry.taskId || entry.activityId || '';
      const valueLine = formatActivityValue(entry);
      const balanceLine = formatActivityBalances(entry);
      text += `• <b>${type}</b>${cat ? ' | ' + cat : ''}${tid ? ' | <code>' + escapeHtml(tid) + '</code>' : ''}\n`;
      text += `  🕐 ${date}\n`;
      text += `  ${valueLine}\n`;
      if (balanceLine) text += `  ${balanceLine}\n`;
      text += `\n`;
    });
  }

  const chunks = [];
  let remaining = text;
  while (remaining.length > 3500) {
    let cut = remaining.lastIndexOf('\n', 3500);
    if (cut < 1000) cut = 3500;
    chunks.push(remaining.substring(0, cut));
    remaining = remaining.substring(cut);
  }
  chunks.push(remaining);

  for (const chunk of chunks) {
    await adminReply(bot, chatId, chunk);
    await new Promise(r => setTimeout(r, 300));
  }
}

// ==========================
// 🔹 Firebase
// ==========================
if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.error("❌ FIREBASE_SERVICE_ACCOUNT missing"); process.exit(1); }
try {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DB_URL,
  });
  console.log("✅ Firebase connected");
} catch (e) { console.error("❌ Firebase error:", e.message); process.exit(1); }
const db = admin.database();

// ==========================
// 🔹 TON Client
// ==========================
if (!process.env.TON_API_KEY) { console.error("❌ TON_API_KEY missing"); process.exit(1); }
const client = new TonClient({
  endpoint: "https://toncenter.com/api/v2/jsonRPC",
  apiKey: process.env.TON_API_KEY,
});

// ==========================
// 🔹 Wallet variables
// ==========================
let walletContract = null;
let walletKey      = null;
let walletAddress  = null;
let isProcessing   = false;
const processingQueue = new Set();
let botInstance    = null;

// ==========================
// 🔹 Create wallet
// ==========================
async function getWallet() {
  if (walletContract && walletKey && walletAddress)
    return { contract: walletContract, key: walletKey, address: walletAddress };
  const mnemonic = process.env.TON_MNEMONIC.split(" ");
  const key      = await mnemonicToWalletKey(mnemonic);
  const wallet   = WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey });
  const contract = client.open(wallet);
  const address  = contract.address.toString();
  walletContract = contract; walletKey = key; walletAddress = address;
  console.log("✅ Wallet loaded:", address.substring(0, 10) + "...");
  return { contract, key, address };
}

async function getWalletBalance() {
  try {
    const { contract } = await getWallet();
    return Number(await contract.getBalance()) / 1e9;
  } catch (e) { console.log(`❌ getWalletBalance: ${e.message}`); return 0; }
}

// ==========================
// 🔹 Ban check
// ==========================
async function isWalletBanned(address) {
  try {
    const snap = await db.ref(`bannedWallets/${address.replace(/[.$#[\]/]/g, '_')}`).once("value");
    return snap.exists();
  } catch { return false; }
}

async function isUserBanned(userId) {
  try {
    const snap = await db.ref(`bannedUsers/${userId}`).once("value");
    return snap.exists();
  } catch { return false; }
}

// ==========================
// 🔹 Daily withdrawal count check
// ==========================
async function getUserDailyWithdrawalCount(userId) {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const snap = await db.ref("withdrawQueue")
      .orderByChild("userId").equalTo(userId).once("value");
    if (!snap.exists()) return 0;
    let count = 0;
    snap.forEach(child => {
      const d = child.val();
      const ts = d.ts || d.timestamp || 0;
      const status = d.status || '';
      if (ts >= startOfDay.getTime() && ['paid', 'processing', 'pending', 'awaiting_approval', 'awaiting_manual'].includes(status)) {
        count++;
      }
    });
    return count;
  } catch (e) { console.log(`❌ getUserDailyWithdrawalCount: ${e.message}`); return 0; }
}

// ==========================
// 🔹 Notify admin of approval request
// ==========================
// ==========================
// 🔹 Instant alert to admin for a withdrawal needing manual approval (sent automatically as soon as the status changes)
// ==========================
async function sendManualReviewAlert(withdrawId, data, reason) {
  if (!botInstance) return;
  const roundedAmount = roundAmount(data.ton ?? data.amt);
  const userId  = data.userId || 'unknown';
  const address = data.address || '—';
  const requestTime = new Date(data.ts || Date.now()).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false });

  const text =
        `🔍 <b>Withdrawal needs manual approval</b>\n\n` +
    `👤 User: <code>${userId}</code>\n` +
    `🆔 ID: <code>${withdrawId}</code>\n\n` +
        `💰 Amount: <b>${roundedAmount.toFixed(4)} TON</b>\n` +
        `📬 Wallet:\n<code>${address}</code>\n\n` +
        `⚠️ Reason: ${reason}\n` +
        `🕐 Time: ${requestTime} UTC\n\n` +
        `Do you approve this withdrawal? (or use /pending_wd to view all details)`;

  try {
    await botInstance.sendMessage(ADMIN_CHAT_ID, text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
                    { text: "✅ Approve — Pay now", callback_data: `approve_wd:${withdrawId}` },
                    { text: "❌ Reject — Cancel",        callback_data: `reject_wd:${withdrawId}`  },
        ]]
      }
    });
    console.log(`📨 Manual review alert sent for ${withdrawId}`);
  } catch (e) { console.log(`❌ sendManualReviewAlert: ${e.message}`); }
}

async function sendAdminApprovalRequest(botInstance, withdrawId, data, dailyCount) {
  const roundedAmount = roundAmount(data.ton);
  const userId        = data.userId || 'unknown';
  const address       = data.address || '—';
  const amountCoins   = data.amt || 0;
  const requestTime   = new Date(data.ts || Date.now()).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false });

  const text =
        `⚠️ <b>Withdrawal needs approval</b>\n\n` +
    `👤 User: <code>${userId}</code>\n` +
        `📅 Withdrawals today: <b>${dailyCount}</b> (exceeds the allowed limit)\n\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `🆔 ID: <code>${withdrawId}</code>\n` +
        `💰 Amount: <b>${roundedAmount} TON</b>\n` +
    `🪙 Bamboo: <b>${Number(amountCoins).toLocaleString()}</b>\n` +
        `📬 Wallet:\n<code>${address}</code>\n` +
        `🕐 Time: ${requestTime} UTC\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
        `Do you approve this withdrawal?`;

  try {
    await botInstance.sendMessage(ADMIN_CHAT_ID, text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
                    { text: "✅ Approve — Pay now", callback_data: `approve_wd:${withdrawId}` },
                    { text: "❌ Reject — Cancel",        callback_data: `reject_wd:${withdrawId}`  },
        ]]
      }
    });
    console.log(`📨 Approval request sent for ${withdrawId}`);
  } catch (e) { console.log(`❌ sendAdminApprovalRequest: ${e.message}`); }
}

async function checkSufficientBalance(requiredAmount) {
  const balance = await getWalletBalance();
  return {
    sufficient: balance >= (requiredAmount + MAX_BALANCE_BUFFER),
    balance, required: requiredAmount
  };
}

// ==========================
// 🔹 Helper function to reply to admin
// ==========================
async function adminReply(bot, chatId, text, extra = {}) {
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  } catch (e) { console.log(`❌ adminReply: ${e.message}`); }
}

// ==========================
// 🔹 Verify transaction confirmation (for Batch)
// ==========================
async function confirmBatchTransaction(expectedSeqno, maxWaitMs = 120000) {
  const start = Date.now();
  console.log(`🔍 Waiting for batch seqno ${expectedSeqno + 1} to confirm...`);

  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 4000));
    try {
      const { contract } = await getWallet();
      const currentSeqno = await contract.getSeqno();
      if (currentSeqno > expectedSeqno) {
        console.log(`✅ Batch seqno advanced: ${expectedSeqno} → ${currentSeqno}`);
        return { confirmed: true, reason: 'seqno_advanced' };
      }
    } catch (e) { console.log(`⚠️ seqno check error: ${e.message}`); }
  }

  return { confirmed: false, reason: 'seqno_timeout' };
}

// ==========================
// 🔹 Notify user of withdrawal
// ==========================
function maskUserId(userId) {
  const uid = String(userId || 'Unknown');
  if (uid.length <= 4) return uid;
  const start = Math.ceil(uid.length / 3);
  const end   = Math.floor(uid.length / 4);
  return uid.substring(0, start) + '***' + uid.substring(uid.length - end);
}

// ==========================
// 🔹 Unified withdrawal success message (used for both the user and the channel)
// ==========================
function buildPayoutCaption(userId, amountTon) {
  const masked = maskUserId(userId);
  return (
    `💎 <b>PAYMENT SENT</b>\n\n` +
    `🚀 <b>Withdrawal Completed Successfully</b>\n\n` +
    `👤 <b>User:</b> <code>${masked}</code>\n` +
    `💰 <b>Amount:</b> <code>${amountTon.toFixed(4)} TON</code>\n` +
    `🟣 <b>Network:</b> TON\n` +
    `✅ <b>Status:</b> <b>SUCCESSFUL</b>\n\n` +
    `━━━━━━━━━━━━━━\n\n` +
    `💎 Your reward has been processed and sent directly to your <b>TON Wallet</b>.\n\n` +
    `🔗 <b>Transaction:</b> Verified On-Chain\n` +
    `⚡ <b>Processing:</b> Fast &amp; Secure\n\n` +
    `🏆 <b>PMT Gram</b>\n` +
    `<i>Earn • Complete • Get Paid</i>`
  );
}

function buildPayoutKeyboard(txLink) {
  const keys = [];
  if (txLink) keys.push({ text: "🔍 View Transaction", url: txLink });
  keys.push({ text: "🚀 Open PMT Gram", url: BOT_URL });
  return { inline_keyboard: [keys] };
}

async function sendUserNotification(chatId, amountTon, amountCoins, txHash) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !chatId) return false;
  const txLink  = txHash ? `https://tonscan.org/tx/${encodeURIComponent(txHash)}` : null;
  const caption = buildPayoutCaption(chatId, amountTon);
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: PAYMENT_IMAGE_URL,
        caption,
        parse_mode: 'HTML',
        reply_markup: buildPayoutKeyboard(txLink)
      }),
    });
    const data = await res.json();
    if (data.ok) { console.log(`✅ User notified: ${chatId}`); return true; }
    console.log(`❌ Telegram: ${data.description}`); return false;
  } catch (e) { console.log(`❌ sendUserNotification: ${e.message}`); return false; }
}

// ==========================
// 🔹 Withdrawal channel notification
// ==========================
async function sendChannelNotification(items, txHash) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;

  const txLink = txHash ? `https://tonscan.org/tx/${encodeURIComponent(txHash)}` : null;

    // Each item in the batch is sent as a separate message using the same format as the user message
  for (const item of items) {
    const caption = buildPayoutCaption(item.userId, item.roundedAmount);
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id:      WITHDRAWAL_CHANNEL_ID,
          photo:        PAYMENT_IMAGE_URL,
          caption,
          parse_mode:   'HTML',
          reply_markup: buildPayoutKeyboard(txLink)
        }),
      });
      const d = await res.json();
      if (d.ok) console.log(`✅ Channel notified — user ${item.userId}`);
      else console.log(`❌ Channel notification failed: ${d.description}`);
    } catch (e) { console.log(`❌ sendChannelNotification: ${e.message}`); }
  }
}

// ==========================
// 🔹 Update wdHistory
// ==========================
async function updateUserWdHistory(userId, wdId, txHash, amountTon) {
  if (!userId || !wdId) return;
  try {
    await db.ref(`users/${userId}/wdHistory/${wdId}`).update({
      status:      "paid",
      txHash:      txHash || null,
      sentAmount:  amountTon,
      paidAt:      Date.now(),
    });
    console.log(`✅ wdHistory updated: users/${userId}/wdHistory/${wdId}`);
  } catch (e) { console.log(`❌ updateUserWdHistory: ${e.message}`); }
}

// ==========================
// 🔹 Validate withdrawal
// ==========================
async function validateWithdrawal(withdrawId, data) {
  if (!data?.address || (!data?.ton && !data?.amt)) {
    await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "failed", error: "Invalid data", updatedAt: Date.now() });
    return { valid: false, skip: true };
  }

  const roundedAmount = roundAmount(data.ton ?? data.amt);
  const userId        = data.userId || null;
  const wdId          = data.wdId   || withdrawId;
  const addr          = String(data.address || '').trim();

  const validPrefix  = addr.startsWith("EQ") || addr.startsWith("UQ");
  const validLength  = addr.length === 48;
  const validChars   = /^[A-Za-z0-9+/\-_=]+$/.test(addr);
  const duplicated   = addr.indexOf("EQ", 2) !== -1 || addr.indexOf("UQ", 2) !== -1;
  const hasSpaces    = addr.includes(' ');

  let addrError = null;
  if (!validPrefix)  addrError = `Invalid prefix (expected EQ/UQ, got ${addr.substring(0,2)})`;
  else if (duplicated) addrError = `Duplicated address — two addresses merged`;
  else if (!validLength) addrError = `Invalid length: ${addr.length} (expected 48)`;
  else if (!validChars)  addrError = `Invalid characters in address`;
  else if (hasSpaces)    addrError = `Address contains spaces`;

  if (addrError) {
    console.log(`❌ Bad address [${withdrawId}]: ${addrError} | ${addr.substring(0, 30)}...`);
    await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "cancelled", error: addrError, updatedAt: Date.now() });
    if (userId && wdId) {
      await db.ref(`users/${userId}/wdHistory/${wdId}`).update({ status: "cancelled", updatedAt: Date.now() }).catch(() => {});
    }
    if (botInstance) {
      await botInstance.sendMessage(ADMIN_CHAT_ID,
                `⚠️ <b>Invalid wallet address — request cancelled</b>\n\n🆔 ID: <code>${withdrawId}</code>\n👤 User: <code>${userId || '?'}</code>\n❌ Reason: ${addrError}\n📬 Address:\n<code>${addr.substring(0, 80)}</code>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
    return { valid: false, skip: true };
  }
  data.address = addr;

  if (userId && await isUserBanned(userId)) {
    await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "cancelled", error: "User is banned", updatedAt: Date.now() });
    if (wdId) await db.ref(`users/${userId}/wdHistory/${wdId}`).update({ status: "cancelled", updatedAt: Date.now() });
    return { valid: false, skip: true };
  }

  if (await isWalletBanned(data.address)) {
    await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "cancelled", error: "Wallet is banned", updatedAt: Date.now() });
    if (userId && wdId) await db.ref(`users/${userId}/wdHistory/${wdId}`).update({ status: "cancelled", updatedAt: Date.now() });
    return { valid: false, skip: true };
  }

  if (data.status === 'awaiting_approval') {
    return { valid: false, skip: false };
  }

    // Policy: every withdrawal requires manual admin approval before any automatic payout — regardless
    // of the amount. The daily/max/min limits are no longer a routing condition here; the decision
    // is entirely up to the admin via /pending_wd or the approve/reject buttons sent automatically.
  if (userId && !data.approvedByAdmin) {
    const already = (data.status === 'awaiting_manual');
    if (!already) {
            const reason = `New withdrawal request — amount ${roundedAmount} TON — needs manual approval (all withdrawals require review)`;
      await db.ref(`withdrawQueue/${withdrawId}`).update({
        status: 'awaiting_manual',
        updatedAt: Date.now(),
        holdReason: reason,
        error: null, lastError: null,
      });
            console.log(`⏸ Manual review required (all withdrawals require review): ${withdrawId} | ${roundedAmount} TON`);
      await sendManualReviewAlert(withdrawId, { ...data, ton: roundedAmount }, reason);
    }
    return { valid: false, skip: false };
  }

  await db.ref(`withdrawQueue/${withdrawId}`).update({ error: null, lastError: null, updatedAt: Date.now() }).catch(() => {});
  return { valid: true, roundedAmount, userId, wdId };
}

// ==========================
// 🔹 Send Batch payout
// ==========================
async function sendBatchTransfer(items, attempt = 0) {
  const MAX_BATCH_RETRIES = 2;
  const batchIds = items.map(i => i.id).join(', ');
  const totalTON = items.reduce((s, i) => s + i.roundedAmount, 0);

  console.log(`\n${'='.repeat(50)}`);
  console.log(`📦 BATCH TRANSFER | ${items.length} items | ${totalTON.toFixed(4)} TON total`);
  console.log(`   IDs: ${batchIds}`);
  console.log(`${'='.repeat(50)}`);

  const balanceCheck = await checkSufficientBalance(totalTON);
  if (!balanceCheck.sufficient) {
    console.log(`⏭️ Insufficient balance for batch: ${balanceCheck.balance.toFixed(3)} TON < ${totalTON.toFixed(3)} TON`);
    for (const item of items) {
      processingQueue.delete(item.id);
      await db.ref(`withdrawQueue/${item.id}`).update({
        status: "pending", updatedAt: Date.now(),
        lastError: `Insufficient balance: ${balanceCheck.balance.toFixed(3)} TON`
      }).catch(() => {});
    }
    return { success: false, reason: 'insufficient_balance' };
  }

  try {
    const { contract, key } = await getWallet();
    const seqno = await contract.getSeqno();

    const validMessages = [];
    const invalidItems  = [];

    for (const item of items) {
      try {
        const needsComment = item.roundedAmount > 0.1;
        const msg = internal({
          to: item.data.address,
          value: toNano(item.roundedAmount.toFixed(3)),
          bounce: false,
          ...(needsComment ? { body: 'PMT GRAM' } : {})
        });
        validMessages.push({ item, msg });
      } catch (addrErr) {
        const reason = addrErr.message || 'Invalid address';
        console.log(`❌ Bad address — cancelling ${item.id}: ${reason}`);
        invalidItems.push({ item, reason });
        await db.ref(`withdrawQueue/${item.id}`).update({ status: "cancelled", updatedAt: Date.now(), error: `Bad address: ${reason}` }).catch(() => {});
        if (item.userId && item.wdId) {
          await db.ref(`users/${item.userId}/wdHistory/${item.wdId}`).update({ status: "cancelled", updatedAt: Date.now() }).catch(() => {});
        }
        processingQueue.delete(item.id);
      }
    }

    if (invalidItems.length > 0 && botInstance) {
      const lines = invalidItems.map(x =>
        `• <code>${x.item.id}</code> | 👤 <code>${x.item.userId || '?'}</code>\n  📬 <code>${String(x.item.data.address).substring(0, 60)}</code>\n  ❌ ${x.reason}`
      ).join('\n\n');
      await botInstance.sendMessage(ADMIN_CHAT_ID,
                `⚠️ <b>${invalidItems.length} invalid address(es) — automatically cancelled</b>\n\n${lines}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }

    if (validMessages.length === 0) {
      console.log(`🚫 Batch cancelled — all addresses invalid`);
      return { success: false, reason: 'all_invalid' };
    }

    const cleanItems = validMessages.map(x => x.item);
    const messages   = validMessages.map(x => x.msg);
    const cleanTotal = cleanItems.reduce((s, i) => s + i.roundedAmount, 0);
    console.log(`📦 Building batch: ${cleanItems.length}/${items.length} valid | ${cleanTotal.toFixed(4)} TON`);

    const recheck = await checkSufficientBalance(cleanTotal);
    if (!recheck.sufficient) {
      for (const item of cleanItems) {
        processingQueue.delete(item.id);
        await db.ref(`withdrawQueue/${item.id}`).update({ status: "pending", updatedAt: Date.now(), lastError: `Insufficient balance: ${recheck.balance.toFixed(3)} TON` }).catch(() => {});
      }
      return { success: false, reason: 'insufficient_balance' };
    }

    await new Promise(r => setTimeout(r, 1000));
    await contract.sendTransfer({ secretKey: key.secretKey, seqno, messages });
    console.log(`📤 Batch submitted — seqno: ${seqno} | ${cleanItems.length} msgs | attempt: ${attempt + 1}`);

    const confirmation = await confirmBatchTransaction(seqno, 120000);

    if (!confirmation.confirmed) {
      console.log(`⚠️ Batch TIMEOUT — seqno ${seqno} not advanced. Marking as needs_review.`);
      for (const item of cleanItems) {
        await db.ref(`withdrawQueue/${item.id}`).update({ status: "needs_review", updatedAt: Date.now(), lastError: `Batch timeout — seqno ${seqno} — verify manually`, batchSeqno: seqno }).catch(() => {});
        processingQueue.delete(item.id);
      }
      if (botInstance) {
        await botInstance.sendMessage(ADMIN_CHAT_ID,
                    `⚠️ <b>Batch Timeout</b>\n\n${cleanItems.length} withdrawals need manual review\nSeqno: <code>${seqno}</code>\n\nIDs:\n${cleanItems.map(i => `• <code>${i.id}</code>`).join('\n')}`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
      return { success: false, reason: 'timeout', seqno };
    }

    let batchTxHash = null;
    try {
      const txRes  = await fetch(`https://toncenter.com/api/v2/getTransactions?address=${walletAddress}&limit=5`, { headers: { "X-API-Key": process.env.TON_API_KEY } });
      const txData = await txRes.json();
      batchTxHash = txData.result?.[0]?.transaction_id?.hash || null;
    } catch (e) { console.log(`⚠️ Could not fetch batch tx hash: ${e.message}`); }

    console.log(`✅ Batch confirmed | hash: ${batchTxHash ? batchTxHash.substring(0, 14) + '...' : 'N/A'}`);

    const updatePromises = cleanItems.map(async (item) => {
      try {
        await db.ref(`withdrawQueue/${item.id}`).update({ status: "paid", updatedAt: Date.now(), completedAt: Date.now(), txHash: batchTxHash || null, sentAmount: item.roundedAmount, batchSize: cleanItems.length });
        await updateUserWdHistory(item.userId, item.wdId, batchTxHash, item.roundedAmount);
        processingQueue.delete(item.id);
        console.log(`   ✅ Marked paid: ${item.id}`);
      } catch (e) { console.log(`   ❌ Failed to update ${item.id}: ${e.message}`); }
    });
    await Promise.all(updatePromises);

    for (const item of cleanItems) {
      const sent = await sendUserNotification(item.userId, item.roundedAmount, item.amountCoins, batchTxHash);
      if (!sent) { await new Promise(r => setTimeout(r, 2000)); await sendUserNotification(item.userId, item.roundedAmount, item.amountCoins, batchTxHash); }
    }
    await sendChannelNotification(cleanItems, batchTxHash).catch(() => {});
    console.log(`🎉 Batch complete: ${cleanItems.length} paid`);
    return { success: true, txHash: batchTxHash, count: cleanItems.length };

  } catch (error) {
    const msg = error.message;
    console.log(`❌ Batch attempt ${attempt + 1} failed: ${msg}`);
    const isNetworkError = msg.includes('500') || msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('network');
    if (isNetworkError && attempt < MAX_BATCH_RETRIES) {
      const waitSec = 20 * (attempt + 1);
      console.log(`🔁 Network error — retrying batch in ${waitSec}s`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      return sendBatchTransfer(items, attempt + 1);
    }
    const revertList = (typeof cleanItems !== 'undefined') ? cleanItems : items;
    for (const item of revertList) {
      await db.ref(`withdrawQueue/${item.id}`).update({ status: "pending", updatedAt: Date.now(), lastError: `Batch failed (attempt ${attempt + 1}): ${msg}`, attempts: (item.data.attempts || 0) + 1 }).catch(() => {});
      processingQueue.delete(item.id);
    }
    if (botInstance) {
      await botInstance.sendMessage(ADMIN_CHAT_ID,
                `🔴 <b>Batch Failed</b>\n\n${items.length} withdrawal(s) failed and were reverted to pending\n\n<i>${msg.substring(0, 300)}</i>\n\nIDs:\n${items.map(i => `• <code>${i.id}</code>`).join('\n')}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
    return { success: false, reason: 'error', error: msg };
  }
}

// ==========================
// 🔹 Send a single withdrawal (Single mode)
// ==========================
async function sendSingleTransfer(item, attempt = 0) {
  const MAX_SINGLE_RETRIES = 3;
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`💸 SINGLE TRANSFER | ${item.id} | ${item.roundedAmount} TON → ${item.data.address.substring(0,10)}...`);

  const balanceCheck = await checkSufficientBalance(item.roundedAmount);
  if (!balanceCheck.sufficient) {
    processingQueue.delete(item.id);
    await db.ref(`withdrawQueue/${item.id}`).update({ status: "pending", updatedAt: Date.now(), lastError: `Insufficient balance: ${balanceCheck.balance.toFixed(3)} TON` }).catch(() => {});
    return { success: false, reason: 'insufficient_balance' };
  }

  try {
    const { contract, key } = await getWallet();
    const seqno = await contract.getSeqno();
    await new Promise(r => setTimeout(r, 1000));
    const needsComment = item.roundedAmount > 0.1;
    await contract.sendTransfer({ secretKey: key.secretKey, seqno, messages: [internal({ to: item.data.address, value: toNano(item.roundedAmount.toFixed(3)), bounce: false, ...(needsComment ? { body: 'PMT GRAM' } : {}) })] });
    console.log(`📤 Single submitted — seqno: ${seqno} | attempt: ${attempt + 1}`);

    const confirmation = await confirmBatchTransaction(seqno, 90000);
    if (!confirmation.confirmed) {
      console.log(`⚠️ Single TIMEOUT — seqno ${seqno}`);
      await db.ref(`withdrawQueue/${item.id}`).update({ status: "needs_review", updatedAt: Date.now(), lastError: `Single timeout — seqno ${seqno} — verify manually` }).catch(() => {});
      processingQueue.delete(item.id);
      if (botInstance) {
                  await botInstance.sendMessage(ADMIN_CHAT_ID, `⚠️ <b>Single Timeout</b>\n\n<code>${item.id}</code>\nSeqno: <code>${seqno}</code>\nReview manually`, { parse_mode: 'HTML' }).catch(() => {});
      }
      return { success: false, reason: 'timeout' };
    }

    let txHash = null;
    try {
      const txRes  = await fetch(`https://toncenter.com/api/v2/getTransactions?address=${walletAddress}&limit=3`, { headers: { "X-API-Key": process.env.TON_API_KEY } });
      const txData = await txRes.json();
      txHash = txData.result?.[0]?.transaction_id?.hash || null;
    } catch(e) {}

    await db.ref(`withdrawQueue/${item.id}`).update({ status: "paid", updatedAt: Date.now(), completedAt: Date.now(), txHash: txHash || null, sentAmount: item.roundedAmount, batchSize: 1 });
    await updateUserWdHistory(item.userId, item.wdId, txHash, item.roundedAmount);
    processingQueue.delete(item.id);
    console.log(`✅ Single paid: ${item.id} | hash: ${txHash ? txHash.substring(0,12)+'...' : 'N/A'}`);

    const sent = await sendUserNotification(item.userId, item.roundedAmount, item.amountCoins, txHash);
    if (!sent) { await new Promise(r => setTimeout(r, 2000)); await sendUserNotification(item.userId, item.roundedAmount, item.amountCoins, txHash); }
    await sendChannelNotification([item], txHash).catch(() => {});
    return { success: true, txHash };

  } catch (error) {
    const msg = error.message;
    console.log(`❌ Single attempt ${attempt + 1} failed: ${msg}`);
    const isNetwork = msg.includes('500') || msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('network');
    if (isNetwork && attempt < MAX_SINGLE_RETRIES) {
      const waitSec = 15 * (attempt + 1);
      console.log(`🔁 Retrying single in ${waitSec}s`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      return sendSingleTransfer(item, attempt + 1);
    }
    await db.ref(`withdrawQueue/${item.id}`).update({ status: "pending", updatedAt: Date.now(), lastError: `Single failed (${attempt + 1}): ${msg}`, attempts: (item.data.attempts || 0) + 1 }).catch(() => {});
    processingQueue.delete(item.id);
    return { success: false, reason: 'error', error: msg };
  }
}

// ==========================
// 🔹 Process pending withdrawals
// ==========================
async function processPendingWithdrawals() {
  if (!WITHDRAWAL_ENABLED) { console.log("⛔ Withdrawal system disabled — skipping"); return; }
  if (systemPaused) { console.log("⏸️ Paused — skipping"); return; }
  if (isProcessing)  { console.log("⚠️ Already processing — skipping"); return; }

  try {
    isProcessing = true;
    await unlockExpiredDailyLimits();

    const snapshot    = await db.ref("withdrawQueue").orderByChild("status").equalTo("pending").once("value");
    const withdrawals = snapshot.val();
    if (!withdrawals) { console.log("📭 No pending withdrawals"); isProcessing = false; return; }

    const list = Object.entries(withdrawals)
      .filter(([id]) => !processingQueue.has(id))
      .map(([id, d]) => ({ id, data: d, timestamp: d.ts || d.timestamp || 0 }))
      .sort((a, b) => a.timestamp - b.timestamp);

    if (!list.length) { console.log("📭 All pending already in processingQueue"); isProcessing = false; return; }

        console.log(`\n📋 ${list.length} pending in queue — only one request will be paid this cycle`);

        // We take only the oldest valid request and pay it; the rest wait for the next cycle (every minute).
        // This prevents paying out more than one withdrawal at the same time.
    let chosen = null;
    for (const { id, data } of list) {
      processingQueue.add(id);
      const validation = await validateWithdrawal(id, data);
      if (!validation.valid) { processingQueue.delete(id); continue; }

      let locked = false;
      await db.ref(`withdrawQueue/${id}`).transaction((current) => {
        if (!current || current.status !== "pending") return;
        locked = true;
        return { ...current, status: "processing", updatedAt: Date.now(), attempts: (current.attempts || 0) + 1 };
      });

      if (!locked) { console.log(`⏭️ ${id} already taken — skipping`); processingQueue.delete(id); continue; }

      chosen = { id, data, roundedAmount: validation.roundedAmount, userId: validation.userId, wdId: validation.wdId, amountCoins: data.amt || 0 };
            break; // We stopped at the first valid request — the rest of the queue waits
    }

    if (!chosen) { console.log("📭 No valid withdrawal to pay this cycle"); isProcessing = false; return; }

    console.log(`\n🚀 Paying single withdrawal: ${chosen.id} | ${chosen.roundedAmount.toFixed(4)} TON`);
    await sendSingleTransfer(chosen);

  } catch (e) { console.log(`❌ processPendingWithdrawals: ${e.message}`); }
  finally { isProcessing = false; console.log("✅ processPendingWithdrawals cycle done"); }
}

// ==========================
// 🔹 Release pending requests whose wait time has ended
// ==========================
async function unlockExpiredDailyLimits() {
  try {
    const snap  = await db.ref("withdrawQueue").orderByChild("status").equalTo("awaiting_approval").once("value");
    const items = snap.val();
    if (!items) return;
    const now = Date.now();
    let unlocked = 0;
    for (const [id, d] of Object.entries(items)) {
      if (d.unlockAt && now >= d.unlockAt) {
        await db.ref(`withdrawQueue/${id}`).update({ status: "pending", updatedAt: now, holdReason: null, unlockAt: null, lastError: null });
        unlocked++;
        console.log(`🔓 Unlocked daily-limit withdrawal: ${id}`);
      }
    }
    if (unlocked > 0) console.log(`🔓 Unlocked ${unlocked} daily-limit withdrawals`);
  } catch (e) { console.log(`❌ unlockExpiredDailyLimits: ${e.message}`); }
}

// ==========================
// 🔹 Check deposits (every 5 minutes) - Update: add TON Balance instead of Bamboo
// ==========================
async function checkDeposits() {
  if (!DEPOSIT_ENABLED) { console.log("⛔ Deposit system disabled — skipping check"); return; }
  const wallet   = process.env.TON_WALLET_ADDRESS || "UQAACNWWtTtN7ILkhRERwYUTzo06Bd1Tv_8Yk5gPioIMFoUD";
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!wallet || !botToken) return;

  console.log("💰 Checking TON deposits...");

  try {
    const response = await fetch(
      `https://toncenter.com/api/v2/getTransactions?address=${wallet}&limit=120`,
      { headers: { "X-API-Key": process.env.TON_API_KEY } }
    );
    const data = await response.json();
    if (!data.result) { console.log("No transactions found"); return; }

    for (const tx of data.result) {
      const txHash = tx.transaction_id.hash;
      if (!tx.in_msg || !tx.in_msg.message) continue;
      let comment = tx.in_msg.message.trim();
      if (!comment) continue;

            // Extract userId from the transaction comment — supports JSON, a raw number,
            // and the PMT system format: Pmt Gram User ID: 123456789.
      let userId = null;
      if (comment.startsWith('{')) {
        try {
          const parsed = JSON.parse(comment);
          if (parsed && parsed.user_id && /^\d+$/.test(String(parsed.user_id))) {
            userId = String(parsed.user_id);
          }
        } catch (e) {}
      } else {
        const idMatch = comment.match(/(?:Pmt\s+Gram\s+User\s+ID\s*:\s*)?(\d{5,})/i);
        if (idMatch) userId = idMatch[1];
      }
      if (!userId) continue;
      const amountTon = Number(tx.in_msg.value) / 1e9;
      if (amountTon <= 0) continue;

            // Check whether the transaction was already processed
      let alreadyProcessed = false;
      try {
        const snap = await db.ref(`processed/${txHash}`).once("value");
        alreadyProcessed = snap.exists();
      } catch(e) {}
      if (alreadyProcessed) continue;

            // Fetch user data
      let userData = null;
      try {
        const snap = await db.ref(`users/${userId}`).once("value");
        userData = snap.val();
      } catch(e) {}
      if (!userData) continue;

            // 🔁 Update: add TON balance directly instead of Bamboo (no 50% bonus)
      const currentTonBalance = Number(userData.tonBalance || 0);
      const newTonBalance = currentTonBalance + amountTon;

            // Update TON balance + mark user as a depositor
      await db.ref(`users/${userId}`).update({
        tonBalance:   newTonBalance,
        hasDeposited: true,
      });

            // Record deposit data
      const txLink           = `https://tonscan.org/tx/${encodeURIComponent(txHash)}`;
      const depositTimestamp = Date.now();
      await db.ref(`users/${userId}/deposits`).push({
        amount:      amountTon,
        tonAdded:    amountTon,
        txHash,
        txLink,
        date:        new Date(depositTimestamp).toISOString(),
        timestamp:   depositTimestamp,
      });

            // Mark transaction as processed
      await db.ref(`processed/${txHash}`).set(true);

      console.log(`💰 Deposit: +${amountTon} TON → user ${userId} (${currentTonBalance} → ${newTonBalance} TON)`);

            // 🔁 Update: notify user of TON balance (no Bamboo, no 50% bonus)
      const formattedTon    = amountTon.toFixed(6);
      const formattedNewBalance = newTonBalance.toFixed(6);
      const depositCaption =
        `💎 <b>DEPOSIT RECEIVED</b>\n\n` +
        `🎉 <b>A new deposit has been confirmed!</b>\n\n` +
        `👤 <b>User:</b> <code>${maskUserId(userId)}</code>\n` +
        `💰 <b>Amount:</b> <code>${amountTon.toFixed(4)} TON</code>\n` +
        `🟣 <b>Network:</b> TON\n` +
        `✅ <b>Status:</b> <b>CONFIRMED</b>\n\n` +
        `━━━━━━━━━━━━━━\n\n` +
        `💎 The deposit has been successfully credited to the user's <b>PMT Gram</b> balance.\n\n` +
        `🔗 <b>Transaction:</b> Verified On-Chain\n` +
        `⚡ <b>Confirmation:</b> Fast &amp; Secure\n\n` +
        `🏆 <b>PMT Gram</b>\n` +
        `<i>Earn • Complete • Get Paid</i>`;

      await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id:    userId,
          photo:      PAYMENT_IMAGE_URL,
          caption:    depositCaption,
          parse_mode: "HTML",
          reply_markup: {
             inline_keyboard: [[{ text: "🚀 Open PMT Gram", url: BOT_URL }]]
          }
        })
      });
      console.log(`📨 Deposit notification sent to user ${userId}`);

            // 🔁 Notify admin of confirmed deposit
      const adminMessage =
                `💰 <b>New deposit processed ✅</b>\n\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `👤 User ID: <code>${userId}</code>\n` +
                `💎 Amount: <b>${formattedTon} TON</b>\n` +
                `🏦 New TON balance: <b>${formattedNewBalance} TON</b>\n` +
        `━━━━━━━━━━━━━━━━\n` +
                `✅ Balance updated\n` +
                `✅ User notified\n` +
        `🔗 <a href="${txLink}">View Transaction</a>`;

      for (const adminId of ADMIN_CHAT_IDS) {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id:                adminId,
            text:                   adminMessage,
            parse_mode:             "HTML",
            disable_web_page_preview: false,
          })
        }).catch(() => {});
      }
      console.log(`📨 Admin notified about deposit from user ${userId}`);
    }

    console.log("✅ Deposit check completed.");
  } catch (e) { console.log(`❌ checkDeposits: ${e.message}`); }
}

// ==========================
// 🔹 Welcome bot + admin commands
// ==========================
function startWelcomeBot() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) { console.log("⚠️ TELEGRAM_BOT_TOKEN missing"); return; }

  const bot = new TelegramBot(botToken, { polling: true });
  botInstance = bot;
  bot.setMyCommands([
  ]).catch(e => console.log(`⚠️ setMyCommands: ${e.message}`));

  const isAdmin = (msg) => isAdminId(msg.chat.id);
  const unauth  = async (msg) => await bot.sendMessage(msg.chat.id, "⛔ Unauthorized");

  // ─── /start ───────────────────────────────────────────
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`👋 /start: ${chatId}`);
        const displayName = escapeHtml(msg.from?.first_name || msg.from?.username || 'friend');
    const caption =
      `🪙 <b>Welcome to ${BOT_NAME}, ${displayName}!</b> 👑\n\n` +
      `💎 Complete tasks, watch ads &amp; earn PMT rewards.\n\n` +
      `🎯 <b>Daily Tasks</b> — Complete simple tasks and earn instantly.\n` +
      `👥 <b>Invite Friends</b> — Earn from referrals and their activity.\n` +
      `💰 <b>Fast Withdrawals</b> — Withdraw your earnings directly to your TON Wallet.\n\n` +
      `⚡ Fast rewards • Transparent payouts • On-chain verified\n\n` +
      `🚀 Ready to earn? Tap below and start now!\n\n` +
      `📢 Your referral &amp; payout updates will appear here.`;
    try {
      await bot.sendPhoto(chatId,
        WELCOME_IMAGE_URL,
        {
          caption,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: "🚀 Open Bot", url: BOT_URL }],
              [{ text: "📢 Withdrawals Channel", url: WITHDRAWAL_CHANNEL_URL }]
            ]
          }
        }
      );
    } catch (e) {
      console.log(`❌ /start sendPhoto error: ${e.message}`);
    }
  });

  // ─── /help ────────────────────────────────────────────
  bot.onText(/\/help/, async (msg) => {
    if (!isAdmin(msg)) return;
    await adminReply(bot, msg.chat.id,
            `🐼 <b>${BOT_NAME} — Admin Panel</b>\n` +
      `${'═'.repeat(32)}\n\n` +
            `👋 <b>Basics</b>\n` +
            `/start — Welcome message\n` +
            `/help — Show all commands\n` +
            `/my — Private control panel\n\n` +
            `📊 <b>Info & Monitoring</b>\n` +
            `/balance — TON wallet balance\n` +
            `/queue — Status of all withdrawal queues\n` +
            `/lastpaid — Last 5 paid transactions\n\n` +
            `⚙️ <b>Withdrawal Settings</b>\n` +
            `/setmax [TON] — Maximum automatic payout limit\n` +
            `/setmin [TON] — Minimum withdrawal limit\n` +
            `/setdaily [number] — Daily limit per user\n` +
            `/setcooldown [hours] — Wait time after exceeding the limit\n\n` +
            `👤 <b>User Management</b>\n` +
            `/banwallet [address] — Ban a wallet\n` +
            `/unwallet [address] — Unban a wallet\n\n` +
            `📨 <b>Sending Messages</b>\n` +
            `/sendmsg [userId] — Send a message to a user\n` +
            `/broadcast — Send a message to everyone\n` +
            `/broadcast_status — Broadcast status\n` +
            `/broadcast_debug — Check users path\n` +
            `/cancel — Cancel a message-sending session\n\n` +
            `📡 <b>Channel Broadcast</b>\n` +
            `/addchannel [id/@user] [label] — Add a channel\n` +
            `/removechannel [id/@user] — Remove a channel\n` +
            `/channels — List registered channels\n` +
            `/sendchannel [id/@user] — Send a message to one channel\n` +
            `/broadcast_channels — Send a message to all channels\n\n` +
            `🕵️ <b>Fraud Detection</b>\n` +
            `/check_suspicious — Detect shared wallets (+3 users)\n\n` +
            `📊 <b>Referral Reports</b>\n` +
            `/top_referrals — Top 50 users by total referrals\n\n` +
            `🔴 <b>Full System Control</b>\n` +
            `/stop_all — ⛔ Fully stop automatic withdrawals\n` +
            `/start_all — ✅ Resume withdrawals`
    );
  });

  // ─── /my ──────────────────────────────────────────────
  bot.onText(/\/my/, async (msg) => {
    if (!isAdmin(msg)) return;
    await adminReply(bot, msg.chat.id,
            `🎛 <b>${BOT_NAME} — Private Control Panel</b>\n` +
      `${'═'.repeat(32)}\n\n` +
            `📊 <b>Statistics & Monitoring</b>\n` +
            `/stats — Full statistics\n\n` +
            `🔍 <b>User Info</b>\n` +
            `/userinfo [userId] — Full user info\n` +
            `/logs [userId] [30|100|200|all] — Activity log with rewards\n\n` +
            `💸 <b>Withdrawal Management</b>\n` +
            `/pending_wd — Review withdrawals needing manual approval\n` +
            `/awaiting_queue — Withdrawals pending due to the daily limit/approval\n` +
            `/unlock [count] — Release a number of pending withdrawals for payout\n` +
            `/retryall — Retry failed withdrawals\n\n` +
            `👤 <b>User Management</b>\n` +
            `/banuser [userId] — Ban a user\n` +
            `/unbanuser [userId] — Unban a user\n\n` +
            `💎 <b>Add Balance</b>\n` +
            `/addton [userId] [amount] — Add TON\n\n` +
            `⚙️ <b>Price Settings</b>\n` +
            `/setrate [number] — Bamboo→TON price\n` +
            `/mode — Current mode Batch/Single`
    );
  });

  // ─── /balance ─────────────────────────────────────────
  bot.onText(/\/balance/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const b = await getWalletBalance();
    await adminReply(bot, msg.chat.id, `💰 <b>Wallet Balance:</b> ${b.toFixed(6)} TON\n📬 <code>${walletAddress || 'not loaded'}</code>`);
  });

  // ─── /queue ───────────────────────────────────────────
  bot.onText(/\/queue/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const [snapP, snapM, snapA, snapR] = await Promise.all([
        db.ref("withdrawQueue").orderByChild("status").equalTo("pending").once("value"),
        db.ref("withdrawQueue").orderByChild("status").equalTo("awaiting_manual").once("value"),
        db.ref("withdrawQueue").orderByChild("status").equalTo("awaiting_approval").once("value"),
        db.ref("withdrawQueue").orderByChild("status").equalTo("processing").once("value"),
      ]);
      const pendingItems = snapP.exists() ? snapP.val() : {};
      const manualItems  = snapM.exists() ? snapM.val() : {};
      const approvalItems = snapA.exists() ? snapA.val() : {};
      const processingItems = snapR.exists() ? snapR.val() : {};
      const pendingCount = Object.keys(pendingItems).length;
      const manualCount = Object.keys(manualItems).length;
      const approvalCount = Object.keys(approvalItems).length;
      const processingCount = Object.keys(processingItems).length;
      const totalTON = [...Object.values(pendingItems), ...Object.values(manualItems), ...Object.values(approvalItems), ...Object.values(processingItems)]
        .reduce((s, d) => s + roundAmount(d.ton ?? d.amt), 0).toFixed(4);
      await adminReply(bot, msg.chat.id,
        `📋 <b>Queue Status</b>\n\n` +
        `⏳ Pending: <b>${pendingCount}</b>\n` +
        `📝 Awaiting manual: <b>${manualCount}</b>\n` +
        `⏸ Awaiting approval/daily: <b>${approvalCount}</b>\n` +
        `🔄 Processing: <b>${processingCount}</b>\n` +
        `💰 Total held: <b>${totalTON} TON</b>\n\n` +
        `📦 Batch size: <b>${BATCH_SIZE}</b> per batch\n` +
        `⚡ Est. batches needed: <b>${Math.ceil(pendingCount / BATCH_SIZE)}</b>\n\n` +
                `💡 Use /pending_wd to review manual withdrawals`
      );
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /mode ────────────────────────────────────────────
  bot.onText(/\/mode/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const modeIcon = PROCESSING_MODE === 'batch' ? '📦' : '💸';
    await adminReply(bot, msg.chat.id,
            `${modeIcon} <b>Current processing mode: ${PROCESSING_MODE.toUpperCase()}</b>\n\n` +
      (PROCESSING_MODE === 'batch'
                ? `📦 Batch: groups up to <b>${BATCH_SIZE}</b> withdrawals into one transaction\n⏳ Delay between batches: <b>${BATCH_BETWEEN_DELAY/1000}s</b>`
                : `💸 Single: sends each withdrawal individually\n⏳ Delay between each withdrawal: <b>${SINGLE_DELAY_MS/1000}s</b>`) +
            `\n\n🔄 Processing: <b>${isProcessing ? '✅ Running' : '⏹ Stopped'}</b>` +
            `\n⏸ Paused: <b>${systemPaused ? 'Yes ⏸' : 'No ✅'}</b>` +
            `\n🔒 In queue: <b>${processingQueue.size}</b>`
    );
  });

  // ─── /stats ───────────────────────────────────────────
  bot.onText(/\/stats/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("withdrawQueue").once("value");
      const items = snap.val() || {};
      const counts = { pending: 0, processing: 0, paid: 0, failed: 0, bounced: 0, cancelled: 0, awaiting_approval: 0, awaiting_manual: 0, needs_review: 0 };
      let totalPaid = 0;
      Object.values(items).forEach(d => {
        counts[d.status] = (counts[d.status] || 0) + 1;
        if (d.status === 'paid') totalPaid += Number(d.sentAmount || d.amt || d.ton || 0);
      });
      const bal = await getWalletBalance();
      const modeIcon = PROCESSING_MODE === 'batch' ? '📦' : '💸';
      await adminReply(bot, msg.chat.id,
                `📊 <b>Current Mode Statistics</b>\n\n` +
                `✅ Paid: <b>${counts.paid}</b> (${totalPaid.toFixed(3)} TON)\n` +
        `⏳ Pending: <b>${counts.pending}</b>\n` +
        `🔄 Processing: <b>${counts.processing}</b>\n` +
        `⏸ Awaiting (daily): <b>${counts.awaiting_approval}</b>\n` +
        `📝 Awaiting manual: <b>${counts.awaiting_manual}</b>\n` +
        `🔴 Bounced: <b>${counts.bounced}</b>\n` +
        `❌ Failed: <b>${counts.failed}</b>\n` +
        `🔍 Needs review: <b>${counts.needs_review}</b>\n` +
        `🚫 Cancelled: <b>${counts.cancelled}</b>\n\n` +
                `💰 Wallet balance: <b>${bal.toFixed(4)} TON</b>\n\n` +
        `${'─'.repeat(28)}\n` +
                `${modeIcon} Mode: <b>${PROCESSING_MODE.toUpperCase()}</b> | Batch size: <b>${BATCH_SIZE}</b>\n` +
        `📈 Max: <b>${MAX_WITHDRAWAL_AMOUNT}</b> | Min: <b>${MIN_WITHDRAWAL_AMOUNT}</b> TON\n` +
                `📅 Daily limit: <b>${DAILY_LIMIT}</b> withdrawals | Cooldown: <b>${DAILY_COOLDOWN_HOURS}h</b>\n` +
        `💱 Rate: <b>1 TON = ${BAMBOO_TO_TON_RATE} Bamboo</b>\n` +
                `⏸ Paused: <b>${systemPaused ? 'Yes' : 'No'}</b>`
      );
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /setmax ──────────────────────────────────────────
  bot.onText(/\/setmax (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseFloat(match[1]);
        if (isNaN(v) || v <= 0) { await adminReply(bot, msg.chat.id, "❌ Invalid number"); return; }
    MAX_WITHDRAWAL_AMOUNT = v;
        await adminReply(bot, msg.chat.id, `✅ Maximum limit: <b>${v} TON</b>\n🔄 Reprocessing pending requests...`);
    setTimeout(() => processPendingWithdrawals(), 1000);
  });

  // ─── /setmin ──────────────────────────────────────────
  bot.onText(/\/setmin (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseFloat(match[1]);
        if (isNaN(v) || v <= 0) { await adminReply(bot, msg.chat.id, "❌ Invalid number"); return; }
    MIN_WITHDRAWAL_AMOUNT = v;
        await adminReply(bot, msg.chat.id, `✅ Minimum limit: <b>${v} TON</b>\n🔄 Reprocessing pending requests...`);
    setTimeout(() => processPendingWithdrawals(), 1000);
  });

  // ─── /setrate ─────────────────────────────────────────
  bot.onText(/\/setrate (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseInt(match[1]);
        if (isNaN(v) || v <= 0) { await adminReply(bot, msg.chat.id, "❌ Invalid number"); return; }
    BAMBOO_TO_TON_RATE = v;
        await adminReply(bot, msg.chat.id, `✅ Price: <b>1 TON = ${v} Bamboo</b>`);
  });

  // ─── /setdaily ────────────────────────────────────────
  bot.onText(/\/setdaily (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseInt(match[1]);
        if (isNaN(v) || v < 1) { await adminReply(bot, msg.chat.id, "❌ Invalid number (minimum 1)"); return; }
    DAILY_LIMIT = v;
        await adminReply(bot, msg.chat.id, `✅ Daily limit: <b>${v}</b> withdrawals per user`);
  });

  // ─── /setcooldown ─────────────────────────────────────
  bot.onText(/\/setcooldown (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseFloat(match[1]);
        if (isNaN(v) || v <= 0) { await adminReply(bot, msg.chat.id, "❌ Invalid number"); return; }
    DAILY_COOLDOWN_HOURS = v;
        await adminReply(bot, msg.chat.id, `✅ Wait time: <b>${v}</b> hour(s) after exceeding the daily limit`);
  });

  // ─── /retryall ────────────────────────────────────────
  bot.onText(/\/retryall/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("withdrawQueue").orderByChild("status").equalTo("failed").once("value");
      const items = snap.val();
            if (!items) { await adminReply(bot, msg.chat.id, "📭 No failed withdrawals"); return; }
      const count = Object.keys(items).length;
      const updates = {};
      Object.keys(items).forEach(id => { updates[`${id}/status`] = "pending"; updates[`${id}/updatedAt`] = Date.now(); updates[`${id}/lastError`] = null; updates[`${id}/attempts`] = 0; });
      await db.ref("withdrawQueue").update(updates);
            await adminReply(bot, msg.chat.id, `🔄 Requeued <b>${count}</b> failed withdrawal(s) for processing`);
      setTimeout(() => processPendingWithdrawals(), 1000);
    } catch(e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /banuser ─────────────────────────────────────────
  bot.onText(/\/banuser (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const userId = match[1].trim();
    await db.ref(`bannedUsers/${userId}`).set({ bannedAt: Date.now(), by: 'admin' });
        await adminReply(bot, msg.chat.id, `🚫 User banned <code>${userId}</code>`);
  });

  // ─── /unbanuser ───────────────────────────────────────
  bot.onText(/\/unbanuser (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const userId = match[1].trim();
    await db.ref(`bannedUsers/${userId}`).remove();
        await adminReply(bot, msg.chat.id, `✅ User unbanned <code>${userId}</code>`);
  });

  // ─── /banwallet ───────────────────────────────────────
  bot.onText(/\/banwallet (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const addr = match[1].trim();
    const key  = addr.replace(/[.$#[\]/]/g, '_');
        await db.ref(`bannedWallets/${key}`).set({ address: addr, bannedAt: Date.now(), reason: 'Manual by admin' });
        await adminReply(bot, msg.chat.id, `🚫 Wallet banned:\n<code>${addr}</code>`);
  });

  // ─── /unwallet ────────────────────────────────────────
  bot.onText(/\/unwallet (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const addr = match[1].trim();
    const key  = addr.replace(/[.$#[\]/]/g, '_');
    await db.ref(`bannedWallets/${key}`).remove();
        await adminReply(bot, msg.chat.id, `✅ Wallet unbanned:\n<code>${addr}</code>`);
  });

  // ─── /userinfo ────────────────────────────────────────
  bot.onText(/\/userinfo (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const userId = match[1].trim();
    try {
      const [bannedSnap, wdSnap, depositsSnap, referralsSnap, userSnap] = await Promise.all([
        db.ref(`bannedUsers/${userId}`).once("value"),
        db.ref("withdrawQueue").orderByChild("userId").equalTo(userId).once("value"),
        db.ref(`users/${userId}/deposits`).once("value"),
        db.ref(`users/${userId}/referrals`).once("value"),
        db.ref(`users/${userId}`).once("value"),
      ]);

      const isBanned  = bannedSnap.exists();
      const wdItems   = wdSnap.val() || {};
      const allWds    = Object.values(wdItems);
      const paid      = allWds.filter(d => d.status === 'paid');
      const pending   = allWds.filter(d => ['pending','awaiting_approval','awaiting_manual','processing'].includes(d.status));
      const cancelled = allWds.filter(d => d.status === 'cancelled');
      const totalPaid = paid.reduce((s, d) => s + roundAmount(d.ton), 0);
      const wallets   = [...new Set(allWds.map(d => d.address).filter(Boolean))];

            // Deposit statistics
      const depositsData = depositsSnap.val() || {};
      const depositsList = Object.entries(depositsData);
      const confirmedDeposits = depositsList.filter(([, d]) => !d.status || d.status !== 'pending');
      const totalDepositTon   = confirmedDeposits.reduce((s, [, d]) => s + (Number(d.amount) || 0), 0);
      const totalDepositCount = confirmedDeposits.length;

            // Referral statistics
      const referralsData    = referralsSnap.val() || {};
      const totalReferrals   = Object.keys(referralsData).length;

      let activeReferrals = 0;
      const referralIds = Object.keys(referralsData);
      for (const referralId of referralIds) {
        try {
          const depSnap = await db.ref(`users/${referralId}/hasDeposited`).once("value");
          if (depSnap.val() === true) activeReferrals++;
              } catch (e) { /* ignore individual errors */ }
      }

            // Coins, Bamboo, and TON balances
      const userData   = userSnap.val() || {};
      const bambooBalance = userData.bamboo || 0;
      const coinsBalance  = userData.coins  || 0;
      const tonBalance    = userData.tonBalance || 0;

            // Total withdrawals to compare with deposits
      const totalWithdrawTon = paid.reduce((s, d) => s + roundAmount(d.ton), 0);

            // Deposit links
      let depositsText = '';
      if (confirmedDeposits.length > 0) {
        const lastDeposits = confirmedDeposits.slice(-5);
                depositsText = `\n🔗 <b>Recent deposits (transaction links):</b>\n`;
        lastDeposits.forEach(([, d], idx) => {
          const amt  = Number(d.amount || 0).toFixed(3);
          const date = d.date ? new Date(d.date).toLocaleDateString('en-GB') : (d.timestamp ? new Date(d.timestamp).toLocaleDateString('en-GB') : '—');
          if (d.txLink) {
                        depositsText += `${idx + 1}. 💎 ${amt} TON — ${date} — <a href="${d.txLink}">🔍 View</a>\n`;
          } else if (d.txHash) {
            const cleanHash = encodeURIComponent(d.txHash);
                        depositsText += `${idx + 1}. 💎 ${amt} TON — ${date} — <a href="https://tonscan.org/tx/${cleanHash}">🔍 View</a>\n`;
          } else {
            depositsText += `${idx + 1}. 💎 ${amt} TON — ${date}\n`;
          }
        });
                if (confirmedDeposits.length > 5) depositsText += `... and ${confirmedDeposits.length - 5} more older deposit(s)\n`;
      } else {
                depositsText = `\n⚠️ No confirmed deposits\n`;
      }

            // Warning if withdrawals > deposits
      const suspiciousWithdraw = totalDepositTon > 0 && totalWithdrawTon > totalDepositTon;
      const noDepositWarning   = totalDepositTon === 0 && totalPaid > 0;

      let text =
                `👤 <b>User Info</b>\n` +
        `🆔 ID: <code>${userId}</code>\n` +
                `🚫 Banned: <b>${isBanned ? 'Yes ❌' : 'No ✅'}</b>\n` +
        `${'━'.repeat(30)}\n\n` +

                `💰 <b>Current Balance</b>\n` +
        `🎍 Bamboo: <b>${Number(bambooBalance).toLocaleString()}</b>\n` +
        `🪙 Coins: <b>${Number(coinsBalance).toLocaleString()}</b>\n` +
        `💎 TON: <b>${Number(tonBalance).toFixed(6)} TON</b>\n` +
        `${'━'.repeat(30)}\n\n` +

                `📥 <b>Deposits</b>\n` +
                `💎 Total deposits: <b>${totalDepositTon.toFixed(3)} TON</b>\n` +
                `🔢 Number of transactions: <b>${totalDepositCount}</b>\n` +
        depositsText +
        `${'━'.repeat(30)}\n\n` +

                `📤 <b>Withdrawals</b>\n` +
                `✅ Paid: <b>${paid.length}</b> (<b>${totalPaid.toFixed(3)} TON</b>)\n` +
                `⏳ Pending: <b>${pending.length}</b>\n` +
                `🚫 Cancelled: <b>${cancelled.length}</b>\n` +
                (suspiciousWithdraw ? `\n⚠️ <b>Warning: total withdrawals (${totalWithdrawTon.toFixed(3)} TON) exceed total deposits (${totalDepositTon.toFixed(3)} TON)!</b>\n` : '') +
                (noDepositWarning   ? `\n⚠️ <b>Warning: this user withdrew without ever depositing!</b>\n` : '') +
        `${'━'.repeat(30)}\n\n` +

                `👥 <b>Referrals</b>\n` +
                `📊 Total referrals: <b>${totalReferrals}</b>\n` +
                `✅ Active referrals (deposited): <b>${activeReferrals}</b>\n` +
        `${'━'.repeat(30)}\n\n` +

                `📬 <b>Wallets Used (${wallets.length})</b>\n`;

      wallets.slice(0, 5).forEach(w => { text += `• <code>${w}</code>\n`; });
            if (wallets.length > 5) text += `... and ${wallets.length - 5} more\n`;

      const keyboard = [];
            if (!isBanned) keyboard.push([{ text: "🚫 Ban User", callback_data: `ban_user:${userId}` }]);
            else           keyboard.push([{ text: "✅ Unban",     callback_data: `unban_user:${userId}` }]);

      await adminReply(bot, msg.chat.id, text, { reply_markup: { inline_keyboard: keyboard }, disable_web_page_preview: false });
    } catch(e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /addton [userId] [amount] ───────────────────────
  bot.onText(/\/addton (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const parts  = match[1].trim().split(/\s+/);
    const userId = parts[0];
    const amount = parseFloat(parts[1]);
    if (!userId || isNaN(amount) || amount <= 0) {
            await adminReply(bot, msg.chat.id, `❌ Usage: /addton [userId] [amount]\nExample: /addton 123456789 10.5`);
      return;
    }
    try {
      const userSnap    = await db.ref(`users/${userId}`).once("value");
            if (!userSnap.exists()) { await adminReply(bot, msg.chat.id, `❌ User <code>${userId}</code> not found`); return; }
      const userData    = userSnap.val() || {};
      const currentTon = Number(userData.tonBalance || 0);
      const newTon     = currentTon + amount;
      await db.ref(`users/${userId}`).update({ tonBalance: newTon, updatedAt: Date.now() });
      await adminReply(bot, msg.chat.id,
                `✅ <b>TON added successfully</b>\n\n` +
        `👤 User: <code>${userId}</code>\n` +
                `➕ Added: <b>${amount.toFixed(6)} TON</b>\n` +
                `📊 Previous balance: <b>${currentTon.toFixed(6)} TON</b>\n` +
                `💰 New balance: <b>${newTon.toFixed(6)} TON</b>`
      );
      console.log(`✅ Admin added ${amount} TON → user ${userId} (${currentTon} → ${newTon})`);
    } catch(e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });


    // ─── /pending_wd — Review withdrawals exceeding the maximum limit ─────────────────
    // Manual review state (session state)
  const manualReviewState = {};   // { [adminChatId]: { list: [], index: 0, mode: 'one_by_one'|'all' } }

  async function buildManualWdMessage(wd, wdId) {
    const roundedAmount = roundAmount(wd.ton ?? wd.amt);
    const userId  = wd.userId || 'unknown';
    const address = wd.address || '—';
    const requestTime = new Date(wd.ts || Date.now()).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false });

        // Basic profile data — the same fields shown by the dashboard in "View user details"
    let displayName = userId, username = null, pmtBalance = 0, referralCode = '—', referredBy = '—';
    let forceSubPassed = false, linkedWallet = '—', joinedAt = null, lastSeen = null, isBanned = false;
    try {
      const [userSnap, bannedSnap] = await Promise.all([
        db.ref(`users/${userId}`).once('value'),
        db.ref(`bannedUsers/${userId}`).once('value'),
      ]);
      const u = userSnap.val() || {};
      const nameParts = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
      displayName     = nameParts || (u.username ? '@' + u.username : userId);
      username        = u.username || null;
      pmtBalance      = Number(u.balance || 0);
      referralCode    = u.referralCode || '—';
      referredBy      = u.referredBy || '—';
      forceSubPassed  = !!u.forceSubPassed;
      linkedWallet    = u.tonWallet || u.wallet || '—';
      joinedAt        = u.createdAt || null;
      lastSeen        = u.lastLogin || null;
      isBanned        = bannedSnap.exists();
    } catch(e) {}

        // Total deposits
    let totalDepositTon = 0;
    try {
      const depSnap = await db.ref(`users/${userId}/deposits`).once('value');
      const deps = depSnap.val() || {};
      totalDepositTon = Object.values(deps).reduce((s, d) => s + (Number(d.amount || d.tonAdded || 0)), 0);
    } catch(e) {}

        // Total paid withdrawals + count of successful withdrawals
    let totalPaidTon = 0;
    let paidCount = 0;
    try {
      const wdSnap = await db.ref(`users/${userId}/wdHistory`).once('value');
      const wds = Object.values(wdSnap.val() || {});
      const paid = wds.filter(w => w.status === 'paid');
      totalPaidTon = paid.reduce((s, w) => s + (Number(w.sentAmount || 0)), 0);
      paidCount = paid.length;
    } catch(e) {}

        // Total/active referrals — same path and logic used by the dashboard (referrals/{id})
    let totalReferrals = 0;
    let activeReferrals = 0;
    try {
      const refSnap = await db.ref(`referrals/${userId}`).once('value');
      const refs = Object.values(refSnap.val() || {});
      totalReferrals  = refs.length;
      activeReferrals = refs.filter(r => r && (r.status === 'active' || r.status === 'completed')).length;
    } catch(e) {}

        // User ads — the same fields used by the dashboard
    let adsToday = 0;
    let adsAllTime = 0;
    try {
      const userSnap = await db.ref(`users/${userId}`).once('value');
      const u = userSnap.val() || {};
      adsAllTime = Number(u.totalAdsWatched || 0);
      if (u.adWatchDate === todayKeyCairo()) {
        adsToday = u.adsWatchedByCompany
          ? Object.values(u.adsWatchedByCompany).reduce((s, c) => s + Number(c || 0), 0)
          : Number(u.adsWatchedToday || 0);
      }
    } catch(e) {}

    const text =
            `🔍 <b>Withdrawal needs manual approval</b>
` +
      `${'━'.repeat(30)}

` +
            `👤 <b>User:</b> ${escapeHtml(displayName)}${username ? ' (@' + escapeHtml(username) + ')' : ''}
` +
            `🆔 <b>Telegram ID:</b> <code>${userId}</code>
` +
            `🆔 <b>Withdrawal ID:</b> <code>${wdId}</code>
` +
            `🚫 <b>Banned:</b> ${isBanned ? 'Yes ❌' : 'No ✅'}

` +
      `${'─'.repeat(30)}
` +
            `💰 <b>Requested amount:</b> <b>${roundedAmount.toFixed(4)} TON</b>
` +
            `📬 <b>Withdrawal wallet:</b>
<code>${address}</code>
` +
            `🔗 <b>Wallet linked to account:</b> ${escapeHtml(linkedWallet)}

` +
      `${'─'.repeat(30)}
` +
            `🪙 <b>PMT balance:</b> ${formatCompactNumber(pmtBalance) ?? pmtBalance}
` +
            `🏷️ <b>Referral code:</b> ${escapeHtml(referralCode)}
` +
            `👤 <b>Referred by:</b> ${escapeHtml(referredBy)}
` +
            `📌 <b>Passed mandatory subscription:</b> ${forceSubPassed ? 'Yes' : 'No'}
` +
            `📅 <b>Join date:</b> ${joinedAt ? new Date(joinedAt).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) : '—'}
` +
            `🕐 <b>Last seen:</b> ${lastSeen ? new Date(lastSeen).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) : '—'}

` +
      `${'─'.repeat(30)}
` +
            `📥 <b>Total deposits:</b> ${totalDepositTon.toFixed(4)} TON
` +
            `📤 <b>Total paid withdrawals:</b> ${totalPaidTon.toFixed(4)} TON
` +
            `✅ <b>Successful withdrawal count:</b> ${paidCount}
` +
            `👥 <b>Total referrals:</b> ${totalReferrals}
` +
            `🟢 <b>Active referrals:</b> ${activeReferrals}
` +
            `📺 <b>Ads today:</b> ${adsToday}
` +
            `🎬 <b>Total ads:</b> ${adsAllTime}

` +
      `${'─'.repeat(30)}
` +
            `🕐 <b>Withdrawal request time:</b> ${requestTime} UTC
` +
      `${'━'.repeat(30)}`;

    return text;
  }

  bot.onText(/\/pending_wd/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const chatId = msg.chat.id.toString();
    try {
            // Fetch all non-final statuses, not just awaiting_manual — because the dashboard
            // treats any request that isn't completed/rejected as "pending". So if a request is in pending or
            // processing or awaiting_approval it will still show as "pending" on the dashboard even if
            // the (old) /pending_wd says "nothing here" because it only looked at awaiting_manual.
      const [snapManual, snapApproval, snapPending, snapProcessing] = await Promise.all([
        db.ref('withdrawQueue').orderByChild('status').equalTo('awaiting_manual').once('value'),
        db.ref('withdrawQueue').orderByChild('status').equalTo('awaiting_approval').once('value'),
        db.ref('withdrawQueue').orderByChild('status').equalTo('pending').once('value'),
        db.ref('withdrawQueue').orderByChild('status').equalTo('processing').once('value'),
      ]);

      const toList = (snap) => Object.entries(snap.val() || {}).map(([id, d]) => ({ id, ...d }));
      const manualItems     = toList(snapManual);
      const approvalItems   = toList(snapApproval);
      const pendingItems    = toList(snapPending);
      const processingItems = toList(snapProcessing);

      const allNonTerminal = [...manualItems, ...approvalItems, ...pendingItems, ...processingItems]
        .sort((a, b) => (a.ts || 0) - (b.ts || 0));

            if (!allNonTerminal.length) { await adminReply(bot, chatId, '📭 There are no pending withdrawals of any kind right now'); return; }

      const statusLabel = (s) => ({
                awaiting_manual:   '📝 Needs manual approval (exceeds max limit)',
                awaiting_approval: '⏸ Needs approval (exceeds daily limit)',
                pending:           '⏳ Waiting (will be processed automatically in the next batch)',
                processing:        '🔄 Currently processing',
      }[s] || s);

            // If there's nothing that actually needs a manual decision, just show a summary of the other statuses
      if (!manualItems.length) {
                let info = `📭 There are no withdrawals needing <b>manual approval</b> right now.\n\n` +
                    `But there are <b>${allNonTerminal.length}</b> withdrawal request(s) still "pending" from the dashboard's perspective:\n\n`;
        allNonTerminal.slice(0, 15).forEach(w => {
          const amt = roundAmount(w.ton ?? w.amt);
          info += `• <code>${w.id}</code> — ${statusLabel(w.status)} — ${amt.toFixed(4)} TON` +
                        ((w.lastError || w.error) ? `\n  ⚠️ Last error: ${escapeHtml(w.lastError || w.error)}` : '') + `\n`;
        });
                if (allNonTerminal.length > 15) info += `\n… and ${allNonTerminal.length - 15} more request(s) (use /queue for a count summary)`;
                info += `\n\n💡 These don't need a decision from you — they're processed automatically every minute (pending) or right now (processing). If they stay like this for a long time, send me /queue and /stats so we can check whether there's an issue with automatic processing.`;
        await adminReply(bot, chatId, info);
        return;
      }

      const list = manualItems.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const totalTON = list.reduce((s, w) => s + roundAmount(w.ton ?? w.amt), 0);

            let header = `📋 <b>Withdrawals needing manual approval</b>

` +
                `📊 Count: <b>${list.length}</b> request(s)
` +
                `💰 Total: <b>${totalTON.toFixed(4)} TON</b>
`;
      const otherCount = allNonTerminal.length - manualItems.length;
            if (otherCount > 0) header += `\nℹ️ There are also <b>${otherCount}</b> pending request(s) in other statuses (pending/processing/awaiting_approval) — these don't need manual approval, use /queue for details.\n`;
            header += `\nChoose a review method:`;

      await bot.sendMessage(chatId, header,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
                            { text: `📩 One by one (${list.length})`, callback_data: 'manual_wd_one_by_one' },
                            { text: `📋 Show all`,                  callback_data: 'manual_wd_list_all'   },
            ]]
          }
        }
      );

      manualReviewState[chatId] = { list, index: 0 };
    } catch(e) { await adminReply(bot, chatId, `❌ ${e.message}`); }
  });

    // ─── /logs [userId] [count|all] — Full financial log for the user ────────────
  bot.onText(/\/logs(?:\s+(.+))?/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const raw = (match && match[1] ? match[1] : '').trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    const userId = parts[0];
    const limit = parseLogLimitArg(parts[1]);

    if (!userId) {
      await adminReply(bot, msg.chat.id,
                `❌ Usage:\n` +
                `<code>/logs [userId]</code> to choose the count\n` +
                `<code>/logs [userId] 100</code> to show the last 100 activities\n` +
                `<code>/logs [userId] all</code> to show all activities`
      );
      return;
    }

    try {
      if (!limit) {
        await showLogLimitChooser(bot, msg.chat.id, userId);
        return;
      }
      await sendUserLogs(bot, msg.chat.id, userId, limit);
    } catch(e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });


    // ─── /top_referrals — Top 50 by total referrals ───────────────────
  bot.onText(/\/top_referrals/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
            await adminReply(bot, msg.chat.id, "🔍 Fetching referral data for all users... this may take a while");

      const usersSnap = await db.ref("users").once("value");
      const allUsers  = usersSnap.val() || {};

            await adminReply(bot, msg.chat.id, `👥 Fetched ${Object.keys(allUsers).length} user(s) — calculating...`);

      const userStats = [];
      for (const [userId, userData] of Object.entries(allUsers)) {
        const referrals     = userData.referrals     || {};
        const deposits      = userData.deposits      || {};
        const wdHistory     = userData.wdHistory     || {};

        const totalReferrals = Object.keys(referrals).length;
        if (totalReferrals === 0) continue;

                // Calculate referrals that deposited
        let depositedReferrals = 0;
        for (const refId of Object.keys(referrals)) {
          try {
            const refSnap = await db.ref(`users/${refId}/hasDeposited`).once("value");
            if (refSnap.val() === true) { depositedReferrals++; continue; }
                        // Alternative check from the deposits folder
            const refDepSnap = await db.ref(`users/${refId}/deposits`).once("value");
            const refDeps = refDepSnap.val() || {};
            const confirmed = Object.values(refDeps).filter(d => !d.status || d.status !== 'pending');
            if (confirmed.length > 0) depositedReferrals++;
                    } catch(e) { /* ignore */ }
        }

                // Total deposits
        const confirmedDeps = Object.values(deposits).filter(d => !d.status || d.status !== 'pending');
        const totalDepositTon = confirmedDeps.reduce((s, d) => s + (Number(d.amount) || 0), 0);

                // Total withdrawals
        const paidWds = Object.values(wdHistory).filter(w => w.status === 'paid');
        const totalWithdrawTon = paidWds.reduce((s, w) => s + (Number(w.sentAmount) || 0), 0);

        userStats.push({
          userId,
          totalReferrals,
          depositedReferrals,
          totalDepositTon,
          totalWithdrawTon,
          paidWdCount: paidWds.length,
        });
      }

            // Sort by total referrals
      userStats.sort((a, b) => b.totalReferrals - a.totalReferrals);
      const top50 = userStats.slice(0, 50);

      if (!top50.length) {
                await adminReply(bot, msg.chat.id, "📭 No users have referrals");
        return;
      }

      const CHUNK = 10;
      for (let i = 0; i < top50.length; i += CHUNK) {
        const chunk = top50.slice(i, i + CHUNK);
        let text = i === 0
                    ? `🏆 <b>Top 50 users — total referrals</b>\n${'━'.repeat(32)}\n\n`
                    : `🏆 <b>Continued... (${i + 1}–${Math.min(i + CHUNK, top50.length)})</b>\n\n`;

        chunk.forEach((u, idx) => {
          text +=
            `<b>${i + idx + 1}.</b> 👤 <code>${escapeHtml(u.userId)}</code>\n` +
                        `   👥 Total referrals: <b>${u.totalReferrals}</b>\n` +
                        `   ✅ Deposited: <b>${u.depositedReferrals}</b>\n` +
                        `   📥 Their deposits: <b>${u.totalDepositTon.toFixed(3)} TON</b>\n` +
                        `   📤 Their withdrawals: <b>${u.totalWithdrawTon.toFixed(3)} TON</b> (${u.paidWdCount} withdrawal(s))\n\n`;
        });

        await adminReply(bot, msg.chat.id, text);
        if (i + CHUNK < top50.length) await new Promise(r => setTimeout(r, 400));
      }
    } catch(e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  bot.onText(/\/lastpaid/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("withdrawQueue").orderByChild("status").equalTo("paid").once("value");
      const items = snap.val();
            if (!items) { await adminReply(bot, msg.chat.id, "📭 No paid withdrawals yet"); return; }

      const paid = Object.entries(items)
        .map(([id, d]) => ({ id, ...d }))
        .filter(d => d.completedAt || d.updatedAt)
        .sort((a, b) => (b.completedAt || b.updatedAt || 0) - (a.completedAt || a.updatedAt || 0))
        .slice(0, 5);

            let text = `💸 <b>Last 5 paid transactions</b>\n${'━'.repeat(30)}\n\n`;
      paid.forEach((w, idx) => {
        const ton    = roundAmount(w.ton ?? w.amt);
        const time   = new Date(w.completedAt || w.updatedAt).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false });
        const txLink = w.txHash ? `https://tonscan.org/tx/${encodeURIComponent(w.txHash)}` : null;
        text +=
          `${idx + 1}. 👤 <code>${w.userId || '?'}</code>\n` +
          `   💰 <b>${ton} TON</b>\n` +
          `   🆔 <code>${w.id}</code>\n` +
          `   📬 <code>${(w.address || '—').substring(0, 20)}...</code>\n` +
          `   🕐 ${time} UTC\n` +
          (txLink ? `   🔗 <a href="${txLink}">View TX</a>\n` : ``) +
          `\n`;
      });

      await adminReply(bot, msg.chat.id, text, { disable_web_page_preview: true });
    } catch(e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

    // ─── /stop_all — Fully stop withdrawals ──────────
  bot.onText(/\/stop_all/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
        systemPaused      = false; // leave it false since stop_all is broader
    WITHDRAWAL_ENABLED = false;
    systemPaused       = true;
    await adminReply(bot, msg.chat.id,
            `⛔ <b>System fully stopped</b>\n\n` +
            `🚫 Automatic withdrawals: <b>stopped</b>\n` +
            `🚫 Request processing: <b>stopped</b>\n\n` +
            `Use /start_all to restart`
    );
    console.log("⛔ SYSTEM FULLY STOPPED by admin");
  });

    // ─── /start_all — Resume withdrawals ────────
  bot.onText(/\/start_all/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    systemPaused       = false;
    WITHDRAWAL_ENABLED = true;
    await adminReply(bot, msg.chat.id,
            `✅ <b>System fully started</b>\n\n` +
            `✅ Automatic withdrawals: <b>running</b>\n` +
            `✅ Request processing: <b>active</b>\n\n` +
            `🔄 Starting to process pending withdrawals...`
    );
    console.log("✅ SYSTEM FULLY STARTED by admin");
    setTimeout(() => processPendingWithdrawals(), 1000);
  });

  // ─── /check_suspicious ────────────────────────────────
  bot.onText(/\/check_suspicious/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
            await adminReply(bot, msg.chat.id, "🔍 Checking pending withdrawals for fraud...");
      const snap  = await db.ref("withdrawQueue").once("value");
      const items = snap.val();
            if (!items) { await adminReply(bot, msg.chat.id, "📭 No withdrawals in the queue"); return; }
      const walletUsers = {};
      Object.entries(items).forEach(([id, d]) => {
        const status = d.status || '';
        if (!['pending', 'awaiting_approval', 'awaiting_manual', 'processing'].includes(status)) return;
        if (!d.address || !d.userId) return;
        const addr = d.address;
        if (!walletUsers[addr]) walletUsers[addr] = { userIds: new Set(), withdrawIds: [], totalTon: 0 };
        walletUsers[addr].userIds.add(String(d.userId));
        walletUsers[addr].withdrawIds.push(id);
        walletUsers[addr].totalTon += roundAmount(d.ton);
      });
      const suspicious = Object.entries(walletUsers).filter(([, v]) => v.userIds.size > 3).sort((a, b) => b[1].userIds.size - a[1].userIds.size);
            if (!suspicious.length) { await adminReply(bot, msg.chat.id, `✅ <b>No suspicious activity detected</b>`); return; }
            let text = `🚨 <b>Suspicious wallets — multiple accounts</b>\nDetected <b>${suspicious.length}</b> wallet(s)\n${'━'.repeat(32)}\n\n`;
      for (let i = 0; i < suspicious.length; i++) {
        const [addr, data] = suspicious[i];
        const userList = [...data.userIds].join(', ');
                text += `🔴 <b>Wallet ${i + 1}</b>\n📬 <code>${addr}</code>\n👥 Number of users: <b>${data.userIds.size}</b>\n🆔 Users: <code>${userList}</code>\n📋 Pending requests: <b>${data.withdrawIds.length}</b>\n💰 Total requested: <b>${data.totalTon.toFixed(3)} TON</b>\n\n`;
        if (text.length > 3000 && i < suspicious.length - 1) {
          await adminReply(bot, msg.chat.id, text);
                    text = `🚨 <b>Continued — suspicious wallets</b>\n\n`;
        }
      }
      await adminReply(bot, msg.chat.id, text);
        } catch (e) { await adminReply(bot, msg.chat.id, `❌ Error: ${e.message}`); }
  });

  // ─── /awaiting_queue ──────────────────────────────────
  bot.onText(/\/awaiting_queue/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("withdrawQueue").orderByChild("status").equalTo("awaiting_approval").once("value");
      const items = snap.val();
            if (!items) { await adminReply(bot, msg.chat.id, "📭 No withdrawals currently pending due to the daily limit"); return; }

      const list = Object.entries(items)
        .map(([id, d]) => ({ id, ...d }))
        .sort((a, b) => (a.ts || 0) - (b.ts || 0));

      const totalTON = list.reduce((s, w) => s + roundAmount(w.ton), 0);
      const CHUNK = 15;

      for (let i = 0; i < list.length; i += CHUNK) {
        const chunk = list.slice(i, i + CHUNK);
        let text = i === 0
                    ? `⏳ <b>Pending withdrawals — daily limit</b>\n📊 Total: <b>${list.length}</b> request(s) | <b>${totalTON.toFixed(4)} TON</b>\n${'━'.repeat(30)}\n\n`
                    : `⏳ <b>Continued... (${i + 1}–${Math.min(i + CHUNK, list.length)})</b>\n\n`;

        chunk.forEach((w, idx) => {
          const ton      = roundAmount(w.ton);
          const time     = w.ts ? new Date(w.ts).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) : '—';
          const unlockAt = w.unlockAt ? new Date(w.unlockAt).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) : '—';
          text +=
            `${i + idx + 1}. 👤 <code>${w.userId || '?'}</code>\n` +
            `   🆔 <code>${w.id}</code>\n` +
            `   💰 ${ton} TON | 🪙 ${Number(w.amt || 0).toLocaleString()}\n` +
                        `   🕐 Requested: ${time} UTC\n` +
                        `   🔓 Auto-unlock: ${unlockAt} UTC\n\n`;
        });

        await adminReply(bot, msg.chat.id, text);
        if (i + CHUNK < list.length) await new Promise(r => setTimeout(r, 400));
      }
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

    // ─── /unlock [count] ────────────────────────────────────
  bot.onText(/\/unlock(?:\s+(\d+))?/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("withdrawQueue").orderByChild("status").equalTo("awaiting_approval").once("value");
      const items = snap.val();
            if (!items) { await adminReply(bot, msg.chat.id, "📭 No withdrawals awaiting daily approval"); return; }

      const list = Object.entries(items)
        .map(([id, d]) => ({ id, ...d }))
        .sort((a, b) => (a.ts || 0) - (b.ts || 0));

      const requestedCount = match && match[1] ? parseInt(match[1]) : list.length;
      const toUnlock = list.slice(0, requestedCount);

      let unlocked = 0;
      const now = Date.now();
      for (const w of toUnlock) {
        await db.ref(`withdrawQueue/${w.id}`).update({
          status:    "pending",
          updatedAt: now,
          holdReason: null,
          unlockAt:  null,
          lastError: null,
          approvedByAdmin: true,
        }).catch(() => {});
        unlocked++;
        console.log(`🔓 Admin unlocked: ${w.id}`);
      }

      await adminReply(bot, msg.chat.id,
                `🔓 <b>Released ${unlocked} withdrawal(s)</b> for processing\n\n` +
                `${list.length - unlocked > 0 ? `⏳ Still waiting: <b>${list.length - unlocked}</b>` : `✅ All pending withdrawals released`}\n\n` +
                `🔄 Starting processing...`
      );
      setTimeout(() => processPendingWithdrawals(), 1000);
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /pending_reasons ─────────────────────────────────
  bot.onText(/\/pending_reasons/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("withdrawQueue").orderByChild("status").once("value");
      const items = snap.val();
            if (!items) { await adminReply(bot, msg.chat.id, "📭 No withdrawals"); return; }
      const held = Object.entries(items).map(([id, d]) => ({ id, ...d })).filter(w => ['pending', 'awaiting_approval', 'awaiting_manual', 'processing'].includes(w.status)).sort((a, b) => (a.ts || 0) - (b.ts || 0));
            if (!held.length) { await adminReply(bot, msg.chat.id, "📭 No pending withdrawals right now"); return; }
      const CHUNK = 15;
      for (let i = 0; i < held.length; i += CHUNK) {
        const chunk = held.slice(i, i + CHUNK);
                let text = i === 0 ? `📋 <b>Pending Withdrawals (${held.length})</b>\n\n` : `📋 <b>Continued... (${i + 1}–${Math.min(i + CHUNK, held.length)})</b>\n\n`;
        chunk.forEach((w, idx) => {
          const ton    = roundAmount(w.ton);
          const time   = w.ts ? new Date(w.ts).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) : '—';
                    const status = w.status === 'awaiting_manual' ? '📝 Manual approval' : (w.status === 'awaiting_approval' ? '⏳ Awaiting approval' : (w.status === 'processing' ? '🔄 processing' : '🔄 pending'));
          let reason = '—';
          if (w.holdReason) reason = w.holdReason;
          else if (w.lastError) reason = w.lastError;
          else if (w.error) reason = w.error;
                    else if (w.status === 'awaiting_manual') reason = `Exceeds the maximum automatic payout limit (${MAX_WITHDRAWAL_AMOUNT} TON)`;
                    else if (w.status === 'awaiting_approval') reason = 'Exceeds the daily limit';
                    else if (ton > MAX_WITHDRAWAL_AMOUNT) reason = `Exceeds the maximum limit (${MAX_WITHDRAWAL_AMOUNT} TON)`;
                    else if (ton < MIN_WITHDRAWAL_AMOUNT) reason = `Below the minimum limit (${MIN_WITHDRAWAL_AMOUNT} TON)`;
                    text += `${i + idx + 1}. ${status}\n   🆔 <code>${w.id}</code>\n   👤 User: <code>${w.userId || '?'}</code>\n   💰 ${ton} TON | 🪙 ${Number(w.amt || 0).toLocaleString()}\n   ⚠️ Reason: ${reason}\n   🕐 ${time} UTC\n\n`;
        });
        await adminReply(bot, msg.chat.id, text);
        if (i + CHUNK < held.length) await new Promise(r => setTimeout(r, 500));
      }
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /sendmsg [userId] ────────────────────────────────
  // ─── /broadcast ───────────────────────────────────────
    // Conversation states
  const msgSessions = {};

    // Ongoing broadcast state
  let broadcastState = null;

  function buildProgressBar(current, total, width) {
    if (total === 0) return '[' + '░'.repeat(width) + ']';
    const filled = Math.round((current / total) * width);
    return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
  }

  function formatEta(seconds) {
        if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
        if (m < 60) return `${m}m ${s}s`;
    const h = Math.floor(m / 60);
        return `${h}h ${m % 60}m`;
  }

  function sanitizeChannelKey(id) {
    return String(id).replace(/[.$#[\]/]/g, '_');
  }

  async function getChannelsList() {
    const snap = await db.ref('broadcastChannels').once('value');
    return snap.exists() ? snap.val() : {};
  }

  // mode: 'user' | 'channel' | 'broadcast_users' | 'broadcast_channels'
  async function startMsgSession(bot, chatId, target, mode = 'user') {
    msgSessions[chatId] = { step: 'text', target, mode, text: null, photo: null, buttons: [] };
    let header;
        if (mode === 'broadcast_users')        header = `📢 <b>Send message to all users</b>`;
        else if (mode === 'broadcast_channels') header = `📢 <b>Send message to all channels</b>`;
        else if (mode === 'channel')            header = `📡 <b>Send message to channel</b> <code>${target}</code>`;
        else                                    header = `📩 <b>Send message to user</b> <code>${target}</code>`;
    await adminReply(bot, chatId,
      `${header}\n\n` +
            `<b>Step 1 — Write the message text:</b>\n` +
            `(You can use HTML like <code>&lt;b&gt;text&lt;/b&gt;</code>)\n\n` +
            `Type /cancel to cancel`
    );
  }

  bot.onText(/\/sendmsg(?:\s+(\d+))?/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const userId = match && match[1] ? match[1].trim() : null;
    if (!userId) {
            await adminReply(bot, msg.chat.id, `❌ Usage: /sendmsg [userId]\nExample: /sendmsg 6970148965`);
      return;
    }
    await startMsgSession(bot, msg.chat.id, userId, 'user');
  });

  bot.onText(/^\/broadcast(?:@\w+)?$/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    await startMsgSession(bot, msg.chat.id, null, 'broadcast_users');
  });

  // ─── Channel broadcast management ──────────────────────
  bot.onText(/^\/addchannel(?:\s+(\S+))?(?:\s+([\s\S]+))?$/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const channelId = match && match[1] ? match[1].trim() : null;
    const label     = match && match[2] ? match[2].trim() : null;
    if (!channelId) {
            await adminReply(bot, msg.chat.id, `❌ Usage: /addchannel [channelId or @username] [optional label]\nExample: /addchannel @MyChannel My Channel`);
      return;
    }
    try {
      let title = label;
      try {
        const chat = await bot.getChat(channelId);
        if (!title) title = chat.title || chat.username || channelId;
      } catch (e) {
                await adminReply(bot, msg.chat.id, `⚠️ Couldn't verify the channel (make sure the bot is an admin in it): ${e.message}\nSaving with the provided ID anyway...`);
        if (!title) title = channelId;
      }
      const key = sanitizeChannelKey(channelId);
      await db.ref(`broadcastChannels/${key}`).set({ id: channelId, title, addedAt: Date.now(), addedBy: String(msg.chat.id) });
            await adminReply(bot, msg.chat.id, `✅ <b>Channel added</b>\n📡 <code>${escapeHtml(channelId)}</code>\n🏷 ${escapeHtml(title)}`);
    } catch (e) {
            await adminReply(bot, msg.chat.id, `❌ Error: ${e.message}`);
    }
  });

  bot.onText(/^\/removechannel(?:\s+(\S+))?$/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const channelId = match && match[1] ? match[1].trim() : null;
    if (!channelId) {
            await adminReply(bot, msg.chat.id, `❌ Usage: /removechannel [channelId or @username]`);
      return;
    }
    try {
      const key  = sanitizeChannelKey(channelId);
      const snap = await db.ref(`broadcastChannels/${key}`).once('value');
      if (!snap.exists()) {
                await adminReply(bot, msg.chat.id, `❌ Channel not found in the list: <code>${escapeHtml(channelId)}</code>`);
        return;
      }
      await db.ref(`broadcastChannels/${key}`).remove();
            await adminReply(bot, msg.chat.id, `✅ <b>Channel removed</b>\n📡 <code>${escapeHtml(channelId)}</code>`);
    } catch (e) {
            await adminReply(bot, msg.chat.id, `❌ Error: ${e.message}`);
    }
  });

  bot.onText(/^\/channels$/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const channels = await getChannelsList();
      const entries  = Object.values(channels);
      if (!entries.length) {
                await adminReply(bot, msg.chat.id, `📭 No channels added yet.\nUse /addchannel [channelId or @username] to add one.`);
        return;
      }
            let text = `📡 <b>Registered Channels (${entries.length})</b>\n${'━'.repeat(28)}\n\n`;
      entries.forEach((c, i) => {
        text += `${i + 1}. 🏷 ${escapeHtml(c.title || '—')}\n   🆔 <code>${escapeHtml(c.id)}</code>\n\n`;
      });
      await adminReply(bot, msg.chat.id, text);
    } catch (e) {
            await adminReply(bot, msg.chat.id, `❌ Error: ${e.message}`);
    }
  });

  bot.onText(/^\/sendchannel(?:\s+(\S+))?$/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const channelId = match && match[1] ? match[1].trim() : null;
    if (!channelId) {
            await adminReply(bot, msg.chat.id, `❌ Usage: /sendchannel [channelId or @username]\nExample: /sendchannel @MyChannel`);
      return;
    }
    await startMsgSession(bot, msg.chat.id, channelId, 'channel');
  });

  bot.onText(/^\/broadcast_channels$/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const channels = await getChannelsList();
    if (!Object.keys(channels).length) {
            await adminReply(bot, msg.chat.id, `📭 No channels added yet.\nUse /addchannel [channelId or @username] to add one first.`);
      return;
    }
    await startMsgSession(bot, msg.chat.id, null, 'broadcast_channels');
  });

  bot.onText(/\/cancel/, async (msg) => {
    if (!isAdmin(msg)) return;
    if (msgSessions[msg.chat.id]) {
      delete msgSessions[msg.chat.id];
            await adminReply(bot, msg.chat.id, `❌ Message sending cancelled`);
    }
  });

  bot.onText(/\/broadcast_status/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    if (!broadcastState) {
            await adminReply(bot, msg.chat.id, '📭 No broadcast currently in progress');
      return;
    }
    const s        = broadcastState;
        const label    = s.label === 'channels' ? '📡 Channels' : '👥 Total';
    const elapsed  = Math.floor((Date.now() - s.startedAt) / 1000);
    const done     = s.current;
    const remaining = s.total - done;
    const pct      = s.total > 0 ? ((done / s.total) * 100).toFixed(1) : 0;
    const bar      = buildProgressBar(done, s.total, 20);

    if (s.done) {
      const duration = Math.floor((s.doneAt - s.startedAt) / 1000);
      await adminReply(bot, msg.chat.id,
                `✅ <b>Broadcast complete</b>\n\n` +
        `${bar} ${pct}%\n\n` +
                `${label}: <b>${s.total}</b>\n` +
                `✅ Delivered: <b>${s.sent}</b>\n` +
                `❌ Failed: <b>${s.failed}</b>\n` +
                `⏱ Duration: <b>${duration}s</b>`
      );
    } else {
      const speed    = elapsed > 0 ? (done / elapsed).toFixed(1) : '—';
      const etaSec   = speed > 0 ? Math.floor(remaining / speed) : null;
      const etaStr   = etaSec !== null ? formatEta(etaSec) : '—';
      await adminReply(bot, msg.chat.id,
                `📡 <b>Broadcast in progress</b>\n\n` +
        `${bar} ${pct}%\n\n` +
                `${label}: <b>${s.total}</b>\n` +
                `📤 Delivered so far: <b>${done}</b>\n` +
                `✅ Succeeded: <b>${s.sent}</b>\n` +
                `❌ Failed: <b>${s.failed}</b>\n` +
                `⏳ Remaining: <b>${remaining}</b>\n` +
                `⚡ Speed: <b>${speed}/s</b>\n` +
                `🕐 Time remaining: <b>${etaStr}</b>\n` +
                `⏱ Elapsed: <b>${formatEta(elapsed)}</b>`
      );
    }
  });

  bot.onText(/\/broadcast_debug/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
        await adminReply(bot, msg.chat.id, '🔍 Checking the database...');
    try {
      const dbUrl  = process.env.FIREBASE_DB_URL.replace(/\/$/, '');
      const token  = await admin.app().options.credential.getAccessToken();
      const res    = await fetch(`${dbUrl}/users.json?shallow=true&access_token=${token.access_token}`);
      const data   = await res.json();
      const count  = data ? Object.keys(data).length : 0;
      const sample = data ? Object.keys(data).slice(0, 5).join(', ') : '—';
      await adminReply(bot, msg.chat.id,
                `🔍 <b>Database diagnostics</b>\n\n` +
                `📁 Path: <code>/users</code>\n` +
                `👥 Number of users: <b>${count}</b>\n` +
                `🔑 Example IDs:\n<code>${sample}</code>\n\n` +
        (count === 0
                    ? `⚠️ <b>Path is empty!</b> Make sure users are stored under <code>/users/{userId}</code>`
                    : `✅ Data exists — broadcast will work correctly`)
      );
    } catch (e) {
            await adminReply(bot, msg.chat.id, `❌ Error while checking: ${e.message}`);
    }
  });

    // Message handler for sendmsg / broadcast steps
  bot.on('message', async (msg) => {
    const chatId  = msg.chat.id.toString();
    if (!isAdminId(chatId)) return;
    const session = msgSessions[chatId];
    if (!session) return;
    const text = msg.text || '';

    if (session.step === 'text') {
      if (!text || text.startsWith('/')) return;
      session.text = text;
      session.step = 'photo';
      await adminReply(bot, msg.chat.id,
                `✅ Text saved.\n\n` +
                `<b>Step 2 — Send an image URL, or type:</b>\n<code>skip</code> for no image`
      );
      return;
    }

    if (session.step === 'photo') {
      if (text.toLowerCase() === 'skip') {
        session.photo = null;
      } else {
        session.photo = text.trim();
      }
      session.step = 'buttons';
      await adminReply(bot, msg.chat.id,
                `✅ Done.\n\n` +
                `<b>Step 3 — Add buttons (one button per line):</b>\n` +
                `Format: <code>button text | link</code>\n` +
                `Example:\n<code>🐼 Open App | ${BOT_URL}</code>\n\n` +
                `Or type <code>skip</code> for no buttons`
      );
      return;
    }

    if (session.step === 'buttons') {
      if (text.toLowerCase() !== 'skip') {
        const lines   = text.split('\n').map(l => l.trim()).filter(Boolean);
        const buttons = [];
        for (const line of lines) {
          const parts = line.split('|');
          if (parts.length >= 2) {
            const label = parts[0].trim();
            const url   = parts.slice(1).join('|').trim();
            if (label && url) buttons.push([{ text: label, url }]);
          }
        }
        session.buttons = buttons;
      } else {
        session.buttons = [];
      }
      session.step = 'preview';

      let targetLabel;
            if (session.mode === 'broadcast_users')        targetLabel = `📢 <b>To all users</b>`;
            else if (session.mode === 'broadcast_channels') targetLabel = `📢 <b>To all channels</b>`;
            else if (session.mode === 'channel')            targetLabel = `📡 <b>Channel</b> <code>${escapeHtml(session.target)}</code>`;
            else                                             targetLabel = `👤 <b>${escapeHtml(session.target)}</b>`;

      await adminReply(bot, msg.chat.id,
                `🔍 <b>Message Preview</b>\n` +
        `${'━'.repeat(30)}\n` +
                `📬 Recipient: ${targetLabel}\n` +
                (session.photo ? `🖼 Image: <a href="${session.photo}">Image link</a>\n` : `🖼 Image: none\n`) +
                `🔘 Buttons: ${session.buttons.length > 0 ? session.buttons.map(r => r.map(b => b.text).join(' | ')).join(' / ') : 'none'}\n` +
        `${'━'.repeat(30)}\n\n` +
                `📝 <b>Text:</b>\n${session.text}`,
        {
          reply_markup: {
            inline_keyboard: [[
                            { text: '✅ Send now', callback_data: `do_send_msg:${chatId}` },
                            { text: '❌ Cancel',      callback_data: `cancel_send_msg:${chatId}` },
            ]]
          }
        }
      );
      return;
    }
  });

  // ─── Callbacks ────────────────────────────────────────
  bot.on('callback_query', async (query) => {
    if (!isAdminId(query.message.chat.id)) return;
    const data   = query.data || '';
    const chatId = query.message.chat.id;

    if (data.startsWith('cancel_send_msg:')) {
      const sid = data.replace('cancel_send_msg:', '').trim();
      delete msgSessions[sid];
            await bot.answerCallbackQuery(query.id, { text: '❌ Cancelled' });
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
            await adminReply(bot, chatId, '❌ Sending cancelled');
      return;
    }

    if (data.startsWith('do_send_msg:')) {
      const sid     = data.replace('do_send_msg:', '').trim();
      const session = msgSessions[sid];
            if (!session) { await bot.answerCallbackQuery(query.id, { text: '❌ Session expired' }); return; }
      delete msgSessions[sid];

            await bot.answerCallbackQuery(query.id, { text: '📤 Sending...' });
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});

      const { text: msgText, photo, buttons, mode, target } = session;
      const replyMarkup = buttons.length > 0 ? { inline_keyboard: buttons } : undefined;

      async function sendToTarget(uid) {
        try {
          if (photo) {
            await bot.sendPhoto(uid, photo, { caption: msgText, parse_mode: 'HTML', ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
          } else {
            await bot.sendMessage(uid, msgText, { parse_mode: 'HTML', disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
          }
          return true;
        } catch (e) { return false; }
      }

      async function runBroadcast(ids, label) {
                await adminReply(bot, chatId,
                    `📢 <b>Sending message to all ${label}...</b>\n` +
                    '💡 Use /broadcast_status to track progress at any time'
        );
        try {
          let sent = 0, failed = 0;
                    broadcastState = { total: ids.length, sent: 0, failed: 0, current: 0, startedAt: Date.now(), done: false, doneAt: null, label };

          for (let i = 0; i < ids.length; i++) {
                        const ok = await sendToTarget(ids[i]);
            if (ok) sent++; else failed++;
            broadcastState.current = i + 1;
            broadcastState.sent    = sent;
            broadcastState.failed  = failed;
                        if ((i + 1) % 100 === 0 || i === ids.length - 1) {
                            const pct = (((i + 1) / ids.length) * 100).toFixed(1);
                            const bar = buildProgressBar(i + 1, ids.length, 15);
              await adminReply(bot, chatId,
                `📊 ${bar} ${pct}%\n` +
                                `📤 <b>${i + 1}</b>/${ids.length} — ✅ ${sent} | ❌ ${failed}`
              );
            }
            await new Promise(r => setTimeout(r, 50));
          }

          broadcastState.done   = true;
          broadcastState.doneAt = Date.now();
          const duration = Math.floor((broadcastState.doneAt - broadcastState.startedAt) / 1000);

          await adminReply(bot, chatId,
                        `🎉 <b>Broadcast finished</b>\n\n` +
                        `${buildProgressBar(ids.length, ids.length, 15)} 100%\n\n` +
                        `👥 Total: <b>${ids.length}</b>\n` +
                        `✅ Delivered: <b>${sent}</b>\n` +
                        `❌ Failed: <b>${failed}</b>\n` +
                        `⏱ Duration: <b>${formatEta(duration)}</b>`
          );
        } catch (e) {
          if (broadcastState) { broadcastState.done = true; broadcastState.doneAt = Date.now(); }
                    await adminReply(bot, chatId, `❌ Broadcast error: ${e.message}`);
        }
      }

      if (mode === 'user') {
                const ok = await sendToTarget(target);
        await adminReply(bot, chatId,
          ok
                        ? `✅ <b>Message sent successfully</b> to user <code>${escapeHtml(target)}</code>`
                        : `❌ <b>Sending failed</b> for user <code>${escapeHtml(target)}</code> — check the chat ID`
        );
            } else if (mode === 'channel') {
                const ok = await sendToTarget(target);
                await adminReply(bot, chatId,
                    ok
                        ? `✅ <b>Message sent successfully</b> to channel <code>${escapeHtml(target)}</code>`
                        : `❌ <b>Sending failed</b> for channel <code>${escapeHtml(target)}</code> — check the ID and that the bot is an admin there`
                );
            } else if (mode === 'broadcast_users') {
        try {
          let userIds = [];
          try {
            const dbUrl    = process.env.FIREBASE_DB_URL.replace(/\/$/, '');
            const token    = await admin.app().options.credential.getAccessToken();
            const shallowRes = await fetch(`${dbUrl}/users.json?shallow=true&access_token=${token.access_token}`);
            const shallowData = await shallowRes.json();
            userIds = shallowData ? Object.keys(shallowData) : [];
          } catch (shallowErr) {
            console.log(`⚠️ shallow fetch failed, fallback: ${shallowErr.message}`);
            const usersSnap = await db.ref('users').once('value');
            const users     = usersSnap.val() || {};
            userIds         = Object.keys(users);
          }
                    await runBroadcast(userIds, 'users');
        } catch (e) {
                    await adminReply(bot, chatId, `❌ Broadcast error: ${e.message}`);
                }
            } else if (mode === 'broadcast_channels') {
                try {
                    const channels   = await getChannelsList();
                    const channelIds = Object.values(channels).map(c => c.id);
                    if (!channelIds.length) {
                        await adminReply(bot, chatId, `📭 No channels registered — nothing to send to.`);
                    } else {
                        await runBroadcast(channelIds, 'channels');
                    }
                } catch (e) {
                    await adminReply(bot, chatId, `❌ Broadcast error: ${e.message}`);
                }
      }
      return;
    }

    const msgId  = query.message.message_id;

        // ── Manual review: choose display method ─────────────────────────────────────
    if (data === 'manual_wd_one_by_one' || data === 'manual_wd_list_all') {
      const state = manualReviewState[chatId];
      if (!state || !state.list.length) {
                await bot.answerCallbackQuery(query.id, { text: '📭 The list or session has expired — rerun /pending_wd' });
        return;
      }

      if (data === 'manual_wd_list_all') {
                // Show a compact list of all requests
        const totalTON = state.list.reduce((s, w) => s + roundAmount(w.ton ?? w.amt), 0);
                let text = `📋 <b>All Pending Withdrawals (${state.list.length})</b>\n💰 Total: <b>${totalTON.toFixed(4)} TON</b>\n${'━'.repeat(28)}\n\n`;
        state.list.forEach((w, i) => {
          const amt = roundAmount(w.ton ?? w.amt);
          text += `${i + 1}. 👤 <code>${w.userId || '?'}</code> — <b>${amt.toFixed(4)} TON</b>\n    🆔 <code>${w.id}</code>\n`;
        });
                text += `\n${'━'.repeat(28)}\nUse the button below to review one by one`;
        await bot.editMessageText(text, {
          chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '📩 Start one-by-one review', callback_data: 'manual_wd_one_by_one' }]] }
        });
        state.index = 0;
        await bot.answerCallbackQuery(query.id);
        return;
      }

            // One by one — send first/next request
      const wd = state.list[state.index];
      if (!wd) {
                await bot.answerCallbackQuery(query.id, { text: '✅ All requests done' });
                await bot.editMessageText('✅ <b>All requests reviewed</b>', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
        delete manualReviewState[chatId];
        return;
      }

      const wdText = await buildManualWdMessage(wd, wd.id);
      const remaining = state.list.length - state.index;
            const fullText = wdText + `\n\n📊 <b>Remaining: ${remaining}/${state.list.length}</b>`;

      await bot.editMessageText(fullText, {
        chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
                        { text: '✅ Approve — Pay now', callback_data: `manual_approve:${wd.id}` },
                        { text: '❌ Reject',                callback_data: `manual_reject:${wd.id}`  },
            { text: '📋 Logs',               callback_data: `wd_logs:${wd.userId || ''}` },
          ]]
        }
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

        // ── Manual approval of a withdrawal ────────────────────────────────────────────────
    if (data.startsWith('manual_approve:')) {
      const withdrawId = data.replace('manual_approve:', '').trim();
      try {
        const snap = await db.ref(`withdrawQueue/${withdrawId}`).once('value');
        const wd   = snap.val();
                if (!wd) { await bot.answerCallbackQuery(query.id, { text: '❌ Withdrawal not found!' }); return; }
        await db.ref(`withdrawQueue/${withdrawId}`).update({
          status: 'pending', approvedByAdmin: true, updatedAt: Date.now(), holdReason: null, unlockAt: null, lastError: null
        });
                // Advance to the next in the session
        const state = manualReviewState[chatId];
        if (state) state.index++;
        await bot.editMessageText(
                    (query.message.text || '') + `\n\n✅ <b>Approved — paying now...</b>`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
        );
                await bot.answerCallbackQuery(query.id, { text: '✅ Approved — payment will be sent now' });
        setTimeout(() => processPendingWithdrawals(), 1000);

                // Automatically send the next request if a session is active
        if (state && state.list[state.index]) {
          const next = state.list[state.index];
          const nextText = await buildManualWdMessage(next, next.id);
          const remaining = state.list.length - state.index;
          await bot.sendMessage(chatId,
                        nextText + `\n\n📊 <b>Remaining: ${remaining}/${state.list.length}</b>`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[
                                    { text: '✅ Approve — Pay now', callback_data: `manual_approve:${next.id}` },
                                    { text: '❌ Reject',                callback_data: `manual_reject:${next.id}`  },
                  { text: '📋 Logs',               callback_data: `wd_logs:${next.userId || ''}` },
                ]]
              }
            }
          );
        } else if (state && !state.list[state.index]) {
                    await bot.sendMessage(chatId, '✅ <b>All requests reviewed</b>', { parse_mode: 'HTML' });
          delete manualReviewState[chatId];
        }
      } catch(e) { await bot.answerCallbackQuery(query.id, { text: `❌ ${e.message}` }); }
      return;
    }

        // ── Manual rejection of a withdrawal ───────────────────────────────────────────────────────
    if (data.startsWith('manual_reject:')) {
      const withdrawId = data.replace('manual_reject:', '').trim();
      try {
        const snap = await db.ref(`withdrawQueue/${withdrawId}`).once('value');
        const wd   = snap.val();
                if (!wd) { await bot.answerCallbackQuery(query.id, { text: '❌ Withdrawal not found!' }); return; }
        await db.ref(`withdrawQueue/${withdrawId}`).update({
                    status: 'cancelled', updatedAt: Date.now(), holdReason: 'Rejected manually by admin'
        });
        if (wd.userId && wd.wdId) {
          await db.ref(`users/${wd.userId}/wdHistory/${wd.wdId}`).update({ status: 'cancelled', updatedAt: Date.now() }).catch(() => {});
        }
        const state = manualReviewState[chatId];
        if (state) state.index++;
        await bot.editMessageText(
                    (query.message.text || '') + `\n\n❌ <b>Rejected and cancelled</b>`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
        );
                await bot.answerCallbackQuery(query.id, { text: '❌ Withdrawal rejected' });

                // Automatically send the next request
        if (state && state.list[state.index]) {
          const next = state.list[state.index];
          const nextText = await buildManualWdMessage(next, next.id);
          const remaining = state.list.length - state.index;
          await bot.sendMessage(chatId,
                        nextText + `\n\n📊 <b>Remaining: ${remaining}/${state.list.length}</b>`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[
                                    { text: '✅ Approve — Pay now', callback_data: `manual_approve:${next.id}` },
                                    { text: '❌ Reject',                callback_data: `manual_reject:${next.id}`  },
                  { text: '📋 Logs',               callback_data: `wd_logs:${next.userId || ''}` },
                ]]
              }
            }
          );
        } else if (state && !state.list[state.index]) {
                    await bot.sendMessage(chatId, '✅ <b>All requests reviewed</b>', { parse_mode: 'HTML' });
          delete manualReviewState[chatId];
        }
      } catch(e) { await bot.answerCallbackQuery(query.id, { text: `❌ ${e.message}` }); }
      return;
    }

        // ── Choose log count / user logs from the withdrawal button ─────────────────────────
    if (data.startsWith('log_limit:')) {
      const parts = data.split(':');
      const userId = parts[1];
      const limit = parseLogLimitArg(parts[2]) || 30;
            await bot.answerCallbackQuery(query.id, { text: `📋 Fetching ${getLogLimitLabel(limit)}...` });
      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
        await sendUserLogs(bot, chatId, userId, limit);
      } catch(e) { await adminReply(bot, chatId, `❌ ${e.message}`); }
      return;
    }

    if (data.startsWith('wd_logs:')) {
      const userId = data.replace('wd_logs:', '').trim();
            if (!userId) { await bot.answerCallbackQuery(query.id, { text: '❌ No userId' }); return; }
            await bot.answerCallbackQuery(query.id, { text: '📋 Choose the number of activities' });
      await showLogLimitChooser(bot, chatId, userId);
      return;
    }


        if (data.startsWith('ban_user:')) {
      const uid = data.replace('ban_user:', '').trim();
      await db.ref(`bannedUsers/${uid}`).set({ bannedAt: Date.now(), by: 'admin' });
            await bot.answerCallbackQuery(query.id, { text: `🚫 Banned ${uid}` });
            await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: "✅ Unban", callback_data: `unban_user:${uid}` }]] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    }

    if (data.startsWith('unban_user:')) {
      const uid = data.replace('unban_user:', '').trim();
      await db.ref(`bannedUsers/${uid}`).remove();
            await bot.answerCallbackQuery(query.id, { text: `✅ Unbanned ${uid}` });
            await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: "🚫 Ban User", callback_data: `ban_user:${uid}` }]] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    }

    if (data.startsWith('reprocess_wd:')) {
      const withdrawId = data.replace('reprocess_wd:', '').trim();
      try {
        const snap = await db.ref(`withdrawQueue/${withdrawId}`).once("value");
        const wd   = snap.val();
                if (!wd) { await bot.answerCallbackQuery(query.id, { text: "❌ Withdrawal not found!" }); return; }
        await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "pending", updatedAt: Date.now(), lastError: null });
                await bot.editMessageText(query.message.text + `\n\n🔄 <b>Re-added for processing</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
                await bot.answerCallbackQuery(query.id, { text: "🔄 Re-added to the queue" });
        setTimeout(() => processPendingWithdrawals(), 1000);
            } catch (e) { await bot.answerCallbackQuery(query.id, { text: `❌ Error: ${e.message}` }); }
    }

    if (data.startsWith('approve_wd:')) {
      const withdrawId = data.replace('approve_wd:', '').trim();
      try {
        const snap = await db.ref(`withdrawQueue/${withdrawId}`).once("value");
        const wd   = snap.val();
                if (!wd) { await bot.answerCallbackQuery(query.id, { text: "❌ Withdrawal not found!" }); return; }
                if (!['awaiting_approval', 'awaiting_manual'].includes(wd.status)) { await bot.answerCallbackQuery(query.id, { text: `⚠️ Current status: ${wd.status}` }); return; }
        await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "pending", approvedByAdmin: true, updatedAt: Date.now(), holdReason: null, unlockAt: null, lastError: null });
                await bot.editMessageText(query.message.text + `\n\n✅ <b>Approved</b> — paying now...`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
                await bot.answerCallbackQuery(query.id, { text: "✅ Approved — payment will be sent now" });
        setTimeout(() => processPendingWithdrawals(), 1000);
            } catch (e) { await bot.answerCallbackQuery(query.id, { text: `❌ Error: ${e.message}` }); }
    }

    if (data.startsWith('reject_wd:')) {
      const withdrawId = data.replace('reject_wd:', '').trim();
      try {
        const snap = await db.ref(`withdrawQueue/${withdrawId}`).once("value");
        const wd   = snap.val();
                if (!wd) { await bot.answerCallbackQuery(query.id, { text: "❌ Withdrawal not found!" }); return; }
                if (!['awaiting_approval', 'awaiting_manual'].includes(wd.status)) { await bot.answerCallbackQuery(query.id, { text: `⚠️ Current status: ${wd.status}` }); return; }
                await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "cancelled", updatedAt: Date.now(), holdReason: "Rejected by admin" });
        if (wd.userId && wd.wdId) await db.ref(`users/${wd.userId}/wdHistory/${wd.wdId}`).update({ status: "cancelled", updatedAt: Date.now() });
                await bot.editMessageText(query.message.text + `\n\n❌ <b>Rejected and cancelled</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
                await bot.answerCallbackQuery(query.id, { text: "❌ Withdrawal rejected and cancelled" });
            } catch (e) { await bot.answerCallbackQuery(query.id, { text: `❌ Error: ${e.message}` }); }
    }
  });

  bot.on('polling_error', () => {});
  console.log("✅ Bot running with all admin commands + Batch system + Deposit checker");
}

// ==========================
// 🔹 Recover stuck withdrawals
// ==========================
setInterval(async () => {
  if (systemPaused) return;
  if (!WITHDRAWAL_ENABLED) return;
  try {
    const snap = await db.ref("withdrawQueue").orderByChild("status").equalTo("processing").once("value");
    const items = snap.val();
    if (!items) return;
    const stuckThreshold = Date.now() - 5 * 60 * 1000;
    let recovered = 0;
    for (const [id, data] of Object.entries(items)) {
      if ((data.updatedAt || 0) < stuckThreshold) {
        await db.ref(`withdrawQueue/${id}`).update({ status: "pending", updatedAt: Date.now(), lastError: "Recovered from stuck processing state" });
        processingQueue.delete(id);
        console.log(`♻️ Recovered stuck withdrawal: ${id}`);
        recovered++;
      }
    }
    if (recovered > 0) { console.log(`♻️ Recovered ${recovered} stuck — triggering re-process`); setTimeout(() => processPendingWithdrawals(), 2000); }
  } catch (e) { console.log(`❌ stuckRecovery: ${e.message}`); }
}, 10 * 60 * 1000);

// ==========================
// 🔹 Flush Timer
// ==========================
setInterval(async () => {
  if (!systemPaused && !isProcessing && WITHDRAWAL_ENABLED) {
    const snap = await db.ref("withdrawQueue").orderByChild("status").equalTo("pending").once("value").catch(() => null);
    if (snap && snap.exists()) { console.log(`⏰ Flush timer — running batch process`); processPendingWithdrawals(); }
  }
}, BATCH_FLUSH_SECONDS * 1000);

// ==========================
// 🔹 Check deposits — runs every 5 minutes
// ==========================
setInterval(() => checkDeposits(), 5 * 60 * 1000);

// ==========================
// 🔹 Start
// ==========================
console.log("\n" + "=".repeat(50));
console.log("🐼 PMT GRAM BOT — WITHDRAWAL + DEPOSIT");
console.log("=".repeat(50));
console.log(`FIREBASE: ${process.env.FIREBASE_SERVICE_ACCOUNT ? '✅' : '❌'}`);
console.log(`TON_API_KEY: ${process.env.TON_API_KEY ? '✅' : '❌'}`);
console.log(`TON_MNEMONIC: ${process.env.TON_MNEMONIC ? '✅' : '❌'}`);
console.log(`TON_WALLET_ADDRESS: ${process.env.TON_WALLET_ADDRESS ? '✅' : '❌'}`);
console.log(`TELEGRAM_BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? '✅' : '❌'}`);
console.log(`📦 Batch size: ${BATCH_SIZE} | Flush: ${BATCH_FLUSH_SECONDS}s | Between batches: ${BATCH_BETWEEN_DELAY / 1000}s`);

startWelcomeBot();

getWallet().then(async () => {
  const b = await getWalletBalance();
  console.log(`💰 Wallet balance: ${b.toFixed(4)} TON`);
  if (WITHDRAWAL_ENABLED) await processPendingWithdrawals();
  else console.log("⛔ Withdrawal system disabled — skipping initial process");
  if (DEPOSIT_ENABLED) await checkDeposits();
}).catch(err => { console.error("❌ Wallet error:", err.message); });

setInterval(async () => {
  if (!systemPaused && WITHDRAWAL_ENABLED) await processPendingWithdrawals();
}, 60 * 1000);

db.ref("withdrawQueue").on("child_added", async (snap) => {
  if (systemPaused) return;
  if (!WITHDRAWAL_ENABLED) return;
  const data = snap.val();
  if (data?.status === "pending" && !processingQueue.has(snap.key)) {
    console.log(`📢 New withdrawal: ${snap.key}`);
    setTimeout(() => processPendingWithdrawals(), 2000);
  }
});

// ==========================
// 🔹 Bridge: withdrawals/{userId}/{id}  →  withdrawQueue/{id}
//    The Mini App writes withdrawal requests to the path "withdrawals/{userId}/{id}"
//    which is completely different from the one our processing engine reads from ("withdrawQueue").
//    This code "mirrors" any new pending request into withdrawQueue with the same id,
//    so it goes through the same verification and payment engine, and then reflects the status update
//    (paid / cancelled / failed / ...) back to the original path so the Mini App displays it correctly.
// ==========================
function mapLegacyWithdrawal(userId, id, data) {
  const amount = Number(data.netAmount ?? data.amount ?? data.requestedAmount ?? 0);
  return {
    address: String(data.walletAddress || data.address || '').trim(),
    ton: amount,
    userId,
    wdId: id,
    ts: data.ts || data.timestamp || Date.now(),
    status: "pending",
    srcPath: `withdrawals/${userId}/${id}`,
  };
}

function watchLegacyWithdrawals() {
  db.ref("withdrawals").on("child_added", (userSnap) => {
    const userId = userSnap.key;

    userSnap.ref.on("child_added", async (wSnap) => {
      const id   = wSnap.key;
      const data = wSnap.val();
      if (!data || data.status !== "pending" || data.mirrored) return;

      try {
        const qRef = db.ref(`withdrawQueue/${id}`);
        const existing = (await qRef.once("value")).val();
        if (existing) { await wSnap.ref.update({ mirrored: true }).catch(() => {}); return; }

        const mapped = mapLegacyWithdrawal(userId, id, data);
        if (!mapped.address || !mapped.ton) {
          console.log(`⚠️ Legacy withdrawal ${id} skipped — missing address/amount`);
          return;
        }

        await qRef.set(mapped);
        await wSnap.ref.update({ mirrored: true }).catch(() => {});
        console.log(`🔗 Mirrored legacy withdrawal ${id} (user ${userId}) → withdrawQueue`);
        setTimeout(() => processPendingWithdrawals(), 1500);
      } catch (e) {
        console.log(`❌ mirror error [${id}]: ${e.message}`);
      }
    });
  });
}

// Sync the payment status back from withdrawQueue to the original path withdrawals/{userId}/{id}
db.ref("withdrawQueue").on("child_changed", async (snap) => {
  const data = snap.val();
  if (!data?.srcPath || !data?.status) return;
  try {
    await db.ref(data.srcPath).update({
      status: data.status,
      txHash: data.txHash || null,
      lastError: data.lastError || data.error || null,
      updatedAt: Date.now(),
    });
  } catch (e) {
    console.log(`❌ sync-back error [${snap.key}]: ${e.message}`);
  }
});

watchLegacyWithdrawals();

db.ref(".info/connected").on("value", (snap) => { if (snap.val()) console.log("📡 Firebase connected"); });

console.log(`💸 Running | 📬 ${WITHDRAWAL_CHANNEL_ID} | 👤 Admin:`, ADMIN_CHAT_ID);
console.log("=".repeat(50) + "\n");
