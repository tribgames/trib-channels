if (process.env.CLAUDE2BOT_NO_CONNECT) process.exit(0);
/**
 * claude2bot PostToolUse hook
 * 1. Update reaction on user message
 * 2. Send pending text (from PreToolUse) + tool log as one message
 */
const fs = require('fs');
const path = require('path');

const { chunk, formatForDiscord, discordApi, discordReact } = require('./lib/format.cjs');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
if (!DATA_DIR) process.exit(0);

const STATE_FILE = path.join(require('os').tmpdir(), 'claude2bot-status.json');

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', async () => {
  try {
    const data = JSON.parse(input);
    if (data.agent_id) process.exit(0);

    const tool = data.tool_name || '';
    const toolInput = data.tool_input || {};
    if (tool === 'ToolSearch') process.exit(0);
    // Skip claude2bot channel tools (reply, fetch, react, edit, download) but show schedule tools
    if (tool.includes('plugin_claude2bot_claude2bot__') && !tool.includes('schedule') && !tool.includes('trigger')) process.exit(0);
    if (tool === 'SendMessage') process.exit(0);
    // Read/Grep/Glob: show as one-liner (no code block)
    const isSearchTool = (tool === 'Read' || tool === 'Grep' || tool === 'Glob');

    const desc = (toolInput.description || '').substring(0, 50);
    let summary = '';
    let detail = '';

    if (tool === 'Bash' || tool.includes('Bash')) {
      const cmd = (toolInput.command || '');
      summary = desc || 'Bash';
      detail = isSearchTool ? '' : cmd.substring(0, 500);
    } else if (tool === 'Read') {
      const fname = (toolInput.file_path || '').split('/').pop() || '';
      const ext = fname.split('.').pop().toLowerCase();
      if (['png','jpg','jpeg','gif','webp','svg'].includes(ext)) summary = fname;
      else if (['ogg','mp3','wav','m4a'].includes(ext)) summary = fname;
      else summary = fname;
    } else if (tool === 'Grep') {
      summary = '"' + (toolInput.pattern || '').substring(0, 25) + '"';
    } else if (tool === 'Glob') {
      summary = (toolInput.pattern || '').substring(0, 25);
    } else if (tool === 'Write') {
      summary = (toolInput.file_path || '').split('/').pop() || 'Write';
      detail = toolInput.file_path || '';
    } else if (tool === 'Edit') {
      summary = (toolInput.file_path || '').split('/').pop() || 'Edit';
      detail = toolInput.file_path || '';
    } else if (tool === 'Agent') {
      summary = toolInput.name || toolInput.subagent_type || 'agent';
      detail = (toolInput.prompt || '').substring(0, 200);
    } else if (tool === 'TaskCreate') {
      summary = (toolInput.subject || '').substring(0, 50);
    } else if (tool === 'TeamCreate') {
      summary = toolInput.team_name || '';
      detail = toolInput.description || '';
    } else {
      summary = tool.replace(/mcp__\w+__/, '');
    }
    if (!summary) process.exit(0);

    const displayName = tool.replace(/^mcp__plugin_claude2bot_claude2bot__/, '');
    let toolLine = '-# ' + displayName + ' (' + summary + ')';
    if (!isSearchTool && detail && detail !== summary) toolLine += '\n```\n' + detail.substring(0, 300) + '\n```';

    const emoji = '\u{1F6E0}\uFE0F';

    let state = {};
    try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { process.exit(0); }
    if (!state.channelId) process.exit(0);

    const configPath = path.join(DATA_DIR, 'config.json');
    if (!fs.existsSync(configPath)) process.exit(0);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const token = config.discord && config.discord.token;
    if (!token) process.exit(0);

    const ch = state.channelId;

    if (state.userMessageId) {
      if (state.emoji && state.emoji !== emoji) {
        await discordReact('DELETE', ch, state.userMessageId, state.emoji, token);
      }
      await discordReact('PUT', ch, state.userMessageId, emoji, token);
      state.emoji = emoji;
    }

    const pad = state.sentCount > 0 ? '\u3164\n' : '';
    let msg = '';
    if (state.pendingText) {
      msg = pad + formatForDiscord(state.pendingText.trim()) + '\n\n' + toolLine;
      state.pendingText = '';
    } else {
      msg = pad + toolLine;
    }
    state.sentCount = (state.sentCount || 0) + 1;

    const chunks = chunk(msg, 2000);
    for (const c of chunks) {
      await discordApi('POST', '/api/v10/channels/' + ch + '/messages', token, { content: c });
    }

    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    process.exit(0);
  } catch { process.exit(0); }
});
