#!/usr/bin/env python3
"""Show RandomPlace's burn-in wear map as a heat map in the terminal.

    python3 wear-report.py               # reads ~/.local/state/randomplace/usage.json
    python3 wear-report.py FILE [COLS]   # another file, and/or a different width

For each screen it prints how much border/title-bar time is recorded, how
evenly it is spread (peak / mean and coefficient of variation; lower is more
even) and a heat map where darker characters mean more wear. No extra Python
packages are needed.
"""
import json
import math
import os
import sys

B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
IDX = {c: i for i, c in enumerate(B64)}
SHADES = " .:-=+*#%@"


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


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else default_path()
    cols = int(sys.argv[2]) if len(sys.argv) > 2 else 100
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    wear = data.get("wear") or {}
    if not wear:
        print("No wear maps recorded yet in", path)
        return
    for key, e in wear.items():
        gw, gh, cell = e["gw"], e["gh"], e["cell"]
        d = decode(e["d"], gw * gh)
        total = sum(d)
        touched = [v for v in d if v > 0]
        mean_all = total / len(d)
        mean_t = sum(touched) / len(touched) if touched else 0
        cv = math.sqrt(sum((v - mean_all) ** 2 for v in d) / len(d)) / mean_all if mean_all else 0
        print("=" * cols)
        print("%s   grid %dx%d of %d px cells" % (key, gw, gh, cell))
        print("border/title-bar time: %.1f cell-hours   covered: %.1f%% of screen" %
              (total / 3600, 100 * len(touched) / len(d)))
        print("evenness: peak/mean %.2f   p99/mean %.2f   cv %.3f  (lower = more even)" % (
            max(d) / mean_t if mean_t else 0,
            sorted(touched)[int(0.99 * (len(touched) - 1))] / mean_t if touched else 0, cv))
        # downsample to the terminal: terminal cells are about twice as tall as wide
        c = min(cols, gw)
        r = max(1, round(gh * c / gw / 2))
        peak = 0
        grid = []
        for y in range(r):
            row = []
            for x in range(c):
                x0, x1 = x * gw // c, max(x * gw // c + 1, (x + 1) * gw // c)
                y0, y1 = y * gh // r, max(y * gh // r + 1, (y + 1) * gh // r)
                v = sum(d[yy * gw + xx] for yy in range(y0, y1) for xx in range(x0, x1)) / ((x1 - x0) * (y1 - y0))
                row.append(v)
                peak = max(peak, v)
            grid.append(row)
        print("+" + "-" * c + "+")
        for row in grid:
            print("|" + "".join(SHADES[min(len(SHADES) - 1, int(len(SHADES) * v / peak))] if peak else " "
                                for v in row) + "|")
        print("+" + "-" * c + "+")
        print("scale: '%s' (none -> most)" % SHADES)


if __name__ == "__main__":
    main()
