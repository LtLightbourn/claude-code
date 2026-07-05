/**
 * Outreach sequence state machine.
 * Determines which leads need which email today and updates their status.
 *
 * State transitions:
 *   new (+ has email)  → [send Day 1] → emailed-d1
 *   emailed-d1 (4d+)  → [send Day 4] → emailed-d4
 *   emailed-d4 (5d+)  → [send Day 9] → emailed-d9  (sequence complete)
 *   any state          ← 'replied' / 'closed' / 'not-interested' (stop sequence)
 *
 * Terminal states (no more emails): replied, closed, not-interested,
 *                                   emailed-d9, phone-only, unsubscribed
 */

'use strict';

const fs   = require('fs');
const path = require('path');

let cfg;
try { cfg = require('./config'); } catch { cfg = require('./config.template'); }

const TERMINAL_STATES = new Set([
  'replied', 'closed', 'not-interested', 'emailed-d9',
  'phone-only', 'unsubscribed', 'below-quality-bar', 'no-contact',
]);

const SEQ_DAYS = cfg.sequence ?? { day4DelayDays: 4, day9DelayDays: 9 };

function daysSince(isoDate) {
  if (!isoDate) return 999;
  return (Date.now() - new Date(isoDate).getTime()) / 86_400_000;
}

// ── Classify what action a lead needs today ───────────────────────────────────
function classifyLead(lead) {
  const status = lead.outreachStatus || 'new';

  if (TERMINAL_STATES.has(status)) return null;

  // New lead with email — send Day 1
  if (status === 'new' && lead.email && lead.enrichStatus !== 'below-quality-bar') {
    return { day: 1, reason: 'new lead with email' };
  }

  // Day 4 follow-up
  if (status === 'emailed-d1' && daysSince(lead.d1SentAt) >= SEQ_DAYS.day4DelayDays) {
    return { day: 4, reason: `${Math.floor(daysSince(lead.d1SentAt))}d since Day 1` };
  }

  // Day 9 final email
  if (status === 'emailed-d4' && daysSince(lead.d1SentAt) >= SEQ_DAYS.day9DelayDays) {
    return { day: 9, reason: `${Math.floor(daysSince(lead.d1SentAt))}d since Day 1` };
  }

  return null;
}

// ── Mark a lead as sent ───────────────────────────────────────────────────────
function markSent(lead, day) {
  const now = new Date().toISOString();
  const updated = { ...lead };

  if (day === 1) {
    updated.outreachStatus = 'emailed-d1';
    updated.d1SentAt = now;
  } else if (day === 4) {
    updated.outreachStatus = 'emailed-d4';
    updated.d4SentAt = now;
  } else if (day === 9) {
    updated.outreachStatus = 'emailed-d9';
    updated.d9SentAt = now;
  }

  return updated;
}

// ── Mark as unsubscribed (called when reply contains "unsubscribe") ───────────
function markUnsubscribed(lead) {
  return { ...lead, outreachStatus: 'unsubscribed', unsubscribedAt: new Date().toISOString() };
}

// ── Build today's send queue for a project ────────────────────────────────────
function buildQueue(leads, projectSlug, projectConfig) {
  const perDay  = cfg.emailLimits?.perProjectPerDay ?? 30;
  const byDay   = { 1: [], 4: [], 9: [] };

  for (const lead of leads) {
    const action = classifyLead(lead);
    if (action) byDay[action.day].push({ lead, ...action, projectSlug, projectConfig });
  }

  // Prioritise Day 9 > Day 4 > Day 1 (honour commitments before new contacts)
  const ordered = [...byDay[9], ...byDay[4], ...byDay[1]];
  return ordered.slice(0, perDay);
}

// ── Persist updated leads back to disk ───────────────────────────────────────
function saveLeads(projectSlug, leads) {
  const leadsPath = path.join(__dirname, '..', 'projects', projectSlug, 'leads.json');
  const csvPath   = path.join(__dirname, '..', 'projects', projectSlug, 'leads.csv');

  fs.writeFileSync(leadsPath, JSON.stringify(leads, null, 2));

  // Rebuild CSV
  const headers = [
    'name', 'address', 'phone', 'email', 'rating', 'reviews',
    'outreachStatus', 'd1SentAt', 'd4SentAt', 'd9SentAt',
    'enrichStatus', 'location', 'mapsUrl', 'notes',
  ];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [
    headers.join(','),
    ...leads.map(r => headers.map(h => esc(r[h])).join(',')),
  ].join('\n');
  fs.writeFileSync(csvPath, csv);
}

// ── Load leads for a project ──────────────────────────────────────────────────
function loadLeads(projectSlug) {
  const p = path.join(__dirname, '..', 'projects', projectSlug, 'leads.json');
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return []; }
}

module.exports = { classifyLead, markSent, markUnsubscribed, buildQueue, saveLeads, loadLeads };
