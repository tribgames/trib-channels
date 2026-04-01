'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude/plugins/data/claude2bot-claude2bot');
const dbPath = path.join(PLUGIN_DATA, 'memory.sqlite');

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const payload = JSON.parse(input);
      const message = extractMessage(payload);
      if (!message || message.length < 3) {
        process.stdout.write('{}');
        return;
      }
      const hints = queryMemory(message);
      if (!hints) {
        process.stdout.write('{}');
        return;
      }
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: hints
        }
      }));
    } catch (e) {
      process.stdout.write('{}');
    }
  });
}

function extractMessage(payload) {
  if (!payload) return null;
  // Claude Code UserPromptSubmit format: { user_prompt: "..." }
  if (typeof payload.user_prompt === 'string') return payload.user_prompt;
  // Fallback: { message: { content: "..." } } or { message: "..." }
  const msg = payload.message;
  if (!msg) return null;
  if (typeof msg === 'string') return msg;
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join(' ');
  }
  return null;
}

function queryMemory(message) {
  if (!fs.existsSync(dbPath)) return null;

  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    return null;
  }

  try {
    db.exec('PRAGMA busy_timeout = 500');
    db.exec('PRAGMA journal_mode = WAL');

    const parts = [];

    // 1. FTS search on facts (active only, limit 3)
    const factHints = searchFacts(db, message);
    for (const f of factHints) {
      parts.push(`<hint type="fact">${f}</hint>`);
    }

    // 2. Active/in_progress tasks (limit 2)
    const taskHints = getActiveTasks(db);
    for (const t of taskHints) {
      parts.push(`<hint type="task">${t}</hint>`);
    }

    // 3. Top signals (limit 2)
    const signalHints = getTopSignals(db);
    for (const s of signalHints) {
      parts.push(`<hint type="signal">${s}</hint>`);
    }

    if (parts.length === 0) return null;
    return '<memory-context>\n' + parts.join('\n') + '\n</memory-context>';
  } catch (e) {
    return null;
  } finally {
    try { db.close(); } catch (_) {}
  }
}

function searchFacts(db, message) {
  try {
    // trigram FTS — use the message as search term
    const searchTerm = message.slice(0, 200);
    const stmt = db.prepare(`
      SELECT f.text FROM facts f
      JOIN facts_fts ft ON ft.rowid = f.id
      WHERE facts_fts MATCH ? AND f.status = 'active'
      ORDER BY rank
      LIMIT 3
    `);
    const rows = stmt.all(searchTerm);
    return rows.map(r => r.text);
  } catch (e) {
    return [];
  }
}

function getActiveTasks(db) {
  try {
    const stmt = db.prepare(`
      SELECT title, details FROM tasks
      WHERE status IN ('active', 'in_progress')
      ORDER BY priority DESC, last_seen DESC
      LIMIT 2
    `);
    const rows = stmt.all();
    return rows.map(r => r.details ? `${r.title}: ${r.details}` : r.title);
  } catch (e) {
    return [];
  }
}

function getTopSignals(db) {
  try {
    const stmt = db.prepare(`
      SELECT kind, value, score FROM signals
      WHERE status = 'active'
      ORDER BY score DESC
      LIMIT 2
    `);
    const rows = stmt.all();
    return rows.map(r => `[${r.kind}] ${r.value} (score: ${r.score})`);
  } catch (e) {
    return [];
  }
}

main();
