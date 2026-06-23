# SwimTopia Opponent Scraping Research

Updated: 2026-06-23

## Goal

Investigate whether the seeder can probe an opponent's public SwimTopia site and, when useful data is available, use that data instead of scraping MyNVSL leader pages. If the probe fails or the public data is incomplete, the seeder should keep the current NVSL scraping path as the fallback.

## Current Seeder Behavior

- `src/seeder/index.html` currently builds opponent ladders from MyNVSL leader pages in `scrape_data()`.
- It selects an opponent from `public/files/teams.json`, then fetches MyNVSL leader pages by team id, year, gender, age group, distance, and stroke.
- If Parklawn's own ladder has been imported, the scraper includes the home team from `your_ladder`; otherwise it only scrapes the selected opponent from NVSL.
- The existing SwimTopia import is home-team only. `server/swimtopia.js` hardcodes `PARKLAWN_SWIMTOPIA_ORG_ID = "27626"` and uses authenticated mobile API calls for roster, absences, and historical results.

## Confirmed Public SwimTopia Surface

- Public team sites use hostnames like `ravensworthravens.swimtopia.com`.
- Public calendar pages can expose meet names, dates, locations, and attached files. Example: Ravensworth's public calendar shows `Time Trials @ Ravensworth` on June 13, 2026, plus A/B meet entries around it.
- Some teams expose result PDFs directly from SwimTopia's CDN. Example: Four Seasons' public calendar has `RESULTS` links for `Time Trials Meet` on June 6, 2026 and later A meets.
- Downloaded Four Seasons' public Time Trials results PDF and confirmed it is a Meet Maestro results report with parseable swimmer rows: event number/title, gender/age group, name, age, team abbreviation, seed, official time, and points.
- The result report footer says `SwimTopia Meet Maestro`, so these PDFs are likely generated from SwimTopia/Meet Maestro data even though they are exposed as static public files.
- SwimTopia's own help docs say Meet Maestro results transfer into the SwimTopia site and appear in browser results, athlete time history, athlete reports, and the mobile app. The same docs separately describe PDF meet result reports as downloadable calendar attachments for viewing, not imported data.
- SwimTopia's mobile app docs say guest users can see public/past meet results when the meet is available and not private, but this is app behavior rather than an open web API.

## Confirmed API/Access Constraints

- `mobile-api.swimtopia.com/mobile/organizations` returns `401` without a bearer token.
- Filtering mobile endpoints by guessed hostname/subdomain also returns `401`.
- `mobile-api.swimtopia.com/mobile/swim-meets?filter[year]=2026` returns `401` without a bearer token.
- A guessed unauthenticated organization search endpoint returned `404`.
- Raw `curl` to public SwimTopia pages often receives a Cloudflare challenge. Browser/indexed access can still see the public pages, so implementation should not assume plain server-side fetch will always work.
- Public pages do not appear to expose a clean organization id in the visible text. The public hostname is easier to discover than a SwimTopia org id.
- Private website pages and team account content require SwimTopia sign-in. Public attachments should be the boundary for an opponent scraper.

## Website / Team Discovery Options

The feature needs a way to map an NVSL team to a SwimTopia hostname before probing.

Practical options:

1. Add optional fields to `public/files/teams.json`, for example:

   ```json
   {
     "Ravensworth Farm": {
       "id": 337,
       "abr": "RF",
       "swimtopia": {
         "host": "ravensworthravens.swimtopia.com"
       }
     }
   }
   ```

2. Build a setup-time discovery step that searches for `<team name> SwimTopia` and stores confirmed hostnames. This is less deterministic and may need manual review.

3. Probe likely subdomain guesses, but this is fragile. Team names and mascots often do not map cleanly to hostnames.

Recommendation: start with explicit optional `swimtopia.host` metadata in `teams.json`, then add assisted discovery later.

## Data Model Fit

Public Meet Maestro result PDFs can probably build the same kind of opponent `sheet_data` entries that NVSL leader pages currently produce:

- `time`: official result
- `name`: swimmer name from the PDF
- `age`: result age
- `team`: result team abbreviation
- `date`: inferred from meet date on the SwimTopia calendar or report title
- `event`: parsed from report event title
- `distance`: parsed from report event title
- `gender`: parsed from event title (`Boys`, `Girls`, `Men`, `Women`)
- `swimmer_id`: unavailable from public PDFs, so use normalized name as key

Important limitation: public PDFs provide meet result rows, not stable SwimTopia athlete ids. That is okay for opponent ladder generation because the existing code already has a name-based fallback via `swimmer_key(entry)`, but it is weaker for detailed swimmer history links.

## Proposed Probe Flow

For the selected opponent:

1. Look for `teams[division][teamName].swimtopia.host`.
2. Fetch/probe `https://${host}/swim_meets` and `https://${host}/swim_meets/past`.
3. Parse visible meet entries and attached file links.
4. Prefer files labeled `RESULTS`; ignore `Heat Sheet`, `Psych Sheet`, and `Athlete Check-in` for ladder construction.
5. Download supported result files, initially PDF.
6. Parse result rows into normalized meet result entries.
7. Keep only this season and previous season, matching current seeder behavior.
8. Reduce to best time per swimmer/event/distance with current-year swim-rate/range fields where possible.
9. If any required step fails, produces too few entries, or finds no usable result files, fall back to the current MyNVSL scrape.

## Parsing Notes

- Meet Maestro PDFs can be extracted with `pdftotext -layout` into predictable sections.
- Event headers look like `#16 Boys 11-12 50m Freestyle`.
- Result rows can include placing numbers or `--` for non-scoring/exhibition rows.
- Ignore rows with `DQ`, `NS`, or blank official times.
- Time Trials reports may include only one team, which is ideal for opponent roster/seed-time discovery.
- A-meet reports may include both teams; filter rows by the selected opponent abbreviation.
- Some names wrap or spacing gets odd in PDF extraction, so parser tests should use real extracted snippets.

## Fallback Decision

Use SwimTopia data only when all are true:

- The selected team has a known `swimtopia.host`.
- Calendar pages can be fetched.
- At least one public `RESULTS` file is found.
- The parser extracts enough valid individual event rows for the selected team.

Otherwise, continue with MyNVSL exactly as today.

## Open Questions

- How many NVSL teams publish results files publicly on their SwimTopia calendars?
- Does Ravensworth publish Time Trials results behind a link not present on the visible public calendar page, or was the public data visible in a prior season/page state?
- Are result files always PDFs, or do some teams publish CSV/HTML/Meet Maestro exports?
- Should setup own a manual `swimtopia.host` override UI, or should it live directly in `teams.json` first?
- Should SwimTopia parsing be implemented server-side only, to avoid browser CORS/file handling issues?

## Useful Source URLs

- Ravensworth public calendar: `https://ravensworthravens.swimtopia.com/swim_meets`
- Ravensworth past events: `https://ravensworthravens.swimtopia.com/swim_meets/past`
- Four Seasons public calendar with visible results attachments: `https://fourseasons.swimtopia.com/swim_meets`
- SwimTopia help, results transfer/upload/PDF attachments: `https://help.swimtopia.com/hc/en-us/articles/200783158-Meet-Results-File-Automated-Transfer-or-Manual-Upload`
- SwimTopia help, mobile app guest access/public meet behavior: `https://help.swimtopia.com/hc/en-us/articles/115002754166-SwimTopia-Mobile-App-Overview-Admin-Info`
- SwimTopia help, account/private page access: `https://help.swimtopia.com/hc/en-us/articles/200783578-Member-Account-Management-and-FAQs-Parents-Guardians-Athletes`

## Implementation Sketch

- Add `server/public-swimtopia.js` for public host probing, calendar parsing, result download, and result normalization.
- Add `POST /api/swimtopia/public-team-results` with `{ host, teamAbr, years }`.
- In `src/seeder/index.html`, before the NVSL loops for the opponent, call the new endpoint when a host is configured.
- If the endpoint returns normalized data, merge it into `sheet_data` and skip NVSL for that opponent.
- Keep NVSL scraping for Parklawn enrichment and for all teams without successful public SwimTopia data.
- Add tests with saved small text fixtures from real Meet Maestro output.
