/**
 * claude2bot PostToolUse hook
 * Forwards all tool execution results to Discord in compact format.
 * Skips reply tool (already sent to Discord).
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
if (!DATA_DIR) process.exit(0);

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    if (data.agent_id) process.exit(0); // skip subagent tools

    const tool = data.tool_name || '';
    const toolInput = data.tool_input || {};
    const toolOutput = data.tool_output || '';

    // Skip reply (already on Discord) and ToolSearch (noise)
    if (tool.includes('reply') || tool === 'ToolSearch') process.exit(0);

    // Build compact summary
    let summary = '';
    if (tool === 'Bash' || tool.includes('Bash')) {
      const cmd = (toolInput.command || '').substring(0, 80);
      summary = `🔧 Bash: \`${cmd}\``;
    } else if (tool === 'Read') {
      summary = `📖 Read: ${toolInput.file_path || ''}`;
    } else if (tool === 'Write') {
      summary = `📝 Write: ${toolInput.file_path || ''}`;
    } else if (tool === 'Edit') {
      summary = `✏️ Edit: ${toolInput.file_path || ''}`;
    } else if (tool === 'Grep') {
      summary = `🔍 Grep: "${toolInput.pattern || ''}"`;
    } else if (tool === 'Glob') {
      summary = `📂 Glob: ${toolInput.pattern || ''}`;
    } else if (tool === 'Agent') {
      summary = `🤖 Agent: ${toolInput.name || toolInput.subagent_type || 'spawn'}`;
    } else if (tool === 'TaskCreate') {
      summary = `📋 Task: ${toolInput.subject || ''}`;
    } else if (tool === 'TaskUpdate') {
      summary = `📋 Task ${toolInput.taskId}: ${toolInput.status || ''}`;
    } else if (tool === 'SendMessage') {
      summary = `💬 → ${toolInput.to || ''}: ${(toolInput.summary || '').substring(0, 50)}`;
    } else if (tool === 'TeamCreate') {
      summary = `👥 Team: ${toolInput.team_name || ''}`;
    } else if (tool.includes('react')) {
      summary = `👍 React: ${toolInput.emoji || ''}`;
    } else if (tool.includes('fetch_messages')) {
      summary = `📨 Fetch messages`;
    } else if (tool.includes('trigger_schedule')) {
      summary = `⏰ Trigger: ${toolInput.name || ''}`;
    } else if (tool.includes('schedule_status')) {
      summary = `📊 Schedule status`;
    } else if (tool.includes('chrome') || tool.includes('navigate')) {
      summary = `🌐 Chrome: ${toolInput.url || toolInput.action || tool}`;
    } else if (tool.includes('WebFetch') || tool.includes('WebSearch')) {
      summary = `🌐 Web: ${toolInput.query || toolInput.url || ''}`.substring(0, 80);
    } else {
      summary = `🔧 ${tool}`;
    }

    if (!summary) process.exit(0);
    if (summary.length > 200) summary = summary.substring(0, 200) + '...';

    // Read config
    const configPath = path.join(DATA_DIR, 'config.json');
    if (!fs.existsSync(configPath)) process.exit(0);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const token = config.discord?.token;
    if (!token) process.exit(0);
    const mainLabel = config.channelsConfig?.main;
    const channelId = mainLabel && config.channelsConfig?.channels[mainLabel]?.id;
    if (!channelId) process.exit(0);

    const body = JSON.stringify({ content: summary });
    const req = https.request({
      hostname: 'discord.com',
      path: `/api/v10/channels/${channelId}/messages`,
      method: 'POST',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => { res.resume(); res.on('end', () => process.exit(0)); });
    req.on('error', () => process.exit(0));
    req.write(body);
    req.end();
  } catch { process.exit(0); }
});
