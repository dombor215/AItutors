#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EduBotStack Launcher  (edubotstack.pyw)
---------------------------------------
Small local web page that lists the apps in the EduBotStack and can start them.

 - Runs without a console window (.pyw), so it has its OWN Shutdown button.
 - Binds to 127.0.0.1 only (not reachable from the network).
 - Uses only the Python standard library.
"""

import hmac
import html
import json
import os
import secrets
import shlex
import shutil
import subprocess
import sys
import threading
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
HOST = "127.0.0.1"
PREFERRED_PORT = 8750          # falls back to a random free port if busy
TOKEN = secrets.token_urlsafe(24)   # protects POST actions from other websites

APPS = [
    {
        "id": "botstudio",
        "name": "Bot Studio",
        "icon": "🎓",
        "script": "botstudio.py",
        "description": "Design your own chatbot tutors and teaching assistants: "
                       "set their role, behaviour and knowledge, and try them out.",
    },
    {
        "id": "bothub",
        "name": "Bot Hub",
        "icon": "🌐",
        "script": "bothub.py",
        "description": "Build web pages in the form of Hub(s) where your bots are "
                       "listed, so students can find and open them in one place.",
    },
]
APP_BY_ID = {a["id"]: a for a in APPS}
PROCS = {}   # app id -> subprocess.Popen


# ----------------------------------------------------------------- launching
def console_python():
    """Return a python interpreter that has a console (python.exe, not pythonw.exe)."""
    exe = sys.executable
    if os.path.basename(exe).lower() == "pythonw.exe":
        cand = os.path.join(os.path.dirname(exe), "python.exe")
        if os.path.exists(cand):
            return cand
        return shutil.which("python") or exe
    return exe


def is_running(app_id):
    p = PROCS.get(app_id)
    return p is not None and p.poll() is None


def launch(app_id):
    app = APP_BY_ID[app_id]
    script = os.path.join(BASE_DIR, app["script"])
    if not os.path.isfile(script):
        return False, f"{app['script']} was not found next to edubotstack.pyw."
    if is_running(app_id):
        return True, f"{app['name']} is already running (see its console window)."

    py = console_python()
    try:
        if os.name == "nt":
            PROCS[app_id] = subprocess.Popen(
                [py, script], cwd=BASE_DIR,
                creationflags=subprocess.CREATE_NEW_CONSOLE)
        elif sys.platform == "darwin":
            cmd = f"cd {shlex.quote(BASE_DIR)} && {shlex.quote(py)} {shlex.quote(script)}"
            osa = f'tell application "Terminal" to do script "{cmd.replace(chr(34), chr(92) + chr(34))}"'
            subprocess.Popen(["osascript", "-e", osa,
                              "-e", 'tell application "Terminal" to activate'])
        else:
            terms = [["x-terminal-emulator", "-e"], ["gnome-terminal", "--"],
                     ["konsole", "-e"], ["xterm", "-e"]]
            for t in terms:
                if shutil.which(t[0]):
                    PROCS[app_id] = subprocess.Popen(t + [py, script], cwd=BASE_DIR)
                    break
            else:
                PROCS[app_id] = subprocess.Popen([py, script], cwd=BASE_DIR)
    except Exception as exc:  # noqa
        return False, f"Could not start {app['name']}: {exc}"
    return True, f"{app['name']} is starting in a console window…"


# ---------------------------------------------------------------------- page
def render_cards():
    out = []
    for a in APPS:
        exists = os.path.isfile(os.path.join(BASE_DIR, a["script"]))
        out.append(f"""
        <article class="card" data-app="{a['id']}">
          <div class="icon">{a['icon']}</div>
          <h2>{html.escape(a['name'])}</h2>
          <p>{html.escape(a['description'])}</p>
          <p class="file"><code>{html.escape(a['script'])}</code>
             <span class="badge" id="badge-{a['id']}">{'stopped' if exists else 'file missing'}</span></p>
          <button class="btn" onclick="launchApp('{a['id']}')" {'' if exists else 'disabled'}>
            ▶ Launch {html.escape(a['name'])}</button>
        </article>""")
    return "\n".join(out)


PAGE = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EduBotStack</title>
<style>
 :root{--bg:#f4f6fb;--card:#fff;--ink:#1d2433;--muted:#5b667a;--accent:#3b6cf6;--warn:#fff7e0;--warnb:#f0c14b;--danger:#d64545}
 *{box-sizing:border-box}
 body{margin:0;font-family:system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink);line-height:1.5}
 header{background:linear-gradient(135deg,#3b6cf6,#7a4cf0);color:#fff;padding:28px 20px;text-align:center}
 header h1{margin:0;font-size:2rem} header p{margin:6px 0 0;opacity:.9}
 main{max-width:980px;margin:0 auto;padding:24px 16px 60px}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px}
 .card{background:var(--card);border-radius:14px;padding:22px;box-shadow:0 2px 10px rgba(20,30,60,.08)}
 .card .icon{font-size:2.2rem} .card h2{margin:.2rem 0 .4rem}
 .file{color:var(--muted);font-size:.9rem}
 code{background:#eef1f8;padding:1px 6px;border-radius:5px;font-size:.9em}
 pre{background:#1d2433;color:#e8ecf5;padding:14px;border-radius:10px;overflow:auto;font-size:.88rem}
 pre code{background:none;color:inherit;padding:0}
 .badge{margin-left:8px;padding:2px 9px;border-radius:99px;font-size:.75rem;background:#e6e9f2;color:var(--muted)}
 .badge.on{background:#dff5e3;color:#1c7a34}
 .btn{margin-top:8px;border:0;background:var(--accent);color:#fff;padding:10px 16px;border-radius:9px;font-size:1rem;cursor:pointer}
 .btn:hover{filter:brightness(1.08)} .btn:disabled{background:#b9c0d0;cursor:not-allowed}
 .btn.danger{background:var(--danger)}
 section.box{background:var(--card);border-radius:14px;padding:20px 24px;margin-top:22px;box-shadow:0 2px 10px rgba(20,30,60,.08)}
 section.warn{background:var(--warn);border:1px solid var(--warnb)}
 h3{margin-top:0} li{margin:4px 0}
 #toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:#1d2433;color:#fff;padding:10px 18px;border-radius:9px;display:none;max-width:90%}
 footer{text-align:center;margin-top:26px}
</style></head><body>
<header><h1>🤖 EduBotStack</h1><p>Tools for building AI chatbot tutors and teaching assistants</p></header>
<main>
  <div class="grid">__CARDS__</div>

  <section class="box warn">
    <h3>⚠️ Please read: local servers &amp; clean shutdown</h3>
    <p>Each app runs as a <b>local Python server in console mode</b> and opens in your web browser.
       Closing the browser tab does <b>not</b> stop the server. To avoid leftover background processes, always stop an app by either:</p>
    <ul>
      <li>clicking the <b>Shutdown</b> button inside the app's web page, <b>or</b></li>
      <li>switching to its console window and pressing <kbd>Ctrl</kbd>+<kbd>C</kbd>.</li>
    </ul>
    <p>This launcher page also runs as a small local server <i>without</i> a console window (it is a <code>.pyw</code> file),
       so stop it with the <b>Shutdown launcher</b> button below. If something is ever stuck, end the leftover
       <code>python</code>/<code>pythonw</code> process in Task Manager (Windows) or Activity Monitor (macOS).</p>
  </section>

  <section class="box">
    <h3>🚀 Publish your AI Bot Hub with GitHub Pages</h3>
    <ol>
      <li>Create a new repository on <a href="https://github.com/new" target="_blank" rel="noopener">github.com</a>
          (public, unless your plan supports Pages for private repos).</li>
      <li>Put the whole <code>EduBotStack</code> folder content into it, including your exported Hub
          (an <code>index.html</code> in the repository root is the start page):
<pre><code>cd EduBotStack
git init
git add .
git commit -m "My EduBotStack"
git branch -M main
git remote add origin https://github.com/YOUR-USER/YOUR-REPO.git
git push -u origin main</code></pre></li>
      <li>On GitHub open <b>Settings → Pages</b>, under <i>Build and deployment</i> choose
          <b>Deploy from a branch</b>, select <code>main</code> and <code>/ (root)</code>, then <b>Save</b>.</li>
      <li>After a minute your Hub is live at
          <code>https://YOUR-USER.github.io/YOUR-REPO/</code>.</li>
    </ol>
    <p class="file">Notes: GitHub Pages hosts static files only. The Python apps (Bot Studio, Bot Hub) keep running
       locally, and only the generated web pages are published. Everything in a public repository is visible to
       everyone, so never commit passwords or private API keys.</p>
  </section>

  <footer><button class="btn danger" onclick="shutdownLauncher()">⏻ Shutdown launcher</button></footer>
</main>
<div id="toast"></div>
<script>
const TOKEN = "__TOKEN__";
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.style.display='block';
  clearTimeout(window._tt);window._tt=setTimeout(()=>t.style.display='none',4500);}
async function post(url){
  const r = await fetch(url,{method:'POST',headers:{'X-Token':TOKEN}});
  return r.json();
}
async function launchApp(id){
  try{const j=await post('/api/launch?app='+encodeURIComponent(id));toast(j.message);refresh();}
  catch(e){toast('Launcher is not reachable.');}
}
async function refresh(){
  try{
    const r=await fetch('/api/status',{cache:'no-store'});const s=await r.json();
    for(const id in s){
      const b=document.getElementById('badge-'+id);if(!b)continue;
      if(!s[id].exists){b.textContent='file missing';b.className='badge';}
      else if(s[id].running){b.textContent='running';b.className='badge on';}
      else{b.textContent='stopped';b.className='badge';}
    }
  }catch(e){}
}
async function shutdownLauncher(){
  if(!confirm('Shut down the EduBotStack launcher?\\n(Apps you started keep running in their own consoles.)'))return;
  try{await post('/api/shutdown');}catch(e){}
  document.body.innerHTML='<div style="text-align:center;padding:80px 20px;font-family:system-ui">'+
    '<h1>✅ Launcher stopped</h1><p>You can close this tab now.</p></div>';
}
setInterval(refresh,3000);refresh();
</script></body></html>
"""


# -------------------------------------------------------------------- server
class Handler(BaseHTTPRequestHandler):
    server_version = "EduBotStack"

    def log_message(self, *args):   # pythonw has no stderr -> stay silent
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj))

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            page = PAGE.replace("__CARDS__", render_cards()).replace("__TOKEN__", TOKEN)
            self._send(200, page, "text/html; charset=utf-8")
        elif path == "/api/status":
            self._json({a["id"]: {
                "exists": os.path.isfile(os.path.join(BASE_DIR, a["script"])),
                "running": is_running(a["id"])} for a in APPS})
        elif path == "/api/ping":
            self._send(200, "edubotstack-launcher", "text/plain")
        else:
            self._send(404, "Not found", "text/plain")

    def do_POST(self):
        if not hmac.compare_digest(self.headers.get("X-Token", ""), TOKEN):
            return self._json({"ok": False, "message": "Forbidden"}, 403)
        path, _, query = self.path.partition("?")
        if path == "/api/launch":
            app_id = dict(p.split("=", 1) for p in query.split("&") if "=" in p).get("app", "")
            if app_id not in APP_BY_ID:
                return self._json({"ok": False, "message": "Unknown app."}, 400)
            ok, msg = launch(app_id)
            self._json({"ok": ok, "message": msg})
        elif path == "/api/shutdown":
            self._json({"ok": True, "message": "Shutting down…"})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
        else:
            self._json({"ok": False, "message": "Not found"}, 404)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False   # so a second instance really fails on a busy port


def launcher_already_running(port):
    try:
        with urllib.request.urlopen(f"http://{HOST}:{port}/api/ping", timeout=1) as r:
            return r.read().decode().strip() == "edubotstack-launcher"
    except Exception:
        return False


def main():
    server = None
    for port in (PREFERRED_PORT, 0):
        try:
            server = Server((HOST, port), Handler)
            break
        except OSError:
            if port and launcher_already_running(port):
                # Don't start a second hidden process – just show the existing page.
                webbrowser.open(f"http://{HOST}:{port}/")
                return
    if server is None:
        return

    url = f"http://{HOST}:{server.server_address[1]}/"
    threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()