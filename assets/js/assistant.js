/* =====================================================================
   The AI assistant of the pipelines practical.

   Chat tab  – an AI coding assistant. In guided mode (default) its answers
               to the practical's questions were prepared in advance; some
               contain the mistakes AI assistants really make, on purpose.
               Code blocks can go straight into the Snakefile, a file, the
               notebook or the terminal. Failed terminal commands can be
               sent here with "Ask the AI assistant about this error".
   Agent tab – a simulated AI agent for the chapter on provenance: a
               "black box" that hands over files without any record, and a
               "glass box" that runs your Snakemake pipeline in your
               terminal, where every step can be checked.
   Live mode – a real model (Anthropic, or an OpenAI-compatible service)
               called from the browser with a key the student enters; the
               key is kept only in this tab's sessionStorage.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { h, esc, bus, toast, store } = MG;
  const KEY_NAME = 'pipelines-ai-key';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const HOME = () => (MG.app && MG.app.HOME) || '/home/student';
  const PROJECT = () => (MG.app && MG.app.PROJECT) || HOME() + '/cyp2c19-pipeline';
  const SNAKEFILE = () => PROJECT() + '/workflow/Snakefile';

  /* a date as GATK writes it in VCF headers: "October 1, 2026 at 10:42:17 AM UTC" */
  function gatkDate(d) {
    const M = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const h = d.getUTCHours(), h12 = h % 12 || 12, p2 = (n) => String(n).padStart(2, '0');
    return `${M[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} at ${h12}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${h < 12 ? 'AM' : 'PM'} UTC`;
  }

  /* ------------------------------------------------------------------
     a small markdown renderer: paragraphs, lists, headings, tables,
     code blocks (```lang [path] [example]), inline code, bold, links
     ------------------------------------------------------------------ */
  function inline(s) {
    const codes = [];
    let t = esc(s).replace(/`([^`]+)`/g, (m, c) => {
      codes.push(c);
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    t = t.replace(/\\\*/g, '\u0001');
    t = t.replace(/(^|[^\w*])\*\*((?:[^*]|\*(?!\*))+?)\*\*(?![\w*])/g, '$1<b>$2</b>');
    t = t.replace(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?![\w*])/g, '$1<i>$2</i>');
    t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    t = t.replace(/\u0001/g, '*');
    return t.replace(/\u0000(\d+)\u0000/g, (m, k) => '<code>' + codes[+k] + '</code>');
  }
  function renderMarkdown(md) {
    const out = [];
    const lines = String(md || '').replace(/\r/g, '').split('\n');
    let i = 0, list = null, para = [];
    const closeList = () => {
      if (list) {
        out.push({ html: `<${list.type}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.type}>` });
        list = null;
      }
    };
    const closePara = () => {
      if (para.length) {
        out.push({ html: `<p>${inline(para.join(' '))}</p>` });
        para = [];
      }
    };
    while (i < lines.length) {
      const L = lines[i];
      const fence = /^```\s*([\w+-]*)\s*(.*)$/.exec(L);
      if (fence) {
        closePara();
        closeList();
        const code = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
        i++;
        const extra = fence[2].trim().split(/\s+/).filter(Boolean);
        out.push({ code: code.join('\n'), lang: (fence[1] || 'text').toLowerCase(), example: extra.includes('example'), file: extra.find((x) => x !== 'example') || null });
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(L) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        closePara();
        closeList();
        const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(L);
        i += 2;
        const body = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(cells(lines[i++]));
        out.push({ html: `<div class="ai-tablewrap"><table class="ai-table"><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</table></div>` });
        continue;
      }
      const hd = /^(#{1,4})\s+(.*)$/.exec(L);
      const ul = /^\s*[-*]\s+(.*)$/.exec(L);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(L);
      if (hd) {
        closePara();
        closeList();
        out.push({ html: `<h5>${inline(hd[2])}</h5>` });
      } else if (ul || ol) {
        closePara();
        const type = ul ? 'ul' : 'ol';
        if (!list || list.type !== type) {
          closeList();
          list = { type, items: [] };
        }
        list.items.push((ul || ol)[1]);
      } else if (!L.trim()) {
        closePara();
        closeList();
      } else if (list && /^\s{2,}\S/.test(L)) {
        list.items[list.items.length - 1] += ' ' + L.trim();
      } else {
        closeList();
        para.push(L.trim());
      }
      i++;
    }
    closePara();
    closeList();
    return out;
  }

  /* ------------------------------------------------------------------
     rule-based help when there is no prepared answer (guided mode)
     ------------------------------------------------------------------ */
  const ERROR_HELP = [
    [/MissingInputException/, 'Snakemake needs an input file that does not exist, and no rule can make it. Compare the file name in the message with what is really there (`ls`): a typo, a wrong folder, a missing comma between two input files (Python joins the two names into one), or a rule whose `output:` pattern does not match.'],
    [/is unknown in this context/, 'In a `shell:` command Snakemake fills in every `{…}` – `{input}`, `{output}`, `{params.x}`, `{wildcards.x}`, `{log}`, `{threads}`. Braces meant for the shell or awk must be doubled (`{{print $1}}`), and any other name in braces must be defined (for example under `params:`).'],
    [/Target rules may not contain wildcards/, 'Snakemake does not know which sample you mean. Name a file on the command line (`snakemake -n results/qc/NA12878.flagstat.txt`), or put a target rule without wildcards (`rule all:` with `expand(...)`) at the top of the Snakefile.'],
    [/SyntaxError|IndentationError/, 'Python could not read the file. Look at the line shown: a missing colon after `rule name` or a keyword (`input:`), a missing comma between items, unmatched quotes or brackets, or inconsistent indentation (use 4 spaces).'],
    [/already used by another rule|name .* is already used/, 'Two rules have the same name. When you replace a rule, delete the old version – or give the new one a different name.'],
    [/MissingOutputException/, 'The command ran without an error but did not create the file(s) listed in `output:`. Check that the command writes to `{output}` (and not to another name or folder).'],
    [/CalledProcessError|Error in rule|returned non-zero exit status/, 'A command of a rule failed. The program’s own message is printed *above* the "Error in rule" block (or in the rule’s log file, if it has `log:`): read that first. Snakemake deletes the output of a failed job so that no half-made file is mistaken for a result.'],
    [/unrecognized option|invalid option|unknown option|illegal option/, 'The program does not have that option. Check the real options with `PROGRAM --help` (for bcftools: `bcftools filter --help`). AI assistants sometimes invent options that sound right.'],
    [/LibMambaUnsatisfiableError|could not be solved|incompatible/, 'conda cannot build an environment in which all the requested packages fit together – an environment holds only one version of each library. For example, samtools 1.17 needs htslib 1.17 or newer, so it cannot join an environment in which htslib is pinned to 1.10: put such tools in separate environments (one `conda:` file per rule).'],
    [/PackagesNotFoundError|nothing provides/, 'conda cannot find a package with that name and version. Check the spelling and the version (`conda search NAME`).'],
    [/command not found/, 'The shell cannot find that program. Is it spelled right, and is the right conda environment active (`conda activate pipelines`)? For a script in the current folder, write `./script.sh` or `bash script.sh`.'],
    [/Permission denied/, 'The file cannot be written (it is read-only – for example raw data you protected) or run (a script needs `chmod +x`, or run it with `bash script.sh`).'],
    [/No such file or directory/, 'A file or folder in the command does not exist where the command looked. Check your current folder (`pwd`) and the path (`ls`). Paths in the project are relative to the project folder.'],
    [/WorkflowError/, 'Snakemake stopped before running any job. The lines after "WorkflowError" say why – often a problem with the Snakefile, the config file or the command-line options.'],
    [/Nothing to be done/, 'All requested files already exist and are up to date, so nothing needs to run. `snakemake -n -r` shows reasons; `-R RULE` forces a rule and everything after it.']
  ];
  const PY_ERRORS = {
    NameError: 'Python does not know that name. It is misspelt, or it was created in a cell that has not been run in this session (after a restart, run the cells again from the top).',
    SyntaxError: 'Python could not read the code: look for a missing bracket, quote, comma or colon on the line shown (or just above it).',
    IndentationError: 'Python uses indentation to group lines. The lines inside `for`, `if` or `def` must be indented consistently (4 spaces).',
    KeyError: 'That key does not exist in the dictionary (or column in the table). Keys are case-sensitive – print the dictionary (or `df.columns`) to see what is there.',
    IndexError: 'An index is out of range: a list of 2 items has positions 0 and 1 only.',
    TypeError: 'A value of the wrong type was used – for example adding a number to a string (`"NA" + 1`) or calling something that is not a function.',
    FileNotFoundError: 'The file path is wrong. The notebook runs in your project folder, so paths such as `config/config.yaml` are relative to it.',
    ModuleNotFoundError: 'That package is not installed in this browser’s Python. Available: pandas, numpy, matplotlib, pyyaml (import yaml).',
    AttributeError: 'The object does not have that attribute or method – often a typo, or a method of another type of object.',
    ValueError: 'The value has the right type but cannot be used – for example `int("NA12878")`.',
    ZeroDivisionError: 'Something was divided by zero.'
  };
  function ruleExplainError(text) {
    const hits = ERROR_HELP.filter(([re]) => re.test(text)).map(([, t]) => t);
    if (!hits.length) return null;
    return hits.slice(0, 2).map((t) => '- ' + t).join('\n');
  }

  /* ------------------------------------------------------------------
     matching typed questions to prepared prompts
     ------------------------------------------------------------------ */
  const STOP = new Set('a an the of to in on for and or with by is are be it this that these those how what which do does can could would should i me my we our you your please make show give using use from as at into than then there their its about all any some also just like get me write'.split(' '));
  function tokens(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9_%\s-]/g, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/(ies)$/, 'y').replace(/([^s])s$/, '$1'))
      .filter((w) => w && !STOP.has(w));
  }
  function score(query, entry) {
    if (entry.requires && !new RegExp(entry.requires, 'i').test(query)) return 0;
    if (entry.excludes && new RegExp(entry.excludes, 'i').test(query)) return 0;
    const q = new Set(tokens(query));
    if (!q.size) return 0;
    const p = new Set(tokens(entry.prompt + ' ' + (entry.alt || []).join(' ')));
    let hit = 0;
    q.forEach((w) => p.has(w) && hit++);
    let kw = 0;
    (entry.keywords || []).forEach((k) => new RegExp(k, 'i').test(query) && kw++);
    const need = entry.keywords && entry.keywords.length ? kw / entry.keywords.length : 0;
    return 0.55 * (hit / Math.max(q.size, 3)) + 0.45 * need;
  }

  /* ------------------------------------------------------------------
     the Snakefile: add or replace a rule
     ------------------------------------------------------------------ */
  function ruleNames(code) {
    return Array.from(code.matchAll(/^(?:rule|checkpoint)\s+(\w+)\s*:/gm)).map((m) => m[1]);
  }
  function findRule(text, name) {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => new RegExp('^(rule|checkpoint)\\s+' + name + '\\s*:').test(l));
    if (start < 0) return null;
    let end = start + 1;
    while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end++;
    while (end > start + 1 && lines[end - 1].trim() === '') end--;
    return { start, end, lines };
  }
  async function snakefileText() {
    const fs = MG.app.fs;
    const ed = MG.app.editor;
    if (ed && ed.isDirty && ed.isDirty(SNAKEFILE())) {
      // keep the student's unsaved edits: save them first
      if (ed.current !== SNAKEFILE()) await ed.openFile(SNAKEFILE(), { noFocus: true });
      ed.save();
    }
    return fs.exists(SNAKEFILE()) ? fs.readText(SNAKEFILE()) : '';
  }

  const CFG = MG.config || {};
  const LIVE_DEFAULTS = {
    provider: CFG.liveProvider || 'gemini',
    model: CFG.anthropicModel || 'claude-sonnet-5-5',
    geminiModel: CFG.geminiModel || 'gemini-3.8-flash',
    baseURL: 'https://api.openai.com/v1',
    openaiModel: ''
  };
  /* the model of each service; an empty model in the saved settings means the site's default
     from config.js, so a model changed there (e.g. when one is retired) reaches every student
     who has not chosen a model of their own */
  const geminiModelOf = (s) => (s.geminiModel || LIVE_DEFAULTS.geminiModel).trim().replace(/^models\//, '');
  const anthropicModelOf = (s) => (s.model || LIVE_DEFAULTS.model).trim();
  const modelOf = (s) => (s.provider === 'gemini' ? geminiModelOf(s) : s.provider === 'anthropic' ? anthropicModelOf(s) : s.openaiModel || 'model');
  /** Gemini and Anthropic always need a key; an OpenAI-compatible server (e.g. a local one) may not */
  const needsKey = (s) => s.provider !== 'openai';
  /* A model can be "experiencing high demand" (HTTP 503), and each Gemini model has its own
     free-tier limits (HTTP 429). Live mode then asks these models in turn; the answer says which
     model replied. */
  const GEMINI_FALLBACKS = (Array.isArray(CFG.geminiFallbackModels) ? CFG.geminiFallbackModels : ['gemini-3.6-flash', 'gemini-3.5-flash-lite'])
    .map((m) => String(m).trim().replace(/^models\//, ''))
    .filter(Boolean);
  const BUSY = [500, 502, 503, 504, 529];
  const skipWord = (status) => (status === 404 ? 'not found' : status === 429 ? 'over its limit' : 'busy');
  /** a pause that the Stop button can cut short */
  const pause = (ms, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      const stop = () => {
        clearTimeout(t);
        reject(new DOMException('Stopped', 'AbortError'));
      };
      if (signal && signal.aborted) stop();
      else if (signal) signal.addEventListener('abort', stop, { once: true });
    });

  /* ------------------------------------------------------------------
     the assistant panel
     ------------------------------------------------------------------ */
  class Assistant {
    constructor(root, opts) {
      this.root = root;
      this.opts = opts || {};
      this.nb = this.opts.notebook;
      this.script = this.opts.script || MG.AI_SCRIPT || [];
      this.threads = {};
      this.msgs = { chat: [], agent: [] };
      this.last = { chat: null, agent: null };
      this.busy = false;
      this.tab = 'chat';
      this.settings = Object.assign({}, LIVE_DEFAULTS, store.get('ai:settings', {}));
      this.mode = store.get('ai:mode', (MG.config && MG.config.assistantDefaultMode) || 'guided');
      try {
        this.key = window.sessionStorage.getItem(KEY_NAME) || '';
      } catch (e) {
        this.key = '';
      }
      if (this.mode === 'live' && !this.key && needsKey(this.settings)) this.mode = 'guided';
      this.agentRuns = 0;
      this._build();
      this.welcome('chat');
      this.welcome('agent');
      bus.on('nb:ask', (d) => this.askAboutCell(d));
      bus.on('term:ask', (d) => this.askAboutError(d));
      bus.on('app:chapter', () => {
        // the agent chapter opens the agent tab
        if (this.currentChapter() === 'agent' && this.tab !== 'agent' && !this._agentSeen) {
          this._agentSeen = true;
          this.showTab('agent');
        }
        this.renderSuggestions();
      });
      if (this.currentChapter() === 'agent') this.showTab('agent');
    }

    _build() {
      const R = this.root;
      R.classList.add('ai');
      this.modeEl = h('button.ai-mode', { type: 'button', title: 'Guided (prepared answers) or live AI – click to change' });
      this.modeEl.addEventListener('click', () => this.settingsDialog());
      const tabs = h('div.ai-tabs', { role: 'tablist' });
      this.tabBtns = {};
      [['chat', 'Chat', 'sparkle'], ['agent', 'Agent', 'robot']].forEach(([k, label, ic]) => {
        const b = h('button.ai-tab', { type: 'button', role: 'tab', html: MG.icon(ic) + '<span>' + label + '</span>' });
        b.addEventListener('click', () => this.showTab(k));
        tabs.appendChild(b);
        this.tabBtns[k] = b;
      });
      const copyBtn = h('button.tbtn', { type: 'button', title: 'Copy a ready-made prompt (with your Snakefile and config) to paste into an AI tool you are allowed to use', html: MG.icon('copy') + '<span>Copy prompt</span>' });
      copyBtn.addEventListener('click', () => this.copyPrompt());
      const newBtn = h('button.tbtn', { type: 'button', title: 'Start a new conversation', html: MG.icon('reset') + '<span>New</span>' });
      newBtn.addEventListener('click', () => {
        this.msgs[this.tab] = [];
        this.last[this.tab] = null;
        this.threads[this.tab].innerHTML = '';
        this.welcome(this.tab);
        this.renderSuggestions();
      });
      const setBtn = h('button.tbtn', { type: 'button', title: 'Assistant settings (guided or live AI)', 'aria-label': 'Assistant settings', html: MG.icon('gear') });
      setBtn.addEventListener('click', () => this.settingsDialog());
      const body = h('div.ai-threads');
      ['chat', 'agent'].forEach((k) => {
        const t = h('div.ai-thread', { role: 'log', 'aria-live': 'polite', dataset: { tab: k } });
        this.threads[k] = t;
        body.appendChild(t);
      });
      this.sugg = h('div.ai-sugg');
      this.input = h('textarea.ai-input', { rows: 2, 'aria-label': 'Message to the AI assistant' });
      this.sendBtn = h('button.btn.primary.ai-send', { type: 'button', title: 'Send (Enter)', html: MG.icon('send') + '<span>Send</span>' });
      this.sendBtn.addEventListener('click', () => (this._abort ? this._abort.abort() : this.send()));
      this.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          this.send();
        }
      });
      R.append(
        h('div.ai-bar', h('span.ai-title', { html: MG.icon('sparkle') + ' AI assistant' }), tabs, this.modeEl, h('span.grow'), copyBtn, newBtn, setBtn),
        body,
        h('div.ai-foot', this.sugg, h('div.ai-inrow', this.input, this.sendBtn))
      );
      this.renderMode();
      this.showTab('chat', true);
    }
    showTab(k, quiet) {
      this.tab = k;
      Object.entries(this.tabBtns).forEach(([n, b]) => {
        b.classList.toggle('on', n === k);
        b.setAttribute('aria-selected', String(n === k));
      });
      Object.entries(this.threads).forEach(([n, t]) => (t.hidden = n !== k));
      this.root.classList.toggle('agent', k === 'agent');
      this.input.placeholder = k === 'agent' ? 'Give the agent a task – e.g. “Call the variants for NA12878 and give me a VCF file”' : 'Ask the assistant – e.g. “Write a rule that indexes my BAM file”';
      this.renderSuggestions();
      if (!quiet) bus.emit('ai:tab', { tab: k });
    }
    renderMode() {
      if (this.mode === 'live') {
        this.modeEl.innerHTML = `<span class="kdot ok"></span> Live · ${esc(modelOf(this.settings))}`;
        this.modeEl.classList.add('live');
      } else {
        this.modeEl.innerHTML = '<span class="kdot"></span> Guided';
        this.modeEl.classList.remove('live');
      }
    }
    welcome(tab) {
      if (tab === 'agent') {
        this.addBubble('assistant', 'I am an **AI agent**: give me a whole task and I will carry it out and give you the result – no commands needed.\n\n*In this practical the agent is a scripted simulation, built from the ways real AI tools behave. Treat it as if it were real, and judge what it gives you only by the evidence.*', { intro: true, tab: 'agent' });
        return;
      }
      this.addBubble('assistant', this.mode === 'live'
        ? 'Hi! I am a **live** AI model. I can see your Snakefile and config file when you ask me something, but not your data. The suggestions under this box still give the practical’s prepared answers. Always check what I give you: run it, read the errors, compare the results.'
        : 'Hi! I am the practical’s AI coding assistant, in **guided mode**: my answers to the practical’s questions were prepared in advance – and, like real AI output, *some contain mistakes* for you to catch. Pick a suggestion below or type a question. Code can go straight into your Snakefile, the notebook or the terminal with the buttons under it.', { intro: true, tab: 'chat' });
    }

    /* ---------------- suggestions ---------------- */
    currentChapter() {
      const ch = Array.from(document.querySelectorAll('.chapter')).find((c) => !c.hidden);
      return ch ? ch.id : '';
    }
    entryMode(e) {
      return e.mode || 'chat';
    }
    renderSuggestions() {
      const ch = this.currentChapter();
      const tab = this.tab;
      const used = new Set(this.msgs[tab].filter((m) => m.entry).map((m) => m.entry));
      const last = this.last[tab];
      const follow = last ? this.script.filter((e) => (last.next || []).includes(e.id) && !used.has(e.id)) : [];
      let list = this.script.filter((e) => this.entryMode(e) === tab && !e.followOnly && !e.hidden && !used.has(e.id) && (tab === 'agent' || e.chapter === ch));
      list = follow.concat(list.filter((e) => !follow.includes(e))).slice(0, tab === 'agent' ? 6 : 4);
      this.sugg.innerHTML = '';
      if (!list.length) return;
      this.sugg.appendChild(h('span.muted.small', tab === 'agent' ? 'Tasks:' : 'Try:'));
      list.forEach((e) => {
        const b = h('button.chip', { type: 'button', title: 'Send this', dataset: { entry: e.id } }, e.prompt);
        b.addEventListener('click', () => {
          if (this.busy) return toast('The assistant is still busy – wait a moment.', 'warn');
          this.send(e.prompt, e, 'chip');
        });
        this.sugg.appendChild(b);
      });
    }

    /* ---------------- messages ---------------- */
    addBubble(role, md, meta = {}) {
      const tab = meta.tab || this.tab;
      const b = h('div.ai-msg.' + role + (meta.intro ? '.intro' : ''));
      const body = h('div.ai-body');
      if (role === 'user') body.textContent = md;
      else this.fill(body, md);
      b.appendChild(body);
      if (meta.badge) b.appendChild(h('div.ai-badge', { html: meta.badge }));
      this.threads[tab].appendChild(b);
      this.scroll(tab);
      return b;
    }
    scroll(tab) {
      const t = this.threads[tab || this.tab];
      t.scrollTop = t.scrollHeight;
    }
    fill(body, md) {
      body.innerHTML = '';
      renderMarkdown(md).forEach((blk) => {
        if (blk.html) body.insertAdjacentHTML('beforeend', blk.html);
        else body.appendChild(this.codeBox(blk));
      });
    }
    codeBox(blk) {
      const pre = h('pre.ai-code', h('code', blk.code));
      const head = blk.file ? h('div.ai-code-file', blk.file) : null;
      const acts = h('div.ai-code-acts');
      const btn = (icon, label, fn, primary) => {
        const b = h('button.btn.small' + (primary ? '.primary' : ''), { type: 'button', html: (icon ? MG.icon(icon) : '') + '<span>' + esc(label) + '</span>' });
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            await fn();
          } catch (e) {
            console.error(e);
            toast(esc(e.message || String(e)), 'error');
          } finally {
            b.disabled = false;
          }
        });
        return b;
      };
      const lang = blk.lang;
      const smk = /^(snakemake|snakefile|smk)$/.test(lang);
      if (!blk.example) {
        if (smk) {
          const names = ruleNames(blk.code);
          let label = names.length === 1 ? `Add rule ${names[0]} to Snakefile` : 'Add to Snakefile';
          const e = MG.app.fs && MG.app.fs.get(SNAKEFILE());
          if (names.length === 1 && e && e.kind === 'text' && findRule(e.text, names[0])) label = `Replace rule ${names[0]} in Snakefile`;
          acts.appendChild(btn('plus', label, () => this.toSnakefile(blk.code), true));
        } else if (blk.file) {
          acts.appendChild(btn('save', 'Save as ' + blk.file, () => this.saveAs(blk.file, blk.code), true));
        } else if (lang === 'python' || lang === 'py') {
          acts.append(btn('plus', 'Insert into notebook', () => this.toNotebook(blk.code), true), btn('play', 'Insert and run', () => this.toNotebook(blk.code, true)));
        } else if (/^(bash|sh|shell|console)$/.test(lang)) {
          const first = blk.code.split('\n').find((l) => l.trim() && !l.trim().startsWith('#')) || '';
          if (first) acts.appendChild(btn('terminal', blk.code.trim().split('\n').filter((l) => l.trim()).length > 1 ? 'Type the first command in the terminal' : 'Type in the terminal', () => this.toTerminal(first.replace(/\s+#.*$/, '')), true));
        }
      }
      acts.appendChild(btn('copy', 'Copy', async () => ((await MG.copyText(blk.code)) ? toast('Copied.') : toast('Could not copy.', 'error'))));
      return h('div.ai-codebox' + (blk.example ? '.example' : ''), head, pre, acts);
    }

    /* ---------------- code into the workbench ---------------- */
    async toSnakefile(code) {
      const fs = MG.app.fs;
      if (!fs.isDir(PROJECT())) {
        toast('There is no project folder yet: make ~/cyp2c19-pipeline first (chapter 1).', 'warn', 6000);
        return;
      }
      fs.mkdirp(PROJECT() + '/workflow');
      let text = await snakefileText();
      const names = ruleNames(code);
      const clean = code.replace(/\s+$/, '');
      let line = 1, replaced = [];
      for (const n of names) {
        const r = findRule(text, n);
        if (r) replaced.push(n);
      }
      if (replaced.length && names.length === 1) {
        const r = findRule(text, names[0]);
        const lines = r.lines.slice(0, r.start).concat(clean.split('\n'), r.lines.slice(r.end));
        text = lines.join('\n');
        line = r.start + 1;
        if (!text.endsWith('\n')) text += '\n';
        fs.writeText(SNAKEFILE(), text);
        await MG.app.editFile(SNAKEFILE(), { line });
        toast(`Replaced <b>rule ${esc(names[0])}</b> in workflow/Snakefile (line ${line}). Check it, then run <code>snakemake -n</code>.`, null, 6000);
      } else {
        const sep = !text.trim() ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
        line = (text + sep).split('\n').length;
        text = text + sep + clean + '\n';
        fs.writeText(SNAKEFILE(), text);
        await MG.app.editFile(SNAKEFILE(), { line });
        toast(`Added to the end of workflow/Snakefile (line ${line})${replaced.length ? ' – note: a rule with this name already exists' : ''}. Check it, then run <code>snakemake -n</code>.`, null, 6000);
      }
      bus.emit('ai:insert', { target: 'snakefile', rules: names.join(','), replaced: replaced.join(',') });
    }
    async saveAs(file, code) {
      const fs = MG.app.fs;
      const rel = file.replace(/^\.\//, '');
      const path = rel.startsWith('/') ? rel : rel.startsWith('~/') ? HOME() + rel.slice(1) : PROJECT() + '/' + rel;
      if (!fs.isDir(PROJECT()) && path.startsWith(PROJECT())) {
        toast('There is no project folder yet: make ~/cyp2c19-pipeline first (chapter 1).', 'warn', 6000);
        return;
      }
      const e = fs.get(path);
      if (e && (e.readonly || e.protected)) {
        toast(esc(fs.pretty(path)) + ' is read-only.', 'error');
        return;
      }
      if (e) {
        const old = await fs.readText(path);
        if (old.trim() !== code.trim() && !window.confirm(`${fs.pretty(path)} already exists. Replace its contents with the assistant’s version?`)) return;
      }
      fs.mkdirp(MG.path.dirname(path));
      fs.writeText(path, code.replace(/\s+$/, '') + '\n');
      await MG.app.editFile(path, { line: 1 });
      toast(`Saved <b>${esc(fs.pretty(path))}</b>.`, null, 3000);
      bus.emit('ai:insert', { target: 'file', path });
    }
    async toNotebook(code, run) {
      if (MG.app.showWorkbench) MG.app.showWorkbench('notebook');
      await this.nb.insertCode(code, { run });
      bus.emit('ai:insert', { target: 'notebook', run: !!run });
    }
    async toTerminal(line) {
      if (MG.app.showWorkbench) MG.app.showWorkbench('terminal');
      await MG.app.term.type(line, false);
      bus.emit('ai:insert', { target: 'terminal' });
    }

    /* ---------------- sending ---------------- */
    async send(text, entry, source) {
      const q = (text != null ? text : this.input.value).trim();
      if (!q) return;
      if (this.busy) {
        toast('The assistant is still answering – wait for it to finish' + (this._abort ? ', or press Stop.' : '.'), 'warn');
        return;
      }
      if (text == null) this.input.value = '';
      const tab = entry ? this.entryMode(entry) : this.tab;
      if (tab !== this.tab) this.showTab(tab);
      this.addBubble('user', q);
      this.msgs[tab].push({ role: 'user', content: q });
      const e = entry || (tab === 'agent' || this.mode !== 'live' ? this.match(q, tab) : null);
      bus.emit('ai:ask', { text: q, mode: this.mode, tab, entry: e ? e.id : '', source: source || (text == null ? 'typed' : 'button') });
      if (e) return tab === 'agent' ? this.runAgent(e) : this.playRecorded(e);
      if (tab === 'agent') {
        const reply = 'I can only carry out the tasks listed under this box in this practical. Pick one of them.';
        this.msgs.agent.push({ role: 'assistant', content: reply });
        this.addBubble('assistant', reply, { badge: 'simulated agent' });
        this.renderSuggestions();
        return;
      }
      if (this.mode === 'live') return this.live(q);
      const help = ruleExplainError(q);
      const reply = help
        ? `I don’t have a prepared answer for exactly that, but here is general guidance:\n\n${help}\n\n*Guided mode: rule-based help, not a live AI.*`
        : 'In **guided mode** I only have prepared answers for the practical’s questions (see the suggestions below), so I can’t answer that one properly.\n\n- Try a suggestion, or rephrase using the words in the instructions.\n- **Copy prompt** makes a prompt (with your Snakefile and config) to paste into any AI tool you are allowed to use.\n- With an API key (Google Gemini has a free tier), switch to a **live** model with ⚙.';
      this.msgs.chat.push({ role: 'assistant', content: reply });
      this.addBubble('assistant', reply, { badge: help ? 'guided mode · rule-based help' : 'guided mode · no prepared answer' });
      this.renderSuggestions();
    }
    match(q, tab) {
      const ch = this.currentChapter();
      let best = null, bs = 0;
      this.script.forEach((e) => {
        if (this.entryMode(e) !== tab) return;
        const s = score(q, e) + (e.chapter === ch ? 0.08 : 0) + (this.last[tab] && (this.last[tab].next || []).includes(e.id) ? 0.1 : 0);
        if (s > bs) {
          bs = s;
          best = e;
        }
      });
      return bs >= 0.42 ? best : null;
    }
    async stream(body, full, tab) {
      const words = full.split(/(\s+)/);
      let stop = false;
      const b = body.parentElement;
      const skip = () => (stop = true);
      b.addEventListener('click', skip, { once: true });
      for (let i = 0; i < words.length && !stop; i += 6) {
        this.fill(body, words.slice(0, i + 6).join('') + (i + 6 < words.length ? ' ▍' : ''));
        this.scroll(tab);
        await sleep(16);
      }
      this.fill(body, full);
      this.scroll(tab);
    }
    async playRecorded(e) {
      this.busy = true;
      const tab = 'chat';
      this.last[tab] = e;
      const b = this.addBubble('assistant', '', { tab });
      const body = b.querySelector('.ai-body');
      body.innerHTML = '<span class="ai-typing"><i></i><i></i><i></i></span>';
      await sleep(450 + Math.random() * 400);
      await this.stream(body, e.response, tab);
      b.appendChild(h('div.ai-badge', { html: this.mode === 'live' ? 'prepared answer from the practical' : 'prepared answer · guided mode' }));
      this.msgs[tab].push({ role: 'assistant', content: e.response, entry: e.id });
      this.busy = false;
      bus.emit('ai:answer', { entry: e.id, mode: 'guided' });
      this.renderSuggestions();
    }

    /* ---------------- the agent ---------------- */
    async runAgent(e) {
      const a = e.agent || { kind: 'say' };
      this.busy = true;
      this.last.agent = e;
      try {
        if (a.kind === 'blackbox') await this.blackBox(e, a);
        else if (a.kind === 'glassbox') await this.glassBox(e);
        else {
          const b = this.addBubble('assistant', '', { tab: 'agent' });
          const body = b.querySelector('.ai-body');
          body.innerHTML = '<span class="ai-typing"><i></i><i></i><i></i></span>';
          await sleep(700 + Math.random() * 500);
          await this.stream(body, e.response, 'agent');
          b.appendChild(h('div.ai-badge', 'agent'));
          this.msgs.agent.push({ role: 'assistant', content: e.response, entry: e.id });
        }
        bus.emit('agent:answer', { entry: e.id, kind: a.kind });
      } finally {
        this.busy = false;
        this.renderSuggestions();
      }
    }
    agentCard(title) {
      const card = h('div.ai-msg.assistant.ag');
      const head = h('div.ag-head', { html: MG.icon('robot') + '<b>' + esc(title) + '</b>' });
      const steps = h('ol.ag-steps');
      card.append(head, steps);
      this.threads.agent.appendChild(card);
      this.scroll('agent');
      return { card, steps };
    }
    async blackBox(e, a) {
      const { card, steps } = this.agentCard('Working on it…');
      const t0 = performance.now();
      for (const s of a.steps) {
        const li = h('li.ag-step.run', h('span.ag-ic', { html: '<span class="spinner small"></span>' }), h('span', s));
        steps.appendChild(li);
        this.scroll('agent');
        await sleep(650 + Math.random() * 600);
        li.classList.remove('run');
        li.querySelector('.ag-ic').innerHTML = '✓';
      }
      card.querySelector('.ag-head b').textContent = `Finished in ${a.secs} s`;
      // the file appears in the student's home folder
      const fs = MG.app.fs;
      const path = HOME() + '/' + a.path;
      fs.mkdirp(MG.path.dirname(path));
      fs.writeText(path, ((MG.AI_AGENT_FILES || {})[a.file] || '').replace(/\{DATE\}/g, gatkDate(new Date(Date.now() - (a.secs || 40) * 1000))));
      const body = h('div.ai-body');
      card.appendChild(body);
      await this.stream(body, e.response, 'agent');
      const open = h('button.btn.small.primary', { type: 'button', html: MG.icon('folder') + '<span>Open in Files</span>' });
      open.addEventListener('click', () => MG.app.editFile(path, {}));
      const look = h('button.btn.small', { type: 'button', html: MG.icon('terminal') + '<span>Look at it in the terminal</span>' });
      look.addEventListener('click', async () => {
        MG.app.showWorkbench('terminal');
        await MG.app.term.type('grep -v "^##" ~/' + a.path + ' | head', false);
      });
      card.appendChild(h('div.ag-file', h('span.ag-fname', { html: MG.icon('text') + ' ' + esc('~/' + a.path) }), h('small.muted', MG.humanSize(fs.size(fs.get(path))) + 'B · just now'), h('span.grow'), open, look));
      card.appendChild(h('div.ai-badge', 'agent · ' + ((performance.now() - t0) / 1000).toFixed(0) + ' s in your browser'));
      this.msgs.agent.push({ role: 'assistant', content: e.response, entry: e.id });
      this.agentRuns++;
      bus.emit('agent:file', { path, run: a.file });
      this.scroll('agent');
    }
    /** run a command in the student's own terminal and capture its output */
    async termRun(cmd) {
      const T = MG.app.term;
      for (let i = 0; i < 600 && T.busy; i++) await sleep(100);
      const before = T.outEl.children.length;
      const code = await T.exec(cmd);
      const els = Array.from(T.outEl.children).slice(before + 1);
      const text = els.filter((x) => !x.classList.contains('ask')).map((x) => x.textContent + (x.classList.contains('note') ? '\n' : '')).join('');
      return { code, text };
    }
    async glassBox(e) {
      const fs = MG.app.fs;
      const P = PROJECT();
      const { card, steps } = this.agentCard('Running your pipeline in your terminal');
      const done = [];
      const step = async (cmd, why) => {
        const li = h('li.ag-step.run', h('span.ag-ic', { html: '<span class="spinner small"></span>' }), h('span', h('code', cmd), why ? h('small.muted', ' – ' + why) : null));
        steps.appendChild(li);
        this.scroll('agent');
        const r = await this.termRun(cmd);
        li.classList.remove('run');
        li.classList.toggle('bad', r.code !== 0);
        li.querySelector('.ag-ic').innerHTML = r.code === 0 ? '✓' : '✗';
        const lines = r.text.replace(/\s+$/, '').split('\n');
        const excerpt = (lines.length > 14 ? ['…'].concat(lines.slice(-14)) : lines).join('\n');
        const det = h('details.ag-out', h('summary', `output (exit status ${r.code})`), h('pre', excerpt || '(no output)'));
        li.appendChild(det);
        done.push({ cmd, code: r.code, text: r.text });
        return r;
      };
      let report;
      if (!fs.exists(P + '/workflow/Snakefile')) {
        report = `I looked for your pipeline, but there is no \`workflow/Snakefile\` in \`${fs.pretty(P)}\` yet, so there is nothing for me to run. Build the pipeline first (chapters 4–6), then ask me again.`;
      } else {
        const text = await fs.readText(P + '/workflow/Snakefile');
        const conda = /^\s+conda\s*:/m.test(text);
        await step('cd ' + fs.pretty(P), 'work in your project folder');
        const dry = await step('snakemake -n' + (conda ? ' --use-conda' : ''), 'see what needs to run');
        let ran = null;
        if (dry.code === 0 && !/Nothing to be done/.test(dry.text)) ran = await step('snakemake --cores 1' + (conda ? ' --use-conda' : ''), 'run the jobs that are needed');
        const failed = dry.code !== 0 || (ran && ran.code !== 0);
        let summary = null, n = null, md5 = null;
        const vcf = 'results/variants/NA12878.filtered.vcf.gz';
        if (!failed) {
          summary = await step('snakemake --summary', 'Snakemake’s record of every output');
          if (fs.exists(P + '/' + vcf)) {
            n = await step(`bcftools view -H ${vcf} | wc -l`, 'count the variant records');
            md5 = await step(`bcftools view -H ${vcf} | md5sum`, 'a checksum of the records, to compare with other runs');
          }
        }
        card.querySelector('.ag-head b').textContent = failed ? 'Stopped: a command failed' : 'Done';
        const jobs = /(\d+) of \1 steps \(100%\) done/.exec(ran ? ran.text : '');
        const lines = [];
        lines.push(`I ran **${done.length} commands in your terminal** – they are there with their complete output, and listed above (open *output* under each one).`);
        lines.push('');
        if (failed) {
          const bad = done.find((d) => d.code !== 0);
          const errLines = bad.text.split('\n').filter((l) => /error|exception|failed|missing/i.test(l)).slice(0, 4);
          lines.push(`\`${bad.cmd}\` **failed** (exit status ${bad.code}), so I stopped there instead of guessing. The error messages were:`);
          lines.push('');
          lines.push('```text');
          lines.push((errLines.length ? errLines : bad.text.trim().split('\n').slice(-4)).join('\n'));
          lines.push('```');
          lines.push('');
          lines.push('Fix the problem (the Chat tab can help explain the error), then ask me again.');
        } else {
          lines.push(ran ? `- \`snakemake -n\` showed that jobs needed to run, so I ran them${jobs ? ` – **${jobs[1]} jobs**, all finished` : ''}.` : '- `snakemake -n` said **nothing needed to be done**: every result was already up to date with your code, settings and data, so I did not re-run anything.');
          if (n && md5) {
            const count = (n.text.match(/^\s*(\d+)\s*$/m) || [])[1];
            const sum = (md5.text.match(/[0-9a-f]{32}/) || [])[0];
            lines.push(`- \`${vcf}\` contains **${count || '?'} variant records**; their checksum is \`${sum || '?'}\`.`);
          }
          lines.push('- `snakemake --summary` lists which rule made each output and when; Snakemake keeps the full record (code, parameters, input files, software environment) in `.snakemake/metadata`.');
          lines.push('');
          lines.push('**How to check my work:** run the same commands yourself, or compare the checksum with your earlier runs. I did not interpret the variants – the numbers above come straight from the command output.');
        }
        report = lines.join('\n');
        bus.emit('agent:glassbox', { ok: !failed, commands: done.length });
      }
      const body = h('div.ai-body');
      card.appendChild(body);
      await this.stream(body, report, 'agent');
      card.appendChild(h('div.ai-badge', 'agent · commands run in your terminal'));
      this.msgs.agent.push({ role: 'assistant', content: report, entry: e.id });
    }

    /* ---------------- asked from the terminal or the notebook ---------------- */
    async askAboutError(d) {
      if (this.tab !== 'chat') this.showTab('chat');
      if (this.busy) {
        toast('The assistant is still answering – try again in a moment.', 'warn');
        return;
      }
      const err = (d.error || d.output || '').trim();
      const short = err.split('\n').slice(-12).join('\n');
      const q = `My command failed:\n$ ${d.line}\n${short}`;
      this.addBubble('user', q);
      this.msgs.chat.push({ role: 'user', content: q });
      bus.emit('ai:ask', { text: q, mode: this.mode, tab: 'chat', entry: '', source: 'terminal' });
      if (this.mode === 'live') return this.live(q, { error: d });
      const hay = d.line + '\n' + (d.output || '');
      const e = this.script.find((x) => x.onError && new RegExp(x.onError, 'i').test(hay));
      if (e) return this.playRecorded(e);
      const help = ruleExplainError(hay);
      const reply = (help ? `Here is what that error usually means:\n\n${help}` : 'I don’t recognise that error. Read the **last lines** of the message first – they usually name the problem – and check the file names and your current folder (`pwd`, `ls`).') + '\n\n*Guided mode: rule-based help, not a live AI. For a live explanation, switch to live mode with ⚙ (Google Gemini has a free tier) or use **Copy prompt**.*';
      this.msgs.chat.push({ role: 'assistant', content: reply });
      this.addBubble('assistant', reply, { badge: 'guided mode · rule-based help' });
      bus.emit('ai:answer', { entry: 'rule:error', mode: 'guided' });
    }
    async askAboutCell(d) {
      if (MG.app.showWorkbench) MG.app.showWorkbench('assistant');
      if (this.tab !== 'chat') this.showTab('chat');
      if (this.busy) return toast('The assistant is still answering – try again in a moment.', 'warn');
      const c = d.cell;
      const what = d.kind === 'fix' ? 'Explain this error and how to fix it.' : d.kind === 'improve' ? 'How could this code be improved?' : 'Explain what this code does.';
      const shortCode = c.code.length > 400 ? c.code.slice(0, 400) + '\n…' : c.code;
      const q = `${what}\n\n${shortCode}${d.kind === 'fix' && c.error ? `\n\n${c.error.ename}: ${c.error.evalue}` : ''}`;
      this.addBubble('user', q);
      this.msgs.chat.push({ role: 'user', content: q });
      if (this.mode === 'live') return this.live(q, { cell: c });
      let reply;
      if (d.kind === 'fix' && c.error) {
        const e = c.error;
        const L = [`**${e.ename}**: ${e.evalue || ''}`, '', PY_ERRORS[e.ename] || 'Read the last line of the error first: it names the problem. The line number points to where Python noticed it.'];
        const ln = /line (\d+)/.exec(e.traceback || '');
        if (ln) {
          const src = c.code.split('\n')[+ln[1] - 1];
          if (src) L.push('', `The problem was noticed on line ${ln[1]}:`, '', '```text', src, '```');
        }
        reply = L.join('\n');
      } else if (d.kind === 'improve') reply = 'In **guided mode** I can’t review your own code. Ask yourself: does it still work after **Restart and run all**? Would it run as a script, from the top, in a fresh Python? Are file names relative to the project folder? Is anything typed in by hand that should come from `config.yaml`?';
      else {
        const notes = [
          [/^\s*import\s|^\s*from\s.+\simport\s/m, '`import` loads a package (a library of ready-made functions).'],
          [/\[[^\]]*\]/, 'Square brackets make a **list** (`[a, b]`) – or pick an item from one (`samples[0]`, counting from 0).'],
          [/\{[^}]*:[^}]*\}/, 'Curly brackets with `key: value` pairs make a **dictionary**; `config["min_qual"]` looks up a value.'],
          [/f"|f'/, 'An **f-string** (`f"…{name}…"`) fills the value of `name` into the text.'],
          [/\.format\(/, '`.format(name=…)` fills values into the `{name}` placeholders of a string – the way Snakemake fills in `{sample}`.'],
          [/^\s*for\s.+:/m, 'A `for` loop repeats the indented lines once for each item.'],
          [/^\s*def\s/m, '`def` defines a **function**: a named, reusable piece of code; `return` gives back its result.'],
          [/yaml\.safe_load/, '`yaml.safe_load` reads a YAML file (like `config.yaml`) into Python dictionaries and lists.'],
          [/print\(/, '`print(...)` shows values below the cell.'],
          [/expand\(/, '`expand()` makes every combination of a file-name pattern and values – Snakemake’s way of listing files for all samples.']
        ].filter(([re]) => re.test(c.code)).map(([, t]) => '- ' + t);
        reply = notes.length ? `What the main parts of this cell do:\n\n${notes.join('\n')}` : 'I could not match this code to anything in my guide – try a live model (⚙) or **Copy prompt**.';
      }
      reply += '\n\n*Guided mode: rule-based help, not a live AI.*';
      this.msgs.chat.push({ role: 'assistant', content: reply });
      this.addBubble('assistant', reply, { badge: 'guided mode · rule-based help' });
      bus.emit('ai:answer', { entry: 'rule:' + d.kind, mode: 'guided' });
    }

    /* ---------------- live mode ---------------- */
    systemPrompt() {
      const v = (this.nb && this.nb.kernel && this.nb.kernel.versions) || {};
      return [
        'You are an AI coding assistant embedded in a browser-based practical for MSc bioinformatics students on pipelines and reproducibility (Claerbout’s principle: an article about a computational result is only advertising; the scholarship is the complete software environment and instructions – and the data – that produced it).',
        'The students turn a variant-calling analysis (NA12878 exome reads around CYP2C19 and CYP2C9, two slices of hg19) into a Snakemake pipeline, then build the same workflow in a Galaxy-style workflow editor. For most of them this is their first contact with Python.',
        '',
        'Environment (all in the web browser): a bash-like terminal; Snakemake ' + ((v.snakemake || '9.27.0')) + ' (a faithful browser re-implementation); Python ' + (v.python || '3.13') + ' with pandas, numpy, matplotlib and pyyaml (Pyodide); minimap2 2.22, samtools 1.17, bcftools 1.10 (with htslib 1.10), bgzip/tabix (htslib 1.17) and Graphviz dot, compiled to WebAssembly; a conda model with environments "base" and "pipelines". No internet access from the terminal or Python, and no other programs (no bwa, gatk, fastqc, git, docker). Shell: no loops, no command substitution.',
        'Project folder: ~/cyp2c19-pipeline with data/raw/NA12878_R1.fastq, NA12878_R2.fastq, reference.fa (+ .fai), config/config.yaml, workflow/Snakefile, workflow/envs/, workflow/scripts/, results/, logs/.',
        '',
        'How to answer: be brief and friendly; explain in plain language and explain Python syntax when you use it; put Snakefile code in ```snakemake blocks, notebook code in ```python blocks and terminal commands in ```bash blocks; use relative paths; never invent program options – if unsure, tell the student to check `PROGRAM --help`. Do not claim to have run anything or seen results you were not shown. Help the student learn rather than just handing over answers to the practical questions.'
      ].join('\n');
    }
    async contextFor(extra = {}) {
      let ctx = '';
      try {
        const fs = MG.app.fs;
        if (fs.exists(SNAKEFILE())) ctx += `The student's workflow/Snakefile:\n\`\`\`snakemake\n${(await fs.readText(SNAKEFILE())).slice(0, 6000)}\n\`\`\`\n\n`;
        const cfg = PROJECT() + '/config/config.yaml';
        if (fs.exists(cfg)) ctx += `config/config.yaml:\n\`\`\`yaml\n${(await fs.readText(cfg)).slice(0, 1500)}\n\`\`\`\n\n`;
      } catch (e) {
        /* optional */
      }
      if (extra.error) ctx += `The command that failed: \`${extra.error.line}\` (in ${extra.error.cwd}). Its output ended:\n\`\`\`text\n${(extra.error.output || '').slice(-3000)}\n\`\`\`\n\n`;
      if (extra.cell) {
        ctx += `The student is asking about this notebook cell:\n\`\`\`python\n${extra.cell.code}\n\`\`\`\n`;
        if (extra.cell.error) ctx += `It raised:\n\`\`\`text\n${(extra.cell.error.traceback || extra.cell.error.ename + ': ' + extra.cell.error.evalue).slice(0, 2500)}\n\`\`\`\n`;
      } else if (this.nb && this.nb.codeContext && this.currentChapter() === 'python') {
        const code = this.nb.codeContext(3000);
        if (code) ctx += `The student's notebook:\n\`\`\`python\n${code}\n\`\`\`\n\n`;
      }
      return ctx;
    }
    async live(q, extra) {
      if (!this.key && needsKey(this.settings)) {
        this.addBubble('assistant', 'No API key is set for live mode. Open ⚙ to add one, or switch back to guided mode.', { badge: 'live mode' });
        return;
      }
      this.busy = true;
      this._abort = new AbortController();
      this.sendBtn.innerHTML = MG.icon('stop') + '<span>Stop</span>';
      const b = this.addBubble('assistant', '', { tab: 'chat' });
      const body = b.querySelector('.ai-body');
      body.innerHTML = '<span class="ai-typing"><i></i><i></i><i></i></span>';
      const hist = this.msgs.chat.slice(-12).map((m) => ({ role: m.role, content: m.content }));
      while (hist.length && hist[0].role !== 'user') hist.shift();
      if (hist.length) hist[hist.length - 1] = { role: 'user', content: (await this.contextFor(extra || {})) + 'Question: ' + hist[hist.length - 1].content };
      let text = '';
      const t0 = performance.now();
      try {
        const res = await this.streamLive(
          hist,
          (delta) => {
            text += delta;
            this.fill(body, text + ' ▍');
            this.scroll('chat');
          },
          this._abort.signal,
          null,
          (note) => {
            if (!text) body.innerHTML = `<div class="muted" style="font-size:0.85em;margin-bottom:0.35em">${esc(note)}</div><span class="ai-typing"><i></i><i></i><i></i></span>`;
          }
        );
        this.fill(body, text || '(no reply)');
        const via = res.skipped.length ? ` (${res.skipped.map((x) => x.model + ' ' + skipWord(x.status)).join(', ')})` : '';
        b.appendChild(h('div.ai-badge', { html: `live · ${esc(res.model + via)} · ${((performance.now() - t0) / 1000).toFixed(1)} s` }));
        this.msgs.chat.push({ role: 'assistant', content: text });
        bus.emit('ai:answer', { entry: 'live', mode: 'live' });
      } catch (e) {
        if (e.name === 'AbortError') {
          this.fill(body, (text || '') + '\n\n*(stopped)*');
          if (text) this.msgs.chat.push({ role: 'assistant', content: text });
        } else {
          this.fill(body, '**The AI service returned an error.**\n\n' + e.message);
          b.classList.add('err');
        }
      } finally {
        this.busy = false;
        this._abort = null;
        this.sendBtn.innerHTML = MG.icon('send') + '<span>Send</span>';
      }
    }
    /* Stream an answer from the chosen service. For Gemini, when a model is busy (HTTP 5xx), over
       its free-tier limit (429) or not found (404), the fallback models are asked in turn; the last
       model asked (for other services, the only one) gets a second try after a short pause if it is
       busy. Returns { model, skipped }: the model that answered and the ones that could not. */
    async streamLive(messages, onDelta, signal, cfg, onNote) {
      const s = (cfg && cfg.settings) || this.settings;
      const key = cfg ? cfg.key : this.key;
      const note = onNote || (() => {});
      // turns must alternate between user and assistant: join neighbours of the same role
      messages = messages.reduce((out, m) => {
        const last = out[out.length - 1];
        if (last && last.role === m.role) last.content += '\n\n' + m.content;
        else out.push({ role: m.role, content: m.content });
        return out;
      }, []);
      const gemini = s.provider === 'gemini';
      const chain = gemini ? [geminiModelOf(s)].concat(GEMINI_FALLBACKS.filter((m, i, a) => a.indexOf(m) === i && m !== geminiModelOf(s))) : [modelOf(s)];
      const skipped = [];
      let first = null;
      for (let i = 0; i < chain.length; i++) {
        for (let attempt = 1; ; attempt++) {
          let started = false;
          try {
            await this.streamOnce(s, key, chain[i], messages, (d) => {
              started = true;
              onDelta(d);
            }, signal);
            return { model: chain[i], skipped };
          } catch (e) {
            // only an HTTP error that came before any text is worth another try
            if (e.name === 'AbortError' || started || !e.status) throw e;
            const busy = BUSY.includes(e.status);
            const last = i === chain.length - 1;
            if (i === 0 && attempt === 1) first = e;
            // "high demand" usually lasts minutes: go straight to the next model …
            if (gemini && !last && (busy || e.status === 429 || e.status === 404)) {
              skipped.push({ model: chain[i], status: e.status });
              note(`${chain[i]} ${e.status === 404 ? 'was not found' : e.status === 429 ? 'is over its free-tier limit' : 'is busy'} – asking ${chain[i + 1]} instead…`);
              break;
            }
            // … and give the last one a second try after a short pause
            if (last && busy && attempt === 1) {
              note(`${chain[i]} is busy – trying again…`);
              await pause(1500 + Math.random() * 1500, signal);
              continue;
            }
            // nothing answered: report the chosen model's error, and what the others said
            if (i === 0) throw e;
            first.message += ` (Also tried: ${skipped.slice(1).map((x) => x.model + ' – HTTP ' + x.status).concat(chain[i] + ' – HTTP ' + e.status).join('; ')}.)`;
            throw first;
          }
        }
      }
    }
    /** one request: the answer is passed to onDelta as it arrives; HTTP errors carry .status */
    async streamOnce(s, key, model, messages, onDelta, signal) {
      let r;
      if (s.provider === 'anthropic') {
        r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
          body: JSON.stringify({ model: anthropicModelOf(s), max_tokens: 2000, system: this.systemPrompt(), messages, stream: true }),
          signal
        }).catch((e) => {
          if (e.name === 'AbortError') throw e;
          throw new Error('Could not reach the Anthropic API (' + e.message + '). Check the internet connection.');
        });
      } else if (s.provider === 'gemini') {
        // Google's Gemini API (generateContent, streamed as server-sent events); the whole conversation is sent each time
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: this.systemPrompt() }] },
            contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
          }),
          signal
        }).catch((e) => {
          if (e.name === 'AbortError') throw e;
          throw new Error('Could not reach the Gemini API (' + e.message + '). Check the internet connection.');
        });
      } else {
        const base = (s.baseURL || '').replace(/\/+$/, '');
        r = await fetch(base + '/chat/completions', {
          method: 'POST',
          headers: Object.assign({ 'content-type': 'application/json' }, key ? { authorization: 'Bearer ' + key } : {}),
          body: JSON.stringify({ model: s.openaiModel, stream: true, messages: [{ role: 'system', content: this.systemPrompt() }].concat(messages) }),
          signal
        }).catch((e) => {
          if (e.name === 'AbortError') throw e;
          throw new Error('Could not reach ' + base + ' (' + e.message + '). Check the address; the service must allow requests from web pages (CORS).');
        });
      }
      if (!r.ok) {
        let detail = '';
        let reason = '';
        try {
          const j = await r.json();
          detail = (j.error && (j.error.message || j.error.type)) || JSON.stringify(j).slice(0, 300);
          reason = (j.error && ((j.error.details || []).map((d) => d.reason).filter(Boolean)[0] || j.error.status)) || '';
        } catch (e) {
          detail = r.statusText;
        }
        const badKey = r.status === 401 || r.status === 403 || reason === 'API_KEY_INVALID';
        const gem = s.provider === 'gemini';
        const why = badKey
          ? 'The API key was not accepted.'
          : r.status === 404
            ? `The model name${gem ? ' (' + model + ')' : ''} may be wrong, or the model has been retired – check the model name in ⚙.`
            : r.status === 429
              ? gem
                ? 'Too many requests: the free tier allows only a few requests per minute and per day – wait a minute and try again.'
                : 'Too many requests or no credit left – try again in a minute.'
              : BUSY.includes(r.status)
                ? gem
                  ? `Google’s servers are busy for ${model} (“high demand”). This is on Google’s side, not a problem with your key: wait a minute and try again, or choose another model in ⚙.`
                  : 'The service is busy or had a temporary problem – try again in a minute.'
                : '';
        throw Object.assign(new Error(`HTTP ${r.status}. ${why} ${detail}`.trim()), { status: r.status });
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, k).trim();
          buf = buf.slice(k + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let j;
          try {
            j = JSON.parse(data);
          } catch (e) {
            continue;
          }
          if (s.provider === 'anthropic') {
            if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') onDelta(j.delta.text);
            else if (j.type === 'error') throw Object.assign(new Error((j.error && j.error.message) || 'stream error'), { status: j.error && j.error.type === 'overloaded_error' ? 529 : undefined });
          } else if (s.provider === 'gemini') {
            if (j.error) throw Object.assign(new Error(j.error.message || 'stream error'), { status: j.error.code });
            if (j.promptFeedback && j.promptFeedback.blockReason) throw new Error('Gemini did not answer (' + j.promptFeedback.blockReason + ').');
            const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
            parts.forEach((p) => {
              if (p.text && !p.thought) onDelta(p.text);
            });
          } else {
            const dd = j.choices && j.choices[0] && j.choices[0].delta;
            if (dd && dd.content) onDelta(dd.content);
          }
        }
      }
    }

    /* ---------------- a prompt for another AI tool ---------------- */
    async buildPrompt(question) {
      const q = question || this.input.value.trim() || '[write your question here]';
      const ctx = await this.contextFor({});
      return [
        'I am learning Snakemake (version 9) in a bioinformatics practical. My project folder is cyp2c19-pipeline/ with data/raw/ (NA12878_R1.fastq, NA12878_R2.fastq, reference.fa), config/config.yaml, workflow/Snakefile, workflow/envs/ and workflow/scripts/. The tools are minimap2 2.22, samtools 1.17 and bcftools 1.10; Python 3.13 with pandas and matplotlib.',
        '',
        ctx || '(My Snakefile is empty so far.)',
        'My question: ' + q,
        '',
        'Please answer briefly, explain any Python syntax you use, and only use options that really exist in these program versions.'
      ].join('\n');
    }
    async copyPrompt() {
      const text = await this.buildPrompt();
      const ok = await MG.copyText(text);
      const m = MG.modal(
        'A prompt for any AI tool',
        `<p class="small">${ok ? '<b>Copied to the clipboard.</b> ' : ''}Paste it into an AI tool you are allowed to use – then check what it gives you, just as you check this assistant. The prompt contains your Snakefile and config file (not your data) and the question in the assistant’s box. Read it first: what does it tell the AI, and what does it leave out? Never paste personal or patient data into an AI tool.</p><textarea class="prompt-text" readonly aria-label="Prompt">${esc(text)}</textarea><div class="prompt-actions"><button class="btn" data-x="copy" type="button">${MG.icon('copy')}<span>Copy</span></button><button class="btn primary" data-x="ok" type="button">Done</button></div>`
      );
      m.box.querySelector('[data-x="copy"]').addEventListener('click', async () => toast((await MG.copyText(text)) ? 'Prompt copied.' : 'Could not copy – select the text and copy it yourself.', null, 2500));
      m.box.querySelector('[data-x="ok"]').addEventListener('click', () => m.close());
      bus.emit('ai:copyprompt', {});
    }

    /* ---------------- settings ---------------- */
    settingsDialog() {
      const s = this.settings;
      let remembered = false;
      try {
        remembered = !!window.sessionStorage.getItem(KEY_NAME);
      } catch (e) {
        remembered = false;
      }
      const html = `
<div class="ai-set">
  <label class="ai-opt"><input type="radio" name="aimode" value="guided" ${this.mode === 'guided' ? 'checked' : ''}> <span><b>Guided</b> – prepared answers for the practical (no account needed). Some contain deliberate mistakes to find.</span></label>
  <label class="ai-opt"><input type="radio" name="aimode" value="live" ${this.mode === 'live' ? 'checked' : ''}> <span><b>Live AI</b> – connect a real model with your own API key, or one provided by your lecturer. Applies to the Chat tab; the agent stays simulated.</span></label>
  <div class="ai-live-box">
    <label>Service <select data-k="provider"><option value="gemini" ${s.provider === 'gemini' ? 'selected' : ''}>Google Gemini (free tier available)</option><option value="anthropic" ${s.provider === 'anthropic' ? 'selected' : ''}>Anthropic (Claude)</option><option value="openai" ${s.provider === 'openai' ? 'selected' : ''}>OpenAI-compatible service</option></select></label>
    <label data-show="gemini">Model <input data-k="geminiModel" value="${esc(geminiModelOf(s))}" spellcheck="false"></label>
    <p data-show="gemini" class="muted small">Make a free key with a Google account at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> (you must be 18 or over). On the free tier Google may use what you send to improve its products, and human reviewers may read it. The free tier allows only a few requests per minute and per day.</p>
    <label data-show="anthropic">Model <input data-k="model" value="${esc(anthropicModelOf(s))}" spellcheck="false"></label>
    <label data-show="openai">Base URL <input data-k="baseURL" value="${esc(s.baseURL)}" spellcheck="false"></label>
    <label data-show="openai">Model <input data-k="openaiModel" value="${esc(s.openaiModel)}" placeholder="the model name your service uses" spellcheck="false"></label>
    <label>API key <input data-k="key" type="password" value="${esc(this.key)}" autocomplete="off" spellcheck="false" placeholder="paste the key here"></label>
    <label class="ai-cb"><input type="checkbox" data-k="remember" ${remembered ? 'checked' : ''}> Remember the key until I close this browser tab</label>
    <p class="muted small">In live mode your messages, your Snakefile and config file and – when you ask about an error – the command and its output are sent from your browser straight to the service you choose (your data files are not). The key is kept only in this browser tab. The suggestions keep using the practical’s prepared answers. Never paste personal or patient data into an AI tool.</p>
  </div>
  <div class="prompt-actions"><span class="ai-test-out muted small"></span><button class="btn" data-x="test" type="button">Test</button><button class="btn primary" data-x="save" type="button">Save</button></div>
</div>`;
      const m = MG.modal('AI assistant settings', html);
      const B = m.box;
      const val = (k) => B.querySelector(`[data-k="${k}"]`);
      const sync = () => {
        const live = B.querySelector('input[name="aimode"]:checked').value === 'live';
        B.querySelector('.ai-live-box').classList.toggle('off', !live);
        const p = val('provider').value;
        B.querySelectorAll('[data-show]').forEach((el) => (el.hidden = el.dataset.show !== p));
      };
      B.querySelectorAll('input[name="aimode"]').forEach((r) => r.addEventListener('change', sync));
      val('provider').addEventListener('change', sync);
      sync();
      // a model left at the site's default is saved as '' (= follow config.js)
      const own = (k, dflt) => {
        const v = val(k).value.trim().replace(/^models\//, '');
        return v && v !== dflt ? v : '';
      };
      const read = () => ({
        settings: { provider: val('provider').value, model: own('model', LIVE_DEFAULTS.model), geminiModel: own('geminiModel', LIVE_DEFAULTS.geminiModel), baseURL: val('baseURL').value.trim(), openaiModel: val('openaiModel').value.trim() },
        key: val('key').value.trim()
      });
      B.querySelector('[data-x="test"]').addEventListener('click', async () => {
        const out = B.querySelector('.ai-test-out');
        out.textContent = 'Testing…';
        let got = '';
        try {
          const res = await this.streamLive([{ role: 'user', content: 'Reply with the single word: ready' }], (d) => (got += d), undefined, read(), (note) => (out.textContent = note));
          out.textContent = '✓ Connected: “' + got.trim().slice(0, 40) + '”' + (res.skipped.length ? ` – from ${res.model} (${res.skipped.map((x) => x.model + ' ' + skipWord(x.status)).join(', ')})` : '');
        } catch (e) {
          out.textContent = '✗ ' + e.message;
        }
      });
      B.querySelector('[data-x="save"]').addEventListener('click', () => {
        const r = read();
        const want = B.querySelector('input[name="aimode"]:checked').value;
        if (want === 'live' && !r.key && needsKey(r.settings)) {
          toast('Add an API key for live mode (or choose guided mode).', 'warn');
          return;
        }
        this.settings = r.settings;
        this.key = r.key;
        store.set('ai:settings', this.settings);
        try {
          if (val('remember').checked && this.key) window.sessionStorage.setItem(KEY_NAME, this.key);
          else window.sessionStorage.removeItem(KEY_NAME);
        } catch (e) {
          /* storage may be blocked */
        }
        const changed = want !== this.mode;
        this.mode = want;
        store.set('ai:mode', want);
        this.renderMode();
        m.close();
        if (changed) {
          this.addBubble('assistant', want === 'live' ? 'Switched to **live** mode – I am now a real AI model. Check everything I tell you.' : 'Switched to **guided** mode.', { tab: 'chat' });
          bus.emit('ai:mode', { mode: want });
        }
      });
    }
  }

  MG.Assistant = Assistant;
  MG.renderMarkdown = renderMarkdown;
  MG.aiUtil = { findRule, ruleNames, renderMarkdown, score };
})();
