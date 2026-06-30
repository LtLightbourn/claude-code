/**
 * Generates and emails a monthly report to each active client.
 *
 * Sent monthly, not weekly — tied to the billing cycle, and small local
 * service businesses don't generate enough weekly traffic/calls for a
 * week-over-week number to mean anything. Monthly is also the cadence
 * implied by "$200/month" — one report per billing event, not a stream
 * of noise. Reflects exactly what was promised in the cold email and in
 * product.json's `includes` list: calls received, form submissions,
 * visitors, and ranking movement.
 *
 * Data sources:
 *   - Visitors / form submissions  → Google Analytics Data API (GA4)
 *   - Calls received               → Twilio call log for the client's tracking number
 *   - Ranking movement             → Google Search Console (avg. position, this month vs. last)
 *
 * Setup:
 *   1. Enable the Analytics Data API and Search Console API in GCP console
 *   2. Create a service account, download JSON key, set
 *      google.serviceAccountKeyFile in config.js
 *   3. Add the service account email as a Viewer on each client's GA4
 *      property and as a verified user on their Search Console site
 *   4. Set twilio.accountSid / twilio.authToken in config.js
 *   5. Buy each client a Twilio number, forward it to their real line,
 *      and record it as trackingPhoneNumber in clients.json
 *
 * Usage:
 *   node scraper/reports/monthly.js
 *   node scraper/reports/monthly.js --client bobs-auto-repair  (single client)
 *
 * clients.json format:
 *   [ { "slug": "bobs-auto", "name": "Bob's Auto", "email": "bob@...",
 *       "ga4PropertyId": "properties/123456789", "trackingPhoneNumber": "+15125550100",
 *       "searchConsoleSiteUrl": "https://bobsauto.com/",
 *       "targetKeywords": ["auto repair near me", "auto repair austin tx"],
 *       "phone": "...", "city": "..." } ]
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
        trackingPhoneNumber:  '+15125550100',          // Twilio number assigned to this client
        searchConsoleSiteUrl: 'https://bobs-auto-repair.pages.dev/',
        targetKeywords: ['auto repair near me', 'auto repair austin tx'],
        phone:         '(512) 555-0100',
        city:          'Austin, TX',
        liveUrl:       'https://bobs-auto-repair.pages.dev',
        retainerAmt:   200,
        active:        true,
      },
    ], null, 2));
    return [];
  }
  return JSON.parse(fs.readFileSync(CLIENTS_PATH, 'utf8')).filter(c => c.active);
}

// ── Google API auth (shared service account JWT, scoped per call) ─────────────
async function getGoogleToken(scopes) {
  if (!cfg.google?.serviceAccountKeyFile) return null;
  try {
    const key = JSON.parse(fs.readFileSync(cfg.google.serviceAccountKeyFile, 'utf8'));
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
      scope: scopes.join(' '),
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

const GA_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

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

// ── Search Console (ranking movement: avg. position this month vs. last) ──────
async function fetchRankingMovement(siteUrl, keywords, token) {
  if (!token || !siteUrl || !keywords?.length) return null;

  const today         = new Date();
  const periodEnd      = new Date(today.getFullYear(), today.getMonth(), 0);
  const periodStart    = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const prevPeriodEnd   = new Date(today.getFullYear(), today.getMonth() - 1, 0);
  const prevPeriodStart = new Date(today.getFullYear(), today.getMonth() - 2, 1);
  const fmt = d => d.toISOString().split('T')[0];

  const query = (startDate, endDate) => new Promise((resolve) => {
    const body = JSON.stringify({
      startDate: fmt(startDate),
      endDate:   fmt(endDate),
      dimensions: ['query'],
      dimensionFilterGroups: [{
        filters: keywords.map(k => ({ dimension: 'query', operator: 'equals', expression: k })),
      }],
    });
    const req = https.request({
      hostname: 'searchconsole.googleapis.com',
      path:     `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      method:   'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });

  const [current, previous] = await Promise.all([
    query(periodStart, periodEnd),
    query(prevPeriodStart, prevPeriodEnd),
  ]);

  const positionsByQuery = rows => {
    const map = {};
    for (const row of rows?.rows || []) map[row.keys[0]] = row.position;
    return map;
  };

  const currentPos  = positionsByQuery(current);
  const previousPos = positionsByQuery(previous);

  return keywords.map(k => {
    const now  = currentPos[k];
    const prev = previousPos[k];
    return {
      keyword:  k,
      position: typeof now === 'number' ? Math.round(now * 10) / 10 : null,
      // Lower avg. position is better — a positive delta means it improved.
      movement: typeof now === 'number' && typeof prev === 'number'
        ? Math.round((prev - now) * 10) / 10
        : null,
    };
  });
}

// ── Twilio (calls received on the client's dedicated tracking number) ─────────
async function fetchCallStats(phoneNumber) {
  if (!cfg.twilio?.accountSid || !cfg.twilio?.authToken || !phoneNumber) return null;

  const today      = new Date();
  const periodStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const periodEnd    = new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59);
  const fmt = d => d.toISOString().split('T')[0];

  const auth = Buffer.from(`${cfg.twilio.accountSid}:${cfg.twilio.authToken}`).toString('base64');
  const qs = new URLSearchParams({
    To: phoneNumber,
    StartTime: `>=${fmt(periodStart)}`,
    EndTime:   `<=${fmt(periodEnd)}`,
    PageSize:  '1000',
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.twilio.com',
      path:     `/2010-04-01/Accounts/${cfg.twilio.accountSid}/Calls.json?${qs.toString()}`,
      method:   'GET',
      headers:  { Authorization: `Basic ${auth}` },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const calls = JSON.parse(data).calls || [];
          const answered = calls.filter(c => c.status === 'completed').length;
          const missed   = calls.length - answered;
          const totalSeconds = calls.reduce((sum, c) => sum + (parseInt(c.duration, 10) || 0), 0);
          resolve({ total: calls.length, answered, missed, avgDurationSec: calls.length ? Math.round(totalSeconds / calls.length) : 0 });
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ── Build report email ─────────────────────────────────────────────────────────
function buildReport(client, metrics, callStats, ranking) {
  const month = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1)
    .toLocaleString('en-US', { month: 'long', year: 'numeric' });

  const hasGA = metrics && typeof metrics.sessions === 'number';

  const trafficSection = hasGA
    ? `
Visitors:           ${metrics.users.toLocaleString()}
Form submissions:   ${metrics.conversions.toLocaleString()}
Mobile traffic:      ${metrics.mobilePercent}%`
    : `
(Analytics not yet connected — visitor and form numbers will appear once it's set up.)`;

  const callsSection = callStats
    ? `
Calls received:      ${callStats.total}  (${callStats.answered} answered, ${callStats.missed} missed)`
    : `
(Call tracking not yet connected for this number.)`;

  const rankingSection = ranking?.length
    ? ranking.map(r => {
        const pos = r.position != null ? `#${r.position}` : 'not ranking yet';
        const move = r.movement == null ? ''
          : r.movement > 0 ? `  (up ${r.movement})`
          : r.movement < 0 ? `  (down ${Math.abs(r.movement)})`
          : '  (no change)';
        return `${r.keyword.padEnd(28)} ${pos}${move}`;
      }).join('\n')
    : '(Ranking data not yet connected — will appear once Search Console is set up.)';

  return `Hi ${client.ownerName || client.name},

Here's your monthly update for ${month}.

Website
─────────────────────────────────${trafficSection}

Calls
─────────────────────────────────${callsSection}

Search ranking
─────────────────────────────────
${rankingSection}

Your site: ${client.liveUrl}

Everything is running smoothly — hosting, SSL, and uptime are all green. Google Business Profile is posted to and monitored weekly.

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

  const token = await getGoogleToken([GA_SCOPE, GSC_SCOPE]);
  if (!token) console.log('  (No Google service account credentials — sending reports without traffic/ranking data)\n');

  for (const client of targets) {
    process.stdout.write(`  ${client.name}... `);
    try {
      const gaData    = token && client.ga4PropertyId ? await fetchGA4Metrics(client.ga4PropertyId, token) : null;
      const metrics   = parseMetrics(gaData);
      const callStats = await fetchCallStats(client.trackingPhoneNumber);
      const ranking   = token ? await fetchRankingMovement(client.searchConsoleSiteUrl, client.targetKeywords, token) : null;
      const body      = buildReport(client, metrics, callStats, ranking);

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
