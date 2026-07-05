/**
 * Client onboarding — turns a closed lead into a paying client.
 *
 * One command does the bookkeeping that connects the three halves of the
 * system: the lead database (outreach), the deploy config (fulfillment),
 * and clients.json (monthly reporting + billing).
 *
 * What it does:
 *   1. Finds the lead and marks it closed (if it isn't already)
 *   2. Writes scraper/clients/<slug>.json — the deploy config for
 *      scraper/deploy/cloudflare.js, prefilled from the lead record
 *   3. Adds the client to scraper/reports/clients.json so they get
 *      monthly reports
 *   4. Prints the go-live checklist (deploy, GA4, Search Console, Twilio)
 *
 * Usage:
 *   node scraper/onboard.js --project auto-repair --find "bob" --email bob@gmail.com
 *
 * Options:
 *   --project   Project slug (auto-repair | roofers | electricians)   [required]
 *   --find      Lead search: name/email/phone/placeId substring        [required]
 *   --email     Client's email — for reports and contact-form leads
 *   --owner     Owner's first name (used in report greeting)
 *   --domain    Their own domain, if they have one (else <slug>.pages.dev)
 *   --services  Pipe-separated service list (else niche defaults)
 *   --tagline   Hero tagline (else generated)
 *   --color     Primary brand color hex (else niche default)
 *   --deploy    Also build + deploy the site right now
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { loadLeads, saveLeads } = require('./automation/sequences');
const { listProjects, loadProjectConfig } = require('./automation/projects');

const CLIENTS_DIR          = path.join(__dirname, 'clients');
const REPORT_CLIENTS_PATH  = path.join(__dirname, 'reports', 'clients.json');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

const project = getArg('--project');
const find    = getArg('--find');

if (!project || !find || !listProjects().includes(project)) {
  console.error(`Usage: node scraper/onboard.js --project <slug> --find <text> [--email ...] [--deploy]`);
  console.error(`Projects: ${listProjects().join(', ')}`);
  process.exit(1);
}

// ── Find the lead ─────────────────────────────────────────────────────────────
const leads   = loadLeads(project);
const needle  = find.toLowerCase();
const matches = leads
  .map((lead, idx) => ({ lead, idx }))
  .filter(({ lead }) =>
    [lead.name, lead.email, lead.phone, lead.placeId]
      .some(f => f && String(f).toLowerCase().includes(needle))
  );

if (matches.length === 0) {
  console.error(`No lead matching "${find}" in ${project}.`);
  process.exit(1);
}
if (matches.length > 1) {
  console.error(`"${find}" matches ${matches.length} leads — narrow the search:`);
  matches.forEach(({ lead }) => console.error(`  ${lead.name}  (${lead.phone || 'no phone'})`));
  process.exit(1);
}

const { lead, idx } = matches[0];

// ── Derive client fields from the lead ────────────────────────────────────────
const slug = lead.name
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

// lead.location is the searched city ("Austin, TX"); fall back to the address
const locParts = (lead.location || '').split(',').map(s => s.trim());
const city  = locParts[0] || (lead.address || '').split(',').slice(-3, -2)[0]?.trim() || '';
const state = locParts[1] || '';

// Niche defaults come from the project's config.json `site` block — adding a
// new industry needs no code changes here
const projectConfig = loadProjectConfig(project);
const site = projectConfig.site || {};
const defaults = {
  services:   site.services   || ['General Service', 'Repairs', 'Installations', 'Free Estimates'],
  color:      site.color      || '#1a3c5e',
  keyword:    site.keyword    || projectConfig.name.toLowerCase(),
  schemaType: site.schemaType || 'LocalBusiness',
};

const email  = getArg('--email')  || lead.email || '';
const domain = getArg('--domain') || '';
const liveUrl = domain ? `https://${domain}` : `https://${slug}.pages.dev`;

const clientConfig = {
  slug,
  name:         lead.name,
  ...(domain ? { domain } : {}),
  project,
  phone:        lead.phone || '',
  address:      lead.address || '',
  services:     getArg('--services')?.split('|').map(s => s.trim()) || defaults.services,
  city,
  state,
  hours:        'Mon–Fri 8am–6pm',
  tagline:      getArg('--tagline') || `${city}'s trusted ${defaults.keyword} — call today for a free quote.`,
  colorPrimary: getArg('--color') || defaults.color,
  schemaType:   defaults.schemaType,   // JSON-LD @type for local SEO
  nicheLabel:   projectConfig.name,    // Human label for titles/meta
  analyticsId:     '',   // Fill in after creating the GA4 property
  gscVerification: '',   // Fill in after adding the site to Search Console
  email,
};

// ── 1. Mark the lead closed ───────────────────────────────────────────────────
if ((lead.outreachStatus || 'new') !== 'closed') {
  leads[idx] = { ...lead, outreachStatus: 'closed', closedAt: new Date().toISOString() };
  saveLeads(project, leads);
  console.log(`\n✓ Lead marked closed: ${lead.name}`);
} else {
  console.log(`\n✓ Lead already closed: ${lead.name}`);
}

// ── 2. Write the deploy config ────────────────────────────────────────────────
if (!fs.existsSync(CLIENTS_DIR)) fs.mkdirSync(CLIENTS_DIR, { recursive: true });
const clientPath = path.join(CLIENTS_DIR, `${slug}.json`);
fs.writeFileSync(clientPath, JSON.stringify(clientConfig, null, 2));
console.log(`✓ Deploy config: ${clientPath}`);

// ── 3. Register for monthly reports ───────────────────────────────────────────
let reportClients = [];
if (fs.existsSync(REPORT_CLIENTS_PATH)) {
  try { reportClients = JSON.parse(fs.readFileSync(REPORT_CLIENTS_PATH, 'utf8')); }
  catch { reportClients = []; }
}
// Drop the template placeholder entry if it's still there
reportClients = reportClients.filter(c => c.slug !== 'example-client');

const existing = reportClients.findIndex(c => c.slug === slug);
const reportEntry = {
  slug,
  name:          lead.name,
  ownerName:     getArg('--owner') || lead.ownerName || '',
  email,
  project,
  ga4PropertyId:        '',   // 'properties/123456789' once GA4 is set up
  trackingPhoneNumber:  '',   // Twilio number once purchased
  searchConsoleSiteUrl: `${liveUrl}/`,
  targetKeywords: [
    `${defaults.keyword} near me`,
    `${defaults.keyword} ${city.toLowerCase()}${state ? ' ' + state.toLowerCase() : ''}`.trim(),
  ],
  phone:       lead.phone || '',
  city:        [city, state].filter(Boolean).join(', '),
  liveUrl,
  retainerAmt: projectConfig.pitch.retainerMonthly,
  active:      true,
};
if (existing !== -1) reportClients[existing] = { ...reportClients[existing], ...reportEntry };
else reportClients.push(reportEntry);

fs.writeFileSync(REPORT_CLIENTS_PATH, JSON.stringify(reportClients, null, 2));
console.log(`✓ Added to monthly reports: ${REPORT_CLIENTS_PATH}`);

// ── 4. Deploy now, or print the checklist ─────────────────────────────────────
const deployCmd = `node scraper/deploy/cloudflare.js --client "${clientPath}"`;

console.log(`\n── Go-live checklist ──────────────────────────────────────────`);
console.log(`  1. Deploy the site:        ${getArg('--deploy') !== null ? '(running now)' : deployCmd}`);
console.log(`  2. GA4: create property at analytics.google.com, put the`);
console.log(`     G-XXXX id in ${path.relative(process.cwd(), clientPath)} (analyticsId),`);
console.log(`     the property id in reports/clients.json (ga4PropertyId), redeploy`);
console.log(`  3. Search Console: add ${liveUrl}, put the verification`);
console.log(`     token in gscVerification, redeploy, then grant the service`);
console.log(`     account access`);
console.log(`  4. Twilio: buy a local number, forward it to ${lead.phone || 'their line'},`);
console.log(`     record it as trackingPhoneNumber in reports/clients.json,`);
console.log(`     and use it as {{PHONE}} on the site so calls are tracked`);
console.log(`  5. First monthly report goes out on the 1st automatically\n`);

if (args.includes('--deploy')) {
  const { deploy } = require('./deploy/cloudflare');
  deploy(clientConfig).catch(err => {
    console.error('Deploy failed:', err.message);
    process.exit(1);
  });
}
