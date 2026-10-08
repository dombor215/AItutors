#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Bot Studio - tiny local server (console mode).

  python botstudio.py                (or double-click it)
  python botstudio.py --port 9000 --no-browser --verbose

Stop it with Ctrl+C, by closing this window, or with the "Stop server" button.
Only the Python standard library is used. It:
  * serves botstudio.html at http://127.0.0.1:<port>/
  * serves every bot folder at /bots/<folder>/ (preview, no-cache)
  * offers a small JSON API for file operations (list / read / save / copy / rename)
Security: bound to 127.0.0.1, Host + Origin check, random per-run token for /api/*,
strict folder-name validation, path-traversal guard.
"""
import argparse
import json
import mimetypes
import os
import re
import secrets
import shutil
import sys
import threading
import time
import traceback
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

ROOT = Path(__file__).resolve().parent
TEMPLATE = "template"
UI_FILE = ROOT / "botstudio.html"
HOST = "127.0.0.1"
DEFAULT_PORT = 8765
TOKEN = secrets.token_urlsafe(24)
MAX_BODY = 25 * 1024 * 1024
CSS_FILE = "custom.css"
MAX_DEPTH = 5   # max folder nesting; chatbots can sit inside folders up to this level

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
JS_FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}\.js$")
CONFIG_HINT = re.compile(r"\bconst\s+(?:API_URL|MODEL_NAME|FIRST_MESSAGE)\b")
SCRIPT_SRC = re.compile(r"""<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']""", re.I)

STATE = {"port": DEFAULT_PORT, "httpd": None}
VERBOSE = False
USE_COLOR = False

MIME = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8", ".map": "application/json; charset=utf-8",
}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ----------------------------------------------------------------- console output
def setup_console():
    """Make printing safe (odd characters, no console under pythonw) and enable colours."""
    global USE_COLOR
    if sys.stdout is None or sys.stderr is None:      # started with pythonw: no console
        sys.stdout = sys.stderr = open(os.devnull, "w")
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")      # never crash on cp1252 consoles
        except Exception:
            pass
    if sys.stdout.isatty():
        if os.name == "nt":
            os.system("")                             # enables ANSI colours in Windows 10+ consoles
            os.system("title Bot Studio")
        USE_COLOR = "NO_COLOR" not in os.environ


def _c(code, text):
    return f"\033[{code}m{text}\033[0m" if USE_COLOR else text


TAGS = {"info": ("36", "INFO"), "ok": ("32", "OK  "), "warn": ("33", "WARN"),
        "error": ("31", "ERR "), "dim": ("90", "    ")}


def say(msg, kind="info"):
    code, tag = TAGS[kind]
    stamp = _c("90", datetime.now().strftime("%H:%M:%S"))
    text = _c("90", msg) if kind == "dim" else msg
    print(f"{stamp} {_c(code, tag)} {text}", flush=True)


# ----------------------------------------------------------------- file helpers
def read_text(p: Path) -> str:
    try:
        return p.read_bytes().decode("utf-8-sig").replace("\r\n", "\n")
    except UnicodeDecodeError:
        raise ApiError(400, f"{p.name} is not valid UTF-8.")


def write_text(p: Path, text: str):
    tmp = p.with_name(p.name + ".studio-tmp")
    tmp.write_bytes(text.replace("\r\n", "\n").encode("utf-8"))
    os.replace(tmp, p)  # atomic: never leaves a half-written file


def has_js(p: Path) -> bool:
    try:
        return any(f.suffix.lower() == ".js" and f.is_file() for f in p.iterdir())
    except OSError:
        return False


def is_bot_dir(p: Path) -> bool:
    """A chatbot = folder with index.html AND at least one .js file directly inside it."""
    return (p.is_dir() and not p.name.startswith((".", "_"))
            and (p / "index.html").is_file() and has_js(p))


def _segment_ok(seg) -> bool:
    return (isinstance(seg, str) and seg not in ("", ".", "..")
            and not seg.startswith((".", "_"))
            and not any(c in seg for c in '\\:\0*?"<>|'))


def safe_path(rel, max_parts=MAX_DEPTH + 1) -> Path:
    """'folder/sub/bot' (always '/'-separated) -> absolute path guaranteed to be inside ROOT."""
    parts = rel.split("/") if isinstance(rel, str) else []
    if not parts or len(parts) > max_parts or not all(_segment_ok(s) for s in parts):
        raise ApiError(400, "Invalid path.")
    p = ROOT.joinpath(*parts).resolve()
    if p == ROOT or ROOT not in p.parents:
        raise ApiError(400, "Invalid path.")
    return p


def rel_of(p: Path) -> str:
    return p.relative_to(ROOT).as_posix()


def _is_template(p: Path) -> bool:
    return rel_of(p) == TEMPLATE


def _inside_bot(p: Path) -> bool:
    cur = p.parent
    while cur != ROOT and ROOT in cur.parents:
        if is_bot_dir(cur):
            return True
        cur = cur.parent
    return False


def bot_dir(rel) -> Path:
    p = safe_path(rel)
    if not is_bot_dir(p) or _inside_bot(p):
        raise ApiError(404, f"Chatbot '{rel}' not found.")
    return p


def folder_dir(rel, allow_root=False) -> Path:
    """An organising folder (a directory that is not a chatbot). '' means the top level."""
    if allow_root and rel in ("", None):
        return ROOT
    p = safe_path(rel, MAX_DEPTH)
    if p.relative_to(ROOT).parts[0].lower() == TEMPLATE:
        raise ApiError(400, "'template' cannot be used as a folder.")
    if not p.is_dir():
        raise ApiError(404, f"Folder '{rel}' not found.")
    if is_bot_dir(p) or _inside_bot(p):
        raise ApiError(400, "That is a chatbot, not a folder.")
    return p


def check_new_name(name, parent: Path = ROOT):
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise ApiError(400, "Use 1-64 letters, digits, '-' or '_' (start with a letter or digit).")
    if name.lower() == TEMPLATE:
        raise ApiError(400, "'template' is reserved.")
    if any(c.name.lower() == name.lower() for c in parent.iterdir()):
        raise ApiError(409, f"'{name}' already exists in this location.")


def find_config_file(d: Path) -> str:
    """Which .js file does index.html load as the config? (default: config_data.js)"""
    names = []
    idx = d / "index.html"
    if idx.is_file():
        try:
            html = read_text(idx)
        except ApiError:
            html = ""
        for src in SCRIPT_SRC.findall(html):
            if re.match(r"^(?:[a-z][a-z0-9+.-]*:|//)", src, re.I):
                continue  # external script
            src = re.split(r"[?#]", src)[0]
            if src.startswith("./"):
                src = src[2:]
            if "/" in src or "\\" in src or not src.lower().endswith(".js"):
                continue
            if (d / src).is_file():
                names.append(src)
    for n in names:
        try:
            if CONFIG_HINT.search(read_text(d / n)):
                return n
        except Exception:
            pass
    return "config_data.js"


# ----------------------------------------------------------------- API actions
SKIP_DIRS = {"node_modules", "__pycache__"}


def _is_empty(p: Path) -> bool:
    try:
        return not any(not c.name.startswith(".") for c in p.iterdir())
    except OSError:
        return False


def _scan(d: Path, level: int) -> dict:
    folders, bots = [], []
    try:
        entries = sorted(d.iterdir(), key=lambda x: x.name.lower())
    except OSError:
        entries = []
    for p in entries:
        if p.name.startswith((".", "_")) or p.name.lower() in SKIP_DIRS or not p.is_dir():
            continue
        if d == ROOT and p.name.lower() == TEMPLATE:
            continue
        rel = rel_of(p)
        if is_bot_dir(p):
            bots.append({"path": rel, "name": p.name, "configFile": find_config_file(p)})
        elif level <= MAX_DEPTH:
            node = _scan(p, level + 1)
            # keep a folder only if it leads to chatbots, or if it is completely empty
            # (so a folder you just created doesn't vanish before you put a bot in it)
            if node["bots"] or node["folders"] or _is_empty(p):
                node.update(path=rel, name=p.name)
                folders.append(node)
    return {"folders": folders, "bots": bots}


def list_bots():
    return {"tree": _scan(ROOT, 1), "maxDepth": MAX_DEPTH,
            "hasTemplate": is_bot_dir(ROOT / TEMPLATE), "root": str(ROOT)}


def get_bot(name):
    d = bot_dir(name)
    cfg = find_config_file(d)
    if not (d / cfg).is_file():
        raise ApiError(404, f"Config file '{cfg}' not found in '{name}'.")
    css = read_text(d / CSS_FILE) if (d / CSS_FILE).is_file() else ""
    return {"name": d.name, "path": rel_of(d), "isTemplate": _is_template(d), "configFile": cfg,
            "config": read_text(d / cfg), "css": css}


def save_bot(name, body):
    d = bot_dir(name)
    config, css = body.get("config"), body.get("css")
    if not isinstance(config, str) or not isinstance(css, str):
        raise ApiError(400, "config and css must be strings.")
    cfg = find_config_file(d)
    write_text(d / cfg, config)
    write_text(d / CSS_FILE, css)
    say(f"Saved '{rel_of(d)}'  ({cfg}, {CSS_FILE})", "ok")
    return {"ok": True, "savedAt": time.time()}


def _copy_template(src: Path, new_name: str, parent: Path):
    check_new_name(new_name, parent)
    dest = parent / new_name
    shutil.copytree(src, dest, ignore=shutil.ignore_patterns(".git", "__pycache__", "*.studio-tmp"))
    say(f"Created '{rel_of(dest)}' from '{rel_of(src)}'", "ok")
    return {"path": rel_of(dest)}


def create_bot(body):
    src = ROOT / TEMPLATE
    if not is_bot_dir(src):
        raise ApiError(400, "The 'template' folder (with index.html) is missing.")
    parent = folder_dir(body.get("folder"), allow_root=True)
    return _copy_template(src, body.get("name"), parent)


def duplicate_bot(name, body):
    d = bot_dir(name)
    return _copy_template(d, body.get("newName"), d.parent)   # copy lands next to the original


def rename_bot(name, body):
    d = bot_dir(name)
    if _is_template(d):
        raise ApiError(400, "The template folder cannot be renamed.")
    new = body.get("newName")
    check_new_name(new, d.parent)
    target = d.parent / new
    try:
        os.rename(d, target)
    except OSError as e:
        raise ApiError(409, f"Could not rename (is something using the folder?): {e}")
    say(f"Renamed '{d.name}' -> '{new}'", "ok")
    return {"path": rel_of(target)}


def move_bot(name, body):
    d = bot_dir(name)
    if _is_template(d):
        raise ApiError(400, "The template cannot be moved.")
    dest = folder_dir(body.get("folder"), allow_root=True)
    if dest == d.parent:
        return {"path": rel_of(d)}
    if any(c.name.lower() == d.name.lower() for c in dest.iterdir()):
        raise ApiError(409, f"'{d.name}' already exists in the destination folder.")
    target = dest / d.name
    try:
        shutil.move(str(d), str(target))
    except OSError as e:
        raise ApiError(409, f"Could not move (is something using the folder?): {e}")
    say(f"Moved '{d.name}' -> '{rel_of(target)}'", "ok")
    return {"path": rel_of(target)}


def create_folder(body):
    parent = folder_dir(body.get("parent"), allow_root=True)
    if parent != ROOT and len(parent.relative_to(ROOT).parts) >= MAX_DEPTH:
        raise ApiError(400, f"Folders can be nested at most {MAX_DEPTH} levels deep.")
    name = body.get("name")
    check_new_name(name, parent)
    (parent / name).mkdir()
    say(f"Created folder '{rel_of(parent / name)}'", "ok")
    return {"path": rel_of(parent / name)}


def delete_folder(body):
    d = folder_dir(body.get("path"))
    trash = ROOT / "_trash"
    trash.mkdir(exist_ok=True)
    target = trash / f"{d.name}_{datetime.now():%Y%m%d-%H%M%S}"
    shutil.move(str(d), str(target))
    say(f"Moved folder '{d.name}' to _trash/{target.name}", "warn")
    return {"ok": True}


def rename_config(name, body):
    d = bot_dir(name)
    new = body.get("newFile")
    if not isinstance(new, str) or not JS_FILE_RE.match(new):
        raise ApiError(400, "File name must end with .js and use only letters, digits, '.', '-', '_'.")
    old = find_config_file(d)
    if new == old:
        return {"configFile": old}
    if not (d / old).is_file():
        raise ApiError(404, f"'{old}' does not exist.")
    if (d / new).exists():
        raise ApiError(409, f"'{new}' already exists.")
    html = read_text(d / "index.html")
    pattern = re.compile(r"""(<script\b[^>]*?\bsrc\s*=\s*["'](?:\./)?)""" + re.escape(old)
                         + r"""(?=[?#"'])""", re.I)
    new_html, count = pattern.subn(lambda m: m.group(1) + new, html)
    if count == 0:
        raise ApiError(400, f"Could not find <script src=\"{old}\"> in index.html - nothing was changed.")
    (d / old).rename(d / new)
    write_text(d / "index.html", new_html)
    say(f"'{d.name}': config file '{old}' -> '{new}' (index.html updated)", "ok")
    return {"configFile": new}


def delete_bot(name, body):
    d = bot_dir(name)
    if d.name == TEMPLATE:
        raise ApiError(400, "The template cannot be deleted.")
    trash = ROOT / "_trash"
    trash.mkdir(exist_ok=True)
    target = trash / f"{d.name}_{datetime.now():%Y%m%d-%H%M%S}"
    shutil.move(str(d), str(target))
    say(f"Moved '{d.name}' to _trash/{target.name}", "warn")
    return {"ok": True}


def shutdown(_body):
    say("Stop requested from the browser.")
    threading.Thread(target=STATE["httpd"].shutdown, daemon=True).start()
    return {"ok": True}


def route(method, path, body):
    parts = [unquote(p) for p in path.split("/")[2:]]  # drop '' and 'api'
    if method == "GET":
        if parts == ["bots"]:
            return list_bots()
        if len(parts) == 2 and parts[0] == "bot":
            return get_bot(parts[1])
    else:
        if parts == ["create"]:
            return create_bot(body)
        if parts == ["shutdown"]:
            return shutdown(body)
        if len(parts) == 2 and parts[0] == "folder":
            fn = {"create": create_folder, "delete": delete_folder}.get(parts[1])
            if fn:
                return fn(body)
        if len(parts) == 3 and parts[0] == "bot":
            fn = {"save": save_bot, "rename": rename_bot, "rename-config": rename_config,
                  "duplicate": duplicate_bot, "move": move_bot, "delete": delete_bot}.get(parts[2])
            if fn:
                return fn(parts[1], body)
    raise ApiError(404, "Unknown API route.")


# ----------------------------------------------------------------- HTTP layer
class Handler(BaseHTTPRequestHandler):
    server_version = "BotStudio/1.0"

    # --- logging: one short line per request (preview assets only with --verbose)
    def log_request(self, code="-", size="-"):
        try:
            status = int(code)
        except (TypeError, ValueError):
            status = 0
        path = unquote(urlparse(self.path).path)
        asset = path.startswith("/bots/") and not (path.endswith("/") or path.lower().endswith(".html"))
        if asset and status < 400 and not VERBOSE:
            return
        kind = "error" if status >= 500 else "warn" if status >= 400 else "dim"
        say(f"{self.command:<4} {path}  ->  {status}", kind)

    def log_message(self, fmt, *args):  # used by log_error (malformed requests etc.)
        try:
            say(f"{self.address_string()}: {fmt % args}", "warn")
        except Exception:
            pass

    def _send(self, status, body: bytes, ctype, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status, obj):
        self._send(status, json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8")

    # --- request checks
    def _allowed_hosts(self):
        p = STATE["port"]
        return (f"127.0.0.1:{p}", f"localhost:{p}")

    def _host_ok(self):
        return (self.headers.get("Host") or "").lower() in self._allowed_hosts()

    def _origin_ok(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True
        return origin.lower() in tuple("http://" + h for h in self._allowed_hosts())

    def _token_ok(self):
        sent = (self.headers.get("X-Studio-Token") or "").encode("utf-8")
        return secrets.compare_digest(sent, TOKEN.encode("utf-8"))

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def _dispatch(self, method):
        try:
            if not self._host_ok() or not self._origin_ok():
                raise ApiError(403, "Forbidden host/origin.")
            path = urlparse(self.path).path
            if method == "GET" and path in ("/", "/index.html"):
                return self._serve_ui()
            if method == "GET" and path.startswith("/bots/"):
                return self._serve_bot_file(path)
            if path.startswith("/api/"):
                if not self._token_ok():
                    raise ApiError(403, "Bad token - reload the Studio page.")
                body = {}
                if method == "POST":
                    n = int(self.headers.get("Content-Length") or 0)
                    if n > MAX_BODY:
                        raise ApiError(413, "Request too large.")
                    if n:
                        body = json.loads(self.rfile.read(n).decode("utf-8"))
                    if not isinstance(body, dict):
                        raise ApiError(400, "Expected a JSON object.")
                return self._json(200, route(method, path, body))
            raise ApiError(404, "Not found.")
        except ApiError as e:
            if e.status >= 400 and self.path.startswith("/api/"):
                say(f"{e.message}", "warn")
            self._json(e.status, {"error": e.message})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except json.JSONDecodeError:
            self._json(400, {"error": "Invalid JSON."})
        except Exception:
            say("Unhandled error:\n" + traceback.format_exc().rstrip(), "error")
            self._json(500, {"error": "Internal error (see the server console)."})

    def _serve_ui(self):
        if not UI_FILE.is_file():
            raise ApiError(500, "botstudio.html is missing next to botstudio.py.")
        html = UI_FILE.read_text(encoding="utf-8").replace("__STUDIO_TOKEN__", TOKEN)
        self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")

    def _serve_bot_file(self, path):
        parts = unquote(path[len("/bots/"):]).split("/")
        cur, d, idx = ROOT, None, 0
        for i, seg in enumerate(parts[:MAX_DEPTH + 1]):
            if not _segment_ok(seg):
                raise ApiError(404, "File not found.")
            cur = cur / seg
            if not cur.is_dir():
                raise ApiError(404, "File not found.")
            if is_bot_dir(cur):
                d, idx = cur, i + 1
                break
        if d is None:
            raise ApiError(404, "Chatbot not found.")
        d = d.resolve()
        if ROOT not in d.parents:
            raise ApiError(404, "File not found.")
        if idx == len(parts):  # /bots/foo -> /bots/foo/
            self.send_response(302)
            self.send_header("Location", "/bots/" + "/".join(quote(p) for p in parts) + "/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        sub = "/".join(parts[idx:])
        if sub == "" or sub.endswith("/"):
            sub += "index.html"
        try:
            f = (d / sub).resolve()
            f.relative_to(d)  # path-traversal guard
        except (ValueError, OSError):
            raise ApiError(404, "File not found.")
        if not f.is_file():
            raise ApiError(404, "File not found.")
        ctype = MIME.get(f.suffix.lower()) or mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        self._send(200, f.read_bytes(), ctype)


class Server(ThreadingHTTPServer):
    daemon_threads = True          # open connections never block shutdown
    allow_reuse_address = False    # on Windows this would allow two servers on one port

    def handle_error(self, request, client_address):
        say("Connection error: " + traceback.format_exc().strip().splitlines()[-1], "warn")


def main():
    global VERBOSE
    ap = argparse.ArgumentParser(description="Bot Studio local server")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"first port to try (default {DEFAULT_PORT})")
    ap.add_argument("--no-browser", action="store_true", help="do not open the browser automatically")
    ap.add_argument("-v", "--verbose", action="store_true", help="also log every preview file request")
    args = ap.parse_args()
    VERBOSE = args.verbose
    setup_console()

    httpd = None
    for port in range(args.port, args.port + 20):
        try:
            httpd = Server((HOST, port), Handler)
            STATE["port"] = port
            break
        except OSError:
            continue
    if httpd is None:
        say(f"No free port found between {args.port} and {args.port + 19}.", "error")
        return 1
    STATE["httpd"] = httpd

    url = f"http://127.0.0.1:{STATE['port']}/"
    print()
    print(_c("1", "  Bot Studio"))
    print(f"  Folder : {ROOT}")
    print(f"  Open   : {_c('36', url)}")
    print(f"  Stop   : {_c('33', 'Ctrl+C')} here, close this window, or use the Stop button in the browser")
    print()
    if not (ROOT / TEMPLATE / "index.html").is_file():
        say("No 'template' folder with an index.html next to this script - 'New chatbot' will not work.", "warn")
    if not UI_FILE.is_file():
        say("botstudio.html is missing next to this script.", "error")

    if not args.no_browser:
        t = threading.Timer(0.5, lambda: webbrowser.open(url))
        t.daemon = True
        t.start()
    say("Server running. Waiting for requests...")

    try:
        httpd.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print()
        say("Ctrl+C received - shutting down...")
    finally:
        httpd.server_close()
    say("Server stopped. Bye!", "ok")
    return 0


if __name__ == "__main__":
    code = 0
    try:
        code = main()
    except Exception:
        say("Fatal error:\n" + traceback.format_exc().rstrip(), "error")
        code = 1
    if code and sys.stdin is not None and sys.stdin.isatty():
        try:  # keep the window open so the error message can be read
            input("\nPress Enter to close this window...")
        except (EOFError, KeyboardInterrupt):
            pass
    sys.exit(code)