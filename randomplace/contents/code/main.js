/*
 * RandomPlace - KWin script for Plasma 6
 *
 * Goal: spread OLED wear. Window borders and title bars are the static,
 * high-contrast parts of a desktop, so they should not keep landing on the
 * same pixels.
 *
 *  1. Randomness first. New windows and reshuffles pick positions at random,
 *     with a preference (not a rule) for exposing more of the windows you use
 *     most. How strongly variety wins over exposure is one setting: `variety`.
 *  2. Wear map. The script records, per screen and across logins, how long
 *     window borders and title bars have been shown on each part of the
 *     screen, and steers new positions towards less-worn areas.
 *  3. Usage. Windows of apps you use more (and windows focused recently) are
 *     covered less; per-app usage is remembered across logins.
 *  4. A global shortcut reshuffles the current desktop.
 *
 * Persistence goes through a small helper service (KWin scripts cannot
 * write files). Without the helper everything still works for the session.
 *
 * Settings: ~/.config/kwinrc, group [Script-randomplace] (see README.md).
 */
"use strict";

// ---------------------------------------------------------------- settings

function num(key, def) {
    const v = Number(readConfig(key, def));
    return isFinite(v) ? v : def;
}
function bool(key, def) {
    const v = readConfig(key, def);
    return v === true || v === "true" || v === 1 || v === "1";
}

// Read on load, and again before every placement and reshuffle so changes
// made in System Settings apply without reloading the script.
const CFG = {};
function loadConfig() {
    const prevCell = CFG.wearCell;
    Object.assign(CFG, readSettings());
    if (prevCell !== undefined && prevCell !== CFG.wearCell) regridWearMaps();
}
function readSettings() { return {
    // Random positions tried for a new window.
    candidates: Math.max(50, Math.round(num("candidates", 600))),
    // Randomness vs. exposure. 0 = always the best spot found; 1 = a spot
    // that hides ~5% more of an average window is still reasonably likely;
    // higher = more variety, more overlap.
    variety: Math.max(0, num("variety", 1)),
    // 0..1: how much recency counts vs. accumulated per-app focus time.
    recencyWeight: Math.min(1, Math.max(0, num("recencyWeight", 0.6))),
    recencyHalfLifeSec: Math.max(1, num("recencyHalfLifeSec", 600)),
    // Covering even an unused window costs a little; covering a hot one costs more.
    baseOverlapCost: Math.max(0, num("baseOverlapCost", 0.15)),
    // Pixels kept free from the edges of the usable screen area.
    margin: Math.max(0, num("margin", 0)),
    // Reshuffle search: time budget per screen and cap on layouts tried.
    optimizeMs: Math.max(10, num("optimizeMs", 150)),
    maxRestarts: Math.max(3, Math.round(num("maxRestarts", 300))),
    // Wear map.
    wear: bool("wear", true),
    wearWeight: Math.max(0, num("wearWeight", 1)),
    wearCell: Math.max(8, Math.round(num("wearCell", 20))),
    wearHalfLifeDays: Math.max(1, num("wearHalfLifeDays", 180)),
    // (at most 20 s: the helper's clock reply must beat D-Bus's 25 s timeout)
    wearSampleSec: Math.min(20, Math.max(1, num("wearSampleSec", 5))),
    titleBarHeight: Math.max(0, num("titleBarHeight", 32)),
    // Persistence of per-app usage (and the wear map).
    persist: bool("persist", true),
    usageHalfLifeDays: Math.max(0.1, num("usageHalfLifeDays", 14)),
    saveIntervalSec: Math.max(10, num("saveIntervalSec", 120)),
    // A single uninterrupted stretch never counts for more than this, for
    // both focus time and wear (stops an idle or locked screen inflating it).
    idleCapSec: Math.max(10, num("idleCapSec", 600)),
    maxApps: Math.max(10, Math.round(num("maxApps", 200))),
    debug: bool("debug", false),
    // Dialogs stay over their parent: they move with it on reshuffle, and
    // dialogs that don't say who their parent is are centered over it.
    keepDialogsWithParent: bool("keepDialogsWithParent", true),
    // Undo size changes an app makes on its own right after being moved.
    keepSizeOnMove: bool("keepSizeOnMove", true),
    // Automatic reshuffle: every autoReshuffleMin minutes, but only once you
    // have been idle for autoIdleSec (or right after unlocking, if due).
    autoReshuffle: bool("autoReshuffle", true),
    autoReshuffleMin: Math.max(5, Math.round(num("autoReshuffleMin", 45))),
    autoIdleSec: Math.max(10, Math.round(num("autoIdleSec", 120))),
    reshuffleOnUnlock: bool("reshuffleOnUnlock", true),
    // Drift: every driftEverySec, while idle for driftIdleSec, each window
    // moves driftPx pixels along its own slowly turning direction.
    drift: bool("drift", true),
    driftEverySec: Math.max(10, Math.round(num("driftEverySec", 60))),
    driftPx: Math.max(1, Math.round(num("driftPx", 2))),
    driftIdleSec: Math.max(10, Math.round(num("driftIdleSec", 20))),
    excludeClasses: String(readConfig("excludeClasses",
        "krunner,plasmashell,ksplashqml,kwin_wayland,xwaylandvideobridge," +
        "org.kde.polkit-kde-authentication-agent-1,ksmserver-logout-greeter"))
        .split(",").map(function (s) { return s.trim().toLowerCase(); })
        .filter(function (s) { return s.length > 0; }),
}; }
loadConfig();

const STORE = {
    service: "local.randomplace.Store",
    path: "/local/randomplace/Store",
    iface: "local.randomplace.Store",
};

// Always printed (load message, errors).
function say(msg) { print("randomplace: " + msg); }
// Only printed when debug=true.
function log(msg) { if (CFG.debug) say(msg); }
const logOuter = log;

// Run fn; report any exception instead of failing silently inside KWin.
function guard(name, fn) {
    return function () {
        try {
            return fn.apply(null, arguments);
        } catch (e) {
            say("ERROR in " + name + ": " + e + (e && e.stack ? "\n" + e.stack : ""));
        }
    };
}

// -------------------------------------------------------- API compatibility

function allWindows() {
    if (typeof workspace.windowList === "function") return workspace.windowList();
    return workspace.stackingOrder || [];
}

function allOutputs() {
    if (workspace.screens && workspace.screens.length) return workspace.screens;
    return workspace.activeScreen ? [workspace.activeScreen] : [];
}

function clientAreaFor(output, desktop, win) {
    try {
        return workspace.clientArea(KWin.PlacementArea, output, desktop);
    } catch (e) {
        if (win) return workspace.clientArea(KWin.PlacementArea, win);
        throw e;
    }
}

// ---------------------------------------------------------- usage tracking
//
// apps:    app key (window class) -> { ms, ts, last }
//          ms is focus time that decays with a half-life of usageHalfLifeDays;
//          it is exact at time ts and decays from there.
// winLast: window id -> last time that window had focus (this session only).

const apps = new Map();
const winLast = new Map();
let current = null;        // currently focused window
let currentSince = 0;      // when its current focus stretch started
let dirty = false;         // something changed since last save
let screenLocked = false;   // set from the screen saver's lock state on every clock tick
let lastReshuffleAt = Date.now();   // any reshuffle (shortcut or automatic)

function halfLifeMs() { return CFG.usageHalfLifeDays * 86400000; }

function wid(w) { return String(w.internalId); }

function appKey(w) {
    const k = String(w.resourceClass || w.desktopFileName || "").trim().toLowerCase();
    return k || "unknown";
}

function excluded(w) {
    return CFG.excludeClasses.indexOf(String(w.resourceClass).toLowerCase()) !== -1;
}

function decayed(a, now) {
    return a.ms * Math.pow(0.5, Math.max(0, now - a.ts) / halfLifeMs());
}

// Book the focused window's time up to `now` to its app.
function credit(now) {
    const w = current;
    const since = currentSince;
    currentSince = now;
    if (!w || excluded(w) || screenLocked) return;
    const delta = Math.min(Math.max(0, now - since), stretchCapMs(now));
    const k = appKey(w);
    let a = apps.get(k);
    if (!a) { a = { ms: 0, ts: now, last: 0 }; apps.set(k, a); }
    a.ms = decayed(a, now) + delta;
    a.ts = now;
    a.last = now;
    winLast.set(wid(w), now);
    if (delta > 0) dirty = true;
}

function onActivated(w) {
    const now = Date.now();
    sampleWear(now, false);
    credit(now);
    current = w || null;
    currentSince = now;
    if (current) winLast.set(wid(current), now);
    maybeSave(now, false);
}

// Usage score in 0..1 for each window: a blend of how recently that window
// was focused and how much (decayed) focus time its app has had, relative to
// the busiest app among `windows`.
function usageScores(windows) {
    const now = Date.now();
    credit(now);
    let maxFreq = 0;
    const freq = windows.map(function (w) {
        const a = apps.get(appKey(w));
        const v = a ? decayed(a, now) : 0;
        if (v > maxFreq) maxFreq = v;
        return v;
    });
    const out = new Map();
    windows.forEach(function (w, i) {
        const f = maxFreq > 0 ? freq[i] / maxFreq : 0;
        const last = winLast.get(wid(w)) || 0;
        const rec = last > 0
            ? Math.pow(0.5, (now - last) / 1000 / CFG.recencyHalfLifeSec)
            : 0;
        out.set(wid(w), CFG.recencyWeight * rec + (1 - CFG.recencyWeight) * f);
    });
    return out;
}

// ----------------------------------------------------------- window checks

function onDesktop(w, desktop) {
    if (w.onAllDesktops) return true;
    const ds = w.desktops || [];
    for (let i = 0; i < ds.length; i++) if (ds[i] === desktop) return true;
    return false;
}

// Plasma Activities: an empty list means "on all activities".
function onActivity(w, activity) {
    const acts = w.activities;
    if (!acts || acts.length === 0 || !activity) return true;
    for (let i = 0; i < acts.length; i++) if (acts[i] === activity) return true;
    return false;
}

function stackIndex() {
    const order = workspace.stackingOrder || allWindows();   // bottom -> top
    const z = new Map();
    for (let i = 0; i < order.length; i++) z.set(wid(order[i]), i);
    return z;
}

function goodRect(a) {
    return a && isFinite(a.x) && isFinite(a.y) && a.width > 0 && a.height > 0;
}

let warnedMargin = false;
function usableArea(win, output, desktop, noMargin) {
    let a = null;
    try { a = clientAreaFor(output, desktop, win); } catch (e) { say("clientArea failed: " + e); }
    if (!goodRect(a)) {
        say("clientArea gave an unusable rectangle (" + JSON.stringify(a) + "); using output geometry");
        a = output && output.geometry;
    }
    if (!goodRect(a)) a = workspace.virtualScreenGeometry;
    if (!goodRect(a)) throw new Error("no usable screen area");
    const plain = { x: a.x, y: a.y, width: a.width, height: a.height };
    const m = CFG.margin;
    if (noMargin || !m) return plain;
    const r = { x: a.x + m, y: a.y + m, width: a.width - 2 * m, height: a.height - 2 * m };
    if (r.width < 200 || r.height < 200) {
        if (!warnedMargin) { warnedMargin = true; say("margin " + m + " px leaves too little room; ignoring it"); }
        return plain;
    }
    return r;
}

// ---------------------------------------------------------------- dialogs
//
// Dialogs belong over the window they came from. KWin already places a
// dialog over its parent when the dialog names one (transientFor); this
// script never moves dialogs on its own, and on reshuffle moves each dialog
// together with its parent so the two stay together. Some dialogs don't name
// a parent: notably file dialogs shown by the desktop portal (a separate
// process) on Wayland, which arrive as ordinary windows of another app. Those
// are recognized and centered over the window they most likely belong to: the
// most recently used window of the same app, or else the active window.

const PORTAL_CLASSES = ["xdg-desktop-portal-kde", "org.freedesktop.impl.portal.desktop.kde",
                        "xdg-desktop-portal-gtk", "xdg-desktop-portal-gnome"];
const dialogParent = new Map();   // dialog window id -> window it was centered over

function isPortal(w) {
    return PORTAL_CLASSES.indexOf(String(w.resourceClass || "").toLowerCase()) !== -1;
}

// A dialog-like or child window (never laid out on its own).
function isChild(w) {
    return !!(w.transient || w.transientFor || w.dialog || w.modal || w.utility || w.splash || isPortal(w));
}

// The window a child belongs to, following parents up to a top-level window.
function topParent(w) {
    let p = w, guard = 0;
    while (p && guard++ < 10) {
        const next = p.transientFor || dialogParent.get(wid(p));
        if (!next || next === p) break;
        p = next;
    }
    return p === w ? null : p;
}

// A dialog that does not name its parent.
function isOrphanDialog(w) {
    if (!w || w.transientFor || excluded(w)) return false;
    return !!(w.dialog || w.modal || w.transient || isPortal(w));
}

function guessParent(w) {
    const desktop = (w.desktops && w.desktops.length) ? w.desktops[0] : workspace.currentDesktop;
    const ok = function (o) {
        return o && o !== w && o.normalWindow && !o.deleted && !o.minimized && !isChild(o) &&
               onDesktop(o, desktop);
    };
    let best = null, bestT = -1;
    allWindows().forEach(function (o) {
        if (!ok(o)) return;
        const same = (w.pid && o.pid === w.pid) || appKey(o) === appKey(w);
        if (!same) return;
        const t = winLast.get(wid(o)) || 0;
        if (t > bestT) { bestT = t; best = o; }
    });
    if (best) return best;
    const a = workspace.activeWindow;
    if (ok(a)) return a;
    // the dialog may already be active: fall back to the most recently focused window
    allWindows().forEach(function (o) {
        if (!ok(o)) return;
        const t = winLast.get(wid(o)) || 0;
        if (t > bestT) { bestT = t; best = o; }
    });
    return best;
}

function clampInto(x, y, w, h, area) {
    return {
        x: Math.round(clamp(x, area.x, area.x + area.width - w)),
        y: Math.round(clamp(y, area.y, area.y + area.height - h)),
    };
}

const centerOverParent = guard("centerOverParent", function (w) {
    const p = guessParent(w);
    if (!p) { log("dialog '" + w.caption + "': no parent found, left where KWin put it"); return; }
    const g = w.frameGeometry, pg = p.frameGeometry;
    const pds = p.desktops || [];
    const area = usableArea(p, p.output, pds.length ? pds[0] : workspace.currentDesktop);
    const pos = clampInto(pg.x + (pg.width - g.width) / 2, pg.y + (pg.height - g.height) / 2,
                          g.width, g.height, area);
    dialogParent.set(wid(w), p);
    log("dialog '" + w.caption + "' centered over '" + p.caption + "'");
    moveTo(w, pos.x, pos.y);
});

// After a reshuffle moved some windows: move their dialogs by the same amount.
function moveDialogsWith(moved, area) {
    if (!CFG.keepDialogsWithParent || moved.size === 0) return 0;
    let n = 0;
    allWindows().forEach(function (c) {
        if (c.deleted || c.minimized || !isChild(c)) return;
        const p = topParent(c);
        const d = p && moved.get(wid(p));
        if (!d) return;
        const g = c.frameGeometry;
        const pos = clampInto(g.x + d.dx, g.y + d.dy, g.width, g.height, area);
        if (moveTo(c, pos.x, pos.y)) n++;
    });
    return n;
}

// A window we are allowed to relocate. Returns "" if yes, else the reason.
function whyNot(w) {
    if (!w) return "no window";
    if (!w.normalWindow) return "not a normal window";
    if (w.deleted) return "deleted";
    if (w.dialog) return "dialog";
    if (w.transient) return "transient";
    if (isChild(w)) return "dialog or child window";
    if (w.fullScreen) return "fullscreen";
    if (w.minimized) return "minimized";
    if (w.moveable === false) return "not moveable";
    if (w.tile) return "tiled";
    if (excluded(w)) return "excluded class " + w.resourceClass;
    return "";
}

// Roughly maximized (covers the whole usable area): moving it is meaningless.
function fillsArea(w, area) {
    const g = w.frameGeometry;
    return g.width >= area.width - 2 && g.height >= area.height - 2;
}

// ------------------------------------------------- maximized / snapped windows
//
// Moving a maximized (fully, vertically or horizontally) or snapped window
// makes KWin restore its earlier size, so such windows are left alone.
// KWin doesn't expose the maximize state as a property, so it is tracked from
// the maximizedAboutToChange(mode) signal (mode: 0 none, 1 vertical,
// 2 horizontal, 3 both), and also recognized from the geometry, which covers
// windows that were already maximized when the script started.

const maxMode = new Map();       // window id -> last known maximize mode
const maxTracked = {};

function trackMaximize(w) {
    if (!w || maxTracked[wid(w)]) return;
    try {
        w.maximizedAboutToChange.connect(function (mode) {
            maxMode.set(wid(w), Number(mode) || 0);
            log("'" + w.caption + "' maximize mode -> " + Number(mode));
        });
        maxTracked[wid(w)] = true;
    } catch (e) { /* signal not available */ }
}

function maximizeArea(output, desktop, area) {
    let m = null;
    try { m = workspace.clientArea(KWin.MaximizeArea !== undefined ? KWin.MaximizeArea : KWin.PlacementArea, output, desktop); }
    catch (e) { m = null; }
    return goodRect(m) ? m : area;
}

// Non-empty reason if `w` is maximized or snapped (so it must not be moved).
function maximizedReason(w, output, desktop, area) {
    const mode = maxMode.get(wid(w));
    if (mode) return "maximized" + (mode === 1 ? " vertically" : mode === 2 ? " horizontally" : "");
    if (w.tile) return "snapped/tiled";
    const m = maximizeArea(output, desktop, area);
    const g = w.frameGeometry;
    const near = function (a, b) { return Math.abs(a - b) < 2.5; };
    const fullW = near(g.x, m.x) && near(g.width, m.width);
    const fullH = near(g.y, m.y) && near(g.height, m.height);
    if (fullW && fullH) return "maximized";
    if (fullH) return "maximized vertically or snapped to a side";
    if (fullW) return "maximized horizontally or snapped to top/bottom";
    const halfW = near(g.width, m.width / 2), halfH = near(g.height, m.height / 2);
    const atX = near(g.x, m.x) || near(g.x + g.width, m.x + m.width);
    const atY = near(g.y, m.y) || near(g.y + g.height, m.y + m.height);
    if (halfW && halfH && atX && atY) return "snapped to a quarter";
    return "";
}

// Visible windows on this output + desktop + activity (each virtual desktop,
// activity and screen is laid out on its own).
function visibleOn(output, desktop, activity, exclude) {
    return allWindows().filter(function (o) {
        return o !== exclude && o.normalWindow && !o.deleted && !o.minimized &&
               !o.fullScreen && o.output === output &&
               onDesktop(o, desktop) && onActivity(o, activity);
    });
}

// ---------------------------------------------------------------- wear map
//
// One map per screen, keyed by output name. It covers the output's full
// geometry, so panels, margins or a moved panel never shift or reset it; a
// change of resolution, scale or cell size resamples the existing history.
// Each cell (wearCell logical px square) holds how many seconds a window
// border or title bar has been shown on it, decaying very slowly
// (wearHalfLifeDays). Only what is actually visible counts: a border hidden
// under another window, or off this screen, does not wear it.
//
// For placement, wear is normalized by the map's mean (1 = average wear,
// 0 = never used) and summed over the cells a window's border and title bar
// would cover. Row/column prefix sums and a summed-area table make that
// O(1) per candidate position.
//
// Time is measured on a steady clock (the helper's Tick), so keyboard-only
// work counts too; while the screen is locked nothing is counted. Without
// the helper, samples are taken on cursor movement and window events, and a
// single stretch never counts for more than idleCapSec.

const wearMaps = new Map();      // output name -> map
let storedWear = {};             // wear entries loaded from the store, not yet merged
let wearSnapshot = [];           // what was on screen at the last sample
let lastWearSample = Date.now();
let lastTickReply = 0;
const WEAR_CAP = 8;              // normalized wear is capped (one hot spot can't dominate)
const MAX_WEAR_CELLS = 1000000;  // sanity limit when decoding stored maps
function wearHalfLifeMs() { return CFG.wearHalfLifeDays * 86400000; }
// Cost per cell of average wear. Scales with the cell size so that the
// setting means the same thing whatever the grid resolution.
function wearLambda(m) { return CFG.wearWeight * m.cell * 50; }

// The longest stretch one sample may count: a few clock ticks when the
// clock runs (a longer gap means suspend or a stall), else idleCapSec.
function stretchCapMs(now) {
    const tick = CFG.wearSampleSec * 1000;
    return (now - lastTickReply < 4 * tick) ? 4 * tick : CFG.idleCapSec * 1000;
}

// The rectangle a screen's wear map covers.
function outputRect(output, fallback) {
    const g = output && output.geometry;
    const r = goodRect(g) ? g : fallback;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function newWearMap(key, rect, cell) {
    const gw = Math.max(1, Math.ceil(rect.width / cell));
    const gh = Math.max(1, Math.ceil(rect.height / cell));
    const now = Date.now();
    return { key: key, cell: cell, gw: gw, gh: gh, ox: rect.x, oy: rect.y,
             w: Math.round(rect.width), h: Math.round(rect.height),
             data: new Float64Array(gw * gh), ts: now, used: now, stale: true,
             norm: null, rowPS: null, colPS: null, sat: null, mean: 0, peak: 0 };
}

// Add grid `src` (sw x sh cells covering the same screen) into map m,
// scaled by `factor`. When grids differ, each target cell takes the largest
// value of the source cells it covers: wear is line-shaped (title bars,
// borders), and averaging or point-sampling would erase lines.
function resampleInto(m, src, sw, sh, factor) {
    if (sw === m.gw && sh === m.gh) {
        for (let i = 0; i < src.length; i++) m.data[i] += src[i] * factor;
    } else {
        for (let r = 0; r < m.gh; r++) {
            const r0 = Math.min(sh - 1, Math.floor(r * sh / m.gh));
            const r1 = Math.min(sh - 1, Math.max(r0, Math.ceil((r + 1) * sh / m.gh) - 1));
            for (let c = 0; c < m.gw; c++) {
                const c0 = Math.min(sw - 1, Math.floor(c * sw / m.gw));
                const c1 = Math.min(sw - 1, Math.max(c0, Math.ceil((c + 1) * sw / m.gw) - 1));
                let v = 0;
                for (let rr = r0; rr <= r1; rr++)
                    for (let cc = c0; cc <= c1; cc++) if (src[rr * sw + cc] > v) v = src[rr * sw + cc];
                m.data[r * m.gw + c] += v * factor;
            }
        }
    }
    m.stale = true;
}

function rebuildWearMap(m, rect, cell, why) {
    const nm = newWearMap(m.key, rect, cell);
    resampleInto(nm, m.data, m.gw, m.gh, 1);
    nm.ts = m.ts;
    wearMaps.set(m.key, nm);
    wearSnapshot = [];
    dirty = true;
    say("wear map for " + m.key + " resampled to " + nm.gw + "x" + nm.gh + " cells of " + cell + " px (" + why + ")");
    return nm;
}

function wearMapFor(output, rect) {
    const key = String(output && output.name);
    let m = wearMaps.get(key);
    if (m && (m.w !== Math.round(rect.width) || m.h !== Math.round(rect.height))) {
        m = rebuildWearMap(m, rect, CFG.wearCell, "screen size changed");
    } else if (m && m.cell !== CFG.wearCell) {
        m = rebuildWearMap(m, rect, CFG.wearCell, "cell size changed");
    }
    if (!m) {
        m = newWearMap(key, rect, CFG.wearCell);
        wearMaps.set(key, m);
        if (storedWear[key]) {
            mergeWearEntry(m, storedWear[key], Date.now());
            delete storedWear[key];
        }
    }
    m.ox = rect.x;          // screen moved in the layout: same pixels, new origin
    m.oy = rect.y;
    m.used = Date.now();
    return m;
}

// wearCell changed in the settings: rebuild every map at the new resolution.
function regridWearMaps() {
    const old = [];
    wearMaps.forEach(function (m) { old.push(m); });
    old.forEach(function (m) {
        rebuildWearMap(m, { x: m.ox, y: m.oy, width: m.w, height: m.h }, CFG.wearCell, "cell size changed");
    });
}

function cellX(m, x) { return Math.max(0, Math.min(m.gw - 1, Math.floor((x - m.ox) / m.cell))); }
function cellY(m, y) { return Math.max(0, Math.min(m.gh - 1, Math.floor((y - m.oy) / m.cell))); }

// The cells a window at (x, y, w, h) wears: its title-bar band (which
// includes the top border), the bottom border, and both side borders.
// Clamped to the map: used for scoring positions, which are on screen.
function wearSpan(m, x, y, w, h) {
    const c0 = cellX(m, x), c1 = cellX(m, x + w - 1);
    const r0 = cellY(m, y), r1 = cellY(m, y + h - 1);
    const rt = Math.min(r1, cellY(m, y + Math.max(1, CFG.titleBarHeight) - 1));
    return { c0: c0, c1: c1, r0: r0, r1: r1, rt: rt };
}

function decayWear(m, now) {
    if (now - m.ts < 3600000) return;
    const f = Math.pow(0.5, (now - m.ts) / wearHalfLifeMs());
    for (let i = 0; i < m.data.length; i++) m.data[i] *= f;
    m.ts = now;
    m.stale = true;
}

function coveredBy(px, py, above) {
    for (let k = 0; k < above.length; k++) {
        const a = above[k];
        if (px > a.x && px < a.x + a.width && py > a.y && py < a.y + a.height) return true;
    }
    return false;
}

// Credit `amount` seconds to the cells window g visibly wears on map m.
// Not clamped: parts of the window outside this screen are skipped.
function addWear(m, g, above, amount) {
    const cell = m.cell, gw = m.gw, gh = m.gh;
    const c0 = Math.floor((g.x - m.ox) / cell), c1 = Math.floor((g.x + g.width - 1 - m.ox) / cell);
    const r0 = Math.floor((g.y - m.oy) / cell), r1 = Math.floor((g.y + g.height - 1 - m.oy) / cell);
    const rt = Math.min(r1, Math.floor((g.y + Math.max(1, CFG.titleBarHeight) - 1 - m.oy) / cell));
    const add = function (c, r) {
        if (c < 0 || c >= gw || r < 0 || r >= gh) return;
        if (above.length && coveredBy(m.ox + (c + 0.5) * cell, m.oy + (r + 0.5) * cell, above)) return;
        m.data[r * gw + c] += amount;
    };
    const cl = Math.max(0, c0), cr = Math.min(gw - 1, c1);
    for (let r = Math.max(0, r0); r <= Math.min(gh - 1, rt); r++) for (let c = cl; c <= cr; c++) add(c, r);
    if (r1 > rt) for (let c = cl; c <= cr; c++) add(c, r1);
    for (let r = Math.max(0, rt + 1); r <= Math.min(gh - 1, r1 - 1); r++) {
        add(c0, r);
        if (c1 > c0) add(c1, r);
    }
    m.stale = true;
}

function plainRect(g) { return { x: g.x, y: g.y, width: g.width, height: g.height }; }

function intersects(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

// What is on screen now, per output: { m, rects (bottom -> top, plain copies) }.
// Every window that intersects a screen counts there, whichever screen KWin
// considers it to be on.
function captureWear() {
    const desktop = workspace.currentDesktop, activity = workspace.currentActivity;
    const z = stackIndex();
    const shown = allWindows().filter(function (o) {
        return o.normalWindow && !o.deleted && !o.minimized && !o.fullScreen &&
               onDesktop(o, desktop) && onActivity(o, activity);
    }).sort(function (a, b) { return (z.get(wid(a)) || 0) - (z.get(wid(b)) || 0); });
    const snap = [];
    allOutputs().forEach(function (output) {
        let area;
        try { area = usableArea(null, output, desktop, true); } catch (e) { return; }
        const known = goodRect(output && output.geometry);
        const rect = outputRect(output, area);
        const rects = [];
        shown.forEach(function (w) {
            const g = plainRect(w.frameGeometry);
            if (known ? intersects(g, rect) : w.output === output) rects.push(g);
        });
        snap.push({ m: wearMapFor(output, rect), rects: rects });
    });
    return snap;
}

// Credit the time since the last sample to what was on screen then, and
// remember what is on screen now. force=false: at most once a second.
function sampleWear(now, force) {
    if (!CFG.wear) { lastWearSample = now; wearSnapshot = []; return; }
    if (!force && now - lastWearSample < 1000) return;
    const dt = screenLocked ? 0
        : Math.min(Math.max(0, now - lastWearSample), stretchCapMs(now)) / 1000;
    lastWearSample = now;
    if (dt > 0) {
        wearSnapshot.forEach(function (s) {
            decayWear(s.m, now);
            for (let i = 0; i < s.rects.length; i++) {
                const g = s.rects[i];
                const above = [];
                for (let j = i + 1; j < s.rects.length; j++) if (intersects(s.rects[j], g)) above.push(s.rects[j]);
                addWear(s.m, g, above, dt);
            }
        });
        if (wearSnapshot.length) dirty = true;
    }
    wearSnapshot = captureWear();
}

function prepareWear(m) {
    if (!m.stale) return;
    const gw = m.gw, gh = m.gh, n = gw * gh, d = m.data;
    let sum = 0, peak = 0;
    for (let i = 0; i < n; i++) { sum += d[i]; if (d[i] > peak) peak = d[i]; }
    const mean = sum / n;
    m.mean = mean;
    m.peak = peak;
    const norm = m.norm || (m.norm = new Float64Array(n));
    for (let i = 0; i < n; i++) norm[i] = mean > 0 ? Math.min(WEAR_CAP, d[i] / mean) : 0;
    const rowPS = m.rowPS || (m.rowPS = new Float64Array((gw + 1) * gh));
    const colPS = m.colPS || (m.colPS = new Float64Array((gh + 1) * gw));
    const sat = m.sat || (m.sat = new Float64Array((gw + 1) * (gh + 1)));
    for (let r = 0; r < gh; r++) {
        rowPS[r * (gw + 1)] = 0;
        for (let c = 0; c < gw; c++) rowPS[r * (gw + 1) + c + 1] = rowPS[r * (gw + 1) + c] + norm[r * gw + c];
    }
    for (let c = 0; c < gw; c++) {
        colPS[c * (gh + 1)] = 0;
        for (let r = 0; r < gh; r++) colPS[c * (gh + 1) + r + 1] = colPS[c * (gh + 1) + r] + norm[r * gw + c];
    }
    for (let c = 0; c <= gw; c++) sat[c] = 0;
    for (let r = 0; r < gh; r++) {
        sat[(r + 1) * (gw + 1)] = 0;
        for (let c = 0; c < gw; c++) {
            sat[(r + 1) * (gw + 1) + c + 1] = norm[r * gw + c] + sat[r * (gw + 1) + c + 1] +
                sat[(r + 1) * (gw + 1) + c] - sat[r * (gw + 1) + c];
        }
    }
    m.stale = false;
}

// Normalized wear under a window at (x, y, w, h), and how many cells that is.
function wearUnder(m, x, y, w, h) {
    const s = wearSpan(m, x, y, w, h);
    const W = m.gw + 1, H = m.gh + 1;
    let score = m.sat[(s.rt + 1) * W + s.c1 + 1] - m.sat[s.r0 * W + s.c1 + 1] -
                m.sat[(s.rt + 1) * W + s.c0] + m.sat[s.r0 * W + s.c0];
    let cells = (s.rt - s.r0 + 1) * (s.c1 - s.c0 + 1);
    if (s.r1 > s.rt) {
        score += m.rowPS[s.r1 * W + s.c1 + 1] - m.rowPS[s.r1 * W + s.c0];
        cells += s.c1 - s.c0 + 1;
    }
    if (s.r1 - 1 >= s.rt + 1) {
        score += m.colPS[s.c0 * H + s.r1] - m.colPS[s.c0 * H + s.rt + 1];
        cells += s.r1 - 1 - s.rt;
        if (s.c1 > s.c0) {
            score += m.colPS[s.c1 * H + s.r1] - m.colPS[s.c1 * H + s.rt + 1];
            cells += s.r1 - 1 - s.rt;
        }
    }
    return { score: score, cells: cells };
}

function wearCost(it, x, y, wm) {
    if (!wm || CFG.wearWeight <= 0 || wm.mean <= 0) return 0;
    return wearLambda(wm) * wearUnder(wm, x, y, it.width, it.height).score;
}

// Peak / mean of the cells that have any wear (1.0 = perfectly even).
function wearHotspot(m) {
    let sum = 0, n = 0, peak = 0;
    for (let i = 0; i < m.data.length; i++) {
        if (m.data[i] > 0) { sum += m.data[i]; n++; if (m.data[i] > peak) peak = m.data[i]; }
    }
    return n ? peak / (sum / n) : 0;
}

// Compact encoding for the store: 2 chars per cell, log-scaled seconds.
// Stochastic rounding keeps decay correct when the map is saved and loaded
// many times (plain rounding would snap small changes back every time).
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64I = {};
for (let i = 0; i < 64; i++) B64I[B64[i]] = i;

function encodeWear(data) {
    const out = new Array(data.length);
    for (let i = 0; i < data.length; i++) {
        const v = data[i];
        let q = 0;
        if (v > 0) {
            const x = Math.log(1 + v / 60) / Math.LN2 * 180;
            q = Math.floor(x);
            if (Math.random() < x - q) q++;
            q = Math.max(1, Math.min(4095, q));
        }
        out[i] = B64[q >> 6] + B64[q & 63];
    }
    return out.join("");
}

function decodeWear(s, n) {
    if (!(n > 0) || n !== Math.floor(n) || n > MAX_WEAR_CELLS) return null;
    if (typeof s !== "string" || s.length !== n * 2) return null;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const a = B64I[s[2 * i]], b = B64I[s[2 * i + 1]];
        if (a === undefined || b === undefined) return null;
        const q = a * 64 + b;
        out[i] = q ? 60 * (Math.pow(2, q / 180) - 1) : 0;
    }
    return out;
}

function validEntry(e) {
    return e && typeof e === "object" && e.gw === Math.floor(e.gw) && e.gh === Math.floor(e.gh) &&
           e.gw > 0 && e.gh > 0 && e.gw * e.gh <= MAX_WEAR_CELLS && typeof e.d === "string";
}

function mergeWearEntry(m, e, now) {
    if (!validEntry(e)) return false;
    const d = decodeWear(e.d, e.gw * e.gh);
    if (!d) return false;
    const f = Math.pow(0.5, Math.max(0, now - (isFinite(e.t) ? e.t : now)) / wearHalfLifeMs());
    resampleInto(m, d, e.gw, e.gh, f);
    return true;
}

// ------------------------------------------------------------ layout model
//
// An "item" is a window in the layout being computed:
//   { x, y, width, height, z, weight, movable, w, T }
// z is the stacking position (higher = on top); weight is how much it costs
// per pixel to hide this window (baseOverlapCost + its usage score); T is its
// "temperature": how much extra cost we will gladly pay for variety.
//
// Energy of a layout = exposure cost + wear cost.
//   exposure: for every window, the area hidden by windows stacked above
//             it, times its weight (so covering what is already buried, or
//             a little-used window, is cheap);
//   wear:     WEAR_LAMBDA * normalized wear under each moved window's
//             border and title bar.
// Positions are chosen at random with probability ~ exp(-energy / T)
// (a Boltzmann choice), so good spots are likelier but never certain, and
// repeating the same spot is penalized once it has worn.

const EPS = 0.5;            // pixels² treated as "no overlap"
const TOP_Z = 1e9;

function rand(n) { return Math.floor(Math.random() * n); }
function pick(list) { return list[rand(list.length)]; }

function shuffled(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = rand(i + 1);
        const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
}

// Random order where heavier (more used) items tend to come first.
function weightedShuffle(items) {
    return items.map(function (it) {
        return { it: it, k: Math.pow(Math.random(), 1 / Math.max(1e-3, it.weight)) };
    }).sort(function (a, b) { return b.k - a.k; }).map(function (e) { return e.it; });
}

function clamp(v, lo, hi) {
    if (hi < lo) return lo;
    return Math.min(hi, Math.max(lo, v));
}

// Fold a value back into [lo, hi] (keeps random positions uniform; clamping
// would pile them up on the screen edges).
function reflect(v, lo, hi) {
    if (hi <= lo) return lo;
    const span = hi - lo;
    let t = (v - lo) % (2 * span);
    if (t < 0) t += 2 * span;
    return lo + (t <= span ? t : 2 * span - t);
}

function gauss() {
    let u = 0;
    while (u === 0) u = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

function temperature(it) {
    return CFG.variety * 0.05 * it.width * it.height * (CFG.baseOverlapCost + 0.5);
}

// Random choice with probability ~ exp(-(cost - best) / T).
function boltzmannPick(list, key, T) {
    let min = Infinity;
    for (let i = 0; i < list.length; i++) if (list[i][key] < min) min = list[i][key];
    if (!(T > 0)) {
        return pick(list.filter(function (c) { return c[key] <= min + EPS; }));
    }
    let total = 0;
    const ws = list.map(function (c) { const w = Math.exp(-(c[key] - min) / T); total += w; return w; });
    let r = Math.random() * total;
    for (let i = 0; i < list.length; i++) { r -= ws[i]; if (r <= 0) return list[i]; }
    return list[list.length - 1];
}

function overlapAt(x, y, w, h, b) {
    const dx = Math.min(x + w, b.x + b.width) - Math.max(x, b.x);
    if (dx <= 0) return 0;
    const dy = Math.min(y + h, b.y + b.height) - Math.max(y, b.y);
    return dy > 0 ? dx * dy : 0;
}

// Pairwise exposure cost of `it` at (x, y) against `others`: whichever of
// the two is lower in the stack pays for the overlap.
function pairCost(it, x, y, others) {
    let c = 0;
    for (let j = 0; j < others.length; j++) {
        const o = others[j];
        if (o === it) continue;
        const ov = overlapAt(x, y, it.width, it.height, o);
        if (ov > 0) c += ov * (it.z > o.z ? o.weight : it.weight);
    }
    return c;
}

function energyAt(it, x, y, others, wm) {
    return pairCost(it, x, y, others) + wearCost(it, x, y, wm);
}

// Area of the union of rectangles (coordinate compression; n is tiny).
function unionArea(rs) {
    if (rs.length === 1) return rs[0].width * rs[0].height;
    const xs = [], ys = [];
    for (let i = 0; i < rs.length; i++) {
        xs.push(rs[i].x, rs[i].x + rs[i].width);
        ys.push(rs[i].y, rs[i].y + rs[i].height);
    }
    xs.sort(function (a, b) { return a - b; });
    ys.sort(function (a, b) { return a - b; });
    let area = 0;
    for (let i = 0; i + 1 < xs.length; i++) {
        const x0 = xs[i], x1 = xs[i + 1];
        if (x1 <= x0) continue;
        const xm = (x0 + x1) / 2;
        for (let k = 0; k + 1 < ys.length; k++) {
            const y0 = ys[k], y1 = ys[k + 1];
            if (y1 <= y0) continue;
            const ym = (y0 + y1) / 2;
            for (let r = 0; r < rs.length; r++) {
                const q = rs[r];
                if (xm > q.x && xm < q.x + q.width && ym > q.y && ym < q.y + q.height) {
                    area += (x1 - x0) * (y1 - y0);
                    break;
                }
            }
        }
    }
    return area;
}

// Exact hidden area of a layout (weighted by default; weighted=false -> px).
function exactCost(items, weighted) {
    let total = 0;
    for (let i = 0; i < items.length; i++) {
        const a = items[i];
        const clips = [];
        for (let j = 0; j < items.length; j++) {
            if (j === i) continue;
            const b = items[j];
            if (b.z < a.z || (b.z === a.z && j < i)) continue;     // not above a
            const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
            const x1 = Math.min(a.x + a.width, b.x + b.width);
            const y1 = Math.min(a.y + a.height, b.y + b.height);
            if (x1 > x0 && y1 > y0) clips.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
        }
        if (clips.length) total += unionArea(clips) * (weighted === false ? 1 : a.weight);
    }
    return total;
}

function bounds(it, area) {
    return { lx: area.x, hx: Math.max(area.x, area.x + area.width - it.width),
             ly: area.y, hy: Math.max(area.y, area.y + area.height - it.height) };
}

function randomSpot(it, area) {
    const b = bounds(it, area);
    return { x: Math.round(b.lx + Math.random() * (b.hx - b.lx)),
             y: Math.round(b.ly + Math.random() * (b.hy - b.ly)), edge: false };
}

function nearby(it, c, area, n) {
    const b = bounds(it, area);
    const out = [];
    for (let k = 0; k < n; k++) {
        out.push({
            x: Math.round(reflect(c.x + (Math.random() * 2 - 1) * it.width * 0.5, b.lx, b.hx)),
            y: Math.round(reflect(c.y + (Math.random() * 2 - 1) * it.height * 0.5, b.ly, b.hy)),
            edge: false,
        });
    }
    return out;
}

// Positions where an edge of `it` lines up with the screen or another
// window. Only used when they are clearly better than any random spot
// (e.g. the one gap a window fits in exactly).
function edgeCandidates(it, others, area) {
    const b = bounds(it, area);
    const xs = [], ys = [];
    for (let j = 0; j < others.length; j++) {
        const o = others[j];
        if (o === it) continue;
        xs.push(o.x - it.width, o.x, o.x + o.width - it.width, o.x + o.width);
        ys.push(o.y - it.height, o.y, o.y + o.height - it.height, o.y + o.height);
    }
    // In-range values only: neither the screen bounds themselves nor
    // values clamped onto them (that is how windows end up flush with the
    // screen edge). Random positions supply the variety along the other axis.
    const ux = {}, uy = {}, cx = [], cy = [];
    xs.forEach(function (v) { v = Math.round(v); if (v > b.lx && v < b.hx && !ux[v]) { ux[v] = 1; cx.push(v); } });
    ys.forEach(function (v) { v = Math.round(v); if (v > b.ly && v < b.hy && !uy[v]) { uy[v] = 1; cy.push(v); } });
    for (let k = 0; k < 6; k++) {
        cx.push(Math.round(b.lx + Math.random() * (b.hx - b.lx)));
        cy.push(Math.round(b.ly + Math.random() * (b.hy - b.ly)));
    }
    const out = [];
    if (cx.length * cy.length <= 1600) {
        for (let a = 0; a < cx.length; a++)
            for (let k = 0; k < cy.length; k++) out.push({ x: cx[a], y: cy[k], edge: true });
    } else {                                   // many windows: sample pairs instead of building the grid
        for (let k = 0; k < 1600; k++) out.push({ x: pick(cx), y: pick(cy), edge: true });
    }
    return out;
}

/*
 * Extra weighted area hidden by putting `it` (on top of everything) at (x, y):
 * for each window below it, the part of their intersection that was still
 * visible. Only windows that overlap `it` are looked at.
 */
function addedHidden(it, x, y, others) {
    let total = 0;
    for (let i = 0; i < others.length; i++) {
        const o = others[i];
        const x0 = Math.max(x, o.x), y0 = Math.max(y, o.y);
        const x1 = Math.min(x + it.width, o.x + o.width), y1 = Math.min(y + it.height, o.y + o.height);
        if (x1 <= x0 || y1 <= y0) continue;
        const clips = [];
        for (let j = 0; j < others.length; j++) {
            if (j === i) continue;
            const b = others[j];
            if (b.z < o.z || (b.z === o.z && j < i)) continue;          // not above o
            const bx0 = Math.max(x0, b.x), by0 = Math.max(y0, b.y);
            const bx1 = Math.min(x1, b.x + b.width), by1 = Math.min(y1, b.y + b.height);
            if (bx1 > bx0 && by1 > by0) clips.push({ x: bx0, y: by0, width: bx1 - bx0, height: by1 - by0 });
        }
        const covered = clips.length ? unionArea(clips) : 0;
        total += ((x1 - x0) * (y1 - y0) - covered) * o.weight;
    }
    return total;
}

const PLACE_BUDGET_MS = 40;      // per new window

/*
 * Place one new window `it` (on top of the stack) among fixed `others`.
 * Returns { x, y, hidden, wear, edge }.
 */
function placeOne(it, others, area, wm) {
    const T = temperature(it);
    const deadline = Date.now() + PLACE_BUDGET_MS;
    const score = function (c) {
        c.cost = pairCost(it, c.x, c.y, others);
        c.J = c.cost + wearCost(it, c.x, c.y, wm);
        return c;
    };

    const cands = [];
    for (let k = 0; k < CFG.candidates; k++) {
        cands.push(score(randomSpot(it, area)));
        if ((k & 63) === 63 && k >= 100 && Date.now() > deadline) break;
    }
    cands.sort(function (a, b) { return a.J - b.J; });
    // look around the best few random spots for room in their neighbourhood
    cands.slice(0, 8).forEach(function (s) {
        nearby(it, s, area, 25).forEach(function (p) { cands.push(score(p)); });
    });
    let minOverlap = Infinity;
    cands.forEach(function (c) { if (c.cost < minOverlap) minOverlap = c.cost; });

    // Edge-aligned spots can only beat random ones on overlap, so they are
    // skipped (they are the expensive part) when a random spot is already
    // overlap-free. Otherwise the few best that beat every random spot on
    // overlap join the same random choice as the rest: an exact-fit gap is
    // used often when the alternative covers windows you use, rarely when it
    // only covers ones you don't.
    let pool = cands;
    if (minOverlap > EPS && Date.now() < deadline) {
        const all = edgeCandidates(it, others, area), scored = [];
        for (let k = 0; k < all.length; k++) {
            scored.push(score(all[k]));
            if ((k & 127) === 127 && Date.now() > deadline) break;
        }
        const edges = scored
            .filter(function (c) { return c.cost < minOverlap - EPS; })
            .sort(function (a, b) { return a.J - b.J; })
            .slice(0, 5);
        pool = cands.concat(edges);
    }

    // Rank a shortlist with the exact exposure cost (covering what is
    // already buried is free), then make a Boltzmann choice.
    pool.sort(function (a, b) { return a.J - b.J; });
    const shortlist = pool.slice(0, 40);
    const ranked = [];
    for (let i = 0; i < shortlist.length; i++) {
        const c = shortlist[i];
        c.hidden = addedHidden(it, c.x, c.y, others);
        c.E = c.hidden + (c.J - c.cost);
        ranked.push(c);
        if (i >= 8 && Date.now() > deadline) break;
    }
    const c = boltzmannPick(ranked, "E", T);
    return { x: c.x, y: c.y, hidden: c.hidden, wear: c.J - c.cost, edge: !!c.edge };
}

// A random move for `it`: mostly local steps that shrink as the search
// cools, sometimes a jump anywhere, rarely a snap to line up with something.
function propose(it, items, area, frac) {
    const b = bounds(it, area);
    const r = Math.random();
    if (r < 0.15) return randomSpot(it, area);
    if (r < 0.22) {
        // butt up against another window (never snap to the screen edges)
        // (a snap that would leave the screen is dropped, not clamped: clamping
        // would put the window flush with the screen edge)
        const others = items.filter(function (o) { return o !== it; });
        if (others.length) {
            const o = pick(others);
            if (Math.random() < 0.5) {
                const x = Math.round(pick([o.x - it.width, o.x + o.width]));
                if (x > b.lx && x < b.hx) return { x: x, y: it.y, edge: true };
            } else {
                const y = Math.round(pick([o.y - it.height, o.y + o.height]));
                if (y > b.ly && y < b.hy) return { x: it.x, y: y, edge: true };
            }
        }
        return randomSpot(it, area);
    }
    const s = 0.3 * (1 - frac) + 0.01;
    return {
        x: Math.round(reflect(it.x + gauss() * s * area.width, b.lx, b.hx)),
        y: Math.round(reflect(it.y + gauss() * s * area.height, b.ly, b.hy)),
        edge: false,
    };
}

/*
 * Re-place every movable item. Several independent searches ("chains"),
 * each: place windows one by one with a Boltzmann choice among random spots
 * (more-used windows tend to go first), then simulated annealing with random
 * moves. One of the resulting layouts is chosen, again by a Boltzmann choice,
 * and windows finally drift at random inside the free space they have.
 * `deadline` is a hard limit: it is checked inside the search too, and the
 * first chain is cut short rather than overrun it.
 */
function optimizeLayout(items, area, wm, deadline) {
    const mov = items.filter(function (it) { return it.movable; });
    const fixed = items.filter(function (it) { return !it.movable; });
    mov.forEach(function (it) { it.T = Math.max(1, temperature(it)); });
    let Tsum = 0;
    mov.forEach(function (it) { Tsum += it.T; });
    const base = exactCost(fixed);
    const started = Date.now();
    const results = [];
    let chains = 0, cut = false;

    while (chains < CFG.maxRestarts && (chains === 0 || Date.now() < deadline)) {
        // 1. construction
        const placed = fixed.slice();
        weightedShuffle(mov).forEach(function (it) {
            const cands = [];
            for (let k = 0; k < 60; k++) {
                const c = randomSpot(it, area);
                c.J = energyAt(it, c.x, c.y, placed, wm);
                cands.push(c);
            }
            const c = boltzmannPick(cands, "J", it.T);
            it.x = c.x; it.y = c.y;
            placed.push(it);
        });
        // 2. annealing: temperature 2T -> 0.1T
        const steps = 150 * mov.length;
        for (let s = 0; s < steps; s++) {
            // out of time: a later chain is dropped (earlier ones are kept);
            // the first chain is used as far as it got
            if ((s & 255) === 255 && Date.now() > deadline) { cut = true; break; }
            const frac = s / steps;
            const it = mov[rand(mov.length)];
            const p = propose(it, items, area, frac);
            const dJ = energyAt(it, p.x, p.y, items, wm) - energyAt(it, it.x, it.y, items, wm);
            const temp = it.T * (2 * (1 - frac) + 0.1 * frac);
            if (dJ <= 0 || Math.random() < Math.exp(-dJ / temp)) { it.x = p.x; it.y = p.y; }
        }
        if (cut && chains > 0) break;
        let wear = 0;
        mov.forEach(function (it) { wear += wearCost(it, it.x, it.y, wm); });
        const hidden = Math.max(0, exactCost(items) - base);
        results.push({ E: hidden + wear, hidden: hidden, pos: mov.map(function (it) { return [it.x, it.y]; }) });
        chains++;
        if (cut) break;
    }

    const chosen = boltzmannPick(results, "E", Tsum);
    mov.forEach(function (it, i) { it.x = chosen.pos[i][0]; it.y = chosen.pos[i][1]; });
    if (Date.now() < deadline) jitter(mov, items, area, wm);

    return { tried: chains, ms: Date.now() - started, cut: cut };
}

// How far `it` can slide along one axis without touching anything it does
// not already overlap. Returns [lo, hi] for its x (axis "x") or y (axis "y").
function slack(it, items, area, axis) {
    const X = axis === "x";
    const pos = X ? it.x : it.y, len = X ? it.width : it.height;
    let lo = X ? area.x : area.y;
    let hi = Math.max(lo, (X ? area.x + area.width : area.y + area.height) - len);
    for (let j = 0; j < items.length; j++) {
        const o = items[j];
        if (o === it) continue;
        const crossLo = X ? o.y : o.x, crossLen = X ? o.height : o.width;
        const myLo = X ? it.y : it.x, myLen = X ? it.height : it.width;
        if (crossLo >= myLo + myLen || crossLo + crossLen <= myLo) continue;
        const oLo = X ? o.x : o.y, oLen = X ? o.width : o.height;
        if (oLo + oLen <= pos) lo = Math.max(lo, oLo + oLen);
        else if (oLo >= pos + len) hi = Math.min(hi, oLo - len);
    }
    return [Math.min(lo, pos), Math.max(hi, pos)];
}

// Let each window drift to a random spot within its free range (alternating
// axes), never adding overlap, and accepting more wear only with Boltzmann
// probability. Spreads windows out inside free space.
function jitter(mov, items, area, wm) {
    const before = exactCost(items);
    const saved = mov.map(function (it) { return [it.x, it.y]; });
    for (let sweep = 0; sweep < 4; sweep++) {
        shuffled(mov).forEach(function (it) {
            ["x", "y"].forEach(function (axis) {
                const r = slack(it, items, area, axis);
                if (r[1] - r[0] < 1) return;
                const v = Math.round(r[0] + Math.random() * (r[1] - r[0]));
                const nx = axis === "x" ? v : it.x, ny = axis === "y" ? v : it.y;
                if (pairCost(it, nx, ny, items) > pairCost(it, it.x, it.y, items) + EPS) return;
                const dW = wearCost(it, nx, ny, wm) - wearCost(it, it.x, it.y, wm);
                if (dW <= 0 || Math.random() < Math.exp(-dW / (it.T || 1))) { it.x = nx; it.y = ny; }
            });
        });
    }
    if (exactCost(items) > before + EPS) {
        mov.forEach(function (it, i) { it.x = saved[i][0]; it.y = saved[i][1]; });
    }
}

// ------------------------------------------------------------- moving

function applied(w, x, y) {
    const a = w.frameGeometry;
    return Math.abs(a.x - x) < 1 && Math.abs(a.y - y) < 1;
}

// Move a window and verify KWin actually accepted it; if the first way of
// assigning the geometry is ignored, retry with a plain object.
// Some apps (Steam, under XWayland with display scaling) answer being moved
// by resizing themselves. For a short while after the script moves a window,
// a size change the app makes on its own is undone, at most twice, so the
// script never fights an app for long. Resizes you make yourself (dragging a
// window edge) are never touched.
const SIZE_GUARD_MS = 5000;
const SIZE_GUARD_MAX = 2;
const sizeGuards = new Map();       // window id -> guard
const warnedResizers = {};

function guardSize(w, width, height) {
    if (!CFG.keepSizeOnMove || !w.frameGeometryChanged) return;
    const id = wid(w);
    const old = sizeGuards.get(id);
    if (old) { try { w.frameGeometryChanged.disconnect(old.handler); } catch (e) { /* gone */ } }
    const movedAt = Date.now();
    const gd = { width: width, height: height, until: movedAt + SIZE_GUARD_MS, restores: 0, restoring: false };
    gd.handler = guard("sizeGuard", function () {
        const done = function () {
            try { w.frameGeometryChanged.disconnect(gd.handler); } catch (e) { /* gone */ }
            if (sizeGuards.get(id) === gd) sizeGuards.delete(id);
        };
        if (w.deleted || Date.now() > gd.until || gd.restores >= SIZE_GUARD_MAX) { done(); return; }
        if (gd.restoring) return;                         // the change is our own restore
        // a plain copy: the live geometry changes as soon as the size is restored
        const g = plainRect(w.frameGeometry);
        const ms = Date.now() - movedAt;
        const user = w.move || w.resize;
        log("geometry of '" + w.caption + "' changed " + ms + " ms after move: " + fmtRect(g) +
            (user ? " (user move/resize, left alone)" : ""));
        if (user || w.fullScreen || w.minimized) return;
        if (Math.abs(g.width - gd.width) < 1.5 && Math.abs(g.height - gd.height) < 1.5) return;
        gd.restores++;
        gd.restoring = true;
        w.frameGeometry = { x: g.x, y: g.y, width: gd.width, height: gd.height };
        gd.restoring = false;
        const r = plainRect(w.frameGeometry);
        const kept = Math.abs(r.width - gd.width) < 1.5 && Math.abs(r.height - gd.height) < 1.5;
        const msg = "'" + w.caption + "' (" + appKey(w) + ") resized itself " + ms + " ms after being moved: " +
            Math.round(gd.width) + "x" + Math.round(gd.height) + " -> " + Math.round(g.width) + "x" + Math.round(g.height) +
            (kept ? "; size restored" : "; restoring failed, KWin kept " + Math.round(r.width) + "x" + Math.round(r.height)) +
            " (restore " + gd.restores + " of " + SIZE_GUARD_MAX + ")";
        const key = appKey(w);
        if (!warnedResizers[key] || !kept) {      // once per app (always if it failed); details in debug
            warnedResizers[key] = true;
            say(msg);
        } else {
            log(msg);
        }
    });
    sizeGuards.set(id, gd);
    w.frameGeometryChanged.connect(gd.handler);
}

function fmtRect(r) {
    return r ? (+r.x).toFixed(1) + "," + (+r.y).toFixed(1) + " " + (+r.width).toFixed(1) + "x" + (+r.height).toFixed(1) : "-";
}
function describeGeom(w) {
    let s = "frame " + fmtRect(w.frameGeometry);
    try { if (w.clientGeometry) s += ", client " + fmtRect(w.clientGeometry); } catch (e) { /* n/a */ }
    try { if (w.minSize) s += ", min " + (+w.minSize.width).toFixed(0) + "x" + (+w.minSize.height).toFixed(0); } catch (e) { /* n/a */ }
    try { if (w.maxSize) s += ", max " + (+w.maxSize.width).toFixed(0) + "x" + (+w.maxSize.height).toFixed(0); } catch (e) { /* n/a */ }
    return s;
}

function moveTo(w, x, y, quiet) {
    if (!isFinite(x) || !isFinite(y)) {
        say("refusing to move '" + w.caption + "' to " + x + "," + y);
        return false;
    }
    const log = quiet ? function () {} : logOuter;
    if (CFG.debug && !quiet) log("move '" + w.caption + "' (" + appKey(w) + (w.windowId ? ", X11 id " + w.windowId : "") +
                       ") to " + x + "," + y + "; before: " + describeGeom(w));
    const g = w.frameGeometry;     // copy, modify, assign back
    const x0 = g.x, y0 = g.y, w0 = g.width, h0 = g.height;
    // Watch for KWin un-maximizing the window because of this move.
    let unmaximized = false;
    const onMax = function (mode) { if (!Number(mode)) unmaximized = true; };
    let watching = false;
    try { w.maximizedAboutToChange.connect(onMax); watching = true; } catch (e) { /* n/a */ }
    g.x = x;
    g.y = y;
    w.frameGeometry = g;
    let how = "rect copy";
    if (!unmaximized && !applied(w, x, y)) {
        w.frameGeometry = { x: x, y: y, width: w0, height: h0 };
        how = "plain object";
    }
    if (watching) { try { w.maximizedAboutToChange.disconnect(onMax); } catch (e) { /* n/a */ } }
    if (unmaximized) {
        // It was maximized after all: put it back and leave it alone from now on.
        const prev = maxMode.get(wid(w));
        let mode = prev || 3;
        if (!prev) {
            const out = w.output, ds = w.desktops || [];
            let area = null;
            try { area = usableArea(w, out, ds.length ? ds[0] : workspace.currentDesktop, true); } catch (e) { /* n/a */ }
            const m = area ? maximizeArea(out, ds.length ? ds[0] : workspace.currentDesktop, area) : null;
            if (m) {
                const fullH = Math.abs(h0 - m.height) < 2.5, fullW = Math.abs(w0 - m.width) < 2.5;
                mode = fullH && !fullW ? 1 : fullW && !fullH ? 2 : 3;
            }
        }
        try {
            w.setMaximize(!!(mode & 1), !!(mode & 2));
        } catch (e) {
            w.frameGeometry = { x: x0, y: y0, width: w0, height: h0 };
        }
        maxMode.set(wid(w), mode);
        say("'" + w.caption + "' (" + appKey(w) + ") was maximized; the move un-maximized it, so it was " +
            "re-maximized and will be left in place");
        return false;
    }
    const a = w.frameGeometry;
    if (applied(w, x, y)) {
        // the size may already have changed during the move itself
        if (CFG.keepSizeOnMove && (Math.abs(a.width - w0) >= 1.5 || Math.abs(a.height - h0) >= 1.5)) {
            log("  size changed during the move (" + fmtRect(a) + "); restoring " + w0 + "x" + h0);
            w.frameGeometry = { x: x, y: y, width: w0, height: h0 };
            const b = w.frameGeometry;
            if (Math.abs(b.width - w0) >= 1.5 || Math.abs(b.height - h0) >= 1.5) {
                say("'" + w.caption + "' (" + appKey(w) + ") changes size when moved and KWin keeps the new size (" +
                    fmtRect(b) + "); add '" + appKey(w) + "' to excludeClasses if this is unwanted");
            }
        }
        log("moved '" + w.caption + "' to " + x + "," + y + " via " + how + "; after: " + describeGeom(w));
        guardSize(w, w0, h0);
        return true;
    }
    say("KWin ignored move of '" + w.caption + "' (wanted " + x + "," + y +
        ", still at " + a.x + "," + a.y + ")");
    return false;
}

function itemFor(w, z, usage, movable) {
    const g = w.frameGeometry;
    return {
        w: w, x: g.x, y: g.y, width: g.width, height: g.height,
        z: z, weight: CFG.baseOverlapCost + (usage.get(wid(w)) || 0), movable: movable,
    };
}

// Mean normalized wear under the borders of `list` (0 = fresh, 1 = average).
function meanWearUnder(list, wm) {
    if (!wm || wm.mean <= 0) return 0;
    let s = 0, n = 0;
    list.forEach(function (it) { const u = wearUnder(wm, it.x, it.y, it.width, it.height); s += u.score; n += u.cells; });
    return n ? s / n : 0;
}

// ---------------------------------------------------------- new windows

const placeNew = guard("placeNew", function (w) {
    loadConfig();
    const reason = whyNot(w);
    if (reason) { log("skip '" + w.caption + "': " + reason); return; }

    const output = w.output;
    const ds = w.desktops || [];
    const desktop = ds.length ? ds[0] : workspace.currentDesktop;
    const area = usableArea(w, output, desktop);
    if (fillsArea(w, area)) { log("skip '" + w.caption + "': fills area"); return; }
    trackMaximize(w);
    const mr = maximizedReason(w, output, desktop, area);
    if (mr) { log("skip '" + w.caption + "': " + mr); return; }

    const now = Date.now();
    sampleWear(now, true);
    const wm = CFG.wear ? wearMapFor(output, outputRect(output, usableArea(w, output, desktop, true))) : null;
    if (wm) prepareWear(wm);

    // the window's own activity (a window can open on an activity other than the current one)
    const acts = w.activities || [];
    const activity = acts.length ? acts[0] : workspace.currentActivity;
    const others = visibleOn(output, desktop, activity, w)
        .filter(function (o) { return !fillsArea(o, area); });
    const usage = usageScores(others);
    const z = stackIndex();
    const items = others.map(function (o) { return itemFor(o, z.get(wid(o)) || 0, usage, false); });

    const g = w.frameGeometry;
    const it = { w: w, x: g.x, y: g.y, width: g.width, height: g.height,
                 z: TOP_Z, weight: CFG.baseOverlapCost, movable: true };
    const spot = placeOne(it, items, area, wm);
    log("place '" + w.caption + "' at " + spot.x + "," + spot.y +
        " (hides " + Math.round(spot.hidden) + " weighted px, wear cost " + Math.round(spot.wear) +
        (spot.edge ? ", edge-aligned" : "") + ")");
    moveTo(w, spot.x, spot.y);
    sampleWear(Date.now(), true);
});

// Some windows report a 0x0 size at windowAdded; wait until they have one.
function whenSized(w, fn) {
    function ready() {
        const g = w.frameGeometry;
        return g.width > 1 && g.height > 1;
    }
    if (ready()) { fn(); return; }
    const handler = function () {
        if (!ready()) return;
        w.frameGeometryChanged.disconnect(handler);
        fn();
    };
    w.frameGeometryChanged.connect(handler);
}

// ------------------------------------------------------------- reshuffle

const reshuffle = guard("reshuffle", function (why) {
    loadConfig();
    lastReshuffleAt = Date.now();
    say("reshuffle triggered (" + (why || "shortcut") + ")");
    sampleWear(Date.now(), true);         // book the time the old layout was shown
    const desktop = workspace.currentDesktop;
    const outputs = allOutputs();
    const activity = workspace.currentActivity;
    const z = stackIndex();
    // one time budget for the whole reshuffle, shared between the screens
    const started = Date.now();

    for (let s = 0; s < outputs.length; s++) {
        const output = outputs[s];
        const area = usableArea(null, output, desktop);
        const wm = CFG.wear ? wearMapFor(output, outputRect(output, usableArea(null, output, desktop, true))) : null;
        if (wm) prepareWear(wm);
        const remaining = Math.max(0, started + CFG.optimizeMs - Date.now());
        const deadline = Date.now() + remaining / (outputs.length - s);

        const visible = visibleOn(output, desktop, activity, null);
        const usage = usageScores(visible);
        if (CFG.debug) {
            visible.forEach(function (w) {
                log("usage " + (usage.get(wid(w)) || 0).toFixed(2) + "  " +
                    appKey(w) + "  '" + w.caption + "'");
            });
        }

        // Maximized-size windows are left out entirely; windows we may not
        // move still take part as fixed obstacles.
        const items = [];
        visible.forEach(function (w) {
            if (fillsArea(w, area)) { log("reshuffle skips '" + w.caption + "': fills area"); return; }
            // dialogs aren't laid out on their own: they follow their parent below
            if (CFG.keepDialogsWithParent && isChild(w)) return;
            trackMaximize(w);
            const reason = whyNot(w) || maximizedReason(w, output, desktop, area);
            if (reason) log("reshuffle keeps '" + w.caption + "' fixed: " + reason);
            items.push(itemFor(w, z.get(wid(w)) || 0, usage, reason === ""));
        });
        const movable = items.filter(function (it) { return it.movable; });
        if (movable.length === 0) {
            say("nothing to reshuffle on output " + output.name);
            continue;
        }

        const hiddenBefore = exactCost(items, false);
        const wearBefore = meanWearUnder(movable, wm);
        const r = optimizeLayout(items, area, wm, deadline);
        const moved = new Map();
        movable.forEach(function (it) {
            const g = it.w.frameGeometry;
            const dx = it.x - g.x, dy = it.y - g.y;
            if (moveTo(it.w, it.x, it.y) && (dx || dy)) moved.set(wid(it.w), { dx: dx, dy: dy });
        });
        const nd = moveDialogsWith(moved, area);
        if (nd) log("moved " + nd + " dialog(s) along with their parent");

        say("reshuffled " + movable.length + " of " + visible.length +
            " window(s) on output " + output.name +
            " (desktop '" + (desktop && desktop.name) + "')" +
            ": hidden " + Math.round(hiddenBefore) + " -> " + Math.round(exactCost(items, false)) + " px" +
            (wm ? ", border wear " + wearBefore.toFixed(2) + " -> " + meanWearUnder(movable, wm).toFixed(2) +
                  " (1 = average, map hotspot " + wearHotspot(wm).toFixed(1) + "x)" : "") +
            "; " + r.tried + " layouts in " + r.ms + " ms");
    }
    sampleWear(Date.now(), true);         // start timing the new layout
    maybeSave(Date.now(), true);
});

// -------------------------------------------------------------- persistence
//
// Saved format:
//   { v: 1, saved: <epoch ms>,
//     apps: { <key>: { ms, last } },
//     wear: { <output name>: { cell, gw, gh, w, h, t, u, d } } }
// Safety rules:
//  - nothing is saved until the stored data has been loaded and merged, so a
//    slow or missing helper can never overwrite saved history;
//  - if the stored data cannot be understood (the helper reports an error,
//    or it is not version 1), nothing is saved for the rest of the session.

let storeLoaded = false;
let storeBlocked = false;
let loadTries = 0;
let lastLoadTry = 0;
let lastSave = Date.now();
let warnedNoStore = false;
const LOAD_RETRY_MS = 60000;
const LOAD_MAX_TRIES = 5;
const MAX_WEAR_MAPS = 6;

function hasWear(m) {
    for (let i = 0; i < m.data.length; i++) if (m.data[i] > 0) return true;
    return false;
}

function snapshot(now) {
    const list = [];
    apps.forEach(function (a, k) { list.push({ k: k, ms: decayed(a, now), last: a.last }); });
    list.sort(function (a, b) { return b.ms - a.ms; });
    const out = {};
    list.filter(function (e) { return e.ms >= 60000; })   // drop < 1 min of use
        .slice(0, CFG.maxApps)
        .forEach(function (e) { out[e.k] = { ms: Math.round(e.ms), last: e.last }; });

    // Wear maps: this session's and those of screens not seen this session
    // (e.g. a monitor unplugged); empty ones are skipped and, beyond the
    // limit, the least recently used are dropped.
    const maps = [];
    wearMaps.forEach(function (m) {
        if (!hasWear(m)) return;
        decayWear(m, now);
        maps.push({ key: m.key, u: m.used, e: function () {
            return { cell: m.cell, gw: m.gw, gh: m.gh, w: m.w, h: m.h, t: m.ts, u: m.used, d: encodeWear(m.data) };
        } });
    });
    Object.keys(storedWear).forEach(function (k) {
        const e = storedWear[k];
        if (!wearMaps.has(k)) maps.push({ key: k, u: isFinite(e.u) ? e.u : (isFinite(e.t) ? e.t : 0), e: function () { return e; } });
    });
    maps.sort(function (a, b) { return b.u - a.u; });
    const wear = {};
    maps.slice(0, MAX_WEAR_MAPS).forEach(function (x) { wear[x.key] = x.e(); });
    return { v: 1, saved: now, apps: out, wear: wear };
}

// Merge saved data. Returns { ok, apps, wear }; ok=false means the text was
// not something we understand and must not be overwritten.
function mergeStore(text, now) {
    const t = String(text || "").trim();
    if (t === "" || t === "{}") return { ok: true, apps: 0, wear: 0 };
    let d;
    try { d = JSON.parse(t); } catch (e) { return { ok: false, why: "not valid JSON (" + e + ")" }; }
    if (!d || typeof d !== "object" || d.v !== 1 || !d.apps || typeof d.apps !== "object") {
        return { ok: false, why: "unknown format (v=" + (d && d.v) + ")" };
    }
    const savedAt = isFinite(d.saved) ? Math.min(Number(d.saved), now) : now;
    let n = 0;
    Object.keys(d.apps).forEach(function (k) {
        const e = d.apps[k];
        if (!e || !isFinite(e.ms) || e.ms < 0) return;
        const stored = { ms: Number(e.ms), ts: savedAt, last: isFinite(e.last) ? Number(e.last) : 0 };
        const v = decayed(stored, now);
        const a = apps.get(k);
        if (a) {
            a.ms = decayed(a, now) + v;
            a.ts = now;
            a.last = Math.max(a.last, stored.last);
        } else {
            apps.set(k, { ms: v, ts: now, last: stored.last });
        }
        n++;
    });
    let nw = 0;
    if (d.wear && typeof d.wear === "object") {
        Object.keys(d.wear).forEach(function (k) {
            const e = d.wear[k];
            if (!validEntry(e)) return;
            const m = wearMaps.get(k);
            if (m) { if (mergeWearEntry(m, e, now)) nw++; }
            else { storedWear[k] = e; nw++; }
        });
    }
    return { ok: true, apps: n, wear: nw };
}

function tryLoad(now) {
    if (!CFG.persist || storeLoaded || storeBlocked) return;
    if (loadTries >= LOAD_MAX_TRIES) {
        if (!warnedNoStore && now - lastLoadTry >= LOAD_RETRY_MS) {
            warnedNoStore = true;
            say("usage store not reachable or not readable; usage and wear are kept for this session " +
                "only and nothing is saved (see README, Troubleshooting)");
        }
        return;
    }
    if (loadTries > 0 && now - lastLoadTry < LOAD_RETRY_MS) return;
    loadTries++;
    lastLoadTry = now;
    log("usage store: load attempt " + loadTries);
    callDBus(STORE.service, STORE.path, STORE.iface, "Load", guard("storeLoaded", function (reply) {
        if (storeLoaded || storeBlocked) return;
        const text = (typeof reply === "string") ? reply
            : (reply && reply.length !== undefined && typeof reply[0] === "string") ? reply[0] : "";
        const n = mergeStore(text, Date.now());
        if (!n.ok) {
            storeBlocked = true;
            say("usage store: saved data is " + n.why + "; NOT saving this session so it is not " +
                "overwritten. Fix or move ~/.local/state/randomplace/usage.json and reload the script.");
            return;
        }
        storeLoaded = true;
        lastSave = Date.now();
        say("usage store: loaded " + n.apps + " app(s), " + n.wear + " wear map(s)");
    }));
}

function maybeSave(now, force) {
    if (!CFG.persist || !storeLoaded || storeBlocked) return;
    if (!force && now - lastSave < CFG.saveIntervalSec * 1000) return;
    credit(now);
    sampleWear(now, false);
    lastSave = now;
    if (!dirty) return;
    dirty = false;
    const snap = snapshot(now);
    const text = JSON.stringify(snap);
    if (text.length > 3.5 * 1024 * 1024) {
        say("usage store: data too large to save (" + text.length + " bytes); reduce the number of screens or raise wearCell");
        return;
    }
    callDBus(STORE.service, STORE.path, STORE.iface, "Save", text);
    log("usage store: saved " + Object.keys(snap.apps).length + " app(s), " +
        Object.keys(snap.wear).length + " wear map(s), " + text.length + " bytes");
}

// ------------------------------------------------------------------ clock
//
// KWin JS scripts have no timers. The helper's Tick call replies after
// wearSampleSec, which gives a steady clock for sampling wear and focus time
// even when nothing moves on screen. Each tick also asks the screen saver
// whether the screen is locked (nothing is counted while it is).
// Without the helper, cursor movement and window events drive sampling.

let tickPending = false;
let tickIssued = 0;

function canTick() {
    return CFG.persist && !(warnedNoStore && !storeLoaded);
}

function requestTick(now) {
    if (!canTick()) return;
    tickPending = true;
    tickIssued = now;
    callDBus(STORE.service, STORE.path, STORE.iface, "Tick",
             String(Math.round(CFG.wearSampleSec * 1000)), guard("tick", onTick));
}

function onTick() {
    const now = Date.now();
    tickPending = false;
    lastTickReply = now;
    try {
        callDBus("org.freedesktop.ScreenSaver", "/ScreenSaver", "org.freedesktop.ScreenSaver", "GetActive",
            guard("screensaver", function (v) {
                const locked = !!((typeof v === "boolean" || typeof v === "number") ? v : (v && v[0]));
                if (locked === screenLocked) return;
                const t = Date.now();
                sampleWear(t, true);       // book what was shown up to now
                credit(t);
                screenLocked = locked;
                log("screen " + (locked ? "locked: not counting" : "unlocked: counting again"));
                if (!locked) onUnlock(t);
            }));
    } catch (e) { /* no screen saver service: assume unlocked */ }
    sampleWear(now, true);
    credit(now);
    if (!storeLoaded) tryLoad(now);
    else maybeSave(now, false);
    requestIdle();
    autoActions(now);
    requestTick(now);
}

// ------------------------------------------------------- automatic actions
//
// Why: burn-in comes from the same content staying in the same place for
// many hours. The wear map can only spread wear if layouts change, and a
// layout left alone for a whole day concentrates border and title-bar wear
// on a few lines. So the layout is reshuffled every autoReshuffleMin minutes
// (default 45: 8-16 layouts in a working day; more often adds little and
// disturbs more), but only when you are idle, so windows never jump while
// you work; a reshuffle that is due also happens right after unlocking.
// Between reshuffles, windows drift a couple of pixels at a time while you
// are idle, blurring edge lines like the monitor's own pixel shift but over a
// larger range.
//
// Idle time comes from the helper (Wayland ext-idle-notify, which also counts
// a playing video as activity). Without it, nothing automatic happens.

let idleSec = -1;            // latest reading; -1 = unknown
let idleReadAt = 0;
let warnedNoIdle = false;
let lastDriftAt = Date.now();
const driftDir = new Map();  // window id -> direction (radians)

function autoWanted() { return CFG.autoReshuffle || CFG.drift; }

function requestIdle() {
    if (!autoWanted() || !CFG.persist) return;
    const secs = Math.min(CFG.autoReshuffle ? CFG.autoIdleSec : 1e9, CFG.drift ? CFG.driftIdleSec : 1e9);
    callDBus(STORE.service, STORE.path, STORE.iface, "IdleSeconds", String(secs * 1000),
        guard("idle", function (v) {
            const s = Number((v && v.length !== undefined && typeof v !== "string") ? v[0] : v);
            idleSec = isFinite(s) ? s : -1;
            idleReadAt = Date.now();
            if (idleSec < 0 && !warnedNoIdle) {
                warnedNoIdle = true;
                say("idle time is not available (no Wayland idle-notify support?); automatic reshuffle and drift are off");
            }
        }));
}

function idleFor(now) {
    // a reading older than three ticks is stale
    if (idleSec < 0 || now - idleReadAt > 3 * CFG.wearSampleSec * 1000 + 2000) return -1;
    return idleSec;
}

// Something on screen that must not be disturbed: a fullscreen window (game,
// video) or a window being dragged or resized.
function busyScreen() {
    const desktop = workspace.currentDesktop, activity = workspace.currentActivity;
    return allWindows().some(function (w) {
        if (w.deleted || w.minimized || !onDesktop(w, desktop) || !onActivity(w, activity)) return false;
        return w.fullScreen || w.move || w.resize;
    });
}

// Move every movable window a few pixels along its own direction, turning
// gently; bounce off the screen edges; never into new overlap.
const driftStep = guard("drift", function () {
    loadConfig();
    const desktop = workspace.currentDesktop, activity = workspace.currentActivity;
    const z = stackIndex();
    const none = new Map();
    let total = 0;
    sampleWear(Date.now(), true);
    allOutputs().forEach(function (output) {
        const area = usableArea(null, output, desktop);
        const items = [];
        visibleOn(output, desktop, activity, null).forEach(function (w) {
            if (fillsArea(w, area)) return;
            if (CFG.keepDialogsWithParent && isChild(w)) return;
            trackMaximize(w);
            const movable = whyNot(w) === "" && maximizedReason(w, output, desktop, area) === "";
            items.push(itemFor(w, z.get(wid(w)) || 0, none, movable));
        });
        const moved = new Map();
        items.forEach(function (it) {
            if (!it.movable) return;
            const id = wid(it.w);
            let a = driftDir.has(id) ? driftDir.get(id) : Math.random() * 2 * Math.PI;
            const b = bounds(it, area);
            let nx = Math.round(it.x + Math.cos(a) * CFG.driftPx);
            let ny = Math.round(it.y + Math.sin(a) * CFG.driftPx);
            if (nx < b.lx || nx > b.hx) { a = Math.PI - a; nx = Math.round(clamp(it.x + Math.cos(a) * CFG.driftPx, b.lx, b.hx)); }
            if (ny < b.ly || ny > b.hy) { a = -a; ny = Math.round(clamp(it.y + Math.sin(a) * CFG.driftPx, b.ly, b.hy)); }
            if ((nx === it.x && ny === it.y) ||
                pairCost(it, nx, ny, items) > pairCost(it, it.x, it.y, items) + EPS) {
                driftDir.set(id, Math.random() * 2 * Math.PI);        // blocked: try another way next time
                return;
            }
            driftDir.set(id, a + (Math.random() - 0.5) * 0.5);        // turn gently
            const dx = nx - it.x, dy = ny - it.y;
            if (moveTo(it.w, nx, ny, true)) {
                it.x = nx; it.y = ny;
                moved.set(id, { dx: dx, dy: dy });
                total++;
            }
        });
        moveDialogsWith(moved, area);
    });
    sampleWear(Date.now(), true);
    if (total) log("drift: moved " + total + " window(s) by " + CFG.driftPx + " px");
});

function autoActions(now) {
    if (!autoWanted() || screenLocked) return;
    const idle = idleFor(now);
    if (idle < 0) return;
    if (CFG.autoReshuffle && idle >= CFG.autoIdleSec &&
        now - lastReshuffleAt >= CFG.autoReshuffleMin * 60000 && !busyScreen()) {
        reshuffle("automatic, idle " + Math.round(idle) + " s");
        lastDriftAt = Date.now();
        return;
    }
    if (CFG.drift && idle >= CFG.driftIdleSec && now - lastDriftAt >= CFG.driftEverySec * 1000 && !busyScreen()) {
        lastDriftAt = now;
        driftStep();
    }
}

function onUnlock(now) {
    if (CFG.autoReshuffle && CFG.reshuffleOnUnlock && now - lastReshuffleAt >= CFG.autoReshuffleMin * 60000 &&
        !busyScreen()) {
        reshuffle("automatic, after unlock");
    }
}

// Runs at most once a second off cursor movement and window events: the
// fallback sampler, and a watchdog that restarts the clock if a tick was lost.
let lastBeat = 0;
function heartbeat() {
    const now = Date.now();
    if (now - lastBeat < 1000) return;
    lastBeat = now;
    try {
        if (CFG.wear && now - lastWearSample >= CFG.wearSampleSec * 1000) sampleWear(now, true);
        if (!storeLoaded) tryLoad(now);
        else maybeSave(now, false);
        if (canTick() && (!tickPending || now - tickIssued > 30000)) requestTick(now);
    } catch (e) {
        say("ERROR in heartbeat: " + e);
    }
}

// ---------------------------------------------------------------- wiring

allWindows().forEach(trackMaximize);
workspace.windowActivated.connect(guard("onActivated", onActivated));
onActivated(workspace.activeWindow);

workspace.windowAdded.connect(guard("windowAdded", function (w) {
    heartbeat();
    loadConfig();
    trackMaximize(w);
    // A dialog that doesn't name its parent: put it over the window it belongs to.
    // (Dialogs that do name one are placed over it by KWin, and left alone.)
    if (CFG.keepDialogsWithParent && isOrphanDialog(w) && !w.fullScreen) {
        whenSized(w, function () { centerOverParent(w); });
        return;
    }
    const reason = whyNot(w);
    if (reason) { log("ignore new '" + w.caption + "': " + reason); return; }
    whenSized(w, function () { placeNew(w); });
}));

workspace.windowRemoved.connect(guard("windowRemoved", function (w) {
    const now = Date.now();
    if (w === current) {
        try { credit(now); } catch (e) { /* window may already be torn down */ }
        current = null;
        currentSince = now;
    }
    winLast.delete(wid(w));
    dialogParent.delete(wid(w));
    maxMode.delete(wid(w));
    delete maxTracked[wid(w)];
    try { sampleWear(now, true); } catch (e) { say("ERROR in wear sample: " + e); }
    maybeSave(now, false);
}));

["currentDesktopChanged", "currentActivityChanged"].forEach(function (sig) {
    try {
        workspace[sig].connect(guard(sig, function () { sampleWear(Date.now(), true); }));
    } catch (e) {
        log(sig + " unavailable: " + e);
    }
});

// KWin re-reads kwinrc on reconfigure (e.g. after saving the settings page).
try {
    options.configChanged.connect(guard("configChanged", function () {
        loadConfig();
        log("settings reloaded");
    }));
} catch (e) {
    log("options.configChanged unavailable: " + e);
}

try {
    workspace.cursorPosChanged.connect(heartbeat);
} catch (e) {
    say("cursorPosChanged unavailable (" + e + "); saving only on window events");
}

registerShortcut(
    "RandomPlace Reshuffle",
    "RandomPlace: Reshuffle windows",
    "Meta+Ctrl+Shift+R",
    function () { reshuffle("shortcut"); }
);

sampleWear(Date.now(), true);
if (CFG.persist) tryLoad(Date.now());
requestTick(Date.now());

say("loaded (windows=" + allWindows().length +
    ", outputs=" + allOutputs().length +
    ", persist=" + CFG.persist + ", wear=" + CFG.wear + ")");
