/**
 * Runs all 3 project scrapers in parallel for a given location.
 *
 * Usage:
 *   node scraper/run-all.js --location "Austin, TX"
 *   node scraper/run-all.js --location "Denver, CO" --radius 8000
 *
 * Env:
 *   GOOGLE_API_KEY  — required
 *
 * What it does:
 *   - Spawns scrape.js for auto-repair, roofers, and electricians simultaneously
 *   - Streams each project's output prefixed with its name
 *   - Prints a combined summary when all 3 finish
 *   - Repeats across as many --location values as you pass (comma-separated)
 */

'use strict';

const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');

const PROJECTS = ['auto-repair', 'roofers', 'electricians'];

const args = process.argv.slice(2);
function getArg(flag, def) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}

const LOCATIONS_RAW = getArg('--location', 'Austin, TX');
const LOCATIONS     = LOCATIONS_RAW.split('|').map(l => l.trim()); // pipe-separated for multiple
const RADIUS        = getArg('--radius', '6000');

const SCRAPER = path.join(__dirname, 'scrape.js');
const COLORS  = { 'auto-repair': '\x1b[33m', roofers: '\x1b[34m', electricians: '\x1b[32m' };
const RESET   = '\x1b[0m';

function runScraper(project, location) {
  return new Promise((resolve, reject) => {
    const color  = COLORS[project] || '';
    const prefix = `${color}[${project.padEnd(12)}]${RESET} `;

    const proc = spawn(process.execPath, [
      SCRAPER,
      '--project',  project,
      '--location', location,
      '--radius',   RADIUS,
    ], {
      env: { ...process.env },
    });

    let newLeads = 0;
    let total    = 0;

    proc.stdout.on('data', data => {
      const lines = data.toString().split('\n');
      lines.forEach(line => {
        if (!line.trim()) return;
        // Extract summary numbers from output
        const newMatch   = line.match(/New leads found\s*:\s*(\d+)/);
        const totalMatch = line.match(/Total in database\s*:\s*(\d+)/);
        if (newMatch)   newLeads = parseInt(newMatch[1], 10);
        if (totalMatch) total    = parseInt(totalMatch[1], 10);
        process.stdout.write(prefix + line + '\n');
      });
    });

    proc.stderr.on('data', data =>
      process.stderr.write(prefix + data.toString())
    );

    proc.on('close', code => {
      if (code !== 0) reject(new Error(`${project} exited with code ${code}`));
      else resolve({ project, newLeads, total });
    });
  });
}

(async () => {
  if (!process.env.GOOGLE_API_KEY) {
    console.error('\nMissing GOOGLE_API_KEY. Set it with:\n  export GOOGLE_API_KEY="AIza..."\n');
    process.exit(1);
  }

  let grandTotal = 0;
  let grandNew   = 0;

  for (const location of LOCATIONS) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  Scraping all 3 projects for: ${location}`);
    console.log(`${'═'.repeat(70)}\n`);

    const results = await Promise.all(
      PROJECTS.map(p => runScraper(p, location).catch(err => {
        console.error(`\n[ERROR] ${p}: ${err.message}`);
        return { project: p, newLeads: 0, total: 0, error: true };
      }))
    );

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  Results for: ${location}`);
    console.log(`${'═'.repeat(70)}`);
    console.log(`  ${'Project'.padEnd(16)} ${'New'.padStart(6)}  ${'Total DB'.padStart(10)}`);
    console.log(`  ${'-'.repeat(36)}`);
    for (const r of results) {
      const status = r.error ? '  [FAILED]' : '';
      console.log(`  ${r.project.padEnd(16)} ${String(r.newLeads).padStart(6)}  ${String(r.total).padStart(10)}${status}`);
      grandNew   += r.newLeads;
      grandTotal += r.total;
    }
    console.log(`  ${'-'.repeat(36)}`);
    console.log(`  ${'TOTAL'.padEnd(16)} ${String(grandNew).padStart(6)}  ${String(grandTotal).padStart(10)}`);
    console.log(`${'═'.repeat(70)}\n`);
  }

  // Print database file paths
  console.log('Lead databases:');
  for (const project of PROJECTS) {
    const leadsPath = path.join(__dirname, 'projects', project, 'leads.json');
    const csvPath   = path.join(__dirname, 'projects', project, 'leads.csv');
    const count     = fs.existsSync(leadsPath)
      ? JSON.parse(fs.readFileSync(leadsPath, 'utf8')).length
      : 0;
    console.log(`  ${project.padEnd(16)}: ${count} leads  →  ${csvPath}`);
  }
  console.log('');
})();
