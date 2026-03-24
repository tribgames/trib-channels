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
    // Skip ToolSearch and claude2bot own tools (reply, fetch, schedule etc) — show all others including MCP
    if (tool === 'ToolSearch') process.exit(0);
    if (tool.includes('plugin_claude2bot_claude2bot__')) process.exit(0);

    // Build summary (short) + detail (full, spoiler)
    const desc = (toolInput.description || '').substring(0, 50);
    let summary = '';
    let detail = '';

    if (tool === 'Bash' || tool.includes('Bash')) {
      summary = desc || 'Bash';
      detail = (toolInput.command || '').substring(0, 500);
    } else if (tool === 'Read') {
      summary = (toolInput.file_path || '').split('/').pop() || 'Read';
      detail = toolInput.file_path || '';
    } else if (tool === 'Write') {
      summary = (toolInput.file_path || '').split('/').pop() || 'Write';
      detail = toolInput.file_path || '';
    } else if (tool === 'Edit') {
      summary = (toolInput.file_path || '').split('/').pop() || 'Edit';
      detail = toolInput.file_path || '';
    } else if (tool === 'Grep') {
      summary = '"' + (toolInput.pattern || '') + '"';
      detail = 'path: ' + (toolInput.path || '.') + ', pattern: ' + (toolInput.pattern || '');
    } else if (tool === 'Glob') {
      summary = toolInput.pattern || 'Glob';
      detail = 'path: ' + (toolInput.path || '.');
    } else if (tool === 'Agent') {
      summary = toolInput.name || toolInput.subagent_type || 'agent';
      detail = (toolInput.prompt || '').substring(0, 200);
    } else if (tool === 'TaskCreate') {
      summary = (toolInput.subject || '').substring(0, 50);
      detail = toolInput.description || '';
    } else if (tool === 'SendMessage') {
      summary = '\u2192 ' + (toolInput.to || '');
      detail = (toolInput.summary || toolInput.message || '').substring(0, 200);
    } else {
      summary = tool;
      detail = JSON.stringify(toolInput).substring(0, 200);
    }
    if (!summary) process.exit(0);

    // Format: ⏳ Tool (summary) + code block for detail
    let line = '\u23F3 ' + tool + ' (' + summary + ')';
    if (detail && detail !== summary) line += '\n```\n' + detail.substring(0, 400) + '\n```';

    // Single work emoji for all tools
    const emoji = '\u{1F6E0}\uFE0F'; // 🛠️

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

    // 2. Send new message for each tool call
    const msgContent = line.length > 1900 ? line.substring(0, 1900) : line;
    await discordApi('POST', '/api/v10/channels/' + ch + '/messages', token, { content: msgContent });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    process.exit(0);
  } catch { process.exit(0); }
});
