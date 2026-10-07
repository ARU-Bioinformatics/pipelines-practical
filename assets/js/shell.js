/* =====================================================================
   The shell of the browser terminal.

   This file: running the programs of a pipeline (with redirection), and
   the commands for files and folders that are written in JavaScript
   (ls, cp, rm, tree …). They work on the page's file system (vfs.js).

   shell-lang.js  the language: lists, variables, $( ), if / for / while,
                  functions, scripts
   tools-wasm.js  the compiled programs (fastp, samtools, GNU tools …),
                  which register themselves in MG.shellTools
   shell-extra.js more commands (chmod, find, sha256sum, od, bc, open …)
   ===================================================================== */
(function () {
  'use strict';
  const MG = (window.MG = window.MG || {});

  function linesOf(text) {
    if (!text) return [];
    const L = text.split('\n');
    if (L[L.length - 1] === '') L.pop();
    return L;
  }
  function fmtN(n) {
    return Number(n).toLocaleString('en-GB');
  }
  function userErr(msg, code) {
    const e = new Error(msg);
    e.userMessage = msg;
    e.code = code || 1;
    return e;
  }
  /** an option that a command does not have, refused in the words of the GNU programs */
  const refuseOption = (name, a, code) => userErr((a.startsWith('--') ? `${name}: unrecognized option '${a}'` : `${name}: invalid option -- '${a[1]}'`) + `\nTry '${name} --help' for more information.`, code || 1);

  /** set -e, set -u, set -x, set -o pipefail, set -euo pipefail (and + to switch off).
      Carried out: e errexit, u nounset, x xtrace, pipefail, a allexport (every variable that is set is exported),
      f noglob (no file name patterns), C noclobber (> does not overwrite a file; >| does), v verbose (each command
      is shown as it is read), n noexec (in a script: the commands are read and not run).
      Accepted, and of no consequence in this terminal: the options about the history, job control and the line
      editor. Any other name is refused, as bash refuses a name it does not know. */
  const SET_LETTERS = { e: 'e', u: 'u', x: 'x', a: 'a', f: 'f', C: 'C', v: 'v', n: 'n', E: 'E' };
  const SET_NAMES = { errexit: 'e', nounset: 'u', xtrace: 'x', pipefail: 'pipefail', allexport: 'a', noglob: 'f', noclobber: 'C', verbose: 'v', noexec: 'n', errtrace: 'E' };
  const SET_IDLE_LETTERS = 'hBHmbTPkpt';
  const SET_IDLE_NAMES = ['braceexpand', 'emacs', 'functrace', 'hashall', 'histexpand', 'history', 'ignoreeof', 'interactive-comments', 'keyword', 'monitor', 'nolog', 'notify', 'onecmd', 'physical', 'posix', 'privileged', 'vi'];
  function applySetFlags(spec, flags, bad) {
    const parts = Array.isArray(spec) ? spec : spec.trim().split(/\s+/);
    const no = (msg, code) => {
      if (bad) bad(msg, code);
    };
    // (bash looks at all the letters before it changes anything: with one that it does not know – set -ez, or
    // "set -e" with the carriage return of a Windows line end behind it – nothing is switched on. A name after -o is
    // looked at when its turn comes: set -eo nosuch has switched -e on by then.)
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!/^[-+]/.test(p)) continue;
      for (const ch of p.slice(1)) {
        if (ch === 'o') i++;
        else if (!SET_LETTERS[ch] && !SET_IDLE_LETTERS.includes(ch)) {
          no(`set: ${p[0]}${ch}: invalid option\nset: usage: set [-abefhkmnptuvxBCEHPT] [-o option-name] [--] [-] [arg ...]`, 2);
          return flags;
        }
      }
    }
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const on = p.startsWith('-');
      if (!/^[-+]/.test(p)) continue;
      for (const ch of p.slice(1)) {
        if (ch === 'o') {
          const opt = parts[++i];
          if (opt === undefined) continue;
          if (SET_NAMES[opt]) flags[SET_NAMES[opt]] = on;
          else if (!SET_IDLE_NAMES.includes(opt)) no(`set: ${opt}: invalid option name`, 2);
        } else if (SET_LETTERS[ch]) flags[SET_LETTERS[ch]] = on;
        else if (!SET_IDLE_LETTERS.includes(ch)) no(`set: ${p[0]}${ch}: invalid option\nset: usage: set [-abefhkmnptuvxBCEHPT] [-o option-name] [--] [-] [arg ...]`, 2);
      }
    }
    // (an AI agent's run keeps a shadow of -e and -u – see nounset in shell-lang.js: it follows what the commands set)
    if (flags.sl) {
      if (flags.e) flags.se = true;
      else if (/(^|\s)\+[a-zA-Z]*e/.test(parts.join(' ')) || /\+o\s+errexit/.test(parts.join(' '))) flags.se = false;
      if (flags.u) flags.su = true;
      else if (/(^|\s)\+[a-zA-Z]*u/.test(parts.join(' ')) || /\+o\s+nounset/.test(parts.join(' '))) flags.su = false;
    }
    return flags;
  }
  /** What a command, a block or a function prints when its output goes to a file or into a pipe: text, and the bytes of
      programs (a BAM file, a .gz file), in the order they were written. Bytes stay bytes: nothing is lost on the way
      through a function, a { } block, a loop or bash -c. */
  class Sink {
    constructor() {
      this.parts = [];
      this.binary = false; // some of it came as bytes
    }
    add(t) {
      if (t == null || t === '') return;
      if (typeof t === 'string') {
        const n = this.parts.length;
        if (n && typeof this.parts[n - 1] === 'string') this.parts[n - 1] += t;
        else this.parts.push(t);
      } else if (t.length) {
        this.parts.push(t);
        this.binary = true;
      }
    }
    clear() {
      this.parts = [];
      this.binary = false;
    }
    get empty() {
      return !this.parts.length;
    }
    text() {
      return this.parts.map((p) => (typeof p === 'string' ? p : bytesText(p))).join('');
    }
    bytes() {
      const enc = new TextEncoder();
      const list = this.parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p));
      const all = new Uint8Array(list.reduce((n, b) => n + b.length, 0));
      let at = 0;
      for (const b of list) {
        all.set(b, at);
        at += b.length;
      }
      return all;
    }
  }
  const bytesText = (b) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(b);
  /** The output of the commands that a command runs itself (bash -c, a script, eval, xargs, find -exec): it goes where
      the command's own output goes – as bytes too, when that is a file or a pipe. */
  const innerIO = (ctx) => Object.assign({}, ctx.io, { out: ctx.out, err: ctx.err, bytes: !!ctx.takesBytes, outClear: ctx.outClear || null, errClear: ctx.errClear || null, piped: !!(ctx.io.piped || !ctx.toCaller), outFile: ctx.redirectTarget ? { path: ctx.fs.resolve(ctx.redirectTarget), append: !!ctx.redirectAppend } : ctx.toCaller ? ctx.io.outFile || null : null });
  /** timeout 60 COMMAND, nice COMMAND, env A=1 COMMAND, command COMMAND, time COMMAND: the words of COMMAND
      (for the check of which files a line reads) */
  function unwrap(argv) {
    let a = argv;
    for (let n = 0; n < 6 && a.length; n++) {
      const name = a[0];
      let k = 1;
      if (name === 'command' || name === 'builtin' || name === 'time' || name === 'nice' || name === 'timeout' || name === 'env' || name === 'nohup') {
        while (k < a.length && (/^-/.test(a[k]) || (name === 'env' && /^[A-Za-z_]\w*=/.test(a[k])))) {
          if (/^(-n|-s|-k|-u|--adjustment|--signal|--kill-after|--unset)$/.test(a[k])) k++;
          k++;
        }
        if (name === 'timeout') k++;
        if (name === 'command' && /^-[vV]/.test(a[1] || '')) return a;
        a = a.slice(k);
      } else break;
    }
    return a;
  }

  /* ------------------------------------------------------------------
     programs that people (and AI models) expect, but that are not here
     ------------------------------------------------------------------ */
  const ABSENT = [
    [/^(bwa|bwa-mem2|bowtie|hisat2|STAR|bbmap|ngmlr|novoalign|subread-align)$/, 'is not installed in this terminal. For mapping reads there are minimap2 and bowtie2.'],
    [/^(fastqc|multiqc|trimmomatic|cutadapt|trim_galore|bbduk\.sh|seqkit|NanoPlot|prinseq)$/, 'is not installed in this terminal. For quality control and trimming there is fastp (seqtk can do simple things too).'],
    [/^(gatk|freebayes|picard|varscan|deepvariant|strelka|octopus|vardict|lofreq|snpEff|SnpSift|vep|annovar|vcftools|igv|qualimap|mosdepth|sambamba|bamtools)$/, 'is not installed in this terminal. For variants there is bcftools (mpileup, call, filter, view, query, stats, norm); for alignments samtools and bedtools.'],
    [/^(python|python3|python2|pip|pip3|R|Rscript|perl|ruby|java|julia|node|ipython|jupyter)$/, 'is not installed in this terminal. There is the shell with its text tools: awk, sed, grep, sort, cut, jq …'],
    [/^(conda|mamba|micromamba|apt|apt-get|yum|dnf|brew|docker|singularity|apptainer|snakemake|nextflow|git|make|module)$/, 'is not available: nothing can be installed in this terminal. Type  help  to see the programs that are here.'],
    [/^(wget|curl|ssh|scp|rsync|ping|ftp|sftp)$/, 'is not available: this terminal has no network access. The data is in ~/data.'],
    [/^(top|htop|ps|kill|free|lscpu|df|mount|su|chown|screen|tmux|nohup|watch|crontab|pkill|pgrep|uptime|stty|getconf|lsblk|dmesg|who|w|last|service|systemctl|chgrp|mknod)$/, 'is not available in this terminal: it is a web page, not a whole computer.'],
    [/^(mkfifo|flock)$/, 'is not available in this terminal: the commands here run one after the other, so there are no named pipes and nothing to lock. Use a file between two commands, or  COMMAND <(OTHER COMMAND)'],
    [/^install$/, 'is not available in this terminal. For a folder:  mkdir -p FOLDER   For a file with permissions:  cp FILE DESTINATION && chmod 755 DESTINATION'],
    [/^(iconv|recode)$/, 'is not installed in this terminal: text here is UTF-8, and the programs pass other bytes through as they are.'],
    [/^(dos2unix|unix2dos)$/, 'is not installed in this terminal (nor on many Linux computers). To take the carriage returns of a Windows file away:  sed -i \'s/\\r$//\' FILE   or   tr -d \'\\r\' < FILE > NEWFILE'],
    [/^(cal|ncal|banner|figlet|cowsay|fortune)$/, 'is not installed in this terminal. Type  help  to see what is here.'],
    [/^ln$/, 'is not available in this terminal: there are no links here. Copy the file instead:  cp FILE NEWNAME'],
    [/^(tar|zip|unzip|7z|bzip2|bunzip2|xz|pigz)$/, 'is not installed in this terminal. For compressed files there are gzip, gunzip, zcat and bgzip. (A person at the terminal can save a whole folder as a .zip with  download FOLDER.)'],
    [/^dc$/, 'is not installed in this terminal. For sums there are bc, $(( 2 + 3 )) and awk.'],
    [/^(sdiff|diff3)$/, 'is not available in this terminal: it works by starting diff as a second program, which a web page cannot do. Two files side by side:  diff -y A B'],
    [/^(patch|colordiff|vimdiff|wdiff)$/, 'is not installed in this terminal. To compare files there are diff and cmp.'],
    [/^strings$/, 'is not installed in this terminal. To look at the bytes of a file there are od -c, hexdump -C and xxd; to look into a compressed file,  zcat FILE | head'],
    [/^yes$/, 'is not available in this terminal: the commands of a pipeline run one after the other, and yes never ends. For N lines:  seq N | sed "s/.*/y/"   or   printf \'y\\n%.0s\' {1..N}'],
    [/^(csplit|numfmt|cksum|sum|dd|tsort|fmt|pr)$/, 'is not among the programs of this terminal. Type  help  to see what is here.'],
    [/^(alias|unalias)$/, 'is not available in this terminal. Write a function instead:  ll() { ls -l "$@"; }']
  ];
  /* A command failed for a reason of THIS terminal: a program that is not here (python3, bwa), or something a
     program cannot do in a web page (bcftools plugins). On Linux the same command would work, and do more. The
     names are noted; assistant.js empties the list before each command of an agent and reads it afterwards. */
  function notHere(what) {
    MG.hereLog = MG.hereLog || [];
    if (MG.hereLog.length < 40 && !MG.hereLog.includes(what)) MG.hereLog.push(String(what).slice(0, 60));
  }
  function absentNote(name) {
    const hit = ABSENT.find(([re]) => re.test(name));
    return hit ? `${name} ${hit[1]}` : '';
  }
  function allCommandNames() {
    return Object.keys(MG.shellBuiltins).concat(Object.keys(MG.shellTools));
  }
  function lev(a, b) {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 3) return 9;
    const d = Array.from({ length: m + 1 }, (_, i) => [i].concat(new Array(n).fill(0)));
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }
  function suggest(name) {
    let best = null, bd = name.length < 4 ? 2 : 3;
    allCommandNames().forEach((c) => {
      const d = lev(name, c);
      if (d < bd) {
        bd = d;
        best = c;
      }
    });
    return best;
  }

  /* The permissions of an entry as a number (0644) and as ls shows them (-rw-r--r--). What the page acts on is
     whether the owner may write (not read-only) and may run the file (x); chmod keeps the other bits for show. */
  function permBits(e) {
    // (a folder: what chmod set is kept and shown; it changes nothing about what can be done in the folder)
    if (e.kind === 'dir') return e.perm != null ? e.perm : 0o755;
    const x = e.mode === 'x', ro = !!(e.readonly || e.protected);
    if (e.perm != null && !!(e.perm & 0o100) === x && !(e.perm & 0o200) === ro) return e.perm;
    return (ro ? 0o444 : 0o644) | (x ? 0o111 : 0);
  }
  function permText(e) {
    const b = permBits(e);
    const t = [6, 3, 0].map((sh) => ((b >> sh) & 4 ? 'r' : '-') + ((b >> sh) & 2 ? 'w' : '-') + ((b >> sh) & 1 ? 'x' : '-'));
    // (the three special bits: set-user-ID, set-group-ID, sticky – chmod 2755, chmod 1777)
    const special = (s, bit, c) => (b & bit ? s.slice(0, 2) + (s[2] === 'x' ? c : c.toUpperCase()) : s);
    return (e.kind === 'dir' ? 'd' : '-') + special(t[0], 0o4000, 's') + special(t[1], 0o2000, 's') + special(t[2], 0o1000, 't');
  }
  MG.permBits = permBits;
  MG.permText = permText;

  /* ------------------------------------------------------------------
     Times, as the commands of this terminal read and show them: in the time zone of the computer – or, when TZ is
     set for the command (TZ=UTC ls -l, export TZ=America/New_York), in that zone. zone: null (the computer's),
     'UTC', or a name that the browser knows (Europe/Paris).
     ------------------------------------------------------------------ */
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const zoneFormats = {};
  function zoneFormat(zone) {
    if (!(zone in zoneFormats)) {
      try {
        zoneFormats[zone] = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
      } catch (e) {
        zoneFormats[zone] = null;
      }
    }
    return zoneFormats[zone];
  }
  /** the zone that TZ names for this command: null – no TZ, or one that is not known here */
  function zoneOf(ctx) {
    const st = ctx.opts && ctx.opts.st, tz = ctx.env && ctx.env.TZ;
    if (typeof tz !== 'string' || (st && st.exported && !st.exported.has('TZ'))) return null;
    if (/^(|UTC0?|Etc\/UTC|Etc\/UCT|Etc\/Universal|Etc\/Zulu|Zulu|Universal|UCT)$/i.test(tz)) return 'UTC';
    // (Greenwich time has its own name, GMT)
    if (/^(GMT[-+]?0?|Etc\/GMT[-+]?0?|Etc\/Greenwich|Greenwich)$/i.test(tz)) return zoneFormat('GMT') ? 'GMT' : 'UTC';
    return zoneFormat(tz) ? tz : null;
  }
  /** the date and the time of day of a moment (ms since 1970) in a zone; off: minutes east of UTC */
  function timeFields(t, zone) {
    const d = new Date(t);
    if (!zone) return { Y: d.getFullYear(), M: d.getMonth(), D: d.getDate(), H: d.getHours(), Mi: d.getMinutes(), S: d.getSeconds(), W: d.getDay(), off: -d.getTimezoneOffset() };
    if (zone === 'UTC' || Number.isNaN(d.getTime())) return { Y: d.getUTCFullYear(), M: d.getUTCMonth(), D: d.getUTCDate(), H: d.getUTCHours(), Mi: d.getUTCMinutes(), S: d.getUTCSeconds(), W: d.getUTCDay(), off: 0 };
    const o = {};
    for (const part of zoneFormat(zone).formatToParts(d)) o[part.type] = part.value;
    const f = { Y: +o.year, M: +o.month - 1, D: +o.day, H: +o.hour % 24, Mi: +o.minute, S: +o.second, W: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) };
    f.off = Math.round((Date.UTC(f.Y, f.M, f.D, f.H, f.Mi, f.S) - Math.floor(t / 1000) * 1000) / 60000);
    return f;
  }
  /** the moment of a date and time of day in a zone → ms since 1970 */
  function timeOf(Y, M, D, H, Mi, S, zone) {
    if (!zone) return new Date(Y, M, D, H, Mi, S).getTime();
    const g = Date.UTC(Y, M, D, H, Mi, S);
    if (zone === 'UTC') return g;
    let t = g - timeFields(g, zone).off * 60000;
    t = g - timeFields(t, zone).off * 60000;
    return t;
  }
  /** the short name of the zone at that moment (BST, CEST, EST) – or its distance from UTC (+09) */
  function zoneName(t, zone) {
    if (zone === 'UTC' || zone === 'GMT') return zone;
    const d = new Date(t), off = timeFields(t, zone).off;
    try {
      for (const l of ['en-GB', 'en-US', 'en-AU', 'en-IN', 'en-CA']) {
        const part = new Intl.DateTimeFormat(l, Object.assign({ timeZoneName: 'short' }, zone ? { timeZone: zone } : {})).formatToParts(d).find((q) => q.type === 'timeZoneName');
        if (part && /^[A-Za-z]{2,6}$/.test(part.value) && (!/^(GMT|UTC)$/.test(part.value) || off === 0)) return part.value;
      }
      // (British time was one hour ahead all year from 1968 to 1971: BST then, too)
      if (off === 60 && (zone || Intl.DateTimeFormat().resolvedOptions().timeZone) === 'Europe/London') return 'BST';
    } catch (e) {
      /* the offset, then */
    }
    const a = Math.abs(off);
    return (off < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + (a % 60 ? String(a % 60).padStart(2, '0') : '');
  }
  /** a time in the format of date (+%Y-%m-%d …), as the C library writes it */
  function strftime(fmt, when, zone) {
    const t = when instanceof Date ? when.getTime() : +when;
    const f = timeFields(t, zone);
    const p2 = (n) => String(n).padStart(2, '0');
    const yday = Math.round((Date.UTC(f.Y, f.M, f.D) - Date.UTC(f.Y, 0, 1)) / 864e5);
    const isoWeek = () => {
      const x = new Date(Date.UTC(f.Y, f.M, f.D));
      x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7) + 3);
      const y = x.getUTCFullYear(), first = new Date(Date.UTC(y, 0, 4));
      return [y, 1 + Math.round(((x - first) / 864e5 - 3 + ((first.getUTCDay() + 6) % 7)) / 7)];
    };
    const zone4 = (colon) => {
      const a = Math.abs(f.off);
      return (f.off < 0 ? '-' : '+') + p2(Math.floor(a / 60)) + (colon ? ':' : '') + p2(a % 60);
    };
    const h12 = f.H % 12 === 0 ? 12 : f.H % 12;
    const one = (c) => {
      switch (c) {
        case 'Y': return String(f.Y);
        case 'C': return p2(Math.floor(f.Y / 100));
        case 'y': return p2(f.Y % 100);
        case 'm': return p2(f.M + 1);
        case 'd': return p2(f.D);
        case 'e': return String(f.D).padStart(2, ' ');
        case 'H': return p2(f.H);
        case 'k': return String(f.H).padStart(2, ' ');
        case 'I': return p2(h12);
        case 'l': return String(h12).padStart(2, ' ');
        case 'M': return p2(f.Mi);
        case 'S': return p2(f.S);
        case 'N': return String(((t % 1000) + 1000) % 1000).padStart(3, '0') + '000000';
        case 'p': return f.H < 12 ? 'AM' : 'PM';
        case 'P': return f.H < 12 ? 'am' : 'pm';
        case 'j': return String(yday + 1).padStart(3, '0');
        case 'u': return String(f.W === 0 ? 7 : f.W);
        case 'w': return String(f.W);
        case 'a': return DAY_NAMES[f.W].slice(0, 3);
        case 'A': return DAY_NAMES[f.W];
        case 'b':
        case 'h': return MONTH_NAMES[f.M].slice(0, 3);
        case 'B': return MONTH_NAMES[f.M];
        case 'Z': return zoneName(t, zone);
        case 'z': return zone4(false);
        case 's': return String(Math.floor(t / 1000));
        case 'n': return '\n';
        case 't': return '\t';
        case 'F': return `${f.Y}-${p2(f.M + 1)}-${p2(f.D)}`;
        case 'T': return `${p2(f.H)}:${p2(f.Mi)}:${p2(f.S)}`;
        case 'R': return `${p2(f.H)}:${p2(f.Mi)}`;
        case 'D':
        case 'x': return `${p2(f.M + 1)}/${p2(f.D)}/${p2(f.Y % 100)}`;
        case 'X': return `${p2(f.H)}:${p2(f.Mi)}:${p2(f.S)}`;
        case 'r': return `${p2(h12)}:${p2(f.Mi)}:${p2(f.S)} ${f.H < 12 ? 'AM' : 'PM'}`;
        case 'c': return `${DAY_NAMES[f.W].slice(0, 3)} ${MONTH_NAMES[f.M].slice(0, 3)} ${String(f.D).padStart(2, ' ')} ${p2(f.H)}:${p2(f.Mi)}:${p2(f.S)} ${f.Y}`;
        case 'G': return String(isoWeek()[0]);
        case 'g': return p2(isoWeek()[0] % 100);
        case 'V': return p2(isoWeek()[1]);
        case 'U': return p2(Math.floor((yday + 7 - f.W) / 7));
        case 'W': return p2(Math.floor((yday + 7 - ((f.W + 6) % 7)) / 7));
        default: return null;
      }
    };
    return String(fmt).replace(/%:z/g, () => zone4(true)).replace(/%([-_0^#]?)(\d*)([A-Za-z%+])/g, (m, flag, width, c) => {
      if (c === '%') return '%';
      let s = one(c);
      if (s == null) return m;
      if (flag === '-') s = s.replace(/^[0 ]+(?=\S)/, '');
      else if (flag === '_') s = s.replace(/^0+(?=\d)/, (z) => ' '.repeat(z.length));
      else if (flag === '^') s = s.toUpperCase();
      if (width) s = s.padStart(+width, flag === '_' ? ' ' : /^\d/.test(s) ? '0' : ' ');
      return s;
    });
  }
  /** A date as people write it for touch -d and find -newermt: 2024-07-15, "2024-07-15 12:30", 2024-07-15T12:30:00Z,
      @1721044800, "4 March 2022", now, yesterday, tomorrow, "2 days ago", "+3 hours", "next week".
      → ms since 1970, or NaN (not a date that is understood here) */
  function parseDate(text, zone, base) {
    let s = String(text).trim().replace(/\s+/g, ' ');
    const now = base != null ? base : Date.now();
    if (/^@-?\d+(\.\d+)?$/.test(s)) return parseFloat(s.slice(1)) * 1000;
    // a zone written at the end goes before TZ
    let z = zone, fixed = null, m = /\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})$/i.exec(s);
    if (m && /\d/.test(s.slice(0, m.index))) {
      if (/^[+-]/.test(m[1])) fixed = (m[1][0] === '-' ? -1 : 1) * (+m[1].slice(1, 3) * 60 + +m[1].slice(-2));
      else z = 'UTC';
      s = s.slice(0, m.index).trim();
    }
    const mk = (Y, Mo, D, h, mi, sec) => (fixed != null ? Date.UTC(Y, Mo, D, h, mi, sec) - fixed * 60000 : timeOf(Y, Mo, D, h, mi, sec, z));
    const lower = s.toLowerCase();
    const UNIT = { sec: 1e3, second: 1e3, min: 6e4, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, fortnight: 12096e5 };
    if (lower === 'now' || lower === 'today' || lower === '') return now;
    if (lower === 'yesterday') return now - 864e5;
    if (lower === 'tomorrow') return now + 864e5;
    m = /^(?:(next|last)|([+-]?\d+)) ?(sec|second|min|minute|hour|day|week|fortnight|month|year)s?( ago)?$/.exec(lower);
    if (m) {
      let n = m[1] ? (m[1] === 'next' ? 1 : -1) : parseInt(m[2], 10);
      if (m[4]) n = -n;
      if (UNIT[m[3]]) return now + n * UNIT[m[3]];
      const f = timeFields(now, z);
      return mk(f.Y + (m[3] === 'year' ? n : 0), f.M + (m[3] === 'month' ? n : 0), f.D, f.H, f.Mi, f.S);
    }
    const hms = '(?:[T ]+(\\d{1,2}):(\\d{2})(?::(\\d{2})(?:[.,]\\d+)?)?)?';
    m = new RegExp(`^(\\d{4})-(\\d{1,2})-(\\d{1,2})${hms}$`).exec(s) || new RegExp(`^(\\d{4})(\\d{2})(\\d{2})${hms}$`).exec(s);
    if (m) return mk(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    const month = (w) => MONTH_NAMES.findIndex((x) => x.toLowerCase().startsWith(w.toLowerCase().replace(/\.$/, '')) && w.replace(/\.$/, '').length >= 3);
    m = new RegExp(`^(\\d{1,2}) ([A-Za-z]{3,9})\\.?,? (\\d{4})${hms}$`).exec(s);
    if (m && month(m[2]) >= 0) return mk(+m[3], month(m[2]), +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    m = new RegExp(`^([A-Za-z]{3,9})\\.? (\\d{1,2}),? (\\d{4})${hms}$`).exec(s);
    if (m && month(m[1]) >= 0) return mk(+m[3], month(m[1]), +m[2], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (m) {
      const f = timeFields(now, z);
      return mk(f.Y, f.M, f.D, +m[1], +m[2], +(m[3] || 0));
    }
    return NaN;
  }
  MG.time = { zoneOf, fields: timeFields, at: timeOf, zoneName, strftime, parse: parseDate };

  /* ------------------------------------------------------------------
     Option parsing helper:  getopts(args, 'n:c:vh', {long})
     ------------------------------------------------------------------ */
  function getopts(args, spec, longMap, extra) {
    const takes = {};
    (spec + (extra || '')).replace(/([A-Za-z0-9@])(:?)/g, (m, c, colon) => (takes[c] = !!colon));
    const opts = {};
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') {
        rest.push(...args.slice(i + 1));
        break;
      }
      if (a.startsWith('--') && longMap) {
        const [k, v] = a.slice(2).split('=');
        const m = longMap[k];
        if (!m) throw userErr(`unrecognized option '${a}'`);
        if (takes[m]) {
          opts[m] = v != null ? v : args[++i];
          if (opts[m] === undefined) throw userErr(`option '--${k}' requires an argument`);
        } else opts[m] = true;
        continue;
      }
      if (/^-[0-9]+$/.test(a) && takes.n) {
        opts.n = a.slice(1);
        continue;
      }
      if (a.startsWith('-') && a.length > 1 && (!/^-\d/.test(a) || a[1] in takes)) {
        for (let j = 1; j < a.length; j++) {
          const c = a[j];
          if (!(c in takes)) throw userErr(`invalid option -- '${c}'`);
          if (takes[c]) {
            opts[c] = j + 1 < a.length ? a.slice(j + 1) : args[++i];
            if (opts[c] === undefined) throw userErr(`option requires an argument -- '${c}'`);
            break;
          } else opts[c] = true;
        }
        continue;
      }
      rest.push(a);
    }
    return { opts, rest };
  }

  /** What is left of the input of the block, the function or the script a command stands in
      ({ cat; } < FILE,  f() { wc -l; }; f < FILE,  PROGRAM | bash script.sh) – for a command that has no input
      of its own and reads. Taking it uses it up: the next command finds nothing. → the text, or null */
  function inherited(ctx) {
    const s = ctx.inherit;
    if (!s || s.pos >= s.text.length) return null;
    const rest = s.text.slice(s.pos);
    s.pos = s.text.length;
    return rest;
  }
  /** A name as bash shows it in its own messages: with a control character in it (a carriage return from a script
      with the line ends of Windows, a tab, a newline) in the form $'…', so that the character can be seen. */
  const printable = (s) => (/[\x00-\x1f\x7f]/.test(s) ? "$'" + String(s).replace(/[\\']/g, '\\$&').replace(/[\x00-\x1f\x7f]/g, (c) => ({ '\x07': '\\a', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\v': '\\v', '\f': '\\f', '\r': '\\r', '\x1b': '\\E' }[c] || '\\' + c.charCodeAt(0).toString(8).padStart(3, '0'))) + "'" : s);
  /** the text a command reads: the named files, or what is piped in */
  async function inputOf(ctx, files, cmdName) {
    if (!files.length || (files.length === 1 && (files[0] === '-' || files[0] === '/dev/stdin'))) {
      if (ctx.stdin == null) return inherited(ctx) || '';
      if (MG.FileRef && ctx.stdin instanceof MG.FileRef) return await MG.wasm.readText(ctx.stdin.apath);
      return ctx.stdin;
    }
    let all = '';
    for (const f of files) all += await readOne(ctx, f, cmdName);
    return all;
  }
  async function readOne(ctx, f, cmdName) {
    if (f === '/dev/null') return '';
    if (f === '/dev/stdin') return inputOf(ctx, [], cmdName);
    const e = ctx.fs.get(f);
    const shown = cmdName === 'nl' && (f === '' || /[^\w%+,\-./:=@^~#]/.test(f) || /^[~#]/.test(f)) ? "'" + f.replace(/'/g, "'\\''") + "'" : f;
    if (!e) throw userErr(`${cmdName}: ${shown}: No such file or directory`);
    if (e.kind === 'dir') throw userErr(`${cmdName}: ${shown}: Is a directory`);
    return await ctx.fs.readText(f);
  }

  /* ------------------------------------------------------------------
     Shell
     ------------------------------------------------------------------ */
  class Shell {
    constructor(opts) {
      // (the shell's view of the files: a path that reaches a command is taken as it is written – see VFS.forShell)
      this.fs = opts.fs && typeof opts.fs.forShell === 'function' ? opts.fs.forShell() : opts.fs;
      this.term = opts.term || null;
      // (TERM=dumb: this terminal shows text – no colours, no moving about the screen)
      this.env = Object.assign({ HOME: this.fs.home, USER: 'student', LOGNAME: 'student', SHELL: '/bin/bash', PATH: '/usr/local/bin:/usr/bin:/bin', HOSTNAME: (MG.config && MG.config.hostname) || 'biolab', LANG: 'C.UTF-8', TERM: 'dumb' }, opts.env || {});
      this.env0 = Object.assign({}, this.env); // the environment of a new shell (see freshState)
      this.history = [];
      this.lastCode = 0;
      this.running = false;
      this.hooks = opts.hooks || {};
      this.flags = { e: false, u: false, x: false, pipefail: false };
    }
    get cwd() {
      return this.fs.cwd;
    }
    /** the note about a reader that left early (see runPipeline): not twice within three seconds, and for the same
        two commands not again within a minute – a loop over twenty samples says it once */
    _pipeMaybeDue(key) {
      const now = Date.now(), seen = this._pipeMaybeAt || (this._pipeMaybeAt = new Map());
      if ((this._pipeMaybe && now - this._pipeMaybe < 3000) || (seen.has(key) && now - seen.get(key) < 60000)) return false;
      this._pipeMaybe = now;
      seen.set(key, now);
      return true;
    }

    /** Run the programs of one pipeline, one after another: [{ argv, redirs, stdinText }].
        Each program's output goes to the next as a file (or as text, for the JavaScript commands).
        opts: { scope: the variables, st: the interpreter's state, pipefail, stdin }
        io.bytes: the output of the last command is kept by the caller as bytes (the file or the pipe of a block) */
    async runPipeline(pipeline, io, rawLine, opts = {}) {
      let stdin = opts.stdin != null ? opts.stdin : null;
      let code = 0;
      const codes = [];
      const noclobber = !!(opts.st && opts.st.flags && opts.st.flags.C);
      // in a script the shell's own messages name the script and the line, as bash's do:
      //   analysis.sh: line 12: bwa: command not found
      const who = opts.st && (opts.st.script || opts.st.errName) ? `${opts.st.script || opts.st.errName}: line ${opts.st.line}: ` : 'bash: ';
      const named = (t) => (who !== 'bash: ' && typeof t === 'string' && t.startsWith('bash: ') && !/^bash: line \d+: /.test(t) ? who + t.slice(6) : t);
      // (the special files that a command may write to)
      const DEV_OUT = /^\/dev\/(null|stdout|stderr|tty|fd\/[12])$/;
      // bash opens the files after > before the command runs. So a file that is new is there from the start
      // ("ls > list.txt" lists list.txt), and a file that exists is emptied before the command reads it:
      // "sort f > f" and "sort f | uniq > f" leave an empty file – here as on every Linux computer, and the terminal
      // says why. In a pipeline the commands start together and each opens its own files: by the time a program
      // reads, the command after it has emptied its file, and the ones further on usually have not yet
      // ("awk 1 f | sort | uniq > f" as a rule still reads f; nobody should count on it).
      const emptied = pipeline.map(() => false);
      const openFiles = (k, empty, from) => {
        const c = pipeline[k];
        if (!c || emptied[k]) return;
        if (empty) emptied[k] = true;
        for (const r of c.redirs || []) {
          // (the files are opened from left to right: after "< FILE" that is not there, nothing more is opened)
          if (r.op === '<' && r.target && !this.fs.exists(r.target)) break;
          if (!/^(>|>>|&>|2>|2>>)$/.test(r.op) || !r.target || DEV_OUT.test(r.target)) continue;
          // (> NAME/ cannot be opened – "Is a directory": no file NAME is made, and nothing after it is opened)
          if (/[^/]\/+$/.test(r.target)) break;
          const abs = this.fs.resolve(r.target), e = this.fs.get(abs);
          if (!e) {
            // (in a folder that is not there no file can be made – and nothing after it is opened)
            if (!this.fs.isDir(MG.path.dirname(abs))) break;
            this.fs.writeText(abs, '');
            r.made = true;
            continue;
          }
          // (a folder, a write-protected file, a file that set -C protects cannot be opened – nor is anything after it)
          if (e.kind === 'dir' || e.readonly || e.protected || (noclobber && !r.made && !r.clobber && !/>>$/.test(r.op) && !(this._fresh && this._fresh.has(abs)))) break;
          if (!empty || r.made || />>$/.test(r.op) || e.kind === 'dir' || e.readonly || e.protected || (noclobber && !r.clobber)) continue;
          if (e.kind === 'text' && e.text === '') continue;
          // (a command that has still to run, and reads this file)
          const reader = pipeline.slice(from).find((q) => {
            const words = unwrap(q.argv), name = words[0];
            if (!name || !(MG.shellTools[name] || /^(tac|rev|nl|column|sha256sum|diff|cmp|less|more|bash|sh)$/.test(name))) return false;
            if ((q.redirs || []).some((x) => x.op === '<' && x.target && this.fs.resolve(x.target) === abs)) return true;
            const args = words.slice(1), kinds = MG.shellLang && MG.shellLang.argKinds ? MG.shellLang.argKinds(name, args) : [];
            return args.some((a, i) => kinds[i] !== 'skip' && a && !a.startsWith('-') && this.fs.resolve(a) === abs);
          });
          this.fs.rewrite(abs, '');
          if (reader && io.note) io.note(`${r.target} was emptied before ${unwrap(reader.argv)[0]} read it: bash opens the file after > first. Write to another file, then rename it:  ${unwrap(reader.argv)[0]} … > new.tmp && mv new.tmp ${r.target}`);
        }
      };
      // (new files of every command are there from the start; the first command's files and the second's are emptied)
      pipeline.forEach((c, k) => openFiles(k, k <= 1, 0));
      /* The reader left early. On Linux a command that still writes into a pipe when the command after it has
         ended is itself ended, by the signal SIGPIPE – its status is 141:  samtools view x.bam | head  (under
         set -o pipefail the pipeline then counts as failed). Here the commands run one after the other, each to
         its end; what would have happened is worked out afterwards, and only where it is certain: the writer wrote
         more than a pipe holds (64 KiB) beyond what the reader took. piped: the bytes the command before wrote
         into the pipe; see "took" below. */
      const sizeOfInput = async (x) => (x == null ? null : MG.FileRef && x instanceof MG.FileRef ? (MG.wasm && MG.wasm.sizeOf ? await MG.wasm.sizeOf(x.apath) : null) : typeof x === 'string' ? x.length : null);
      let piped = null;
      for (let s = 0; s < pipeline.length; s++) {
        if (this.term?.cancelled) return 130;
        openFiles(s + 1, true, s);
        const cmd = pipeline[s];
        const last = s === pipeline.length - 1;
        const argv = cmd.argv.slice();
        const fromPipe = s > 0 ? piped : stdin != null ? await sizeOfInput(stdin) : null;
        // input: a here-document, or < FILE
        const ownInput = cmd.stdinText != null || cmd.redirs.some((r) => r.op === '<');
        if (cmd.stdinText != null) stdin = cmd.stdinText;
        const inR = cmd.redirs.filter((r) => r.op === '<').pop();
        // bash opens the files of a command before the command starts, from left to right: a file that is not
        // there, a missing folder or a write-protected file stops it. cannot → why the file of one redirection
        // cannot be opened (or null)
        const cannot = (redir) => {
          if (redir.op === '<') {
            const e = this.fs.get(redir.target);
            if (!e) return `${redir.target}: ${(this.fs.pathError && this.fs.pathError(redir.target)) || 'No such file or directory'}`;
            return e.kind === 'dir' && redir === inR ? `${redir.target}: Is a directory` : null;
          }
          if (!/^(>|>>|&>|2>|2>>)$/.test(redir.op) || !redir.target || DEV_OUT.test(redir.target)) return null;
          const parent = MG.path.dirname(this.fs.resolve(redir.target));
          // (> NAME/ : a slash behind the name asks for a folder, and a folder cannot be written to – whether NAME is
          // a file, a folder or not there at all)
          if (/[^/]\/+$/.test(redir.target) && (this.fs.isDir(parent) || (this.fs.pathError && this.fs.pathError(redir.target) === 'Not a directory'))) return `${redir.target}: Is a directory`;
          if (!this.fs.isDir(parent)) {
            // (a file, or a special file like /dev/null, where a folder should be: "Not a directory")
            const pe = this.fs.exists(parent) || deviceEntry(this.fs, parent);
            return `${redir.target}: ${pe && parent !== '/dev' ? 'Not a directory' : parent === '/dev' ? 'Permission denied' : 'No such file or directory'}`;
          }
          const te = this.fs.get(redir.target);
          if (te && (te.readonly || te.protected)) return `${redir.target}: Permission denied`;
          if (te && te.kind === 'dir') return `${redir.target}: Is a directory`;
          // set -o noclobber (set -C): > does not overwrite a file that is there (>| does)
          if (noclobber && te && !redir.made && !redir.clobber && !/>>$/.test(redir.op) && !(this._fresh && this._fresh.has(this.fs.resolve(redir.target)))) return `${redir.target}: cannot overwrite existing file`;
          return null;
        };
        const refused = cmd.redirs.find((r) => cannot(r));
        if (refused) {
          // The command is not run and has the status 1. The other commands of the pipeline run all the same, as in
          // bash:  sort < nosuch.txt | wc -l  prints 0 (and has the status of wc); the next command reads an empty
          // input. The command before this one finds nobody reading: a program that writes anything is ended by
          // SIGPIPE (status 141) – one of the shell's own commands (echo, printf) has, as a rule, written its few
          // bytes before that, and ends with 0. The message goes where the errors of this command go at that
          // moment – into the file of a  2> FILE  that stands before.
          const msg = `${who}${cannot(refused)}\n`;
          // (where the errors go, and the output, after the redirections that stand before the one that fails:
          // 2> FILE, &> FILE, > FILE 2>&1 – the message is in FILE –, 2>&1 alone – it goes down the pipe, or to
          // whoever takes the output: x=$(sort 2>&1 < nosuch))
          let errTo = null, outTo = null, passOn = '';
          for (const r of cmd.redirs.slice(0, cmd.redirs.indexOf(refused))) {
            if (r.op === '>' || r.op === '>>') outTo = r;
            else if (r.op === '2>' || r.op === '2>>') errTo = r;
            else if (r.op === '&>') outTo = errTo = r;
            else if (r.op === '2>&1') errTo = outTo || 'out';
          }
          if (!errTo) io.err(msg);
          else if (errTo === 'out') {
            if (last) io.out(msg);
            else passOn = msg;
          } else if (errTo.target && errTo.target !== '/dev/null' && this.fs.exists(errTo.target) && !this.fs.isDir(errTo.target)) {
            if (/>>$/.test(errTo.op)) await this.appendTo(errTo.target, msg);
            else this.fs.rewrite(errTo.target, msg);
          }
          const before = s > 0 ? unwrap(pipeline[s - 1].argv)[0] || '' : '';
          if (s > 0 && piped != null && codes[s - 1] === 0 && (piped > 65536 || (piped > 0 && !(MG.shellLang && MG.shellLang.isShellWord && MG.shellLang.isShellWord(before))))) codes[s - 1] = 141;
          code = 1;
          codes.push(code);
          stdin = passOn;
          piped = passOn.length;
          continue;
        }
        if (inR) {
          if (MG.wasm) {
            await MG.wasm.ensure();
            // everything, not this file alone: writing one file could destroy the bytes that a copy of it (cp, mv) still needs
            await MG.wasm.syncAll(this.fs);
            stdin = new MG.FileRef(MG.wasm.apath(this.fs.resolve(inR.target)));
            stdin.fromFile = true; // a file, not a pipe: see _stream
            if (/^\/tmp\/\.psub-\d+$/.test(this.fs.resolve(inR.target))) stdin.psub = true; // (… but of < <(command) wc must think it is one)
          } else stdin = await this.fs.readText(inR.target);
        }
        let outR = cmd.redirs.filter((r) => r.op === '>' || r.op === '>>' || r.op === '&>').pop();
        let errR = cmd.redirs.filter((r) => r.op === '2>' || r.op === '2>>').pop();
        let errToOut = cmd.redirs.some((r) => r.op === '2>&1' || r.op === '&>');
        // "2>&1 > FILE" is not "> FILE 2>&1": the errors go where the output went before it was sent to the file –
        // down the pipe, or to the terminal – and only the output goes to the file
        const errEarly = errToOut && !cmd.redirs.some((r) => r.op === '&>') && cmd.redirs.findIndex((r) => r.op === '2>&1') < cmd.redirs.map((r) => r.op === '>' || r.op === '>>').lastIndexOf(true);
        // … and where the files are is settled then, too: a cd in the command does not move them
        const settled = (r) => (r && r.target !== '/dev/null' ? Object.assign({}, r, { target: this.fs.resolve(r.target) }) : r);
        outR = settled(outR);
        errR = settled(errR);
        // COMMAND >> log 2>> log: output and messages go to one file – in the order in which they are written, as
        // with 2>&1 (kept apart, the messages would all stand before the output)
        if (outR && errR && outR.target !== '/dev/null' && outR.target === errR.target) {
          errR = null;
          errToOut = true;
        }
        const toTerminal = last && !outR;
        const ownShell = /^(.*\/)?(bash|sh)$/.test(unwrap(argv)[0] || '');
        const sink = new Sink(); // what the command printed, when that does not go straight on to the caller
        let outRef = null;
        let errBuf = '';
        let early = ''; // what "2>&1 > FILE" sends down the pipe
        const ctx = {
          shell: this,
          fs: this.fs,
          env: opts.scope || this.env,
          argv,
          name: argv[0],
          args: argv.slice(1),
          stdin,
          // A command without input of its own reads that of the block, the function or the script it stands in
          // (the first command of a pipeline only: the others read the one before them). See inherited().
          inherit: s === 0 && stdin == null && opts.st && opts.st.stdin ? opts.st.stdin : null,
          isPipedIn: s > 0 || !!inR || stdin != null,
          // (for [ -p /dev/stdin ], [ -f /dev/stdin ] …: the file of "< FILE", and whether the output goes into a pipe)
          stdinFrom: inR ? this.fs.resolve(inR.target) : cmd.stdinDev && !inR ? '/dev/null' : null,
          outToPipe: !last,
          // (the input is a here-document or a here-string – for wc: see _run in tools-wasm.js)
          hereInput: cmd.stdinText != null && !inR,
          // (a program hands its output over as a file when it goes into a pipe – that of a block, too)
          isPipedOut: !last || (!outR && !!io.bytes),
          // the output is kept as it is, bytes included: it goes to a file or into a pipe, not to the screen
          takesBytes: !toTerminal || !!io.bytes,
          // (the output goes on to whoever runs this pipeline – the terminal, or the file or pipe of a block)
          toCaller: toTerminal,
          // "> /dev/stdout", "> /dev/stderr" inside a script open the file anew: what was written to it so far goes
          outClear: outR ? (outR.op !== '>>' && outR.target !== '/dev/null' ? () => sink.clear() : null) : toTerminal ? io.outClear || null : null,
          errClear: errR ? (errR.op === '2>' ? () => (errBuf = '') : null) : errToOut && !errEarly ? (outR ? (outR.op !== '>>' ? () => sink.clear() : null) : toTerminal ? io.outClear || null : null) : io.errClear || null,
          redirectTarget: outR ? outR.target : null,
          redirectAppend: outR ? outR.op === '>>' : false,
          mergeStderr: errToOut && !errR && !errEarly,
          rawLine,
          term: this.term,
          io,
          opts,
          out: (t) => {
            if (t == null) return;
            if (MG.FileRef && t instanceof MG.FileRef) {
              outRef = t;
              return;
            }
            if (!toTerminal) sink.add(t);
            else if (typeof t === 'string' || io.bytes) io.out(t);
            else io.out(bytesText(t));
          },
          outHTML: (html) => {
            if (toTerminal && io.html && !io.bytes) io.html(html);
          },
          err: (t) => {
            // (An operand that names nothing because a FILE stands where a folder is needed – "a.txt/",
            // "a.txt/../x": the commands of the page say "No such file or directory" for whatever they do not
            // find; Linux says "Not a directory" there.)
            if (typeof t === 'string' && t.includes('No such file or directory') && this.fs.pathError && argv.some((a, k) => k > 0 && a.includes('/') && t.includes(a) && this.fs.pathError(a) === 'Not a directory')) t = t.replace(/No such file or directory/g, 'Not a directory');
            // (not what a bash that this command starts says itself: bash nosuch.sh)
            if (!ownShell) t = named(t);
            if (errR) errBuf += t;
            else if (errEarly) {
              if (last) io.out(t);
              else early += t;
            } else if (errToOut && !toTerminal) sink.add(t);
            else if (errToOut) io.out(t);
            else io.err(t);
          },
          progress: (t) => io.progress && io.progress(t)
        };
        const name = argv[0];
        // (no word at all: nothing to run. An EMPTY word – "$TOOL" view … with TOOL not set – is a command that
        // is not found, status 127, as in bash: it goes the way of every other name)
        if (!argv.length) {
          stdin = '';
          piped = 0;
          continue;
        }
        // (did the command look at its input at all?)
        let took = false, input = stdin;
        Object.defineProperty(ctx, 'stdin', { get: () => ((took = true), input), set: (v) => (input = v), enumerable: true, configurable: true });
        // (the file that is this command's input stays until the command has ended, whatever it runs itself)
        const held = MG.FileRef && stdin instanceof MG.FileRef && MG.wasm && MG.wasm.hold ? stdin.apath : null;
        if (held) MG.wasm.hold(held);
        try {
          code = await this.dispatch(name, ctx);
        } catch (e) {
          // exit, return, break … and errors of the language itself are not this command's business
          if (e && (e.shellControl || e.shellError) && !e.readonlyVar) throw e;
          if (e && e.readonlyVar) ctx.err(`bash: ${/^(local|declare|typeset|export|readonly|read|printf|mapfile|readarray|getopts|let)$/.test(name) ? name + ': ' : ''}${e.message}\n`);
          else if (e && e.userMessage) {
            // (what a program says about its options and operands, as the GNU programs say it: with its name in
            // front, and where to look)
            let msg = e.userMessage;
            if (/^(invalid option -- |unrecognized option |option requires an argument -- |option '--[\w-]+' requires an argument)/.test(msg)) msg = `${name}: ${msg}\nTry '${name} --help' for more information.`;
            else if (!msg.includes('\n') && new RegExp(`^${name.replace(/[^\w-]/g, '\\$&')}: (missing (file |destination file )?operand\\b.*|extra operand .*|cannot combine .*)$`).test(msg)) msg += `\nTry '${name} --help' for more information.`;
            ctx.err(msg.endsWith('\n') ? msg : msg + '\n');
          }
          else {
            console.error(e);
            ctx.err(`${name}: ${e && e.message ? e.message : e}\n`);
          }
          code = e && e.code ? e.code : 1;
        } finally {
          if (held) MG.wasm.release(held);
        }
        // How much of what was piped in did the command take? A program: as far as it read (0: not known – wc -c
        // asks for the size of its input and reads nothing). A command of the page: all of it if it looked, nothing
        // if it never did (echo, true). With an input of its own (< FILE, <<<): nothing.  null: all, or not known.
        const used = ownInput ? 0 : typeof ctx.stdinUsed === 'number' ? (ctx.stdinUsed > 0 ? ctx.stdinUsed : null) : took ? null : 0;
        const unread = fromPipe != null && used != null ? fromPipe - used : 0;
        const leftEarly = unread > 65536;
        if (s > 0 && !leftEarly && unread > 0 && fromPipe > 4096 && opts.pipefail && io.note && this._pipeMaybeDue(`${unwrap(pipeline[s - 1].argv)[0]} | ${unwrap(argv)[0]}`)) {
          // Less than a pipe holds was left unread. On Linux the writer is then ended by SIGPIPE if it is still
          // writing when the reader goes, and ends normally if it had written everything by then: the timing
          // decides, and so the same script passes on one day and stops on another. Here the status is 0 – and the
          // student is told, because under set -o pipefail the pipeline can fail on Linux.
          const writer = unwrap(pipeline[s - 1].argv)[0] || 'the command before', reader = unwrap(argv)[0];
          io.note(`On Linux this pipeline can fail under set -o pipefail: ${reader} stopped reading before it had taken everything that ${writer} wrote, and a program that is still writing at that moment is ended with status 141 (SIGPIPE) – whether it is depends on timing. Here the status is 0. To be safe on every computer, use a reader that reads to the end ( … | awk 'NR <= 10' ,  … | sed -n '1,10p' ), or let it pass:  … | ${reader} … || true`);
        }
        if (s > 0 && leftEarly) {
          codes[s - 1] = 141;
          if (opts.pipefail && io.note && !(this._pipeNoted && Date.now() - this._pipeNoted < 3000)) {
            const writer = unwrap(pipeline[s - 1].argv)[0] || 'the command before';
            io.note(`${writer} was ended by the signal SIGPIPE (status 141): ${unwrap(argv)[0]} stopped reading before ${writer} had written everything. With set -o pipefail the pipeline fails for that – here as on Linux. A reader that reads to the end does not have this effect ( … | awk 'NR <= 10' ,  … | sed -n '1,10p' ); or let it pass:  … | ${unwrap(argv)[0]} … || true`);
            this._pipeNoted = Date.now();
          }
        }
        // (for a pipeline with blocks and functions in it: see _runMulti)
        if (s === 0 && opts.stdin != null) this._tookPart = used != null && fromPipe != null ? { used, size: fromPipe } : null;
        // (a file that the command itself removed or renamed – rm f > f, mv f g > f – is not made again)
        // (No message: the file stays as it was opened – made, or emptied, before the command ran – or as the command
        // itself wrote it by name:  sort a.txt -o F 2> F,  samtools sort -o s.bam x.bam 2> s.bam)
        if (errR && errR.target !== '/dev/null' && errBuf !== '' && this.fs.exists(errR.target)) {
          if (errR.op === '2>>') await this.appendTo(errR.target, errBuf);
          else this.fs.rewrite(errR.target, errBuf);
        }
        if (outR) {
          if (outR.target === '/dev/null' || ctx.wroteRedirect || !this.fs.exists(outR.target)) {
            /* nothing to keep, or the program wrote the file itself (real bytes) */
          } else {
            let all = sink;
            if (outRef) {
              // the bytes of the program, then what the page added
              all = new Sink();
              all.add(await MG.wasm.readBytes(outRef.apath));
              sink.parts.forEach((part) => all.add(part));
            }
            // (Nothing was printed: the file stays as it was opened – made, or emptied, before the command ran – or
            // as the command itself wrote it by name:  sort -o F a.txt > F,  cp a.txt F > F,  f() { echo x >> F; }; f > F)
            if (!all.empty) await this.writeOut(outR.target, all, outR.op === '>>');
          }
          stdin = early;
          piped = early.length;
        } else if (!last) {
          if (outRef && sink.empty) stdin = outRef;
          else if (outRef || sink.binary) {
            const all = new Sink();
            if (outRef) all.add(await MG.wasm.readBytes(outRef.apath));
            sink.parts.forEach((part) => all.add(part));
            stdin = await MG.wasm.tempBytes(all.bytes(), !!(outRef && outRef.binary));
          } else stdin = sink.text();
          piped = await sizeOfInput(stdin);
        } else if (outRef) {
          if (io.bytes) io.out(await MG.wasm.readBytes(outRef.apath));
          else if (outRef.binary) io.note('Binary output: save it in a file with  > FILE');
          else io.out(await MG.wasm.readText(outRef.apath));
        }
        // As in bash, a failed stage does not stop the pipe: the next program gets whatever
        // was written (often nothing). The status of the pipe is that of the LAST program –
        // unless  set -o pipefail  is on, when it is the last non-zero status of any program.
        codes.push(code);
      }
      opts.codes = codes; // (for ${PIPESTATUS[@]}: see _runPipe)
      if (opts.pipefail) {
        for (let k = codes.length - 1; k >= 0; k--) if (codes[k] !== 0) return codes[k];
        return 0;
      }
      return code;
    }
    /** add text to the end of a file of any kind (>>) */
    async appendTo(target, text) {
      const e = this.fs.get(target);
      if (!e) return this.fs.writeText(target, text);
      if (e.kind === 'text') return this.fs.appendText(target, text);
      // (a file that is kept as bytes – large, or no text: it keeps its permissions, too)
      const old = await this.fs.readBytes(target), keep = {};
      if (e.mode) keep.mode = e.mode;
      if (e.perm != null) keep.perm = e.perm;
      return this.fs.put(target, Object.assign({ kind: 'blob', blob: new Blob([old, text]), fresh: true }, keep));
    }
    /** what was printed becomes the contents of a file (> FILE), or is added to it (>> FILE): text – or bytes, and
        then the file is one of the programs' files (a BAM file written by a function, a loop that writes .gz) */
    async writeOut(target, sink, append) {
      if (!sink.binary || !MG.wasm) {
        const text = sink.text();
        if (append) return this.appendTo(target, text);
        return this.fs.rewrite(target, text);
      }
      let bytes = sink.bytes();
      if (append && this.fs.exists(target) && !this.fs.isDir(target)) bytes = joinBytes(await this.fs.readBytes(target), bytes);
      return MG.wasm.writeBytes(this.fs, this.fs.resolve(target), bytes);
    }

    async dispatch(name, ctx) {
      // (a program is being started: by now the other parts of the pipeline have opened their files – see _runMulti)
      if (this._opening && this._opening.length && !(MG.shellLang && MG.shellLang.isShellWord && MG.shellLang.isShellWord(name))) this._opening.forEach((open) => open());
      const b = MG.shellBuiltins[name];
      // A program is found by way of PATH, as on Linux: after PATH=/nonexistent, or PATH=$HOME/bin (without ":$PATH"),
      // ls and samtools are "command not found". The shell's own commands – cd, echo, read … – need no PATH.
      if ((b || MG.shellTools[name]) && !name.includes('/') && !this.sysPath(ctx.env) && !(MG.shellLang && MG.shellLang.isShellWord && MG.shellLang.isShellWord(name))) {
        const mine = this.onPath(name, ctx.env);
        if (mine) return this.runFile(mine, ctx);
        ctx.err(`bash: ${printable(name)}: command not found\n`);
        ctx.io.note(`PATH is "${ctx.env.PATH}": the folders of the programs – /usr/bin and /bin – are not in it any more, so no program is found (the same happens on Linux). Put them back:  PATH=/usr/local/bin:/usr/bin:/bin   To add a folder of your own, keep the old value:  PATH="$PWD/bin:$PATH"`);
        return 127;
      }
      // NAME --help, NAME --version: what the terminal's own version of a program can do
      // (a command that runs another – env, xargs, find -exec … – takes --help for itself only as its first word)
      const first = /^(env|timeout|xargs|find|nice|nohup|time|command|getopt|stdbuf)$/.test(name);
      if (b && MG.shellHelp && ((first ? ctx.args[0] === '--help' : ctx.args.includes('--help')) || (ctx.args.length === 1 && ctx.args[0] === '--version'))) {
        const k = ctx.args.indexOf('--'), at = ctx.args.indexOf(ctx.args.includes('--help') ? '--help' : '--version');
        const text = k >= 0 && k < at ? null : MG.shellHelp(name, !ctx.args.includes('--help'));
        if (text) {
          ctx.out(text);
          return 0;
        }
      }
      if (b) return (await b(ctx)) || 0;
      const t = MG.shellTools[name];
      if (t) return (await t.run(ctx)) || 0;
      if (name.includes('/')) {
        // /usr/bin/samtools is samtools
        const base = name.split('/').pop();
        if (/^\/(usr|bin|opt)\b/.test(name) && !this.fs.exists(name) && (MG.shellBuiltins[base] || MG.shellTools[base])) return this.dispatch(base, Object.assign(ctx, { name: base }));
        if (!this.fs.exists(name) || this.fs.isDir(name)) {
          // (./FILE/ – a file where a folder is needed: "Not a directory", status 126)
          const notDir = !this.fs.isDir(name) && this.fs.pathError && this.fs.pathError(name) === 'Not a directory';
          ctx.err(`bash: ${name}: ${this.fs.isDir(name) ? 'Is a directory' : notDir ? 'Not a directory' : 'No such file or directory'}\n`);
          return this.fs.isDir(name) || notDir ? 126 : 127;
        }
        if (this.fs.get(name).mode !== 'x') {
          ctx.err(`bash: ${name}: Permission denied\n`);
          ctx.io.note(`A script must be made executable before it can be run like this:  chmod +x ${name}   (or run it with  bash ${name})`);
          return 126;
        }
        return this.runFile(name, ctx);
      }
      // a script of the student's in a folder that is on PATH (export PATH="$PWD/bin:$PATH"; mytool …)
      const found = this.onPath(name, ctx.env);
      if (found) return this.runFile(found, ctx);
      // a file of that name in a folder of PATH that may not be run (chmod +x was forgotten): as bash says it
      const noX = name.includes('/') ? null : this.onPath(name, ctx.env, false, true);
      if (noX) {
        ctx.err(`bash: ${noX}: Permission denied\n`);
        ctx.io.note(`${this.fs.pretty(noX)} is in a folder of PATH, but it is not executable. Make it so:  chmod +x ${MG.typedPath ? MG.typedPath(this.fs.pretty(noX)) : this.fs.pretty(noX)}`);
        return 126;
      }
      ctx.err(`bash: ${printable(name)}: command not found\n`);
      notHere(name);
      const why = absentNote(name);
      if (/^\{[A-Za-z_]\w*\}$/.test(name)) ctx.io.note(`${name}> FILE and ${name}< FILE – a file descriptor whose number bash chooses and puts into the variable – are not available in this terminal. Choose the number yourself, from 3 to 9:  exec 3> FILE   …   echo text >&3   …   exec 3>&-`);
      else if (why) ctx.io.note(why);
      else if (this.fs.exists(name) && /\.sh$/.test(name)) ctx.io.note(`To run a script in this folder:  bash ${name}   (or ./${name} after chmod +x ${name})`);
      else {
        const hint = !name || /[\x00-\x1f\x7f]/.test(name) ? null : suggest(name);
        if (hint) ctx.io.note(`Did you mean '${hint}'? Type  help  for the list of programs.`);
      }
      return 127;
    }
    /** Run an executable file of the student's as Linux does: by the program that its first line names.
          #!/bin/bash, #!/usr/bin/env bash, sh – or no such line: this shell (options on the line, -e -u -x, count);
          #!/usr/bin/awk -f, #!/bin/sed -f, #!/usr/bin/env -S awk -f: that program, with the file as its argument;
          a program that is not here (#!/usr/bin/env python3): the message of Linux, status 127 (126 without env).
        (bash FILE runs any file as a shell script, whatever its first line says – here as on Linux.) */
    async runFile(path, ctx) {
      const asShell = (flags) => this.runScript(path, ctx.args, innerIO(ctx), Object.assign({}, ctx.opts, { stdin: ctx.stdin, stdinDev: ctx.stdinFrom === '/dev/null' }, flags && flags.length ? { initialFlags: flags } : {}));
      const e = this.fs.get(path);
      let first = '';
      try {
        first = (e && e.kind === 'text' ? e.text.slice(0, 400) : (await this.fs.readText(path)).slice(0, 400)).split('\n', 1)[0];
      } catch (x) {
        first = '';
      }
      if (!first.startsWith('#!')) return asShell();
      const typed = ctx.name;
      // (bash 5.2 says "cannot execute: required file not found", status 127, where older versions said
      // "bad interpreter: No such file or directory", status 126. env names the word it was given.)
      const envMiss = (word) => `/usr/bin/env: \u2018${word.replace(/\r/g, '\\r')}\u2019: No such file or directory\n` + (/\s/.test(word) ? '/usr/bin/env: use -[v]S to pass options in shebang lines\n' : '');
      const absent = (prog, viaEnv) => {
        ctx.err(viaEnv ? envMiss(prog) : `bash: ${typed}: cannot execute: required file not found\n`);
        const why = absentNote(prog.split('/').pop());
        ctx.io.note(`The first line of ${typed} (${first.trim()}) names the program that is to run it` + (/\s/.test(prog) ? ` – and Linux hands "${prog}" over as ONE word. Write  #!/usr/bin/env -S ${prog}` : ', and that program is not in this terminal.') + (why ? ' ' + why : ''));
        return 127;
      };
      if (first.endsWith('\r')) {
        // a file with the line ends of Windows: Linux looks for a program called "bash<CR>" (the kernel takes the
        // carriage return for a part of the name; only blanks and tabs separate)
        const k = /^#![ \t]*([^ \t]+)(?:[ \t]+([\s\S]*?))?[ \t]*$/.exec(first);
        let status = 127;
        const crNote = () => ctx.io.note(`${typed} has the line ends of Windows (a carriage return at the end of each line): Linux takes that character for a part of the name on the first line. Take them away:  sed -i 's/\\r$//' ${typed}`);
        const kb = k ? k[1].split('/').pop() : '';
        if (k && k[2] && !/(^|\/)(env|bash|sh|dash)$/.test(k[1]) && /^\/(usr\/(local\/)?)?bin\/[^/]+$/.test(k[1]) && (MG.shellBuiltins[kb] || MG.shellTools[kb]) && !(MG.shellLang && MG.shellLang.isShellWord && MG.shellLang.isShellWord(kb))) {
          // #!/usr/bin/awk -f<CR>: the program is there, and gets "-f<CR>" as its option
          crNote();
          const argv = [kb, k[2], path, ...ctx.args];
          return this.dispatch(kb, Object.assign(ctx, { name: kb, argv, args: argv.slice(1) }));
        }
        if (k && k[2] && /(^|\/)env$/.test(k[1])) ctx.err(envMiss(k[2]));
        else if (k && k[2] && /(^|\/)bash$/.test(k[1])) {
          // #!/bin/bash -e<CR>: bash takes the carriage return for one more option letter
          ctx.err(`${k[1]}: -\r: invalid option\n`);
          status = /e/.test(k[2]) ? 1 : 2;
        } else if (k && k[2] && /(^|\/)(sh|dash)$/.test(k[1])) {
          ctx.err(`${k[1]}: 0: Illegal option -\r\n`);
          status = 2;
        } else ctx.err(`bash: ${typed}: cannot execute: required file not found\n`);
        crNote();
        return status;
      }
      const m = /^#!\s*(\S+)(?:\s+(.*\S))?\s*$/.exec(first);
      if (!m) return asShell();
      // (Linux hands everything behind the program over as ONE word: "#!/usr/bin/env awk -f" asks env for a
      // program called "awk -f" – env -S is what splits it)
      let prog = m[1], rest = m[2] != null ? [m[2]] : [], viaEnv = false;
      if (/(^|\/)env$/.test(prog)) {
        if (!rest.length) return asShell();
        const words = /^-S/.test(rest[0]) ? rest[0].replace(/^-S\s*/, '').split(/\s+/).filter(Boolean) : [rest[0]];
        if (!words.length) return asShell();
        if (/^-S/.test(rest[0]) && /^[A-Za-z_]\w*=/.test(words[0]) && words.some((w) => !/^[A-Za-z_]\w*=/.test(w))) {
          // (… -S NAME=value bash: the env of this terminal does the same – it starts the program with the file)
          const prog2 = words.find((w) => !/^[A-Za-z_]\w*=/.test(w)).split('/').pop();
          if (MG.shellBuiltins[prog2] || MG.shellTools[prog2]) {
            const argv = ['env', ...words, path, ...ctx.args];
            return this.dispatch('env', Object.assign(ctx, { name: 'env', argv, args: argv.slice(1) }));
          }
        }
        prog = words[0];
        rest = words.slice(1);
        viaEnv = true;
      }
      const base = prog.split('/').pop();
      if (/^(bash|sh|dash)$/.test(base) && (viaEnv || /^\/(usr\/(local\/)?)?bin\//.test(prog))) {
        // env -S splits what follows into words: #!/usr/bin/env -S bash -euo pipefail  works
        if (viaEnv) return asShell(rest.length ? rest.filter((w) => /^[-+]/.test(w) || /^[a-z]+$/.test(w)) : null);
        // Without env, Linux hands ALL that follows the program over as ONE word. #!/bin/bash -eu is fine;
        // #!/bin/bash -euo pipefail is not: bash gets "-euo pipefail", and the o takes the next word – the name of
        // the script – for the name of its option. #!/bin/bash -e -u: the blank is "an invalid option".
        const word = rest.length ? rest[0] : null;
        if (word == null || word === '-' || word === '--') return asShell();
        const dash = base !== 'bash';
        const usage = `Usage:\t${prog} [GNU long option] [option] ...\n\t${prog} [GNU long option] [option] script-file ...\n`;
        // (what to write instead: the options on a line of their own – named when the word is made of options of set)
        const asSet = /^[-+][abefhkmnptuvxBCEHPT]+( [-+][abefhkmnptuvxBCEHPT]+)*$/.test(word) ? `set ${word}` : /^[-+][abefhkmnptuvxBCEHPT]*o \w+$/.test(word) ? `set ${word}` : null;
        const instead = `Keep the first line to  #!${prog}  and ` + (asSet ? `write  ${asSet}  on the next line.` : 'set the options on a line of their own (set -euo pipefail, shopt -s extglob); a # on that first line does not start a comment.');
        const oneWord = () => /\s/.test(word) && ctx.io.note(`On Linux everything that follows the program on the first line of a script is handed over as ONE word: ${base} gets "${word}" as a single word, and fails. ${instead}`);
        if (!/^[-+]/.test(word)) {
          // (#!/bin/bash # comment: the word is taken for the script to run)
          if (this.fs.exists(word)) return asShell();
          ctx.err(dash ? `${prog}: 0: cannot open ${word}: No such file\n` : `${prog}: ${word}: No such file or directory\n`);
          oneWord();
          return dash ? 2 : 127;
        }
        if (!dash && word.startsWith('--')) {
          if (/^--(norc|noprofile|login|posix|restricted|noediting|debugger|verbose)$/.test(word)) return asShell(word === '--verbose' ? ['-v'] : null);
          ctx.err(`${prog}: ${word}: invalid option\n${usage}`);
          oneWord();
          return 2;
        }
        const letters = Array.from(word.slice(1));
        const valid = dash ? 'aCefIimnuVvxbsE' : 'abefhkmnptuvxBCEHPTilrsDcO';
        for (let k = 0; k < letters.length; k++) {
          const c = letters[k];
          if (c === 'o') {
            ctx.err(dash ? `${prog}: 0: Illegal option -o ${typed}\n` : `${prog}: line 0: ${prog}: ${typed}: invalid option name\n`);
            ctx.io.note(`On Linux everything that follows the program on the first line of a script is handed over as ONE word: ${base} gets "${word}" as a single option, and its o takes the next word – the name of the script – for the name of the option. ${instead}` + (dash ? '' : ` (#!/usr/bin/env -S bash ${word}  works too: env -S splits the words.)`));
            return 2;
          }
          if (!valid.includes(c)) {
            const hadE = !dash && word[0] === '-' && letters.slice(0, k).includes('e');
            ctx.err(dash ? `${prog}: 0: Illegal option ${word[0]}${c}\n` : `${prog}: ${word[0]}${c}: invalid option\n` + (hadE ? '' : usage));
            oneWord();
            return hadE ? 1 : 2;
          }
        }
        const kept = letters.filter((c) => !'ilrsDcOIVbm'.includes(c)).join('');
        return asShell(kept ? [word[0] + kept] : null);
      }
      const here = !/\s/.test(prog) && (MG.shellBuiltins[base] || MG.shellTools[base]) && (/^(echo|printf|true|false|test|pwd)$/.test(base) || !(MG.shellLang && MG.shellLang.isShellWord && MG.shellLang.isShellWord(base))) && (viaEnv ? !prog.includes('/') : /^\/(usr\/(local\/)?)?bin\//.test(prog));
      if (!here) return absent(prog, viaEnv);
      const argv = [base, ...rest, path, ...ctx.args];
      return this.dispatch(base, Object.assign(ctx, { name: base, argv, args: argv.slice(1) }));
    }
    /** Where a program of the terminal is: /usr/bin/NAME – unless the page says otherwise
        (MG.shellHooks.programPath: a path, or null for "nowhere"; the conda environments of this practical). */
    programPath(name) {
      const hook = MG.shellHooks && MG.shellHooks.programPath;
      const p = hook ? hook(name, this) : undefined;
      return p === undefined ? `/usr/bin/${name}` : p;
    }
    /** Is a folder of the system's programs – /usr/bin or /bin – on PATH? (No PATH at all: bash looks there anyway.) */
    sysPath(env) {
      const p = env ? env.PATH : undefined;
      return typeof p !== 'string' || p.split(':').some((d) => /^\/(usr\/)?bin\/?$/.test(d));
    }
    /** the executable file NAME in one of the folders of PATH that are folders of the page → its path, or null */
    onPath(name, env, plain, anyMode) {
      if (!env || typeof env.PATH !== 'string') return null;
      const path = env.PATH;
      const home = env && typeof env.HOME === 'string' ? env.HOME : this.fs.home;
      for (let dir of path.split(':')) {
        // (an empty folder in PATH – "PATH=$PATH:" with nothing behind the colon, "::" – is the folder one is in)
        if (dir === '') dir = '.';
        // (bash itself takes a ~ at the start of a folder of PATH for the home folder – PATH="~/bin:$PATH" works
        // for the commands of the shell. The programs that start other programs – env, xargs, which, timeout –
        // take the folder as it is written, and find nothing there: plain.)
        if (!plain && (dir === '~' || dir.startsWith('~/'))) dir = home + dir.slice(1);
        if (/^\/(usr|bin|sbin|opt)\b/.test(dir)) continue;
        const p = this.fs.resolve(dir + '/' + name), e = this.fs.entries.get(p);
        // (anyMode: also a file that may not be run – for the message "Permission denied")
        if (e && e.kind !== 'dir' && (e.mode === 'x' || anyMode)) return p;
      }
      return null;
    }
    /** COMMAND in the place of the word that was typed in front of it (command, env, nice, timeout): it has that
        command's input and output – its redirection, its place in the pipe – and its exit status */
    runAs(ctx, argv) {
      ctx.argv = argv;
      ctx.name = argv[0];
      ctx.args = argv.slice(1);
      return this.dispatch(argv[0], ctx);
    }
  }
  function joinBytes(a, b) {
    const both = new Uint8Array(a.length + b.length);
    both.set(a);
    both.set(b, a.length);
    return both;
  }

  /* ------------------------------------------------------------------
     Commands written in JavaScript (the ones that work on the page's
     folders rather than on the bytes of files)
     ------------------------------------------------------------------ */
  const B = {};

  B.pwd = (ctx) => {
    // pwd [-LP] (there are no links here: both give the same)
    const bad = ctx.args.find((a) => /^-./.test(a) && !/^-[LP]+$/.test(a));
    if (bad) throw userErr(`bash: pwd: ${bad.startsWith('--') ? '--' : bad.slice(0, 2)}: invalid option\npwd: usage: pwd [-LP]`, 2);
    return ctx.out(ctx.fs.cwd + '\n');
  };
  B.cd = (ctx) => {
    // options: -L -P -e -@ are accepted (there are no links here), any other is refused as bash does; "--" ends them
    const args = [];
    let options = true;
    for (const a of ctx.args) {
      if (options && a === '--') options = false;
      else if (options && /^-[LPe@]+$/.test(a)) continue;
      else if (options && /^-./.test(a)) throw userErr(`bash: cd: ${a.slice(0, 2)}: invalid option\ncd: usage: cd [-L|[-P [-e]] [-@]] [dir]`, 2);
      else {
        options = false;
        args.push(a);
      }
    }
    if (args.length > 1) throw userErr('bash: cd: too many arguments');
    if (args.length && args[0] === '') return 0; // cd "": bash stays where it is
    // (cd without a folder goes to $HOME, wherever that points)
    if (!args.length && ctx.env && ctx.env.HOME === undefined) throw userErr('bash: cd: HOME not set');
    const target = args.length ? args[0] : ctx.env && typeof ctx.env.HOME === 'string' && ctx.env.HOME !== '' ? ctx.env.HOME : ctx.fs.home;
    // cd - goes to the folder before the last cd, and prints it
    if (target === '-' && !ctx.shell.oldpwd) throw userErr('bash: cd: OLDPWD not set');
    const abs = ctx.fs.resolve(target === '-' ? ctx.shell.oldpwd : target);
    const e = ctx.fs.entries.get(abs);
    // (in a folder that was removed – a script that cleans up after itself –  cd .  and  cd ..  do not fail, as in
    // bash: the shell goes up a level, also when that folder is gone too)
    const adrift = !e && !ctx.fs.isDir(ctx.fs.cwd) && /^\.\.?(\/\.\.?)*\/*$/.test(target);
    if (!e && !adrift) throw userErr(`bash: cd: ${printable(target)}: ${(ctx.fs.pathError && ctx.fs.pathError(target)) || 'No such file or directory'}`);
    if (e && e.kind !== 'dir') throw userErr(`bash: cd: ${printable(target)}: Not a directory`);
    ctx.shell.oldpwd = ctx.fs.cwd;
    ctx.fs.cwd = abs;
    if (target === '-') ctx.out(abs + '\n');
    return 0;
  };
  /* pushd DIR, popd, dirs: a stack of folders (scripts use it to go somewhere and come back) */
  // (the stack belongs to the shell's state: in a subshell or a pipeline it is a copy, as in bash)
  const dirState = (ctx) => (ctx.opts && ctx.opts.st) || ctx.shell._top();
  const dirStack = (ctx) => {
    const st = dirState(ctx);
    return (st.dirs = st.dirs || []);
  };
  const goTo = (ctx, dir, who) => {
    try {
      B.cd(Object.assign({}, ctx, { args: [dir], out: () => {} }));
    } catch (e) {
      if (e && e.userMessage) e.userMessage = e.message = e.userMessage.replace(/^bash: cd:/, `bash: ${who}:`);
      throw e;
    }
  };
  const showDirs = (ctx) => ctx.out([ctx.fs.cwd].concat(dirStack(ctx)).map((d) => ctx.fs.pretty(d)).join(' ') + '\n');
  /* +N: the Nth folder of the list that dirs shows, counted from the left (0 is where you are); -N: from the right */
  const stackIndex = (ctx, a, who) => {
    const n = dirStack(ctx).length + 1, k = parseInt(a.slice(1), 10);
    if (k >= n) throw userErr(`bash: ${who}: ${a}: directory stack index out of range`);
    return a[0] === '+' ? k : n - 1 - k;
  };
  B.pushd = (ctx) => {
    const noCd = ctx.args.includes('-n');
    const args = ctx.args.filter((a) => a !== '-n' && a !== '--');
    if (args.length > 1) throw userErr('bash: pushd: too many arguments');
    const stack = dirStack(ctx), here = ctx.fs.cwd;
    if (!args.length) {
      // pushd alone: swap the two on top
      if (!stack.length) throw userErr('bash: pushd: no other directory');
      if (noCd) return 0;
      goTo(ctx, stack[0], 'pushd');
      stack[0] = here;
    } else if (/^[-+]\d+$/.test(args[0])) {
      // pushd +N: turn the list round until its Nth folder is on top – and go there
      if (!stack.length) throw userErr('bash: pushd: directory stack empty');
      const k = stackIndex(ctx, args[0], 'pushd');
      const all = [here].concat(stack), turned = all.slice(k).concat(all.slice(0, k));
      if (!noCd) goTo(ctx, turned[0], 'pushd');
      stack.splice(0, stack.length, ...(noCd ? turned.filter((d, i) => i !== turned.indexOf(here)) : turned.slice(1)));
    } else if (noCd) {
      // pushd -n DIR: the folder is put on the list (second, behind where you are); you stay
      stack.unshift(args[0]);
    } else {
      goTo(ctx, args[0], 'pushd');
      stack.unshift(here);
    }
    showDirs(ctx);
    return 0;
  };
  B.popd = (ctx) => {
    const noCd = ctx.args.includes('-n');
    const args = ctx.args.filter((a) => a !== '-n' && a !== '--');
    const stack = dirStack(ctx);
    if (!stack.length) throw userErr('bash: popd: directory stack empty');
    if (args.length && !/^[-+]\d+$/.test(args[0])) throw userErr(`bash: popd: ${args[0]}: invalid argument\npopd: usage: popd [-n] [+N | -N]`);
    const k = args.length ? stackIndex(ctx, args[0], 'popd') : 0;
    if (k === 0 && !noCd) {
      goTo(ctx, stack[0], 'popd');
      stack.shift();
    } else stack.splice(k === 0 ? 0 : k - 1, 1); // (popd -n: the folder below the top one is taken off)
    showDirs(ctx);
    return 0;
  };
  B.dirs = (ctx) => {
    const flags = ctx.args.filter((a) => /^-[clpv]+$/.test(a)).join('');
    const pick = ctx.args.find((a) => /^[-+]\d+$/.test(a));
    const bad = ctx.args.find((a) => !/^-[clpv]+$/.test(a) && !/^[-+]\d+$/.test(a));
    if (bad) throw userErr(/^-/.test(bad) ? `bash: dirs: ${bad.startsWith('--') ? '--' : '-' + (/[^clpv-]/.exec(bad) || ['?'])[0]}: invalid option\ndirs: usage: dirs [-clpv] [+N] [-N]` : `bash: dirs: ${bad}: invalid number\ndirs: usage: dirs [-clpv] [+N] [-N]`, /^-/.test(bad) ? 2 : 1);
    const name = (d) => (flags.includes('l') ? d : ctx.fs.pretty(d));
    const all = [ctx.fs.cwd].concat(dirStack(ctx));
    if (flags.includes('c')) dirState(ctx).dirs = [];
    else if (pick) ctx.out(name(all[stackIndex(ctx, pick, 'dirs')]) + '\n');
    else if (flags.includes('p') || flags.includes('v')) all.forEach((d, i) => ctx.out((flags.includes('v') ? `${String(i).padStart(2)}  ` : '') + name(d) + '\n'));
    else ctx.out(all.map(name).join(' ') + '\n');
    return 0;
  };
  /* tput: there is no terminal to ask – a script that colours its messages gets nothing to print, and goes on */
  B.tput = (ctx) => {
    const what = ctx.args.filter((a) => !a.startsWith('-'))[0];
    if (what === 'cols') ctx.out('80\n');
    else if (what === 'lines') ctx.out('24\n');
    else if (what === 'colors') ctx.out('8\n');
    return 0;
  };
  // (clear > /dev/null, and clear in a script whose output goes to a file: nothing is cleared)
  B.clear = (ctx) => !(MG.app && MG.app.term && MG.app.term.agentCmd) && !ctx.takesBytes && !ctx.io.piped && !ctx.redirectTarget && ctx.io.clear && ctx.io.clear();
  B.whoami = (ctx) => {
    const a = ctx.args[0];
    if (a != null) throw /^-./.test(a) ? refuseOption('whoami', a) : userErr(`whoami: extra operand \u2018${a}\u2019\nTry 'whoami --help' for more information.`);
    return ctx.out('student\n');
  };
  /* id [-u|-g|-G] [-n] [-r] [USER]: who the student is here – one user, one group */
  B.id = (ctx) => {
    const LONG = { '--user': 'u', '--group': 'g', '--groups': 'G', '--name': 'n', '--real': 'r', '--zero': 'z' };
    let flags = '';
    for (const a of ctx.args) {
      if (LONG[a]) flags += LONG[a];
      else if (/^--/.test(a)) throw refuseOption('id', a);
      else if (/^-./.test(a)) {
        const bad = /[^ugGnrz]/.exec(a.slice(1));
        if (bad) throw refuseOption('id', '-' + bad[0]);
        flags += a.slice(1);
      } else if (a !== 'student' && a !== '1000') throw userErr(`id: \u2018${a}\u2019: no such user`);
    }
    const which = flags.replace(/[nrz]/g, '');
    if (which.length > 1 && new Set(which).size > 1) throw userErr('id: cannot print "only" of more than one choice');
    if (!which) {
      if (/[nrz]/.test(flags)) throw userErr(flags.includes('z') && !/[nr]/.test(flags) ? 'id: option --zero not permitted in default format' : 'id: cannot print only names or real IDs in default format');
      return ctx.out('uid=1000(student) gid=1000(student) groups=1000(student)\n');
    }
    return ctx.out((flags.includes('n') ? 'student' : '1000') + (flags.includes('z') ? '\0' : '\n'));
  };
  /* hostname [-s|-f|-d|-i|-I]: the name in the prompt */
  B.hostname = (ctx) => {
    const host = ctx.env.HOSTNAME || 'biolab';
    const LONG = { '--short': 's', '--fqdn': 'f', '--long': 'f', '--domain': 'd', '--ip-address': 'i', '--all-ip-addresses': 'I', '--alias': 'a' };
    let flag = '';
    for (const a of ctx.args) {
      if (LONG[a]) flag = LONG[a];
      else if (/^--/.test(a)) throw userErr(`hostname: unrecognized option '${a}'\nUsage: hostname [-s|-f|-d|-i|-I]`, 255);
      else if (/^-./.test(a)) {
        const bad = /[^sfdiIa]/.exec(a.slice(1));
        if (bad) throw userErr(`hostname: invalid option -- '${bad[0]}'\nUsage: hostname [-s|-f|-d|-i|-I]`, 255);
        flag = a[a.length - 1];
      } else throw userErr('hostname: you must be root to change the host name');
    }
    return ctx.out((flag === 'i' || flag === 'I' ? '127.0.0.1' : flag === 'd' || flag === 'a' ? '' : host) + '\n');
  };
  /* nproc [--all] [--ignore=N]: in a browser tab every program runs on one thread */
  B.nproc = (ctx) => {
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (a === '--all' || /^--ignore=\d+$/.test(a)) continue;
      if (a === '--ignore' && /^\d+$/.test(ctx.args[i + 1] || '')) i++;
      else if (/^--ignore/.test(a)) throw userErr(`nproc: invalid number: \u2018${a === '--ignore' ? ctx.args[i + 1] || '' : a.slice(9)}\u2019`);
      else if (/^-./.test(a)) throw refuseOption('nproc', a);
      else throw userErr(`nproc: extra operand \u2018${a}\u2019\nTry 'nproc --help' for more information.`);
    }
    return ctx.out('1\n');
  };
  /* uname [-asnrvmpio]: what this "computer" is – a terminal in a web page */
  B.uname = (ctx) => {
    const host = ctx.env.HOSTNAME || 'biolab';
    const LONG = { '--all': 'a', '--kernel-name': 's', '--nodename': 'n', '--kernel-release': 'r', '--kernel-version': 'v', '--machine': 'm', '--processor': 'p', '--hardware-platform': 'i', '--operating-system': 'o' };
    const want = new Set();
    for (const a of ctx.args) {
      if (LONG[a]) want.add(LONG[a]);
      else if (/^--/.test(a)) throw userErr(`uname: unrecognized option '${a}'\nTry 'uname --help' for more information.`, 1);
      else if (/^-./.test(a)) {
        for (const c of a.slice(1)) {
          if (!'asnrvmpio'.includes(c)) throw userErr(`uname: invalid option -- '${c}'\nTry 'uname --help' for more information.`, 1);
          want.add(c);
        }
      } else throw userErr(`uname: extra operand \u2018${a}\u2019\nTry 'uname --help' for more information.`, 1);
    }
    if (want.has('a')) return ctx.out(`Linux ${host} 6.1.0-wasm #1 WebAssembly wasm32 GNU/Linux (a terminal in a web page)\n`);
    if (!want.size) want.add('s');
    const part = { s: 'Linux', n: host, r: '6.1.0-wasm', v: '#1 WebAssembly', m: 'wasm32', p: 'unknown', i: 'unknown', o: 'GNU/Linux' };
    return ctx.out('snrvmpio'.split('').filter((c) => want.has(c)).map((c) => part[c]).join(' ') + '\n');
  };
  /* history [N]: the commands typed so far (the last N) */
  B.history = (ctx) => {
    const a = ctx.args[0];
    if (a != null && /^-/.test(a)) throw userErr(`bash: history: ${a.startsWith('--') ? '--' : a.slice(0, 2)}: invalid option\nhistory: usage: history [n]`, 2);
    if (a != null && !/^\d+$/.test(a)) throw userErr(`bash: history: ${a}: numeric argument required`, 1);
    if (ctx.args.length > 1) throw userErr('bash: history: too many arguments', 1);
    const all = ctx.shell.history.map((h, i) => String(i + 1).padStart(5) + '  ' + h.replace(/\n/g, '\n       '));
    const shown = a != null ? all.slice(Math.max(0, all.length - parseInt(a, 10))) : all;
    return ctx.out(shown.length ? shown.join('\n') + '\n' : '');
  };
  B.true = () => 0;
  B[':'] = () => 0;
  B.false = () => 1;
  B.sudo = (ctx) => {
    ctx.err('student is not in the sudoers file. (You do not need sudo here: everything in your home folder is yours.)\n');
    return 1;
  };
  /* env [-i] [-u NAME] [NAME=VALUE …] [COMMAND [ARG …]]: without a command the environment is printed; with one, the
     command runs (env LC_ALL=C sort …, /usr/bin/env bash script.sh). The variables are set for that command; the
     programs of this terminal take no environment, the shell's own commands see them. */
  B.env = async (ctx) => {
    const args = ctx.args.slice(), set = {}, drop = [];
    let empty = false; // env -i: an empty environment
    let chdir = null, nul = false;
    const refuse = (text) => userErr(`env: ${text}\nTry 'env --help' for more information.`, 125);
    while (args.length) {
      const a = args[0];
      const m = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(a);
      if (a === '--') {
        args.shift();
        break;
      }
      if (a === '-u' || a === '--unset') {
        if (args.length < 2) throw refuse(a === '-u' ? "option requires an argument -- 'u'" : "option '--unset' requires an argument");
        drop.push(args[1]);
        args.splice(0, 2);
      } else if (/^--unset=/.test(a) || /^-u./.test(a)) {
        drop.push(a.replace(/^(--unset=|-u)/, ''));
        args.shift();
      } else if (a === '-C' || a === '--chdir') {
        if (args.length < 2) throw refuse(a === '-C' ? "option requires an argument -- 'C'" : "option '--chdir' requires an argument");
        chdir = args[1];
        args.splice(0, 2);
      } else if (/^--chdir=/.test(a) || /^-C./.test(a)) {
        chdir = a.replace(/^(--chdir=|-C)/, '');
        args.shift();
      } else if (a === '-i' || a === '-' || a === '--ignore-environment') {
        empty = true;
        args.shift();
      } else if (a === '-0' || a === '--null') {
        nul = true;
        args.shift();
      } else if (a === '-v' || a === '--debug') args.shift();
      else if (a === '-S' || /^-S./.test(a) || /^--split-string/.test(a)) throw userErr('env: -S (--split-string) is not available in this terminal: give the command and its arguments as words of their own', 125);
      else if (/^--/.test(a)) throw refuse(`unrecognized option '${a}'`);
      else if (/^-./.test(a)) throw refuse(`invalid option -- '${a[1]}'`);
      else if (m) {
        set[m[1]] = m[2];
        args.shift();
      } else break;
    }
    if (chdir != null && !args.length) throw refuse('must specify command with --chdir (-C)');
    if (nul && args.length) throw refuse('cannot specify --null (-0) with command');
    if (chdir != null && !ctx.fs.isDir(chdir)) throw userErr(`env: cannot change directory to \u2018${chdir}\u2019: ${ctx.fs.exists(chdir) ? 'Not a directory' : 'No such file or directory'}`, 125);
    const st = (ctx.opts && ctx.opts.st) || ctx.shell._top();
    // env: the exported variables (a variable of the shell that was not exported is not in the environment)
    const exported = empty ? new Set() : new Set(st.exported || Object.keys(ctx.env));
    drop.forEach((k) => exported.delete(k));
    const env = Object.assign({}, set);
    for (const k of exported) if (typeof ctx.env[k] === 'string' && !(k in set)) env[k] = ctx.env[k];
    // (PWD belongs to the environment too)
    if (exported.has('PWD') && !('PWD' in env)) env.PWD = ctx.fs.cwd;
    if (exported.has('OLDPWD') && !('OLDPWD' in env) && ctx.shell.oldpwd) env.OLDPWD = ctx.shell.oldpwd;
    // (bash gives every program it starts the variable _: the path of that program)
    const end = nul ? '\0' : '\n';
    if (!args.length) return ctx.out(Object.entries(env).filter(([k]) => k !== '_').map(([k, v]) => `${k}=${v}${end}`).join('') + (empty || st.envEmptied ? '' : `_=/usr/bin/${ctx.name === 'printenv' ? 'printenv' : 'env'}${end}`));
    // env is a program: it runs programs, not the functions of the shell
    if (!MG.shellBuiltins[args[0]] && !MG.shellTools[args[0]] && !args[0].includes('/') && !ctx.shell.onPath(args[0], ctx.env, true)) {
      ctx.err(`env: \u2018${args[0]}\u2019: No such file or directory\n`);
      return 127;
    }
    // (as with NAME=value COMMAND: the variables hold, exported, while the command runs)
    const before = Object.keys(set).map((k) => [k, st.vars[k]]), was = st.exported, wasEmptied = st.envEmptied;
    Object.assign(st.vars, set);
    st.exported = new Set([...exported, ...Object.keys(set)]);
    if (empty) st.envEmptied = true; // (env -i COMMAND: the command does not even get the _ that bash would give it)
    // (env -C DIR COMMAND: the command runs in DIR; the shell stays where it is)
    const cwd = ctx.fs.cwd;
    if (chdir != null) ctx.fs.cwd = ctx.fs.resolve(chdir);
    try {
      // the command stands where env stood: it has its input, its redirection and its place in the pipe
      return await ctx.shell.runAs(ctx, args);
    } finally {
      if (chdir != null && ctx.fs.isDir(cwd)) ctx.fs.cwd = cwd;
      before.forEach(([k, v]) => {
        if (v === undefined) delete st.vars[k];
        else st.vars[k] = v;
      });
      st.exported = was;
      st.envEmptied = wasEmptied;
    }
  };
  B.printenv = (ctx) => {
    // printenv [-0] [NAME …]
    let nul = false;
    const names = [];
    ctx.args.forEach((a, i) => {
      if (a === '-0' || a === '--null') nul = true;
      else if (/^-./.test(a) && a !== '--' && !ctx.args.slice(0, i).includes('--')) throw refuseOption('printenv', a, 2);
      else if (a !== '--' || ctx.args.slice(0, i).includes('--')) names.push(a);
    });
    if (!names.length) return B.env(Object.assign({}, ctx, { args: nul ? ['-0'] : [] }));
    const st = (ctx.opts && ctx.opts.st) || ctx.shell._top();
    const end = nul ? '\0' : '\n';
    let code = 0;
    names.forEach((k) => {
      if (k === '_' && !st.envEmptied) ctx.out('/usr/bin/printenv' + end);
      else if (typeof ctx.env[k] === 'string' && (!st.exported || st.exported.has(k))) ctx.out(ctx.env[k] + end);
      else if (k === 'PWD' && (!st.exported || st.exported.has('PWD'))) ctx.out(ctx.fs.cwd + end);
      else if (k === 'OLDPWD' && ctx.shell.oldpwd && (!st.exported || st.exported.has('OLDPWD'))) ctx.out(ctx.shell.oldpwd + end);
      else code = 1;
    });
    return code;
  };

  /* ------------------------------------------------------------------
     ls – the options and the layout of GNU ls (coreutils): the columns of -l as wide as the widest entry, "total" in
     blocks of 1 K, -h rounded up (4.0K, 612K), -C and -x in columns with tabs, -m with commas, -s, -i, -I, --hide,
     -B, -w, -Q, -b, -q, the sort orders. The names are in the order of their characters (as with LC_ALL=C): capital
     letters before small ones. At this terminal ls prints one name per line, as it does into a pipe or a file.
     ------------------------------------------------------------------ */
  /** sizes as ls -h and du -h show them: powers of 1024 (or, --si, of 1000), rounded up, one decimal below 10 */
  /** --block-size=SIZE of ls and du: K, M, 1K, 512, KB … → { size: bytes, suffix: what stands behind each number }
      (a suffix only when SIZE is a unit by itself: K gives 12K, 1K gives 12) – or what GNU says of a size that is none */
  function blockSize(v, name, opt) {
    const m = /^(\d*)(?:([kKMGTPEZY])(i?B)?)?$/.exec(v || '');
    const n = m && m[1] !== '' ? Number(m[1]) : 1;
    if (!m || (m[1] === '' && !m[2]) || !(n > 0)) throw userErr(`${name}: invalid ${/^\d+\D/.test(v || '') ? 'suffix in ' : ''}${opt} argument '${v}'`, name === 'ls' ? 2 : 1);
    const power = m[2] ? 'KMGTPEZY'.indexOf(m[2].toUpperCase()) + 1 : 0, base = m[3] === 'B' ? 1000 : 1024;
    return { size: n * base ** power, suffix: m[1] === '' ? (m[3] === 'B' ? (m[2].toUpperCase() === 'K' ? 'k' : m[2]) + 'B' : m[2].toUpperCase() + (m[3] || '')) : '' };
  }
  function humanCeil(n, si) {
    const base = si ? 1000 : 1024, units = si ? 'kMGTPE' : 'KMGTPE';
    if (n < base) return String(n);
    let k = 0, div = 1;
    while (n / div >= base && k < units.length) {
      div *= base;
      k++;
    }
    let amt = Math.floor(n / div);
    const rem = n - amt * div;
    let tenths = Math.floor((rem * 10) / div);
    const more = rem * 10 - tenths * div > 0;
    if (amt < 10) {
      if (more) {
        tenths++;
        if (tenths === 10) {
          amt++;
          tenths = 0;
        }
      }
      return amt < 10 ? `${amt}.${tenths}${units[k - 1]}` : amt + units[k - 1];
    }
    if (tenths > 0 || more) {
      amt++;
      if (amt === base && k < units.length) return '1.0' + units[k];
    }
    return amt + units[k - 1];
  }
  /* The special files of /dev that scripts name. The page has no devices: > /dev/null and < /dev/null are the
     shell's business; ls, stat, test and cp know the names. */
  const T0 = Date.now();
  const DEVICES = { null: [1, 3], random: [1, 8], tty: [5, 0], urandom: [1, 9], zero: [1, 5] };
  const DEV_LINKS = { stderr: '/proc/self/fd/2', stdin: '/proc/self/fd/0', stdout: '/proc/self/fd/1' };
  function deviceEntry(fs, p) {
    const abs = fs.resolve(p);
    if (abs === '/dev') return { kind: 'dir', protected: true, mtime: T0, devdir: true };
    const m = /^\/dev\/([a-z]+)$/.exec(abs);
    if (!m) return null;
    if (DEVICES[m[1]]) return { kind: 'dev', protected: true, mtime: T0, major: DEVICES[m[1]][0], minor: DEVICES[m[1]][1] };
    if (DEV_LINKS[m[1]]) return { kind: 'link', protected: true, mtime: T0, to: DEV_LINKS[m[1]] };
    return null;
  }
  const deviceNames = () => Object.keys(DEVICES).concat(Object.keys(DEV_LINKS)).sort();
  /** a number for a file that stays the same while the file has its name (ls -i, stat -c %i) */
  function inodeOf(abs) {
    let h = 2166136261;
    for (let i = 0; i < abs.length; i++) h = Math.imul(h ^ abs.charCodeAt(i), 16777619) >>> 0;
    return 1000000 + (h % 9000000);
  }
  /** the width of a text in the columns of a terminal (wide characters take two) */
  function columnsOf(s) {
    let n = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c >= 0x300 && c <= 0x36f) continue;
      n += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd) ? 2 : 1;
    }
    return n;
  }
  const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  /** names with numbers in them in the order of the numbers (ls -v, sort -V): x2 before x10 */
  function byVersion(a, b) {
    const pa = a.match(/\d+|\D+/g) || [], pb = b.match(/\d+|\D+/g) || [];
    for (let i = 0; i < pa.length && i < pb.length; i++) {
      const x = pa[i], y = pb[i];
      if (/^\d/.test(x) && /^\d/.test(y)) {
        const nx = x.replace(/^0+(?=\d)/, ''), ny = y.replace(/^0+(?=\d)/, '');
        if (nx.length !== ny.length) return nx.length - ny.length;
        if (nx !== ny) return nx < ny ? -1 : 1;
      } else if (x !== y) return x < y ? -1 : 1;
    }
    return pa.length - pb.length || byName(a, b);
  }
  B.ls = (ctx) => {
    const o = { format: null, sort: 'name', all: 0, width: null, tab: 8, quote: 'literal', ignore: [], hide: [], timeStyle: '', ind: '', time: 'm', block: null };
    const rest = [], args = ctx.args;
    const badArg = (v, name, valid) => userErr(`ls: invalid argument ‘${v}’ for ‘--${name}’\nValid arguments are:\n${valid.map((x) => `  - ‘${x}’`).join('\n')}\nTry 'ls --help' for more information.`, 2);
    let more = true;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!more || a === '-' || !a.startsWith('-')) {
        rest.push(a);
        continue;
      }
      if (a === '--') {
        more = false;
        continue;
      }
      if (a.startsWith('--')) {
        const eq = a.indexOf('='), name = eq < 0 ? a.slice(2) : a.slice(2, eq);
        let val = eq < 0 ? null : a.slice(eq + 1);
        const need = () => {
          if (val == null) {
            if (i + 1 >= args.length) throw userErr(`ls: option '--${name}' requires an argument\nTry 'ls --help' for more information.`, 2);
            val = args[++i];
          }
          return val;
        };
        const pick = (map) => {
          const v = need();
          if (!(v in map)) throw badArg(v, name, Object.keys(map));
          return map[v];
        };
        switch (name) {
          case 'all': o.all = 2; break;
          case 'almost-all': o.all = 1; break;
          case 'human-readable': o.h = true; o.si = false; o.block = null; break;
          case 'si': o.h = o.si = true; o.block = null; break;
          case 'block-size': o.block = blockSize(need(), 'ls', '--block-size'); o.h = o.si = false; break;
          case 'recursive': o.R = true; break;
          case 'reverse': o.r = true; break;
          case 'directory': o.d = true; break;
          case 'classify': o.ind = 'F'; break;
          case 'file-type': o.ind = 'f'; break;
          case 'indicator-style': o.ind = pick({ none: '', slash: 'p', 'file-type': 'f', classify: 'F' }); break;
          case 'group-directories-first': o.dirsFirst = true; break;
          case 'no-group': o.G = true; break;
          case 'numeric-uid-gid': o.n = true; o.format = 'l'; break;
          case 'size': o.s = true; break;
          case 'inode': o.i = true; break;
          case 'ignore': o.ignore.push(need()); break;
          case 'hide': o.hide.push(need()); break;
          case 'ignore-backups': o.B = true; break;
          case 'width': o.width = need(); break;
          case 'tabsize': o.tab = need(); break;
          case 'quote-name': o.quote = 'c'; break;
          case 'escape': o.quote = 'escape'; break;
          case 'literal': o.quote = 'literal'; break;
          case 'hide-control-chars': o.q = true; break;
          case 'show-control-chars': o.q = false; break;
          case 'quoting-style': o.quote = pick({ literal: 'literal', shell: 'shell', 'shell-always': 'shell-always', 'shell-escape': 'shell-escape', 'shell-escape-always': 'shell-escape-always', c: 'c', escape: 'escape', locale: 'c', clocale: 'c' }); break;
          case 'time-style': o.timeStyle = need(); break;
          case 'full-time': o.format = 'l'; o.fullTime = true; break;
          case 'format': o.format = pick({ long: 'l', verbose: 'l', commas: 'm', horizontal: 'x', across: 'x', vertical: 'C', 'single-column': '1' }); break;
          case 'sort': o.sort = pick({ none: 'none', size: 'size', time: 'time', version: 'version', extension: 'extension', name: 'name', width: 'width' }); o.sortGiven = true; break;
          // (the time of the last reading – atime – or of the last change; a file has no others here)
          case 'time': o.time = pick({ atime: 'a', access: 'a', use: 'a', ctime: 'm', status: 'm', mtime: 'm', modification: 'm', birth: 'm', creation: 'm' }); o.timeGiven = true; break;
          case 'author': o.author = true; break;
          case 'color':
          case 'colour':
          case 'hyperlink':
          case 'kibibytes':
          case 'dereference':
          case 'dereference-command-line':
          case 'context': break; // (colours and links: the names are printed plain)
          default: throw userErr(`ls: unrecognized option '${a}'\nTry 'ls --help' for more information.`, 2);
        }
        continue;
      }
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        const value = () => {
          if (j + 1 >= a.length && i + 1 >= args.length) throw userErr(`ls: option requires an argument -- '${c}'\nTry 'ls --help' for more information.`, 2);
          const v = j + 1 < a.length ? a.slice(j + 1) : args[++i];
          j = a.length;
          return v;
        };
        switch (c) {
          case 'a': o.all = 2; break;
          case 'A': o.all = 1; break;
          case 'b': o.quote = 'escape'; break;
          case 'B': o.B = true; break;
          case 'C': o.format = 'C'; break;
          case 'd': o.d = true; break;
          case 'f': o.all = 2; o.sort = 'none'; o.sortGiven = true; break;
          case 'F': o.ind = 'F'; break;
          case 'g': o.format = 'l'; o.noOwner = true; break;
          case 'G': o.G = true; break;
          case 'h': o.h = true; o.si = false; o.block = null; break;
          case 'i': o.i = true; break;
          case 'I': o.ignore.push(value()); break;
          case 'l': o.format = 'l'; break;
          case 'm': o.format = 'm'; break;
          case 'n': o.format = 'l'; o.n = true; break;
          case 'N': o.quote = 'literal'; break;
          case 'o': o.format = 'l'; o.G = true; break;
          case 'p': o.ind = 'p'; break;
          case 'q': o.q = true; break;
          case 'Q': o.quote = 'c'; break;
          case 'r': o.r = true; break;
          case 'R': o.R = true; break;
          case 's': o.s = true; break;
          case 'S': o.sort = 'size'; o.sortGiven = true; break;
          case 't': o.sort = 'time'; o.sortGiven = true; break;
          case 'T': o.tab = value(); break;
          case 'U': o.sort = 'none'; o.sortGiven = true; break;
          case 'v': o.sort = 'version'; o.sortGiven = true; break;
          case 'w': o.width = value(); break;
          case 'x': o.format = 'x'; break;
          case 'X': o.sort = 'extension'; o.sortGiven = true; break;
          case '1': if (o.format !== 'l') o.format = '1'; break;
          case 'u': o.time = 'a'; o.timeGiven = true; break;
          case 'c': o.time = 'm'; o.timeGiven = true; break;
          case 'k':
          case 'L':
          case 'H':
          case 'Z': break;
          default: throw userErr(`ls: invalid option -- '${c}'\nTry 'ls --help' for more information.`, 2);
        }
      }
    }
    const num = (v, what, dflt) => {
      if (v == null) return dflt;
      if (!/^\d+$/.test(v)) throw userErr(`ls: invalid ${what}: ‘${v}’`, 2);
      return parseInt(v, 10);
    };
    const width = num(o.width, 'line width', /^\d+$/.test(ctx.env.COLUMNS || '') ? parseInt(ctx.env.COLUMNS, 10) : 80), tab = num(o.tab, 'tab size', 8);
    const long = o.format === 'l', zone = zoneOf(ctx), fs = ctx.fs;
    // (-u or -c without -l and without an order of its own: newest first by that time)
    if (o.timeGiven && !long && !o.sortGiven) o.sort = 'time';
    if (long && !o.fullTime && o.timeStyle && o.timeStyle[0] !== '+' && !/^(posix-)?(full-iso|long-iso|iso|locale)$/.test(o.timeStyle)) throw userErr(`ls: invalid argument ‘${o.timeStyle}’ for ‘time style’
Valid arguments are:
  - [posix-]full-iso
  - [posix-]long-iso
  - [posix-]iso
  - [posix-]locale
  - +FORMAT (e.g., +%H:%M) for a 'date'-style format
Try 'ls --help' for more information.`, 2);
    o.timeStyle = o.timeStyle.replace(/^posix-/, '');
    if (!o.block && !o.h) {
      const env = ctx.env.LS_BLOCK_SIZE || ctx.env.BLOCK_SIZE;
      try {
        if (env) o.block = blockSize(env, 'ls', '--block-size');
      } catch (e) {
        /* (a size in the environment that is none: left out) */
      }
    }
    const stamp = (e) => (o.time === 'a' && e.atime != null ? e.atime : e.mtime || 0);
    const get = (p) => fs.get(p) || deviceEntry(fs, p);
    const isDir = (e) => e.kind === 'dir';
    const sizeOf = (e) => (e.kind === 'dev' ? 0 : e.kind === 'link' ? e.to.length : fs.size(e));
    // the space on the disk in blocks of 1 K, as ls counts it (a file takes whole blocks of 4 K, a folder 4 K)
    const blocksOf = (e) => (isDir(e) ? (e.devdir ? 0 : 4) : e.kind === 'dev' || e.kind === 'link' ? 0 : Math.ceil(fs.size(e) / 4096) * 4);
    const showBlocks = (n) => (o.h ? humanCeil(n * 1024, o.si) : o.block ? Math.ceil((n * 1024) / o.block.size) + o.block.suffix : String(n));
    // ---- how a name is written
    const C_ESC = { '\n': '\\n', '\t': '\\t', '\r': '\\r', '\x07': '\\a', '\b': '\\b', '\f': '\\f', '\v': '\\v', '\\': '\\\\' };
    /* eslint-disable no-control-regex */
    const hasCtrl = (s) => /[\x00-\x1f\x7f]/.test(s);
    const octal = (c) => C_ESC[c] || '\\' + c.charCodeAt(0).toString(8).padStart(3, '0');
    const quoted = (name) => {
      let s = name;
      switch (o.quote) {
        case 'c': s = '"' + s.replace(/[\\"]|[\x00-\x1f\x7f]/g, (c) => (c === '"' ? '\\"' : octal(c))) + '"'; break;
        case 'escape': s = s.replace(/[\\ ]|[\x00-\x1f\x7f]/g, (c) => (c === ' ' ? '\\ ' : octal(c))); break;
        case 'shell':
        case 'shell-always':
        case 'shell-escape':
        case 'shell-escape-always': {
          const always = /always/.test(o.quote), esc = /escape/.test(o.quote);
          if (esc && hasCtrl(s)) {
            s = "'" + s.replace(/'/g, "'\\''").replace(/[\x00-\x1f\x7f]/g, (c) => "'$'" + octal(c) + "''") + "'";
            s = s.replace(/^''|''$/g, '');
          } else if (always || s === '' || /[\s!"#$&'()*;<=>?[\\\]^`{|}~]/.test(s)) s = s.includes("'") && !/["$`\\!]/.test(s) ? '"' + s + '"' : "'" + s.replace(/'/g, "'\\''") + "'";
          break;
        }
        default: break;
      }
      return o.q ? s.replace(/[\x00-\x1f\x7f]/g, '?') : s;
    };
    /* eslint-enable no-control-regex */
    const mark = (name, e) => (!o.ind ? '' : isDir(e) ? (name.endsWith('/') ? '' : '/') : e.kind === 'link' ? (o.ind === 'p' ? '' : '@') : o.ind === 'F' && e.mode === 'x' ? '*' : '');
    // ---- the order
    const ext = (n) => (n.lastIndexOf('.') > 0 ? n.slice(n.lastIndexOf('.')) : '');
    const inOrder = (items) => {
      if (o.sort !== 'none') {
        items.sort((a, b) => byName(a.name, b.name));
        if (o.sort === 'version') items.sort((a, b) => byVersion(a.name, b.name));
        else if (o.sort === 'extension') items.sort((a, b) => byName(ext(a.name), ext(b.name)));
        else if (o.sort === 'time') items.sort((a, b) => stamp(b.e) - stamp(a.e));
        else if (o.sort === 'size') items.sort((a, b) => sizeOf(b.e) - sizeOf(a.e));
        else if (o.sort === 'width') items.sort((a, b) => columnsOf(a.name) - columnsOf(b.name));
        if (o.r) items.reverse();
      }
      if (o.dirsFirst) items.sort((a, b) => isDir(b.e) - isDir(a.e));
      return items;
    };
    // ---- one batch of entries (the files named on the command line, or what is in one folder) as lines
    const timeOf = (e) => {
      const t = stamp(e) || Date.now(), old = Math.abs(Date.now() - t) > 15778800000, style = o.timeStyle;
      return o.fullTime || style === 'full-iso' ? strftime('%Y-%m-%d %H:%M:%S.%N %z', t, zone) : style === 'long-iso' ? strftime('%Y-%m-%d %H:%M', t, zone) : style === 'iso' ? strftime(old ? '%Y-%m-%d ' : '%m-%d %H:%M', t, zone) : style[0] === '+' ? strftime(style.slice(1), t, zone) : strftime(old ? '%b %e  %Y' : '%b %e %H:%M', t, zone);
    };
    // (the row of ".." in ls -la: counting the folders in the folder above is no use of that folder – for a command of
    // the agent the page notes the paths it works with, see watched in terminal.js)
    const nlink = (item) => (isDir(item.e) && !item.e.devdir ? 2 + (fs.__real || fs).list(item.abs).filter((c) => c.entry.kind === 'dir').length : 1);
    const lines = (items) => {
      if (!items.length) return [];
      const pad = (rows, k, left) => {
        const w = Math.max(...rows.map((r) => r[k].length));
        rows.forEach((r) => (r[k] = left ? r[k].padEnd(w) : r[k].padStart(w)));
      };
      // what stands before each name: the inode (-i), the blocks (-s)
      const pre = items.map((it) => [o.i ? String(it.e.kind === 'dev' || it.e.kind === 'link' || it.e.devdir ? 1 + (inodeOf(it.abs) % 999) : inodeOf(it.abs)) : '', o.s ? showBlocks(blocksOf(it.e)) : '']);
      if (o.i) pad(pre, 0);
      if (o.s) pad(pre, 1);
      const frills = pre.map((p) => (o.i ? p[0] + ' ' : '') + (o.s ? p[1] + ' ' : ''));
      const names = items.map((it) => quoted(it.name) + mark(it.name, it.e));
      if (long) {
        const rows = items.map((it) => {
          const e = it.e, root = !!e.protected;
          const perm = e.kind === 'dev' ? 'crw-rw-rw-' : e.kind === 'link' ? 'lrwxrwxrwx' : e.devdir ? 'drwxr-xr-x' : permText(e);
          const owner = o.n ? (root ? '0' : '1000') : root ? 'root' : 'student';
          const size = e.kind === 'dev' ? `${e.major}, ${e.minor}` : o.h ? humanCeil(sizeOf(e), o.si) : o.block ? Math.ceil(sizeOf(e) / o.block.size) + o.block.suffix : String(sizeOf(e));
          return [perm, String(nlink(it)), owner, owner, size, timeOf(e)];
        });
        pad(rows, 1);
        pad(rows, 2, !o.n);
        pad(rows, 3, !o.n);
        pad(rows, 4);
        // (--author: the one who wrote the file – here always its owner – in a column of its own)
        return rows.map((r, k) => frills[k] + [r[0], r[1]].concat(o.noOwner ? [] : [r[2]], o.G ? [] : [r[3]], o.author ? [r[2]] : [], [r[4], r[5]]).join(' ') + ' ' + names[k] + (items[k].e.kind === 'link' ? ' -> ' + items[k].e.to : ''));
      }
      const cells = names.map((n, k) => frills[k] + n);
      if (o.format === 'm') {
        // the names with commas between them, in lines no wider than the width
        let out = '', pos = 0;
        cells.forEach((c, k) => {
          const len = columnsOf(c);
          if (k) {
            if (!width || pos + len + 2 < width) {
              out += ', ';
              pos += 2;
            } else {
              out += ',\n';
              pos = 0;
            }
          }
          out += c;
          pos += len;
        });
        return out.split('\n');
      }
      if (o.format !== 'C' && o.format !== 'x') return cells;
      // in columns: as many as fit into the width, each as wide as its widest name plus two; down the columns (-C)
      // or across (-x). Between the columns there are tabs where a tab reaches far enough, as GNU ls writes them.
      if (!width) return [cells.join('  ')]; // -w 0: no limit – everything on one line
      const n = cells.length, lens = cells.map(columnsOf), byCols = o.format === 'C';
      const maxCols = Math.max(1, Math.min(n, Math.ceil(width / 3)));
      const info = [];
      for (let i = 0; i < maxCols; i++) info.push({ valid: true, len: (i + 1) * 3, col: new Array(i + 1).fill(3) });
      for (let f = 0; f < n; f++) {
        for (let i = 0; i < maxCols; i++) {
          const ci = info[i];
          if (!ci.valid) continue;
          const idx = byCols ? Math.floor(f / Math.floor((n + i) / (i + 1))) : f % (i + 1);
          const real = lens[f] + (idx === i ? 0 : 2);
          if (ci.col[idx] < real) {
            ci.len += real - ci.col[idx];
            ci.col[idx] = real;
            ci.valid = ci.len < width;
          }
        }
      }
      let cols = maxCols;
      while (cols > 1 && !info[cols - 1].valid) cols--;
      const widths = info[cols - 1].col, rowsN = Math.ceil(n / cols), out = [];
      const indent = (from, to) => {
        let s = '';
        while (from < to) {
          if (tab && Math.floor(to / tab) > Math.floor((from + 1) / tab)) {
            s += '\t';
            from += tab - (from % tab);
          } else {
            s += ' ';
            from++;
          }
        }
        return s;
      };
      for (let r = 0; r < rowsN; r++) {
        let row = '', pos = 0;
        for (let c = 0; c < cols; c++) {
          const f = byCols ? c * rowsN + r : r * cols + c;
          if (f >= n) break;
          row += cells[f];
          const nextF = byCols ? (c + 1) * rowsN + r : r * cols + c + 1;
          if (c + 1 < cols && nextF < n) row += indent(pos + lens[f], pos + widths[c]);
          pos += widths[c];
        }
        out.push(row);
      }
      return out;
    };
    // ---- what was asked for
    let code = 0;
    const files = [], dirs = [];
    // (ls in a folder that was removed – a script that has cleaned up after itself: Linux lists nothing there)
    const gone = !ctx.fs.isDir(ctx.fs.cwd);
    (rest.length ? rest : ['.']).forEach((t) => {
      if (gone && /^\.\/*$/.test(t)) return;
      const e = get(t);
      if (!e || (/\/$/.test(t) && !isDir(e))) {
        ctx.err(`ls: cannot access '${t}': ${e ? 'Not a directory' : 'No such file or directory'}\n`);
        code = 2;
      } else (isDir(e) && !o.d ? dirs : files).push({ name: t, e, abs: fs.resolve(t) });
    });
    inOrder(files);
    inOrder(dirs);
    const out = lines(files);
    const hidden = (name) => {
      if (o.all < 1 && name.startsWith('.')) return true;
      if (o.B && name.endsWith('~')) return true;
      if (o.ignore.some((p) => MG.globRe(p, '', true).test(name))) return true;
      return o.all < 1 && o.hide.some((p) => MG.globRe(p, '', true).test(name));
    };
    // (the name of a folder stands above its list – except for ls of one folder and nothing else)
    const header = o.R || !(files.length === 0 && rest.length <= 1 && dirs.length === 1);
    const listDir = (dir, abs, e) => {
      if (out.length) out.push('');
      if (header) out.push(quoted(dir) + ':');
      const kids = e.devdir ? deviceNames().map((n) => ({ name: n, e: deviceEntry(fs, '/dev/' + n), abs: '/dev/' + n })) : fs.list(abs).map((c) => ({ name: c.name, e: c.entry, abs: c.path }));
      const shown = kids.filter((c) => !hidden(c.name));
      // ls -a: the folder itself and the one above it, too
      if (o.all === 2) shown.unshift({ name: '.', e, abs }, { name: '..', e: fs.entries.get(MG.path.dirname(abs)) || { kind: 'dir' }, abs: MG.path.dirname(abs) });
      inOrder(shown);
      if (long || o.s) out.push('total ' + showBlocks(shown.reduce((s, c) => s + blocksOf(c.e), 0)));
      out.push(...lines(shown));
      // ls -R: then each folder in it
      if (o.R) shown.filter((c) => isDir(c.e) && c.name !== '.' && c.name !== '..').forEach((c) => listDir(dir.replace(/\/$/, '') + '/' + c.name, c.abs, c.e));
    };
    dirs.forEach((d) => listDir(d.name, d.abs, d.e));
    if (out.length) ctx.out(out.join('\n') + '\n');
    return code;
  };
  B.dir = B.ls;
  B.ll = (ctx) => B.ls(Object.assign({}, ctx, { args: ['-l'].concat(ctx.args) }));

  /** a mode as mkdir -m and chmod take it – 750, u=rwx,go=, g-w, +t – applied to the bits START → the new bits, or
      null: no mode. A clause that names nobody (+x) leaves out what the umask takes away. */
  function modeBits(mode, start, isDir, umask) {
    if (/^[0-7]{1,4}$/.test(mode)) return parseInt(mode, 8);
    if (mode === '') return null;
    const shift = { u: 6, g: 3, o: 0 }, mask = umask == null ? 0o022 : umask;
    let bits = start;
    for (const part of mode.split(',')) {
      const m = /^([ugoa]*)((?:[+\-=](?:[rwxXst]*|[ugo]))+)$/.exec(part);
      if (!m) return null;
      const who = m[1] === '' || m[1].includes('a') ? 'ugo' : m[1];
      if (m[1] === '') bits &= ~mask | 0o7000;
      for (const op of m[2].match(/[+\-=](?:[rwxXst]*|[ugo])/g)) {
        let set = 0;
        for (const w of who) {
          if (/^[ugo]$/.test(op.slice(1))) {
            set |= ((bits >> shift[op[1]]) & 7) << shift[w];
            continue;
          }
          for (const c of op.slice(1)) {
            const bit = c === 'X' ? (isDir || bits & 0o111 ? 1 : 0) : { r: 4, w: 2, x: 1 }[c];
            if (bit) set |= bit << shift[w];
            if (c === 's' && w !== 'o') set |= w === 'u' ? 0o4000 : 0o2000;
            if (c === 't') set |= 0o1000;
          }
        }
        if (m[1] === '') set &= ~mask | 0o7000;
        if (op[0] === '+') bits |= set;
        else if (op[0] === '-') bits &= ~set;
        else {
          for (const w of who) bits &= ~(7 << shift[w]);
          bits |= set;
        }
      }
    }
    return bits;
  }
  /** Who answers when rm -i, cp -i or mv -i asks: the lines of what is piped in (echo y | rm -i FILE). At the
      terminal nobody can answer here – the question is shown, the answer counts as "no", and a note says so. */
  function asker(ctx, name) {
    let lines = null, noted = false;
    const piped = ctx.stdin != null || !!(ctx.inherit && ctx.inherit.pos < ctx.inherit.text.length);
    const ask = async (question) => {
      ctx.err(`${name}: ${question} `);
      if (!piped) {
        ctx.err('\n');
        if (!noted) ctx.io.note(`${name} asked before going on. This terminal cannot take an answer, so it counted as "no". Without -i ${name} does not ask – or send the answer in:  echo y | ${name} -i …`);
        noted = true;
        return false;
      }
      if (lines == null) lines = (await inputOf(ctx, [], name)).split('\n');
      const a = lines.shift();
      return a !== undefined && /^[yY]/.test(a);
    };
    ask.piped = piped;
    return ask;
  }
  /** a date as GNU date reads it ("next month", "3 weeks ago", 01/15/2024, "Mon, 15 Jan 2024 10:30 +0000") → the
      time in milliseconds, or NaN. The date program itself does the reading. */
  async function gnuDate(ctx, text) {
    if (MG.wasm && MG.wasm.run) {
      try {
        const r = await MG.wasm.run(Object.assign({}, ctx, { stdin: '', inherit: null, name: 'date', args: [], mergeStderr: false }), 'date', ['-d', text, '+%s %N']);
        const m = /^(-?\d+) (\d{9})\s*$/.exec(r.stdout || '');
        return r.code === 0 && m ? +m[1] * 1000 + Math.floor(+m[2] / 1e6) : NaN;
      } catch (e) {
        /* the programs are not there: the page's own reader */
      }
    }
    return parseDate(text, zoneOf(ctx));
  }
  MG.time.gnu = gnuDate;
  /* mkdir [-p] [-v] [-m MODE] DIRECTORY…  (MODE as chmod takes it: 700, u=rwx,go=) */
  B.mkdir = (ctx) => {
    const { opts, rest } = getopts(ctx.args, 'pvm:Z', { parents: 'p', verbose: 'v', mode: 'm' });
    if (!rest.length) throw userErr('mkdir: missing operand');
    const umask = ctx.fs.umask != null ? ctx.fs.umask : 0o022;
    const mode = opts.m != null ? modeBits(opts.m, 0o777, true, umask) : null;
    if (opts.m != null && (mode == null || mode > 0o7777)) throw userErr(`mkdir: invalid mode ‘${opts.m}’`);
    let code = 0;
    const cannot = (d, why) => {
      ctx.err(`mkdir: cannot create directory ‘${d}’: ${why}\n`);
      code = 1;
    };
    // (a look at the folders above the one that is made is no use of them: for a command of the agent the page notes
    // the paths that the command works with – see watched in terminal.js – and /home is not one of mkdir -p /home/…/x)
    const look = ctx.fs.__real || ctx.fs;
    rest.forEach((d) => {
      if (d === '') return cannot(d, 'No such file or directory');
      if (ctx.fs.exists(d)) {
        if (!opts.p || !ctx.fs.isDir(d)) cannot(d, 'File exists');
        return;
      }
      // (a file where one of the folders above would be: with -p that folder is named, without it the whole path)
      const parts = d.replace(/\/+$/, '').split('/');
      for (let k = 1; k < parts.length; k++) {
        const up = parts.slice(0, k).join('/') || '/', ue = look.get(up);
        if (ue && ue.kind !== 'dir') return cannot(opts.p ? up : d, 'Not a directory');
      }
      if (!opts.p && !look.isDir(MG.path.dirname(look.resolve(d)))) return cannot(d, 'No such file or directory');
      // (mkdir -v names each folder it makes – with -p, the ones above it too)
      const made = [];
      for (let k = 1; k <= parts.length; k++) {
        const sub = parts.slice(0, k).join('/');
        if (sub && !look.exists(sub)) made.push(sub);
      }
      try {
        // (mkdir -p a/../b: every part of the path as it was written is made – a too)
        if (opts.p && /(^|\/)\.\.(\/|$)/.test(d)) for (let k = 1; k < parts.length; k++) {
          const sub = parts.slice(0, k).join('/');
          if (sub && !/(^|\/)\.\.?$/.test(sub) && !look.exists(sub)) ctx.fs.mkdirp(sub);
        }
        ctx.fs.mkdirp(d);
        // (mkdir -m 700: the permissions, as ls -l and stat show them – of the folder that was named, not of the
        // ones -p made on the way)
        if (mode != null) ctx.fs.chmod(d, { bits: mode });
        if (opts.v) made.forEach((x) => ctx.out(`mkdir: created directory '${x}'\n`));
      } catch (e) {
        cannot(d, 'Not a directory');
      }
    });
    return code;
  };
  /* touch [-c] [-a] [-m] [-d DATE] [-r FILE] [-t [[CC]YY]MMDDhhmm[.ss]] FILE…: make the file if it is not there (not
     with -c), and set its times – to now, or to the time given. -a: only the time of the last reading, -m: only
     the time of the last change (what ls -l shows). */
  B.touch = async (ctx) => {
    let create = true, when = null, which = '';
    const files = [];
    const noTime = (w) => userErr(`touch: invalid argument ‘${w}’ for ‘--time’\nValid arguments are:\n  - ‘atime’, ‘access’, ‘use’\n  - ‘mtime’, ‘modify’\nTry 'touch --help' for more information.`);
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      let v = null;
      if (a === '--') {
        files.push(...ctx.args.slice(i + 1));
        break;
      }
      if (a === '-c' || a === '--no-create') create = false;
      else if (a === '-d' || a === '--date' || a === '-r' || a === '--reference' || a === '-t') {
        v = ctx.args[++i];
        if (v === undefined) throw userErr(a.startsWith('--') ? `option '${a}' requires an argument` : `option requires an argument -- '${a[1]}'`);
      } else if (/^--(date|reference)=/.test(a)) v = a.slice(a.indexOf('=') + 1);
      else if (/^--time(=|$)/.test(a)) {
        const w = a.includes('=') ? a.slice(7) : ctx.args[++i];
        if (w === undefined) throw userErr("option '--time' requires an argument");
        if (/^(atime|access|use)$/.test(w)) which += 'a';
        else if (/^(mtime|modify)$/.test(w)) which += 'm';
        else throw noTime(w);
      } else if (/^-[acmhf]*[drt]$/.test(a) && a.length > 2) {
        // -cd DATE, -mt STAMP: letters together, the last one takes the value
        if (a.includes('c')) create = false;
        which += a.replace(/[^am]/g, '');
        ctx.args.splice(i, 1, '-' + a.slice(-1));
        i--;
        continue;
      } else if (/^-[acmhf]+$/.test(a)) {
        if (a.includes('c')) create = false;
        which += a.replace(/[^am]/g, '');
      } else if (a.startsWith('--')) throw userErr(`unrecognized option '${a}'`);
      else if (a.startsWith('-') && a !== '-') throw userErr(`invalid option -- '${(/[^acmhf]/.exec(a.slice(1)) || [a[1]])[0]}'`);
      else files.push(a);
      if (v == null) continue;
      if (/^(-r|--reference)/.test(a)) {
        const ref = ctx.fs.get(v);
        if (!ref) throw userErr(`touch: failed to get attributes of '${v}': No such file or directory`);
        when = { m: ref.mtime || Date.now(), a: ref.atime != null ? ref.atime : ref.mtime || Date.now() };
      } else if (a === '-t') {
        // [[CC]YY]MMDDhhmm[.ss]: a year of two digits is 1969–1999 or 2000–2068
        const m = /^(\d{2}(?=\d{10}))?(\d{2}(?=\d{8}))?(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{2}))?$/.exec(v);
        if (!m) throw userErr(`touch: invalid date format ‘${v}’`);
        const year = m[1] ? +(m[1] + m[2]) : m[2] ? (+m[2] >= 69 ? 1900 : 2000) + +m[2] : timeFields(Date.now(), zoneOf(ctx)).Y;
        const t = timeOf(year, +m[3] - 1, +m[4], +m[5], +m[6], +(m[7] || 0), zoneOf(ctx));
        when = { m: t, a: t };
      } else {
        const t = await gnuDate(ctx, v);
        if (Number.isNaN(t)) throw userErr(`touch: invalid date format ‘${v}’`);
        when = { m: t, a: t };
      }
    }
    if (!files.length) throw userErr('touch: missing file operand');
    const both = !which || (which.includes('a') && which.includes('m'));
    let code = 0;
    files.forEach((f) => {
      // (touch - : the times of the output – nothing to do here, and no file "-")
      if (f === '-') return;
      const e = ctx.fs.get(f);
      if (!e && !create) return;
      const fail = (msg) => {
        ctx.err(`touch: ${msg}\n`);
        code = 1;
      };
      if (f !== '' && /\/$/.test(f) && !e && ctx.fs.isDir(MG.path.dirname(ctx.fs.resolve(f)))) return fail(`setting times of '${f}': No such file or directory`);
      if (f !== '' && /\/$/.test(f) && ctx.fs.pathError && ctx.fs.pathError(f) === 'Not a directory') return fail(`setting times of '${f}': Not a directory`);
      if (f === '' || !ctx.fs.isDir(MG.path.dirname(ctx.fs.resolve(f)))) return fail(`cannot touch '${f}': ${f !== '' && ctx.fs.exists(MG.path.dirname(ctx.fs.resolve(f))) ? 'Not a directory' : 'No such file or directory'}`);
      if (e && e.kind !== 'dir' && /\/$/.test(f)) return fail(`setting times of '${f}': Not a directory`);
      // (the owner of a file may set its times without permission to write: touch on a read-only copy works.
      // The course data is root's.)
      if (e && e.protected) return fail(`cannot touch '${f}': Permission denied`);
      const now = Date.now();
      ctx.fs.touch(f, both ? (when ? when.m : null) : which.includes('m') ? (when ? when.m : now) : undefined, both ? (when ? when.a : null) : which.includes('a') ? (when ? when.a : now) : undefined);
    });
    return code;
  };
  /* rm [-f] [-i | -I] [-r] [-d] [-v] FILE…: -i asks before every file, -I once before more than three files or
     before a folder with all that is in it. Of -f, -i and -I the last one given counts. */
  B.rm = async (ctx) => {
    let ask = 'never', force = false;
    for (const a of ctx.args) {
      if (a === '--') break;
      if (a === '--force') (ask = 'never'), (force = true);
      else if (/^--interactive(=|$)/.test(a)) {
        const w = a.includes('=') ? a.slice(a.indexOf('=') + 1) : 'always';
        if (/^(always|yes)$/.test(w)) (ask = 'always'), (force = false);
        else if (w === 'once') (ask = 'once'), (force = false);
        else if (/^(never|no|none)$/.test(w)) ask = 'never';
        else throw userErr(`rm: invalid argument ‘${w}’ for ‘--interactive’\nValid arguments are:\n  - ‘never’, ‘no’, ‘none’\n  - ‘once’\n  - ‘always’, ‘yes’\nTry 'rm --help' for more information.`);
      } else if (/^-[A-Za-z]+$/.test(a)) {
        for (const c of a.slice(1)) {
          if (c === 'f') (ask = 'never'), (force = true);
          else if (c === 'i') (ask = 'always'), (force = false);
          else if (c === 'I') (ask = 'once'), (force = false);
        }
      }
    }
    const { opts, rest } = getopts(ctx.args.map((a) => (/^--interactive=/.test(a) ? '--interactive' : a)), 'rfRivdI', { recursive: 'r', force: 'f', verbose: 'v', dir: 'd', interactive: 'i', 'one-file-system': 'x', 'preserve-root': 'x', 'no-preserve-root': 'x' }, 'x');
    if (!rest.length) {
      if (force) return 0;
      throw userErr('rm: missing operand');
    }
    const recursive = !!(opts.r || opts.R);
    const question = asker(ctx, 'rm');
    if (ask === 'once' && (rest.length > 3 || recursive)) {
      const n = rest.length;
      if (!(await question(recursive ? `remove ${n} argument${n === 1 ? '' : 's'} recursively?` : `remove ${n} arguments?`))) return 0;
    }
    let code = 0;
    const fail = (msg) => {
      ctx.err(msg + '\n');
      code = 1;
    };
    // one file → is it gone?
    const file = async (shown, abs, e) => {
      if (ask === 'always') {
        if (!(await question(`remove ${e.readonly ? 'write-protected ' : ''}regular ${ctx.fs.size(e) ? '' : 'empty '}file '${shown}'?`))) return false;
      } else if (e.readonly && !force && !question.piped) {
        // (on Linux rm asks here; nobody can answer in this terminal, so it wants -f)
        fail(`rm: cannot remove '${shown}': the file is write-protected (use rm -f to remove it anyway)`);
        return false;
      }
      ctx.fs.remove(abs);
      if (opts.v) ctx.out(`removed '${shown}'\n`);
      return true;
    };
    // a folder and all that is in it → is it gone? (something in it was kept: so is the folder, and nobody is asked)
    const tree = async (shown, abs) => {
      const kids = ctx.fs.list(abs);
      if (ask === 'always' && kids.length && !(await question(`descend into directory '${shown}'?`))) return false;
      let all = true;
      for (const k of kids) {
        const gone = k.entry.kind === 'dir' ? await tree(`${shown}/${k.name}`, k.path) : await file(`${shown}/${k.name}`, k.path, k.entry);
        if (!gone) all = false;
      }
      if (!all) return false;
      if (ask === 'always' && !(await question(`remove directory '${shown}'?`))) return false;
      ctx.fs.remove(abs);
      if (opts.v) ctx.out(`removed directory '${shown}'\n`);
      return true;
    };
    for (const f of rest) {
      const e = f === '' ? null : ctx.fs.get(f), abs = ctx.fs.resolve(f);
      if (recursive && abs === '/') {
        fail("rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe");
        continue;
      }
      if (!e) {
        if (!force) fail(`rm: cannot remove '${f}': ${(ctx.fs.pathError && ctx.fs.pathError(f)) || 'No such file or directory'}`);
        continue;
      }
      if (recursive && /(^|\/)\.\.?\/*$/.test(f)) {
        fail(`rm: refusing to remove '.' or '..' directory: skipping '${f}'`);
        continue;
      }
      const under = e.kind === 'dir' ? Array.from(ctx.fs.entries).filter(([k]) => k.startsWith(abs + '/')) : [];
      if (e.protected || under.some(([, v]) => v.protected)) {
        fail(`rm: cannot remove '${f}': Permission denied (the course data is read-only)`);
        continue;
      }
      if (e.kind !== 'dir') {
        await file(f, abs, e);
        continue;
      }
      if (!recursive && (!opts.d || under.length)) {
        // (rm -d removes a folder that is empty)
        fail(`rm: cannot remove '${f}': ${opts.d ? 'Directory not empty' : 'Is a directory'}`);
        continue;
      }
      // (The folder one is in – or one above it – can be removed, as on Linux: scripts do it when they clean up
      // (cd "$tmp"; …; rm -rf "$tmp"). The shell is then in a folder that is not there any more; at the prompt it
      // moves to the nearest one that is – see run in shell-lang.js.)
      const shown = f.replace(/(.)\/+$/, '$1');
      // (nobody to ask and nothing to tell: the whole folder at once)
      if (ask !== 'always' && !opts.v && (force || question.piped || !under.some(([, v]) => v.readonly && v.kind !== 'dir'))) ctx.fs.remove(abs);
      else await tree(shown, abs);
    }
    return code;
  };
  B.rmdir = (ctx) => {
    const { opts, rest } = getopts(ctx.args, 'pv', { parents: 'p', verbose: 'v', 'ignore-fail-on-non-empty': 'I' }, 'I');
    if (!rest.length) throw userErr('rmdir: missing operand');
    let code = 0;
    // → true: gone, false: left alone without a word (--ignore-fail-on-non-empty), null: could not be removed
    const one = (d, parent) => {
      const fail = (why) => {
        ctx.err(`rmdir: failed to remove ${parent ? 'directory ' : ''}'${d}': ${why}\n`);
        code = 1;
        return null;
      };
      if (opts.v) ctx.out(`rmdir: removing directory, '${d}'\n`);
      if (d === '') return fail('No such file or directory');
      if (/(^|\/)\.\/*$/.test(d) && ctx.fs.isDir(d)) return fail('Invalid argument');
      if (!ctx.fs.isDir(d)) return fail(d !== '' && ctx.fs.exists(d) ? 'Not a directory' : 'No such file or directory');
      if (ctx.fs.resolve(d) === '/') return fail('Device or resource busy');
      if (ctx.fs.list(d).length) return opts.I ? false : fail('Directory not empty');
      if (ctx.fs.get(d).protected) return fail('Permission denied');
      ctx.fs.remove(d);
      return true;
    };
    rest.forEach((d) => {
      if (one(d, false) !== true) return;
      // rmdir -p a/b/c: then a/b, then a
      if (opts.p) for (let up = d.replace(/\/+$/, ''); up.includes('/'); ) {
        up = up.slice(0, up.lastIndexOf('/')).replace(/\/+$/, '');
        if (!up || one(up, true) !== true) break;
      }
    });
    return code;
  };
  /** the options of cp and of mv → { o, rest }. cp: of -i and -n the last one counts; mv: of -i, -n and -f. */
  function copyOpts(name, args) {
    const cp = name === 'cp';
    const o = { deep: false, f: false, v: false, T: false, parents: false, update: false, clobber: 'yes', mode: false, noMode: false, times: false, t: null };
    const rest = [];
    const need = (opt, v) => {
      if (v === undefined) throw userErr(opt.startsWith('--') ? `option '${opt}' requires an argument` : `option requires an argument -- '${opt[1]}'`);
      return v;
    };
    const noLinks = (opt) => userErr(`cp: ${opt}: the folders of this terminal have no links – make a copy instead:  cp FILE COPY`);
    const preserve = (list, on) => {
      for (const w of list.split(',')) {
        if (w === 'all') (o.mode = o.times = on), (o.noMode = !on);
        else if (w === 'mode') (o.mode = on), (o.noMode = !on);
        else if (w === 'timestamps') o.times = on;
        else if (!/^(ownership|links|context|xattr)$/.test(w)) throw userErr(`cp: invalid argument ‘${w}’ for ‘--${on ? '' : 'no-'}preserve’\nValid arguments are:\n  - ‘mode’\n  - ‘timestamps’\n  - ‘ownership’\n  - ‘links’\n  - ‘context’\n  - ‘xattr’\n  - ‘all’\nTry 'cp --help' for more information.`);
      }
    };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') {
        rest.push(...args.slice(i + 1));
        break;
      }
      if (a.startsWith('--')) {
        const eq = a.indexOf('='), k = eq < 0 ? a.slice(2) : a.slice(2, eq), v = eq < 0 ? undefined : a.slice(eq + 1);
        if (k === 'force') {
          o.f = true;
          if (!cp) o.clobber = 'yes';
        } else if (k === 'interactive') o.clobber = 'ask';
        else if (k === 'no-clobber') o.clobber = 'no';
        else if (k === 'verbose') o.v = true;
        else if (k === 'update') {
          if (v === undefined || v === 'older') o.update = true;
          else if (v === 'none') o.clobber = 'no';
          else if (v === 'all') o.update = false;
          else throw userErr(`${name}: invalid argument ‘${v}’ for ‘--update’\nValid arguments are:\n  - ‘all’\n  - ‘none’\n  - ‘older’\nTry '${name} --help' for more information.`);
        } else if (k === 'target-directory') o.t = need('--target-directory', v !== undefined ? v : args[++i]);
        else if (k === 'no-target-directory') o.T = true;
        else if (k === 'strip-trailing-slashes') o.strip = true;
        else if (cp && k === 'recursive') o.deep = true;
        else if (cp && k === 'archive') o.deep = o.mode = o.times = true;
        else if (cp && k === 'preserve') preserve(v === undefined ? 'mode,ownership,timestamps' : v, true);
        else if (cp && k === 'no-preserve') preserve(need('--no-preserve', v !== undefined ? v : args[++i]), false);
        else if (cp && k === 'parents') o.parents = true;
        else if (cp && /^(dereference|no-dereference|one-file-system|sparse|reflink|remove-destination)$/.test(k)) continue;
        else if (cp && /^(link|symbolic-link)$/.test(k)) throw noLinks(a);
        else throw userErr(`unrecognized option '${a}'`);
        continue;
      }
      if (a.length > 1 && a[0] === '-') {
        for (let j = 1; j < a.length; j++) {
          const c = a[j];
          if (c === 'f') {
            o.f = true;
            if (!cp) o.clobber = 'yes';
          } else if (c === 'i') o.clobber = 'ask';
          else if (c === 'n') o.clobber = 'no';
          else if (c === 'v') o.v = true;
          else if (c === 'u') o.update = true;
          else if (c === 'T') o.T = true;
          else if (c === 't') {
            o.t = need('-t', j + 1 < a.length ? a.slice(j + 1) : args[++i]);
            break;
          } else if (cp && (c === 'r' || c === 'R')) o.deep = true;
          else if (cp && c === 'a') o.deep = o.mode = o.times = true;
          else if (cp && c === 'p') o.mode = o.times = true;
          else if (c === 'Z' || (cp && 'dPLHx'.includes(c))) continue;
          else if (cp && (c === 'l' || c === 's')) throw noLinks('-' + c);
          else throw userErr(`invalid option -- '${c}'`);
        }
        continue;
      }
      rest.push(a);
    }
    if (o.t != null && o.T) throw userErr(`${name}: cannot combine --target-directory (-t) and --no-target-directory (-T)`);
    if (o.t != null) {
      if (!rest.length) throw userErr(`${name}: missing file operand`);
      rest.push(o.t);
    } else if (rest.length < 2) throw userErr(rest.length ? `${name}: missing destination file operand after '${rest[0]}'` : `${name}: missing file operand`);
    else if (o.T && rest.length > 2) throw userErr(`${name}: extra operand '${rest[2]}'`);
    return { o, rest };
  }
  /* cp and mv, as GNU does it. A destination written with a slash at its end has to be a folder – or to become
     one (a folder that is copied or moved under a new name).
     cp: -r (-R) folders, -a folders with times and permissions, -p times and permissions (--preserve=mode,timestamps),
     -u only what is newer than the copy that is there, -n never over a file that is there, -i ask first, -T the
     destination is the copy itself (not a folder to put it in), --parents with the folders of the path. */
  B.cp = async (ctx) => {
    const { o, rest } = copyOpts('cp', ctx.args);
    const dest = rest.pop();
    // cp FILE /dev/null: read, and nothing kept;  cp FILE /dev/stdout: the file is printed
    if (/^\/dev\/(null|stdout|stderr)$/.test(ctx.fs.resolve(dest))) {
      let bad = 0;
      for (const src of rest) {
        const e = ctx.fs.get(src);
        if (!e || e.kind === 'dir') {
          ctx.err(e ? `cp: -r not specified; omitting directory '${src}'\n` : `cp: cannot stat '${src}': No such file or directory\n`);
          bad = 1;
        } else if (!dest.endsWith('null')) {
          const b = await ctx.fs.readBytes(src);
          if (dest.endsWith('stdout')) ctx.out(b);
          else ctx.err(bytesText(b));
        }
      }
      return bad;
    }
    if (o.t != null && !ctx.fs.isDir(dest)) throw userErr(`cp: target directory '${dest}': ${ctx.fs.exists(dest) ? 'Not a directory' : 'No such file or directory'}`);
    if (o.parents && !ctx.fs.isDir(dest)) throw userErr("cp: with --parents, the destination must be a directory\nTry 'cp --help' for more information.");
    if (rest.length > 1 && !ctx.fs.isDir(dest)) throw userErr(`cp: target '${dest}': ${ctx.fs.exists(dest) ? 'Not a directory' : 'No such file or directory'}`);
    const slash = /\/$/.test(dest) && !ctx.fs.isDir(dest);
    const question = asker(ctx, 'cp');
    let code = 0;
    const fail = (msg) => {
      ctx.err(msg + '\n');
      code = 1;
    };
    // a file that is there already and is read-only is not written over – unless -f is given (then it is replaced, as by cp)
    const locked = (abs) => {
      const te = ctx.fs.entries.get(abs);
      return !!te && te.kind !== 'dir' && (te.protected || (te.readonly && !o.f));
    };
    const said = (from, to) => o.v && ctx.out(`'${from}' -> '${to}'\n`);
    // The files that this command itself has made from the sources it was given: a later source of the same name
    // (cp run1/x.txt run2/x.txt all/, cp */summary.txt all/) is not written over an earlier one – "will not
    // overwrite just-created" –, or the earlier file would be lost without a word. As GNU cp and mv do.
    const made = new Set(), given = new Set();
    // one file. cp writes into a file that is there already: that file keeps its own permissions (not with -p)
    const copy = async (from, to, fromShown, shown) => {
      const was = ctx.fs.entries.get(to), src = ctx.fs.entries.get(ctx.fs.resolve(from));
      if (was) {
        // -u: only when the source is newer; -n: never; -i: ask
        if (o.update && (was.mtime || 0) >= (src.mtime || 0)) return;
        if (o.clobber === 'no') return;
        if (o.clobber === 'ask' && !(await question(`overwrite '${shown}'?`))) {
          code = 1;
          return;
        }
      }
      if (locked(to)) return fail(`cp: cannot create regular file '${shown}': Permission denied`);
      ctx.fs.copy(from, to, { times: o.times });
      const n = ctx.fs.entries.get(to);
      if (o.noMode) {
        delete n.readonly;
        delete n.mode;
        delete n.perm;
      } else if (was && was.kind !== 'dir' && !was.readonly && !was.protected && !o.mode) {
        delete n.readonly;
        if (was.mode) n.mode = was.mode;
        else delete n.mode;
        if (was.perm != null) n.perm = was.perm;
        else delete n.perm;
      }
      said(fromShown, shown);
    };
    for (const src of rest) {
      const e = src === '' ? null : ctx.fs.get(src);
      if (src === '/dev/null' && !ctx.fs.isDir(dest)) {
        // cp /dev/null FILE: an empty file
        if (locked(ctx.fs.resolve(dest))) fail(`cp: cannot create regular file '${dest}': Permission denied`);
        else ctx.fs.writeText(dest, '');
        continue;
      }
      if (!e) {
        fail(`cp: cannot stat '${src}': No such file or directory`);
        continue;
      }
      if (e.kind !== 'dir' && /\/$/.test(src)) {
        fail(`cp: cannot stat '${src}': Not a directory`);
        continue;
      }
      const A = ctx.fs.resolve(src);
      // (the same source twice – cp a.txt ./a.txt all/: a warning, and it is copied once)
      if (given.has(A) && (e.kind !== 'dir' || o.deep)) {
        ctx.err(`cp: warning: source ${e.kind === 'dir' ? 'directory' : 'file'} '${src}' specified more than once\n`);
        continue;
      }
      given.add(A);
      // (DEST/ where DEST is a file: the name before the slash is looked at – "DEST/" itself names nothing)
      const bare = dest.replace(/\/+$/, '');
      if (slash && ((bare !== '' && ctx.fs.exists(bare)) || e.kind !== 'dir')) {
        fail(bare !== '' && ctx.fs.exists(bare) ? `cp: failed to access '${dest}': Not a directory` : `cp: cannot create regular file '${dest}': Not a directory`);
        continue;
      }
      // SRC/. is what is in the folder SRC: it goes into the destination itself, not into a folder SRC there
      const contents = e.kind === 'dir' && /(^|\/)\.\/*$/.test(src);
      let target;
      if (o.parents) {
        // --parents: under the destination with the folders of its path (cp --parents a/b/c.txt out → out/a/b/c.txt)
        const rel = src.replace(/^\/+/, '').replace(/\/+$/, '');
        target = dest.replace(/\/+$/, '') + '/' + rel;
        if (e.kind !== 'dir' || o.deep) ctx.fs.mkdirp(MG.path.dirname(ctx.fs.resolve(target)));
      } else target = !o.T && ctx.fs.isDir(dest) && !contents ? dest.replace(/\/+$/, '') + '/' + MG.path.basename(A) : dest;
      // (the empty name – cp FILE "$DIR" with DIR not set – is no file and no folder)
      if (target === '' && (e.kind !== 'dir' || o.deep)) {
        fail(`cp: cannot create ${e.kind === 'dir' ? 'directory' : 'regular file'} '': No such file or directory`);
        continue;
      }
      const T = ctx.fs.resolve(target);
      if (!ctx.fs.isDir(MG.path.dirname(T))) {
        fail(`cp: cannot create ${e.kind === 'dir' ? 'directory' : 'regular file'} '${target}': No such file or directory`);
        continue;
      }
      const there = ctx.fs.entries.get(T);
      if (e.kind === 'dir') {
        if (!o.deep) fail(`cp: -r not specified; omitting directory '${src}'`);
        else if (T === A) fail(`cp: cannot copy a directory, '${src}', into itself, '${target}'`);
        else if (there && there.kind !== 'dir') fail(`cp: cannot overwrite non-directory '${target}' with directory '${src}'`);
        else {
          const dirs = [[A, T]];
          if (!there) said(src.replace(/\/+$/, ''), target.replace(/\/+$/, ''));
          const before = Array.from(ctx.fs.entries);
          ctx.fs.mkdirp(T);
          // (into a folder inside itself – cp -r d d/copy: what is in d is copied, the new folder itself is not, and
          // cp says so)
          if (T.startsWith(A + '/')) fail(`cp: cannot copy a directory, '${src}', into itself, '${target}'`);
          const skip = T.startsWith(A + '/') ? [T] : []; // folders that could not be made: what is in them is left out too
          for (const [k, v] of before) {
            if (!k.startsWith(A + '/') || k === T || skip.some((x) => k.startsWith(x + '/'))) continue;
            const rel = k.slice(A.length), to = T + rel, shown = target.replace(/\/+$/, '') + rel;
            const te = ctx.fs.entries.get(to);
            if (v.kind === 'dir') {
              if (te && te.kind !== 'dir') {
                fail(`cp: cannot overwrite non-directory '${shown}' with directory '${src.replace(/\/+$/, '') + rel}'`);
                skip.push(k);
              } else {
                if (!te) said(src.replace(/\/+$/, '') + rel, shown);
                ctx.fs.mkdirp(to);
                dirs.push([k, to]);
              }
            } else if (te && te.kind === 'dir') fail(`cp: cannot overwrite directory '${shown}' with non-directory`);
            else await copy(k, to, src.replace(/\/+$/, '') + rel, shown);
          }
          // (-a, -p: the folders get the times and the permissions of the ones they were copied from – last, when
          // all that is in them is there)
          if (o.times || o.mode) for (const [from, to] of dirs.reverse()) {
            const fe = ctx.fs.entries.get(from), te2 = ctx.fs.entries.get(to);
            if (!fe || !te2) continue;
            const n = Object.assign({}, te2);
            if (o.times) {
              n.mtime = fe.mtime;
              if (fe.atime != null) n.atime = fe.atime;
            }
            if (o.mode && fe.perm != null) n.perm = fe.perm;
            ctx.fs.entries.set(to, n);
          }
        }
        continue;
      }
      if (T === A) fail(`cp: '${src}' and '${target}' are the same file`);
      else if (there && there.kind === 'dir') fail(`cp: cannot overwrite directory '${target}' with non-directory`);
      else if (there && made.has(T) && o.clobber !== 'no' && !(o.update && (there.mtime || 0) >= (e.mtime || 0))) fail(`cp: will not overwrite just-created '${target}' with '${src}'`);
      else {
        await copy(src, T, src, target);
        made.add(T);
      }
    }
    return code;
  };
  /* mv [-f | -i | -n] [-u] [-v] [-T] [-t DIRECTORY] SOURCE… DESTINATION */
  B.mv = async (ctx) => {
    const { o, rest } = copyOpts('mv', ctx.args);
    const dest = rest.pop();
    if (o.t != null && !ctx.fs.isDir(dest)) throw userErr(`mv: target directory '${dest}': ${ctx.fs.exists(dest) ? 'Not a directory' : 'No such file or directory'}`);
    if (rest.length > 1 && !ctx.fs.isDir(dest)) throw userErr(`mv: target '${dest}': ${ctx.fs.exists(dest) ? 'Not a directory' : 'No such file or directory'}`);
    const slash = /\/$/.test(dest) && !ctx.fs.isDir(dest);
    const question = asker(ctx, 'mv');
    let code = 0;
    // (the files this command itself has put there: see cp – mv run1/x.txt run2/x.txt all/ keeps both files)
    const made = new Set();
    // one source that cannot be moved does not stop the others
    for (const src of rest) {
      const fail = (msg) => {
        ctx.err(msg + '\n');
        code = 1;
      };
      const e = src === '' ? null : ctx.fs.get(src);
      if (!e || (e.kind !== 'dir' && /\/$/.test(src))) {
        fail(`mv: cannot stat '${src}': ${e ? 'Not a directory' : (ctx.fs.pathError && ctx.fs.pathError(src)) || 'No such file or directory'}`);
        continue;
      }
      // ("." and "..", also at the end of a longer path – e/., f/.. : Linux refuses to rename a folder under that
      // name. Taken as the folder it stands for, "mv . ../g" would move the folder one is in.)
      if (/(^|\/)\.\.?\/*$/.test(src)) {
        fail(`mv: cannot move '${src}' to '${dest}': Device or resource busy`);
        continue;
      }
      const A = ctx.fs.resolve(src);
      const target = !o.T && ctx.fs.isDir(dest) ? dest.replace(/\/+$/, '') + '/' + MG.path.basename(A) : dest;
      if (target === '') {
        fail(`mv: cannot move '${src}' to '': No such file or directory`);
        continue;
      }
      const T = ctx.fs.resolve(target);
      const te = ctx.fs.get(target);
      if (e.protected || (e.kind === 'dir' && Array.from(ctx.fs.entries).some(([k, v]) => k.startsWith(A + '/') && v.protected))) fail(`mv: cannot move '${src}': Permission denied (the course data is read-only)`);
      else if (slash && (ctx.fs.exists(dest) || e.kind !== 'dir')) fail(`mv: cannot move '${src}' to '${dest}': Not a directory`);
      else if (!ctx.fs.isDir(MG.path.dirname(T))) fail(`mv: cannot move '${src}' to '${target}': No such file or directory`);
      else if (T === A) fail(`mv: '${src}' and '${target}' are the same file`);
      // -u: only when the source is newer; -n: never over a file that is there
      else if (te && o.update && (te.mtime || 0) >= (e.mtime || 0)) continue;
      else if (te && o.clobber === 'no') continue;
      else if (te && te.kind === 'dir' && e.kind !== 'dir') fail(`mv: cannot overwrite directory '${target}' with non-directory`);
      else if (te && te.kind !== 'dir' && e.kind === 'dir') fail(`mv: cannot overwrite non-directory '${target}' with directory '${src}'`);
      else if (te && te.kind === 'dir' && ctx.fs.list(T).length) fail(`mv: cannot move '${src}' to '${target}': Directory not empty`);
      else if (te && te.protected) fail(`mv: cannot move '${src}' to '${target}': Permission denied`);
      else if (e.kind === 'dir' && T.startsWith(A + '/')) fail(`mv: cannot move '${src}' to a subdirectory of itself, '${target}'`);
      else if (te && te.kind !== 'dir' && made.has(T)) fail(`mv: will not overwrite just-created '${target}' with '${src}'`);
      else {
        if (te && o.clobber === 'ask') {
          if (!(await question(`overwrite '${target}'?`))) {
            code = 1;
            continue;
          }
        } else if (te && te.readonly && !o.f && !question.piped) {
          // on Linux mv asks before it replaces a write-protected file; here there is nobody to ask, so it wants -f
          fail(`mv: cannot move '${src}' to '${target}': '${target}' is write-protected (use mv -f to replace it anyway)`);
          continue;
        }
        const inside = ctx.fs.cwd === A || ctx.fs.cwd.startsWith(A + '/');
        if (!ctx.fs.rename(src, target)) {
          fail(`mv: cannot move '${src}' to '${target}': No such file or directory`);
          continue;
        }
        made.add(T);
        if (o.v) ctx.out(`renamed '${src}' -> '${target}'\n`);
        if (inside) ctx.fs.cwd = T + ctx.fs.cwd.slice(A.length);
      }
    }
    return code;
  };

  B.less = async (ctx) => {
    const input = await inputOf(ctx, ctx.args.filter((a) => !a.startsWith('-')), ctx.name);
    if (!ctx.isPipedOut) ctx.io.note('(less shows a file one screen at a time; here the whole file is printed – scroll the terminal)');
    ctx.out(input);
  };
  B.more = B.less;
  /** the texts of the files a command was given, one by one: "-" is the input; none at all: the input alone */
  async function textsOf(ctx, files, name) {
    if (!files.length) return [await inputOf(ctx, [], name)];
    const out = [];
    for (const f of files) out.push(f === '-' ? await inputOf(ctx, [], name) : await readOne(ctx, f, name));
    return out;
  }
  /* tac [-b] [-s SEPARATOR] [-r] [FILE …]: each file by itself, its lines last to first (tac a b: the lines of a
     backwards, then those of b). -s: what ends a record instead of the newline (-r: a regular expression);
     -b: the separator stands before its record. */
  B.tac = async (ctx) => {
    let sep = '\n', before = false, regex = false;
    const files = [];
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      const m = /^--separator=([\s\S]*)$/.exec(a);
      if (a === '-' || !a.startsWith('-')) files.push(a);
      else if (m) sep = m[1];
      else if (a === '--separator' || a === '-s') {
        if (i + 1 >= ctx.args.length) throw userErr("tac: option requires an argument -- 's'\nTry 'tac --help' for more information.");
        sep = ctx.args[++i];
      } else if (a === '--before') before = true;
      else if (a === '--regex') regex = true;
      else if (a === '--') {
        files.push(...ctx.args.slice(i + 1));
        break;
      } else if (/^-[brs]+/.test(a)) {
        for (let j = 1; j < a.length; j++) {
          if (a[j] === 'b') before = true;
          else if (a[j] === 'r') regex = true;
          else if (a[j] === 's') {
            sep = j + 1 < a.length ? a.slice(j + 1) : ctx.args[++i];
            if (sep == null) throw userErr("tac: option requires an argument -- 's'\nTry 'tac --help' for more information.");
            break;
          } else throw userErr(`tac: invalid option -- '${a[j]}'\nTry 'tac --help' for more information.`);
        }
      } else throw userErr(`tac: ${a.startsWith('--') ? `unrecognized option '${a}'` : `invalid option -- '${a[1]}'`}\nTry 'tac --help' for more information.`);
    }
    if (sep === '') throw userErr('tac: separator cannot be empty');
    let re;
    try {
      re = new RegExp(regex ? sep : sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    } catch (e) {
      throw userErr(`tac: ${sep}: Invalid regular expression`);
    }
    let code = 0;
    for (const f of files.length ? files : ['-']) {
      let text;
      if (f === '-') text = await inputOf(ctx, [], 'tac');
      else {
        const e = ctx.fs.get(f);
        if (!e || e.kind === 'dir') {
          ctx.err(e ? `tac: ${f}: read error: Is a directory\n` : `tac: failed to open '${f}' for reading: No such file or directory\n`);
          code = 1;
          continue;
        }
        text = await ctx.fs.readText(f);
      }
      // the records: each with its separator – at its end, or (-b) at its start
      const parts = [];
      let at = 0, m;
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        if (!m[0].length) {
          re.lastIndex++;
          continue;
        }
        const cut = before ? m.index : m.index + m[0].length;
        if (cut > at) parts.push(text.slice(at, cut));
        at = cut;
      }
      if (at < text.length) parts.push(text.slice(at));
      if (parts.length) ctx.out(parts.reverse().join(''));
    }
    return code;
  };
  B.rev = async (ctx) => {
    const k = ctx.args.indexOf('--');
    const bad = ctx.args.find((a, i) => /^-./.test(a) && (k < 0 || i < k));
    if (bad) throw refuseOption('rev', bad);
    const files = ctx.args.filter((a, i) => (a === '-' || !a.startsWith('-') || (k >= 0 && i > k)) && i !== k);
    let code = 0;
    // (the files in turn; one that is not there is said and left out)
    for (const f of files.length ? files : ['-']) {
      let text;
      if (f === '-') text = await inputOf(ctx, [], 'rev');
      else {
        const e = ctx.fs.get(f);
        if (!e || e.kind === 'dir') {
          ctx.err(`rev: cannot open ${f}: ${e ? 'Is a directory' : 'No such file or directory'}\n`);
          code = 1;
          continue;
        }
        text = await ctx.fs.readText(f);
      }
      const L = linesOf(text);
      // (a last line without a newline stays without one)
      if (L.length) ctx.out(L.map((l) => Array.from(l).reverse().join('')).join('\n') + (text.endsWith('\n') ? '\n' : ''));
    }
    return code;
  };
  /* nl [-b STYLE] [-h STYLE] [-f STYLE] [-n ln|rn|rz] [-w WIDTH] [-s SEPARATOR] [-v START] [-i STEP] [-l N] [-p]
     [-d CC] [FILE …]: number the lines – by default those that are not empty, in a column of 6 with a tab after it.
     STYLE: a (all lines), t (the lines that are not empty), n (none), pREGEX (the lines that match). A line of
     \:\:\: , \:\: or \: starts the header, the body or the footer of a new "page"; the numbers start again there. */
  B.nl = async (ctx) => {
    const style = { b: 't', h: 'n', f: 'n' };
    let fmt = 'rn', width = 6, sep = '\t', start = 1, step = 1, join = 1, renumber = true, delim = '\\:';
    const files = [];
    const LONG = { 'body-numbering': 'b', 'header-numbering': 'h', 'footer-numbering': 'f', 'number-format': 'n', 'number-width': 'w', 'number-separator': 's', 'starting-line-number': 'v', 'line-increment': 'i', 'join-blank-lines': 'l', 'section-delimiter': 'd' };
    const bad = (msg) => userErr(`nl: ${msg}\nTry 'nl --help' for more information.`);
    const int = (v, what) => {
      if (!/^-?\d+$/.test(v)) throw userErr(`nl: invalid ${what}: \u2018${v}\u2019`);
      return parseInt(v, 10);
    };
    const set = (k, v) => {
      if (k === 'b' || k === 'h' || k === 'f') {
        if (!/^(a|t|n|p[\s\S]*)$/.test(v)) throw bad(`invalid ${k === 'b' ? 'body' : k === 'h' ? 'header' : 'footer'} numbering style: \u2018${v}\u2019`);
        style[k] = v;
      } else if (k === 'n') {
        if (!/^(ln|rn|rz)$/.test(v)) throw bad(`invalid line numbering format: \u2018${v}\u2019`);
        fmt = v;
      } else if (k === 'w') {
        width = int(v, 'line number field width');
        if (width < 1) throw userErr(`nl: invalid line number field width: \u2018${v}\u2019: Numerical result out of range`);
      } else if (k === 's') sep = v;
      else if (k === 'v') start = int(v, 'starting line number');
      else if (k === 'i') step = int(v, 'line number increment');
      else if (k === 'l') join = Math.max(1, int(v, 'line number of blank lines'));
      else if (k === 'd') delim = v.length === 1 ? v + ':' : v; // (one character: the second stays ':')
    };
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (a === '-' || !a.startsWith('-')) {
        files.push(a);
        continue;
      }
      if (a === '--') {
        files.push(...ctx.args.slice(i + 1));
        break;
      }
      if (a.startsWith('--')) {
        const eq = a.indexOf('='), name = eq < 0 ? a.slice(2) : a.slice(2, eq);
        if (name === 'no-renumber') renumber = false;
        else if (LONG[name]) {
          const v = eq < 0 ? ctx.args[++i] : a.slice(eq + 1);
          if (v == null) throw bad(`option '--${name}' requires an argument`);
          set(LONG[name], v);
        } else throw bad(`unrecognized option '${a}'`);
        continue;
      }
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (c === 'p') renumber = false;
        else if ('bhfnwsvild'.includes(c)) {
          const v = j + 1 < a.length ? a.slice(j + 1) : ctx.args[++i];
          if (v == null) throw bad(`option requires an argument -- '${c}'`);
          set(c, v);
          break;
        } else throw bad(`invalid option -- '${c}'`);
      }
    }
    let code = 0, text = '';
    for (const f of files.length ? files : ['-']) {
      try {
        text += f === '-' ? await inputOf(ctx, [], 'nl') : await readOne(ctx, f, 'nl');
      } catch (e) {
        if (!e || !e.userMessage) throw e;
        ctx.err(e.userMessage + '\n');
        code = 1;
      }
    }
    const matcher = (s) => {
      if (s[0] !== 'p') return null;
      try {
        // (a basic regular expression: \( \) are groups, a + or ? is itself)
        return new RegExp(s.slice(1).replace(/\\([(){}|+?])|([(){}|+?])/g, (m, esc, plain) => (esc ? esc : '\\' + plain)));
      } catch (e) {
        throw userErr(`nl: ${s.slice(1)}: Invalid regular expression`);
      }
    };
    const re = { b: matcher(style.b), h: matcher(style.h), f: matcher(style.f) };
    const blank = ' '.repeat(width + sep.length);
    const shown = (n) => {
      const t = String(Math.abs(n)), neg = n < 0 ? '-' : '';
      return fmt === 'ln' ? (neg + t).padEnd(width) : fmt === 'rz' ? neg + t.padStart(width - neg.length, '0') : (neg + t).padStart(width);
    };
    let n = start, section = 'b', blanks = 0;
    const out = [];
    for (const l of linesOf(text)) {
      const sec = delim && l === delim.repeat(3) ? 'h' : delim && l === delim.repeat(2) ? 'b' : delim && l === delim ? 'f' : null;
      if (sec) {
        // a new section: the line itself becomes an empty one; a new page (its header) starts the numbers again
        section = sec;
        blanks = 0;
        if (sec === 'h' && renumber) n = start;
        out.push('');
        continue;
      }
      const s = style[section];
      let number;
      if (s === 'a') {
        // -l N: of N empty lines one after the other, the last one is numbered
        if (l === '' && join > 1) {
          number = ++blanks === join;
          if (number) blanks = 0;
        } else {
          number = true;
          blanks = 0;
        }
      } else if (s === 't') number = l !== '';
      else if (s === 'n') number = false;
      else number = re[section].test(l);
      if (number) {
        out.push(shown(n) + sep + l);
        n += step;
      } else out.push(blank + l);
    }
    if (out.length) ctx.out(out.join('\n') + '\n');
    return code;
  };
  const unesc = (s) => String(s).replace(/\\t/g, '\t').replace(/\\n/g, '\n');
  B.column = async (ctx) => {
    const { opts, rest } = getopts(ctx.args, 'ts:o:', { table: 't', separator: 's' });
    const input = await inputOf(ctx, rest, 'column');
    if (!opts.t) return ctx.out(input);
    const sep = opts.s == null ? /[ \t]+/ : unesc(opts.s);
    const rows = linesOf(input).map((l) => (opts.s == null ? l.trim() : l).split(sep));
    const w = [];
    rows.forEach((r) => r.forEach((c, i) => (w[i] = Math.max(w[i] || 0, c.length))));
    ctx.out(rows.map((r) => r.map((c, i) => (i < r.length - 1 ? c.padEnd(w[i]) : c)).join(opts.o != null ? unesc(opts.o) : '  ')).join('\n') + '\n');
  };

  /* file [-b] [-i] FILE…: what kind of file – judged by its name and its size, not by reading it.
     -b: without the name;  -i (--mime): as a MIME type with the character set;  --mime-type: the type alone */
  /* du [-s] [-a] [-c] [-h] [-b] [-k] [-m] [-B SIZE] [-d N] [-S] [-t SIZE] [--exclude=PATTERN] [--time] [FILE …]: the
     space that files and folders take. As on a Linux disk, a file takes whole blocks of 4 K and a folder 4 K of its
     own; -b (and --apparent-size) count the bytes of the files, and nothing for a folder itself. */
  B.du = (ctx) => {
    const o = { apparent: false, block: { size: 1024, suffix: '' }, human: null, depth: null, exclude: [], end: '\n', threshold: null, time: false, timeStyle: 'long-iso', inodes: false };
    const rest = [], args = ctx.args;
    const env = ctx.env.DU_BLOCK_SIZE || ctx.env.BLOCK_SIZE;
    if (env) {
      try {
        o.block = blockSize(env, 'du', '-B');
      } catch (e) {
        /* (a size in the environment that is none: left out) */
      }
    }
    const depth = (v) => {
      if (!/^\d+$/.test(v)) throw userErr(`du: invalid maximum depth ‘${v}’`);
      return parseInt(v, 10);
    };
    const size = (v) => {
      const m = /^(-?)(.+)$/.exec(v || ''), b = m ? blockSize(m[2], 'du', '--threshold') : null;
      if (!b || (m[1] && b.size === 0)) throw userErr(`du: invalid --threshold argument '${v}'`);
      return m[1] ? -b.size : b.size;
    };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') {
        rest.push(...args.slice(i + 1));
        break;
      }
      if (a.startsWith('--')) {
        const eq = a.indexOf('='), k = eq < 0 ? a.slice(2) : a.slice(2, eq);
        let v = eq < 0 ? undefined : a.slice(eq + 1);
        const need = () => {
          if (v === undefined) v = args[++i];
          if (v === undefined) throw userErr(`option '--${k}' requires an argument`);
          return v;
        };
        if (k === 'summarize') o.s = true;
        else if (k === 'all') o.a = true;
        else if (k === 'total') o.c = true;
        else if (k === 'separate-dirs') o.S = true;
        else if (k === 'human-readable') o.human = 'h';
        else if (k === 'si') o.human = 'si';
        else if (k === 'bytes') (o.apparent = true), (o.block = { size: 1, suffix: '' }), (o.human = null);
        else if (k === 'apparent-size') o.apparent = true;
        else if (k === 'block-size') (o.block = blockSize(need(), 'du', '--block-size')), (o.human = null);
        else if (k === 'max-depth') o.depth = depth(need());
        else if (k === 'null') o.end = '\0';
        else if (k === 'threshold') o.threshold = size(need());
        else if (k === 'exclude') o.exclude.push(need());
        else if (k === 'exclude-from') {
          const f = need(), e = ctx.fs.get(f);
          if (f !== '/dev/null') {
            if (!e || e.kind !== 'text') throw userErr(`du: ${f}: No such file or directory`);
            o.exclude.push(...linesOf(e.text).filter(Boolean));
          }
        } else if (k === 'time') o.time = true;
        else if (k === 'time-style') o.timeStyle = need();
        else if (k === 'inodes') o.inodes = true;
        else if (/^(one-file-system|dereference|no-dereference|dereference-args|count-links)$/.test(k)) continue;
        else throw userErr(`unrecognized option '${a}'`);
        continue;
      }
      if (a.length > 1 && a[0] === '-') {
        for (let j = 1; j < a.length; j++) {
          const c = a[j];
          const value = () => {
            const v = j + 1 < a.length ? a.slice(j + 1) : args[++i];
            if (v === undefined) throw userErr(`option requires an argument -- '${c}'`);
            j = a.length;
            return v;
          };
          if (c === 's') o.s = true;
          else if (c === 'a') o.a = true;
          else if (c === 'c') o.c = true;
          else if (c === 'S') o.S = true;
          else if (c === 'h') o.human = 'h';
          else if (c === 'b') (o.apparent = true), (o.block = { size: 1, suffix: '' }), (o.human = null);
          else if (c === 'k') (o.block = { size: 1024, suffix: '' }), (o.human = null);
          else if (c === 'm') (o.block = { size: 1048576, suffix: '' }), (o.human = null);
          else if (c === 'B') (o.block = blockSize(value(), 'du', '-B')), (o.human = null);
          else if (c === 'd') o.depth = depth(value());
          else if (c === '0') o.end = '\0';
          else if (c === 't') o.threshold = size(value());
          else if (c === 'X') {
            const f = value(), e = ctx.fs.get(f);
            if (f !== '/dev/null') {
              if (!e || e.kind !== 'text') throw userErr(`du: ${f}: No such file or directory`);
              o.exclude.push(...linesOf(e.text).filter(Boolean));
            }
          } else if ('xLPDHl'.includes(c)) continue;
          else throw userErr(`invalid option -- '${c}'`);
        }
        continue;
      }
      rest.push(a);
    }
    if (o.s && o.a) throw userErr("du: cannot both summarize and show all entries\nTry 'du --help' for more information.");
    if (o.s && o.depth != null && o.depth !== 0) throw userErr(`du: warning: summarizing conflicts with --max-depth=${o.depth}\nTry 'du --help' for more information.`);
    const depthMax = o.s ? 0 : o.depth != null ? o.depth : Infinity;
    const own = (e) => (o.inodes ? 1 : o.apparent ? (e.kind === 'dir' ? 0 : ctx.fs.size(e)) : e.kind === 'dir' ? 4096 : Math.ceil(ctx.fs.size(e) / 4096) * 4096);
    const show = (n) => (o.inodes ? String(n) : o.human ? humanCeil(n, o.human === 'si') : Math.ceil(n / o.block.size) + o.block.suffix);
    const excluded = (name, path) => o.exclude.some((p) => MG.globRe(p, '', true).test(name) || MG.globRe(p, '', true).test(path));
    const zone = zoneOf(ctx);
    const stamp = (t) => strftime(o.timeStyle[0] === '+' ? o.timeStyle.slice(1) : o.timeStyle === 'full-iso' ? '%Y-%m-%d %H:%M:%S.%N %z' : o.timeStyle === 'iso' ? '%Y-%m-%d' : '%Y-%m-%d %H:%M', t, zone);
    const line = (n, t, name) => {
      if (o.threshold != null && !o.inodes && (o.threshold >= 0 ? n < o.threshold : n > -o.threshold)) return;
      ctx.out(show(n) + '\t' + (o.time ? stamp(t) + '\t' : '') + name + o.end);
    };
    let code = 0, grand = 0, newest = 0;
    (rest.length ? rest : ['.']).forEach((p) => {
      const abs = ctx.fs.resolve(p), e = p === '' ? null : ctx.fs.get(abs);
      if (!e) {
        ctx.err(p === '' ? 'du: invalid zero-length file name\n' : `du: cannot access '${p}': No such file or directory\n`);
        code = 1;
        return;
      }
      const shown = p.replace(/(.)\/+$/, '$1');
      // every folder below, the deepest first (du -a: every file too); du -s, du -d 0: only the total
      const walk = (dir, entry, name, depth) => {
        let tot = own(entry), here = own(entry), time = entry.mtime || 0;
        if (entry.kind === 'dir') {
          ctx.fs.list(dir).forEach((c) => {
            const cname = (name === '/' ? '' : name) + '/' + c.name;
            if (excluded(c.name, cname)) return;
            const sub = walk(c.path, c.entry, cname, depth + 1);
            tot += sub.tot;
            time = Math.max(time, sub.time);
            if (c.entry.kind !== 'dir') here += sub.tot;
          });
        }
        if ((entry.kind === 'dir' || o.a || depth === 0) && depth <= depthMax) line(o.S && entry.kind === 'dir' ? here : tot, time, name);
        return { tot, time };
      };
      const r = walk(abs, e, shown, 0);
      grand += r.tot;
      newest = Math.max(newest, r.time);
    });
    if (o.c) ctx.out(show(grand) + '\t' + (o.time ? stamp(newest) + '\t' : '') + 'total' + o.end);
    return code;
  };
  /* stat [-c FORMAT | --printf FORMAT] [-t] FILE …: the size, the kind, the permissions and the times of a file.
     In a format a number may stand between % and the letter (%5s, %-10n). */
  B.stat = (ctx) => {
    const args = ctx.args.slice();
    let fmt = null, terse = false;
    const files = [];
    // (--printf: \n, \t, \101, \x41 … are carried out, as printf does)
    const ESC = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v', '\\': '\\', '"': '"' };
    const unprintf = (t) => t.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|[\s\S])/g, (m, c) => {
      if (c[0] === 'x' && c.length > 1) return String.fromCharCode(parseInt(c.slice(1), 16));
      if (/^[0-7]/.test(c)) return String.fromCharCode(parseInt(c, 8));
      if (c in ESC) return ESC[c];
      ctx.err(`stat: warning: unrecognized escape '\\${c}'\n`);
      return c;
    });
    const value1 = (i, opt) => {
      if (i >= args.length) throw userErr(opt.startsWith('--') ? `option '${opt}' requires an argument` : `option requires an argument -- '${opt[1]}'`);
      return args[i];
    };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' || args[i] === '--format') fmt = value1(++i, args[i - 1]) + '\n';
      else if (args[i] === '--printf') fmt = unprintf(value1(++i, '--printf'));
      else if (args[i].startsWith('--printf=')) fmt = unprintf(args[i].slice(9));
      else if (args[i].startsWith('-c')) fmt = args[i].slice(2) + '\n';
      else if (args[i].startsWith('--format=')) fmt = args[i].slice(9) + '\n';
      else if (args[i] === '-t' || args[i] === '--terse') terse = true;
      else if (args[i] === '-L' || args[i] === '--dereference') continue;
      else if (args[i] === '-f' || args[i] === '--file-system') throw userErr('stat: -f (the file system) is not available in this terminal');
      else if (args[i] === '--') {
        files.push(...args.slice(i + 1));
        break;
      } else if (args[i].startsWith('--')) throw userErr(`unrecognized option '${args[i]}'`);
      else if (args[i].startsWith('-') && args[i] !== '-') throw userErr(`invalid option -- '${args[i][1]}'`);
      else files.push(args[i]);
    }
    if (!files.length) throw userErr("stat: missing operand\nTry 'stat --help' for more information.");
    const zone = zoneOf(ctx);
    let code = 0;
    files.forEach((f) => {
      const e = ctx.fs.get(f) || deviceEntry(ctx.fs, f);
      if (!e) {
        ctx.err(`stat: cannot statx '${f}': No such file or directory\n`);
        code = 1;
        return;
      }
      const abs = ctx.fs.resolve(f), special = e.kind === 'dev' || e.kind === 'link';
      const size = e.kind === 'dir' ? (e.devdir ? 0 : 4096) : e.kind === 'dev' ? 0 : e.kind === 'link' ? e.to.length : ctx.fs.size(e), when = e.mtime || Date.now(), secs = Math.floor(when / 1000);
      const full = strftime('%Y-%m-%d %H:%M:%S.%N %z', when, zone);
      // (the time of the last reading: its own only when touch -a set it)
      const read = e.atime != null ? e.atime : when, fullRead = strftime('%Y-%m-%d %H:%M:%S.%N %z', read, zone), secsRead = Math.floor(read / 1000);
      const ms = { X: read, Y: when, Z: when };
      const kind = e.kind === 'dir' ? 'directory' : e.kind === 'dev' ? 'character special file' : e.kind === 'link' ? 'symbolic link' : size ? 'regular file' : 'regular empty file';
      const bits = e.kind === 'dev' ? 0o666 : e.kind === 'link' ? 0o777 : e.devdir ? 0o755 : permBits(e), mode = (e.kind === 'dir' ? 0o40000 : e.kind === 'dev' ? 0o20000 : e.kind === 'link' ? 0o120000 : 0o100000) | bits;
      const perms = e.kind === 'dev' ? 'crw-rw-rw-' : e.kind === 'link' ? 'lrwxrwxrwx' : e.devdir ? 'drwxr-xr-x' : permText(e);
      const blocks = special || e.devdir ? 0 : e.kind === 'dir' ? 8 : Math.ceil(size / 4096) * 8;
      const owner = e.protected ? 'root' : 'student', uid = e.protected ? 0 : 1000;
      // (a folder has two links, and one more for each folder in it)
      const links = e.kind === 'dir' && !e.devdir ? 2 + ctx.fs.list(abs).filter((c) => c.entry.kind === 'dir').length : 1;
      const inode = special || e.devdir ? 1 + (inodeOf(abs) % 999) : inodeOf(abs);
      const value = { s: size, n: f, N: e.kind === 'link' ? `'${f}' -> '${e.to}'` : `'${f}'`, y: full, z: full, x: fullRead, w: '-', Y: secs, Z: secs, X: secsRead, W: 0, F: kind, U: owner, G: owner, u: uid, g: uid, a: bits.toString(8), A: perms, b: blocks, B: 512, h: links, i: inode, o: 4096, f: mode.toString(16), t: e.kind === 'dev' ? e.major.toString(16) : 0, T: e.kind === 'dev' ? e.minor.toString(16) : 0, d: 2049, D: 801, m: '/' };
      if (fmt != null) {
        ctx.out(fmt.replace(/%([-0#+ ']*)(\d*)(?:\.(\d+))?([A-Za-z%!?])/g, (m, flags, width, prec, c) => {
          if (c === '%' && !flags && !width && prec == null) return '%';
          // (a letter that stat does not know: a question mark)
          if (!(c in value)) return '?';
          let v = String(value[c]);
          const number = typeof value[c] === 'number';
          if (prec != null && c in ms) {
            // %.3Y: the seconds with a fraction
            v = (ms[c] / 1000).toFixed(3) + '000000';
            v = +prec ? v.slice(0, v.indexOf('.') + 1 + Math.min(+prec, 9)) : v.slice(0, v.indexOf('.'));
          } else if (prec != null && number) v = v.padStart(+prec, '0');
          else if (prec != null) v = v.slice(0, +prec);
          if (flags.includes('#') && c === 'a' && v[0] !== '0') v = '0' + v;
          if (width) v = flags.includes('-') ? v.padEnd(+width) : v.padStart(+width, flags.includes('0') && prec == null && /^\d+$/.test(v) ? '0' : ' ');
          return v;
        }));
      } else if (terse) ctx.out(`${f} ${size} ${blocks} ${mode.toString(16)} ${uid} ${uid} 801 ${inode} ${links} ${value.t} ${value.T} ${secsRead} ${secs} ${secs} 0 4096\n`);
      else ctx.out(`  File: ${value.N.replace(/^'([^']*)'$/, '$1')}\n  Size: ${String(size).padEnd(10)}\tBlocks: ${String(blocks).padEnd(10)} IO Block: ${'4096'.padEnd(6)} ${kind}\nDevice: 8,1\tInode: ${String(inode).padEnd(10)}  Links: ${e.kind === 'dev' ? `${String(links).padEnd(5)} Device type: ${e.major},${e.minor}` : links}\nAccess: (${bits.toString(8).padStart(4, '0')}/${perms})  Uid: (${String(uid).padStart(5)}/${owner.padStart(8)})   Gid: (${String(uid).padStart(5)}/${owner.padStart(8)})\nAccess: ${fullRead}\nModify: ${full}\nChange: ${full}\n Birth: -\n`);
    });
    return code;
  };
  B.tree = (ctx) => {
    const args = ctx.args.slice();
    let depth = Infinity, all = false, dirsOnly = false, full = false, flat = false, classify = false, dirsFirst = false, report = true;
    const leave = [], only = [];
    const roots = [];
    const usage = '\nusage: tree [-adfiCF] [-L level] [-I pattern] [-P pattern] [--dirsfirst] [--noreport] [directory ...]';
    const level = (v) => {
      if (!/^\d+$/.test(v || '') || parseInt(v, 10) < 1) throw userErr('tree: Invalid level, must be greater than 0.', 1);
      return parseInt(v, 10);
    };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') {
        roots.push(...args.slice(i + 1));
        break;
      }
      if (a === '-L') {
        if (i + 1 >= args.length) throw userErr('tree: Missing argument to -L option.', 1);
        depth = level(args[++i]);
      } else if (/^-L./.test(a)) depth = level(a.slice(2));
      else if (a === '-I' || a === '-P') {
        if (i + 1 >= args.length) throw userErr(`tree: Missing argument to ${a} option.`, 1);
        (a === '-I' ? leave : only).push(...args[++i].split('|'));
      } else if (a === '--noreport') report = false;
      else if (a === '--dirsfirst') dirsFirst = true;
      else if (/^--/.test(a)) throw userErr(`tree: Invalid argument \`${a}'.${usage}`, 1);
      else if (/^-./.test(a)) {
        for (const c of a.slice(1)) {
          if (c === 'a') all = true;
          else if (c === 'd') dirsOnly = true;
          else if (c === 'f') full = true;
          else if (c === 'i') flat = true;
          else if (c === 'F') classify = true;
          else if (c === 'C' || c === 'n' || c === 'N') continue; // (colours: there are none here)
          else if (c === 'h' || c === 's') throw userErr(`tree: -${c} (sizes) is not available in this terminal. The sizes of all files:  ls -lhR   or   du -ah`, 1);
          else throw userErr(`tree: Invalid argument -\`${c}'.${usage}`, 1);
        }
      } else roots.push(a);
    }
    if (!roots.length) roots.push('.');
    const lines = [];
    let nd = 0, nf = 0, code = 0;
    const match = (list, name) => list.some((p) => MG.globRe(p).test(name));
    roots.forEach((root) => {
      if (!ctx.fs.isDir(root)) {
        lines.push(`${root}  [error opening dir]`);
        code = 2;
        return;
      }
      lines.push(root);
      const walk = (p, shown, pre, lvl) => {
        let kids = ctx.fs.list(p).filter((c) => (all || !c.name.startsWith('.')) && (!dirsOnly || c.entry.kind === 'dir') && !match(leave, c.name) && (c.entry.kind === 'dir' || !only.length || match(only, c.name)));
        if (dirsFirst) kids = kids.filter((c) => c.entry.kind === 'dir').concat(kids.filter((c) => c.entry.kind !== 'dir'));
        kids.forEach((c, i) => {
          const lastK = i === kids.length - 1, isDir = c.entry.kind === 'dir';
          const name = (full ? shown.replace(/\/$/, '') + '/' : '') + c.name + (classify ? (isDir ? '/' : c.entry.mode === 'x' ? '*' : '') : '');
          lines.push((flat ? '' : pre + (lastK ? '└── ' : '├── ')) + name);
          if (isDir) {
            nd++;
            if (lvl < depth) walk(c.path, shown.replace(/\/$/, '') + '/' + c.name, pre + (lastK ? '    ' : '│   '), lvl + 1);
          } else nf++;
        });
      };
      walk(ctx.fs.resolve(root), root, '', 1);
    });
    ctx.out(lines.join('\n') + '\n' + (report ? `\n${nd} director${nd === 1 ? 'y' : 'ies'}${dirsOnly ? '' : `, ${nf} file${nf === 1 ? '' : 's'}`}\n` : ''));
    return code;
  };
  /* mktemp [-d] [-u] [-p DIR] [-t] [--suffix=S] [TEMPLATE]: a new file (or folder, -d) with a name of its own;
     -u: only the name. Without a template the file is in /tmp. */
  B.mktemp = (ctx) => {
    let dir = false, dry = false, base = null, suffix = '', inTmp = false, tpl = null, quiet = false;
    // (the folder for temporary files: TMPDIR if it is set, or /tmp)
    const tmp = ctx.env.TMPDIR ? ctx.env.TMPDIR.replace(/(.)\/+$/, '$1') : '/tmp';
    const refuse = (text) => userErr(`mktemp: ${text}\nTry 'mktemp --help' for more information.`, 1);
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (a === '--') {
        if (i + 1 < ctx.args.length) tpl = ctx.args[i + 1];
        if (i + 2 < ctx.args.length) throw refuse('too many templates');
        break;
      }
      if (a === '--tmpdir') inTmp = true;
      else if (a === '--quiet') quiet = true;
      else if (/^--tmpdir=/.test(a)) base = a.slice(9);
      else if (/^--suffix=/.test(a)) suffix = a.slice(9);
      else if (a === '--suffix') {
        if (i + 1 >= ctx.args.length) throw refuse("option '--suffix' requires an argument");
        suffix = ctx.args[++i];
      } else if (a === '--directory') dir = true;
      else if (a === '--dry-run') dry = true;
      else if (/^--/.test(a)) throw refuse(`unrecognized option '${a}'`);
      else if (/^-./.test(a)) {
        // -d, -u, -t, -q, and -p FOLDER (also together: -dp FOLDER, -dt)
        for (let j = 1; j < a.length; j++) {
          const c = a[j];
          if (c === 'd') dir = true;
          else if (c === 'u') dry = true;
          else if (c === 't') inTmp = true;
          else if (c === 'q') quiet = true;
          else if (c === 'p') {
            if (j + 1 < a.length) base = a.slice(j + 1);
            else if (i + 1 < ctx.args.length) base = ctx.args[++i];
            else throw refuse("option requires an argument -- 'p'");
            break;
          } else throw refuse(`invalid option -- '${c}'`);
        }
      } else {
        if (tpl != null) throw refuse('too many templates');
        tpl = a;
      }
    }
    const fail = (msg) => {
      if (quiet) return 1;
      throw userErr(msg);
    };
    if (tpl != null && !/X{3,}/.test(tpl)) return fail(`mktemp: too few X's in template \u2018${tpl}\u2019`);
    if (tpl == null) {
      tpl = 'tmp.XXXXXXXXXX';
      inTmp = true;
    }
    if (base != null || inTmp) tpl = (base != null && base !== '' ? base.replace(/(.)\/+$/, '$1') : tmp) + '/' + tpl;
    const rnd = (n) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('');
    // (the last run of X is the one that is replaced)
    const path = tpl.replace(/X{3,}(?!.*X{3,})/, (m) => rnd(m.length)) + suffix;
    const parent = MG.path.dirname(ctx.fs.resolve(path));
    if (!ctx.fs.isDir(parent)) {
      if (parent !== '/tmp') return fail(`mktemp: failed to create ${dir ? 'directory' : 'file'} via template \u2018${tpl}\u2019: No such file or directory`);
      ctx.fs.mkdirp(parent);
    }
    if (!dry) {
      // (only its owner may read and write a temporary file: 600, a folder 700)
      if (dir) {
        ctx.fs.mkdirp(path);
        ctx.fs.chmod(path, { bits: 0o700 });
      } else {
        ctx.fs.writeText(path, '');
        ctx.fs.chmod(path, { bits: 0o600 });
      }
    }
    ctx.out(path + '\n');
  };
  B.download = async (ctx) => {
    if (MG.app && MG.app.term && MG.app.term.agentCmd) throw userErr('download: this saves a file to the computer of the person at the terminal – not available to the agent');
    const unknown = ctx.args.find((a) => /^-./.test(a));
    if (unknown) throw userErr(`download: unknown option ${unknown}\nusage: download FILE|FOLDER …   (saves a copy to your computer; a folder as a .zip)`);
    const files = ctx.args.filter((a) => !a.startsWith('-'));
    if (!files.length) throw userErr('usage: download FILE|FOLDER …   (saves a copy to your computer; a folder as a .zip)');
    for (const f of files) {
      const e = ctx.fs.get(f);
      if (!e) throw userErr(`download: ${f}: No such file or directory`);
      if (e.kind === 'dir') {
        // a folder: as a .zip (what the buttons "Download … as a .zip" do)
        const abs = ctx.fs.resolve(f), name = (MG.path.basename(abs) || 'home') + '.zip';
        const zipped = await MG.project.download(abs, name, {});
        if (zipped) ctx.out(`Saving ${name} (${MG.humanSize(zipped.size)}B) to your Downloads folder\n`);
        continue;
      }
      const blob = await ctx.fs.toBlob(f);
      MG.downloadBlob(blob, MG.path.basename(ctx.fs.resolve(f)));
      ctx.out(`Saving ${MG.path.basename(ctx.fs.resolve(f))} (${MG.humanSize(blob.size)}B) to your Downloads folder\n`);
    }
  };
  B.man = (ctx) => {
    const name = ctx.args.filter((a) => !a.startsWith('-'))[0];
    if (!name) throw userErr('What manual page do you want?\nFor example, try \'man samtools\'.');
    const t = MG.shellTools[name];
    if (t && t.man) return ctx.out(t.man + '\n');
    if (MG.shellBuiltins[name] && MG.shellHelp && MG.shellHelp(name)) return ctx.out(MG.shellHelp(name));
    if (MG.shellBuiltins[name]) return ctx.out(`${name}: a command of the shell itself (bash has it too). help lists what this terminal has.\n`);
    throw userErr(`No manual entry for ${name}`, 16);
  };

  MG.shellBuiltins = B;
  MG.shellTools = MG.shellTools || {};
  MG.Shell = Shell;
  MG.shellUtil = { ABSENT, notHere, printable, refuseOption, humanCeil, deviceEntry, inodeOf, byName, byVersion, columnsOf, getopts, userErr, inputOf, inherited, readOne, linesOf, fmtN, applySetFlags, suggest, absentNote, unesc, Sink, innerIO, unwrap, bytesText, joinBytes, SET_NAMES, SET_IDLE_NAMES, strftime: (fmt, d, zone) => strftime(fmt, d, zone), zoneUTC: (ctx) => zoneOf(ctx) };
})();
