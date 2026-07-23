/**
 * Recreation of ARTIS's narrowcasting countdown widget (chunk 1644.js),
 * de-obfuscated and with the hourly-reload / "00:00 hold" race condition fixed.
 *
 * Original bug: window.location.reload() fires at exactly HH:00:00.000, the
 * same instant shows are scheduled to start. A reload can never complete in
 * 0ms, so the first check after reload already finds the show's start time
 * slightly in the past -> it skips straight to the next show instead of
 * holding on "00:00" for 2 minutes.
 *
 * Fix: delay the hourly reload by FIX_DELAY_SECONDS past the hour, so any
 * show starting exactly on the hour gets at least one full second-tick to
 * render "00:00" (and schedule its 2-minute hold) before the reload can
 * wipe the page's state.
 *
 * A debug harness (URL query params) lets you fast-forward a fake clock to
 * verify this without waiting for a real hour boundary. See README.md.
 */
(function () {
    "use strict";

    const TZ = "Europe/Amsterdam";
    const LOCALE = "en-US";
    const SECOND = 1000;
    const MINUTE = 60 * SECOND;
    const ZERO = "00:00";

    const LESS_THAN_HOUR_CLASS = "narrowcasting-countdown--less-than-hour";
    const HIDDEN_HIGHLIGHT_CLASS = "narrowcasting-countdown__highlight--is-hidden";

    // ---------------------------------------------------------------------
    // Debug / QA harness — lets you simulate the exact top-of-hour race
    // condition on demand instead of waiting for a real clock hour.
    //
    // URL params:
    //   fakeNow=HH:MM:SS   start the fake clock at this time (today)
    //   timeScale=N        run the fake clock N times faster than real time
    //   fixDelay=N         seconds to delay the hourly reload past the hour
    //                      (0 = reproduce the ORIGINAL bug, default = 5)
    //
    // The fake-clock anchor is stored in sessionStorage so it survives the
    // page's own reload — otherwise you'd never see the reload actually
    // happen mid-test.
    // ---------------------------------------------------------------------
    const params = new URLSearchParams(window.location.search);
    const FIX_DELAY_SECONDS = params.has("fixDelay") ? Number(params.get("fixDelay")) : 5;
    const TIME_SCALE = params.has("timeScale") ? Number(params.get("timeScale")) : 1;
    const debugEnabled = params.has("fakeNow") || sessionStorage.getItem("artis_debug_anchor_fake");

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
        const nowEl = document.getElementById("dbg-now");
        const fixEl = document.getElementById("dbg-fixdelay");
        if (nowEl) nowEl.textContent = now.toTimeString().slice(0, 8) + (debugEnabled ? "  (fake, x" + TIME_SCALE + ")" : "  (real)");
        if (fixEl) fixEl.textContent = String(FIX_DELAY_SECONDS);
    }

    // ---------------------------------------------------------------------
    // Core logic (ported 1:1 from 1644.js, renamed for readability)
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
        if (diff <= 0) return ZERO;
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

    // returns true if this highlight is "upcoming" (not yet started)
    function checkIfIsUpcoming(el, now, startTime, alreadyFoundActive) {
        if (startTime.getTime() < now.getTime()) {
            el.classList.add(HIDDEN_HIGHLIGHT_CLASS);
            return alreadyFoundActive;
        }
        if (!alreadyFoundActive) {
            el.classList.remove(HIDDEN_HIGHLIGHT_CLASS);
            return true;
        }
        return alreadyFoundActive;
    }

    class NarrowcastingCountdown {
        constructor(el) {
            this.element = el;
            this.clockElement = el.querySelector("[js-hook-narrowcasting-countdown-clock]");
            this.emptyElement = el.querySelector("[js-hook-narrowcasting-countdown-empty]");
            this.highlightElements = Array.from(el.querySelectorAll("[js-hook-narrowcasting-countdown-highlight]"));
            this._tickHandle = null;
            this._updateCountdown();
            this._scheduleNextHourCheck();
        }

        _updateCountdown() {
            const now = getNow();
            updateDebugBar(now);
            this._initTimer(now);
            this._initEvents(now);
            this._initClock(now);
        }

        _initTimer(now) {
            let foundActive = false;
            this.highlightElements.forEach((el) => {
                const startTime = convertTimeToDate(el.getAttribute("data-starttime") || "", now);
                const isUpcoming = checkIfIsUpcoming(el, now, startTime, foundActive);
                if (!foundActive && isUpcoming) {
                    this._updateTimer(el, now, startTime);
                }
                foundActive = isUpcoming;
            });
            if (!foundActive && this.emptyElement) {
                this.emptyElement.classList.remove("narrowcasting-countdown__empty--is-hidden");
            }
        }

        _updateTimer(el, now, startTime) {
            const timerEl = el.querySelector("[js-hook-narrowcasting-countdown-timer]");
            const text = formatDuration(startTime, now, el);
            const nextDelayMs = text === ZERO ? 2 * MINUTE : SECOND;
            if (timerEl) timerEl.innerHTML = text;
            if (this._tickHandle) clearTimeout(this._tickHandle);
            this._tickHandle = setTimeout(() => this._updateCountdown(), nextDelayMs / (debugEnabled ? TIME_SCALE : 1));
        }

        _initEvents(now) {
            Array.from(this.element.querySelectorAll("[js-hook-narrowcasting-countdown-event]")).forEach((el) => {
                const startTime = convertTimeToDate(el.getAttribute("data-starttime") || "", now);
                if (startTime.getTime() < now.getTime()) el.remove();
            });
        }

        _initClock(now) {
            if (!this.clockElement) return;
            const fmt = new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
            this.clockElement.innerHTML = fmt.format(now);
        }

        // --- THE FIX lives here -------------------------------------------------
        _scheduleNextHourCheck() {
            const now = getNow();
            const nextHour = new Date(now.getTime());
            nextHour.setHours(now.getHours() + 1, 0, FIX_DELAY_SECONDS, 0); // was (h+1, 0, 0, 0)
            let msUntilReload = nextHour.getTime() - now.getTime();
            if (debugEnabled) msUntilReload = msUntilReload / TIME_SCALE;

            const reloadEl = document.getElementById("dbg-reload");
            if (reloadEl) {
                const tick = () => {
                    const secsLeft = Math.max(0, Math.round(msUntilReload / 1000));
                    reloadEl.textContent = secsLeft + "s";
                };
                tick();
                const interval = setInterval(() => {
                    msUntilReload -= 1000 * (debugEnabled ? 1 : 1);
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

    document.addEventListener("DOMContentLoaded", () => {
        const el = document.querySelector("[js-hook-narrowcasting-countdown]");
        if (el) new NarrowcastingCountdown(el);
    });
})();
