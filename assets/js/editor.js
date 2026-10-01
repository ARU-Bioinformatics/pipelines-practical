/* =====================================================================
   Files & editor: a file tree of /home/student, a code editor
   (CodeMirror, with Snakefile, Python, YAML, shell and Markdown
   highlighting) and a viewer for pictures, SVG, tables and HTML.
   Files are saved into the page's file system, so the terminal,
   Snakemake and Python see the change at once.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { h, esc, bus, store, toast } = MG;

  const SMK_KEYWORDS = ['rule', 'checkpoint', 'input', 'output', 'params', 'log', 'benchmark', 'threads', 'resources', 'conda', 'shell', 'run', 'script', 'message', 'wildcard_constraints', 'priority', 'container', 'default_target', 'localrule', 'retries', 'configfile', 'include', 'localrules', 'ruleorder', 'onsuccess', 'onerror', 'onstart', 'envmodules', 'notebook', 'wrapper'];
  const SMK_BUILTINS = ['expand', 'collect', 'temp', 'protected', 'directory', 'ancient', 'touch', 'glob_wildcards', 'multiext', 'unpack', 'config', 'rules', 'workflow', 'min_version', 'report'];

  function modeFor(path) {
    const n = path.split('/').pop();
    if (/^Snakefile$|\.smk$|^snakefile$/i.test(n)) return { name: 'python', extra_keywords: SMK_KEYWORDS, extra_builtins: SMK_BUILTINS, singleLineStringErrors: false };
    if (/\.py$/.test(n)) return { name: 'python', singleLineStringErrors: false };
    if (/\.ya?ml$/.test(n)) return 'yaml';
    if (/\.(sh|bash)$|^\.bashrc$/.test(n)) return 'shell';
    if (/\.(md|markdown)$/.test(n)) return 'markdown';
    return null;
  }
  const kindOf = (path) => {
    const n = path.toLowerCase();
    if (/\.(png|jpe?g|gif|webp)$/.test(n)) return 'image';
    if (/\.svg$/.test(n)) return 'svg';
    if (/\.html?$/.test(n)) return 'html';
    if (/\.(tsv|csv)$/.test(n)) return 'table';
    if (/\.(gz|bgz|bam|bai|cram|crai|bcf|csi|tbi|zip|pdf|pkl|npy|xlsx?)$/.test(n)) return 'binary';
    return 'text';
  };
  const ICON = (name, isDir) => {
    if (isDir) return 'folder';
    if (/\.(png|jpe?g|svg|gif)$/i.test(name)) return 'image';
    if (/\.(bam|sam|cram)$/i.test(name)) return 'layers';
    if (/\.(vcf|bcf)(\.gz)?$/i.test(name)) return 'tag';
    return 'text';
  };

  class Editor {
    constructor(root, opts) {
      this.root = root;
      this.fs = opts.fs;
      this.home = this.fs.home;
      this.open = new Map(); // path -> {doc, saved, cm-mode}
      this.current = null;
      this.expanded = new Set(store.get('edExpanded', []));
      this.showHidden = store.get('edHidden', false);
      this._build();
      this.fs.onChange((path, what) => this._fsChanged(path, what));
      this.renderTree();
      const last = store.get('edOpen', []);
      last.filter((p) => this.fs.exists(p)).forEach((p) => this._openText(p, { quiet: true }));
      const cur = store.get('edCurrent', null);
      if (cur && this.open.has(cur)) this.show(cur);
      else this._empty();
    }

    _build() {
      const R = this.root;
      R.classList.add('ed');
      const btn = (icon, label, title, fn) => {
        const b = h('button.tbtn', { type: 'button', title, html: MG.icon(icon) + (label ? '<span>' + esc(label) + '</span>' : '') });
        b.addEventListener('click', fn);
        return b;
      };
      this.tree = h('div.ed-tree', { role: 'tree', 'aria-label': 'Files' });
      const treeBar = h('div.ed-treebar',
        h('b', 'Files'),
        h('span.grow'),
        btn('plus', '', 'New file', () => this.newFile()),
        btn('folder', '', 'New folder', () => this.newFolder()),
        (this.hiddenBtn = btn('eye', '', 'Show hidden files (names starting with a dot, like .snakemake)', () => this.toggleHidden()))
      );
      this.hiddenBtn.classList.toggle('on', this.showHidden);
      this.side = h('aside.ed-side', treeBar, this.tree);
      this.tabs = h('div.ed-tabs', { role: 'tablist' });
      this.saveBtn = btn('save', 'Save', 'Save (Ctrl+S)', () => this.save());
      this.pathEl = h('span.ed-path');
      this.dlBtn = btn('download', '', 'Download this file', () => this.download());
      this.runBtn = btn('play', 'Run', '', () => this.runCurrent());
      this.runBtn.hidden = true;
      const bar = h('div.ed-bar', this.pathEl, h('span.grow'), this.runBtn, this.dlBtn, this.saveBtn);
      this.cmHost = h('div.ed-cm');
      this.view = h('div.ed-view', { hidden: true });
      this.emptyEl = h('div.ed-empty');
      this.main = h('section.ed-main', this.tabs, bar, this.cmHost, this.view, this.emptyEl);
      R.append(this.side, this.main);
      this.cm = window.CodeMirror(this.cmHost, {
        value: '',
        lineNumbers: true,
        indentUnit: 4,
        tabSize: 4,
        indentWithTabs: false,
        matchBrackets: true,
        autoCloseBrackets: true,
        viewportMargin: 30,
        extraKeys: {
          'Ctrl-S': () => this.save(),
          'Cmd-S': () => this.save(),
          Tab: (cm) => (cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('    ', 'end')),
          'Shift-Tab': (cm) => cm.indentSelection('subtract'),
          'Ctrl-/': 'toggleComment',
          'Cmd-/': 'toggleComment'
        }
      });
      this.cm.on('change', () => this._dirtyCheck());
      this.cmHost.hidden = true;
    }

    /* ---------------- tree ---------------- */
    toggleHidden() {
      this.showHidden = !this.showHidden;
      store.set('edHidden', this.showHidden);
      this.hiddenBtn.classList.toggle('on', this.showHidden);
      this.renderTree();
    }
    renderTree() {
      clearTimeout(this._rt);
      const el = this.tree;
      const keep = el.scrollTop;
      el.innerHTML = '';
      const walk = (path, depth) => {
        this.fs.list(path).filter((c) => this.showHidden || (!c.name.startsWith('.') && !c.entry.hidden)).sort((a, b) => (a.entry.kind === 'dir') === (b.entry.kind === 'dir') ? a.name.localeCompare(b.name) : a.entry.kind === 'dir' ? -1 : 1).forEach((c) => {
          const isDir = c.entry.kind === 'dir';
          const open = this.expanded.has(c.path);
          const row = h('div.ed-row' + (isDir ? '.dir' : '') + (c.path === this.current ? '.on' : ''), { role: 'treeitem', tabindex: '0', title: c.path, style: { paddingLeft: 6 + depth * 14 + 'px' }, 'aria-expanded': isDir ? String(open) : null });
          row.appendChild(h('span.ed-caret', isDir ? (open ? '▾' : '▸') : ''));
          row.appendChild(h('span.ed-ic', { html: MG.icon(ICON(c.name, isDir)) }));
          row.appendChild(h('span.ed-name', c.name));
          if (!isDir) row.appendChild(h('small.ed-size', MG.humanSize(this.fs.size(c.entry))));
          if (c.entry.readonly || c.entry.protected) row.appendChild(h('span.ed-lock', { title: 'read-only', html: MG.icon('lock') }));
          if (c.entry.fresh && Date.now() - (c.entry.mtime || 0) < 60000) row.classList.add('fresh');
          const act = () => {
            if (isDir) {
              if (open) this.expanded.delete(c.path);
              else this.expanded.add(c.path);
              store.set('edExpanded', Array.from(this.expanded));
              this.renderTree();
            } else this.openFile(c.path);
          };
          row.addEventListener('click', act);
          row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              act();
            }
          });
          row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this._menu(row, c);
          });
          el.appendChild(row);
          if (isDir && open) walk(c.path, depth + 1);
        });
      };
      walk(this.home, 0);
      if (!el.children.length) el.appendChild(h('p.muted.small', 'No files yet.'));
      el.scrollTop = keep;
    }
    _menu(row, c) {
      const items = [];
      if (c.entry.kind !== 'dir') {
        items.push(['text', 'Open', () => this.openFile(c.path)]);
        items.push(['download', 'Download', () => this.download(c.path)]);
      }
      items.push(['copy', 'Copy path', () => MG.copyText(c.path)]);
      if (!c.entry.protected) items.push(['trash', 'Delete', () => this.remove(c.path)]);
      MG.popmenu(row, items);
    }
    _fsChanged(path, what) {
      clearTimeout(this._rt);
      this._rt = setTimeout(() => this.renderTree(), 150);
      const o = this.open.get(path);
      if (!o) {
        if (what === 'rename' || what === 'write') this._refreshView(path);
        return;
      }
      if (what === 'remove') {
        o.gone = true;
        if (this.current === path) this._markGone();
        return;
      }
      if (what === 'write' || what === 'rename' || what === 'chmod') this._reloadFromFs(path);
    }

    /* ---------------- opening files ---------------- */
    async openFile(path, opts = {}) {
      const e = this.fs.get(path);
      if (!e) {
        if (opts.create) {
          this.fs.writeText(path, '');
          return this._openText(path, opts);
        }
        toast('No such file: ' + esc(path), 'error');
        return;
      }
      const k = kindOf(path);
      if (k === 'text') return this._openText(path, opts);
      return this.showView(path);
    }
    async _openText(path, opts = {}) {
      const e = this.fs.get(path);
      if (!e) return;
      let text = '';
      const size = this.fs.size(e);
      let truncated = false;
      try {
        text = await this.fs.readText(path);
      } catch (err) {
        if (!opts.quiet) toast('Could not read ' + esc(path), 'error');
        return;
      }
      if (size > 400000) {
        const L = text.split('\n');
        if (L.length > 400) {
          text = L.slice(0, 400).join('\n');
          truncated = true;
        }
      }
      const ro = !!(e.readonly || e.protected || truncated || !path.startsWith(this.home + '/'));
      let o = this.open.get(path);
      if (!o) {
        const doc = window.CodeMirror.Doc(text, modeFor(path));
        o = { doc, saved: text, ro, truncated, entry: e };
        this.open.set(path, o);
      } else if (!o.dirty) {
        o.saved = text;
        o.doc.setValue(text);
        o.dirty = false;
        o.ro = ro;
        o.entry = e;
      }
      this._persist();
      if (!opts.background) this.show(path, opts);
    }
    _persist() {
      store.set('edOpen', Array.from(this.open.keys()).filter((p) => p.startsWith(this.home + '/')));
      store.set('edCurrent', this.current);
    }
    show(path, opts = {}) {
      const o = this.open.get(path);
      if (!o) return;
      this.current = path;
      this.view.hidden = true;
      this.emptyEl.hidden = true;
      this.cmHost.hidden = false;
      this.cm.swapDoc(o.doc);
      this.cm.setOption('readOnly', o.ro);
      this.cm.setOption('mode', modeFor(path));
      this.saveBtn.hidden = o.ro;
      this.pathEl.innerHTML = esc(this.fs.pretty(path)) + (o.ro ? ' <span class="pill small">read-only' + (o.truncated ? ': first 400 lines' : '') + '</span>' : '');
      this._runBtnFor(path);
      this._renderTabs();
      this._persist();
      setTimeout(() => {
        this.cm.refresh();
        if (opts.line) {
          const ln = Math.max(0, opts.line - 1);
          this.cm.setCursor({ line: ln, ch: 0 });
          this.cm.scrollIntoView({ line: ln, ch: 0 }, 80);
          this.cm.addLineClass(ln, 'background', 'cm-flash');
          setTimeout(() => this.cm.removeLineClass(ln, 'background', 'cm-flash'), 2200);
        }
        if (!opts.noFocus) this.cm.focus();
      }, 20);
      this.renderTree();
      bus.emit('editor:open', { path, name: path.split('/').pop() });
    }
    _runBtnFor(path) {
      const n = path.split('/').pop();
      let label = null;
      if (/\.py$/.test(n)) label = 'Run with python';
      else if (/\.sh$/.test(n)) label = 'Run with bash';
      else if (/^Snakefile$/.test(n)) label = 'Dry-run (snakemake -n)';
      this.runBtn.hidden = !label;
      if (label) {
        this.runBtn.querySelector('span').textContent = label;
        this.runBtn.title = label + ' in the Terminal (saves the file first)';
      }
    }
    async runCurrent() {
      const p = this.current;
      if (!p) return;
      if (this.isDirty(p)) this.save();
      const n = p.split('/').pop();
      const dir = MG.path.dirname(p);
      const rel = (x) => (x.startsWith(MG.app.fs.cwd + '/') ? x.slice(MG.app.fs.cwd.length + 1) : x);
      let cmd;
      if (/\.py$/.test(n)) cmd = `python ${rel(p)}`;
      else if (/\.sh$/.test(n)) cmd = `bash ${rel(p)}`;
      else {
        const proj = /\/workflow$/.test(dir) ? MG.path.dirname(dir) : dir;
        cmd = MG.app.fs.cwd === proj ? 'snakemake -n' : `cd ${MG.app.fs.pretty(proj)} && snakemake -n`;
      }
      MG.app.showWorkbench('terminal');
      await MG.app.term.type(cmd, true);
    }
    _renderTabs() {
      this.tabs.innerHTML = '';
      for (const [p, o] of this.open) {
        const t = h('div.ed-tab' + (p === this.current ? '.on' : '') + (o.dirty ? '.dirty' : '') + (o.gone ? '.gone' : ''), { role: 'tab', title: p });
        const lab = h('button.ed-tab-l', { type: 'button' }, p.split('/').pop());
        lab.addEventListener('click', () => this.show(p));
        const x = h('button.ed-tab-x', { type: 'button', 'aria-label': 'Close ' + p.split('/').pop(), html: o.dirty ? '●' : '×' });
        x.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.close(p);
        });
        t.append(lab, x);
        this.tabs.appendChild(t);
      }
    }
    close(p) {
      const o = this.open.get(p);
      if (!o) return;
      if (o.dirty && !o.gone && !window.confirm(`${p.split('/').pop()} has unsaved changes. Close it and lose them?`)) return;
      this.open.delete(p);
      if (this.current === p) {
        const next = Array.from(this.open.keys()).pop();
        if (next) this.show(next);
        else this._empty();
      } else this._renderTabs();
      this._persist();
    }
    _empty() {
      this.current = null;
      this.cmHost.hidden = true;
      this.view.hidden = true;
      this.emptyEl.hidden = false;
      this.saveBtn.hidden = true;
      this.runBtn.hidden = true;
      this.pathEl.textContent = '';
      this.emptyEl.innerHTML = '<div class="ex-empty"><h3>No file open</h3><p>Click a file on the left, or open one from the Terminal with <code>nano FILE</code> (to edit) or <code>open FILE</code> (to look at pictures and tables).</p></div>';
      this._renderTabs();
      this._persist();
    }
    isDirty(p) {
      const o = this.open.get(p);
      return !!(o && o.dirty);
    }
    /** files with unsaved changes */
    dirtyPaths() {
      return Array.from(this.open.entries()).filter(([, o]) => o.dirty && !o.gone).map(([p]) => p);
    }
    /** add text at the end of a file (opening it), save it and highlight the new lines -> first new line number */
    async appendText(path, text) {
      if (!this.open.get(path)) await this.openFile(path, { create: true, noFocus: true });
      else this.show(path, { noFocus: true });
      const o = this.open.get(path);
      if (!o || o.ro) return 0;
      const doc = o.doc;
      const last = doc.lastLine();
      const tail = doc.getLine(last);
      const body = doc.getValue();
      const sep = !body.trim() ? '' : tail === '' ? (doc.getLine(Math.max(0, last - 1)) === '' ? '' : '\n') : '\n\n';
      const add = sep + text.replace(/\s+$/, '') + '\n';
      const first = last + (sep.match(/\n/g) || []).length + (tail === '' || !body.trim() ? 0 : 0);
      doc.replaceRange(add, { line: last, ch: tail.length });
      const n = text.replace(/\s+$/, '').split('\n').length;
      this.save();
      for (let i = first; i < first + n; i++) this.cm.addLineClass(i, 'background', 'cm-flash');
      setTimeout(() => {
        for (let i = first; i < first + n; i++) this.cm.removeLineClass(i, 'background', 'cm-flash');
      }, 2600);
      this.cm.scrollIntoView({ line: Math.min(doc.lastLine(), first + n), ch: 0 }, 60);
      return first + 1;
    }
    _dirtyCheck() {
      const o = this.open.get(this.current);
      if (!o) return;
      const d = o.doc.getValue() !== o.saved;
      if (d !== !!o.dirty) {
        o.dirty = d;
        this._renderTabs();
      }
    }
    save() {
      const p = this.current;
      const o = this.open.get(p);
      if (!o || o.ro) return;
      const text = o.doc.getValue();
      const old = this.fs.get(p);
      if (old && old.kind === 'dir') {
        toast('Cannot save: ' + esc(p) + ' is a folder', 'error');
        return;
      }
      if (!this.fs.isDir(MG.path.dirname(p))) this.fs.mkdirp(MG.path.dirname(p));
      o.saving = true;
      this.fs.writeText(p, text, old && old.mode ? { mode: old.mode } : {});
      o.saving = false;
      o.saved = text;
      o.dirty = false;
      o.gone = false;
      this._renderTabs();
      toast('Saved ' + esc(this.fs.pretty(p)), null, 1600);
      bus.emit('editor:save', { path: p, name: p.split('/').pop(), text });
    }
    async _reloadFromFs(p) {
      const o = this.open.get(p);
      if (!o || o.saving) return;
      const e = this.fs.get(p);
      if (!e || e === o.entry) return;
      o.entry = e;
      o.gone = false;
      if (e.kind === 'dir') return;
      let text;
      try {
        text = await this.fs.readText(p);
      } catch (err) {
        return;
      }
      if (text === o.saved) return;
      if (o.dirty) {
        o.conflict = true;
        if (this.current === p) toast(esc(p.split('/').pop()) + ' was changed on disk (for example by a command in the terminal). Your unsaved edits are kept – saving will overwrite the new version.', 'warn', 7000);
        return;
      }
      const cur = this.current === p ? this.cm.getCursor() : null;
      // record the saved text first: setValue fires the change handler, which compares with it
      o.saved = text;
      o.doc.setValue(text);
      o.dirty = false;
      if (cur) this.cm.setCursor(cur);
      this._renderTabs();
    }
    _markGone() {
      this.pathEl.innerHTML = esc(this.fs.pretty(this.current)) + ' <span class="pill small warn">deleted – Save to write it again</span>';
      this._renderTabs();
    }

    /* ---------------- viewer (pictures, SVG, tables, HTML) ---------------- */
    async showView(path) {
      const e = this.fs.get(path);
      if (!e) return;
      this.current = null;
      this.cmHost.hidden = true;
      this.emptyEl.hidden = true;
      this.view.hidden = false;
      this.saveBtn.hidden = true;
      this.runBtn.hidden = true;
      this.viewPath = path;
      this.pathEl.innerHTML = esc(this.fs.pretty(path)) + ` <span class="pill small">${esc(MG.humanSize(this.fs.size(e)))}B</span>`;
      this._renderTabs();
      await this._renderView(path);
      bus.emit('editor:view', { path, name: path.split('/').pop(), kind: kindOf(path) });
    }
    async _refreshView(path) {
      if (this.view.hidden || this.viewPath !== path) return;
      await this._renderView(path);
    }
    async _renderView(path) {
      const V = this.view;
      V.innerHTML = '';
      const k = kindOf(path);
      if (this._url) URL.revokeObjectURL(this._url);
      try {
        if (k === 'image') {
          const blob = await this.fs.toBlob(path);
          this._url = URL.createObjectURL(blob);
          V.appendChild(h('div.ed-img', h('img', { src: this._url, alt: path.split('/').pop() })));
        } else if (k === 'svg') {
          const text = await this.fs.readText(path);
          this._url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
          V.appendChild(h('div.ed-img.svg', h('img', { src: this._url, alt: path.split('/').pop() })));
          const edit = h('button.btn.small', { type: 'button' }, 'Show the SVG text');
          edit.addEventListener('click', () => this._openText(path));
          V.appendChild(h('p.ed-note', edit));
        } else if (k === 'html') {
          const text = await this.fs.readText(path);
          const fr = h('iframe.ed-frame', { sandbox: '', title: path.split('/').pop() });
          fr.srcdoc = text;
          V.appendChild(fr);
        } else if (k === 'table') {
          const text = await this.fs.readText(path);
          V.appendChild(tableView(text, /\.csv$/i.test(path) ? ',' : '\t'));
          const raw = h('button.btn.small', { type: 'button' }, 'Open as text');
          raw.addEventListener('click', () => this._openText(path));
          V.appendChild(h('p.ed-note', raw));
        } else {
          const n = path.split('/').pop();
          const rel = MG.app.fs.cwd && path.startsWith(MG.app.fs.cwd + '/') ? path.slice(MG.app.fs.cwd.length + 1) : this.fs.pretty(path);
          let tip = `ls -l ${rel}`;
          if (/\.vcf\.gz$/.test(n)) tip = `bcftools view -H ${rel} | head`;
          else if (/\.bam$/.test(n)) tip = `samtools view ${rel} | head -n 3`;
          else if (/\.gz$/.test(n)) tip = `zcat ${rel} | head`;
          const b = h('button.btn.small', { type: 'button' }, 'Run: ' + tip);
          b.addEventListener('click', () => {
            MG.app.showWorkbench('terminal');
            MG.app.term.type(tip, true);
          });
          V.appendChild(h('div.ex-empty', h('h3', 'A compressed or binary file'), h('p', `${n} is not plain text, so it cannot be shown here. Look inside it with a program in the Terminal:`), b));
        }
      } catch (err) {
        V.appendChild(h('p.muted', 'Could not show this file: ' + err.message));
      }
    }

    /* ---------------- file operations ---------------- */
    _baseDir() {
      const p = this.current || this.viewPath;
      if (p) return MG.path.dirname(p);
      return MG.app.fs.cwd.startsWith(this.home) ? MG.app.fs.cwd : this.home;
    }
    newFile() {
      const base = this.fs.pretty(this._baseDir());
      const name = window.prompt('Name of the new file (a path relative to your home folder ~ is fine):', (base === '~' ? '~/' : base + '/') + 'new_file.txt');
      if (!name) return;
      const abs = this.fs.resolve(name);
      if (!abs.startsWith(this.home + '/')) return toast('Files can only be made in your home folder.', 'warn');
      if (this.fs.exists(abs)) return this.openFile(abs);
      this.fs.mkdirp(MG.path.dirname(abs));
      this.fs.writeText(abs, '');
      this.expanded.add(MG.path.dirname(abs));
      this.openFile(abs);
    }
    newFolder() {
      const base = this.fs.pretty(this._baseDir());
      const name = window.prompt('Name of the new folder:', (base === '~' ? '~/' : base + '/') + 'new_folder');
      if (!name) return;
      const abs = this.fs.resolve(name);
      if (!abs.startsWith(this.home + '/')) return toast('Folders can only be made in your home folder.', 'warn');
      this.fs.mkdirp(abs);
      this.expanded.add(abs);
      this.renderTree();
    }
    remove(p) {
      const e = this.fs.get(p);
      if (!e) return;
      if (!window.confirm(`Delete ${this.fs.pretty(p)}${e.kind === 'dir' ? ' and everything in it' : ''}?`)) return;
      this.fs.remove(p);
      if (this.open.has(p)) {
        this.open.get(p).dirty = false;
        this.close(p);
      }
    }
    async download(p) {
      p = p || this.current || this.viewPath;
      if (!p) return;
      try {
        MG.downloadBlob(await this.fs.toBlob(p), p.split('/').pop());
      } catch (err) {
        toast(esc(err.message), 'error');
      }
    }
  }

  function tableView(text, sep) {
    const lines = text.split('\n').filter((l) => l.length);
    const rows = lines.slice(0, 501).map((l) => l.split(sep));
    const t = h('table.table.small.ed-table');
    rows.forEach((r, i) => {
      const tr = h('tr');
      r.forEach((c) => tr.appendChild(h(i === 0 ? 'th' : 'td', c)));
      t.appendChild(tr);
    });
    const box = h('div.ed-tablebox', t);
    if (lines.length > 501) box.appendChild(h('p.muted.small', `… first 500 of ${lines.length - 1} rows shown`));
    return box;
  }

  MG.Editor = Editor;
})();
