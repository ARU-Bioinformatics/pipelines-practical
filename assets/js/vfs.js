/* =====================================================================
   Virtual file system used by the browser terminal and workflow engine.

   Entry kinds
     dir      – a directory
     text     – a small text file held in memory       { text }
     url      – a real file hosted with the site        { url, size }
     blob     – a real file on the student's computer   { blob }
     aioli    – a real file that lives in the WebAssembly file system { apath, size }
   ===================================================================== */
(function () {
  'use strict';
  const MG = (window.MG = window.MG || {});

  function normPath(p) {
    const parts = [];
    String(p).split('/').forEach((seg) => {
      if (!seg || seg === '.') return;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    });
    return '/' + parts.join('/');
  }
  // how many bytes a text has (UTF-8). Counted here: asking the browser for a Blob takes as long as a thousand lines
  // of this – a file that is written line by line is measured once per line.
  const ENC = new TextEncoder();
  const utf8Size = (t) => {
    let n = t.length, plain = true;
    for (let i = 0; i < n; i++) if (t.charCodeAt(i) > 0x7f) { plain = false; break; }
    return plain ? n : ENC.encode(t).length;
  };
  function dirname(p) {
    const n = normPath(p);
    const i = n.lastIndexOf('/');
    return i <= 0 ? '/' : n.slice(0, i);
  }
  function basename(p) {
    const n = normPath(p);
    return n.slice(n.lastIndexOf('/') + 1);
  }

  class VFS {
    constructor(home) {
      this.home = home || '/home/student';
      this.cwd = this.home;
      this.entries = new Map();
      this.listeners = [];
      this.entries.set('/', { kind: 'dir', mtime: Date.now() });
      this.mkdirp(this.home);
    }
    onChange(fn) {
      this.listeners.push(fn);
    }
    _changed(path, what) {
      this.listeners.forEach((fn) => {
        try {
          fn(path, what);
        } catch (e) {
          console.error(e);
        }
      });
    }
    /** resolve a user path (relative, ~, absolute) to an absolute path */
    resolve(p, cwd) {
      if (p == null || p === '') return normPath(cwd || this.cwd);
      p = String(p);
      if (p === '~') return this.home;
      if (p.startsWith('~/')) return normPath(this.home + '/' + p.slice(2));
      if (p.startsWith('/')) return normPath(p);
      return normPath((cwd || this.cwd) + '/' + p);
    }
    /** The file system as the shell sees it: the same files, but a path is taken as it is written. On Linux "~" is
        the home folder only where the shell itself puts the folder in its place – at the start of a word that is not
        in quotes (shell-lang.js does that). What reaches a command with a ~ in front is a name:
        mkdir "~/results" makes a folder called ~, and ls "~/data" finds nothing. */
    forShell() {
      const fs = this;
      // Linux reads a path name by name. "X/.." needs X to be a folder that is there (nosuch/../a.txt names nothing,
      // although it "is" a.txt once the dots are taken out), and a name with a slash behind it – "FILE/", "FILE/." –
      // must be a folder. A path that fails this gets a name that no file has and that none can be given (NOWHERE:
      // see put, mkdirp, touch, rename below): the commands then find nothing there and can make nothing there –
      // rm -f a.txt/ and  echo x > nosuch/../a.txt  must not touch a.txt.
      // (The folder one is in is not asked whether it is still there: "cd .." and "../file" work in a folder that
      // was removed, as on Linux.)
      const NOWHERE = '\u0001';
      const resolve = function (p, cwd) {
        if (p == null || p === '') return normPath(cwd || fs.cwd);
        p = String(p);
        const base = cwd || fs.cwd;
        if (!((p.length > 1 && p.endsWith('/')) || /(^|\/)\.\.?(\/|$)/.test(p))) return normPath(p.startsWith('/') ? p : base + '/' + p);
        let cur = p.startsWith('/') ? '/' : normPath(base), start = !p.startsWith('/');
        for (const seg of p.split('/')) {
          if (seg === '') continue;
          if (seg === '.' || seg === '..') {
            if (!start) {
              const e = fs.entries.get(cur);
              if (!e || e.kind !== 'dir') return cur + '/' + NOWHERE;
            }
            if (seg === '..') cur = dirname(cur);
          } else {
            cur = cur === '/' ? '/' + seg : cur + '/' + seg;
            start = false;
          }
        }
        if (p.endsWith('/')) {
          const e = fs.entries.get(cur);
          if (e && e.kind !== 'dir') return cur + '/' + NOWHERE;
        }
        return cur;
      };
      const nowhere = (abs) => typeof abs === 'string' && abs.includes(NOWHERE);
      /** why a path names nothing, in the words of Linux – or null: it can be read as it is written */
      const pathError = (abs) => (nowhere(abs) ? (fs.entries.has(dirname(abs)) ? 'Not a directory' : 'No such file or directory') : null);
      // The empty name is no file at all: [ -d "$DIR" ] with an empty DIR is false, [ -x "$(command -v nosuch)" ]
      // is false, ls "" finds nothing. (Called as methods: "this" is whatever view the caller holds – the one that
      // notes the paths of an agent's command wraps this one, and must see these paths too.)
      const over = {
        resolve,
        get(p) {
          return p === '' ? null : fs.entries.get(this.resolve(p)) || null;
        },
        exists(p) {
          return p !== '' && fs.entries.has(this.resolve(p));
        },
        isDir(p) {
          const e = p === '' ? null : fs.entries.get(this.resolve(p));
          return !!e && e.kind === 'dir';
        },
        // … and nothing is written to it, made of it, moved to it or removed with it: mv FILE "$DIR" with an empty
        // DIR must never be taken for "the folder I am in".
        put(p, entry) {
          if (p === '') throw new Error(': No such file or directory');
          const why = pathError(this.resolve(p));
          if (why) throw new Error(`${p}: ${why}`);
          return fs.put.call(this, p, entry);
        },
        mkdirp(p) {
          if (p === '') throw new Error(': No such file or directory');
          const why = pathError(this.resolve(p));
          if (why) throw new Error(`${p}: ${why}`);
          return fs.mkdirp.call(this, p);
        },
        touch(p) {
          if (p === '') throw new Error(': No such file or directory');
          const why = pathError(this.resolve(p));
          if (why) throw new Error(`${p}: ${why}`);
          return fs.touch.apply(this, arguments);
        },
        remove(p) {
          return p === '' ? false : fs.remove.call(this, p);
        },
        rename(a, b) {
          return a === '' || b === '' || nowhere(this.resolve(a)) || nowhere(this.resolve(b)) ? false : fs.rename.call(this, a, b);
        },
        /** "Not a directory" / "No such file or directory" for a path that names nothing because of a slash behind a
            file's name or of dots behind a folder that is not there – null for every other path */
        pathError(p) {
          return p == null || p === '' ? null : pathError(this.resolve(p));
        },
        chmod(p, perm) {
          return p === '' ? false : fs.chmod.call(this, p, perm);
        }
      };
      return new Proxy(fs, {
        get: (t, k) => (Object.prototype.hasOwnProperty.call(over, k) ? over[k] : t[k]),
        set: (t, k, v) => {
          t[k] = v;
          return true;
        }
      });
    }
    /** pretty path for prompts (~ for home) */
    pretty(abs) {
      if (abs === this.home) return '~';
      if (abs.startsWith(this.home + '/')) return '~' + abs.slice(this.home.length);
      return abs;
    }
    get(p) {
      return this.entries.get(this.resolve(p)) || null;
    }
    exists(p) {
      return this.entries.has(this.resolve(p));
    }
    isDir(p) {
      const e = this.get(p);
      return !!e && e.kind === 'dir';
    }
    /** The folder in which a name appears, or from which one goes, has changed: as on Linux, the time of a folder is
        the time at which its list of names last changed (ls -td run_* | head -n 1, find -newer, [ dir -nt file ]).
        when: the time of a file that a program wrote (the folder is not newer than what was written into it).
        The entry stays the same object: only its time moves on. */
    _dirTouched(abs, when) {
      const d = this.entries.get(dirname(abs));
      if (!d || d.kind !== 'dir') return;
      const t = when || Date.now();
      if (t > (d.mtime || 0)) d.mtime = t;
    }
    mkdirp(p) {
      const abs = this.resolve(p);
      const parts = abs.split('/').filter(Boolean);
      let cur = '';
      parts.forEach((seg) => {
        cur += '/' + seg;
        if (this.entries.has(cur)&&this.entries.get(cur).kind!=='dir')throw new Error(`${cur}: Not a directory`);
        if (!this.entries.has(cur)) {
          const d = { kind: 'dir', mtime: Date.now() };
          if (this.umask != null && this.umask !== 0o022) d.perm = 0o777 & ~this.umask;
          this.entries.set(cur, d);
          this._dirTouched(cur);
          this._changed(cur, 'mkdir');
        }
      });
      return abs;
    }
    /** write/replace a file entry */
    put(p, entry) {
      const abs = this.resolve(p);
      const parent = dirname(abs);
      if(this.entries.has(abs)&&this.entries.get(abs).kind==='dir')throw new Error(`${abs}: Is a directory`);
      if (!this.entries.has(parent)) this.mkdirp(parent);
      if(this.entries.get(parent)?.kind!=='dir')throw new Error(`${parent}: Not a directory`);
      const e = Object.assign({ mtime: Date.now() }, entry);
      // (umask: the bits that a new file does not get – set by the shell's umask command; 022 is the usual one)
      if (this.umask != null && this.umask !== 0o022 && e.perm == null && !this.entries.has(abs)) e.perm = (e.mode === 'x' ? 0o777 : 0o666) & ~this.umask;
      if (e.kind === 'text') {
        e.text = e.text == null ? '' : String(e.text);
        e.size = utf8Size(e.text);
        e.dirty = true;
      }
      const isNew = !this.entries.has(abs);
      this.entries.set(abs, e);
      if (isNew) this._dirTouched(abs, e.fresh ? e.mtime : 0);
      this._changed(abs, 'write');
      return abs;
    }
    writeText(p, text, extra) {
      return this.put(p, Object.assign({ kind: 'text', text }, extra || {}));
    }
    /** More text at the end of a text file (>>, a log that every command adds to, a loop that writes a file line by
        line): the size is counted up, not counted anew – what is there is not read again. A file that is there keeps
        its permissions. → false: no text file is there */
    appendText(p, text) {
      const abs = this.resolve(p), e = this.entries.get(abs);
      if (!e || e.kind !== 'text') return false;
      text = String(text);
      // (The text that is there is not looked at: looking would copy it – a file that grows line by line would be
      // copied once per line. half: the text ends in the first half of a character of two halves – noted when it
      // was added. Such a character must not be counted as two characters: then the whole text is counted.)
      const half = (t) => /[\ud800-\udbff]$/.test(t);
      const split = (e.half != null ? e.half : half(e.text)) && /^[\udc00-\udfff]/.test(text);
      const all = e.text + text;
      const n = { kind: 'text', text: all, size: split ? utf8Size(all) : (e.size || 0) + (text ? utf8Size(text) : 0), mtime: Date.now(), dirty: true, half: text ? half(text) : e.half != null ? e.half : half(e.text) };
      if (e.mode) n.mode = e.mode;
      if (e.perm != null) n.perm = e.perm;
      this.entries.set(abs, n);
      this._changed(abs, 'write');
      return abs;
    }
    /** new contents for a file (COMMAND > FILE): a file that is there keeps its permissions */
    rewrite(p, text) {
      const e = this.get(p);
      const keep = {};
      if (e && e.kind !== 'dir') {
        if (e.mode) keep.mode = e.mode;
        if (e.perm != null) keep.perm = e.perm;
      }
      return this.writeText(p, text, keep);
    }
    remove(p) {
      const abs = this.resolve(p);
      const e = this.entries.get(abs);
      if (!e) return false;
      if (e.kind === 'dir') {
        for (const k of Array.from(this.entries.keys())) if (k === abs || k.startsWith(abs + '/')) this.entries.delete(k);
      } else this.entries.delete(abs);
      this._dirTouched(abs);
      this._changed(abs, 'remove');
      return true;
    }
    rename(a, b) {
      const A = this.resolve(a), B = this.resolve(b);
      const e = this.entries.get(A);
      if (!e) return false;
      if (A === B) return true;
      // (never a file in the place of a folder, a folder in the place of a file, or a folder into itself: what is
      // below would be left without a folder above it)
      const tb = this.entries.get(B);
      if (tb && (tb.kind === 'dir') !== (e.kind === 'dir')) return false;
      if (e.kind === 'dir' && B.startsWith(A + '/')) return false;
      if (!this.entries.has(dirname(B))) this.mkdirp(dirname(B));
      if (e.kind === 'dir') {
        for (const k of Array.from(this.entries.keys())) {
          if (k === A || k.startsWith(A + '/')) {
            const v = this.entries.get(k);
            this.entries.delete(k);
            // a moved file is a new file for anyone keeping copies (Python, the tools)
            this.entries.set(B + k.slice(A.length), Object.assign({}, v));
          }
        }
      } else {
        this.entries.delete(A);
        this.entries.set(B, Object.assign({}, e));
      }
      this._dirTouched(A);
      this._dirTouched(B);
      this._changed(A, 'remove');
      this._changed(B, 'rename');
      return true;
    }
    /** update the times (touch). touch(p, when): the time of the last change, and with it that of the last reading.
        touch(p, mtime, atime): the two by themselves – undefined: as it is, null: now. (An entry has an atime of
        its own only when that differs from its mtime.) */
    touch(p, when, atime) {
      const abs = this.resolve(p);
      let e = this.entries.get(abs);
      const both = arguments.length < 3;
      if (!e) {
        this.writeText(abs, '');
        if (when == null && (both || atime == null)) return abs;
        e = this.entries.get(abs);
      }
      const now = Date.now(), n = Object.assign({}, e);
      if (both) {
        n.mtime = when != null ? when : now;
        delete n.atime;
      } else {
        const m0 = e.mtime || now, a0 = e.atime != null ? e.atime : m0;
        n.mtime = when === undefined ? m0 : when == null ? now : when;
        const a = atime === undefined ? a0 : atime == null ? now : atime;
        if (a === n.mtime) delete n.atime;
        else n.atime = a;
      }
      // (the very first millisecond of 1970 would read as "no time at all")
      if (n.mtime === 0) n.mtime = 1;
      if (n.kind === 'text') n.dirty = true;
      this.entries.set(abs, n);
      this._changed(abs, 'write');
      return abs;
    }
    /** set the permissions: { exec: bool, readonly: bool } */
    chmod(p, perm) {
      const abs = this.resolve(p);
      const e = this.entries.get(abs);
      if (!e) return false;
      const n = Object.assign({}, e);
      if (perm.exec != null) n.mode = perm.exec ? 'x' : undefined;
      if (perm.readonly != null) n.readonly = !!perm.readonly;
      // (the other bits – group, others – are kept for ls -l and stat to show; they change nothing here)
      if (perm.bits != null) n.perm = perm.bits;
      else delete n.perm;
      this.entries.set(abs, n);
      this._changed(abs, 'chmod');
      return true;
    }
    copy(a, b, keep) {
      const e = this.get(a);
      if (!e || e.kind === 'dir') return false;
      // a copy belongs to you: course-data protection is not copied (a read-only file of yours stays read-only, as with cp)
      // (keep.times – cp -p: the copy has the times of the file it was made from)
      const n = Object.assign({}, e, { mtime: keep && keep.times ? e.mtime : Date.now() });
      if (!(keep && keep.times)) delete n.atime;
      if (e.protected) {
        delete n.protected;
        delete n.readonly;
      }
      delete n.hidden;
      this.put(b, n);
      return true;
    }
    /** children of a directory: [{name, path, entry}] */
    list(p) {
      const abs = this.resolve(p);
      const out = [];
      const pre = abs === '/' ? '/' : abs + '/';
      for (const [k, v] of this.entries) {
        if (k === abs || !k.startsWith(pre)) continue;
        const rest = k.slice(pre.length);
        if (rest.includes('/')) continue;
        out.push({ name: rest, path: k, entry: v });
      }
      // (in the order of the characters, as ls and * give the names with LANG=C.UTF-8: capital letters first)
      return out.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    }
    size(e) {
      if (!e) return 0;
      if (e.kind === 'dir') return 4096;
      if (e.kind === 'text') return e.size || 0;
      if (e.kind === 'virtual') return (e.meta && e.meta.size) || 0;
      if (e.kind === 'blob') return e.blob.size || 0;
      return e.size || 0;
    }
    /** read as text (async – may need to fetch or read from WebAssembly) */
    async readText(p, opts = {}) {
      const e = this.get(p);
      if (!e) throw new Error(`${p}: No such file or directory`);
      if (e.kind === 'dir') throw new Error(`${p}: Is a directory`);
      if (e.kind === 'text') return e.text;
      if (e.kind === 'virtual') {
        if (e.meta && typeof e.meta.text === 'function') return e.meta.text(opts);
        throw Object.assign(new Error('virtual'), { virtual: true, entry: e });
      }
      if (e.kind === 'url') {
        const r = await fetch(e.url);
        if (!r.ok) throw new Error(`${p}: could not be read (${r.status})`);
        return await r.text();
      }
      if (e.kind === 'blob') return await e.blob.text();
      if (e.kind === 'aioli') {
        if (!MG.wasm || !MG.wasm.ready) throw new Error(`${p}: not available yet`);
        return await MG.wasm.readText(e.apath);
      }
      throw new Error(`${p}: cannot read`);
    }
    async readBytes(p) {
      const e = this.get(p);
      if (!e) throw new Error(`${p}: No such file or directory`);
      if (e.kind === 'text') return new TextEncoder().encode(e.text);
      if (e.kind === 'url') { const r=await fetch(e.url);if(!r.ok)throw new Error(`${p}: could not be read (${r.status})`);return new Uint8Array(await r.arrayBuffer()); }
      if (e.kind === 'blob') return new Uint8Array(await e.blob.arrayBuffer());
      if (e.kind === 'aioli' && MG.wasm) return await MG.wasm.readBytes(e.apath);
      throw new Error(`${p}: cannot read bytes`);
    }
    /** get a Blob for downloading / handing to igv.js */
    async toBlob(p) {
      const e = this.get(p);
      if (!e) throw new Error(`${p}: No such file`);
      if (e.kind === 'text') return new Blob([e.text], { type: 'text/plain' });
      if (e.kind === 'blob') return e.blob;
      if (e.kind === 'url') return await (await fetch(e.url)).blob();
      if (e.kind === 'aioli') return new Blob([await MG.wasm.readBytes(e.apath)]);
      throw new Error(`${p}: this simulated file cannot be downloaded`);
    }
    /** paths for tab completion */
    complete(prefix) {
      const hasSlash = prefix.includes('/');
      const dirPart = hasSlash ? prefix.slice(0, prefix.lastIndexOf('/') + 1) : '';
      const namePart = hasSlash ? prefix.slice(prefix.lastIndexOf('/') + 1) : prefix;
      const dirAbs = this.resolve(dirPart || '.');
      if (!this.isDir(dirAbs)) return [];
      return this.list(dirAbs)
        .filter((c) => c.name.startsWith(namePart) && (namePart.startsWith('.') || !c.name.startsWith('.')))
        .map((c) => dirPart + c.name + (c.entry.kind === 'dir' ? '/' : ''));
    }
    /** glob expansion: * ? [..] and the groups @( ) +( ) … in any part of a path. Names that start with a dot are only
        matched by a pattern that starts with one; no match gives the pattern back (as in bash).
        opts: globstar (a part ** is this folder and every folder below it), dotglob (* matches names that start
        with a dot too), nocase */
    glob(pattern, opts) {
      opts = opts || {};
      // (opts.noext: extglob is off – a bracket is a character like any other)
      const special = opts.noext ? /[*?[]/ : /[*?[]|[+@!]\(/;
      if (!special.test(pattern)) return [pattern];
      const flags = opts.nocase ? 'i' : '';
      const segs = pattern.split('/');
      const rooted = pattern.startsWith('/');
      // each step: [the place so far as an absolute path, the path as it was written]
      let bases = [[rooted ? '/' : this.cwd, rooted ? '/' : '']];
      const join = (shown, name) => (shown === '' ? name : shown.endsWith('/') ? shown + name : shown + '/' + name);
      const under = (abs, name) => (abs === '/' ? '/' + name : abs + '/' + name);
      segs.forEach((seg, k) => {
        if (k === 0 && seg === '') return;
        const last = k === segs.length - 1;
        const next = [];
        for (const [abs, shown] of bases) {
          if (seg === '') {
            // a pattern that ends in / matches folders only
            if (!last) next.push([abs, shown]);
            else if (this.isDir(abs) && shown !== '') next.push([abs, shown + '/']);
            continue;
          }
          // ("." and ".." stand for a folder only behind a folder that is there: nosuch/../*.txt and FILE/../*.txt
          // match nothing – a path is read name by name. At the start of the pattern they stand for the folder one
          // is in, and the one above it, whatever has become of it.)
          if ((seg === '.' || seg === '..') && shown !== '' && !this.isDir(abs)) continue;
          if (seg === '.') {
            next.push([abs, join(shown, '.')]);
            continue;
          }
          if (seg === '..') {
            next.push([dirname(abs), join(shown, '..')]);
            continue;
          }
          if (opts.globstar && seg === '**') {
            if (!this.isDir(abs)) continue;
            if (!last) next.push([abs, shown]);
            else if (shown !== '' && !shown.endsWith('/')) next.push([abs, shown + '/']); // (dir/** is dir/ itself too)
            const walk = (a, sh) => {
              for (const c of this.list(a)) {
                if (c.name.startsWith('.') && !opts.dotglob) continue;
                const s2 = join(sh, c.name);
                if (last || c.entry.kind === 'dir') next.push([c.path, s2]);
                if (c.entry.kind === 'dir') walk(c.path, s2);
              }
            };
            walk(abs, shown);
            continue;
          }
          if (!special.test(seg)) {
            next.push([under(abs, seg), join(shown, seg)]);
            continue;
          }
          if (!this.isDir(abs)) continue;
          const re = globRe(seg, flags, opts.noext);
          this.list(abs).forEach((c) => {
            if (c.name.startsWith('.') && seg[0] !== '.' && !opts.dotglob) return;
            if (re.test(c.name) && (last || c.entry.kind === 'dir')) next.push([c.path, join(shown, c.name)]);
          });
        }
        bases = next;
      });
      const hits = bases.filter(([abs]) => this.entries.has(abs)).map(([, shown]) => shown).sort();
      return hits.length ? hits : [pattern];
    }
  }

  /** a shell pattern as a regular expression for the whole string: * ? [abc] [!a-z] [[:digit:]], a backslash before a
      character that is meant as itself, and the groups of bash's extended patterns – ?(a|b) *(a|b) +(a|b) @(a|b) !(a|b);
      noExt: without the groups (bash with extglob off; the patterns of find -name, ls --hide, du --exclude) */
  const CLASSES = { alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: ' \\t\\n\\r\\f\\v', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', word: '\\w', cntrl: '\\x00-\\x1f\\x7f', print: '\\x20-\\x7e', graph: '\\x21-\\x7e' };
  function globSrc(pat, noExt) {
    let re = '';
    for (let i = 0; i < pat.length; i++) {
      const c = pat[i];
      if (!noExt && '?*+@!'.includes(c) && pat[i + 1] === '(') {
        let depth = 0, j = i + 1;
        for (; j < pat.length; j++) {
          if (pat[j] === '\\') j++;
          else if (pat[j] === '(') depth++;
          else if (pat[j] === ')' && --depth === 0) break;
        }
        if (j < pat.length) {
          const inner = pat.slice(i + 2, j), alts = [];
          let d = 0, from = 0;
          for (let k = 0; k < inner.length; k++) {
            const ch = inner[k];
            if (ch === '\\') k++;
            else if (ch === '(') d++;
            else if (ch === ')') d--;
            else if (ch === '|' && d === 0) {
              alts.push(inner.slice(from, k));
              from = k + 1;
            }
          }
          alts.push(inner.slice(from));
          const group = '(?:' + alts.map((a) => globSrc(a)).join('|') + ')';
          if (c === '!') {
            // anything but these: looked at together with what follows in the pattern
            const rest = globSrc(pat.slice(j + 1));
            return re + '(?!' + group + rest + '$)[\\s\\S]*' + rest;
          }
          re += group + (c === '?' ? '?' : c === '*' ? '*' : c === '+' ? '+' : '');
          i = j;
          continue;
        }
      }
      if (c === '*') re += '[\\s\\S]*';
      else if (c === '?') re += '[\\s\\S]';
      else if (c === '[') {
        // up to the ] that closes it: a ] straight after [ or [! is a character, [:name:] is a class of characters
        let j = i + 1;
        if (pat[j] === '!' || pat[j] === '^') j++;
        if (pat[j] === ']') j++;
        for (; j < pat.length && pat[j] !== ']'; j++) {
          if (pat[j] === '[' && pat[j + 1] === ':') {
            const e = pat.indexOf(':]', j + 2);
            if (e > 0) j = e + 1;
          } else if (pat[j] === '\\') j++;
        }
        if (j >= pat.length) re += '\\[';
        else {
          let cls = pat.slice(i + 1, j), neg = '';
          if (cls[0] === '!' || cls[0] === '^') {
            neg = '^';
            cls = cls.slice(1);
          }
          cls = cls.replace(/\[:(\w+):\]|\\([\s\S])|([\\\]\[^])/g, (m, name, esc, special) => (name ? (CLASSES[name] != null ? CLASSES[name] : '') : '\\' + (esc || special)));
          re += '[' + neg + cls + ']';
          i = j;
        }
      } else if (c === '\\' && i + 1 < pat.length) re += pat[++i].replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
      else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return re;
  }
  function globRe(pat, flags, noExt) {
    try {
      return new RegExp('^' + globSrc(pat, noExt) + '$', flags || '');
    } catch (e) {
      // (a range that runs backwards – [z-a], and the [i-1] of an unquoted "arr[i-1]": such a pattern matches nothing,
      // in bash too, and the word stays as it was written)
      return new RegExp('^(?!)$');
    }
  }

  function humanSize(n) {
    if (n < 1024) return n + '';
    const u = ['K', 'M', 'G', 'T'];
    let i = -1;
    do {
      n /= 1024;
      i++;
    } while (n >= 1024 && i < u.length - 1);
    return (n < 10 ? n.toFixed(1) : Math.round(n)) + u[i];
  }

  MG.VFS = VFS;
  MG.path = { norm: normPath, dirname, basename };
  MG.humanSize = humanSize;
  MG.globRe = globRe;
})();
