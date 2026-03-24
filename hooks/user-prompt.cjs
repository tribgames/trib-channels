if (process.env.CLAUDE2BOT_NO_CONNECT) process.exit(0);
/**
 * claude2bot UserPromptSubmit hook
 * 1. Injects response rules from settings.local.md
 * 2. Saves transcript offset + adds reaction to user message
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
if (!DATA_DIR) process.exit(0);

const STATE_FILE = path.join(require('os').tmpdir(), 'claude2bot-status.json');
const LOCAL_FILE = path.join(DATA_DIR, 'settings.local.md');

function discordApi(method, apiPath, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'discord.com', path: apiPath, method: method,
      headers: { 'Authorization': 'Bot ' + token },
    }, res => { let out = ''; res.on('data', d => { out += d; }); res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve({}); } }); });
    req.on('error', reject);
    req.end();
  });
}

function discordReact(channelId, messageId, emoji, token) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'discord.com',
      path: '/api/v10/channels/' + channelId + '/messages/' + messageId + '/reactions/' + encodeURIComponent(emoji) + '/@me',
      method: 'PUT',
      headers: { 'Authorization': 'Bot ' + token, 'Content-Length': 0 },
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.end();
  });
}

function extractResponseRules(content) {
  const match1 = content.match(/^## Response Rules\n([\s\S]*?)(?=\n## |\n# |$)/m);
  if (match1 && match1[1].trim()) return match1[1].trim();
  const match2 = content.match(/^## Rules\n([\s\S]*?)(?=\n## |\n# |$)/m);
  if (match2 && match2[1].trim()) return match2[1].trim();
  return null;
}

let stdinData = '';
process.stdin.on('data', d => { stdinData += d; });
process.stdin.on('end', async () => {
  let hookOutput = null;
  try {
    const content = fs.readFileSync(LOCAL_FILE, 'utf8');
    const rules = extractResponseRules(content);
    if (rules) {
      hookOutput = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '## claude2bot Response Rules\n' + rules } };
    }
  } catch {}

  let data = {};
  try { data = JSON.parse(stdinData); } catch {}

  let transcriptIdx = 0;
  try {
    if (data.transcript_path && fs.existsSync(data.transcript_path)) {
      transcriptIdx = fs.readFileSync(data.transcript_path, 'utf8').trim().split('\n').length;
    }
  } catch {}

  try {
    const configPath = path.join(DATA_DIR, 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const token = config.discord && config.discord.token;
      const mainLabel = config.channelsConfig && config.channelsConfig.main;
      const channels = config.channelsConfig && config.channelsConfig.channels;
      const channelId = mainLabel && channels && channels[mainLabel] && channels[mainLabel].id;

      if (token && channelId) {
        const msgs = await discordApi('GET', '/api/v10/channels/' + channelId + '/messages?limit=5', token);
        const userMsg = Array.isArray(msgs) && msgs.find(m => !m.author || !m.author.bot);
        if (userMsg) {
          const mid = userMsg.id;
          const oldState = {}; try { Object.assign(oldState, JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))); } catch {} fs.writeFileSync(STATE_FILE, JSON.stringify({ ...oldState,
            channelId: channelId,
            userMessageId: mid,
            emoji: '\u{1F914}',
            transcriptIdx: transcriptIdx,
            transcriptPath: data.transcript_path || '',
            sentCount: 0
          }));
          await discordReact(channelId, mid, '\u{1F914}', token);
        }
      }
    }
  } catch {}

  if (hookOutput) process.stdout.write(JSON.stringify(hookOutput));
  process.exit(0);
});
