const express = require('express');
const crypto = require('crypto');
const app = express();

// In-memory store — persists as long as server is running.
// For permanent persistence, swap this object for a free
// PlanetScale or Supabase database call.
const milestones = {};

// Milestone name normalizer — makes fuzzy matching work
// so "WTC batch production" and "wtc batch production" both match.
function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
}

// Slack request verification — ensures commands are genuinely from Slack.
function verifySlackRequest(req, rawBody) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return true; // skip in local dev without secret
  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSig  = req.headers['x-slack-signature'];
  if (!timestamp || !slackSig) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false; // replay attack guard
  const base = `v0:${timestamp}:${rawBody}`;
  const computed = 'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(slackSig));
}

// Capture raw body for signature verification before JSON/urlencoded parsing.
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => { req.rawBody = data; next(); });
});

app.use(express.urlencoded({ extended: true }));

// CORS — allow the HTML tracker (served from any origin) to poll status.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ── GET /status ─────────────────────────────────────────────────────────────
// The HTML tracker polls this every 30 seconds.
// Returns { milestones: { "normalized name": { status, updatedBy, updatedAt } } }
app.get('/status', (req, res) => {
  res.json({ milestones, updatedAt: new Date().toISOString() });
});

// ── POST /slack ──────────────────────────────────────────────────────────────
// Receives slash commands from Slack.
// Command format: /newkroo [action] ["milestone name"]
//   Actions: complete | inprogress | blocked | reset | status
app.post('/slack', (req, res) => {
  if (!verifySlackRequest(req, req.rawBody)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const text = (req.body.text || '').trim();
  const user = req.body.user_name || 'someone';

  // /newkroo status — list all tracked milestones
  if (!text || text === 'status') {
    const entries = Object.entries(milestones);
    if (entries.length === 0) {
      return res.json({ response_type: 'ephemeral', text: 'No milestones tracked yet. Use `/newkroo complete "milestone name"` to get started.' });
    }
    const lines = entries.map(([name, data]) => {
      const icon = { complete: '✅', inprogress: '🔄', blocked: '🚫', reset: '⬜' }[data.status] || '⬜';
      return `${icon} *${name}* — ${data.status} (${data.updatedBy}, ${new Date(data.updatedAt).toLocaleDateString('en-GB', { day:'numeric', month:'short' })})`;
    });
    return res.json({ response_type: 'in_channel', text: `*NewKroo milestone tracker*\n\n${lines.join('\n')}` });
  }

  // Parse action and milestone name
  // Expects: complete "milestone name" OR inprogress "milestone name"
  const match = text.match(/^(complete|inprogress|blocked|reset)\s+"(.+)"$/i);
  if (!match) {
    return res.json({
      response_type: 'ephemeral',
      text: [
        'Unrecognized format. Usage:',
        '`/newkroo complete "WTC batch production"`',
        '`/newkroo inprogress "PCN target list"`',
        '`/newkroo blocked "OD/HR owner assigned"`',
        '`/newkroo reset "PCN target list"`',
        '`/newkroo status`'
      ].join('\n')
    });
  }

  const action = match[1].toLowerCase();
  const milestoneName = match[2].trim();
  const key = normalize(milestoneName);

  milestones[key] = {
    displayName: milestoneName,
    status: action,
    updatedBy: user,
    updatedAt: new Date().toISOString()
  };

  const icons = { complete: '✅', inprogress: '🔄', blocked: '🚫', reset: '⬜' };
  const icon = icons[action] || '⬜';
  const statusLabels = { complete: 'marked complete', inprogress: 'marked in progress', blocked: 'flagged as blocked', reset: 'reset to not started' };

  return res.json({
    response_type: 'in_channel',
    text: `${icon} *${milestoneName}* ${statusLabels[action]} by @${user}`
  });
});

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'NewKroo Tracker Backend' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NewKroo tracker backend running on port ${PORT}`));
