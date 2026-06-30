/**
 * Prints a live dashboard of all 3 project lead databases.
 *
 * Usage:
 *   node scraper/status.js
 *   node scraper/status.js --project roofers   (single project detail)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const PROJECTS = ['auto-repair', 'roofers', 'electricians'];

const args = process.argv.slice(2);
const filterProject = args.includes('--project') ? args[args.indexOf('--project') + 1] : null;

const OUTREACH_STAGES = [
  'new', 'emailed-d1', 'emailed-d4', 'emailed-d9', 'replied', 'closed',
  'not-interested', 'phone-only', 'unsubscribed', 'below-quality-bar', 'no-contact',
];

function loadProject(slug) {
  const dir       = path.join(__dirname, 'projects', slug);
  const leadsPath = path.join(dir, 'leads.json');
  const config    = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));

  if (!fs.existsSync(leadsPath)) return { config, leads: [], counts: {} };

  const leads = JSON.parse(fs.readFileSync(leadsPath, 'utf8'));

  const counts = {};
  for (const stage of OUTREACH_STAGES) counts[stage] = 0;
  for (const lead of leads) {
    const s = lead.outreachStatus || 'new';
    counts[s] = (counts[s] || 0) + 1;
  }

  const locations = [...new Set(leads.map(l => l.location))];

  return { config, leads, counts, locations };
}

function bar(n, total, width = 20) {
  if (total === 0) return '[' + ' '.repeat(width) + ']';
  const filled = Math.round((n / total) * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

// ── Summary view (all 3 projects) ─────────────────────────────────────────────
function printSummary() {
  console.log(`\n${'═'.repeat(72)}`);
  console.log('  LEAD DATABASE STATUS');
  console.log(`${'═'.repeat(72)}\n`);

  let grandTotal = 0;
  let grandClosed = 0;

  for (const slug of PROJECTS) {
    const { config, leads, counts, locations } = loadProject(slug);
    const total  = leads.length;
    const closed = counts['closed'] || 0;
    grandTotal  += total;
    grandClosed += closed;

    console.log(`  ▶ ${config.name.toUpperCase()}`);
    console.log(`    Total leads    : ${total}`);
    console.log(`    Locations      : ${locations?.join(', ') || 'none yet'}`);
    console.log(`    Retainer price : $${config.pitch.retainerMonthly}/mo  |  Setup: $${config.pitch.setupFee}`);
    console.log('');
    console.log(`    Outreach pipeline:`);

    for (const stage of OUTREACH_STAGES) {
      const n = counts[stage] || 0;
      if (total === 0 && n === 0) continue;
      const pct = total > 0 ? Math.round((n / total) * 100) : 0;
      console.log(`      ${stage.padEnd(14)} ${String(n).padStart(4)}  ${bar(n, total, 16)}  ${pct}%`);
    }

    const mrrPotential = (counts['closed'] || 0) * config.pitch.retainerMonthly;
    if (mrrPotential > 0) {
      console.log(`\n    MRR from closed : $${mrrPotential}/mo`);
    }
    console.log('');
  }

  const totalMrr = PROJECTS.reduce((sum, slug) => {
    const { config, counts } = loadProject(slug);
    return sum + (counts['closed'] || 0) * config.pitch.retainerMonthly;
  }, 0);

  console.log(`${'─'.repeat(72)}`);
  console.log(`  Total leads across all projects : ${grandTotal}`);
  console.log(`  Total clients closed            : ${grandClosed}`);
  console.log(`  Total MRR                       : $${totalMrr}/mo`);
  console.log(`${'═'.repeat(72)}\n`);
}

// ── Detail view (single project) ──────────────────────────────────────────────
function printDetail(slug) {
  const { config, leads, counts } = loadProject(slug);

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  ${config.name.toUpperCase()} — LEAD DETAIL`);
  console.log(`${'═'.repeat(72)}\n`);

  const statusFilter = process.argv.includes('--status')
    ? process.argv[process.argv.indexOf('--status') + 1]
    : null;

  const filtered = statusFilter
    ? leads.filter(l => (l.outreachStatus || 'new') === statusFilter)
    : leads;

  console.log(`  Showing: ${statusFilter ? statusFilter : 'all'} (${filtered.length} leads)\n`);

  for (const lead of filtered.slice(0, 50)) {
    const status = lead.outreachStatus || 'new';
    console.log(`  ${lead.name}`);
    console.log(`    ${lead.address}`);
    console.log(`    ${lead.phone || '(no phone)'}  |  ${lead.rating ? lead.rating + '/5' : '?'}  (${lead.reviews} reviews)  |  Status: ${status}`);
    if (lead.notes) console.log(`    Note: ${lead.notes}`);
    console.log('');
  }

  if (filtered.length > 50) console.log(`  ... and ${filtered.length - 50} more\n`);

  console.log(`  CSV: ${path.join(__dirname, 'projects', slug, 'leads.csv')}\n`);
}

if (filterProject) {
  printDetail(filterProject);
} else {
  printSummary();
}
