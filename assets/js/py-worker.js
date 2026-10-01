/* =====================================================================
   Python in a Web Worker (Pyodide = CPython compiled to WebAssembly).

   One Python serves the whole page:
   · the Notebook (cells run one at a time, output streamed back);
   · the terminal's  python  command (runs scripts);
   · the terminal's  snakemake  command (assets/py/smk.py), whose shell
     commands are sent back to the page, run by the page's shell (real
     WebAssembly tools) and answered with 'smk-shell-result'.

   Files: the page's virtual file system is the master copy. Before
   Python runs, the page pushes changed files here ('push'); after it
   runs, this worker reports the files Python changed ('changes' in the
   'done' message). Files keep their modification times on both sides,
   which Snakemake relies on.
   ===================================================================== */
/* global loadPyodide, importScripts */
'use strict';

let pyodide = null;
let runId = null;
let queue = Promise.resolve();

const post = (m, transfer) => self.postMessage(m, transfer || []);
const status = (text) => post({ type: 'status', text });

const HOME = '/home/student';
const ROOTS = [HOME];

/* ------------------------------------------------------------------
   output of notebook cells
   ------------------------------------------------------------------ */
const OUT_CAP = 200000;
let outChars = 0;
let outCut = false;
let sbuf = { name: null, text: '' };
function flushStream() {
  if (sbuf.text) post({ type: 'output', id: runId, payload: JSON.stringify({ type: 'stream', name: sbuf.name, text: sbuf.text }) });
  sbuf.text = '';
}
function resetOutput() {
  outChars = 0;
  outCut = false;
  sbuf = { name: null, text: '' };
}
self.nb_stream = (name, text) => {
  if (outCut || !text) return;
  if (outChars + text.length > OUT_CAP) {
    text = text.slice(0, Math.max(0, OUT_CAP - outChars)) + '\n… output cut after ' + OUT_CAP.toLocaleString('en') + ' characters (the cell carries on running; press Restart to stop it).\n';
    outCut = true;
  }
  outChars += text.length;
  if (sbuf.name !== name) flushStream();
  sbuf.name = name;
  sbuf.text += text;
  const nl = sbuf.text.lastIndexOf('\n');
  if (outCut || sbuf.text.length > 8192) flushStream();
  else if (nl >= 0) {
    const rest = sbuf.text.slice(nl + 1);
    sbuf.text = sbuf.text.slice(0, nl + 1);
    flushStream();
    sbuf.text = rest;
  }
};
self.nb_post_output = (json) => {
  flushStream();
  post({ type: 'output', id: runId, payload: json });
};

/* ------------------------------------------------------------------
   output of terminal commands (python, snakemake)
   ------------------------------------------------------------------ */
let termId = null;
let tbuf = [];
let tTimer = null;
function termFlush() {
  if (tTimer) {
    clearTimeout(tTimer);
    tTimer = null;
  }
  if (tbuf.length) post({ type: 'term-out', id: termId, chunks: tbuf });
  tbuf = [];
}
self.term_emit = (text, stream, color) => {
  if (!text) return;
  const last = tbuf[tbuf.length - 1];
  if (last && last.stream === stream && last.color === (color || null)) last.text += text;
  else tbuf.push({ text, stream, color: color || null });
  if (tbuf.length > 40 || (last && last.text.length > 16000)) termFlush();
  else if (!tTimer) tTimer = setTimeout(termFlush, 30);
};

/* ------------------------------------------------------------------
   the bridge: snakemake asks the page to run a shell command
   ------------------------------------------------------------------ */
const shellWaits = new Map();
let shellSeq = 0;
const cancelled = new Set();
self.smk_shell = (cmd, tools, env) =>
  new Promise((resolve) => {
    termFlush();
    const sid = ++shellSeq;
    shellWaits.set(sid, (m) => {
      applyChanges(m.changes);
      resolve(m.code);
    });
    const ch = scan();
    post({ type: 'smk-shell', id: termId, sid, cmd, tools: tools ? tools.toJs ? tools.toJs() : tools : null, env: env || null, cwd: pyodide.FS.cwd(), changes: ch }, transferOf(ch));
  });
self.smk_sync = () => {
  termFlush();
  const ch = scan();
  if (ch.files.length || ch.dirs.length || ch.removed.length) post({ type: 'fs-changes', changes: ch }, transferOf(ch));
};
self.smk_cancelled = () => cancelled.has(termId);

/* ------------------------------------------------------------------
   file sync
   ------------------------------------------------------------------ */
const known = new Map(); // path -> 'dir' | 'size:mtime'
const sigOf = (st) => st.size + ':' + (st.mtime instanceof Date ? st.mtime.getTime() : +st.mtime);
function dirnameOf(p) {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}
function mkdirp(p) {
  try {
    pyodide.FS.mkdirTree(p);
  } catch (e) {
    /* exists */
  }
}
function removeTree(p) {
  const FS = pyodide.FS;
  let st;
  try {
    st = FS.lstat(p);
  } catch (e) {
    return;
  }
  if (FS.isDir(st.mode)) {
    for (const n of FS.readdir(p)) if (n !== '.' && n !== '..') removeTree(p + '/' + n);
    try {
      FS.rmdir(p);
    } catch (e) {}
  } else {
    try {
      FS.unlink(p);
    } catch (e) {}
  }
  for (const k of Array.from(known.keys())) if (k === p || k.startsWith(p + '/')) known.delete(k);
}
function applyChanges(ch) {
  if (!ch) return;
  const FS = pyodide.FS;
  for (const p of ch.removed || []) removeTree(p);
  for (const d of ch.dirs || []) {
    mkdirp(d);
    known.set(d, 'dir');
  }
  for (const f of ch.files || []) {
    mkdirp(dirnameOf(f.path));
    try {
      FS.chmod(f.path, 0o644);
    } catch (e) {}
    FS.writeFile(f.path, new Uint8Array(f.bytes));
    if (f.mtime) FS.utime(f.path, f.mtime, f.mtime);
    if (f.readonly) FS.chmod(f.path, 0o444);
    known.set(f.path, sigOf(FS.stat(f.path)));
  }
}
function scan() {
  const FS = pyodide.FS;
  const files = [];
  const dirs = [];
  const seen = new Set();
  const walk = (dir) => {
    let names;
    try {
      names = FS.readdir(dir);
    } catch (e) {
      return;
    }
    for (const n of names) {
      if (n === '.' || n === '..' || n === '__pycache__') continue;
      const p = dir + '/' + n;
      let st;
      try {
        st = FS.stat(p);
      } catch (e) {
        continue;
      }
      if (FS.isDir(st.mode)) {
        seen.add(p);
        if (known.get(p) !== 'dir') {
          known.set(p, 'dir');
          dirs.push(p);
        }
        walk(p);
      } else if (FS.isFile(st.mode)) {
        seen.add(p);
        const s = sigOf(st);
        if (known.get(p) !== s) {
          known.set(p, s);
          files.push({ path: p, bytes: FS.readFile(p).buffer, mtime: st.mtime instanceof Date ? st.mtime.getTime() : +st.mtime, readonly: (st.mode & 0o200) === 0 });
        }
      }
    }
  };
  for (const r of ROOTS) {
    try {
      FS.stat(r);
    } catch (e) {
      continue;
    }
    seen.add(r);
    walk(r);
  }
  const removed = [];
  for (const p of Array.from(known.keys())) {
    if (ROOTS.some((r) => p === r || p.startsWith(r + '/')) && !seen.has(p)) {
      removed.push(p);
      known.delete(p);
    }
  }
  // parents before children, children before parents for removal
  removed.sort((a, b) => b.length - a.length);
  return { files, dirs, removed };
}
function transferOf(ch) {
  return (ch && ch.files ? ch.files.map((f) => f.bytes) : []).filter((b) => b instanceof ArrayBuffer);
}

/* ------------------------------------------------------------------
   Python set-up
   ------------------------------------------------------------------ */
const PY_SETUP = String.raw`
import sys, io, os, json, base64, ast, inspect, linecache, traceback, difflib, warnings, runpy, asyncio
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from js import nb_post_output, nb_stream, term_emit

pd.set_option('display.max_rows', 20)
pd.set_option('display.min_rows', 10)
pd.set_option('display.max_columns', 30)
pd.set_option('display.width', 160)
pd.set_option('display.max_colwidth', 100)
plt.rcParams.update({'figure.figsize': (6.4, 4.2), 'figure.dpi': 100, 'axes.spines.top': False,
                     'axes.spines.right': False, 'font.size': 10, 'axes.titlesize': 11})

def _emit(obj):
    nb_post_output(json.dumps(obj))

class _Stream(io.TextIOBase):
    def __init__(self, name):
        self.name = name
    def writable(self):
        return True
    def write(self, s):
        if s:
            nb_stream(self.name, s)
        return len(s)
    def flush(self):
        pass

class _TermStream(io.TextIOBase):
    def __init__(self, name):
        self.name = name
    def writable(self):
        return True
    def write(self, s):
        if s:
            term_emit(s, 'out' if self.name == 'stdout' else 'err', None)
        return len(s)
    def flush(self):
        pass
    def isatty(self):
        return False

_NB_OUT, _NB_ERR = _Stream('stdout'), _Stream('stderr')
sys.stdout, sys.stderr = _NB_OUT, _NB_ERR
warnings.simplefilter('once')

def _png(fig):
    buf = io.BytesIO()
    fig.savefig(buf, format='png', dpi=110, bbox_inches='tight')
    return base64.b64encode(buf.getvalue()).decode('ascii')

def _flush_figures():
    for num in plt.get_fignums():
        fig = plt.figure(num)
        if fig.axes:
            _emit({'type': 'display', 'mime': 'image/png', 'data': _png(fig)})
    plt.close('all')

plt.show = lambda *a, **k: _flush_figures()

def _no_input(prompt=''):
    raise RuntimeError("input() cannot ask for typing here. Put the value in the code instead, e.g.  sample = 'NA12878'")

import builtins
builtins.input = _no_input

def _is_mpl(v):
    from matplotlib.artist import Artist
    from matplotlib.container import Container
    if isinstance(v, (Artist, Container)):
        return True
    if isinstance(v, np.ndarray) and v.dtype == object and v.size and all(isinstance(x, Artist) for x in v.ravel()):
        return True
    if isinstance(v, (list, tuple)) and v and any(_is_mpl(x) for x in v):
        return True
    if isinstance(v, dict) and v and all(isinstance(x, list) and all(isinstance(y, Artist) for y in x) for x in v.values()):
        return True
    return False

def _rich(o):
    from matplotlib.figure import Figure
    if isinstance(o, Figure):
        data = _png(o)
        plt.close(o)
        return {'type': 'display', 'mime': 'image/png', 'data': data}
    rh = getattr(o, '_repr_html_', None)
    if callable(rh) and not isinstance(o, type):
        try:
            h = rh()
            if h:
                return {'type': 'display', 'mime': 'text/html', 'data': h}
        except Exception:
            pass
    r = repr(o)
    if len(r) > 20000:
        r = r[:20000] + '\n… (output truncated)'
    return {'type': 'display', 'mime': 'text/plain', 'data': r}

def display(*objs, **kwargs):
    for o in objs:
        _emit(_rich(o))

from matplotlib.figure import Figure as _Figure
_Figure.show = lambda self, *a, **k: display(self)

_G = {'__name__': '__main__', '__builtins__': __builtins__, 'display': display}

def _hints(e):
    """simple, rule-based hints for common mistakes (shown under the error)"""
    hints = []
    name = type(e).__name__
    try:
        if name == 'KeyError' and e.args:
            key = str(e.args[0])
            frames = [(vn, v) for vn, v in list(_G.items()) if isinstance(v, pd.DataFrame) and not vn.startswith('_')]
            for vn, v in frames:
                close = difflib.get_close_matches(key, [str(c) for c in v.columns], n=3, cutoff=0.5)
                if close:
                    hints.append(f"'{key}' is not a column of {vn}. Did you mean: {', '.join(repr(c) for c in close)}?")
                    break
            if not hints:
                dicts = [(vn, v) for vn, v in list(_G.items()) if isinstance(v, dict) and not vn.startswith('_') and v]
                for vn, v in dicts:
                    close = difflib.get_close_matches(key, [str(k) for k in v], n=3, cutoff=0.5)
                    if close:
                        hints.append(f"'{key}' is not a key of the dictionary {vn}. Did you mean: {', '.join(repr(c) for c in close)}?")
                        break
            if not hints:
                hints.append(f"'{key}' was not found. Names are case-sensitive: check the spelling (for a table:  df.columns; for a dictionary:  d.keys()).")
        elif name == 'NameError':
            import re
            m = re.search(r"name '([^']+)' is not defined", str(e))
            if m:
                n = m.group(1)
                import builtins as _b
                close = difflib.get_close_matches(n, [k for k in _G if not k.startswith('_')] + [k for k in dir(_b) if not k.startswith('_')], n=3, cutoff=0.6)
                if close:
                    hints.append(f"Did you mean {', '.join(close)}?")
                elif n in ('pd', 'np', 'plt'):
                    hints.append(f"'{n}' is an abbreviation that has to be imported first, e.g. import pandas as pd / import numpy as np / import matplotlib.pyplot as plt")
                else:
                    hints.append(f"'{n}' has not been created yet. Run the cell that defines it first - or, if it is text, put it in quotes: '{n}'.")
        elif name == 'FileNotFoundError':
            hints.append(f"The notebook runs in {os.getcwd()}. Paths are relative to that folder - check the file exists there (the Terminal's  ls  helps).")
        elif name in ('ModuleNotFoundError', 'ImportError'):
            hints.append('Only some packages are available in this browser Python: pandas, numpy, matplotlib, scipy and pyyaml (import yaml).')
        elif name == 'IndentationError':
            hints.append('Python uses indentation (spaces at the start of a line) to group code: every line inside a for loop, if or def must be indented by the same amount (4 spaces).')
        elif name == 'SyntaxError' and 'never closed' in str(e):
            hints.append('A bracket ( [ { or quote was opened but not closed. Check the line shown and the one above it.')
        elif name == 'TypeError' and 'can only concatenate str' in str(e):
            hints.append('Text and numbers cannot be joined with +. Use an f-string instead:  f"{name} has {n} reads"  or convert with str(n).')
    except Exception:
        pass
    return hints

def _emit_error(e, code):
    tb = traceback.TracebackException.from_exception(e)
    frames = [f for f in tb.stack if f.filename == '<cell>']
    lines = []
    if frames:
        lines.append('Traceback (most recent call last):')
        shown = frames if len(frames) <= 12 else frames[:5] + [None] + frames[-5:]
        for f in shown:
            if f is None:
                lines.append(f'  … {len(frames) - 10} more lines like these …')
                continue
            lines.append(f'  Cell line {f.lineno}' + (f', in {f.name}' if f.name != '<module>' else ''))
            if f.line:
                lines.append('    ' + f.line.strip())
    if isinstance(e, SyntaxError):
        lines.append(f'  Cell line {e.lineno}')
        if e.text:
            lines.append('    ' + e.text.rstrip('\n'))
            if e.offset:
                lines.append('    ' + ' ' * (max(e.offset, 1) - 1) + '^')
    only = [l for l in ''.join(tb.format_exception_only()).strip().split('\n') if l.strip()]
    msg = only[-1].strip() if isinstance(e, SyntaxError) else '\n'.join(l.rstrip() for l in only)
    if len(msg) > 3000:
        msg = msg[:3000] + ' …'
    lines.append(msg)
    hints = _hints(e)
    if 'Did you mean' in msg:
        hints = [h for h in hints if not h.startswith('Did you mean')]
    _emit({'type': 'error', 'ename': type(e).__name__, 'evalue': str(e)[:2000], 'traceback': '\n'.join(lines),
           'lineno': (frames[-1].lineno if frames else getattr(e, 'lineno', None)), 'hints': hints})

_MAGIC = __import__('re').compile(r'^\s*[%!]')
_NB_CWD = [os.getcwd()]

async def _nb_run(code, cwd=None):
    if cwd and os.path.isdir(cwd):
        os.chdir(cwd)
    if any(_MAGIC.match(l) for l in code.splitlines()):
        code = '\n'.join(('# ' + l) if _MAGIC.match(l) else l for l in code.splitlines())
        print('Note: lines starting with % or ! are Jupyter/IPython commands - they are not needed here and were skipped. '
              'Shell commands go in the Terminal tab.', file=sys.stderr)
    linecache.cache['<cell>'] = (len(code), None, code.splitlines(True), '<cell>')
    try:
        tree = ast.parse(code, filename='<cell>', mode='exec')
    except SyntaxError as e:
        _emit_error(e, code)
        return False
    last = None
    if tree.body and isinstance(tree.body[-1], ast.Expr) and not code.rstrip().endswith(';'):
        last = ast.Expression(tree.body.pop().value)
    flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
    try:
        r = eval(compile(tree, '<cell>', 'exec', flags=flags), _G)
        if inspect.iscoroutine(r):
            await r
        val = None
        if last is not None:
            val = eval(compile(last, '<cell>', 'eval', flags=flags), _G)
            if inspect.iscoroutine(val):
                val = await val
        _flush_figures()
        if val is not None and not _is_mpl(val):
            _G['_'] = val
            _emit(_rich(val))
        return True
    except BaseException as e:
        try:
            _flush_figures()
        except Exception:
            pass
        _emit_error(e, code)
        return False

def _nb_eval(expr):
    try:
        v = eval(expr, _G)
    except Exception:
        return 'null'
    try:
        if isinstance(v, (np.integer,)):
            v = int(v)
        elif isinstance(v, (np.floating,)):
            v = float(v)
        elif isinstance(v, np.ndarray):
            v = v.tolist()
        return json.dumps(v, default=str)
    except Exception:
        return json.dumps(str(v))

def _nb_vars():
    out = []
    for k, v in _G.items():
        if k.startswith('_') or k in ('display',) or inspect.ismodule(v) or callable(v) and not isinstance(v, (pd.DataFrame, pd.Series)):
            continue
        t = type(v).__name__
        if isinstance(v, pd.DataFrame):
            d = f'{v.shape[0]} rows × {v.shape[1]} columns'
        elif isinstance(v, pd.Series):
            d = f'{len(v)} values'
        elif isinstance(v, np.ndarray):
            d = 'shape ' + ' × '.join(str(x) for x in v.shape)
        elif isinstance(v, (int, float, str, bool)):
            d = repr(v)[:60]
        elif isinstance(v, (list, tuple, dict, set)):
            d = f'{len(v)} items'
        else:
            d = type(v).__module__.split('.')[0]
        out.append({'name': k, 'type': t, 'desc': d})
    return json.dumps(out)

# ---------------------------------------------------------------- terminal commands
class _TermContext:
    """run a terminal command: its own cwd, output to the terminal, notebook state untouched"""
    def __init__(self, cwd):
        self.cwd = cwd
    def __enter__(self):
        self.old_cwd = os.getcwd()
        self.old = (sys.stdout, sys.stderr, sys.argv[:])
        sys.stdout, sys.stderr = _TermStream('stdout'), _TermStream('stderr')
        if self.cwd:
            os.chdir(self.cwd)
        return self
    def __exit__(self, *exc):
        sys.stdout, sys.stderr, sys.argv[:] = self.old[0], self.old[1], self.old[2]
        try:
            plt.close('all')
        except Exception:
            pass
        try:
            os.chdir(self.old_cwd)
        except OSError:
            os.chdir('/home/student')
        return False

def _term_traceback(e, path):
    tbe = traceback.TracebackException.from_exception(e)
    lines = ['Traceback (most recent call last):']
    for fr in tbe.stack:
        if not (fr.filename == path or fr.filename.startswith('/home/student')):
            continue
        lines.append(f'  File "{fr.filename}", line {fr.lineno}, in {fr.name}')
        if fr.line:
            lines.append('    ' + fr.line.strip())
    if isinstance(e, SyntaxError):
        lines = [f'  File "{e.filename}", line {e.lineno}']
        if e.text:
            lines.append('    ' + e.text.rstrip('\n'))
            if e.offset:
                lines.append('    ' + ' ' * (max(e.offset, 1) - 1) + '^')
    lines += [l.rstrip('\n') for l in tbe.format_exception_only()]
    return '\n'.join(l for l in lines if l.strip() or l == '') + '\n'

async def _py_script(argv, cwd):
    """python ARGS... ; returns the exit status"""
    with _TermContext(cwd):
        code_text, path, mod = None, None, None
        args = list(argv)
        if not args:
            term_emit("Python 3 is here, but an interactive Python prompt (>>>) is not available in this terminal.\n"
                      "Use the Notebook tab to type Python line by line, or run a script:  python my_script.py\n", 'err', None)
            return 2
        if args[0] == '-c':
            if len(args) < 2:
                term_emit("Argument expected for the -c option\n", 'err', None)
                return 2
            code_text, path, rest = args[1], '<string>', args[2:]
            sys.argv[:] = ['-c'] + rest
        elif args[0] == '-m':
            term_emit("python -m is not available in this terminal (try the command itself, e.g.  pip list).\n", 'err', None)
            return 2
        else:
            path = args[0]
            if not os.path.exists(path):
                term_emit(f"python: can't open file '{os.path.abspath(path)}': [Errno 2] No such file or directory\n", 'err', None)
                return 2
            if os.path.isdir(path):
                term_emit(f"python: '{path}' is a directory, cannot run it\n", 'err', None)
                return 2
            sys.argv[:] = args
            with open(path) as fh:
                code_text = fh.read()
            path = os.path.abspath(path)
        g = {'__name__': '__main__', '__file__': path, '__builtins__': __builtins__}
        try:
            code = compile(code_text, path, 'exec', flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
            r = eval(code, g)
            if inspect.iscoroutine(r):
                await r
            return 0
        except SystemExit as e:
            c = e.code
            if c is None:
                return 0
            if isinstance(c, int):
                return c
            term_emit(str(c) + '\n', 'err', None)
            return 1
        except BaseException as e:
            term_emit(_term_traceback(e, path), 'err', None)
            return 1

async def _smk_run(argv, cwd, host):
    import smk
    with _TermContext(cwd):
        smk._PAGE_BRIDGE.cancel_flag = False
        return await smk.main(list(argv), lambda t, s, c: term_emit(t, s, c), dict(host))
`;

const SMK_BRIDGE = String.raw`
import smk
from js import smk_shell, smk_sync, smk_cancelled

class _PageBridge(smk.Bridge):
    cancel_flag = False
    async def shell(self, cmd, tools=None, env=None):
        from pyodide.ffi import to_js
        return int(await smk_shell(cmd, to_js(tools) if tools is not None else None, env))
    async def sync(self):
        smk_sync()
    def cancelled(self):
        return bool(smk_cancelled())

smk._PAGE_BRIDGE = _PageBridge()
smk.set_bridge(smk._PAGE_BRIDGE)
`;

async function init(m) {
  status('Downloading Python (Pyodide)…');
  try {
    importScripts(m.indexURL + 'pyodide.js');
  } catch (e) {
    throw new Error('Could not download Python from ' + m.indexURL + ' – check the internet connection.');
  }
  WHEELS = m.wheels || {};
  pyodide = await loadPyodide({ indexURL: m.indexURL, env: { HOME, USER: 'student' } });
  status('Loading numpy, pandas, matplotlib and PyYAML…');
  await pyodide.loadPackage(m.preload || ['numpy', 'pandas', 'matplotlib', 'pyyaml'], { messageCallback: () => {}, errorCallback: () => {} });
  status('Setting up the files…');
  mkdirp(HOME);
  for (const f of m.files || []) {
    const r = await fetch(f.url);
    if (!r.ok) throw new Error('Could not load ' + f.url);
    const buf = new Uint8Array(await r.arrayBuffer());
    mkdirp(dirnameOf(f.path));
    pyodide.FS.writeFile(f.path, buf);
    if (f.mtime) pyodide.FS.utime(f.path, f.mtime, f.mtime);
    if (f.readonly) pyodide.FS.chmod(f.path, 0o444);
  }
  // the Snakemake-compatible engine
  const lib = '/lib/smk';
  mkdirp(lib);
  for (const mod of m.modules || []) {
    const r = await fetch(mod.url);
    if (!r.ok) throw new Error('Could not load ' + mod.url);
    pyodide.FS.writeFile(lib + '/' + mod.name, await r.text());
  }
  // `from snakemake.io import expand` works in the notebook and in scripts, as with Snakemake installed
  mkdirp(lib + '/snakemake');
  pyodide.FS.writeFile(lib + '/snakemake/__init__.py', 'from smk import VERSION as __version__\n');
  pyodide.FS.writeFile(lib + '/snakemake/io.py', 'from smk import expand, collect, glob_wildcards, temp, protected, directory, ancient, touch, multiext, unpack\n');
  pyodide.FS.chdir(HOME);
  await pyodide.runPythonAsync(PY_SETUP);
  await pyodide.runPythonAsync(`import sys\nsys.path.insert(0, '${lib}')\n` + SMK_BRIDGE);
  const versions = JSON.parse(
    await pyodide.runPythonAsync(
      "import sys, pandas, numpy, matplotlib, yaml, smk; json.dumps({'python': sys.version.split()[0], 'pandas': pandas.__version__, 'numpy': numpy.__version__, 'matplotlib': matplotlib.__version__, 'pyyaml': yaml.__version__, 'snakemake': smk.VERSION})"
    )
  );
  post({ type: 'ready', versions });
  if (m.background && m.background.length) {
    pyodide.loadPackage(m.background, { messageCallback: () => {}, errorCallback: () => {} }).then(() => post({ type: 'background', done: true })).catch(() => {});
  }
}

let WHEELS = {};

async function loadImports(code, id) {
  try {
    await pyodide.loadPackagesFromImports(code, {
      messageCallback: (msg) => {
        const mm = /Loading (.+)/.exec(msg);
        if (mm) post({ type: 'status', text: 'Loading ' + mm[1].slice(0, 80) + '…', id });
      },
      errorCallback: () => {}
    });
    const wants = Object.keys(WHEELS).filter((k) => new RegExp('^\\s*(import|from)\\s+' + k + '\\b', 'm').test(code));
    if (wants.length) {
      const have = JSON.parse(await pyodide.runPythonAsync(`import importlib.util, json; json.dumps([${wants.map((w) => `importlib.util.find_spec('${w}') is not None`).join(',')}])`));
      const missing = wants.filter((w, i) => !have[i]);
      if (missing.length) {
        post({ type: 'status', text: 'Installing ' + missing.join(', ') + '…', id });
        await pyodide.loadPackage('micropip');
        const micropip = pyodide.pyimport('micropip');
        await micropip.install(missing.map((k) => WHEELS[k]));
        micropip.destroy();
      }
    }
  } catch (e) {
    /* a missing package is reported by Python itself when the import runs */
  }
}

function doneWithChanges(msg) {
  let ch = { files: [], dirs: [], removed: [] };
  try {
    ch = scan();
  } catch (e) {
    console.error(e);
  }
  msg.changes = ch;
  post(msg, transferOf(ch));
}

async function run(m) {
  runId = m.id;
  resetOutput();
  const t0 = performance.now();
  await loadImports(m.code, m.id);
  const runner = pyodide.globals.get('_nb_run');
  let ok = false;
  try {
    ok = await runner(m.code, m.cwd || null);
  } finally {
    runner.destroy();
    flushStream();
  }
  doneWithChanges({ type: 'done', id: m.id, ok: !!ok, secs: (performance.now() - t0) / 1000 });
  runId = null;
}

async function termRun(m) {
  termId = m.id;
  tbuf = [];
  let code = 1;
  try {
    if (m.type === 'python') {
      const path = m.argv[0] && m.argv[0] !== '-c' ? m.argv[0] : null;
      let src = m.argv[0] === '-c' ? m.argv[1] || '' : '';
      if (path) {
        try {
          src = new TextDecoder().decode(pyodide.FS.readFile(m.cwd && !path.startsWith('/') ? m.cwd + '/' + path : path));
        } catch (e) {
          src = '';
        }
      }
      if (src) await loadImports(src, m.id);
      const f = pyodide.globals.get('_py_script');
      try {
        code = await f(pyodide.toPy(m.argv), m.cwd);
      } finally {
        f.destroy();
      }
    } else if (m.type === 'smk') {
      const f = pyodide.globals.get('_smk_run');
      try {
        code = await f(pyodide.toPy(m.argv), m.cwd, pyodide.toPy(m.host || {}));
      } finally {
        f.destroy();
      }
    }
  } catch (e) {
    self.term_emit(String((e && e.message) || e) + '\n', 'err', 'red');
    code = 1;
  }
  termFlush();
  cancelled.delete(m.id);
  doneWithChanges({ type: 'term-done', id: m.id, code: Number(code) || 0 });
  termId = null;
}

async function evalExpr(m) {
  const f = pyodide.globals.get('_nb_eval');
  let v = 'null';
  try {
    v = f(m.expr);
  } finally {
    f.destroy();
  }
  post({ type: 'evalResult', id: m.id, value: JSON.parse(v) });
}

async function vars(m) {
  const f = pyodide.globals.get('_nb_vars');
  let v = '[]';
  try {
    v = f();
  } finally {
    f.destroy();
  }
  post({ type: 'vars', id: m.id, value: JSON.parse(v) });
}

async function handle(m) {
  try {
    if (m.type === 'init') await init(m);
    else if (m.type === 'push') {
      applyChanges(m.changes);
      if (m.id) post({ type: 'pushed', id: m.id });
    } else if (m.type === 'run') await run(m);
    else if (m.type === 'python' || m.type === 'smk') await termRun(m);
    else if (m.type === 'eval') await evalExpr(m);
    else if (m.type === 'vars') await vars(m);
    else if (m.type === 'reload-module') {
      const r = await fetch(m.url);
      pyodide.FS.writeFile('/lib/smk/' + m.name, await r.text());
      await pyodide.runPythonAsync(`import importlib, smk\nimportlib.reload(smk)\n` + SMK_BRIDGE);
      post({ type: 'pushed', id: m.id });
    }
  } catch (e) {
    post({ type: 'fatal', id: m.id, stage: m.type, message: String((e && e.message) || e) });
  }
}

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'smk-shell-result') {
    const w = shellWaits.get(m.sid);
    if (w) {
      shellWaits.delete(m.sid);
      w(m);
    }
    return;
  }
  if (m.type === 'cancel') {
    cancelled.add(m.id);
    return;
  }
  queue = queue.then(() => handle(m));
};
