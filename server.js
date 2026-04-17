const express = require('express');
const crypto = require('crypto');
const app = express();
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(REDIS_URL + '/get/' + key, { headers: { Authorization: 'Bearer ' + REDIS_TOKEN } });
    const data = await res.json();
    if (!data.result) return null;
    return JSON.parse(data.result);
  } catch (e) { console.error('Redis GET error:', e.message); return null; }
}

async function redisSet(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    const encoded = encodeURIComponent(JSON.stringify(value));
    await fetch(REDIS_URL + '/set/' + key + '/' + encoded, { method: 'GET', headers: { Authorization: 'Bearer ' + REDIS_TOKEN } });
  } catch (e) { console.error('Redis SET error:', e.message); }
}

function normalize(str) { return str.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim(); }

function verifySlackRequest(req) {
  if (!SLACK_SIGNING_SECRET) return true;
  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSig = req.headers['x-slack-signature'];
  if (!timestamp || !slackSig) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const base = 'v0:' + timestamp + ':' + new URLSearchParams(req.body).toString();
  const computed = 'v0=' + crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(base).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(slackSig)); } catch { return false; }
}

async function postToTrackerUpdates(text) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    const response = await fetch(SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    console.log('Webhook response status:', response.status);
  } catch (err) { console.error('Webhook error:', err.message); }
}

app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); res.header('Access-Control-Allow-Headers', 'Content-Type'); next(); });
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'NewKroo Tracker Backend', webhookConfigured: !!SLACK_WEBHOOK_URL, redisConfigured: !!(REDIS_URL && REDIS_TOKEN) });
});

app.get('/status', async (req, res) => {
  const milestones = await redisGet('milestones') || {};
  const activityLog = await redisGet('activityLog') || [];
  res.json({ milestones, activityLog, updatedAt: new Date().toISOString() });
});

app.post('/slack', async (req, res) => {
  if (!verifySlackRequest(req)) return res.status(401).json({ error: 'Invalid signature' });
  const text = (req.body.text || '').trim();
  const user = req.body.user_name || 'someone';
  const milestones = await redisGet('milestones') || {};
  const activityLog = await redisGet('activityLog') || [];
  if (!text || text === 'status') {
    const entries = Object.entries(milestones);
    if (entries.length === 0) return res.json({ response_type: 'ephemeral', text: 'No milestones tracked yet.' });
    const lines = entries.map(([, data]) => '*' + data.displayName + '* -- ' + data.status + ' (@' + data.updatedBy + ')');
    return res.json({ response_type: 'in_channel', text: '*NewKroo milestone tracker*\n\n' + lines.join('\n') });
  }
  const match = text.match(/^(complete|inprogress|blocked|reset)\s+"(.+)"$/i);
  if (!match) return res.json({ response_type: 'ephemeral', text: 'Try: /newkroo complete "milestone name"' });
  const action = match[1].toLowerCase();
  const milestoneName = match[2].trim();
  const key = normalize(milestoneName);
  const now = new Date().toISOString();
  milestones[key] = { displayName: milestoneName, status: action, updatedBy: user, updatedAt: now };
  const labels = { complete: 'marked complete', inprogress: 'marked in progress', blocked: 'flagged as blocked', reset: 'reset to not started' };
  activityLog.unshift({ milestoneName, action, updatedBy: user, updatedAt: now });
  if (activityLog.length > 100) activityLog.pop();
  await redisSet('milestones', milestones);
  await redisSet('activityLog', activityLog);
  const notifText = '*' + milestoneName + '* ' + (labels[action] || action) + ' by @' + user;
  postToTrackerUpdates(notifText);
  return res.json({ response_type: 'in_channel', text: notifText });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('NewKroo tracker backend running on port ' + PORT));
