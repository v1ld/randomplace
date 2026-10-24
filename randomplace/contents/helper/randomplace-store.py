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
    IdleSeconds(s timeoutMs) -> i
                    how long the user has been idle, in seconds (0 = active),
                    or -1 if it can't be told. Uses the Wayland
                    ext-idle-notify-v1 protocol (KWin implements it): KWin
                    scripts can't see keyboard input, and KDE's screen saver
                    D-Bus idle query is unsupported on Wayland. The
                    notification respects idle inhibitors, so while a video
                    plays the user never counts as idle. Idle times shorter
                    than timeoutMs read as 0.

Data file: $XDG_STATE_HOME/randomplace/usage.json (default ~/.local/state/...).
Override with RANDOMPLACE_STORE=/path/to/file (used by the tests).

Backups, in backups/ next to the data file, taken before a save replaces it:
  usage-YYYY-MM-DD.json   the first save of each day keeps the previous file;
                          the newest BACKUP_DAYS of these are kept.
  usage-shrunk-<time>.json
                          the file as it was before a save that drops a
                          screen's wear map or loses more than half of its
                          recorded wear; the newest BACKUP_SHRUNK are kept.
To restore one, copy it over usage.json and reload the script.

The service is D-Bus activated on first use. While the script's clock is
ticking it stays running (a few MB, idle between ticks); after a period
without any calls it exits, and the next call simply starts it again.
"""
import json
import os
import socket
import struct
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
BACKUP_DAYS = 7
BACKUP_SHRUNK = 5
SHRINK_MIN_SEC = 3600           # maps with less recorded wear than this don't count
B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
B64I = {c: i for i, c in enumerate(B64)}

XML = """
<node>
  <interface name="local.randomplace.Store">
    <method name="Load"><arg type="s" direction="out"/></method>
    <method name="Save"><arg type="s" direction="in"/></method>
    <method name="Tick"><arg type="s" direction="in"/><arg type="b" direction="out"/></method>
    <method name="IdleSeconds"><arg type="s" direction="in"/><arg type="i" direction="out"/></method>
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


def wear_totals(data):
    """Recorded wear (cell-seconds) per real screen, from saved data."""
    out = {}
    wear = data.get("wear") if isinstance(data, dict) else None
    if not isinstance(wear, dict):
        return out
    for key, e in wear.items():
        if key.startswith("Placeholder-") or not isinstance(e, dict):
            continue
        d = e.get("d")
        if not isinstance(d, str):
            continue
        total = 0.0
        try:
            for i in range(0, len(d) - 1, 2):
                q = B64I[d[i]] * 64 + B64I[d[i + 1]]
                if q:
                    total += 60 * (2 ** (q / 180) - 1)
        except KeyError:
            continue
        out[key] = total
    return out


def keep_copy(dest, raw):
    folder = os.path.dirname(dest)
    os.makedirs(folder, mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".backup-", dir=folder)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, dest)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def prune(folder, prefix, keep):
    try:
        names = sorted(n for n in os.listdir(folder) if n.startswith(prefix) and n.endswith(".json"))
    except OSError:
        return
    for n in names[:-keep]:
        try:
            os.unlink(os.path.join(folder, n))
        except OSError:
            pass


def backup(path, new_data):
    """Keep the current file before it is replaced: once a day, and whenever
    the new data would drop or shrink a screen's wear map. Never fails a save."""
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError:
        return                                # nothing saved yet
    folder = os.path.join(os.path.dirname(path), "backups")
    try:
        daily = os.path.join(folder, "usage-%s.json" % time.strftime("%Y-%m-%d"))
        if not os.path.exists(daily):
            keep_copy(daily, raw)
            prune(folder, "usage-2", BACKUP_DAYS)
        try:
            old = wear_totals(json.loads(raw.decode("utf-8")))
        except ValueError:
            return
        new = wear_totals(new_data)
        lost = [k for k, t in old.items() if t >= SHRINK_MIN_SEC and new.get(k, 0) < t / 2]
        if lost:
            dest = os.path.join(folder, "usage-shrunk-%s.json" % time.strftime("%Y%m%d-%H%M%S"))
            keep_copy(dest, raw)
            prune(folder, "usage-shrunk-", BACKUP_SHRUNK)
            print("randomplace-store: save drops or halves the wear map of %s; previous file kept as %s"
                  % (", ".join(sorted(lost)), dest), file=sys.stderr)
    except OSError as e:
        print("randomplace-store: backup failed: %s" % e, file=sys.stderr)


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
    backup(path, data)
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


# --------------------------------------------------------------- idle watch
#
# A minimal Wayland client (wire protocol only, no extra packages) that asks
# the compositor for an ext_idle_notification_v1 and listens for its idled /
# resumed events.

def _wstr(s):
    b = s.encode("utf-8") + b"\0"
    return struct.pack("=I", len(b)) + b + b"\0" * (-len(b) % 4)


class IdleWatcher:
    def __init__(self):
        self.sock = None
        self.state = "new"           # new -> ready | unsupported | broken
        self.timeout_ms = 0
        self.idled_at = None         # monotonic time of the last "idled" event
        self.buf = b""
        self.next_id = 2
        self.objs = {}
        self.globals = {}
        self.seat = self.notifier = self.notif = None
        self.watch = None
        self.retry_at = 0

    # -- wire helpers
    def _new(self, iface):
        i = self.next_id
        self.next_id += 1
        self.objs[i] = iface
        return i

    def _send(self, obj, opcode, payload=b""):
        self.sock.sendall(struct.pack("=II", obj, ((8 + len(payload)) << 16) | opcode) + payload)

    def _messages(self):
        while len(self.buf) >= 8:
            obj, so = struct.unpack_from("=II", self.buf)
            size, opcode = so >> 16, so & 0xFFFF
            if size < 8 or len(self.buf) < size:
                if size < 8:
                    raise ValueError("bad message size")
                return
            payload = self.buf[8:size]
            self.buf = self.buf[size:]
            yield obj, opcode, payload

    @staticmethod
    def _str(payload, off):
        n = struct.unpack_from("=I", payload, off)[0]
        s = payload[off + 4:off + 4 + max(0, n - 1)].decode("utf-8", "replace")
        return s, off + 4 + n + (-n % 4)

    def _handle(self, obj, opcode, payload):
        iface = self.objs.get(obj)
        if obj == 1 and opcode == 0:                      # wl_display.error
            _, code = struct.unpack_from("=II", payload)
            msg, _ = self._str(payload, 8)
            raise RuntimeError("Wayland error %d: %s" % (code, msg))
        if iface == "wl_registry" and opcode == 0:        # global(name, interface, version)
            name = struct.unpack_from("=I", payload)[0]
            ifname, off = self._str(payload, 4)
            version = struct.unpack_from("=I", payload, off)[0]
            self.globals[ifname] = (name, version)
        elif iface == "wl_callback" and opcode == 0:      # done
            self.objs[obj] = "wl_callback(done)"
        elif iface == "ext_idle_notification_v1" and obj == self.notif:
            if opcode == 0:
                self.idled_at = time.monotonic()
            elif opcode == 1:
                self.idled_at = None

    def _read_blocking(self, until_done_id, deadline):
        while self.objs.get(until_done_id) != "wl_callback(done)":
            self.sock.settimeout(max(0.05, deadline - time.monotonic()))
            data = self.sock.recv(65536)
            if not data:
                raise ConnectionError("compositor closed the connection")
            self.buf += data
            for m in list(self._messages()):
                self._handle(*m)

    def _socket_paths(self):
        rt = os.environ.get("XDG_RUNTIME_DIR") or "/run/user/%d" % os.getuid()
        disp = os.environ.get("WAYLAND_DISPLAY")
        names = [disp] if disp else []
        try:
            names += sorted(f for f in os.listdir(rt) if f.startswith("wayland-") and not f.endswith(".lock"))
        except OSError:
            pass
        seen = []
        for n in names:
            p = n if os.path.isabs(n) else os.path.join(rt, n)
            if p not in seen:
                seen.append(p)
        return seen

    def _connect(self):
        last = None
        for path in self._socket_paths():
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                s.connect(path)
                return s
            except OSError as e:
                s.close()
                last = e
        raise ConnectionError("no Wayland socket (%s)" % last)

    def _setup(self):
        self.sock = self._connect()
        reg = self._new("wl_registry")
        self._send(1, 1, struct.pack("=I", reg))               # wl_display.get_registry
        cb = self._new("wl_callback")
        self._send(1, 0, struct.pack("=I", cb))                # wl_display.sync
        self._read_blocking(cb, time.monotonic() + 2.0)
        if "ext_idle_notifier_v1" not in self.globals or "wl_seat" not in self.globals:
            self.state = "unsupported"
            self.sock.close()
            self.sock = None
            return
        for ifname, attr in (("wl_seat", "seat"), ("ext_idle_notifier_v1", "notifier")):
            name, _ = self.globals[ifname]
            oid = self._new(ifname)
            self._send(reg, 0, struct.pack("=I", name) + _wstr(ifname) + struct.pack("=II", 1, oid))
            setattr(self, attr, oid)
        self.sock.setblocking(False)
        self.watch = GLib.io_add_watch(self.sock.fileno(), GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, self._on_io)
        self.state = "ready"

    def _make_notification(self, timeout_ms):
        if self.notif is not None:
            self._send(self.notif, 0)                          # ext_idle_notification_v1.destroy
        self.notif = self._new("ext_idle_notification_v1")
        self.idled_at = None
        self.timeout_ms = timeout_ms
        # ext_idle_notifier_v1.get_idle_notification(id, timeout, seat): respects inhibitors
        self._send(self.notifier, 1, struct.pack("=III", self.notif, timeout_ms, self.seat))

    def _on_io(self, fd, cond):
        try:
            if cond & (GLib.IO_HUP | GLib.IO_ERR):
                raise ConnectionError("connection lost")
            while True:
                try:
                    data = self.sock.recv(65536)
                except BlockingIOError:
                    break
                if not data:
                    raise ConnectionError("compositor closed the connection")
                self.buf += data
            for m in list(self._messages()):
                self._handle(*m)
            return True
        except Exception as e:                                 # reconnect later
            print("randomplace-store: idle watch: %s" % e, file=sys.stderr)
            self._reset("broken")
            return False

    def _reset(self, state):
        try:
            if self.sock:
                self.sock.close()
        except OSError:
            pass
        self.__init__()
        self.state = state
        self.retry_at = time.monotonic() + 30

    def idle_seconds(self, timeout_ms):
        if self.state in ("unsupported",):
            return -1
        if self.state == "broken" and time.monotonic() < self.retry_at:
            return -1
        try:
            if self.state != "ready":
                self._reset("new")
                self._setup()
                if self.state != "ready":
                    return -1
            timeout_ms = max(1000, min(3600000, int(timeout_ms)))
            if self.notif is None or timeout_ms != self.timeout_ms:
                self._make_notification(timeout_ms)
            if self.idled_at is None:
                return 0
            return int(self.timeout_ms / 1000 + time.monotonic() - self.idled_at)
        except Exception as e:
            print("randomplace-store: idle watch: %s" % e, file=sys.stderr)
            self._reset("broken")
            return -1


idle_watch = IdleWatcher()


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
        elif method == "IdleSeconds":
            try:
                ms = int(float(params.unpack()[0]))
            except ValueError:
                ms = 20000
            invocation.return_value(GLib.Variant("(i)", (idle_watch.idle_seconds(ms),)))
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
