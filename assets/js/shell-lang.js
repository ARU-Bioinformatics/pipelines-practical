/* =====================================================================
   The language of the terminal: a large subset of bash.

   Lists (; && ||), pipelines (| and !), redirection (> >> < 2> 2>&1 >&2
   &> and here-documents), quoting, variables and ${…} expansions, arrays,
   command substitution $( ), arithmetic $(( )), globs and {a,b} braces,
   if / for / while / until / case, [ ] and [[ ]], functions, { } groups,
   ( ) subshells, and scripts (bash script.sh, set -euo pipefail, exit).

   Process substitution <( ) runs its commands first and hands over a file. Not there: background jobs (&), coprocesses,
   signals. The programs of a pipeline run one after the other.

   lex → parse (a syntax tree) → run. Words are expanded just before a
   command runs, as in bash.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const Shell = MG.Shell;
  const B = MG.shellBuiltins;
  const { userErr, applySetFlags, linesOf, inputOf, Sink, innerIO } = MG.shellUtil;
  const T0 = Date.now();
  const MAX_LOOP = 200000;

  /* break, continue, return and exit travel up as exceptions */
  class Ctl {
    constructor(kind, code, n) {
      this.kind = kind;
      this.code = code || 0;
      this.n = n || 1;
      this.shellControl = true;
    }
  }
  /* Errors of the language itself. As in bash there are two kinds:
     - lineErr: a word that cannot be expanded – a bad substitution, a division by 0, a wrong expression. The command
       it stands in is given up with all that belongs to it (the rest of the line, the whole if / loop / function
       call), its status is 1, and a script goes on with its next line. (With set -e the script ends.)
     - unsetErr: an unset variable under set -u, ${NAME:?message}. A script ends there (status 1; bash -c: 127).
     shErr without more: what this terminal cannot do – that ends a script too. */
  const shErr = (msg, code) => Object.assign(new Error(msg), { shellError: true, code: code || 1 });
  const lineErr = (msg) => Object.assign(shErr(msg), { endsLine: true });
  // (an error in an arithmetic expression ends the line as well – but, unlike the others, not the script under set -e)
  const arithErr = (msg) => Object.assign(lineErr(msg), { arith: true });
  // a redirection that cannot be carried out (> $empty): that command fails, the line goes on
  const cmdErr = (msg) => Object.assign(userErr('bash: ' + msg), { cmdFail: true });
  const unsetErr = (msg) => Object.assign(shErr(msg), { unset: true });
  /* set -u – and its shadow. In an AI agent's run the commands run without -e and -u, but the script that the page
     writes from the run (rerun.sh) has both. So the shell notes, while such a command runs, where they WOULD have
     ended it: flags.se / flags.su are "what -e / -u would be, had the session begun with set -eu" (they follow set
     +e, set -u … and are switched off where bash switches -e off), and flags.sl is the note: { e: how often a
     command failed where -e ends a script, u: the names that had no value }. (assistant.js sets and reads them.) */
  const nounset = (st, name) => {
    if (st.flags.u) return true;
    const log = st.flags.su && st.flags.sl;
    if (log && log.u.length < 12 && !log.u.includes(name)) log.u.push(name);
    return false;
  };
  const synErr = (msg, pos, incomplete) => Object.assign(new Error(msg), { syntax: true, pos: pos || 0, incomplete: !!incomplete });

  /* ------------------------------------------------------------------
     scanning quoted and bracketed text: each returns the index after it
     ------------------------------------------------------------------ */
  function scanSq(s, j) {
    if (j > 0 && s[j - 1] === '$') {
      // $'…': a backslash takes the next character with it ($'it\'s')
      for (let k = j + 1; k < s.length; k++) {
        if (s[k] === '\\') k++;
        else if (s[k] === "'") return k + 1;
      }
      throw synErr("unexpected EOF while looking for matching `''", j, true);
    }
    const k = s.indexOf("'", j + 1);
    if (k < 0) throw synErr("unexpected EOF while looking for matching `''", j, true);
    return k + 1;
  }
  function scanDq(s, j) {
    const start = j++;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\') j += 2;
      else if (c === '"') return j + 1;
      else if (c === '$' && s[j + 1] === '(') j = scanSub(s, j + 1);
      else if (c === '$' && s[j + 1] === '{') j = scanBrace(s, j + 1);
      else if (c === '`') j = scanBq(s, j);
      else j++;
    }
    throw synErr('unexpected EOF while looking for matching `"\'', start, true);
  }
  function scanBq(s, j) {
    const start = j++;
    while (j < s.length) {
      if (s[j] === '\\') j += 2;
      else if (s[j] === '`') return j + 1;
      else j++;
    }
    throw synErr('unexpected EOF while looking for matching ``\'', start, true);
  }
  function scanParen(s, j) {
    const start = j;
    let depth = 0;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\') j += 2;
      else if (c === "'") j = scanSq(s, j);
      else if (c === '"') j = scanDq(s, j);
      else if (c === '`') j = scanBq(s, j);
      else {
        if (c === '(') depth++;
        else if (c === ')' && --depth === 0) return j + 1;
        j++;
      }
    }
    throw synErr("unexpected EOF while looking for matching `)'", start, true);
  }
  /** the end of $( commands ), <( commands ) and >( commands ): s[j] is the bracket → the index after the bracket
      that closes it. What stands between is read as commands are read, so a ) that is no end stays one: the ) after a
      pattern of case, a ) in a comment or in a here-document. ($(( … )) is arithmetic: its brackets are counted.) */
  function scanSub(s, j) {
    if (s[j + 1] !== '(') return lexer(s, j + 1, { sub: true }).end;
    try {
      return scanParen(s, j);
    } catch (e) {
      if (e && e.syntax) e.eofLine = true; // (bash reports the line after the last one)
      throw e;
    }
  }
  /** $[ … ], the old way of writing $(( … )) */
  function scanBracket(s, j) {
    const start = j;
    let depth = 0;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\') j += 2;
      else {
        if (c === '[') depth++;
        else if (c === ']' && --depth === 0) return j + 1;
        j++;
      }
    }
    throw synErr("unexpected EOF while looking for matching `]'", start, true);
  }
  /** ${ … }: s[j] is the { → the index after the } that ends it. As in bash that is the first } which is not
      quoted and not part of a ${ }, $( ) or ` ` inside – a { by itself is a character like any other
      (${x:-{a,b}} is ${x:-{a,b} and a }). */
  function scanBrace(s, j) {
    const start = j;
    j++;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\') j += 2;
      else if (c === '"') j = scanDq(s, j);
      else if (c === '$' && s[j + 1] === '(') j = scanSub(s, j + 1);
      else if (c === '$' && s[j + 1] === '{') j = scanBrace(s, j + 1);
      else if (c === '`') j = scanBq(s, j);
      else if (c === '$' && s[j + 1] === "'") {
        // $'…': to the ' that ends it (a \' inside does not)
        j += 2;
        while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1;
        j++;
      } else if (c === "'") j = scanSq(s, j); // ('…' holds a } that does not end it – also where the expansion stands in "…": bash reads it so)
      else if (c === '}') return j + 1;
      else j++;
    }
    throw synErr("unexpected EOF while looking for matching `}'", start, true);
  }
  /** NAME=…, NAME+=…, NAME[subscript]=… at the start of a word → { name, sub, plus, rest }. The subscript may hold
      brackets of its own: arr[${#arr[@]}]=x */
  function assignHead(raw) {
    const m = /^[A-Za-z_]\w*/.exec(raw);
    if (!m) return null;
    let j = m[0].length, sub;
    if (raw[j] === '[') {
      let depth = 0, k = j;
      for (; k < raw.length; k++) {
        const c = raw[k];
        if (c === '\\') k++;
        else if (c === '[') depth++;
        else if (c === ']' && --depth === 0) break;
      }
      if (k >= raw.length) return null;
      sub = raw.slice(j + 1, k);
      j = k + 1;
    }
    const plus = raw[j] === '+';
    if (plus) j++;
    if (raw[j] !== '=') return null;
    return { name: m[0], sub, plus, rest: raw.slice(j + 1) };
  }
  const ASSIGN = { test: (raw) => !!assignHead(raw) };
  /** the words between the brackets of NAME=( … ): split at blanks outside quotes; [a key with blanks]=value is one */
  function compoundWords(text) {
    const out = [], n = text.length;
    let i = 0;
    while (i < n) {
      while (i < n && /[ \t\n]/.test(text[i])) i++;
      if (i >= n) break;
      if (text[i] === '#') {
        while (i < n && text[i] !== '\n') i++;
        continue;
      }
      const start = i;
      let inKey = false;
      while (i < n) {
        const c = text[i];
        if (c === '\\') i += 2;
        else if (c === "'") i = scanSq(text, i);
        else if (c === '"') i = scanDq(text, i);
        else if (c === '`') i = scanBq(text, i);
        else if (c === '$' && text[i + 1] === '(') i = scanSub(text, i + 1);
        else if ((c === '<' || c === '>') && text[i + 1] === '(') i = scanSub(text, i + 1);
        else if (c === '$' && text[i + 1] === '{') i = scanBrace(text, i + 1);
        else if (c === '[' && i === start) {
          inKey = true;
          i++;
        } else if (c === ']' && inKey) {
          inKey = false;
          i++;
        } else if (/[ \t\n]/.test(c) && !inKey) break;
        else i++;
      }
      out.push(text.slice(start, Math.min(i, n)));
    }
    return out;
  }

  /* ------------------------------------------------------------------
     lexer: words (kept as written), operators, redirections
     ------------------------------------------------------------------ */
  const OPENS_COMMAND = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!', '{', 'time']);
  function lex(src, opts) {
    return lexer(src, 0, opts || {}).toks;
  }
  /* opts.sub: the text from "from" on is the inside of $( … ): read up to the bracket that closes it → { end }.
     opts.eofHeredoc: a here-document whose last line is missing takes the rest of the text, with a warning – as bash
     does in a script (at the prompt the terminal waits for the line instead). */
  /* extglob. bash reads the groups of patterns – ?(a|b) *(a|b) +(a|b) @(a|b) !(a|b) – only while its option extglob
     is on (and always inside [[ ]]): with it off, a bracket straight after one of these characters is a syntax error.
     The option is off in a script and in bash -c until  shopt -s extglob  was carried out there; at the prompt of a
     terminal on Linux it is on as a rule (bash-completion turns it on) – and so it is at the prompt here.
     EXTGLOB: null – the groups are read wherever they stand (a text that is only looked at; a !( where a command
     begins is taken as "not" with a subshell there); true / false – as bash with the option on / off.
     opts.extglob sets it for a text; a line of that text with the command  shopt -s extglob  or  shopt -u extglob
     changes it from the next line on (bash has read the rest of that line before the command is carried out). */
  let EXTGLOB = null;
  function lexer(src, from, opts) {
    const before = EXTGLOB;
    if (typeof opts.extglob === 'boolean') EXTGLOB = opts.extglob;
    try {
      return lexer1(src, from, opts);
    } finally {
      EXTGLOB = before;
    }
  }
  function lexer1(src, from, opts) {
    const toks = [];
    toks.warnings = [];
    const n = src.length;
    let i = from, cmdPos = true;
    const follows = typeof opts.extglob === 'boolean';
    const shoptLine = () => {
      let k = toks.length;
      while (k > 0 && !(toks[k - 1].t === 'op' && toks[k - 1].v === '\n')) k--;
      let words = [];
      const done = () => {
        while (words.length && ['then', 'do', 'else', '{', '!', 'time'].includes(words[0])) words.shift();
        if (words[0] === 'shopt' && words.includes('extglob')) {
          const f = words.filter((w) => /^-[a-z]+$/.test(w)).join('');
          if (f.includes('s')) EXTGLOB = true;
          else if (f.includes('u')) EXTGLOB = false;
        }
        words = [];
      };
      for (; k < toks.length; k++) {
        if (toks[k].t === 'w') words.push(toks[k].raw);
        else if (toks[k].t === 'op') done();
      }
      done();
    };
    const pending = [];
    // (for opts.sub) the brackets that are open, and the case … esac blocks: { depth, state } with state 'word' (the
    // word after case), 'in', 'pat' (a pattern list: its ) closes nothing) and 'body'
    let depth = 0;
    const cases = [];
    const topCase = () => (cases.length && cases[cases.length - 1].depth === depth ? cases[cases.length - 1] : null);
    function scanWord(j, condMode) {
      const start = j;
      while (j < n) {
        const c = src[j];
        if (c === '\\') j += 2;
        else if (c === "'") j = scanSq(src, j);
        else if (c === '"') j = scanDq(src, j);
        else if (c === '`') j = scanBq(src, j);
        else if (c === '$' && src[j + 1] === '(') j = scanSub(src, j + 1);
        else if (c === '$' && src[j + 1] === '{') j = scanBrace(src, j + 1);
        else if (c === '$' && src[j + 1] === '[') j = scanBracket(src, j + 1);
        else if (c === '(' && !condMode && /^[A-Za-z_]\w*\+?=$/.test(src.slice(start, j))) j = scanParen(src, j); // NAME=(an array)
        else if (c === '[' && !condMode && cmdPos && j > start && /^[A-Za-z_]\w*$/.test(src.slice(start, j))) {
          // NAME[subscript]=value where a command begins: the subscript belongs to the word, blanks and all (a[i + 1]=x)
          let k = -1;
          try {
            k = scanBracket(src, j);
          } catch (e) {
            if (!e.syntax) throw e;
          }
          j = k > 0 && !src.slice(j, k).includes('\n') && (src[k] === '=' || (src[k] === '+' && src[k + 1] === '=')) ? k : j + 1;
        }
        else if ((c === '<' || c === '>') && src[j + 1] === '(' && src[j - 1] === '=' && j > start) j = scanSub(src, j + 1); // x=<( … ), --file=<( … )
        else if (c === '(' && j > start && '?*+@!'.includes(src[j - 1]) && (condMode ? j - 1 > start || src[j - 1] !== '!' : EXTGLOB == null ? j - 1 > start || src[j - 1] !== '!' || !cmdPos : EXTGLOB)) j = scanParen(src, j); // *.@(fq|fastq), +(a), !(*.gz): a group of patterns
        else if (c === ' ' || c === '\t' || c === '\n') break;
        else if (!condMode && '|&;()<>'.includes(c)) break;
        else j++;
      }
      return Math.min(j, n);
    }
    function readHeredocs() {
      for (const hd of pending) {
        let body = '', found = false;
        hd.bodyStart = i;
        while (i < n) {
          let j = src.indexOf('\n', i);
          if (j < 0) j = n;
          const line = src.slice(i, j);
          i = Math.min(n, j + 1);
          const cmp = hd.strip ? line.replace(/^\t+/, '') : line;
          if (cmp === hd.delim) {
            found = true;
            break;
          }
          body += cmp + '\n';
        }
        if (!found) {
          if (!opts.eofHeredoc) throw synErr(`here-document delimited by end-of-file (wanted \`${hd.delim}')`, hd.pos, true);
          toks.warnings.push({ pos: hd.pos, delim: hd.delim });
        }
        hd.body = body;
        hd.bodyEnd = i;
      }
      pending.length = 0;
    }
    while (i < n) {
      const c = src[i];
      // (blanks and tabs separate words. A carriage return does not: it is a character of the word it stands in –
      // which is why a script with the line ends of Windows fails on Linux, and here)
      if (c === ' ' || c === '\t') {
        i++;
        continue;
      }
      if (c === '\\' && src[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (c === '\n') {
        if (follows) shoptLine();
        toks.push({ t: 'op', v: '\n', pos: i, end: i + 1 });
        i++;
        cmdPos = true;
        if (pending.length) readHeredocs();
        continue;
      }
      if (c === '#') {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (c === '&' && src[i + 1] === '>') {
        const app = src[i + 2] === '>';
        toks.push({ t: 'redir', v: app ? '&>>' : '&>', fd: null, pos: i, end: i + (app ? 3 : 2) });
        i += app ? 3 : 2;
        continue;
      }
      if ((c === '<' || c === '>') && src[i + 1] === '(') {
        // <( commands ), >( commands ): process substitution – a word, which becomes the name of a file (see _psub)
        const e = scanWord(scanSub(src, i + 1));
        toks.push({ t: 'w', raw: src.slice(i, e), pos: i, end: e });
        i = e;
        cmdPos = false;
        continue;
      }
      const m = /^(\d*)(<<<|<<-|<<|<&|<>|<|>>|>&|>\||>)/.exec(src.slice(i, i + 12));
      if (m) {
        const tok = { t: 'redir', v: m[2] === '>|' ? '>' : m[2], fd: m[1] === '' ? null : +m[1], pos: i, clobber: m[2] === '>|' };
        i += m[0].length;
        tok.end = i;
        if ((tok.v === '<' || tok.v === '>') && src[i] === '(') throw synErr(`${m[0]}( ): write a space before the bracket – 2> >( commands )`, tok.pos);
        if (tok.v === '<<' || tok.v === '<<-') {
          while (src[i] === ' ' || src[i] === '\t') i++;
          const e = scanWord(i);
          if (e === i) throw synErr("syntax error near unexpected token `newline'", i, i >= n);
          const rawDelim = src.slice(i, e);
          i = e;
          tok.end = e;
          tok.quoted = /['"\\]/.test(rawDelim);
          tok.rawDelim = rawDelim;
          tok.delim = rawDelim.replace(/['"\\]/g, '');
          tok.strip = tok.v === '<<-';
          tok.v = '<<';
          tok.body = null;
          pending.push(tok);
        }
        toks.push(tok);
        continue;
      }
      const two = src.slice(i, i + 2);
      if (two === '((' && (cmdPos || (toks.length && toks[toks.length - 1].t === 'w' && toks[toks.length - 1].raw === 'for'))) {
        // (( arithmetic )) – or two subshells; it is arithmetic when the brackets close together
        let inner = -1;
        try {
          inner = scanParen(src, i + 1);
        } catch (e) {
          if (!e.syntax) throw e;
        }
        if (inner > 0 && src[inner] === ')') {
          toks.push({ t: 'arith', expr: src.slice(i + 2, inner - 1), pos: i, end: inner + 1 });
          i = inner + 1;
          cmdPos = false;
          continue;
        }
      }
      if (src.startsWith(';;&', i)) {
        toks.push({ t: 'op', v: ';;&', pos: i, end: i + 3 });
        i += 3;
        cmdPos = true;
        if (topCase() && topCase().state === 'body') topCase().state = 'pat';
        continue;
      }
      if (two === '&&' || two === '||' || two === ';;' || two === '|&' || two === ';&') {
        toks.push({ t: 'op', v: two, pos: i, end: i + 2 });
        i += 2;
        cmdPos = true;
        if ((two === ';;' || two === ';&') && topCase() && topCase().state === 'body') topCase().state = 'pat';
        continue;
      }
      if ('|&;()'.includes(c)) {
        // (extglob off, inside $( … ): a bracket straight after ? * + @ ! is the group of patterns that bash does not
        // read there – a syntax error of the line, found when the line is read)
        if (c === '(' && opts.sub && EXTGLOB === false) {
          const pt = toks[toks.length - 1];
          if (pt && pt.t === 'w' && pt.end === i && pt.raw !== '!' && /[?*+@!]$/.test(pt.raw)) throw synErr("syntax error near unexpected token `('", i);
        }
        if (opts.sub && (c === '(' || c === ')')) {
          const tc = topCase();
          if (tc && tc.state === 'pat') {
            // ( pattern ) of case: the ) ends the patterns, and no bracket
            if (c === ')') tc.state = 'body';
          } else if (c === '(') depth++;
          else if (depth === 0) return { toks, end: i + 1 };
          else depth--;
        }
        toks.push({ t: 'op', v: c, pos: i, end: i + 1 });
        i++;
        cmdPos = true;
        continue;
      }
      const e = scanWord(i);
      const raw = src.slice(i, e);
      if (opts.sub) {
        const tc = topCase();
        if (tc && tc.state === 'word') tc.state = 'in';
        else if (tc && tc.state === 'in' && raw === 'in') tc.state = 'pat';
        else if (tc && raw === 'esac' && (tc.state === 'pat' || (tc.state === 'body' && cmdPos))) cases.pop();
        else if (raw === 'case' && cmdPos && !(tc && tc.state === 'pat')) cases.push({ depth, state: 'word' });
      }
      if (cmdPos && raw === '[[') {
        let j = e;
        const words = [];
        for (;;) {
          while (j < n && /[ \t\n]/.test(src[j])) j++;
          if (j >= n) throw synErr("unexpected end of file while looking for `]]'", i, true);
          if (src.startsWith(']]', j)) {
            j += 2;
            break;
          }
          const k = scanWord(j, true);
          const w = src.slice(j, k);
          j = k;
          if (w === ']]') break;
          words.push(w);
        }
        toks.push({ t: 'cond', words, pos: i, end: j });
        i = j;
        cmdPos = false;
        continue;
      }
      toks.push({ t: 'w', raw, pos: i, end: e });
      i = e;
      cmdPos = OPENS_COMMAND.has(raw) || (cmdPos && ASSIGN.test(raw));
    }
    if (pending.length) {
      if (!opts.eofHeredoc) throw synErr(`here-document delimited by end-of-file (wanted \`${pending[0].delim}')`, pending[0].pos, true);
      pending.forEach((hd) => {
        toks.warnings.push({ pos: hd.pos, delim: hd.delim });
        hd.body = '';
        hd.bodyStart = hd.bodyEnd = n;
      });
    }
    if (opts.sub) throw Object.assign(synErr("unexpected EOF while looking for matching `)'", from, true), { eofLine: true });
    return { toks, end: n };
  }

  /* ------------------------------------------------------------------
     parser → syntax tree
     ------------------------------------------------------------------ */
  function parse(src, opts) {
    const toks = lex(src, opts);
    const nl = [];
    for (let k = 0; k < src.length; k++) if (src[k] === '\n') nl.push(k);
    const lineAt = (pos) => {
      let lo = 0, hi = nl.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (nl[mid] < pos) lo = mid + 1;
        else hi = mid;
      }
      return lo + 1;
    };
    let p = 0;
    const peek = (k = 0) => toks[p + k];
    const isOp = (t, v) => !!t && t.t === 'op' && (v === undefined || t.v === v);
    const isW = (t, raw) => !!t && t.t === 'w' && (raw === undefined || t.raw === raw);
    const show = (t) => (t.t === 'op' ? (t.v === '\n' ? 'newline' : t.v) : t.t === 'w' ? MG.shellUtil.printable(t.raw) : t.t === 'redir' ? t.v : t.t === 'cond' ? '[[' : '((');
    const unexpected = (t) => (t ? synErr(`syntax error near unexpected token \`${show(t)}'`, t.pos) : synErr('syntax error: unexpected end of file', src.length, true));
    const skipNl = () => {
      while (isOp(peek(), '\n')) p++;
    };
    const skipSep = () => {
      while (isOp(peek(), '\n') || isOp(peek(), ';')) p++;
    };
    const expectW = (raw) => {
      const t = peek();
      if (!isW(t, raw)) throw unexpected(t);
      p++;
      return t;
    };
    const spanEnd = (from) => {
      let e = 0;
      for (let k = from; k < p; k++) e = Math.max(e, toks[k].bodyEnd || toks[k].end);
      return e;
    };

    // the end of a clause of case: ;;  (and ;& – go on with the next clause, ;;& – test the next patterns too)
    const endsClause = (t) => isOp(t, ';;') || isOp(t, ';&') || isOp(t, ';;&');
    // if, then, else, do, { } and ( ) need at least one command: "then" with nothing but a comment before "fi" is a
    // syntax error in bash, and here
    const some = (list) => {
      if (!list.items.length) throw unexpected(peek() || null);
      return list;
    };
    function parseList(stops) {
      const items = [];
      for (;;) {
        skipNl();
        const t = peek();
        if (!t || isOp(t, ')') || endsClause(t)) break;
        if (t.t === 'w' && stops && stops.has(t.raw)) break;
        // (a ; needs a command before it: ";" alone, "then ; fi", "a ; ; b" are syntax errors)
        if (isOp(t, ';')) throw unexpected(t);
        items.push(parseAndOr());
        const s = peek();
        if (!s) break;
        if (isOp(s, '&')) throw synErr('background jobs (&) are not available in this terminal: run one command after the other', s.pos);
        if (isOp(s, ';')) {
          p++;
          continue;
        }
        if (isOp(s, '\n') || isOp(s, ')') || endsClause(s)) continue;
        if (s.t === 'w' && stops && stops.has(s.raw)) continue;
        throw unexpected(s);
      }
      return { type: 'list', items };
    }
    function parseAndOr() {
      const start = p;
      const first = parsePipe();
      const rest = [];
      while (isOp(peek(), '&&') || isOp(peek(), '||')) {
        const op = toks[p++].v;
        skipNl();
        if (!peek()) throw unexpected(null);
        rest.push({ op, pipe: parsePipe() });
      }
      return { type: 'andor', first, rest, pos: toks[start].pos, end: spanEnd(start), line: lineAt(toks[start].pos) };
    }
    function parsePipe() {
      let negate = false, timed = false;
      for (;;) {
        const t = peek();
        if (isW(t, '!')) negate = !negate;
        else if (isW(t, 'time')) timed = true;
        else break;
        p++;
        if (timed && isW(peek(), '-p')) {
          timed = 'p';
          p++;
        }
        if (timed && isW(peek(), '--')) {
          timed = 'p';
          p++;
        }
      }
      if (!peek()) throw unexpected(null);
      const cmds = [parseCommand()];
      while (isOp(peek(), '|') || isOp(peek(), '|&')) {
        if (toks[p++].v === '|&') (cmds[cmds.length - 1].redirs = cmds[cmds.length - 1].redirs || []).push({ op: '>&', fd: 2, target: '1' });
        skipNl();
        if (!peek()) throw unexpected(null);
        cmds.push(parseCommand());
      }
      return { type: 'pipe', negate, timed, cmds };
    }
    function parseRedir() {
      const t = toks[p++];
      if (t.v === '<<') return { op: '<<', fd: t.fd, body: t.body, quoted: t.quoted, delim: t.delim, rawDelim: t.rawDelim, strip: t.strip };
      const w = peek();
      // (> with nothing after it: "syntax error near unexpected token `newline'", at the prompt too)
      if (!w) throw synErr("syntax error near unexpected token `newline'", t.pos);
      if (!isW(w)) throw unexpected(w);
      p++;
      return { op: t.v, fd: t.fd, target: w.raw, clobber: !!t.clobber };
    }
    function withRedirs(node) {
      node.redirs = node.redirs || [];
      while (peek() && peek().t === 'redir') node.redirs.push(parseRedir());
      return node;
    }
    /** Does a compound command start here – { }, ( ), (( )), [[ ]], if, for, while, until, case? (The body of a function
        has to be one:  f() echo x  is a syntax error in bash.) */
    const compoundNext = () => {
      const t = peek();
      return !!t && ((t.t === 'op' && t.v === '(') || t.t === 'arith' || t.t === 'cond' || (t.t === 'w' && /^(if|for|while|until|case|\{|select)$/.test(t.raw)));
    };
    function parseCommand() {
      const t = peek();
      if (!t) throw unexpected(null);
      const start = p;
      const done = (node) => {
        node.pos = toks[start].pos;
        node.end = spanEnd(start);
        node.line = lineAt(node.pos);
        return node;
      };
      if (t.t === 'op') {
        if (t.v === '(') {
          p++;
          const body = some(parseList(null));
          if (!isOp(peek(), ')')) throw unexpected(peek() || null);
          p++;
          return done(withRedirs({ type: 'subshell', body }));
        }
        throw unexpected(t);
      }
      if (t.t === 'arith') {
        p++;
        return done(withRedirs({ type: 'arith', expr: t.expr }));
      }
      if (t.t === 'cond') {
        p++;
        return done(withRedirs({ type: 'cond', words: t.words }));
      }
      if (t.t === 'redir') return done(parseSimple());
      switch (t.raw) {
        case 'if':
          return done(withRedirs(parseIf()));
        case 'for':
          return done(withRedirs(parseFor()));
        case 'while':
        case 'until':
          return done(withRedirs(parseWhile()));
        case 'case':
          return done(withRedirs(parseCase()));
        case '{': {
          p++;
          const body = some(parseList(new Set(['}'])));
          expectW('}');
          return done(withRedirs({ type: 'group', body }));
        }
        case 'function': {
          p++;
          const name = peek();
          if (!isW(name)) throw unexpected(name || null);
          p++;
          if (isOp(peek(), '(') && isOp(peek(1), ')')) p += 2;
          skipNl();
          if (!peek()) throw unexpected(null);
          if (!compoundNext()) throw unexpected(peek());
          return done({ type: 'func', name: name.raw, body: parseCommand(), src });
        }
        case 'then':
        case 'fi':
        case 'do':
        case 'done':
        case 'elif':
        case 'else':
        case 'esac':
        case '}':
          throw unexpected(t);
      }
      // (a function can have nearly any name: ns::fn, do-it, step.1)
      if (/^[A-Za-z0-9_][\w.:+@,%^~\/-]*$/.test(t.raw) && !/^\d+$/.test(t.raw) && isOp(peek(1), '(') && isOp(peek(2), ')')) {
        p += 3;
        skipNl();
        if (!peek()) throw unexpected(null);
        if (!compoundNext()) throw unexpected(peek());
        return done({ type: 'func', name: t.raw, body: parseCommand(), src });
      }
      return done(parseSimple());
    }
    function parseSimple() {
      const node = { type: 'simple', assigns: [], words: [], redirs: [] };
      for (;;) {
        const t = peek();
        if (!t) break;
        if (t.t === 'redir') node.redirs.push(parseRedir());
        else if (t.t === 'w') {
          if (!node.words.length && ASSIGN.test(t.raw)) node.assigns.push(t.raw);
          else node.words.push(t.raw);
          p++;
        } else break;
      }
      return node;
    }
    function parseIf() {
      p++;
      const clauses = [];
      let orelse = null;
      for (;;) {
        const cond = some(parseList(new Set(['then'])));
        expectW('then');
        const body = some(parseList(new Set(['elif', 'else', 'fi'])));
        clauses.push({ cond, body });
        const t = peek();
        if (isW(t, 'elif')) {
          p++;
          continue;
        }
        if (isW(t, 'else')) {
          p++;
          orelse = some(parseList(new Set(['fi'])));
        }
        expectW('fi');
        break;
      }
      return { type: 'if', clauses, orelse };
    }
    function parseBody() {
      skipSep();
      expectW('do');
      const body = some(parseList(new Set(['done'])));
      expectW('done');
      return body;
    }
    function parseFor() {
      p++;
      const t = peek();
      if (t && t.t === 'arith') {
        // for (( i = 0; i < n; i++ ))
        p++;
        const parts = t.expr.split(';');
        if (parts.length !== 3) throw synErr('syntax error: for (( )) needs three expressions', t.pos);
        return { type: 'cfor', init: parts[0], test: parts[1], step: parts[2], body: parseBody() };
      }
      if (!isW(t) || !/^[A-Za-z_]\w*$/.test(t.raw)) throw unexpected(t || null);
      p++;
      skipNl();
      let words = null;
      if (isW(peek(), 'in')) {
        p++;
        words = [];
        while (isW(peek())) words.push(toks[p++].raw);
      }
      return { type: 'for', name: t.raw, words, body: parseBody() };
    }
    function parseWhile() {
      const until = toks[p++].raw === 'until';
      const cond = some(parseList(new Set(['do'])));
      expectW('do');
      const body = some(parseList(new Set(['done'])));
      expectW('done');
      return { type: 'while', until, cond, body };
    }
    function parseCase() {
      p++;
      const w = peek();
      if (!isW(w)) throw unexpected(w || null);
      p++;
      skipNl();
      expectW('in');
      const clauses = [];
      for (;;) {
        skipSep();
        const t = peek();
        if (!t) throw unexpected(null);
        if (isW(t, 'esac')) {
          p++;
          break;
        }
        if (isOp(t, '(')) p++;
        const patterns = [];
        for (;;) {
          const q = peek();
          if (!isW(q)) throw unexpected(q || null);
          patterns.push(q.raw);
          p++;
          if (isOp(peek(), '|')) {
            p++;
            continue;
          }
          break;
        }
        if (!isOp(peek(), ')')) throw unexpected(peek() || null);
        p++;
        const body = parseList(new Set(['esac']));
        const end = peek() && endsClause(peek()) ? toks[p++].v : ';;';
        clauses.push({ patterns, body, end });
      }
      return { type: 'case', word: w.raw, clauses };
    }

    const list = parseList(null);
    if (p < toks.length) throw unexpected(toks[p]);
    list.src = src;
    // (here-documents that the end of the text ended: said when the command they belong to is reached)
    list.warnings = toks.warnings.map((w) => ({ pos: w.pos, text: `warning: here-document at line ${lineAt(w.pos)} delimited by end-of-file (wanted \`${w.delim}')` }));
    return list;
  }
  /** a syntax error as bash reports it in a script and in bash -c: "PREFIXline N: MESSAGE" and, where a word was not
      expected, the line it stands in. At the end of the text the line is the one after the last. */
  function synReport(prefix, text, e) {
    const lines = text.split('\n');
    const count = lines.length - (text.endsWith('\n') ? 1 : 0);
    const eof = e.incomplete && (/unexpected end of file$/.test(e.message) || e.eofLine);
    const at = eof ? count + 1 : Math.max(1, Math.min(text.slice(0, e.pos).split('\n').length, Math.max(count, 1)));
    let out = `${prefix}line ${at}: ${e.message}\n`;
    if (/^syntax error near unexpected token/.test(e.message)) out += `${prefix}line ${at}: \`${lines[at - 1] || ''}'\n`;
    return out;
  }

  /** The commands inside $( ) and `…` of a word, as texts. Inside "…" they count too – and there an apostrophe is
      only an apostrophe ("it's"); inside '…' nothing counts. A word that cannot be read gives none. */
  function substitutions(raw) {
    const out = [];
    try {
      let dq = false;
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '\\') i++;
        else if (c === '"') dq = !dq;
        else if (c === "'" && !dq) {
          if (raw[i - 1] === '$') {
            // $'…': a backslash takes the next character with it
            for (i++; i < raw.length && raw[i] !== "'"; i++) if (raw[i] === '\\') i++;
          } else i = scanSq(raw, i) - 1;
        } else if (c === '$' && raw[i + 1] === '(' && raw[i + 2] !== '(') {
          const e = scanSub(raw, i + 1);
          out.push(raw.slice(i + 2, e - 1));
          i = e - 1;
        } else if (c === '`') {
          const e = scanBq(raw, i);
          out.push(raw.slice(i + 1, e - 1));
          i = e - 1;
        } else if ((c === '<' || c === '>') && raw[i + 1] === '(' && !dq) {
          // <( commands ), >( commands )
          const e = scanSub(raw, i + 1);
          out.push(raw.slice(i + 2, e - 1));
          i = e - 1;
        }
      }
    } catch (e) {
      /* an odd word: what was found so far */
    }
    return out;
  }
  /** the top-level commands of a text, each as it was written (an if … fi block is one command) */
  function statements(src, opts) {
    const items = parse(src, opts).items, out = [];
    for (let i = 0; i < items.length; i++) {
      const from = items[i].pos;
      let end = items[i].end;
      // (a second command on the line that opens a here-document –  cat > a.txt <<EOF; echo done  – : the text of the
      // first reaches to the end of the document, and so holds the second. The two stay one piece.)
      while (i + 1 < items.length && items[i + 1].pos < end) end = Math.max(end, items[++i].end);
      out.push(src.slice(from, end).trim());
    }
    return out;
  }
  /** Is this text ONE line of simple commands (joined by | && ||) – nothing in which set -e could end it part-way:
      no loop, if, case, group, subshell or function definition, and no command that carries out other text (a
      function of the run, eval, source, ".", a name that is only known when the line runs)? For such a line
      "set +e; LINE; set -e" does what LINE does under set -e – but for ending the script.
      funcs: the names of the functions that are defined where the line runs (a Set). */
  function flat(src, funcs, opts) {
    let list;
    try {
      list = parse(src, opts);
    } catch (e) {
      return false;
    }
    if (!list || list.items.length !== 1) return false;
    const a = list.items[0];
    for (const pp of [a.first].concat(a.rest.map((r) => r.pipe)))
      for (const c of pp.cmds) {
        if (c.type === 'arith' || c.type === 'cond') continue;
        if (c.type !== 'simple') return false;
        if (!c.words.length) continue;
        let k = 0;
        for (;;) {
          const w = c.words[k];
          if (w == null) break;
          if (!/^[\w./+:@%,=\-[\]]+$/.test(w)) return false; // a name that is only known when the line runs
          if ((funcs && funcs.has(w)) || /^(eval|source|\.|exec|exit|return|trap|set|shopt)$/.test(w)) return false;
          if (!['command', 'builtin', 'time', 'env', 'nice', 'nohup', 'timeout'].includes(w)) break;
          k++;
          while (k < c.words.length && (c.words[k].startsWith('-') || ((w === 'env' || w === 'time') && /^[A-Za-z_]\w*=/.test(c.words[k])) || (w === 'timeout' && /^[\d.]+[smhd]?$/.test(c.words[k]) && !c.words.slice(1, k).some((x) => /^[\d.]+[smhd]?$/.test(x))))) k++;
        }
      }
    return true;
  }
  /** true when the text is the beginning of a command: an open quote, a block not closed, a trailing | or && */
  function incomplete(src) {
    try {
      parse(src);
      return false;
    } catch (e) {
      return !!(e.syntax && e.incomplete);
    }
  }
  /** the names of all commands a text would run (for the tasks' checks and the agent's rules).
      A name that is only known when the text runs is given as '$'. */
  function commandNames(src) {
    const names = [];
    const funcs = new Set();
    const inWord = (raw) => {
      // commands inside $( ) and backticks
      for (const text of substitutions(raw)) {
        let list = null;
        try {
          list = parse(text);
        } catch (e) {
          /* not readable: no names from it */
        }
        walkList(list);
      }
    };
    const walkList = (list) => list && list.items.forEach((a) => [a.first].concat(a.rest.map((r) => r.pipe)).forEach((pp) => pp.cmds.forEach(walkCmd)));
    const walkCmd = (c) => {
      (c.redirs || []).forEach((r) => r.target && inWord(r.target));
      switch (c.type) {
        case 'simple': {
          c.assigns.concat(c.words).forEach(inWord);
          if (!c.words.length) return;
          // a word that is only known when the text runs counts as '$'
          const plain = (w) => (/^[\w./+:@%,=\-[\]]+$/.test(w) ? w : /^(['"])[\w./+:@%,=\-[\] ]*\1$/.test(w) ? w.slice(1, -1) : '$');
          let name = plain(c.words[0]);
          names.push(name);
          // command, xargs, env …: the command they run is the next word that is not an option
          let k = 0;
          while (['command', 'builtin', 'exec', 'xargs', 'env', 'time'].includes(name)) {
            k++;
            while (k < c.words.length && (c.words[k].startsWith('-') || (name === 'env' && c.words[k].includes('=')))) k++;
            if (k >= c.words.length) break;
            name = plain(c.words[k]);
            names.push(name);
          }
          return;
        }
        case 'if':
          c.clauses.forEach((cl) => {
            walkList(cl.cond);
            walkList(cl.body);
          });
          return walkList(c.orelse);
        case 'for':
          (c.words || []).forEach(inWord);
          return walkList(c.body);
        case 'cfor':
          return walkList(c.body);
        case 'while':
          walkList(c.cond);
          return walkList(c.body);
        case 'case':
          inWord(c.word);
          return c.clauses.forEach((cl) => walkList(cl.body));
        case 'group':
        case 'subshell':
          return walkList(c.body);
        case 'func':
          funcs.add(c.name);
          return walkCmd(c.body);
        case 'cond':
          return c.words.forEach(inWord);
        default:
      }
    };
    walkList(parse(src));
    return names.filter((x) => !funcs.has(x));
  }
  /** the files that a text runs as scripts – ./NAME, work/NAME, bash NAME, sh NAME, source NAME, . NAME – as they
      were written, without their quotes; also inside $( ), loops, branches and functions. Never throws. */
  function scriptsRun(src) {
    const out = [];
    const unq = (raw) => String(raw).replace(/\$(?=['"])/g, '').replace(/\\([\s\S])/g, '$1').replace(/['"]/g, '');
    const inWord = (raw) => {
      if (raw == null) return;
      for (const text of substitutions(raw)) {
        try {
          walkList(parse(text));
        } catch (e) {
          /* not readable: nothing from it */
        }
      }
    };
    const walkList = (list) => list && list.items.forEach((a) => [a.first].concat(a.rest.map((r) => r.pipe)).forEach((pp) => pp.cmds.forEach(walkCmd)));
    const simple = (c) => {
      c.assigns.concat(c.words).forEach(inWord);
      let w = c.words.map(unq);
      // /usr/bin/env bash FILE, command bash FILE, time ./FILE: the command is the word after the wrapper's own options
      const bin = (x) => (/^\/(usr\/(local\/)?)?bin\/[\w.+-]+$/.test(x) ? x.replace(/^.*\//, '') : x);
      for (let guard = 0; guard < 4 && w.length && ['command', 'builtin', 'exec', 'env', 'time', 'nohup'].includes(bin(w[0])); guard++) {
        const env = bin(w[0]) === 'env';
        let k = 1;
        while (k < w.length && (w[k].startsWith('-') || (env && /^[A-Za-z_]\w*=/.test(w[k])))) k++;
        w = w.slice(k);
      }
      if (!w.length) return;
      const name = bin(w[0]);
      if (name.includes('/')) out.push(name);
      else if (['bash', 'sh', 'source', '.'].includes(name)) {
        // bash [options] FILE: with -c there is no file; -o and -O take a value
        let k = 1;
        while (k < w.length && /^[-+]./.test(w[k])) {
          if (/^-[A-Za-z]*c/.test(w[k])) return;
          k += /^[-+][oO]$/.test(w[k]) ? 2 : 1;
        }
        if (k < w.length && w[k] !== '-') out.push(w[k]);
      }
    };
    const walkCmd = (c) => {
      (c.redirs || []).forEach((r) => r.op !== '<<' && inWord(r.target));
      switch (c.type) {
        case 'simple':
          return simple(c);
        case 'if':
          c.clauses.forEach((cl) => {
            walkList(cl.cond);
            walkList(cl.body);
          });
          return walkList(c.orelse);
        case 'for':
          (c.words || []).forEach(inWord);
          return walkList(c.body);
        case 'cfor':
          return walkList(c.body);
        case 'while':
          walkList(c.cond);
          return walkList(c.body);
        case 'case':
          inWord(c.word);
          return c.clauses.forEach((cl) => walkList(cl.body));
        case 'group':
        case 'subshell':
          return walkList(c.body);
        case 'func':
          return walkCmd(c.body);
        case 'cond':
          return c.words.forEach(inWord);
        default:
      }
    };
    try {
      walkList(parse(src));
    } catch (e) {
      /* not readable: what was found so far */
    }
    return out;
  }
  /** every word of a text as it was written (with its quotes): arguments, values of assignments, targets of
      redirections, the lists of for and case – also inside $( ), `…` and the bodies of loops and functions */
  function wordsOf(src) {
    const out = [];
    const word = (raw) => {
      if (raw == null) return;
      out.push(raw);
      for (const text of substitutions(raw)) {
        let list = null;
        try {
          list = parse(text);
        } catch (e) {
          /* not readable: no words from it */
        }
        walkList(list);
      }
    };
    const walkList = (list) => list && list.items.forEach((a) => [a.first].concat(a.rest.map((r) => r.pipe)).forEach((pp) => pp.cmds.forEach(walkCmd)));
    const walkCmd = (c) => {
      (c.redirs || []).forEach((r) => r.op !== '<<' && word(r.target));
      switch (c.type) {
        case 'simple':
          return c.assigns.concat(c.words).forEach(word);
        case 'if':
          c.clauses.forEach((cl) => {
            walkList(cl.cond);
            walkList(cl.body);
          });
          return walkList(c.orelse);
        case 'for':
          (c.words || []).forEach(word);
          return walkList(c.body);
        case 'cfor':
          return walkList(c.body);
        case 'while':
          walkList(c.cond);
          return walkList(c.body);
        case 'case':
          word(c.word);
          return c.clauses.forEach((cl) => walkList(cl.body));
        case 'group':
        case 'subshell':
          return walkList(c.body);
        case 'func':
          return walkCmd(c.body);
        case 'cond':
          return c.words.forEach(word);
        default:
      }
    };
    walkList(parse(src));
    return out;
  }

  /** What the arguments of a command are: 'path' (the default – a file, a folder, or a value that is neither),
      'skip' (a pattern, a program, a delimiter, a format: not a path, whatever it looks like – /^>/, /, /tmp/), and for
      echo and printf 'text' or 'shell' when st says that what they print goes into a file, a pipe or a script.
      args: the arguments without the command's name, without their quotes. → one kind for each argument.
      (Used where a text is read for the paths in it – reach – and where the arguments of a program are handed to
      it: a pattern must reach the program as it was typed.) */
  const VALUED = {
    awk: { skip: ['-F', '--field-separator', '-e', '--source', '-v', '--assign'], path: ['-f', '--file', '-i', '--include', '-E'], program: ['-e', '--source', '-f', '--file', '-E'], first: true },
    sed: { skip: ['-e', '--expression', '-l', '--line-length'], path: ['-f', '--file'], program: ['-e', '--expression', '-f', '--file'], first: true },
    grep: { skip: ['-e', '--regexp', '-m', '--max-count', '-A', '-B', '-C', '--after-context', '--before-context', '--context', '--include', '--exclude', '--exclude-dir', '-d', '-D', '--label'], path: ['-f', '--file'], program: ['-e', '--regexp', '-f', '--file'], first: true },
    jq: { skip: ['--indent', '--arg', '--argjson'], path: ['-f', '--from-file', '-L', '--slurpfile', '--rawfile'], program: ['-f', '--from-file'], two: ['--arg', '--argjson', '--slurpfile', '--rawfile'], first: true },
    cut: { skip: ['-d', '--delimiter', '-f', '--fields', '-c', '--characters', '-b', '--bytes', '--output-delimiter'], path: [] },
    paste: { skip: ['-d', '--delimiters'], path: [] },
    sort: { skip: ['-t', '--field-separator', '-k', '--key', '-S', '--buffer-size'], path: ['-T', '--temporary-directory', '-o', '--output'] },
    join: { skip: ['-t', '-1', '-2', '-j', '-o', '-e', '-a', '-v'], path: [] },
    column: { skip: ['-s', '--separator', '-o', '--output-separator'], path: [] },
    uniq: { skip: ['-f', '--skip-fields', '-s', '--skip-chars', '-w', '--check-chars'], path: [] },
    head: { skip: ['-n', '--lines', '-c', '--bytes'], path: [] },
    tail: { skip: ['-n', '--lines', '-c', '--bytes'], path: [] },
    fold: { skip: ['-w', '--width'], path: [] },
    comm: { skip: ['--output-delimiter'], path: [] },
    od: { skip: ['-A', '-t', '-N', '-j', '-w', '--address-radix', '--format', '--read-bytes', '--skip-bytes', '--width'], path: [] },
    hexdump: { skip: ['-n', '-s', '--length', '--skip'], path: [] },
    xxd: { skip: ['-l', '-len', '-s', '-seek', '-c', '-cols', '-g', '-groupsize'], path: [] },
    base64: { skip: ['-w', '--wrap'], path: [] },
    split: { skip: ['-l', '--lines', '-b', '--bytes', '-n', '--number', '-a', '--suffix-length'], path: [] },
    truncate: { skip: ['-s', '--size'], path: [] },
    expand: { skip: ['-t', '--tabs'], path: [] },
    diff: { skip: ['-I', '--ignore-matching-lines', '-x', '--exclude', '-L', '--label', '-F', '--show-function-line', '-U', '--unified', '-C', '--context', '-W', '--width', '-D', '--ifdef', '-S', '--starting-file', '--tabsize', '--horizon-lines', '--color', '--palette', '--line-format', '--old-line-format', '--new-line-format', '--unchanged-line-format', '--old-group-format', '--new-group-format', '--changed-group-format', '--unchanged-group-format'], path: ['-X', '--exclude-from', '--from-file', '--to-file'] },
    cmp: { skip: ['-n', '--bytes', '-i', '--ignore-initial'], path: [] }
  };
  VALUED.gawk = VALUED.awk;
  VALUED.egrep = VALUED.fgrep = VALUED.zgrep = VALUED.grep;
  /** does this option of a program take a pattern, a delimiter, a number … – anything but a path? (cut -d, awk -F, sort -t, grep -e) */
  const optionSkips = (name, opt) => !!(VALUED[name] && VALUED[name].skip.includes(opt));
  function argKinds(name, args, st) {
    st = st || {};
    // what echo and printf print is looked at when it goes somewhere: into a script (then it is read as commands),
    // or into another file or a pipe
    if (name === 'echo' || name === 'printf') return args.map(() => (st.script ? 'shell' : st.goes ? 'text' : 'skip'));
    // names, sets of characters, numbers: no paths
    if (name === 'basename' || name === 'dirname' || name === 'tr' || name === 'seq') return args.map(() => 'skip');
    const V = VALUED[name];
    const k = args.map(() => 'path');
    if (!V) return k;
    let program = !V.first; // has the program (the pattern, the filter) been seen?
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') {
        if (!program && i + 1 < args.length) k[i + 1] = 'skip';
        break;
      }
      if (a.startsWith('-') && a.length > 1) {
        const eq = a.startsWith('--') ? a.indexOf('=') : -1;
        if (eq > 0) {
          // --delimiter=/ : the value is part of the word
          const opt = a.slice(0, eq);
          if (V.skip.includes(opt)) k[i] = 'skip';
          if (V.program && V.program.includes(opt)) program = true;
        } else if (V.skip.includes(a) || V.path.includes(a)) {
          if (V.skip.includes(a) && i + 1 < args.length) k[i + 1] = 'skip';
          if (V.program && V.program.includes(a)) program = true;
          i++;
          // jq --arg NAME VALUE, --slurpfile NAME FILE: the name is not a path
          if (V.two && V.two.includes(a)) {
            if (i < args.length) k[i] = 'skip';
            i++;
            if (V.skip.includes(a) && i < args.length) k[i] = 'skip';
          }
        } else if (V.program && a.length > 2 && !a.startsWith('--') && V.program.includes(a.slice(0, 2))) program = true; // -e's/a/b/'
        else if (/^-[A-Za-z]{2,}$/.test(a) && (V.skip.includes('-' + a[a.length - 1]) || V.path.includes('-' + a[a.length - 1]))) {
          // -sd / , -ne 's/a/b/' : several options in one word, the last of them takes the next word
          const last = '-' + a[a.length - 1];
          if (V.skip.includes(last) && i + 1 < args.length) k[i + 1] = 'skip';
          if (V.program && V.program.includes(last)) program = true;
          i++;
        }
        continue;
      }
      if (!program) {
        k[i] = 'skip';
        program = true;
      }
    }
    return k;
  }

  /** Which words of a shell text lead out of the folder it runs in? → those words, as they were written.
      (For the script that is made from a run of the AI agent: a command that reaches outside its folder is left
      out. This is one of three checks there: the page also notes which paths the shell really touched when the
      command ran, and what the command changed outside the folder. This one reads the text, so it also sees
      what did not happen in the run: the branch that was not taken, the file that was not there yet.)
      Counted:
        - a path into the home folder (~…, $HOME…, /home/…) and any other absolute path – but not /dev, /tmp, the
          programs in /usr and /bin, the folders in opts.allow (the course data), and opts.top, a variable that
          stands for the top folder itself ("$RUN_FOLDER"/results is inside);
        - a relative path with enough ".." to climb out, counted from opts.depth (how many folders below the top
          the text starts in) and following every cd in the text. Where the folder is only known when the text
          runs (after cd "$DIR"), ".." is not counted: that is left to the other two checks;
        - a cd that leaves: cd without a folder, cd - without a cd before it, cd to one of the paths above;
        - in a text that a shell will run (eval, bash -c, trap, a here-document or an echo that writes a script –
          a file named *.sh or one of opts.scripts): the same, read as commands;
        - in a text that is printed into a file or a pipe (echo, printf): a clear reference to the home folder,
          or a path that climbs out;
        - an awk program that calls system( ): what that command does is not seen here.
      Not looked at otherwise: the patterns and programs of awk, sed, grep, jq and tr, which often begin with a slash.
      A text the page cannot read as shell counts as leading out: the answer is then ['?']. It never throws. */
  function reach(src, opts = {}) {
    const out = [];
    const hit = (w) => out.includes(w) || out.push(w);
    const home = opts.home || '/home/student';
    const allow = (opts.allow || []).map((p) => p.replace(/\/+$/, ''));
    const scripts = opts.scripts || new Set();
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // $'…' and "…": without the quotes (and without the $ of $'…')
    const unq = (raw) => String(raw).replace(/\$(?=['"])/g, '').replace(/\\([\s\S])/g, '$1').replace(/['"]/g, '');
    const dots = (w) => /(^|\/)\.\.(\/|$)/.test(w);
    // ~/x, $HOME/x, ${HOME}/x and /home/student/x are one place
    const homeRe = new RegExp('^' + esc(home) + '(?=/|$)');
    const canon = (w) => w.replace(/^(\$HOME\b|\$\{HOME\})/, '~').replace(homeRe, '~');
    const allowed = (w) => {
      const c = canon(w);
      return allow.some((a) => c === a || c.startsWith(a + '/'));
    };
    // "$RUN_FOLDER"/results → results (a path from the top folder), or null
    const topName = opts.top ? String(opts.top).replace(/^\$/, '') : null;
    const topRe = topName ? new RegExp('^\\$(' + esc(topName) + '\\b|\\{' + esc(topName) + '\\})(?=/|$)') : null;
    const fromTop = (w) => (topRe && topRe.test(w) ? w.replace(topRe, '').replace(/^\/+/, '') : null);
    // … and the same inside a word (-o"$RUN_FOLDER"/sorted.txt): what follows the variable, or null
    const topIn = topName ? new RegExp('\\$(' + esc(topName) + '(?![A-Za-z0-9_])|\\{' + esc(topName) + '\\})') : null;
    const afterTop = (w) => {
      const m = topIn && topIn.exec(w);
      return m ? w.slice(m.index + m[0].length) : null;
    };
    // where a path ends, counted in folders below the top; -1: above it
    const climb = (path, from) => {
      let n = from;
      for (const seg of path.split('/')) {
        if (seg === '..') {
          if (--n < 0) return -1;
        } else if (seg && seg !== '.') n++;
      }
      return n;
    };
    // $PWD, ${PWD}, $(pwd) and `pwd` at the start of a path are the folder the text is in
    const here = (w) => String(w).replace(/^(\$PWD(?![A-Za-z0-9_])|\$\{PWD\}|\$\(pwd\)|`pwd`)(?=\/|$)/, '.');
    const leadsOut = (w, depth) => {
      if (!w) return false;
      w = here(w);
      const t = fromTop(w);
      if (t != null) return climb(t, 0) < 0;
      const a = afterTop(w);
      // "$RUN_FOLDER"_old, "$RUN_FOLDER"*: another folder, beside the top one
      if (a != null) return a === '' || /^[/:,]/.test(a) ? climb(a.split(/[:,]/)[0], 0) < 0 : true;
      if (allowed(w)) return dots(w);
      if (/^~/.test(w) || /\$HOME\b|\$\{HOME\b/.test(w) || /[{,]~/.test(w)) return true;
      // the folder above the one the text runs in, the one it was in before, and a folder named by a variable's variable
      if (/\$\{PWD%|\$\{?OLDPWD\b/.test(w) || /\$\{![A-Za-z_]\w*\}\//.test(w)) return true;
      // {..,x}/… : one of the alternatives is the folder above
      if (/[{,]\.\.[,}]/.test(w) || /^\.\{\.,?\}/.test(w)) return true;
      if (w.startsWith('/')) return /^\/(dev|usr|bin|proc|tmp)(\/|$)/.test(w) ? dots(w) : true;
      if (!dots(w)) return false;
      // from a place outside that is allowed (the course data, /tmp), ".." leads on to places that are not
      if (depth === 'out') return true;
      // climbing from a folder that is only known when the text runs: not counted here
      if (depth == null || /[$`]|\{\}/.test(w.slice(0, w.search(/(^|\/)\.\.(\/|$)/)))) return false;
      return climb(w, depth) < 0;
    };
    // a text that is printed into a file or a pipe: a clear reference to the home folder, or a path that climbs out
    const inText = (s, st) => {
      for (const t of String(s).split(/[\s"'`;|&<>(){}=:,[\]]+/)) {
        if (!t || (allowed(t) && !dots(t))) continue;
        if (/^~\/([\w.-]|$)/.test(t) || /\$HOME\b|\$\{HOME\b/.test(t) || /^\/home\//.test(t)) hit(t);
        else if (/^\.\.(\/|$)/.test(t) && leadsOut(t, st.depth)) hit(t);
      }
    };
    // a text that a shell will run
    const shellText = (s, st) => {
      let list;
      try {
        list = parse(s);
      } catch (e) {
        return inText(s, st);
      }
      walkList(list, st);
    };
    // the commands inside $( ) and `…` of a word: they run in a shell of their own
    const inner = (raw, st) => substitutions(raw).forEach((text) => shellText(text, Object.assign({}, st)));
    // a word that may be a path: an argument, the value of an assignment, the target of a redirection
    const pathWord = (raw, st) => {
      if (raw == null) return;
      inner(raw, st);
      const w = unq(raw);
      if (/\s/.test(w)) {
        // a message or a program – or a file name with a space in it
        inText(w, st);
        if (/^(\.\.?\/|~|\/[\w.]|\$HOME\b|\$\{HOME\})/.test(w) && leadsOut(w, st.depth)) hit(w);
        return;
      }
      // NAME=value, --option=value: the value counts – each part of a list like a:b, but not an address (http://…)
      const eq = w.indexOf('=');
      const value = eq > 0 && !w.startsWith('/') ? w.slice(eq + 1) : '';
      const parts = [w].concat(/^[A-Za-z][\w+.-]*:\/\//.test(value) ? [] : value.split(':'));
      if (/^[A-Za-z][\w+.-]*:\/\//.test(w)) return;
      if (parts.some((x) => leadsOut(x, st.depth))) hit(w);
    };
    const kindsOf = argKinds;
    const walkList = (list, st) => {
      if (!list) return;
      for (const a of list.items) {
        for (const pp of [a.first].concat(a.rest.map((r) => r.pipe))) {
          // the commands of a pipeline run in shells of their own: a cd in one of them changes nothing for what follows
          if (pp.cmds.length > 1) pp.cmds.forEach((c) => walkCmd(c, Object.assign({}, st), true));
          else walkCmd(pp.cmds[0], st, false);
        }
      }
    };
    const walkSimple = (c, st) => {
      c.assigns.forEach((raw) => /^IFS=/.test(raw) || pathWord(raw, st));
      if (!c.words.length) return;
      let words = c.words;
      let name = unq(words[0]);
      // command, env, time, xargs …: the command they run is the word after their own options
      for (let guard = 0; guard < 4 && ['command', 'builtin', 'exec', 'env', 'time', 'nohup', 'xargs'].includes(name); guard++) {
        const valued = name === 'xargs' ? ['-n', '-I', '-P', '-d', '-L', '-s', '-E', '-a'] : [];
        let k = 1;
        while (k < words.length && (/^-/.test(unq(words[k])) || (name === 'env' && /^[A-Za-z_]\w*=/.test(unq(words[k]))))) {
          if (name === 'env' && !/^-/.test(unq(words[k]))) pathWord(words[k], st);
          k += valued.includes(unq(words[k])) ? 2 : 1;
        }
        if (k >= words.length) return;
        words = words.slice(k);
        name = unq(words[0]);
      }
      const args = words.slice(1);
      const plain = args.map(unq);
      pathWord(words[0], st);
      if (name === 'cd' || name === 'pushd') {
        args.forEach((raw) => inner(raw, st));
        const i = plain.findIndex((a) => a === '-' || !a.startsWith('-'));
        const to = i < 0 ? null : here(plain[i]);
        const leave = (word) => {
          if (word) hit(word);
          st.prev = st.depth;
          st.depth = null;
        };
        const t = to == null ? null : fromTop(to);
        if (to == null) leave(name === 'cd' ? 'cd (without a folder: to the home folder)' : null);
        else if (to === '-') {
          if (st.prev === undefined) hit('cd -');
          const was = st.depth;
          st.depth = st.prev === undefined ? null : st.prev;
          st.prev = was;
        } else if (to === '') {
          /* cd "": stays */
        } else if (leadsOut(to, st.depth)) leave(plain[i]);
        else if (t != null) {
          // a folder written from the top: where the text is, is known again
          st.prev = st.depth;
          st.depth = climb(t, 0);
        } else if (/^[~/]/.test(to) || allowed(to)) {
          // a place outside that is allowed (the course data, /tmp)
          st.prev = st.depth;
          st.depth = 'out';
        } else if (st.depth === 'out' && !/[$`*?[{]/.test(to)) {
          st.prev = 'out'; // a folder below such a place: still there
        } else if (/[$`*?[{]/.test(to) || typeof st.depth !== 'number') leave(null); // only known when the text runs
        else {
          st.prev = st.depth;
          st.depth = climb(to, st.depth);
        }
        return;
      }
      if (name === 'popd') {
        st.depth = null;
        return;
      }
      if (name === 'eval') return shellText(plain.join(' '), st);
      // trap 'commands' EXIT: the commands run later, in this shell
      if (name === 'trap' && plain.length > 1 && plain[0] !== '-') return shellText(plain[0], Object.assign({}, st));
      // dirname $PWD is the folder above
      if (name === 'dirname' && plain.some((a) => /^(\$PWD|\$\{PWD\}|\.|\$\(pwd\)|`pwd`)$/.test(a))) hit('dirname ' + plain.join(' '));
      if ((name === 'bash' || name === 'sh') && plain.includes('-c')) {
        const i = plain.indexOf('-c');
        if (i + 1 < plain.length) shellText(plain[i + 1], Object.assign({}, st));
        args.forEach((raw, j) => j !== i + 1 && pathWord(raw, st));
        return;
      }
      const kinds = kindsOf(name, plain, st);
      // [ -n "$HOME" ], test -z "$X": a text is looked at, not a path
      if (name === '[' || name === 'test') plain.forEach((a, j) => (a === '-n' || a === '-z') && j + 1 < kinds.length && (kinds[j + 1] = 'skip'));
      // awk's system( ) runs a command of its own – one that this reading does not see (and that the page's awk cannot run)
      if ((name === 'awk' || name === 'gawk') && plain.some((a, j) => kinds[j] === 'skip' && /\bsystem\s*\(/.test(a))) hit('system( ) in awk');
      args.forEach((raw, j) => {
        if (kinds[j] === 'path') pathWord(raw, st);
        else {
          inner(raw, st);
          if (kinds[j] === 'text') inText(plain[j], st);
          else if (kinds[j] === 'shell') shellText(plain[j].replace(/\\n/g, '\n'), Object.assign({}, st));
        }
      });
    };
    // is this file a script: by its name, or because some command of the run runs it
    const isScript = (target) => {
      const w = unq(target);
      return /\.(sh|bash)$/.test(w) || scripts.has(w.replace(/^\.\//, '')) || (fromTop(w) != null && scripts.has(fromTop(w)));
    };
    const walkCmd = (c, st, piped) => {
      const name = c.type === 'simple' && c.words.length ? unq(c.words[0]) : '';
      const args = c.type === 'simple' ? c.words.slice(1).map(unq) : [];
      const shellStdin = (name === 'bash' || name === 'sh') && !args.some((a) => !a.startsWith('-'));
      const outputs = (c.redirs || []).filter((r) => r.target && /^>|^&>/.test(r.op) && !/^(\d+|-)$/.test(r.target) && !/^\/dev\//.test(unq(r.target)));
      // tee FILE writes its input into FILE
      const scriptOut = outputs.some((r) => isScript(r.target)) || (name === 'tee' && args.some((a) => !a.startsWith('-') && isScript(a)));
      (c.redirs || []).forEach((r) => {
        if (r.op === '<<') {
          // a here-document: commands for a shell, the text of a script, or any other text (which is not looked at).
          // (In one that is expanded, \$ \` and \\ stand for the plain characters.)
          if (shellStdin || scriptOut) shellText(r.quoted ? r.body : r.body.replace(/\\([\\$`])/g, '$1'), Object.assign({}, st));
        } else if (r.op === '<<<') {
          inner(r.target, st);
          if (shellStdin || scriptOut) shellText(unq(r.target), Object.assign({}, st));
          else inText(unq(r.target), st);
        } else if (!(/&/.test(r.op) && /^(\d+|-)$/.test(r.target))) pathWord(r.target, st);
      });
      const before = st.depth;
      // what is printed inside goes somewhere: into a pipe, or into a file – which may be a script
      const was = [st.goes, st.script];
      st.goes = was[0] || !!piped || outputs.length > 0;
      st.script = was[1] || scriptOut;
      try {
        walkNode(c, st);
      } finally {
        st.goes = was[0];
        st.script = was[1];
      }
      // a branch or a loop that changed folder: where the text is afterwards is not known
      if (['if', 'for', 'cfor', 'while', 'case'].includes(c.type) && st.depth !== before) st.depth = null;
    };
    const walkNode = (c, st) => {
      switch (c.type) {
        case 'simple':
          return walkSimple(c, st);
        case 'if':
          c.clauses.forEach((cl) => {
            walkList(cl.cond, st);
            walkList(cl.body, st);
          });
          walkList(c.orelse, st);
          break;
        case 'for':
          (c.words || []).forEach((raw) => pathWord(raw, st));
          walkList(c.body, st);
          break;
        case 'cfor':
          walkList(c.body, st);
          break;
        case 'while':
          walkList(c.cond, st);
          walkList(c.body, st);
          break;
        case 'case':
          pathWord(c.word, st);
          c.clauses.forEach((cl) => walkList(cl.body, st));
          break;
        case 'group':
          return walkList(c.body, st);
        case 'subshell':
          return walkList(c.body, Object.assign({}, st));
        case 'func':
          return walkCmd(c.body, Object.assign({}, st));
        case 'cond':
          // [[ … ]]: the word after =~ is a pattern
          return c.words.forEach((raw, i) => (i && ['=~', '-n', '-z'].includes(unq(c.words[i - 1]))) || pathWord(raw, st));
        default:
      }
    };
    try {
      walkList(parse(src), { depth: opts.depth === undefined ? 0 : opts.depth, prev: undefined, goes: false, script: false });
    } catch (e) {
      return ['?'];
    }
    return out;
  }

  /** A shell text in which a folder that is named in full is named by a variable instead. (For the script that is
      made from a run of the AI agent: the script runs in another folder than the agent did, so "the run's folder"
      must mean the folder the script is in.)
        folder: { abs: '/home/student/runs/3-auto', home: '/home/student' } – the folder is then also recognised
                as ~/runs/3-auto, $HOME/runs/3-auto, ${HOME}/runs/3-auto and "$HOME"/runs/3-auto
        name:   the variable, RUN_FOLDER
      What the folder becomes depends on where it stands:
        outside quotes                      "$RUN_FOLDER"
        inside "…", ${…}, a here-document   $RUN_FOLDER
        inside '…' and $'…'                 the quote is closed and opened again around "$RUN_FOLDER"
        in a here-document that is taken as it is (<<'EOF')   the here-document becomes one that is expanded (<<EOF):
                                            $RUN_FOLDER for the folder, and \ before every $, ` and \ of its text
      Only the folder itself and paths below it: /home/student/runs/3-auto_old is another one, and so is
      /mnt/home/student/runs/3-auto. Inside '…' and such a here-document only the full path counts (~ and $HOME are
      plain text there).
      → { text, left }: left says that the folder is still named somewhere in the text (where ~ is not expanded,
      in a comment, after a variable …). It never throws. */
  function anchor(src, folder, name) {
    const tail = folder.abs.slice(folder.home.length); // /runs/3-auto
    const A = folder.abs, H = ['${HOME}' + tail, '$HOME' + tail];
    const forms = { code: ['"$HOME"' + tail, '"${HOME}"' + tail].concat(H, [A]), text: H.concat([A]), plain: [A] };
    // what may follow the folder's name: the end, a slash, or a character that ends a word or a path
    const stops = (c) => c === undefined || /[/\s"'`;|&()<>:,=\]}]/.test(c);
    // … in a text also the full stop (or ! or ?) at the end of a sentence
    const ends = (text, k, inText) => stops(text[k]) || (inText && /[.!?]/.test(text[k]) && (k + 1 >= text.length || /[\s"')\]]/.test(text[k + 1])));
    // … and what may not come before it: a longer path (/mnt/home/…) or a variable ($BASE/home/…). Outside quotes
    // also a quoted text ("$BASE"/home/…); inside a text a quote is a character like any other.
    const starts = (text, j, inText) => {
      const pre = (inText ? /[^\s=:,;|&<>("'`[{]*$/ : /[^\s=:,;|&<>(]*$/).exec(text.slice(0, j))[0];
      return !pre.includes('/') && !(inText ? /[.~})]$/ : /[.~}"'`)]$/).test(pre) && !/\$\w+$/.test(pre);
    };
    const found = (list, text, j, inText) => list.find((f) => text.startsWith(f, j) && ends(text, j + f.length, inText) && (f !== A || starts(text, j, inText)));
    // a text in which nothing is expanded: the pieces between the places where the folder is named
    const pieces = (text) => {
      const out = [''];
      for (let j = 0; j < text.length; ) {
        const f = found(forms.plain, text, j, true);
        if (f) {
          out.push('');
          j += f.length;
        } else out[out.length - 1] += text[j++];
      }
      return out;
    };
    // $( … ), `…`, ${ … } at j of a text: → [what to put, where the text goes on], or null
    const nested = (text, j) => {
      const c = text[j];
      if (c === '`') {
        const k = scanBq(text, j);
        return ['`' + all(text.slice(j + 1, k - 1)) + '`', k];
      }
      if (c === '$' && text[j + 1] === '(') {
        const k = scanSub(text, j + 1);
        // $(( … )) is arithmetic: no paths
        return [text[j + 2] === '(' ? text.slice(j, k) : '$(' + all(text.slice(j + 2, k - 1)) + ')', k];
      }
      if (c === '$' && text[j + 1] === '{') {
        const k = scanBrace(text, j + 1);
        // ${OUT:-/home/…/out}, ${f#/home/…/}: the word after the name is expanded like a text
        const m = /^\$\{(!?[A-Za-z_]\w*(?:\[[^\]]*\])?|[#?@*$!0-9-])([\s\S]*)\}$/.exec(text.slice(j, k));
        return [m && m[2] ? '${' + m[1] + dq(m[2]) + '}' : text.slice(j, k), k];
      }
      return null;
    };
    // the inside of "…", the word of ${…}, and the text of a here-document that is expanded
    const dq = (text) => {
      let out = '', j = 0;
      while (j < text.length) {
        const f = found(forms.text, text, j, true);
        if (f) {
          out += '$' + name;
          j += f.length;
          continue;
        }
        if (text[j] === '\\') {
          out += text.slice(j, j + 2);
          j += 2;
          continue;
        }
        const sub = nested(text, j);
        if (sub) {
          out += sub[0];
          j = sub[1];
        } else out += text[j++];
      }
      return out;
    };
    // a word as it was written (or the words between [[ and ]])
    const code = (text) => {
      let out = '', j = 0;
      const n = text.length;
      const assign = ASSIGN.test(text);
      const variable = '"$' + name + '"';
      while (j < n) {
        const c = text[j];
        const f = found(forms.code, text, j, false);
        if (f) {
          out += variable;
          j += f.length;
          continue;
        }
        // ~ stands for the home folder at the start of a word, and after = and : in NAME=value
        if (c === '~' && text.startsWith(tail, j + 1) && stops(text[j + 1 + tail.length]) && (j === 0 || /\s/.test(text[j - 1]) || (assign && /[=:(]/.test(text[j - 1])))) {
          out += variable;
          j += 1 + tail.length;
          continue;
        }
        if (c === '\\') {
          out += text.slice(j, j + 2);
          j += 2;
        } else if (c === "'" || (c === '$' && text[j + 1] === "'")) {
          // '…' and $'…' (where a backslash takes the next character with it): nothing is expanded inside, so the
          // quote is closed before the folder and opened again after it
          const open = c === "'" ? "'" : "$'";
          let k;
          if (c === "'") k = scanSq(text, j);
          else {
            k = j + 2;
            while (k < n && text[k] !== "'") k += text[k] === '\\' ? 2 : 1;
            k = Math.min(n, k + 1);
          }
          const inside = text.slice(j + open.length, k - 1);
          const P = text[k - 1] === "'" && k - 1 >= j + open.length ? pieces(inside) : [inside];
          out += P.length === 1 ? text.slice(j, k) : P.map((x) => (x ? open + x + "'" : '')).join(variable);
          j = k;
        } else if (c === '"') {
          const k = scanDq(text, j);
          out += '"' + dq(text.slice(j + 1, k - 1)) + '"';
          j = k;
        } else {
          const sub = nested(text, j);
          if (sub) {
            out += sub[0];
            j = sub[1];
          } else out += text[j++];
        }
      }
      return out;
    };
    // a whole text: its words, and the here-documents
    const all = (text) => {
      const edits = [];
      for (const t of lex(text)) {
        if (t.t === 'w' || t.t === 'cond') edits.push([t.pos, t.end, code(text.slice(t.pos, t.end))]);
        else if (t.t === 'redir' && t.v === '<<' && t.body != null && !t.quoted) edits.push([t.bodyStart, t.bodyEnd, dq(text.slice(t.bodyStart, t.bodyEnd))]);
        else if (t.t === 'redir' && t.v === '<<' && t.body != null && /^[A-Za-z_][\w.-]*$/.test(t.delim)) {
          // <<'EOF': taken as it is. If the folder is named in it, it becomes <<EOF, with a backslash before
          // whatever would be expanded – and $RUN_FOLDER for the folder
          const whole = text.slice(t.bodyStart, t.bodyEnd);
          const cut = whole.replace(/\n$/, '').lastIndexOf('\n') + 1; // (the last line is the delimiter)
          const P = pieces(whole.slice(0, cut));
          const head = /^(\d*<<-?[ \t]*)/.exec(text.slice(t.pos, t.end));
          if (P.length > 1 && head) {
            edits.push([t.pos + head[1].length, t.end, t.delim]);
            edits.push([t.bodyStart, t.bodyEnd, P.map((x) => x.replace(/[\\$`]/g, '\\$&')).join('$' + name) + whole.slice(cut)]);
          }
        }
      }
      let out = text;
      edits.sort((a, b) => b[0] - a[0]).forEach(([from, to, put]) => (out = out.slice(0, from) + put + out.slice(to)));
      return out;
    };
    let text = String(src);
    try {
      text = all(text);
    } catch (e) {
      text = String(src); // a text the page cannot read: as it was
    }
    const named = [A, '~' + tail].concat(H);
    const left = named.some((f) => {
      for (let k = text.indexOf(f); k >= 0; k = text.indexOf(f, k + 1)) if (stops(text[k + f.length])) return true;
      return false;
    });
    return { text, left };
  }
  /** A text – the contents of a file – as the body of a here-document that is expanded (cat > FILE <<EOF), with
      $RUN_FOLDER where the text names the folder in full: every \, $ and ` of the text gets a backslash, so that the
      file is written as it was but for the folder. all: also where the folder is named as ~/runs/3-auto or
      $HOME/runs/3-auto (for a script, in which those are expanded when it runs).
      → { text, n: how often the folder is named } */
  function anchorText(src, folder, name, all) {
    const tail = folder.abs.slice(folder.home.length);
    const list = all ? ['${HOME}' + tail, '$HOME' + tail, '~' + tail, folder.abs] : [folder.abs];
    const stops = (c) => c === undefined || /[/\s"'`;|&()<>:,=\]}]/.test(c);
    const text = String(src);
    const P = [''];
    for (let j = 0; j < text.length; ) {
      const f = list.find((x) => text.startsWith(x, j));
      const k = f ? j + f.length : j;
      const pre = f ? /[^\s=:,;|&<>("'`[{]*$/.exec(text.slice(0, j))[0] : '';
      const end = f && (stops(text[k]) || (/[.!?]/.test(text[k]) && (k + 1 >= text.length || /[\s"')\]]/.test(text[k + 1]))));
      // (the folder itself – not a longer path, not another folder that begins like it)
      if (f && end && !pre.includes('/') && !/[.~})]$/.test(pre) && !(f[0] === '~' && pre) && !/\$\w+$/.test(pre)) {
        P.push('');
        j = k;
      } else P[P.length - 1] += text[j++];
    }
    return { text: P.map((x) => x.replace(/[\\$`]/g, '\\$&')).join('$' + name), n: P.length - 1 };
  }

  /* ------------------------------------------------------------------
     patterns and braces
     ------------------------------------------------------------------ */
  const globRe = MG.globRe;
  /* A POSIX regular expression – extended (ERE: [[ =~ ]]) or basic (BRE: expr) – as a pattern of JavaScript.
     Bracket expressions are read as POSIX reads them ([]abc], [[:digit:]], a backslash in them is a backslash); the
     classes take in the letters of all alphabets, as they do under a UTF-8 locale; "." matches a newline too;
     \w \W \s \S \b \B \< \> are the GNU extras. What JavaScript would read differently – (?: … ), \d, a lone { – means
     what POSIX means by it (which may be: a mistake). → the source of a RegExp for the flags "su"; throws on a
     pattern that the C library refuses. */
  function posixRe(src, bre) {
    const CLASS = {
      alpha: '\\p{L}', digit: '0-9', alnum: '\\p{L}\\p{Nd}', upper: '\\p{Lu}', lower: '\\p{Ll}', space: ' \\t\\n\\v\\f\\r', blank: ' \\t',
      punct: '!-\\/:-@\\[-`{-~\\p{P}\\p{S}', cntrl: '\\x00-\\x1f\\x7f', xdigit: '0-9A-Fa-f', print: '\\x20-\\x7e\\p{L}\\p{N}\\p{P}\\p{S}\\p{M}', graph: '\\x21-\\x7e\\p{L}\\p{N}\\p{P}\\p{S}\\p{M}'
    };
    const lit = (c) => (/[\\^$.*+?()[\]{}|\/]/.test(c) ? '\\' + c : c);
    const W = '[\\p{L}\\p{N}_]', NW = '[^\\p{L}\\p{N}_]';
    const bad = (msg) => new Error(msg);
    // (code points: a letter outside the 16-bit range is one character)
    const chars = Array.from(src), N = chars.length;
    const at = (k) => chars[k];
    let out = '', i = 0;
    // the piece that a following * + ? { would repeat: where it starts in out (-1: there is none), and whether it
    // ends with such a sign already (then it is put in brackets first: a{2}{3}, a+*)
    let atom = -1, repeated = false;
    const opens = []; // where the groups that are open start in out
    const piece = (text) => {
      atom = out.length;
      repeated = false;
      out += text;
    };
    const repeat = (q) => {
      if (repeated) out = out.slice(0, atom) + '(?:' + out.slice(atom) + ')';
      out += q;
      repeated = true;
    };
    const nothing = () => bad('Invalid preceding regular expression');
    const bracket = () => {
      // chars[i] is "["
      let j = i + 1, neg = false, body = '', first = true;
      if (at(j) === '^') {
        neg = true;
        j++;
      }
      const items = [];
      for (;;) {
        if (j >= N) throw bad('Unmatched [, [^, [:, [., or [=');
        const c = at(j);
        if (c === ']' && !first) break;
        first = false;
        if (c === '[' && (at(j + 1) === ':' || at(j + 1) === '.' || at(j + 1) === '=')) {
          const kind = at(j + 1);
          let e = j + 2;
          while (e < N - 1 && !(at(e) === kind && at(e + 1) === ']')) e++;
          if (e >= N - 1) throw bad('Unmatched [, [^, [:, [., or [=');
          const name = chars.slice(j + 2, e).join('');
          j = e + 2;
          if (kind === ':') {
            if (!CLASS[name]) throw bad('Invalid character class name');
            items.push({ cls: CLASS[name] });
          } else items.push({ ch: name }); // [.x.] and [=x=]: the character itself
          continue;
        }
        j++;
        // a range a-z (a "-" at the start or the end is itself)
        if (at(j) === '-' && j + 1 < N && at(j + 1) !== ']') {
          let hi = at(j + 1), adv = 2;
          if (hi === '[' && at(j + 2) === '.') {
            let e = j + 3;
            while (e < N - 1 && !(at(e) === '.' && at(e + 1) === ']')) e++;
            hi = chars.slice(j + 3, e).join('');
            adv = e + 2 - j;
          }
          if (c.codePointAt(0) > hi.codePointAt(0)) throw bad('Invalid range end');
          items.push({ lo: c, hi });
          j += adv;
          continue;
        }
        items.push({ ch: c });
      }
      i = j + 1;
      const esc = (c) => (/[\\\]\[^-]/.test(c) ? '\\' + c : c);
      for (const it of items) body += it.cls ? it.cls : it.lo ? esc(it.lo) + '-' + esc(it.hi) : Array.from(it.ch).map(esc).join('');
      return '[' + (neg ? '^' : '') + body + ']';
    };
    const interval = () => {
      // chars[i] is "{" (of "\{" in a BRE): {n} {n,} {n,m} {,m} → its text; a "{" that is none of these is a mistake
      let j = i + 1, a = '', b = '', comma = false;
      while (j < N && /\d/.test(at(j))) a += at(j++);
      if (at(j) === ',') {
        comma = true;
        j++;
        while (j < N && /\d/.test(at(j))) b += at(j++);
      }
      if (bre ? at(j) !== '\\' || at(j + 1) !== '}' : at(j) !== '}') throw bad(j >= N ? 'Unmatched { or \\{' : 'Invalid content of \\{\\}');
      j += bre ? 2 : 1;
      if (a === '' && b === '') throw bad('Invalid content of \\{\\}');
      if (a === '') a = '0';
      if (b !== '' && +b < +a) throw bad('Invalid content of \\{\\}');
      if (+a > 32767 || +b > 32767) throw bad('Regular expression too big');
      i = j;
      return '{' + a + (comma ? ',' + b : '') + '}';
    };
    while (i < N) {
      const c = at(i);
      if (c === '\\') {
        const d = at(i + 1);
        if (d === undefined) throw bad('Trailing backslash');
        i += 2;
        if (bre && d === '(') {
          opens.push(out.length);
          out += '(';
          atom = -1;
        } else if (bre && d === ')') {
          if (!opens.length) throw bad('Unmatched ) or \\)');
          out += ')';
          atom = opens.pop();
          repeated = false;
        } else if (bre && d === '{') {
          if (atom < 0) throw nothing();
          i--; // (interval() looks at chars[i], the "{")
          repeat(interval());
        } else if (bre && d === '|') {
          out += '|';
          atom = -1;
        } else if (bre && (d === '+' || d === '?')) {
          if (atom < 0) piece(lit(d));
          else repeat(d);
        } else if (d === 'w') piece(W);
        else if (d === 'W') piece(NW);
        else if (d === 's') piece('[ \\t\\n\\v\\f\\r]');
        else if (d === 'S') piece('[^ \\t\\n\\v\\f\\r]');
        else if (d === 'b') piece(`(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`);
        else if (d === 'B') piece(`(?:(?<=${W})(?=${W})|(?<!${W})(?!${W}))`);
        else if (d === '<') piece(`(?:(?<!${W})(?=${W}))`);
        else if (d === '>') piece(`(?:(?<=${W})(?!${W}))`);
        else if (d === '`') piece('(?:^)');
        else if (d === "'") piece('(?:$)');
        else if (/[1-9]/.test(d)) piece('\\' + d);
        else piece(lit(d));
        continue;
      }
      if (c === '[') {
        const start = out.length, b = bracket();
        out += b;
        atom = start;
        repeated = false;
        continue;
      }
      i++;
      if (c === '.') piece('.');
      else if (c === '*') {
        // (with nothing before it a * is a mistake in an ERE, and a star in a BRE)
        if (atom < 0) {
          if (!bre) throw nothing();
          piece('\\*');
        } else repeat('*');
      } else if (c === '^') {
        // in a BRE a ^ that is not at the start (of the pattern or of a group) is a character
        const anchor = !bre || out === '' || /(^|[^\\])(\(|\|)$/.test(out);
        if (anchor) {
          out += '^';
          atom = -1;
        } else piece('\\^');
      } else if (c === '$') {
        const anchor = !bre || i >= N || (at(i) === '\\' && (at(i + 1) === ')' || at(i + 1) === '|'));
        if (anchor) {
          // (in an ERE an anchor can be repeated – "$*" –: it stays what it is)
          out += '$';
          atom = bre ? -1 : -1;
        } else piece('\\$');
      } else if (!bre && (c === '+' || c === '?')) {
        if (atom < 0) throw nothing();
        repeat(c);
      } else if (!bre && c === '{') {
        if (atom < 0) throw nothing();
        i--;
        repeat(interval());
      } else if (!bre && c === '(') {
        opens.push(out.length);
        out += '(';
        atom = -1;
      } else if (!bre && c === ')') {
        if (!opens.length) piece('\\)'); // (an unmatched ")" is a character)
        else {
          out += ')';
          atom = opens.pop();
          repeated = false;
        }
      } else if (!bre && c === '|') {
        out += '|';
        atom = -1;
      } else piece(lit(c));
    }
    if (opens.length) throw bad(bre ? 'Unmatched ( or \\(' : 'Unmatched ( or \\(');
    return out;
  }
  /* Match text against a POSIX pattern as the C library does: the match that starts first, and of those that start
     there the longest (x|xy on "xyz" matches "xy" – JavaScript alone would stop at "x"). → the match of JavaScript
     (an array: the whole match and the groups), or null */
  function posixExec(src, text, flags, bre) {
    const js = posixRe(src, bre);
    const first = new RegExp(js, 'su' + (flags || '')).exec(text);
    if (!first || !js.includes('|')) return first;
    // a longer match from the same place? (the end is asked for, from the end of the text downwards)
    const before = Array.from(text.slice(0, first.index)).length, total = Array.from(text).length, len = Array.from(first[0]).length;
    for (let end = total; end > before + len; end--) {
      const re = new RegExp('(?:' + js + ')(?<=^[\\s\\S]{' + end + '})', 'suy' + (flags || ''));
      re.lastIndex = first.index;
      const m = re.exec(text);
      if (m) return m;
    }
    return first;
  }
  /** {a,b} and {1..5}, outside quotes */
  function braceExpand(raw) {
    if (raw.indexOf('{') < 0) return [raw];
    const n = raw.length;
    let i = 0;
    while (i < n) {
      const c = raw[i];
      if (c === '\\') i += 2;
      else if (c === "'") i = scanSq(raw, i);
      else if (c === '"') i = scanDq(raw, i);
      else if (c === '`') i = scanBq(raw, i);
      else if (c === '$' && raw[i + 1] === '(') i = scanSub(raw, i + 1);
      else if ((c === '<' || c === '>') && raw[i + 1] === '(') i = scanSub(raw, i + 1);
      else if (c === '$' && raw[i + 1] === '{') i = scanBrace(raw, i + 1);
      else if (c === '{') {
        let depth = 0, j = i, ok = false;
        const commas = [];
        for (; j < n; j++) {
          const d = raw[j];
          if (d === '\\') j++;
          else if (d === "'") j = scanSq(raw, j) - 1;
          else if (d === '"') j = scanDq(raw, j) - 1;
          else if (d === '$' && raw[j + 1] === '(') j = scanSub(raw, j + 1) - 1;
          else if (d === '$' && raw[j + 1] === '{') j = scanBrace(raw, j + 1) - 1;
          else if (d === '{') depth++;
          else if (d === '}') {
            if (--depth === 0) {
              ok = true;
              break;
            }
          } else if (d === ',' && depth === 1) commas.push(j);
        }
        if (ok) {
          const pre = raw.slice(0, i), body = raw.slice(i + 1, j), post = raw.slice(j + 1);
          let alts = null;
          if (commas.length) {
            alts = [];
            let s = i + 1;
            commas.concat([j]).forEach((k) => {
              alts.push(raw.slice(s, k));
              s = k + 1;
            });
          } else {
            const r = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(body), l = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/.exec(body);
            if (r) {
              const a = +r[1], b = +r[2], st = Math.abs(+r[3] || 1) || 1;
              const w = /^-?0\d/.test(r[1]) || /^-?0\d/.test(r[2]) ? Math.max(r[1].length, r[2].length) : 0;
              alts = [];
              for (let k = a; a <= b ? k <= b : k >= b; k += a <= b ? st : -st) alts.push(w ? String(k).padStart(w, '0') : String(k));
            } else if (l) {
              // {a..e}, {a..z..5}: letters, every one or every Nth
              const a = l[1].charCodeAt(0), b = l[2].charCodeAt(0), st = Math.abs(+l[3] || 1) || 1;
              alts = [];
              for (let k = a; a <= b ? k <= b : k >= b; k += a <= b ? st : -st) alts.push(String.fromCharCode(k));
            }
          }
          if (alts) return alts.flatMap((alt) => braceExpand(pre + alt + post));
        }
        i++;
      } else i++;
    }
    return [raw];
  }

  /* ------------------------------------------------------------------
     arithmetic: $(( )), (( )), let, array subscripts
     ------------------------------------------------------------------ */
  /* Arithmetic as bash does it: whole numbers of 64 bits (2 ** 63 wraps round to the negative numbers; 1 << 40 is
     1099511627776). The right side of && and ||, and the branch of ? : that is not taken, are read and not carried
     out ($(( n > 0 ? total / n : 0 )) does not divide by 0). What is no whole number – 1.5, 08, "12 reads" – is a
     mistake, here as in bash. arithBig gives the exact number, arithEval a JavaScript number (for subscripts,
     offsets and tests). */
  const I64 = (x) => BigInt.asIntN(64, x);
  function arithEval(src, get, set) {
    return Number(arithBig(src, get, set));
  }
  function arithBig(src, get, set) {
    const toks = [], tpos = [];
    const re = /[ \t\n]*(0[xX][0-9a-fA-F]+|\d+#[\w@]+|\d+|[A-Za-z_]\w*|\*\*|<<=|>>=|<<|>>|<=|>=|==|!=|&&|\|\||\+\+|--|[-+*/%&|^]=|[-+*/%<>=!~&|^?:(),])/y;
    // (a mistake is reported in bash's words: the expression as it was written – without the blanks in front –, and
    // the "error token": what is left of it from the place of the mistake on)
    const shown = src.replace(/^[ \t\n]+/, '');
    let pos = 0;
    for (;;) {
      re.lastIndex = pos;
      const m = re.exec(src);
      if (!m) {
        // (what is left and is no blank: a number that ends in a carriage return – a value read from a file with
        // the line ends of Windows – is "5<CR>: syntax error: invalid arithmetic operator", as in bash)
        if (src.slice(pos).replace(/^[ \t\n]+/, '')) throw arithErr(`${shown}: syntax error: invalid arithmetic operator (error token is "${src.slice(pos).replace(/^[ \t\n]+/, '')}")`);
        break;
      }
      let tok = m[1];
      tpos.push(re.lastIndex - tok.length);
      pos = re.lastIndex;
      if (/^[A-Za-z_]/.test(tok) && src[pos] === '[') {
        // NAME[subscript]: an element of an array – (( n[$c]++ )), $(( a[0] + a[i+1] ))
        let depth = 0, j = pos;
        for (; j < src.length; j++) {
          if (src[j] === '[') depth++;
          else if (src[j] === ']' && --depth === 0) break;
        }
        if (j >= src.length) throw arithErr(`${shown}: bad array subscript (error token is "${src.slice(tpos[tpos.length - 1])}")`);
        tok += src.slice(pos, j + 1);
        pos = j + 1;
      }
      toks.push(tok);
    }
    let k = 0;
    let dead = 0; // > 0: this part of the expression is read, and not carried out
    const from = (i) => (toks.length ? src.slice(tpos[Math.max(0, Math.min(i, toks.length - 1))]) : '');
    const bad = (what, i) => arithErr(`${shown}: ${what || 'syntax error in expression'} (error token is "${from(i === undefined ? k : i)}")`);
    // a number as it is written: 0x1f, 017 (octal – 08 and 09 are mistakes), 2#101, 16#ff
    const literal = (t) => {
      if (/^0[xX]/.test(t)) return I64(BigInt(t));
      const m = /^(\d+)#([\w@]+)$/.exec(t);
      const tooGreat = () => arithErr(`${t}: value too great for base (error token is "${t}")`);
      if (m) {
        const base = +m[1];
        if (base < 2 || base > 64) throw arithErr(`${t}: invalid arithmetic base (error token is "${t}")`);
        let v = 0n;
        for (const ch of m[2]) {
          const c = ch.charCodeAt(0);
          const d = /\d/.test(ch) ? +ch : /[a-z]/.test(ch) ? c - 87 : /[A-Z]/.test(ch) ? (base <= 36 ? c - 55 : c - 29) : ch === '@' ? 62 : 63;
          if (d >= base) throw tooGreat();
          v = v * BigInt(base) + BigInt(d);
        }
        return I64(v);
      }
      if (/^0\d/.test(t)) {
        if (/[89]/.test(t)) throw tooGreat();
        const digits = t.replace(/^0+/, '');
        return digits ? I64(BigInt('0o' + digits)) : 0n;
      }
      return I64(BigInt(t));
    };
    // a variable, or an element: the subscript of an array is itself an expression, that of an associative array a text
    const elem = (t) => /^([A-Za-z_]\w*)\[([\s\S]*)\]$/.exec(t);
    const keyOf = (s) => s.trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    const read = (t) => {
      const e = elem(t);
      if (!e) {
        const v = get(t);
        // (set -u: a name that has no value is a mistake in an expression as it is in $name – see _arithGet)
        if (v === undefined && get.unbound) get.unbound(t);
        return Array.isArray(v) ? v[0] : isAssoc(v) ? v.get('0') : v;
      }
      const v = get(e[1]);
      // (an element that is not there counts as 0; an array that is not there at all – or was only declared – is unbound)
      if ((v === undefined || declaredOnly(v)) && get.unbound) get.unbound(e[1]);
      if (isAssoc(v)) return v.get(keyOf(e[2]));
      const i = arithEval(e[2], get, set);
      const arr = Array.isArray(v) ? v : v == null ? [] : [v];
      return arr[i < 0 ? arr.length + i : i];
    };
    const write = (t, val) => {
      if (dead) return undefined;
      const e = elem(t);
      if (!e) return set(t, val);
      const v = get(e[1]);
      if (isAssoc(v)) return set(e[1], v.with(keyOf(e[2]), val));
      const i = arithEval(e[2], get, set);
      const arr = Array.isArray(v) ? v.slice() : v == null ? [] : [v];
      arr[i < 0 ? arr.length + i : i] = val;
      return set(e[1], arr);
    };
    const num = (name, depth = 0) => {
      if (dead) return 0n;
      let v = read(name);
      if (v == null || v === '') return 0n;
      // (blanks, tabs and newlines around the number do not count; a carriage return does – see the reader above)
      v = String(v).replace(/^[ \t\n]+|[ \t\n]+$/g, '');
      if (v === '') return 0n;
      if (/^[-+]?(0|[1-9]\d*)$/.test(v)) return I64(BigInt(v));
      // the value is a name or an expression itself (y=x; echo $((y))): it is worked out, as bash does – and what
      // is no whole number (1.5, 08, "12 reads") is a mistake, as it is in bash: the shell counts in whole numbers
      if (depth > 20) throw arithErr(`${name}: expression recursion level exceeded (error token is "${name}")`);
      return /^[A-Za-z_]\w*$/.test(v) ? num(v, depth + 1) : arithBig(v, get, set);
    };
    const power = (a, b) => {
      let r = 1n, x = I64(a);
      for (; b > 0n; b >>= 1n) {
        if (b & 1n) r = I64(r * x);
        x = I64(x * x);
      }
      return r;
    };
    const flag = (t) => (t ? 1n : 0n);
    const bin = (op, a, b, at) => {
      if (dead) return 0n;
      switch (op) {
        case '+': return I64(a + b);
        case '-': return I64(a - b);
        case '*': return I64(a * b);
        case '/':
          if (b === 0n) throw bad('division by 0', at);
          return I64(a / b);
        case '%':
          if (b === 0n) throw bad('division by 0', at);
          return a % b;
        case '**':
          if (b < 0n) throw bad('exponent less than 0', k - 1);
          return power(a, b);
        case '<<': return I64(a << (b & 63n));
        case '>>': return a >> (b & 63n);
        case '<': return flag(a < b);
        case '<=': return flag(a <= b);
        case '>': return flag(a > b);
        case '>=': return flag(a >= b);
        case '==': return flag(a === b);
        case '!=': return flag(a !== b);
        case '&': return a & b;
        case '^': return a ^ b;
        case '|': return a | b;
        default: throw bad();
      }
    };
    const LEVELS = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '<=', '>', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
    const comma = () => {
      let r = assign();
      while (toks[k] === ',') {
        k++;
        r = assign();
      }
      return r;
    };
    const assign = () => {
      if (/^[A-Za-z_]/.test(toks[k] || '') && /^(\*\*|<<|>>|[-+*/%&|^])?=$/.test(toks[k + 1] || '')) {
        const name = toks[k], op = toks[k + 1];
        k += 2;
        const at = k;
        const rhs = assign();
        const val = op === '=' ? rhs : bin(op.slice(0, -1), num(name), rhs, at);
        write(name, String(val));
        return val;
      }
      const c = level(0);
      if (/^(\*\*|<<|>>|[-+*/%&|^])?=$/.test(toks[k] || '')) throw bad('attempted assignment to non-variable');
      if (toks[k] === '?') {
        k++;
        // (only the branch that is taken is carried out)
        if (c === 0n) dead++;
        const a = assign();
        if (c === 0n) dead--;
        if (toks[k++] !== ':') throw bad("`:' expected for conditional expression", k - 2);
        if (c !== 0n) dead++;
        const b = assign();
        if (c !== 0n) dead--;
        return c !== 0n ? a : b;
      }
      return c;
    };
    const level = (i) => {
      if (i === LEVELS.length) return powers();
      let l = level(i + 1);
      while (LEVELS[i].includes(toks[k])) {
        const op = toks[k++];
        if (op === '&&' || op === '||') {
          // (a && b: b is carried out only if a is not 0;  a || b: only if a is 0)
          const skip = op === '&&' ? l === 0n : l !== 0n;
          if (skip) dead++;
          const r = level(i + 1);
          if (skip) dead--;
          l = dead ? 0n : flag(op === '&&' ? l !== 0n && r !== 0n : l !== 0n || r !== 0n);
        } else {
          const at = k;
          l = bin(op, l, level(i + 1), at);
        }
      }
      return l;
    };
    const powers = () => {
      const b = unary();
      if (toks[k] === '**') {
        k++;
        const at = k;
        return bin('**', b, powers(), at);
      }
      return b;
    };
    const unary = () => {
      const t = toks[k];
      if (t === '!') return k++, flag(unary() === 0n);
      if (t === '-') return k++, I64(-unary());
      if (t === '+') return k++, unary();
      if (t === '~') return k++, ~unary();
      if (t === '++' || t === '--') {
        k++;
        const name = toks[k++];
        if (!/^[A-Za-z_]/.test(name || '')) throw bad();
        const v = I64(num(name) + (t === '++' ? 1n : -1n));
        write(name, String(v));
        return v;
      }
      return atom();
    };
    const atom = () => {
      const t = toks[k++];
      if (t === undefined) throw bad('syntax error: operand expected', k - 2);
      if (t === '(') {
        const v = comma();
        if (toks[k++] !== ')') throw bad("missing `)'", k - 1);
        return v;
      }
      if (/^\d/.test(t)) return literal(t);
      if (/^[A-Za-z_]/.test(t)) {
        if (toks[k] === '++' || toks[k] === '--') {
          const v = num(t);
          write(t, String(I64(v + (toks[k++] === '++' ? 1n : -1n))));
          return v;
        }
        return num(t);
      }
      throw bad('syntax error: operand expected', k - 1);
    };
    if (!toks.length) return 0n;
    const v = comma();
    if (k < toks.length) throw bad();
    return v;
  }

  /* ------------------------------------------------------------------
     state: variables, arguments, options, functions
     ------------------------------------------------------------------ */
  /* IFS has its value – space, tab, newline – in every shell from the start; it is a variable of the shell, not of the
     environment. (OLDIFS=$IFS; IFS=,; …; IFS=$OLDIFS must put the three characters back, not an empty text.) */
  const IFS0 = ' \t\n';
  /** Is extglob on? What shopt set; else on at the prompt (and in its subshells), off in a script and in bash -c. */
  const extOn = (st) => (st.shopt && 'extglob' in st.shopt ? !!st.shopt.extglob : !!(st.top || st.ext0));
  Shell.prototype._top = function () {
    if (!this._st) {
      const exported = new Set(Object.keys(this.env).concat(['PWD', 'OLDPWD']));
      if (!('IFS' in this.env)) this.env.IFS = IFS0;
      if (!('SHLVL' in this.env)) {
        this.env.SHLVL = '1';
        exported.add('SHLVL');
      }
      shellVars(this.env);
      this._st = { vars: this.env, args: [], name: 'bash', flags: this.flags, funcs: {}, cond: 0, loop: 0, fn: 0, locals: null, stdin: null, traps: {}, script: null, top: true, line: 0, sub: 0, exported };
    }
    return this._st;
  };
  /* The interactive shell's variables, functions, options and traps can be saved and put back:
     an AI agent starts with a new shell, and leaves the student's shell as it found it. */
  const copyVars = (vars) => {
    const out = {};
    for (const [k, v] of Object.entries(vars)) out[k] = Array.isArray(v) ? v.slice() : v;
    return out;
  };
  Shell.prototype.saveState = function () {
    const st = this._top();
    return { vars: copyVars(st.vars), flags: Object.assign({}, st.flags), funcs: Object.assign({}, st.funcs), traps: Object.assign({}, st.traps), args: st.args.slice(), readonly: st.readonly ? new Set(st.readonly) : null, lastCode: this.lastCode, oldpwd: this.oldpwd, exported: new Set(st.exported || []), attrs: st.attrs ? new Map(st.attrs) : null, shopt: st.shopt ? Object.assign({}, st.shopt) : null, xfuncs: st.xfuncs ? new Set(st.xfuncs) : null, rand: st.rand ? Object.assign({}, st.rand) : null, noRandom: !!st.noRandom, sec0: st.sec0 != null ? st.sec0 : null, signals: st.signals ? Object.assign({}, st.signals) : null, umask: st.umask != null ? st.umask : null, saved: true };
  };
  Shell.prototype.restoreState = function (s) {
    const st = this._top();
    // the same objects stay in use (the shell's env and flags are these objects)
    Object.keys(st.vars).forEach((k) => delete st.vars[k]);
    Object.assign(st.vars, copyVars(s.vars));
    Object.keys(st.flags).forEach((k) => delete st.flags[k]);
    Object.assign(st.flags, { e: false, u: false, x: false, pipefail: false }, s.flags);
    st.funcs = Object.assign({}, s.funcs);
    st.traps = Object.assign({}, s.traps);
    st.args = s.args.slice();
    st.readonly = s.readonly ? new Set(s.readonly) : null;
    st.exported = new Set(s.exported || Object.keys(s.vars));
    // (a state that was saved has IFS as it was – unset, too; a new shell has the three characters)
    if (!s.saved) {
      st.vars.IFS = IFS0;
      st.vars.SHLVL = '1';
      st.exported.add('SHLVL');
      st.exported.add('PWD');
      st.exported.add('OLDPWD');
      shellVars(st.vars);
      st.rand = null;
      st.noRandom = false;
    } else {
      st.rand = s.rand ? Object.assign({}, s.rand) : null;
      st.noRandom = !!s.noRandom;
    }
    st.sec0 = s.sec0 != null ? s.sec0 : null;
    st.signals = s.signals ? Object.assign({}, s.signals) : null;
    st.umask = s.umask != null ? s.umask : null;
    st.inTrap = 0;
    st.inErr = false;
    st.subshell = 0;
    st.cmdText = '';
    st.attrs = s.attrs ? new Map(s.attrs) : null;
    st.shopt = s.shopt ? Object.assign({}, s.shopt) : null;
    st.xfuncs = s.xfuncs ? new Set(s.xfuncs) : null;
    st.sourced = 0;
    st.fds = null;
    st.optAt = null;
    st.dirs = null;
    st.cond = 0;
    st.loop = 0;
    st.fn = 0;
    st.locals = null;
    st.stdin = null;
    this.lastCode = s.lastCode || 0;
    this.oldpwd = s.oldpwd; // where "cd -" goes
  };
  Shell.prototype.freshState = function () {
    this.restoreState({ vars: this.env0, flags: {}, funcs: {}, traps: {}, args: [], readonly: null, lastCode: 0 });
  };
  Shell.prototype._child = function (st) {
    // (the traps of a shell are not those of its subshells – but for ERR under set -E)
    return { vars: Object.assign({}, st.vars), args: st.args.slice(), name: st.name, flags: Object.assign({}, st.flags), funcs: Object.assign({}, st.funcs), cond: st.cond, loop: 0, fn: st.fn, locals: null, stdin: st.stdin, traps: st.flags.E && st.traps.ERR ? { ERR: st.traps.ERR } : {}, signals: null, subshell: (st.subshell || 0) + 1, cmdText: st.cmdText || '', script: st.script, top: false, cOpt: !!st.cOpt, sOpt: !!st.sOpt, hashed: st.hashed ? new Map(st.hashed) : null, line: st.line, sub: 0, fnames: st.fnames, exported: new Set(st.exported || []), attrs: st.attrs ? new Map(st.attrs) : null, shopt: st.shopt ? Object.assign({}, st.shopt) : null, readonly: st.readonly ? new Set(st.readonly) : null, dirs: st.dirs ? st.dirs.slice() : null, xfuncs: st.xfuncs ? new Set(st.xfuncs) : null, sourced: st.sourced || 0, fds: st.fds ? Object.assign({}, st.fds) : null, errName: st.errName || null, lineFixed: st.lineFixed != null ? st.lineFixed : null, lineBase: st.lineBase || 0, sec0: st.sec0 != null ? st.sec0 : null, noRandom: !!st.noRandom, umask: st.umask != null ? st.umask : null, xlevel: st.xlevel || 0, ext0: !!(st.top || st.ext0), ptraps: Object.assign({}, st.ptraps && !st.trapsOwn ? st.ptraps : {}, st.signals || {}, st.traps), flines: st.flines || null };
  };
  /** The state of a new process – bash script.sh, bash -c '…', ./script.sh. Unlike a subshell it gets only the
      variables that are exported (not the others, no arrays, no functions): a script that needs REF must be given
      it – export REF, REF=… bash script.sh, or as an argument. */
  Shell.prototype._process = function (parent) {
    const st = this._child(parent);
    st.vars = {};
    for (const k of parent.exported || []) {
      // (a variable that a function declared local and gave no value: the program still gets the value from outside)
      const v = parent.vars[k] === undefined && parent.locals && parent.locals.has(k) ? parent.locals.get(k) : parent.vars[k];
      if (typeof v === 'string') st.vars[k] = v;
    }
    st.exported = new Set(Object.keys(st.vars));
    if (parent.exported && parent.exported.has('PWD')) st.exported.add('PWD');
    if (parent.exported && parent.exported.has('OLDPWD')) st.exported.add('OLDPWD');
    // (a new shell starts with its own IFS, whatever the caller's is; and it is one level deeper)
    st.vars.IFS = IFS0;
    shellVars(st.vars);
    st.vars.OPTIND = '1';
    st.xlevel = 0;
    st.hashed = null;
    st.rand = null;
    st.noRandom = false;
    st.sec0 = Date.now();
    st.umask = parent.umask != null ? parent.umask : null;
    st.vars._ = '/usr/bin/bash';
    st.vars.SHLVL = String((parseInt(parent.vars.SHLVL, 10) || 0) + 1);
    st.exported.add('SHLVL');
    // the functions that were exported (export -f NAME) are there in the new shell too
    st.funcs = {};
    for (const k of parent.xfuncs || []) if (parent.funcs[k]) st.funcs[k] = parent.funcs[k];
    st.xfuncs = new Set(Object.keys(st.funcs));
    st.sourced = 0;
    st.errName = null;
    st.lineFixed = null;
    st.lineBase = 0;
    st.attrs = null;
    st.readonly = null;
    st.shopt = null;
    st.ext0 = false;
    st.cOpt = false;
    st.sOpt = false;
    st.ptraps = null;
    st.flines = null;
    st.fnames = null;
    st.optAt = null;
    st.dirs = null;
    st.subshell = 0;
    st.traps = {};
    st.inTrap = 0;
    st.inErr = false;
    return st;
  };
  /** The input of a block, a function or a script, as the commands in it read it: { text, pos } – read takes a
      line, a program takes what it reads (see inherited() in shell.js and _run in tools-wasm.js), and what is left
      is there for the next command. pipe: it came through a pipe (a program cannot go back in it); path, apath:
      the file it is (a program that reads it from the start gets the file itself, byte for byte).
      s: a text that was piped in, a file of the programs, or the stream of the caller (which is then shared). */
  /** … < /dev/null: an empty input that is a device ([ -c /dev/stdin ]), not a pipe ([ -p /dev/stdin ]) */
  const devStream = (s, opts) => (s && opts && opts.stdinDev && s.text === '' && !s.path && !s.apath ? Object.assign({}, s, { dev: true, pipe: false }) : s);
  Shell.prototype._stream = async function (s) {
    if (s == null) return null;
    if (typeof s === 'string') return { text: s, pos: 0, pipe: true };
    // (apath: the file itself – the first program that reads gets it byte for byte: cat x.bam | { samtools view -c -; })
    if (MG.FileRef && s instanceof MG.FileRef) return { text: await MG.wasm.readText(s.apath), pos: 0, pipe: !s.fromFile, apath: s.apath };
    return s;
  };
  /* An associative array (declare -A). bash keeps one in a hash table, and "${!m[@]}", "${m[@]}" and declare -p
     list it in the order of that table – no order a person would choose, but the same on every computer with
     bash 5. This is that table: 1024 buckets (four times as many whenever there are twice as many keys as
     buckets), the place of a key from the FNV-1 hash of its bytes, a new key at the front of its bucket.
     A value of this class is never changed once a variable holds it (the shells of $( ) and ( ) share the values of
     their parent): with() and without() give a new one. */
  const UTF8 = new TextEncoder();
  function hashKey(s) {
    let h = 2166136261;
    for (const b of UTF8.encode(s)) h = (Math.imul(h, 16777619) ^ (b >= 128 ? b | 0xffffff00 : b)) >>> 0;
    return h >>> 0;
  }
  class Assoc {
    constructor(from) {
      this.n = from ? from.n : 1024;
      this.size = from ? from.size : 0;
      this.b = new Map();
      if (from) for (const [i, list] of from.b) this.b.set(i, list.slice());
    }
    _at(k) {
      const h = hashKey(k), list = this.b.get(h & (this.n - 1));
      return { h, list, i: list ? list.findIndex((e) => e[0] === k) : -1 };
    }
    has(k) {
      return this._at(k).i >= 0;
    }
    get(k) {
      const a = this._at(k);
      return a.i >= 0 ? a.list[a.i][1] : undefined;
    }
    set(k, v) {
      let a = this._at(k);
      if (a.i >= 0) {
        a.list[a.i] = [k, v, a.h];
        return this;
      }
      if (this.size >= this.n * 2) {
        const old = Array.from(this.b).sort((x, y) => x[0] - y[0]);
        this.n *= 4;
        this.b = new Map();
        for (const [, list] of old) for (const e of list) this._front(e[2] & (this.n - 1), e);
        a = this._at(k);
      }
      this._front(a.h & (this.n - 1), [k, v, a.h]);
      this.size++;
      return this;
    }
    _front(i, e) {
      const list = this.b.get(i);
      if (list) list.unshift(e);
      else this.b.set(i, [e]);
    }
    delete(k) {
      const a = this._at(k);
      if (a.i < 0) return this;
      a.list.splice(a.i, 1);
      if (!a.list.length) this.b.delete(a.h & (this.n - 1));
      this.size--;
      return this;
    }
    entries() {
      const out = [];
      for (const [, list] of Array.from(this.b).sort((x, y) => x[0] - y[0])) for (const e of list) out.push([e[0], e[1]]);
      return out;
    }
    keys() {
      return this.entries().map((e) => e[0]);
    }
    values() {
      return this.entries().map((e) => e[1]);
    }
    with(k, v) {
      return new Assoc(this).set(k, v);
    }
    without(k) {
      return new Assoc(this).delete(k);
    }
  }
  const isAssoc = (v) => v instanceof Assoc;
  /** An array that was declared and never given a value – declare -A counts, local -a list – is "not set" for
      set -u, as in bash: ((counts[$k]++)) and ${#list[@]} are then "unbound variable" (declare -A counts=() is set). */
  const declaredOnly = (v) => !!v && v.declared === true && (Array.isArray(v) ? v.length === 0 : isAssoc(v) && v.size === 0);
  const blank = (v) => {
    v.declared = true;
    return v;
  };
  /* $RANDOM as bash (5.1 and later) makes it: the "minimal standard" generator x → 16807·x mod (2^31 − 1), its 32
     bits folded to 15. RANDOM=N starts the series anew, and the same N gives the same numbers here as in bash – a
     script that must be repeatable can count on it. A ( subshell ) and a $( ) start a series of their own. */
  function randomNext(st) {
    if (!st.rand) st.rand = { seed: (Math.floor(Math.random() * 0x7fffffff) + 1) >>> 0, last: 0 };
    const r = st.rand;
    let v;
    do {
      const s = r.seed === 0 ? 123459876 : r.seed;
      const h = Math.floor(s / 127773), l = s - 127773 * h;
      let t = 16807 * l - 2836 * h;
      if (t < 0) t += 0x7fffffff;
      r.seed = t >>> 0;
      v = ((r.seed >>> 16) ^ (r.seed & 65535)) & 32767;
    } while (v === r.last);
    r.last = v;
    return v;
  }
  /* The version this shell gives itself: bash 5.2 is what it follows (in the order of an associative array, the &
     in ${x/a/&}, the wording of messages). It is not GNU bash – bash --version says so. */
  const BASH_VERSINFO = ['5', '2', '0', '1', 'browser', 'x86_64-pc-linux-gnu'];
  /** the variables every bash has from the start, and that are no part of the environment */
  const shellVars = (vars) => {
    const d = { OSTYPE: 'linux-gnu', MACHTYPE: 'x86_64-pc-linux-gnu', HOSTTYPE: 'x86_64', BASH: '/bin/bash', OPTIND: '1', OPTERR: '1', PS4: '+ ', PPID: '4241' };
    for (const k of Object.keys(d)) if (vars[k] === undefined) vars[k] = d[k];
    return vars;
  };
  /** the variable that a name reference (declare -n ref=NAME) stands for → { name, sub: a subscript or undefined },
      or null: the reference has no value yet, or leads nowhere */
  Shell.prototype._refTarget = function (name, st) {
    let seen = 0;
    for (;;) {
      const at = st.attrs && st.attrs.get(name);
      if (!at || !at.n) return { name, sub: undefined };
      const t = st.vars[name];
      const m = typeof t === 'string' ? /^([A-Za-z_]\w*)(?:\[([\s\S]+)\])?$/.exec(t) : null;
      if (!m || m[1] === name || ++seen > 8) return null;
      if (m[2] !== undefined) return { name: m[1], sub: m[2] };
      name = m[1];
    }
  };
  Shell.prototype._get = function (name, st) {
    switch (name) {
      case '?': return String(this.lastCode || 0);
      case '#': return String(st.args.length);
      case '@':
      case '*': return st.args;
      case '$': return '4242';
      case '!': return '';
      case '-': {
        // (the letters in bash's own order. At the prompt – an interactive shell – i, m, H and s are there too, so
        // that  case $- in *i*) …  tells the prompt from a script as it does on Linux; bash -c adds c.)
        const inter = !!(st.top || st.ext0);
        return (st.flags.a ? 'a' : '') + (st.flags.e ? 'e' : '') + (st.flags.f ? 'f' : '') + 'h' + (inter ? 'im' : '') + (st.flags.n ? 'n' : '') + (st.flags.u ? 'u' : '') + (st.flags.v ? 'v' : '') + (st.flags.x ? 'x' : '') + 'B' + (st.flags.C ? 'C' : '') + (st.flags.E ? 'E' : '') + (inter ? 'H' : '') + (st.cOpt ? 'c' : '') + (inter || st.sOpt ? 's' : '');
      }
      case '0': return st.name;
      case 'PWD': return this.fs.cwd;
      case 'OLDPWD': return this.oldpwd || this.fs.cwd;
      case 'RANDOM': return st.noRandom ? st.vars.RANDOM : String(randomNext(st));
      // (SECONDS=0 starts the count anew: SECONDS=0; …; echo "took $SECONDS s")
      case 'SECONDS': return String(Math.floor((Date.now() - (st.sec0 != null ? st.sec0 : T0)) / 1000));
      case 'EPOCHSECONDS': return String(Math.floor(Date.now() / 1000));
      case 'EPOCHREALTIME': return (Date.now() / 1000).toFixed(3) + '000';
      case 'SRANDOM': return String(Math.floor(Math.random() * 4294967296));
      case 'LINENO': return String(st.line || 0);
      // (BASH_SOURCE: the file of each function that is being carried out, and of the script itself;
      //  BASH_LINENO: the line at which each of them was called – 0 for the script)
      case 'BASH_SOURCE': return st.script ? (st.fnames && st.fnames.length ? new Array(st.fnames.length + 1).fill(st.script) : st.script) : '';
      case 'BASH_LINENO': return st.flines && st.flines.length ? (st.script ? st.flines.concat('0') : st.flines) : st.script ? ['0'] : undefined;
      case 'BASH_VERSION': return `${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}.${BASH_VERSINFO[2]}(${BASH_VERSINFO[3]})-${BASH_VERSINFO[4]}`;
      case 'BASH_VERSINFO': return BASH_VERSINFO;
      // the command that is being carried out – in a trap: the one that was, when the trap began
      case 'BASH_COMMAND': return st.cmdText || '';
      case 'BASH_SUBSHELL': return String(st.subshell || 0);
      case 'BASHPID': return String(4242 + (st.subshell || 0));
      // the exit status of each command of the last pipeline; the functions that are being carried out (innermost first)
      case 'PIPESTATUS': return this.pipeStatus || ['0'];
      case 'FUNCNAME': return st.fnames && st.fnames.length ? (st.script ? st.fnames.concat('main') : st.fnames) : undefined;
      case 'UID':
      case 'EUID': return '1000';
      case 'GROUPS': return ['1000'];
      // the options that are on, as bash lists them (set -o NAME; shopt -s NAME)
      case 'SHELLOPTS': return ['braceexpand', 'hashall', 'interactive-comments'].concat(Object.entries({ allexport: 'a', errexit: 'e', errtrace: 'E', noclobber: 'C', noexec: 'n', noglob: 'f', nounset: 'u', pipefail: 'pipefail', verbose: 'v', xtrace: 'x' }).filter(([, f]) => st.flags[f]).map(([n]) => n)).sort().join(':');
      case 'BASHOPTS': return ['checkwinsize', 'cmdhist', 'complete_fullquote', 'extquote', 'force_fignore', 'globasciiranges', 'globskipdots', 'hostcomplete', 'interactive_comments', 'patsub_replacement', 'progcomp', 'promptvars', 'sourcepath'].filter((n) => !(st.shopt && st.shopt[n] === false)).concat(Object.keys(st.shopt || {}).filter((n) => st.shopt[n] === true), st.flags.nullglob ? ['nullglob'] : [], extOn(st) ? ['extglob'] : []).filter((n, i, a) => a.indexOf(n) === i).sort().join(':');
      default:
    }
    if (/^\d+$/.test(name)) return st.args[+name - 1];
    const v = st.vars[name];
    if (st.attrs && st.attrs.size) {
      const at = st.attrs.get(name);
      if (at && at.n) {
        // a name reference: the value of the variable it stands for
        const r = this._refTarget(name, st);
        if (!r) return undefined;
        const t = this._get(r.name, st);
        if (r.sub === undefined) return t;
        if (r.sub === '@' || r.sub === '*') return Array.isArray(t) ? t.filter((x) => x !== undefined) : isAssoc(t) ? t.values() : t;
        if (isAssoc(t)) return t.get(r.sub.replace(/^(['"])([\s\S]*)\1$/, '$2'));
        const k = arithEval(r.sub, (n) => this._get(n, st), (n, x) => this._set(n, x, st));
        return Array.isArray(t) ? t[k < 0 ? t.length + k : k] : k === 0 ? t : undefined;
      }
    }
    return v;
  };
  Shell.prototype._set = function (name, val, st) {
    if (/^(PWD|LINENO|UID|EUID|BASH_SOURCE|BASH_LINENO|BASH_VERSION|BASH_VERSINFO|PIPESTATUS|FUNCNAME|BASH_COMMAND|BASH_SUBSHELL|BASHPID|GROUPS|SHELLOPTS|BASHOPTS|EPOCHSECONDS|EPOCHREALTIME|SRANDOM)$/.test(name)) return;
    if (name === 'RANDOM' && !st.noRandom) {
      // RANDOM=N: the series starts anew from N (what N is, is worked out as a sum: RANDOM=abc is RANDOM=0)
      let seed = 0n;
      try {
        seed = arithBig(String(Array.isArray(val) ? val[0] || 0 : val), (n) => this._get(n, st), (n, v) => this._set(n, v, st));
      } catch (e) {
        if (!e || !e.arith) throw e;
      }
      st.rand = { seed: Number(BigInt.asUintN(32, seed)), last: 0 };
      return;
    }
    if (name === 'SECONDS') {
      st.sec0 = Date.now() - (parseInt(val, 10) || 0) * 1000;
      return;
    }
    if (st.readonly && st.readonly.has(name)) throw Object.assign(shErr(`${name}: readonly variable`), { readonlyVar: true });
    const at = st.attrs && st.attrs.get(name);
    if (at && at.n) {
      // a name reference: the variable it stands for is given the value (a reference without a value: its target)
      const cur = st.vars[name];
      if (cur === undefined || cur === '') {
        st.vars[name] = Array.isArray(val) ? val[0] : val;
        return;
      }
      const r = this._refTarget(name, st);
      if (!r) throw lineErr(`${name}: circular name reference`);
      if (r.sub === undefined) return this._set(r.name, val, st);
      const old = this._get(r.name, st);
      if (isAssoc(old)) return this._set(r.name, old.with(r.sub.replace(/^(['"])([\s\S]*)\1$/, '$2'), val), st);
      const arr = Array.isArray(old) ? old.slice() : old == null ? [] : [old];
      const k = arithEval(r.sub, (n) => this._get(n, st), (n, x) => this._set(n, x, st));
      arr[k < 0 ? arr.length + k : k] = val;
      return this._set(r.name, arr, st);
    }
    if (at && typeof val === 'string') {
      // declare -i: the value is worked out; -l, -u: lower or upper case
      if (at.i) val = String(arithBig(val, this._arithGet(st), (n, v) => this._set(n, v, st)));
      if (at.l) val = lowerC(val);
      if (at.u) val = upperC(val);
    }
    // NAME=text where NAME is an array: the text becomes element 0 (in an associative array: the key 0) and the
    // other elements stay, as in bash – files=(a b c); files=x  leaves "x b c". The same for every other way a
    // variable gets a text: for NAME in …, read NAME, printf -v NAME, (( NAME = 5 )).
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'bigint') {
      const cur = st.vars[name];
      if (Array.isArray(cur)) {
        const arr = cur.slice();
        arr[0] = String(val);
        val = arr;
      } else if (isAssoc(cur)) val = cur.with('0', String(val));
    }
    st.vars[name] = val;
    // set -a (allexport): every variable that is given a value from now on is exported
    if (st.flags.a && st.exported && /^[A-Za-z_]\w*$/.test(name)) st.exported.add(name);
  };

  /** give a value to NAME, or to one element NAME[subscript] (printf -v arr[1] …) */
  Shell.prototype._setRef = async function (ref, val, st, io) {
    const m = /^([A-Za-z_]\w*)\[([\s\S]+)\]$/.exec(ref);
    if (!m) return this._set(ref, val, st);
    const old = this._get(m[1], st);
    if (isAssoc(old)) return this._set(m[1], old.with(m[2].replace(/^(['"])([\s\S]*)\1$/, '$2'), val), st);
    const arr = Array.isArray(old) ? old.slice() : old == null ? [] : [old];
    const k = await this._arith(m[2], st, io);
    arr[k < 0 ? arr.length + k : k] = val;
    return this._set(m[1], arr, st);
  };

  /* ------------------------------------------------------------------
     expansion of words
     ------------------------------------------------------------------ */
  /** mode 'args': braces, splitting of unquoted results into words, glob marks → [{ v, glob }]
      mode 'one':  one string (assignments, redirection targets, patterns) */
  Shell.prototype._expand = async function (raw, st, io, mode) {
    const out = [];
    if (mode === 'args') for (const r of braceExpand(raw)) await this._expandOne(r, st, io, true, out);
    else {
      await this._expandOne(raw, st, io, false, out);
      return out.map((f) => f.v).join(' ');
    }
    return out;
  };
  /** a pattern (of case, [[ x == pattern ]], ${x#pattern}, ${x/pattern/}): what was written in quotes or after a
      backslash stands for itself – it comes out with a backslash in front of every character that a pattern would
      take for a wildcard; the value of a variable that is not in quotes is a pattern */
  Shell.prototype._expandPat = async function (raw, st, io) {
    const out = [];
    await this._expandOne(raw, st, io, false, out, true);
    return out.map((f) => f.v).join(' ');
  };
  /** The word of "${x:-word}" as it reads inside double quotes: the double quotes in it are taken out – there they
      only mark where "$@" gives one word per argument –, and what stands in $( ), ${ } and ` ` is left as it is. */
  function undq(w) {
    let out = '';
    for (let i = 0; i < w.length; ) {
      const c = w[i];
      let k = -1;
      if (c === '\\' && w[i + 1] === '}') {
        // (\} – a } that does not end the expansion – is a plain } here)
        out += '}';
        i += 2;
        continue;
      }
      if (c === '$' && w[i + 1] === "'") {
        // $'…' in the word: what it stands for, as plain text
        let j = i + 2, t = '';
        while (j < w.length && w[j] !== "'") {
          if (w[j] === '\\' && j + 1 < w.length) {
            t += w[j] + w[j + 1];
            j += 2;
          } else t += w[j++];
        }
        out += settleRaw(unescapeC(t)).split('\0')[0].replace(/[\\"$`]/g, '\\$&');
        i = j + 1;
        continue;
      }
      if (c === '\\' && i + 1 < w.length) k = i + 2;
      else if (c === '$' && w[i + 1] === '(') k = scanSub(w, i + 1);
      else if (c === '$' && w[i + 1] === '{') k = scanBrace(w, i + 1);
      else if (c === '`') k = scanBq(w, i);
      if (k > 0) {
        out += w.slice(i, k);
        i = k;
      } else {
        if (c !== '"') out += c;
        i++;
      }
    }
    return out;
  }
  /** wordOf: raw is the word of ${x:-word} or ${x:+word} outside double quotes – what is not quoted in it is split
      into words at the characters of IFS, as the value of a variable is (${v:+-o "$v"} is two words, ${u:-a b} two) */
  Shell.prototype._expandOne = async function (raw, st, io, split, out, pat, assignAt, wordOf) {
    let cur = null;
    // quoted: true (written in quotes: no wildcard, no splitting), 'plain' (the value of a variable where nothing is
    // split), false
    const add = (text, quoted) => {
      if (cur == null) cur = { v: '', glob: false };
      // (pat 'rep': the text of ${x/pattern/text} – a quoted & or \ gets a backslash, see there)
      // (pat 're': the pattern of [[ x =~ … ]] – what was quoted gets a backslash where a regular expression needs one)
      cur.v += pat === 'rep' ? (quoted === true ? text.replace(/[\\&]/g, '\\$&') : text) : pat === 're' ? (quoted === true ? text.replace(/[\\.^$*+?()[\]{}|]/g, '\\$&') : text) : pat && quoted === true ? text.replace(/[\\*?[\]()|!@+]/g, '\\$&') : text;
      // (a word with * ? [ in it – or a group of patterns, @(a|b) – that is not in quotes is a file name pattern)
      if (!quoted && split && (/[*?[]/.test(text) || (text === '(' && '+@!'.includes(cur.u)))) cur.glob = true;
      cur.u = quoted ? '' : text.slice(-1);
    };
    const flush = () => {
      if (cur != null) out.push(cur);
      cur = null;
    };
    // (the words that the word of ${x:-word} gave: the first goes on from where the text stands, the last stays open)
    const merge = (fields) => fields.forEach((f, k) => {
      if (k > 0) flush();
      if (cur == null) cur = { v: '', glob: false };
      cur.v += f.v;
      if (f.glob) cur.glob = true;
      cur.u = f.u;
    });
    /* the value of an expansion; quoted: true, false, '@' ("$@": one word per argument), or 'sp' (taken whole,
       an array joined by spaces: x=${a[@]}) */
    const ifs = typeof st.vars.IFS === 'string' ? st.vars.IFS : ' \t\n';
    const addValue = (val, quoted) => {
      if (Array.isArray(val)) {
        if (quoted === '@') {
          val.forEach((x, k) => {
            if (k > 0) flush();
            add(String(x), true);
          });
          return;
        }
        if (!quoted && split) {
          val.forEach((x, k) => {
            if (k > 0) flush();
            addValue(String(x), false);
          });
          return;
        }
        // "${a[*]}", "$*": joined by the first character of IFS (IFS=,; echo "${a[*]}")
        val = val.join(quoted === 'sp' ? ' ' : typeof st.vars.IFS === 'string' ? st.vars.IFS.slice(0, 1) : ' ');
      }
      val = val == null ? '' : String(val);
      if (quoted || !split) return add(val, quoted === true || quoted === '@' ? true : 'plain');
      if (ifs === ' \t\n') {
        val.split(/[ \t\n]+/).forEach((part, k) => {
          if (k > 0) flush();
          if (part !== '') add(part, false);
        });
        return;
      }
      // the words of an unquoted value are split at the characters of IFS: blanks of IFS in a row are one
      // separator and count neither at the start nor at the end; every other character of IFS separates by
      // itself (a::b has an empty word in the middle)
      if (ifs === '') {
        if (val !== '') add(val, false);
        return;
      }
      const blank = (c) => ifs.includes(c) && ' \t\n'.includes(c), other = (c) => ifs.includes(c) && !' \t\n'.includes(c);
      let j = 0, field = '', open = false;
      const n = val.length;
      while (j < n && blank(val[j])) j++;
      if (j > 0) flush();
      while (j < n) {
        const c = val[j];
        if (!ifs.includes(c)) {
          field += c;
          open = true;
          j++;
          continue;
        }
        // a separator: blanks, at most one other character, blanks
        let hard = false;
        while (j < n && blank(val[j])) j++;
        if (j < n && other(val[j])) {
          hard = true;
          j++;
          while (j < n && blank(val[j])) j++;
        }
        if (open || hard) add(field, false);
        flush();
        field = '';
        open = false;
      }
      if (open) add(field, false);
    };
    // (walk: the text of a word – and, in it, the word of a ${x:-word} that stands outside quotes)
    const walk = async (raw, assignAt, wordOf) => {
      const n = raw.length;
      let i = 0;
      /* ~ is the home folder, ~+ the folder one is in, ~- the one before, ~NAME the home of that user – at the start
         of a word, and in NAME=value (assignAt: where the value begins) at the start of the value and after each ":"
         (PATH=~/bin:~/tools). → { text, next } or null */
      const tilde = (k) => {
        let j = k + 1;
        while (j < n && /[\w.+-]/.test(raw[j])) j++;
        if (j < n && raw[j] !== '/' && !(assignAt != null && raw[j] === ':')) return null;
        const who = raw.slice(k + 1, j);
        const home = who === '' ? (typeof st.vars.HOME === 'string' ? st.vars.HOME : this.fs.home) : who === '+' ? this.fs.cwd : who === '-' ? this.oldpwd || null : who === (st.vars.USER || 'student') ? this.fs.home : who === 'root' ? '/root' : null;
        return home == null ? null : { text: home, next: j };
      };
      if (raw[0] === '~' && assignAt == null) {
        const t = tilde(0);
        if (t) {
          add(t.text, true);
          i = t.next;
        }
      }
      while (i < n) {
        const c = raw[i];
        if (c === '~' && assignAt != null && i >= assignAt && (i === assignAt || raw[i - 1] === ':')) {
          const t = tilde(i);
          if (t) {
            add(t.text, true);
            i = t.next;
            continue;
          }
        }
        if (c === '\\') {
          if (raw[i + 1] !== '\n') add(i + 1 < n ? raw[i + 1] : '\\', true);
          i += 2;
        } else if (c === "'") {
          const k = scanSq(raw, i);
          add(raw.slice(i + 1, k - 1), true);
          i = k;
        } else if (c === '"') {
          // inside double quotes: $ ` and \ keep their meaning
          const end = scanDq(raw, i);
          let j = i + 1, lit = '', sawAt = false;
          while (j < end - 1) {
            const d = raw[j];
            if (d === '\\') {
              const e = raw[j + 1];
              if (e === '\n') j += 2;
              else if ('$`"\\'.includes(e)) {
                lit += e;
                j += 2;
              } else {
                lit += '\\';
                j++;
              }
            } else if (d === '`') {
              const k = scanBq(raw, j);
              if (lit !== '') add(lit, true);
              lit = '';
              addValue(await this._subst(raw.slice(j + 1, k - 1).replace(/\\([`$\\"])/g, '$1'), st, io), true);
              j = k;
            } else if (d === '$') {
              const r = await this._dollar(raw, j, st, io, true);
              if (r && r.word !== undefined) {
                // "${x:-word}", "${a[@]+"${a[@]}"}": the word, read as a text in double quotes – its own ' and ~ are
                // characters like any other, a "$@" in it is one word per argument (and none at all when there is none)
                if (lit !== '') add(lit, true);
                lit = '';
                const sub = [];
                await this._expandOne('"' + undq(r.word) + '"', st, io, split, sub, pat);
                if (sub.length) merge(sub);
                else sawAt = true;
                j = r.next;
              } else if (r) {
                if (lit !== '') add(lit, true);
                lit = '';
                addValue(r.val, r.isAt ? '@' : true);
                if (r.isAt) sawAt = true;
                j = r.next;
              } else {
                lit += d;
                j++;
              }
            } else {
              lit += d;
              j++;
            }
          }
          if (lit !== '' || !sawAt) add(lit, true);
          i = end;
        } else if (c === '`') {
          const k = scanBq(raw, i);
          addValue(await this._subst(raw.slice(i + 1, k - 1).replace(/\\([`$\\])/g, '$1'), st, io), false);
          i = k;
        } else if (c === '$' && raw[i + 1] === '"') {
          // $"…": a text that a translation could replace – here it is the text
          i++;
        } else if (c === '$') {
          const r = await this._dollar(raw, i, st, io, false);
          if (r && r.word !== undefined) {
            // ${x:-word}, ${x:+word}: the word is expanded where it stands – what is quoted in it stays together, the
            // rest is split ([${u:-  a  }] is three words: [ a ]); a ~ at its start is the home folder
            await walk(r.word, assignAt != null ? 0 : undefined, true);
            i = r.next;
          } else if (r) {
            addValue(r.val, r.quoted ? true : r.isAt && !split ? 'sp' : false);
            i = r.next;
          } else {
            // (a $ that begins nothing: a character like any other – in [[ x =~ a$ ]] the end of the text)
            add(c, false);
            i++;
          }
        } else if ((c === '<' || c === '>') && raw[i + 1] === '(') {
          const k = scanSub(raw, i + 1);
          add(await this._psub(c, raw.slice(i + 2, k - 1), st, io), true);
          i = k;
        } else if (wordOf && split) {
          // (see wordOf: the plain text of the word, up to the next quote, backslash or $, is split like a value)
          let k = i + 1;
          while (k < n && !'\\\'"`$'.includes(raw[k]) && !((raw[k] === '<' || raw[k] === '>') && raw[k + 1] === '(')) k++;
          addValue(raw.slice(i, k), false);
          i = k;
        } else {
          add(c, false);
          i++;
        }
      }
    };
    await walk(raw, assignAt, wordOf);
    flush();
  };
  /** an expansion that starts with $ at raw[i] → { val, next } (null: a plain $) */
  Shell.prototype._dollar = async function (raw, i, st, io, inDq) {
    const c = raw[i + 1];
    if (c === '(') {
      if (raw[i + 2] === '(') {
        let inner = -1;
        try {
          inner = scanParen(raw, i + 2);
        } catch (e) {
          if (!e.syntax) throw e;
        }
        if (inner > 0 && raw[inner] === ')') return { val: await this._arithText(raw.slice(i + 3, inner - 1), st, io), next: inner + 1 };
      }
      const end = scanSub(raw, i + 1);
      return { val: await this._subst(raw.slice(i + 2, end - 1), st, io), next: end };
    }
    if (c === '{') {
      const end = scanBrace(raw, i + 1);
      return Object.assign(await this._param(raw.slice(i + 2, end - 1), st, io, inDq), { next: end });
    }
    if (c === '[') {
      // $[ … ]: the old way of writing $(( … ))
      const end = scanBracket(raw, i + 1);
      return { val: await this._arithText(raw.slice(i + 2, end - 1), st, io), next: end };
    }
    if (c === "'" && !inDq) {
      // $'…' with backslash escapes
      let j = i + 2, s = '';
      while (j < raw.length && raw[j] !== "'") {
        if (raw[j] === '\\' && j + 1 < raw.length) {
          s += raw[j] + raw[j + 1];
          j += 2;
        } else s += raw[j++];
      }
      // (a variable cannot hold a NUL byte: the text ends there, as in bash)
      return { val: settleRaw(unescapeC(s)).split('\0')[0], next: j + 1, quoted: true };
    }
    const m = /^[A-Za-z_]\w*/.exec(raw.slice(i + 1, i + 200));
    if (m) {
      let v = this._get(m[0], st);
      // ($a of an array is its element 0: a=(); echo "$a" is "a: unbound variable" under set -u)
      if (Array.isArray(v)) v = v[0];
      else if (isAssoc(v)) v = v.get('0');
      if (v === undefined && nounset(st, m[0])) throw unsetErr(`${m[0]}: unbound variable`);
      return { val: v, next: i + 1 + m[0].length };
    }
    if (c !== undefined && /[0-9?#@*$!-]/.test(c)) {
      const v = this._get(c, st);
      if (v === undefined && /\d/.test(c) && nounset(st, c)) throw unsetErr(`$${c}: unbound variable`);
      return { val: v, next: i + 2, isAt: c === '@' };
    }
    return null;
  };
  /** ${…} */
  Shell.prototype._param = async function (body, st, io, inDq) {
    let m;
    if (body !== '#' && (m = /^#([A-Za-z_]\w*|[@*#?]|\d+)(\[[@*]\])?$/.exec(body))) {
      const v = this._get(m[1], st);
      // (set -u: the length of what is not there is a mistake – ${#name}, ${#1}, ${#name[@]})
      if ((v === undefined || declaredOnly(v)) && !/^[@*#?]$/.test(m[1]) && nounset(st, m[1])) throw unsetErr(`${m[1]}: unbound variable`);
      if (m[2] || m[1] === '@' || m[1] === '*') return { val: String(Array.isArray(v) ? v.filter((x) => x !== undefined).length : isAssoc(v) ? v.size : v == null ? 0 : 1) };
      return { val: String(Array.from(Array.isArray(v) ? v[0] || '' : isAssoc(v) ? v.get('0') || '' : v == null ? '' : String(v)).length) };
    }
    // ${#name[index]}: the length of one element
    if ((m = /^#([A-Za-z_]\w*)\[([^\]]+)\]$/.exec(body))) {
      const v = this._get(m[1], st);
      let e;
      if (isAssoc(v)) e = v.get(await this._expand(m[2], st, io, 'one'));
      else {
        const k = await this._arith(m[2], st, io);
        e = Array.isArray(v) ? v[k < 0 ? v.length + k : k] : k === 0 ? v : undefined;
      }
      return { val: String(e == null ? 0 : String(e).length) };
    }
    if (body[0] === '!') {
      // ${!name[@]}: the indices of an array, or the keys of an associative array
      if ((m = /^!([A-Za-z_]\w*)\[([@*])\]$/.exec(body))) {
        const v = this._get(m[1], st);
        const keys = Array.isArray(v) ? v.map((x, k) => (x === undefined ? null : String(k))).filter((x) => x != null) : isAssoc(v) ? v.keys() : v == null ? [] : ['0'];
        return { val: keys, isAt: m[2] === '@' };
      }
      // ${!#}: the last argument;  ${!prefix@}, ${!prefix*}: the names of the variables that begin with prefix
      if (body === '!#') return { val: st.args.length ? st.args[st.args.length - 1] : st.name };
      // ${!#:-word}, ${!#%.gz} …: the last argument, and then what follows is done to it
      if (body.startsWith('!#') && /^[-:=+?%#\/^,]/.test(body[2])) return this._param(String(st.args.length) + body.slice(2), st, io, inDq);
      if ((m = /^!([A-Za-z_]\w*)([@*])$/.exec(body))) return { val: Object.keys(st.vars).filter((k) => k.startsWith(m[1]) && st.vars[k] !== undefined && /^[A-Za-z_]\w*$/.test(k)).sort(), isAt: m[2] === '@' };
      // ${!name}: the value of the variable whose name is the value of name – which may be an element (ref='arr[1]')
      // or a whole array (ref='arr[@]'); ${!name:-word}, ${!name^^} …: the same, and then what follows is done to it.
      // (Of a name reference – declare -n – ${!ref} is the name it stands for.)
      if ((m = /^!([A-Za-z_]\w*|\d+)([\s\S]*)$/.exec(body))) {
        const at = st.attrs && st.attrs.get(m[1]);
        if (at && at.n && !m[2]) return { val: st.vars[m[1]] };
        const ref = this._get(m[1], st);
        if (typeof ref !== 'string' || !/^([A-Za-z_]\w*(\[[\s\S]+\])?|\d+|[@*#?])$/.test(ref)) {
          if (ref === undefined && nounset(st, m[1])) throw unsetErr(`${m[1]}: unbound variable`);
          // (${!unset-word} and its kin give the word; a plain ${!unset} is a mistake, as in bash 5.2)
          if (ref === undefined || ref === '') {
            if (/^:?[-=+?]/.test(m[2])) return this._param(m[1] + m[2], st, io, inDq);
            throw lineErr(`${m[1]}: invalid indirect expansion`);
          }
          throw lineErr(`${ref}: invalid variable name`);
        }
        return this._param(ref + m[2], st, io, inDq);
      }
      throw lineErr(`\${${body}}: bad substitution`);
    }
    m = /^([A-Za-z_]\w*|\d+|[@*#?$!-])/.exec(body);
    if (!m) throw lineErr(`\${${body}}: bad substitution`);
    const name = m[1];
    // NAME[subscript]: up to the bracket that closes it (the subscript may hold brackets of its own: ${a[${#a[@]}-1]})
    let headLen = m[0].length;
    if (body[headLen] === '[') {
      let depth = 0, j = headLen;
      for (; j < body.length; j++) {
        if (body[j] === '[') depth++;
        else if (body[j] === ']' && --depth === 0) break;
      }
      if (j >= body.length) throw lineErr(`\${${body}}: bad substitution`);
      m = [body.slice(0, j + 1), name, body.slice(headLen, j + 1), body.slice(headLen + 1, j)];
      headLen = j + 1;
    } else m = [m[0], name, undefined, undefined];
    const rest = body.slice(headLen);
    let v = this._get(name, st);
    let isAt = name === '@';
    if (m[2] !== undefined) {
      if (m[3] === '@' || m[3] === '*') {
        v = Array.isArray(v) ? v.filter((x) => x !== undefined) : isAssoc(v) ? v.values() : v == null ? [] : [v];
        isAt = m[3] === '@';
      } else if (isAssoc(v)) {
        const key = await this._expand(m[3], st, io, 'one');
        v = v.get(key);
      } else {
        const k = await this._arith(m[3], st, io);
        v = Array.isArray(v) ? v[k < 0 ? v.length + k : k] : k === 0 ? v : undefined;
      }
    } else if (Array.isArray(v) && name !== '@' && name !== '*') v = v[0];
    else if (isAssoc(v)) v = v.get('0');
    const unbound = () => unsetErr(`${name}: unbound variable`);
    const noValue = v === undefined || v === '' || (Array.isArray(v) && !v.length);
    // (an array without elements – "${a[@]}", "$@" – counts as not set: ${a[@]+has} is empty)
    const notSet = v === undefined || (Array.isArray(v) && !v.length);
    // a pattern: what was written in quotes or after a backslash is itself, not a wildcard (${q//\?/!})
    const pattern = (w) => this._expandPat(w, st, io);
    if (!rest) {
      if (v === undefined && !/^[@*]$/.test(name) && nounset(st, name)) throw unbound();
      return { val: v, isAt };
    }
    // (the word of := and :? as one text: in double quotes its own ' and ~ are plain characters)
    const word = (w) => this._expand(inDq ? '"' + undq(w) + '"' : w, st, io, 'one');
    const op = /^(:?[-=+?])/.exec(rest);
    if (op) {
      const o = op[1].slice(-1), w = rest.slice(op[1].length);
      const use = op[1].length === 2 ? noValue : notSet;
      // ${x:-word}, ${x:+word}: the quotes of the word count – ${v:+-o "$v"} is two words, "${a[@]+"${a[@]}"}" one
      // word per element. So the word goes back as it was written ({ word }), and whoever asked – who knows whether
      // the expansion stands in double quotes – expands it (see _expandOne, _heredoc).
      if (o === '-') return use ? { word: w } : { val: v, isAt };
      if (o === '=') {
        if (!use) return { val: v, isAt };
        const nv = await word(w);
        if (m[2] !== undefined && m[3] !== '@' && m[3] !== '*') {
          // ${a[7]:=x}, ${count[$key]:=0}: that element gets the value (not element 0, and not the whole variable)
          const old = this._get(name, st);
          if (isAssoc(old)) this._set(name, old.with(await this._expand(m[3], st, io, 'one'), nv), st);
          else {
            const arr = Array.isArray(old) ? old.slice() : old == null ? [] : [old];
            let k = await this._arith(m[3], st, io);
            if (k < 0) k += arr.length;
            if (k < 0) throw lineErr(`${name}[${m[3]}]: bad array subscript`);
            arr[k] = nv;
            this._set(name, arr, st);
          }
        } else this._set(name, nv, st);
        return { val: nv };
      }
      // ("${a[@]+…}", "${@:+…}" of nothing: no word at all, as "$@" is)
      if (o === '+') return use ? (isAt ? { val: [], isAt: true } : { val: '' }) : { word: w };
      if (use) throw unsetErr(`${name}: ${(await word(w)) || (op[1].length === 2 ? 'parameter null or not set' : 'parameter not set')}`);
      return { val: v, isAt };
    }
    if (v === undefined && !/^[@*]$/.test(name) && nounset(st, name)) throw unbound();
    const each = (fn) => (Array.isArray(v) ? { val: v.map((x) => fn(String(x))), isAt } : { val: fn(v == null ? '' : String(v)) });
    if (rest[0] === '%' || rest[0] === '#') {
      const long = rest[1] === rest[0];
      const re = globRe(await pattern(rest.slice(long ? 2 : 1)), '', !extOn(st));
      const suffix = rest[0] === '%';
      return each((s) => {
        // the shortest or the longest piece at that end that matches the pattern
        const ks = [];
        for (let k = 0; k <= s.length; k++) ks.push(k);
        if (suffix !== long) ks.reverse();
        for (const k of ks) if (re.test(suffix ? s.slice(k) : s.slice(0, k))) return suffix ? s.slice(0, k) : s.slice(k);
        return s;
      });
    }
    if (rest[0] === '/') {
      const all = rest[1] === '/';
      let spec = rest.slice(all ? 2 : 1), anchor = '';
      if (!all && (spec[0] === '#' || spec[0] === '%')) {
        anchor = spec[0];
        spec = spec.slice(1);
      }
      // the pattern ends at the first / that is not in quotes – in ${p//…} a / at its very start belongs to it:
      // ${p////_} replaces every / (as ${p//\//_} does)
      let cut = -1;
      for (let k = all && spec[0] === '/' ? 1 : 0; k < spec.length; k++) {
        const c = spec[k];
        if (c === '\\') k++;
        else if (c === "'") k = scanSq(spec, k) - 1;
        else if (c === '"') k = scanDq(spec, k) - 1;
        else if (c === '$' && spec[k + 1] === '{') k = scanBrace(spec, k + 1) - 1;
        else if (c === '$' && spec[k + 1] === '(') k = scanSub(spec, k + 1) - 1;
        else if (c === '/') {
          cut = k;
          break;
        }
      }
      const patText = cut < 0 ? spec : spec.slice(0, cut);
      // (${p/#~/x}: behind the # the ~ is a character – it is not what the pattern begins with)
      let pat = await pattern(anchor && patText[0] === '~' ? '\\' + patText : patText);
      // (the # or % may also come out of a variable: v='#chr'; ${name/$v/})
      if (!all && !anchor && spec[0] === '$' && (pat[0] === '#' || pat[0] === '%')) {
        anchor = pat[0];
        pat = pat.slice(1);
      }
      // The text to put in. As in bash 5.2 an & in it that is not quoted stands for what the pattern matched
      // (${f/reads/[&]}); \& is an & itself. shopt -u patsub_replacement switches that off.
      const amp = !(st.shopt && st.shopt.patsub_replacement === false);
      let rep = '', marked = null;
      if (cut >= 0) {
        if (amp) {
          const out = [];
          await this._expandOne(spec.slice(cut + 1), st, io, false, out, 'rep');
          marked = out.map((f) => f.v).join(' ');
          if (!/[&\\]/.test(marked)) {
            rep = marked;
            marked = null;
          }
        } else rep = await word(spec.slice(cut + 1));
      }
      const put = (hit) => (marked == null ? rep : marked.replace(/\\([\\&])|&/g, (x, c) => (c !== undefined ? c : hit)));
      // ${s/#/pre-}, ${a[@]/%/.bam}: nothing at the start (at the end) is replaced – the text is put in front (behind)
      if (pat === '') return each((s) => (anchor === '#' ? put('') + s : anchor === '%' ? s + put('') : s));
      const src = globRe(pat, '', !extOn(st)).source.slice(1, -1);
      const re = new RegExp(anchor === '#' ? '^(?:' + src + ')' : anchor === '%' ? '(?:' + src + ')$' : src, all ? 'g' : '');
      return each((s) => s.replace(re, (hit) => put(hit)));
    }
    if (rest[0] === ':') {
      // ${x:offset} and ${x:offset:length}: two sums; the : between them is the first that is not part of a ?: or
      // inside brackets (${s:(n > 1 ? 5 : 0)})
      const spec = rest.slice(1);
      if (!spec.trim()) throw lineErr(`\${${body}}: bad substitution`);
      let cutAt = -1;
      for (let k = 0, depth = 0, q = 0; k < spec.length; k++) {
        const c = spec[k];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === '?' && !depth) q++;
        else if (c === ':' && !depth) {
          if (q) q--;
          else {
            cutAt = k;
            break;
          }
        }
      }
      const a = cutAt < 0 ? spec : spec.slice(0, cutAt), b = cutAt < 0 ? undefined : spec.slice(cutAt + 1);
      const off = await this._arith(a, st, io);
      const len = b === undefined ? undefined : await this._arith(b, st, io);
      const tooShort = () => lineErr(`${b}: substring expression < 0`);
      if (Array.isArray(v)) {
        // ${@:2}: the positional parameters count from 1 ($0 is number 0); ${@: -1}: the last one.
        // ${arr[@]:N}: from the element with index N on (an array may have gaps); ${arr[@]: -2}: N counts back
        // from the last index. The length is a number of elements, and cannot be negative.
        let idx = [];
        if (m[2] === undefined && (name === '@' || name === '*')) v = [st.name || 'bash'].concat(v);
        else if (m[2] !== undefined) {
          // (the array itself, with its gaps)
          const whole = this._get(name, st);
          if (Array.isArray(whole)) v = whole;
        }
        v.forEach((x, k) => {
          if (x !== undefined) idx.push(k);
        });
        const size = idx.length ? idx[idx.length - 1] + 1 : 0, from = off < 0 ? off + size : off;
        if (from < 0 || from > size) return { val: [], isAt };
        if (len !== undefined && len < 0) throw tooShort();
        idx = idx.filter((k) => k >= from);
        return { val: (len === undefined ? idx : idx.slice(0, len)).map((k) => v[k]), isAt };
      }
      // (characters, not bytes; an offset before the start or behind the end gives nothing; a negative length is
      // a place counted from the end – before the offset it is an error)
      const chars = Array.from(v == null ? '' : String(v)), size = chars.length;
      const from = off < 0 ? off + size : off;
      if (from < 0 || from > size) return { val: '' };
      let to = size;
      if (len !== undefined) {
        to = len < 0 ? len + size : from + len;
        if (len < 0 && (to < 0 || to < from)) throw tooShort();
      }
      return { val: chars.slice(from, Math.min(to, size)).join('') };
    }
    // ${x^} ${x^^} ${x,} ${x,,} ${x~} ${x~~}: the case of the first character, or of all – with a pattern behind
    // it, of the characters that match the pattern (${x^^[aeiou]})
    const cm = /^(\^\^|\^|,,|,|~~|~)([\s\S]*)$/.exec(rest);
    if (cm) {
      const re = cm[2] ? globRe(await pattern(cm[2]), '', !extOn(st)) : null;
      const flip = (c) => (c === upperC(c) ? lowerC(c) : upperC(c));
      const fn = cm[1][0] === '^' ? upperC : cm[1][0] === ',' ? lowerC : flip;
      const one = (c) => (!re || re.test(c) ? fn(c) : c);
      return each((s) => {
        const chars = Array.from(s);
        return cm[1].length === 2 ? chars.map(one).join('') : chars.length ? one(chars[0]) + chars.slice(1).join('') : '';
      });
    }
    // ${x@Q} (quoted so that the shell reads it back), @U @u @L (case), @E (backslash escapes carried out), @P (as
    // a prompt), @A (as an assignment), @a (what the variable is: a, A, i, r, x …), @K @k (keys and values)
    if (/^@[QUuLEPAaKk]$/.test(rest)) {
      const o = rest[1];
      const q = (s) => (s === '' ? "''" : /[\x00-\x1f\x7f]/.test(s) ? shellQuote(s) : "'" + s.replace(/'/g, "'\\''") + "'");
      const whole = this._get(name, st), at = (st.attrs && st.attrs.get(name)) || {};
      const flags = (Array.isArray(whole) ? 'a' : isAssoc(whole) ? 'A' : '') + (at.i ? 'i' : '') + (at.l ? 'l' : '') + (at.n ? 'n' : '') + (st.readonly && st.readonly.has(name) ? 'r' : '') + (at.u ? 'u' : '') + (st.exported && st.exported.has(name) ? 'x' : '');
      if (o === 'a') return Array.isArray(v) ? { val: v.map(() => flags), isAt } : { val: flags };
      if (v === undefined || (Array.isArray(v) && !v.length)) return { val: Array.isArray(v) ? [] : '', isAt };
      if (o === 'U') return each((s) => upperC(s));
      if (o === 'L') return each((s) => lowerC(s));
      if (o === 'u') return each((s) => { const a = Array.from(s); return (a.length ? upperC(a[0]) : '') + a.slice(1).join(''); });
      if (o === 'Q') return each(q);
      if (o === 'E') return each((s) => settleRaw(unescapeC(s)));
      if (o === 'P') {
        const host = String(st.vars.HOSTNAME || 'biolab'), pretty = (d) => this.fs.pretty(d);
        return each((s) => s.replace(/\\(\[|\]|[uhHwW$nrtaes\\])/g, (x, c) => ({ u: String(st.vars.USER || 'student'), h: host.split('.')[0], H: host, w: pretty(this.fs.cwd), W: this.fs.cwd === this.fs.home ? '~' : this.fs.cwd.split('/').pop() || '/', $: '$', n: '\n', r: '\r', t: new Date().toTimeString().slice(0, 8), a: '\x07', e: '\x1b', s: 'bash', '\\': '\\', '[': '', ']': '' })[c]));
      }
      if (o === 'A') {
        if (m[2] !== undefined && (m[3] === '@' || m[3] === '*')) {
          const body2 = isAssoc(whole) ? whole.entries().map(([a, b]) => `[${a}]=${q(String(b))} `).join('') : (Array.isArray(whole) ? whole : []).map((x, k) => (x === undefined ? null : `[${k}]=${q(String(x))}`)).filter((x) => x != null).join(' ');
          return { val: `declare -${flags || '-'} ${name}=(${body2})` };
        }
        return { val: (flags ? `declare -${flags} ` : '') + `${name}=${q(String(Array.isArray(v) ? v[0] : v))}` };
      }
      // @K, @k
      if (m[2] !== undefined && (m[3] === '@' || m[3] === '*')) {
        const pairs = isAssoc(whole) ? whole.entries() : (Array.isArray(whole) ? whole : []).map((x, k) => [String(k), x]).filter((e) => e[1] !== undefined);
        return o === 'k' ? { val: pairs.flatMap(([a, b]) => [a, String(b)]), isAt: true } : { val: pairs.map(([a, b]) => `${a} "${String(b).replace(/[\\"$\`]/g, '\\$&')}"`).join(' ') };
      }
      return each(q);
    }
    throw lineErr(`\${${body}}: bad substitution`);
  };
  /* A byte that is no character by itself – printf '\377', echo -e '\xE2\x9C\x93', $'\xff' – is kept in a text as
     a "lone low surrogate" (U+DC80 … U+DCFF: no real text holds one). A run of such bytes that spells characters in
     UTF-8 becomes those characters (settleRaw); what is left goes out as the bytes it stands for (rawOut). */
  const RAW_ONE = /[\uDC80-\uDCFF]/u, RAW_RUN = /[\uDC80-\uDCFF]+/gu, RAW_SPLIT = /([\uDC80-\uDCFF])/u;
  const rawByte = (n) => String.fromCharCode((n & 255) < 0x80 ? n & 255 : 0xdc00 + (n & 255));
  function settleRaw(s) {
    if (!RAW_ONE.test(s)) return s;
    return s.replace(RAW_RUN, (run) => {
      const b = Uint8Array.from(run, (c) => c.charCodeAt(0) - 0xdc00);
      let out = '', i = 0;
      while (i < b.length) {
        const n = b[i] >= 0xf0 ? 4 : b[i] >= 0xe0 ? 3 : b[i] >= 0xc2 ? 2 : 0;
        let ch = null;
        if (n && i + n <= b.length) {
          try {
            ch = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(i, i + n));
          } catch (e) {
            ch = null;
          }
        }
        if (ch != null && Array.from(ch).length === 1) {
          out += ch;
          i += n;
        } else out += run[i++];
      }
      return out;
    });
  }
  /** what a command prints: the text – or, if bytes that are no characters are in it, the bytes */
  function rawOut(s) {
    if (!RAW_ONE.test(s)) return s;
    const enc = new TextEncoder();
    const parts = s.split(RAW_SPLIT).map((p, i) => (i % 2 ? Uint8Array.of(p.charCodeAt(0) - 0xdc00) : enc.encode(p)));
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    parts.forEach((p) => {
      all.set(p, at);
      at += p.length;
    });
    return all;
  }
  /** (an error of the shell is said once: a block with a redirection has said it already – see _redirected) */
  const unsaid = (e) => !(e && e.said);
  /* Upper and lower case as the C library does it (towupper, towlower): character by character, each one to ONE
     character. Where the rule of a language gives two – "ß" would be "SS" – the character stays as it is. */
  const upperC = (s) => Array.from(String(s), (ch) => { const u = ch.toUpperCase(); return Array.from(u).length === 1 ? u : ch; }).join('');
  const lowerC = (s) => Array.from(String(s), (ch) => { const l = ch.toLowerCase(); return Array.from(l).length === 1 ? l : ch === '\u0130' ? 'i' : ch; }).join('');
  /** what stands before a message of the shell itself: in a script its name and the line ("analysis.sh: line 12: "),
      in bash -c and in commands read from the input "bash: line 3: ", at the prompt "bash: " */
  function prefixOf(st) {
    const name = st && (st.script || st.errName);
    return name ? `${name}: line ${st.line}: ` : 'bash: ';
  }
  function unescapeC(s) {
    return s.replace(/\\(n|t|r|a|b|e|E|f|v|\\|'|"|\?|c[\s\S]|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|0[0-7]{0,3}|[1-7][0-7]{0,2})/g, (m, c) => {
      switch (c[0]) {
        // \cA: the control character of that letter (Ctrl+A is 1); \c? is DEL
        case 'c': return c[1] === '?' ? '\x7f' : String.fromCharCode(c[1].toUpperCase().charCodeAt(0) & 0x1f);
        case 'u':
        case 'U': return String.fromCodePoint(parseInt(c.slice(1), 16));
        case '?': return '?';
        case 'n': return '\n';
        case 't': return '\t';
        case 'r': return '\r';
        case 'a': return '\x07';
        case 'b': return '\b';
        case 'e':
        case 'E': return '\x1b';
        case 'f': return '\f';
        case 'v': return '\v';
        case 'x': return rawByte(parseInt(c.slice(1), 16));
        case '\\':
        case "'":
        case '"': return c;
        default: return rawByte(parseInt(c, 8));
      }
    });
  }
  /** the text of a here-document: $ and ` are expanded, quotes are plain text */
  Shell.prototype._heredoc = async function (body, st, io) {
    let out = '', i = 0;
    while (i < body.length) {
      const c = body[i];
      if (c === '\\' && '$`\\'.includes(body[i + 1])) {
        out += body[i + 1];
        i += 2;
      } else if (c === '\\' && body[i + 1] === '\n') i += 2;
      else if (c === '`') {
        const k = scanBq(body, i);
        out += await this._subst(body.slice(i + 1, k - 1), st, io);
        i = k;
      } else if (c === '$') {
        const r = await this._dollar(body, i, st, io, true);
        if (r && r.word !== undefined) {
          out += await this._expand('"' + undq(r.word) + '"', st, io, 'one');
          i = r.next;
        } else if (r) {
          out += Array.isArray(r.val) ? r.val.join(' ') : r.val == null ? '' : r.val;
          i = r.next;
        } else {
          out += c;
          i++;
        }
      } else {
        out += c;
        i++;
      }
    }
    return out;
  };
  /** $( … ): what the commands print, without the newlines at the end */
  Shell.prototype._subst = async function (text, st, io) {
    // (a variable cannot hold a NUL byte: bash leaves them out of what $( ) gives, and says so)
    const noNul = (t) => {
      if (!t.includes('\0')) return t;
      io.err(`${prefixOf(st)}warning: command substitution: ignored null byte in input\n`);
      return t.replace(/\0/g, '');
    };
    // $(< FILE) is the contents of the file
    const whole = /^\s*<\s*((?:"(?:[^"\\]|\\[\s\S])*"|'[^']*'|\\[\s\S]|[^\s"'\\<>|&;()])+)\s*$/.exec(text);
    if (whole) {
      const f = await this._expand(whole[1], st, io, 'one');
      await this._settleOut();
      if (!this.fs.exists(f) || this.fs.isDir(f)) {
        io.err(`bash: ${f}: No such file or directory\n`);
        st.sub = 1;
        return '';
      }
      st.sub = 0;
      return noNul(await this.fs.readText(f)).replace(/\n+$/, '');
    }
    const ast = parse(text, { extglob: extOn(st) });
    const sub = this._child(st);
    sub.lineFixed = st.line;
    sub.xlevel = (st.xlevel || 0) + 1;
    // (inside $( ) bash switches set -e off – unless shopt -s inherit_errexit is on:  x=$(false; echo still)  gives "still")
    if (!(st.shopt && st.shopt.inherit_errexit)) sub.flags.e = sub.flags.se = false;
    let buf = '';
    const sio = ioWith(io, { out: (t) => (buf += t) });
    const cwd = this.fs.cwd, oldpwd = this.oldpwd;
    let code = 0;
    try {
      try {
        code = await this._runList(ast, sub, sio);
      } catch (c) {
        if (c && c.shellControl && !halts(c)) code = c.code;
        else if (c && c.shellError) {
          // an error of the language in there (an unset variable with set -u …) ends those commands, not the script
          unsaid(c) && io.err(`${prefixOf(st)}${c.message}\n`);
          code = c.code || 1;
        } else throw c;
      }
      code = await this._exitTrap(sub, sio, code);
    } finally {
      {
        this.fs.cwd = cwd;
        this.oldpwd = oldpwd;
      }
    }
    st.sub = code;
    this.lastCode = code;
    return noNul(buf).replace(/\n+$/, '');
  };
  /** Process substitution.  <( commands ): the commands are run, what they print is put into a file, and the word
      is the name of that file (diff <(sort a) <(sort b);  while read x; do …; done < <(commands)).
      >( commands ): the word is the name of an empty file; when the command that got it has ended, the commands
      are run with that file as their input (tee >(wc -l > n.txt)).
      In bash the commands run at the same time as the command they belong to, joined by a pipe; here they run
      before it (after it, for >( )): the result is the same, the order of what appears in the terminal may not be.
      The files are removed when the pipeline has ended (see _psubEnd). */
  let PSUB = 0;
  Shell.prototype._psub = async function (kind, text, st, io) {
    if (!this.fs.isDir('/tmp')) this.fs.mkdirp('/tmp');
    const path = `/tmp/.psub-${++PSUB}`;
    const entry = { path, kind, text, st };
    (this._psubs = this._psubs || []).push(entry);
    if (kind === '>') {
      this.fs.writeText(path, '');
      return path;
    }
    const sub = this._child(st);
    sub.stdin = null;
    // (what the commands print is kept as it is – the bytes of a program too: samtools view -c <(samtools view -b x.bam))
    const sink = new Sink();
    const sio = ioWith(io, { out: (t) => sink.add(t), bytes: true });
    const cwd = this.fs.cwd, oldpwd = this.oldpwd, last = this.lastCode;
    try {
      await this._runList(parse(text, { extglob: extOn(st) }), sub, sio);
    } catch (c) {
      if (c && c.shellControl && !halts(c)) {
        /* exit in there: those commands end */
      } else if (c && c.shellError) unsaid(c) && io.err(`${prefixOf(st)}${c.message}\n`);
      else throw c;
    } finally {
      {
        this.fs.cwd = cwd;
        this.oldpwd = oldpwd;
      }
      this.lastCode = last;
    }
    await this.writeOut(path, sink, false);
    return path;
  };
  /** the pipeline has ended: the commands of its >( ) get their input now, and the files go */
  Shell.prototype._psubEnd = async function (mark, io) {
    const list = this._psubs || [];
    while (list.length > mark) {
      const e = list.splice(mark, 1)[0];
      if (e.kind === '>' && !e.held && this.fs.exists(e.path) && !(this.term && this.term.cancelled)) {
        const sub = this._child(e.st);
        // (path: a program that reads it gets the file itself, byte for byte:  tee >(samtools view -c - > n.txt))
        sub.stdin = { text: await this.fs.readText(e.path), pos: 0, pipe: true, path: e.path };
        const cwd = this.fs.cwd, oldpwd = this.oldpwd, last = this.lastCode;
        try {
          await this._runList(parse(e.text, { extglob: extOn(e.st) }), sub, io);
        } catch (c) {
          if (c && c.shellControl && !halts(c)) {
            /* exit in there */
          } else if (c && c.shellError) unsaid(c) && io.err(`bash: ${c.message}\n`);
          else throw c;
        } finally {
          {
        this.fs.cwd = cwd;
        this.oldpwd = oldpwd;
      }
          this.lastCode = last;
        }
      }
      if (this.fs.exists(e.path)) this.fs.remove(e.path);
    }
  };
  /** The variables of an expression. Under set -u a name without a value is a mistake, as it is in $name:
      n=$((n + 1)), ((count++)), ${a[i]}, ${s:off}, [[ n -eq 0 ]] with n, count, i, off not set end the script. */
  Shell.prototype._arithGet = function (st) {
    const get = (name) => this._get(name, st);
    if (st.flags.u) get.unbound = (name) => {
      throw unsetErr(`${name}: unbound variable`);
    };
    else if (st.flags.su) get.unbound = (name) => void nounset(st, name);
    return get;
  };
  Shell.prototype._arith = async function (expr, st, io) {
    // ($x, $(cmd) and "quotes" in the expression are taken care of first: $(( "$n" + 1 )) is $(( n + 1 )))
    const text = /[$`"]/.test(expr) ? await this._expand(expr, st, io, 'one') : expr;
    return arithEval(text, this._arithGet(st), (name, v) => this._set(name, v, st));
  };
  /** $(( … )): the result as a text, exact to the last digit */
  Shell.prototype._arithText = async function (expr, st, io) {
    const text = /[$`"]/.test(expr) ? await this._expand(expr, st, io, 'one') : expr;
    return String(arithBig(text, this._arithGet(st), (name, v) => this._set(name, v, st)));
  };
  /** the words of a command, as the strings the program gets */
  const ARRAY_WORD = '\u0001array\u0001'; // marks NAME=( … ) among the arguments of a declaration command
  Shell.prototype._words = async function (words, st, io, declaration) {
    const out = [];
    for (let k = 0; k < words.length; k++) {
      const w = words[k];
      // export NAME=value, local NAME=value: the value is one word, as in an assignment
      if (declaration && k > 0 && ASSIGN.test(w)) {
        // local NAME=(a b c), declare -A NAME=([k]=v …): the command itself makes the array (see declare)
        if (/^[A-Za-z_]\w*\+?=\([\s\S]*\)$/.test(w)) {
          out.push(ARRAY_WORD + w);
          continue;
        }
        const eq = w.indexOf('=');
        out.push(w.slice(0, eq + 1) + (await this._value(w.slice(eq + 1), st, io)));
        continue;
      }
      const am = !declaration && k > 0 && w.includes('~') ? /^[A-Za-z_]\w*=/.exec(w) : null;
      let fields;
      if (am) {
        fields = [];
        for (const r of braceExpand(w)) await this._expandOne(r, st, io, true, fields, false, am[0].length);
      } else fields = await this._expand(w, st, io, 'args');
      for (const f of fields) {
        // (set -f, set -o noglob: no file name patterns at all)
        if (f.glob && !st.flags.f) {
          const so = st.shopt || {};
          const g = this.fs.glob(f.v, { globstar: !!so.globstar, dotglob: !!so.dotglob, nocase: !!so.nocaseglob, noext: !extOn(st) });
          const none = g.length === 1 && g[0] === f.v && (extOn(st) ? /[*?]|\[[^\]]+\]|[+@!]\(/ : /[*?]|\[[^\]]+\]/).test(f.v) && !this.fs.exists(f.v);
          // shopt -s failglob: a pattern that matches nothing is an error, and the command is not run
          if (none && so.failglob) throw Object.assign(shErr(`no match: ${f.v}`), { endsLine: true });
          // shopt -s nullglob: a pattern that matches nothing gives no word at all
          // (a lone [ – the test command – is not a pattern)
          if (!(st.flags.nullglob && none)) out.push(...g);
        } else out.push(f.v);
      }
    }
    return out;
  };
  /** the right-hand side of NAME=value */
  Shell.prototype._value = async function (raw, st, io) {
    // ~ also after : (as in PATH=~/bin:~/tools)
    const out = [];
    await this._expandOne(raw, st, io, false, out, false, 0);
    return out.map((f) => f.v).join(' ');
  };
  /** carry out NAME=value; → the assignment as set -x shows it. before(shown), if given, is called when the value
      is worked out and the variable is not set yet – that is when bash prints the line for an assignment that
      stands by itself (so  PS4='> '  is still shown with the old PS4) */
  Shell.prototype._assign = async function (raw, st, io, before) {
    const h = assignHead(raw);
    const name = h.name, idx = h.sub, plus = h.plus, rhs = h.rest;
    const old = this._get(name, st);
    // (the elements of an array that is declare -i are sums, of one that is -l or -u lower or upper case)
    const at = st.attrs && st.attrs.get(name);
    const typed = (x) => {
      if (!at || typeof x !== 'string') return x;
      if (at.i) x = String(arithBig(x, this._arithGet(st), (n, v) => this._set(n, v, st)));
      if (at.l) x = lowerC(x);
      if (at.u) x = upperC(x);
      return x;
    };
    const added = (before, more) => typed(at && at.i ? `(${before || 0}) + (${more || 0})` : (before || '') + more);
    let val, shown = raw; // (shown: the assignment as set -x prints it – an array as it was written)
    if (idx === undefined && rhs[0] === '(' && rhs[rhs.length - 1] === ')') {
      const words = compoundWords(rhs.slice(1, -1));
      if (isAssoc(old)) {
        // m=([key]=value …)
        val = new Assoc(plus ? old : null);
        // (in such a list bash does not take a ~ for the home folder – m=([ref]=~/ref.fa) holds "~/ref.fa" –,
        // unlike in m[ref]=~/ref.fa and in the list of an ordinary array)
        const plainValue = async (raw) => {
          const out = [];
          await this._expandOne(raw[0] === '~' ? '\\' + raw : raw, st, io, false, out, false);
          return out.map((f) => f.v).join(' ');
        };
        if (words.length && !words.some((w) => w[0] === '[')) {
          // m=(key value key value …), as bash 5.1 and later take it
          for (let k = 0; k < words.length; k += 2) val.set(await this._expand(words[k], st, io, 'one'), typed(k + 1 < words.length ? await plainValue(words[k + 1]) : ''));
        } else {
          for (const w of words) {
            const e = /^\[([^\]]*)\]=([\s\S]*)$/.exec(w);
            if (!e) throw lineErr(`${name}: ${w}: must use subscript when assigning associative array`);
            val.set(await this._expand(e[1], st, io, 'one'), typed(await plainValue(e[2])));
          }
        }
      } else {
        // a=(x y [5]=z w): the words in turn; [N]=word puts a word at place N, and the next ones follow it
        val = plus ? (Array.isArray(old) ? old.slice() : old == null ? [] : [old]) : [];
        let next = val.length;
        for (const w of words) {
          const e = /^\[([^\]]+)\]=([\s\S]*)$/.exec(w);
          if (e) {
            const k = await this._arith(e[1], st, io);
            if (k < 0) throw lineErr(`${name}: [${e[1]}]=${e[2]}: bad array subscript`);
            val[k] = typed(await this._value(e[2], st, io));
            next = k + 1;
          } else for (const f of await this._words([w], st, io)) val[next++] = typed(f);
        }
      }
    } else {
      val = await this._value(rhs, st, io);
      shown = `${name}${idx !== undefined ? '[' + idx + ']' : ''}${plus ? '+' : ''}=${val === '' ? '' : xq(val)}`;
      if (idx !== undefined && isAssoc(old)) {
        const key = await this._expand(idx, st, io, 'one');
        val = old.with(key, plus ? added(old.get(key), val) : typed(val));
      } else if (idx !== undefined) {
        const arr = Array.isArray(old) ? old.slice() : old == null ? [] : [old];
        let k = await this._arith(idx, st, io);
        // (arr[-1]=x: the last element)
        if (k < 0) k += arr.length;
        if (k < 0) throw lineErr(`${name}[${idx}]: bad array subscript`);
        arr[k] = plus ? added(arr[k], val) : typed(val);
        val = arr;
      } else if (plus && isAssoc(old)) val = old.with('0', added(old.get('0'), val)); // (m+=text: the element with the key 0)
      else if (plus && Array.isArray(old)) {
        // a+=text – without brackets – adds the text to element 0, as in bash (a new element is a+=(text))
        const arr = old.slice();
        arr[0] = added(arr[0], val);
        val = arr;
      } else if (plus && st.attrs && st.attrs.get(name) && st.attrs.get(name).i) val = `(${old || 0}) + (${val || 0})`; // n+=4 of an integer
      else if (plus) val = (old || '') + val;
    }
    if (before) await before(shown);
    this._set(name, val, st);
    return shown;
  };

  /* ------------------------------------------------------------------
     redirections
     ------------------------------------------------------------------ */
  /** expand the targets → { list: for runPipeline, plan: for blocks and functions }.
      plan.steps: the redirections, in the order they were written – the order matters:
      "2>&1 > FILE" sends the errors where the output went BEFORE it was sent to the file.
      The descriptors 3 to 9 can be opened and used as well (exec 3< FILE, read -u 3, done 3< FILE, echo x >&3,
      exec 3>&1 … exec 1>&3 3>&-). */
  /** The files of the redirections that stand before one that failed were opened before it was looked at:
      cat > FILE <<EOF … (with a mistake in the text) and  echo x > FILE > ""  leave an empty FILE behind, as in bash. */
  Shell.prototype._openEarlier = function (opened, st) {
    for (const s of opened || []) {
      if (!s.target || /^\/dev\//.test(s.target)) continue;
      try {
        const abs = this.fs.resolve(s.target), fe = this.fs.get(abs);
        if (!fe) {
          if (this.fs.isDir(MG.path.dirname(abs))) this.fs.writeText(abs, '');
        } else if (fe.kind !== 'dir' && !s.append && !fe.readonly && !fe.protected && !st.flags.C) this.fs.rewrite(abs, '');
      } catch (x) {
        /* (a file that cannot be made: nothing more to say here) */
      }
    }
  };
  Shell.prototype._redirs = async function (redirs, st, io) {
    const R = { list: [], stdinText: null, outToErr: false, any: !!(redirs && redirs.length), plan: { steps: [], out: null, err: null, errToOut: false, outToErr: false, stdinText: null, stdinFile: null } };
    const steps = R.plan.steps;
    const high = (n) => n != null && n >= 3 && n <= 9;
    // (a redirection that cannot be carried out: the files of the redirections that stand before it have been opened
    // by then, as in bash –  echo x > a.txt > ""  leaves a.txt empty. See _openEarlier.)
    const failed = (msg) => Object.assign(cmdErr(msg), { opened: steps.filter((x) => x.kind === 'file' || x.kind === 'both') });
    for (const r of redirs || []) {
      if (r.fd != null && r.fd > 9) throw shErr(`${r.fd}${r.op}: only the file descriptors 0 to 9 can be used in this terminal`);
      if (r.op === '<<') {
        let text;
        try {
          text = r.quoted ? r.body : await this._heredoc(r.body, st, io);
        } catch (e) {
          if (e && e.unset) {
            e.inHere = true;
            e.opened = steps.filter((x) => x.kind === 'file' || x.kind === 'both');
          }
          throw e;
        }
        if (high(r.fd)) {
          steps.push({ kind: 'openIn', fd: r.fd, text });
          R.fds = true;
        } else R.stdinText = R.plan.stdinText = text;
        continue;
      }
      let target;
      if (r.op !== '<<<' && /[$`*?[]/.test(r.target)) {
        // (> $out, > *.txt: after the expansion there must be exactly one word – none, or two, is "ambiguous")
        const ws = (await this._words([r.target], st, io)).filter((w) => typeof w === 'string');
        if (ws.length !== 1) throw failed(`${r.target}: ambiguous redirect`);
        target = ws[0];
      } else {
        try {
          target = await this._expand(r.target, st, io, 'one');
        } catch (e) {
          if (e && e.unset && r.op === '<<<') {
            e.inHere = true;
            e.opened = steps.filter((x) => x.kind === 'file' || x.kind === 'both');
          }
          throw e;
        }
      }
      if (r.op !== '<<<' && target === '' && !/^[<>]&$/.test(r.op)) throw failed(': No such file or directory');
      if (r.op === '<<<') {
        if (high(r.fd)) {
          steps.push({ kind: 'openIn', fd: r.fd, text: target + '\n' });
          R.fds = true;
        } else R.stdinText = R.plan.stdinText = target + '\n';
      } else if (r.op === '<') {
        if (high(r.fd)) {
          // N< FILE: the file is opened for reading as descriptor N
          steps.push({ kind: 'openIn', fd: r.fd, target });
          R.fds = true;
          continue;
        }
        if (r.fd != null && r.fd !== 0) throw shErr(`${r.fd}<: the standard output and error cannot be opened for reading`);
        if (target === '/dev/null') {
          // < /dev/null: no input at all (and what [ -c /dev/stdin ] then asks about is a device: stdinDev)
          R.stdinText = R.plan.stdinText = '';
          R.stdinDev = R.plan.stdinDev = true;
          continue;
        }
        if (/^\/dev\/(stdin|fd\/0)$/.test(target)) continue; // the input that is there already
        // (the commands of this terminal run one after the other: an input without end would never be handed over)
        if (/^\/dev\/(zero|u?random)$/.test(target)) throw failed(`${target}: an input that never ends cannot feed a command in this terminal. To take N bytes of it:  head -c N ${target}`);
        const m = /^\/dev\/fd\/([3-9])$/.exec(target);
        if (m) {
          steps.push({ kind: 'dupIn', fd: 0, to: +m[1] });
          R.fds = true;
          continue;
        }
        R.list.push({ op: '<', target });
        R.plan.stdinFile = target;
        steps.push({ kind: 'in', target });
      } else if (r.op === '&>' || r.op === '&>>') {
        R.list.push({ op: r.op === '&>' ? '&>' : '>>', target });
        if (r.op === '&>>') R.list.push({ op: '2>&1' });
        R.plan.out = { target, append: r.op === '&>>' };
        R.plan.errToOut = true;
        steps.push({ kind: 'both', target, append: r.op === '&>>' });
      } else if (r.op === '<&') {
        // <&N: the input is what descriptor N reads;  N<&M: N reads what M reads;  N<&-: N is closed
        const fd = r.fd == null ? 0 : r.fd;
        if (target === '-') steps.push({ kind: 'close', fd });
        else if (/^\d$/.test(target)) {
          if (fd === 0 && target === '0') continue;
          steps.push({ kind: 'dupIn', fd, to: +target });
        } else throw failed(`${target}: ambiguous redirect`);
        R.fds = true;
      } else if (r.op === '>&') {
        if (r.fd === 2 && target === '1') {
          R.list.push({ op: '2>&1' });
          R.plan.errToOut = true;
          steps.push({ kind: 'dup', fd: 2, to: 1 });
        } else if ((r.fd == null || r.fd === 1) && target === '2') {
          R.outToErr = R.plan.outToErr = true;
          steps.push({ kind: 'dup', fd: 1, to: 2 });
        } else if ((r.fd == null || r.fd === 1) && target === '1') continue; // >&1: where it goes already
        else if (r.fd === 2 && target === '2') continue;
        else if (r.fd == null && !/^(\d+|-)$/.test(target)) {
          R.list.push({ op: '&>', target });
          R.plan.out = { target, append: false };
          R.plan.errToOut = true;
          steps.push({ kind: 'both', target, append: false });
        } else if (target === '-') {
          // N>&-: descriptor N is closed
          steps.push({ kind: 'close', fd: r.fd == null ? 1 : r.fd });
          R.fds = true;
        } else if (/^\d$/.test(target)) {
          // >&3, 2>&3: the output (the errors) go where descriptor 3 writes;  3>&1: 3 writes where the output goes now
          steps.push({ kind: 'dup', fd: r.fd == null ? 1 : r.fd, to: +target });
          R.fds = true;
        } else throw failed(`${target}: ambiguous redirect`);
      } else if ((r.op === '>' || r.op === '>>') && target === '/dev/tty') {
        // > /dev/tty: to the terminal itself. Here that is where the messages go – shown in the terminal unless the
        // messages are sent elsewhere (as >> /dev/stderr; 2> /dev/tty changes nothing)
        const fd = r.fd || 1;
        if (fd === 1) {
          R.outToErr = R.plan.outToErr = true;
          steps.push({ kind: 'dup', fd: 1, to: 2 });
        } else if (fd > 2) {
          steps.push({ kind: 'dup', fd, to: 2 });
          R.fds = true;
        }
      } else if ((r.op === '>' || r.op === '>>') && (r.fd == null || r.fd <= 9) && /^\/dev\/(stdout|stderr|fd\/[1-9])$/.test(target)) {
        // echo "…" > /dev/stderr is >&2, 2> /dev/stdout is 2>&1 – with one difference: /dev/stderr is opened anew,
        // and when the errors are going to a file (2> FILE) that file is emptied by it, as > empties a file
        const fd = r.fd || 1, to = /stdout$/.test(target) ? 1 : /stderr$/.test(target) ? 2 : +target.slice(-1);
        if (fd > 2 || to > 2) {
          steps.push({ kind: r.op === '>' ? 'reopen' : 'dup', fd, to });
          R.fds = true;
          continue;
        }
        if (r.op === '>' && fd !== to) R[to === 2 ? 'truncErr' : 'truncOut'] = true;
        if (fd === 1 && to === 2) R.outToErr = R.plan.outToErr = true;
        else if (fd === 2 && to === 1) {
          R.list.push({ op: '2>&1' });
          R.plan.errToOut = true;
        }
        if (fd !== to || r.op === '>') steps.push({ kind: r.op === '>' ? 'reopen' : 'dup', fd, to });
        if (fd === to && r.op === '>') R.reopens = true;
      } else if (r.op === '>' || r.op === '>>') {
        if (r.fd === 2) {
          R.list.push({ op: r.op === '>' ? '2>' : '2>>', target, clobber: !!r.clobber });
          R.plan.err = { target, append: r.op === '>>' };
          steps.push({ kind: 'file', fd: 2, target, append: r.op === '>>', clobber: !!r.clobber });
        } else if (r.fd == null || r.fd === 1) {
          R.list.push({ op: r.op, target, clobber: !!r.clobber });
          R.plan.out = { target, append: r.op === '>>' };
          steps.push({ kind: 'file', fd: 1, target, append: r.op === '>>', clobber: !!r.clobber });
        } else if (high(r.fd)) {
          // N> FILE: the file is opened for writing as descriptor N
          steps.push({ kind: 'openOut', fd: r.fd, target, append: r.op === '>>', clobber: !!r.clobber });
          R.fds = true;
        } else throw shErr(`${r.fd}${r.op}: the standard input cannot be opened for writing`);
      } else if (r.op === '<>') throw shErr(`${r.fd == null ? '' : r.fd}<>: opening a file for reading and writing at once is not available in this terminal`);
      else throw shErr(`${r.op}: this redirection is not available in this terminal`);
    }
    // the plain cases are carried out by runPipeline itself (it keeps the order in which a program wrote its output
    // and its errors into one file); the others – where the order of the redirections decides, or a descriptor
    // from 3 on is used – as for a block
    R.ordered = (R.outToErr && steps.filter((x) => x.kind !== 'in').length > 1) || !!R.reopens || !!R.fds;
    return R;
  };
  /** an io whose output goes somewhere else: what belongs to the old destination does not go with it */
  const ioWith = (io, o) => Object.assign({}, io, { bytes: false, outClear: null, piped: true, outFile: null }, o);
  /** Carry out the redirections of a plan, from left to right, as bash does. Output and errors are two streams, each
      going somewhere: > FILE points a stream at a file, 2>&1 points the errors at what the output points at just then.
      → { d1, d2: where the output and the errors go, fds: the descriptors 3–9, stdin: a new input (or undefined),
          files: the files to write when the commands have ended }
      now: the files are written as the text arrives (for exec, whose redirections last) */
  /** Are the commands of a >( ) one tee –  tee [-a] [-i] FILE… [>&2] [> /dev/null]  – and nothing else?
      → { files, append, to: 'out' | 'err' | 'null' }, or null */
  Shell.prototype._teeOf = async function (ps, io) {
    let pr;
    try {
      const ast = parse(ps.text);
      const first = ast.items.length === 1 && !ast.items[0].rest.length ? ast.items[0].first : null;
      const c = first && !first.negate && first.cmds.length === 1 ? first.cmds[0] : null;
      if (!c || c.type !== 'simple' || c.assigns.length || !c.words.length) return null;
      pr = await this._prep(c, ps.st, io);
    } catch (e) {
      if (e && (e.shellError || e.cmdFail || e.syntax)) return null;
      throw e;
    }
    if (pr.argv[0] !== 'tee' || pr.R.plan.stdinText != null || pr.R.plan.stdinFile != null) return null;
    const t = { files: [], append: false, to: 'out' };
    let options = true;
    for (const a of pr.argv.slice(1)) {
      if (options && a === '--') options = false;
      else if (options && (a === '--append' || /^-[ai]+$/.test(a))) t.append = t.append || a === '--append' || a.includes('a');
      else if (options && a === '--ignore-interrupts') continue;
      else if (options && a.startsWith('-') && a !== '-') return null;
      else t.files.push(a);
    }
    for (const s of pr.R.plan.steps) {
      if ((s.kind === 'dup' || s.kind === 'reopen') && s.fd === 1 && s.to === 2) t.to = 'err';
      else if (s.kind === 'file' && s.target === '/dev/null' && (s.fd == null || s.fd === 1)) t.to = 'null';
      else if (s.kind === 'file' && s.target === '/dev/null' && s.fd === 2) continue;
      else return null;
    }
    return t;
  };
  Shell.prototype._openRedirs = async function (P, st, io, now) {
    const files = [];
    // A file that gets what is printed as it comes (exec > FILE, exec 3>> FILE, exec > >(tee FILE)). Into a text
    // file the text is added at once. A file that is kept as bytes (one that a program wrote and that is large or
    // no text, or that came back from the browser's storage) cannot be added to on the spot: what is printed waits
    // (see _settleOut) until a command may look at the file, or the script ends, and is then ADDED to it. (It must
    // never take the place of what is there: exec >> big.log, exec > >(tee -a big.log).)
    const passing = (abs, append) => {
      const dn = { write: null, bytes: true, clear: null, sink: new Sink(), target: abs, append: !!append, passing: true };
      dn.write = (x) => {
        const e = this.fs.get(abs);
        // (Bytes that are a text are a text: a log stays a text file that is added to line by line. Bytes that are
        // none – exec 3> y.bam; samtools view -b x.bam >&3 – wait with whatever follows them, and are added as bytes.)
        let more = x;
        if (typeof x !== 'string') {
          try {
            const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(x);
            if (text.indexOf('\0') < 0) more = text;
          } catch (err) {
            /* no text */
          }
        }
        // (the file was removed – rm run.log after exec > run.log: what is printed from then on is gone, as on Linux,
        // where it goes into a file that no name leads to any more)
        if (!e || e.kind === 'dir') return;
        if (typeof more === 'string' && dn.sink.empty && e.kind === 'text') return void this.fs.appendText(abs, more);
        dn.sink.add(more);
        const pend = this._pendingOut || (this._pendingOut = []);
        if (!pend.includes(dn)) pend.push(dn);
      };
      if (!append) dn.clear = () => {
        dn.sink.clear();
        this.fs.rewrite(abs, '');
      };
      return dn;
    };
    const fileDest = (t) => {
      if (t.target === '/dev/null') return { write: () => {}, bytes: true, clear: null };
      const ps = now && /^\/tmp\/\.psub-\d+$/.test(t.target) ? (this._psubs || []).find((e) => e.path === t.target && e.tee) : null;
      if (ps) {
        // (exec > >(tee FILE): what is written is added to the file and passed on to where the output went before)
        const forward = ps.tee.to === 'err' ? io.err : ps.tee.to === 'null' ? null : io.out;
        const paths = [];
        for (const f of ps.tee.files) {
          const abs = this.fs.resolve(f), fe = this.fs.get(abs);
          const why = !this.fs.isDir(MG.path.dirname(abs)) ? 'No such file or directory' : fe && fe.kind === 'dir' ? 'Is a directory' : fe && (fe.readonly || fe.protected) ? 'Permission denied' : null;
          if (why) {
            io.err(`tee: ${f}: ${why}\n`);
            continue;
          }
          if (!fe) this.fs.writeText(abs, '');
          else if (!ps.tee.append && !(fe.kind === 'text' && fe.text === '')) this.fs.rewrite(abs, '');
          paths.push(abs);
        }
        const dests = paths.map((abs) => passing(abs, true));
        const write = (x) => {
          // (a file that was removed in the meantime is not made again)
          for (const dn of dests) if (this.fs.exists(dn.target)) dn.write(x);
          if (forward) forward(x);
        };
        return { write, bytes: false, clear: null };
      }
      const abs = this.fs.resolve(t.target);
      // (> NAME/ : a slash behind the name asks for a folder, and a folder cannot be written to)
      if (/[^/]\/+$/.test(t.target) && (this.fs.isDir(MG.path.dirname(abs)) || (this.fs.pathError && this.fs.pathError(t.target) === 'Not a directory'))) throw userErr(`bash: ${t.target}: Is a directory`);
      if (!this.fs.isDir(MG.path.dirname(abs))) throw userErr(`bash: ${t.target}: No such file or directory`);
      const te = this.fs.get(abs);
      if (te && (te.readonly || te.protected)) throw userErr(`bash: ${t.target}: Permission denied`);
      if (te && te.kind === 'dir') throw userErr(`bash: ${t.target}: Is a directory`);
      if (te && st.flags.C && !t.append && !t.clobber && !(this._fresh && this._fresh.has(abs))) throw userErr(`bash: ${t.target}: cannot overwrite existing file`);
      // The file is opened before the commands run, as in bash: a new file is there from the start ({ ls; } > list.txt
      // lists list.txt) and a file that exists is empty by then ({ cat f; echo more; } > f leaves only "more").
      // Where the file is, is settled now: a cd inside the block does not move it.
      if (!te) this.fs.writeText(abs, '');
      else if (!t.append && !(te.kind === 'text' && te.text === '')) this.fs.rewrite(abs, '');
      if (now) {
        // (text, written as it comes: see passing)
        return passing(abs, t.append);
      }
      // (Two redirections to one file – { …; } >> log 2>> log – write to it in turn, in the order in which the
      // lines are printed: they share what is kept for the file.)
      const same = files.find((x) => x.target === abs);
      if (same) return same;
      const sink = new Sink();
      const d = { write: (x) => sink.add(x), bytes: true, clear: null, sink, target: abs, append: !!t.append };
      // (… > /dev/stdout inside the block opens the file anew: what was written so far goes – also what is in the
      // file already, see _settleOut)
      if (!t.append) d.clear = () => {
        sink.clear();
        if (d.flushed && this.fs.exists(abs) && !this.fs.isDir(abs)) this.fs.rewrite(abs, '');
      };
      files.push(d);
      return d;
    };
    const fds = Object.assign({}, st.fds || {});
    let d1 = { write: io.out, bytes: !!io.bytes, clear: io.outClear || null, same: true, target: io.outFile ? io.outFile.path : null, append: io.outFile ? io.outFile.append : false };
    let d2 = { write: io.err, bytes: false, clear: io.errClear || null, same: true };
    let stdin;
    const badFd = (n) => userErr(`bash: ${n}: Bad file descriptor`);
    const outOf = (n) => (n === 1 ? d1 : n === 2 ? d2 : fds[n] && fds[n].write ? fds[n] : null);
    const setOut = (n, d) => {
      if (n === 1) d1 = d;
      else if (n === 2) d2 = d;
      else fds[n] = d;
    };
    for (const s of P.steps) {
      if (s.kind === 'in') {
        // (the files are opened from left to right: after "< FILE" that is not there, nothing more is opened)
        const e = this.fs.get(s.target);
        if (!e || e.kind === 'dir') throw userErr(`bash: ${s.target}: ${e ? 'Is a directory' : (this.fs.pathError && this.fs.pathError(s.target)) || 'No such file or directory'}`);
      } else if (s.kind === 'file') setOut(s.fd, fileDest(s));
      else if (s.kind === 'both') d1 = d2 = fileDest(s);
      else if (s.kind === 'openOut') fds[s.fd] = fileDest(s);
      else if (s.kind === 'dup' || s.kind === 'reopen') {
        const d = outOf(s.to);
        if (!d) throw badFd(s.to);
        if (s.kind === 'reopen' && d.clear) d.clear();
        setOut(s.fd, d);
      } else if (s.kind === 'openIn') {
        if (s.text != null) fds[s.fd] = { in: { text: s.text, pos: 0 } };
        else {
          const e = this.fs.get(s.target);
          if (!e || e.kind === 'dir') throw userErr(`bash: ${s.target}: ${e ? 'Is a directory' : (this.fs.pathError && this.fs.pathError(s.target)) || 'No such file or directory'}`);
          fds[s.fd] = { in: { text: await this.fs.readText(s.target), pos: 0, path: this.fs.resolve(s.target) } };
        }
      } else if (s.kind === 'dupIn') {
        // (exec 3<&0 … exec <&3: where no input was given, descriptor 3 stands for the terminal's own – no input)
        const src = s.to === 0 ? { in: st.stdin || null, term: !st.stdin } : fds[s.to];
        if (!src || (!src.in && !src.term)) throw badFd(s.to);
        if (s.fd === 0) stdin = src.in;
        else fds[s.fd] = src;
      } else if (s.kind === 'close') {
        if (s.fd === 0) stdin = { text: '', pos: 0 };
        else if (s.fd <= 2) setOut(s.fd, { write: () => {}, bytes: s.fd === 1, clear: null });
        else delete fds[s.fd];
      }
    }
    return { d1, d2, fds, stdin, files };
  };
  /** run fn with the output of a block, a function or a command going where its redirections say */
  Shell.prototype._redirected = async function (R, st, io, fn) {
    if (!R.any) return fn(io);
    const P = R.plan;
    let opened;
    try {
      opened = await this._openRedirs(P, st, io, false);
    } catch (e) {
      if (e && e.userMessage) e.redirect = true; // (the files could not be opened: see _runCmd)
      throw e;
    }
    const { d1, d2, fds, stdin, files } = opened;
    let stdinText = P.stdinText, stdinPath = null;
    if (P.stdinFile != null) {
      await this._settleOut();
      const e = this.fs.get(P.stdinFile);
      if (!e || e.kind === 'dir') throw Object.assign(userErr(`bash: ${P.stdinFile}: ${e ? 'Is a directory' : (this.fs.pathError && this.fs.pathError(P.stdinFile)) || 'No such file or directory'}`), { redirect: true });
      stdinText = await this.fs.readText(P.stdinFile);
      stdinPath = this.fs.resolve(P.stdinFile);
    }
    const io2 = Object.assign({}, io, { out: d1.write, err: d2.write, bytes: d1.bytes, outClear: d1.clear, errClear: d2.clear, piped: d1.same ? !!io.piped : true, outFile: d1.target ? { path: d1.target, append: d1.append } : null });
    const before = st.stdin, beforeFds = st.fds;
    if (stdinText != null) st.stdin = { text: stdinText, pos: 0, path: stdinPath, dev: !!P.stdinDev && stdinPath == null && stdinText === '' };
    if (stdin !== undefined) st.stdin = stdin;
    if (R.fds) st.fds = fds;
    // What the commands of the block print is kept here until the block ends – and is put into the file whenever a
    // command starts that may read or write files (see _settleOut): in bash it is in the file at once.
    const pend = this._pendingOut || (this._pendingOut = []);
    for (const d of files) pend.push(d);
    try {
      return await fn(io2);
    } catch (e) {
      // An error of the shell itself – an unset variable under set -u, a read-only variable, ${x:?…} – is said
      // where it happens: with 2> FILE on the block or on the function, into that file. (See unsaid.)
      if (e && e.shellError && !e.syntax && !e.said && e.message) {
        io2.err(`${prefixOf(st)}${e.message}\n`);
        e.said = true;
      }
      throw e;
    } finally {
      st.stdin = before;
      if (R.fds) st.fds = beforeFds;
      for (const d of files) {
        const i = pend.indexOf(d);
        if (i >= 0) pend.splice(i, 1);
      }
      // (A file that the commands themselves removed or renamed is not made again. The file was made, or emptied,
      // when the block began; what the block printed since is ADDED to what is there – what was put there while the
      // block ran, and what its commands wrote into the file by name:  f() { echo x >> log; }; f > log  keeps the x.)
      for (const d of files) if (!d.sink.empty && this.fs.exists(d.target) && !this.fs.isDir(d.target)) await this.writeOut(d.target, d.sink, true);
    }
  };
  /** The output of the blocks, loops and functions that are running and write to a file ({ …; } > FILE,
      for …; done >> FILE, f > FILE) is put into those files. It is called before a command that may read or write
      files:  { echo start; wc -l < out.log; } > out.log  counts one line, a header is written once in
      for …; do [ -s table.tsv ] || echo header; …; done > table.tsv , and what a function adds to a log with >>
      comes after what the block around it printed before – as in bash, where the output is in the file at once. */
  Shell.prototype._settleOut = async function () {
    const pend = this._pendingOut;
    if (!pend || !pend.length) return;
    for (const d of pend.slice()) {
      if (!d.sink.empty) {
        if (this.fs.exists(d.target) && !this.fs.isDir(d.target)) await this.writeOut(d.target, d.sink, true);
        d.sink.clear();
        d.flushed = true;
      }
      // (the file of an exec redirection is on the list only while something waits for it)
      if (d.passing) {
        const i = pend.indexOf(d);
        if (i >= 0) pend.splice(i, 1);
      }
    }
  };
  // the shell's own commands that neither read nor write a file (without a redirection of their own)
  // (read and mapfile take their input from what is open already; a function is looked at command by command)
  const NO_FILES = new Set(['echo', 'printf', ':', 'true', 'false', 'local', 'declare', 'typeset', 'export', 'readonly', 'let', 'shift', 'set', 'unset', 'break', 'continue', 'return', 'exit', 'getopts', 'trap', 'shopt', 'umask', 'wait', 'eval', 'read', 'mapfile', 'readarray', 'basename', 'dirname', 'pwd', 'expr', 'sleep', 'printenv']);
  // (the tests of [ ], test and [[ ]] that look at files)
  const FILE_TEST = /^-(?:[a-hkprstuwxGLNOS]|nt|ot|ef)$/;
  Shell.prototype._mayTouchFiles = function (argv, R, st) {
    if (R && R.any) return true;
    if (!argv.length) return false;
    const name = argv[0];
    if (st && st.funcs && Object.prototype.hasOwnProperty.call(st.funcs, name)) return false;
    if (name === '[' || name === 'test') return argv.some((w) => typeof w === 'string' && FILE_TEST.test(w));
    return !NO_FILES.has(name);
  };
  /** The files after > of one part of a pipeline are opened – made, or emptied – before any part of the pipeline
      runs, as bash does: in  cat f | while read x; do …; done > f  the file f is empty before cat reads it. */
  Shell.prototype._preopen = function (R, st, onlyNew) {
    for (const s of R.plan.steps) {
      if (s.kind === 'in') {
        if (!this.fs.exists(s.target)) return;
        continue;
      }
      if ((s.kind !== 'file' && s.kind !== 'both') || /^\/dev\//.test(s.target)) continue;
      const abs = this.fs.resolve(s.target), e = this.fs.get(abs);
      if (!e) {
        if (this.fs.isDir(MG.path.dirname(abs))) {
          this.fs.writeText(abs, '');
          (this._fresh = this._fresh || new Set()).add(abs);
        }
        continue;
      }
      if (onlyNew || (this._fresh && this._fresh.has(abs))) continue;
      if (s.append || e.kind === 'dir' || e.readonly || e.protected || (st.flags.C && !s.clobber)) continue;
      if (!(e.kind === 'text' && e.text === '')) this.fs.rewrite(abs, '');
    }
  };

  /* ------------------------------------------------------------------
     running the tree
     ------------------------------------------------------------------ */
  /* Ctrl+C, and the time limit of "timeout N COMMAND": looked at before every command and every round of a loop.
     (A limit is an entry { at: the time it runs out, id } of this._deadlines; the timeout that set it catches the
     exception with its id.) */
  const halts = (c) => c.kind === 'cancel' || c.kind === 'timeout';
  Shell.prototype._tick = function () {
    if (this.term && this.term.cancelled) throw new Ctl('cancel', 130);
    const d = this._deadlines;
    if (d && d.length) {
      const now = Date.now();
      for (const e of d) if (now >= e.at) throw Object.assign(new Ctl('timeout', 124), { id: e.id });
    }
  };
  /** the limit that runs out first → { at, id }, or null */
  Shell.prototype._deadline = function () {
    const d = this._deadlines;
    return d && d.length ? d.reduce((a, b) => (b.at < a.at ? b : a)) : null;
  };
  Shell.prototype._expire = function (e) {
    throw Object.assign(new Ctl('timeout', 124), { id: e.id });
  };
  Shell.prototype._runList = async function (list, st, io) {
    let code = 0;
    for (const item of list.items) {
      this._tick();
      code = await this._runAndOr(item, st, io);
    }
    return code;
  };
  /** The commands of a script, of bash -c or of what was typed, one after the other. An assignment to a read-only
      variable ends the line it stands in – the rest of that line is not run – and the script goes on with the next
      line (status 1), as bash does. */
  Shell.prototype._runTop = async function (list, st, io, where) {
    let code = 0, skip = 0, shown = 0;
    const lineEnd = (p) => {
      const i = list.src.indexOf('\n', p);
      return i < 0 ? list.src.length : i + 1;
    };
    for (const item of list.items) {
      this._tick();
      // set -v: the lines are shown as bash reads them – whole lines, comments too, each one once; a line that was
      // read before set -v took effect (the rest of the line with set -v in it) is not shown
      if (list.src && item.pos >= shown) {
        const end = lineEnd(Math.max(item.pos, item.end - 1));
        if (st.flags.v) io.err(list.src.slice(shown, end).replace(/\n?$/, '\n'));
        shown = end;
      }
      if (skip && item.line === skip) continue;
      skip = 0;
      // (a here-document that the end of the script ended: bash says so when it reads the command, and goes on)
      while (list.warnings && list.warnings.length && list.warnings[0].pos < item.end) {
        const was = st.line;
        st.line = list.src.split('\n').length - (list.src.endsWith('\n') ? 1 : 0);
        io.err(`${where()}${list.warnings.shift().text}\n`);
        st.line = was;
      }
      // set -n: the commands are read, and not run
      if (st.flags.n && !st.top) continue;
      try {
        code = await this._runAndOr(item, st, io);
      } catch (e) {
        // (the same for a pattern without a match under shopt -s failglob)
        if (!e || !(e.readonlyVar || e.endsLine)) throw e;
        unsaid(e) && io.err(`${where()}${e.message}\n`);
        code = this.lastCode = 1;
        skip = item.line;
        // (set -e: the script ends; bash -c 'TEXT': the whole text is one piece, and what is left of it is given up)
        if ((st.flags.e && !e.arith) || st.oneText) throw new Ctl('exit', 1);
        if (st.flags.se && st.flags.sl && !e.arith) st.flags.sl.e++;
      }
    }
    return code;
  };
  /* set -e and the ERR trap, as bash has them. What can "fail" is a simple command (a call of a function too), a
     pipeline, (( )), [[ ]] and a ( subshell ) – never a loop, an if, a case or a { group } as a whole: what failed
     there is a command inside. And a failure does not count where the status is being tested: in the condition of
     if / while / until, after !, and in every part of an && || list but the last. That holds for all that such a
     command runs – the body of a function, a loop, a group, a subshell, eval, source:
         check() { grep -q x "$1"; echo "checked $1"; }
         check a.txt || echo "no x"       # grep may fail: the function goes on, as in bash
     st.cond counts the tests the command is standing in. */
  const FAILS = new Set(['simple', 'arith', 'cond', 'subshell']);
  Shell.prototype._runAndOr = async function (node, st, io) {
    // (in $( ) every command counts as standing in the line of the command it belongs to; in eval the lines of
    // the text go on from that line)
    st.line = st.lineFixed != null ? st.lineFixed : node.line + (st.lineBase || 0);
    const n = node.rest.length;
    const run = async (pipe, tested) => {
      if (!tested) return this._runPipe(pipe, st, io);
      st.cond++;
      try {
        return await this._runPipe(pipe, st, io);
      } finally {
        st.cond--;
      }
    };
    let code = await run(node.first, n > 0);
    let lastRun = node.first, at = 0;
    for (let k = 0; k < n; k++) {
      const r = node.rest[k];
      if ((r.op === '&&') === (code === 0)) {
        code = await run(r.pipe, k < n - 1);
        lastRun = r.pipe;
        at = k + 1;
      }
    }
    // (… and any command whose redirection could not be carried out:  for f in *; do …; done > /nosuch/file)
    if (code !== 0 && !st.cond && at === n && !lastRun.negate && (lastRun.cmds.length > 1 || FAILS.has(lastRun.cmds[0].type) || st.redirFail)) {
      // the ERR trap – inside a function, a subshell or $( ) only with set -E –, then, with set -e, the end
      // (without set -E a function that is called, and a subshell, do not have the ERR trap of the shell around
      // them – but one that is set in a function or in a subshell is at work there)
      if (st.traps.ERR && !st.inErr && (st.flags.E || ((st.fn || 0) <= (st.errFn || 0) && (st.subshell || 0) === (st.errSub || 0)))) {
        const first = lastRun.cmds[0];
        await this._trap('ERR', st, io, code, st.lineFixed != null ? st.lineFixed : (first.line || node.line) + (st.lineBase || 0));
      }
      if (st.flags.e) throw new Ctl('exit', code);
      // (the shadow of set -e, in an AI agent's run: here it would have ended the script)
      if (st.flags.se && st.flags.sl) st.flags.sl.e++;
    }
    return code;
  };
  /** carry out the commands of trap '…' ERR: $? is the status of the command that failed, $LINENO its line; an
      exit in the trap ends the script */
  Shell.prototype._trap = async function (name, st, io, code, line) {
    const text = st.traps[name];
    const keep = { last: this.lastCode, fixed: st.lineFixed, pipe: this.pipeStatus, trapCode: st.trapCode, sub: st.sub };
    st.inErr = true;
    st.inTrap = (st.inTrap || 0) + 1;
    st.trapCode = code;
    this.lastCode = code;
    st.lineFixed = line;
    try {
      await this._runList(parse(text, { extglob: extOn(st) }), st, io);
    } catch (c) {
      if (!(c && c.shellError) || c.syntax) throw c;
      unsaid(c) && io.err(`${prefixOf(st)}${c.message}\n`);
    } finally {
      st.inErr = false;
      st.inTrap--;
      st.trapCode = keep.trapCode;
      st.lineFixed = keep.fixed;
      st.sub = keep.sub;
      this.lastCode = keep.last;
      this.pipeStatus = keep.pipe;
    }
  };
  /** trap '…' EXIT: carried out when a script, bash -c, a ( subshell ) or a $( ) ends. In it $? is the status the
      shell is ending with; that stays the status – unless the trap itself says exit N (a plain exit keeps it), or,
      under set -e, a command of the trap fails. → the status */
  Shell.prototype._exitTrap = async function (st, io, code) {
    const text = st.traps.EXIT;
    if (!text) return code;
    delete st.traps.EXIT;
    const keep = { fixed: st.lineFixed, base: st.lineBase };
    st.inTrap = (st.inTrap || 0) + 1;
    st.trapCode = code;
    this.lastCode = code;
    st.cond = 0;
    st.loop = 0;
    st.lineFixed = null;
    st.lineBase = 0;
    try {
      await this._runList(parse(text, { extglob: extOn(st) }), st, io);
    } catch (c) {
      if (c && c.shellControl) {
        if (halts(c)) throw c;
        return c.kind === 'exit' ? c.code : code;
      }
      if (!(c && (c.shellError || c.syntax))) throw c;
      unsaid(c) && io.err(`${prefixOf(st)}${c.message}\n`);
    } finally {
      st.inTrap--;
      st.lineFixed = keep.fixed;
      st.lineBase = keep.base;
    }
    return code;
  };
  Shell.prototype._runPipe = async function (p, st, io) {
    const t0 = performance.now();
    let code;
    if (p.negate) st.cond++;
    st.redirFail = false;
    const psubs = this._psubs ? this._psubs.length : 0;
    try {
      this._codes = null;
      code = p.cmds.length === 1 ? await this._runCmd(p.cmds[0], st, io, null) : await this._runMulti(p.cmds, st, io);
    } finally {
      if (p.negate) st.cond--;
      // the files of <( ) and >( ) that this pipeline made
      if (this._psubs && this._psubs.length > psubs) {
        const keep = this._codes;
        await this._psubEnd(psubs, io);
        this._codes = keep;
      }
    }
    // ${PIPESTATUS[0]}: the exit status of each command of this pipeline (of one command: its own)
    this.pipeStatus = (p.cmds.length > 1 && this._codes && this._codes.length === p.cmds.length ? this._codes : [code]).map(String);
    this._codes = null;
    if (p.negate) code = code === 0 ? 1 : 0;
    if (p.timed) {
      // time: how long it took, in the form that TIMEFORMAT gives (%R the time that passed, %U and %S the time the
      // processor worked – here: the same, and none –, %P the share; a digit before the letter: so many decimals,
      // 3 at most; l: with minutes, 0m1.234s). time -p: the form POSIX asks for. An empty TIMEFORMAT: nothing.
      const ms = Math.max(0, Math.floor(performance.now() - t0));
      const tf = p.timed === 'p' ? 'real %2R\nuser %2U\nsys %2S' : typeof st.vars.TIMEFORMAT === 'string' ? st.vars.TIMEFORMAT : '\nreal\t%3lR\nuser\t%3lU\nsys\t%3lS';
      if (tf !== '') {
        const val = { R: ms, U: ms, S: 0 };
        io.err(tf.replace(/%(?:(%)|(P)|([0-9])?(l)?([RUS]))/g, (m, pc, share, prec, long, which) => {
          if (pc) return '%';
          if (share) return ms > 0 ? '100.00' : '0.00';
          const d = prec == null ? 3 : Math.min(3, +prec), x = val[which];
          const sec = Math.floor(x / 1000), frac = d > 0 ? '.' + String(x % 1000).padStart(3, '0').slice(0, d) : '';
          return long ? `${Math.floor(sec / 60)}m${sec % 60}${frac}s` : `${sec}${frac}`;
        }) + '\n');
      }
    }
    this.lastCode = code;
    return code;
  };
  /** the shell's own message as bash words it inside a script: "analysis.sh: line 12: …" for "bash: …" */
  const inScript = (st, msg) => (st && (st.script || st.errName) && typeof msg === 'string' && msg.startsWith('bash: ') && !/^bash: line \d+: /.test(msg) ? prefixOf(st) + msg.slice(6) : msg);
  Shell.prototype._popts = function (st, stdin) {
    return { scope: st.vars, st, pipefail: !!st.flags.pipefail, stdin: stdin != null ? stdin : undefined };
  };
  const DECLARATION = /^(export|local|declare|typeset|readonly)$/;
  /** expand a simple command: its words and redirections */
  Shell.prototype._prep = async function (cmd, st, io) {
    const argv = await this._words(cmd.words, st, io, cmd.words.length > 0 && DECLARATION.test(cmd.words[0]));
    return { argv, R: await this._redirs(cmd.redirs, st, io) };
  };
  /* set -x: each command is shown before it runs, as bash shows it – "+ " (the value of PS4; its first character
     once more for every $( ) or eval the command stands in), then the words after their expansion, in quotes where
     the shell would need them. Assignments are shown with their values, [[ ]] test by test, a loop at each round. */
  const xq = (a) => (a === '' ? "''" : /[ \t\n'"\\|&;()<>!{}*[?\]^$`]/.test(a) || /^[~#]|[=:]~/.test(a) ? "'" + a.replace(/'/g, "'\\''") + "'" : /[\x00-\x1f\x7f]/.test(a) ? shellQuote(a) : a);
  Shell.prototype._xtrace = async function (st, io, text) {
    if (!st.flags.x) return;
    let p = typeof st.vars.PS4 === 'string' ? st.vars.PS4 : '+ ';
    if (/[$`]/.test(p)) {
      // (PS4='+[$LINENO] ': worked out for every line – without showing how)
      const keep = { last: this.lastCode, sub: st.sub };
      st.flags.x = false;
      try {
        p = await this._heredoc(p, st, io);
      } catch (e) {
        if (!(e && e.shellError)) throw e;
      } finally {
        st.flags.x = true;
        this.lastCode = keep.last;
        st.sub = keep.sub;
      }
    }
    io.err((p ? Array.from(p)[0].repeat(st.xlevel || 0) + p : '') + text + '\n');
  };
  Shell.prototype._trace = function (st, io, argv) {
    return st.flags.x ? this._xtrace(st, io, argv.map((a) => (a.startsWith(ARRAY_WORD) ? a.slice(ARRAY_WORD.length) : xq(a))).join(' ')) : undefined;
  };
  /** a simple command as it was written, for $BASH_COMMAND (trap 'echo "failed: $BASH_COMMAND"' ERR) */
  const cmdText = (cmd) => cmd.assigns.concat(cmd.words, (cmd.redirs || []).map((r) => (r.op === '<<' ? `${r.fd == null ? '' : r.fd}<<EOF` : `${r.fd == null ? '' : r.fd}${r.op}${/&$/.test(r.op) ? '' : ' '}${r.target}`))).join(' ');
  Shell.prototype._runSimple = async function (cmd, st, io, stdin, prep) {
    st.sub = 0;
    if (!st.inTrap) st.cmdText = cmdText(cmd);
    let ready = prep;
    if (!ready) {
      try {
        ready = await this._prep(cmd, st, io);
      } catch (e) {
        // (An unset variable under set -u in the text of a here-document or a here-string: bash says so and gives
        // up this command – status 1 –, not the script. With set -e the script ends there all the same. For a loop
        // or a block with such a here-document bash does end the script: that is the case that is not caught here.)
        if (e && e.unset && e.inHere) {
          unsaid(e) && io.err(`${prefixOf(st)}${e.message}\n`);
          this._openEarlier(e.opened, st);
          return 1;
        }
        // (a redirection that cannot be carried out – > $empty: this command fails, the line goes on)
        if (!e || !e.cmdFail) throw e;
        this._openEarlier(e.opened, st);
        io.err(inScript(st, e.userMessage) + '\n');
        return 1;
      }
    }
    const { argv, R } = ready;
    if (this._pendingOut && this._pendingOut.length && this._mayTouchFiles(argv, R, st)) await this._settleOut();
    if (!argv.length) {
      // only assignments (and perhaps  > FILE,  which empties or makes the file)
      // (a read-only variable: the assignment fails, and with it the rest of the line – see _runTop)
      for (const a of cmd.assigns) await this._assign(a, st, io, st.flags.x ? (shown) => this._xtrace(st, io, shown) : null);
      if (R.any) {
        try {
          await this._redirected(R, st, io, async () => 0);
        } catch (e) {
          if (!e || !e.userMessage || e.shellError || e.syntax) throw e;
          io.err(inScript(st, e.userMessage) + '\n');
          return e.code || 1;
        }
      }
      st.vars._ = '';
      return st.sub;
    }
    // NAME=value command: the value holds for this command only
    const saved = [], added = [];
    for (const a of cmd.assigns) {
      const nm = /^[A-Za-z_]\w*/.exec(a)[0];
      saved.push([nm, st.vars[nm]]);
      // (NAME=text command, where NAME is an array: for the command NAME is that text alone – printenv NAME
      // prints it, "${NAME[@]}" is one word – and the array is back afterwards)
      if ((Array.isArray(st.vars[nm]) || isAssoc(st.vars[nm])) && /^[A-Za-z_]\w*=(?!\()/.test(a) && !(st.readonly && st.readonly.has(nm))) delete st.vars[nm];
      try {
        const shown = await this._assign(a, st, io);
        if (st.flags.x) await this._xtrace(st, io, shown);
      } catch (e) {
        // (a read-only variable: bash says so, leaves that one out – and runs the command)
        if (!e || !e.readonlyVar) throw e;
        saved.pop();
        unsaid(e) && io.err(`${prefixOf(st)}${e.message}\n`);
        continue;
      }
      // (… and exported for it: REF=x bash script.sh)
      if (st.exported && !st.exported.has(nm)) {
        st.exported.add(nm);
        added.push(nm);
      }
    }
    try {
      if (st.flags.x) await this._trace(st, io, argv);
      if (argv[0] === 'exec') return await this._exec(argv, R, st, io, cmd, stdin);
      if (st.funcs[argv[0]]) {
        try {
          // (cmd | f: what is piped in is the input of the function's body – unless the call has a < FILE of its own)
          return await this._redirected(R, st, io, (io2) => this._call(argv[0], argv.slice(1), st, io2, R.plan && (R.plan.stdinText != null || R.plan.stdinFile != null || R.plan.steps.some((x) => x.kind === 'dupIn' && x.fd === 0)) ? null : stdin));
        } catch (e) {
          if (!e || !e.userMessage || e.shellError || e.syntax) throw e;
          io.err(inScript(st, e.userMessage) + '\n');
          return e.code || 1;
        }
      }
      // COMMAND 2>> FILE >&2, COMMAND >&2 2> FILE, COMMAND 2>&1 > /dev/stderr: the order of the redirections decides
      if (R.ordered) {
        try {
          // (<&3: the command reads what descriptor 3 reads – not what is piped into it)
          return await this._redirected(R, st, io, (io3) => this.runPipeline([{ argv, redirs: R.list.filter((r) => r.op === '<'), stdinText: R.stdinText, stdinDev: R.stdinDev && R.stdinText === '' }], io3, cmd.src || argv.join(' '), this._popts(st, R.plan.steps.some((x) => x.kind === 'dupIn' && x.fd === 0) ? null : stdin)));
        } catch (e) {
          if (!e || !e.userMessage || e.shellError || e.syntax) throw e;
          io.err(inScript(st, e.userMessage) + '\n');
          return e.code || 1;
        }
      }
      // (> /dev/stderr opens the place where the errors go anew: if that is a file – 2> FILE –, it is emptied)
      if (R.truncErr && io.errClear) io.errClear();
      if (R.truncOut && io.outClear) io.outClear();
      const io2 = R.outToErr ? ioWith(io, { out: io.err, outClear: io.errClear || null }) : io;
      return await this.runPipeline([{ argv, redirs: R.list, stdinText: R.stdinText, stdinDev: R.stdinDev && R.stdinText === '' }], io2, cmd.src || argv.join(' '), this._popts(st, stdin));
    } finally {
      saved.forEach(([k, v]) => {
        if (v === undefined) delete st.vars[k];
        else st.vars[k] = v;
      });
      if (st.exported) added.forEach((k) => st.exported.delete(k));
      // $_: the last word of the command that has just run (mkdir -p out/qc && cd "$_")
      const lastWord = argv[argv.length - 1];
      st.vars._ = lastWord.startsWith(ARRAY_WORD) ? lastWord.slice(ARRAY_WORD.length) : lastWord;
    }
  };
  /** exec > FILE, exec 2>&1 …: from here on the script's output goes there.  exec COMMAND: run it, and end. */
  Shell.prototype._exec = async function (argv, R, st, io, cmd, stdin) {
    if (argv.length > 1) {
      // (exec runs programs – not functions; where there is none of that name the shell ends with status 127,
      // a shell that someone types at goes on)
      const name = argv[1];
      if (!MG.shellBuiltins[name] && !MG.shellTools[name] && !name.includes('/') && !this.onPath(name, st.vars)) {
        // (the message goes where the redirections of the line send the errors: exec nosuch 2> /dev/null says nothing;
        // a redirection that cannot be carried out is reported instead, and the shell goes on with status 1)
        const isDir = name !== '' && this.fs.isDir(name);
        try {
          await this._redirected(R, st, io, async (io2) => {
            io2.err(`${prefixOf(st)}exec: ${name}: ${isDir ? 'cannot execute: Is a directory' : 'not found'}\n`);
            return 0;
          });
        } catch (e) {
          if (!e || !e.userMessage || e.shellError || e.syntax) throw e;
          io.err(inScript(st, e.userMessage) + '\n');
          return 1;
        }
        const stays = st.top || (st.shopt && st.shopt.execfail === true);
        if (isDir) {
          if (stays) return 126;
          throw Object.assign(new Ctl('exit', 126), { exec: true });
        }
        const why = MG.shellUtil.absentNote ? MG.shellUtil.absentNote(name) : '';
        if (io.note && /^\{[A-Za-z_]\w*\}$/.test(name)) io.note(`${name}> FILE and ${name}< FILE – a file descriptor whose number bash chooses and puts into the variable – are not available in this terminal. Choose the number yourself, from 3 to 9:  exec 3> FILE   …   echo text >&3   …   exec 3>&-`);
        else if (io.note && why) io.note(why);
        if (MG.shellUtil.notHere) MG.shellUtil.notHere(name);
        if (stays) return 127;
        throw Object.assign(new Ctl('exit', 127), { exec: true });
      }
      const code = await this.runPipeline([{ argv: argv.slice(1), redirs: R.list, stdinText: R.stdinText, stdinDev: R.stdinDev && R.stdinText === '' }], io, cmd.src || argv.join(' '), this._popts(st, stdin));
      throw Object.assign(new Ctl('exit', code), { exec: true });
    }
    if (!R.any) return 0;
    const P = R.plan;
    // (the descriptors 3 to 9 can be opened anywhere; the input, the output and the errors of the terminal itself stay)
    const std = P.stdinText != null || P.stdinFile != null || P.steps.some((x) => x.kind === 'file' || x.kind === 'both' || ((x.kind === 'dup' || x.kind === 'reopen' || x.kind === 'close') && x.fd <= 2) || (x.kind === 'dupIn' && x.fd === 0));
    if (st.top && std) {
      io.err('bash: exec: the input and the output of the terminal itself cannot be redirected here. Redirect the command (COMMAND > FILE), or use exec in a script.\n');
      return 1;
    }
    // exec > >(tee FILE) 2>&1: from here on the output of the script goes to the screen and into the file. (Of
    // exec > >( commands ) that one form is carried out – see _teeOf; other commands would have to run beside the
    // script, which this terminal cannot do.)
    for (const x of P.steps) {
      if (!x.target || !/^\/tmp\/\.psub-\d+$/.test(x.target)) continue;
      const ps = (this._psubs || []).find((e) => e.path === x.target && e.kind === '>');
      const tee = ps ? await this._teeOf(ps, io) : null;
      if (!tee) {
        io.err(inScript(st, 'bash: exec: of  exec > >( commands )  this terminal carries out one form – the output on the screen and in a file:  exec > >(tee FILE) 2>&1  (or tee -a FILE). Otherwise:  exec > FILE 2>&1  and look at the file, or run the script as  bash script.sh 2>&1 | tee FILE') + '\n');
        return 1;
      }
      ps.tee = tee;
      ps.held = true;
    }
    try {
      const o1 = io.out, o2 = io.err;
      const { d1, d2, fds, stdin: from } = await this._openRedirs(P, st, io, true);
      // from here on the output of the script goes there (a file takes bytes as well as text: see passing in
      // _openRedirs; tee and the screen take text)
      if (d1.write !== o1) Object.assign(io, { out: d1.write, bytes: !!(d1.passing && d1.bytes), outClear: d1.clear || null, piped: true, outFile: d1.target ? { path: d1.target, append: !!d1.append } : null });
      if (d2.write !== o2) Object.assign(io, { err: d2.write, errClear: d2.clear || null });
      if (R.fds) st.fds = fds;
      // exec < FILE: the commands of the script that read (read, cat, a program) read the file from here on
      if (P.stdinFile != null) st.stdin = { text: await this.fs.readText(P.stdinFile), pos: 0, path: this.fs.resolve(P.stdinFile) };
      else if (P.stdinText != null) st.stdin = { text: P.stdinText, pos: 0, dev: !!P.stdinDev && P.stdinText === '' };
      if (from !== undefined) st.stdin = from;
    } catch (e) {
      if (!e || !e.userMessage) throw e;
      io.err(inScript(st, e.userMessage) + '\n');
      return 1;
    }
    return 0;
  };
  /** a pipeline of two or more commands */
  Shell.prototype._runMulti = async function (cmds, st, io) {
    const preps = [];
    // shopt -s lastpipe: the last command of a pipeline runs in this shell (… | read x keeps x). As in bash, not
    // where commands are typed at the prompt: there every part of a pipeline is a job of its own.
    const lastpipe = !!(st.shopt && st.shopt.lastpipe) && !(st.top && !(this.term && this.term.agentCmd));
    let plain = !lastpipe;
    // Each part of a pipeline is a shell of its own – also while its words are worked out: after
    //   echo $((n++)) | cat        n is what it was, and        echo "[$((++step))] …" | tee -a log
    // counts nothing up, here as in bash. (subs: the state of each part.)
    const subs = [];
    for (let k = 0; k < cmds.length; k++) {
      const c = cmds[k];
      subs.push(k === cmds.length - 1 && lastpipe ? st : this._child(st));
      if (c.type !== 'simple' || !c.words.length || c.assigns.length) {
        plain = false;
        preps.push(null);
        continue;
      }
      let pr = null;
      try {
        pr = await this._prep(c, subs[k], io);
      } catch (e) {
        // (an error in the words of one part – an unset variable with set -u – is that part's error: see below)
        if (!e || !(e.shellError || e.cmdFail) || e.syntax) throw e;
      }
      if (pr && pr.argv[0] === 'exec' && pr.argv.length > 1 && !st.funcs.exec) pr.argv = pr.argv.slice(1);
      // (exit and return as a part of a pipeline end that part, not the pipeline: they are carried out part by part)
      if (!pr || !pr.argv.length || st.funcs[pr.argv[0]] || pr.R.outToErr || pr.R.ordered || pr.argv[0] === 'exit' || pr.argv[0] === 'return') plain = false;
      preps.push(pr);
    }
    if (plain) {
      // programs only: each one's output is handed to the next as a file, byte for byte
      if (st.flags.x) for (const pr of preps) await this._trace(st, io, pr.argv);
      // as in bash, each part is a subshell: a cd or a read in a pipeline does not last
      const cwd = this.fs.cwd, oldpwd = this.oldpwd;
      try {
        // (the output of a block around this pipeline is in its file before a program starts that may read it)
        if (this._pendingOut && this._pendingOut.length && preps.some((pr) => this._mayTouchFiles(pr.argv, pr.R, st))) await this._settleOut();
        const popts = this._popts(this._child(st), null);
        const code = await this.runPipeline(preps.map((pr) => ({ argv: pr.argv, redirs: pr.R.list, stdinText: pr.R.stdinText, stdinDev: pr.R.stdinDev && pr.R.stdinText === '' })), io, preps.map((pr) => pr.argv.join(' ')).join(' | '), popts);
        this._codes = popts.codes || null; // (runPipeline leaves them there)
        return code;
      } catch (c) {
        if (c && c.shellControl && (c.kind === 'exit' || c.kind === 'return')) return c.code;
        throw c;
      } finally {
        {
        this.fs.cwd = cwd;
        this.oldpwd = oldpwd;
      }
      }
    }
    // with a block or a function in it: each part runs in its own subshell; what one part prints – text, or the bytes
    // of a program – is the input of the next
    let stdin = null, opening = false;
    const codes = [], held = [];
    const hadFresh = !!this._fresh;
    try {
      // The files after > of every part (see _preopen). On Linux the parts of a pipeline start together, and each
      // opens its files as it starts. A part that starts a program is slower than that: by the time the program
      // looks, the other parts have made their files, and the next part has emptied its file ("ls | sort >
      // list.txt" lists list.txt, and "{ cat f; } | sort > f" finds f empty). A part that the shell carries out
      // itself is faster: a loop that looks at the folder straight away (for f in *; do …; done | sort > list.txt)
      // does not see list.txt yet, and "while read x; do …; done < f | sort > f" has read f before it is emptied.
      // So: the files of a part are opened when the part starts – and before that, as soon as an earlier part
      // starts a program, the new files of all later parts are made and the files of the next part are emptied.
      // (These are races on a real computer; this is how they usually end.)
      for (let k = 0; k < cmds.length; k++) {
        if (!preps[k] && cmds[k].type !== 'simple' && cmds[k].type !== 'func' && cmds[k].redirs && cmds[k].redirs.length) {
          try {
            preps[k] = { R: await this._redirs(cmds[k].redirs, st, io) };
          } catch (e) {
            if (!e || !(e.shellError || e.cmdFail) || e.syntax) throw e;
          }
        }
      }
      const waiting = preps.map((p) => (p && p.R ? p.R : null));
      const openPart = (k) => {
        if (waiting[k]) this._preopen(waiting[k], st);
        waiting[k] = null;
      };
      let running = 0;
      (this._opening = this._opening || []).push(() => {
        waiting.forEach((p) => p && this._preopen(p, st, true));
        openPart(running + 1);
      });
      opening = true;
      for (let k = 0; k < cmds.length; k++) {
        running = k;
        openPart(k);
        const last = k === cmds.length - 1;
        const sink = new Sink();
        const sub = subs[k];
        // (each part is a shell of its own: an exec > FILE in the last part does not last beyond it)
        const sio = last ? (sub !== st ? Object.assign({}, io) : io) : ioWith(io, { out: (t) => sink.add(t), bytes: true });
        const cwd = this.fs.cwd, oldpwd = this.oldpwd;
        let code;
        this._tookPart = null;
        try {
          try {
            code = await this._runCmd(cmds[k], sub, sio, stdin, preps[k]);
          } catch (c) {
            // (exit and return end the part – a subshell –, not the script or the function:
            //  cat list | while read x; do …; return 0; done   goes on after the loop)
            if (c && c.shellControl && (c.kind === 'exit' || c.kind === 'return') && sub !== st) code = c.code;
            else if (c && c.shellError && sub !== st && !c.syntax) {
              // an error of the language in one part ends that part (each is a shell of its own)
              unsaid(c) && sio.err(`${prefixOf(st)}${c.message}\n`);
              code = c.code || 1;
            } else throw c;
          }
          if (sub !== st) code = await this._exitTrap(sub, sio, code);
        } finally {
          if (sub !== st) {
            this.fs.cwd = cwd;
            this.oldpwd = oldpwd;
          }
        }
        // (the reader left early – a part that stopped reading while the part before it still had more than a pipe
        // holds to write: that part is ended by SIGPIPE, status 141. See runPipeline.)
        const t = this._tookPart;
        this._tookPart = null;
        if (k > 0 && t && t.size - t.used > 65536) {
          codes[k - 1] = 141;
          if (st.flags.pipefail && io.note && !(this._pipeNoted && Date.now() - this._pipeNoted < 3000)) {
            io.note('The command before a | was ended by the signal SIGPIPE (status 141): the command after it stopped reading before everything was written. With set -o pipefail the pipeline fails for that – here as on Linux. Let it pass with  … || true , or read to the end.');
            this._pipeNoted = Date.now();
          }
        } else if (k > 0 && t && t.size > 4096 && t.size - t.used > 0 && st.flags.pipefail && io.note && this._pipeMaybeDue('| a block')) {
          // (less than a pipe holds was left unread: on Linux the writer is then ended or not, as the timing falls)
          io.note('On Linux this pipeline can fail under set -o pipefail: the command after a | stopped reading before it had taken everything, and a command that is still writing at that moment is ended with status 141 (SIGPIPE) – whether it is depends on timing. Here the status is 0. To be safe on every computer, read to the end, or let it pass with  … || true');
        }
        codes.push(code);
        if (last) break;
        if (sink.binary && MG.wasm) {
          stdin = await MG.wasm.tempBytes(sink.bytes(), true);
          MG.wasm.hold(stdin.apath);
          held.push(stdin.apath);
        } else stdin = sink.text();
      }
    } finally {
      held.forEach((f) => MG.wasm.release(f));
      if (!hadFresh) this._fresh = null;
      if (opening) this._opening.pop();
    }
    this._codes = codes;
    if (st.flags.pipefail) for (let k = codes.length - 1; k >= 0; k--) if (codes[k] !== 0) return codes[k];
    return codes[codes.length - 1];
  };
  Shell.prototype._runCmd = async function (cmd, st, io, stdin, prep) {
    if (cmd.line) st.line = st.lineFixed != null ? st.lineFixed : cmd.line + (st.lineBase || 0);
    this.fs.umask = st.umask != null ? st.umask : null; // (the bits a new file does not get: see umask)
    if (cmd.type === 'simple') return this._runSimple(cmd, st, io, stdin, prep);
    if (cmd.type === 'func') {
      st.funcs[cmd.name] = cmd.body;
      return 0;
    }
    let R = prep && prep.R ? prep.R : null;
    if (!R) {
      try {
        R = await this._redirs(cmd.redirs, st, io);
      } catch (e) {
        if (!e || !e.cmdFail) throw e;
        io.err(inScript(st, e.userMessage) + '\n');
        st.redirFail = true;
        return 1;
      }
    }
    if (!st.inTrap && (cmd.type === 'arith' || cmd.type === 'cond')) st.cmdText = cmd.type === 'arith' ? `((${cmd.expr}))` : `[[ ${cmd.words.join(' ')} ]]`;
    if (this._pendingOut && this._pendingOut.length && (R.any || (cmd.type === 'cond' && cmd.words.some((w) => typeof w === 'string' && FILE_TEST.test(w))))) await this._settleOut();
    const before = st.stdin;
    if (stdin != null) st.stdin = await this._stream(stdin);
    const mine = stdin != null ? st.stdin : null;
    try {
      return await this._redirected(R, st, io, (io2) => this._runBlock(cmd, st, io2));
    } catch (e) {
      // a file that cannot be opened, a test that cannot be made: this command fails, the script goes on
      // (with set -e it ends there: a redirection that failed counts, whatever kind of command it belongs to)
      if (!e || !e.userMessage || e.shellError || e.syntax) throw e;
      io.err(inScript(st, e.userMessage) + '\n');
      if (e.redirect) st.redirFail = true;
      return e.code || 1;
    } finally {
      st.stdin = before;
      // (how far a block, a loop or a function read what was piped into it – see _runMulti; 0: not known)
      if (mine) this._tookPart = mine.pos > 0 && typeof mine.text === 'string' ? { used: mine.pos, size: mine.text.length } : null;
    }
  };
  Shell.prototype._test = async function (list, st, io) {
    st.cond++;
    try {
      return await this._runList(list, st, io);
    } finally {
      st.cond--;
    }
  };
  /** the body of a loop, once: 'break' | 'continue' | null; passes on break 2 and the like */
  Shell.prototype._loopBody = async function (body, st, io, status) {
    try {
      status.code = await this._runList(body, st, io);
      return null;
    } catch (c) {
      if (c && c.shellControl && (c.kind === 'break' || c.kind === 'continue')) {
        // (break 5 with fewer loops around: it ends them all, and the script goes on after the outermost one)
        if (c.n > 1 && st.loop > 1) {
          c.n--;
          throw c;
        }
        // (the status of the loop is that of the last command carried out in it – which was the break or the
        // continue itself: 0.  for f in …; do [[ -s $f ]] && break; done  ends with 0 when a file was found)
        status.code = c.code || 0;
        return c.kind;
      }
      throw c;
    }
  };
  Shell.prototype._runBlock = async function (cmd, st, io) {
    switch (cmd.type) {
      case 'group':
        return this._runList(cmd.body, st, io);
      case 'subshell': {
        const sub = this._child(st);
        const cwd = this.fs.cwd, oldpwd = this.oldpwd;
        // (where its output goes is the subshell's own affair: after  ( exec > FILE; … )  the script writes where it
        // wrote before)
        const sio = Object.assign({}, io);
        let code;
        try {
          try {
            code = await this._runList(cmd.body, sub, sio);
          } catch (c) {
            // exit – and return, in a function – end the subshell, and nothing else: after  ( return 5 )  the
            // function goes on, with status 5
            if (c && c.shellControl && (c.kind === 'exit' || c.kind === 'return')) code = c.code;
            // (an error of the language in there ends the subshell – it is a shell of its own –, not the script)
            else if (c && c.shellError && !c.syntax) {
              unsaid(c) && sio.err(`${prefixOf(st)}${c.message}\n`);
              code = c.code || 1;
            } else throw c;
          }
          // ( trap '…' EXIT; … ): the trap of the subshell runs when the subshell ends
          return await this._exitTrap(sub, sio, code);
        } finally {
          {
        this.fs.cwd = cwd;
        this.oldpwd = oldpwd;
      }
        }
      }
      case 'if': {
        for (const cl of cmd.clauses) if ((await this._test(cl.cond, st, io)) === 0) return this._runList(cl.body, st, io);
        return cmd.orelse ? this._runList(cmd.orelse, st, io) : 0;
      }
      case 'for': {
        const values = cmd.words ? await this._words(cmd.words, st, io) : st.args.slice();
        const status = { code: 0 };
        st.loop++;
        try {
          for (const v of values) {
            this._tick();
            if (st.flags.x) await this._xtrace(st, io, `for ${cmd.name} in ${cmd.words ? cmd.words.join(' ') : '"$@"'}`);
            try {
              this._set(cmd.name, v, st);
            } catch (e) {
              // (a read-only variable cannot be the variable of a loop: the loop does not run, status 1)
              if (!e || !e.readonlyVar) throw e;
              unsaid(e) && io.err(`${prefixOf(st)}${e.message}\n`);
              status.code = 1;
              break;
            }
            if ((await this._loopBody(cmd.body, st, io, status)) === 'break') break;
          }
        } finally {
          st.loop--;
        }
        return status.code;
      }
      case 'cfor':
      case 'while': {
        const status = { code: 0 };
        st.loop++;
        try {
          const xa = (e) => (st.flags.x && cmd.type === 'cfor' ? this._xtrace(st, io, `(( ${e.trim()} ))`) : undefined);
          if (cmd.type === 'cfor') {
            await xa(cmd.init);
            await this._arith(cmd.init, st, io);
          }
          for (let n = 0; ; n++) {
            this._tick();
            if (n >= MAX_LOOP) throw shErr(`a loop ran ${MAX_LOOP} times and was stopped`);
            if (cmd.type === 'cfor') {
              await xa(cmd.test);
              if (cmd.test.trim() && !(await this._arith(cmd.test, st, io))) break;
            } else if (((await this._test(cmd.cond, st, io)) === 0) === cmd.until) break;
            if ((await this._loopBody(cmd.body, st, io, status)) === 'break') break;
            if (cmd.type === 'cfor') {
              await xa(cmd.step);
              await this._arith(cmd.step, st, io);
            }
            if (n % 200 === 199) await new Promise((r) => setTimeout(r, 0));
          }
        } catch (e) {
          // for (( i = 0; i < n / 0; i++ )): a mistake in one of the three expressions ends the loop, status 1
          if (cmd.type !== 'cfor' || !e || !e.arith) throw e;
          io.err(`${prefixOf(st)}((: ${e.message}\n`);
          status.code = 1;
        } finally {
          st.loop--;
        }
        return status.code;
      }
      case 'case': {
        if (st.flags.x) await this._xtrace(st, io, `case ${cmd.word} in`);
        const word = await this._expand(cmd.word, st, io, 'one');
        let code = 0, through = false;
        for (const cl of cmd.clauses) {
          let hit = through;
          if (!hit) for (const pat of cl.patterns) if (globRe(await this._pattern(pat, st, io), st.shopt && st.shopt.nocasematch ? 'i' : '', !extOn(st)).test(word)) hit = true;
          if (!hit) continue;
          code = await this._runList(cl.body, st, io);
          if (cl.end === ';&') through = true;
          else if (cl.end === ';;&') through = false;
          else break;
        }
        return code;
      }
      case 'arith':
        if (st.flags.x) await this._xtrace(st, io, `(( ${cmd.expr} ))`);
        try {
          return (await this._arith(cmd.expr, st, io)) !== 0 ? 0 : 1;
        } catch (e) {
          // (( R++ )) of a read-only variable, (( 1 / 0 )): an error, status 1 – the line goes on
          if (!e || !(e.readonlyVar || e.arith)) throw e;
          io.err(`${prefixOf(st)}${e.arith ? '((: ' : ''}${e.message}\n`);
          return 1;
        }
      case 'cond':
        return this._cond(cmd.words, st, io);
      default:
        throw shErr(`${cmd.type}: not available in this terminal`);
    }
  };
  /** a pattern word: quoted parts are literal */
  Shell.prototype._pattern = function (raw, st, io) {
    return this._expandPat(raw, st, io);
  };
  Shell.prototype._call = async function (name, args, st, io, stdin) {
    const saveArgs = st.args, saveLocals = st.locals, saveLoop = st.loop, saveNames = st.fnames, saveLines = st.flines;
    const saveRo = st.readonly ? new Set(st.readonly) : null, saveAttrs = st.attrs ? new Map(st.attrs) : null, saveExp = st.exported ? new Set(st.exported) : null;
    st.args = args;
    st.locals = new Map();
    st.loop = 0;
    st.fn++;
    st.fnames = [name].concat(st.fnames || []);
    st.flines = [String(st.line || 0)].concat(st.flines || []); // (BASH_LINENO: the line each function was called at)
    if (st.fn > 100) throw shErr(`${name}: maximum function nesting level exceeded (100)`);
    try {
      return await this._runCmd(st.funcs[name], st, io, stdin == null ? null : stdin);
    } catch (c) {
      if (c && c.shellControl && c.kind === 'return') return c.code;
      throw c;
    } finally {
      for (const [k, v] of st.locals) {
        if (k === '-') {
          // (local -: the options as they were when the function began)
          Object.keys(st.flags).forEach((f) => delete st.flags[f]);
          Object.assign(st.flags, v);
          continue;
        }
        if (v === undefined) delete st.vars[k];
        else st.vars[k] = v;
        // (what a local variable was – read-only, an integer, exported – ends with the function)
        if (st.readonly && !(saveRo && saveRo.has(k))) st.readonly.delete(k);
        if (st.exported) {
          if (saveExp && saveExp.has(k)) st.exported.add(k);
          else st.exported.delete(k);
        }
        if (st.attrs) {
          if (saveAttrs && saveAttrs.has(k)) st.attrs.set(k, saveAttrs.get(k));
          else st.attrs.delete(k);
        }
      }
      st.fn--;
      st.args = saveArgs;
      st.locals = saveLocals;
      st.loop = saveLoop;
      st.fnames = saveNames;
      st.flines = saveLines;
    }
  };

  /* ------------------------------------------------------------------
     tests: [ ], test and [[ ]]
     ------------------------------------------------------------------ */
  /** /dev/null and the other device files that a script may ask about */
  const DEVICE = /^\/dev\/(null|zero|stdin|stdout|stderr|tty|urandom|random)$/;
  /* /dev/stdin, /dev/stdout, /dev/stderr, /dev/fd/N and /proc/self/fd/N are what the descriptor is at that moment:
     the terminal (a character device: -c), a pipe (-p) or a file (-f, and -s if there is something in it) –
         if [ -p /dev/stdin ]; then cat; else echo "usage: …"; fi       "was something piped in?"
     std(fd) says which: 'tty', 'pipe', 'file', 'empty' (a file without contents) – or null: not known, not open. */
  // (/proc/self/fd/N: only these tests know it – there is no /proc to read from)
  const STDFD = /^(?:\/dev\/(stdin|stdout|stderr)|\/dev\/fd\/([0-2])|\/proc\/self\/fd\/([0-2]))$/;
  function unaryTest(fs, op, s, std) {
    const fdm = std && /^-[a-zA-Z]$/.test(op) && !'zn'.includes(op[1]) ? STDFD.exec(s) : null;
    if (fdm) {
      const kind = std(fdm[1] ? ['stdin', 'stdout', 'stderr'].indexOf(fdm[1]) : +(fdm[2] || fdm[3]));
      if (kind) {
        if ('earwLh'.includes(op[1])) return true;
        if (op[1] === 'c') return kind === 'tty';
        if (op[1] === 'p') return kind === 'pipe';
        if (op[1] === 'f') return kind === 'file' || kind === 'empty';
        if (op[1] === 's') return kind === 'file';
        return false;
      }
    }
    if (DEVICE.test(s) && /^-[a-zA-Z]$/.test(op) && !'zn'.includes(op[1])) return 'earwc'.includes(op[1]);
    // /usr/bin/samtools – what command -v, which and type -P print for a program of this terminal. There is no such
    // folder among the page's files, but the program is there and can be run: [ -x "$(command -v samtools)" ] holds.
    if (/^-[a-zA-Z]$/.test(op) && !'zn'.includes(op[1]) && /^\/(usr\/)?bin(\/|$)|^\/usr\/?$/.test(s) && !fs.get(s)) {
      const prog = /^\/(?:usr\/)?bin\/([^/]+)$/.exec(s);
      if (!prog) return 'eadrx'.includes(op[1]); // (the folders /usr, /usr/bin and /bin themselves)
      if (MG.shellTools[prog[1]] || /^(bash|sh|env)$/.test(prog[1]) || (MG.shellBuiltins[prog[1]] && !SHELL_WORDS.includes(prog[1]))) return 'eafrxs'.includes(op[1]);
    }
    // (/dev and /dev/fd are folders)
    if (/^\/dev(\/fd)?\/?$/.test(s) && /^-[a-zA-Z]$/.test(op) && !'zn'.includes(op[1])) return 'eadrxs'.includes(op[1]);
    let e = /^-[a-zA-Z]$/.test(op) && !'zn'.includes(op[1]) ? fs.get(s) : null;
    // (a name with a slash at its end can only be a folder: [ -f file.txt/ ] is false)
    if (e && e.kind !== 'dir' && /\/\.?$/.test(s)) e = null;
    switch (op) {
      case '-z': return s === '';
      case '-n': return s !== '';
      case '-e':
      case '-a': return !!e;
      case '-f': return !!e && e.kind !== 'dir';
      case '-d': return !!e && e.kind === 'dir';
      case '-s': return !!e && (e.kind === 'dir' || fs.size(e) > 0);
      case '-r': return !!e;
      case '-w': return !!e && !e.readonly && !e.protected;
      case '-x': return !!e && (e.kind === 'dir' || e.mode === 'x');
      case '-O':
      case '-G': return !!e;
      case '-u': return !!e && !!(MG.permBits(e) & 0o4000);
      case '-g': return !!e && !!(MG.permBits(e) & 0o2000);
      case '-k': return !!e && !!(MG.permBits(e) & 0o1000);
      case '-L':
      case '-h':
      case '-p':
      case '-S':
      case '-b':
      case '-N':
      case '-c': return false;
      default: throw userErr(`bash: test: ${op}: unary operator expected`, 2);
    }
  }
  const BINARY = /^(=|==|!=|<|>|-eq|-ne|-lt|-le|-gt|-ge|-nt|-ot|-ef|=~)$/;
  function binaryTest(fs, a, op, b, who) {
    const int = (x) => {
      if (typeof x === 'bigint') return x;
      // (blanks of any kind in front, as the C library skips them; behind the number only blanks and tabs:
      // [ "5<CR>" -ge 5 ] is "integer expression expected", status 2)
      if (!/^[ \t\n\v\f\r]*[-+]?\d+[ \t]*$/.test(x)) throw userErr(`bash: ${who}: ${x}: integer expression expected`, 2);
      return BigInt(x.trim());
    };
    const mt = (p) => {
      const e = fs.get(p);
      return e ? e.mtime || 0 : null;
    };
    switch (op) {
      case '=':
      case '==': return a === b;
      case '!=': return a !== b;
      case '<': return a < b;
      case '>': return a > b;
      case '-eq': return int(a) === int(b);
      case '-ne': return int(a) !== int(b);
      case '-lt': return int(a) < int(b);
      case '-le': return int(a) <= int(b);
      case '-gt': return int(a) > int(b);
      case '-ge': return int(a) >= int(b);
      case '-nt': return mt(a) != null && (mt(b) == null || mt(a) > mt(b));
      case '-ot': return mt(b) != null && (mt(a) == null || mt(a) < mt(b));
      case '-ef': return fs.exists(a) && fs.resolve(a) === fs.resolve(b);
      default: throw userErr(`bash: ${who}: ${op}: binary operator expected`, 2);
    }
  }
  /* test and [ ], as POSIX and bash read them: what the words mean depends on how many there are.
       none: false;  one: true if it is not empty;  two: ! WORD, or -f FILE and the like;
       three: A = B, A -lt B …, WORD -a WORD, ! and two, ( WORD );  four: ! and three, ( and two );
       more: an expression with -a, -o, !, ( ).
     A word in the wrong place is reported in bash's words – "[: -gt: unary operator expected" is what
     [ $n -gt 0 ] says when n is empty – and the status is 2. */
  const UNOPS = new Set(Array.from('abcdefghkLprsStuwxOGNznovR', (c) => '-' + c));
  const isBinop = (w) => w !== undefined && BINARY.test(w) && w !== '=~';
  function testExpr(fs, args, who, T) {
    const n = args.length;
    let pos = 0;
    const fail = (msg) => userErr(`bash: ${who}: ${msg}`, 2);
    const one = (w) => w !== '';
    const isUnary = (w) => /^-.$/.test(w);
    const unary = () => {
      const op = args[pos], arg = args[pos + 1];
      if (arg === undefined) throw fail('argument expected');
      pos += 2;
      if (op === '-v') return T.isSet(arg);
      if (op === '-o') return T.optOn(arg);
      if (op === '-R') return T.isRef(arg);
      // -t 0, -t 1: is the input (the output) the terminal – and not a file or a pipe?
      if (op === '-t') return /^\d+$/.test(arg) && T.tty(parseInt(arg, 10));
      return unaryTest(fs, op, arg, T.std);
    };
    const binary = () => {
      pos += 3;
      return binaryTest(fs, args[pos - 3], args[pos - 2], args[pos - 1], who);
    };
    const two = () => {
      if (args[pos] === '!') {
        pos += 2;
        return args[pos - 1] === '';
      }
      if (isUnary(args[pos]) && UNOPS.has(args[pos])) return unary();
      throw fail(`${args[pos]}: unary operator expected`);
    };
    const three = () => {
      if (isBinop(args[pos + 1])) return binary();
      if (args[pos + 1] === '-a' || args[pos + 1] === '-o') {
        pos += 3;
        return args[pos - 2] === '-a' ? one(args[pos - 3]) && one(args[pos - 1]) : one(args[pos - 3]) || one(args[pos - 1]);
      }
      if (args[pos] === '!') {
        pos++;
        return !two();
      }
      if (args[pos] === '(' && args[pos + 2] === ')') {
        pos += 3;
        return one(args[pos - 2]);
      }
      throw fail(`${args[pos + 1]}: binary operator expected`);
    };
    const or = () => {
      let v = and();
      while (pos < n && args[pos] === '-o') {
        pos++;
        const r = and();
        v = v || r;
      }
      return v;
    };
    const and = () => {
      let v = term();
      while (pos < n && args[pos] === '-a') {
        pos++;
        const r = term();
        v = v && r;
      }
      return v;
    };
    const term = () => {
      if (pos >= n) throw fail('argument expected');
      if (args[pos] === '!') {
        let neg = false;
        while (pos < n && args[pos] === '!') {
          pos++;
          neg = !neg;
        }
        return neg ? !term() : term();
      }
      if (args[pos] === '(') {
        pos++;
        const v = or();
        if (args[pos] === undefined) throw fail("`)' expected");
        if (args[pos] !== ')') throw fail(`\`)' expected, found ${args[pos]}`);
        pos++;
        return v;
      }
      if (pos + 3 <= n && isBinop(args[pos + 1])) return binary();
      if (isUnary(args[pos])) {
        if (UNOPS.has(args[pos])) return unary();
        throw fail(`${args[pos]}: unary operator expected`);
      }
      return one(args[pos++]);
    };
    let v;
    if (n === 0) v = false;
    else if (n === 1) {
      v = one(args[0]);
      pos = 1;
    } else if (n === 2) v = two();
    else if (n === 3) v = three();
    else if (n === 4 && args[0] === '!') {
      pos = 1;
      v = !three();
    } else if (n === 4 && args[0] === '(' && args[3] === ')') {
      pos = 1;
      v = two();
      pos = 4;
    } else v = or();
    if (pos < n) throw fail(args[pos][0] === '-' ? `syntax error: \`${args[pos]}' unexpected` : 'too many arguments');
    return v;
  }
  const ttyOf = (ctx) => (fd) => (fd === 0 ? ctx.stdin == null && !ctx.inherit : fd === 1 ? !ctx.takesBytes && !ctx.io.piped : fd === 2);
  /** what a standard descriptor is (see unaryTest): the input that was piped in or comes from a file (< FILE: it has
      a path), the output that goes into a pipe; where the page cannot tell a file from a pipe: null */
  const streamKind = (s) => {
    if (!s || s.dev) return 'tty';
    const p = s.path || null;
    if (p && /^\/dev\//.test(p)) return 'tty'; // < /dev/null: a device
    if (p && /^\/tmp\/\.psub-/.test(p)) return 'pipe'; // < <(command)
    if (p || s.fromFile || s.pipe === false) return (s.text != null ? s.text.length : 1) > 0 ? 'file' : 'empty';
    return 'pipe';
  };
  const fileKind = (fs, p) => (/^\/dev\//.test(p) ? 'tty' : /^\/tmp\/\.psub-/.test(p) ? 'pipe' : fs.exists(p) && !fs.isDir(p) && fs.size(fs.get(p)) > 0 ? 'file' : 'empty');
  const stdOf = (ctx) => (fd) => {
    if (fd === 0) {
      if (ctx.stdin == null) return streamKind(ctx.inherit);
      if (ctx.stdinFrom) return fileKind(ctx.fs, ctx.stdinFrom);
      return typeof ctx.stdin === 'object' && ctx.stdin.fromFile ? (ctx.stdin.psub ? 'pipe' : 'file') : 'pipe';
    }
    if (fd === 1) {
      if (ctx.redirectTarget) return fileKind(ctx.fs, ctx.fs.resolve(ctx.redirectTarget));
      if (ttyOf(ctx)(1)) return 'tty';
      if (ctx.outToPipe) return 'pipe';
      // ({ …; } > FILE, f > FILE, exec > FILE: the file of the block, the function or the script)
      const of = ctx.io.outFile;
      if (of && of.path) return /^\/dev\//.test(of.path) ? 'tty' : fileKind(ctx.fs, ctx.fs.resolve(of.path)) === 'file' ? 'file' : 'empty';
      return ctx.io.piped ? 'pipe' : null;
    }
    return fd === 2 ? 'tty' : null;
  };
  /** set -o NAME: is the option on? */
  const optionOn = (st, name) => {
    const f = { errexit: 'e', nounset: 'u', xtrace: 'x', pipefail: 'pipefail', allexport: 'a', noglob: 'f', noclobber: 'C', verbose: 'v', noexec: 'n', errtrace: 'E' }[name];
    return f ? !!st.flags[f] : ['braceexpand', 'hashall', 'interactive-comments'].includes(name);
  };
  const testEnv = (ctx) => {
    const st = (ctx.opts && ctx.opts.st) || ctx.shell._top();
    return { isSet: (n) => ctx.shell._isSet(n, st), optOn: (n) => optionOn(st, n), isRef: (n) => !!(st.attrs && st.attrs.get(n) && st.attrs.get(n).n && st.vars[n]), tty: ttyOf(ctx), std: stdOf(ctx) };
  };
  B.test = (ctx) => (testExpr(ctx.fs, ctx.args, 'test', testEnv(ctx)) ? 0 : 1);
  B['['] = (ctx) => {
    if (ctx.args[ctx.args.length - 1] !== ']') throw userErr("bash: [: missing `]'", 2);
    return testExpr(ctx.fs, ctx.args.slice(0, -1), '[', testEnv(ctx)) ? 0 : 1;
  };
  /** -v NAME, -v NAME[KEY]: is it set? */
  Shell.prototype._isSet = function (name, st) {
    const m = /^([A-Za-z_]\w*)\[(.+)\]$/.exec(name);
    if (!m) {
      // (-v NAME of an array asks about its element 0; -v 1: is there a first argument?)
      const v = this._get(name, st);
      return Array.isArray(v) ? v[0] !== undefined : isAssoc(v) ? v.has('0') : v !== undefined;
    }
    const v = this._get(m[1], st);
    if (m[2] === '@' || m[2] === '*') return Array.isArray(v) ? v.some((x) => x !== undefined) : isAssoc(v) ? v.size > 0 : v !== undefined;
    // (the subscript is worked out here: [[ -v a[i] ]], [[ -v 'm[$key]' ]])
    const value = (x, n) => {
      const t = this._get(n, st);
      return t == null ? '' : String(Array.isArray(t) ? t[0] : t);
    };
    if (isAssoc(v)) return v.has(m[2].replace(/^(['"])([\s\S]*)\1$/, '$2').replace(/\$\{?([A-Za-z_]\w*)\}?/g, value));
    let k;
    try {
      k = arithEval(m[2].replace(/\$\{?([A-Za-z_]\w*)\}?/g, '$1'), (n) => this._get(n, st), (n, x) => this._set(n, x, st));
    } catch (e) {
      if (!e || !e.arith) throw e;
      return false;
    }
    if (Array.isArray(v)) return v[k < 0 ? v.length + k : k] !== undefined;
    return v !== undefined && k === 0;
  };
  Shell.prototype._cond = async function (words, st, io) {
    const self = this;
    let k = 0, fail = 0;
    const ex = (w) => self._expand(w, st, io, 'one');
    const or = async () => {
      let v = await and();
      while (words[k] === '||') {
        k++;
        const r = await and();
        v = v || r;
      }
      return v;
    };
    const and = async () => {
      let v = await not();
      while (words[k] === '&&') {
        k++;
        const r = await not();
        v = v && r;
      }
      return v;
    };
    const not = async (neg) => {
      if (words[k] === '!') {
        k++;
        return !(await not(!neg));
      }
      return prim(neg);
    };
    const stop = (w) => w === undefined || w === '&&' || w === '||' || w === ')';
    const prim = async (neg) => {
      const w = words[k];
      // (set -x shows each test as it is made: + [[ 3 -gt 2 ]])
      const tr = (a, op, b) => (st.flags.x ? self._xtrace(st, io, `[[ ${neg ? '! ' : ''}${[a, op, b].filter((x) => x !== undefined).map((x) => (x === '' ? "''" : x)).join(' ')} ]]`) : undefined);
      if (stop(w)) throw shErr('[[: conditional expression expected');
      if (w === '(') {
        k++;
        const v = await or();
        if (words[k] !== ')') throw shErr("[[: expected `)'");
        k++;
        return v;
      }
      if (/^-[a-zA-Z]$/.test(w) && !stop(words[k + 1]) && !BINARY.test(words[k + 1])) {
        k += 2;
        const arg = await ex(words[k - 1]);
        await tr(w, arg);
        if (w === '-v') return self._isSet(arg, st);
        if (w === '-o') return optionOn(st, arg);
        if (w === '-R') return !!(st.attrs && st.attrs.get(arg) && st.attrs.get(arg).n && st.vars[arg]);
        if (w === '-t') return arg === '0' ? !st.stdin : arg === '1' ? !io.bytes && !io.piped : arg === '2';
        return unaryTest(self.fs, w, arg, (fd) => (fd === 0 ? streamKind(st.stdin) : fd === 1 ? (!io.bytes && !io.piped ? 'tty' : io.piped ? 'pipe' : null) : fd === 2 ? 'tty' : null));
      }
      const left = await ex(w);
      k++;
      const op = words[k];
      if (stop(op) || !BINARY.test(op)) {
        await tr('-n', left);
        return left !== '';
      }
      k++;
      if (stop(words[k])) throw shErr(`[[: argument expected after ${op}`);
      if (op === '=~') {
        // the rest of the expression is the regular expression
        let raw = words[k++];
        while (!stop(words[k]) && words[k] !== ']]') raw += ' ' + words[k++];
        // A POSIX extended regular expression. What was written in quotes or after a backslash stands for itself
        // ([[ $f =~ \.fq$ ]]: a dot; [[ $x =~ "a.b" ]]: the text a.b); the value of a variable is a pattern.
        const parts = [];
        await self._expandOne(raw, st, io, false, parts, 're');
        await tr(left, op, parts.map((f) => f.v).join(' '));
        let m = null;
        try {
          m = posixExec(parts.map((f) => f.v).join(' '), left, st.shopt && st.shopt.nocasematch ? 'i' : '');
        } catch (e) {
          // (not a regular expression: status 2 – bash says nothing either)
          if (e && (e.shellError || e.shellControl || e.userMessage)) throw e;
          fail = 2;
          return false;
        }
        // BASH_REMATCH: the match and its groups – nothing, when there is no match
        self._set('BASH_REMATCH', m ? Array.from(m, (x) => (x == null ? '' : x)) : [], st);
        return !!m;
      }
      const rraw = words[k++];
      if (op === '=' || op === '==' || op === '!=') {
        const pat = await self._pattern(rraw, st, io);
        await tr(left, op, pat);
        const same = globRe(pat, st.shopt && st.shopt.nocasematch ? 'i' : '').test(left);
        return op === '!=' ? !same : same;
      }
      const right = await ex(rraw);
      await tr(left, op, right);
      if (/^-(eq|ne|lt|le|gt|ge)$/.test(op)) {
        // in [[ ]] the two sides are arithmetic expressions ([[ n -gt 3 ]], [[ 010 -eq 8 ]]; 08 is a mistake)
        const get = self._arithGet(st), put = (name, v) => self._set(name, v, st);
        try {
          return binaryTest(self.fs, arithBig(left, get, put), op, arithBig(right, get, put), '[[');
        } catch (e) {
          if (!e || !e.arith) throw e;
          io.err(`${prefixOf(st)}[[: ${e.message}\n`);
          return false;
        }
      }
      return binaryTest(self.fs, left, op, right, '[[');
    };
    const v = await or();
    if (k < words.length) throw shErr(`[[: syntax error near \`${words[k]}'`, 2);
    return fail || (v ? 0 : 1);
  };

  /* ------------------------------------------------------------------
     entry points: a typed line, bash -c, a script
     ------------------------------------------------------------------ */
  /** what a control exception or a language error means at the top of a run */
  Shell.prototype._ended = function (c, st, io, where) {
    if (c && c.shellControl) {
      if (c.kind === 'cancel') return 130;
      if (c.kind === 'timeout') return 124;
      if (c.kind === 'exit' || c.kind === 'return') return c.code;
      return 0;
    }
    if (c && (c.shellError || c.syntax || c.userMessage)) {
      unsaid(c) && io.err(`${where}${c.message}\n`);
      return c.syntax ? 2 : c.code || 1;
    }
    throw c;
  };
  /** run one line (or block) typed in the terminal */
  Shell.prototype.run = async function (line, io) {
    if (this.running) {
      io.err('The terminal is busy: wait for the current command to finish.\n');
      return 125;
    }
    const text = line.replace(/^\s+|\s+$/g, '');
    if (!text) return 0;
    // each line is an entry of the history (the prompt is a one-line box) – but not what the AI agent ran:
    // the arrow-up key must not hand the student a command of the agent's, to be run in another folder
    if (!(this.term && this.term.agentCmd)) text.split('\n').forEach((l) => l.trim() && this.history.push(l.trim()));
    const st = this._top();
    let ast;
    this.endedBy = null;
    try {
      ast = parse(text, { extglob: extOn(st) });
    } catch (e) {
      if (!e.syntax) throw e;
      unsaid(e) && io.err(`bash: ${e.message}\n`);
      return (this.lastCode = 2);
    }
    let code = 0;
    this.running = true;
    try {
      code = await this._runTop(ast, st, io, () => 'bash: ');
    } catch (c) {
      // What ended the line before its end – where a script would have ended altogether: exit, set -e, a name
      // without a value (set -u, ${NAME:?}), exec. (assistant.js notes it in the record of an agent's run: the
      // script made from the run lets such a command end in a subshell.)
      this.endedBy = c && c.shellControl ? (c.kind !== 'exit' ? null : c.typed ? 'exit' : c.exec ? 'exec' : 'set -e') : c && c.unset ? 'unset' : null;
      if (c && c.shellControl && c.kind === 'exit' && c.typed) {
        // (for the agent, "exit" ends its block of commands: assistant.js looks at this mark)
        this.exitTyped = true;
        if (io.note && !(this.term && this.term.agentCmd)) io.note('This terminal lives in the web page – there is nothing to log out of.');
      }
      code = this._ended(c, st, io, 'bash: ');
      st.cond = 0;
      st.loop = 0;
      st.fn = 0;
      st.locals = null;
      st.stdin = null;
    } finally {
      this.running = false;
    }
    if (this._pendingOut && this._pendingOut.length) await this._settleOut();
    this.lastCode = code;
    // The folder the terminal was in has been removed (rm -rf of it, or of a folder above it – by the line that
    // was typed, or by a script it started). On Linux the shell stays in a folder that is not there any more, and
    // nearly every command fails until one changes folder. Here the prompt moves to the nearest folder that is
    // still there, and says so. (Inside a script nothing is moved: there the commands fail as they do on Linux.)
    if (!this.fs.isDir(this.fs.cwd)) {
      const was = this.fs.cwd;
      let d = was;
      while (d !== '/' && !this.fs.isDir(d)) d = MG.path.dirname(d);
      this.fs.cwd = d;
      if (io.note) io.note(`${this.fs.pretty(was)} – the folder this terminal was in – is not there any more. The terminal is now in ${this.fs.pretty(d)}.`);
    }
    if (this.hooks.afterCommand) this.hooks.afterCommand(text, code);
    return code;
  };
  /** bash -c 'commands': a child shell */
  /** A script or the text of bash -c as bash takes it: command by command – what stands before a syntax error is
      carried out, then the error is reported (status 2). → { ast: the commands that can be read (null: none),
      broken: the report, or null } */
  function parseLoose(text, prefix, ext) {
    try {
      return { ast: parse(text, { eofHeredoc: true, extglob: !!ext }), broken: null };
    } catch (e) {
      if (!e.syntax) throw e;
      const lines = text.split('\n');
      const at = text.slice(0, e.pos).split('\n').length;
      const broken = synReport(prefix, text, e);
      for (let k = Math.min(at, lines.length) - 1; k > 0; k--) {
        try {
          return { ast: parse(lines.slice(0, k).join('\n'), { eofHeredoc: true, extglob: !!ext }), broken };
        } catch (e2) {
          if (!e2.syntax) throw e2;
        }
      }
      return { ast: null, broken };
    }
  }
  Shell.prototype.exec = async function (text, io, opts = {}) {
    const { ast, broken } = parseLoose(text, opts.command ? 'bash: -c: ' : 'bash: ', opts.shopt && opts.shopt.extglob);
    if (!ast) {
      io.err(broken);
      return 2;
    }
    const st = this._process(opts.st || this._top());
    if (opts.shopt) st.shopt = Object.assign({}, opts.shopt);
    if (opts.stdin != null) st.stdin = devStream(await this._stream(opts.stdin), opts); // (else: the input of the caller, shared)
    st.flags = { e: !!opts.errexit, u: !!opts.nounset, x: !!opts.xtrace, pipefail: !!opts.pipefail };
    if (opts.flags) for (const k of ['a', 'f', 'C', 'E', 'n']) if (opts.flags[k]) st.flags[k] = true;
    if (opts.verbose) st.flags.v = true;
    if (opts.shopt && opts.shopt.nullglob) st.flags.nullglob = true;
    st.name = opts.name || 'bash';
    // (no script: BASH_SOURCE is empty; the messages of this shell begin with "bash: line N: ")
    st.script = null;
    st.oneText = !!opts.command;
    st.cOpt = !!opts.command;
    st.sOpt = !!opts.fromStdin;
    st.errName = opts.name || 'bash';
    st.fnames = null;
    st.line = 1;
    st.cond = 0;
    st.fn = 0;
    if (opts.args) st.args = opts.args;
    const cwd = this.fs.cwd, oldpwd = this.oldpwd;
    try {
      let code, ended = false;
      try {
        code = await this._runTop(ast, st, io, () => prefixOf(st));
      } catch (c) {
        if (c && c.shellControl && halts(c)) throw c;
        code = this._ended(c, st, io, prefixOf(st));
        ended = true;
        // (an unset variable under set -u, ${x:?…}: bash -c ends with 127, a script with 1)
        if (opts.command && c && c.unset) code = st.flags && st.flags.e ? 1 : 127;
      }
      if (broken && !ended) {
        io.err(broken);
        code = 2;
      }
      return await this._exitTrap(st, io, code);
    } finally {
      {
        this.fs.cwd = cwd;
        this.oldpwd = oldpwd;
      }
      if (this._pendingOut && this._pendingOut.some((d) => d.passing)) await this._settleOut();
    }
  };
  /** bash script.sh ARGS  (a child shell)  or  source script.sh  (this shell) */
  Shell.prototype.runScript = async function (path, args, io, opts = {}) {
    const text = opts.text != null ? opts.text : await this.fs.readText(path);
    // (A script with the line ends of Windows. For bash the carriage return is a character of the last word of each
    // line: "$'\r': command not found", "syntax error near unexpected token `$'do\r''", a folder called "out\r".
    // The page behaves the same – and says where the trouble comes from, before the messages start.)
    if (/\r\n/.test(text) && io.note) io.note(`${path} has the line ends of Windows: a carriage return (shown as ^M or \\r) at the end of each line. bash takes that character for a part of the last word of the line – messages such as  $'\\r': command not found  come from it. Take them away:  sed -i 's/\\r$//' ${path}`);
    // bash reads a script command by command: what comes before a syntax error still runs
    const parent = opts.st || this._top();
    const loose = parseLoose(text, `${path}: `, opts.sourced ? extOn(parent) : opts.shopt && opts.shopt.extglob);
    const ast = loose.ast;
    let broken = loose.broken;
    if (!ast) {
      io.err(broken);
      return 2;
    }
    let st = parent;
    const saved = { args: parent.args, script: parent.script, stdin: parent.stdin };
    if (opts.sourced) {
      if (args.length) st.args = args;
      st.script = path;
      if (opts.stdin != null) st.stdin = await this._stream(opts.stdin);
    } else {
      st = this._process(parent);
      st.args = args;
      st.name = path;
      st.script = path;
      st.flags = applySetFlags(opts.initialFlags || '', { e: false, u: false, x: false, pipefail: false });
      if (opts.shopt) {
        st.shopt = Object.assign({}, opts.shopt);
        if (opts.shopt.nullglob) st.flags.nullglob = true;
      }
      st.cond = 0;
      st.fn = 0;
      // bash script.sh < FILE, PROGRAM | bash script.sh: the input of the script's commands. Without one, the
      // script reads the input of the block or the script it was called in (st.stdin, shared: see _child).
      if (opts.stdin != null) st.stdin = devStream(await this._stream(opts.stdin), opts);
    }
    const cwd = this.fs.cwd, oldpwd = this.oldpwd;
    let code = 0;
    if (opts.sourced) st.sourced = (st.sourced || 0) + 1;
    try {
      try {
        code = opts.sourced ? await this._runList(ast, st, io) : await this._runTop(ast, st, io, () => `${path}: line ${st.line}: `);
      } catch (c) {
        if (c && c.shellControl && (halts(c) || (opts.sourced && c.kind === 'exit'))) throw c;
        // (an assignment to a read-only variable in a sourced file: the line of the caller ends with it)
        if (opts.sourced && c && c.readonlyVar) throw c;
        // (an unset variable under set -u – or ${x:?…} – in a file that is sourced ends the script that sources it,
        // as in bash: not the "source" command alone, after which the script would go on with half of its settings)
        if (opts.sourced && c && c.unset) {
          unsaid(c) && io.err(`${path}: line ${st.line}: ${c.message}\n`);
          c.said = true;
          throw c;
        }
        code = this._ended(c, st, io, `${path}: line ${st.line}: `);
        broken = null;
      }
      if (broken) {
        io.err(broken);
        code = 2;
      }
      // trap '…' EXIT – with $? the status the script ends with
      if (!opts.sourced) code = await this._exitTrap(st, io, code);
    } finally {
      if (opts.sourced) {
        st.sourced--;
        st.args = saved.args;
        st.script = saved.script;
        st.stdin = saved.stdin;
      } else {
        this.fs.cwd = cwd;
        this.oldpwd = oldpwd;
      }
    }
    return code;
  };
  /** run a command given as words (xargs, command, time): a function or a program */
  Shell.prototype.runArgv = async function (argv, st, io, stdin, who) {
    // (xargs and find are programs: they run programs – a function of the shell is not one; export -f f and
    //  bash -c 'f "$@"' _ ARGS  is the way to it)
    if (who && !MG.shellBuiltins[argv[0]] && !MG.shellTools[argv[0]] && !argv[0].includes('/') && !this.onPath(argv[0], st.vars, true)) {
      io.err(`${who}: ${argv[0]}: No such file or directory\n`);
      return 127;
    }
    return this.runPipeline([{ argv, redirs: [] }], io, argv.join(' '), this._popts(st, stdin));
  };

  /* ------------------------------------------------------------------
     commands that belong to the shell itself
     ------------------------------------------------------------------ */
  const stOf = (ctx) => (ctx.opts && ctx.opts.st) || ctx.shell._top();
  const num = (s, dflt) => (s == null ? dflt : parseInt(s, 10) || 0);
  /* exit [N], return [N]: N is a whole number (its last 8 bits count: exit 256 is 0, exit -1 is 255). Anything else
     is "numeric argument required" – and the status is 2. Without N: the status of the last command – inside a trap,
     the status the trap was started with. */
  const statusArg = (ctx, st) => {
    const a = ctx.args[0] === '--' ? ctx.args.slice(1) : ctx.args;
    if (!a.length) return { code: st.inTrap ? st.trapCode || 0 : ctx.shell.lastCode };
    if (!/^[ \t\n\v\f\r]*[-+]?\d+[ \t]*$/.test(a[0])) {
      ctx.err(`bash: ${ctx.name}: ${a[0]}: numeric argument required\n`);
      return { code: 2 };
    }
    // (exit 1 2, return 1 2: bash says so and gives up the line it stands in – status 1 –, as after a mistake in
    // an expansion; the script goes on with its next line)
    if (a.length > 1) {
      ctx.err(`bash: ${ctx.name}: too many arguments\n`);
      throw Object.assign(lineErr(`${ctx.name}: too many arguments`), { said: true });
    }
    return { code: Number(BigInt.asUintN(8, BigInt(a[0].trim()))) };
  };
  B.exit = (ctx) => {
    const st = stOf(ctx);
    const r = statusArg(ctx, st);
    if (r.stay) return r.code;
    throw Object.assign(new Ctl('exit', r.code), { typed: st.top });
  };
  B.logout = B.exit;
  B.return = (ctx) => {
    const st = stOf(ctx);
    if (!st.fn && !st.sourced) throw userErr("bash: return: can only `return' from a function or sourced script", 2);
    const r = statusArg(ctx, st);
    if (r.stay) return r.code;
    throw new Ctl('return', r.code);
  };
  const loopCtl = (kind) => (ctx) => {
    if (!stOf(ctx).loop) {
      ctx.err(`bash: ${kind}: only meaningful in a \`for', \`while', or \`until' loop\n`);
      return 0;
    }
    const a = ctx.args[0];
    if (a !== undefined && !/^[-+]?\d+$/.test(a)) {
      ctx.err(`bash: ${kind}: ${a}: numeric argument required\n`);
      throw new Ctl('break', 1, 1);
    }
    if (a !== undefined && parseInt(a, 10) < 1) {
      // (break 0: said, and the loop is left with status 1)
      ctx.err(`bash: ${kind}: ${a}: loop count out of range\n`);
      throw new Ctl('break', 1, 1);
    }
    throw new Ctl(kind, 0, a === undefined ? 1 : parseInt(a, 10));
  };
  B.break = loopCtl('break');
  B.continue = loopCtl('continue');
  B.set = (ctx) => {
    const st = stOf(ctx);
    if (!ctx.args.length) {
      // every variable, as bash writes it: a value that needs it in quotes ('…', or $'…' for a tab or a newline)
      const q = (v) => (/^[\w@%+=:,./-]*$/.test(v) ? v : /[\x00-\x1f\x7f]/.test(v) ? "$'" + v.replace(/[\\']/g, '\\$&').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r') + "'" : "'" + v.replace(/'/g, "'\\''") + "'");
      ctx.out(Object.entries(st.vars).filter(([k, v]) => /^[A-Za-z_]\w*$/.test(k) && v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${Array.isArray(v) ? '(' + v.reduce((list, x, i) => (x === undefined ? list : list.concat(`[${i}]="${x}"`)), []).join(' ') + ')' : isAssoc(v) ? '(' + v.entries().map(([a, b]) => `[${a}]="${b}"`).join(' ') + ')' : q(String(v))}\n`).join(''));
      return 0;
    }
    // set -o, set +o: the options, as a list (or as commands)
    if (ctx.args.length === 1 && /^[-+]o$/.test(ctx.args[0])) {
      const state = { errexit: st.flags.e, nounset: st.flags.u, xtrace: st.flags.x, pipefail: st.flags.pipefail, allexport: st.flags.a, noglob: st.flags.f, noclobber: st.flags.C, verbose: st.flags.v, noexec: st.flags.n, braceexpand: true, hashall: true, 'interactive-comments': true };
      ['allexport', 'braceexpand', 'emacs', 'errexit', 'errtrace', 'functrace', 'hashall', 'histexpand', 'history', 'ignoreeof', 'interactive-comments', 'keyword', 'monitor', 'noclobber', 'noexec', 'noglob', 'nolog', 'notify', 'nounset', 'onecmd', 'physical', 'pipefail', 'posix', 'privileged', 'verbose', 'vi', 'xtrace'].forEach((n) => ctx.out(ctx.args[0] === '-o' ? `${n.padEnd(15)}\t${state[n] ? 'on' : 'off'}\n` : `set ${state[n] ? '-' : '+'}o ${n}\n`));
      return 0;
    }
    // the options; from "--", "-" or the first word that is not an option: the arguments ($1 $2 …) of the shell
    let k = 0;
    while (k < ctx.args.length && /^[-+]./.test(ctx.args[k]) && ctx.args[k] !== '--') k += /^[-+][A-Za-z]*o$/.test(ctx.args[k]) && k + 1 < ctx.args.length ? 2 : 1;
    applySetFlags(ctx.args.slice(0, k), st.flags, (msg, code) => {
      throw userErr('bash: ' + msg, code);
    });
    if (k < ctx.args.length) st.args = ctx.args.slice(ctx.args[k] === '--' || ctx.args[k] === '-' ? k + 1 : k);
    return 0;
  };
  B.shift = (ctx) => {
    const st = stOf(ctx);
    const n = num(ctx.args[0], 1);
    if (n > st.args.length) return 1;
    st.args = st.args.slice(n);
    return 0;
  };
  const declare = async (ctx) => {
    const st = stOf(ctx);
    const local = ctx.name === 'local' || ((ctx.name === 'declare' || ctx.name === 'typeset') && st.fn > 0);
    if (ctx.name === 'local' && !st.fn) throw userErr('bash: local: can only be used in a function');
    // -A an associative array, -a an array, -i an integer, -l -u lower and upper case, -r read-only, -x exported
    // (+x: no longer), -p: print the declarations, -g: not local, -n: remove the export (export -n)
    const F = {};
    const names = [];
    for (const a of ctx.args) {
      if (/^[-+][A-Za-z]+$/.test(a) && !names.length) for (const c of a.slice(1)) F[c] = a[0] === '-' ? true : 'off';
      else names.push(a);
    }
    {
      // (a letter that is no option of the command: refused as bash refuses it, status 2)
      const valid = ctx.name === 'export' ? 'fnp' : ctx.name === 'readonly' ? 'aAfp' : 'aAfFgiIlnrtuxp';
      const wrong = Object.keys(F).find((c) => !valid.includes(c));
      const usage = { export: 'export [-fn] [name[=value] ...] or export -p', readonly: 'readonly [-aAf] [name[=value] ...] or readonly -p', local: 'local [option] name[=value] ...', typeset: 'typeset [-aAfFgiIlnrtux] name[=value] ... or typeset -p [-aAfFilnrtux] [name ...]', declare: 'declare [-aAfFgiIlnrtux] [name[=value] ...] or declare -p [-aAfFilnrtux] [name ...]' }[ctx.name];
      if (wrong) throw userErr(`bash: ${ctx.name}: -${wrong}: invalid option\n${ctx.name}: usage: ${usage}`, 2);
    }
    st.exported = st.exported || new Set();
    // export -f NAME, declare -fx NAME: the function is there in the scripts and the bash -c that this shell starts;
    // declare -f [NAME], declare -F: the functions of the shell
    if (F.f || F.F) {
      let code = 0;
      st.xfuncs = st.xfuncs || new Set();
      if (!names.length && (ctx.name === 'export' || F.x === true)) {
        for (const k of Array.from(st.xfuncs).filter((n) => st.funcs[n]).sort()) ctx.out((F.F ? '' : functionText(k, st.funcs[k]) + '\n') + `declare -fx ${k}\n`);
        return 0;
      }
      const list = names.length ? names : Object.keys(st.funcs).sort();
      for (const k of list) {
        if (!st.funcs[k]) {
          if (ctx.name === 'export') ctx.err(`bash: export: ${k}: not a function\n`);
          code = 1;
        } else if (ctx.name === 'export' || F.x) {
          if (F.n || F.x === 'off') st.xfuncs.delete(k);
          else st.xfuncs.add(k);
        } else if (F.F) ctx.out(names.length ? `${k}\n` : `declare -f${st.xfuncs.has(k) ? 'x' : ''} ${k}\n`);
        else ctx.out(functionText(k, st.funcs[k]) + '\n' + (st.xfuncs.has(k) && !names.length ? `declare -fx ${k}\n` : ''));
      }
      return code;
    }
    const quote = (v) => '"' + String(v).replace(/[\\"$`]/g, '\\$&') + '"';
    // (a key is written as bash writes it: plain, in "…" when it holds a blank or another special character)
    const keyText = (a) => (/^[\w.+:@%,/=-]+$/.test(a) ? a : /[\x00-\x1f\x7f]/.test(a) ? shellQuote(a) : quote(a));
    const isRef = ctx.name !== 'export' && ctx.name !== 'readonly';
    const show = (k) => {
      const v = st.vars[k], at = (st.attrs && st.attrs.get(k)) || {};
      const flags = (Array.isArray(v) ? 'a' : isAssoc(v) ? 'A' : '') + (at.i ? 'i' : '') + (at.l ? 'l' : '') + (at.n ? 'n' : '') + (st.readonly && st.readonly.has(k) ? 'r' : '') + (at.u ? 'u' : '') + (st.exported.has(k) ? 'x' : '');
      const val = Array.isArray(v) ? '(' + v.reduce((list, x, i) => (x === undefined ? list : list.concat(`[${i}]=${quote(x)}`)), []).join(' ') + ')' : isAssoc(v) ? '(' + v.entries().map(([a, b]) => `[${keyText(a)}]=${quote(b)} `).join('') + ')' : quote(v);
      // (an array that was declared and has no value yet: "declare -A m", without "=()")
      return `declare -${flags || '-'} ${k}${v === undefined || declaredOnly(v) ? '' : '=' + val}`;
    };
    // export, export -p, declare -x: the exported variables; declare -p [NAME …]
    // readonly, readonly -p, declare -r: the read-only ones
    const roOnly = (ctx.name === 'readonly' || F.r === true) && !F.f;
    if (!names.length && (ctx.name === 'export' || roOnly || F.p || F.x)) {
      const list = Array.from(new Set(Object.keys(st.vars).concat(Array.from(st.exported)))).filter((k) => /^[A-Za-z_]\w*$/.test(k) && (ctx.name === 'export' || F.x ? st.exported.has(k) : st.vars[k] !== undefined) && (!roOnly || (st.readonly && st.readonly.has(k)))).sort();
      if (list.length) ctx.out(list.map(show).join('\n') + '\n');
      return 0;
    }
    if (F.p && ctx.name !== 'export') {
      let code = 0;
      names.forEach((k) => {
        // (declare NAME without a value: the variable is there, and has none – "declare -- NAME")
        if (st.vars[k] === undefined && !(st.declared && st.declared.has(k)) && !/^(BASH_VERSINFO|GROUPS|PIPESTATUS)$/.test(k)) {
          ctx.err(`bash: ${ctx.name}: ${k}: not found\n`);
          code = 1;
        } else if (k === 'BASH_VERSINFO') ctx.out(`declare -ar BASH_VERSINFO=(${BASH_VERSINFO.map((x, i) => `[${i}]=${quote(x)}`).join(' ')})\n`);
        else ctx.out(show(k) + '\n');
      });
      return code;
    }
    const isLocal = local && !F.g;
    for (let a of names) {
      // local -: the options of set are the function's own from here on – what it changes there ends with it
      if (a === '-' && ctx.name === 'local') {
        if (st.locals && !st.locals.has('-')) st.locals.set('-', Object.assign({}, st.flags));
        continue;
      }
      const array = a.startsWith(ARRAY_WORD);
      if (array) a = a.slice(ARRAY_WORD.length);
      // declare 'a[2]=x', local "m[$key]=v": one element (export and readonly take whole variables only)
      const em = !array && isRef ? /^([A-Za-z_]\w*)\[([\s\S]+?)\]=([\s\S]*)$/.exec(a) : null;
      if (em) {
        if (isLocal && st.locals && !st.locals.has(em[1])) {
          st.locals.set(em[1], st.vars[em[1]]);
          delete st.vars[em[1]];
        }
        if (F.A === true && !isAssoc(st.vars[em[1]])) st.vars[em[1]] = new Assoc();
        await ctx.shell._setRef(`${em[1]}[${em[2]}]`, em[3], st, ctx.io);
        continue;
      }
      const m = /^([A-Za-z_]\w*)(?:(\+)?=([\s\S]*))?$/.exec(a);
      if (!m) throw userErr(`bash: ${ctx.name}: \`${/^[A-Za-z_]\w*\[/.test(a) ? a.replace(/=[\s\S]*$/, '') : a}': not a valid identifier`);
      const k = m[1];
      if (isLocal && st.locals && !st.locals.has(k)) {
        st.locals.set(k, st.vars[k]);
        // a new local variable has no value yet (${x-unset}, [[ -v x ]]) – whatever the variable of that name outside is
        if (st.readonly && st.readonly.has(k)) throw Object.assign(shErr(`${k}: readonly variable`), { readonlyVar: true });
        delete st.vars[k];
      }
      if (F.A === true && !isAssoc(st.vars[k])) st.vars[k] = blank(new Assoc());
      if (F.a === true && !array && m[3] === undefined && !Array.isArray(st.vars[k])) st.vars[k] = st.vars[k] === undefined ? blank([]) : [st.vars[k]];
      if (F.i || F.l || F.u || (isRef && F.n)) {
        st.attrs = st.attrs || new Map();
        const at = Object.assign({}, st.attrs.get(k));
        ['i', 'l', 'u'].concat(isRef ? ['n'] : []).forEach((c) => {
          if (F[c] === true) at[c] = true;
          else if (F[c] === 'off') delete at[c];
        });
        if (F.l === true) delete at.u;
        if (F.u === true) delete at.l;
        st.attrs.set(k, at);
      }
      if (isRef && F.n === true) {
        // declare -n REF=NAME, local -n REF=$1: REF stands for the variable NAME from now on
        if (m[3] !== undefined) {
          if (!/^[A-Za-z_]\w*(\[[\s\S]+\])?$/.test(m[3])) throw userErr(`bash: ${ctx.name}: \`${m[3]}': invalid variable name for name reference`);
          if (m[3] === k) throw userErr(`bash: ${ctx.name}: ${k}: nameref variable self references not allowed`);
          st.vars[k] = m[3];
        }
      } else if (array || m[2]) await ctx.shell._assign(a, st, ctx.io);
      else if (m[3] !== undefined) ctx.shell._set(k, m[3], st);
      else if (st.vars[k] === undefined) (st.declared = st.declared || new Set()).add(k);
      if (ctx.name === 'readonly' || F.r === true) (st.readonly = st.readonly || new Set()).add(k);
      if ((ctx.name === 'export' && !F.n) || F.x === true) st.exported.add(k);
      else if ((!isRef && F.n) || F.x === 'off') st.exported.delete(k);
    }
    return 0;
  };
  ['export', 'local', 'declare', 'typeset', 'readonly'].forEach((k) => (B[k] = declare));
  /* unset NAME …, unset 'NAME[subscript]' (one element: the subscript is worked out here – unset 'a[$i]',
     unset 'a[${#a[@]}-1]', unset 'm[$key]'), unset -f FUNCTION, unset -n REFERENCE */
  B.unset = async (ctx) => {
    const st = stOf(ctx);
    let code = 0;
    const isOpt = (a) => /^-[fvn]+$/.test(a), has = (c) => ctx.args.some((a) => isOpt(a) && a.includes(c));
    if (ctx.args.length && /^-[A-Za-z]/.test(ctx.args[0]) && !isOpt(ctx.args[0])) throw userErr(`bash: unset: -${Array.from(ctx.args[0].slice(1)).find((c) => !'fvn'.includes(c))}: invalid option\nunset: usage: unset [-f] [-v] [-n] [name ...]`, 2);
    const fail = (msg) => {
      ctx.err(`bash: unset: ${msg}\n`);
      code = 1;
    };
    const whole = (k) => {
      if (st.readonly && st.readonly.has(k)) return fail(`${k}: cannot unset: readonly variable`);
      delete st.vars[k];
      if (st.exported) st.exported.delete(k);
      if (st.attrs) st.attrs.delete(k);
      if (st.declared) st.declared.delete(k);
      // (RANDOM and SECONDS are ordinary variables once they were unset)
      if (k === 'RANDOM') st.noRandom = true;
    };
    for (let k of ctx.args.filter((a) => !isOpt(a))) {
      // unset REF: the variable that a name reference stands for goes (unset -n REF: the reference itself)
      const refOf = (n) => (!has('f') && !has('n') && st.attrs && st.attrs.get(n) && st.attrs.get(n).n ? ctx.shell._refTarget(n, st) : null);
      const r = refOf(k);
      if (r && r.name !== k) k = r.sub === undefined ? r.name : `${r.name}[${r.sub}]`;
      let e = /^([A-Za-z_]\w*)\[([\s\S]*)\]$/.exec(k);
      // (unset 'REF[1]': the element of the array that the reference stands for)
      const r2 = e ? refOf(e[1]) : null;
      if (r2 && r2.name !== e[1] && r2.sub === undefined) e = [k, r2.name, e[2]];
      if (has('f') || (st.vars[k] === undefined && st.funcs[k] && !has('v'))) {
        delete st.funcs[k];
        if (st.xfuncs) st.xfuncs.delete(k);
      } else if (e) {
        const cur = st.vars[e[1]];
        if (cur === undefined) continue; // (nothing there: nothing to do, status 0)
        if (st.readonly && st.readonly.has(e[1])) {
          fail(`${e[1]}: cannot unset: readonly variable`);
          continue;
        }
        if (e[2] === '@' || e[2] === '*') {
          whole(e[1]);
          continue;
        }
        if (isAssoc(cur)) {
          const key = /[$`\\]/.test(e[2]) ? await ctx.shell._expand(e[2], st, ctx.io, 'one') : e[2].replace(/^(['"])([\s\S]*)\1$/, '$2');
          st.vars[e[1]] = cur.without(key);
          continue;
        }
        let at;
        try {
          at = await ctx.shell._arith(e[2], st, ctx.io);
        } catch (x) {
          if (!x || !x.arith) throw x;
          fail(x.message);
          continue;
        }
        if (!Array.isArray(cur)) {
          // (a plain variable is its own element 0)
          if (at === 0) whole(e[1]);
          else fail(`${e[1]}: not an array variable`);
          continue;
        }
        if (at < 0) at += cur.length;
        if (at < 0) {
          fail(`[${e[2]}]: bad array subscript`);
          continue;
        }
        const copy = cur.slice();
        delete copy[at];
        while (copy.length && copy[copy.length - 1] === undefined) copy.length--;
        st.vars[e[1]] = copy;
      } else whole(k);
    }
    return code;
  };
  B.read = async (ctx) => {
    const st = stOf(ctx);
    const names = [];
    let raw = false;
    let into = null; // read -a NAME: all the fields, as an array
    let count = null, exact = false, delim = '\n'; // -n COUNT, -N COUNT (that many characters), -d C (up to C)
    let fd = null; // -u N: from descriptor N (exec 3< FILE)
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (!/^-[a-zA-Z]/.test(a) || names.length) {
        names.push(a);
        continue;
      }
      // -r, -s, -e alone or together (-rs); an option with a value takes the rest of the word or the next word
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (c === 'r') raw = true;
        else if ('adnNptu'.includes(c)) {
          const v = j + 1 < a.length ? a.slice(j + 1) : ctx.args[++i];
          if (c === 'a') into = v;
          else if (c === 'n' || c === 'N') {
            count = Math.max(0, parseInt(v, 10) || 0);
            exact = c === 'N';
          } else if (c === 'd') delim = v == null || v === '' ? '\0' : v[0];
          else if (c === 'u') fd = parseInt(v, 10);
          break;
        }
      }
    }
    for (const nm of names) if (!/^[A-Za-z_]\w*(\[[\s\S]*\])?$/.test(nm)) throw userErr(`bash: read: \`${nm}': not a valid identifier`, 1);
    // (read without a name: the whole line goes to REPLY, with the blanks at its start and its end)
    const plain = !names.length && !into;
    if (!names.length) names.push('REPLY');
    let src = null;
    if (fd != null && fd !== 0) {
      src = st.fds && st.fds[fd] && st.fds[fd].in;
      if (!src) throw userErr(`bash: read: ${fd}: invalid file descriptor: Bad file descriptor`);
    } else if (ctx.stdin != null) src = { text: typeof ctx.stdin === 'string' ? ctx.stdin : await MG.wasm.readText(ctx.stdin.apath), pos: 0 };
    else if (st.stdin) src = st.stdin;
    if (!src) {
      ctx.io.note('read: this terminal cannot ask you for input – give the value on the command line or in a variable.');
      return 1;
    }
    // (read 'a[1]', read 'm[key]': one element of an array – its subscript is worked out as in an assignment)
    const set = (k, v) => {
      const e = /^([A-Za-z_]\w*)\[([\s\S]+)\]$/.exec(k);
      if (!e) return ctx.shell._set(k, v, st);
      const old = ctx.shell._get(e[1], st);
      if (isAssoc(old)) return ctx.shell._set(e[1], old.with(e[2].replace(/^(['"])([\s\S]*)\1$/, '$2'), v), st);
      const arr = Array.isArray(old) ? old.slice() : old == null ? [] : [old];
      const i = arithEval(e[2].replace(/\$\{?([A-Za-z_]\w*)\}?/g, '$1'), ctx.shell._arithGet(st), (n, x) => ctx.shell._set(n, x, st));
      arr[i < 0 ? arr.length + i : i] = v;
      return ctx.shell._set(e[1], arr, st);
    };
    if (src.pos >= src.text.length) {
      if (into) set(into, []);
      else names.forEach((k) => set(k, ''));
      return 1;
    }
    // The line: up to the delimiter (a newline), or COUNT characters (-n: at most, -N: exactly, and then a newline is
    // a character like any other). Without -r a backslash takes the next character with it – it is then no
    // separator –, and a backslash at the end of a line joins the next line to it.
    const text = src.text, chars = [];
    let i = src.pos, eof = true;
    while (i < text.length) {
      if (count != null && chars.length >= count) {
        eof = false;
        break;
      }
      const c = text[i];
      if (!raw && c === '\\') {
        if (i + 1 >= text.length) {
          i++;
          break;
        }
        if (text[i + 1] !== '\n') chars.push({ c: text[i + 1], q: true });
        i += 2;
        continue;
      }
      if (!exact && c === delim) {
        i++;
        eof = false;
        break;
      }
      // (a character outside the 16-bit range is one character)
      const cp = text.codePointAt(i), ch = String.fromCodePoint(cp);
      chars.push({ c: ch, q: false });
      i += ch.length;
    }
    if (count != null && chars.length >= count) eof = false;
    src.pos = i;
    const whole = chars.map((x) => x.c).join('');
    const ifs = typeof st.vars.IFS === 'string' ? st.vars.IFS : ' \t\n';
    if (exact || ifs === '' || plain) {
      // read -N: nothing is split;  IFS=: the whole line, with its blanks
      if (into) set(into, whole === '' ? [] : [whole]);
      else names.forEach((k, idx) => set(k, idx === 0 ? whole : ''));
      return eof ? 1 : 0;
    }
    // The fields, as the shell splits words: blanks of IFS in a row are one separator, and count neither at the start
    // nor at the end of the line; any other character of IFS separates by itself (a::b has an empty field).
    const n = chars.length;
    const ws = (x) => !x.q && ifs.includes(x.c) && ' \t\n'.includes(x.c);
    const other = (x) => !x.q && ifs.includes(x.c) && !' \t\n'.includes(x.c);
    let k = 0;
    while (k < n && ws(chars[k])) k++;
    const word = () => {
      let w = '';
      while (k < n && !ws(chars[k]) && !other(chars[k])) w += chars[k++].c;
      while (k < n && ws(chars[k])) k++;
      if (k < n && other(chars[k])) {
        k++;
        while (k < n && ws(chars[k])) k++;
      }
      return w;
    };
    if (into) {
      const fields = [];
      while (k < n) fields.push(word());
      set(into, fields);
      return eof ? 1 : 0;
    }
    names.forEach((name, idx) => {
      if (idx < names.length - 1) return set(name, k < n ? word() : '');
      // the last name: all that is left, with its separators – but if that is exactly one field, the separator
      // behind it goes ("x|y|" gives y, "x|y||" gives y||)
      if (k >= n) return set(name, '');
      const from = k, w = word();
      if (k >= n) return set(name, w);
      let end = n;
      while (end > from && ws(chars[end - 1])) end--;
      return set(name, chars.slice(from, end).map((x) => x.c).join(''));
    });
    return eof ? 1 : 0;
  };
  B.eval = async (ctx) => {
    const st = stOf(ctx);
    const text = ctx.args.join(' ');
    if (!text.trim()) return 0;
    // eval 'wc -l' < FILE, cmd | eval '…': the input of the commands of the text
    const before = st.stdin;
    if (ctx.stdin != null) st.stdin = await ctx.shell._stream(ctx.stdin);
    const base = st.lineBase, line = st.line;
    let ast;
    try {
      ast = parse(text, { extglob: extOn(st) });
    } catch (e) {
      // a syntax error in the text: eval fails (status 2), the script goes on
      if (!e.syntax) throw e;
      const rep = synReport('', text, e).replace(/^line (\d+): /gm, (x, k) => `${st.script || st.errName || 'bash'}: eval: line ${+k + (st.lineFixed != null ? st.lineFixed : line) - 1}: `);
      ctx.err(rep);
      return 2;
    }
    if (st.lineFixed == null) st.lineBase = line - 1;
    st.xlevel = (st.xlevel || 0) + 1;
    try {
      return await ctx.shell._runList(ast, st, innerIO(ctx));
    } finally {
      st.xlevel--;
      st.stdin = before;
      st.lineBase = base;
      st.line = line;
    }
  };
  /* trap 'COMMANDS' SIGNAL …, trap - SIGNAL … (as it was), trap -p [SIGNAL …] and trap alone (the traps that are
     set, as commands), trap -l (the names of the signals).
     Carried out here: EXIT (when a script, bash -c, a subshell ends) and ERR (when a command fails). The signals
     of a real computer – INT, TERM, HUP … – do not reach a script in this terminal: a trap for one is kept and
     shown, and never runs (Ctrl+C stops the script without it). */
  const SIGNALS = ['EXIT', 'HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'BUS', 'FPE', 'KILL', 'USR1', 'SEGV', 'USR2', 'PIPE', 'ALRM', 'TERM', 'STKFLT', 'CHLD', 'CONT', 'STOP', 'TSTP', 'TTIN', 'TTOU', 'URG', 'XCPU', 'XFSZ', 'VTALRM', 'PROF', 'WINCH', 'IO', 'PWR', 'SYS'];
  const RT = Array.from({ length: 31 }, (_, k) => (k === 0 ? 'RTMIN' : k <= 15 ? `RTMIN+${k}` : k === 30 ? 'RTMAX' : `RTMAX-${30 - k}`)); // 34 … 64
  const PSEUDO = ['DEBUG', 'ERR', 'RETURN'];
  /** a signal as it was written (INT, SIGINT, sigint, 2, 0) → its name without SIG (EXIT, INT, ERR …), or null */
  const signalName = (s) => {
    if (/^\d+$/.test(s)) return +s < SIGNALS.length ? SIGNALS[+s] : +s >= 34 && +s <= 64 ? RT[+s - 34] : null;
    const u = s.toUpperCase().replace(/^SIG/, '');
    return SIGNALS.includes(u) || RT.includes(u) || PSEUDO.includes(u) ? u : null;
  };
  const signalShown = (n) => (n === 'EXIT' || PSEUDO.includes(n) ? n : 'SIG' + n);
  B.trap = (ctx) => {
    const st = stOf(ctx);
    let args = ctx.args.slice(), list = false, print = false;
    while (args.length && /^-[A-Za-z]/.test(args[0])) {
      const a = args.shift();
      if (!/^-[lp]+$/.test(a)) throw userErr(`bash: trap: ${a.slice(0, 2)}: invalid option\ntrap: usage: trap [-lp] [[arg] signal_spec ...]`, 2);
      if (a.includes('l')) list = true;
      if (a.includes('p')) print = true;
    }
    if (args[0] === '--') args.shift();
    if (list) {
      const all = SIGNALS.slice(1).map((n, k) => [k + 1, n]).concat(RT.map((n, k) => [k + 34, n]));
      let out = '';
      all.forEach(([num, n], k) => (out += `${String(num).padStart(2)}) SIG${n}` + (k % 5 === 4 ? '\n' : '\t')));
      ctx.out(out.endsWith('\n') ? out : out + '\n');
      return 0;
    }
    // (in a subshell – saved=$(trap -p EXIT) – the traps of the shell around it are shown, until one is set there)
    const all = () => Object.assign({}, st.ptraps && !st.trapsOwn ? st.ptraps : {}, st.signals || {}, st.traps);
    const quote = (t) => "'" + t.replace(/'/g, "'\\''") + "'";
    const order = SIGNALS.concat(RT, PSEUDO);
    const show = (names) => {
      const set = all();
      names.filter((n) => n in set).sort((a, b) => order.indexOf(a) - order.indexOf(b)).forEach((n) => ctx.out(`trap -- ${quote(set[n])} ${signalShown(n)}\n`));
    };
    let code = 0;
    const named = (list2) => list2.map((s) => {
      const n = signalName(s);
      if (n == null) {
        ctx.err(`bash: trap: ${s}: invalid signal specification\n`);
        code = 1;
      }
      return n;
    }).filter((n) => n != null);
    if (print || !args.length) {
      show(args.length ? named(args) : Object.keys(all()));
      return code;
    }
    // trap SIGNAL: as it was;  trap 2 3 (the first word a number): those signals as they were
    let action = args[0], sigs = args.slice(1);
    if (!sigs.length) {
      if (signalName(action) == null) throw userErr('trap: usage: trap [-lp] [[arg] signal_spec ...]', 2);
      sigs = [action];
      action = '-';
    } else if (/^\d+$/.test(action)) {
      sigs = args;
      action = '-';
    }
    named(sigs).forEach((name) => {
      const real = name === 'EXIT' || name === 'ERR';
      const store = real ? st.traps : (st.signals = st.signals || {});
      st.trapsOwn = true;
      if (name === 'ERR') {
        st.errFn = st.fn || 0;
        st.errSub = st.subshell || 0;
      }
      if (action === '-') delete store[name];
      else if (action === '' && real) delete store[name]; // (nothing to do at EXIT, or when a command fails)
      else store[name] = action;
    });
    return code;
  };
  /* compgen -G PATTERN: the names that the pattern matches, one to a line (status 1: none) – the usual question is
     "are there any?":  compgen -G '*.fastq' > /dev/null.  compgen -v [PREFIX], -A function, -c, -f, -d: the names of
     the variables, functions, commands, files and folders that begin with PREFIX. (The rest of compgen is about
     completing words at the prompt.) */
  B.compgen = (ctx) => {
    const st = stOf(ctx), a = ctx.args;
    const usage = (opt) => userErr(`bash: compgen: ${opt}: invalid option\ncompgen: usage: compgen [-abcdefgjksuv] [-o option] [-A action] [-G globpat] [-W wordlist] [-F function] [-C command] [-X filterpat] [-P prefix] [-S suffix] [word]`, 2);
    let kind = null, glob = null, words = null, k = 0;
    for (; k < a.length && /^-./.test(a[k]); k++) {
      if (a[k] === '--') {
        k++;
        break;
      }
      if (a[k] === '-G') glob = a[++k];
      else if (a[k] === '-W') words = String(a[++k] || '').split(/[ \t\n]+/).filter((x) => x !== '');
      else if (a[k] === '-A') kind = a[++k];
      else if (/^-[vcfdabek]$/.test(a[k])) kind = { v: 'variable', c: 'command', f: 'file', d: 'directory', a: 'alias', b: 'builtin', e: 'export', k: 'keyword' }[a[k][1]];
      else throw usage(a[k]);
    }
    const prefix = a[k] || '';
    const so = st.shopt || {}, gopts = { globstar: !!so.globstar, dotglob: !!so.dotglob, nocase: !!so.nocaseglob, noext: !extOn(st) };
    const matches = (pat) => {
      const g = ctx.fs.glob(pat, gopts);
      return g.length === 1 && g[0] === pat && !ctx.fs.exists(pat) ? [] : g;
    };
    let names;
    if (glob != null) names = matches(glob);
    else if (words) names = words;
    else if (kind === 'variable') names = Object.keys(st.vars).filter((n) => st.vars[n] !== undefined && /^[A-Za-z_]\w*$/.test(n)).concat(['BASHOPTS', 'BASHPID', 'BASH_COMMAND', 'BASH_LINENO', 'BASH_SOURCE', 'BASH_SUBSHELL', 'BASH_VERSINFO', 'BASH_VERSION', 'EPOCHREALTIME', 'EPOCHSECONDS', 'EUID', 'FUNCNAME', 'GROUPS', 'LINENO', 'OLDPWD', 'PIPESTATUS', 'PWD', 'RANDOM', 'SECONDS', 'SHELLOPTS', 'SRANDOM', 'UID'].filter((n) => ctx.shell._get(n, st) !== undefined));
    else if (kind === 'export') names = Array.from(st.exported || []).filter((n) => st.vars[n] !== undefined);
    else if (kind === 'function') names = Object.keys(st.funcs);
    else if (kind === 'builtin') names = SHELL_WORDS.filter((n) => MG.shellBuiltins[n]);
    else if (kind === 'keyword') names = KEYWORDS.slice();
    else if (kind === 'command') names = Object.keys(st.funcs).concat(Object.keys(MG.shellBuiltins), Object.keys(MG.shellTools));
    else if (kind === 'file' || kind === 'directory') names = matches(prefix.replace(/[*?[\\]/g, '\\$&') + '*').filter((n) => kind === 'file' || ctx.fs.isDir(n));
    else if (kind === 'alias') names = [];
    else if (kind != null) throw userErr(`bash: compgen: ${kind}: invalid action name`, 2);
    else return 1;
    if (glob == null && kind !== 'file' && kind !== 'directory') names = names.filter((n) => n.startsWith(prefix));
    names = Array.from(new Set(names)).sort();
    if (names.length) ctx.out(names.join('\n') + '\n');
    return names.length ? 0 : 1;
  };
  /* what a name is: a keyword of the language, a function, a command that belongs to the shell itself (a builtin), or
     a program – one of this terminal's, or an executable file of the student's (./run.sh, or in a folder on PATH) */
  const SHELL_WORDS = ['.', ':', '[', 'break', 'builtin', 'caller', 'cd', 'command', 'compgen', 'continue', 'declare', 'dirs', 'echo', 'eval', 'exec', 'exit', 'export', 'false', 'getopts', 'hash', 'help', 'history', 'let', 'local', 'logout', 'mapfile', 'popd', 'printf', 'pushd', 'pwd', 'read', 'readarray', 'readonly', 'return', 'set', 'shift', 'shopt', 'source', 'test', 'times', 'trap', 'true', 'type', 'typeset', 'ulimit', 'umask', 'unset', 'wait'];
  const KEYWORDS = ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in', 'function', 'select', 'time', '{', '}', '!', '[[', ']]', 'coproc'];
  const kindOf = (ctx, c) => {
    if (KEYWORDS.includes(c)) return { kind: 'keyword' };
    if (stOf(ctx).funcs[c]) return { kind: 'function', body: stOf(ctx).funcs[c] };
    if (SHELL_WORDS.includes(c) && MG.shellBuiltins[c]) return { kind: 'builtin' };
    // (a script of one's own in a folder that comes first on PATH is found first; the programs of the terminal are
    // found while /usr/bin or /bin is on PATH – see sysPath)
    if ((MG.shellTools[c] || MG.shellBuiltins[c]) && ctx.shell.sysPath(ctx.env) && ctx.shell.programPath(c)) return { kind: 'file', path: ctx.shell.programPath(c) };
    if (c.includes('/')) {
      const e = ctx.fs.get(c);
      return e && e.kind !== 'dir' && e.mode === 'x' ? { kind: 'file', path: c } : null;
    }
    const found = ctx.shell.onPath(c, ctx.env);
    return found ? { kind: 'file', path: found } : null;
  };
  /* declare -f NAME, type NAME: the function as bash prints it – one command to a line, four spaces in, the words
     as they were written, comments gone. The layout is bash's own (print_cmd.c), so that what comes out here is
     what comes out there: elif as an if inside else, >&2 as 1>&2, the text of a here-document after its line. */
  function functionText(name, body, nested) {
    let out = '', ind = nested || 0, skip = 0, connection = 0, wasHeredoc = false, deferred = [];
    const put = (s) => {
      out += s;
    };
    const indent = () => put(' '.repeat(ind));
    const lead = () => {
      if (skip) skip--;
      else indent();
    };
    const newline = (s) => {
      put('\n');
      indent();
      if (s) put(s);
    };
    const semicolon = () => {
      const c = out[out.length - 1];
      if (c !== '&' && c !== '\n') put(';');
    };
    // the texts of the here-documents that are waiting, after the connector (a |, a && …) of their command
    const flush = (cstring) => {
      const text = cstring && (cstring[0] !== ';' || cstring.length > 1) ? cstring : '';
      put(text);
      if (!deferred.length) return;
      put('\n');
      for (const r of deferred) put(r.body + (r.delim || 'EOF') + '\n');
      if (text) put(' ');
      deferred = [];
      wasHeredoc = true;
    };
    const flushIf = () => {
      if (deferred.length) flush('');
    };
    const redirText = (r) => {
      const n = (dflt) => (r.fd == null || r.fd === dflt ? '' : String(r.fd));
      switch (r.op) {
        case '<<': return `${n(0)}<<${r.strip ? '-' : ''}${r.rawDelim || (r.quoted ? "'EOF'" : 'EOF')}`;
        case '<': return `${n(0)}< ${r.target}`;
        case '>': return `${n(1)}>${r.clobber ? '|' : ''} ${r.target}`;
        case '>>': return `${n(1)}>> ${r.target}`;
        case '<>': return `${n(0)}<> ${r.target}`;
        case '<<<': return `${n(0)}<<< ${r.target}`;
        case '>&': return /^(\d+|-)$/.test(r.target) ? `${r.fd == null ? 1 : r.fd}>&${r.target}` : r.fd == null || r.fd === 1 ? `&> ${r.target}` : `${r.fd}>&${r.target}`;
        case '<&': return `${r.fd == null ? 0 : r.fd}<&${r.target}`;
        default: return `${r.op} ${r.target}`; // &> and &>>
      }
    };
    const redirList = (rs) => {
      wasHeredoc = false;
      put(rs.map(redirText).join(' '));
      const here = rs.filter((r) => r.op === '<<');
      if (!here.length) return;
      if (connection) deferred = here;
      else {
        put('\n');
        for (const r of here) put(r.body + (r.delim || 'EOF') + '\n');
        wasHeredoc = true;
      }
    };
    // ($'a\tb' is kept by bash as the text it stands for, in plain quotes)
    const ansiPlain = (w) => {
      if (!w.includes("$'")) return w;
      let res = '', i = 0;
      while (i < w.length) {
        const c = w[i];
        let j = i + 1;
        if (c === '\\') j = i + 2;
        else if (c === "'") j = scanSq(w, i);
        else if (c === '"') j = scanDq(w, i);
        else if (c === '$' && w[i + 1] === "'") {
          j = i + 2;
          while (j < w.length && w[j] !== "'") j += w[j] === '\\' ? 2 : 1;
          res += "'" + settleRaw(unescapeC(w.slice(i + 2, j))).replace(/'/g, "'\\''") + "'";
          i = j + 1;
          continue;
        }
        res += w.slice(i, j);
        i = j;
      }
      return res;
    };
    let list;
    const block = (l) => {
      ind += 4;
      list(l);
      flushIf();
      ind -= 4;
    };
    const func = (fname, b, keyword) => {
      put(`${keyword ? 'function ' : ''}${fname} () \n`);
      indent();
      put('{ \n');
      ind += 4;
      if (b.type === 'group') list(b.body);
      else command(Object.assign({}, b));
      flushIf();
      ind -= 4;
      if (b.type === 'group' && b.redirs && b.redirs.length) {
        newline('} ');
        redirList(b.redirs);
      } else newline('}');
    };
    function command(cmd) {
      lead();
      switch (cmd.type) {
        case 'simple':
          put(cmd.assigns.concat(cmd.words).map(ansiPlain).join(' '));
          if (cmd.redirs && cmd.redirs.length) {
            if (cmd.assigns.length || cmd.words.length) put(' ');
            redirList(cmd.redirs);
          }
          return;
        case 'func':
          func(cmd.name, cmd.body, true);
          return;
        case 'group':
          put('{ \n');
          block(cmd.body);
          put('\n');
          indent();
          put('}');
          break;
        case 'subshell':
          put('( ');
          skip++;
          list(cmd.body);
          flushIf();
          put(' )');
          break;
        case 'arith':
          put(`((${cmd.expr}))`);
          break;
        case 'cond':
          put(`[[ ${cmd.words.join(' ')} ]]`);
          break;
        case 'if': {
          const one = (k) => {
            put('if ');
            skip++;
            list(cmd.clauses[k].cond);
            semicolon();
            put(' then\n');
            block(cmd.clauses[k].body);
            const more = k + 1 < cmd.clauses.length;
            if (more || cmd.orelse) {
              semicolon();
              newline('else\n');
              ind += 4;
              if (more) {
                indent();
                one(k + 1);
              } else list(cmd.orelse);
              flushIf();
              ind -= 4;
            }
            semicolon();
            newline('fi');
          };
          one(0);
          break;
        }
        case 'while':
          put(cmd.until ? 'until ' : 'while ');
          skip++;
          list(cmd.cond);
          flushIf();
          semicolon();
          put(' do\n');
          block(cmd.body);
          semicolon();
          newline('done');
          break;
        case 'for':
        case 'cfor':
          if (cmd.type === 'for') put(`for ${cmd.name} in ${cmd.words ? cmd.words.join(' ') : '"$@"'};`);
          else put(`for ((${cmd.init.replace(/^\s+/, '')}; ${cmd.test.replace(/^\s+/, '')}; ${cmd.step.replace(/^\s+/, '')}))`);
          newline('do\n');
          ind += 4;
          list(cmd.body);
          flushIf();
          semicolon();
          ind -= 4;
          newline('done');
          break;
        case 'case':
          put(`case ${cmd.word} in `);
          ind += 4;
          for (const cl of cmd.clauses) {
            newline('');
            put(cl.patterns.join(' | ') + ')\n');
            ind += 4;
            list(cl.body);
            ind -= 4;
            flushIf();
            newline(cl.end);
          }
          ind -= 4;
          newline('esac');
          break;
        default:
      }
      if (cmd.redirs && cmd.redirs.length) {
        put(' ');
        redirList(cmd.redirs);
      }
    }
    const pipeline = (p) => {
      lead();
      if (p.timed) put(p.timed === 'p' ? 'time -p ' : 'time ');
      if (p.negate) put('! ');
      const many = p.cmds.length > 1;
      if (many) connection++;
      p.cmds.forEach((c, k) => {
        if (k) {
          flush(' |');
          put(' ');
        }
        skip++;
        command(c);
        if (k) flushIf();
      });
      if (many) connection--;
    };
    const andor = (a) => {
      lead();
      if (a.rest.length) connection++;
      skip++;
      pipeline(a.first);
      for (const r of a.rest) {
        flush(` ${r.op} `);
        skip++;
        pipeline(r.pipe);
        flushIf();
      }
      if (a.rest.length) connection--;
    };
    list = (l) => {
      const many = l.items.length > 1;
      if (many) connection++;
      l.items.forEach((item, k) => {
        andor(item);
        if (k < l.items.length - 1) {
          if (deferred.length) flush('');
          else if (wasHeredoc) wasHeredoc = false;
          else put(';');
          put('\n');
        } else if (k) flushIf();
      });
      if (many) connection--;
    };
    func(name, body, false);
    return out;
  }
  const describe = (c, k) => (k.kind === 'keyword' ? `${c} is a shell keyword` : k.kind === 'function' ? `${c} is a function` + (k.body ? '\n' + functionText(c, k.body) : '') : k.kind === 'builtin' ? `${c} is a shell builtin` : `${c} is ${k.path}`);
  B.command = async (ctx) => {
    const args = ctx.args.slice();
    if (args[0] === '-v' || args[0] === '-V') {
      // (the status is 0 if one of the names is there – as in bash; "type" fails if one of them is missing)
      let any = false;
      args.slice(1).forEach((c) => {
        const k = kindOf(ctx, c);
        if (!k) {
          if (args[0] === '-V') ctx.err(`bash: command: ${c}: not found\n`);
          return;
        }
        any = true;
        if (args[0] === '-V') ctx.out(describe(c, k) + '\n');
        else ctx.out((k.kind === 'file' ? k.path : c) + '\n'); // (a keyword, a function, a builtin: its name alone)
      });
      return any ? 0 : 1;
    }
    while (args.length && args[0].startsWith('-')) args.shift();
    if (!args.length) return 0;
    // the command itself – not a function of that name – in the place of "command": with its input, its redirection
    // and its place in the pipe
    return ctx.shell.runAs(ctx, args);
  };
  B.builtin = (ctx) => {
    const name = ctx.args[0];
    if (name != null && !/^-/.test(name) && !(SHELL_WORDS.includes(name) && MG.shellBuiltins[name])) throw userErr(`bash: builtin: ${name}: not a shell builtin`, 1);
    return B.command(ctx);
  };
  /* caller [N]: from where the function that is running was called – the line and the file; with N the name of the
     calling function too (N frames up). As bash does it: from BASH_LINENO, FUNCNAME and BASH_SOURCE. */
  B.caller = (ctx) => {
    const st = stOf(ctx);
    const arr = (v) => (v == null || v === '' ? [] : Array.isArray(v) ? v : [v]);
    const lines = arr(ctx.shell._get('BASH_LINENO', st)), files = arr(ctx.shell._get('BASH_SOURCE', st)), names = arr(ctx.shell._get('FUNCNAME', st));
    if (!lines.length || !files.length) return 1;
    const a = ctx.args[0] === '--' ? ctx.args[1] : ctx.args[0];
    if (a === undefined) return ctx.out(`${lines[0] != null ? lines[0] : 'NULL'} ${files[1] != null ? files[1] : 'NULL'}\n`);
    if (!/^[-+]?\d+$/.test(a)) throw userErr(`bash: caller: ${a}: invalid number\ncaller: usage: caller [expr]`, 2);
    const n = parseInt(a, 10);
    if (!names.length || lines[n] == null || files[n + 1] == null || names[n + 1] == null) return 1;
    return ctx.out(`${lines[n]} ${names[n + 1]} ${files[n + 1]}\n`);
  };
  /* nice [-n N] COMMAND …: the command is run.
     timeout [OPTIONS] DURATION COMMAND …: the command is run, and stopped when the time is up – status 124 (137
     with -s KILL, 128 + the signal with --preserve-status). What the page carries out itself is stopped at once:
     sleep, a loop, a script, bash -c. A program that is running cannot be stopped from outside without losing the
     files in the programs' memory: it runs to its end, and if that took longer than the limit the status is 124
     all the same, with a note. (DURATION 0: no limit.) */
  const SIGNUM = { HUP: 1, INT: 2, QUIT: 3, KILL: 9, USR1: 10, USR2: 12, PIPE: 13, ALRM: 14, TERM: 15, STOP: 19, CONT: 18 };
  const wrapper = (skip, taken) => async (ctx) => {
    const args = ctx.args.slice();
    let signal = 'TERM', preserve = false, verbose = false, modes = 0;
    while (args.length && /^-./.test(args[0])) {
      const a = args.shift();
      if (a === '--') break;
      let value = null;
      if (skip.test(a)) {
        if (!args.length) throw userErr(`${ctx.name}: option ${a.startsWith('--') ? `'${a}' requires an argument` : `requires an argument -- '${a[1]}'`}\nTry '${ctx.name} --help' for more information.`, 125);
        value = args.shift();
      } else if (!taken.test(a)) throw MG.shellUtil.refuseOption(ctx.name, a, 125);
      if (ctx.name === 'stdbuf') {
        // -o L (a line at a time), -o 0 (at once), -o 64K (so much at a time); the same for -e, and for -i without L
        const m = /^(?:-([ioe])|--(input|output|error)=?)([\s\S]*)$/.exec(a);
        const mode = m ? (m[3] !== '' ? m[3] : value) : null;
        if (m && !/^(L|0|[1-9]\d*(?:[KMGTPEZY]i?B?|[kmgtpezy]B?|B)?)$/.test(String(mode))) throw userErr(`stdbuf: invalid mode \u2018${mode}\u2019`, 125);
        if (m && mode === 'L' && (m[1] || m[2][0]) === 'i') throw userErr("stdbuf: line buffering stdin is meaningless\nTry 'stdbuf --help' for more information.", 125);
        if (m) modes++;
      }
      if (ctx.name === 'timeout') {
        const m = /^(?:-s|--signal=?)(.*)$/.exec(a);
        if (m) {
          const s = String(m[1] || value || '').replace(/^SIG/i, '').toUpperCase();
          if (!(s in SIGNUM) && !/^\d+$/.test(s)) throw userErr(`timeout: ${m[1] || value}: invalid signal\nTry 'timeout --help' for more information.`, 125);
          signal = /^\d+$/.test(s) ? Object.keys(SIGNUM).find((k) => SIGNUM[k] === +s) || s : s;
        } else if (a === '--preserve-status') preserve = true;
        else if (a === '-v' || a === '--verbose') verbose = true;
      }
    }
    let secs = 0;
    if (ctx.name === 'timeout') {
      // (with no duration, or no command: only the pointer to --help, as GNU timeout prints it)
      if (args.length < 2) throw userErr("Try 'timeout --help' for more information.", 125);
      const m = /^(\d+\.?\d*|\.\d+)((?:e[-+]?\d+)?)([smhd]?)$/i.exec(args[0]);
      if (!m) throw userErr(`timeout: invalid time interval \u2018${args[0]}\u2019\nTry 'timeout --help' for more information.`, 125);
      secs = parseFloat(m[1] + m[2]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[3].toLowerCase()];
      args.shift();
    }
    if (!args.length) {
      if (ctx.name === 'nice') return ctx.out('0\n');
      throw userErr(`${ctx.name}: missing operand\nTry '${ctx.name} --help' for more information.`, 125);
    }
    if (ctx.name === 'stdbuf' && !modes) throw userErr("stdbuf: you must specify a buffering mode option\nTry 'stdbuf --help' for more information.", 125);
    // (timeout and nice are programs: they run programs, not the functions of the shell)
    if (!MG.shellBuiltins[args[0]] && !MG.shellTools[args[0]] && !args[0].includes('/') && !ctx.shell.onPath(args[0], ctx.env, true)) {
      ctx.err(ctx.name === 'timeout' || ctx.name === 'stdbuf' ? `${ctx.name}: failed to run command \u2018${args[0]}\u2019: No such file or directory\n` : `${ctx.name}: \u2018${args[0]}\u2019: No such file or directory\n`);
      return 127;
    }
    // the command stands where timeout or nice stood: it has its input, its redirection and its place in the pipe
    if (ctx.name !== 'timeout' || !(secs > 0)) return ctx.shell.runAs(ctx, args);
    const sh = ctx.shell, limit = { at: Date.now() + secs * 1000, id: {} }, t0 = Date.now(), name = args[0];
    (sh._deadlines = sh._deadlines || []).push(limit);
    let code = 0, out = false;
    try {
      code = await sh.runAs(ctx, args);
    } catch (c) {
      if (!(c && c.shellControl && c.kind === 'timeout' && c.id === limit.id)) throw c;
      out = true;
    } finally {
      sh._deadlines.splice(sh._deadlines.indexOf(limit), 1);
    }
    if (!out && Date.now() >= limit.at) {
      out = true;
      ctx.io.note(`timeout: ${name} took ${((Date.now() - t0) / 1000).toFixed(1)} s, longer than the ${secs} s it was given. A program that is running cannot be stopped from outside in this terminal, so it ran to its end – what it wrote is complete. The status is the one a timeout gives.`);
    }
    if (!out) return code;
    if (verbose) ctx.err(`timeout: sending signal ${signal} to command \u2018${name}\u2019\n`);
    return signal === 'KILL' ? 137 : preserve ? 128 + (SIGNUM[signal] || 15) : 124;
  };
  // timeout [-s SIGNAL] [-k DURATION] [--foreground] [--preserve-status] [-v] DURATION COMMAND …;  nice [-n N] COMMAND …
  B.timeout = wrapper(/^(-s|-k|--signal|--kill-after)$/, /^(--signal=.+|--kill-after=.+|-s.+|-k.+|--foreground|--preserve-status|-v|--verbose)$/);
  B.nice = wrapper(/^(-n|--adjustment)$/, /^(--adjustment=-?\d+|-n-?\d+|-\d+)$/);
  // stdbuf -oL COMMAND …: the command is run (how a program gathers its output before writing makes no difference here)
  B.stdbuf = wrapper(/^(-i|-o|-e|--input|--output|--error)$/, /^(--input=.+|--output=.+|--error=.+|-[ioe].+)$/);
  // tty [-s]: the terminal that the input comes from – or "not a tty" (status 1) when it is a file or a pipe
  B.tty = (ctx) => {
    let silent = false;
    for (const a of ctx.args) {
      if (a === '-s' || a === '--silent' || a === '--quiet') silent = true;
      else if (/^-./.test(a)) throw MG.shellUtil.refuseOption('tty', a, 2);
      else throw userErr(`tty: extra operand \u2018${a}\u2019\nTry 'tty --help' for more information.`, 2);
    }
    const is = ttyOf(ctx)(0);
    if (!silent) ctx.out(is ? '/dev/pts/0\n' : 'not a tty\n');
    return is ? 0 : 1;
  };
  // sync: what was written is on the disk – here there is nothing to wait for
  B.sync = (ctx) => {
    let code = 0;
    for (const a of ctx.args) {
      if (/^(-d|--data|-f|--file-system)$/.test(a)) continue;
      if (/^-./.test(a)) throw MG.shellUtil.refuseOption('sync', a);
      if (!ctx.fs.exists(a)) {
        ctx.err(`sync: error opening '${a}': No such file or directory\n`);
        code = 1;
      }
    }
    return code;
  };
  B.logname = (ctx) => {
    const a = ctx.args[0];
    if (a != null) throw /^-./.test(a) ? MG.shellUtil.refuseOption('logname', a) : userErr(`logname: extra operand \u2018${a}\u2019\nTry 'logname --help' for more information.`);
    return ctx.out('student\n');
  };
  B.groups = (ctx) => {
    const names = ctx.args.filter((a) => !/^-./.test(a));
    const bad = ctx.args.find((a) => /^-./.test(a));
    if (bad) throw MG.shellUtil.refuseOption('groups', bad);
    if (!names.length) return ctx.out('student\n');
    let code = 0;
    for (const n of names) {
      if (n === 'student' || n === 'root') ctx.out(`${n} : ${n}\n`);
      else {
        ctx.err(`groups: \u2018${n}\u2019: no such user\n`);
        code = 1;
      }
    }
    return code;
  };
  /* locale: the language settings as the programs see them – LANG, LC_ALL and the LC_ variables that are exported.
     locale -a: the settings that exist here.  locale charmap: the encoding (UTF-8; plain ASCII with C or POSIX). */
  B.locale = (ctx) => {
    const st = stOf(ctx);
    const get = (k) => (typeof ctx.env[k] === 'string' && (!st.exported || st.exported.has(k)) && ctx.env[k] !== '' ? ctx.env[k] : null);
    const CATS = ['CTYPE', 'NUMERIC', 'TIME', 'COLLATE', 'MONETARY', 'MESSAGES', 'PAPER', 'NAME', 'ADDRESS', 'TELEPHONE', 'MEASUREMENT', 'IDENTIFICATION'];
    const of = (cat) => get('LC_ALL') || get('LC_' + cat) || get('LANG') || 'POSIX';
    const a = ctx.args[0];
    if (a === '-a' || a === '--all-locales') return ctx.out('C\nC.utf8\nPOSIX\n');
    if (a === '-m' || a === '--charmaps') return ctx.out('ANSI_X3.4-1968\nUTF-8\n');
    if (a != null && /^-./.test(a)) throw MG.shellUtil.refuseOption('locale', a);
    if (a != null) {
      let code = 0;
      for (const w of ctx.args) {
        if (w === 'charmap') ctx.out(/utf-?8/i.test(of('CTYPE')) ? 'UTF-8\n' : 'ANSI_X3.4-1968\n');
        else {
          ctx.err(`locale: unknown name "${w}"\n`);
          code = 1;
        }
      }
      return code;
    }
    const all = get('LC_ALL');
    let text = `LANG=${get('LANG') || ''}\nLANGUAGE=${get('LANGUAGE') || ''}\n`;
    for (const c of CATS) text += !all && get('LC_' + c) ? `LC_${c}=${get('LC_' + c)}\n` : `LC_${c}="${of(c)}"\n`;
    return ctx.out(text + `LC_ALL=${all || ''}\n`);
  };
  /* getopt – without an s at the end: the program of util-linux, not the shell's own getopts. Scripts use it to
     read long options:
         OPTS=$(getopt -o hi:o: --long help,input:,output: -n "$0" -- "$@") || exit 2
         eval set -- "$OPTS"
     It prints the options in order – each a word of its own, the values in quotes –, then --, then the other words.
     getoptScan is one pass of the C library's getopt_long() over the words, as glibc does it:
       → out: { c, value, takes } | { long, value } | { plain } | { bad: the message, or null }   rest: the other words */
  function getoptScan(args, optstr, longs, o) {
    let order = 'permute';
    if (optstr[0] === '-' || optstr[0] === '+') {
      order = optstr[0] === '-' ? 'inorder' : 'require';
      optstr = optstr.slice(1);
    } else if (o.posixly) order = 'require';
    const say = optstr[0] !== ':' && !o.quiet;
    const out = [], rest = [], n = args.length;
    const bad = (m) => out.push({ bad: say ? m : null });
    // a letter: null – not an option, 0 – takes nothing, 1 – takes a value, 2 – may have one glued to it
    const kindOf = (c) => {
      const k = c === ':' || c === ';' ? -1 : optstr.indexOf(c);
      return k < 0 ? null : optstr[k + 1] !== ':' ? 0 : optstr[k + 2] === ':' ? 2 : 1;
    };
    let i = 0;
    // --name, --name=value, --na (the start of a name)   → false: not a long option after all (-a: try the letters)
    const long = (text, dash, only) => {
      const eq = text.indexOf('='), name = eq < 0 ? text : text.slice(0, eq);
      let hit = longs.find((l) => l.name === name);
      if (!hit) {
        const hits = longs.filter((l) => l.name.startsWith(name));
        // (the C library's rule: a second name that starts alike makes it ambiguous if anything tells the two apart)
        const others = hits.slice(1).filter((l) => only || l.arg !== hits[0].arg || l.val !== hits[0].val);
        if (others.length) {
          bad(`option '${dash}${text}' is ambiguous; possibilities:${[hits[0]].concat(others).map((l) => ` '${dash}${l.name}'`).join('')}`);
          i++;
          return true;
        }
        hit = hits[0];
      }
      if (!hit) {
        if (only && dash === '-' && optstr.includes(text[0])) return false;
        bad(`unrecognized option '${dash}${text}'`);
        i++;
        return true;
      }
      i++;
      let value = null;
      if (eq >= 0) {
        if (!hit.arg) {
          bad(`option '${dash}${hit.name}' doesn't allow an argument`);
          return true;
        }
        value = text.slice(eq + 1);
      } else if (hit.arg === 1) {
        if (i >= n) {
          bad(`option '${dash}${hit.name}' requires an argument`);
          return true;
        }
        value = args[i++];
      }
      out.push({ long: hit, value });
      return true;
    };
    while (i < n) {
      const a = args[i];
      if (a === '--') {
        i++;
        break;
      }
      if (a[0] !== '-' || a.length === 1) {
        if (order === 'require') break;
        if (order === 'inorder') out.push({ plain: a });
        else rest.push(a);
        i++;
        continue;
      }
      if (a[1] === '-') {
        long(a.slice(2), '--', o.only);
        continue;
      }
      if (o.only && (a.length > 2 || !optstr.includes(a[1])) && long(a.slice(1), '-', true)) continue;
      i++;
      for (let k = 1; k < a.length; k++) {
        const c = a[k], kind = kindOf(c);
        if (kind == null) bad(`invalid option -- '${c}'`);
        else if (kind === 0) out.push({ c });
        else {
          const glued = a.slice(k + 1);
          if (glued !== '') out.push({ c, value: glued, takes: true });
          else if (kind === 2) out.push({ c, value: null, takes: true });
          else if (i < n) out.push({ c, value: args[i++], takes: true });
          else bad(`option requires an argument -- '${c}'`);
          break;
        }
      }
    }
    return { out, rest: rest.concat(args.slice(i)) };
  }
  const GETOPT_OWN = [['options', 1, 'o'], ['longoptions', 1, 'l'], ['quiet', 0, 'q'], ['quiet-output', 0, 'Q'], ['shell', 1, 's'], ['test', 0, 'T'], ['unquoted', 0, 'u'], ['help', 0, 'h'], ['alternative', 0, 'a'], ['name', 1, 'n'], ['version', 0, 'V']].map(([name, arg, val]) => ({ name, arg, val }));
  B.getopt = (ctx) => {
    const st = stOf(ctx);
    const inEnv = (k) => typeof ctx.env[k] === 'string' && (!st.exported || st.exported.has(k));
    const refuse = (m) => userErr((m ? `getopt: ${m}\n` : '') + "Try 'getopt --help' for more information.", 2);
    const args = ctx.args.slice(), posixly = inEnv('POSIXLY_CORRECT'), compatible = inEnv('GETOPT_COMPATIBLE');
    const C = { quote: true, quiet: false, silent: false, tcsh: false, only: false, name: 'getopt' };
    const longs = [];
    let optstr = null, words;
    if (!args.length) {
      if (compatible) return ctx.out(' --\n');
      throw refuse('missing optstring argument');
    }
    if (args[0][0] !== '-' || compatible) {
      // getopt OPTSTRING WORDS…: as the getopt of old – the letters only, and no quotes in what is printed
      C.quote = false;
      optstr = args[0].replace(/^[-+]+/, '');
      words = args.slice(1);
    } else {
      const own = getoptScan(args, '+ao:l:n:qQs:TuhV', GETOPT_OWN, { posixly });
      for (const x of own.out) {
        if ('bad' in x) throw refuse(x.bad);
        const k = x.long ? x.long.val : x.c, v = x.value;
        if (k === 'a') C.only = true;
        else if (k === 'h') return ctx.out((MG.shellHelp && MG.shellHelp('getopt')) || '');
        else if (k === 'V') return ctx.out((MG.shellHelp && MG.shellHelp('getopt', true)) || '');
        else if (k === 'T') return 4;
        else if (k === 'o') optstr = v;
        else if (k === 'n') C.name = v;
        else if (k === 'q') C.quiet = true;
        else if (k === 'Q') C.silent = true;
        else if (k === 'u') C.quote = false;
        else if (k === 's') {
          if (!/^(bash|sh|tcsh|csh)$/.test(v)) throw refuse('unknown shell after -s or --shell argument');
          C.tcsh = /csh$/.test(v);
        } else if (k === 'l') {
          // NAME, NAME: (takes a value), NAME:: (may have one: --NAME=VALUE) – with commas or blanks between them
          for (const t of v.split(/[, \t\n]+/).filter(Boolean)) {
            const arg = t.endsWith('::') ? 2 : t.endsWith(':') ? 1 : 0, name = arg ? t.slice(0, -arg) : t;
            if (arg && name === '') throw refuse('empty long option after -l or --long argument');
            longs.push({ name, arg, val: longs.length });
          }
        }
      }
      words = own.rest;
      if (optstr == null) {
        if (!words.length) throw refuse('missing optstring argument');
        optstr = words.shift();
      }
    }
    const R = getoptScan(words, optstr, longs, { posixly, only: C.only, quiet: C.quiet });
    // a word in quotes, as the shell reads it back (eval set -- "$OPTS")
    const q = (s) => {
      if (!C.quote) return ' ' + s;
      let t = '';
      for (const ch of s) t += C.tcsh && ch === '\\' ? '\\\\' : C.tcsh && ch === '!' ? "'\\!'" : C.tcsh && ch === '\n' ? '\\n' : C.tcsh && /\s/.test(ch) ? "'\\" + ch + "'" : ch === "'" ? "'\\''" : ch;
      return " '" + t + "'";
    };
    let code = 0, line = '';
    for (const x of R.out) {
      if ('bad' in x) {
        code = 1;
        if (x.bad) ctx.err(`${C.name}: ${x.bad}\n`);
      } else if (x.plain != null) line += q(x.plain);
      else if (x.long) line += ' --' + x.long.name + (x.long.arg ? q(x.value != null ? x.value : '') : '');
      else line += ' -' + x.c + (x.takes ? q(x.value != null ? x.value : '') : '');
    }
    if (!C.silent) ctx.out(line + ' --' + R.rest.map(q).join('') + '\n');
    return code;
  };
  /* getopts OPTSTRING NAME [ARG …]: the next option of the arguments of the script or the function.
     OPTIND is the number of the argument that comes next, OPTARG the value of an option that takes one. */
  B.getopts = (ctx) => {
    const st = stOf(ctx);
    if (ctx.args.length < 2) throw userErr('getopts: usage: getopts optstring name [arg ...]', 2);
    const spec = ctx.args[0], name = ctx.args[1], args = ctx.args.length > 2 ? ctx.args.slice(2) : st.args;
    const quiet = spec[0] === ':';
    // (OPTERR=0: no messages – but the name is still set to ?, not as with a : at the start of the letters)
    const mute = String(st.vars.OPTERR) === '0';
    const set = (k, v) => ctx.shell._set(k, v, st);
    let ind = parseInt(st.vars.OPTIND, 10) || 1;
    // (where it is inside a word like -abc; OPTIND=1 by the script starts afresh)
    let pos = st.optAt && st.optAt.ind === ind ? st.optAt.pos : 0;
    const end = () => {
      set(name, '?');
      delete st.vars.OPTARG;
      // (OPTIND is never left beyond the end of the arguments)
      set('OPTIND', String(Math.min(ind, args.length + 1)));
      st.optAt = null;
      return 1;
    };
    const arg = args[ind - 1];
    if (pos === 0) {
      if (arg === undefined || arg === '-' || arg[0] !== '-') return end();
      if (arg === '--') {
        ind++;
        return end();
      }
      pos = 1;
    }
    const c = arg[pos++];
    const last = pos >= arg.length;
    const k = c === ':' || c === '?' ? -1 : spec.indexOf(c, quiet ? 1 : 0);
    delete st.vars.OPTARG;
    if (k < 0) {
      // not an option of this script
      if (quiet) set('OPTARG', c);
      else if (!mute) ctx.err(`${st.name || 'bash'}: illegal option -- ${c}\n`);
      set(name, '?');
      if (last) {
        ind++;
        pos = 0;
      }
    } else if (spec[k + 1] === ':') {
      // it takes a value: the rest of this word, or the next word
      if (!last) {
        set('OPTARG', arg.slice(pos));
        set(name, c);
        ind++;
      } else if (args[ind] !== undefined) {
        set('OPTARG', args[ind]);
        set(name, c);
        ind += 2;
      } else {
        ind++;
        if (quiet) {
          set(name, ':');
          set('OPTARG', c);
        } else {
          if (!mute) ctx.err(`${st.name || 'bash'}: option requires an argument -- ${c}\n`);
          set(name, '?');
        }
      }
      pos = 0;
    } else {
      set(name, c);
      if (last) {
        ind++;
        pos = 0;
      }
    }
    set('OPTIND', String(ind));
    st.optAt = pos ? { ind, pos } : null;
    return 0;
  };
  /* hash [-r] [-d] [-t] [-l] [-p PATH] [NAME …]: the table in which bash keeps where the programs are. Scripts use
     it to ask whether a program is there:  hash samtools 2> /dev/null || die "samtools is missing"  – status 1 and
     "hash: NAME: not found" for a name that is no program on PATH. (A function, a command of the shell itself and
     a name with a slash are passed over, as in bash.) */
  B.hash = (ctx) => {
    const sh = ctx.shell, st = stOf(ctx), T = st.hashed || (st.hashed = new Map());
    const args = ctx.args.slice();
    let mode = null, cleared = false;
    while (args.length && /^-./.test(args[0])) {
      const a = args.shift();
      if (a === '--') break;
      for (const c of a.slice(1)) {
        if (c === 'r') {
          T.clear();
          cleared = true;
        } else if (c === 'd' || c === 't' || c === 'l') mode = c;
        else if (c === 'p') {
          // hash -p PATH NAME: PATH is where NAME is, from now on
          if (args.length < 2) throw userErr('bash: hash: -p: option requires an argument\nhash: usage: hash [-lr] [-p pathname] [-dt] [name ...]', 2);
          const p = args.shift();
          args.forEach((n) => T.set(n, p));
          return 0;
        } else throw userErr(`bash: hash: -${c}: invalid option\nhash: usage: hash [-lr] [-p pathname] [-dt] [name ...]`, 2);
      }
    }
    const where = (c) => ctx.shell.onPath(c, ctx.env) || ((MG.shellTools[c] || (MG.shellBuiltins[c] && !SHELL_WORDS.includes(c))) && ctx.shell.sysPath(ctx.env) ? ctx.shell.programPath(c) : null);
    if (!args.length) {
      if (cleared) return 0;
      if (!T.size) {
        ctx.out('hash: hash table empty\n');
        return 0;
      }
      if (mode === 'l') T.forEach((p, n) => ctx.out(`builtin hash -p ${p} ${n}\n`));
      else ctx.out('hits\tcommand\n' + Array.from(T.values(), (p) => `   1\t${p}\n`).join(''));
      return 0;
    }
    let code = 0;
    for (const n of args) {
      if (mode === 'd') {
        if (!T.delete(n)) {
          ctx.err(`bash: hash: ${n}: not found\n`);
          code = 1;
        }
        continue;
      }
      // (a name with a slash, a function, a command of the shell itself: nothing to look up)
      if (mode !== 't' && (n.includes('/') || st.funcs[n] || (SHELL_WORDS.includes(n) && MG.shellBuiltins[n]))) continue;
      const p = T.get(n) || where(n);
      if (!p) {
        ctx.err(`bash: hash: ${n}: not found\n`);
        code = 1;
      } else if (mode === 't') ctx.out(args.length > 1 ? `${n}\t${p}\n` : `${p}\n`);
      else T.set(n, p);
    }
    return code;
  };
  B.wait = () => 0;
  B.which = (ctx) => {
    let code = 0;
    // which [-a] [-s] NAME …
    const bad = ctx.args.find((a) => /^-./.test(a) && !/^-[as]+$/.test(a));
    if (bad) throw userErr(`Illegal option ${bad.startsWith('--') ? '--' : '-' + (/[^as]/.exec(bad.slice(1)) || ['?'])[0]}\nUsage: /usr/bin/which [-as] args`, 2);
    const silent = ctx.args.some((a) => /^-[as]*s[as]*$/.test(a));
    const where = (c) => {
      if (c.includes('/')) {
        const e = ctx.fs.get(c);
        return e && e.kind !== 'dir' && e.mode === 'x' ? c : null;
      }
      return ctx.shell.onPath(c, ctx.env, true) || ((MG.shellTools[c] || MG.shellBuiltins[c]) && ctx.shell.sysPath(ctx.env) ? ctx.shell.programPath(c) : null);
    };
    if (silent) return ctx.args.filter((a) => !a.startsWith('-')).every(where) ? 0 : 1;
    ctx.args.filter((a) => !a.startsWith('-')).forEach((c) => {
      const p = where(c);
      if (p) ctx.out(`${p}\n`);
      else code = 1;
    });
    return code;
  };
  /* type [-t] [-p] [-P] [-a] NAME…: what a name is. -t: one word (keyword, function, builtin, file); -p, -P: the path of a program */
  B.type = (ctx) => {
    let code = 0, short = false, path = false;
    const names = [];
    ctx.args.forEach((a) => {
      if (/^-[tpPaf]+$/.test(a) && !names.length) {
        if (a.includes('t')) short = true;
        if (/[pP]/.test(a)) path = true;
      } else names.push(a);
    });
    names.forEach((c) => {
      const k = kindOf(ctx, c);
      if (!k) {
        if (!short && !path) ctx.err(`bash: type: ${c}: not found\n`);
        code = 1;
      } else if (path) {
        if (k.kind === 'file') ctx.out(k.path + '\n');
        else if (!ctx.args.some((a) => /^-[a-zA-Z]*P/.test(a))) return;
        else code = 1;
      } else if (short) ctx.out(k.kind + '\n');
      else ctx.out(describe(c, k) + '\n');
    });
    return code;
  };
  B.let = async (ctx) => {
    const st = stOf(ctx);
    let v = 0;
    try {
      for (const a of ctx.args) v = await ctx.shell._arith(a, st, ctx.io);
    } catch (e) {
      // (a mistake in the expression: let fails, the line goes on)
      if (!e || !e.arith) throw e;
      ctx.err(`bash: let: ${e.message}\n`);
      return 1;
    }
    return v !== 0 ? 0 : 1;
  };
  /* expr: each argument is one token.  | &  = != < <= > >=  + -  * / %  STRING : REGEX,
     match STRING REGEX, substr STRING POS LENGTH, index STRING CHARS, length STRING, ( ).
     Status 0 if the result is neither empty nor 0, 1 if it is, 2 for a mistake in the expression. */
  B.expr = (ctx) => {
    const a = ctx.args;
    let k = 0;
    const bad = (msg) => userErr(`expr: ${msg}`, 2);
    if (!a.length) throw bad("missing operand\nTry 'expr --help' for more information.");
    // (whole numbers of any size, as in GNU expr)
    const isInt = (x) => /^-?\d+$/.test(x);
    const int = (x) => {
      if (!isInt(x)) throw bad('non-integer argument');
      return BigInt(x);
    };
    // STRING : REGEX – a basic regular expression (\( \) are groups, a + or ? is itself), tied to the start
    const match = (str, r) => {
      let m;
      try {
        m = posixExec(r, str, 'y', true);
      } catch (e) {
        throw bad(e.message);
      }
      const grouped = /\\\(/.test(r);
      return m ? (grouped ? m[1] || '' : String(Array.from(m[0]).length)) : grouped ? '' : '0';
    };
    const truthy = (x) => x !== '' && !(isInt(x) && BigInt(x) === 0n);
    const prim = () => {
      if (k >= a.length) throw bad('syntax error: missing argument after ‘' + a[a.length - 1] + '’');
      const w = a[k++];
      if (w === '(') {
        const v = or();
        if (a[k++] !== ')') throw bad("syntax error: expecting ‘)’ after ‘" + (a[k - 2] || '') + "’");
        return v;
      }
      const need = (n) => {
        if (k + n > a.length) throw bad('syntax error: missing argument after ‘' + a[a.length - 1] + '’');
      };
      if (w === 'length' && k < a.length) return String(a[k++].length);
      if (w === 'match' && k < a.length) {
        need(2);
        k += 2;
        return match(a[k - 2], a[k - 1]);
      }
      if (w === 'index' && k < a.length) {
        need(2);
        k += 2;
        const at = Array.from(a[k - 2]).findIndex((ch) => a[k - 1].includes(ch));
        return String(at + 1);
      }
      if (w === 'substr' && k < a.length) {
        need(3);
        k += 3;
        const pos = isInt(a[k - 2]) ? parseInt(a[k - 2], 10) : 0, len = isInt(a[k - 1]) ? parseInt(a[k - 1], 10) : 0;
        return pos <= 0 || len <= 0 ? '' : a[k - 3].substr(pos - 1, len);
      }
      if (w === '+' && k < a.length) return a[k++]; // + TOKEN: the token as a text, even if it is a keyword
      return w;
    };
    const colon = () => {
      let v = prim();
      while (a[k] === ':') {
        k++;
        v = match(v, prim());
      }
      return v;
    };
    const mul = () => {
      let v = colon();
      while (a[k] === '*' || a[k] === '/' || a[k] === '%') {
        const op = a[k++], r = int(colon()), l = int(v);
        if (op !== '*' && r === 0n) throw bad('division by zero');
        v = String(op === '*' ? l * r : op === '/' ? l / r : l % r);
      }
      return v;
    };
    const add = () => {
      let v = mul();
      while (a[k] === '+' || a[k] === '-') {
        const op = a[k++], r = int(mul()), l = int(v);
        v = String(op === '+' ? l + r : l - r);
      }
      return v;
    };
    const cmp = () => {
      let v = add();
      while (/^(=|==|!=|<|<=|>|>=)$/.test(a[k] || '')) {
        const op = a[k++], r = add();
        const c = isInt(v) && isInt(r) ? (BigInt(v) < BigInt(r) ? -1 : BigInt(v) > BigInt(r) ? 1 : 0) : v < r ? -1 : v > r ? 1 : 0;
        v = (op === '=' || op === '==' ? c === 0 : op === '!=' ? c !== 0 : op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0) ? '1' : '0';
      }
      return v;
    };
    const and = () => {
      let v = cmp();
      while (a[k] === '&') {
        k++;
        const r = cmp();
        v = truthy(v) && truthy(r) ? v : '0';
      }
      return v;
    };
    const or = () => {
      let v = and();
      while (a[k] === '|') {
        k++;
        const r = and();
        v = truthy(v) ? v : truthy(r) ? r : '0';
      }
      return v;
    };
    const v = or();
    if (k < a.length) throw bad('syntax error: unexpected argument ‘' + a[k] + '’');
    ctx.out(v + '\n');
    return truthy(v) ? 0 : 1;
  };
  B.echo = (ctx) => {
    const args = ctx.args.slice();
    let nl = true, esc = false;
    while (args.length && /^-[neE]+$/.test(args[0])) {
      // (the letters count in the order they stand: -Ee ends with e)
      for (const c of args.shift().slice(1)) {
        if (c === 'n') nl = false;
        else esc = c === 'e';
      }
    }
    let s = args.join(' ');
    if (esc) {
      // (echo -e: \0NNN is a character by its octal number – \NNN is not, unlike in printf –, \xHH, \uHHHH; \c ends the output)
      let out = '', stop = false;
      for (let i = 0; i < s.length && !stop; i++) {
        if (s[i] !== '\\' || i + 1 >= s.length) {
          out += s[i];
          continue;
        }
        const c = s[i + 1];
        const simple = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\' }[c];
        let m;
        if (simple !== undefined) {
          out += simple;
          i++;
        } else if (c === 'c') {
          stop = true;
          nl = false;
        } else if (c === '0' && (m = /^0[0-7]{0,3}/.exec(s.slice(i + 1)))) {
          out += rawByte(parseInt(m[0], 8));
          i += m[0].length;
        } else if (c === 'x' && (m = /^x[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1)))) {
          out += rawByte(parseInt(m[0].slice(1), 16));
          i += m[0].length;
        } else if ((c === 'u' && (m = /^u[0-9a-fA-F]{1,4}/.exec(s.slice(i + 1)))) || (c === 'U' && (m = /^U[0-9a-fA-F]{1,8}/.exec(s.slice(i + 1))))) {
          out += String.fromCodePoint(parseInt(m[0].slice(1), 16));
          i += m[0].length;
        } else out += '\\';
      }
      s = settleRaw(out);
    }
    ctx.out(rawOut(s + (nl ? '\n' : '')));
    return 0;
  };
  /* ------------------------------------------------------------------
     printf – as bash's own (builtins/printf.def): the format is used again while arguments are left; widths and
     precisions count bytes; whole numbers are 64 bits; numbers with a point are C's "long double" (a binary number
     of 64 bits), so '%.1f' 99.95 is 99.9 and '%.20f' 0.1 ends in …0000000000001.
     ------------------------------------------------------------------ */
  const I64_MAX = 2n ** 63n - 1n, I64_MIN = -(2n ** 63n), U64_MAX = 2n ** 64n - 1n;
  /** a text with every byte as one character (a byte over 127 as a raw byte: see settleRaw) */
  function byteStr(s) {
    // eslint-disable-next-line no-control-regex
    if (/^[\x00-\x7f]*$/.test(s)) return s;
    let out = '';
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c < 0x80 || (c >= 0xdc80 && c <= 0xdcff)) out += ch;
      else for (const b of UTF8.encode(ch)) out += String.fromCharCode(0xdc00 + b);
    }
    return out;
  }
  /** C's strtoimax / strtoumax (TEXT, base 0) → { v, end: how far the number went, range: too large for 64 bits } */
  function cInteger(a, unsigned) {
    const m = /^[ \t\n\v\f\r]*([-+]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/.exec(a);
    if (!m) return { v: 0n, end: 0 };
    let v = /^0[xX]/.test(m[2]) ? BigInt(m[2]) : m[2].length > 1 && m[2][0] === '0' ? BigInt('0o' + m[2].slice(1)) : BigInt(m[2]);
    let range = false;
    if (unsigned) {
      if (v > U64_MAX) {
        v = U64_MAX;
        range = true;
      } else if (m[1] === '-' && v !== 0n) v = U64_MAX + 1n - v;
    } else {
      if (m[1] === '-') v = -v;
      if (v > I64_MAX) {
        v = I64_MAX;
        range = true;
      } else if (v < I64_MIN) {
        v = I64_MIN;
        range = true;
      }
    }
    return { v, end: m[0].length, range };
  }
  const bitLen = (x) => (x === 0n ? 0 : x.toString(2).length);
  /** N / D rounded to a whole number, a half to the even one */
  function roundDiv(N, D) {
    let q = N / D;
    const r2 = (N % D) * 2n;
    if (r2 > D || (r2 === D && (q & 1n) === 1n)) q += 1n;
    return q;
  }
  /** the "long double" nearest to N / D: m × 2^e with m of 64 bits → { m, e } | { inf: true } | { m: 0n, under: true } */
  function toLongDouble(N, D) {
    if (N === 0n) return { m: 0n, e: 0 };
    let k = 64 - (bitLen(N) - bitLen(D));
    const scaled = (kk) => (kk >= 0 ? [N << BigInt(kk), D] : [N, D << BigInt(-kk)]);
    let [n, d] = scaled(k);
    let q = n / d;
    while (q >= 2n ** 64n) [n, d] = scaled(--k), (q = n / d);
    while (q < 2n ** 63n) [n, d] = scaled(++k), (q = n / d);
    if (k > 16445) {
      // smaller than the smallest ordinary number: fewer bits
      k = 16445;
      [n, d] = scaled(k);
    }
    q = roundDiv(n, d);
    if (q === 2n ** 64n) {
      q = 2n ** 63n;
      k--;
    }
    if (q === 0n) return { m: 0n, e: 0, under: true };
    if (-k > 16320) return { inf: true };
    return { m: q, e: -k };
  }
  /** C's strtold → { kind: 'num' | 'inf' | 'nan', neg, m, e, end, range } (end 0: no number there) */
  function cFloat(a) {
    const lead = /^[ \t\n\v\f\r]*([-+]?)/.exec(a);
    const neg = lead[1] === '-', rest = a.slice(lead[0].length);
    let m;
    if ((m = /^(?:infinity|inf)/i.exec(rest))) return { kind: 'inf', neg, end: lead[0].length + m[0].length };
    if ((m = /^nan(?:\([A-Za-z0-9_]*\))?/i.exec(rest))) return { kind: 'nan', neg, end: lead[0].length + m[0].length };
    let N, D, len;
    if ((m = /^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([-+]?\d+))?/.exec(rest)) && (m[1] || m[2])) {
      const frac = m[2] || '', p = (m[3] ? parseInt(m[3], 10) : 0) - 4 * frac.length;
      if (Math.abs(p) > 40000) return /^0*$/.test(m[1] + frac) ? { kind: 'num', neg, m: 0n, e: 0, end: lead[0].length + m[0].length } : p > 0 ? { kind: 'inf', neg, end: lead[0].length + m[0].length, range: true } : { kind: 'num', neg, m: 0n, e: 0, end: lead[0].length + m[0].length, range: true };
      N = BigInt('0x' + (m[1] + frac || '0'));
      D = 1n;
      if (p >= 0) N <<= BigInt(p);
      else D <<= BigInt(-p);
      len = m[0].length;
    } else if ((m = /^(\d*)(?:\.(\d*))?(?:[eE]([-+]?\d+))?/.exec(rest)) && (m[1] || m[2])) {
      const frac = m[2] || '', digits = (m[1] + frac).replace(/^0+(?=.)/, ''), x = (m[3] ? parseInt(m[3], 10) : 0) - frac.length;
      len = m[0].length;
      const end = lead[0].length + len;
      if (/^0*$/.test(digits)) return { kind: 'num', neg, m: 0n, e: 0, end };
      // (far beyond what a long double holds: 1e5000 is infinite, 1e-5000 is 0 – and bash warns)
      if (digits.length + x > 5000) return { kind: 'inf', neg, end, range: true };
      if (digits.length + x < -5000) return { kind: 'num', neg, m: 0n, e: 0, end, range: true };
      N = BigInt(digits);
      D = 1n;
      if (x >= 0) N *= 10n ** BigInt(x);
      else D = 10n ** BigInt(-x);
    } else if (/^0[xX]/.test(rest)) return { kind: 'num', neg, m: 0n, e: 0, end: lead[0].length + 1 }; // 0x and no digit: the 0
    else return { kind: 'num', neg, m: 0n, e: 0, end: 0 };
    const end = lead[0].length + len;
    const ld = toLongDouble(N, D);
    if (ld.inf) return { kind: 'inf', neg, end, range: true };
    return { kind: 'num', neg, m: ld.m, e: ld.e, end, range: !!ld.under };
  }
  /** m × 2^e as a fraction */
  const ldFraction = (x) => (x.e >= 0 ? [x.m << BigInt(x.e), 1n] : [x.m, 1n << BigInt(-x.e)]);
  /** N / D with p digits after the point */
  function fixedDigits(N, D, p) {
    let s = roundDiv(N * 10n ** BigInt(p), D).toString();
    if (p > 0) {
      s = s.padStart(p + 1, '0');
      s = s.slice(0, -p) + '.' + s.slice(-p);
    }
    return s;
  }
  /** N / D as p + 1 digits and a power of ten: d.ddd × 10^x → { digits, x } */
  function expDigits(N, D, p) {
    if (N === 0n) return { digits: '0'.repeat(p + 1), x: 0 };
    let x;
    if (N >= D) x = (N / D).toString().length - 1;
    else {
      const L = (D / N).toString().length;
      x = N * 10n ** BigInt(L - 1) >= D ? -(L - 1) : -L;
    }
    const sh = p - x;
    let q = sh >= 0 ? roundDiv(N * 10n ** BigInt(sh), D) : roundDiv(N, D * 10n ** BigInt(-sh));
    let digits = q.toString();
    if (digits.length > p + 1) {
      x++;
      q = sh - 1 >= 0 ? roundDiv(N * 10n ** BigInt(sh - 1), D) : roundDiv(N, D * 10n ** BigInt(1 - sh));
      digits = q.toString();
    }
    return { digits, x };
  }
  const expText = (x) => (x < 0 ? '-' : '+') + String(Math.abs(x)).padStart(2, '0');
  /** a number with a point as %f %e %g %a write it (without sign and padding) */
  function floatText(x, conv, P, alt) {
    const lc = conv.toLowerCase();
    if (x.kind !== 'num') return x.kind;
    const [N, D] = ldFraction(x);
    if (lc === 'f') {
      const s = fixedDigits(N, D, P == null ? 6 : P);
      return alt && !s.includes('.') ? s + '.' : s;
    }
    if (lc === 'e') {
      const p = P == null ? 6 : P, r = expDigits(N, D, p);
      return r.digits[0] + (p > 0 || alt ? '.' : '') + r.digits.slice(1) + 'e' + expText(r.x);
    }
    if (lc === 'g') {
      const p = P == null ? 6 : P || 1, r = expDigits(N, D, p - 1);
      let s;
      if (r.x < -4 || r.x >= p) {
        let frac = r.digits.slice(1);
        if (!alt) frac = frac.replace(/0+$/, '');
        s = r.digits[0] + (frac || alt ? '.' : '') + frac + 'e' + expText(r.x);
      } else {
        s = fixedDigits(N, D, p - 1 - r.x);
        if (alt) {
          if (!s.includes('.')) s += '.';
        } else if (s.includes('.')) s = s.replace(/\.?0+$/, '');
      }
      return s;
    }
    // %a: the 64 bits as one hexadecimal digit, a point and up to 15 more
    if (x.m === 0n) return '0x0' + (P ? '.' + '0'.repeat(P) : alt ? '.' : '') + 'p+0';
    let m = x.m, e = x.e;
    while (m < 2n ** 63n) {
      m <<= 1n;
      e--;
    }
    let leadDigit = m >> 60n, frac = (m & (2n ** 60n - 1n)).toString(16).padStart(15, '0'), ex = e + 60;
    if (P != null && P < 15) {
      const drop = BigInt(4 * (15 - P));
      let q = m >> drop;
      const rem = m & ((1n << drop) - 1n), half = 1n << (drop - 1n);
      if (rem > half || (rem === half && (q & 1n) === 1n)) q += 1n;
      leadDigit = q >> BigInt(4 * P);
      frac = P ? (q & ((1n << BigInt(4 * P)) - 1n)).toString(16).padStart(P, '0') : '';
      if (leadDigit > 15n) {
        leadDigit = 1n;
        ex += 4;
      }
    } else if (P == null) frac = frac.replace(/0+$/, '');
    else frac = frac.padEnd(P, '0');
    return '0x' + leadDigit.toString(16) + (frac || alt ? '.' : '') + frac + 'p' + (ex < 0 ? '-' : '+') + Math.abs(ex);
  }
  /** one backslash escape of printf; s[i] is the character after the backslash. → { text, n } – n: how many characters
      it took (0: none – the backslash is printed and the character after it is read as it is) – or { stop: true }.
      inB: in the argument of %b (\0 with three more digits, \c ends all output, \" stays) */
  function printfEscape(s, i, inB, warn) {
    const c = s[i];
    const simple = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };
    if (c !== undefined && Object.prototype.hasOwnProperty.call(simple, c)) return { text: simple[c], n: 1 };
    if (c >= '0' && c <= '7') {
      let v = parseInt(c, 8), n = 1, left = 2 + (v === 0 && inB ? 1 : 0);
      while (left-- > 0 && i + n < s.length && s[i + n] >= '0' && s[i + n] <= '7') v = v * 8 + parseInt(s[i + n++], 8);
      return { text: rawByte(v & 255), n };
    }
    if (c === 'x' || c === 'u' || c === 'U') {
      const m = new RegExp(`^[0-9a-fA-F]{1,${c === 'x' ? 2 : c === 'u' ? 4 : 8}}`).exec(s.slice(i + 1));
      if (!m) {
        warn(c === 'x' ? 'missing hex digit for \\x' : `missing unicode digit for \\${c}`);
        return { text: '\\', n: 0 };
      }
      const v = parseInt(m[0], 16);
      return { text: c === 'x' ? rawByte(v) : v > 0x10ffff ? '\ufffd' : String.fromCodePoint(v), n: 1 + m[0].length };
    }
    if (c === "'" || c === '"' || c === '?') return inB ? { text: '\\', n: 0 } : { text: c, n: 1 };
    if (c === 'c' && inB) return { stop: true };
    return { text: '\\', n: 0 };
  }
  /** the text of %b, as echo -e reads it → { text, stop: \c was in it } */
  function unescapeB(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== '\\' || i + 1 >= s.length) {
        out += s[i];
        continue;
      }
      const e = printfEscape(s, i + 1, true, () => {});
      if (e.stop) return { text: out, stop: true };
      out += e.text;
      i += e.n;
    }
    return { text: out, stop: false };
  }
  /** a text as the shell would have to be given it (printf %q) */
  function shellQuote(a) {
    a = a == null ? '' : String(a);
    if (a === '') return "''";
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(a)) {
      const names = { '\x07': '\\a', '\b': '\\b', '\x1b': '\\E', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v' };
      // eslint-disable-next-line no-control-regex
      return "$'" + a.replace(/[\\']|[\x00-\x1f\x7f]/g, (c) => (c === '\\' || c === "'" ? '\\' + c : names[c] || '\\' + c.charCodeAt(0).toString(8).padStart(3, '0'))) + "'";
    }
    // (a # is a comment only at the start of a word, a ~ the home folder only there and after : or =)
    return a.replace(/[ !"$&'()*,;<>?[\\\]^`{|}]/g, '\\$&').replace(/^[#~]/, '\\$&').replace(/([:=])~/g, '$1\\~');
  }
  function printfFormat(fmt, args, opt) {
    let ai = 0, out = '', done = false;
    const say = (msg) => opt.err && opt.err(`printf: ${msg}`);
    const fail = (msg) => {
      opt.failed = true;
      say(msg);
    };
    const invalid = (a) => fail(`${a}: ${/^0\d/.test(a) ? 'invalid octal number' : /^0x/.test(a) ? 'invalid hex number' : 'invalid number'}`);
    const getStr = () => (ai < args.length ? String(args[ai++]) : '');
    const ascii = (a) => (a.length > 1 ? BigInt(a.codePointAt(1)) : 0n);
    const getIntMax = (unsigned) => {
      if (ai >= args.length) return 0n;
      const a = String(args[ai++]);
      if (a[0] === "'" || a[0] === '"') return ascii(a);
      const r = cInteger(a, unsigned);
      if (r.end < a.length) invalid(a);
      else if (r.range) say(`warning: ${a}: Numerical result out of range`);
      return r.v;
    };
    const getInt = () => {
      const v = getIntMax(false);
      return v > 2147483647n ? 2147483647 : v < -2147483648n ? -2147483648 : Number(v);
    };
    const getFloat = () => {
      if (ai >= args.length) return { kind: 'num', neg: false, m: 0n, e: 0 };
      const a = String(args[ai++]);
      if (a[0] === "'" || a[0] === '"') {
        const ld = toLongDouble(ascii(a), 1n);
        return { kind: 'num', neg: false, m: ld.m, e: ld.e };
      }
      const r = cFloat(a);
      if (r.end < a.length) invalid(a);
      else if (r.range) say(`warning: ${a}: Numerical result out of range`);
      return r;
    };
    // a text in a field: width and precision count bytes
    const field = (text, left, width, prec) => {
      if (!width && prec == null) return text;
      let b = byteStr(text);
      if (prec != null && prec < b.length) b = b.slice(0, prec);
      return width > b.length ? (left ? b.padEnd(width) : b.padStart(width)) : b;
    };
    // a number in a field: the sign, 0x, then zeros or the digits
    const numField = (sign, prefix, digits, flags, width, zeros) => {
      const s = sign + prefix + digits;
      if (width <= s.length) return s;
      if (flags.includes('-')) return s.padEnd(width);
      if (zeros) return sign + prefix + digits.padStart(width - sign.length - prefix.length, '0');
      return s.padStart(width);
    };
    const pass = () => {
      let res = '', i = 0;
      while (i < fmt.length) {
        const c = fmt[i];
        if (c === '\\') {
          const e = printfEscape(fmt, i + 1, false, say);
          res += e.text;
          i += 1 + e.n;
          continue;
        }
        if (c !== '%') {
          res += c;
          i++;
          continue;
        }
        const start = i++;
        if (fmt[i] === '%') {
          res += '%';
          i++;
          continue;
        }
        let flags = '';
        while (i < fmt.length && "#'-+ 0".includes(fmt[i])) flags += fmt[i++];
        let width = 0, P = null, m;
        if (fmt[i] === '*') {
          i++;
          width = getInt();
        } else if ((m = /^\d+/.exec(fmt.slice(i)))) {
          width = parseInt(m[0], 10);
          i += m[0].length;
        }
        if (fmt[i] === '.') {
          i++;
          if (fmt[i] === '*') {
            i++;
            P = getInt();
            if (P < 0) P = null;
          } else {
            const minus = fmt[i] === '-';
            if (minus) i++;
            m = /^\d+/.exec(fmt.slice(i));
            if (m) i += m[0].length;
            P = minus ? null : m ? parseInt(m[0], 10) : 0;
          }
        }
        while (i < fmt.length && 'hjlLtz'.includes(fmt[i])) i++;
        if (i >= fmt.length) {
          fail(`\`${fmt.slice(start)}': missing format character`);
          done = true;
          return res;
        }
        if (width < 0) {
          flags += '-';
          width = -width;
        }
        const left = flags.includes('-');
        const conv = fmt[i++];
        switch (conv) {
          case 'c': {
            // the first byte of the argument (no argument, or an empty one: a NUL byte)
            const b = ai < args.length ? byteStr(String(args[ai++])) : '';
            res += field(b === '' ? '\0' : b[0], left, width, null);
            break;
          }
          case 's':
            res += field(getStr(), left, width, P);
            break;
          case '(': {
            // %(FORMAT)T: a time (seconds since 1970; -1 or nothing: now; -2: when the shell started), as date writes it
            let depth = 1, j = i;
            for (; j < fmt.length; j++) {
              if (fmt[j] === '(') depth++;
              else if (fmt[j] === ')' && --depth === 0) break;
            }
            if (fmt[j + 1] !== 'T') {
              say(`warning: \`${fmt[j + 1] || ''}': invalid time format specification`);
              res += '%';
              i = start + 1;
              continue;
            }
            const timeFmt = fmt.slice(i, j);
            i = j + 2;
            const secs = ai < args.length ? getIntMax(false) : -1n;
            const d = new Date(secs === -1n ? Date.now() : secs === -2n ? opt.t0 || Date.now() : Number(secs) * 1000);
            res += field(opt.strftime ? opt.strftime(timeFmt || '%X', d) : '', left, width, P);
            break;
          }
          case 'n': {
            const name = getStr();
            if (name) {
              if (!/^[A-Za-z_]\w*$/.test(name)) {
                fail(`\`${name}': not a valid identifier`);
                done = true;
                return res;
              }
              if (opt.setVar) opt.setVar(name, String(byteStr(res).length));
            }
            break;
          }
          case 'b': {
            const u = unescapeB(getStr());
            res += field(u.text, left, width, P);
            if (u.stop) {
              done = true;
              return res;
            }
            break;
          }
          case 'q':
            res += field(shellQuote(getStr()), left, width, P);
            break;
          case 'Q': {
            // (the precision cuts the text before it is quoted)
            let a = byteStr(getStr());
            if (P != null && P < a.length) a = a.slice(0, P);
            res += field(shellQuote(settleRaw(a)), left, width, null);
            break;
          }
          case 'd':
          case 'i': {
            const v = getIntMax(false);
            let digits = (v < 0n ? -v : v).toString();
            if (P != null) digits = P === 0 && v === 0n ? '' : digits.padStart(P, '0');
            res += numField(v < 0n ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '', '', digits, flags, width, flags.includes('0') && P == null);
            break;
          }
          case 'u':
          case 'o':
          case 'x':
          case 'X': {
            const v = getIntMax(true);
            let digits = v.toString(conv === 'o' ? 8 : conv === 'u' ? 10 : 16);
            if (conv === 'X') digits = digits.toUpperCase();
            if (P != null) digits = P === 0 && v === 0n ? '' : digits.padStart(P, '0');
            let prefix = '';
            if (flags.includes('#')) {
              if (conv === 'o' && digits[0] !== '0') digits = '0' + digits;
              else if (conv !== 'o' && conv !== 'u' && v !== 0n) prefix = conv === 'x' ? '0x' : '0X';
            }
            res += numField('', prefix, digits, flags, width, flags.includes('0') && P == null);
            break;
          }
          case 'e':
          case 'E':
          case 'f':
          case 'F':
          case 'g':
          case 'G':
          case 'a':
          case 'A': {
            const x = getFloat();
            let s = floatText(x, conv, P, flags.includes('#'));
            if (conv === conv.toUpperCase()) s = s.toUpperCase();
            const sign = x.neg ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
            const hex = /^0x/i.test(s) ? s.slice(0, 2) : '';
            res += numField(sign, hex, s.slice(hex.length), flags, width, flags.includes('0') && x.kind === 'num');
            break;
          }
          default:
            fail(`\`${conv}': invalid format character`);
            done = true;
            return res;
        }
      }
      return res;
    };
    do out += pass();
    while (!done && ai > 0 && ai < args.length);
    return out;
  }
  B.printf = async (ctx) => {
    const st = stOf(ctx);
    const args = ctx.args;
    const usage = 'printf: usage: printf [-v var] format [arguments]';
    let i = 0, into = null;
    // the options: -v NAME (the text goes into the variable); a format that begins with - needs  --  before it
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === '--') {
        i++;
        break;
      }
      if (a[0] !== '-' || a === '-') break;
      if (a[1] !== 'v') throw userErr(`bash: printf: -${a[1]}: invalid option\n${usage}`, 2);
      into = a.length > 2 ? a.slice(2) : args[++i];
      if (into === undefined) throw userErr(`bash: printf: -v: option requires an argument\n${usage}`, 2);
      if (!/^[A-Za-z_]\w*(\[.+\])?$/.test(into)) throw userErr(`bash: printf: \`${into}': not a valid identifier`, 2);
    }
    if (i >= args.length) throw userErr(usage, 2);
    const utc = MG.shellUtil.zoneUTC(ctx);
    const opt = {
      err: (msg) => ctx.err(`bash: ${msg}\n`),
      failed: false,
      t0: T0,
      strftime: (f, d) => MG.shellUtil.strftime(f, d, utc),
      setVar: (name, value) => ctx.shell._set(name, value, st)
    };
    const s = settleRaw(printfFormat(args[i], args.slice(i + 1), opt));
    // (a variable holds no NUL byte: the text ends there)
    if (into) await ctx.shell._setRef(into, s.split('\0')[0], st, ctx.io);
    else ctx.out(rawOut(s));
    return opt.failed ? 1 : 0;
  };
  /* Carried out: nullglob, failglob, globstar (**), dotglob, nocaseglob, nocasematch, lastpipe, inherit_errexit and
     extglob (see EXTGLOB: on at the prompt, off in a script until it is turned on). The other options of bash are
     remembered and shown – they are about the history, the prompt and completion, which this terminal does not have.
     A name that bash does not know is refused. */
  const SHOPT_ON = ['cmdhist', 'complete_fullquote', 'extquote', 'force_fignore', 'globasciiranges', 'hostcomplete', 'interactive_comments', 'progcomp', 'promptvars', 'sourcepath'];
  const SHOPT_ALL = ['autocd', 'assoc_expand_once', 'cdable_vars', 'cdspell', 'checkhash', 'checkjobs', 'checkwinsize', 'cmdhist', 'compat31', 'compat32', 'compat40', 'compat41', 'compat42', 'compat43', 'compat44', 'complete_fullquote', 'direxpand', 'dirspell', 'dotglob', 'execfail', 'expand_aliases', 'extdebug', 'extglob', 'extquote', 'failglob', 'force_fignore', 'globasciiranges', 'globskipdots', 'globstar', 'gnu_errfmt', 'histappend', 'histreedit', 'histverify', 'hostcomplete', 'huponexit', 'inherit_errexit', 'interactive_comments', 'lastpipe', 'lithist', 'localvar_inherit', 'localvar_unset', 'login_shell', 'mailwarn', 'no_empty_cmd_completion', 'nocaseglob', 'nocasematch', 'noexpand_translation', 'nullglob', 'patsub_replacement', 'progcomp', 'progcomp_alias', 'promptvars', 'restricted_shell', 'shift_verbose', 'sourcepath', 'varredir_close', 'xpg_echo'];
  B.shopt = (ctx) => {
    const st = stOf(ctx);
    const flag = (c) => ctx.args.some((a) => /^-[a-z]+$/.test(a) && a.includes(c));
    const on = flag('s'), off = flag('u'), quiet = flag('q'), asCommands = flag('p');
    const names = ctx.args.filter((a) => !a.startsWith('-'));
    if (flag('o')) {
      // shopt -o NAME: the options of set -o (shopt -qo errexit: is set -e on?)
      const SETO = ['allexport', 'braceexpand', 'errexit', 'errtrace', 'hashall', 'interactive-comments', 'noclobber', 'noexec', 'noglob', 'nounset', 'pipefail', 'verbose', 'xtrace'];
      let rc = 0;
      for (const n of names.length ? names : SETO) {
        if (!SETO.includes(n)) {
          ctx.err(`bash: shopt: ${n}: invalid option name\n`);
          rc = 1;
        } else if (on || off) {
          applySetFlags([on ? '-o' : '+o', n], st.flags, (msg, c) => {
            throw userErr('bash: ' + msg, c);
          });
        } else {
          if (!quiet) ctx.out(asCommands ? `set ${optionOn(st, n) ? '-' : '+'}o ${n}\n` : `${n.padEnd(15)}\t${optionOn(st, n) ? 'on' : 'off'}\n`);
          if (names.length && !optionOn(st, n)) rc = 1;
        }
      }
      return rc;
    }
    st.shopt = st.shopt || {};
    const is = (n) => (n === 'nullglob' ? !!st.flags.nullglob : n === 'extglob' ? extOn(st) : n in st.shopt ? !!st.shopt[n] : SHOPT_ON.includes(n));
    let code = 0;
    const known = names.filter((n) => {
      if (SHOPT_ALL.includes(n)) return true;
      ctx.err(`bash: shopt: ${n}: invalid shell option name\n`);
      code = 1;
      return false;
    });
    if (!on && !off) {
      const list = names.length ? known : SHOPT_ALL;
      if (!quiet) list.forEach((n) => ctx.out(asCommands ? `shopt -${is(n) ? 's' : 'u'} ${n}\n` : `${n.padEnd(15)}\t${is(n) ? 'on' : 'off'}\n`));
      return code || (names.length && !known.every(is) ? 1 : 0);
    }
    known.forEach((n) => {
      if (n === 'nullglob') st.flags.nullglob = on;
      else st.shopt[n] = on;
    });
    return code;
  };
  /* umask [-S] [-p] [MODE]: the permission bits that a new file or folder does not get. umask 077: only the owner
     may read what is made from now on (files 600, folders 700). MODE in octal, or as u=rwx,g=rx,o= */
  B.umask = (ctx) => {
    const st = stOf(ctx);
    const cur = st.umask != null ? st.umask : 0o022;
    const sym = (m) => ['u', 'g', 'o'].map((w, k) => {
      const b = (~m >> (6 - 3 * k)) & 7;
      return `${w}=${b & 4 ? 'r' : ''}${b & 2 ? 'w' : ''}${b & 1 ? 'x' : ''}`;
    }).join(',');
    let symbolic = false, asCmd = false;
    const rest = [];
    for (const a of ctx.args) {
      if (/^-[Sp]+$/.test(a) && !rest.length) {
        if (a.includes('S')) symbolic = true;
        if (a.includes('p')) asCmd = true;
      } else if (/^-./.test(a) && !rest.length) throw userErr(`bash: umask: ${a.slice(0, 2)}: invalid option\numask: usage: umask [-p] [-S] [mode]`, 2);
      else rest.push(a);
    }
    if (!rest.length) {
      ctx.out((asCmd ? 'umask ' + (symbolic ? '-S ' : '') : '') + (symbolic ? sym(cur) : cur.toString(8).padStart(4, '0')) + '\n');
      return 0;
    }
    const mode = rest[0];
    let next;
    if (/^[0-7]{1,4}$/.test(mode)) next = parseInt(mode, 8) & 0o777;
    else if (/^\d+$/.test(mode)) throw userErr(`bash: umask: ${mode}: octal number out of range`);
    else {
      // u=rwx,g=rx,o= … : the bits that are allowed; the mask is what is left
      let allowed = ~cur & 0o777;
      for (const part of mode.split(',')) {
        const m = /^([ugoa]*)([-+=])([rwx]*)$/.exec(part);
        if (!m) throw userErr(`bash: umask: \`${(/[^ugoa+=rwx,-]/.exec(mode) || [mode[0]])[0]}': invalid symbolic mode ${/^[ugoa]*[^-+=ugoa]/.test(part) ? 'operator' : 'character'}`);
        const who = m[1] === '' || m[1].includes('a') ? 'ugo' : m[1];
        let bits = 0;
        for (const w of who) for (const c of m[3]) bits |= { r: 4, w: 2, x: 1 }[c] << { u: 6, g: 3, o: 0 }[w];
        const all = Array.from(who).reduce((x, w) => x | (7 << { u: 6, g: 3, o: 0 }[w]), 0);
        if (m[2] === '+') allowed |= bits;
        else if (m[2] === '-') allowed &= ~bits;
        else allowed = (allowed & ~all) | bits;
      }
      next = ~allowed & 0o777;
    }
    st.umask = next;
    ctx.fs.umask = next;
    if (symbolic) ctx.out(sym(next) + '\n');
    return 0;
  };
  /** times: how long the shell and the programs it ran have used the processor – not measured here */
  B.times = (ctx) => {
    ctx.out('0m0.000s 0m0.000s\n0m0.000s 0m0.000s\n');
    return 0;
  };
  B.ulimit = (ctx) => {
    ctx.out('unlimited\n');
    return 0;
  };
  /** mapfile / readarray [-t] [-n COUNT] [-s SKIP] [NAME]: the lines of the input, as an array */
  B.mapfile = B.readarray = async (ctx) => {
    const st = stOf(ctx);
    let trim = false, count = 0, skip = 0, name = 'MAPFILE', delim = '\n', origin = null, fd = null;
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (a === '--' || !/^-./.test(a)) {
        if (a !== '--') name = a;
        else if (i + 1 < ctx.args.length) name = ctx.args[i + 1];
        if (a === '--') break;
        continue;
      }
      // the letters of one word: -t, and the ones with a value – glued to the letter (-d:, -n2, -td,) or the next word
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (c === 't') {
          trim = true;
          continue;
        }
        if (!'dnOsuCc'.includes(c)) throw userErr(`bash: ${ctx.name}: -${c}: invalid option\n${ctx.name}: usage: ${ctx.name} [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] [-C callback] [-c quantum] [array]`, 2);
        const v = j + 1 < a.length ? a.slice(j + 1) : ctx.args[++i];
        if (v === undefined) throw userErr(`bash: ${ctx.name}: -${c}: option requires an argument\n${ctx.name}: usage: ${ctx.name} [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] [-C callback] [-c quantum] [array]`, 2);
        // -d C: the lines end with C (-d '': with a NUL byte, as find -print0 and sort -z write them)
        if (c === 'd') delim = v[0] || '\0';
        else if (c === 'n') count = parseInt(v, 10) || 0;
        else if (c === 's') skip = parseInt(v, 10) || 0;
        else if (c === 'O') origin = parseInt(v, 10) || 0;
        else if (c === 'u') fd = parseInt(v, 10);
        break;
      }
    }
    let src = null;
    if (fd != null && fd !== 0 && !Number.isNaN(fd)) {
      // -u N: from descriptor N (exec 3< FILE; mapfile -t -u 3 lines)
      src = st.fds && st.fds[fd] && st.fds[fd].in;
      if (!src) throw userErr(`bash: ${ctx.name}: ${fd}: invalid file descriptor: Bad file descriptor`);
    } else if (ctx.stdin != null) src = { text: typeof ctx.stdin === 'string' ? ctx.stdin : await MG.wasm.readText(ctx.stdin.apath), pos: 0 };
    else if (st.stdin) src = st.stdin;
    if (!src) {
      ctx.io.note(`${ctx.name}: this terminal cannot ask you for input – give it a file:  ${ctx.name} -t ${name} < FILE`);
      return 1;
    }
    const text = src.text.slice(src.pos);
    src.pos = src.text.length;
    let L = text.split(delim);
    const open = L[L.length - 1] !== ''; // the last line has no newline
    if (!open) L.pop();
    if (!trim) L = L.map((l, k) => l + (open && k === L.length - 1 ? '' : delim));
    L = L.slice(skip);
    if (count) L = L.slice(0, count);
    if (origin != null) {
      // -O N: the lines are put into the array from element N on; what is there before stays
      const old = ctx.shell._get(name, st), arr = Array.isArray(old) ? old.slice() : [];
      L.forEach((l, k) => (arr[origin + k] = l));
      L = arr;
    }
    ctx.shell._set(name, L, st);
    return 0;
  };
  /* xargs [OPTIONS] [COMMAND [ARGS]]: build commands from what is piped in.
       -n N  at most N items per command          -I R  one command per line, the line in the place of R
       -L N  N lines per command                  -0, -d D  items between NUL bytes, or the character D
       -a FILE  read the items from FILE          -E WORD  stop at the item WORD
       -t  show each command before it runs       -r  run nothing when there is no item
       -P N  taken (the commands run one after the other, as everything does in this terminal); -s N, -x: taken
     Unless -0 or -d is given, quotes and the backslash are xargs's own: 'a b' and "a b" are one item, a\ b too,
     and an apostrophe without its partner is a mistake – as in GNU xargs.
     Status 123: a command failed; 124: a command ended with status 255 (xargs stops there); 127: not found. */
  B.xargs = async (ctx) => {
    const st = stOf(ctx);
    const args = ctx.args.slice();
    let n = Infinity, repl = null, nul = false, delim = null, show = false, lines = 0, noEmpty = false, file = null, eof = null;
    const bad = (msg) => userErr(`xargs: ${msg}`, 1);
    const count = (v, opt) => {
      if (!/^\d+$/.test(v || '')) throw bad(`invalid number "${v || ''}" for -${opt} option`);
      if (+v < 1) throw bad(`value ${v} for -${opt} option should be >= 1`);
      return +v;
    };
    while (args.length && args[0].startsWith('-') && args[0] !== '-') {
      let a = args.shift();
      if (a === '--') break;
      // --long=value and --long value are the short option with its value
      let value = null;
      const long = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(a);
      if (long) {
        const L = { 'max-args': 'n', replace: 'i', 'max-lines': 'l', delimiter: 'd', 'arg-file': 'a', eof: 'e', 'max-procs': 'P', 'max-chars': 's', null: '0', verbose: 't', 'no-run-if-empty': 'r', exit: 'x', interactive: 'p', 'open-tty': 'o' }[long[1]];
        if (!L) throw userErr(`xargs: unrecognized option '${a.split('=')[0]}'\nTry 'xargs --help' for more information.`, 1);
        value = long[2] != null ? long[2] : 'ndaPs'.includes(L) ? args.shift() : null;
        a = '-' + L;
        if (value != null) a += value;
      }
      // (several letters in one word: -rt, -0r, -n1 …)
      let j = 1;
      while (j < a.length) {
        const c = a[j], rest = a.slice(j + 1);
        const take = () => (rest !== '' ? rest : args.shift());
        if (c === 'n') {
          n = count(take(), 'n');
          break;
        } else if (c === 'I') {
          repl = take();
          if (repl == null) throw userErr("xargs: option requires an argument -- 'I'\nTry 'xargs --help' for more information.", 1);
          break;
        } else if (c === 'i') {
          repl = rest !== '' ? rest : '{}';
          break;
        } else if (c === 'L') {
          lines = count(take(), 'L');
          break;
        } else if (c === 'l') {
          lines = rest !== '' ? count(rest, 'l') : 1;
          break;
        } else if (c === 'd') {
          const d = take();
          if (d == null) throw userErr("xargs: option requires an argument -- 'd'\nTry 'xargs --help' for more information.", 1);
          delim = MG.shellUtil.unesc(d).replace(/\\0/g, '\0').replace(/\\\\/g, '\\');
          if (Array.from(delim).length !== 1) throw bad(`Invalid input delimiter specification ${d}: the delimiter must be either a single character or an escape sequence starting with \\.`);
          break;
        } else if (c === 'a') {
          file = take();
          break;
        } else if (c === 'E') {
          eof = take();
          break;
        } else if (c === 'e') {
          eof = rest !== '' ? rest : null;
          break;
        } else if (c === 'P') {
          const v = take();
          if (!/^\d+$/.test(v || '')) throw bad(`invalid number "${v || ''}" for -P option`);
          break;
        } else if (c === 's') {
          count(take(), 's');
          break;
        } else if (c === '0') nul = true;
        else if (c === 't') show = true;
        else if (c === 'r') noEmpty = true;
        else if (c === 'x' || c === 'o') {
          /* taken */
        } else if (c === 'p') throw bad('-p (ask before each command) is not available: this terminal cannot ask. With -t each command is shown before it runs.');
        else throw userErr(`xargs: invalid option -- '${c}'\nTry 'xargs --help' for more information.`, 1);
        j++;
      }
    }
    const cmd = args.length ? args : ['echo'];
    let text;
    if (file != null) {
      const e = ctx.fs.get(file);
      if (!e || e.kind === 'dir') throw bad(`Cannot open input file \u2018${file}\u2019: ${e ? 'Is a directory' : 'No such file or directory'}`);
      text = await ctx.fs.readText(file);
    } else text = await inputOf(ctx, [], 'xargs');
    // the items: between NUL bytes (-0) or the delimiter (-d); else words – or, with -I and -L, lines – in which
    // quotes and backslashes are taken off as xargs does it
    let items, units = null; // (units: for -L, the items of each line)
    if (nul) items = text.split('\0').filter((x, k, all) => !(x === '' && k === all.length - 1));
    else if (delim != null) items = text.split(delim).filter((x, k, all) => !(x === '' && k === all.length - 1));
    else {
      items = [];
      units = [];
      let cur = null, line = [];
      const push = () => {
        if (cur != null) {
          items.push(cur);
          line.push(cur);
        }
        cur = null;
      };
      const byLine = repl != null;
      for (let k = 0; k < text.length; k++) {
        const c = text[k];
        if (c === '\\') {
          k++;
          if (k < text.length) cur = (cur || '') + text[k];
        } else if (c === "'" || c === '"') {
          const e = text.indexOf(c, k + 1), nl = text.indexOf('\n', k + 1);
          if (e < 0 || (nl >= 0 && nl < e)) throw bad(`unmatched ${c === "'" ? 'single' : 'double'} quote; by default quotes are special to xargs unless you use the -0 option`);
          cur = (cur || '') + text.slice(k + 1, e);
          k = e;
        } else if (c === '\n') {
          // (-L: a line that ends in a blank goes on in the next line)
          const goesOn = lines && cur == null && k > 0 && /[ \t]/.test(text[k - 1]) && line.length;
          push();
          if (!goesOn && line.length) {
            units.push(line);
            line = [];
          }
        } else if ((c === ' ' || c === '\t') && !byLine) push();
        else if ((c === ' ' || c === '\t') && cur == null) {
          /* -I: blanks at the start of a line do not count */
        } else cur = (cur || '') + c;
      }
      push();
      if (line.length) units.push(line);
    }
    if (eof != null && eof !== '') {
      const at = items.indexOf(eof);
      if (at >= 0) {
        items = items.slice(0, at);
        if (units) {
          let left = at;
          units = units.map((u) => {
            const part = u.slice(0, Math.max(0, left));
            left -= u.length;
            return part;
          }).filter((u) => u.length);
        }
      }
    }
    const runs = [];
    if (repl != null) items.forEach((it) => runs.push(args.length ? cmd.map((a) => a.split(repl).join(it)) : cmd));
    else if (lines && units) for (let k = 0; k < units.length; k += lines) runs.push(cmd.concat(...units.slice(k, k + lines)));
    else if (!items.length) {
      if (!noEmpty) runs.push(cmd);
    } else for (let k = 0; k < items.length; k += n === Infinity ? items.length : n) runs.push(cmd.concat(items.slice(k, n === Infinity ? undefined : k + n)));
    let code = 0;
    const io = innerIO(ctx);
    for (const argv of runs) {
      if (ctx.term && ctx.term.cancelled) return 130;
      ctx.shell._tick();
      if (show) ctx.err(argv.join(' ') + '\n');
      const c = await ctx.shell.runArgv(argv, st, io, '', 'xargs');
      if (c === 127 || c === 126) return c;
      if (c === 255) {
        ctx.err(`xargs: ${argv[0]}: exited with status 255; aborting\n`);
        return 124;
      }
      if (c) code = 123;
    }
    return code;
  };

  /* ------------------------------------------------------------------ bash, sh, source */
  const runBash = async (ctx) => {
    const args = ctx.args.slice();
    const flags = [];
    let checkOnly = false, fromInput = false, shopts = null, cmdMode = false;
    while (args.length) {
      const a = args[0];
      // bash -O extglob …, bash +O NAME: an option of shopt that is on (off) from the start
      if ((a === '-O' || a === '+O') && args.length > 1) {
        if (!SHOPT_ALL.includes(args[1])) throw userErr(`bash: line 0: ${args[1]}: invalid shell option name`, 2);
        (shopts = shopts || {})[args[1]] = a === '-O';
        args.splice(0, 2);
        continue;
      }
      // bash -s ARG …: the commands come from the input, the words after -s are $1 $2 …
      if (a === '-s') {
        args.shift();
        fromInput = true;
        continue;
      }
      // -- (or a lone -): the options end here
      if (a === '--' || a === '-') {
        args.shift();
        break;
      }
      if (a === '--version') {
        ctx.out('The shell of this practical: a subset of bash, written in JavaScript (it is not GNU bash, so it has no bash version).\nhelp lists what it can do.\n');
        return 0;
      }
      if (a === '--help') {
        ctx.out('Usage: bash [-e] [-u] [-x] [-n] [-o pipefail] [-O SHOPT_OPTION] SCRIPT [ARGUMENTS]\n       bash -c "COMMANDS"\n  -e  stop at the first command that fails     -u  an unset variable is an error\n  -x  print each command before it runs        -n  check the syntax only, run nothing\n  -O NAME  an option of shopt that is on from the start:  bash -O extglob script.sh\n');
        return 0;
      }
      if (a === '--norc' || a === '--noprofile' || a === '--login' || a === '--posix') {
        args.shift();
        continue;
      }
      // The letters of "set" (-e -u -x -v -a -f -C -E -o NAME …); -n: syntax check; -l -i -r -p -D and the letters
      // about the history and job control: taken, and of no consequence here. A letter or a long option that bash
      // does not know is refused as bash refuses it (status 2; after -e: status 1, and no usage lines).
      if (a === '-c') {
        cmdMode = true;
        args.shift();
        continue;
      }
      if (!/^[-+]./.test(a)) break;
      const usage = 'Usage:\tbash [GNU long option] [option] ...\n\tbash [GNU long option] [option] script-file ...';
      if (a.startsWith('--')) {
        if (a === '--verbose') flags.push('-v');
        else if (a === '--rcfile' || a === '--init-file') args.shift();
        else if (!/^--(restricted|noediting|debug|debugger|pretty-print|dump-strings|dump-po-strings)$/.test(a)) throw userErr(`bash: ${a}: invalid option\n${usage}`, 2);
        args.shift();
        continue;
      }
      const wrong = Array.from(a.slice(1)).find((c) => !'abefhkmnptuvxBCEHPTilrsDcoO'.includes(c));
      if (wrong !== undefined) {
        const hadE = (a[0] === '-' && a.slice(1, a.indexOf(wrong)).includes('e')) || flags.some((w) => /^-[A-Za-z]*e/.test(w));
        throw userErr(`bash: ${a[0]}${wrong}: invalid option` + (hadE ? '' : '\n' + usage), hadE ? 1 : 2);
      }
      args.shift();
      if (a[0] === '-' && a.includes('n')) checkOnly = true;
      if (a.includes('s')) fromInput = true;
      const known = a[0] + a.slice(1).replace(/[nlicrsDO]/g, '');
      if (known.length > 1) flags.push(known);
      for (const c of a.slice(1)) {
        // (-o NAME and -O NAME inside a group of letters: each takes the next word)
        if (c === 'o' && args.length) flags.push(args.shift());
        else if (c === 'O' && args.length) {
          const nm = args.shift();
          if (!SHOPT_ALL.includes(nm)) throw userErr(`bash: line 0: ${nm}: invalid shell option name`, 2);
          (shopts = shopts || {})[nm] = a[0] === '-';
        }
      }
      // bash -lc "…", bash -ec "…"
      if (a[0] === '-' && a.includes('c')) cmdMode = true;
    }
    // (-c: the first word that is no option is the text of the commands – bash -c -e 'commands' works too)
    if (cmdMode) args.unshift('-c');
    const f = applySetFlags(flags, {}, (msg, code) => {
      // bash -o nosuchname
      throw userErr('bash: line 0: bash: ' + msg.replace(/^set: /, '').split('\n')[0], code || 2);
    });
    const io = innerIO(ctx);
    if (checkOnly) {
      // bash -n: read the commands, run nothing
      let text, label;
      if (args[0] === '-c') [text, label] = [args[1] || '', 'bash: -c'];
      else if (!args.length) [text, label] = [typeof ctx.stdin === 'string' ? ctx.stdin : '', 'bash'];
      else {
        const e = ctx.fs.get(args[0]);
        if (!e) throw userErr(`bash: ${args[0]}: No such file or directory`, 127);
        if (e.kind === 'dir') throw userErr(`bash: ${args[0]}: Is a directory`, 126);
        [text, label] = [await ctx.fs.readText(args[0]), args[0]];
      }
      try {
        parse(text, { eofHeredoc: true, extglob: !!(shopts && shopts.extglob) });
      } catch (e) {
        if (!e.syntax) throw e;
        ctx.err(synReport(`${label}: `, text, e));
        return 2;
      }
      return 0;
    }
    if (args[0] === '-c') {
      if (args[1] == null) throw userErr('bash: -c: option requires an argument', 2);
      // bash -c 'COMMANDS' NAME ARG…: NAME is $0, the rest $1 …
      return ctx.shell.exec(args[1], io, { st: stOf(ctx), command: true, shopt: shopts, flags: f, errexit: !!f.e, nounset: !!f.u, xtrace: !!f.x, verbose: !!f.v, pipefail: !!f.pipefail, name: args[2], args: args.slice(3), stdin: ctx.stdin, stdinDev: ctx.stdinFrom === '/dev/null' });
    }
    if (!args.length || fromInput) {
      // bash without a script: its commands are its input (echo 'ls' | bash) – that of the block it stands in, too
      const script = ctx.stdin != null ? (typeof ctx.stdin === 'string' ? ctx.stdin : await MG.wasm.readText(ctx.stdin.apath)) : MG.shellUtil.inherited(ctx);
      if (script != null) return ctx.shell.exec(script, io, { fromStdin: true, st: stOf(ctx), shopt: shopts, flags: f, errexit: !!f.e, nounset: !!f.u, xtrace: !!f.x, verbose: !!f.v, pipefail: !!f.pipefail, stdin: '', args: fromInput ? args : undefined });
      ctx.io.note('You are already in a bash-like shell. To run a script:  bash script.sh');
      return 0;
    }
    const path = args[0];
    if (path === '/dev/null') return 0; // an empty script
    const e = ctx.fs.get(path);
    // (bash -e nosuch.sh: the message is an error like any other, and -e ends the new shell with status 1;
    //  bash FILE/ : "Not a directory", status 126)
    if (!e) {
      const notDir = ctx.fs.pathError && ctx.fs.pathError(path) === 'Not a directory';
      throw userErr(`bash: ${path}: ${notDir ? 'Not a directory' : 'No such file or directory'}`, f.e ? 1 : notDir ? 126 : 127);
    }
    if (e.kind === 'dir') throw userErr(`${path}: ${path}: Is a directory`, f.e ? 1 : 126);
    if (MG.unsavedNote) MG.unsavedNote(ctx);
    const sourced = ctx.name === 'source' || ctx.name === '.';
    MG.bus.emit('script:start', { path: ctx.fs.resolve(path) });
    const code = await ctx.shell.runScript(path, args.slice(1), io, { st: stOf(ctx), initialFlags: flags, sourced, stdin: ctx.stdin, stdinDev: ctx.stdinFrom === '/dev/null', shopt: shopts });
    MG.bus.emit('script:done', { path: ctx.fs.resolve(path), name: path.split('/').pop(), code });
    return code;
  };
  B.bash = runBash;
  B.sh = runBash;
  /* source FILE [ARGUMENTS], . FILE: the commands of the file are carried out in this shell. A file that is not
     there is status 1 (in a script under set -e: the end). source /dev/stdin reads the commands from the input. */
  B.source = async (ctx) => {
    const name = ctx.name === '.' ? '.' : 'source';
    if (!ctx.args.length) throw userErr(`bash: ${name}: filename argument required\n${name}: usage: ${name} filename [arguments]`, 2);
    const path = ctx.args[0], st = stOf(ctx);
    if (/^\/dev\/(stdin|fd\/0)$/.test(path)) {
      const text = ctx.stdin != null ? (typeof ctx.stdin === 'string' ? ctx.stdin : await MG.wasm.readText(ctx.stdin.apath)) : MG.shellUtil.inherited(ctx) || '';
      return ctx.shell.runScript(path, ctx.args.slice(1), innerIO(ctx), { st, sourced: true, text });
    }
    if (path === '/dev/null') return 0;
    const e = ctx.fs.get(path);
    if (!e) throw userErr(`bash: ${path}: No such file or directory`, 1);
    if (e.kind === 'dir') throw userErr(`bash: ${name}: ${path}: is a directory`, 1);
    return runBash(ctx);
  };
  B['.'] = B.source;

  MG.shellLang = { extglobOn: (st) => extOn(st), flat, lex, parse, statements, incomplete, commandNames, wordsOf, scriptsRun, argKinds, optionSkips, reach, anchor, anchorText, globRe, braceExpand, arithEval, printfFormat, isShellWord: (name) => SHELL_WORDS.includes(name) };
})();
