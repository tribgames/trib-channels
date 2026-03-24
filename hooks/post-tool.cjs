/**
 * claude2bot PostToolUse hook
 * 1. Update reaction on user message
 * 2. Append tool activity to a running log message (single message, edit to append)
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
if (!DATA_DIR) process.exit(0);

const STATE_FILE = path.join(require('os').tmpdir(), 'claude2bot-status.json');

function discordApi(method, apiPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: 'discord.com', path: apiPath, method: method, headers: headers },
      res => { let out = ''; res.on('data', d => { out += d; }); res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve({}); } }); });
    req.on('error', reject);
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

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', async () => {
  try {
    const data = JSON.parse(input);
    if (data.agent_id) process.exit(0);

    const tool = data.tool_name || '';
    const toolInput = data.tool_input || {};
    if (tool.includes('reply') || tool === 'ToolSearch') process.exit(0);

    // Build line for log (no emoji — emoji is on user's reaction only)
    let line = '';
    if (tool === 'Bash' || tool.includes('Bash')) {
      const cmd = (toolInput.command || '').split('\n')[0].substring(0, 50);
      line = cmd;
    } else if (tool === 'Read') {
      line = (toolInput.file_path || '').split('/').pop() || '';
    } else if (tool === 'Write') {
      line = (toolInput.file_path || '').split('/').pop() || '';
    } else if (tool === 'Edit') {
      line = (toolInput.file_path || '').split('/').pop() || '';
    } else if (tool === 'Grep') {
      line = '"' + (toolInput.pattern || '').substring(0, 25) + '"';
    } else if (tool === 'Glob') {
      line = (toolInput.pattern || '').substring(0, 25);
    } else if (tool === 'Agent') {
      line = (toolInput.name || toolInput.subagent_type || 'agent');
    } else if (tool === 'TaskCreate') {
      line = (toolInput.subject || '').substring(0, 35);
    } else if (tool === 'SendMessage') {
      line = '\u2192 ' + (toolInput.to || '');
    } else if (tool.includes('chrome') || tool.includes('navigate')) {
      line = (toolInput.url || toolInput.action || '').substring(0, 35);
    } else if (tool.includes('WebFetch') || tool.includes('WebSearch')) {
      line = (toolInput.query || toolInput.url || '').substring(0, 35);
    } else {
      line = '\u2699\uFE0F ' + tool.replace(/mcp__\w+__/, '');
    }
    if (!line) process.exit(0);

    // Pick emoji for reaction
    let emoji = '\u{1F527}'; // 🔧
    if (tool === 'Read') emoji = '\u{1F4D6}';
    else if (tool === 'Write' || tool === 'Edit') emoji = '\u270F\uFE0F';
    else if (tool === 'Grep' || tool === 'Glob') emoji = '\u{1F50D}';
    else if (tool === 'Agent') emoji = '\u{1F916}';
    else if (tool.includes('Web') || tool.includes('chrome')) emoji = '\u{1F310}';

    // Read state + config
    let state = {};
    try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { process.exit(0); }
    if (!state.channelId) process.exit(0);

    const configPath = path.join(DATA_DIR, 'config.json');
    if (!fs.existsSync(configPath)) process.exit(0);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const token = config.discord && config.discord.token;
    if (!token) process.exit(0);

    const ch = state.channelId;

    // 1. Update reaction on user message
    if (state.userMessageId) {
      if (state.emoji && state.emoji !== emoji) {
        await discordReact('DELETE', ch, state.userMessageId, state.emoji, token);
      }
      await discordReact('PUT', ch, state.userMessageId, emoji, token);
      state.emoji = emoji;
    }

    // 2. Append tool line to log message (tool activity only, no transcript text)
    const log = (state.log || '') + (state.log ? '\n' : '') + line;
    if (state.logMessageId) {
      // Edit existing log message
      const truncLog = log.length > 1900 ? log.substring(log.length - 1900) : log;
      await discordApi('PATCH', '/api/v10/channels/' + ch + '/messages/' + state.logMessageId, token, { content: truncLog });
    } else {
      // Create log message
      const res = await discordApi('POST', '/api/v10/channels/' + ch + '/messages', token, { content: log });
      if (res.id) state.logMessageId = res.id;
    }
    state.log = log;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    process.exit(0);
  } catch { process.exit(0); }
});
