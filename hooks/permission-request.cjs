if (process.env.CLAUDE2BOT_NO_CONNECT) process.exit(0);
/**
 * claude2bot PermissionRequest hook
 * 1. Send Discord message with approve/deny buttons
 * 2. Poll /tmp/perm-{uuid}.result for decision
 * 3. Return JSON decision to stdout
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEBUG = process.env.CLAUDE2BOT_DEBUG === '1';

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
if (!DATA_DIR) process.exit(0);

const POLL_INTERVAL = 2000;
const TIMEOUT = 900000; // 15 minutes
const STALE_THRESHOLD = 30 * 60 * 1000; // 30 minutes

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

function cleanupStaleFiles() {
  try {
    const tmpDir = os.tmpdir();
    const files = fs.readdirSync(tmpDir);
    const now = Date.now();
    for (const f of files) {
      if (f.startsWith('perm-') && f.endsWith('.pending')) {
        const fp = path.join(tmpDir, f);
        try {
          const stat = fs.statSync(fp);
          if (now - stat.mtimeMs > STALE_THRESHOLD) {
            fs.unlinkSync(fp);
            // Also remove matching result file
            const resultFile = fp.replace('.pending', '.result');
            try { fs.unlinkSync(resultFile); } catch {}
          }
        } catch {}
      }
    }
  } catch {}
}

function buildContent(toolName, toolInput) {
  let detail = '';
  if (toolName === 'Bash' || (toolName && toolName.includes('Bash'))) {
    detail = (toolInput.command || '').substring(0, 800);
  } else if (toolName === 'Write') {
    detail = toolInput.file_path || '';
  } else if (toolName === 'Edit') {
    detail = (toolInput.file_path || '') + '\n' + (toolInput.old_string || '').substring(0, 200);
  } else {
    detail = JSON.stringify(toolInput).substring(0, 800);
  }

  let msg = '🔐 **권한 요청**\n도구: `' + toolName + '`';
  if (detail) msg += '\n```\n' + detail + '\n```';
  return msg;
}

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', async () => {
  try {
    const data = JSON.parse(input);

    const configPath = path.join(DATA_DIR, 'config.json');
    if (!fs.existsSync(configPath)) process.exit(0);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const token = config.discord && config.discord.token;
    if (!token) process.exit(0);
    const mainLabel = config.channelsConfig && config.channelsConfig.main;
    const channels = config.channelsConfig && config.channelsConfig.channels;
    const channelId = mainLabel && channels && channels[mainLabel] && channels[mainLabel].id;
    if (!channelId) process.exit(0);

    // Cleanup stale pending files
    cleanupStaleFiles();

    const uuid = crypto.randomBytes(16).toString('hex');
    const tmpDir = os.tmpdir();
    const pendingFile = path.join(tmpDir, 'perm-' + uuid + '.pending');
    const resultFile = path.join(tmpDir, 'perm-' + uuid + '.result');

    const toolName = data.tool_name || 'unknown';
    const toolInput = data.tool_input || {};
    const permSuggestions = data.permission_suggestions || [];

    // Send Discord message with buttons
    const content = buildContent(toolName, toolInput);
    const body = {
      content: content,
      components: [{
        type: 1,
        components: [
          { type: 2, style: 3, label: '승인', custom_id: 'perm-' + uuid + '-allow' },
          { type: 2, style: 1, label: '세션 승인', custom_id: 'perm-' + uuid + '-session' },
          { type: 2, style: 4, label: '거부', custom_id: 'perm-' + uuid + '-deny' }
        ]
      }]
    };

    const msgResult = await discordApi('POST', '/api/v10/channels/' + channelId + '/messages', token, body);
    const messageId = msgResult.id;

    if (!messageId) {
      // Discord 메시지 전송 실패 → 터미널 폴백
      process.exit(0);
    }

    // Create pending file
    fs.writeFileSync(pendingFile, JSON.stringify({ uuid: uuid, messageId: messageId, channelId: channelId, toolName: toolName, createdAt: Date.now() }));

    // Poll for result
    const startTime = Date.now();

    while (Date.now() - startTime < TIMEOUT) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));

      if (fs.existsSync(resultFile)) {
        let decision;
        try {
          const result = fs.readFileSync(resultFile, 'utf8').trim();
          if (DEBUG) process.stderr.write('[perm-hook] result file content: "' + result + '"\n');

          if (result === 'allow') {
            decision = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
          } else if (result === 'session') {
            // permission_suggestions가 있으면 그대로 사용 (공식 방법)
            // 없으면 도구 전체를 세션에서 허용
            const perms = permSuggestions.length > 0
              ? permSuggestions.map(s => ({ ...s, destination: 'session' }))
              : [{ type: 'addRules', rules: [{ toolName: toolName }], behavior: 'allow', destination: 'session' }];
            decision = {
              hookSpecificOutput: {
                hookEventName: 'PermissionRequest',
                decision: {
                  behavior: 'allow',
                  updatedPermissions: perms
                }
              }
            };
          } else {
            decision = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Discord에서 거부됨' } } };
          }
        } catch {
          decision = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: '결과 읽기 실패' } } };
        }

        // Cleanup
        try { fs.unlinkSync(pendingFile); } catch {}
        try { fs.unlinkSync(resultFile); } catch {}

        if (DEBUG) process.stderr.write('[perm-hook] decision: ' + JSON.stringify(decision) + '\n');
        process.stdout.write(JSON.stringify(decision));
        process.exit(0);
      }
    }

    // Timeout — edit Discord message and deny
    if (messageId) {
      await discordApi('PATCH', '/api/v10/channels/' + channelId + '/messages/' + messageId, token, {
        content: content + '\n\n\u26A0\uFE0F 시간 초과로 자동 거부되었습니다.',
        components: []
      });
    }

    // Cleanup
    try { fs.unlinkSync(pendingFile); } catch {}
    try { fs.unlinkSync(resultFile); } catch {}

    const denyDecision = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: '시간 초과' } } };
    process.stdout.write(JSON.stringify(denyDecision));
    process.exit(0);
  } catch {
    // Fail-closed: empty output → fallback to terminal approval
    process.exit(0);
  }
});
