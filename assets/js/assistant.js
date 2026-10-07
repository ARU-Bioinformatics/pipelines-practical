/* =====================================================================
   The AI assistant of the pipelines practical.

   Chat tab  – an AI coding assistant. In guided mode (default) its answers
               to the practical's questions were prepared in advance; some
               contain the mistakes AI assistants really make, on purpose.
               Code blocks can go straight into the Snakefile, a file, the
               notebook or the terminal. Failed terminal commands can be
               sent here with "Ask the AI assistant about this error".
   Agent tab – in live mode, a task the student types goes to a real agent
     (a live model that runs commands in the terminal, in its own folder).
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
  /* A Gemini model can be busy (HTTP 503 "high demand"), give no answer at all, or be over one
     of its limits (429) – on the free tier each model has limits of its own, per minute and per
     day. Then the next model of this list is asked; the answer says which one replied.
     The page remembers what a model said, and does not ask it again before that can have
     changed: a busy model after two minutes (then four, eight … if it is busy again), a silent
     one after one minute, a model over a limit when the service says the limit is over (a limit
     per day: not before tomorrow), a model that was not found not at all. That saves time –
     "busy" can take twenty seconds to arrive – and requests, of which the free tier allows few:
     on 6 October 2026, 20 a day for each of the four larger models, and a request that was
     answered "busy" counted as one of them. The memory belongs to one key – another key is
     another project, with limits of its own – and lasts until the page is loaded again. */
  const FALLBACK_DEFAULT = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
  const FALLBACKS = (Array.isArray(CFG.geminiFallbackModels) ? CFG.geminiFallbackModels : FALLBACK_DEFAULT).map((m) => String(m).trim().replace(/^models\//, '')).filter(Boolean);
  const BUSY = [500, 502, 503, 504, 529];
  const BUSY_REST = 120, SILENT_REST = 60; // seconds
  const RETRY = 20; // seconds after which it is worth asking busy or silent models again
  /* how long a Gemini model may say nothing – before its answer begins, or in the middle of it – until the request is given up */
  const WAIT = () => (+CFG.aiWaitSeconds > 0 ? Math.max(1, +CFG.aiWaitSeconds) : 60);
  const REST = new Map(); // model → { model, why: 'busy' | 'noanswer' | 'limit' | 'notfound', at, until (ms), daily, limit, n, status, text }
  let restKey = null;
  const resting = (model) => {
    const r = REST.get(model);
    return r && r.until > Date.now() ? r : null;
  };
  const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  /** what kept a model from answering: in a word or two (under an answer, in the bar) … */
  const skipWord = (x) => (x.why === 'notfound' ? 'not found' : x.why === 'limit' ? (x.daily ? 'over its limit for today' : 'over its limit') : x.why === 'noanswer' ? 'gave no answer' : x.why === 'broke' ? 'broke off' : 'busy');
  /** … and as part of a sentence – with the numbers that the service gave, unless short */
  const told = (x, short) =>
    x.why === 'notfound'
      ? 'was not found'
      : x.why === 'limit'
        ? x.daily
          ? 'is over its limit for today' + (short ? '' : (x.limit != null ? `: ${x.limit} requests a day` : '') + (isFinite(x.until) ? `, again after ${hhmm(x.until)}` : ''))
          : 'is over its limit per minute'
        : x.why === 'noanswer'
          ? 'gave no answer'
          : 'is busy';
  /** the error when no Gemini model answered: what each one said. .status: 429 (limits), 503 (busy), 404, or not set
      (no answer came); .retryIn: after how many seconds asking again can help – 0 when it cannot today */
  function noAnswer(all, connection) {
    const some = (f) => all.some(f);
    const waits = all.filter((x) => x.why === 'limit' && !x.daily).map((x) => Math.min(90, Math.max(1, Math.ceil((x.until - Date.now()) / 1000))));
    if (some((x) => x.why === 'busy' || x.why === 'noanswer')) waits.push(RETRY);
    const retryIn = waits.length ? Math.min(...waits) : 0;
    // one model only (no fallback models): its own words
    if (all.length === 1) return Object.assign(new Error(all[0].text), { status: all[0].status, network: all[0].why === 'noanswer', retryIn });
    let status, lead;
    // (a model that answered within the last two minutes, if only with "busy" or "over its limit": the service can be reached)
    const heard = some((x) => x.status && Date.now() - x.at < 120000);
    if (connection || (some((x) => x.why === 'noanswer') && !some((x) => x.why === 'busy'))) lead = heard ? 'No answer came from the Gemini API, though it can be reached: try again in a moment.' : 'Could not reach the Gemini API: no answer came. Check the internet connection, and try again.';
    else if (some((x) => x.why === 'busy')) (status = 503), (lead = 'HTTP 503. Google’s servers are busy (“high demand”). That is on Google’s side, not a problem with your key: wait a minute and try again.');
    else if (waits.length) (status = 429), (lead = 'HTTP 429. Too many requests: the free tier allows only a few requests per minute – wait a minute and try again.');
    else if (some((x) => x.why === 'limit')) (status = 429), (lead = 'HTTP 429. No requests are left for today: every model that this page asks is over its limit for this key. The free tier allows each model a number of requests per day, counted per project. Go on when the service takes requests again, or use a key from another person or project.');
    else (status = 404), (lead = 'HTTP 404. None of the models was found – check the model in the AI settings (⚙).');
    return Object.assign(new Error(`${lead} (${all.map((x) => x.model + ' ' + told(x)).join('; ')}.)`), { status, network: !status, retryIn });
  }
  const stopped = () => new DOMException('Stopped', 'AbortError');
  /* ---- the real agent (live mode): what it may run, and where ---- */
  const AGENT_MAX = 15; // commands per task
  const AGENT_OUT = 3000; // characters of each command's output that the model sees
  const AGENT_TOOLS = ['minimap2', 'samtools', 'bcftools', 'bgzip', 'tabix'];
  const AGENT_UTILS = ['ls', 'pwd', 'mkdir', 'cp', 'mv', 'rm', 'rmdir', 'touch', 'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'tee', 'paste', 'join', 'comm', 'seq', 'grep', 'egrep', 'fgrep', 'zgrep', 'sed', 'awk', 'gawk', 'zcat', 'gunzip', 'gzip', 'md5sum', 'sha256sum', 'tree', 'find', 'xargs', 'basename', 'dirname', 'realpath', 'mktemp', 'echo', 'printf', 'printenv', 'date', 'diff', 'cmp', 'du', 'stat', 'file', 'column', 'nl', 'tac', 'rev', 'fold', 'od', 'bc', 'expr', 'sleep', 'which', 'type', 'true', 'false', 'test', '[', 'read', 'help', 'man'];
  // (words of the shell itself, which run no program)
  const AGENT_SHELL = ['export', 'unset', 'set', 'shopt', 'local', 'declare', 'typeset', 'readonly', 'let', 'shift', 'getopts', 'mapfile', 'readarray', 'exit', 'return', 'break', 'continue', ':', 'command', 'env', 'time'];
  // a step of the agent that has not ended after this many seconds is stopped (config.js: agentCommandSeconds)
  const AGENT_SECONDS = Math.max(5, +CFG.agentCommandSeconds || 150);
  const AGENT_OK = new Set(AGENT_TOOLS.concat(AGENT_UTILS, AGENT_SHELL));
  const agentList = () => AGENT_TOOLS.concat(AGENT_UTILS).join(', ');
  /** why the agent may not run this text ('' if it may): a command in it that the agent has not got. The names are
      those that the shell itself reads in the text – also inside $( ), loops and pipes. Nothing of such a text is
      run. (A name that is only known when the text runs – "$tool", the program that xargs or find -exec starts – is
      checked when it runs: see dispatch in shell-pipe.js.) */
  function agentRefusal(text) {
    let names;
    try {
      names = MG.shellLang.commandNames(text);
    } catch (e) {
      return ''; // (not readable as shell: nothing of it runs, and the terminal says why)
    }
    // (functions that the agent defined in an earlier step are its own)
    let funcs = {};
    try {
      funcs = MG.app.term.shell._top().funcs || {};
    } catch (e) {
      /* no shell yet */
    }
    const bad = names.filter((c) => c !== '$' && !/^\d+$/.test(c) && !AGENT_OK.has(c) && !Object.prototype.hasOwnProperty.call(funcs, c)).filter((c, i, a) => a.indexOf(c) === i);
    if (!bad.length) return '';
    if (bad.includes('cd')) return 'cd is not available: the terminal stays in your folder, so use relative paths.';
    return `${bad.map((b) => '`' + b + '`').join(', ')} ${bad.length > 1 ? 'are' : 'is'} not available to you. You can use: ${agentList()}.`;
  }
  const SHELL_FENCE = ['', 'bash', 'sh', 'shell', 'console', 'zsh', 'shell-session', 'shellscript', 'terminal', 'cmd', 'command'];
  /** The command in an agent's reply: its first shell code block, as it was written ('' = empty block, null = none).
      A model sometimes begins its command on the line of the fence itself –
          ```bcftools view -H raw.vcf | wc -l
      (gemini-3.5-flash-lite did, on 6 October 2026, and the step was taken for the report: the task ended there).
      Such a line is the first line of the command: where a command that the agent has is followed by more words
      – one word alone is the name of a language (```diff, ```awk, ```text) –, also after the name of a shell
      (```bash samtools index x.bam). And sometimes the whole command stands between two fences on one line
      (```bcftools stats raw.vcf | grep "^SN"``` – the same model, the same day). */
  function agentStep(reply) {
    const re = /```([^\n`]*)(?:\n([\s\S]*?)```|```)/g;
    let m;
    while ((m = re.exec(reply))) {
      const info = m[1].trim(), words = info.split(/\s+/).filter(Boolean);
      const shell = SHELL_FENCE.includes((words[0] || '').toLowerCase());
      let first = '';
      if (m[2] === undefined) {
        // (one line between two fences: a command if it begins with one – after the name of a shell, or not)
        if (shell && words.length > 1 && AGENT_OK.has(words[1])) first = info.slice(words[0].length).trim();
        else if (words.length && AGENT_OK.has(words[0])) first = info;
        else continue;
        return { cmd: first, before: withoutCode(reply.slice(0, m.index)), after: withoutCode(reply.slice(re.lastIndex)) };
      }
      if (shell) {
        if (words.length > 1 && AGENT_OK.has(words[1])) first = info.slice(words[0].length).trim();
      } else if (words.length > 1 && AGENT_OK.has(words[0])) first = info;
      else continue;
      const body = m[2]
        .replace(/\r/g, '')
        .split('\n')
        .map((l) => l.replace(/^\s*\$\s+/, ''))
        .join('\n')
        .trim();
      // (before, after: what the reply says in front of the block of its command, and behind it)
      return { cmd: first ? first + (body ? '\n' + body : '') : body, before: withoutCode(reply.slice(0, m.index)), after: withoutCode(reply.slice(re.lastIndex)) };
    }
    return { cmd: null, before: '', after: '' };
  }
  const agentCommand = (reply) => agentStep(reply).cmd;
  /* A model sometimes goes on writing after the block of its command – its report, with what the command "showed",
     before the command has run (gemini-3.1-flash-lite did, on 6 October 2026: "… confirmed that variants were
     identified", and no number). The reply is a step all the same; but what stands behind the block, when it is more
     than a remark, is not shown as the description of the step: the card says so, and the agent is told. */
  const AGENT_AHEAD = 120; // characters behind the block from which this holds
  const AGENT_AHEAD_TOLD = 'What you wrote after the code block was written before the command had run; it was not shown to the user. Send your report when you have read the output – without a code block.';
  // (what the agent is told, once in a task, when a reply has a code block that is no command)
  const AGENT_REMIND = 'Nothing was run: your reply had a code block, but not a ```bash block with a command. If you meant to run a command, send it again in a ```bash block. If that was your report, send it again without any code block.';
  /** the commands of a block, one by one (a loop or an if … fi is one command) */
  function agentParts(cmd) {
    try {
      const parts = MG.shellLang.statements(cmd, { extglob: MG.shellLang.extglobOn(MG.app.term.shell._top()) });
      return parts.length ? parts : [cmd];
    } catch (e) {
      return [cmd];
    }
  }
  // (for the tests)
  MG.agentRules = { ok: AGENT_OK, tools: AGENT_TOOLS, refusal: agentRefusal, command: agentCommand, step: agentStep, parts: agentParts, seconds: AGENT_SECONDS };
  const withoutCode = (reply) => reply.replace(/```[\s\S]*?(```|$)/g, '').trim();
  const insideDir = (k, root) => k === root || k.startsWith(root + '/');
  // the agent's own folder, and /tmp, where the programs keep temporary files
  const agentMay = (k, root) => insideDir(k, root) || insideDir(k, '/tmp');
  /** every file entry outside the agent's folder, to put back what a command changed there */
  function outsideSnapshot(fs, root) {
    const m = new Map();
    for (const [k, v] of fs.entries) if (!agentMay(k, root)) m.set(k, v);
    return m;
  }
  /* A file that a program wrote (BAM, .gz …) has its bytes in the programs' memory only. Two copies are taken before
     a step of the agent runs:
     - of the files outside the agent's folder, MG.wasm keeps one in that memory (keep) and writes it back after the
       step, where the step changed or removed the file (putBack);
     - of all such files – in the student's folders and in the agent's – the page holds one itself (holdBytes). If the
       programs have to be stopped by force (a command that does not end: the time limit, or Stop pressed twice),
       their memory is gone, and with it every file that a program wrote. Those that were there before the step are
       then written again from the page's copies: a forced stop costs the work of that step, and nothing else. */
  const AGENT_HOLD = 300 * 1024 * 1024; // bytes that the page holds at most (more than that: lost in a forced stop, and named)
  async function holdBytes(fs, held) {
    // (copies of files that are not there any more are let go)
    const live = new Set(fs.entries.values());
    for (const e of Array.from(held.keys())) if (!live.has(e)) held.delete(e);
    let total = 0;
    for (const b of held.values()) total += b.length;
    for (const [k, v] of Array.from(fs.entries)) {
      if (v.kind !== 'aioli' || held.has(v) || insideDir(k, '/tmp')) continue;
      if (total + (v.size || 0) > AGENT_HOLD) continue;
      try {
        const bytes = await fs.readBytes(k);
        held.set(v, bytes);
        total += bytes.length;
      } catch (e) {
        console.error(e);
      }
    }
  }
  /** After a step: what it changed outside the agent's folder is put back; after a forced stop of the programs, the
      files that programs had written before the step are written again.
      snap: the entries outside the folder before the step; keep: paths the student saved in the editor meanwhile;
      since, gen: when the step started, and MG.wasm.gen then; held: see holdBytes; before: every program-written
      file before the step (path → entry).
      → { changed: paths outside that were put back or removed again, lost: paths whose bytes could not be had, killed } */
  async function undoOutside(fs, root, snap, keep, since, gen, held, before) {
    const W = MG.wasm, changed = [], lost = [], back = [];
    const killed = !!W && W.gen !== gen;
    // 1. what the step made outside the folder goes
    for (const k of Array.from(fs.entries.keys())) {
      if (!agentMay(k, root) && !snap.has(k) && !keep.has(k)) {
        fs.entries.delete(k);
        changed.push(k);
      }
    }
    // 2. files that the step copied or moved, and that stay, get bytes of their own first
    if (W && W.ready && W.settle && !killed) {
      try {
        await W.settle(fs);
      } catch (e) {
        console.error(e);
      }
    }
    // 3. what was there before is put back
    for (const [k, v] of snap) {
      if (keep.has(k)) continue;
      const now = fs.entries.get(k);
      if (v.kind === 'aioli' && killed) {
        // (whatever is there now is not the student's file: it goes, and the file comes back below)
        if (now) {
          fs.entries.delete(k);
          changed.push(k);
        }
        continue;
      }
      if (now === v) continue;
      fs.entries.set(k, v);
      changed.push(k);
      if (v.kind !== 'aioli' || !W || !W.putBack) continue;
      let ok = false;
      try {
        ok = await W.putBack(k, v, since);
      } catch (e) {
        console.error(e);
      }
      if (!ok) {
        fs.entries.delete(k);
        back.push([k, v]);
      }
    }
    // 4. After a forced stop: the files that programs had written before the step. Outside the folder: all of them.
    //    Inside it: those that were still there, unchanged, when the programs were stopped – a file that the step
    //    itself had removed or written anew stays gone.
    if (killed && before) {
      const atStop = W.lostEntries || new Map();
      for (const [k, v] of before) {
        if (keep.has(k) || fs.entries.has(k)) continue;
        if (agentMay(k, root) && atStop.get(k) !== v) continue;
        back.push([k, v]);
      }
    }
    for (const [k, v] of back) {
      const bytes = held ? held.get(v) : null;
      let ok = false;
      if (bytes && W && W.writeBytes) {
        try {
          fs.mkdirp(MG.path.dirname(k));
          await W.writeBytes(fs, k, bytes);
          fs.touch(k, v.mtime); // (the file has the time it had: Snakemake compares the times of files)
          ok = true;
        } catch (e) {
          console.error(e);
        }
      }
      if (!ok) lost.push(k);
    }
    changed.concat(lost).forEach((k) => fs._changed(k, !fs.entries.has(k) ? 'remove' : fs.entries.get(k).kind === 'dir' ? 'mkdir' : 'write'));
    return { changed, lost, killed };
  }
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
      this.sendBtn.addEventListener('click', () => (this._abort ? this.stopNow() : this.send()));
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
      this.input.placeholder = k !== 'agent' ? 'Ask the assistant – e.g. “Write a rule that indexes my BAM file”' : this.mode === 'live' ? 'Type a task for the real agent – e.g. “Call the variants for NA12878 from the reads in input/ and give me a filtered VCF file”' : 'Give the agent a task – e.g. “Call the variants for NA12878 and give me a VCF file”';
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
        this.addBubble('assistant', 'I am an **AI agent**: give me a whole task and I will carry it out and give you the result – no commands needed.\n\n*In this practical the agent is a scripted simulation, built from the ways real AI tools behave. Treat it as if it were real, and judge what it gives you only by the evidence.*' + (this.mode === 'live' ? '\n\n' + this.liveAgentIntro() : ''), { intro: true, tab: 'agent' });
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
      // in live mode, typed text goes to the live model – in the Agent tab, to a real agent
      const e = entry || (this.mode !== 'live' ? this.match(q, tab) : null);
      bus.emit('ai:ask', { text: q, mode: this.mode, tab, entry: e ? e.id : '', source: source || (text == null ? 'typed' : 'button') });
      if (e) return tab === 'agent' ? this.runAgent(e) : this.playRecorded(e);
      if (tab === 'agent') {
        if (this.mode === 'live') return this.liveAgent(q);
        const reply = 'I can only carry out the tasks listed under this box in this practical. Pick one of them.\n\n*With an API key (⚙, live mode), a task you type here goes to a real agent instead.*';
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
    /** The Stop button. While the real agent runs a command in the terminal, the first press lets the program that
        is running finish and skips the rest; a second press stops that program by force (see stop in terminal.js:
        what programs had written is then lost). */
    stopNow() {
      if (this._abort) this._abort.abort();
      const T = MG.app.term;
      if (this._agentLive && T && T.busy) T.stop();
    }
    /** run a command in the student's own terminal and capture its output */
    async termRun(cmd, opts) {
      const T = MG.app.term;
      for (let i = 0; i < 600 && T.busy; i++) await sleep(100);
      const before = T.outEl.children.length;
      const code = await T.exec(cmd, opts);
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

    /* ---------------- a real agent (live mode) ---------------- */
    liveAgentIntro() {
      return `**Live mode:** a task you **type** goes to a **real agent** – ${modelOf(this.settings)} runs commands in your terminal, one at a time, in a folder of its own (\`~/ai-agent/live-…\`), with copies of the course data. You see every command and its output; each task you type is a new run, in a new folder. While it works the terminal is locked for typing; **Stop** ends the task. The tasks under this box stay simulated: chapter 8 is written for them.`;
    }
    agentPrompt(run) {
      return [
        'You are an AI agent in a bioinformatics practical for MSc students. You carry out the user’s task by running shell commands, one at a time, in a Linux-like terminal that runs inside their web browser.',
        '',
        'How to work:',
        '- In each reply, say in one or two short sentences what you will do next and why, then give ONE step in a ```bash code block – a command, or a few that belong together, one per line – and stop. You will then get the exit status and the output. If a command of the block fails, the ones after it are not run.',
        '- Base each next step on the output you got. If a command fails, read the error and change your approach.',
        '- Do not ask the user questions – nobody can answer during the task. Make sensible choices, say which, and carry on.',
        `- You can take at most ${AGENT_MAX} steps.`,
        '- When the task is done, or cannot be done, reply WITHOUT a code block: the commands you ran (in short), the files you made, and what the results show. Report only what the outputs showed – never invent results, versions or files.',
        '',
        'Your environment:',
        `- Your folder is ${run} and the terminal is already in it. Use relative paths and stay inside it: cd is not available, and changes to files outside it are undone.`,
        '- input/NA12878_R1.fastq and input/NA12878_R2.fastq: paired-end Illumina exome reads of the reference sample NA12878, only from the regions of CYP2C19 and CYP2C9. input/reference.fa: two slices of the hg19 human reference (chr10), named human_CYP2C19 and human_CYP2C9.',
        `- Programs: minimap2 2.22, samtools 1.17, bcftools 1.10 (with its own htslib 1.10), bgzip and tabix (htslib 1.17), and ${AGENT_UTILS.join(', ')}. Nothing else: no bwa, GATK, FreeBayes, fastqc, Python, R, Snakemake, conda, bash scripts or internet access. A command that has not ended after ${AGENT_SECONDS} seconds is stopped.`,
        '- Shell: bash-like – pipes (|), &&, ||, ;, redirection (> >> < 2> 2>&1), quotes, globs, variables, $( ), $(( )), for / while / if, and here-documents work. cd does not, and there are no background jobs (&).',
        `- Each command’s output is shortened to its last ${AGENT_OUT} characters.`
      ].join('\n');
    }
    /** one turn of the agent: the model's reply (free-tier limits: wait and ask again, up to 3 times) */
    async agentAsk(hist, run, signal, note, onText) {
      for (let waited = 0; ; waited++) {
        let text = '';
        try {
          const res = await this.streamLive(hist, (d) => {
            text += d;
            onText(text);
          }, signal, { settings: this.settings, key: this.key, system: this.agentPrompt(run), onReset: () => {
            text = '';
            onText('');
          } }, note);
          return { text, model: res.model };
        } catch (e) {
          // no model answered. Waiting helps when a limit per minute is reached, the servers are busy or the connection
          // gave no answer (the error says after how many seconds: retryIn) – up to three times for one reply. It does
          // not help when every model is over its limit for today, or the key is not accepted: the task ends at once.
          const wait = e.name !== 'AbortError' && e.retryIn > 0 ? Math.round(Math.min(90, Math.max(5, e.retryIn))) : 0;
          if (wait && waited >= 3) e.message += (e.status === 429 ? ' The page waited three times and the limit is still reached – a key that many people are using at once, perhaps.' : e.status ? ' The page waited three times and asked again: the service is still busy.' : ' The page waited three times and asked again: still no answer.') + ' Go on later' + (e.status ? ', or use a key from another person or project (limits are counted per project, not per key).' : '.');
          if (!wait || waited >= 3) throw e;
          for (let t = wait; t > 0; t--) {
            note(`${e.status === 429 ? 'The service allows only a few requests per minute' : e.status ? 'The service is busy' : 'No answer came from the service'} – waiting ${t} s, then asking again (Stop ends the task)…`);
            await pause(1000, signal);
          }
          note('');
        }
      }
    }
    async liveAgent(task) {
      if (!this.key && needsKey(this.settings)) {
        this.addBubble('assistant', 'No API key is set for live mode. Open ⚙ to add one, or switch back to guided mode.', { badge: 'live mode', tab: 'agent' });
        return;
      }
      const fs = MG.app.fs;
      if (!MG.app.term || !fs.exists('/data/course/SRR098401_1.fastq')) {
        this.addBubble('assistant', 'The terminal is not ready yet – try again in a moment.', { tab: 'agent' });
        return;
      }
      this.busy = true;
      this._abort = new AbortController();
      const signal = this._abort.signal;
      this.sendBtn.innerHTML = MG.icon('stop') + '<span>Stop</span>';
      // a fresh folder for each task, with copies of the course data (the same files as in data/raw)
      let n = 1;
      while (fs.exists(HOME() + '/ai-agent/live-' + n)) n++;
      const run = HOME() + '/ai-agent/live-' + n;
      fs.mkdirp(run + '/input');
      [['SRR098401_1.fastq', 'NA12878_R1.fastq'], ['SRR098401_2.fastq', 'NA12878_R2.fastq'], ['hg19_CYP2C_slices.fa', 'reference.fa']].forEach(([a, b]) => fs.copy('/data/course/' + a, run + '/input/' + b));
      const back = fs.cwd;
      const { card, steps } = this.agentCard(`Real agent · working in ${fs.pretty(run)}`);
      card.classList.add('live');
      const noteEl = h('div.muted', { style: 'font-size:0.85em;margin:0.4em 0 0.2em' });
      card.appendChild(noteEl);
      const note = (t) => {
        noteEl.textContent = t || '';
        this.scroll('agent');
      };
      const t0 = performance.now();
      const hist = [{ role: 'user', content: task }];
      const models = [];
      let cmds = 0, final = '', outcome = 'done';
      // The agent works in a new shell – the student's variables, functions and options are not its own, and it
      // leaves none behind – with the programs it was told it has, whatever conda environment is active; and nobody
      // else can type into the terminal meanwhile.
      const T = MG.app.term;
      for (let i = 0; i < 600 && T.busy; i++) await sleep(100);
      const shellState = T.shell.saveState ? T.shell.saveState() : null;
      if (T.shell.freshState) T.shell.freshState();
      const jobTools = T.shell._jobTools;
      T.shell._jobTools = AGENT_TOOLS.slice();
      const held = new Map(); // the page's copies of program-written files, for a forced stop: see holdBytes
      if (T.lock) T.lock('The agent is using the terminal.');
      this._agentLive = true;
      let reminded = false;
      try {
        await this.termRun('cd ' + fs.pretty(run), { agent: true });
        for (;;) {
          const li = h('li.ag-step.run', h('span.ag-ic', { html: '<span class="spinner small"></span>' }), h('span.ag-say.muted', 'thinking…'));
          steps.appendChild(li);
          this.scroll('agent');
          const say = li.querySelector('.ag-say');
          const { text, model } = await this.agentAsk(hist, run, signal, note, (t) => {
            say.textContent = withoutCode(t) || 'thinking…';
            this.scroll('agent');
          });
          note('');
          if (!models.includes(model)) models.push(model);
          const step = agentStep(text), cmd = step.cmd;
          // A reply with a code block that is no command (```text, ```python …). The rule the agent was given is that
          // a report has no code block: once in a task it is told that nothing was run, and asked which it meant.
          if (cmd == null && /```/.test(text) && !reminded && cmds < AGENT_MAX) {
            reminded = true;
            li.remove();
            hist.push({ role: 'assistant', content: text }, { role: 'user', content: AGENT_REMIND });
            continue;
          }
          if (cmd == null || cmds >= AGENT_MAX) {
            // no command: this is the agent's report
            li.remove();
            final = cmd == null ? text : withoutCode(text) + `\n\n*(Stopped at the limit of ${AGENT_MAX} steps.)*`;
            break;
          }
          // (the description of the step: what stands in front of its block – see AGENT_AHEAD)
          const ahead = step.before && step.after.length > AGENT_AHEAD;
          say.textContent = ahead ? step.before : withoutCode(text);
          say.classList.remove('muted');
          cmds++;
          const refused = cmd ? agentRefusal(cmd) : 'the code block was empty: give one command.';
          let result;
          li.appendChild(h('div', h('code.ag-cmd', cmd || '(empty)')));
          if (refused) {
            li.classList.add('bad');
            li.querySelector('.ag-ic').textContent = '⛔';
            li.appendChild(h('small.muted', 'not run: ' + refused.replace(/ You can use: .*$/, '')));
            result = 'Not run: ' + refused;
          } else {
            // run it in the student's terminal; anything it changes outside the agent's folder is put back
            const W = MG.wasm;
            const snap = outsideSnapshot(fs, run);
            if (W && W.keep) {
              try {
                await W.keep(Array.from(snap));
              } catch (e) {
                console.error(e); // without the copies, only files that the command leaves alone can be put back
              }
            }
            const before = new Map();
            for (const [p, e] of fs.entries) if (e.kind === 'aioli' && !insideDir(p, '/tmp')) before.set(p, e);
            try {
              await holdBytes(fs, held);
            } catch (e) {
              console.error(e);
            }
            const since = Date.now(), gen = W ? W.gen : 0;
            const saved = new Set();
            const off = bus.on('editor:save', (d) => saved.add(d.path));
            // a command that has not ended after AGENT_SECONDS is stopped by force. (The Stop button: see stopNow.)
            let timedOut = false, again = null;
            const timer = setTimeout(() => {
              timedOut = true;
              T.stop();
              T.stop(true);
              // (a program that was only just being started is not "running" yet at that moment: again, until the command has ended)
              again = setInterval(() => T.stop(true), 500);
            }, AGENT_SECONDS * 1000);
            const r = { code: 0, text: '' };
            const notRun = [], refusedNow = [];
            let ended = null;
            try {
              // the commands of the block, one after the other: what follows a command that failed is not run
              const parts = agentParts(cmd);
              for (let k = 0; k < parts.length; k++) {
                T.shell.endedBy = null;
                T.shell.exitTyped = false;
                // (while a command of the agent runs, the shell starts only the programs that the agent has)
                T.shell._agentOnly = AGENT_OK;
                T.shell._agentRefused = refusedNow;
                let one;
                try {
                  one = await this.termRun(parts[k], { agent: true });
                } finally {
                  T.shell._agentOnly = null;
                  T.shell._agentRefused = null;
                }
                r.text += one.text;
                r.code = one.code;
                // (exit, or the agent's own set -e / set -u, ended the command where a script would have ended: so does the block)
                ended = T.shell.exitTyped ? 'exit' : T.shell.endedBy || null;
                T.shell.exitTyped = false;
                if (one.code !== 0 || ended || timedOut || signal.aborted) {
                  notRun.push(...parts.slice(k + 1));
                  break;
                }
              }
            } finally {
              clearTimeout(timer);
              clearInterval(again);
              off();
            }
            const u = await undoOutside(fs, run, snap, saved, since, gen, held, before);
            const undone = u.changed, killed = u.killed;
            // (after a forced stop: the program-written files of this folder that are not there any more – the step's own)
            const gone = killed ? Array.from(before.keys()).filter((p) => insideDir(p, run) && !fs.entries.has(p)).map((p) => p.slice(run.length + 1)) : [];
            const lostOut = u.lost.filter((p) => !insideDir(p, run));
            if (fs.cwd !== run) await this.termRun('cd ' + fs.pretty(run), { agent: true });
            li.classList.toggle('bad', r.code !== 0 || undone.length > 0 || timedOut);
            li.querySelector('.ag-ic').innerHTML = r.code === 0 && !undone.length && !timedOut ? '✓' : '✗';
            const lines = r.text.replace(/\s+$/, '').split('\n');
            const excerpt = (lines.length > 14 ? ['…'].concat(lines.slice(-14)) : lines).join('\n');
            li.appendChild(h('details.ag-out', h('summary', `output (exit status ${r.code})`), h('pre', excerpt || '(no output)')));
            if (undone.length) li.appendChild(h('small.muted', 'Changes outside its folder were undone: ' + undone.slice(0, 4).map((k) => fs.pretty(k)).join(', ') + (undone.length > 4 ? ' …' : '')));
            if (refusedNow.length) li.appendChild(h('small.muted', 'not available to the agent: ' + refusedNow.join(', ')));
            if (timedOut) li.appendChild(h('small.muted', `Stopped by the page: it ran for more than ${AGENT_SECONDS} seconds.`));
            if (killed) li.appendChild(h('small.muted', 'The programs had to be stopped by force, and were started again. What programs wrote in this step is gone; the files they had written before are back as they were.' + (lostOut.length ? ' Lost from your folders (too large to hold a copy of): ' + lostOut.slice(0, 4).map((k) => fs.pretty(k)).join(', ') + (lostOut.length > 4 ? ` and ${lostOut.length - 4} more` : '') + '. Run your pipeline again to make them.' : '')));
            const out = r.text.trim();
            result = `Exit status ${r.code}.` + (timedOut ? ` The command was stopped: it ran for more than ${AGENT_SECONDS} seconds.` : '') + (killed ? ' The programs had to be stopped by force: what programs wrote in this step is gone; the files from earlier steps are as they were.' + (gone.length ? ` Not there any more: ${gone.slice(0, 6).join(', ')}.` : '') : '') + (refusedNow.length ? ` ${refusedNow.map((b) => '`' + b + '`').join(', ')} ${refusedNow.length > 1 ? 'are' : 'is'} not available to you. You can use: ${agentList()}.` : '') + (notRun.length ? ` Not run, because the command before ${r.code !== 0 ? 'failed' : ended === 'exit' ? 'was exit' : 'ended the block'}: ${notRun.join(' ; ').slice(0, 300)}.` : '') + (undone.length ? ` Your changes outside your folder were undone: ${undone.slice(0, 6).map((k) => fs.pretty(k)).join(', ')}.` : '') + '\nOutput' + (out.length > AGENT_OUT ? ' (last ' + AGENT_OUT + ' characters)' : '') + ':\n```text\n' + (out.slice(-AGENT_OUT) || '(no output)') + '\n```';
          }
          li.classList.remove('run');
          if (ahead) {
            li.appendChild(h('small.muted', 'The model wrote more after this step – before the step had run. That text is not shown here: a report can only come after the result.'));
            result += '\n\n' + AGENT_AHEAD_TOLD;
          }
          if (cmds >= AGENT_MAX) result += `\n\nYou have used all ${AGENT_MAX} steps. Reply now without a code block: what you did, which files you made and what the results show.`;
          hist.push({ role: 'assistant', content: text }, { role: 'user', content: result });
          if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
        }
      } catch (e) {
        outcome = e.name === 'AbortError' ? 'stopped' : 'error';
        steps.querySelectorAll('li.run').forEach((li) => {
          li.classList.remove('run');
          li.querySelector('.ag-ic').textContent = '–';
          if (/thinking/.test(li.textContent)) li.remove();
        });
        final = outcome === 'stopped' ? '*(Stopped.)*' : '**The AI service returned an error.**\n\n' + e.message;
        if (outcome === 'error') card.classList.add('err');
      } finally {
        note('');
        if (fs.cwd !== back && fs.isDir(back)) await this.termRun('cd ' + fs.pretty(back), { agent: true });
        this._agentLive = false;
        if (T.unlock) T.unlock();
        T.shell._jobTools = jobTools;
        if (shellState && T.shell.restoreState) T.shell.restoreState(shellState);
        held.clear();
        if (MG.wasm && MG.wasm.dropKept) MG.wasm.dropKept().catch(() => {});
        T._renderPrompt();
        card.querySelector('.ag-head b').textContent = (outcome === 'done' ? 'Real agent · finished' : outcome === 'stopped' ? 'Real agent · stopped' : 'Real agent · error') + ` · ${fs.pretty(run)}`;
        const body = h('div.ai-body');
        card.appendChild(body);
        this.fill(body, final || '(no reply)');
        const secs = Math.round((performance.now() - t0) / 1000);
        card.appendChild(h('div.ai-badge', `real agent · ${models.join(', ') || modelOf(this.settings)} · ${cmds} step${cmds === 1 ? '' : 's'} · ${secs >= 60 ? Math.floor(secs / 60) + ' min ' : ''}${secs % 60} s`));
        this.msgs.agent.push({ role: 'assistant', content: final });
        this.busy = false;
        this._abort = null;
        this.sendBtn.innerHTML = MG.icon('send') + '<span>Send</span>';
        this.scroll('agent');
        bus.emit('agent:live', { ok: outcome === 'done', run: n, commands: cmds, folder: fs.pretty(run) });
        this.renderSuggestions();
      }
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
        'Environment (all in the web browser): a bash-like terminal; Snakemake ' + ((v.snakemake || '9.27.0')) + ' (a faithful browser re-implementation); Python ' + (v.python || '3.13') + ' with pandas, numpy, matplotlib and pyyaml (Pyodide); minimap2 2.22, samtools 1.17, bcftools 1.10 (with htslib 1.10), bgzip/tabix (htslib 1.17) and Graphviz dot, compiled to WebAssembly; a conda model with environments "base" and "pipelines". No internet access from the terminal or Python, and no other programs (no bwa, gatk, fastqc, git, docker). Shell: bash-like – loops, if, $( ), $(( )), ${…}, functions and here-documents work; there are no background jobs (&), and every program runs on one thread. Snakemake runs the command of a rule in the strict mode of bash (set -euo pipefail), as the real program does.',
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
          { onReset: () => (text = '') },
          (note) => {
            if (!text) body.innerHTML = `<div class="muted" style="font-size:0.85em;margin-bottom:0.35em">${esc(note)}</div><span class="ai-typing"><i></i><i></i><i></i></span>`;
          }
        );
        // a reply with nothing in it is not kept as a turn of the conversation: it is reported, and the question can be asked again
        if (!text.trim()) throw Object.assign(new Error(`${res.model} sent an empty reply. Ask again – a second try usually gets an answer.`), { empty: true });
        this.fill(body, text);
        const via = res.skipped.length ? ` (${res.skipped.map((x) => x.model + ' ' + skipWord(x)).join(', ')})` : '';
        b.appendChild(h('div.ai-badge', { html: `live · ${esc(res.model + via)} · ${((performance.now() - t0) / 1000).toFixed(1)} s` }));
        this.msgs.chat.push({ role: 'assistant', content: text });
        bus.emit('ai:answer', { entry: 'live', mode: 'live' });
      } catch (e) {
        if (e.name === 'AbortError') {
          this.fill(body, (text || '') + '\n\n*(stopped)*');
          if (text) this.msgs.chat.push({ role: 'assistant', content: text });
        } else {
          this.fill(body, (e.empty ? '' : '**The AI service returned an error.**\n\n') + e.message);
          b.classList.add('err');
        }
      } finally {
        this.busy = false;
        this._abort = null;
        this.sendBtn.innerHTML = MG.icon('send') + '<span>Send</span>';
      }
    }
    /* Stream an answer.
       Gemini: the chosen model is asked first, then the fallback models in their order – but not a model that the
       page knows to be busy, silent or over a limit (the memory above). A model that is busy (HTTP 5xx), over a
       limit (429), not found (404) or gives no answer (the connection fails, or nothing comes for a minute) is
       noted, and the next one is asked. An answer that breaks off part-way is taken back (cfg.onReset) and the
       question goes to the next model. When no model is left that is not at rest, the two that have rested longest
       of those that were only busy or silent get another chance. Two models in a row that give no answer end the
       request: that is the connection, not the models.
       Other services: one model; if it is busy, a second try after a short pause.
       → { model, skipped }: the model that answered, and what kept others from it – the chosen model if it is at
         rest, and every model that failed in this request.
       When nothing answers, the error says what each model said. Its .status is 429 (limits), 503 (busy) or not set
       (no answer came); .retryIn is the number of seconds after which asking again can help – not set when it
       cannot (a wrong key; every model over its limit for today). */
    async streamLive(messages, onDelta, signal, cfg, onNote) {
      const s = (cfg && cfg.settings) || this.settings;
      const key = cfg && cfg.key != null ? cfg.key : this.key;
      const system = (cfg && cfg.system) || this.systemPrompt();
      const note = onNote || (() => {});
      const reset = cfg && cfg.onReset;
      // turns must alternate between user and assistant: join neighbours of the same role
      messages = messages.reduce((out, m) => {
        const last = out[out.length - 1];
        if (last && last.role === m.role) last.content += '\n\n' + m.content;
        else out.push({ role: m.role, content: m.content });
        return out;
      }, []);
      if (s.provider !== 'gemini') {
        const model = modelOf(s);
        for (let attempt = 1; ; attempt++) {
          let started = false;
          try {
            await this.streamOnce(s, key, model, messages, (d) => {
              started = true;
              onDelta(d);
            }, signal, system);
            return { model, skipped: [] };
          } catch (e) {
            if (e.name !== 'AbortError' && !started && BUSY.includes(e.status) && attempt === 1) {
              note(`${model} is busy – trying again…`);
              await pause(1500 + Math.random() * 1500, signal);
              continue;
            }
            if (e.status === 429 && !started) e.retryIn = Math.round(Math.min(90, Math.max(5, e.retryAfter || 30)));
            throw e;
          }
        }
      }
      const chosen = geminiModelOf(s);
      const chain = [chosen].concat(FALLBACKS.filter((m, i, a) => a.indexOf(m) === i && m !== chosen));
      if (restKey !== key) {
        // another key is another project, with limits of its own
        REST.clear();
        restKey = key;
      }
      try {
        if (navigator.onLine === false) throw Object.assign(new Error('This browser is offline. Connect it to the internet, and try again.'), { network: true, retryIn: RETRY });
        const said = new Map(); // what each model said: in this request, or when it was last asked and is still at rest
        chain.forEach((m) => resting(m) && said.set(m, REST.get(m)));
        const failed = [];
        let queue = chain.filter((m) => !said.has(m));
        let again = false, silent = 0;
        for (;;) {
          if (!queue.length && !again) {
            again = true;
            queue = chain.filter((m) => said.has(m) && !failed.includes(said.get(m)) && (said.get(m).why === 'busy' || said.get(m).why === 'noanswer')).sort((a, b) => said.get(a).until - said.get(b).until).slice(0, 2);
          }
          if (!queue.length) break;
          const model = queue.shift();
          const before = failed[failed.length - 1];
          if (before) note(`${before.model} ${before.broke ? 'broke off' : told(before, true)} – asking ${model} instead…`);
          let started = false;
          try {
            await this.streamOnce(s, key, model, messages, (d) => {
              started = true;
              onDelta(d);
            }, signal, system);
            REST.delete(model);
            const first = model !== chosen && said.get(chosen);
            return { model, skipped: (first && !failed.includes(first) ? [first] : []).concat(failed).map((x) => ({ model: x.model, why: x.broke ? 'broke' : x.why, daily: x.daily })) };
          } catch (e) {
            if (e.name === 'AbortError') throw e;
            const why = e.network ? 'noanswer' : e.status === 404 ? 'notfound' : e.status === 429 ? 'limit' : BUSY.includes(e.status) ? 'busy' : '';
            // an error of another kind (the key, the request itself) – or an answer that broke off and cannot be taken back
            if (!why || (started && !reset)) throw e;
            if (started) reset();
            const was = REST.get(model);
            const x = { model, why, broke: started, status: e.status, text: e.message, at: Date.now(), until: Infinity };
            if (why === 'limit') {
              const wait = e.retryAfter > 0 ? Math.min(86400, e.retryAfter) : e.daily ? 3600 : 60;
              x.daily = !!e.daily || wait > 900;
              x.limit = e.limit;
              x.until = Date.now() + (wait + 1) * 1000;
            } else if (why === 'busy') {
              // busy again soon after its rest: the rest is twice as long (2, 4, 8, at most 15 minutes)
              x.n = was && was.why === 'busy' && Date.now() - was.until < 600000 ? was.n + 1 : 1;
              x.until = Date.now() + Math.min(900, BUSY_REST * 2 ** (x.n - 1)) * 1000;
            } else if (why === 'noanswer') x.until = Date.now() + SILENT_REST * 1000;
            REST.set(model, x);
            said.set(model, x);
            failed.push(x);
            silent = why === 'noanswer' ? silent + 1 : 0;
            if (silent >= 2) break;
          }
        }
        throw noAnswer(chain.map((m) => said.get(m)).filter(Boolean), silent >= 2);
      } finally {
        if (this.showStatus) this.showStatus();
      }
    }
    /** one request; the answer is passed to onDelta as it arrives.
        An error that the service reports carries .status – and for "too many requests" (429) .retryAfter (seconds)
        and, when the service names a limit per day, .daily and .limit. An answer that does not come – the connection
        fails or breaks off, or (Gemini) nothing arrives for a minute (aiWaitSeconds) – carries .network. */
    async streamOnce(s, key, model, messages, onDelta, signal, system) {
      const gem = s.provider === 'gemini';
      const base = (s.baseURL || '').replace(/\/+$/, '');
      if (signal && signal.aborted) throw stopped();
      // the request ends when the user presses Stop – or when the service has said nothing for too long
      const ac = new AbortController();
      const onStop = () => ac.abort();
      if (signal) signal.addEventListener('abort', onStop, { once: true });
      const quiet = gem ? WAIT() * 1000 : 0;
      let timer = null, silent = false, bytes = 0;
      const arm = () => {
        clearTimeout(timer);
        if (quiet)
          timer = setTimeout(() => {
            silent = true;
            ac.abort();
          }, quiet);
      };
      /* why the answer did not come: the user's Stop, the service's silence, or the connection */
      const lost = (e) => {
        if (signal && signal.aborted) return stopped();
        if (silent) return Object.assign(new Error(`${model} ${bytes ? 'stopped in the middle of its reply and said nothing more' : 'gave no answer'} for ${Math.round(quiet / 1000)} seconds.`), { network: true, silent: true });
        if (e.name === 'AbortError') return e;
        const where = gem ? 'the Gemini API' : s.provider === 'anthropic' ? 'the Anthropic API' : base;
        return Object.assign(new Error(bytes ? `The connection to ${where} broke off in the middle of the reply (${e.message}).` : `Could not reach ${where} (${e.message}). ${s.provider === 'openai' ? 'Check the address; the service must allow requests from web pages (CORS).' : 'Check the internet connection.'}`), { network: true });
      };
      /* an error that the service reports: as the status of its answer, or (Gemini) inside an answer that had begun */
      const refused = (status, j, statusText, retryHeader) => {
        const err = (j && j.error) || null;
        const det = err && Array.isArray(err.details) ? err.details.filter(Boolean) : [];
        const detail = j ? (err && (err.message || err.type)) || JSON.stringify(j).slice(0, 300) : statusText || '';
        const reason = err ? det.map((d) => d.reason).filter(Boolean)[0] || err.status || '' : '';
        const ri = det.find((d) => /RetryInfo$/.test(d['@type'] || ''));
        const retryAfter = (ri && parseFloat(ri.retryDelay)) || parseFloat(retryHeader) || 0;
        // a limit per day is named in the answer: quotaId "GenerateRequestsPerDayPerProjectPerModel-FreeTier", with its value
        const qf = det.find((d) => /QuotaFailure$/.test(d['@type'] || ''));
        const day = ((qf && qf.violations) || []).find((v) => v && /PerDay/i.test(v.quotaId || ''));
        const limit = day && /^\d+$/.test(String(day.quotaValue)) ? +day.quotaValue : undefined;
        const badKey = status === 401 || status === 403 || reason === 'API_KEY_INVALID';
        const why = badKey
          ? 'The API key was not accepted.'
          : status === 404
            ? `The model name (${model}) may be wrong, or the model has been retired – check it in the AI settings (⚙).`
            : status === 429
              ? gem
                ? day
                  ? `${model} is over its limit for today${limit != null ? ` (${limit} requests a day)` : ''}. The free tier allows each model a number of requests per day, counted per project: go on when the service takes requests again, use a key from another person or project, or choose another model in the AI settings (⚙).`
                  : 'Too many requests: the free tier allows only a few requests per minute and per day – wait a minute and try again.'
                : 'Too many requests, or no credit left – try again in a minute.'
              : BUSY.includes(status)
                ? gem
                  ? `Google’s servers are busy for ${model} (“high demand”). That is on Google’s side, not a problem with your key: wait a minute and try again, or choose another model in the AI settings (⚙).`
                  : 'The service is busy or had a temporary problem – try again in a minute.'
                : '';
        return Object.assign(new Error(`HTTP ${status}. ${why} ${detail}`.trim()), { status, retryAfter, daily: !!day, limit });
      };
      try {
        arm();
        let r;
        if (s.provider === 'anthropic') {
          r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
            body: JSON.stringify({ model, max_tokens: 4000, system, messages, stream: true }),
            signal: ac.signal
          }).catch((e) => {
            throw lost(e);
          });
        } else if (gem) {
          // Google's Gemini API (generateContent, streamed as server-sent events); the whole conversation is sent each time
          r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })) }),
            signal: ac.signal
          }).catch((e) => {
            throw lost(e);
          });
        } else {
          r = await fetch(base + '/chat/completions', {
            method: 'POST',
            headers: Object.assign({ 'content-type': 'application/json' }, key ? { authorization: 'Bearer ' + key } : {}),
            body: JSON.stringify({ model, stream: true, messages: [{ role: 'system', content: system }].concat(messages) }),
            signal: ac.signal
          }).catch((e) => {
            throw lost(e);
          });
        }
        arm();
        if (!r.ok) {
          let j = null;
          try {
            j = await r.json();
          } catch (e) {
            if (signal && signal.aborted) throw stopped();
          }
          throw refused(r.status, j, r.statusText, r.headers.get('retry-after'));
        }
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read().catch((e) => {
            throw lost(e);
          });
          if (done) break;
          arm();
          bytes += value.length;
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
            } else if (gem) {
              if (j.error) {
                // an error in an answer that began with "200 OK": the same kinds as the errors that come instead of an answer
                const code = +j.error.code || { UNAVAILABLE: 503, RESOURCE_EXHAUSTED: 429, INTERNAL: 500, DEADLINE_EXCEEDED: 504, NOT_FOUND: 404 }[j.error.status];
                throw code ? refused(code, j) : new Error(j.error.message || 'stream error');
              }
              if (j.promptFeedback && j.promptFeedback.blockReason) throw new Error('Gemini did not answer (' + j.promptFeedback.blockReason + ').');
              const cand = (j.candidates && j.candidates[0]) || {};
              ((cand.content && cand.content.parts) || []).forEach((p) => {
                if (p.text && !p.thought) onDelta(p.text);
              });
              // A reply that the service cut off as a "malformed function call": the model had begun its ```bash block,
              // and the service took the fence for the call of a tool named bash. What it took away is in finishMessage
              // ("Malformed function call: call:bash ```", the commands, "```") – the block goes back into the reply.
              // (Seen with gemini-3.5-flash on 6 October 2026, twice in about seventy replies.)
              if (cand.finishReason === 'MALFORMED_FUNCTION_CALL' && typeof cand.finishMessage === 'string') {
                const m = /call:\s*(?:bash|sh|shell)\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(cand.finishMessage);
                if (m && m[1].trim()) onDelta('\n\n```bash\n' + m[1] + '\n```\n');
              }
            } else {
              const dd = j.choices && j.choices[0] && j.choices[0].delta;
              if (dd && dd.content) onDelta(dd.content);
            }
          }
        }
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onStop);
        ac.abort(); // (nothing is left to end when the answer came whole)
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
  <label class="ai-opt"><input type="radio" name="aimode" value="live" ${this.mode === 'live' ? 'checked' : ''}> <span><b>Live AI</b> – connect a real model with your own API key, or one provided by your lecturer. What you type goes to it – in the Agent tab, to a real agent that runs commands in your terminal. The suggestions keep the practical’s prepared answers and the simulated agent.</span></label>
  <div class="ai-live-box">
    <label>Service <select data-k="provider"><option value="gemini" ${s.provider === 'gemini' ? 'selected' : ''}>Google Gemini (free tier available)</option><option value="anthropic" ${s.provider === 'anthropic' ? 'selected' : ''}>Anthropic (Claude)</option><option value="openai" ${s.provider === 'openai' ? 'selected' : ''}>OpenAI-compatible service</option></select></label>
    <label data-show="gemini">Model <input data-k="geminiModel" value="${esc(geminiModelOf(s))}" spellcheck="false"></label>
    <p data-show="gemini" class="muted small">Make a free key with a Google account at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> (you must be 18 or over). On the free tier Google may use what you send to improve its products, and human reviewers may read it. The free tier allows each model only a few requests per minute and a limited number per day; when a model is busy or over its limit, the page asks another one, and each answer says which model replied.</p>
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
          const res = await this.streamLive([{ role: 'user', content: 'Reply with the single word: ready' }], (d) => (got += d), undefined, Object.assign(read(), { onReset: () => (got = '') }), (note) => (out.textContent = note));
          out.textContent = '✓ Connected: “' + got.trim().slice(0, 40) + '”' + (res.skipped.length ? ` – from ${res.model} (${res.skipped.map((x) => x.model + ' ' + skipWord(x)).join(', ')})` : '');
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
        this.showTab(this.tab, true);
        m.close();
        if (changed) {
          this.addBubble('assistant', want === 'live' ? 'Switched to **live** mode – I am now a real AI model. Check everything I tell you.' : 'Switched to **guided** mode.', { tab: 'chat' });
          this.addBubble('assistant', want === 'live' ? this.liveAgentIntro() : 'Switched to **guided** mode: the agent is the simulation only.', { tab: 'agent' });
          bus.emit('ai:mode', { mode: want });
        }
      });
    }
  }

  MG.Assistant = Assistant;
  MG.aiModelMemory = REST;
  MG.renderMarkdown = renderMarkdown;
  MG.aiUtil = { findRule, ruleNames, renderMarkdown, score };
})();
