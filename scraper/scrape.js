/**
 * Multi-project Google Places scraper.
 * Reads a project config and appends new leads to that project's database.
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

async function nearbySearch(lat, lng, keyword) {
  const places = [];
  let url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${RADIUS}&keyword=${encodeURIComponent(keyword)}&key=${API_KEY}`;

  while (url && places.length < LIMIT) {
    const data = await get(url);
    if (!['OK', 'ZERO_RESULTS'].includes(data.status))
      throw new Error(`Nearby search: ${data.status} — ${data.error_message || ''}`);
    places.push(...(data.results || []));

    if (data.next_page_token && places.length < LIMIT) {
      await sleep(2000);
      url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?pagetoken=${data.next_page_token}&key=${API_KEY}`;
    } else {
      url = null;
    }
  }
  return places.slice(0, LIMIT);
}

async function getDetails(placeId) {
  const fields = 'name,formatted_address,formatted_phone_number,website,rating,user_ratings_total,types,place_id,url';
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&key=${API_KEY}`;
  const data = await get(url);
  return data.status === 'OK' ? data.result : null;
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
      places = await nearbySearch(geo.lat, geo.lng, keyword);
    } catch (err) {
      console.error(`  Search failed: ${err.message}`);
      continue;
    }

    process.stdout.write(`  Found ${places.length} candidates. Checking for websites...\n`);

    for (let i = 0; i < places.length; i++) {
      const p = places[i];
      if (existingIds.has(p.place_id)) {
        process.stdout.write(`  [skip] Already in database: ${p.name}\n`);
        continue;
      }

      process.stdout.write(`  [${i + 1}/${places.length}] ${(p.name || '').slice(0, 55)}\r`);

      let details;
      try { details = await getDetails(p.place_id); }
      catch { continue; }
      if (!details) continue;

      if (details.website) continue; // has a website — skip

      const lead = {
        name:           details.name || p.name,
        types:          (details.types || []).filter(t => t !== 'point_of_interest' && t !== 'establishment').slice(0, 3).join(', '),
        address:        details.formatted_address || p.vicinity || '',
        phone:          details.formatted_phone_number || '',
        rating:         details.rating ?? '',
        reviews:        details.user_ratings_total ?? 0,
        mapsUrl:        details.url || `https://www.google.com/maps/place/?q=place_id:${p.place_id}`,
        placeId:        p.place_id,
        location:       LOCATION,
        keyword,
        scrapedAt,
        outreachStatus: 'new',   // new | emailed | called | replied | closed | not-interested
        notes:          '',
      };

      newLeads.push(lead);
      existingIds.add(p.place_id);
      process.stdout.write(`  ✓ ${lead.name.slice(0, 50).padEnd(50)} (${newLeads.length} new)\n`);

      await sleep(120); // Places API rate limit
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
