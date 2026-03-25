/**
 * Shared formatting & Discord API helpers for claude2bot hooks
 */
const https = require('https');

function getDisplayWidth(str) {
  let width = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (
      (code >= 0x1100 && code <= 0x115F) ||
      (code >= 0x2E80 && code <= 0x303E) ||
      (code >= 0x3040 && code <= 0x33BF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0xAC00 && code <= 0xD7AF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xFE30 && code <= 0xFE4F) ||
      (code >= 0xFF00 && code <= 0xFF60) ||
      (code >= 0xFFE0 && code <= 0xFFE6) ||
      (code >= 0x20000 && code <= 0x2FA1F) ||
      (code >= 0x1F300 && code <= 0x1F9FF)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function replaceEmojiInCodeBlock(text) {
  return text
    .replace(/✅/g, '[O]')
    .replace(/❌/g, '[X]')
    .replace(/⭕/g, '[O]')
    .replace(/🔴/g, '[X]');
}

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
          const cellLen = row[c] ? getDisplayWidth(row[c]) : 0;
          if (cellLen > max) max = cellLen;
        }
        widths.push(max);
      }

      const padCell = (str, w) => {
        const visLen = getDisplayWidth(str || '');
        return (str || '') + ' '.repeat(Math.max(0, w - visLen));
      };

      const outLines = [];
      outLines.push(allRows[0].map((c, ci) => padCell(c, widths[ci])).join('  '));
      outLines.push(widths.map(w => '-'.repeat(w)).join('  '));
      for (let r = 1; r < allRows.length; r++) {
        outLines.push(allRows[r].map((c, ci) => padCell(c, widths[ci])).join('  '));
      }

      const tableText = replaceEmojiInCodeBlock(outLines.join('\n'));
      result[headerIdx] = '```\n' + tableText + '\n```';
      i = j;
      continue;
    }
    result.push(lines[i]);
    i++;
  }
  return result.join('\n');
}

function escapeNestedCodeBlocks(text) {
  let inBlock = false;
  const lines = text.split('\n');
  return lines.map(line => {
    if (line.startsWith('```')) {
      inBlock = !inBlock;
      return line;
    }
    if (inBlock && line.includes('```')) {
      return line.replace(/```/g, '`\u200B``');
    }
    return line;
  }).join('\n');
}

function chunk(text, limit) {
  if (text.length <= limit) return [text];
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = -1;
    const cbEnd1 = rest.lastIndexOf('\n```\n', limit);
    const cbEnd2 = rest.lastIndexOf('\n```', limit);
    if (cbEnd1 > limit / 2) {
      cut = cbEnd1 + 4;
    } else if (cbEnd2 > limit / 2) {
      cut = cbEnd2 + 4;
    }
    if (cut <= 0 || cut > limit) {
      const para = rest.lastIndexOf('\n\n', limit);
      const line = rest.lastIndexOf('\n', limit);
      const space = rest.lastIndexOf(' ', limit);
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;
    }
    let part = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n+/, '');
    const backtickCount = (part.match(/```/g) || []).length;
    if (backtickCount % 2 === 1) {
      const langMatch = part.match(/```(\w+)/);
      const lang = langMatch ? langMatch[1] : '';
      const closing = '\n```';
      if (part.length + closing.length > limit) {
        const overflow = part.length + closing.length - limit;
        const moved = part.slice(part.length - overflow);
        part = part.slice(0, part.length - overflow) + closing;
        rest = '```' + lang + '\n' + moved + rest;
      } else {
        part += closing;
        rest = '```' + lang + '\n' + rest;
      }
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

function discordApi(method, apiPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: 'discord.com', path: apiPath, method: method, headers: headers },
      res => { let out = ''; res.on('data', d => { out += d; }); res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve({}); } }); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function discordReact(method, channelId, messageId, emoji, token) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'discord.com',
      path: '/api/v10/channels/' + channelId + '/messages/' + messageId + '/reactions/' + encodeURIComponent(emoji) + '/@me',
      method: method,
      headers: { 'Authorization': 'Bot ' + token, 'Content-Length': 0 },
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.end();
  });
}

function formatForDiscord(text) {
  return escapeNestedCodeBlocks(convertMarkdownTables(text));
}

module.exports = {
  getDisplayWidth, convertMarkdownTables, escapeNestedCodeBlocks,
  chunk, discordSend, discordApi, discordReact, formatForDiscord
};
