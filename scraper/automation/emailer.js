/**
 * Email sending engine with rate limiting and send tracking.
 * Uses Nodemailer (npm install nodemailer).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

let cfg;
try { cfg = require('./config'); } catch { cfg = require('./config.template'); }

let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch {
  try {
    nodemailer = require('/opt/node22/lib/node_modules/nodemailer');
  } catch {
    nodemailer = null;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Template engine ───────────────────────────────────────────────────────────
const TEMPLATES_DIR = path.join(__dirname, 'templates');

function loadTemplate(project, day) {
  const p = path.join(TEMPLATES_DIR, project, `day${day}.txt`);
  if (!fs.existsSync(p)) throw new Error(`Template not found: ${p}`);
  return fs.readFileSync(p, 'utf8');
}

function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

function splitTemplate(rendered) {
  const lines = rendered.split('\n');
  const subjectLine = lines.find(l => l.startsWith('Subject:'));
  const subject = subjectLine ? subjectLine.replace('Subject:', '').trim() : '(no subject)';
  const body = lines
    .filter(l => !l.startsWith('Subject:'))
    .join('\n')
    .replace(/^\n+/, '');
  return { subject, body };
}

// ── Unsubscribe footer ────────────────────────────────────────────────────────
function addFooter(body, lead) {
  return `${body}

---
To stop receiving emails, reply with "unsubscribe" and I'll remove you immediately.
${cfg.sender.company}  |  ${cfg.sender.phone}`;
}

// ── Transporter ───────────────────────────────────────────────────────────────
let _transporter = null;
function getTransporter() {
  if (!nodemailer) throw new Error('nodemailer not installed. Run: npm install nodemailer');
  if (!_transporter) {
    _transporter = nodemailer.createTransport(cfg.smtp);
  }
  return _transporter;
}

// ── Send one email ────────────────────────────────────────────────────────────
async function sendEmail({ to, subject, body, replyTo }) {
  const transporter = getTransporter();
  const info = await transporter.sendMail({
    from:    `"${cfg.sender.name}" <${cfg.sender.email}>`,
    to,
    subject,
    text:    body,
    replyTo: replyTo || cfg.sender.email,
  });
  return info;
}

// ── Build merge vars for a lead ───────────────────────────────────────────────
function buildVars(lead, projectConfig) {
  const firstName = lead.ownerName
    ? lead.ownerName.split(' ')[0]
    : 'there';

  const city = (lead.location || lead.address?.split(',').slice(-2, -1)[0] || '').trim();

  return {
    name:         firstName,
    businessName: lead.name,
    city,
    rating:       lead.rating || '4+',
    reviews:      lead.reviews || 'several',
    phone:        lead.phone || '',
    address:      lead.address || '',
    avgJob:       `$${projectConfig.pitch.avgJobValue.toLocaleString()}`,
    monthly:      `$${projectConfig.pitch.retainerMonthly}`,
    senderName:   cfg.sender.name,
    senderPhone:  cfg.sender.phone,
    senderEmail:  cfg.sender.email,
    calendly:     cfg.sender.calendly || '',
    company:      cfg.sender.company,
    senderSite:   cfg.sender.website,
  };
}

// ── Send sequence email for one lead ─────────────────────────────────────────
async function sendSequenceEmail(lead, day, projectSlug, projectConfig) {
  if (!lead.email) throw new Error('Lead has no email address');

  const template = loadTemplate(projectSlug, day);
  const vars     = buildVars(lead, projectConfig);
  const rendered = render(template, vars);
  const { subject, body } = splitTemplate(rendered);
  const withFooter = addFooter(body, lead);

  await sendEmail({
    to:      lead.email,
    subject,
    body:    withFooter,
  });

  return { subject, preview: body.slice(0, 100) };
}

// ── Batch sender with rate limiting ──────────────────────────────────────────
async function sendBatch(jobs, { onSent, onError } = {}) {
  const delay     = cfg.emailLimits?.delayBetweenMs ?? 4000;
  const results   = [];

  for (const job of jobs) {
    try {
      const result = await sendSequenceEmail(job.lead, job.day, job.projectSlug, job.projectConfig);
      results.push({ ...job, success: true, ...result });
      onSent?.(job, result);
    } catch (err) {
      results.push({ ...job, success: false, error: err.message });
      onError?.(job, err);
    }
    await sleep(delay + Math.random() * 1000);
  }

  return results;
}

module.exports = { sendSequenceEmail, sendBatch, render, loadTemplate, buildVars };
