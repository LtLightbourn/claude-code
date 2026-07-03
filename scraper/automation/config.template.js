/**
 * Copy this file to config.js and fill in your values.
 *   cp scraper/automation/config.template.js scraper/automation/config.js
 *
 * config.js is gitignored — your keys never leave this machine.
 */

module.exports = {

  // ── Identity ───────────────────────────────────────────────────────────────
  sender: {
    name:    'Your Name',
    email:   'you@yourdomain.com',       // Must match your SMTP account
    company: 'Your Company Name',
    phone:   '(555) 000-0000',
    website: 'https://yourdomain.com',   // Your own site (portfolio/agency)
    calendly: 'https://calendly.com/you', // Optional — for booking demos
  },

  // ── Email / SMTP ───────────────────────────────────────────────────────────
  // Works with any SMTP provider. Recommended: Zoho Mail (free), Google Workspace ($6/mo)
  smtp: {
    host:   'smtp.zoho.com',   // or smtp.gmail.com, smtp.office365.com
    port:   465,
    secure: true,
    auth: {
      user: 'you@yourdomain.com',
      pass: 'YOUR_SMTP_PASSWORD',
    },
  },

  // IMAP for the same mailbox — the inbox watcher scans it for replies and
  // unsubscribes so sequences stop the moment someone responds.
  // Leave host/user empty to disable (replies then need manual mark.js).
  imap: {
    host:   '',    // e.g. imap.zoho.com, imap.gmail.com, outlook.office365.com
    port:   993,
    secure: true,
    auth: {
      user: '',    // same account as smtp.auth.user
      pass: '',
    },
  },

  // Daily send cap per project (stay under spam thresholds)
  emailLimits: {
    perProjectPerDay: 30,   // Max new Day-1 emails per project per day
    delayBetweenMs:   4000, // 4s between sends (avoid burst flags)
  },

  // ── Lead enrichment ────────────────────────────────────────────────────────
  enrichment: {
    // Hunter.io — finds professional emails by domain (25 free/month)
    hunterApiKey: '',   // Get free key at https://hunter.io

    // Apollo.io — broader enrichment (50 free credits/month)
    apolloApiKey: '',   // Get free key at https://app.apollo.io

    // Min review count — skip businesses with fewer reviews (less established)
    minReviews: 3,

    // Min rating — skip very low-rated businesses (harder sell, higher churn)
    minRating: 3.5,
  },

  // ── Scraping schedule ─────────────────────────────────────────────────────
  // Cities to scrape each week, per project
  locations: {
    'auto-repair':   ['Austin, TX', 'Round Rock, TX', 'Cedar Park, TX', 'Kyle, TX'],
    'roofers':       ['Austin, TX', 'Round Rock, TX', 'Cedar Park, TX', 'Kyle, TX'],
    'electricians':  ['Austin, TX', 'Round Rock, TX', 'Cedar Park, TX', 'Kyle, TX'],
  },

  scrape: {
    radiusMetres:     6000,
    rotateLocationsDays: 7, // Cycle through each city every 7 days
  },

  // ── Cloudflare Pages deployment ───────────────────────────────────────────
  cloudflare: {
    apiToken:  '',   // https://dash.cloudflare.com → API Tokens → Edit Cloudflare Pages
    accountId: '',   // Found in Cloudflare dashboard → right sidebar
  },

  // ── Google APIs ───────────────────────────────────────────────────────────
  google: {
    placesApiKey: process.env.GOOGLE_API_KEY || '',
    // Service account JSON, used for both Analytics (GA4) and Search Console
    // reporting. Add the service account email as a Viewer/Restricted user on
    // each client's GA4 property and Search Console site.
    serviceAccountKeyFile: '',
  },

  // ── Call tracking (Twilio) ─────────────────────────────────────────────────
  // Powers the "calls received" line in the monthly report. Each client gets
  // their own Twilio number (~$1/mo) forwarded to their real line.
  twilio: {
    accountSid: '',
    authToken:  '',
  },

  // ── Sequence timing ────────────────────────────────────────────────────────
  sequence: {
    day1DelayHours:  0,   // Send Day 1 immediately after enrichment
    day4DelayDays:   4,   // Follow-up 4 days after Day 1
    day9DelayDays:   9,   // Final email 9 days after Day 1
  },

};
