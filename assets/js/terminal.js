/* =====================================================================
   Browser terminal UI: prompt, history, tab completion, Ctrl+C,
   a files drawer, and a run() API for ▶ buttons in the tutorial.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { h, esc, bus, store } = MG;

  const MAX_LINES_PER_COMMAND = 3000;

  class TerminalUI {
    constructor(root, opts = {}) {
      this.root = root;
      this.opts = opts;
      this.fs = opts.fs;
      this.shell = new MG.Shell({ fs: this.fs, term: this, env: opts.env || {} });
      this.histIdx = null;
      this.pending = '';
      this.busy = false;
      this.cancelled = false;
      this.hostname = opts.hostname || 'genomics';
      this._build();
      const saved = store.get('termHistory', []);
      if (Array.isArray(saved)) this.shell.history = saved.slice(-200);
      this.fs.onChange(() => this._filesSoon());
      bus.on('conda:changed', () => this._renderPrompt());
      if (opts.welcome) this.note(opts.welcome);
      this._renderPrompt();
      this.renderFiles();
    }

    _build() {
      const r = this.root;
      r.classList.add('term');
      this.titleEl = h('span.term-title');
      this.filesBtn = h('button.tbtn', { type: 'button', title: 'Show or hide the files panel', html: MG.icon('folder') + '<span>Files</span>' });
      this.filesBtn.addEventListener('click', () => this.toggleFiles());
      const clearBtn = h('button.tbtn', { type: 'button', title: 'Clear the screen (Ctrl+L)', html: MG.icon('trash') + '<span>Clear</span>' });
      clearBtn.addEventListener('click', () => this.clear());
      const helpBtn = h('button.tbtn', { type: 'button', title: 'List the commands you can use', html: MG.icon('help') + '<span>Help</span>' });
      helpBtn.addEventListener('click', () => this.run('help'));
      this.statusEl = h('span.term-status');
      const bar = h('div.term-bar', h('span.term-dots', h('i'), h('i'), h('i')), this.titleEl, this.statusEl, h('span.grow'), helpBtn, clearBtn, this.filesBtn);
      this.screen = h('div.term-screen', { tabindex: '-1', role: 'log', 'aria-live': 'polite' });
      this.outEl = h('div.term-out');
      this.promptEl = h('span.term-prompt');
      this.input = h('input.term-input', { type: 'text', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Command line – type a command and press Enter' });
      this.inputLine = h('div.term-inputline', this.promptEl, this.input);
      this.screen.append(this.outEl, this.inputLine);
      this.filesEl = h('aside.term-files', { hidden: true });
      const body = h('div.term-body', this.screen, this.filesEl);
      r.append(bar, body);
      this.screen.addEventListener('mouseup', () => {
        const sel = window.getSelection();
        if (!sel || !String(sel)) this.input.focus({ preventScroll: true });
      });
      this.input.addEventListener('keydown', (e) => this._key(e));
      this.input.addEventListener('paste', (e) => {
        const t = (e.clipboardData || window.clipboardData).getData('text');
        if (t && t.includes('\n')) {
          e.preventDefault();
          const lines = t.split(/\r?\n/).filter((x) => x.trim());
          this._queue(lines);
        }
      });
      if (store.get('termFiles', false)) this.toggleFiles(true);
    }

    get cwdPretty() {
      return this.fs.pretty(this.fs.cwd);
    }
    _renderPrompt() {
      const env = MG.conda ? `<span class="penv">(${esc(MG.conda.active)})</span> ` : '';
      const p = `${env}<span class="pu">student@${esc(this.hostname)}</span>:<span class="pp">${esc(this.cwdPretty)}</span>$&nbsp;`;
      this.promptEl.innerHTML = p;
      this.titleEl.textContent = `student@${this.hostname}: ${this.cwdPretty}`;
    }
    focus() {
      this.input.focus({ preventScroll: true });
    }

    /* ---------------- output ---------------- */
    _append(cls, text) {
      if (this._lineBudget != null) {
        const n = (text.match(/\n/g) || []).length;
        if (this._lineBudget <= 0) {
          this._truncated = (this._truncated || 0) + n;
          return;
        }
        if (n > this._lineBudget) {
          const L = text.split('\n');
          const keep = L.slice(0, this._lineBudget).join('\n') + '\n';
          this._truncated = (this._truncated || 0) + (n - this._lineBudget);
          this._lineBudget = 0;
          text = keep;
        } else this._lineBudget -= n;
      }
      const last = this.outEl.lastElementChild;
      if (last && last.dataset.cls === cls && !last.classList.contains('cmdline') && last.textContent.length < 20000) last.textContent += text;
      else {
        const el = h('div.tl.' + cls);
        el.dataset.cls = cls;
        el.textContent = text;
        this.outEl.appendChild(el);
      }
      this._scroll();
    }
    out(text) {
      this._append('out', String(text));
    }
    err(text) {
      this._append('err', String(text));
    }
    /** coloured program output (Snakemake's log: yellow, green, red; hints) */
    colored(text, color) {
      const cls = { yellow: 'cy', green: 'cg', red: 'cr', hint: 'hint' }[color] || 'err';
      this._append(cls, String(text));
    }
    note(text) {
      const el = h('div.tl.note');
      el.dataset.cls = 'note';
      el.textContent = String(text).replace(/\n$/, '');
      this.outEl.appendChild(el);
      this._scroll();
    }
    html(html) {
      const el = h('div.tl.html', { html });
      el.dataset.cls = 'html';
      this.outEl.appendChild(el);
      this._scroll();
    }
    progress(text) {
      if (!this._progEl || !this._progEl.isConnected) {
        this._progEl = h('div.tl.out.progress');
        this._progEl.dataset.cls = 'progress';
        this.outEl.appendChild(this._progEl);
      }
      this._progEl.textContent = text;
      this._scroll();
    }
    endProgress() {
      this._progEl = null;
    }
    clear() {
      this.outEl.innerHTML = '';
    }
    _scroll() {
      this.screen.scrollTop = this.screen.scrollHeight;
    }
    get io() {
      return {
        out: (t) => this.out(t),
        err: (t) => this.err(t),
        colored: (t, c) => this.colored(t, c),
        note: (t) => this.note(t),
        html: (x) => this.html(x),
        progress: (t) => this.progress(t),
        clear: () => this.clear()
      };
    }

    /* ---------------- input ---------------- */
    _key(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.busy) return;
        const line = this.input.value;
        this.input.value = '';
        this.histIdx = null;
        this.exec(line);
        return;
      }
      if (e.key === 'c' && e.ctrlKey) {
        if (window.getSelection && String(window.getSelection())) return; // allow copy
        e.preventDefault();
        if (this.busy) {
          this.cancelled = true;
          this.note('Stop requested. The current WebAssembly tool must finish; later pipeline stages and queued commands will be skipped.');
          this._q=[];
        } else {
          this._echo(this.input.value + '^C');
          this.input.value = '';
        }
        return;
      }
      if (e.key === 'l' && e.ctrlKey) {
        e.preventDefault();
        this.clear();
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const H = this.shell.history;
        if (!H.length) return;
        if (this.histIdx == null) {
          this.pending = this.input.value;
          this.histIdx = H.length;
        }
        this.histIdx += e.key === 'ArrowUp' ? -1 : 1;
        this.histIdx = Math.max(0, Math.min(H.length, this.histIdx));
        this.input.value = this.histIdx === H.length ? this.pending : H[this.histIdx];
        setTimeout(() => this.input.setSelectionRange(this.input.value.length, this.input.value.length), 0);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        this._complete();
      }
    }
    _complete() {
      const v = this.input.value;
      const pos = this.input.selectionStart;
      const before = v.slice(0, pos);
      const m = /(\S*)$/.exec(before);
      const word = m ? m[1] : '';
      const isFirst = !before.slice(0, before.length - word.length).trim() || /[|;&]\s*$/.test(before.slice(0, before.length - word.length));
      let cands;
      if (isFirst) cands = Object.keys(MG.shellTools).concat(Object.keys(MG.shellBuiltins)).filter((c) => c.startsWith(word)).map((c) => c + ' ');
      else {
        const toks = before.trim().split(/\s+/);
        const tool = MG.shellTools[toks[0]];
        if (tool && tool.subcommands && toks.length === 2 && !before.endsWith(' ')) cands = tool.subcommands.filter((s) => s.startsWith(word)).map((s) => s + ' ');
        else cands = this.fs.complete(word).map((c) => (c.endsWith('/') ? c : c + ' '));
      }
      cands = Array.from(new Set(cands));
      if (!cands.length) return;
      if (cands.length === 1) {
        this.input.value = before.slice(0, before.length - word.length) + cands[0] + v.slice(pos);
      } else {
        const common = cands.reduce((a, b) => {
          let i = 0;
          while (i < a.length && i < b.length && a[i] === b[i]) i++;
          return a.slice(0, i);
        });
        if (common.length > word.length) this.input.value = before.slice(0, before.length - word.length) + common + v.slice(pos);
        else {
          this._echo(v);
          this.out(cands.map((c) => c.trim()).join('   ') + '\n');
        }
      }
    }
    _echo(line) {
      const el = h('div.tl.cmdline', { html: this.promptEl.innerHTML + esc(line) });
      el.dataset.cls = 'cmd';
      this.outEl.appendChild(el);
      this._scroll();
    }
    _queue(lines) {
      this._q = (this._q || []).concat(lines);
      if (!this.busy) this._drain();
    }
    async _drain() {
      while (this._q && this._q.length) {
        const l = this._q.shift();
        await this.exec(l);
      }
    }

    /** execute a line as if typed */
    /** run a command line as if typed. opts.agent: run by the real AI agent – its commands do not
        tick the student's tasks and do not offer "Ask the AI assistant" */
    async exec(line, opts = {}) {
      if(this.busy){this.note('The shared terminal is busy.');return 125;}
      this._echo(line);
      const first = this.outEl.children.length;
      if (!line.trim()) return 0;
      this.busy = true;
      this.cancelled = false;
      this.root.classList.add('busy');
      this.statusEl.innerHTML = '<span class="spinner small"></span> running…';
      this._lineBudget = MAX_LINES_PER_COMMAND;
      this._truncated = 0;
      let code = 0;
      const t0 = performance.now();
      try {
        code = await this.shell.run(line, this.io);
      } catch (e) {
        console.error(e);
        this.err(String(e && e.message ? e.message : e) + '\n');
        code = 1;
      } finally {
        this._lineBudget = null;
        if (this._truncated) this.note(`… ${MG.shellUtil.fmtN(this._truncated)} more lines omitted from the display. Use head to view fewer lines, or write the output to a file with >.`);
        this.endProgress();
        this.busy = false;
        this.root.classList.remove('busy');
        this.statusEl.textContent = code ? `exit ${code}` : 'done';
        this._renderPrompt();
        store.set('termHistory', this.shell.history.slice(-200));
        this.focus();
      }
      const argv = safeArgv(line);
      if (opts.agent) return code;
      bus.emit('term:command', { line: line.trim(), code, name: argv[0] || '', sub: argv[1] || '', ms: performance.now() - t0 });
      if (code && code !== 130 && this.opts.askAI !== false && MG.Assistant) this._offerAsk(line, first);
      return code;
    }
    /** after a failed command with an error message: a button that asks the AI assistant about it */
    _offerAsk(line, first) {
      const els = Array.from(this.outEl.children).slice(first);
      const errText = els.filter((e) => /\b(err|cr)\b/.test(e.className)).map((e) => e.textContent).join('');
      if (!errText.trim()) return;
      const all = els.map((e) => e.textContent + (e.classList.contains('note') ? '\n' : '')).join('');
      const b = h('button.term-ask', { type: 'button', title: 'Send this command and its error message to the AI assistant' }, '✦ Ask the AI assistant about this error');
      b.addEventListener('click', () => {
        b.disabled = true;
        if (MG.app.showWorkbench) MG.app.showWorkbench('assistant');
        setTimeout(() => bus.emit('term:ask', { line: line.trim(), output: all.slice(-6000), error: errText.slice(-4000), cwd: this.fs.cwd }), 60);
      });
      const row = h('div.tl.ask', b);
      row.dataset.cls = 'ask';
      this.outEl.appendChild(row);
      this._scroll();
    }

    /** type a command into the prompt (and optionally run it) – used by ▶ buttons */
    async type(line, run) {
      if (this.busy) {
        MG.toast('The terminal is still busy – wait for the current command to finish.', 'warn');
        return;
      }
      this.focus();
      this.input.value = '';
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce || line.length > 140) this.input.value = line;
      else {
        for (let i = 0; i < line.length; i++) {
          this.input.value += line[i];
          if (i % 3 === 0) await new Promise((r) => setTimeout(r, 8));
        }
      }
      if (run) {
        this.input.value = '';
        return this.exec(line);
      }
      this.input.classList.add('flash');
      setTimeout(() => this.input.classList.remove('flash'), 900);
      return null;
    }
    run(line) {
      return this.type(line, true);
    }

    /* ---------------- files drawer ---------------- */
    toggleFiles(on) {
      const show = on == null ? this.filesEl.hidden : on;
      this.filesEl.hidden = !show;
      this.filesBtn.classList.toggle('on', show);
      store.set('termFiles', show);
      if (show) this.renderFiles();
    }
    _filesSoon() {
      clearTimeout(this._ft);
      this._ft = setTimeout(() => this.renderFiles(), 120);
    }
    renderFiles() {
      if (this.filesEl.hidden) return;
      const el = this.filesEl;
      el.innerHTML = '';
      el.appendChild(h('div.tf-h', h('b', 'Files'), h('small', this.fs.pretty(this.fs.home))));
      const tree = h('div.tf-tree');
      const walk = (path, depth) => {
        this.fs.list(path).filter((c) => !c.name.startsWith('.') && !c.entry.hidden).forEach((c) => {
          const isDir = c.entry.kind === 'dir';
          const row = h('div.tf-row' + (isDir ? '.dir' : ''), { style: { paddingLeft: 6 + depth * 12 + 'px' }, title: c.path });
          row.appendChild(h('span.tf-ic', { html: MG.icon(isDir ? 'folder' : fileIcon(c.name)) }));
          row.appendChild(h('span.tf-name', c.name));
          if (!isDir) row.appendChild(h('small.tf-size', MG.humanSize(this.fs.size(c.entry))));
          if (c.entry.fresh && Date.now() - c.entry.mtime < 60000) row.classList.add('fresh');
          row.addEventListener('click', () => this._fileClick(c));
          tree.appendChild(row);
          if (isDir && depth < 4) walk(c.path, depth + 1);
        });
      };
      walk(this.fs.home, 0);
      el.appendChild(tree);
      el.appendChild(h('p.tf-hint', 'Click a file to see how to look at it.'));
    }
    _fileClick(c) {
      if (c.entry.kind === 'dir') {
        this.type('cd ' + this.fs.pretty(c.path).replace(/^~\//, '~/'));
        return;
      }
      const rel = relPath(this.fs.cwd, c.path);
      const n = c.name;
      let cmd;
      if (/\.(fastq|fq)\.gz$/.test(n)) cmd = `zcat ${rel} | head -n 8`;
      else if (/_fastqc\.html$/.test(n)) cmd = `open ${rel}`;
      else if (/\.bam$/.test(n)) cmd = `samtools view -H ${rel} | head`;
      else if (/\.vcf\.gz$/.test(n)) cmd = `bcftools view -H ${rel} | head`;
      else if (/\.(bai|csi|tbi|gzi|zip|amb|ann|bwt|pac|sa)$/.test(n)) cmd = `ls -lh ${rel}`;
      else cmd = `head ${rel}`;
      this.type(cmd);
    }
  }

  function fileIcon(n) {
    if (/\.(html)$/.test(n)) return 'image';
    if (/\.(bam|sam|cram)$/.test(n)) return 'layers';
    if (/\.(vcf|bcf)(\.gz)?$/.test(n)) return 'tag';
    return 'text';
  }
  function relPath(from, to) {
    if (to.startsWith(from + '/')) return to.slice(from.length + 1);
    const home = '/home/student';
    if (to.startsWith(home + '/')) return '~/' + to.slice(home.length + 1);
    return to;
  }
  function safeArgv(line) {
    try {
      const l = MG.shellUtil.parse(line, {});
      return l.length ? l[l.length - 1].pipeline[0].argv : [];
    } catch (e) {
      return line.trim().split(/\s+/);
    }
  }

  MG.TerminalUI = TerminalUI;
})();
