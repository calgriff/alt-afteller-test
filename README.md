# ARTIS Afteller — bug fix demo, now with live-ish schedule data

This is a standalone recreation of the `artis.nl/nl/narrowcasting/afteller`
countdown widget. It ports the real `1644.js` logic 1:1, with the hourly
reload delayed a few seconds past the hour (the fix for the "00:00 skip"
bug — see `countdown.js` comments for the full explanation).

**What's new in this version:** show times are no longer hardcoded. They're
read from `schedule.json`, which a GitHub Actions workflow regenerates every
30 minutes by scraping the public
[ARTIS daily schedule](https://www.artis.nl/en/artis-zoo/daily-schedule)
page and filtering it down to just the ARTIS-Planetarium **shows** (talks,
feedings, and tours at other locations are excluded).

## Why it's built this way (not a plain client-side fetch)

A browser can't `fetch()` `artis.nl` directly from a page hosted on GitHub
Pages — that page doesn't grant cross-origin permission, so the browser
blocks reading the response (CORS). GitHub Actions runs server-side, so it
isn't affected by that. The flow is:

```
GitHub Actions (every 30 min)
  -> scrape.mjs fetches artis.nl/en/artis-zoo/daily-schedule
  -> filters to ARTIS-Planetarium "show" entries
  -> writes schedule.json
  -> commits it back to the repo

Browser (visiting the GitHub Pages site)
  -> fetches ./schedule.json  (same-origin, no CORS issue)
  -> builds the countdown DOM from it
  -> runs the same countdown/reload-fix logic as before
```

**Caveat:** `scrape.mjs`'s parsing logic was written by inspecting the page's
rendered text (this sandbox can't reach artis.nl to test the real HTML
directly). The regex is reasonably tolerant of formatting, but the first
real run is worth checking — go to the repo's **Actions** tab, open the
"Update ARTIS schedule" run, and check the "Run scraper" step's log. If it
prints "No Planetarium shows parsed", it dumps the first 60 lines of
extracted text so you (or I, if you paste it back to me) can adjust the
regex in `scrape.mjs`.

## Files

- `index.html` — page shell + styling (placeholder styling, not ARTIS's
  actual CSS — no design assets were provided)
- `countdown.js` — the countdown/clock/reload logic, now schedule-driven
- `scrape.mjs` — the scraper (run by the workflow, or manually: `node scrape.mjs`)
- `schedule.json` — the current data; committed to the repo so the page
  works even before the first Action run
- `.github/workflows/update-schedule.yml` — the scheduled job

## Testing the reload-fix behaviour without waiting for a real hour

Add query params to the URL:

- `?fakeNow=13:59:55` — start the page's fake clock at that time today
- `&timeScale=10` — run the fake clock 10x real speed
- `&fixDelay=5` — seconds the reload is delayed past the hour (`0` reproduces
  the *original* bug)

Example — reproduce the bug: `index.html?fakeNow=13:59:55&timeScale=5&fixDelay=0`
Example — see the fix work: `index.html?fakeNow=13:59:55&timeScale=5&fixDelay=5`

The fake clock persists across the page's self-reload (via `sessionStorage`),
so you can actually watch it jump the hour boundary.

## Hosting it on GitHub Pages

1. Create a new repo at https://github.com/new (public is simplest — Pages
   on private repos needs a paid plan).
2. Upload all the files **keeping the folder structure**, especially
   `.github/workflows/update-schedule.yml` — GitHub only recognizes workflow
   files in exactly that path. The web UI's drag-and-drop upload preserves
   folder structure if you drag the whole folder in, but it's more reliable
   to use `git` directly if you're comfortable with it:
   ```
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
3. Go to **Settings → Actions → General**, scroll to "Workflow permissions",
   and select **"Read and write permissions"** — the scraper needs this to
   be able to commit `schedule.json` back.
4. Go to **Settings → Pages**, set Source to "Deploy from a branch", branch
   `main`, folder `/root`, save.
5. Go to the **Actions** tab and manually run "Update ARTIS schedule" once
   (via "Run workflow") to confirm it works and commits a fresh
   `schedule.json`, rather than waiting up to 30 minutes for the first
   scheduled run.
6. Your page will be live at `https://<you>.github.io/<repo>/` shortly after.

When you're done testing: delete the repo, or just disable the workflow
(Actions tab → "Update ARTIS schedule" → "..." → Disable workflow) and turn
Pages off (Settings → Pages → Source → None).
