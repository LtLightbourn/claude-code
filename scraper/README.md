# Lead Pipeline — Scrape → Outreach → Deploy → Report

End-to-end system for a website-retainer business: finds small businesses on
Google Maps with **no website**, cold-emails them a done-for-you website offer
($200/month, nothing upfront), deploys their site to Cloudflare Pages when they
close, and emails them a monthly performance report.

Three niches run in parallel, each with its own lead database and email copy:

| Slug | Niche | Why |
|------|-------|-----|
| `auto-repair` | Auto repair shops | Lowest web design competition, highest website gap |
| `roofers` | Roofing contractors | Highest ticket value ($12K avg job = easy ROI pitch) |
| `electricians` | Electricians | Largest market (257K businesses), year-round demand |

## The pipeline

```
scrape.js ──► enricher.js ──► sequences.js + emailer.js ──► inbox.js
(find leads)  (find emails)   (Day 1/4/9 email sequence)    (detect replies)
                                                                │ replied
                                                                ▼
                              reports/monthly.js ◄── onboard.js ◄── you close
                              (monthly value report)  (client setup)  the deal
                                                                │
                                                                ▼
                                                       deploy/cloudflare.js
                                                       (site live on CF Pages)
```

`automate.js` runs the top row daily via cron. Everything below the fold
happens when a lead says yes.

---

## Setup (once)

```bash
cd scraper
npm install                                          # nodemailer, imapflow, mailparser, jsonwebtoken
cp automation/config.template.js automation/config.js
```

Fill in `automation/config.js` (gitignored — keys never leave your machine):

1. **Google Places API key** — [console.cloud.google.com](https://console.cloud.google.com)
   → enable **Places API** → create key. Free tier ≈ 6,000 searches/month.
   Also works as `export GOOGLE_API_KEY="AIza..."`.
2. **SMTP + IMAP** — same mailbox for both (Zoho free / Google Workspace).
   SMTP sends the sequences; IMAP lets `inbox.js` stop sequences when
   someone replies or unsubscribes.
3. **sender block** — your name, phone, company. Merged into every email.
4. Optional, for enrichment: **Hunter.io** + **Apollo.io** free API keys.
5. Later, per client: **Cloudflare** token (deploys), **Google service
   account** (GA4 + Search Console reporting), **Twilio** (call tracking).

---

## Daily operation

One command does everything — run it manually or via cron:

```bash
node scraper/automate.js              # inbox check → scrape → enrich → send sequences
node scraper/automate.js --dry-run    # show what would happen, send nothing
node scraper/automate.js --skip-scrape
node scraper/automate.js --project roofers
```

Cron:

```cron
0 9 * * *  cd /path/to/claude-code && node scraper/automate.js >> scraper/logs/automate.log 2>&1
0 9 1 * *  cd /path/to/claude-code && node scraper/reports/monthly.js >> scraper/logs/reports.log 2>&1
```

Safety rails built in:

- Max **30 Day-1 emails per project per day**, 4–5s between sends
- Replies and unsubscribes processed **before** any sending; if the inbox
  check fails, that run sends nothing
- Every email carries a reply-to-unsubscribe footer, honored automatically
- Leads below the quality bar (< 3 reviews or < 3.5 rating) are never emailed

## Working leads by hand

The inbox watcher catches email replies. For phone calls and everything else:

```bash
node scraper/status.js                                   # pipeline dashboard, all projects
node scraper/status.js --project roofers --status replied
node scraper/mark.js --project roofers --find "bob"      # inspect one lead
node scraper/mark.js --project roofers --find "bob" --status replied --note "wants to see examples"
node scraper/mark.js --project roofers --find "bob" --status not-interested
```

## When a lead closes

```bash
node scraper/onboard.js --project auto-repair --find "bob" --email bob@gmail.com --deploy
```

This marks the lead closed, writes `clients/<slug>.json` (the deploy config,
prefilled from the lead record), registers them in `reports/clients.json` for
monthly reports, deploys the site, and prints the go-live checklist
(GA4 property → Search Console → Twilio tracking number).

Redeploy after any config change:

```bash
node scraper/deploy/cloudflare.js --client scraper/clients/bobs-auto-repair.json
```

Site templates live in `templates/<project>/` — mobile-first single-pagers
with LocalBusiness JSON-LD, GA4 events on the contact form, and `{{VAR}}`
placeholders filled at deploy time.

## Monthly reports

```bash
node scraper/reports/monthly.js                      # all active clients
node scraper/reports/monthly.js --client bobs-auto   # one client
```

Each client gets: **calls received** (Twilio tracking number), **form
submissions + visitors** (GA4), and **ranking movement** per target keyword
(Search Console, this month vs. last). Sections degrade gracefully — anything
not yet connected shows "(not yet connected)" instead of breaking the report.

---

## Scraping on demand

```bash
node scraper/run-all.js --location "Austin, TX"                       # all 3 niches
node scraper/run-all.js --location "Austin, TX|Denver, CO"            # multiple cities
node scraper/scrape.js --project roofers --location "Denver, CO" --radius 8000
```

`automate.js` also scrapes daily, rotating through the cities configured in
`config.js` → `locations`.

## Data layout

```
scraper/
├── automate.js               # Daily runner (cron this)
├── scrape.js                 # Per-project Places scraper
├── run-all.js                # All 3 projects in parallel
├── status.js                 # Pipeline dashboard
├── mark.js                   # Manual lead status updates
├── onboard.js                # Closed lead → client setup
├── automation/
│   ├── config.js             # Your credentials (gitignored)
│   ├── enricher.js           # Email finding (Hunter/Apollo/heuristics)
│   ├── sequences.js          # Day 1/4/9 state machine
│   ├── emailer.js            # SMTP sending + templating
│   ├── inbox.js              # IMAP reply/unsubscribe detection
│   └── templates/<project>/  # day1.txt, day4.txt, day9.txt email copy
├── projects/<project>/
│   ├── config.json           # Niche config, pitch, pricing
│   ├── leads.json            # Deduplicated lead database (gitignored)
│   └── leads.csv             # Spreadsheet export (gitignored)
├── clients/<slug>.json       # Per-client deploy configs (gitignored)
├── deploy/cloudflare.js      # Template → Cloudflare Pages
└── reports/
    ├── clients.json          # Active clients for reporting (gitignored)
    └── monthly.js            # Monthly value report emails
```

## Lead lifecycle

```
new ──► emailed-d1 ──► emailed-d4 ──► emailed-d9   (sequence complete)
 │           │              │              │
 │           └──────────────┴──────────────┴──► replied ──► closed
 │                                                    └───► not-interested
 ├──► phone-only          (no email found — cold-call list)
 ├──► below-quality-bar   (too few reviews / low rating — never emailed)
 ├──► unsubscribed        (asked to stop — never emailed again)
 └──► no-contact          (no email AND no phone)
```

Statuses update automatically (sends, replies, unsubscribes) or manually via
`mark.js`. `status.js` shows counts and progress bars for every stage.

## Pricing

**$200/month, $0 setup, cancel anytime** — set per niche in
`projects/<project>/config.json` (`pitch.retainerMonthly`) and merged into
email copy as `{{monthly}}`. Positioning and the language rules the email
templates follow live in `product.json`.

---

*`google-maps-no-website.js` (Playwright) and `places-api-no-website.js` are
the original standalone prototypes — superseded by `scrape.js` + `run-all.js`
but kept for one-off searches outside the three configured niches.*
