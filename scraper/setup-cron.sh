#!/usr/bin/env bash
#
# Installs the cron jobs that run the whole pipeline automatically:
#   - Daily 9am:   automate.js  (inbox check → scrape → enrich → email sequences)
#   - Monthly 1st: monthly.js   (client performance reports)
#
# Idempotent — safe to re-run; existing entries are replaced, other cron
# jobs are left untouched.
#
# Usage:
#   bash scraper/setup-cron.sh            # install
#   bash scraper/setup-cron.sh --remove   # uninstall
#   bash scraper/setup-cron.sh --hour 7   # run daily at 7am instead of 9am

set -euo pipefail

SCRAPER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRAPER_DIR")"
NODE_BIN="$(command -v node || true)"
MARKER="# lead-scraper"
HOUR=9

if [[ -z "$NODE_BIN" ]]; then
  echo "node not found on PATH — install Node.js first." >&2
  exit 1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remove) REMOVE=1; shift ;;
    --hour)   HOUR="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Current crontab minus our entries
EXISTING="$(crontab -l 2>/dev/null | grep -v "$MARKER" || true)"

if [[ "${REMOVE:-0}" == "1" ]]; then
  printf '%s\n' "$EXISTING" | crontab -
  echo "Removed lead-scraper cron jobs."
  exit 0
fi

mkdir -p "$SCRAPER_DIR/logs"

DAILY="0 $HOUR * * * cd $REPO_DIR && $NODE_BIN scraper/automate.js >> scraper/logs/automate.log 2>&1 $MARKER"
MONTHLY="0 $HOUR 1 * * cd $REPO_DIR && $NODE_BIN scraper/reports/monthly.js >> scraper/logs/reports.log 2>&1 $MARKER"

{ printf '%s\n' "$EXISTING"; echo "$DAILY"; echo "$MONTHLY"; } | sed '/^$/d' | crontab -

echo "Installed:"
echo "  Daily ${HOUR}:00      → automate.js  (scrape + enrich + sequences, logs to scraper/logs/automate.log)"
echo "  Monthly 1st ${HOUR}:00 → monthly.js   (client reports, logs to scraper/logs/reports.log)"
echo ""
echo "Check what's installed anytime with: crontab -l"
echo "Dry-run the pipeline first with:     node scraper/automate.js --dry-run"
