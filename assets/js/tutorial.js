/* =====================================================================
   Tutorial engine shared by every page of the genomics practicals:
   workbench tabs, chapters, ▶ buttons, auto-ticking tasks, questions,
   progress and “download my answers”. Page content lives in the HTML;
   page-specific set-up registers itself in MG.page (see page-*.js).
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { h, esc, bus, toast, store, $, $$ } = MG;
  const CFG = MG.config;
  const params = new URLSearchParams(location.search);
  const SHOW_ANSWERS = CFG.showModelAnswers || params.has('answers') || params.has('instructor');

  MG.app = MG.app || {};
  const MG_READY_FLAG = { ready: false };
  const state = store.get('progress', null) || { tasks: {}, answers: {}, name: '' };
  // If the page is open in two tabs, keep what the other tab saved (answers and ticks this
  // tab does not have) instead of overwriting it.
  const save = MG.debounce(() => {
    const stored = store.get('progress', null);
    if (stored) {
      Object.entries(stored.answers || {}).forEach(([k, v]) => {
        if (!(k in state.answers)) state.answers[k] = v;
      });
      Object.entries(stored.tasks || {}).forEach(([k, v]) => {
        if (!(k in state.tasks)) state.tasks[k] = v;
      });
      if (!state.name && stored.name) state.name = stored.name;
    }
    store.set('progress', state);
  }, 300);
  let warnedTabs = false;
  window.addEventListener('storage', (e) => {
    if (warnedTabs || !e.key || !/:(progress|nb)$/.test(e.key)) return;
    warnedTabs = true;
    toast('This practical is also open in another tab or window. Work in one of them, so that answers and notebook cells are not overwritten.', 'warn', 9000);
  });

  /* ------------------------------------------------------------------
     Workbench (right-hand side): 3D viewer / UniProt / PDB
     ------------------------------------------------------------------ */
  function initWorkbench() {
    const tabs = $$('.wb-tab');
    const panes = $$('.wb-pane');
    const narrow = () => window.matchMedia('(max-width: 1000px)').matches;
    const inited = new Set();
    MG.app.showWorkbench = (name, opts = {}) => {
      if (!panes.some((p) => p.dataset.wb === name)) return;
      if (narrow() && !opts.noOpen && MG_READY_FLAG.ready) document.body.classList.add('bench-open');
      tabs.forEach((t) => {
        const on = t.dataset.wb === name;
        t.classList.toggle('on', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) t.classList.remove('attn');
      });
      panes.forEach((p) => (p.hidden = p.dataset.wb !== name));
      MG.app.currentBench = name;
      const pane = panes.find((p) => p.dataset.wb === name);
      if (pane && !inited.has(name) && MG.page && MG.page.lazy && MG.page.lazy[name]) {
        inited.add(name);
        try {
          MG.page.lazy[name](pane);
        } catch (e) {
          console.error(e);
        }
      }
      if (name === 'viewer' && MG.app.viewer && MG.app.viewer.stage) setTimeout(() => MG.app.viewer.stage.handleResize(), narrow() ? 280 : 30);
      if (name === 'terminal' && MG.app.term && !narrow()) setTimeout(() => MG.app.term.focus(), 30);
      bus.emit('app:bench', { name });
    };
    tabs.forEach((t) => t.addEventListener('click', () => MG.app.showWorkbench(t.dataset.wb)));
    const fab = $('.bench-fab'), close = $('.bench-close');
    if (fab) fab.addEventListener('click', () => {
      document.body.classList.add('bench-open');
      if (MG.app.viewer && MG.app.viewer.stage) setTimeout(() => MG.app.viewer.stage.handleResize(), 280);
    });
    if (close) close.addEventListener('click', () => document.body.classList.remove('bench-open'));
    if (MG.page && MG.page.init) {
      try {
        MG.page.init();
      } catch (e) {
        console.error(e);
      }
    }
    const first = (MG.page && MG.page.firstBench) || (tabs[0] && tabs[0].dataset.wb);
    if (first) MG.app.showWorkbench(first, { noOpen: true });
  }

  /** create the 3D viewer inside a pane (used by pages that have one) */
  MG.app.createViewer = function (root) {
    try {
      new MG.ViewerUI(root);
    } catch (e) {
      console.error(e);
      root.innerHTML = '<div class="ex-empty"><h3>The 3D viewer could not start</h3><p>This browser or computer may have 3D graphics (WebGL) switched off. Try Chrome, Edge, Firefox or Safari, and turn on “hardware acceleration” in the browser settings.</p></div>';
      const noop = () => toast('The 3D viewer is not available in this browser.', 'error');
      MG.app.vui = { run: noop, log() {}, showTab() {}, showHelp() { noop(); }, tabs: {}, views: [] };
      MG.app.viewer = { structures: [], stage: { handleResize() {} } };
      MG.commands.run = async () => noop();
    }
  };

  /* resizable split */
  function initSplitter() {
    const sp = $('.splitter');
    const tut = $('.tut');
    const saved = store.get('tutWidth', null);
    if (saved) document.documentElement.style.setProperty('--tut-w', saved);
    if (!sp) return;
    let drag = false;
    sp.addEventListener('pointerdown', (e) => {
      drag = true;
      sp.classList.add('drag');
      sp.setPointerCapture(e.pointerId);
      document.body.style.userSelect = 'none';
    });
    sp.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const w = MG.clamp((e.clientX / window.innerWidth) * 100, 22, 70);
      document.documentElement.style.setProperty('--tut-w', w.toFixed(1) + '%');
    });
    const end = () => {
      if (!drag) return;
      drag = false;
      sp.classList.remove('drag');
      document.body.style.userSelect = '';
      store.set('tutWidth', getComputedStyle(document.documentElement).getPropertyValue('--tut-w').trim());
      if (MG.app.viewer) MG.app.viewer.stage.handleResize();
    };
    sp.addEventListener('pointerup', end);
    sp.addEventListener('pointercancel', end);
    sp.addEventListener('dblclick', () => {
      document.documentElement.style.setProperty('--tut-w', '42%');
      store.remove('tutWidth');
      if (MG.app.viewer) MG.app.viewer.stage.handleResize();
    });
    void tut;
  }

  /* ------------------------------------------------------------------
     Chapters
     ------------------------------------------------------------------ */
  let chapters = [];
  function initChapters() {
    chapters = $$('.chapter');
    const nav = $('.ch-nav');
    chapters.forEach((ch, k) => {
      const b = h('button.ch-tab', { type: 'button', dataset: { ch: ch.id } }, h('span.num', ch.dataset.num || String(k)), h('span', ch.dataset.title || ch.id));
      b.addEventListener('click', () => showChapter(ch.id, true));
      nav.appendChild(b);
      // next / previous buttons
      const row = h('div.next-row');
      const prev = chapters[k - 1], next = chapters[k + 1];
      row.appendChild(prev ? mkNav('← ' + (prev.dataset.title || ''), prev.id) : h('span'));
      row.appendChild(next ? mkNav((next.dataset.title || '') + ' →', next.id, true) : h('span'));
      ch.appendChild(row);
    });
    window.addEventListener('hashchange', () => routeHash());
    routeHash(true);
  }
  function mkNav(label, id, primary) {
    const b = h('button.btn' + (primary ? '.primary' : ''), { type: 'button' }, label);
    b.addEventListener('click', () => showChapter(id, true));
    return b;
  }
  function routeHash(initial) {
    const id = decodeURIComponent(location.hash.replace('#', ''));
    const ch = chapters.find((c) => c.id === id) || (id && document.getElementById(id) && document.getElementById(id).closest('.chapter'));
    if (ch) {
      showChapter(ch.id, false);
      const el = document.getElementById(id);
      if (el && el !== ch) setTimeout(() => el.scrollIntoView({ block: 'start' }), 50);
    } else if (initial) showChapter(store.get('chapter', chapters[0] && chapters[0].id), false);
  }
  function showChapter(id, push) {
    chapters.forEach((c) => (c.hidden = c.id !== id));
    $$('.ch-tab').forEach((b) => b.classList.toggle('on', b.dataset.ch === id));
    store.set('chapter', id);
    const tut = $('.tut');
    if (push) {
      history.replaceState(null, '', '#' + id);
      tut.scrollTop = 0;
      if (window.innerWidth <= 1000) $('.ch-nav').scrollIntoView({ block: 'start' });
    }
    const ch = chapters.find((c) => c.id === id);
    if (ch && ch.dataset.bench) MG.app.showWorkbench(ch.dataset.bench, { noOpen: true });
    bus.emit('app:chapter', { id });
    if (typeof evalTasks === 'function') setTimeout(() => evalTasks(null, null), 50);
  }
  MG.app.showChapter = showChapter;
  MG.app.currentChapter = () => {
    const c = chapters.find((x) => !x.hidden);
    return c ? c.id : '';
  };

  /* ------------------------------------------------------------------
     ▶ action buttons inside the tutorial
     ------------------------------------------------------------------ */
  /* ▶ buttons: data-cmd (3D viewer), data-term (terminal), data-igv, data-uniprot,
     data-pdb, data-bench, data-vtab, data-goto, plus page actions in MG.actions */
  MG.actions = MG.actions || {};
  function initActions() {
    const keys = () => ['cmd', 'term', 'termRun', 'igv', 'uniprot', 'pdb', 'bench', 'vtab', 'goto'].concat(Object.keys(MG.actions));
    document.addEventListener('click', async (e) => {
      // only real controls trigger actions. Chapters also carry data-bench (the workbench
      // tab to show with them), so a bare [data-bench] selector would catch every click
      // inside a chapter – blocking radio buttons and ticks and pulling focus to the terminal.
      const sel = keys()
        .map((k) => '[data-' + k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()) + ']')
        .map((a) => `button${a},a${a},[role="button"]${a}`)
        .join(',');
      const b = e.target.closest(sel);
      if (!b || !b.closest('.tut, .modal')) return;
      e.preventDefault();
      const ds = b.dataset;
      if (ds.goto) {
        const ch = document.getElementById(ds.goto);
        if (ch && ch.classList.contains('chapter')) showChapter(ch.id, true);
        else if (ch) {
          showChapter(ch.closest('.chapter').id, true);
          setTimeout(() => ch.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
        }
        return;
      }
      if (ds.bench) MG.app.showWorkbench(ds.bench);
      if (ds.vtab) {
        MG.app.showWorkbench('viewer');
        MG.app.vui.showTab(ds.vtab);
        flash(MG.app.vui.tabs[ds.vtab]);
      }
      const busy = async (fn) => {
        b.classList.add('running');
        try {
          await fn();
        } catch (err) {
          console.error(err);
          toast(esc(err.message || String(err)), 'error');
        } finally {
          b.classList.remove('running');
        }
      };
      if (ds.term != null || ds.termRun != null) {
        MG.app.showWorkbench('terminal');
        const line = ds.term != null ? ds.term : ds.termRun;
        await busy(() => MG.app.term.type(line, ds.termRun != null));
      }
      if (ds.cmd) {
        MG.app.showWorkbench('viewer');
        await busy(() => MG.commands.run(ds.cmd, { prefix: '▶ ' }));
      }
      if (ds.igv) {
        MG.app.showWorkbench('igv');
        await busy(() => MG.app.igv.goto(ds.igv));
      }
      if (ds.uniprot) {
        MG.app.showWorkbench('uniprot');
        const [kind, ...rest] = ds.uniprot.split(':');
        const arg = rest.join(':');
        const U = MG.app.uniprot;
        await busy(async () => {
          if (kind === 'search') await U.search(arg, { reviewed: ds.reviewed === 'true', human: ds.human === 'true' });
          else if (kind === 'entry') await U.open(arg.split('#')[0], arg.split('#')[1]);
          else if (kind === 'section') U.section(arg);
          else if (kind === 'show3d') {
            const [acc, range, ...lab] = arg.split('|');
            const ranges = range.split(',').map((r) => r.split('-').map(Number)).map((x) => (x.length === 1 ? [x[0], x[0]] : x));
            await MG.uniprotShow3D(acc, ranges, lab.join('|') || 'Residues ' + range);
          }
        });
      }
      for (const k of Object.keys(MG.actions)) {
        if (ds[k] != null) await busy(() => MG.actions[k](ds[k], b));
      }
    });
  }
  function flash(el) {
    if (!el) return;
    el.classList.add('flash-attn');
    setTimeout(() => el.classList.remove('flash-attn'), 1400);
  }

  /* ------------------------------------------------------------------
     Tasks (tick automatically when the matching thing happens)
     ------------------------------------------------------------------ */
  const taskEls = [];
  function parseSpec(spec) {
    return spec.split('||').map((one) => {
      const parts = one.trim().split(/\s+(?=[a-zA-Z_]+[=~<>])/);
      const ev = parts.shift();
      const conds = parts.map((p) => {
        const m = /^([a-zA-Z_]+)([=~<>])(.*)$/.exec(p.trim());
        return m ? { k: m[1], op: m[2], v: m[3] } : null;
      }).filter(Boolean);
      return { ev, conds };
    });
  }
  function matches(spec, type, d) {
    return spec.some((s) => s.ev === type && s.conds.every((c) => {
      const val = d[c.k];
      if (c.op === '=') return String(val).toLowerCase() === c.v.toLowerCase();
      if (c.op === '~') return String(val || '').toLowerCase().includes(c.v.toLowerCase());
      if (c.op === '>') return Number(val) > Number(c.v);
      if (c.op === '<') return Number(val) < Number(c.v);
      return false;
    }));
  }
  function initTasks() {
    $$('[data-task]').forEach((li) => {
      const id = li.dataset.task;
      const cb = h('input', { type: 'checkbox', 'aria-label': 'Mark as done' });
      const lab = h('label.task-check', { title: 'Tick when done' }, cb, h('span', 'done'));
      li.prepend(lab);
      if (li.dataset.auto || li.dataset.check) lab.title = 'Ticks itself when you do it – or tick it yourself';
      cb.addEventListener('change', () => setTask(id, cb.checked, false));
      const t = { id, li, cb, spec: li.dataset.auto ? parseSpec(li.dataset.auto) : null, check: li.dataset.check || null };
      taskEls.push(t);
      if (state.tasks[id]) mark(t, true);
    });
    bus.on('*', (d, type) => {
      if (type === 'viewer:rendered' || type === 'viewer:hover' || type === 'viewer:busy') return;
      evalTasks(type, d);
    });
  }
  /* Tasks only tick for the chapter the student is reading, so that e.g. loading 3FXI
     in the warm-up does not tick the same step in a later chapter. */
  function evalTasks(type, d) {
    // events that remember the chapter they started in (e.g. a long notebook run) count for that chapter
    const active = (d && d._chapter && chapters.find((c) => c.id === d._chapter)) || chapters.find((c) => !c.hidden);
    taskEls.forEach((t) => {
      if (state.tasks[t.id]) return;
      if (active && !active.contains(t.li)) return;
      let ok = false;
      if (t.spec && type && matches(t.spec, type, d || {})) ok = true;
      if (!ok && t.check) {
        const cut = t.check.indexOf(':');
        const name = cut < 0 ? t.check : t.check.slice(0, cut);
        const arg = cut < 0 ? undefined : t.check.slice(cut + 1);
        const fn = MG.checks[name];
        if (fn) {
          try {
            ok = !!fn(type, d || {}, arg);
          } catch (e) {
            ok = false;
          }
        }
      }
      if (ok) setTask(t.id, true, true);
    });
  }
  function mark(t, on, auto) {
    t.cb.checked = on;
    t.li.classList.toggle('task-done', on);
    if (auto && on && !t.li.querySelector('.auto-tag')) t.li.querySelector('.task-check').appendChild(h('span.auto-tag', '✓ spotted'));
  }
  function setTask(id, on, auto) {
    const t = taskEls.find((x) => x.id === id);
    if (!t) return;
    if (on) state.tasks[id] = auto ? 'auto' : true;
    else delete state.tasks[id];
    mark(t, on, auto);
    save();
    updateProgress();
  }

  /* state checks used by data-check="name[:arg]" – pages add their own to MG.checks */
  MG.checks = MG.checks || {};

  /* ------------------------------------------------------------------
     Questions
     ------------------------------------------------------------------ */
  const qEls = [];
  function initQuestions() {
    let n = 0;
    $$('.q').forEach((q) => {
      n++;
      const id = q.dataset.q || 'q' + n;
      const text = q.querySelector('.q-text');
      const model = q.querySelector('.q-model');
      if (model) model.hidden = true;
      const num = q.dataset.label || 'Q' + (q.closest('.chapter') ? (q.closest('.chapter').dataset.num || '') + '.' : '') + (qEls.filter((x) => x.q.closest('.chapter') === q.closest('.chapter')).length + 1);
      const head = h('div.q-h', h('span.q-n', num));
      if (text) head.appendChild(text);
      q.prepend(head);
      const body = h('div.q-body');
      const actions = h('div.q-actions');
      const fb = h('span.q-feedback', { 'aria-live': 'polite' });
      const rec = { id, q, fb, model, type: q.dataset.type || (q.dataset.accept ? 'short' : 'text') };
      const saved = state.answers[id] || {};
      if (rec.type === 'mcq') {
        const opts = q.querySelector('.mcq');
        if (opts) {
          opts.querySelectorAll('input').forEach((inp, k) => {
            inp.name = 'mcq-' + id;
            inp.value = String(k);
            if (saved.choice === String(k)) inp.checked = true;
            inp.addEventListener('change', () => checkMCQ(rec, true));
          });
          body.appendChild(opts);
        }
      } else {
        const inp = rec.type === 'short' ? h('input', { type: 'text', 'aria-label': 'Your answer', placeholder: q.dataset.placeholder || 'Your answer' }) : h('textarea', { 'aria-label': 'Your answer', placeholder: q.dataset.placeholder || 'Type your answer – it is saved in this browser' });
        inp.value = saved.text || '';
        rec.input = inp;
        body.appendChild(inp);
        inp.addEventListener('input', () => {
          state.answers[id] = Object.assign(state.answers[id] || {}, { text: inp.value });
          if (rec.type !== 'short') {
            state.answers[id].done = inp.value.trim().length > 3;
            q.classList.toggle('answered', state.answers[id].done);
          }
          save();
          updateProgressSoon();
        });
        if (rec.type === 'short') {
          const chk = h('button.btn.small', { type: 'button', html: MG.icon('check') + '<span>Check</span>' });
          chk.addEventListener('click', () => checkShort(rec, true));
          inp.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), checkShort(rec, true)));
          actions.appendChild(chk);
        }
      }
      if (model && SHOW_ANSWERS) {
        const sb = h('button.btn.small', { type: 'button', text: 'Show answer' });
        sb.addEventListener('click', () => {
          model.hidden = !model.hidden;
          sb.textContent = model.hidden ? 'Show answer' : 'Hide answer';
          if (!model.hidden) {
            state.answers[id] = Object.assign(state.answers[id] || {}, { revealed: true });
            save();
          }
        });
        actions.appendChild(sb);
      }
      actions.appendChild(fb);
      body.appendChild(actions);
      if (model) {
        model.classList.add('q-answer');
        body.appendChild(model);
      }
      q.appendChild(body);
      qEls.push(rec);
      if (rec.type === 'short' && saved.text) checkShort(rec, false);
      if (rec.type === 'mcq' && saved.choice != null) checkMCQ(rec, false);
      if (rec.type === 'text' && saved.done) q.classList.add('answered');
    });
  }
  function norm(s) {
    return String(s || '').toLowerCase().replace(/[‐-―−]/g, '-').replace(/\s+/g, ' ').trim();
  }
  function checkShort(rec, user) {
    const v = norm(rec.input.value);
    if (!v) {
      rec.fb.textContent = '';
      return;
    }
    const accept = (rec.q.dataset.accept || '').split('||').map((s) => s.trim()).filter(Boolean);
    const ok = accept.some((a) => {
      try {
        return new RegExp(a, 'i').test(v);
      } catch (e) {
        return v === norm(a);
      }
    });
    rec.fb.className = 'q-feedback ' + (ok ? 'ok' : 'no');
    rec.fb.textContent = ok ? '✓ Correct' : '✗ Not quite – ' + (rec.q.dataset.hint || 'check again');
    rec.q.classList.toggle('answered', ok);
    state.answers[rec.id] = Object.assign(state.answers[rec.id] || {}, { text: rec.input.value, correct: ok, done: ok });
    save();
    if (user) {
      updateProgress();
      bus.emit('q:checked', { id: rec.id, ok });
    }
  }
  function checkMCQ(rec, user) {
    const inputs = Array.from(rec.q.querySelectorAll('.mcq input'));
    const chosen = inputs.find((i) => i.checked);
    if (!chosen) return;
    const label = chosen.closest('label');
    const right = label.hasAttribute('data-correct');
    rec.q.querySelectorAll('.mcq label').forEach((l) => l.classList.remove('right', 'wrong'));
    label.classList.add(right ? 'right' : 'wrong');
    rec.fb.className = 'q-feedback ' + (right ? 'ok' : 'no');
    const why = label.dataset.why || '';
    rec.fb.textContent = (right ? '✓ Correct. ' : '✗ Not quite. ') + why;
    rec.q.classList.toggle('answered', right);
    state.answers[rec.id] = { choice: chosen.value, correct: right, done: right, text: label.textContent.trim() };
    save();
    if (user) {
      updateProgress();
      bus.emit('q:checked', { id: rec.id, ok: right });
    }
  }

  /* ------------------------------------------------------------------
     Progress
     ------------------------------------------------------------------ */
  function updateProgress() {
    let done = 0, total = 0;
    chapters.forEach((ch) => {
      let d = 0, t = 0;
      taskEls.forEach((x) => {
        if (ch.contains(x.li) && !x.li.closest('.optional')) {
          t++;
          if (state.tasks[x.id]) d++;
        }
      });
      qEls.forEach((x) => {
        if (ch.contains(x.q) && !x.q.closest('.optional')) {
          t++;
          if ((state.answers[x.id] || {}).done) d++;
        }
      });
      done += d;
      total += t;
      const tab = $(`.ch-tab[data-ch="${ch.id}"]`);
      if (tab) {
        tab.classList.toggle('done', t > 0 && d === t);
        tab.title = t ? `${d} of ${t} done` : '';
      }
    });
    const pct = total ? Math.round((done / total) * 100) : 0;
    const bar = $('.progress > i');
    if (bar) bar.style.width = pct + '%';
    const lab = $('.progress-label');
    if (lab) lab.textContent = pct + '% done';
  }
  const updateProgressSoon = MG.debounce(updateProgress, 400);

  /* ------------------------------------------------------------------
     Download answers / reset
     ------------------------------------------------------------------ */
  function exportAnswers() {
    const name = state.name || '';
    const date = new Date().toLocaleString('en-GB');
    let html = `<!doctype html><html><head><meta charset="utf-8"><title>My answers – ${esc(pageTitle())}</title>
<style>body{font-family:Calibri,Arial,sans-serif;max-width:800px;margin:30px auto;color:#222;line-height:1.45}h1{font-size:22px}h2{font-size:17px;border-bottom:1px solid #ccc;margin-top:28px}
.q{margin:12px 0}.qt{font-weight:bold}.a{white-space:pre-wrap;background:#f4f7fa;border-left:3px solid #0b6b8a;padding:6px 10px;margin-top:4px}.none{color:#999;font-style:italic}.ok{color:#16794a}.meta{color:#666}</style></head><body>
<h1>${esc(pageTitle())} – my answers</h1><p class="meta">${name ? 'Name: <b>' + esc(name) + '</b> · ' : ''}Saved ${esc(date)}</p>`;
    chapters.forEach((ch) => {
      const qs = qEls.filter((x) => ch.contains(x.q));
      const ts = taskEls.filter((x) => ch.contains(x.li));
      if (!qs.length && !ts.length) return;
      html += `<h2>${esc(ch.dataset.num ? ch.dataset.num + '. ' : '')}${esc(ch.dataset.title || '')}</h2>`;
      if (ts.length) html += `<p class="meta">Activities completed: ${ts.filter((t) => state.tasks[t.id]).length} of ${ts.length}</p>`;
      qs.forEach((x) => {
        const a = state.answers[x.id] || {};
        const qt = x.q.querySelector('.q-text');
        const num = x.q.querySelector('.q-n');
        html += `<div class="q"><div class="qt">${esc(num ? num.textContent : '')} ${esc(qt ? qt.textContent : '')}</div>${a.text ? `<div class="a">${esc(a.text)}</div>` : '<div class="a none">(no answer)</div>'}${a.correct ? '<div class="ok">✓ checked correct</div>' : ''}</div>`;
      });
    });
    html += '</body></html>';
    const fname = 'my-answers' + (name ? '-' + name.replace(/[^a-z0-9]+/gi, '-') : '') + '.html';
    MG.downloadText(html, fname, 'text/html');
    toast('Saved <b>' + esc(fname) + '</b> – open it in a browser or Word.');
    bus.emit('answers:export', {});
  }
  async function copyAnswers() {
    let out = `${pageTitle()} – my answers${state.name ? ' (' + state.name + ')' : ''}\n\n`;
    chapters.forEach((ch) => {
      const qs = qEls.filter((x) => ch.contains(x.q));
      if (!qs.length) return;
      out += `== ${ch.dataset.num ? ch.dataset.num + '. ' : ''}${ch.dataset.title} ==\n`;
      qs.forEach((x) => {
        const a = state.answers[x.id] || {};
        out += `${x.q.querySelector('.q-n').textContent} ${x.q.querySelector('.q-text') ? x.q.querySelector('.q-text').textContent : ''}\n${a.text || '(no answer)'}\n\n`;
      });
    });
    (await MG.copyText(out)) ? toast('Answers copied to the clipboard.') : toast('Could not copy.', 'error');
  }
  function resetProgress() {
    const extra = (MG.page && MG.page.resetNote) || '';
    const m = MG.modal('Start again?', `<p>This clears your ticks and answers <b>in this browser</b>${extra}. Download your answers first if you want to keep them.</p><div class="prompt-actions"><button class="btn" data-x="no" type="button">Cancel</button><button class="btn primary" data-x="yes" type="button">Clear everything</button></div>`);
    m.box.querySelector('[data-x="no"]').addEventListener('click', () => m.close());
    m.box.querySelector('[data-x="yes"]').addEventListener('click', () => {
      if (MG.page && MG.page.onReset) MG.page.onReset();
      store.remove('progress');
      store.remove('chapter');
      location.hash = '';
      location.reload();
    });
  }
  /* ------------------------------------------------------------------
     All my work in one file: everything this page keeps in the browser
     (ticks, answers and whatever the page saves – files, settings …),
     to continue on another computer or browser.
     ------------------------------------------------------------------ */
  const WORK_FORMAT = 'mg-work';
  function storePrefix() {
    return (CFG.storePrefix || 'genomics') + ':' + (document.body.dataset.page ? document.body.dataset.page + ':' : '');
  }
  async function saveWork() {
    if (MG.page && MG.page.beforeSaveWork) {
      const ok = await MG.page.beforeSaveWork();
      if (ok === false) return;
    }
    store.set('progress', state);
    const pre = storePrefix();
    const keys = {};
    try {
      Object.keys(window.localStorage)
        .filter((k) => k.startsWith(pre))
        .forEach((k) => {
          try {
            keys[k.slice(pre.length)] = JSON.parse(window.localStorage.getItem(k));
          } catch (e) {
            /* skip a damaged entry */
          }
        });
    } catch (e) {
      toast('Your browser does not allow this page to read its storage.', 'error');
      return;
    }
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const who = state.name ? '-' + state.name.replace(/[^a-z0-9]+/gi, '-') : '';
    const data = { format: WORK_FORMAT, version: 1, page: document.body.dataset.page || '', prefix: pre, title: pageTitle(), name: state.name || '', saved: d.toISOString(), keys };
    const fname = `${CFG.storePrefix || 'practical'}-my-work${who}-${stamp}.json`;
    MG.downloadText(JSON.stringify(data), fname, 'application/json');
    toast(`Saved <b>${esc(fname)}</b>. On another computer: <b>My answers → Open my work from a file</b>.`, '', 8000);
    bus.emit('work:save', { file: fname });
  }
  function openWork() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      let data = null;
      try {
        data = JSON.parse(await f.text());
      } catch (e) {
        data = null;
      }
      const pre = storePrefix();
      if (!data || data.format !== WORK_FORMAT || !data.keys || typeof data.keys !== 'object') {
        toast('That is not a work file saved by this page (<i>My answers → Save all my work</i>).', 'error', 7000);
        return;
      }
      if (data.prefix !== pre) {
        toast(`That work file belongs to another practical${data.title ? ' (<b>' + esc(data.title) + '</b>)' : ''}.`, 'error', 7000);
        return;
      }
      const when = data.saved ? new Date(data.saved).toLocaleString('en-GB') : 'an unknown date';
      const m = MG.modal('Open this work file?', `<p><b>${esc(f.name)}</b>${data.name ? ' – ' + esc(data.name) : ''}, saved ${esc(when)}.</p><p>It <b>replaces</b> ${(MG.page && MG.page.workNote) || 'your ticks and answers in this browser'}.</p><div class="prompt-actions"><button class="btn" data-x="no" type="button">Cancel</button><button class="btn primary" data-x="yes" type="button">Open it</button></div>`);
      m.box.querySelector('[data-x="no"]').addEventListener('click', () => m.close());
      m.box.querySelector('[data-x="yes"]').addEventListener('click', () => {
        if (MG.page && MG.page.onReset) MG.page.onReset();
        // nothing may write the old state back while the page reloads
        store.set = () => true;
        store.remove = () => {};
        try {
          Object.keys(window.localStorage)
            .filter((k) => k.startsWith(pre))
            .forEach((k) => window.localStorage.removeItem(k));
          for (const [k, v] of Object.entries(data.keys)) {
            if (typeof k === 'string' && k.length < 200) window.localStorage.setItem(pre + k, JSON.stringify(v));
          }
        } catch (e) {
          m.close();
          toast('Could not store the work file in this browser (storage full or blocked).', 'error', 8000);
          return;
        }
        location.hash = '';
        location.reload();
      });
    });
    inp.click();
  }

  function initMenus() {
    const btn = $('#answersBtn');
    if (btn) btn.addEventListener('click', () => MG.popmenu(btn, [
      ['download', 'Download my answers (.html)', exportAnswers],
      ['copy', 'Copy my answers as text', copyAnswers],
      ['save', 'Save all my work to a file (for another computer)', saveWork],
      ['upload', 'Open my work from a file', openWork],
      ['reset', 'Start again (clear progress)', resetProgress]
    ]));
    const hb = $('#helpBtn');
    if (hb) hb.addEventListener('click', () => (MG.page && MG.page.help ? MG.page.help() : MG.app.vui && MG.app.vui.showHelp()));
    $$('[data-student-name]').forEach((inp) => {
      inp.value = state.name || '';
      inp.addEventListener('input', () => {
        state.name = inp.value;
        save();
      });
    });
    $$('[data-export-answers]').forEach((b) => b.addEventListener('click', exportAnswers));
    const sub = $('.brand-sub');
    if (sub && CFG.courseSubtitle && !sub.textContent.trim()) sub.textContent = CFG.courseSubtitle;
  }

  function pageTitle() {
    return (document.body.dataset.title || document.title || CFG.courseTitle || 'Practical').trim();
  }

  /* nudge: highlight a workbench tab when the tutorial needs it */
  function initNudges() {
    bus.on('app:chapter', ({ id }) => {
      const ch = document.getElementById(id);
      if (!ch || !ch.dataset.bench) return;
      const tab = $(`.wb-tab[data-wb="${ch.dataset.bench}"]`);
      if (tab && MG.app.currentBench !== ch.dataset.bench) tab.classList.add('attn');
    });
  }

  /* WebGL check */
  function webglOK() {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch (e) {
      return false;
    }
  }

  function init() {
    if (!webglOK()) console.warn('WebGL not available');
    MG.app.state = state;
    initWorkbench();
    initSplitter();
    initChapters();
    initActions();
    initTasks();
    initQuestions();
    initMenus();
    initNudges();
    updateProgress();
    if (!SHOW_ANSWERS) document.body.classList.add('no-answers');
    MG_READY_FLAG.ready = true;
    window.MG_READY = true;
    bus.emit('app:ready', {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
