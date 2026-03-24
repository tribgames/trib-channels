/**
 * claude2bot UserPromptSubmit hook
 * 1. Injects response rules from settings.local.md
 * 2. Resets status state for new turn
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

function extractResponseRules(content) {
  const patterns = [
    /^## Response Rules\n([\s\S]*?)(?=\n## |\n# |$)/m,
    /^## Rules\n([\s\S]*?)(?=\n## |\n# |$)/m,
  ];
  for (const re of patterns) {
    const match = content.match(re);
    if (match && match[1].trim()) return match[1].trim();
  }
  return null;
}

let hookOutput = null;
try {
  const content = fs.readFileSync(LOCAL_FILE, 'utf8');
  const rules = extractResponseRules(content);
  if (rules) {
    hookOutput = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '## claude2bot Response Rules\n' + rules } };
  }
} catch {}

// Reset state + save user message ID for reactions
try {
  const configPath = path.join(DATA_DIR, 'config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const token = config.discord && config.discord.token;
    const mainLabel = config.channelsConfig && config.channelsConfig.main;
    const channels = config.channelsConfig && config.channelsConfig.channels;
    const channelId = mainLabel && channels && channels[mainLabel] && channels[mainLabel].id;
    if (token && channelId) {
      discordApi('GET', '/api/v10/channels/' + channelId + '/messages?limit=1', token)
        .then(msgs => {
          if (Array.isArray(msgs) && msgs.length > 0) {
            const mid = msgs[0].id;
            fs.writeFileSync(STATE_FILE, JSON.stringify({ channelId: channelId, userMessageId: mid, emoji: '\u{1F914}' }));
            // Add 🤔 reaction
            const req = https.request({
              hostname: 'discord.com',
              path: '/api/v10/channels/' + channelId + '/messages/' + mid + '/reactions/' + encodeURIComponent('\u{1F914}') + '/@me',
              method: 'PUT',
              headers: { 'Authorization': 'Bot ' + token, 'Content-Length': 0 },
            }, res => { res.resume(); res.on('end', () => {
              if (hookOutput) process.stdout.write(JSON.stringify(hookOutput));
              process.exit(0);
            }); });
            req.on('error', () => {
              if (hookOutput) process.stdout.write(JSON.stringify(hookOutput));
              process.exit(0);
            });
            req.end();
            return;
          }
          if (hookOutput) process.stdout.write(JSON.stringify(hookOutput));
          process.exit(0);
        }).catch(() => {
          if (hookOutput) process.stdout.write(JSON.stringify(hookOutput));
          process.exit(0);
        });
      return;
    }
  }
} catch {}
if (hookOutput) process.stdout.write(JSON.stringify(hookOutput));
