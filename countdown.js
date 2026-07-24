/**
 * ARTIS narrowcasting countdown widget — schedule-driven rebuild.
 *
 * Data flow:
 *   schedule.json   — today's Planetarium shows (regenerated every 30 min by
 *                     the GitHub Actions workflow running scrape.mjs)
 *   show-info.json  — optional presentation extras per show (Dutch display
 *                     title, description, age rating) that the schedule page
 *                     doesn't expose; safe to edit by hand
 *
 * The "00:00 hold" fix, v2:
 * The original 1644.js scheduled a one-shot 2-minute timeout when the timer
 * hit 00:00 — but the hourly window.location.reload() wiped that timeout, so
 * a show starting exactly on the hour skipped straight to the next show.
 *
 * This version makes the hold STATE-based instead of timeout-based: a show
 * counts as "active" until HOLD_MS (2 minutes) past its start time, so the
 * page shows 00:00 for the full 2 minutes even across a reload. The hourly
 * reload is additionally delayed FIX_DELAY_SECONDS past the hour so the
 * reload never lands on the exact second a show starts.
 */
(function () {
    "use strict";

    const TZ = "Europe/Amsterdam";
    const LOCALE = "en-US";
    const SECOND = 1000;
    const MINUTE = 60 * SECOND;
    const ZERO = "00:00";
    const HOLD_MS = 2 * MINUTE; // how long "00:00" stays up after a show starts

    const LESS_THAN_HOUR_CLASS = "narrowcasting-countdown--less-than-hour";
    const HIDDEN_HIGHLIGHT_CLASS = "narrowcasting-countdown__highlight--is-hidden";
    const HIDDEN_EMPTY_CLASS = "narrowcasting-countdown__empty--is-hidden";
    const HIDDEN_EVENT_CLASS = "event--is-hidden";
    const EMPTY_STATE_CLASS = "countdown--is-empty";

    // ---------------------------------------------------------------------
    // Debug / QA harness — simulate the top-of-hour race condition on demand.
    //
    // URL params:
    //   fakeNow=HH:MM:SS   start the fake clock at this time (today)
    //   timeScale=N        run the fake clock N times faster than real time
    //   fixDelay=N         seconds to delay the hourly reload past the hour
    //                      (0 = reproduce the ORIGINAL reload race, default 5)
    //   debug              just show the debug bar without faking the clock
    //
    // The fake-clock anchor is stored in sessionStorage so it survives the
    // page's own reload — otherwise you'd never see the reload happen
    // mid-test.
    // ---------------------------------------------------------------------
    const params = new URLSearchParams(window.location.search);
    const FIX_DELAY_SECONDS = params.has("fixDelay") ? Number(params.get("fixDelay")) : 5;
    const TIME_SCALE = params.has("timeScale") ? Number(params.get("timeScale")) : 1;
    const debugEnabled = params.has("fakeNow") || sessionStorage.getItem("artis_debug_anchor_fake");
    const showDebugBar = debugEnabled || params.has("debug") || params.has("fixDelay") || params.has("timeScale");

    function initDebugClock() {
        if (params.has("fakeNow")) {
            // fresh anchor requested explicitly, overwrite whatever was stored
            const [h, m, s] = params.get("fakeNow").split(":").map(Number);
            const base = new Date();
            base.setHours(h || 0, m || 0, s || 0, 0);
            sessionStorage.setItem("artis_debug_anchor_fake", String(base.getTime()));
            sessionStorage.setItem("artis_debug_anchor_real", String(Date.now()));
        } else if (!sessionStorage.getItem("artis_debug_anchor_real")) {
            sessionStorage.setItem("artis_debug_anchor_real", String(Date.now()));
        }
    }
    if (debugEnabled) initDebugClock();
    if (showDebugBar) {
        document.addEventListener("DOMContentLoaded", () => {
            const bar = document.getElementById("debug-bar");
            if (bar) bar.hidden = false;
        });
    }

    function getNow() {
        if (!debugEnabled) {
            return new Date(new Date().toLocaleString(LOCALE, { timeZone: TZ }));
        }
        const anchorFake = Number(sessionStorage.getItem("artis_debug_anchor_fake"));
        const anchorReal = Number(sessionStorage.getItem("artis_debug_anchor_real"));
        const elapsedReal = Date.now() - anchorReal;
        return new Date(anchorFake + elapsedReal * TIME_SCALE);
    }

    function updateDebugBar(now) {
        if (!showDebugBar) return;
        const nowEl = document.getElementById("dbg-now");
        const fixEl = document.getElementById("dbg-fixdelay");
        if (nowEl) nowEl.textContent = now.toTimeString().slice(0, 8) + (debugEnabled ? " (fake, x" + TIME_SCALE + ")" : " (real)");
        if (fixEl) fixEl.textContent = String(FIX_DELAY_SECONDS);
    }

    function setDebugSource(text) {
        const el = document.getElementById("dbg-source");
        if (el) el.textContent = text;
    }

    // ---------------------------------------------------------------------
    // Schedule loading + DOM construction
    // ---------------------------------------------------------------------

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    // "Habitat Earth (EN)" -> { title: "Habitat Earth", language: "English" }
    function splitLanguage(rawTitle) {
        const m = rawTitle.match(/\s*\(\s*(NL\s*\+\s*EN|EN\s*\+\s*NL|NL\s*\/\s*EN|NL|EN)\s*\)\s*$/i);
        if (!m) return { title: rawTitle.trim(), language: "" };
        const code = m[1].replace(/\s+/g, "").toUpperCase();
        const language =
            code === "NL" ? "Nederlands" :
            code === "EN" ? "English" :
            "Nederlands // English";
        return { title: rawTitle.slice(0, m.index).trim(), language };
    }

    function durationMinutes(starttime, endtime) {
        if (!starttime || !endtime) return null;
        const [sh, sm] = starttime.split(":").map(Number);
        const [eh, em] = endtime.split(":").map(Number);
        const mins = (eh * 60 + em) - (sh * 60 + sm);
        return mins > 0 ? mins : null;
    }

    function buildDom(schedule, infoMap) {
        const highlightsContainer = document.getElementById("highlights-container");
        const listContainer = document.getElementById("list-container");
        if (!highlightsContainer || !listContainer) return;

        (schedule.shows || []).forEach((show) => {
            const { title: cleanTitle, language } = splitLanguage(show.title || "");
            const info = infoMap[cleanTitle.toLowerCase()] || {};
            const displayTitle = escapeHtml(info.displayTitle || cleanTitle);
            const description = escapeHtml(info.description || "");
            const age = escapeHtml(info.age || "");
            const mins = durationMinutes(show.starttime, show.endtime);
            const starttime = escapeHtml(show.starttime || "");

            const metaParts = [];
            if (age) metaParts.push(`<span>${age}</span>`);
            if (language) metaParts.push(`<span>${escapeHtml(language)}</span>`);
            if (mins) metaParts.push(`<span>Duur: ${mins} minuten</span>`);

            highlightsContainer.insertAdjacentHTML("beforeend", `
              <div class="narrowcasting-countdown__highlight ${HIDDEN_HIGHLIGHT_CLASS}"
                   js-hook-narrowcasting-countdown-highlight data-starttime="${starttime}">
                <p class="highlight__over">Over</p>
                <p class="highlight__time" js-hook-narrowcasting-countdown-timer>--:--</p>
                <p class="highlight__minuten">minuten</p>
                <p class="highlight__begint">begint</p>
                <h1 class="highlight__title">${displayTitle}</h1>
                <div class="highlight__info">
                  <div class="highlight__meta">${metaParts.join("")}</div>
                  ${description ? `<p class="highlight__description">${description}</p>` : ""}
                </div>
              </div>`);

            listContainer.insertAdjacentHTML("beforeend", `
              <li class="event ${HIDDEN_EVENT_CLASS}"
                  js-hook-narrowcasting-countdown-event data-starttime="${starttime}">
                <p class="event__time">${starttime}</p>
                <div class="event__body">
                  <h2 class="event__title">${displayTitle}</h2>
                </div>
              </li>`);
        });
    }

    // ---------------------------------------------------------------------
    // Core countdown logic (ported from 1644.js, renamed for readability)
    // ---------------------------------------------------------------------

    function convertTimeToDate(timeStr, now) {
        const [h, m, s] = timeStr.split(":");
        const d = new Date(now.getTime());
        d.setHours(Number(h || 0));
        d.setMinutes(Number(m || 0));
        d.setSeconds(Number(s || 0));
        d.setMilliseconds(0);
        return d;
    }

    function formatDuration(startTime, now, elementForClass) {
        const diff = startTime.getTime() - now.getTime();
        if (diff <= 0) return ZERO; // show has started -> hold on 00:00
        const hours = Math.floor((diff % (MINUTE * 60 * 24)) / (MINUTE * 60));
        const minutes = Math.floor((diff % (MINUTE * 60)) / MINUTE);
        const seconds = Math.floor((diff % MINUTE) / SECOND);
        const mm = String(minutes).padStart(2, "0");
        const ss = String(seconds).padStart(2, "0");
        if (hours < 1) {
            elementForClass.classList.add(LESS_THAN_HOUR_CLASS);
            return `${mm}:${ss}`;
        }
        elementForClass.classList.remove(LESS_THAN_HOUR_CLASS);
        return `${String(hours).padStart(2, "0")}:${mm}:${ss}`;
    }

    // A show counts as "active" from now until HOLD_MS past its start, so the
    // 2-minute 00:00 hold is derived from the clock and survives reloads.
    // Returns true if an active highlight has been found (this one or earlier).
    function checkIfIsUpcoming(el, now, startTime, alreadyFoundActive) {
        if (startTime.getTime() + HOLD_MS <= now.getTime()) {
            el.classList.add(HIDDEN_HIGHLIGHT_CLASS);
            return alreadyFoundActive;
        }
        if (!alreadyFoundActive) {
            el.classList.remove(HIDDEN_HIGHLIGHT_CLASS);
            return true;
        }
        el.classList.add(HIDDEN_HIGHLIGHT_CLASS);
        return alreadyFoundActive;
    }

    class NarrowcastingCountdown {
        constructor(el) {
            this.element = el;
            this.clockElement = el.querySelector("[js-hook-narrowcasting-countdown-clock]");
            this.emptyElement = el.querySelector("[js-hook-narrowcasting-countdown-empty]");
            this.highlightElements = Array.from(el.querySelectorAll("[js-hook-narrowcasting-countdown-highlight]"));
            this.eventElements = Array.from(el.querySelectorAll("[js-hook-narrowcasting-countdown-event]"));
            this._tickHandle = null;
            this._updateCountdown();
            this._scheduleNextHourCheck();
        }

        _updateCountdown() {
            const now = getNow();
            updateDebugBar(now);
            this._initTimer(now);
            this._initClock(now);
            this._scheduleTick();
        }

        _initTimer(now) {
            let foundActive = false;
            let activeStartMs = null;
            this.highlightElements.forEach((el) => {
                const startTime = convertTimeToDate(el.getAttribute("data-starttime") || "", now);
                const isUpcoming = checkIfIsUpcoming(el, now, startTime, foundActive);
                if (!foundActive && isUpcoming) {
                    this._updateTimer(el, now, startTime);
                    activeStartMs = startTime.getTime();
                }
                foundActive = isUpcoming;
            });
            if (this.emptyElement) {
                this.emptyElement.classList.toggle(HIDDEN_EMPTY_CLASS, foundActive);
            }
            this.element.classList.toggle(EMPTY_STATE_CLASS, !foundActive);
            this._syncEventList(now, activeStartMs);
        }

        _updateTimer(el, now, startTime) {
            const timerEl = el.querySelector("[js-hook-narrowcasting-countdown-timer]");
            if (timerEl) timerEl.innerHTML = formatDuration(startTime, now, el);
        }

        // Hide list entries that already started or are the currently
        // highlighted show — the list only shows what comes AFTER it.
        _syncEventList(now, activeStartMs) {
            this.eventElements.forEach((el) => {
                const startMs = convertTimeToDate(el.getAttribute("data-starttime") || "", now).getTime();
                const isPast = startMs + HOLD_MS <= now.getTime();
                const isActiveOrEarlier = activeStartMs !== null && startMs <= activeStartMs;
                el.classList.toggle(HIDDEN_EVENT_CLASS, isPast || isActiveOrEarlier);
            });
        }

        _initClock(now) {
            if (!this.clockElement) return;
            const fmt = new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
            this.clockElement.innerHTML = fmt.format(now);
        }

        _scheduleTick() {
            if (this._tickHandle) clearTimeout(this._tickHandle);
            this._tickHandle = setTimeout(() => this._updateCountdown(), SECOND / (debugEnabled ? TIME_SCALE : 1));
        }

        // --- reload-delay part of THE FIX ---------------------------------
        _scheduleNextHourCheck() {
            const now = getNow();
            const nextHour = new Date(now.getTime());
            nextHour.setHours(now.getHours() + 1, 0, FIX_DELAY_SECONDS, 0); // was (h+1, 0, 0, 0)
            let msUntilReload = nextHour.getTime() - now.getTime();
            if (debugEnabled) msUntilReload = msUntilReload / TIME_SCALE;

            const reloadEl = document.getElementById("dbg-reload");
            if (reloadEl) {
                const tick = () => {
                    reloadEl.textContent = Math.max(0, Math.round(msUntilReload / 1000)) + "s";
                };
                tick();
                const interval = setInterval(() => {
                    msUntilReload -= 1000;
                    tick();
                    if (msUntilReload <= 0) clearInterval(interval);
                }, 1000);
            }

            window.setTimeout(() => {
                flashScreen();
                setTimeout(() => window.location.reload(), 250);
            }, Math.max(0, nextHour.getTime() - now.getTime()) / (debugEnabled ? TIME_SCALE : 1));
        }
    }

    function flashScreen() {
        const el = document.getElementById("flash");
        if (!el) return;
        el.classList.add("active");
    }

    async function fetchJson(url) {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
        return res.json();
    }

    async function init() {
        const el = document.querySelector("[js-hook-narrowcasting-countdown]");
        if (!el) return;

        let schedule = { shows: [] };
        try {
            schedule = await fetchJson("schedule.json");
        } catch (err) {
            setDebugSource("schedule.json failed: " + err.message);
        }

        // Ignore a stale schedule from a previous day (e.g. the scraper
        // hasn't succeeded yet today) — better to show "done for today"
        // than to count down to yesterday's times.
        const today = getNow().toLocaleDateString("en-CA");
        if (schedule.date && schedule.date !== today && !debugEnabled) {
            setDebugSource(`stale (${schedule.date}), showing empty state`);
            schedule = { shows: [] };
        } else if (schedule.shows) {
            setDebugSource(`${schedule.shows.length} shows (${schedule.date || "no date"})`);
        }

        let infoMap = {};
        try {
            const raw = await fetchJson("show-info.json");
            Object.keys(raw).forEach((key) => {
                if (key.startsWith("_")) return;
                infoMap[key.toLowerCase()] = raw[key];
            });
        } catch (err) {
            // presentation extras are optional
        }

        buildDom(schedule, infoMap);
        new NarrowcastingCountdown(el);
    }

    document.addEventListener("DOMContentLoaded", init);
})();
