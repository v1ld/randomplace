# RandomPlace – burn-in-aware window placement for KDE Plasma 6

RandomPlace is a KWin script for OLED screens. Window borders and title bars are the most static, high-contrast things on a desktop. When they keep landing on the same pixels, those pixels age faster than the rest of the panel. RandomPlace spreads that wear out.

- **Random placement.** New windows and reshuffles pick random positions, so window edges don't keep landing on the same lines.
- **Wear map.** For each screen, and across logins, RandomPlace records how long window borders and title bars have been visible on each part of the screen. New positions are steered towards areas that have been used less.
- **Usage-aware.** When windows must overlap, the ones you use least get covered. Usage is remembered per app across logins.
- **Reshuffle on demand.** `Meta+Ctrl+Shift+R` re-places every movable window on the current desktop.
- **Automatic, while you're away from the keyboard.** Every 45 minutes the layout is reshuffled, but only once you've been idle for 2 minutes, or right after you unlock. Between reshuffles, windows drift a couple of pixels at a time while you're idle. Nothing moves while you work, while a video plays, while a window is fullscreen, or while the screen is locked.
- **Separate layouts.** Each virtual desktop, Activity and screen is handled on its own.
- **Dialogs stay over their parent.** On a reshuffle, dialogs move together with the window they belong to. Dialogs that don't declare a parent, such as the file Open/Save dialogs drawn by the desktop portal, are centered over the window that opened them.
- **Settings page** in System Settings → Window Management → KWin Scripts → RandomPlace (configure button).

Requires Plasma 6. Written against the Plasma 6.8 scripting API. The settings page uses the same mechanism as KWin's own bundled scripts: a KConfigXT schema plus a Designer form, loaded by `kcm_kwin4_genericscripted`.

## Install

```bash
chmod +x install.sh uninstall.sh
./install.sh
```

The installer:

1. installs the package with `kpackagetool6` into `~/.local/share/kwin/scripts/randomplace/`,
2. enables it in `kwinrc` (`[Plugins] randomplaceEnabled=true`),
3. registers the helper as a D-Bus service and checks that it answers,
4. loads the script into the running KWin and prints its status. Expect `Loaded in KWin: b true` and `Usage persistence: on`.

**Requirement for the helper:** Python 3 with the GObject bindings (`python-gobject` on Arch/CachyOS, `python3-gobject` on Fedora/openSUSE, `python3-gi` on Debian/Ubuntu). Without them the script still works, but usage and wear are kept only for the current session, and wear is sampled only when the mouse moves or windows change.

Re-running `./install.sh` upgrades in place. Saved usage and wear are kept. Anything not yet saved, at most `saveIntervalSec`, is lost when the script reloads.

`./install.sh --reset-wear` does the same and also clears the wear map, keeping the per-app usage. The previous file is kept as `~/.local/state/randomplace/backups/usage-before-reset-<time>.json`.

## Settings

Open **System Settings → Window Management → KWin Scripts** and click the configure button next to RandomPlace. The settings are grouped into four tabs: Placement, Burn-in, Usage and Advanced. Each has a tooltip. They are stored in `~/.config/kwinrc` under `[Script-randomplace]`, and you can also set them with `kwriteconfig6`:

```bash
kwriteconfig6 --file kwinrc --group Script-randomplace --key variety 1.5
```

Changes apply at the next window placement or reshuffle, with no reload needed.

| Key | Default | Meaning |
|---|---|---|
| **Placement** | | |
| `variety` | 1.0 | Randomness versus exposure. At 0 the best spot found is always chosen. At 1, a spot that hides about 5% more of an average window is still reasonably likely. Higher values give more variety and more overlap. |
| `baseOverlapCost` | 0.15 | Cost of covering a window that is never used, relative to about 1.15 for a heavily used one. |
| `margin` | 0 | Pixels kept clear of the usable-area edges. It is ignored, with a log message, if it would leave less than 200 px. |
| `candidates` | 600 | Random positions tried when a window opens. |
| `optimizeMs` | 150 | Time budget for a whole reshuffle, shared between screens. |
| `maxRestarts` | 300 | Upper limit on layouts tried per reshuffle. |
| `keepDialogsWithParent` | true | Dialogs move together with their parent on reshuffle, and dialogs without a declared parent are centered over the window they belong to. |
| **Burn-in** | | |
| `wear` | true | Track wear and steer placement away from worn areas. |
| `wearWeight` | 1.0 | Strength of wear avoidance compared with overlap avoidance (calibrated below). At 0, wear is still tracked but ignored. |
| `wearCell` | 20 | Wear-map resolution in logical px. On a 5120×2160 panel at 120% scaling, one cell is 24 physical px. Changing it resamples the existing history. |
| `wearHalfLifeDays` | 180 | How slowly old wear fades. |
| `wearSampleSec` | 5 | How often the on-screen layout is sampled, from 1 to 20 s. |
| `titleBarHeight` | 32 | Height of the title-bar band counted as wear. |
| **Usage** | | |
| `recencyWeight` | 0.6 | 0 = only long-term per-app use counts; 1 = only how recently each window was focused. |
| `recencyHalfLifeSec` | 600 | How quickly a window's "recently focused" bonus fades. |
| `usageHalfLifeDays` | 14 | How quickly remembered app usage fades. |
| `idleCapSec` | 600 | Without the helper's clock, the longest single stretch counted at once. |
| `persist` | true | Use the helper to remember usage and wear across logins, and as a clock. When off, no D-Bus calls are made. |
| `saveIntervalSec` | 120 | Minimum time between saves. |
| `maxApps` | 200 | Apps remembered. |
| **Automatic** | | |
| `autoReshuffle` | true | Reshuffle the current desktop on a schedule, but only while you're idle. |
| `autoReshuffleMin` | 45 | Minutes between automatic reshuffles. |
| `autoIdleSec` | 120 | Seconds without keyboard or mouse input before a due reshuffle may happen. |
| `reshuffleOnUnlock` | true | If a reshuffle is due, do it as soon as you unlock. |
| `drift` | true | Between reshuffles, move windows a few pixels at a time while you're idle. |
| `driftEverySec` | 60 | Seconds between drift steps. |
| `driftPx` | 2 | Pixels per drift step. |
| `driftIdleSec` | 20 | Seconds without input before windows may drift. |
| **Advanced** | | |
| `keepSizeOnMove` | true | Some apps, such as Steam under XWayland with display scaling, resize themselves when moved. For 5 seconds after the script moves a window, a size change the app makes on its own (including one during the move itself) is undone, at most twice. Resizing a window yourself is never affected, and neither are maximizing, quick tiling or going fullscreen. |
| `excludeClasses` | krunner,plasmashell,… | Comma-separated window classes that are never moved. |
| `debug` | false | Log every decision. |

The reshuffle shortcut is under **System Settings → Keyboard → Shortcuts → KWin → "RandomPlace: Reshuffle windows"**.

## How it works

### Cost of a layout

A layout's cost has two parts.

- **Exposure.** For each window, the area hidden by windows stacked above it, multiplied by that window's usage weight. Only the window underneath pays for an overlap. Covering something that is already buried costs nothing, and covering a window you rarely use is cheap.
- **Wear.** For each moved window, the wear already recorded under the cells its border and title bar would cover. Wear is normalized so that 0 means never used and 1 means average for that screen.

### Choosing positions

Positions are chosen at random, with probability proportional to `exp(−cost / T)` (a Boltzmann choice). Good spots are likelier but never certain. The temperature `T` is set by `variety`.

- **New window:** 600 random positions are tried, plus extra samples around the most promising ones. If none of them is free of overlap, the few best positions aligned with another window's edges (such as an exact-fit gap) join the same random choice. An exact fit is then used often when the alternative would cover windows you use, and rarely when it would only cover ones you don't. Placement is capped at about 40 ms.
- **Reshuffle:** several independent searches run within the time budget. Each one places windows one by one (more-used windows tend to go first), then refines the layout with random moves while gradually lowering the temperature (simulated annealing). One of the resulting layouts is chosen, again by a Boltzmann choice. Finally, each window drifts to a random spot within the free space around it. The budget is checked during the search, not just between searches.
- **Never snapped to screen edges.** Positions that would leave the screen are discarded rather than clamped. Clamping is what piles windows up against the screen edges.

### Automatic reshuffle and drift

**Why they exist.** Burn-in comes from the same content staying in the same place for many hours. The wear map can only spread wear if layouts actually change. With manual reshuffles only, a layout you leave alone for a whole working day concentrates its border and title-bar wear on a few lines. Two mechanisms keep the layout changing without getting in your way:

- **Automatic reshuffle, every 45 minutes by default.** That gives 8–16 different layouts in an 8-hour day, which is enough for the wear map to work with. The simulation in the burn-in analysis changed layouts every 5 minutes, but reshuffling more often than every half hour or so adds little and is more disruptive. This interval is a reasoned judgment, not a measured optimum. A reshuffle only happens once you've been idle for `autoIdleSec` (2 minutes), so windows never jump while you're working. A reshuffle that is due also happens the moment you unlock, before you start working again.
- **Drift.** Between reshuffles, while you're idle, each window moves `driftPx` (2) pixels every `driftEverySec` (60 s) along its own slowly turning path. It bounces off the screen edges and never moves into new overlap, and its dialogs move with it. Over an idle half hour a window wanders about 50–60 px. This blurs the window's edge lines the way the monitor's own pixel shift does (one pixel every three minutes on Alienware OLEDs), but over a larger range.

**When nothing moves:** while you type or use the mouse, while a video plays, while any window on the current desktop is fullscreen, while a window is being dragged or resized, and while the screen is locked.

**How idle time is measured.** On Wayland, KWin scripts can't see keyboard input, and KDE's screen-saver D-Bus call for idle time is not supported there. So the helper asks KWin directly, using the standard Wayland *ext-idle-notify-v1* protocol. It does this with a small built-in client, so no extra packages are needed. That protocol respects idle inhibitors, so a playing video counts as activity. Without the helper, or if the compositor doesn't offer the protocol, automatic reshuffle and drift stay off, and the log says so once.

### Dialogs

- **Dialogs that name their parent:** KWin already places them over the parent, and the script never moves dialogs on its own. On a reshuffle, each dialog (and any dialog of that dialog) moves by the same amount as its parent, so it stays exactly where it was relative to it. If that would push it off-screen, it is kept on screen instead.
- **Dialogs that don't name a parent:** this is common on Wayland for file dialogs, which the desktop portal draws in a separate process, so they arrive as ordinary windows of another app. They are recognized by their window type, or as portal windows, and centered over the most recently used window of the same app, or else the active window. From then on they follow that window like any other dialog.
- **Child windows** that declare a parent, such as a settings window, are treated the same way and aren't reshuffled on their own.

### Wear map

- **Grid:** one map per screen, keyed by output name and covering the whole screen. Panels, margins or a moved panel don't shift or reset it. A change of resolution, scale or cell size resamples the existing history, taking the maximum of each source block so worn lines survive.
- **What counts:** the time since the last sample is added to each cell that shows a window's title-bar band or border. Parts hidden under another window, or off this screen, don't count. While a window covers the whole screen, such as a fullscreen game or remote desktop, nothing on that screen counts. Window interiors don't count either, because their content changes. A window spanning two screens wears both.
- **Clock:** sampling runs on the helper's clock every `wearSampleSec`, so keyboard-only work counts too. It also runs on every window, desktop or Activity change. Nothing is counted while the screen is locked, checked via `org.freedesktop.ScreenSaver`, and a gap of more than a few ticks (suspend) counts as only a few seconds.
- **Storage:** about 40 KB per screen, with log-scaled precision better than 1%. Up to 6 screens are kept, dropping the least recently used. The "Placeholder-N" screen that KWin stands in while no monitor is connected, for example while it recovers from a crash, gets no map: its size is made up and nothing on the panel is behind it. Wear fades with a half-life of `wearHalfLifeDays`. Stochastic rounding keeps that fade correct across many short sessions.
- **Cost of scoring:** constant time per candidate position, using prefix sums.

### The helper

KWin scripts can read settings, but they cannot write files and have no timers. A small helper, `contents/helper/randomplace-store.py`, provides both over D-Bus.

- **`Load` / `Save`:** keeps `~/.local/state/randomplace/usage.json`, written atomically with mode 600.
- **`Tick`:** replies after `wearSampleSec`. This is the script's clock.
- **`IdleSeconds`:** how long you've been idle, via the Wayland ext-idle-notify protocol. Used by automatic reshuffle and drift.

D-Bus starts the helper on demand. Because the clock keeps calling it, it stays running while the script is active: a small idle Python process that wakes every few seconds. It exits 10 minutes after the last call, for example when the script is disabled.

**Your data is protected.** The script never saves before it has loaded the existing data.
- **Unreadable file** (permissions, I/O error): the helper reports an error, and the script keeps working for the session without saving anything.
- **Corrupt file:** the helper moves it to `usage.json.bad-<date>` before starting fresh.
- **Format the script doesn't recognise** (for example from a newer version): the script refuses to save for the session and logs why.
- **Backups:** before a save replaces the file, the helper keeps copies in `~/.local/state/randomplace/backups/`:
  - `usage-<date>.json`: the file as it was before the first save of each day. The last 7 days are kept.
  - `usage-shrunk-<time>.json`: the file as it was before a save that drops a screen's wear map or loses more than half of its recorded wear. The last 5 are kept, and the helper's log says when it took one.

  To restore a backup: disable the script in System Settings (or run `./uninstall.sh` without `--purge`), copy the backup over `usage.json`, and enable the script again (or run `./install.sh`).

## Burn-in analysis

These measurements were made on your usable area of 4266×1800 logical px (5120×2160 at 120% scaling). The wear-related numbers are measured independently of the script's own wear map, by recording every layout that was on screen at 8 px resolution.

| Metric | What it measures | Better |
|---|---|---|
| **Wear variation** (cv) | Coefficient of variation of border and title-bar time across the whole screen. It measures how unevenly the panel ages, and is the main burn-in figure. | lower |
| **Peak / mean**, **p99 / mean** | How much more the most-worn cell (or the 99th-percentile cell) has been used than the average used cell. | lower |
| **Flush with screen edge** | Share of window placements touching a screen edge. | lower |
| **Busiest edge line** | Share of all window edges that fall on the single most-used pixel line. | lower |
| **Hidden px** | Average window area covered by other windows. | lower |

The versions compared:
- **uniform**: positions drawn completely at random, ignoring overlap. This is the variety baseline.
- **v1.3**: random sampling plus overlap avoidance. This is the previous release.
- **optimizer draft**: an intermediate version tuned purely for exposure, never released.
- **v1.4**: this release.

### 1. Why the exposure-optimizer draft was dropped

Before the wear map, I built a reshuffle that maximized exposure using edge-aligned positions and local search. It exposed far more of each window:

| Windows | Share of screen | Hidden px, v1.3 | Hidden px, optimizer draft | Zero-overlap runs (v1.3 / draft) |
|---|---|---|---|---|
| 5 | 72% | 341k | 0k | 0 / 20 |
| 6 | 78% | 334k | 0k | 0 / 20 |
| 7 | 98% | 1,516k | 309k | 0 / 0 |
| 8 | 111% | 2,009k | 972k | 0 / 0 |

It solved a tight 4×2 tiling with 66×40 px to spare in 10 of 10 runs, and put a new window into an exact-fit hole in 20 of 20 (v1.3: 0 of 20).

But measuring repetition showed it was the wrong direction for burn-in. Over 150 consecutive reshuffles:

| Run | Flush with screen edge | Edge lines on screen border | Busiest edge line | Aligned with another window | Border hotspot (peak/mean) | Title-bar hotspot | Screen ever crossed by a border | Hidden px |
|---|---|---|---|---|---|---|---|---|
| 3 win, uniform random | 0.2% | 0.1% | 0.4% | 0.9% | 4.9× | 3.2× | 81.1% | 0k |
| 3 win, v1.3 | 3.8% | 0.9% | 0.6% | 1.6% | 6.3× | 5.9× | 85.5% | 54k |
| 3 win, optimizer draft | 19.1% | 4.8% | 2.7% | 9.6% | 11.9× | 8.2× | 80.2% | 0k |
| 5 win, uniform random | 0.4% | 0.1% | 0.3% | 0.5% | 4.4× | 2.9× | 90.7% | 0k |
| 5 win, v1.3 | 3.9% | 1.0% | 0.6% | 1.0% | 7.4× | 7.1× | 91.0% | 373k |
| 5 win, optimizer draft | 24.8% | 6.3% | 3.1% | 7.1% | 14.1× | 9.3× | 83.7% | 0k |
| 6 win, uniform random | 0.7% | 0.2% | 0.3% | 0.5% | 4.9× | 3.1× | 93.1% | 0k |
| 6 win, v1.3 | 6.3% | 1.6% | 0.7% | 1.3% | 7.5× | 8.5× | 94.0% | 413k |
| 6 win, optimizer draft | 26.6% | 6.7% | 3.3% | 7.3% | 13.8× | 8.7× | 84.1% | 0k |
| 8 win, uniform random | 0.3% | 0.1% | 0.2% | 0.6% | 4.0× | 3.1× | 95.3% | 0k |
| 8 win, v1.3 | 5.1% | 1.3% | 0.5% | 1.2% | 6.2× | 9.0× | 97.4% | 2,106k |
| 8 win, optimizer draft | 92.1% | 33.9% | 17.0% | 35.8% | 26.3× | 10.3× | 48.5% | 961k |

Opening one 1000×700 window 150 times:

| Run | Flush with screen edge | Edge lines on screen border | Busiest edge line | Border hotspot | Title-bar hotspot | Screen ever crossed | Hidden px |
|---|---|---|---|---|---|---|---|
| 0 already open, v1.3 | 1.3% | 0.3% | 0.8% | 5.9× | 3.7× | 39.3% | 0k |
| 0 already open, optimizer draft | 15.3% | 4.3% | 3.3% | 9.2× | 3.8× | 37.8% | 0k |
| 3 already open, v1.3 | 4.0% | 1.0% | 1.7% | 6.0× | 5.6× | 32.2% | 78k |
| 3 already open, optimizer draft | 83.3% | 29.0% | 15.2% | 19.0× | 6.3× | 19.8% | 15k |
| 5 already open, v1.3 | 4.7% | 1.2% | 1.3% | 6.2× | 5.5× | 30.3% | 504k |
| 5 already open, optimizer draft | 92.0% | 29.3% | 17.0% | 14.7× | 3.3× | 18.7% | 117k |

The tightest packings put windows against screen edges and against each other, so the better the exposure, the more layouts repeat. A clamping bug made it worse: positions that fell off-screen were pushed onto the edge. This is why v1.4 makes randomness the primary goal and uses the wear map instead of chasing maximum exposure.

### 2. Long-run simulation (v1.4)

This simulates days of use. Every 5 simulated minutes, the current layout is credited with 5 minutes of display. Then the user either reshuffles (35%) or closes a window and opens a new one (65%), and focuses a random window. Window sizes are 700–1600 × 450–1100 px. "Steps" is the number of 5-minute steps, so 1000 steps is about 3½ days and 2000 is about a week.

| Run | Windows | Steps | Flush with screen edge | Busiest edge line | Peak / mean | p99 / mean | **Wear variation** | Hidden px |
|---|---|---|---|---|---|---|---|---|
| uniform random | 6 | 1000 | 0.3% | 0.24% | 3.92 | 2.94 | 0.681 | 1,751k |
| v1.3 | 6 | 1000 | 2.8% | 0.35% | 7.06 | 4.82 | 0.820 | 331k |
| optimizer draft | 6 | 1000 | 24.1% | 3.91% | 9.50 | 6.07 | 1.059 | 67k |
| v1.4, wear avoidance off (`wearWeight` 0) | 6 | 1000 | 4.5% | 0.43% | 8.05 | 5.10 | 0.925 | 120k |
| **v1.4 (defaults)** | 6 | 1000 | 3.3% | 0.34% | **3.19** | **2.42** | **0.475** | **300k** |
| v1.4, `wearWeight` 2 | 6 | 1000 | 3.4% | 0.33% | 2.80 | 2.12 | 0.430 | 376k |
| v1.4, `wearWeight` 4 | 6 | 1000 | 2.9% | 0.33% | 2.39 | 1.90 | 0.390 | 488k |
| v1.4, `variety` 0.5 | 6 | 1000 | 3.9% | 0.38% | 3.18 | 2.41 | 0.471 | 248k |
| v1.4, `variety` 2 | 6 | 1000 | 2.7% | 0.33% | 3.49 | 2.50 | 0.500 | 333k |
| v1.3 | 6 | 2000 | 3.0% | 0.36% | 7.75 | 5.60 | 0.863 | 353k |
| **v1.4 (defaults)** | 6 | 2000 | 2.9% | 0.36% | **3.12** | **2.43** | **0.465** | **274k** |
| uniform random | 8 | 1000 | 0.4% | 0.22% | 3.93 | 2.63 | 0.647 | 3,015k |
| v1.3 | 8 | 1000 | 3.2% | 0.38% | 9.11 | 6.47 | 1.004 | 1,077k |
| optimizer draft | 8 | 1000 | 58.2% | 9.34% | 12.17 | 10.41 | 1.579 | 398k |
| **v1.4 (defaults)** | 8 | 1000 | 3.8% | 0.47% | **3.63** | **2.86** | **0.551** | **1,062k** |

What this shows:
- **Evenness:** with default settings, v1.4 spreads border and title-bar wear about 40–45% more evenly than v1.3 (wear variation 0.48 against 0.82 with 6 windows, 0.55 against 1.00 with 8). It is also more even than placing windows completely at random. The most-worn spot drops from 7–9× the mean to about 3–4×.
- **Exposure is not sacrificed:** v1.4 hides slightly less than v1.3 (300k against 331k px with 6 windows, 1,062k against 1,077k with 8).
- **It holds up over time:** v1.3 gets steadily less even the longer it runs (0.82 → 0.86), while v1.4 stays level or improves (0.48 → 0.47). That is wear leveling at work, not just randomness.
- **The wear map does the work:** with `wearWeight` 0, v1.4 hides much less but is no more even than v1.3.
- **Screen-edge contact:** flush and busiest-line figures are close to v1.3's.
- **Tuning:** raising `wearWeight` trades exposure for evenness, about 75–110k px of extra hidden area per step from 1 → 2 → 4. Lowering `variety` reduces overlap with little change in evenness, but windows touch the screen edge slightly more often.

### 3. Reshuffling only

When the user only reshuffles and never opens or closes windows, still with 5 minutes per layout:

| Run | Steps | Hidden px | Wear variation | Peak / mean | Flush |
|---|---|---|---|---|---|
| v1.3, mixed window sizes | 150 | 871k | 1.078 | 9.36 | 3.1% |
| v1.4, mixed window sizes | 150 | 797k | 0.649 | 3.93 | 3.7% |
| v1.3, mixed window sizes | 600 | 833k | 1.034 | 9.31 | 3.6% |
| v1.4, mixed window sizes | 600 | 697k | 0.627 | 4.09 | 3.8% |
| v1.3, six large windows (78% of screen) | 300 | 611k | 0.987 | 9.24 | 3.6% |
| v1.4, `wearWeight` 0 | 300 | 74k | 1.429 | 11.78 | 8.6% |
| v1.4, `wearWeight` 0.5 | 300 | 300k | 0.737 | 4.83 | 5.2% |
| v1.4 (defaults) | 300 | 454k | 0.599 | 3.80 | 4.7% |

### 4. One caveat: windows that have never been focused

The usage weights scale how much overlap costs. In a benchmark where windows are reshuffled back to back and *never focused*, every window counts as unused (weight 0.15). Covering is then cheap, and wear avoidance wins by more than intended:

| 6 large windows, 150 reshuffles | Hidden px, nothing ever focused | Hidden px, windows focused normally |
|---|---|---|
| v1.3 | 396k | 629k |
| v1.4 | 1,013k | **302k** |

In normal use the windows you work in are focused, and their usage scores make them expensive to cover. If you often keep many windows open that you never click on, lower `wearWeight` or raise `baseOverlapCost`.

### What this does not cover

- **Static content inside windows.** Toolbars, sidebars and the like move with the window, so randomizing positions spreads their wear too. They aren't counted in the wear map, though, because their content varies.
- **Plasma panels, desktop widgets and wallpaper.** These never move and aren't counted (see `OLED-SETUP.md`).
- **Maximized windows** aren't moved, but their visible title bars and borders are recorded as wear, unless the window covers the whole screen. A window that covers the whole screen (fullscreen, a borderless-fullscreen game, or maximized with no panels) adds no wear, because its outline is the screen's edge. Everything below it on that screen counts as hidden.
- **The simulation is a model.** Real usage patterns, window sizes and display times differ. The wear-report tool below shows what is actually happening on your screen.

## Inspecting your wear map

```bash
python3 ~/.local/share/kwin/scripts/randomplace/contents/helper/wear-report.py
```

The tool prints, for each screen, how much border and title-bar time has been recorded, how evenly it is spread, and a heat map in the terminal. Never-worn cells stay blank. No extra packages are needed.

- **Colour:** on a terminal that supports it (`COLORTERM=truecolor`, as Ghostty sets, or a 256-colour `TERM`), the map is drawn in colours from dark purple (light wear) to pale yellow (most wear), two map rows per text line. Elsewhere, when piped, and in the weekly files it uses characters, darker meaning more wear. `--color` and `--no-color` override this, and `NO_COLOR` is respected.
- **Scale:** `--linear` (default) is proportional to wear, so a colour twice as far along the ramp means twice the wear. In colour, any wear at all still shows, at least as dark purple. With characters it hides anything under 10% of the peak. `--sqrt` shows faint wear down to 1% of the peak while keeping hotspots clearly darker. The weekly files use it, because characters have only 10 shades. `--log` shows traces down to 0.1%, but makes trivial wear look significant. The evenness figures above the map are the same whichever you pick.

The helper also saves this report once a week as `~/.local/state/randomplace/reports/wear-<date>.txt` and keeps the last 26, about six months. Comparing them shows whether wear is evening out over time, for example with `diff` or side by side in an editor.

Each reshuffle also logs what it did, for example:

```
reshuffled 6 of 6 window(s) on output DP-1 (desktop 'Desktop 1'): hidden 412000 -> 260000 px,
border wear 1.35 -> 0.62 (1 = average, map hotspot 3.4x); 14 layouts in 150 ms
```

## Troubleshooting

```bash
# Is it loaded in the running KWin? (expect: b true)
busctl --user call org.kde.KWin /Scripting org.kde.kwin.Scripting isScriptLoaded s randomplace

# Is the helper reachable? (prints the start of the saved JSON)
busctl --user call local.randomplace.Store /local/randomplace/Store local.randomplace.Store Load | head -c 300; echo

# What the script logs (load, store, reshuffle lines and errors are always printed):
journalctl --user -b -f | grep randomplace
```

- **`usage store: loaded N app(s), M wear map(s)`:** all is well.
- **`usage store not reachable or not readable`:** the helper isn't installed, isn't answering, or reported an error. Check the second command above and the helper's own log with `journalctl --user -b | grep -i randomplace`. Nothing is saved in this state, so your file is safe.
- **`saved data is … NOT saving this session`:** the file is in a format this version doesn't understand. Move it aside, or restore a backup, and run `./install.sh` again.
- **`usage.json.bad-<date>` files:** the helper found a corrupt store and kept it rather than overwriting it.
- **History seems to be gone after a crash:** wear maps are kept per screen name, so run `wear-report.py`: its `screens:` line lists every map. Older versions recorded a map for KWin's temporary "Placeholder-1" screen during crash recovery, and the report showed it first. 2.0.3 ignores and drops it. If a map really is gone, restore it from `backups/` (see *Your data is protected*).
- **More detail:** with `debug` on, the log also shows every window's usage score, each placement's hidden area and wear cost, and screen lock and unlock.

## Uninstall

```bash
./uninstall.sh           # keeps ~/.local/state/randomplace/usage.json
./uninstall.sh --purge   # also deletes saved usage and wear
```

## Notes and limits

- **Left alone:** windows that are fullscreen, maximized (fully, vertically or horizontally), snapped to a half or a quarter of the screen, tiled or minimized are never moved. Moving such a window would make KWin restore its earlier size. Maximize state is followed through KWin's maximize signal and also recognized from the geometry, so a window you size by hand to exactly the full height or width of the screen is treated as maximized too. If a move un-maximizes a window anyway, it is re-maximized at once and left alone after that. Non-maximized windows that are left alone still count as obstacles. Dialogs and child windows are only ever moved to stay with their parent.
- **Dialogs and wear:** dialogs are not counted in the wear map, because they are short-lived and sit over their parent.
- **"On all desktops" windows:** they take part in the reshuffle of whichever desktop you are on, and their new position applies on every desktop.
- **Usage is per app, not per desktop.** An app you use a lot is protected on every desktop.
- **Pauses:** KWin runs scripts on its main thread, so a reshuffle pauses the desktop for up to `optimizeMs` in total, 150 ms by default.
- **Placement speed:** placing a new window takes a few milliseconds with a handful of windows open, and about 50 ms with 45 windows (measured in a fast JavaScript engine). KWin's engine may take a few times longer.
- **Session restore:** windows restored right at login may be placed before saved usage and wear have loaded, so those first placements are purely random.
- **Unsaved time:** focus time and wear not yet saved (at most `saveIntervalSec`) are lost if you log out abruptly or reinstall.
- **Apps that resize themselves when moved** have their size restored, at most twice per move. The first time this happens for an app, the log says so, for example `'Steam' (steam) resized itself 2300 ms after being moved: 1356x1475 -> 1100x900; size restored (restore 1 of 2)`. If restoring ever fails, that is always logged. If an app keeps fighting, add its class to `excludeClasses` (Steam's is `steam`).
- **Window rules** that force a position take precedence over this script. Some applications set their own geometry after the window appears; if one keeps snapping back, add its class to `excludeClasses`.

## Appendix: reading the burn-in numbers

All three numbers measure the same thing: how much time window borders and title bars spend on each small patch of screen. In the simulation the screen is divided into 8×8 logical-pixel cells, about 10×10 physical pixels on a 5120×2160 panel at 120% scaling. For each cell, the time a visible window border or title bar sat on it is added up. Burn-in comes from some pixels aging more than their neighbours, so what matters is how *uneven* those totals are, not how big they are.

### Wear variation

Wear variation is the coefficient of variation of those cell totals: the standard deviation divided by the mean, across every cell on the screen.

- **0** would mean every cell got exactly the same border time.
- **0.48** means a typical cell's border time is about ±48% away from the screen-wide average.
- **1.0** means the spread is as large as the average itself, so some areas get far more than their share and others very little.

**How good is 0.48?** It isn't close to 0, and can't be: borders are thin lines and there are only a handful of windows, so perfectly even coverage would need an enormous number of layouts. The useful comparison is against the alternatives in the same 3½-day simulation with 6 windows:

| Placement | Wear variation |
|---|---|
| Exposure-optimizer draft | 1.06 |
| v1.3 | 0.82 |
| Completely random, ignoring overlap | 0.68 |
| **v1.4 (default settings)** | **0.48** |
| v1.4 with `wearWeight` 4 | 0.39 (but about 60% more hidden area) |

- **Better than pure random.** Pure random isn't perfectly even: window edges rarely land in the outermost strips of the screen, and some areas get covered more than others by chance. The wear map deliberately fills the under-used areas, which randomness alone can't do.
- **It holds over time.** In the week-long run, v1.4 stayed level or improved slightly (0.48 → 0.47), while v1.3 got worse (0.82 → 0.86). Pure random was not run for the full week.

### Peak / mean and p99 / mean

**Peak / mean** is the border time of the single most-worn cell divided by the average of all cells that were touched at all.
- v1.4's 3.2 means the worst spot got about 3.2× the average.
- v1.3's 7.1 means its worst spot got about 7×.
- That worst spot is where burn-in would show first.

Because one cell can be a fluke, the tables also give **p99 / mean**, which uses the cell at the 99th percentile instead. It's steadier, and tells the same story (2.4 for v1.4 against 4.8 for v1.3).

### Flush with screen edge

**Flush** is the share of window time in which a window was touching a screen edge, within 1 pixel. It matters because a window flush against an edge always puts its border on exactly the same line.
- The optimizer draft did this 24% of the time with 6 windows, and 58% with 8, which was the main reason it was dropped.
- v1.4 is at about 3%, roughly the same as v1.3.
- Pure random is at 0.3%, since landing exactly on an edge by chance is rare.

A window ends up flush now mostly when there's genuinely no room elsewhere.

### Caveat

These numbers come from a simulated model of use. Once v1.4 has been running for a while, `wear-report.py` prints the same peak/mean and variation figures for your actual screen. They will run higher at first, until enough history accumulates. They also cover a little less than the simulation: the script's wear map ignores window interiors and uses `wearCell` (20 px) cells rather than 8 px.

## Beyond this script

Monitor, brightness, theme and game settings that reduce burn-in risk are covered in a separate guide, `OLED-SETUP.md`.

## Version history

- **2.0.6:** `wear-report.py` uses the linear scale by default again, now that the colour map shows faint wear; the weekly files keep the square-root scale.
- **2.0.5:** `wear-report.py` draws the map in colour on capable terminals, uses a square-root scale by default (`--linear` and `--log` available) and prints a legend in percent of the peak.
- **2.0.4:** weekly wear reports kept for six months; `./install.sh --reset-wear` clears the wear map. Windows hidden under a fullscreen window no longer collect wear. Before, hours of fullscreen gaming or remote desktop recorded the frozen layout underneath as wear, which shows up in the map as sharp lines; that recorded wear fades with `wearHalfLifeDays`. A window covering the whole screen adds no wear of its own.
- **2.0.3:** no wear map for KWin's "Placeholder-N" stand-in screen, which appears while KWin recovers from a crash (an existing one is dropped at the next save, and `wear-report.py` ignores it and lists the screens it shows); the helper keeps daily backups of the store, plus one whenever a save would drop or halve a screen's wear map.
- **2.0.2:** maximizing, quick tiling or going fullscreen within 5 seconds of the script moving a window (placement, reshuffle or drift) no longer leaves the window at the top left at its old size; the size guard now stands down for anything the window manager does.
- **2.0.1:** no more "used before its declaration" warnings from KWin at load; metadata.json installed with mode 0644.
- **2.0:** idle-aware automatic reshuffle and drift (helper gains Wayland idle detection); new Automatic settings tab; metadata.json author field.
- **1.4.4:** corrected the size-restore log message (it printed the restored size twice).
- **1.4.3:** maximized and snapped windows are left alone; size guard widened to 5 s and also catches changes during the move (fixed Steam resizing itself on reshuffle).
- **1.4.2:** size guard for apps that resize themselves when moved.
- **1.4.1:** dialogs stay over their parent window.
- **1.4:** wear map, randomness-first placement, settings page, store safety fixes from an independent review.
- **1.3:** per-app usage remembered across logins (helper service).
