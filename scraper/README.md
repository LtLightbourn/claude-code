# Small Business "No Website" Scraper

Finds local businesses that appear on Google Maps but have **no website** — prime leads for a web design pitch.

## Two approaches

| Script | How it works | Pros | Cons |
|--------|-------------|------|------|
| `google-maps-no-website.js` | Browser automation (Playwright) | No API key needed | Slower, can be blocked |
| `places-api-no-website.js` | Google Places API | Fast, structured data | Needs a free API key |

---

## Option A — Browser scraper (no key required)

### Requirements
```bash
npm install playwright
npx playwright install chromium
```

### Run
```bash
node scraper/google-maps-no-website.js --category "plumber" --location "Austin, TX"
node scraper/google-maps-no-website.js --category "hair salon" --location "Denver, CO" --limit 60
node scraper/google-maps-no-website.js --category "electrician" --location "Chicago, IL" --visible
```

---

## Option B — Google Places API (recommended)

### Get a free API key
1. Go to <https://console.cloud.google.com>
2. Create a project → Enable **Places API**
3. Create an API key (restrict it to Places API for safety)
4. Free tier gives $200/month credit ≈ ~6,000 searches

### Run
```bash
export GOOGLE_API_KEY="AIza..."
node scraper/places-api-no-website.js --category "plumber" --location "Austin, TX"
node scraper/places-api-no-website.js --category "restaurant" --location "Nashville, TN" --radius 8000
```

---

## Output

Both scripts write two files to the `scraper/` directory:

- **`results.json`** — full structured data
- **`results.csv`** — open in Excel/Sheets for mail merge / outreach

### Sample output row
| name | category | address | phone | rating | reviews | mapsUrl |
|------|----------|---------|-------|--------|---------|---------|
| Bob's Plumbing | Plumber | 123 Main St, Austin TX | (512) 555-0199 | 4.2 | 38 | https://maps.google.com/... |

---

## What makes a business "primed" for a website?

Businesses in the results tend to be:
- **Active** — they have a Google Business Profile with ratings/reviews
- **Established** — they have a phone number and physical address
- **Visible** — customers are finding and rating them
- **Missing out** — no web presence means lost search traffic and credibility

Good categories to search: plumbers, electricians, HVAC, roofers, painters, auto repair, hair salons, nail salons, cleaning services, landscaping, restaurants.
