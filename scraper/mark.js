/**
 * Manually update a lead's outreach status — for everything the inbox
 * watcher can't see: phone replies, in-person conversations, closes.
 *
 * Usage:
 *   node scraper/mark.js --project roofers --find "bob" --status replied
 *   node scraper/mark.js --project auto-repair --find "+15125550100" --status closed
 *   node scraper/mark.js --project electricians --find "smith" --note "Call back Tuesday"
 *   node scraper/mark.js --project roofers --find "bob"            # just show matches
 *
 * --find matches against name, email, phone, or placeId (case-insensitive
 * substring). If it matches more than one lead, all matches are listed and
 * nothing is changed — narrow the search and re-run.
 *
 * Valid statuses: new, replied, closed, not-interested, phone-only, unsubscribed
 */

'use strict';

const { loadLeads, saveLeads } = require('./automation/sequences');

const VALID_STATUSES = new Set([
  'new', 'replied', 'closed', 'not-interested', 'phone-only', 'unsubscribed',
]);

const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

const project = getArg('--project');
const find    = getArg('--find');
const status  = getArg('--status');
const note    = getArg('--note');

if (!project || !find) {
  console.error('Usage: node scraper/mark.js --project <slug> --find <text> [--status <status>] [--note <text>]');
  process.exit(1);
}
if (status && !VALID_STATUSES.has(status)) {
  console.error(`Invalid status "${status}". Valid: ${[...VALID_STATUSES].join(', ')}`);
  process.exit(1);
}

const leads = loadLeads(project);
if (leads.length === 0) {
  console.error(`No leads found for project "${project}".`);
  process.exit(1);
}

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

const show = ({ lead }) => {
  console.log(`  ${lead.name}`);
  console.log(`    ${lead.address || '(no address)'}`);
  console.log(`    ${lead.phone || '(no phone)'}  |  ${lead.email || '(no email)'}  |  Status: ${lead.outreachStatus || 'new'}`);
  if (lead.notes) console.log(`    Notes: ${lead.notes}`);
};

if (matches.length > 1) {
  console.log(`\n"${find}" matches ${matches.length} leads in ${project} — narrow the search:\n`);
  matches.forEach(show);
  console.log('');
  process.exit(1);
}

const { lead, idx } = matches[0];

if (!status && !note) {
  console.log('');
  show(matches[0]);
  console.log('');
  process.exit(0);
}

const updated = { ...lead };
if (status) {
  updated.outreachStatus = status;
  updated[`${status.replace(/-/g, '')}At`] = new Date().toISOString();
}
if (note) {
  updated.notes = [updated.notes, note].filter(Boolean).join(' | ');
}

leads[idx] = updated;
saveLeads(project, leads);

console.log(`\n✓ ${lead.name}: ${lead.outreachStatus || 'new'} → ${updated.outreachStatus || lead.outreachStatus || 'new'}${note ? `  (note added)` : ''}\n`);

if (status === 'closed') {
  console.log(`Next: onboard them as a client →`);
  console.log(`  node scraper/onboard.js --project ${project} --find "${find}" --email <their-email>\n`);
}
