'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const HINTS_PORT_FILE = path.join(os.tmpdir(), 'claude2bot', 'memory-port');

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const payload = JSON.parse(input);
      const message = typeof payload.prompt === 'string' ? payload.prompt : '';
      if (!message || message.length < 3) {
        process.stdout.write('{}');
        return;
      }
      fetchHints(message, (hints) => {
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
      });
    } catch (e) {
      process.stdout.write('{}');
    }
  });
}

function fetchHints(query, cb) {
  let port;
  try {
    port = fs.readFileSync(HINTS_PORT_FILE, 'utf8').trim();
  } catch {
    cb(null);
    return;
  }

  const url = `http://localhost:${port}/hints?q=${encodeURIComponent(query)}`;
  const req = http.get(url, { timeout: 2000 }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        cb(data.hints || null);
      } catch {
        cb(null);
      }
    });
  });
  req.on('error', () => cb(null));
  req.on('timeout', () => { req.destroy(); cb(null); });
}

main();
