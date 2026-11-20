#!/usr/bin/env python3
"""Show RandomPlace's burn-in wear map as a heat map in the terminal.

    python3 wear-report.py               # reads ~/.local/state/randomplace/usage.json
    python3 wear-report.py FILE [COLS]   # another file, and/or a different width

Options:
    --linear (default), --sqrt, --log   how wear maps to shades (see below)
    --color, --no-color                 force colour on or off; by default it
                                        is used on a terminal that supports it
                                        (COLORTERM=truecolor or a 256-colour
                                        TERM) unless NO_COLOR is set

For each screen it prints how much border/title-bar time is recorded, how
evenly it is spread (peak / mean and coefficient of variation; lower is more
even), how sharp the differences between neighbouring cells are, and a heat
map: darker characters, or warmer colours, mean more wear. Never-worn cells
stay blank. No extra Python packages are needed.

Sharpness is the figure closest to visible burn-in: a broad, gradual
difference across the panel is hard to see, a sharp line is not. It is the
difference in wear between cells that touch, as a share of the mean wear:
the typical step, and the 99th-percentile step (the sharpest lines).

Scales, as a fraction f of the map's peak:
    linear  shade ~ f          honest about hotspots (default); in colour faint
                               wear stays visible, as characters it hides
                               wear under 10%
    sqrt    shade ~ sqrt(f)    faint history visible down to 1%
    log     3 decades of f     anything from 0.1% up; exaggerates faint wear

The helper also writes this report weekly to
~/.local/state/randomplace/reports/wear-YYYY-MM-DD.txt (the last 26 are kept).
"""
import json
import math
import os
import sys

B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
IDX = {c: i for i, c in enumerate(B64)}
SHADES = " .:-=+*#%@"
LOG_DECADES = 3
# Dark purple -> red -> orange -> pale yellow (inferno-like, without its
# near-black start so that light wear stays distinct from none).
RAMP = [(40, 11, 84), (101, 21, 110), (159, 42, 99), (212, 72, 66),
        (245, 125, 21), (250, 193, 39), (252, 255, 164)]
CUBE = [0, 95, 135, 175, 215, 255]


def default_path():
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "randomplace", "usage.json")


def decode(s, n):
    if len(s) != 2 * n:
        raise ValueError("wear map length mismatch")
    out = []
    for i in range(n):
        q = IDX[s[2 * i]] * 64 + IDX[s[2 * i + 1]]
        out.append(60 * (2 ** (q / 180) - 1) if q else 0.0)
    return out


def level(f, scale):
    """0..1 shade level for a fraction f (0 < f <= 1) of the peak."""
    if scale == "linear":
        return f
    if scale == "log":
        return max(0.0, 1 + math.log10(f) / LOG_DECADES)
    return math.sqrt(f)


def unlevel(t, scale):
    """The fraction of the peak at shade level t (for the legend)."""
    if scale == "linear":
        return t
    if scale == "log":
        return 10 ** ((t - 1) * LOG_DECADES)
    return t * t


def ramp(t):
    t = min(1.0, max(0.0, t)) * (len(RAMP) - 1)
    i = min(len(RAMP) - 2, int(t))
    a, b, u = RAMP[i], RAMP[i + 1], t - i
    return tuple(round(a[k] + (b[k] - a[k]) * u) for k in range(3))


def sgr(rgb, color, bg=False):
    if color == "truecolor":
        return "%d;2;%d;%d;%d" % (((48 if bg else 38),) + rgb)
    idx = 16 + sum(m * min(range(6), key=lambda j: abs(CUBE[j] - c)) for m, c in zip((36, 6, 1), rgb))
    return "%d;5;%d" % ((48 if bg else 38), idx)


def detect_color():
    if os.environ.get("NO_COLOR") or not sys.stdout.isatty():
        return None
    if os.environ.get("COLORTERM", "").lower() in ("truecolor", "24bit"):
        return "truecolor"
    if "256color" in os.environ.get("TERM", ""):
        return "256"
    return None


def downsample(d, gw, gh, c, r):
    """Average the gw x gh map into c x r blocks."""
    grid = []
    for y in range(r):
        y0, y1 = y * gh // r, max(y * gh // r + 1, (y + 1) * gh // r)
        row = []
        for x in range(c):
            x0, x1 = x * gw // c, max(x * gw // c + 1, (x + 1) * gw // c)
            row.append(sum(d[yy * gw + xx] for yy in range(y0, y1) for xx in range(x0, x1)) /
                       ((x1 - x0) * (y1 - y0)))
        grid.append(row)
    return grid


def heatmap_ascii(d, gw, gh, cols, scale):
    c = min(cols, gw)
    # terminal cells are about twice as tall as wide
    grid = downsample(d, gw, gh, c, max(1, round(gh * c / gw / 2)))
    peak = max(max(row) for row in grid)

    def ch(v):
        if v <= 0 or peak <= 0:
            return " "
        return SHADES[min(len(SHADES) - 1, int(len(SHADES) * level(v / peak, scale)))]
    lines = ["+" + "-" * c + "+"]
    lines += ["|" + "".join(ch(v) for v in row) + "|" for row in grid]
    lines.append("+" + "-" * c + "+")
    first = unlevel(1 / len(SHADES), scale)
    lines.append("scale: '%s' (none -> most), %s; first mark at %s of peak" % (SHADES, scale, pct(first)))
    return lines


def heatmap_color(d, gw, gh, cols, scale, color):
    c = min(cols, gw)
    # two map rows per text line (upper/lower half blocks): square-ish cells
    r = max(2, round(gh * c / gw))
    r += r % 2
    grid = downsample(d, gw, gh, c, r)
    peak = max(max(row) for row in grid)

    def rgb(v):
        return ramp(level(v / peak, scale)) if v > 0 and peak > 0 else None
    lines = ["+" + "-" * c + "+"]
    for y in range(0, r, 2):
        parts = []
        for x in range(c):
            top, bot = rgb(grid[y][x]), rgb(grid[y + 1][x])
            if top and bot:
                parts.append("\x1b[%s;%sm▀" % (sgr(top, color), sgr(bot, color, True)))
            elif top:
                parts.append("\x1b[0;%sm▀" % sgr(top, color))
            elif bot:
                parts.append("\x1b[0;%sm▄" % sgr(bot, color))
            else:
                parts.append("\x1b[0m ")
        lines.append("|" + "".join(parts) + "\x1b[0m|")
    lines.append("+" + "-" * c + "+")
    steps = 40
    bar = "".join("\x1b[%sm█" % sgr(ramp(i / (steps - 1)), color) for i in range(steps)) + "\x1b[0m"
    lines.append("scale: %s  up to %s -> 100%% of peak (%s; middle = %s); blank = never worn" % (
        bar, pct(unlevel(1 / steps, scale)), scale, pct(unlevel(0.5, scale))))
    return lines


def pct(f):
    p = 100 * f
    return ("%.1f%%" % p) if p < 10 else ("%d%%" % round(p))


def sharpness(d, gw, gh):
    """Wear differences between touching cells, as fractions of the mean wear:
    (mean step, 99th-percentile step)."""
    mean = sum(d) / len(d) if d else 0
    if mean <= 0:
        return 0.0, 0.0
    steps = []
    for r in range(gh):
        row = r * gw
        for c in range(gw):
            v = d[row + c]
            if c + 1 < gw:
                steps.append(abs(v - d[row + c + 1]))
            if r + 1 < gh:
                steps.append(abs(v - d[row + gw + c]))
    if not steps:
        return 0.0, 0.0
    steps.sort()
    return sum(steps) / len(steps) / mean, steps[int(0.99 * (len(steps) - 1))] / mean


SEAT_W, SEAT_H = 12, 6
MIN_SEAT_HOURS = 2.0


def own_range(data):
    """Lines on how widely each app's windows range over the screen.

    Each app's time per field of the 12 x 6 grid is compared with the average
    of all listed apps: 1.00 = it was everywhere the others were, in the same
    proportion; 0.33 = it kept to a third of that. The wear map above cannot
    show this, because it does not know which window a border belongs to."""
    rows = []
    for k, e in (data.get("apps") or {}).items():
        p = e.get("pos") if isinstance(e, dict) else None
        if not isinstance(p, list) or len(p) != SEAT_W * SEAT_H:
            continue
        t = float(sum(p))
        if t >= MIN_SEAT_HOURS * 3600:
            rows.append((k, t, [v / t for v in p]))
    if not rows:
        return []
    rows.sort(key=lambda r: -r[1])
    n = len(rows)
    pool = [sum(r[2][i] for r in rows) / n for i in range(SEAT_W * SEAT_H)]
    lines = ["own range, per app with at least %g h on screen (1.00 = ranges as widely as the others; "
             "left-to-right share of its time, 0-9):" % MIN_SEAT_HOURS]
    for k, t, f in rows:
        cols = [sum(f[r * SEAT_W + c] for r in range(SEAT_H)) for c in range(SEAT_W)]
        top = max(cols) or 1
        prof = "".join(str(min(9, int(round(9 * v / top)))) for v in cols)
        if n > 1:
            score = "%.2f" % sum(min(a, b) for a, b in zip(f, pool))
        else:
            score = " n/a"
        lines.append("  %s  %s  %7.1f h  %s" % (score, prof, t / 3600, k))
    if n == 1:
        lines.append("  (one app only: nothing to compare it with yet)")
    return lines


def render(data, cols=100, scale="linear", color=None):
    """The report for saved data, as text. color: None, "256" or "truecolor"."""
    lines = []
    out = lines.append
    wear = data.get("wear") or {}
    # KWin's stand-in screen while no monitor is connected (e.g. during crash
    # recovery); RandomPlace 2.0.3 no longer records or keeps it.
    skipped = sorted(k for k in wear if k.startswith("Placeholder-"))
    wear = {k: e for k, e in wear.items() if k not in skipped}
    if skipped:
        out("ignoring placeholder screen(s): " + ", ".join(skipped))
    if not wear:
        out("No wear maps recorded yet")
        return "\n".join(lines) + "\n"
    out("screens: " + ", ".join("%s (%dx%d px)" % (k, e.get("w", 0), e.get("h", 0)) for k, e in wear.items()))
    for key, e in wear.items():
        gw, gh, cell = e["gw"], e["gh"], e["cell"]
        d = decode(e["d"], gw * gh)
        total = sum(d)
        touched = [v for v in d if v > 0]
        mean_all = total / len(d)
        mean_t = sum(touched) / len(touched) if touched else 0
        cv = math.sqrt(sum((v - mean_all) ** 2 for v in d) / len(d)) / mean_all if mean_all else 0
        out("=" * cols)
        out("%s   grid %dx%d of %d px cells" % (key, gw, gh, cell))
        out("border/title-bar time: %.1f cell-hours   covered: %.1f%% of screen" %
            (total / 3600, 100 * len(touched) / len(d)))
        out("evenness: peak/mean %.2f   p99/mean %.2f   cv %.3f  (lower = more even)" % (
            max(d) / mean_t if mean_t else 0,
            sorted(touched)[int(0.99 * (len(touched) - 1))] / mean_t if touched else 0, cv))
        step_mean, step_99 = sharpness(d, gw, gh)
        out("sharpness: neighbouring cells differ by %s of the mean on average, %s at the sharpest 1%%  (lower = softer)" % (
            pct(step_mean), pct(step_99)))
        if color:
            lines.extend(heatmap_color(d, gw, gh, cols, scale, color))
        else:
            lines.extend(heatmap_ascii(d, gw, gh, cols, scale))
    seats = own_range(data)
    if seats:
        out("=" * cols)
        lines.extend(seats)
    return "\n".join(lines) + "\n"


def main():
    args, scale, color = [], "linear", "auto"
    for a in sys.argv[1:]:
        if a in ("--sqrt", "--linear", "--log"):
            scale = a[2:]
        elif a == "--color":
            color = "always"
        elif a == "--no-color":
            color = "never"
        elif a in ("-h", "--help"):
            print(__doc__.strip())
            return
        elif a.startswith("--"):
            sys.exit("unknown option %s (see --help)" % a)
        else:
            args.append(a)
    path = args[0] if args else default_path()
    cols = int(args[1]) if len(args) > 1 else 100
    if color == "auto":
        mode = detect_color()
    elif color == "always":
        mode = detect_color() or ("256" if "256color" in os.environ.get("TERM", "") else "truecolor")
    else:
        mode = None
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    sys.stdout.write(render(data, cols, scale, mode))


if __name__ == "__main__":
    main()
