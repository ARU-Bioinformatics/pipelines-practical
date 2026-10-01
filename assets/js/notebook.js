/* =====================================================================
   A small Jupyter-style notebook: code cells (CodeMirror), a Python
   kernel in a Web Worker (py-worker.js, Pyodide), rich outputs (tables,
   plots, errors), and .ipynb download so work can continue in Jupyter.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { h, esc, bus, toast, store } = MG;

  /* ------------------------------------------------------------------
     the kernel
     ------------------------------------------------------------------ */
  class PyKernel {
    constructor(opts) {
      this.opts = opts;
      this.seq = 0;
      this.pending = new Map();
      this.state = 'off';
      this.versions = null;
      this.readyPromise = null;
      this.start();
    }
    start() {
      this.state = 'loading';
      this.worker = new Worker(this.opts.workerUrl);
      let resolveReady, rejectReady;
      this.readyPromise = new Promise((res, rej) => {
        resolveReady = res;
        rejectReady = rej;
      });
      this.readyPromise.catch(() => {});
      this._rejectReady = rejectReady;
      this.worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'status') {
          if (!m.id) this._status(m.text);
          const p = this.pending.get(m.id);
          if (p && p.onStatus) p.onStatus(m.text);
        } else if (m.type === 'ready') {
          this.state = 'ready';
          this.versions = m.versions;
          this._status(null);
          resolveReady(m.versions);
          bus.emit('nb:kernel', { state: 'ready' });
        } else if (m.type === 'background') {
          bus.emit('nb:kernel', { state: 'packages' });
        } else if (m.type === 'output') {
          const p = this.pending.get(m.id);
          if (p && p.onOutput) p.onOutput(JSON.parse(m.payload));
        } else if (m.type === 'done' || m.type === 'evalResult' || m.type === 'vars') {
          if (m.type === 'done' && m.changes && this.opts.onChanges) this.opts.onChanges(m.changes);
          const p = this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id);
            p.resolve(m.type === 'done' ? m : m.value);
          }
        } else if (['term-out', 'term-done', 'smk-shell', 'fs-changes', 'pushed'].includes(m.type)) {
          if (this.opts.onExtra) this.opts.onExtra(m, this);
        } else if (m.type === 'fatal') {
          if (m.stage === 'init') {
            this.state = 'failed';
            this._status('Python could not start: ' + m.message, true);
            rejectReady(new Error(m.message));
            bus.emit('nb:kernel', { state: 'failed', message: m.message });
          } else {
            const p = this.pending.get(m.id);
            if (p) {
              this.pending.delete(m.id);
              p.reject(new Error(m.message));
            }
          }
        }
      };
      this.worker.onerror = (e) => {
        this.state = 'failed';
        this._status('Python stopped unexpectedly: ' + (e.message || 'error'), true);
        rejectReady(new Error(e.message || 'worker error'));
        for (const p of this.pending.values()) p.reject(new Error('Python stopped unexpectedly'));
        this.pending.clear();
      };
      this.worker.postMessage({
        type: 'init',
        indexURL: this.opts.indexURL,
        preload: this.opts.preload,
        background: this.opts.background,
        files: this.opts.files,
        modules: this.opts.modules || [],
        wheels: this.opts.wheels || {}
      });
    }
    _status(text, bad) {
      if (this.opts.onStatus) this.opts.onStatus(text, bad);
    }
    ready() {
      return this.readyPromise;
    }
    _send(msg, handlers) {
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, Object.assign({ resolve, reject }, handlers || {}));
        this.worker.postMessage(Object.assign({ id }, msg));
      });
    }
    async run(code, handlers) {
      await this.ready();
      if (this.opts.beforeRun) await this.opts.beforeRun(this);
      return this._send({ type: 'run', code, cwd: this.opts.cwd ? this.opts.cwd() : null }, handlers);
    }
    async eval(expr) {
      await this.ready();
      return this._send({ type: 'eval', expr });
    }
    async vars() {
      await this.ready();
      return this._send({ type: 'vars' });
    }
    restart() {
      if (this.opts.onRestart) this.opts.onRestart();
      this.worker.terminate();
      for (const p of this.pending.values()) p.reject(new Error('Python was restarted'));
      this.pending.clear();
      // anything still waiting for the old Python to start must give up too
      if (this._rejectReady) this._rejectReady(new Error('Python was restarted'));
      this.start();
      bus.emit('nb:kernel', { state: 'restarted' });
    }
  }

  /* ------------------------------------------------------------------
     the notebook UI
     ------------------------------------------------------------------ */
  const uid = () => 'c' + Math.random().toString(36).slice(2, 9);

  /* HTML output (e.g. pandas tables) is sanitised before it is shown: code from an AI model
     or the internet could otherwise put scripts or look-alike page elements into the page. */
  const NUMERIC = /^[\s\-+−]*[\d.,]+(e[-+]?\d+)?\s*%?$|^(NaN|nan|None|True|False|–|-|inf|-inf)$/i;
  function htmlOutput(html) {
    if (!window.DOMPurify) return h('pre.nb-text', html);
    const box = h('div.nb-html', {
      html: window.DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe'], FORBID_ATTR: ['style'] })
    });
    // text cells (descriptions, names) read better left-aligned and wrapped
    box.querySelectorAll('td').forEach((td) => {
      if (!NUMERIC.test(td.textContent.trim())) td.classList.add('txt');
    });
    return box;
  }

  class Notebook {
    constructor(root, opts) {
      this.root = root;
      this.opts = opts;
      this.cells = [];
      this.count = 0;
      this.current = null;
      this.running = null;
      this.runQueue = Promise.resolve();
      this.gen = 0; // incremented by Restart: cells queued before it are dropped
      this._build();
      this.kernel = new PyKernel(Object.assign({}, opts.kernel, { onStatus: (t, bad) => this._kstatus(t, bad) }));
      this.kernel.ready().then(
        (v) => {
          this._kstatus(null);
          this.readyEl.innerHTML = `<span class="kdot ok"></span> Python ${esc(v.python)} ready`;
          this.readyEl.title = `pandas ${v.pandas} · numpy ${v.numpy} · matplotlib ${v.matplotlib} (running in your browser)`;
          bus.emit('nb:ready', v);
        },
        (e) => {
          if (this.kernel.state === 'failed') toast('Python could not start: ' + esc(e.message) + ' Check the internet connection, then reload the page.', 'error', 15000);
        }
      );
      const saved = store.get('nb', null);
      const restored = saved && Array.isArray(saved.cells) && saved.cells.length;
      if (restored) saved.cells.forEach((c) => this.addCell(c.source, { tag: c.tag, id: c.id, noSave: true }));
      else (opts.starter || []).forEach((c) => this.addCell(c.source, { tag: c.tag, noSave: true }));
      if (!this.cells.length) this.addCell('', { noSave: true });
      // a fresh notebook starts at the first cell; a restored one where the student left off
      this.select(restored ? this.cells[this.cells.length - 1] : this.cells[0], false);
    }

    _build() {
      const R = this.root;
      R.classList.add('nb');
      const btn = (icon, label, title, fn, cls) => {
        const b = h('button.tbtn' + (cls || ''), { type: 'button', title, html: MG.icon(icon) + (label ? '<span>' + esc(label) + '</span>' : '') });
        b.addEventListener('click', fn);
        return b;
      };
      this.readyEl = h('span.nb-kernel', { html: '<span class="kdot busy"></span> Starting Python…' });
      this.statusEl = h('span.nb-status');
      const bar = h(
        'div.nb-bar',
        btn('plus', 'Cell', 'Add a new code cell below the selected one', () => this.addCell('', { after: this.current, focus: true })),
        btn('play', 'Run', 'Run the selected cell (Shift+Enter)', () => this.current && this.runCell(this.current, { advance: true })),
        btn('fastforward', 'Run all', 'Run every cell from the top', () => this.runAll()),
        btn('reset', 'Restart', 'Restart Python: forget all variables (use this if a cell runs for too long)', () => this.restart()),
        h('span.grow'),
        this.statusEl,
        this.readyEl,
        btn('list', '', 'Variables: what Python currently remembers', (e) => this.showVars(e.currentTarget)),
        btn('download', '', 'Download the notebook', (e) =>
          MG.popmenu(e.currentTarget, [
            ['download', 'Jupyter notebook (.ipynb)', () => this.downloadIpynb()],
            ['code', 'Python script (.py)', () => this.downloadPy()],
            ...((this.opts.kernel && this.opts.kernel.files) || []).map((f) => ['table', 'Data file: ' + f.path.split('/').pop(), () => this.downloadData(f)]),
            ['folder', 'Open a notebook (.ipynb)…', () => this.openIpynb()],
            ['trash', 'Clear all outputs', () => this.cells.forEach((c) => this.clearOutput(c))],
            ['reset', 'Reset the notebook to the start', () => this.resetNotebook()]
          ])
        )
      );
      this.list = h('div.nb-cells');
      R.append(bar, this.list);
      this.list.addEventListener('click', (e) => {
        const c = this.cells.find((x) => x.el.contains(e.target));
        if (c) this.select(c, false);
      });
    }

    _kstatus(text, bad) {
      if (!text) {
        if (this.kernel && this.kernel.state === 'ready') return;
        return;
      }
      this.readyEl.innerHTML = `<span class="kdot ${bad ? 'bad' : 'busy'}"></span> ${esc(text)}`;
      this.readyEl.title = text;
    }

    /* ---------------- cells ---------------- */
    addCell(source, opts = {}) {
      const c = { id: opts.id || uid(), tag: opts.tag || null, outputs: [], count: null, el: null, cm: null };
      const runBtn = h('button.nb-runbtn', { type: 'button', title: 'Run this cell (Shift+Enter)', html: MG.icon('play') });
      runBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.select(c, false);
        this.runCell(c);
      });
      const countEl = h('span.nb-count', '[ ]');
      const edBox = h('div.nb-editor');
      const tools = h('div.nb-tools');
      const tb = (icon, title, fn, cls) => {
        const b = h('button.icon-btn' + (cls || ''), { type: 'button', title, html: MG.icon(icon) });
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          fn(e);
        });
        tools.appendChild(b);
        return b;
      };
      const ai = h('button.nb-ai', { type: 'button', title: 'Ask the AI assistant about this cell', html: MG.icon('sparkle') + '<span>Ask AI</span>' });
      ai.addEventListener('click', (e) => {
        e.stopPropagation();
        this.select(c, false);
        const items = [
          ['sparkle', 'Explain this code', () => bus.emit('nb:ask', { kind: 'explain', cell: this.cellInfo(c) })],
          ['sparkle', 'Improve or extend this code', () => bus.emit('nb:ask', { kind: 'improve', cell: this.cellInfo(c) })]
        ];
        if (c.outputs.some((o) => o.type === 'error')) items.unshift(['sparkle', 'Explain the error and fix it', () => bus.emit('nb:ask', { kind: 'fix', cell: this.cellInfo(c) })]);
        MG.popmenu(e.currentTarget, items);
      });
      tools.appendChild(ai);
      tb('dots', 'More: move, duplicate or delete this cell', (e) => {
        this.select(c, false);
        MG.popmenu(e.currentTarget, [
          ['arrowUp', 'Move up', () => this.move(c, -1)],
          ['arrowDown', 'Move down', () => this.move(c, 1)],
          ['plus', 'Add a cell below', () => this.addCell('', { after: c, focus: true })],
          ['copy', 'Duplicate', () => this.addCell(c.cm.getValue(), { after: c, focus: true })],
          ['trash', 'Delete cell', () => this.deleteCell(c)]
        ]);
      });
      const out = h('div.nb-out');
      c.el = h('div.nb-cell', { dataset: { id: c.id } }, h('div.nb-gutter', runBtn, countEl), h('div.nb-main', h('div.nb-edrow', edBox, tools), out));
      c.countEl = countEl;
      c.outEl = out;
      c.runBtn = runBtn;
      const idx = opts.after ? this.cells.indexOf(opts.after) + 1 : this.cells.length;
      const ref = this.cells[idx];
      this.cells.splice(idx, 0, c);
      this.list.insertBefore(c.el, ref ? ref.el : null);
      c.cm = window.CodeMirror(edBox, {
        value: source || '',
        mode: 'python',
        indentUnit: 4,
        tabSize: 4,
        lineWrapping: true,
        viewportMargin: Infinity,
        matchBrackets: true,
        autoCloseBrackets: true,
        screenReaderLabel: 'Python code cell',
        extraKeys: {
          // Escape leaves the editor (Tab is used for indenting, as in Jupyter)
          Esc: () => {
            c.cm.getInputField().blur();
            c.runBtn.focus();
          },
          'Shift-Enter': () => this.runCell(c, { advance: true }),
          'Ctrl-Enter': () => this.runCell(c),
          'Cmd-Enter': () => this.runCell(c),
          'Alt-Enter': () => this.runCell(c, { insert: true }),
          'Ctrl-/': 'toggleComment',
          'Cmd-/': 'toggleComment',
          Tab: (cm) => (cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('    ', 'end')),
          'Shift-Tab': (cm) => cm.indentSelection('subtract')
        }
      });
      c.cm.on('focus', () => this.select(c, false));
      c.cm.on('change', () => this._saveSoon());
      if (opts.focus) setTimeout(() => this.select(c, true), 0);
      if (!opts.noSave) this._saveSoon();
      bus.emit('nb:cells', { n: this.cells.length });
      return c;
    }
    cellInfo(c) {
      const err = c.outputs.find((o) => o.type === 'error');
      const text = c.outputs
        .filter((o) => o.type === 'stream' || (o.type === 'display' && o.mime === 'text/plain'))
        .map((o) => o.text || o.data)
        .join('')
        .slice(0, 1500);
      return { id: c.id, tag: c.tag, code: c.cm.getValue(), count: c.count, error: err ? { ename: err.ename, evalue: err.evalue, traceback: err.traceback, hints: err.hints } : null, output: text, hasPlot: c.outputs.some((o) => o.mime === 'image/png'), hasTable: c.outputs.some((o) => o.mime === 'text/html') };
    }
    select(c, focus) {
      if (this.current && this.current !== c) this.current.el.classList.remove('sel');
      this.current = c;
      c.el.classList.add('sel');
      if (focus) {
        c.cm.focus();
        c.el.scrollIntoView({ block: 'nearest' });
      }
    }
    move(c, d) {
      const i = this.cells.indexOf(c);
      const j = i + d;
      if (j < 0 || j >= this.cells.length) return;
      this.cells.splice(i, 1);
      this.cells.splice(j, 0, c);
      const ref = this.cells[j + 1];
      this.list.insertBefore(c.el, ref ? ref.el : null);
      c.cm.refresh();
      this._saveSoon();
    }
    deleteCell(c) {
      if (this.cells.length === 1) {
        c.cm.setValue('');
        this.clearOutput(c);
        return;
      }
      const i = this.cells.indexOf(c);
      this.cells.splice(i, 1);
      c.el.remove();
      this.select(this.cells[Math.min(i, this.cells.length - 1)], false);
      this._saveSoon();
      toast('Cell deleted.', null, 1800);
    }
    clearOutput(c) {
      c.outputs = [];
      c.outEl.innerHTML = '';
      c.el.classList.remove('has-error');
    }
    findByTag(tag) {
      return this.cells.find((c) => c.tag === tag) || null;
    }

    /* ---------------- running ---------------- */
    runCell(c, opts = {}) {
      if (opts.advance) {
        const i = this.cells.indexOf(c);
        const next = this.cells[i + 1] || this.addCell('', { after: c });
        setTimeout(() => this.select(next, true), 0);
      } else if (opts.insert) {
        const n = this.addCell('', { after: c });
        setTimeout(() => this.select(n, true), 0);
      }
      const gen = this.gen;
      c.queued = true;
      if (!c.el.classList.contains('running')) c.countEl.textContent = '[…]';
      const p = (this.runQueue = this.runQueue.then(() => this._run(c, gen)).catch(() => {}));
      return p;
    }
    async _run(c, gen) {
      c.queued = false;
      if (gen !== this.gen) {
        c.countEl.textContent = c.count ? `[${c.count}]` : '[ ]';
        return;
      }
      if (!this.cells.includes(c)) return;
      const code = c.cm.getValue();
      const chapter = MG.app && MG.app.currentChapter ? MG.app.currentChapter() : '';
      this.clearOutput(c);
      c.el.classList.add('running');
      c.countEl.textContent = '[*]';
      this.running = c;
      this.statusEl.textContent = '';
      const t0 = performance.now();
      const timer = setInterval(() => {
        const s = Math.round((performance.now() - t0) / 1000);
        if (this.kernel.state !== 'ready') this.statusEl.innerHTML = `<span class="spinner small"></span> waiting for Python to start… ${s} s`;
        else if (s >= 2) this.statusEl.innerHTML = `<span class="spinner small"></span> running… ${s} s`;
      }, 500);
      if (this.kernel.state !== 'ready') this.statusEl.innerHTML = '<span class="spinner small"></span> waiting for Python to start…';
      let res = null;
      try {
        res = await this.kernel.run(code, {
          onOutput: (o) => this._append(c, o),
          onStatus: (t) => (this.statusEl.innerHTML = `<span class="spinner small"></span> ${esc(t)}`)
        });
      } catch (e) {
        this._append(c, { type: 'error', ename: 'Stopped', evalue: e.message, traceback: e.message, hints: [] });
      } finally {
        clearInterval(timer);
      }
      this.running = null;
      c.el.classList.remove('running');
      this.count++;
      c.count = this.count;
      c.countEl.textContent = `[${this.count}]`;
      const secs = (performance.now() - t0) / 1000;
      this.statusEl.textContent = secs > 3 ? `last cell took ${secs.toFixed(1)} s` : '';
      const err = c.outputs.find((o) => o.type === 'error');
      bus.emit('nb:run', {
        id: c.id,
        _chapter: chapter,
        tag: c.tag || '',
        code,
        ok: !!(res && res.ok),
        error: err ? err.ename : '',
        plot: c.outputs.some((o) => o.mime === 'image/png'),
        table: c.outputs.some((o) => o.mime === 'text/html'),
        text: c.outputs.filter((o) => o.type === 'stream' || o.mime === 'text/plain').map((o) => o.text || o.data).join('').slice(0, 4000)
      });
    }
    runAll() {
      this.cells.forEach((c) => this.runCell(c));
      return this.runQueue;
    }
    restart() {
      this.gen++;
      this.kernel.restart();
      this.count = 0;
      this.cells.forEach((c) => {
        c.count = null;
        c.countEl.textContent = '[ ]';
      });
      this.readyEl.innerHTML = '<span class="kdot busy"></span> Restarting Python…';
      this.kernel.ready().then(
        (v) => {
          this.readyEl.innerHTML = `<span class="kdot ok"></span> Python ${esc(v.python)} ready`;
          toast('Python restarted – all variables are forgotten. Run your cells again from the top.');
        },
        () => {}
      );
    }

    /* ---------------- outputs ---------------- */
    _append(c, o) {
      // print() arrives in pieces: keep consecutive text of the same stream together
      const prev = c.outputs[c.outputs.length - 1];
      if (o.type === 'stream' && prev && prev.type === 'stream' && prev.name === o.name) prev.text += o.text;
      else c.outputs.push(o.type === 'stream' ? Object.assign({}, o) : o);
      const box = c.outEl;
      if (o.type === 'stream') {
        const last = box.lastElementChild;
        if (last && last.classList.contains('nb-stream') && last.dataset.name === o.name) last.appendChild(document.createTextNode(o.text));
        else box.appendChild(h('pre.nb-stream' + (o.name === 'stderr' ? '.err' : ''), { dataset: { name: o.name } }, o.text));
      } else if (o.type === 'display') {
        if (o.mime === 'image/png') {
          const img = h('img.nb-img', { src: 'data:image/png;base64,' + o.data, alt: 'Plot' });
          const dl = h('button.icon-btn.nb-imgdl', { type: 'button', title: 'Save this plot as a PNG image', html: MG.icon('download') });
          dl.addEventListener('click', () => {
            const a = h('a', { href: img.src, download: 'plot.png' });
            document.body.appendChild(a);
            a.click();
            a.remove();
          });
          box.appendChild(h('div.nb-figure', img, dl));
        } else if (o.mime === 'text/html') box.appendChild(htmlOutput(o.data));
        else box.appendChild(h('pre.nb-text', o.data));
      } else if (o.type === 'error') {
        c.el.classList.add('has-error');
        const fix = h('button.btn.small.nb-fix', { type: 'button', html: MG.icon('sparkle') + '<span>Ask the AI to explain this error</span>' });
        fix.addEventListener('click', () => bus.emit('nb:ask', { kind: 'fix', cell: this.cellInfo(c) }));
        const hints = (o.hints || []).map((t) => h('div.nb-hint', '💡 ' + t));
        box.appendChild(h('div.nb-error', h('pre', o.traceback || o.ename + ': ' + o.evalue), hints, h('div.nb-err-actions', fix)));
      }
    }

    /* ---------------- saving ---------------- */
    _saveSoon() {
      clearTimeout(this._st);
      this._st = setTimeout(() => this.saveNow(), 400);
    }
    saveNow() {
      clearTimeout(this._st);
      store.set('nb', { cells: this.cells.map((c) => ({ id: c.id, tag: c.tag, source: c.cm.getValue() })) });
    }
    resetNotebook() {
      const m = MG.modal('Reset the notebook?', '<p>This replaces all your cells with the starting notebook. Download your notebook first if you want to keep it.</p><div class="prompt-actions"><button class="btn" data-x="no" type="button">Cancel</button><button class="btn primary" data-x="yes" type="button">Reset</button></div>');
      m.box.querySelector('[data-x="no"]').addEventListener('click', () => m.close());
      m.box.querySelector('[data-x="yes"]').addEventListener('click', () => {
        m.close();
        this.cells.forEach((c) => c.el.remove());
        this.cells = [];
        (this.opts.starter || []).forEach((c) => this.addCell(c.source, { tag: c.tag, noSave: true }));
        if (!this.cells.length) this.addCell('', { noSave: true });
        this.select(this.cells[0], false);
        this._saveSoon();
      });
    }
    toIpynb() {
      const cells = this.cells.map((c) => ({
        id: c.id,
        cell_type: 'code',
        execution_count: c.count,
        metadata: c.tag ? { tags: [c.tag] } : {},
        source: c.cm.getValue().split(/(?<=\n)/),
        outputs: c.outputs
          .map((o) => {
            if (o.type === 'stream') return { output_type: 'stream', name: o.name, text: o.text.split(/(?<=\n)/) };
            if (o.type === 'error') return { output_type: 'error', ename: o.ename, evalue: o.evalue, traceback: (o.traceback || '').split('\n') };
            if (o.type === 'display') {
              const data = {};
              data[o.mime] = o.mime === 'image/png' ? o.data : o.data.split(/(?<=\n)/);
              if (o.mime !== 'text/plain') data['text/plain'] = [o.mime === 'image/png' ? '<Figure>' : '<table>'];
              return { output_type: 'display_data', data, metadata: {} };
            }
            return null;
          })
          .filter(Boolean)
      }));
      return {
        cells,
        metadata: {
          kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
          language_info: { name: 'python', version: this.kernel.versions ? this.kernel.versions.python : '3' },
          notebook_origin: 'Yeast, data and AI practical (in-browser notebook)'
        },
        nbformat: 4,
        nbformat_minor: 5
      };
    }
    downloadIpynb() {
      MG.downloadText(JSON.stringify(this.toIpynb(), null, 1), (this.opts.fileStem || 'notebook') + '.ipynb', 'application/x-ipynb+json');
      toast('Saved the notebook. It opens in Jupyter, JupyterLab, VS Code or Google Colab. To run it there, also download the data files (same menu) into a folder called data next to it.', null, 7000);
    }
    downloadData(f) {
      const a = h('a', { href: f.url, download: f.path.split('/').pop() });
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    downloadPy() {
      const src = this.cells.map((c, i) => `# %% Cell ${i + 1}\n${c.cm.getValue()}\n`).join('\n');
      MG.downloadText(src, (this.opts.fileStem || 'notebook') + '.py', 'text/x-python');
    }
    openIpynb() {
      const inp = h('input', { type: 'file', accept: '.ipynb,application/json', style: { display: 'none' } });
      document.body.appendChild(inp);
      inp.addEventListener('change', async () => {
        const f = inp.files[0];
        inp.remove();
        if (!f) return;
        let cells;
        try {
          const nb = JSON.parse(await f.text());
          const src = (x) => (Array.isArray(x.source) ? x.source.join('') : x.source || '');
          // text (markdown) cells are kept as comments, so nothing is lost
          cells = (nb.cells || [])
            .filter((x) => x.cell_type === 'code' || x.cell_type === 'markdown' || x.cell_type === 'raw')
            .map((x) => ({
              source: x.cell_type === 'code' ? src(x) : src(x).split('\n').map((l) => '# ' + l).join('\n'),
              tag: (x.metadata && Array.isArray(x.metadata.tags) && x.metadata.tags[0]) || null
            }));
          if (!cells.length) throw new Error('no cells');
        } catch (e) {
          toast('That file is not a notebook this page can read.', 'error');
          return;
        }
        const replace = () => {
          this.cells.forEach((c) => c.el.remove());
          this.cells = [];
          cells.forEach((c) => this.addCell(c.source, { tag: c.tag, noSave: true }));
          this.select(this.cells[this.cells.length - 1], false);
          this._saveSoon();
          toast(`Opened ${esc(f.name)} (${cells.length} cells). Run the cells to recreate the results.`);
        };
        const m = MG.modal('Open this notebook?', `<p>This replaces the cells in your notebook with the ${cells.length} cells of <b>${esc(f.name)}</b>. Download your current notebook first if you want to keep it.</p><div class="prompt-actions"><button class="btn" data-x="no" type="button">Cancel</button><button class="btn primary" data-x="yes" type="button">Open</button></div>`);
        m.box.querySelector('[data-x="no"]').addEventListener('click', () => m.close());
        m.box.querySelector('[data-x="yes"]').addEventListener('click', () => {
          m.close();
          replace();
        });
      });
      inp.click();
    }
    async showVars(anchor) {
      let vars = [];
      try {
        vars = await this.kernel.vars();
      } catch (e) {
        vars = [];
      }
      const rows = vars.length ? vars.map((v) => `<tr><td><code>${esc(v.name)}</code></td><td>${esc(v.type)}</td><td>${esc(v.desc)}</td></tr>`).join('') : '<tr><td colspan="3" class="muted">Nothing yet – run a cell that creates a variable (e.g. <code>df = …</code>).</td></tr>';
      MG.modal('What Python remembers', `<p class="muted small">Variables created by the cells you have run, in this session.</p><table class="table small"><tr><th>Name</th><th>Type</th><th>Contents</th></tr>${rows}</table>`);
      void anchor;
    }

    /* ---------------- API for the tutorial and the assistant ---------------- */
    insertCode(code, opts = {}) {
      // new code goes at the end of the notebook (it usually builds on everything above)
      const after = opts.after || this.cells[this.cells.length - 1];
      let c;
      if (opts.replaceEmpty !== false && after && !after.cm.getValue().trim() && !after.outputs.length) {
        c = after;
        c.cm.setValue(code);
      } else c = this.addCell(code, { after, tag: opts.tag });
      if (opts.tag) c.tag = opts.tag;
      this.select(c, false);
      setTimeout(() => {
        c.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        c.el.classList.add('flash');
        setTimeout(() => c.el.classList.remove('flash'), 1400);
        c.cm.refresh();
      }, 50);
      this._saveSoon();
      if (opts.run) return this.runCell(c).then(() => c);
      return Promise.resolve(c);
    }
    codeContext(maxChars = 5000) {
      const parts = this.cells.map((c, i) => `# cell ${i + 1}${c.count ? ` [ran as ${c.count}]` : ''}\n${c.cm.getValue().trim()}`).filter((s) => s.split('\n').length > 1 || s.length > 12);
      let s = parts.join('\n\n');
      if (s.length > maxChars) s = '…\n' + s.slice(-maxChars);
      return s;
    }
  }

  MG.PyKernel = PyKernel;
  MG.Notebook = Notebook;
})();
