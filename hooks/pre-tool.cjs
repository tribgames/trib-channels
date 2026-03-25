if (process.env.CLAUDE2BOT_NO_CONNECT) process.exit(0);
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { chunk, formatForDiscord, discordSend } = require('./lib/format.cjs');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
if (!DATA_DIR) process.exit(0);
const STATE_FILE = path.join(require('os').tmpdir(), 'claude2bot-status.json');

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', async () => {
  try {
    const STOP_FLAG = path.join(os.tmpdir(), 'claude2bot-stop.flag');
    try {
      if (fs.existsSync(STOP_FLAG)) {
        const ts = parseInt(fs.readFileSync(STOP_FLAG, 'utf8').trim(), 10);
        if (Date.now() - ts < 30000) {
          fs.unlinkSync(STOP_FLAG);
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              decision: { behavior: 'deny', message: '사용자가 작업을 중단했습니다.', interrupt: true }
            }
          }));
          process.exit(0);
        } else {
          fs.unlinkSync(STOP_FLAG);
        }
      }
    } catch {}

    const data = JSON.parse(input);
    if (data.agent_id) process.exit(0);
    const tool = data.tool_name || '';
    if (tool === 'ToolSearch') process.exit(0);
    if (tool.includes('plugin_claude2bot_claude2bot__')) process.exit(0);

    let state = {};
    try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { process.exit(0); }

    const tp = data.transcript_path || state.transcriptPath || '';
    if (!tp || !fs.existsSync(tp)) process.exit(0);

    const transcript = fs.readFileSync(tp, 'utf8');
    const lines = transcript.trim().split('\n');
    const lastIdx = state.transcriptIdx != null ? state.transcriptIdx : Math.max(0, lines.length - 2);
    const newLines = lines.slice(lastIdx);
    state.transcriptIdx = lines.length;

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

    if (newText.trim() && state.channelId) {
      const configPath = path.join(DATA_DIR, 'config.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const token = config.discord && config.discord.token;
        if (token) {
          const formatted = formatForDiscord(newText.trim());
          const hash = crypto.createHash('md5').update(formatted).digest('hex');
          if (state.lastSentHash === hash) {
            fs.writeFileSync(STATE_FILE, JSON.stringify(state));
            process.exit(0);
          }
          state.lastSentHash = hash;
          const pad = state.sentCount > 0 ? '\u3164\n' : '';
          const padded = pad + formatted;
          const chunks = chunk(padded, 2000);
          state.sentCount = (state.sentCount || 0) + chunks.length;
          state.lastSentTime = Date.now();
          state.pendingText = '';
          state.sessionIdle = false;
          fs.writeFileSync(STATE_FILE, JSON.stringify(state));
          for (const c of chunks) {
            await discordSend(state.channelId, c, token);
          }
        }
      }
    } else {
      state.pendingText = '';
      state.sessionIdle = false;
      fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    }
  } catch {}
  process.exit(0);
});
