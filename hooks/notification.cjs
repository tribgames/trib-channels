/**
 * claude2bot Notification hook — DUMP + Forward
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
if (!DATA_DIR) process.exit(0);

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  // Dump to file for analysis
  fs.appendFileSync('/tmp/claude2bot-notification-dump.json', input + '\n---\n');

  try {
    const data = JSON.parse(input);

    // Skip channel messages
    const content = JSON.stringify(data);
    if (content.includes('<channel source=')) process.exit(0);
    if (content.includes('idle_notification')) process.exit(0); // skip idle (noisy)

    // Forward teammate messages
    const configPath = path.join(DATA_DIR, 'config.json');
    if (!fs.existsSync(configPath)) process.exit(0);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const token = config.discord && config.discord.token;
    if (!token) process.exit(0);
    const mainLabel = config.channelsConfig && config.channelsConfig.main;
    const channels = config.channelsConfig && config.channelsConfig.channels;
    const channelId = mainLabel && channels && channels[mainLabel] && channels[mainLabel].id;
    if (!channelId) process.exit(0);

    // Build summary from whatever fields exist
    let summary = '';
    if (data.summary) summary = data.summary;
    else if (data.message) summary = typeof data.message === 'string' ? data.message : JSON.stringify(data.message).substring(0, 150);
    else if (data.content) summary = data.content.substring(0, 150);
    else summary = JSON.stringify(data).substring(0, 150);

    if (!summary || summary.length < 5) process.exit(0);

    const body = JSON.stringify({ content: '\u{1F4E8} ' + summary });
    const req = https.request({
      hostname: 'discord.com',
      path: '/api/v10/channels/' + channelId + '/messages',
      method: 'POST',
      headers: { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); res.on('end', () => process.exit(0)); });
    req.on('error', () => process.exit(0));
    req.write(body);
    req.end();
  } catch { process.exit(0); }
});
