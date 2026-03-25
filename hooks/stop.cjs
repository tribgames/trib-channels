if (process.env.CLAUDE2BOT_NO_CONNECT) process.exit(0);
/**
 * claude2bot Stop hook
 * 1. Remove reaction
 * 2. Forward assistant text to Discord
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { chunk, formatForDiscord, discordSend, discordReact } = require('./lib/format.cjs');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
if (!DATA_DIR) process.exit(0);

const STATE_FILE = path.join(require('os').tmpdir(), 'claude2bot-status.json');

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

    // 2. Forward assistant text — only unsent portion via transcript
    const tp = state.transcriptPath || '';
    if (tp && fs.existsSync(tp)) {
      const transcript = fs.readFileSync(tp, 'utf8');
      const tLines = transcript.trim().split('\n');
      const lastIdx = state.transcriptIdx != null ? state.transcriptIdx : 0;
      const newLines = tLines.slice(lastIdx);

      let newText = '';
      for (const l of newLines) {
        try {
          const entry = JSON.parse(l);
          if (entry.type === 'assistant' && entry.message && entry.message.content) {
            const texts = entry.message.content
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join('\n');
            if (texts.trim()) newText += texts.trim() + '\n';
          }
        } catch {}
      }

      if (newText.trim()) {
        const formatted = formatForDiscord(newText.trim());
        const hash = crypto.createHash('md5').update(formatted).digest('hex');
        if (state.lastSentHash === hash) process.exit(0);
        state.lastSentHash = hash;
        state.lastSentTime = Date.now();
        state.sessionIdle = true;
        fs.writeFileSync(STATE_FILE, JSON.stringify(state));
        const pad = (state && state.sentCount > 0) ? '\u3164\n' : '';
        const padded = pad + formatted;
        const chunks = chunk(padded, 2000);
        for (const c of chunks) {
          await discordSend(channelId, c, token);
        }
      }
    } else {
      // fallback: transcriptPath 없으면 last_assistant_message 사용
      // pre-tool/post-tool이 이미 전송했을 수 있으므로 sentCount > 0이면 skip
      const msg = (data.last_assistant_message || '').trim();
      if (msg && !msg.includes('No response requested') && (state.sentCount || 0) === 0) {
        const formatted = formatForDiscord(msg);
        const hash = crypto.createHash('md5').update(formatted).digest('hex');
        if (state.lastSentHash === hash) process.exit(0);
        state.lastSentHash = hash;
        state.lastSentTime = Date.now();
        state.sessionIdle = true;
        fs.writeFileSync(STATE_FILE, JSON.stringify(state));
        const padded = formatted;
        const chunks = chunk(padded, 2000);
        for (const c of chunks) {
          await discordSend(channelId, c, token);
        }
      } else {
        state.sessionIdle = true;
        fs.writeFileSync(STATE_FILE, JSON.stringify(state));
      }
    }
    process.exit(0);
  } catch { process.exit(0); }
});
