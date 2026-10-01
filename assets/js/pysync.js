/* =====================================================================
   The page's files and Python's files.

   The page's virtual file system (MG.app.fs) is the master copy: the
   terminal, the editor and the WebAssembly tools use it. Python (in its
   Web Worker) keeps a mirror of /home/student. Before Python runs, the
   files that changed are pushed to it; afterwards the files Python
   changed come back. Modification times travel with the files, because
   Snakemake compares them.

   MG.py.term('python' | 'smk', argv, ctx) runs a terminal command in
   Python; for Snakemake it also answers the engine's requests to run
   shell commands (the jobs) in the page's shell.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const HOME = '/home/student';
  const BINARY = /\.(gz|bgz|bam|bai|cram|crai|bcf|csi|tbi|png|jpe?g|gif|pdf|zip|xlsx?|pkl|npy|sqlite)$/i;

  const under = (p) => p === HOME || p.startsWith(HOME + '/');
  const fs = () => MG.app.fs;

  function looksText(bytes, path) {
    if (BINARY.test(path) || bytes.length > 4 * 1024 * 1024) return false;
    const n = Math.min(bytes.length, 8192);
    for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return true;
    } catch (e) {
      return false;
    }
  }

  const pysync = {
    sent: new Map(),
    reset() {
      this.sent.clear();
    },
    /** files that changed since Python last saw them -> {changes, transfer} */
    async collect() {
      const F = fs();
      const files = [], dirs = [], removed = [], transfer = [];
      for (const [p, e] of F.entries) {
        if (!under(p)) continue;
        const s = this.sent.get(p);
        if (e.kind === 'dir') {
          if (!s || s.e !== 'dir') {
            dirs.push(p);
            this.sent.set(p, { e: 'dir' });
          }
          continue;
        }
        if (e.kind === 'virtual') continue;
        if (s && s.e === e && s.m === e.mtime) continue;
        let bytes;
        try {
          bytes = await F.readBytes(p);
        } catch (err) {
          continue;
        }
        const copy = bytes.slice();
        transfer.push(copy.buffer);
        files.push({ path: p, bytes: copy.buffer, mtime: e.mtime || Date.now(), readonly: !!e.readonly });
        this.sent.set(p, { e, m: e.mtime });
      }
      for (const p of Array.from(this.sent.keys())) {
        if (!F.entries.has(p)) {
          removed.push(p);
          this.sent.delete(p);
        }
      }
      removed.sort((a, b) => b.length - a.length);
      dirs.sort((a, b) => a.length - b.length);
      return { changes: { files, dirs, removed }, transfer };
    },
    async push() {
      const K = MG.py.kernel();
      if (!K || K.state !== 'ready') return;
      const { changes, transfer } = await this.collect();
      if (changes.files.length || changes.dirs.length || changes.removed.length) K.worker.postMessage({ type: 'push', changes }, transfer);
    },
    /** files Python changed -> the page's file system */
    apply(ch) {
      if (!ch) return;
      const F = fs();
      for (const p of ch.removed || []) {
        if (F.exists(p)) F.remove(p);
        for (const k of Array.from(this.sent.keys())) if (k === p || k.startsWith(p + '/')) this.sent.delete(k);
      }
      for (const d of ch.dirs || []) {
        if (!F.isDir(d)) {
          if (F.exists(d)) F.remove(d);
          F.mkdirp(d);
        }
        this.sent.set(d, { e: 'dir' });
      }
      for (const f of ch.files || []) {
        const bytes = new Uint8Array(f.bytes);
        const entry = looksText(bytes, f.path)
          ? { kind: 'text', text: new TextDecoder().decode(bytes), mtime: f.mtime, fresh: true }
          : { kind: 'blob', blob: new Blob([bytes]), size: bytes.length, mtime: f.mtime, fresh: true };
        if (f.readonly) entry.readonly = true;
        const old = F.get(f.path);
        if (old && old.mode) entry.mode = old.mode;
        F.put(f.path, entry);
        const stored = F.get(f.path);
        this.sent.set(f.path, { e: stored, m: stored.mtime });
      }
      if ((ch.files || []).length || (ch.removed || []).length) MG.bus.emit('py:files', { files: (ch.files || []).map((f) => f.path), removed: ch.removed || [] });
    }
  };

  const py = {
    kernel() {
      return MG.app && MG.app.nb ? MG.app.nb.kernel : null;
    },
    get versions() {
      const K = this.kernel();
      return K && K.versions;
    },
    host() {
      const v = this.versions || {};
      return {
        exe: MG.conda.which('snakemake') || 'snakemake',
        platform: 'Linux-WebAssembly (Pyodide in your web browser)',
        host: MG.config.hostname || 'biolab',
        user: 'student',
        python: (v.python || '3.13') + ' (Pyodide)',
        cpus: Math.max(1, Math.min(8, navigator.hardwareConcurrency || 2)),
        hints: MG.store.get('smkHints', true)
      };
    },
    /** messages from the worker that are not about notebook cells */
    onExtra(m, K) {
      const p = K.pending.get(m.id);
      if (m.type === 'term-out') {
        if (p && p.onTermOut) p.onTermOut(m.chunks);
      } else if (m.type === 'smk-shell') {
        if (p && p.onShell) p.onShell(m);
        else K.worker.postMessage({ type: 'smk-shell-result', sid: m.sid, code: 1, changes: null });
      } else if (m.type === 'term-done') {
        pysync.apply(m.changes);
        if (p) {
          K.pending.delete(m.id);
          p.resolve(m.code);
        }
      } else if (m.type === 'fs-changes') pysync.apply(m.changes);
      else if (m.type === 'pushed') {
        if (p) {
          K.pending.delete(m.id);
          p.resolve();
        }
      }
    },
    /** run `python ARGS` or `snakemake ARGS` from the terminal; returns the exit status */
    async term(type, argv, ctx) {
      const K = this.kernel();
      if (!K) throw MG.shellUtil.userErr(`${type === 'smk' ? 'snakemake' : 'python'}: Python is not available on this page`);
      if (K.state !== 'ready') {
        ctx.io.note('Starting Python in your browser (the first time this downloads about 40 MB and takes 10–30 seconds)…');
        if (ctx.term && ctx.term.statusEl) ctx.term.statusEl.innerHTML = '<span class="spinner small"></span> starting Python…';
      }
      try {
        await K.ready();
      } catch (e) {
        throw MG.shellUtil.userErr('Python could not start: ' + e.message);
      }
      await pysync.push();
      const id = ++K.seq;
      const out = (text, stream, color) => {
        if (stream === 'out') ctx.out(text);
        else if (ctx.errc) ctx.errc(text, color);
        else ctx.err(text);
      };
      const cancelTimer = setInterval(() => {
        if (ctx.term && ctx.term.cancelled) K.worker.postMessage({ type: 'cancel', id });
      }, 200);
      if (ctx.term && ctx.term.statusEl) ctx.term.statusEl.innerHTML = `<span class="spinner small"></span> ${type === 'smk' ? 'snakemake' : 'python'} is running…`;
      const t0 = performance.now();
      try {
        const code = await new Promise((resolve, reject) => {
          K.pending.set(id, {
            resolve,
            reject,
            onTermOut: (chunks) => chunks.forEach((c) => out(c.text, c.stream, c.color)),
            onShell: async (m) => {
              let code = 1;
              try {
                pysync.apply(m.changes);
                const io = Object.assign({}, ctx.io, { out: ctx.out, err: ctx.err });
                MG.bus.emit('smk:job-shell', { cmd: m.cmd });
                code = await ctx.shell.exec(m.cmd, io, { errexit: true, pipefail: true, tools: m.tools || null });
              } catch (e) {
                ctx.err(String((e && e.message) || e) + '\n');
                code = 1;
              }
              const { changes, transfer } = await pysync.collect();
              K.worker.postMessage({ type: 'smk-shell-result', sid: m.sid, code, changes }, transfer);
            }
          });
          K.worker.postMessage({ type, id, argv, cwd: ctx.fs.cwd, host: this.host() });
        });
        MG.bus.emit(type === 'smk' ? 'smk:run' : 'py:script', { argv, code, ok: code === 0, secs: (performance.now() - t0) / 1000, cwd: ctx.fs.cwd });
        return code;
      } catch (e) {
        ctx.err(`${type === 'smk' ? 'snakemake' : 'python'}: ${e.message}\n`);
        return 1;
      } finally {
        clearInterval(cancelTimer);
      }
    }
  };

  MG.pysync = pysync;
  MG.py = py;
})();
