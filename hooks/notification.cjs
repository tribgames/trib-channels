/**
 * claude2bot TeammateIdle/Notification hook
 * Forwards teammate DM summaries to Discord. Skips raw idle notifications.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
if (!DATA_DIR) process.exit(0);

const STATE_FILE = path.join(require('os').tmpdir(), 'claude2bot-status.json');

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);

    // Only forward if there's a peer DM summary (teammate sent a message)
    // TeammateIdle has: from, idleReason, peerDmSummary (optional)
    const summary = data.summary || data.peerDmSummary || '';
    const from = data.from || data.teammate_name || '';

    // Skip if no useful summary
    if (!summary || summary.length < 3) process.exit(0);
    // Skip raw system data
    if (summary.includes('session_id') || summary.includes('transcript_path')) process.exit(0);

    // Read state for channelId
    let state = {};
    try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { process.exit(0); }
    if (!state.channelId) process.exit(0);

    const configPath = path.join(DATA_DIR, 'config.json');
    if (!fs.existsSync(configPath)) process.exit(0);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const token = config.discord && config.discord.token;
    if (!token) process.exit(0);

    const text = from ? (from + ': ' + summary) : summary;
    const body = JSON.stringify({ content: text.substring(0, 1900) });
    const req = https.request({
      hostname: 'discord.com',
      path: '/api/v10/channels/' + state.channelId + '/messages',
      method: 'POST',
      headers: { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); res.on('end', () => process.exit(0)); });
    req.on('error', () => process.exit(0));
    req.write(body);
    req.end();
  } catch { process.exit(0); }
});
