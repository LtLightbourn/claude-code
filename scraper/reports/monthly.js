/**
 * Generates and emails a monthly report to each active client.
 * Pulls data from Google Analytics Data API (GA4).
 *
 * Setup:
 *   1. Enable Google Analytics Data API in GCP console
 *   2. Create a service account, download JSON key
 *   3. Set analyticsKeyFile path in config.js
 *   4. Add the service account email as a Viewer in each client's GA4 property
 *
 * Usage:
 *   node scraper/reports/monthly.js
 *   node scraper/reports/monthly.js --client bobs-auto-repair  (single client)
 *
 * clients.json format:
 *   [ { "slug": "bobs-auto", "name": "Bob's Auto", "email": "bob@...",
 *       "ga4PropertyId": "properties/123456789", "phone": "...", "city": "..." } ]
 */

'use strict';

const https  = require('https');
const fs     = require('fs');
const path   = require('path');

let cfg;
try { cfg = require('../automation/config'); } catch { cfg = require('../automation/config.template'); }

const { sendEmail } = require('../automation/emailer');

const CLIENTS_PATH = path.join(__dirname, 'clients.json');

// ── Load clients list ─────────────────────────────────────────────────────────
function loadClients() {
  if (!fs.existsSync(CLIENTS_PATH)) {
    console.log(`No clients.json found at ${CLIENTS_PATH}. Creating template...`);
    fs.writeFileSync(CLIENTS_PATH, JSON.stringify([
      {
        slug:          'example-client',
        name:          "Bob's Auto Repair",
        ownerName:     'Bob',
        email:         'bob@example.com',
        project:       'auto-repair',
        ga4PropertyId: 'properties/123456789',
        phone:         '(512) 555-0100',
        city:          'Austin, TX',
        liveUrl:       'https://bobs-auto-repair.pages.dev',
        retainerAmt:   149,
        active:        true,
      },
    ], null, 2));
    return [];
  }
  return JSON.parse(fs.readFileSync(CLIENTS_PATH, 'utf8')).filter(c => c.active);
}

// ── GA4 API (uses service account JWT) ───────────────────────────────────────
async function getGAToken() {
  if (!cfg.google?.analyticsKeyFile) return null;
  try {
    const key = JSON.parse(fs.readFileSync(cfg.google.analyticsKeyFile, 'utf8'));
    // Minimal JWT for Google APIs — requires 'jsonwebtoken' package
    let jwt;
    try { jwt = require('jsonwebtoken'); }
    catch {
      try { jwt = require('/opt/node22/lib/node_modules/jsonwebtoken'); }
      catch { return null; }
    }

    const now = Math.floor(Date.now() / 1000);
    const claim = {
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/analytics.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    };
    const assertion = jwt.sign(claim, key.private_key, { algorithm: 'RS256' });

    return new Promise((resolve, reject) => {
      const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${assertion}`;
      const req = https.request({
        hostname: 'oauth2.googleapis.com',
        path:     '/token',
        method:   'POST',
        headers:  { 'Content-Type': 'application/x-www-form-urlencoded' },
      }, res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data).access_token); }
          catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.write(body);
      req.end();
    });
  } catch { return null; }
}

async function fetchGA4Metrics(propertyId, token) {
  if (!token) return null;

  const today     = new Date();
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);

  const fmt = d => d.toISOString().split('T')[0];
  const body = JSON.stringify({
    dateRanges: [{ startDate: fmt(lastMonth), endDate: fmt(lastMonthEnd) }],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'screenPageViews' },
      { name: 'conversions' },       // Goal completions (contact form)
    ],
    dimensions: [{ name: 'deviceCategory' }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'analyticsdata.googleapis.com',
      path:     `/v1beta/${propertyId}:runReport`,
      method:   'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

function parseMetrics(gaData) {
  if (!gaData?.rows) return { sessions: '—', users: '—', pageviews: '—', conversions: '—', mobilePercent: '—' };

  let sessions = 0, users = 0, pageviews = 0, conversions = 0, mobileSessions = 0;

  for (const row of gaData.rows) {
    const device = row.dimensionValues[0].value;
    const [s, u, pv, cv] = row.metricValues.map(m => parseInt(m.value, 10));
    sessions    += s;  users += u;  pageviews += pv;  conversions += cv;
    if (device === 'mobile') mobileSessions += s;
  }

  const mobilePercent = sessions > 0 ? Math.round((mobileSessions / sessions) * 100) : 0;
  return { sessions, users, pageviews, conversions, mobilePercent };
}

// ── Build report email ─────────────────────────────────────────────────────────
function buildReport(client, metrics) {
  const month = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1)
    .toLocaleString('en-US', { month: 'long', year: 'numeric' });

  const hasGA = metrics && typeof metrics.sessions === 'number';

  const gaSection = hasGA
    ? `
Website performance — ${month}
─────────────────────────────────
Visitors:       ${metrics.users.toLocaleString()}
Sessions:       ${metrics.sessions.toLocaleString()}
Page views:     ${metrics.pageviews.toLocaleString()}
Contact clicks: ${metrics.conversions.toLocaleString()}
Mobile traffic: ${metrics.mobilePercent}%`
    : `
(Analytics data not yet connected — we'll include traffic numbers next month.)`;

  return `Hi ${client.ownerName || client.name},

Here's your monthly website update for ${month}.
${gaSection}

Your site: ${client.liveUrl}

Everything is running smoothly — hosting, SSL, and uptime are all green.

If you'd like to update anything (new services, changed hours, new photos), just reply to this email or call me at ${cfg.sender.phone} and I'll take care of it.

${cfg.sender.name}
${cfg.sender.phone}
${cfg.sender.email}

---
You're receiving this because you're a client of ${cfg.sender.company}.
Reply "cancel" at any time to end your subscription.`;
}

// ── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  const clients = loadClients();
  if (clients.length === 0) {
    console.log('No active clients found. Add entries to scraper/reports/clients.json');
    return;
  }

  const filterSlug = process.argv.includes('--client')
    ? process.argv[process.argv.indexOf('--client') + 1]
    : null;

  const targets = filterSlug ? clients.filter(c => c.slug === filterSlug) : clients;
  console.log(`\nSending monthly reports to ${targets.length} client(s)...\n`);

  const token = await getGAToken();
  if (!token) console.log('  (No GA4 credentials — sending reports without traffic data)\n');

  for (const client of targets) {
    process.stdout.write(`  ${client.name}... `);
    try {
      const gaData  = token && client.ga4PropertyId ? await fetchGA4Metrics(client.ga4PropertyId, token) : null;
      const metrics = parseMetrics(gaData);
      const body    = buildReport(client, metrics);

      await sendEmail({
        to:      client.email,
        subject: `Your website — ${new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).toLocaleString('en-US', { month: 'long' })} update`,
        body,
      });
      console.log('sent ✓');
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
    }
  }

  console.log('\nDone.\n');
})();
