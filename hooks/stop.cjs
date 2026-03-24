/**
 * claude2bot Stop hook
 *
 * Forwards Claude's text output to Discord when the assistant stops.
 * Ensures channel users always see what Claude said, even if reply tool wasn't used.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
if (!DATA_DIR) process.exit(0);

// Read stdin (hook input)
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);

    // Skip if no message or if inside a subagent
    if (!data.last_assistant_message) process.exit(0);
    if (data.agent_id) process.exit(0);

    // Skip if stop hook is already active (prevent loops)
    if (data.stop_hook_active) process.exit(0);

    const msg = data.last_assistant_message.trim();
    if (!msg) process.exit(0);

    // Skip if message is very short (likely not useful)
    if (msg.length < 10) process.exit(0);

    // Check transcript for reply tool usage in last turn — skip if already sent via reply
    try {
      const transcript = fs.readFileSync(data.transcript_path, 'utf8');
      const lines = transcript.trim().split('\n');
      // Check last few lines for reply tool call
      const recent = lines.slice(-5).join('');
      if (recent.includes('"reply"') || recent.includes('plugin_claude2bot_claude2bot__reply')) {
        process.exit(0); // Already sent via reply tool
      }
    } catch { /* can't read transcript, proceed */ }

    // Read config to get bot token and main channel
    const configPath = path.join(DATA_DIR, 'config.json');
    if (!fs.existsSync(configPath)) process.exit(0);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const token = config.discord?.token || config.telegram?.token;
    if (!token) process.exit(0);

    // Get main channel ID
    const mainLabel = config.channelsConfig?.main;
    const channelId = mainLabel && config.channelsConfig?.channels[mainLabel]?.id;
    if (!channelId) process.exit(0);

    // Truncate to Discord limit
    const text = msg.length > 1900 ? msg.substring(0, 1900) + '...' : msg;

    // Send via Discord REST API (not MCP — hook can't use MCP)
    const body = JSON.stringify({ content: text });
    const req = https.request({
      hostname: 'discord.com',
      path: `/api/v10/channels/${channelId}/messages`,
      method: 'POST',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      // Drain response
      res.resume();
      res.on('end', () => process.exit(0));
    });
    req.on('error', () => process.exit(0));
    req.write(body);
    req.end();
  } catch {
    process.exit(0);
  }
});
