/**
 * Scrapes Google Maps for small businesses WITHOUT a website.
 * These are prime candidates for a new website — they have a Google presence but no web presence.
 *
 * Usage:
 *   node scraper/google-maps-no-website.js --category "plumber" --location "Austin, TX"
 *   node scraper/google-maps-no-website.js --category "hair salon" --location "Denver, CO" --limit 60
 *   node scraper/google-maps-no-website.js --category "electrician" --location "Chicago, IL" --visible
 *
 * Options:
 *   --category   Business type to search (default: "plumber")
 *   --location   City/area to search   (default: "Austin, TX")
 *   --limit      Max results to collect (default: 40)
 *   --visible    Show browser window while running
 *
 * Output:
 *   scraper/results.json  — full data
 *   scraper/results.csv   — spreadsheet-friendly
 *
 * Requirements:
 *   Node.js v18+, Playwright installed globally or locally.
 *   Run: npm install playwright  (or use the global at /opt/node22/lib/node_modules/playwright)
 */

'use strict';

// Support both a local install and the globally pre-installed Playwright
let playwrightModule;
try {
  playwrightModule = require('playwright');
} catch {
  try {
    playwrightModule = require('/opt/node22/lib/node_modules/playwright');
  } catch {
    console.error('Playwright not found. Install it: npm install playwright && npx playwright install chromium');
    process.exit(1);
  }
}
const { chromium } = playwrightModule;

const fs   = require('fs');
const path = require('path');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag, def) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}
const CATEGORY = getArg('--category', 'plumber');
const LOCATION = getArg('--location', 'Austin, TX');
const LIMIT    = parseInt(getArg('--limit', '40'), 10);
const HEADLESS = !args.includes('--visible');

const QUERY   = `${CATEGORY} near ${LOCATION}`;
const OUT_DIR = path.join(__dirname);

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function toCsv(records) {
  const headers = ['name', 'category', 'address', 'phone', 'rating', 'reviews', 'mapsUrl'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [
    headers.join(','),
    ...records.map(r => headers.map(h => esc(r[h])).join(',')),
  ].join('\n');
}

async function dismissDialogs(page) {
  const selectors = [
    'button[aria-label*="Accept all"]',
    'button[aria-label*="Reject all"]',
    '#L2AGLb',    // older "I agree" button
    '.QS5gu',
  ];
  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await btn.click().catch(() => {});
      await sleep(400);
    }
  }
}

// ── Business detail scraper ───────────────────────────────────────────────────
async function scrapeDetail(ctx, href) {
  const page = await ctx.newPage();
  try {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await sleep(1200);

    // If a "website" button/link is visible, this business has a site — skip it
    const websiteLocators = [
      'a[data-item-id="authority"]',
      'a[aria-label*="website" i]',
      'a[data-tooltip*="website" i]',
      'a[href^="http"]:has-text("Website")',
    ];
    for (const sel of websiteLocators) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        return null; // has a website
      }
    }

    // Scrape available metadata
    const address = await page
      .locator('button[data-item-id="address"] .fontBodyMedium')
      .first().innerText().catch(() => '');

    const phone = await page
      .locator('[data-item-id^="phone"] .fontBodyMedium')
      .first().innerText().catch(() => '');

    const rating = await page
      .locator('div.fontDisplayLarge')
      .first().innerText().catch(() => '');

    const reviewAttr = await page
      .locator('button[aria-label*="review" i]')
      .first().getAttribute('aria-label').catch(() => '');
    const reviews = (reviewAttr || '').match(/\d[\d,]*/)?.[0]?.replace(/,/g, '') || '0';

    const category = await page
      .locator('button[jsaction*="category"], button.DkEaL')
      .first().innerText().catch(() => CATEGORY);

    return {
      address:  address.trim(),
      phone:    phone.trim(),
      rating:   rating.trim(),
      reviews,
      category: category.trim() || CATEGORY,
    };
  } finally {
    await page.close();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\nGoogle Maps "no website" scraper`);
  console.log(`  Search  : ${QUERY}`);
  console.log(`  Target  : ${LIMIT} businesses without a website`);
  console.log(`  Browser : ${HEADLESS ? 'headless' : 'visible'}\n`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    // Use pre-installed Chromium if available (cloud/CI environments)
    ...(fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
      ? { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }
      : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });

  const page = await ctx.newPage();

  const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(QUERY)}`;
  console.log(`Opening: ${searchUrl}\n`);

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await sleep(2000);
  await dismissDialogs(page);

  // Wait for the sidebar result feed
  await page.waitForSelector('div[role="feed"]', { timeout: 15_000 }).catch(() =>
    console.warn('Warning: result feed not found — page layout may have changed.')
  );

  const results  = [];
  const seen     = new Set();
  let   noNewFor = 0;

  while (results.length < LIMIT && noNewFor < 8) {
    const cards = await page.locator('a.hfpxzc').all();
    let foundNew = false;

    for (const card of cards) {
      if (results.length >= LIMIT) break;

      const href = await card.getAttribute('href').catch(() => null);
      if (!href || seen.has(href)) continue;
      seen.add(href);
      foundNew = true;

      const name = await card.getAttribute('aria-label').catch(() => null);
      if (!name) continue;

      process.stdout.write(`  Checking [${seen.size}]: ${name.slice(0, 55).padEnd(55, ' ')}\r`);

      const detail = await scrapeDetail(ctx, href);
      if (!detail) continue; // has a website — skip

      results.push({ name: name.trim(), mapsUrl: href, ...detail });
      process.stdout.write(`  ✓ No website: ${name.slice(0, 55).padEnd(55, ' ')} (${results.length}/${LIMIT})\n`);

      await sleep(600 + Math.random() * 600);
    }

    // Scroll sidebar to load more listings
    await page
      .locator('div[role="feed"]')
      .evaluate(el => el.scrollBy(0, 800))
      .catch(() => page.evaluate(() => window.scrollBy(0, 800)));

    await sleep(1800);

    const endMarker = await page
      .locator('p.fontBodyMedium:has-text("end of results")')
      .isVisible()
      .catch(() => false);
    if (endMarker) { console.log('\n  [end of results reached]'); break; }

    noNewFor = foundNew ? 0 : noNewFor + 1;
  }

  process.stdout.write('\n');
  await browser.close();

  // ── Output ─────────────────────────────────────────────────────────────────
  console.log(`\nFound ${results.length} businesses without a website:\n`);

  results.slice(0, 10).forEach((r, i) => {
    console.log(`${String(i + 1).padStart(2)}. ${r.name}`);
    console.log(`    Category : ${r.category}`);
    console.log(`    Address  : ${r.address || '(not listed)'}`);
    console.log(`    Phone    : ${r.phone   || '(not listed)'}`);
    console.log(`    Rating   : ${r.rating  || '?'} (${r.reviews} reviews)`);
    console.log(`    Maps URL : ${r.mapsUrl}`);
    console.log('');
  });
  if (results.length > 10) console.log(`  … and ${results.length - 10} more in the output files.\n`);

  const jsonPath = path.join(OUT_DIR, 'results.json');
  const csvPath  = path.join(OUT_DIR, 'results.csv');
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  fs.writeFileSync(csvPath,  toCsv(results));

  console.log(`Saved:\n  ${jsonPath}\n  ${csvPath}\n`);
})().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
