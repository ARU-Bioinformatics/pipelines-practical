/* =====================================================================
   The student's project: saved in this browser between visits, and
   downloadable as a .zip that runs on any computer with
   snakemake --cores 1 --use-conda.

   Saved: the files you write (Snakefile, config, environments, scripts,
   README, ...) and copies of the course data (as references). Not saved:
   what is inside results/, logs/ and .snakemake/ – it is made again by
   running the pipeline, which is rather the point of a pipeline.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { store, bus, toast, esc } = MG;
  const HOME = '/home/student';
  const SKIP = /^\/home\/student\/(?:[^/]+\/)*?(results|logs|benchmarks|\.snakemake|__pycache__)(\/|$)/;
  const KEEP_DIR = /\/(results|logs|benchmarks)$/;
  const MAX_TEXT = 300000;
  const MAX_TOTAL = 3500000;

  const project = {
    /** put the saved files back into the file system */
    restore(fs) {
      const saved = store.get('files', null);
      if (!saved || !Array.isArray(saved.entries)) return false;
      for (const e of saved.entries) {
        try {
          if (e.k === 'd') fs.mkdirp(e.p);
          else if (e.k === 't') fs.put(e.p, { kind: 'text', text: e.t, mtime: e.m, mode: e.x ? 'x' : undefined, readonly: e.r || undefined });
          else if (e.k === 'u') fs.put(e.p, { kind: 'url', url: new URL(e.u, location.href).href, size: e.s, mtime: e.m, readonly: e.r || undefined });
        } catch (err) {
          /* skip a bad entry */
        }
      }
      if (saved.cwd && fs.isDir(saved.cwd)) fs.cwd = saved.cwd;
      return true;
    },
    snapshot(fs) {
      const entries = [];
      let total = 0;
      let skipped = 0;
      for (const [p, e] of fs.entries) {
        if (!(p === HOME || p.startsWith(HOME + '/')) || p === HOME) continue;
        if (SKIP.test(p)) {
          /* keep the empty results/ and logs/ folders the student made, not what is in them */
          if (e.kind === 'dir' && KEEP_DIR.test(p) && !SKIP.test(p.replace(/\/[^/]+$/, ''))) entries.push({ k: 'd', p });
          continue;
        }
        if (e.kind === 'dir') entries.push({ k: 'd', p });
        else if (e.kind === 'text') {
          if (e.text.length > MAX_TEXT || total + e.text.length > MAX_TOTAL) {
            skipped++;
            continue;
          }
          total += e.text.length;
          entries.push({ k: 't', p, t: e.text, m: e.mtime, x: e.mode === 'x' ? 1 : 0, r: e.readonly ? 1 : 0 });
        } else if (e.kind === 'url') {
          entries.push({ k: 'u', p, u: e.url.replace(location.href.replace(/[^/]*$/, ''), ''), s: e.size, m: e.mtime, r: e.readonly ? 1 : 0 });
        } else skipped++;
      }
      return { entries, cwd: fs.cwd, skipped, saved: Date.now() };
    },
    save() {
      const fs = MG.app.fs;
      if (!fs) return;
      const snap = this.snapshot(fs);
      if (!store.set('files', snap)) {
        if (!this._warned) toast('Your browser storage is full, so your files could not be saved. Download your project to keep it.', 'warn', 8000);
        this._warned = true;
      }
    },
    watch(fs) {
      const soon = MG.debounce(() => this.save(), 800);
      fs.onChange(() => soon());
      window.addEventListener('beforeunload', () => this.save());
      setInterval(() => this.save(), 30000);
    },
    reset() {
      store.remove('files');
      store.remove('condaEnvs');
      store.remove('condaStack');
      store.remove('termHistory');
      store.remove('edOpen');
      store.remove('edCurrent');
      store.remove('galaxy');
    },

    /** a .zip of a folder (default: the project) */
    async zip(root, opts = {}) {
      const fs = MG.app.fs;
      if (!window.JSZip) await loadScript('assets/vendor/jszip/jszip.min.js');
      const zip = new window.JSZip();
      const top = root.split('/').pop();
      const skip = opts.skip || /(^|\/)(\.snakemake|__pycache__)(\/|$)/;
      let n = 0;
      for (const [p, e] of fs.entries) {
        if (!p.startsWith(root + '/')) continue;
        const rel = p.slice(root.length + 1);
        if (skip.test(rel) || (opts.only && !opts.only.test(rel))) continue;
        if (e.kind === 'dir') {
          zip.folder(top + '/' + rel);
          continue;
        }
        if (e.kind === 'virtual') continue;
        const bytes = await fs.readBytes(p);
        zip.file(top + '/' + rel, bytes, { date: new Date(e.mtime || Date.now()), unixPermissions: 0o100000 | (e.mode === 'x' ? (e.readonly ? 0o555 : 0o755) : e.readonly ? 0o444 : 0o644) });
        n++;
      }
      for (const [name, text] of Object.entries(opts.extra || {})) zip.file(top + '/' + name, text);
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' });
      return { blob, n };
    },
    async download(root, filename, opts) {
      const fs = MG.app.fs;
      if (!fs.isDir(root)) {
        toast(`There is no folder ${esc(fs.pretty(root))} yet.`, 'warn');
        return null;
      }
      const { blob, n } = await this.zip(root, opts);
      MG.downloadBlob(blob, filename);
      toast(`Saved <b>${esc(filename)}</b> (${n} files, ${MG.humanSize(blob.size)}B).`);
      bus.emit('project:download', { root, filename, files: n, size: blob.size });
      return blob;
    }
  };

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }
  MG.loadScript = loadScript;
  MG.project = project;
})();
