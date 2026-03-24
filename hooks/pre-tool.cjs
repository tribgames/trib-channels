if (process.env.CLAUDE2BOT_NO_CONNECT) process.exit(0);
/**
 * claude2bot PreToolUse hook
 * Extracts new assistant text from transcript since last check.
 * Saves to state.pendingText for PostToolUse to combine with tool log.
 */
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(require('os').tmpdir(), 'claude2bot-status.json');

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    if (data.agent_id) process.exit(0);

    const tool = data.tool_name || '';
    if (tool === 'ToolSearch') process.exit(0);
    if (tool.includes('plugin_claude2bot_claude2bot__')) process.exit(0);
    // For Read/Grep/Glob: update transcriptIdx (discard accumulated text) but don't save pendingText

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

    // Always save pendingText — all intermediate text should be visible
    if (newText.trim()) {
      state.pendingText = (state.pendingText || '') + (state.pendingText ? '\n\n' : '') + newText.trim();
    }

    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {}
  process.exit(0);
});
