/**
 * claude2bot Notification hook
 * Forwards teammate notifications (idle, DM summaries) to Discord.
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

    // Only forward teammate notifications, skip channel messages (already handled)
    const content = data.notification_content || '';
    if (!content) process.exit(0);

    // Skip if it's a channel message notification (already on Discord)
    if (content.includes('<channel source=')) process.exit(0);

    let summary = '';
    try {
      const parsed = JSON.parse(content);
      if (parsed.type === 'idle_notification') {
        summary = `⏸️ ${parsed.from || 'agent'}: idle (${parsed.idleReason || ''})`;
      } else if (parsed.type === 'task_completed') {
        summary = `✅ Task completed: ${parsed.subject || ''}`;
      } else {
        summary = `📢 ${JSON.stringify(parsed).substring(0, 150)}`;
      }
    } catch {
      summary = `📢 ${content.substring(0, 150)}`;
    }

    if (!summary) process.exit(0);

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
