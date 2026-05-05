#!/usr/bin/env node
/**
 * System Operator Bot — Self-healing Telegram interface
 *
 * Not just monitoring — when cycles break, it:
 * 1. Detects the failure (watches logs + lock files + exit codes)
 * 2. Reads the error, understands root cause
 * 3. Dispatches Claude Code to diagnose and fix
 * 4. Retries the cycle
 * 5. Reports to user on Telegram
 *
 * Usage: node bot.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync, exec, spawn } = require('child_process');

const BOT_TOKEN = '8615176967:AAE66n6dJm58UfmofUyEllBgcmHLzlPOo-A';
const CHAT_ID = '6414673343';
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const POLL_INTERVAL = 2000;
let lastUpdateId = 0;

// ── System paths ──
const XRAY_DIR = '/opt/site-xray';
const LEAD_DIR = '/opt/lead-machine';
const DASHBOARD_PORT = 3847;
const HEAL_LOG = '/var/log/site-xray/heal.log';

// ── Healing state ──
let isHealing = false;
let lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000; // every 5 minutes
let lastCycleLogSize = 0;
let lastScrapeLogSize = 0;

// ── Smart healing: track what was tried, escalate when fixes don't work ──
const healHistory = {};  // { 'source:patternName': { attempts: N, lastAttempt: timestamp, escalatedToClaude: bool } }
const HEAL_COOLDOWN = 30 * 60 * 1000; // 30 min cooldown after Claude escalation
const MAX_KNOWN_FIX_ATTEMPTS = 2; // after 2 failed known fixes → escalate to Claude
const MAX_TOTAL_ATTEMPTS = 4; // after Claude also fails → notify user ONCE and stop
let notifiedUser = {}; // { source: true } — only notify once per issue

// ═══════════════════════════════════════
// TELEGRAM HELPERS
// ═══════════════════════════════════════

function tgPost(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(`${API}/${method}`);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sendMessage(text, parseMode = 'Markdown') {
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  for (const chunk of chunks) {
    await tgPost('sendMessage', {
      chat_id: CHAT_ID, text: chunk, parse_mode: parseMode, disable_web_page_preview: true,
    }).catch(() => tgPost('sendMessage', { chat_id: CHAT_ID, text: chunk, disable_web_page_preview: true }));
  }
}

async function sendTyping() {
  await tgPost('sendChatAction', { chat_id: CHAT_ID, action: 'typing' }).catch(() => {});
}

// ═══════════════════════════════════════
// SYSTEM QUERY FUNCTIONS
// ═══════════════════════════════════════

function readJSON(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }
}

function shell(cmd, timeout = 15000) {
  try { return execSync(cmd, { timeout, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); } catch (e) { return `Error: ${e.stderr?.slice(0, 200) || e.message?.slice(0, 200)}`; }
}

function shellAsync(cmd, timeout = 120000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, stdout, stderr: stderr || err.message, code: err.code });
      else resolve({ ok: true, stdout, stderr });
    });
  });
}

const EVENT_LOG = '/opt/site-xray/dashboard/events.json';

function logHeal(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(HEAL_LOG, line);
  console.log(`[HEAL] ${msg}`);
}

function logEvent(type, system, message, status = 'info') {
  // Writes to a JSON file the dashboard reads
  const eventsFile = EVENT_LOG;
  let events = [];
  try { events = JSON.parse(fs.readFileSync(eventsFile, 'utf-8')); } catch {}
  events.push({
    timestamp: new Date().toISOString(),
    type,       // 'cycle', 'scrape', 'heal', 'deploy', 'error', 'fix', 'user'
    system,     // 'xray', 'swapper', 'leads', 'server', 'bot'
    message,
    status,     // 'success', 'failure', 'info', 'warning', 'healing'
  });
  // Keep last 500 events
  if (events.length > 500) events = events.slice(-500);
  fs.writeFileSync(eventsFile, JSON.stringify(events, null, 2));
}

function getXRayStatus() {
  const history = readJSON(`${XRAY_DIR}/improve/history.json`) || [];
  const knowledge = readJSON(`${XRAY_DIR}/improve/knowledge.json`) || {};
  const version = shell(`cat ${XRAY_DIR}/VERSION 2>/dev/null`) || '?';
  const scored = history.filter(h => typeof h.score === 'number');
  const latest = scored[scored.length - 1];
  const cycleRunning = fs.existsSync('/tmp/site-xray-cycle.lock');

  let report = null;
  const resultsDir = `${XRAY_DIR}/test/results`;
  if (fs.existsSync(resultsDir)) {
    const reports = fs.readdirSync(resultsDir).filter(f => f.endsWith('.json') && f.startsWith('v')).sort();
    if (reports.length > 0) report = readJSON(`${resultsDir}/${reports[reports.length - 1]}`);
  }

  return { version: `v${version}`, latestScore: latest?.score ?? '?', latestDiff: latest?.diff ?? 0, cyclesRun: scored.length, cycleRunning, learnings: knowledge.learnings?.length || 0, failures: knowledge.failed_approaches?.length || 0, report };
}

function getLeadMachineStatus() {
  if (!fs.existsSync(LEAD_DIR)) return { status: 'not deployed' };
  const logFile = '/var/log/lead-machine/scrape.log';
  const lastLog = fs.existsSync(logFile) ? shell(`tail -5 ${logFile}`) : 'no logs yet';
  const cron = shell('crontab -l 2>/dev/null | grep lead-machine || echo "no cron"');
  return { status: 'deployed', lastLog, cron };
}

function getServerStatus() {
  const uptime = shell('uptime -p 2>/dev/null || uptime');
  const disk = shell("df -h / | tail -1 | awk '{print $4 \" free of \" $2}'");
  const mem = shell("free -h | head -2 | tail -1 | awk '{print $3 \" used / \" $2 \" total\"}'");
  const load = shell("cat /proc/loadavg | awk '{print $1, $2, $3}'");
  return { uptime, disk, mem, load };
}

function getDashboardUrl() { return `http://178.104.47.126:${DASHBOARD_PORT}`; }

// ═══════════════════════════════════════
// SELF-HEALING ENGINE
// ═══════════════════════════════════════

// Known failure patterns and their fixes
const KNOWN_FIXES = [
  {
    pattern: /rate limit|hit your limit|resets.*UTC|too many requests|429/i,
    name: 'Claude rate limit',
    fix: async () => {
      return 'NEEDS_HUMAN: Rate limited — waiting for reset. Will try again on next cron cycle.';
    },
  },
  {
    pattern: /stale lock/i,
    name: 'Stale PID lock',
    fix: () => {
      shell('rm -f /tmp/site-xray-cycle.lock');
      return 'Removed stale lock file';
    },
  },
  {
    pattern: /permission denied|EACCES/i,
    name: 'Permission error',
    fix: () => {
      shell(`chmod +x ${XRAY_DIR}/improve/cycle.sh`);
      shell(`chmod -R 755 ${XRAY_DIR}/test/`);
      return 'Fixed file permissions';
    },
  },
  {
    pattern: /ENOSPC|No space left/i,
    name: 'Disk full',
    fix: () => {
      shell(`rm -rf ${XRAY_DIR}/test/results/v*/*/videos/ 2>/dev/null`);
      shell(`find ${XRAY_DIR}/test/results -name "*.mp4" -delete 2>/dev/null`);
      shell(`ls -dt ${XRAY_DIR}/test/results/v*/ 2>/dev/null | tail -n +4 | xargs rm -rf 2>/dev/null`);
      const free = shell("df -h / | tail -1 | awk '{print $4}'");
      return `Cleaned old results. Free space: ${free}`;
    },
  },
  {
    pattern: /ETIMEOUT|timeout|timed out/i,
    name: 'Timeout',
    fix: () => {
      shell('pkill -f "chromium" 2>/dev/null || true');
      shell('pkill -f "playwright" 2>/dev/null || true');
      shell('rm -f /tmp/site-xray-cycle.lock');
      return 'Killed stuck browser processes and cleared lock';
    },
  },
  {
    pattern: /Cannot find module|MODULE_NOT_FOUND/i,
    name: 'Missing module',
    fix: () => {
      const result = shell(`cd ${XRAY_DIR} && npm install 2>&1 | tail -3`, 60000);
      return `Reinstalled dependencies: ${result}`;
    },
  },
  {
    pattern: /ECONNREFUSED|ECONNRESET|fetch failed/i,
    name: 'Network error',
    fix: () => {
      // Just needs a retry — network was temporarily down
      return 'Network error — will retry on next cycle';
    },
  },
  {
    pattern: /Not logged in|Please run.*login/i,
    name: 'Claude auth expired',
    fix: async () => {
      await sendMessage('⚠️ *Claude Code auth expired on the server.*\n\nI cannot fix this automatically. You need to SSH in and run:\n```\nssh root@178.104.47.126\nclaude login\n```\n\nI\'ll pause cycles until you fix this.');
      return 'NEEDS_HUMAN: Claude auth expired';
    },
  },
  {
    pattern: /zombie|defunct/i,
    name: 'Zombie processes',
    fix: () => {
      shell('pkill -9 -f "chromium" 2>/dev/null || true');
      shell('pkill -9 -f "node.*v[0-9]+-stable" 2>/dev/null || true');
      return 'Killed zombie processes';
    },
  },
];

async function escalateToClaude(logContent, source, patternName) {
  // Check if Claude itself is rate-limited before dispatching
  const claudeCheck = shell('claude -p "echo ok" --max-turns 1 2>&1', 30000);
  if (/rate limit|hit your limit|resets.*UTC|429/i.test(claudeCheck)) {
    logHeal('Claude Code itself is rate-limited. Cannot escalate.');
    return { ok: false, reason: 'Claude rate-limited — cannot self-heal right now.' };
  }

  logHeal(`Escalating to Claude Code: ${patternName || 'unknown issue'} in ${source}`);
  await sendMessage(`🧠 *Known fix didn't work. Escalating to Claude Code...*\nIssue: ${patternName || 'unknown'}\nSource: ${source}`);
  await sendTyping();

  const contextFile = '/tmp/heal-context.txt';
  const errorTail = logContent.slice(-3000);
  fs.writeFileSync(contextFile, `You are a system operator for Site X-Ray (web cloning tool) and Lead Machine (US lead scraper).

A failure occurred in: ${source}
${patternName ? `The hardcoded fix for "${patternName}" was tried ${MAX_KNOWN_FIX_ATTEMPTS} times but the problem persists. The simple fix is NOT working — find the REAL root cause.` : 'This is an unknown failure pattern.'}

Error log (last 3000 chars):
${errorTail}

System state:
- X-Ray dir: ${XRAY_DIR}
- Lead Machine dir: ${LEAD_DIR}
- Server: Ubuntu 24.04, Node 20
- Claude version: ${shell('claude --version 2>&1')}

Your job:
1. Read the error carefully — look past the surface symptom
2. Check relevant logs: /var/log/site-xray/cycle.log, the latest improve/cycle-v*.log
3. Check system state: disk, memory, processes, Claude auth
4. Identify the ROOT CAUSE (not the symptom)
5. Fix it — edit files, install packages, fix permissions, whatever is needed
6. Verify the fix works (e.g. run a quick test)
7. Report what you did in under 200 words

Important:
- Do NOT just retry the cycle. Fix the underlying issue first.
- If Claude Code auth is expired, say "NEEDS_HUMAN: Claude auth expired"
- If it's a rate limit, say "NEEDS_HUMAN: Rate limited until [time]"
- If you genuinely fixed it, say "FIXED: [what you did]"
`);

  const healResult = await shellAsync(
    `cat ${contextFile} | claude -p --allowedTools "Bash,Read,Write,Edit,Glob,Grep" --max-turns 20 2>&1`,
    300000
  );

  fs.unlinkSync(contextFile);
  const output = ((healResult.stdout || '') + (healResult.stderr || '')).slice(-2000).trim();
  logHeal(`Claude response: ${output.slice(-500)}`);

  return { ok: healResult.ok, output };
}

function retryOperation(source) {
  if (source === 'xray-cycle') {
    exec(`cd ${XRAY_DIR} && nohup ./improve/cycle.sh --auto --notify >> /var/log/site-xray/cycle.log 2>&1 &`);
  } else if (source === 'lead-scrape') {
    exec(`cd ${LEAD_DIR} && nohup npx tsx src/scheduler/scrape.cron.ts >> /var/log/lead-machine/scrape.log 2>&1 &`);
  }
}

async function detectAndHeal(logContent, source) {
  if (isHealing) return;

  // Already notified user about this issue and gave up? Don't spam.
  if (notifiedUser[source]) {
    console.log(`[STOP] Already notified user about ${source}. Waiting for manual /cycle or next cron.`);
    return;
  }

  isHealing = true;
  logHeal(`Failure detected in ${source}. Analyzing...`);

  try {
    // Find which known pattern matches (if any)
    let matchedPattern = null;
    for (const known of KNOWN_FIXES) {
      if (known.pattern.test(logContent)) {
        matchedPattern = known;
        break;
      }
    }

    const healKey = `${source}:${matchedPattern?.name || 'unknown'}`;
    if (!healHistory[healKey]) {
      healHistory[healKey] = { attempts: 0, escalatedToClaude: false };
    }
    const history = healHistory[healKey];
    history.attempts++;
    history.lastAttempt = Date.now();

    logHeal(`Issue: ${matchedPattern?.name || 'unknown'} | Attempt #${history.attempts} | Escalated: ${history.escalatedToClaude}`);

    // ── STAGE 1: Try known fix (max 2 attempts) ──
    if (matchedPattern && history.attempts <= MAX_KNOWN_FIX_ATTEMPTS && !history.escalatedToClaude) {
      logEvent('heal', source === 'xray-cycle' ? 'xray' : 'leads', `Auto-healing: ${matchedPattern.name} (attempt ${history.attempts})`, 'healing');
      await sendMessage(`🔧 *Auto-healing: ${matchedPattern.name}* (attempt ${history.attempts}/${MAX_KNOWN_FIX_ATTEMPTS})\nSource: ${source}`);

      const result = await Promise.resolve(matchedPattern.fix());
      logHeal(`Fix applied: ${result}`);

      if (result.startsWith('NEEDS_HUMAN')) {
        await sendMessage(`⚠️ ${result.replace('NEEDS_HUMAN: ', '')}`);
        notifiedUser[source] = true;
        isHealing = false;
        return;
      }

      logEvent('fix', source === 'xray-cycle' ? 'xray' : 'leads', `Fixed: ${result}`, 'success');
      await sendMessage(`✅ Fixed: ${result}\nRetrying...`);
      retryOperation(source);
      await sendMessage('🔄 Retried.');
      isHealing = false;
      return;
    }

    // ── STAGE 2: Known fix failed twice → escalate to Claude ──
    if (!history.escalatedToClaude && history.attempts <= MAX_TOTAL_ATTEMPTS) {
      history.escalatedToClaude = true;
      const patternName = matchedPattern?.name || null;

      if (matchedPattern) {
        await sendMessage(`⚠️ *Known fix "${matchedPattern.name}" failed ${MAX_KNOWN_FIX_ATTEMPTS} times.* Escalating to Claude Code for deeper diagnosis...`);
      }

      const result = await escalateToClaude(logContent, source, patternName);

      if (result.ok && result.output) {
        const response = result.output;
        if (/NEEDS_HUMAN/i.test(response)) {
          const reason = response.match(/NEEDS_HUMAN:\s*(.+)/i)?.[1] || 'Unknown reason';
          await sendMessage(`⚠️ *Claude says this needs you:*\n${reason}\n\nBot will stop retrying. Use /cycle when ready.`);
          notifiedUser[source] = true;
        } else if (/FIXED/i.test(response)) {
          await sendMessage(`🧠 *Claude fixed it:*\n\n${response.slice(-1500)}\n\nRetrying...`);
          logEvent('fix', source === 'xray-cycle' ? 'xray' : 'leads', `Claude fixed: ${response.slice(0, 200)}`, 'success');
          // Reset — the fix might work now
          healHistory[healKey] = { attempts: 0, escalatedToClaude: false };
          retryOperation(source);
          await sendMessage('🔄 Retried after Claude fix.');
        } else {
          // Claude did something but unclear if it worked — retry once
          await sendMessage(`🧠 *Claude attempted a fix:*\n\n${response.slice(-1000)}\n\nRetrying once to verify...`);
          retryOperation(source);
        }
      } else {
        // Claude itself failed (rate limited, crashed, etc.)
        const reason = result.reason || result.output?.slice(-500) || 'Unknown error';
        await sendMessage(`❌ *Claude could not fix it either:*\n${reason}\n\nBot will stop retrying. Use /cycle when ready.`);
        notifiedUser[source] = true;
      }

      isHealing = false;
      return;
    }

    // ── STAGE 3: Everything failed → notify user ONCE and stop ──
    if (!notifiedUser[source]) {
      await sendMessage(`🚨 *${source} is broken and I can't fix it.*\n\nTried:\n• Known fix "${matchedPattern?.name || 'N/A'}" × ${MAX_KNOWN_FIX_ATTEMPTS}\n• Claude Code escalation\n\nNone worked. You need to look at this.\nUse /logs to see what happened, or /fix <description> to tell me what to try.\n\nI'll stop retrying until you run /cycle.`);
      notifiedUser[source] = true;
      logEvent('error', source === 'xray-cycle' ? 'xray' : 'leads', 'All healing attempts exhausted. User notified.', 'failure');
    }

  } catch (err) {
    logHeal(`Healing error: ${err.message}`);
    await sendMessage(`❌ Self-healing failed: ${err.message?.slice(0, 200)}`);
  }

  isHealing = false;
}

// ═══════════════════════════════════════
// HEALTH CHECK — runs every 5 minutes
// ═══════════════════════════════════════

async function healthCheck() {
  const now = Date.now();
  if (now - lastHealthCheck < HEALTH_CHECK_INTERVAL) return;
  lastHealthCheck = now;

  // 1. Check for stale lock files (cycle running > 2 hours = stuck)
  const lockFile = '/tmp/site-xray-cycle.lock';
  if (fs.existsSync(lockFile)) {
    const lockAge = (now - fs.statSync(lockFile).mtimeMs) / 1000 / 60;
    if (lockAge > 120) {
      logHeal(`Stale lock detected: ${lockAge.toFixed(0)} minutes old`);
      await detectAndHeal('Stale lock file — cycle stuck for ' + lockAge.toFixed(0) + ' minutes', 'xray-cycle');
    }
  }

  // 2. Check for new errors in X-Ray cycle log
  const cycleLog = '/var/log/site-xray/cycle.log';
  if (fs.existsSync(cycleLog)) {
    const currentSize = fs.statSync(cycleLog).size;
    if (currentSize > lastCycleLogSize) {
      // New content — check for failures
      const newContent = shell(`tail -c ${Math.min(currentSize - lastCycleLogSize, 5000)} ${cycleLog}`);
      lastCycleLogSize = currentSize;

      if (/❌|FAILED|Error:|crashed|timed out|PLATEAU/i.test(newContent) && !/✅/.test(newContent.slice(-200))) {
        // Only heal if failure happened recently (within last 10 min), not stale log entries
        const timeMatch = newContent.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
        const isFresh = timeMatch ? (Date.now() - new Date(timeMatch[1] + ' UTC').getTime()) < 10 * 60 * 1000 : true;
        if (isFresh) {
          logHeal('Failure detected in X-Ray cycle log');
          await detectAndHeal(newContent, 'xray-cycle');
        }
      }
    }
  }

  // 3. Check for errors in Lead Machine log
  const scrapeLog = '/var/log/lead-machine/scrape.log';
  if (fs.existsSync(scrapeLog)) {
    const currentSize = fs.statSync(scrapeLog).size;
    if (currentSize > lastScrapeLogSize) {
      const newContent = shell(`tail -c ${Math.min(currentSize - lastScrapeLogSize, 5000)} ${scrapeLog}`);
      lastScrapeLogSize = currentSize;

      if (/FATAL|unhandled|ENOSPC|crashed/i.test(newContent)) {
        logHeal('Failure detected in Lead Machine log');
        await detectAndHeal(newContent, 'lead-scrape');
      }
    }
  }

  // 4. Check disk space
  const freeGB = parseInt(shell("df -BG / | tail -1 | awk '{print $4}' | tr -d 'G'")) || 999;
  if (freeGB < 3) {
    logHeal(`Low disk space: ${freeGB}GB`);
    await detectAndHeal(`ENOSPC: Only ${freeGB}GB free`, 'server');
  }

  // 5. Check if dashboard is responding
  try {
    const dashOk = shell(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${DASHBOARD_PORT}/api/report`);
    if (dashOk !== '200') {
      logHeal(`Dashboard down: HTTP ${dashOk}`);
      shell('systemctl restart xray-dashboard');
      logHeal('Dashboard restarted');
    }
  } catch {}

  // 6. Check if Chromium zombies are accumulating
  const chromiumCount = parseInt(shell('pgrep -c chromium 2>/dev/null || echo 0')) || 0;
  if (chromiumCount > 10) {
    logHeal(`${chromiumCount} Chromium processes — killing zombies`);
    shell('pkill -9 -f "chromium" 2>/dev/null || true');
  }
}

// ═══════════════════════════════════════
// COMMAND HANDLERS
// ═══════════════════════════════════════

const COMMANDS = {
  '/status': async () => {
    const xray = getXRayStatus();
    const leads = getLeadMachineStatus();
    const server = getServerStatus();

    return `🔬 *System Status*

*X-Ray Engine*
Version: ${xray.version}
Score: ${xray.latestScore}/100 ${xray.latestDiff > 0 ? `(+${xray.latestDiff})` : ''}
Cycles: ${xray.cyclesRun} completed
Cycle running: ${xray.cycleRunning ? '🟢 YES' : '⚪ No'}
Learnings: ${xray.learnings} | Failures: ${xray.failures}

*Lead Machine*
Status: ${leads.status}
Cron: ${leads.cron}

*Server*
${server.uptime}
Disk: ${server.disk}
RAM: ${server.mem}
Load: ${server.load}

📊 Dashboard: ${getDashboardUrl()}`;
  },

  '/scores': async () => {
    const xray = getXRayStatus();
    if (!xray.report?.sites) return 'No test results available yet.';
    const lines = xray.report.sites.sort((a, b) => a.totalScore - b.totalScore)
      .map(s => `${s.totalScore}/100 — ${new URL(s.site).hostname}`);
    return `📊 *Per-Site Scores (${xray.version})*\nAvg: ${xray.report.averageScore}/100\n\n${lines.join('\n')}`;
  },

  '/leads': async () => {
    const leads = getLeadMachineStatus();
    if (leads.status !== 'deployed') return 'Lead Machine not deployed yet.';
    return `🎯 *Lead Machine*\nStatus: ${leads.status}\nCron: ${leads.cron}\n\nLast log:\n\`\`\`\n${leads.lastLog}\n\`\`\``;
  },

  '/knowledge': async () => {
    const kb = readJSON(`${XRAY_DIR}/improve/knowledge.json`);
    if (!kb) return 'No knowledge base found.';
    const learnings = (kb.learnings || []).slice(-3).map(l => `✅ *${l.version}* — ${l.technique}\n${l.impact || ''}`).join('\n\n');
    const failures = (kb.failed_approaches || []).filter(f => f.technique).slice(-3).map(f => `❌ *${f.version}* — ${f.technique}\n${f.reason || ''}`).join('\n\n');
    return `🧠 *Knowledge Base*\n\n*Recent Learnings:*\n${learnings || 'None'}\n\n*Recent Failures:*\n${failures || 'None'}`;
  },

  '/cycle': async () => {
    if (fs.existsSync('/tmp/site-xray-cycle.lock')) return '🔄 A cycle is already running.';
    // Reset ALL healing state — user is taking control
    Object.keys(healHistory).forEach(k => delete healHistory[k]);
    Object.keys(notifiedUser).forEach(k => delete notifiedUser[k]);
    exec(`cd ${XRAY_DIR} && nohup ./improve/cycle.sh --auto --notify >> /var/log/site-xray/cycle.log 2>&1 &`);
    logEvent('cycle', 'xray', 'Manual cycle triggered by user', 'info');
    return '🚀 X-Ray improvement cycle triggered! (all healing state reset)';
  },

  '/scrape': async () => {
    exec(`cd ${LEAD_DIR} && nohup npx tsx src/scheduler/scrape.cron.ts >> /var/log/lead-machine/scrape.log 2>&1 &`);
    logEvent('scrape', 'leads', 'Manual scrape triggered by user', 'info');
    return '🔍 Lead scrape triggered! ~30-60 min.';
  },

  '/heal': async () => {
    const healLog = fs.existsSync(HEAL_LOG) ? shell(`tail -20 ${HEAL_LOG}`) : 'No healing events yet.';
    return `🔧 *Healing Log*\n\`\`\`\n${healLog.slice(-1500)}\n\`\`\``;
  },

  '/fix': async (args) => {
    if (!args) return 'Usage: /fix <description of what is broken>';
    await sendTyping();
    await sendMessage('🧠 Dispatching Claude to fix...');

    const contextFile = '/tmp/fix-context.txt';
    fs.writeFileSync(contextFile, `You are a system operator for Site X-Ray (${XRAY_DIR}) and Lead Machine (${LEAD_DIR}).

The user reports this issue: ${args}

Server: Ubuntu 24.04, Node 20, Playwright installed.
X-Ray version: ${shell(`cat ${XRAY_DIR}/VERSION 2>/dev/null`)}

Your job:
1. Investigate the issue — read relevant logs, files, check processes
2. Fix the root cause
3. Verify the fix
4. Report what you did in under 300 words
`);

    const result = await shellAsync(
      `cat ${contextFile} | claude -p --allowedTools "Bash,Read,Write,Edit,Glob,Grep" --max-turns 20 2>&1`,
      600000
    );

    fs.unlinkSync(contextFile);
    const output = ((result.stdout || '') + (result.stderr || '')).slice(-2000);
    return `🧠 *Claude's fix:*\n\n${output.slice(-1500)}`;
  },

  '/dashboard': async () => {
    return `📊 Dashboard: ${getDashboardUrl()}`;
  },

  '/logs': async () => {
    const xrayLog = shell(`tail -20 /var/log/site-xray/cycle.log 2>/dev/null || echo 'No X-Ray logs'`);
    const leadLog = shell(`tail -10 /var/log/lead-machine/scrape.log 2>/dev/null || echo 'No Lead logs'`);
    return `📋 *Recent Logs*\n\n*X-Ray:*\n\`\`\`\n${xrayLog.slice(-1500)}\n\`\`\`\n\n*Lead Machine:*\n\`\`\`\n${leadLog.slice(-800)}\n\`\`\``;
  },

  '/help': async () => {
    return `🤖 *Operator Bot*

*Quick commands:*
/status — System overview
/scores — Clone quality scores
/leads — Lead Machine status
/logs — Recent logs
/cycle — Trigger improvement cycle
/scrape — Trigger lead scrape
/heal — View healing log
/reset — Reset healing + conversation
/dashboard — Dashboard URL

*Or just talk to me:*
Type anything in plain English and Claude will handle it with full server access. It can read files, edit code, run commands, deploy, fix things — anything.

Examples:
• "what's the latest cycle score?"
• "restart the dashboard"
• "check why the last cycle failed"
• "deploy the latest version"
• "show me the test results for the worst site"
• "add a new test site: example.com"

Claude remembers the last ${MAX_CONVERSATION_HISTORY} messages for context.`;
  },

  '/reset': async () => {
    Object.keys(healHistory).forEach(k => delete healHistory[k]);
    Object.keys(notifiedUser).forEach(k => delete notifiedUser[k]);
    isHealing = false;
    conversationHistory.length = 0;
    saveConversation();
    return '🔄 All healing state + conversation history reset.';
  },
};

// ═══════════════════════════════════════
// CONVERSATION MEMORY + CLAUDE SESSION
// ═══════════════════════════════════════

// Rolling conversation history so Claude has context
const conversationHistory = [];
const MAX_CONVERSATION_HISTORY = 20;
const CONVERSATION_FILE = '/opt/monitor-bot/conversation.json';

// Load persisted conversation on startup
try {
  if (fs.existsSync(CONVERSATION_FILE)) {
    const saved = JSON.parse(fs.readFileSync(CONVERSATION_FILE, 'utf-8'));
    conversationHistory.push(...saved.slice(-MAX_CONVERSATION_HISTORY));
  }
} catch {}

function saveConversation() {
  try {
    fs.writeFileSync(CONVERSATION_FILE, JSON.stringify(conversationHistory.slice(-MAX_CONVERSATION_HISTORY), null, 2));
  } catch {}
}

function addToConversation(role, text) {
  conversationHistory.push({ role, text: text.slice(0, 2000), timestamp: new Date().toISOString() });
  if (conversationHistory.length > MAX_CONVERSATION_HISTORY) {
    conversationHistory.splice(0, conversationHistory.length - MAX_CONVERSATION_HISTORY);
  }
  saveConversation();
}

// Keep sending typing indicator while Claude is working
function startTypingLoop() {
  const interval = setInterval(() => {
    sendTyping().catch(() => {});
  }, 4000);
  return () => clearInterval(interval);
}

async function handleFreeText(text) {
  const stopTyping = startTypingLoop();
  addToConversation('user', text);

  try {
    // Build context with system state + conversation history
    const state = {
      xray: getXRayStatus(),
      leads: getLeadMachineStatus(),
      server: getServerStatus(),
    };

    const recentConvo = conversationHistory.slice(-10)
      .map(m => `[${m.role}] ${m.text}`)
      .join('\n');

    const contextFile = '/tmp/chat-context.txt';
    fs.writeFileSync(contextFile, `You are the operator of a Hetzner server (178.104.47.126) running two systems:

1. **Site X-Ray** — A self-improving web cloning tool at /opt/site-xray/
   - Current engine: v${state.xray.version} scoring ${state.xray.latestScore}/100
   - Improvement cycles run every 6h via cron (cycle.sh calls Claude Code to improve the cloner)
   - Test suite: node test/suite.js v{N}
   - Dashboard: http://178.104.47.126:3847

2. **Lead Machine** — US lead scraper + site swapper at /opt/lead-machine/
   - Status: ${state.leads.status}
   - Scrapes bad US business websites, clones award-winning templates, swaps content

Server state:
- Uptime: ${state.server.uptime}
- Disk: ${state.server.disk}
- RAM: ${state.server.mem}
- Load: ${state.server.load}
- Cycle running: ${state.xray.cycleRunning ? 'YES' : 'No'}

You are talking to the owner (Luka) via Telegram. You have FULL access to the server.
You can read/write any file, run any command, edit code, restart services, deploy, install packages — anything.

Recent conversation:
${recentConvo}

IMPORTANT RULES:
- You are an operator, not an assistant. Take action, don't just suggest.
- If Luka says "fix X" — investigate and fix it. Don't ask for permission.
- If Luka says "deploy" — do it. If he says "restart" — do it.
- If Luka asks a question — answer it by checking the actual system, not guessing.
- Keep responses concise — this goes to Telegram (4000 char limit per message).
- If a task will take a while, say what you're doing first, then do it.
- If you need to show code/logs, use short excerpts (not full files).
- End with what you did and the result. No fluff.

Luka says: ${text}
`);

    const result = await shellAsync(
      `cat ${contextFile} | claude -p --allowedTools "Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch" --max-turns 30 2>&1`,
      600000  // 10 min max — real work might take time
    );

    fs.unlinkSync(contextFile);

    const output = ((result.stdout || '') + (result.stderr || '')).trim();

    if (!output || output.length < 5) {
      stopTyping();
      return 'Claude returned empty. Might be rate-limited. Try /status to check.';
    }

    // Extract the meaningful response (Claude's final output, not tool calls)
    // Take the last chunk that looks like a real response
    let response = output.slice(-3500);

    // If the output contains rate limit messages
    if (/hit your limit|rate limit/i.test(output)) {
      stopTyping();
      return '⚠️ Claude is rate-limited right now. Try again later or use slash commands (/status, /logs, /scores).';
    }

    addToConversation('claude', response.slice(0, 2000));
    stopTyping();
    return response;
  } catch (err) {
    stopTyping();
    console.error('handleFreeText error:', err.message);
    return `Error: ${err.message?.slice(0, 200)}\n\nTry /status or /help.`;
  }
}

// ═══════════════════════════════════════
// POLLING LOOP
// ═══════════════════════════════════════

async function poll() {
  try {
    // Run health check in background
    healthCheck().catch(err => console.error('Health check error:', err.message));

    const res = await tgPost('getUpdates', { offset: lastUpdateId + 1, timeout: 30 });
    if (!res.ok || !res.result?.length) return;

    for (const update of res.result) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg?.text || String(msg.chat.id) !== CHAT_ID) continue;

      const text = msg.text.trim();
      console.log(`[${new Date().toISOString()}] Message: ${text}`);

      const parts = text.split(' ');
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1).join(' ');

      if (COMMANDS[cmd]) {
        const response = await COMMANDS[cmd](args);
        addToConversation('user', text);
        addToConversation('claude', response.slice(0, 2000));
        await sendMessage(response);
      } else {
        // Everything else goes to Claude with full server access
        const response = await handleFreeText(text);
        await sendMessage(response);
      }
    }
  } catch (err) {
    console.error(`Poll error: ${err.message}`);
  }
}

// ═══════════════════════════════════════
// MAIN
// ═══════════════════════════════════════

async function main() {
  console.log('Operator Bot starting...');
  fs.mkdirSync(path.dirname(HEAL_LOG), { recursive: true });

  // Initialize log sizes so we don't trigger on old errors
  try { lastCycleLogSize = fs.statSync('/var/log/site-xray/cycle.log').size; } catch {}
  try { lastScrapeLogSize = fs.statSync('/var/log/lead-machine/scrape.log').size; } catch {}

  await tgPost('getUpdates', { offset: -1 });
  await sendMessage('🤖 *Operator Bot Online*\n\nMonitoring + self-healing active.\nType /help for commands.');

  console.log('Bot running. Polling + health checks active...');
  while (true) {
    await poll();
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

main().catch(err => { console.error('Bot crashed:', err); process.exit(1); });
