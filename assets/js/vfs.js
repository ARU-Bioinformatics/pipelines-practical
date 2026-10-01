/* =====================================================================
   Virtual file system used by the browser terminal and workflow engine.

   Entry kinds
     dir      – a directory
     text     – a small text file held in memory       { text }
     virtual  – a large simulated file (no real bytes)  { meta: {size, lines, kind, head(), ...} }
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
    mkdirp(p) {
      const abs = this.resolve(p);
      const parts = abs.split('/').filter(Boolean);
      let cur = '';
      parts.forEach((seg) => {
        cur += '/' + seg;
        if (this.entries.has(cur)&&this.entries.get(cur).kind!=='dir')throw new Error(`${cur}: Not a directory`);
        if (!this.entries.has(cur)) {
          this.entries.set(cur, { kind: 'dir', mtime: Date.now() });
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
      if (e.kind === 'text') {
        e.text = e.text == null ? '' : String(e.text);
        e.size = new Blob([e.text]).size;
        e.dirty = true;
      }
      this.entries.set(abs, e);
      this._changed(abs, 'write');
      return abs;
    }
    writeText(p, text, extra) {
      return this.put(p, Object.assign({ kind: 'text', text }, extra || {}));
    }
    appendText(p, text) {
      const e = this.get(p);
      if (e && e.kind === 'text') return this.writeText(p, e.text + text, { mode: e.mode });
      return this.writeText(p, text);
    }
    remove(p) {
      const abs = this.resolve(p);
      const e = this.entries.get(abs);
      if (!e) return false;
      if (e.kind === 'dir') {
        for (const k of Array.from(this.entries.keys())) if (k === abs || k.startsWith(abs + '/')) this.entries.delete(k);
      } else this.entries.delete(abs);
      this._changed(abs, 'remove');
      return true;
    }
    rename(a, b) {
      const A = this.resolve(a), B = this.resolve(b);
      const e = this.entries.get(A);
      if (!e) return false;
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
      this._changed(A, 'remove');
      this._changed(B, 'rename');
      return true;
    }
    /** update the modification time (touch) */
    touch(p) {
      const abs = this.resolve(p);
      const e = this.entries.get(abs);
      if (!e) return this.writeText(abs, '');
      const n = Object.assign({}, e, { mtime: Date.now() });
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
      this.entries.set(abs, n);
      this._changed(abs, 'chmod');
      return true;
    }
    copy(a, b) {
      const e = this.get(a);
      if (!e || e.kind === 'dir') return false;
      // a copy belongs to you: course-data protection is not copied (a read-only file of yours stays read-only, as with cp)
      const n = Object.assign({}, e, { mtime: Date.now() });
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
      return out.sort((x, y) => x.name.localeCompare(y.name));
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
    /** simple glob expansion for * and ? within one directory level */
    glob(pattern) {
      if (!/[*?]/.test(pattern)) return [pattern];
      const dirPart = pattern.includes('/') ? pattern.slice(0, pattern.lastIndexOf('/') + 1) : '';
      const namePart = pattern.slice(dirPart.length);
      if (/[*?]/.test(dirPart)) return [pattern];
      const re = new RegExp('^' + namePart.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      const dirAbs = this.resolve(dirPart || '.');
      if (!this.isDir(dirAbs)) return [pattern];
      const hits = this.list(dirAbs).filter((c) => re.test(c.name) && !c.name.startsWith('.')).map((c) => dirPart + c.name);
      return hits.length ? hits : [pattern];
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
})();
