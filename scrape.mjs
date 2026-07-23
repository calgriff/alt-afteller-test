// scrape.mjs
// Fetches the ARTIS daily-schedule page and extracts today's ARTIS-Planetarium
// "show" entries (filtering out ARTIS talks, feedings, tours, etc. — the page
// lists everything happening at the zoo that day, not just the Planetarium).
//
// Runs under Node 20+ (has global fetch). Intended to be run by the
// GitHub Actions workflow in .github/workflows/update-schedule.yml, which has
// unrestricted internet access (unlike this sandbox, which can't reach
// artis.nl at all — this script has NOT been run end-to-end against the live
// site yet; check the first workflow run's logs and adjust the regex below
// if it comes back empty).

const SOURCE_URL = "https://www.artis.nl/en/artis-zoo/daily-schedule";

function htmlToRoughText(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        // turn block-level closing tags into line breaks so each schedule
        // item roughly collapses onto its own line(s), same shape as what
        // you'd see reading the rendered page
        .replace(/<\/(h1|h2|h3|h4|p|li|div|section|article|br)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&nbsp;/g, " ")
        .replace(/[ \t]+/g, " ")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
}

// Matches a line like: "show • gratis 11.00 - 11.25 ARTIS-Planetarium"
// or: "show 12.00 - 12.30 ARTIS-Planetarium"
const ENTRY_RE = /^(show|ARTIS talk|activity|guided tour|special program|audio tour|workshop|lecture series|lecture|exhibition|water)\b.*?(\d{1,2})\.(\d{2})\s*-\s*(\d{1,2})\.(\d{2})\s+(.+)$/i;

function parseSchedule(lines) {
    const entries = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(ENTRY_RE);
        if (!m) continue;
        const [, category, sh, sm, eh, em, location] = m;
        if (!/planetarium/i.test(location)) continue;
        if (!/^show$/i.test(category.trim())) continue; // exclude "ARTIS talk" etc.

        // title is usually the nearest preceding non-empty line that isn't
        // itself a schedule-entry line
        let title = null;
        for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
            if (!ENTRY_RE.test(lines[j])) {
                title = lines[j].replace(/^##\s*/, "").trim();
                break;
            }
        }
        if (!title) continue;

        entries.push({
            title,
            starttime: `${sh.padStart(2, "0")}:${sm}`,
            endtime: `${eh.padStart(2, "0")}:${em}`,
        });
    }
    // de-dupe (same title+starttime appearing twice) and sort by time
    const seen = new Set();
    return entries
        .filter((e) => {
            const key = e.title + e.starttime;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((a, b) => a.starttime.localeCompare(b.starttime));
}

async function main() {
    const res = await fetch(SOURCE_URL, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; ARTIS-countdown-demo/1.0)" },
    });
    if (!res.ok) {
        throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    }
    const html = await res.text();
    const lines = htmlToRoughText(html);
    const shows = parseSchedule(lines);

    if (shows.length === 0) {
        console.error("No Planetarium shows parsed — the page structure may");
        console.error("have changed, or the regex needs adjusting. Dumping");
        console.error("the first 60 extracted lines for debugging:");
        console.error(lines.slice(0, 60).join("\n"));
        process.exitCode = 1;
        return;
    }

    const dateStr = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Amsterdam" }); // YYYY-MM-DD
    const output = {
        date: dateStr,
        generatedAt: new Date().toISOString(),
        source: SOURCE_URL,
        shows,
    };

    const fs = await import("node:fs/promises");
    await fs.writeFile("schedule.json", JSON.stringify(output, null, 2) + "\n");
    console.log(`Wrote ${shows.length} shows to schedule.json for ${dateStr}`);
    console.log(shows.map((s) => `  ${s.starttime}-${s.endtime}  ${s.title}`).join("\n"));
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
