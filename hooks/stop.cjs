const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNTIME_ROOT = path.join(os.tmpdir(), 'claude2bot');
const ACTIVE_INSTANCE_FILE = path.join(RUNTIME_ROOT, 'active-instance.json');

// Read the hook event from stdin and ignore sidechain/team stop events.
let input = '';
try {
  input = fs.readFileSync(0, 'utf8');
} catch {}

if (input) {
  try {
    const event = JSON.parse(input);
    // Do not touch the main typing state for sidechain or team turns.
    if (event.isSidechain || event.teamName) process.exit(0);
  } catch {}
}

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
