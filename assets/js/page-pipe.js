/* =====================================================================
   "Pipelines and reproducibility" – page set-up: the file system with
   the course data, the terminal (real WebAssembly tools, conda,
   Snakemake), the editor, the notebook (Python), Galaxy and the AI
   assistant.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { h, esc, bus, toast, store } = MG;
  MG.app = MG.app || {};
  MG.checks = MG.checks || {};
  MG.actions = MG.actions || {};
  const CFG = MG.config;

  const HOME = '/home/student';
  const PROJECT = HOME + '/cyp2c19-pipeline';
  const COURSE_TIME = Date.parse('2026-09-01T09:00:00Z');
  const COURSE = [
    { path: '/data/course/SRR098401_1.fastq', url: 'data/course/SRR098401_1.fastq', size: 626445 },
    { path: '/data/course/SRR098401_2.fastq', url: 'data/course/SRR098401_2.fastq', size: 626445 },
    { path: '/data/course/hg19_CYP2C_slices.fa', url: 'data/course/hg19_CYP2C_slices.fa', size: 56963 },
    { path: '/data/course/hg19_CYP2C_slices.fa.fai', url: 'data/course/hg19_CYP2C_slices.fa.fai', size: 60 },
    { path: '/data/course/MD5SUMS', url: 'data/course/MD5SUMS', size: 218 },
    { path: '/data/course/README.md', url: 'data/course/README.md', size: 1614 },
    { path: '/data/course/provenance.json', url: 'data/course/provenance.json', size: 3919 },
    { path: '/data/course/colleague/README.md', url: 'data/course/colleague/README.md', size: 828 },
    { path: '/data/course/colleague/NA12878.filtered.vcf.gz', url: 'data/course/colleague/NA12878.filtered.vcf.gz', size: 1787 },
    { path: '/data/course/colleague/calling-environment.yml', url: 'data/course/colleague/calling-environment.yml', size: 1400 }
  ];
  MG.app.HOME = HOME;
  MG.app.PROJECT = PROJECT;
  const abs = (u) => new URL(u, location.href).href;

  function setupFs() {
    const fs = new MG.VFS(HOME);
    fs.mkdirp('/data/course/colleague');
    ['/data', '/data/course', '/data/course/colleague'].forEach((d) => (fs.entries.get(d).protected = true));
    COURSE.forEach((f) => fs.put(f.path, { kind: 'url', url: abs(f.url), size: f.size, protected: true, readonly: true, mtime: COURSE_TIME }));
    const restored = MG.project.restore(fs);
    if (!restored) fs.cwd = HOME;
    MG.project.watch(fs);
    return fs;
  }

  const STARTER = [
    { tag: 'hello', source: "# Python in the notebook: run this cell with ▶ or Shift+Enter\nsample = 'NA12878'\nprint('Hello', sample)" },
    { tag: null, source: '' }
  ];

  const page = (MG.page = MG.page || {});
  page.firstBench = 'terminal';

  page.init = function () {
    const fs = (MG.app.fs = setupFs());
    MG.app.term = new MG.TerminalUI(document.getElementById('termRoot'), {
      fs,
      hostname: CFG.hostname || 'biolab',
      env: { CONDA_PREFIX: MG.conda.prefix(MG.conda.active) },
      welcome: 'Welcome to the practical\'s Linux terminal. The course data is in /data/course; your files live in your home folder (~ = /home/student). Type  help  for the commands.'
    });
    MG.app.nb = new MG.Notebook(document.getElementById('nbRoot'), {
      fileStem: 'cyp2c19-notebook',
      starter: STARTER,
      kernel: {
        workerUrl: 'assets/js/py-worker.js',
        indexURL: abs(CFG.pyodideBase || 'https://cdn.jsdelivr.net/pyodide/v0.29.5/full/'),
        preload: ['numpy', 'pandas', 'matplotlib', 'pyyaml'],
        files: COURSE.map((f) => ({ path: f.path, url: abs(f.url), mtime: COURSE_TIME, readonly: true })),
        modules: [{ name: 'smk.py', url: abs('assets/py/smk.py') + '?v=' + (CFG.buildId || '1') }],
        beforeRun: () => MG.pysync.push(),
        onChanges: (ch) => MG.pysync.apply(ch),
        onExtra: (m, K) => MG.py.onExtra(m, K),
        onRestart: () => MG.pysync.reset(),
        cwd: () => (fs.isDir(PROJECT) ? PROJECT : HOME)
      }
    });
  };

  page.lazy = {
    editor: (pane) => (MG.app.editor = new MG.Editor(pane.querySelector('#edRoot'), { fs: MG.app.fs })),
    galaxy: (pane) => {
      if (MG.GalaxyApp) MG.app.galaxy = new MG.GalaxyApp(pane.querySelector('#gxRoot'), { fs: MG.app.fs });
    },
    assistant: (pane) => {
      if (MG.Assistant && !MG.app.ai) MG.app.ai = new MG.Assistant(pane.querySelector('#aiRoot'), { notebook: MG.app.nb });
    }
  };

  /* opening files from the terminal (open, nano) and from links */
  MG.app.editFile = async (path, opts = {}) => {
    MG.app.showWorkbench('editor');
    for (let i = 0; i < 40 && !MG.app.editor; i++) await new Promise((r) => setTimeout(r, 50));
    await MG.app.editor.openFile(path, opts);
  };
  MG.app.openFile = async (path, opts = {}) => MG.app.editFile(path, opts);

  /* ------------------------------------------------------------------
     ▶ buttons in the instructions
     data-term="cmd"      type a command into the terminal
     data-term-run="cmd"  … and run it
     data-edit="path"     open a file in the editor
     data-nb / data-nb-run  put code in the notebook (and run it)
     ------------------------------------------------------------------ */
  MG.actions.edit = async (path) => {
    const p = path.startsWith('/') ? path : path.startsWith('~/') ? HOME + path.slice(1) : PROJECT + '/' + path;
    await MG.app.editFile(p, { create: true });
  };
  MG.actions.nb = async (code) => {
    MG.app.showWorkbench('notebook');
    await MG.app.nb.insertCode(code);
  };
  MG.actions.nbRun = async (code) => {
    MG.app.showWorkbench('notebook');
    await MG.app.nb.insertCode(code, { run: true });
  };

  /* files shown in the instructions: "Create this file" (or replace), "Copy" */
  const inProject = (p) => (p.startsWith('/') ? p : p.startsWith('~/') ? HOME + p.slice(1) : PROJECT + '/' + p);
  const codeOf = (btn) => {
    const box = btn.closest('.codefile');
    return box ? box.querySelector('pre').textContent : '';
  };
  MG.actions.fileCreate = async (rel, btn) => {
    const fs = MG.app.fs;
    if (!fs.isDir(PROJECT)) {
      toast('Make the project folder first (chapter 1): <code>mkdir -p cyp2c19-pipeline/…</code>', 'warn', 6000);
      return;
    }
    const path = inProject(rel);
    const text = codeOf(btn).replace(/\s+$/, '') + '\n';
    const e = fs.get(path);
    if (e && (e.readonly || e.protected)) return toast(esc(fs.pretty(path)) + ' is read-only.', 'error');
    if (e && e.kind !== 'dir') {
      const old = await fs.readText(path);
      if (old === text) return MG.app.editFile(path, {});
      if (!window.confirm(`${fs.pretty(path)} already exists. Replace its contents with the version shown in the instructions?`)) return;
      const ed = MG.app.editor;
      if (ed && ed.open && ed.open.get(path)) ed.open.get(path).dirty = false;
    }
    fs.mkdirp(MG.path.dirname(path));
    fs.writeText(path, text, e && e.mode ? { mode: e.mode } : {});
    await MG.app.editFile(path, { line: 1 });
    bus.emit('file:create', { path, name: path.split('/').pop() });
  };
  MG.actions.copyCode = async (v, btn) => toast((await MG.copyText(codeOf(btn))) ? 'Copied.' : 'Could not copy – select the text and copy it.', null, 1800);
  MG.actions.nbCode = async (how, btn) => {
    MG.app.showWorkbench('notebook');
    const box = btn.closest('.codefile');
    await MG.app.nb.insertCode(codeOf(btn), { run: how === 'run', tag: box && box.dataset.tag });
  };
  /* ask the assistant a prepared question */
  MG.actions.ai = async (id) => {
    MG.app.showWorkbench('assistant');
    for (let i = 0; i < 40 && !MG.app.ai; i++) await new Promise((r) => setTimeout(r, 50));
    const A = MG.app.ai;
    if (!A) return;
    const e = A.script.find((x) => x.id === id) || null;
    if (A.busy) return toast('The assistant is still answering – wait a moment.', 'warn');
    await A.send(e ? e.prompt : id, e, 'tutorial');
  };
  /* download the project folder as a .zip */
  MG.actions.downloadProject = async (kind) => {
    const full = kind === 'full';
    const skip = full ? /(^|\/)(\.snakemake|__pycache__)(\/|$)/ : /(^|\/)(\.snakemake|__pycache__|results|logs)(\/|$)/;
    await MG.project.download(PROJECT, full ? 'cyp2c19-pipeline-with-results.zip' : 'cyp2c19-pipeline.zip', { skip });
  };

  /* state checks for tasks (data-check="name:arg") */
  const textOf = (rel) => {
    const e = MG.app.fs && MG.app.fs.get(inProject(rel));
    return e && e.kind === 'text' ? e.text : null;
  };
  MG.checks.exists = (t, d, path) => MG.app.fs && MG.app.fs.exists(inProject(path));
  MG.checks.readonly = (t, d, path) => {
    const e = MG.app.fs && MG.app.fs.get(inProject(path));
    return !!(e && e.readonly);
  };
  MG.checks.has = (t, d, arg) => {
    const cut = arg.indexOf('|');
    const txt = textOf(arg.slice(0, cut));
    return txt != null && new RegExp(arg.slice(cut + 1), 'm').test(txt);
  };
  MG.checks.nothas = (t, d, arg) => {
    const cut = arg.indexOf('|');
    const txt = textOf(arg.slice(0, cut));
    return txt != null && !new RegExp(arg.slice(cut + 1), 'm').test(txt);
  };
  MG.checks.kernelReady = () => !!(MG.app.nb && MG.app.nb.kernel && MG.app.nb.kernel.state === 'ready');
  MG.checks.gxUploads = (t, d, n) => {
    const G = MG.app.galaxy;
    return !!G && G.datasets.filter((x) => x.upload && x.state === 'ok' && !x.deleted).length >= +(n || 3);
  };
  MG.checks.gxWf = (t, d, what) => {
    const G = MG.app.galaxy;
    if (!G) return false;
    const need = ['minimap2', 'samtools_flagstat', 'bcftools_mpileup', 'bcftools_call', 'bcftools_filter'];
    return G.workflows.some((w) => {
      const ins = w.steps.filter((s) => s.type === 'input');
      const tools = new Set(w.steps.filter((s) => s.type === 'tool').map((s) => s.tool));
      if (what === 'inputs') return ins.filter((s) => s.ext.includes('fastqsanger')).length >= 2 && ins.some((s) => s.ext.includes('fasta'));
      if (what === 'tools') return need.every((x) => tools.has(x));
      if (what === 'wired') return need.every((x) => tools.has(x)) && MG.galaxyUtil.validateWorkflow(w).length === 0;
      return false;
    });
  };

  page.resetNote = ', and also your files, conda environments, Galaxy workflows and notebook (download your project in chapter 9 to keep a copy)';
  page.workNote = 'everything this page has saved in this browser: your ticks and answers, files, conda environments, Galaxy workflows and notebook';
  page.onReset = () => {
    MG.project.reset();
    MG.project.save = () => {}; // do not write the old files back while the page reloads
    ['nb', 'ai:mode', 'smkHints'].forEach((k) => store.remove(k));
  };
  /* before "Save all my work": write everything to the browser's storage now */
  page.beforeSaveWork = async () => {
    const ed = MG.app.editor;
    const dirty = ed && ed.dirtyPaths ? ed.dirtyPaths() : [];
    if (dirty.length) {
      const go = await new Promise((resolve) => {
        const m = MG.modal('Unsaved changes', `<p>These files have changes in the editor that are not saved yet: <b>${dirty.map((p) => MG.esc(MG.app.fs.pretty(p))).join(', ')}</b>. The work file will contain the <i>saved</i> versions.</p><div class="prompt-actions"><button class="btn" data-x="no" type="button">Cancel – I will save them first</button><button class="btn primary" data-x="yes" type="button">Continue</button></div>`);
        m.box.querySelector('[data-x="no"]').addEventListener('click', () => { m.close(); resolve(false); });
        m.box.querySelector('[data-x="yes"]').addEventListener('click', () => { m.close(); resolve(true); });
      });
      if (!go) return false;
    }
    MG.project.save();
    if (MG.app.nb && MG.app.nb.saveNow) MG.app.nb.saveNow();
    if (MG.app.galaxy && MG.app.galaxy.save) MG.app.galaxy.save();
    return true;
  };
  page.help = function () {
    MG.modal(
      'How this page works',
      `<ul>
<li><b>Instructions</b> are on the left, the <b>workbench</b> on the right: Terminal, Files, Notebook, Galaxy and the AI assistant. Drag the divider to resize.</li>
<li><b>Terminal</b>: a Linux-like shell. minimap2, samtools, bcftools and htslib are the real programs, compiled to WebAssembly and running in your browser. Snakemake and Python run in Python compiled to WebAssembly (Pyodide) – the first time, it takes 10–30 seconds to start.</li>
<li><b>Files</b>: your folders and an editor. Save with <kbd>Ctrl</kbd>+<kbd>S</kbd> – commands in the terminal use the saved files.</li>
<li><b>▶ buttons</b> in the instructions type commands for you (press <kbd>Enter</kbd> to run them); <b>Create this file</b> buttons write a file into your project.</li>
<li><b>AI assistant</b>: in <i>guided</i> mode its answers are prepared – some contain deliberate mistakes. With an API key – your own (Google Gemini has a free tier) or one from your lecturer – ⚙ switches the Chat tab to a live model. The Agent tab is a simulation.</li>
<li><b>Saved in this browser:</b> your files (but not what is inside results/, logs/ or .snakemake/ – the pipeline rebuilds that), conda environments, Galaxy workflows, the notebook, ticks and answers. <b>My answers</b> downloads your answers; chapter 9 shows how to download your project.</li>
<li><b>Another computer?</b> <b>My answers → Save all my work to a file</b> saves everything above in one file; on the other computer, <b>My answers → Open my work from a file</b>. (Lab computers may clear the browser's storage when you log out – save your work before you leave.)</li>
<li>To start again from scratch: <b>My answers → Start again</b> (download your answers and project first).</li>
</ul>`
    );
  };

})();
