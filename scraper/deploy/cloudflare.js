/**
 * Deploys a client website to Cloudflare Pages via the API.
 *
 * Usage:
 *   node scraper/deploy/cloudflare.js --client path/to/client.json
 *
 * client.json shape:
 * {
 *   "slug":       "bobs-auto-repair",
 *   "name":       "Bob's Auto Repair",
 *   "domain":     "bobsautorepair.com",      // optional — if they have a domain
 *   "project":    "auto-repair",
 *   "phone":      "(512) 555-0100",
 *   "address":    "123 Main St, Austin TX",
 *   "services":   ["Oil Change", "Brake Repair", "Engine Diagnostics"],
 *   "city":       "Austin",
 *   "state":      "TX",
 *   "hours":      "Mon–Fri 8am–6pm, Sat 9am–3pm",
 *   "tagline":    "Honest repairs, fair prices.",
 *   "colorPrimary": "#1a3c5e",
 *   "analyticsId": ""
 * }
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const { execSync } = require('child_process');

let cfg;
try { cfg = require('../automation/config'); } catch { cfg = require('../automation/config.template'); }

const args = process.argv.slice(2);
function getArg(flag, def) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}

// ── Build site HTML from template ─────────────────────────────────────────────
function buildSite(client) {
  const templateDir = path.join(__dirname, '..', '..', 'templates', client.project);
  const outDir      = path.join('/tmp', `site-${client.slug}`);

  if (!fs.existsSync(templateDir)) {
    throw new Error(`No template found for project "${client.project}" at ${templateDir}`);
  }

  // Copy template to temp dir
  if (fs.existsSync(outDir)) execSync(`rm -rf "${outDir}"`);
  execSync(`cp -r "${templateDir}" "${outDir}"`);

  // Replace placeholders in all HTML/CSS/JS files
  const vars = {
    '{{BUSINESS_NAME}}':   client.name,
    '{{PHONE}}':           client.phone || '',
    '{{ADDRESS}}':         client.address || '',
    '{{CITY}}':            client.city || '',
    '{{STATE}}':           client.state || '',
    '{{HOURS}}':           client.hours || 'Call for hours',
    '{{TAGLINE}}':         client.tagline || `${client.name} — serving ${client.city}`,
    '{{SERVICES_LIST}}':   (client.services || []).map(s => `<li>${s}</li>`).join('\n'),
    '{{COLOR_PRIMARY}}':   client.colorPrimary || '#1a3c5e',
    '{{ANALYTICS_ID}}':    client.analyticsId || '',
    '{{YEAR}}':            new Date().getFullYear().toString(),
    '{{DOMAIN}}':          client.domain || `${client.slug}.pages.dev`,
  };

  const files = getAllFiles(outDir);
  for (const file of files) {
    if (!/\.(html|css|js|txt)$/.test(file)) continue;
    let content = fs.readFileSync(file, 'utf8');
    for (const [k, v] of Object.entries(vars)) {
      content = content.replaceAll(k, v);
    }
    fs.writeFileSync(file, content);
  }

  return outDir;
}

function getAllFiles(dir) {
  const results = [];
  for (const item of fs.readdirSync(dir)) {
    const full = path.join(dir, item);
    if (fs.statSync(full).isDirectory()) results.push(...getAllFiles(full));
    else results.push(full);
  }
  return results;
}

// ── Cloudflare Pages direct upload ────────────────────────────────────────────
async function cfRequest(method, endpoint, body) {
  const { apiToken, accountId } = cfg.cloudflare;
  if (!apiToken || !accountId) throw new Error('Set cloudflare.apiToken and cloudflare.accountId in config.js');

  return new Promise((resolve, reject) => {
    const data  = body ? JSON.stringify(body) : undefined;
    const req   = https.request({
      hostname: 'api.cloudflare.com',
      path:     `/client/v4/accounts/${accountId}${endpoint}`,
      method,
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type':  'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let out = '';
      res.on('data', c => (out += c));
      res.on('end', () => {
        try { resolve(JSON.parse(out)); }
        catch { reject(new Error(`CF API parse error: ${out.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function ensureProject(slug) {
  // Create CF Pages project if it doesn't exist
  const list = await cfRequest('GET', '/pages/projects');
  const existing = list.result?.find(p => p.name === slug);
  if (existing) return existing;

  const created = await cfRequest('POST', '/pages/projects', {
    name:              slug,
    production_branch: 'main',
  });
  if (!created.success) throw new Error(`Failed to create CF project: ${JSON.stringify(created.errors)}`);
  return created.result;
}

async function uploadFiles(projectSlug, siteDir) {
  // Use Wrangler CLI for file upload (handles multipart complexity)
  const wrangler = 'npx wrangler@3';
  execSync(
    `${wrangler} pages deploy "${siteDir}" --project-name="${projectSlug}" --branch=main`,
    {
      env:   { ...process.env, CLOUDFLARE_API_TOKEN: cfg.cloudflare.apiToken },
      stdio: 'inherit',
    }
  );
}

// ── Main deploy function ───────────────────────────────────────────────────────
async function deploy(clientConfig) {
  console.log(`\nDeploying: ${clientConfig.name} (${clientConfig.slug})`);

  // 1. Build static site from template
  console.log('  Building site...');
  const siteDir = buildSite(clientConfig);
  console.log(`  Built to: ${siteDir}`);

  // 2. Ensure CF Pages project exists
  console.log('  Checking Cloudflare project...');
  await ensureProject(clientConfig.slug);

  // 3. Upload
  console.log('  Uploading to Cloudflare Pages...');
  await uploadFiles(clientConfig.slug, siteDir);

  const url = clientConfig.domain
    ? `https://${clientConfig.domain}`
    : `https://${clientConfig.slug}.pages.dev`;

  console.log(`\n  ✓ Live at: ${url}\n`);
  return url;
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────────
if (require.main === module) {
  const clientPath = getArg('--client', null);
  if (!clientPath) {
    console.error('Usage: node scraper/deploy/cloudflare.js --client path/to/client.json');
    process.exit(1);
  }

  const client = JSON.parse(fs.readFileSync(clientPath, 'utf8'));
  deploy(client).catch(err => {
    console.error('Deploy failed:', err.message);
    process.exit(1);
  });
}

module.exports = { deploy, buildSite };
