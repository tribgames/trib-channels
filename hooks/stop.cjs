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

    // 1. Update reaction → ✅
    if (state.userMessageId && state.channelId === channelId) {
      if (state.emoji) await discordReact('DELETE', channelId, state.userMessageId, state.emoji, token);
      await discordReact('PUT', channelId, state.userMessageId, '\u2705', token);
    }

    // 2. Append ✅ to log message
    if (state.logMessageId && state.log) {
      const finalLog = state.log + '\n\u2705 완료';
      const truncLog = finalLog.length > 1900 ? finalLog.substring(finalLog.length - 1900) : finalLog;
      await discordApi('PATCH', '/api/v10/channels/' + channelId + '/messages/' + state.logMessageId, token, { content: truncLog });
    }

    // Clean state
    try { fs.unlinkSync(STATE_FILE); } catch {}

    // 3. Forward assistant text if reply wasn't used
    const msg = (data.last_assistant_message || '').trim();
    if (!msg || msg.length < 10) process.exit(0);

    try {
      const transcript = fs.readFileSync(data.transcript_path, 'utf8');
      const lines = transcript.trim().split('\n');
      const recent = lines.slice(-3).join('');
      if (recent.includes('"tool_use"') && recent.includes('plugin_claude2bot_claude2bot__reply')) {
        process.exit(0);
      }
    } catch {}

    const text = msg.length > 1900 ? msg.substring(0, 1900) + '...' : msg;
    await discordSend(channelId, text, token);
    process.exit(0);
  } catch { process.exit(0); }
});
