/**
 * Inbox watcher — reply and unsubscribe detection.
 *
 * Scans the sender inbox over IMAP and matches incoming mail against every
 * lead we've emailed. Without this, Day 4 / Day 9 follow-ups keep firing at
 * people who already replied — which burns goodwill and spam reputation.
 *
 *   reply from a known lead  → outreachStatus: 'replied'      (sequence stops)
 *   reply saying unsubscribe → outreachStatus: 'unsubscribed' (sequence stops)
 *
 * Only UNSEEN messages are scanned, and each processed message is marked
 * seen, so repeated runs are idempotent. Leads already in a terminal state
 * are never downgraded (a second email from someone who replied changes
 * nothing; an unsubscribe after a reply still upgrades to unsubscribed).
 *
 * Unsubscribe matching is done on the NEW text of the reply only — quoted
 * lines and everything below a reply separator are stripped first, because
 * our own footer contains the word "unsubscribe" and would otherwise turn
 * every plain reply into a false unsubscribe.
 *
 * Setup: fill in the `imap` block in automation/config.js (same mailbox
 * the sequences send from).
 *
 * Usage:
 *   node scraper/automation/inbox.js            # scan and update leads
 *   node scraper/automation/inbox.js --dry-run  # show matches, change nothing
 *
 * Runs automatically as Step 0 of scraper/automate.js.
 */

'use strict';

let cfg;
try { cfg = require('./config'); } catch { cfg = require('./config.template'); }

const { loadLeads, saveLeads, markUnsubscribed } = require('./sequences');

const PROJECTS = ['auto-repair', 'roofers', 'electricians'];

const UNSUB_PATTERNS = [
  /\bunsubscribe\b/i,
  /\bopt\s*out\b/i,
  /\bremove\s+me\b/i,
  /\bstop\s+(emailing|contacting|messaging)\b/i,
  /\btake\s+me\s+off\b/i,
];

// States where an incoming email should update the lead. Terminal states like
// closed/not-interested are left alone except unsubscribed, which always wins.
const REPLYABLE_STATES = new Set(['new', 'emailed-d1', 'emailed-d4', 'emailed-d9']);

// ── Strip quoted text so we only match what the sender actually typed ─────────
function newTextOnly(body) {
  const lines = (body || '').split('\n');
  const kept = [];
  for (const line of lines) {
    // Reply separators — everything below is quoted history
    if (/^On .{5,80} wrote:\s*$/.test(line.trim())) break;
    if (/^-{3,}\s*Original Message\s*-{3,}/i.test(line.trim())) break;
    if (/^From:\s.+@/.test(line.trim()) && kept.length > 0) break;
    if (line.trimStart().startsWith('>')) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

function isUnsubscribe(text) {
  return UNSUB_PATTERNS.some(re => re.test(text));
}

// ── Build a lookup of every lead email across all projects ───────────────────
function buildLeadIndex() {
  const index = new Map(); // email (lowercase) → { project, placeId }
  for (const project of PROJECTS) {
    for (const lead of loadLeads(project)) {
      if (lead.email) {
        index.set(lead.email.toLowerCase(), { project, placeId: lead.placeId });
      }
    }
  }
  return index;
}

// ── Scan the inbox ────────────────────────────────────────────────────────────
async function checkInbox({ dryRun = false, log = console.log } = {}) {
  if (!cfg.imap?.host || !cfg.imap?.auth?.user) {
    log('  (IMAP not configured — skipping reply detection. Set the imap block in config.js)');
    return { replied: 0, unsubscribed: 0, scanned: 0 };
  }

  let ImapFlow, simpleParser;
  try {
    ({ ImapFlow } = require('imapflow'));
    ({ simpleParser } = require('mailparser'));
  } catch {
    log('  (imapflow/mailparser not installed — run: npm install in scraper/)');
    return { replied: 0, unsubscribed: 0, scanned: 0 };
  }

  const index = buildLeadIndex();
  if (index.size === 0) {
    log('  No leads with email addresses yet — nothing to match against.');
    return { replied: 0, unsubscribed: 0, scanned: 0 };
  }

  const client = new ImapFlow({
    host:   cfg.imap.host,
    port:   cfg.imap.port ?? 993,
    secure: cfg.imap.secure ?? true,
    auth:   cfg.imap.auth,
    logger: false,
  });

  const summary = { replied: 0, unsubscribed: 0, scanned: 0 };
  // matches[project] = [{ placeId, action, from, snippet }]
  const matches = {};

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const unseen = await client.search({ seen: false });
    const uids = unseen || [];
    summary.scanned = uids.length;

    for (const uid of uids) {
      const msg = await client.fetchOne(uid, { source: true });
      if (!msg?.source) continue;

      const parsed = await simpleParser(msg.source);
      const fromAddr = parsed.from?.value?.[0]?.address?.toLowerCase();
      if (!fromAddr) continue;

      const hit = index.get(fromAddr);
      if (!hit) continue; // Not from a lead — leave unseen for the human

      const ownText = newTextOnly(parsed.text || '');
      const action  = isUnsubscribe(ownText) || isUnsubscribe(parsed.subject || '')
        ? 'unsubscribed'
        : 'replied';

      (matches[hit.project] ??= []).push({
        placeId: hit.placeId,
        action,
        from:    fromAddr,
        snippet: ownText.trim().replace(/\s+/g, ' ').slice(0, 120),
      });

      if (!dryRun) await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }

  // ── Apply matches to lead databases ─────────────────────────────────────────
  for (const [project, hits] of Object.entries(matches)) {
    const leads = loadLeads(project);
    let changed = false;

    for (const hit of hits) {
      const idx = leads.findIndex(l => l.placeId === hit.placeId);
      if (idx === -1) continue;
      const lead = leads[idx];
      const status = lead.outreachStatus || 'new';

      if (hit.action === 'unsubscribed') {
        if (status === 'unsubscribed') continue;
        log(`  [${project}] ${lead.name} → unsubscribed  ("${hit.snippet}")`);
        summary.unsubscribed++;
        if (!dryRun) { leads[idx] = markUnsubscribed(lead); changed = true; }
      } else {
        if (!REPLYABLE_STATES.has(status)) continue; // already replied/closed/etc.
        log(`  [${project}] ${lead.name} → replied  ("${hit.snippet}")`);
        summary.replied++;
        if (!dryRun) {
          leads[idx] = {
            ...lead,
            outreachStatus: 'replied',
            repliedAt:      new Date().toISOString(),
            notes:          [lead.notes, `Replied: "${hit.snippet}"`].filter(Boolean).join(' | '),
          };
          changed = true;
        }
      }
    }

    if (changed) saveLeads(project, leads);
  }

  if (summary.scanned === 0) log('  Inbox clean — no unseen messages.');
  else log(`  Scanned ${summary.scanned} unseen: ${summary.replied} replies, ${summary.unsubscribed} unsubscribes.`);

  return summary;
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────────
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  checkInbox({ dryRun })
    .then(() => process.exit(0))
    .catch(err => { console.error('Inbox check failed:', err.message); process.exit(1); });
}

module.exports = { checkInbox, newTextOnly, isUnsubscribe };
