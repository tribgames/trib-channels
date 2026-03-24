if (process.env.CLAUDE2BOT_NO_CONNECT) process.exit(0);
const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
if (!DATA_DIR) process.exit(0);
const STATE_FILE = path.join(require('os').tmpdir(), 'claude2bot-status.json');

function convertMarkdownTables(text) {
  const lines = text.split('\n');
  const result = [];
  let i = 0;
  while (i < lines.length) {
    if (i > 0 && /^\|[\s-:]+(\|[\s-:]+)+\|?\s*$/.test(lines[i])) {
      const headerIdx = i - 1;
      const headerLine = lines[headerIdx];
      if (!/\|/.test(headerLine)) { result.push(lines[i]); i++; continue; }

      const tableLines = [headerLine];
      let j = i + 1;
      while (j < lines.length && /^\|/.test(lines[j]) && !/^\|[\s-:]+(\|[\s-:]+)+\|?\s*$/.test(lines[j])) {
        tableLines.push(lines[j]);
        j++;
      }

      const parseCells = (line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const allRows = tableLines.map(parseCells);
      const colCount = allRows[0].length;

      const widths = [];
      for (let c = 0; c < colCount; c++) {
        let max = 2;
        for (const row of allRows) {
          const cellLen = row[c] ? [...row[c]].length : 0;
          if (cellLen > max) max = cellLen;
        }
        widths.push(max);
      }

      const padCell = (str, w) => {
        const visLen = [...(str || '')].length;
        return (str || '') + ' '.repeat(Math.max(0, w - visLen));
      };

      const outLines = [];
      outLines.push(allRows[0].map((c, ci) => padCell(c, widths[ci])).join('  '));
      outLines.push(widths.map(w => '─'.repeat(w)).join('  '));
      for (let r = 1; r < allRows.length; r++) {
        outLines.push(allRows[r].map((c, ci) => padCell(c, widths[ci])).join('  '));
      }

      result[headerIdx] = '```\n' + outLines.join('\n') + '\n```';
      i = j;
      continue;
    }
    result.push(lines[i]);
    i++;
  }
  return result.join('\n');
}

function chunk(text, limit) {
  if (text.length <= limit) return [text];
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit);
    const line = rest.lastIndexOf('\n', limit);
    const space = rest.lastIndexOf(' ', limit);
    let cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;
    let part = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n+/, '');
    const backtickCount = (part.match(/```/g) || []).length;
    if (backtickCount % 2 === 1) {
      part += '\n```';
      rest = '```\n' + rest;
    }
    out.push(part);
  }
  if (rest) out.push(rest);
  return out;
}

function discordSend(channelId, text, token) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ content: text });
    const req = https.request({
      hostname: 'discord.com', path: '/api/v10/channels/' + channelId + '/messages', method: 'POST',
      headers: { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', async () => {
  try {
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
          const pad = state.sentCount > 0 ? '\u3164\n' : '';
          const chunks = chunk(pad + convertMarkdownTables(newText.trim()), 2000);
          for (const c of chunks) {
            await discordSend(state.channelId, c, token);
          }
          state.sentCount = (state.sentCount || 0) + chunks.length;
        }
      }
    }
    state.pendingText = '';
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {}
  process.exit(0);
});
