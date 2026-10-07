/* =====================================================================
   Browser terminal UI: prompt, history, tab completion, Ctrl+C,
   a files drawer, and a run() API for ▶ buttons in the tutorial.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { h, esc, bus, store } = MG;

  // Of what one command prints, the terminal shows at most 3,000 lines: the first 2,000 and the last 1,000 (the end of
  // a long output is where a script prints its result – and the end is what an AI agent is sent of it).
  const HEAD_LINES = 2000, TAIL_LINES = 1000;

  /** The file system as the shell of one command sees it: the same files, and every path that is worked out through
      it (resolve – which all the reading and writing goes through) is added to `log`. `__real` is the file system
      itself, for code that looks at all files and not at the ones a command names (tools-wasm.js). */
  function watched(fs, log) {
    const resolve = function (p, cwd) {
      const abs = fs.resolve(p, cwd);
      log.add(abs);
      return abs;
    };
    return new Proxy(fs, {
      get: (t, k) => (k === 'resolve' ? resolve : k === '__real' ? t : t[k]),
      set: (t, k, v) => {
        t[k] = v;
        return true;
      }
    });
  }
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
          this._queue(t.replace(/\r/g, '').replace(/\n+$/, '').split('\n'));
        }
      });
      if (store.get('termFiles', false)) this.toggleFiles(true);
    }

    get cwdPretty() {
      return this.fs.pretty(this.fs.cwd);
    }
    _renderPrompt() {
      // "> " while a command is not complete yet (an open quote, a for … without its done)
      // (in front of the prompt: what the page puts there – the active conda environment)
      const pre = MG.shellHooks && MG.shellHooks.promptPrefix ? MG.shellHooks.promptPrefix() : '';
      const p = this._more != null ? '<span class="pc">&gt;</span>&nbsp;' : `${pre}<span class="pu">student@${esc(this.hostname)}</span>:<span class="pp">${esc(this.cwdPretty)}</span>$&nbsp;`;
      this.promptEl.innerHTML = p;
      this.titleEl.textContent = `student@${this.hostname}: ${this.cwdPretty}`;
    }
    focus() {
      this.input.focus({ preventScroll: true });
    }

    /* ---------------- output ---------------- */
    /** what comes after the first HEAD_LINES lines of a command is held back: the last TAIL_LINES lines of it are
        shown when the command has ended (see exec), the lines between are counted (_truncated) */
    _hold(cls, text) {
      const T = this._tail || (this._tail = []);
      const last = T[T.length - 1];
      if (last && last.cls === cls) last.text += text;
      else T.push({ cls, text });
      this._tailLines = (this._tailLines || 0) + (text.match(/\n/g) || []).length;
      // (cut at the front, in large pieces: not for every line that arrives)
      if (this._tailLines > TAIL_LINES * 2) {
        let drop = this._tailLines - TAIL_LINES;
        this._truncated = (this._truncated || 0) + drop;
        this._tailLines -= drop;
        while (drop > 0 && T.length) {
          const p = T[0], n = (p.text.match(/\n/g) || []).length;
          if (n <= drop && T.length > 1) {
            T.shift();
            drop -= n;
          } else {
            let at = 0;
            for (let k = 0; k < drop; k++) at = p.text.indexOf('\n', at) + 1;
            p.text = p.text.slice(at);
            drop = 0;
          }
        }
      }
    }
    _append(cls, text) {
      if (this._lineBudget != null) {
        const n = (text.match(/\n/g) || []).length;
        if (this._lineBudget <= 0) return this._hold(cls, text);
        if (n > this._lineBudget) {
          let at = 0;
          for (let k = 0; k < this._lineBudget; k++) at = text.indexOf('\n', at) + 1;
          const rest = text.slice(at);
          this._lineBudget = 0;
          text = text.slice(0, at);
          this._hold(cls, rest);
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
      // not while a command of the AI agent runs: what it prints is read from here for the record and for the model
      if (this.agentCmd) return;
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
        this._submit(line);
        return;
      }
      if (e.key === 'c' && e.ctrlKey) {
        if (window.getSelection && String(window.getSelection())) return; // allow copy
        e.preventDefault();
        if (this.busy) {
          this.stop();
        } else {
          this._echo(this.input.value + '^C');
          this.input.value = '';
          this._more = null;
          this._renderPrompt();
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
    /** while the AI agent uses the terminal, nothing can be typed into it */
    lock(msg) {
      this.locked = true;
      this.input.disabled = true;
      this.input.placeholder = msg || '';
      this.root.classList.add('locked');
    }
    unlock() {
      this.locked = false;
      this.input.disabled = false;
      this.input.placeholder = '';
      this.root.classList.remove('locked');
    }
    /** Ctrl+C. The first time: the program that is running finishes, the rest is skipped.
        A second time (or force): the program is stopped by force – see MG.wasm.kill */
    stop(force) {
      if (!this.busy) return [];
      this._q = [];
      if ((this.cancelled || force) && MG.wasm && MG.wasm.running) {
        this.cancelled = true;
        const program = MG.wasm.running;
        const lost = MG.wasm.kill(this.fs);
        this.note(`${program} was stopped by force, and the programs were started again.`);
        // files that programs had written lived in the stopped programs' memory: the copies kept in the browser come back.
        // (Not here for a command of the AI agent: there the files come back as they were before the command, when what
        // the command changed is put back – see undoOutside in assistant.js – and the agent's card says what was lost.)
        if (lost.length && MG.project && MG.project.afterKill && !(this.agentCmd || (MG.app && MG.app.agentBusy))) {
          const times = MG.wasm.lostTimes || new Map();
          MG.project.afterKill(this.fs, lost).then((n) => {
            const list = (xs) => `${xs.slice(0, 5).map((x) => this.fs.pretty(x)).join(', ')}${xs.length > 5 ? ' and ' + (xs.length - 5) + ' more' : ''}`;
            const gone = lost.filter((x) => !this.fs.exists(x));
            if (gone.length) this.note(`Lost with the stopped program: ${list(gone)}. Run the commands, or your script, again to make ${gone.length === 1 ? 'it' : 'them'}.`);
            // a file that was changed in the last seconds before the stop comes back as it was before that change
            const older = lost.filter((x) => this.fs.exists(x) && (this.fs.get(x).mtime || 0) < (times.get(x) || 0));
            if (older.length) this.note(`Back as an earlier version (the newest had not been stored yet): ${list(older)}. Make ${older.length === 1 ? 'it' : 'them'} again.`);
          });
        }
        return lost;
      }
      // said once per command (the AI tab asks again and again until a command that ran for too long has ended)
      if (!this.cancelled) this.note(`Stop requested: the program that is running finishes first, then the rest is skipped. If it does not finish, press ${this.locked ? 'Stop' : 'Ctrl+C'} again to stop it by force.`);
      this.cancelled = true;
      return [];
    }
    /** show a command as typed: one element, further lines of a block after "> " */
    _echo(line) {
      const lines = String(line).split('\n');
      const el = h('div.tl.cmdline', { html: this.promptEl.innerHTML + lines.map(esc).join('\n<span class="pc">&gt;</span>&nbsp;') });
      el.dataset.cls = 'cmd';
      this.outEl.appendChild(el);
      this._scroll();
    }
    /** a line was entered: run it – or, when the command is not complete yet, wait for the rest */
    async _submit(line) {
      const text = this._more != null ? this._more + '\n' + line : line;
      if (text.trim() && MG.shellLang && MG.shellLang.incomplete(text)) {
        this._echo(line);
        this._more = text;
        this._renderPrompt();
        return null;
      }
      if (this._more == null) return this.exec(text);
      this._echo(line);
      this._more = null;
      this._renderPrompt();
      return this.exec(text, { echoed: true });
    }
    _queue(lines) {
      this._q = (this._q || []).concat(lines);
      if (!this.busy) this._drain();
    }
    async _drain() {
      while (this._q && this._q.length) {
        const l = this._q.shift();
        await this._submit(l);
      }
    }

    /** execute a line as if typed */
    /** run a command line as if typed. opts.agent: run by the real AI agent – its commands do not
        tick the student's tasks and do not offer "Ask the AI assistant" */
    async exec(line, opts = {}) {
      if (this.busy) {
        this.note('The terminal is busy: wait for the current command to finish.');
        return 125;
      }
      if (!opts.echoed) this._echo(line);
      const first = this.outEl.children.length;
      if (!line.trim()) return 0;
      this.busy = true;
      this.agentCmd = !!opts.agent; // what this command does (programs, scripts, files) is the agent's doing, not the student's
      this.cancelled = false;
      this.root.classList.add('busy');
      this.statusEl.innerHTML = '<span class="spinner small"></span> running…';
      this._lineBudget = HEAD_LINES;
      this._truncated = 0;
      this._tail = null;
      this._tailLines = 0;
      let code = 0;
      const t0 = performance.now();
      // A command of the agent: every path that the shell works out while it runs is noted (this.touched) – for the
      // script that can be made from the run, which leaves out a command that reaches outside the agent's folder.
      const fs = this.shell.fs;
      if (opts.agent) {
        this.touched = new Set();
        this.shell.fs = watched(fs, this.touched);
      }
      try {
        code = await this.shell.run(line, this.io);
      } catch (e) {
        console.error(e);
        this.err(String(e && e.message ? e.message : e) + '\n');
        code = 1;
      } finally {
        this.shell.fs = fs;
        this._lineBudget = null;
        // the end of a long output: the last lines of it, after a note that says how many lines are not shown
        const tail = this._tail || [];
        this._tail = null;
        let over = this._tailLines - TAIL_LINES;
        if (over > 0) {
          this._truncated = (this._truncated || 0) + over;
          while (over > 0 && tail.length) {
            const p = tail[0], n = (p.text.match(/\n/g) || []).length;
            if (n <= over && tail.length > 1) {
              tail.shift();
              over -= n;
            } else {
              let at = 0;
              for (let k = 0; k < over; k++) at = p.text.indexOf('\n', at) + 1;
              p.text = p.text.slice(at);
              over = 0;
            }
          }
        }
        this._tailLines = 0;
        if (this._truncated) this.note(`… ${MG.shellUtil.fmtN(this._truncated)} lines are not shown here – the first ${MG.shellUtil.fmtN(HEAD_LINES)} and the last ${MG.shellUtil.fmtN(TAIL_LINES)} lines of what this command printed are. Use head, tail or grep to look at part of it, or write the output to a file with >.`);
        for (const p of tail) if (p.text) this._append(p.cls, p.text);
        this.endProgress();
        this.busy = false;
        this.agentCmd = false;
        this.root.classList.remove('busy');
        this.statusEl.textContent = code ? `exit ${code}` : 'done';
        this._renderPrompt();
        store.set('termHistory', this.shell.history.slice(-200));
        this.focus();
      }
      const argv = safeArgv(line);
      if (opts.agent) return code;
      bus.emit('term:command', { line: line.trim(), code, name: argv[0] || '', sub: argv[1] || '', cwd: this.fs.pretty(this.fs.cwd), ms: performance.now() - t0 });
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
      if (this.locked) {
        MG.toast('The AI agent is using the terminal – wait until it has finished.', 'warn');
        return;
      }
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
        this.type('cd ' + typed(this.fs.pretty(c.path)));
        return;
      }
      const rel = typed(relPath(this.fs.cwd, c.path));
      const n = c.name;
      let cmd;
      if (/\.(fastq|fq)\.gz$/.test(n)) cmd = `zcat ${rel} | head -n 8`;
      else if (/\.html?$/.test(n)) cmd = `open ${rel}`;
      else if (/\.json$/.test(n)) cmd = `jq . ${rel} | head -n 40`;
      else if (/\.sam$/.test(n)) cmd = `grep -v '^@' ${rel} | head -n 3`;
      else if (/\.bam$/.test(n)) cmd = `samtools view -H ${rel} | head`;
      else if (/\.vcf\.gz$/.test(n)) cmd = `bcftools view -H ${rel} | head`;
      else if (/\.(bai|csi|tbi|gzi|zip|bt2)$/.test(n)) cmd = `ls -lh ${rel}`;
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
    if (to.startsWith(from + '/')) {
      // (a name that begins with ~ or - is written ./~… : the shell – and the program – must take it for a name)
      const r = to.slice(from.length + 1);
      return /^[~-]/.test(r) ? './' + r : r;
    }
    const home = '/home/student';
    if (to.startsWith(home + '/')) return '~/' + to.slice(home.length + 1);
    return to;
  }
  /** a path as it can be typed: in quotes where the shell would read it differently (a blank, $, *, a ~ that is part
      of a name) – the ~/ of the home folder stays outside the quotes */
  function typed(p) {
    const head = p.startsWith('~/') ? '~/' : p === '~' ? '~' : '', rest = p.slice(head.length);
    return rest === '' || /^[\w@%+=:,.\/-]+$/.test(rest) ? head + rest : head + "'" + rest.replace(/'/g, "'\\''") + "'";
  }
  /** the words of the last command of a line (its program and sub-command, for the tasks' checks) */
  function safeArgv(line) {
    try {
      // of  a; b && c | d  it is c
      const items = MG.shellLang.parse(line).items;
      const last = items.length ? items[items.length - 1] : null;
      const pipe = last ? (last.rest.length ? last.rest[last.rest.length - 1].pipe : last.first) : null;
      const c = pipe ? pipe.cmds[0] : null;
      if (c && c.type === 'simple') return c.words.map((w) => w.replace(/^(['"])(.*)\1$/, '$2'));
    } catch (e) {
      /* not a complete command */
    }
    return line.trim().split(/\s+/);
  }

  MG.TerminalUI = TerminalUI;
  MG.typedPath = typed;
})();
