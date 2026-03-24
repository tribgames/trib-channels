/**
 * claude2bot Stop hook
 * 1. Update reaction: work emoji → ✅
 * 2. Append ✅ to log message
 * 3. Forward assistant text if reply wasn't used
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
if (!DATA_DIR) process.exit(0);

const STATE_FILE = path.join(require('os').tmpdir(), 'claude2bot-status.json');

function discordApi(method, apiPath, token, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: 'discord.com', path: apiPath, method: method, headers: headers },
      res => { let out = ''; res.on('data', d => { out += d; }); res.on('end', () => resolve()); });
    req.on('error', resolve);
    if (data) req.write(data);
    req.end();
  });
}

function discordReact(method, channelId, messageId, emoji, token) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'discord.com',
      path: '/api/v10/channels/' + channelId + '/messages/' + messageId + '/reactions/' + encodeURIComponent(emoji) + '/@me',
      method: method,
      headers: { 'Authorization': 'Bot ' + token, 'Content-Length': 0 },
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.end();
  });
}

function discordSend(channelId, text, token) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ content: text });
    const req = https.request({
      hostname: 'discord.com', path: '/api/v10/channels/' + channelId + '/messages', method: 'POST',
      headers: { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', async () => {
  try {
    const data = JSON.parse(input);
    if (data.agent_id) process.exit(0);
    if (data.stop_hook_active) process.exit(0);

    const configPath = path.join(DATA_DIR, 'config.json');
    if (!fs.existsSync(configPath)) process.exit(0);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const token = config.discord && config.discord.token;
    if (!token) process.exit(0);
    const mainLabel = config.channelsConfig && config.channelsConfig.main;
    const channels = config.channelsConfig && config.channelsConfig.channels;
    const channelId = mainLabel && channels && channels[mainLabel] && channels[mainLabel].id;
    if (!channelId) process.exit(0);

    let state = {};
    try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}

    // 1. Remove reaction (clean up)
    if (state.userMessageId && state.channelId === channelId && state.emoji) {
      await discordReact('DELETE', channelId, state.userMessageId, state.emoji, token);
    }

    // Clean state
    // Keep state file for subsequent turns (teammate messages etc)

    // 3. Forward assistant text (always — no reply check needed)
    const msg = (data.last_assistant_message || '').trim();
    if (!msg || msg.includes('No response requested')) process.exit(0);

    const pad = '\u3164\n';
    const padded = pad + msg;
    const text = padded.length > 1900 ? padded.substring(0, 1900) + '...' : padded;
    await discordSend(channelId, text, token);
    process.exit(0);
  } catch { process.exit(0); }
});
