#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Bot Hub Builder - small local web app (standard library only).

    python bothub.py [--port 8765] [--no-browser] [-v]

Put bothub.py + bothub.html into the root folder of your bot hub (next to index.html).
Other *.html / *.py files in the root are ignored. Stop the server with Ctrl+C
or with the "Shut down" button in the UI.
"""
import argparse, html, json, mimetypes, os, re, secrets, shutil, sys, threading, traceback, webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlparse, parse_qs

VERSION = '1.0'
ROOT = Path(__file__).resolve().parent
UI_FILE = ROOT / 'bothub.html'
BACKUP_DIR = '.bothub_backups'          # dot-folder => ignored by scanner and web server
KEEP_BACKUPS = 15                       # per hub
IGNORE_DIRS = {'__pycache__', 'node_modules', 'venv', 'env', 'site-packages'}   # edit if needed
MAX_BODY = 8 * 1024 * 1024
MAX_DEPTH = 8
STATE = {'token': '', 'port': 0, 'verbose': False}

try:
    sys.stdout.reconfigure(errors='replace')
except Exception:
    pass


def log(tag, msg):
    print(f'[{datetime.now():%H:%M:%S}] {tag:<6} {msg}', flush=True)


class ApiError(Exception):
    def __init__(self, msg, code=400):
        super().__init__(msg)
        self.code = code


# ----------------------------------------------------------------------------------------
#  Colours / palette
# ----------------------------------------------------------------------------------------
DEFAULT_PALETTE = {'bg': '#f7f9fc', 'bg2': '#eef4ff', 'card': '#ffffff', 'accent': '#0f62fe',
                   'accent2': '#5aa8ff', 'text': '#0b1220', 'muted': '#586069'}
HEX_RE = re.compile(r'^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$')


def norm_hex(v):
    v = v.strip().lower()
    if len(v) == 4:
        v = '#' + ''.join(c * 2 for c in v[1:])
    return v


def rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t):
    """t = share of colour a, (1-t) of colour b"""
    return '#%02x%02x%02x' % tuple(round(x * t + y * (1 - t)) for x, y in zip(rgb(a), rgb(b)))


def rgba(h, alpha):
    r, g, b = rgb(h)
    return f'rgba({r},{g},{b},{alpha})'


def luminance(h):
    def ch(c):
        c /= 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = rgb(h)
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def css_vars(p):
    card, acc = p['card'], p['accent']
    v = dict(p)
    v.update({
        'tint1': mix(acc, card, .16), 'tint2': mix(acc, card, .07),
        'tint1h': mix(acc, card, .26), 'tint2h': mix(acc, card, .15),
        'border': rgba(acc, .22), 'shadow': 'rgba(10,15,30,.10)',
        'on-accent': '#ffffff' if luminance(acc) < .4 else '#0b1220',
    })
    return ';'.join(f'--{k}:{val}' for k, val in v.items())


# ----------------------------------------------------------------------------------------
#  Templates (all share the same markup => switching template never loses content)
# ----------------------------------------------------------------------------------------
BASE_CSS = '''
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  background:linear-gradient(180deg,var(--bg) 0%,var(--bg2) 100%);background-attachment:fixed;color:var(--text);min-height:100vh}
.logo{flex:none;width:56px;height:56px;background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:10px;
  display:flex;align-items:center;justify-content:center;color:var(--on-accent);font-weight:700;font-size:18px;box-shadow:0 6px 18px var(--border)}
h1{margin:0;font-size:1.25rem;letter-spacing:.2px}
p.lead{margin:.625rem 0 1rem;color:var(--muted);font-size:.98rem}
.info{margin:.5rem 0 1rem;font-size:.95rem;line-height:1.55}
.info p{margin:.5rem 0}.info ul{margin:.5rem 0;padding-left:1.25rem}.info li{margin:.25rem 0}
.info a{color:var(--accent)}
nav ul{list-style:none;padding:0;margin:0}
nav a{display:block;text-decoration:none;color:var(--accent);font-weight:600;
  transition:transform .12s ease,box-shadow .12s ease,background .12s ease}
nav .row{display:flex;align-items:center;justify-content:space-between;gap:.75rem}
nav .meta{color:var(--muted);font-weight:500;font-size:.9rem}
nav .desc{display:block;font-size:.8rem;font-style:italic;font-weight:400;color:var(--muted);line-height:1.45;margin-top:.25rem}
nav .desc strong{color:var(--text)}
footer{margin-top:1rem;font-size:.85rem;color:var(--muted);text-align:right}
'''

TEMPLATES = {
    'classic': {'label': 'Classic list', 'desc': 'Centered card with a vertical list of buttons (your original look).', 'css': '''
body{display:flex;align-items:center;justify-content:center;padding:2rem}
.container{width:100%;max-width:760px;background:var(--card);border-radius:12px;box-shadow:0 8px 30px var(--shadow);padding:1.25rem 1.5rem}
header{display:flex;align-items:center;gap:.75rem;margin-bottom:.5rem}
nav ul{display:grid;gap:.5rem}
nav a{padding:.65rem .9rem;background:linear-gradient(180deg,var(--tint1),var(--tint2));border:1px solid var(--border);border-radius:8px}
nav a:hover{transform:translateY(-3px);background:linear-gradient(180deg,var(--tint1h),var(--tint2h));box-shadow:0 8px 20px var(--border)}
@media(max-width:420px){body{padding:1rem}.container{padding:1rem}.logo{width:48px;height:48px;font-size:16px}h1{font-size:1.1rem}}
'''},
    'grid': {'label': 'Card grid', 'desc': 'Centered header and a responsive grid of cards.', 'css': '''
body{padding:2.5rem 1rem}
.container{max-width:1040px;margin:0 auto}
header{display:flex;flex-direction:column;align-items:center;text-align:center;gap:.75rem;margin-bottom:1rem}
.logo{width:72px;height:72px;font-size:22px;border-radius:18px}
h1{font-size:1.9rem}
p.lead{margin:.4rem 0 0}
.info{max-width:720px;margin:1rem auto 1.5rem;text-align:center}
nav ul{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1rem}
nav li{display:flex}
nav a{flex:1;display:flex;flex-direction:column;padding:1.1rem 1.2rem;background:var(--card);border:1px solid var(--border);
  border-top:4px solid var(--accent);border-radius:14px;box-shadow:0 4px 14px var(--shadow)}
nav a:hover{transform:translateY(-4px);box-shadow:0 12px 28px var(--border)}
nav .row{flex-direction:column;align-items:flex-start;gap:.15rem}
nav .title{font-size:1.1rem}
nav .desc{margin-top:.6rem}
footer{text-align:center}
'''},
    'minimal': {'label': 'Minimal', 'desc': 'Plain, text-first list with thin dividers. No card.', 'css': '''
.container{max-width:680px;margin:0 auto;padding:3rem 1.25rem}
header{display:flex;align-items:center;gap:1rem;padding-bottom:1rem;border-bottom:2px solid var(--accent);margin-bottom:1rem}
.logo{width:44px;height:44px;border-radius:50%;font-size:14px;box-shadow:none}
h1{font-size:1.5rem}
p.lead{margin:.2rem 0 0;font-size:.95rem}
nav a{padding:.9rem .25rem;border-radius:6px;transition:padding .12s ease,background .12s ease}
nav li{border-bottom:1px solid var(--border)}
nav a:hover{background:var(--tint2);padding-left:.75rem}
nav .title{font-size:1.05rem}
'''},
    'hero': {'label': 'Hero banner', 'desc': 'Big gradient banner on top, wide cards with an accent bar.', 'css': '''
body{padding:0}
.container{max-width:960px;margin:0 auto;padding:0 1rem 3rem}
header{display:flex;align-items:center;gap:1rem;margin:0 -1rem 1.5rem;padding:2.5rem 2rem;
  background:linear-gradient(135deg,var(--accent),var(--accent2));color:var(--on-accent);
  border-radius:0 0 28px 28px;box-shadow:0 12px 30px var(--border)}
.logo{background:rgba(255,255,255,.2);color:inherit;width:72px;height:72px;font-size:24px;box-shadow:none;border:2px solid rgba(255,255,255,.5)}
h1{font-size:2rem}
p.lead{color:inherit;opacity:.9;margin:.4rem 0 0}
.info{background:var(--card);border-left:4px solid var(--accent);padding:.5rem 1.25rem;border-radius:8px;box-shadow:0 2px 10px var(--shadow)}
nav ul{display:grid;gap:.9rem}
nav a{padding:1rem 1.25rem;background:var(--card);border-radius:12px;border:1px solid var(--border);border-left:6px solid var(--accent);box-shadow:0 3px 12px var(--shadow)}
nav a:hover{transform:translateX(6px);box-shadow:0 10px 24px var(--border)}
@media(max-width:520px){header{flex-direction:column;text-align:center;padding:1.5rem 1rem}}
'''},
}

EDIT_CSS = '''
.bh-off{opacity:.45;outline:2px dashed #888;outline-offset:3px;border-radius:8px}
.bh-missing{outline-color:#d33}
li.bh-sel,.bh-sel{outline:3px solid #f59e0b !important;outline-offset:3px;border-radius:8px}
[data-f]{cursor:text}
[data-f]:hover{outline:1px dashed rgba(60,60,60,.45);outline-offset:2px}
[data-f]:focus{outline:2px solid #3b82f6;outline-offset:2px}
[data-f]:empty:before{content:attr(data-ph);opacity:.45;font-style:italic}
'''

EDIT_JS = '''
(function(){
var P=function(m){m.bothub=1;parent.postMessage(m,'*')};
var li=function(el){return el.closest('li[data-i]')};
document.addEventListener('click',function(e){
  var a=e.target.closest('a'); if(a) e.preventDefault();
  var l=li(e.target); if(l) P({type:'select',i:+l.dataset.i});
},true);
var multi={desc:1,lead:1,info:1,footer:1};
document.querySelectorAll('[data-f]').forEach(function(el){
  el.setAttribute('contenteditable','true'); el.spellcheck=false;
  el.addEventListener('input',function(){var l=li(el);P({type:'edit',f:el.dataset.f,i:l?+l.dataset.i:null,html:el.innerHTML})});
  el.addEventListener('keydown',function(e){
    e.stopPropagation();
    if(e.key==='Enter'){e.preventDefault(); if(multi[el.dataset.f]) document.execCommand('insertLineBreak');}
  });
  el.addEventListener('keyup',function(e){e.stopPropagation()});
  el.addEventListener('paste',function(e){e.preventDefault();
    var t=(e.clipboardData||window.clipboardData).getData('text/plain');document.execCommand('insertText',false,t)});
});
window.addEventListener('message',function(e){
  var d=e.data||{}; if(d.type!=='highlight') return;
  document.querySelectorAll('.bh-sel').forEach(function(x){x.classList.remove('bh-sel')});
  if(d.i==null) return;
  var l=document.querySelector('li[data-i="'+d.i+'"]');
  if(l){l.classList.add('bh-sel'); if(d.scroll) l.scrollIntoView({block:'nearest',behavior:'smooth'});}
});
})();
'''


# ----------------------------------------------------------------------------------------
#  Config model
# ----------------------------------------------------------------------------------------
RE_CFG = re.compile(r'<!--BOTHUB-CONFIG\s*(\{.*?\})\s*-->', re.S)
RE_LI = re.compile(r'(<!--\s*)?<li\b[^>]*>(.*?)</li>(\s*-->)?', re.S | re.I)
RE_FOLDER = re.compile(r'^(?:\./)?([^/:?#]+)/(?:index\.html)?$', re.I)


def prettify(name):
    s = re.sub(r'[_\-]+', ' ', name).strip()
    return s[:1].upper() + s[1:]


def initials(name):
    words = [w for w in re.split(r'[\s_\-]+', name) if w]
    if len(words) == 1:
        return words[0][:3].upper()
    return (''.join(w[0] for w in words)[:3].upper()) or 'BH'


def valid_name(n):
    return bool(n) and n not in ('.', '..') and not any(c in n for c in '/\\:') and not n.startswith('.')


def default_config(name='Bot Hub', style=None):
    cfg = {
        'version': 1, 'template': 'classic', 'palette': dict(DEFAULT_PALETTE),
        'page': {'title': name, 'lang': 'en', 'logo': initials(name), 'heading': name, 'lead': '',
                 'info': '', 'footer': '', 'show_desc': True, 'show_meta': True},
        'items': [],
    }
    if style:
        cfg['template'], cfg['palette'] = style[0], dict(style[1])
    return cfg


def clean_config(raw):
    cfg = default_config()
    if not isinstance(raw, dict):
        return cfg
    if raw.get('template') in TEMPLATES:
        cfg['template'] = raw['template']
    pal = raw.get('palette') if isinstance(raw.get('palette'), dict) else {}
    for k in DEFAULT_PALETTE:
        v = pal.get(k)
        if isinstance(v, str) and HEX_RE.match(v.strip()):
            cfg['palette'][k] = norm_hex(v)
    pg = raw.get('page') if isinstance(raw.get('page'), dict) else {}
    for k in ('title', 'logo', 'heading', 'lead', 'info', 'footer'):
        if isinstance(pg.get(k), str):
            cfg['page'][k] = pg[k]
    if isinstance(pg.get('lang'), str):
        cfg['page']['lang'] = re.sub(r'[^A-Za-z\-]', '', pg['lang'])[:12] or 'en'
    for k in ('show_desc', 'show_meta'):
        if k in pg:
            cfg['page'][k] = bool(pg[k])
    seen, items = set(), []
    for it in raw.get('items') or []:
        if not isinstance(it, dict):
            continue
        out = {}
        f, href = it.get('folder'), it.get('href')
        if isinstance(f, str) and valid_name(f):
            if f in seen:
                continue
            seen.add(f)
            out['folder'] = f
        elif isinstance(href, str) and href.strip():
            out['href'] = href.strip()
        else:
            continue
        out['title'] = str(it.get('title', ''))
        out['desc'] = str(it.get('desc', ''))
        out['meta'] = str(it.get('meta', ''))
        out['hidden'] = bool(it.get('hidden', False))
        out['newtab'] = bool(it.get('newtab', True))
        items.append(out)
    cfg['items'] = items
    return cfg


def embed_config(cfg):
    s = json.dumps(cfg, ensure_ascii=False, indent=1)
    return s.replace('<', '\\u003c').replace('>', '\\u003e').replace('--', '-\\u002d')


# ----------------------------------------------------------------------------------------
#  Parsing of an existing, hand-written index.html (import)
# ----------------------------------------------------------------------------------------
def read_text(p):
    try:
        return Path(p).read_text(encoding='utf-8', errors='replace')
    except OSError:
        return ''


def title_of(p):
    m = re.search(r'<title[^>]*>(.*?)</title>', read_text(p)[:30000], re.S | re.I)
    t = html.unescape(m.group(1).strip()) if m else ''
    return html.escape(t, quote=False)


def _span(cls, s):
    m = re.search(r'<span[^>]*class="[^"]*\b%s\b[^"]*"[^>]*>(.*?)</span>' % cls, s, re.S | re.I)
    return m.group(1).strip() if m else None


def legacy_items(text):
    nm = re.search(r'<nav\b.*?</nav>', text, re.S | re.I)
    region = nm.group(0) if nm else text
    items = []
    for m in RE_LI.finditer(region):
        inner = m.group(2)
        a = re.search(r'<a\b([^>]*)>', inner, re.I | re.S)
        hm = re.search(r'href\s*=\s*"([^"]*)"', a.group(1), re.I) if a else None
        if not hm:
            continue
        href = html.unescape(hm.group(1).strip())
        title = _span('title', inner)
        if title is None:
            title = re.sub(r'<[^>]+>', '', inner).strip()
        it = {'title': title, 'desc': _span('desc', inner) or '', 'meta': _span('meta', inner) or '',
              'hidden': bool(m.group(1)), 'newtab': 'target="_blank"' in a.group(1).replace("'", '"')}
        fm = RE_FOLDER.match(href)
        if fm:
            it = {'folder': unquote(fm.group(1)), **it}
        else:
            it = {'href': href, **it}
        items.append(it)
    return items


def parse_legacy(text, name):
    cfg = default_config(name)
    pg, pal = cfg['page'], cfg['palette']

    def grab(pattern):
        m = re.search(pattern, text, re.S | re.I)
        return m.group(1).strip() if m else None
    v = grab(r'<html[^>]*\blang="([^"]*)"')
    if v:
        pg['lang'] = v
    v = grab(r'<title[^>]*>(.*?)</title>')
    if v:
        pg['title'] = html.unescape(v)
    for key, pat in (('logo', r'<div[^>]*class="[^"]*\blogo\b[^"]*"[^>]*>(.*?)</div>'),
                     ('heading', r'<h1[^>]*>(.*?)</h1>'),
                     ('lead', r'<p[^>]*class="[^"]*\blead\b[^"]*"[^>]*>(.*?)</p>'),
                     ('info', r'<div[^>]*class="[^"]*\binfo\b[^"]*"[^>]*>(.*?)</div>'),
                     ('footer', r'<footer[^>]*>(.*?)</footer>')):
        v = grab(pat)
        if v is not None:
            pg[key] = v
    r = re.search(r':root\s*\{(.*?)\}', text, re.S)
    if r:
        for k, val in re.findall(r'--([\w-]+)\s*:\s*([^;]+);', r.group(1)):
            if k in pal and HEX_RE.match(val.strip()):
                pal[k] = norm_hex(val)
    cfg['items'] = legacy_items(text)
    return clean_config(cfg)


# ----------------------------------------------------------------------------------------
#  File-system scanning
# ----------------------------------------------------------------------------------------
def skip_dir(n):
    return n.startswith('.') or n in IGNORE_DIRS or n.endswith('.egg-info')


def safe_dir(rel):
    rel = (rel or '').strip().strip('/')
    if not rel:
        return ROOT
    parts = rel.split('/')
    if any(not valid_name(p) or skip_dir(p) for p in parts):
        raise ApiError('Invalid path')
    p = ROOT.joinpath(*parts).resolve()
    try:
        p.relative_to(ROOT)
    except ValueError:
        raise ApiError('Path outside of root', 403)
    if not p.is_dir():
        raise ApiError('Folder not found', 404)
    return p


def join(a, b):
    return f'{a}/{b}' if a else b


def inspect_dir(d):
    """kind: noindex | page (index.html only) | bot (index + js) | hub"""
    idx = d / 'index.html'
    has_index = idx.is_file()
    files, subdirs = [], []
    try:
        for e in os.scandir(d):
            if e.is_file():
                files.append(e.name)
            elif e.is_dir() and not skip_dir(e.name):
                subdirs.append(e.name)
    except OSError:
        pass
    files.sort(key=str.lower)
    subdirs.sort(key=str.lower)
    js = [f for f in files if f.lower().endswith('.js')]
    if not has_index:
        kind = 'noindex'
    else:
        text = read_text(idx)
        if RE_CFG.search(text):
            kind = 'hub'
        elif js:
            kind = 'bot'
        elif any((d / s / 'index.html').is_file() for s in subdirs) or legacy_items(text):
            kind = 'hub'
        else:
            kind = 'page'
    return {'kind': kind, 'has_index': has_index, 'js': js, 'files': files, 'subdirs': subdirs}


def build_tree(d, rel='', depth=0):
    info = inspect_dir(d)
    kind = 'root' if rel == '' else info['kind']
    node = {'path': rel, 'name': d.name if rel else ROOT.name, 'kind': kind, 'has_index': info['has_index'],
            'js': info['js'], 'files': info['files'][:40], 'nfiles': len(info['files']), 'children': []}
    if kind in ('root', 'hub', 'noindex', 'page') and depth < MAX_DEPTH:
        for s in info['subdirs']:
            node['children'].append(build_tree(d / s, join(rel, s), depth + 1))
    return node


def read_config(index_path, name):
    """returns (cfg, source) or (None, None)"""
    text = read_text(index_path) if index_path.is_file() else ''
    if not text:
        return None, None
    m = RE_CFG.search(text)
    if m:
        try:
            return clean_config(json.loads(m.group(1))), 'bothub'
        except ValueError:
            pass
    return parse_legacy(text, name), 'legacy'


def parent_style(rel):
    if not rel:
        return None
    par = rel.rsplit('/', 1)[0] if '/' in rel else ''
    cfg, _ = read_config((ROOT / par if par else ROOT) / 'index.html', 'x')
    return (cfg['template'], cfg['palette']) if cfg else None


def sync_items(cfg, d):
    """Merge config items with real sub-folders. Returns list of removed folder names."""
    children = {n: inspect_dir(d / n) for n in inspect_dir(d)['subdirs']}
    removed, kept = [], []
    for it in cfg['items']:
        f = it.get('folder')
        if f is None:
            it['_kind'] = 'link'
            kept.append(it)
        elif f in children:
            it['_kind'], it['_js'] = children[f]['kind'], children[f]['js']
            kept.append(it)
        else:
            removed.append(f)
    known = {it['folder'] for it in kept if 'folder' in it}
    for n, info in children.items():
        if n in known:
            continue
        kept.append({'folder': n, 'title': title_of(d / n / 'index.html') or prettify(n), 'desc': '',
                     'meta': '/' + n, 'hidden': info['kind'] in ('noindex', 'page'), 'newtab': True,
                     '_new': True, '_kind': info['kind'], '_js': info['js']})
    cfg['items'] = kept
    return removed


def load_hub(rel):
    d = safe_dir(rel)
    info = inspect_dir(d)
    if rel and info['kind'] == 'bot':
        raise ApiError('This folder is a bot page (index.html + script), not a hub.')
    name = d.name if rel else ROOT.name
    cfg, source = None, 'new'
    if rel == '' or info['kind'] == 'hub':
        cfg, source = read_config(d / 'index.html', name)
    if cfg is None:
        source = 'new'
        cfg = default_config(prettify(name), parent_style(rel))
    removed = sync_items(cfg, d)
    dirty = source != 'bothub' or bool(removed) or any(i.get('_new') for i in cfg['items'])
    return {'path': rel, 'config': cfg, 'source': source, 'removed': removed, 'dirty_hint': dirty}


# ----------------------------------------------------------------------------------------
#  Rendering
# ----------------------------------------------------------------------------------------
def render_item(i, it, hub_dir, pg, edit):
    folder = it.get('folder')
    if folder:
        href = quote(folder) + '/index.html'
        missing = not (hub_dir / folder / 'index.html').is_file()
    else:
        href, missing = it['href'], False

    def f(name, ph):
        return f' data-f="{name}" data-ph="{ph}"' if edit else ''
    row = f'<span class="row"><span class="title"{f("title", "Title")}>{it["title"]}</span>'
    if pg['show_meta'] and (it['meta'] or edit):
        row += f'<span class="meta"{f("meta", "/path")}>{it["meta"]}</span>'
    row += '</span>'
    desc = ''
    if pg['show_desc'] and (it['desc'] or edit):
        desc = f'<span class="desc"{f("desc", "Description...")}>{it["desc"]}</span>'
    tgt = ' target="_blank" rel="noopener noreferrer"' if it['newtab'] else ''
    a = f'<a href="{html.escape(href, quote=True)}"{tgt}>{row}{desc}</a>'
    off = it['hidden'] or missing
    da = f' data-i="{i}"' if edit else ''
    if not off:
        return f'<li{da}>{a}</li>'
    if edit:
        cls = 'bh-off' + (' bh-missing' if missing else '')
        return f'<li class="{cls}"{da}>{a}</li>'
    label = 'skipped - no index.html' if missing and not it['hidden'] else 'hidden'
    return f'<!-- [{label}] <li>{a.replace("--", "- -")}</li> -->'


def render_page(cfg, hub_dir, edit=False, base=None):
    pg, pal = cfg['page'], cfg['palette']
    tpl = TEMPLATES[cfg['template']]
    items = '\n'.join('        ' + render_item(i, it, hub_dir, pg, edit) for i, it in enumerate(cfg['items']))

    def fa(name, ph):
        return f' data-f="{name}" data-ph="{ph}"' if edit else ''
    out = ['<!DOCTYPE html>', f'<html lang="{html.escape(pg["lang"], quote=True)}">', '<head>', '<meta charset="utf-8">']
    if base:
        out.append(f'<base href="{html.escape(base, quote=True)}">')
    out.append('<meta name="viewport" content="width=device-width,initial-scale=1">')
    out.append(f'<title>{html.escape(pg["title"], quote=False)}</title>')
    if not edit:
        out.append(f'<!--BOTHUB-CONFIG\n{embed_config(cfg)}\n-->')
        out.append('<!-- Generated by Bot Hub Builder. Edit with bothub.py; manual changes will be overwritten on next save. -->')
    out.append('<style>')
    out.append(':root{' + css_vars(pal) + '}')
    out.append(BASE_CSS + tpl['css'])
    if edit:
        out.append(EDIT_CSS)
    out.append('</style>')
    out.append('</head>')
    out.append(f'<body class="tpl-{cfg["template"]}">')
    out.append('  <main class="container" role="main">')
    out.append('    <header>')
    out.append(f'      <div class="logo" aria-hidden="true"{fa("logo", "LOGO")}>{pg["logo"]}</div>')
    out.append('      <div>')
    out.append(f'        <h1{fa("heading", "Heading")}>{pg["heading"]}</h1>')
    if pg['lead'] or edit:
        out.append(f'        <p class="lead"{fa("lead", "Lead text...")}>{pg["lead"]}</p>')
    out.append('      </div>')
    out.append('    </header>')
    if pg['info'] or edit:
        out.append(f'    <div class="info"{fa("info", "Info block (HTML allowed)...")}>{pg["info"]}</div>')
    out.append('    <nav aria-label="Bots and topics">')
    out.append('      <ul>')
    out.append(items)
    out.append('      </ul>')
    out.append('    </nav>')
    if pg['footer'] or edit:
        out.append(f'    <footer{fa("footer", "Footer...")}>{pg["footer"]}</footer>')
    out.append('  </main>')
    if edit:
        out.append('<script>' + EDIT_JS + '</script>')
    out.append('</body>')
    out.append('</html>')
    return '\n'.join(out) + '\n'


# ----------------------------------------------------------------------------------------
#  Writing / backups / moving
# ----------------------------------------------------------------------------------------
def write_atomic(path, text):
    tmp = path.with_name(path.name + '.tmp')
    with open(tmp, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)
    os.replace(tmp, path)


def backup_file(rel, text):
    d = ROOT / BACKUP_DIR / (rel.replace('/', '__') or '_root')
    d.mkdir(parents=True, exist_ok=True)
    (d / f'index_{datetime.now():%Y%m%d_%H%M%S}.html').write_text(text, encoding='utf-8')
    for old in sorted(d.glob('index_*.html'))[:-KEEP_BACKUPS]:
        try:
            old.unlink()
        except OSError:
            pass


def save_hub(rel, raw_cfg):
    d = safe_dir(rel)
    cfg = clean_config(raw_cfg)
    text = render_page(cfg, d)
    idx = d / 'index.html'
    if idx.is_file():
        old = read_text(idx)
        if old == text:
            return len(cfg['items']), False
        backup_file(rel, old)
    write_atomic(idx, text)
    return len(cfg['items']), True


def move_folder(src_rel, dest_rel):
    if not src_rel:
        raise ApiError('Cannot move the root')
    src, dest = safe_dir(src_rel), safe_dir(dest_rel)
    if dest == src or src in dest.parents:
        raise ApiError('Cannot move a folder into itself')
    if src.parent == dest:
        raise ApiError('Folder is already there')
    if dest != ROOT and inspect_dir(dest)['kind'] != 'hub':
        raise ApiError('Destination is not a hub')
    target = dest / src.name
    if target.exists():
        raise ApiError(f'"{src.name}" already exists in the destination', 409)
    shutil.move(str(src), str(target))
    return join(dest_rel, src.name)


def make_hub(rel):
    if not rel:
        raise ApiError('Root is already a hub')
    d = safe_dir(rel)
    info = inspect_dir(d)
    if info['kind'] in ('hub', 'bot'):
        raise ApiError(f'Folder is already a {info["kind"]}')
    cfg = default_config(prettify(d.name), parent_style(rel))
    if info['kind'] == 'page':
        t = title_of(d / 'index.html')
        if t:
            cfg['page']['title'] = html.unescape(t)
    sync_items(cfg, d)
    save_hub(rel, cfg)
    return len(cfg['items'])


# ----------------------------------------------------------------------------------------
#  API handlers
# ----------------------------------------------------------------------------------------
def api_info(q, body):
    ignored = sorted(e.name for e in os.scandir(ROOT) if e.is_file() and e.name != 'index.html')[:30]
    return {'root': str(ROOT), 'name': ROOT.name, 'version': VERSION, 'ignored': ignored,
            'templates': [{'id': k, 'label': v['label'], 'desc': v['desc']} for k, v in TEMPLATES.items()]}


def api_tree(q, body):
    return {'tree': build_tree(ROOT)}


def api_hub(q, body):
    return load_hub((q.get('path') or [''])[0])


def api_render(q, body):
    rel = body.get('path', '')
    d = safe_dir(rel)
    cfg = clean_config(body.get('config'))
    return {'html': render_page(cfg, d, edit=bool(body.get('edit')), base=body.get('base') or None)}


def api_save(q, body):
    rel = body.get('path', '')
    n, changed = save_hub(rel, body.get('config'))
    log('SAVE', f'{rel or "(root)"}/index.html - {n} entries' + ('' if changed else ' (unchanged)'))
    return {'ok': True, 'changed': changed}


def api_move(q, body):
    new = move_folder(body.get('src', ''), body.get('dest', ''))
    log('MOVE', f'{body.get("src")} -> {new}')
    return {'ok': True, 'path': new}


def api_make_hub(q, body):
    n = make_hub(body.get('path', ''))
    log('HUB', f'created hub index in {body.get("path")} ({n} entries)')
    return {'ok': True}


ROUTES = {('GET', 'info'): api_info, ('GET', 'tree'): quiet if False else api_tree, ('GET', 'hub'): api_hub,
          ('POST', 'render'): api_render, ('POST', 'save'): api_save, ('POST', 'move'): api_move,
          ('POST', 'make_hub'): api_make_hub} if False else {
    ('GET', 'info'): api_info, ('GET', 'tree'): api_tree, ('GET', 'hub'): api_hub,
    ('POST', 'render'): api_render, ('POST', 'save'): api_save, ('POST', 'move'): api_move,
    ('POST', 'make_hub'): api_make_hub}
QUIET = ('/api/render', '/api/tree', '/api/info')


# ----------------------------------------------------------------------------------------
#  HTTP
# ----------------------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = 'BotHub/' + VERSION

    def log_message(self, *a):
        pass

    def log_request(self, code='-', size='-'):
        p = self.path
        try:
            c = int(code)
        except (TypeError, ValueError):
            c = 0
        noisy = p.startswith(QUIET) or p.startswith('/site/') or p == '/'
        if c >= 400 or STATE['verbose'] or not noisy and p.startswith('/api/'):
            log('HTTP', f'{self.command} {unquote(p)} -> {code}')

    # -- helpers
    def _send(self, code, body, ctype='application/json; charset=utf-8', headers=None):
        try:
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode('utf-8'))

    def _host_ok(self):
        host = (self.headers.get('Host') or '').lower()
        return host in (f'127.0.0.1:{STATE["port"]}', f'localhost:{STATE["port"]}')

    # -- routing
    def do_GET(self):
        self._handle('GET')

    def do_HEAD(self):
        self._handle('GET')

    def do_POST(self):
        self._handle('POST')

    def _handle(self, method):
        if not self._host_ok():
            return self._json(403, {'error': 'Bad host header'})
        u = urlparse(self.path)
        path = unquote(u.path)
        if method == 'GET' and path in ('/', '/bothub.html'):
            return self._serve_ui()
        if path.startswith('/api/'):
            return self._api(method, path[5:], parse_qs(u.query))
        if method == 'GET' and path.startswith('/site'):
            return self._serve_site(path[5:])
        if path == '/favicon.ico':
            return self._send(204, b'', 'image/x-icon')
        self._json(404, {'error': 'Not found'})

    def _serve_ui(self):
        if not UI_FILE.is_file():
            return self._send(500, b'bothub.html not found next to bothub.py', 'text/plain')
        page = UI_FILE.read_text(encoding='utf-8')
        inject = f'<script>window.BOTHUB_TOKEN={json.dumps(STATE["token"])};</script>'
        page = page.replace('<!--BOTHUB_INJECT-->', inject) if '<!--BOTHUB_INJECT-->' in page \
            else page.replace('</head>', inject + '</head>', 1)
        self._send(200, page.encode('utf-8'), 'text/html; charset=utf-8')

    def _serve_site(self, rel):
        parts = [p for p in rel.split('/') if p]
        if any(p.startswith('.') or p in IGNORE_DIRS for p in parts):
            return self._send(403, b'Forbidden', 'text/plain')
        target = ROOT.joinpath(*parts).resolve() if parts else ROOT
        try:
            target.relative_to(ROOT)
        except ValueError:
            return self._send(403, b'Forbidden', 'text/plain')
        if target.is_dir():
            if not rel.endswith('/'):
                return self._send(301, b'', 'text/plain', {'Location': '/site' + quote(rel) + '/'})
            target = target / 'index.html'
        if not target.is_file() or target.suffix.lower() == '.py':
            return self._send(404 if target.suffix.lower() != '.py' else 403, b'Not available', 'text/plain')
        ctype = mimetypes.guess_type(str(target))[0] or 'application/octet-stream'
        if ctype.startswith('text/') or ctype in ('application/javascript', 'application/json'):
            ctype += '; charset=utf-8'
        self._send(200, target.read_bytes(), ctype)

    def _api(self, method, name, q):
        if self.headers.get('X-Bothub-Token') != STATE['token']:
            return self._json(403, {'error': 'Bad token - reload the builder page'})
        try:
            body = {}
            if method == 'POST':
                n = int(self.headers.get('Content-Length') or 0)
                if n > MAX_BODY:
                    raise ApiError('Request too large', 413)
                raw = self.rfile.read(n) if n else b'{}'
                body = json.loads(raw.decode('utf-8') or '{}')
            if (method, name) == ('POST', 'shutdown'):
                log('INFO', 'Shutdown requested from the UI')
                self._json(200, {'ok': True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            fn = ROUTES.get((method, name))
            if not fn:
                raise ApiError('Unknown API call', 404)
            self._json(200, fn(q, body))
        except ApiError as e:
            log('WARN', f'{name}: {e}')
            self._json(e.code, {'error': str(e)})
        except Exception as e:
            log('ERROR', f'{name}: {e}\n{traceback.format_exc()}')
            self._json(500, {'error': f'Server error: {e}'})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser(description='Bot Hub Builder')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--no-browser', action='store_true')
    ap.add_argument('-v', '--verbose', action='store_true', help='log every request')
    args = ap.parse_args()
    STATE['verbose'] = args.verbose
    STATE['token'] = secrets.token_urlsafe(24)
    if not UI_FILE.is_file():
        sys.exit('bothub.html must be in the same folder as bothub.py')

    server = None
    for port in range(args.port, args.port + 20):
        try:
            server = Server(('127.0.0.1', port), Handler)
            STATE['port'] = port
            break
        except OSError:
            continue
    if not server:
        sys.exit(f'No free port in {args.port}-{args.port + 19}')

    url = f'http://127.0.0.1:{STATE["port"]}/'
    print('=' * 64)
    print(f' Bot Hub Builder {VERSION}')
    print(f' Root folder : {ROOT}')
    print(f' Open        : {url}')
    print(' Stop        : Ctrl+C  (or the "Shut down" button in the UI)')
    print('=' * 64, flush=True)
    ignored = sorted(e.name for e in os.scandir(ROOT) if e.is_file() and e.name != 'index.html')
    if ignored:
        log('INFO', 'Ignoring root files: ' + ', '.join(ignored))
    if not args.no_browser:
        threading.Timer(0.6, webbrowser.open, [url]).start()
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        log('INFO', 'Ctrl+C received')
    finally:
        server.server_close()
        log('INFO', 'Server stopped. Bye.')


if __name__ == '__main__':
    main()