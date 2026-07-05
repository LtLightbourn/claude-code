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

  // Daily send caps (stay under spam thresholds). One mailbox sends for every
  // industry, so the global cap is what actually protects deliverability.
  emailLimits: {
    perProjectPerDay: 30,   // Max emails per project per day
    totalPerDay:      60,   // Hard cap across ALL projects combined
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
  // Cities the daily automation rotates through, one non-repeating window per
  // day (size set by scrape.citiesPerDay below) until the list wraps around.
  // `default` covers every project; add a project slug as a key to give one
  // industry its own list instead (e.g. only scrape roofers in hail-prone
  // metros). Trim this to a region if you don't want nationwide coverage.
  locations: {
    default: [
      // Northeast
      'New York, NY', 'Buffalo, NY', 'Rochester, NY', 'Albany, NY',
      'Boston, MA', 'Worcester, MA', 'Springfield, MA',
      'Providence, RI', 'Hartford, CT', 'New Haven, CT',
      'Manchester, NH', 'Portland, ME',
      'Newark, NJ', 'Jersey City, NJ', 'Trenton, NJ',
      'Philadelphia, PA', 'Pittsburgh, PA', 'Allentown, PA', 'Erie, PA',
      'Baltimore, MD',
      // Southeast
      'Washington, DC', 'Richmond, VA', 'Virginia Beach, VA', 'Norfolk, VA',
      'Charlotte, NC', 'Raleigh, NC', 'Durham, NC', 'Greensboro, NC',
      'Columbia, SC', 'Charleston, SC',
      'Atlanta, GA', 'Savannah, GA', 'Augusta, GA',
      'Jacksonville, FL', 'Miami, FL', 'Orlando, FL', 'Tampa, FL',
      'St. Petersburg, FL', 'Tallahassee, FL', 'Fort Lauderdale, FL',
      'Birmingham, AL', 'Montgomery, AL', 'Huntsville, AL', 'Jackson, MS',
      'Nashville, TN', 'Memphis, TN', 'Knoxville, TN', 'Chattanooga, TN',
      'Louisville, KY', 'Lexington, KY',
      // Midwest
      'Chicago, IL', 'Springfield, IL', 'Rockford, IL',
      'Indianapolis, IN', 'Fort Wayne, IN',
      'Columbus, OH', 'Cleveland, OH', 'Cincinnati, OH', 'Toledo, OH', 'Akron, OH',
      'Detroit, MI', 'Grand Rapids, MI', 'Lansing, MI', 'Ann Arbor, MI',
      'Milwaukee, WI', 'Madison, WI', 'Green Bay, WI',
      'Minneapolis, MN', 'St. Paul, MN', 'Duluth, MN',
      'Des Moines, IA', 'Cedar Rapids, IA',
      'Omaha, NE', 'Lincoln, NE',
      'Kansas City, MO', 'St. Louis, MO', 'Springfield, MO',
      'Wichita, KS', 'Topeka, KS', 'Fargo, ND', 'Sioux Falls, SD',
      // South Central
      'Dallas, TX', 'Fort Worth, TX', 'Houston, TX', 'San Antonio, TX',
      'Austin, TX', 'El Paso, TX', 'Arlington, TX', 'Corpus Christi, TX',
      'Lubbock, TX', 'Amarillo, TX', 'Waco, TX', 'Round Rock, TX', 'Cedar Park, TX',
      'Oklahoma City, OK', 'Tulsa, OK',
      'Little Rock, AR', 'Shreveport, LA', 'New Orleans, LA', 'Baton Rouge, LA', 'Lafayette, LA',
      // Mountain West
      'Denver, CO', 'Colorado Springs, CO', 'Boulder, CO',
      'Salt Lake City, UT', 'Provo, UT',
      'Boise, ID', 'Billings, MT', 'Missoula, MT', 'Cheyenne, WY',
      'Albuquerque, NM', 'Santa Fe, NM',
      'Phoenix, AZ', 'Tucson, AZ', 'Mesa, AZ', 'Scottsdale, AZ',
      'Las Vegas, NV', 'Reno, NV',
      // West Coast
      'Los Angeles, CA', 'San Diego, CA', 'San Jose, CA', 'San Francisco, CA',
      'Sacramento, CA', 'Fresno, CA', 'Long Beach, CA', 'Oakland, CA',
      'Bakersfield, CA', 'Anaheim, CA', 'Riverside, CA',
      'Portland, OR', 'Eugene, OR', 'Salem, OR',
      'Seattle, WA', 'Spokane, WA', 'Tacoma, WA', 'Vancouver, WA',
      'Anchorage, AK', 'Honolulu, HI',
    ],
    // 'roofers': ['Dallas, TX', 'Fort Worth, TX'],  // override for one industry
  },

  scrape: {
    radiusMetres:  6000,
    // Cities scraped per project per automate.js run. 1 = one new metro a
    // day (slow, minimal API usage). Raise this to cover the list faster —
    // it multiplies daily Places API calls roughly linearly (8 projects x
    // ~5 keywords x citiesPerDay), so watch usage in the GCP console
    // (Places API (New) free tier: $200/month credit) before going high.
    citiesPerDay:  1,
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
