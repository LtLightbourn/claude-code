/**
 * Project discovery — the single source of truth for which industries exist.
 *
 * A project is any directory under scraper/projects/ containing a
 * config.json. Adding a new industry means creating that one file (plus,
 * optionally, email templates in automation/templates/<slug>/ — without
 * them the project is scraped and enriched but skipped by the emailer).
 *
 * Every runner (automate, run-all, status, inbox) discovers projects
 * through here rather than hardcoding a list.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const PROJECTS_DIR  = path.join(__dirname, '..', 'projects');
const TEMPLATES_DIR = path.join(__dirname, 'templates');

function listProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs.readdirSync(PROJECTS_DIR)
    .filter(d => fs.existsSync(path.join(PROJECTS_DIR, d, 'config.json')))
    .sort();
}

function loadProjectConfig(slug) {
  return JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, slug, 'config.json'), 'utf8'));
}

// True if the project has the day1/day4/day9 email copy needed for sequences
function hasEmailTemplates(slug) {
  return [1, 4, 9].every(d =>
    fs.existsSync(path.join(TEMPLATES_DIR, slug, `day${d}.txt`))
  );
}

module.exports = { listProjects, loadProjectConfig, hasEmailTemplates, PROJECTS_DIR };
