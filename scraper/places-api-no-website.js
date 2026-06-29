/**
 * Uses the Google Places API to find small businesses without a website.
 * More reliable than scraping — higher rate limits, structured data.
 *
 * Setup:
 *   1. Get a free Google Places API key: https://console.cloud.google.com
 *      Enable "Places API" in the API Library.
 *   2. Set env var:  export GOOGLE_API_KEY="your_key_here"
 *
 * Usage:
 *   node scraper/places-api-no-website.js --category "plumber" --location "Austin, TX"
 *   node scraper/places-api-no-website.js --category "hair salon" --location "Denver, CO" --radius 10000
 *
 * Options:
 *   --category   Business type / keyword   (default: "plumber")
 *   --location   City or address to centre the search  (default: "Austin, TX")
 *   --radius     Search radius in metres   (default: 5000  = 5 km)
 *   --limit      Max results               (default: 60)
 *
 * Free tier: 200 USD/month credit ≈ ~6,000 nearby-search calls.
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const API_KEY = process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  console.error('Set GOOGLE_API_KEY environment variable first.');
  console.error('  export GOOGLE_API_KEY="AIza..."');
  process.exit(1);
}

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag, def) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}
const CATEGORY = getArg('--category', 'plumber');
const LOCATION = getArg('--location', 'Austin, TX');
const RADIUS   = parseInt(getArg('--radius', '5000'), 10);
const LIMIT    = parseInt(getArg('--limit', '60'), 10);

const OUT_DIR = path.join(__dirname);

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse failed: ${body.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function toCsv(records) {
  const headers = ['name', 'types', 'address', 'phone', 'rating', 'reviews', 'mapsUrl', 'placeId'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [
    headers.join(','),
    ...records.map(r => headers.map(h => esc(r[h])).join(',')),
  ].join('\n');
}

// ── Geocode location string → lat,lng ─────────────────────────────────────────
async function geocode(address) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${API_KEY}`;
  const data = await get(url);
  if (data.status !== 'OK') throw new Error(`Geocode failed: ${data.status} — ${data.error_message || ''}`);
  const { lat, lng } = data.results[0].geometry.location;
  console.log(`  Location resolved: ${data.results[0].formatted_address} (${lat}, ${lng})`);
  return { lat, lng };
}

// ── Nearby search (paginates up to 3 pages = 60 results) ─────────────────────
async function nearbySearch(lat, lng, keyword) {
  const places = [];
  let url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${RADIUS}&keyword=${encodeURIComponent(keyword)}&key=${API_KEY}`;

  while (url && places.length < LIMIT) {
    const data = await get(url);
    if (!['OK', 'ZERO_RESULTS'].includes(data.status)) {
      throw new Error(`Nearby search error: ${data.status} — ${data.error_message || ''}`);
    }
    places.push(...(data.results || []));
    process.stdout.write(`  Fetched ${places.length} listings so far...\r`);

    if (data.next_page_token && places.length < LIMIT) {
      await sleep(2000); // Google requires a delay before using next_page_token
      url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?pagetoken=${data.next_page_token}&key=${API_KEY}`;
    } else {
      url = null;
    }
  }
  process.stdout.write('\n');
  return places.slice(0, LIMIT);
}

// ── Place details (includes website field) ────────────────────────────────────
async function getDetails(placeId) {
  const fields = 'name,formatted_address,formatted_phone_number,website,rating,user_ratings_total,types,place_id,url';
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&key=${API_KEY}`;
  const data = await get(url);
  if (data.status !== 'OK') return null;
  return data.result;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\nGoogle Places API — no-website business finder`);
  console.log(`  Category : ${CATEGORY}`);
  console.log(`  Location : ${LOCATION}`);
  console.log(`  Radius   : ${RADIUS}m`);
  console.log(`  Limit    : ${LIMIT}\n`);

  // 1. Geocode the location
  const { lat, lng } = await geocode(LOCATION);

  // 2. Nearby search
  console.log(`\nSearching nearby places...`);
  const places = await nearbySearch(lat, lng, CATEGORY);
  console.log(`Retrieved ${places.length} candidate places. Checking for websites...\n`);

  // 3. Fetch details for each place and filter out those with a website
  const results = [];

  for (let i = 0; i < places.length; i++) {
    const p = places[i];
    process.stdout.write(`  [${i + 1}/${places.length}] ${(p.name || '').slice(0, 55)}\r`);

    const details = await getDetails(p.place_id);
    if (!details) continue;

    if (details.website) continue; // has a website — skip

    results.push({
      name:    details.name || p.name,
      types:   (details.types || []).slice(0, 3).join(', '),
      address: details.formatted_address || p.vicinity || '',
      phone:   details.formatted_phone_number || '',
      rating:  details.rating ?? '',
      reviews: details.user_ratings_total ?? 0,
      mapsUrl: details.url || `https://www.google.com/maps/place/?q=place_id:${p.place_id}`,
      placeId: p.place_id,
    });

    process.stdout.write(`  ✓ No website: ${(details.name || '').slice(0, 50).padEnd(50)} (${results.length} found)\n`);

    // Respect Places API rate limits (~10 req/sec)
    await sleep(110);
  }

  process.stdout.write('\n');

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Found ${results.length} "${CATEGORY}" businesses near ${LOCATION} WITHOUT a website:`);
  console.log(`${'─'.repeat(60)}\n`);

  results.slice(0, 15).forEach((r, i) => {
    console.log(`${String(i + 1).padStart(2)}. ${r.name}`);
    if (r.address) console.log(`    Address : ${r.address}`);
    if (r.phone)   console.log(`    Phone   : ${r.phone}`);
    if (r.rating)  console.log(`    Rating  : ${r.rating}/5  (${r.reviews} reviews)`);
    console.log(`    Maps    : ${r.mapsUrl}`);
    console.log('');
  });
  if (results.length > 15) console.log(`  … and ${results.length - 15} more in the output files.\n`);

  // ── Save outputs ──────────────────────────────────────────────────────────
  const jsonPath = path.join(OUT_DIR, 'results.json');
  const csvPath  = path.join(OUT_DIR, 'results.csv');
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  fs.writeFileSync(csvPath,  toCsv(results));

  console.log(`Saved:\n  ${jsonPath}\n  ${csvPath}\n`);
  console.log(`Tip: These businesses have Google Maps presence, ratings, and phone numbers`);
  console.log(`     but no website — perfect warm leads for web design outreach.\n`);
})().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
