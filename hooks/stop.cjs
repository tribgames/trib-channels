if (process.env.CLAUDE2BOT_NO_CONNECT) process.exit(0);
/**
 * claude2bot Stop hook
 * 1. Remove reaction
 * 2. Forward assistant text to Discord
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
if (!DATA_DIR) process.exit(0);

const STATE_FILE = path.join(require('os').tmpdir(), 'claude2bot-status.json');

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


function chunk(text, limit) {
  if (text.length <= limit) return [text];
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit);
    const line = rest.lastIndexOf('\n', limit);
    const space = rest.lastIndexOf(' ', limit);
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) out.push(rest);
  return out;
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

    // 1. Remove reaction
    if (state.userMessageId && state.channelId === channelId && state.emoji) {
      await discordReact('DELETE', channelId, state.userMessageId, state.emoji, token);
    }

    // 2. Forward assistant text
    const msg = (data.last_assistant_message || '').trim();
    if (!msg || msg.includes('No response requested')) process.exit(0);

    const pad = (state && state.sentCount > 0) ? '\u3164\n' : '';
    const padded = pad + msg;
    const chunks = chunk(padded, 2000);
    for (const c of chunks) {
      await discordSend(channelId, c, token);
    }
    process.exit(0);
  } catch { process.exit(0); }
});
