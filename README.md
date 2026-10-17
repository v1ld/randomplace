# RandomPlace – burn-in-aware window placement for KDE Plasma 6

RandomPlace is a KWin script for OLED screens. Window borders and title bars are the most static, high-contrast things on a desktop. When they keep landing on the same pixels, those pixels age faster than the rest of the panel. RandomPlace spreads that wear out.

- **Random placement.** New windows and reshuffles pick random positions, so window edges don't keep landing on the same lines.
- **Wear map.** For each screen, and across logins, RandomPlace records how long window borders and title bars have been visible on each part of the screen. New positions are steered towards areas that have been used less.
- **Usage-aware.** When windows must overlap, the ones you use least get covered. Usage is remembered per app across logins.
- **Reshuffle on demand.** `Meta+Ctrl+Shift+R` re-places every movable window on the current desktop.
- **Separate layouts.** Each virtual desktop, Activity and screen is handled on its own.
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
| **Advanced** | | |
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

### Wear map

- **Grid:** one map per screen, keyed by output name and covering the whole screen. Panels, margins or a moved panel don't shift or reset it. A change of resolution, scale or cell size resamples the existing history, taking the maximum of each source block so worn lines survive.
- **What counts:** the time since the last sample is added to each cell that shows a window's title-bar band or border. Parts hidden under another window, or off this screen, don't count. Window interiors don't count either, because their content changes. A window spanning two screens wears both.
- **Clock:** sampling runs on the helper's clock every `wearSampleSec`, so keyboard-only work counts too. It also runs on every window, desktop or Activity change. Nothing is counted while the screen is locked, checked via `org.freedesktop.ScreenSaver`, and a gap of more than a few ticks (suspend) counts as only a few seconds.
- **Storage:** about 40 KB per screen, with log-scaled precision better than 1%. Up to 6 screens are kept, dropping the least recently used. Wear fades with a half-life of `wearHalfLifeDays`. Stochastic rounding keeps that fade correct across many short sessions.
- **Cost of scoring:** constant time per candidate position, using prefix sums.

### The helper

KWin scripts can read settings, but they cannot write files and have no timers. A small helper, `contents/helper/randomplace-store.py`, provides both over D-Bus.

- **`Load` / `Save`:** keeps `~/.local/state/randomplace/usage.json`, written atomically with mode 600.
- **`Tick`:** replies after `wearSampleSec`. This is the script's clock.

D-Bus starts the helper on demand. Because the clock keeps calling it, it stays running while the script is active: a small idle Python process that wakes every few seconds. It exits 10 minutes after the last call, for example when the script is disabled.

**Your data is protected.** The script never saves before it has loaded the existing data.
- **Unreadable file** (permissions, I/O error): the helper reports an error, and the script keeps working for the session without saving anything.
- **Corrupt file:** the helper moves it to `usage.json.bad-<date>` before starting fresh.
- **Format the script doesn't recognise** (for example from a newer version): the script refuses to save for the session and logs why.

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
- **Plasma panels, desktop widgets and wallpaper.** These never move and aren't counted. Consider auto-hiding the panel and using the panel's own OLED-friendly options.
- **Maximized windows** aren't moved, but their visible title bars and borders are recorded as wear. Fullscreen windows are ignored.
- **The simulation is a model.** Real usage patterns, window sizes and display times differ. The wear-report tool below shows what is actually happening on your screen.

## Inspecting your wear map

```bash
python3 ~/.local/share/kwin/scripts/randomplace/contents/helper/wear-report.py
```

The tool prints, for each screen, how much border and title-bar time has been recorded, how evenly it is spread, and a heat map in the terminal where darker characters mean more wear. No extra packages are needed.

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
- **More detail:** with `debug` on, the log also shows every window's usage score, each placement's hidden area and wear cost, and screen lock and unlock.

## Uninstall

```bash
./uninstall.sh           # keeps ~/.local/state/randomplace/usage.json
./uninstall.sh --purge   # also deletes saved usage and wear
```

## Notes and limits

- **Left alone:** windows that are fullscreen, maximized, tiled, minimized, dialogs or transients are never moved. Non-maximized ones still count as obstacles.
- **"On all desktops" windows:** they take part in the reshuffle of whichever desktop you are on, and their new position applies on every desktop.
- **Usage is per app, not per desktop.** An app you use a lot is protected on every desktop.
- **Pauses:** KWin runs scripts on its main thread, so a reshuffle pauses the desktop for up to `optimizeMs` in total, 150 ms by default.
- **Placement speed:** placing a new window takes a few milliseconds with a handful of windows open, and about 50 ms with 45 windows (measured in a fast JavaScript engine). KWin's engine may take a few times longer.
- **Session restore:** windows restored right at login may be placed before saved usage and wear have loaded, so those first placements are purely random.
- **Unsaved time:** focus time and wear not yet saved (at most `saveIntervalSec`) are lost if you log out abruptly or reinstall.
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
