#!/usr/bin/env python3
"""RandomPlace store and clock.

KWin scripts cannot write files and have no timers, so the RandomPlace script
talks to this tiny session-bus service:

  bus name   local.randomplace.Store
  object     /local/randomplace/Store
  interface  local.randomplace.Store
    Load() -> s     the saved JSON text; "{}" only if there is no file yet.
                    An unreadable file is an error (the script then never
                    saves over it); a corrupt one is moved aside first.
    Save(s)         replace the saved JSON text (atomically)
    Tick(s) -> b    reply after the given number of milliseconds (100..20000):
                    the script's clock for sampling screen wear on a steady
                    schedule, even when nothing else happens on screen.

Data file: $XDG_STATE_HOME/randomplace/usage.json (default ~/.local/state/...).
Override with RANDOMPLACE_STORE=/path/to/file (used by the tests).

The service is D-Bus activated on first use. While the script's clock is
ticking it stays running (a few MB, idle between ticks); after a period
without any calls it exits, and the next call simply starts it again.
"""
import json
import os
import sys
import tempfile
import time

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

NAME = "local.randomplace.Store"
PATH = "/local/randomplace/Store"
IFACE = "local.randomplace.Store"
ERR = "local.randomplace.Store.Error."
MAX_BYTES = 4 * 1024 * 1024     # wear maps are ~40 KB per screen
IDLE_EXIT_SEC = int(os.environ.get("RANDOMPLACE_IDLE_EXIT", "600"))

XML = """
<node>
  <interface name="local.randomplace.Store">
    <method name="Load"><arg type="s" direction="out"/></method>
    <method name="Save"><arg type="s" direction="in"/></method>
    <method name="Tick"><arg type="s" direction="in"/><arg type="b" direction="out"/></method>
  </interface>
</node>
"""

last_activity = time.monotonic()


class Unreadable(Exception):
    """The store exists but cannot be read: never report it as empty."""


def data_file():
    override = os.environ.get("RANDOMPLACE_STORE")
    if override:
        return override
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "randomplace", "usage.json")


def move_aside(path, why):
    """Keep a damaged store as a backup instead of overwriting it."""
    dest = "%s.bad-%s" % (path, time.strftime("%Y%m%d-%H%M%S"))
    try:
        os.replace(path, dest)
    except OSError as e:
        raise Unreadable("%s, and could not move it aside: %s" % (why, e))
    print("randomplace-store: %s; moved to %s" % (why, dest), file=sys.stderr)


def load():
    path = data_file()
    try:
        size = os.stat(path).st_size
    except FileNotFoundError:
        return "{}"
    except OSError as e:
        raise Unreadable(str(e))
    if size > MAX_BYTES:
        move_aside(path, "store larger than %d bytes" % MAX_BYTES)
        return "{}"
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError as e:                      # permissions, I/O error, a directory...
        raise Unreadable(str(e))
    try:
        text = raw.decode("utf-8")
        json.loads(text)
    except ValueError as e:                   # includes UnicodeDecodeError
        move_aside(path, "store is not valid JSON (%s)" % e)
        return "{}"
    return text


def save(text):
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise ValueError("payload too large")
    try:
        data = json.loads(text)
    except ValueError as e:
        raise ValueError("not valid JSON: %s" % e)
    if not isinstance(data, dict) or data.get("v") != 1 \
            or not isinstance(data.get("apps"), dict):
        raise ValueError("unexpected structure")

    path = data_file()
    folder = os.path.dirname(path)
    os.makedirs(folder, mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".usage-", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)     # atomic: readers never see a partial file
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def touch():
    global last_activity
    last_activity = time.monotonic()


def on_method_call(conn, sender, obj_path, iface, method, params, invocation):
    touch()
    try:
        if method == "Load":
            invocation.return_value(GLib.Variant("(s)", (load(),)))
        elif method == "Save":
            save(params.unpack()[0])
            invocation.return_value(None)
        elif method == "Tick":
            try:
                ms = int(float(params.unpack()[0]))
            except ValueError:
                ms = 5000
            ms = max(100, min(20000, ms))

            def reply():
                touch()
                invocation.return_value(GLib.Variant("(b)", (True,)))
                return False
            GLib.timeout_add(ms, reply)
        else:
            invocation.return_dbus_error(ERR + "UnknownMethod", method)
    except Unreadable as e:
        invocation.return_dbus_error(ERR + "Unreadable", str(e))
    except ValueError as e:
        invocation.return_dbus_error(ERR + "Invalid", str(e))
    except OSError as e:
        invocation.return_dbus_error(ERR + "IO", str(e))
    except Exception as e:                     # never leave a caller hanging
        invocation.return_dbus_error(ERR + "Internal", repr(e))


def main():
    loop = GLib.MainLoop()
    node = Gio.DBusNodeInfo.new_for_xml(XML)

    def on_bus_acquired(conn, name):
        conn.register_object(PATH, node.interfaces[0], on_method_call, None, None)

    def on_name_lost(conn, name):
        # Another instance already owns the name (or the bus went away).
        loop.quit()

    owner = Gio.bus_own_name(Gio.BusType.SESSION, NAME, Gio.BusNameOwnerFlags.NONE,
                             on_bus_acquired, None, on_name_lost)

    def idle_check():
        if time.monotonic() - last_activity > IDLE_EXIT_SEC:
            # Give the name up first so new calls start a fresh instance
            # instead of reaching one that is about to exit.
            Gio.bus_unown_name(owner)
            GLib.timeout_add(500, lambda: (loop.quit(), False)[1])
            return False
        return True

    GLib.timeout_add_seconds(5 if IDLE_EXIT_SEC < 60 else 30, idle_check)
    loop.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
