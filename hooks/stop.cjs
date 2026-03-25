const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNTIME_ROOT = path.join(os.tmpdir(), 'claude2bot');
const ACTIVE_INSTANCE_FILE = path.join(RUNTIME_ROOT, 'active-instance.json');

function readActiveInstance() {
  try {
    return JSON.parse(fs.readFileSync(ACTIVE_INSTANCE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

try {
  const active = readActiveInstance();
  if (!active || !active.turnEndFile) process.exit(0);
  const turnEndFile = active.turnEndFile;
  fs.mkdirSync(path.dirname(turnEndFile), { recursive: true });
  fs.writeFileSync(turnEndFile, String(Date.now()));
} catch {}
