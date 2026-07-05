/**
 * Multi-project Google Places scraper.
 * Reads a project config and appends new leads to that project's database.
 *
 * Uses Places API (New) — Text Search — rather than the legacy Nearby
 * Search/Place Details pair. Text Search (New) returns website URL, rating,
 * phone, and maps link directly in the search response, so no per-place
 * Details call is needed (fewer requests, faster runs). Requires "Places API
 * (New)" enabled in the GCP project (the legacy "Places API" is a separate
 * toggle and is NOT what this uses).
 *
 * Usage:
 *   node scraper/scrape.js --project auto-repair --location "Austin, TX"
 *   node scraper/scrape.js --project roofers     --location "Denver, CO" --radius 8000
 *   node scraper/scrape.js --project electricians --location "Chicago, IL"
 *
 * Env:
 *   GOOGLE_API_KEY  — required (Google Places API key)
 *
 * Output (per project):
 *   scraper/projects/<slug>/leads.json   — full deduplicated database
 *   scraper/projects/<slug>/leads.csv    — spreadsheet export
 *   scraper/projects/<slug>/latest.json  — results from this run only
 */

'use strict';

const https   = require('https');
const fs      = require('fs');
const path    = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const API_KEY = process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  console.error('\nMissing GOOGLE_API_KEY environment variable.');
  console.error('  export GOOGLE_API_KEY="AIza..."\n');
  process.exit(1);
}

const args = process.argv.slice(2);
function getArg(flag, def) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}

const PROJECT_SLUG = getArg('--project', null);
if (!PROJECT_SLUG) {
  console.error('\nUsage: node scraper/scrape.js --project <slug> --location "City, ST"\n');
  console.error('Available projects: auto-repair, roofers, electricians\n');
  process.exit(1);
}

const LOCATION = getArg('--location', 'Austin, TX');
const RADIUS   = parseInt(getArg('--radius', '6000'), 10);
const LIMIT    = parseInt(getArg('--limit', '60'), 10);

const PROJECT_DIR = path.join(__dirname, 'projects', PROJECT_SLUG);
const CONFIG_PATH = path.join(PROJECT_DIR, 'config.json');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`\nProject not found: ${PROJECT_SLUG}`);
  console.error(`Expected config at: ${CONFIG_PATH}\n`);
  process.exit(1);
}

const config  = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const LEADS_PATH  = path.join(PROJECT_DIR, 'leads.json');
const CSV_PATH    = path.join(PROJECT_DIR, 'leads.csv');
const LATEST_PATH = path.join(PROJECT_DIR, 'latest.json');

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error: ${body.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function postJson(url, payload, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-Goog-Api-Key': API_KEY,
        ...extraHeaders,
      },
    }, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body || '{}') }); }
        catch { reject(new Error(`JSON parse error: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function toCsv(records) {
  const headers = [
    'name', 'types', 'address', 'phone', 'rating', 'reviews',
    'mapsUrl', 'placeId', 'location', 'scrapedAt', 'outreachStatus'
  ];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [
    headers.join(','),
    ...records.map(r => headers.map(h => esc(r[h])).join(',')),
  ].join('\n');
}

function loadLeads() {
  if (!fs.existsSync(LEADS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(LEADS_PATH, 'utf8')); }
  catch { return []; }
}

// ── API calls ─────────────────────────────────────────────────────────────────
async function geocode(address) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${API_KEY}`;
  const data = await get(url);
  if (data.status !== 'OK') throw new Error(`Geocode failed: ${data.status} — ${data.error_message || ''}`);
  const { lat, lng } = data.results[0].geometry.location;
  return { lat, lng, formatted: data.results[0].formatted_address };
}

const SEARCH_URL  = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK  = [
  'places.id', 'places.displayName', 'places.formattedAddress',
  'places.nationalPhoneNumber', 'places.internationalPhoneNumber',
  'places.rating', 'places.userRatingCount', 'places.websiteUri',
  'places.googleMapsUri', 'places.types', 'nextPageToken',
].join(',');

// Text Search (New) can keep returning a nextPageToken even as result counts
// thin out — locationBias is a soft hint, not a hard filter, so a broad
// keyword can paginate across a much wider area than intended. Cap pages
// (matching the legacy API's 3-page/60-result ceiling) and stop once a page
// adds nothing new, rather than trusting nextPageToken alone.
const MAX_PAGES = 3;

async function textSearch(lat, lng, keyword) {
  const places = [];
  let pageToken = null;
  let page = 0;

  do {
    const body = {
      textQuery: keyword,
      locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: RADIUS } },
      pageSize: 20,
      ...(pageToken ? { pageToken } : {}),
    };
    const { status, data } = await postJson(SEARCH_URL, body, { 'X-Goog-FieldMask': FIELD_MASK });
    if (status !== 200)
      throw new Error(`Text search: ${data.error?.status || status} — ${data.error?.message || ''}`);

    page++;
    const gotThisPage = (data.places || []).length;
    places.push(...(data.places || []));

    pageToken = data.nextPageToken && gotThisPage > 0 && places.length < LIMIT && page < MAX_PAGES
      ? data.nextPageToken
      : null;
    if (pageToken) await sleep(2000); // fresh page tokens take a moment to activate
  } while (pageToken);

  return places.slice(0, LIMIT);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`  Project  : ${config.name}`);
  console.log(`  Location : ${LOCATION}`);
  console.log(`  Radius   : ${RADIUS}m`);
  console.log(`  Keywords : ${config.keywords.join(', ')}`);
  console.log(`${'━'.repeat(60)}\n`);

  // Load existing leads to deduplicate
  const existingLeads  = loadLeads();
  const existingIds    = new Set(existingLeads.map(l => l.placeId));
  console.log(`Existing leads in database: ${existingLeads.length}`);

  // Geocode
  const geo = await geocode(LOCATION);
  console.log(`Location resolved: ${geo.formatted} (${geo.lat}, ${geo.lng})\n`);

  const newLeads = [];
  const scrapedAt = new Date().toISOString();

  // Run each keyword, deduplicating across them
  for (const keyword of config.keywords) {
    process.stdout.write(`\nSearching: "${keyword}"...\n`);
    let places;
    try {
      places = await textSearch(geo.lat, geo.lng, keyword);
    } catch (err) {
      console.error(`  Search failed: ${err.message}`);
      continue;
    }

    process.stdout.write(`  Found ${places.length} candidates. Checking for websites...\n`);

    for (let i = 0; i < places.length; i++) {
      const p = places[i];
      const name = p.displayName?.text || '(unnamed)';

      if (existingIds.has(p.id)) {
        process.stdout.write(`  [skip] Already in database: ${name}\n`);
        continue;
      }

      process.stdout.write(`  [${i + 1}/${places.length}] ${name.slice(0, 55)}\r`);

      if (p.websiteUri) continue; // has a website — skip

      const lead = {
        name,
        types:          (p.types || []).filter(t => t !== 'point_of_interest' && t !== 'establishment').slice(0, 3).join(', '),
        address:        p.formattedAddress || '',
        phone:          p.nationalPhoneNumber || p.internationalPhoneNumber || '',
        rating:         p.rating ?? '',
        reviews:        p.userRatingCount ?? 0,
        mapsUrl:        p.googleMapsUri || `https://www.google.com/maps/place/?q=place_id:${p.id}`,
        placeId:        p.id,
        location:       LOCATION,
        keyword,
        scrapedAt,
        outreachStatus: 'new',   // new | emailed-d1/d4/d9 | replied | closed | not-interested | ...
        notes:          '',
      };

      newLeads.push(lead);
      existingIds.add(p.id);
      process.stdout.write(`  ✓ ${lead.name.slice(0, 50).padEnd(50)} (${newLeads.length} new)\n`);
    }
  }

  // Merge and save
  const allLeads = [...existingLeads, ...newLeads];

  fs.writeFileSync(LEADS_PATH,  JSON.stringify(allLeads, null, 2));
  fs.writeFileSync(CSV_PATH,    toCsv(allLeads));
  fs.writeFileSync(LATEST_PATH, JSON.stringify(newLeads, null, 2));

  // Summary
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`  New leads found   : ${newLeads.length}`);
  console.log(`  Total in database : ${allLeads.length}`);
  console.log(`  Database          : ${LEADS_PATH}`);
  console.log(`  CSV export        : ${CSV_PATH}`);
  console.log(`${'━'.repeat(60)}\n`);

  if (newLeads.length > 0) {
    console.log('Top new leads:\n');
    newLeads.slice(0, 5).forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.name}`);
      console.log(`     ${r.address}`);
      console.log(`     ${r.phone || '(no phone listed)'}  |  ${r.rating ? r.rating + '/5' : 'no rating'}  (${r.reviews} reviews)`);
      console.log('');
    });
  }
})().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
