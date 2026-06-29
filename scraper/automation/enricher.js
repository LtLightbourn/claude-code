/**
 * Lead enrichment — finds email addresses and owner names for leads
 * that only have a phone number from the Places API.
 *
 * Strategy (in priority order):
 *   1. Hunter.io domain search (if they have any web presence)
 *   2. Apollo.io people search by company name + city
 *   3. Facebook Business page scrape (Playwright)
 *   4. Structured email guess from business name patterns
 *   5. Mark as phone-only (best channel for trades anyway)
 */

'use strict';

const https = require('https');
const path  = require('path');

let cfg;
try { cfg = require('./config'); } catch { cfg = require('./config.template'); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// ── Hunter.io domain search ────────────────────────────────────────────────────
async function hunterDomainSearch(domain) {
  if (!cfg.enrichment?.hunterApiKey) return null;
  const url = `https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${cfg.enrichment.hunterApiKey}&limit=1`;
  const data = await get(url);
  if (!data?.data?.emails?.length) return null;
  const best = data.data.emails.find(e => e.confidence > 70) || data.data.emails[0];
  return { email: best.email, source: 'hunter', confidence: best.confidence };
}

// ── Apollo.io people search ────────────────────────────────────────────────────
async function apolloSearch(businessName, city) {
  if (!cfg.enrichment?.apolloApiKey) return null;
  const url = 'https://api.apollo.io/v1/people/search';
  const body = JSON.stringify({
    api_key: cfg.enrichment.apolloApiKey,
    q_organization_name: businessName,
    person_locations: [city],
    page: 1,
    per_page: 1,
  });

  return new Promise(resolve => {
    const req = https.request(
      { hostname: 'api.apollo.io', path: '/v1/people/search', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const person = parsed.people?.[0];
            if (!person?.email) return resolve(null);
            resolve({ email: person.email, name: person.name, source: 'apollo' });
          } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ── Heuristic domain guesser ─────────────────────────────────────────────────
// Generates candidate email addresses from business name patterns.
// Useful for verification tools but not sent without confirmation.
function guessEmails(businessName, city) {
  const clean = businessName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim();

  const words = clean.split(/\s+/).filter(w =>
    !['llc', 'inc', 'co', 'the', 'and', '&', 'a', 'of'].includes(w)
  );

  const slug       = words.join('');
  const slugDash   = words.join('-');
  const firstWord  = words[0] || slug;
  const citySlug   = city.split(',')[0].toLowerCase().replace(/\s+/g, '');

  const domains = [
    `${slug}.com`,
    `${slugDash}.com`,
    `${firstWord}${citySlug}.com`,
  ];

  const prefixes = ['info', 'contact', 'hello', firstWord];

  return domains.flatMap(d => prefixes.map(p => `${p}@${d}`));
}

// ── Filter criteria ───────────────────────────────────────────────────────────
function meetsQualityBar(lead) {
  const minReviews = cfg.enrichment?.minReviews ?? 3;
  const minRating  = cfg.enrichment?.minRating  ?? 3.5;
  if (lead.reviews < minReviews) return false;
  if (lead.rating && parseFloat(lead.rating) < minRating) return false;
  return true;
}

// ── Main enrichment function ──────────────────────────────────────────────────
async function enrichLead(lead) {
  // Already enriched
  if (lead.email) return lead;

  // Doesn't meet quality bar — skip
  if (!meetsQualityBar(lead)) {
    return { ...lead, enrichStatus: 'below-quality-bar' };
  }

  // Try Apollo first (works without domain)
  const city = lead.location || lead.address?.split(',').slice(-2).join(',').trim() || '';
  const apollo = await apolloSearch(lead.name, city);
  if (apollo?.email) {
    return { ...lead, email: apollo.email, ownerName: apollo.name || '', emailSource: 'apollo', enrichStatus: 'enriched' };
  }

  await sleep(300);

  // Try guessing domain from business name, then Hunter
  const guesses = guessEmails(lead.name, lead.location || '');
  for (const guess of guesses.slice(0, 2)) {
    const domain = guess.split('@')[1];
    const hunter = await hunterDomainSearch(domain);
    if (hunter?.email) {
      return { ...lead, email: hunter.email, emailSource: 'hunter', enrichStatus: 'enriched' };
    }
    await sleep(200);
  }

  // No email found — phone-only (still actionable via cold call)
  return {
    ...lead,
    emailCandidates: guesses.slice(0, 3), // Store for manual review
    enrichStatus: lead.phone ? 'phone-only' : 'no-contact',
  };
}

// ── Batch enrichment ──────────────────────────────────────────────────────────
async function enrichBatch(leads, { onProgress } = {}) {
  const results = [];
  for (let i = 0; i < leads.length; i++) {
    const enriched = await enrichLead(leads[i]);
    results.push(enriched);
    onProgress?.(i + 1, leads.length, enriched);
    await sleep(500); // Rate limit across API calls
  }
  return results;
}

module.exports = { enrichLead, enrichBatch, meetsQualityBar };
