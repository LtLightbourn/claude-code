/**
 * Master automation runner. Run this daily via cron.
 *
 * What it does in order:
 *   1. Scrape new leads (rotates through configured cities)
 *   2. Enrich new leads (find emails via Hunter/Apollo)
 *   3. Process email sequences (Day 1 / Day 4 / Day 9)
 *   4. Print a pipeline summary
 *
 * Usage:
 *   node scraper/automate.js                  # Full run
 *   node scraper/automate.js --dry-run        # Show what would happen, send nothing
 *   node scraper/automate.js --skip-scrape    # Enrich + email only
 *   node scraper/automate.js --skip-email     # Scrape + enrich only
 *   node scraper/automate.js --project roofers # Single project only
 *
 * Cron (runs daily at 9am):
 *   0 9 * * * cd /path/to/claude-code && node scraper/automate.js >> scraper/logs/automate.log 2>&1
 *
 * Monthly reports (1st of each month at 9am):
 *   0 9 1 * * cd /path/to/claude-code && node scraper/reports/monthly.js >> scraper/logs/reports.log 2>&1
 */

'use strict';

const { execSync, spawn } = require('child_process');
const path   = require('fs');
const fs     = require('fs');

const { enrichBatch }                 = require('./automation/enricher');
const { sendBatch }                   = require('./automation/emailer');
const { buildQueue, markSent, saveLeads, loadLeads } = require('./automation/sequences');

let cfg;
try { cfg = require('./automation/config'); } catch { cfg = require('./automation/config.template'); }

// ── CLI flags ─────────────────────────────────────────────────────────────────
const argv       = process.argv.slice(2);
const DRY_RUN    = argv.includes('--dry-run');
const SKIP_SCRAPE = argv.includes('--skip-scrape');
const SKIP_EMAIL  = argv.includes('--skip-email');
const FILTER_PROJECT = argv.includes('--project') ? argv[argv.indexOf('--project') + 1] : null;

const PROJECTS = ['auto-repair', 'roofers', 'electricians']
  .filter(p => !FILTER_PROJECT || p === FILTER_PROJECT);

// ── Logging ───────────────────────────────────────────────────────────────────
const LOG_DIR = require('path').join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const timestamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...args) => console.log(`[${timestamp()}]`, ...args);

// ── Location rotation ─────────────────────────────────────────────────────────
// Cycle through configured cities deterministically based on day of year
function todaysLocation(projectSlug) {
  const locations = cfg.locations?.[projectSlug] || ['Austin, TX'];
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86_400_000);
  return locations[dayOfYear % locations.length];
}

// ── Step 1: Scrape ────────────────────────────────────────────────────────────
async function runScrape() {
  log('─── STEP 1: Scraping new leads ───');

  for (const project of PROJECTS) {
    const location = todaysLocation(project);
    log(`  [${project}] Scraping: ${location}`);

    if (DRY_RUN) { log('  [dry-run] skipped'); continue; }

    try {
      execSync(
        `node "${require('path').join(__dirname, 'scrape.js')}" --project "${project}" --location "${location}" --radius ${cfg.scrape?.radiusMetres || 6000}`,
        { stdio: 'inherit', env: { ...process.env, GOOGLE_API_KEY: cfg.google?.placesApiKey || process.env.GOOGLE_API_KEY } }
      );
    } catch (err) {
      log(`  [${project}] Scrape error: ${err.message}`);
    }
  }
}

// ── Step 2: Enrich ────────────────────────────────────────────────────────────
async function runEnrichment() {
  log('─── STEP 2: Enriching leads ───');

  for (const project of PROJECTS) {
    const leads    = loadLeads(project);
    const needsEmail = leads.filter(l =>
      !l.email && !l.enrichStatus && (l.outreachStatus === 'new' || !l.outreachStatus)
    );

    if (needsEmail.length === 0) {
      log(`  [${project}] No new leads to enrich`);
      continue;
    }

    log(`  [${project}] Enriching ${needsEmail.length} leads...`);
    if (DRY_RUN) { log('  [dry-run] skipped'); continue; }

    const enriched = await enrichBatch(needsEmail, {
      onProgress: (i, total, lead) => {
        if (i % 5 === 0 || i === total) {
          log(`  [${project}] ${i}/${total} — ${lead.enrichStatus}`);
        }
      },
    });

    // Merge enriched results back into full leads list
    const enrichedById = new Map(enriched.map(l => [l.placeId, l]));
    const updated = leads.map(l => enrichedById.get(l.placeId) || l);
    saveLeads(project, updated);

    const gotEmail = enriched.filter(l => l.email).length;
    const phoneOnly = enriched.filter(l => l.enrichStatus === 'phone-only').length;
    log(`  [${project}] Enriched: ${gotEmail} emails found, ${phoneOnly} phone-only`);
  }
}

// ── Step 3: Send email sequences ──────────────────────────────────────────────
async function runSequences() {
  log('─── STEP 3: Processing email sequences ───');

  const summary = { sent: 0, skipped: 0, errors: 0 };

  for (const project of PROJECTS) {
    const cfgPath = require('path').join(__dirname, 'projects', project, 'config.json');
    const projectConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const leads = loadLeads(project);
    const queue = buildQueue(leads, project, projectConfig);

    if (queue.length === 0) {
      log(`  [${project}] Nothing to send today`);
      continue;
    }

    log(`  [${project}] Queue: ${queue.map(j => `Day ${j.day}`).join(', ')}`);

    if (DRY_RUN) {
      for (const job of queue) {
        log(`  [dry-run] Would send Day ${job.day} to ${job.lead.name} <${job.lead.email}>`);
      }
      continue;
    }

    const results = await sendBatch(queue, {
      onSent: (job, result) => {
        log(`  [${project}] ✓ Day ${job.day} → ${job.lead.name} (${job.lead.email})`);
        summary.sent++;

        // Update lead status in memory
        const idx = leads.findIndex(l => l.placeId === job.lead.placeId);
        if (idx !== -1) leads[idx] = markSent(leads[idx], job.day);
      },
      onError: (job, err) => {
        log(`  [${project}] ✗ Day ${job.day} → ${job.lead.name}: ${err.message}`);
        summary.errors++;
      },
    });

    saveLeads(project, leads);
  }

  return summary;
}

// ── Step 4: Pipeline summary ──────────────────────────────────────────────────
function printSummary() {
  log('─── PIPELINE SUMMARY ───');
  const stages = ['new', 'emailed-d1', 'emailed-d4', 'emailed-d9', 'replied', 'closed', 'not-interested', 'phone-only'];

  let totalMRR = 0;

  for (const project of PROJECTS) {
    const cfgPath = require('path').join(__dirname, 'projects', project, 'config.json');
    const projectConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const leads = loadLeads(project);
    const counts = {};
    for (const s of stages) counts[s] = 0;
    for (const l of leads) {
      const s = l.outreachStatus || 'new';
      counts[s] = (counts[s] || 0) + 1;
    }
    const closed = counts['closed'] || 0;
    const mrr = closed * projectConfig.pitch.retainerMonthly;
    totalMRR += mrr;

    log(`\n  ${projectConfig.name.toUpperCase()} (${leads.length} total)`);
    for (const s of stages) {
      if (counts[s]) log(`    ${s.padEnd(16)} ${counts[s]}`);
    }
    if (mrr > 0) log(`    MRR             $${mrr}/mo`);
  }

  log(`\n  TOTAL MRR: $${totalMRR}/mo`);
}

// ── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  log(`════ Automation run started ${DRY_RUN ? '[DRY RUN] ' : ''}════`);

  try {
    if (!SKIP_SCRAPE) await runScrape();
    await runEnrichment();
    if (!SKIP_EMAIL) {
      const emailSummary = await runSequences();
      log(`\nEmails: ${emailSummary.sent} sent, ${emailSummary.errors} errors`);
    }
    printSummary();
  } catch (err) {
    log('FATAL:', err.message);
    process.exit(1);
  }

  log('════ Run complete ════\n');
})();
