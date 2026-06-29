# Lead Scraper — 3 Parallel Projects

Finds small businesses on Google Maps with no website across 3 niches simultaneously.
Each project maintains its own deduplicated lead database with outreach tracking.

## Projects

| Slug | Niche | Why |
|------|-------|-----|
| `auto-repair` | Auto repair shops | Lowest web design competition, highest website gap |
| `roofers` | Roofing contractors | Highest ticket value ($12K avg job = easy ROI pitch) |
| `electricians` | Electricians | Largest market (257K businesses), year-round demand |

## Setup

Get a free Google Places API key:
1. [console.cloud.google.com](https://console.cloud.google.com) → Create project → Enable **Places API**
2. Create an API key (restrict to Places API)
3. Free tier: $200/month credit ≈ ~6,000 searches

```bash
export GOOGLE_API_KEY="AIza..."
```

---

## Commands

### Run all 3 projects for one city
```bash
node scraper/run-all.js --location "Austin, TX"
```

### Run all 3 for multiple cities (pipe-separated)
```bash
node scraper/run-all.js --location "Austin, TX|Denver, CO|Nashville, TN"
```

### Run a single project
```bash
node scraper/scrape.js --project auto-repair --location "Austin, TX"
node scraper/scrape.js --project roofers     --location "Denver, CO" --radius 8000
node scraper/scrape.js --project electricians --location "Chicago, IL"
```

### Check database status (all 3 at a glance)
```bash
node scraper/status.js
```

### Inspect a specific project
```bash
node scraper/status.js --project roofers
node scraper/status.js --project auto-repair --status new
node scraper/status.js --project electricians --status emailed
```

---

## Output structure

```
scraper/
├── scrape.js              # Core per-project scraper
├── run-all.js             # Parallel orchestrator (all 3 at once)
├── status.js              # Dashboard + pipeline view
└── projects/
    ├── auto-repair/
    │   ├── config.json    # Niche config, pitch angles, pricing
    │   ├── leads.json     # Full deduplicated database (append-only)
    │   ├── leads.csv      # Export for mail merge / outreach tools
    │   └── latest.json    # Results from the most recent scrape run
    ├── roofers/
    │   └── ...
    └── electricians/
        └── ...
```

## Lead record fields

| Field | Description |
|-------|-------------|
| `name` | Business name |
| `address` | Full formatted address |
| `phone` | Phone number |
| `rating` | Google rating (out of 5) |
| `reviews` | Number of Google reviews |
| `mapsUrl` | Direct Google Maps link |
| `placeId` | Unique Google Place ID (used for deduplication) |
| `location` | City/area searched |
| `scrapedAt` | ISO timestamp of when this lead was found |
| `outreachStatus` | `new` → `emailed` → `called` → `replied` → `closed` / `not-interested` |
| `notes` | Free-text notes for tracking conversations |

## Outreach status workflow

Update `outreachStatus` in `leads.json` as you work through each lead:

```
new → emailed → called → replied → closed
                                 ↘ not-interested
```

`status.js` shows counts and a progress bar for each stage per project.

---

## Pricing per project

| Project | Setup fee | Monthly retainer |
|---------|-----------|-----------------|
| Auto Repair | $0 | $149/mo |
| Roofers | $0 | $199/mo |
| Electricians | $0 | $149/mo |

$0 setup for the first 8–10 clients per niche (no case studies yet). Raise to $499 setup once you have results to show.
