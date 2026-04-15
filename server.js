const express = require('express');
const crypto = require('crypto');
const app = express();

const milestones = {};

function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use(express.urlencoded({ extended: true }));

function verifySlackRequest(req) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return true;
  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSig  = req.headers['x-slack-signature'];
  if (!timestamp || !slackSig) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const base = `v0:${timestamp}:${new URLSearchParams(req.body).toString()}`;
  const computed = 'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(slackSig));
  } catch {
    return false;
  }
}

app.get('/status', (req, res) => {
  res.json({ milestones, updatedAt: new Date().toISOString() });
});

app.post('/slack', (req, res) => {
  if (!verifySlackRequest(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const text = (req.body.text || '').trim();
  const user = req.body.user_name || 'someone';

  if (!text || text === 'status') {
    const entries = Object.entries(milestones);
    if (entries.length === 0) {
      return res.json({ response_type: 'ephemeral', text: 'No milestones tracked yet. Try `/newkroo complete "milestone name"`' });
    }
    const icons = { complete: '✅', inprogress: '🔄', blocked: '🚫', reset: '⬜' };
    const lines = entries.map(([, data]) => {
      const icon = icons[data.status] || '⬜';
      const date = new Date(data.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      return `${icon} *${data.displayName}* — ${data.status} (@${data.updatedBy}, ${date})`;
    });
    return res.json({ response_type: 'in_channel', text: `*NewKroo milestone tracker*\n\n${lines.join('\n')}` });
  }

  const match = text.match(/^(complete|inprogress|blocked|reset)\s+"(.+)"$/i);
  if (!match) {
    return res.json({
      response_type: 'ephemeral',
      text: [
        'Unrecognized format. Try:',
        '`/newkroo complete "WTC batch production"`',
        '`/newkroo inprogress "PCN target list"`',
        '`/newkroo blocked "OD/HR owner assigned"`',
        '`/newkroo reset "PCN target list"`',
        '`/newkroo status`'
      ].join('\n')
    });
  }

  const action        = match[1].toLowerCase();
  const milestoneName = match[2].trim();
  const key           = normalize(milestoneName);

  milestones[key] = {
    displayName: milestoneName,
    status:      action,
    updatedBy:   user,
    updatedAt:   new Date().toISOString()
  };

  const icons  = { complete: '✅', inprogress: '🔄', blocked: '🚫', reset: '⬜' };
  const labels = { complete: 'marked complete', inprogress: 'marked in progress', blocked: 'flagged as blocked', reset: 'reset to not started' };

  return res.json({
    response_type: 'in_channel',
    text: `${icons[action]} *${milestoneName}* ${labels[action]} by @${user}`
  });
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'NewKroo Tracker Backend' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NewKroo tracker backend running on port ${PORT}`));
