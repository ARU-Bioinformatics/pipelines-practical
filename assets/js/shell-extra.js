/* =====================================================================
   More commands for the practical's terminal:
   md5sum, sha256sum, chmod, bash/sh, source, which, find, basename,
   dirname, realpath, sleep, python, pip, conda (mamba), snakemake, dot,
   open, and edit/nano.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const B = MG.shellBuiltins;
  const T = MG.shellTools;
  const { getopts, userErr, linesOf, isLazy } = MG.shellUtil;
  const enc = new TextEncoder();

  /* ------------------------------------------------------------------ bytes of the input */
  async function stdinBytes(ctx) {
    const s = ctx.stdin;
    if (s == null) return new Uint8Array(0);
    if (MG.FileRef && s instanceof MG.FileRef) return await MG.wasm.readBytes(s.apath);
    if (isLazy(s)) throw userErr('this simulated stream cannot be read byte by byte');
    return enc.encode(String(s));
  }
  async function fileBytes(ctx, f, cmd) {
    const e = ctx.fs.get(f);
    if (!e) throw userErr(`${cmd}: ${f}: No such file or directory`);
    if (e.kind === 'dir') throw userErr(`${cmd}: ${f}: Is a directory`);
    return await ctx.fs.readBytes(f);
  }

  /* ------------------------------------------------------------------ MD5 (RFC 1321) */
  function md5(bytes) {
    const K = new Uint32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    const len = bytes.length;
    const nBlocks = ((len + 8) >>> 6) + 1;
    const buf = new Uint8Array(nBlocks * 64);
    buf.set(bytes);
    buf[len] = 0x80;
    const bitLen = len * 8;
    const dv = new DataView(buf.buffer);
    dv.setUint32(buf.length - 8, bitLen >>> 0, true);
    dv.setUint32(buf.length - 4, Math.floor(bitLen / 4294967296), true);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const M = new Uint32Array(16);
    for (let blk = 0; blk < nBlocks; blk++) {
      for (let i = 0; i < 16; i++) M[i] = dv.getUint32(blk * 64 + i * 4, true);
      let A = a0, Bv = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) {
          F = (Bv & C) | (~Bv & D);
          g = i;
        } else if (i < 32) {
          F = (D & Bv) | (~D & C);
          g = (5 * i + 1) % 16;
        } else if (i < 48) {
          F = Bv ^ C ^ D;
          g = (3 * i + 5) % 16;
        } else {
          F = C ^ (Bv | ~D);
          g = (7 * i) % 16;
        }
        F = (F + A + K[i] + M[g]) >>> 0;
        A = D;
        D = C;
        C = Bv;
        Bv = (Bv + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
      }
      a0 = (a0 + A) >>> 0;
      b0 = (b0 + Bv) >>> 0;
      c0 = (c0 + C) >>> 0;
      d0 = (d0 + D) >>> 0;
    }
    const out = new DataView(new ArrayBuffer(16));
    [a0, b0, c0, d0].forEach((v, i) => out.setUint32(i * 4, v, true));
    return Array.from(new Uint8Array(out.buffer), (x) => x.toString(16).padStart(2, '0')).join('');
  }
  async function sha256(bytes) {
    const h = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(h), (x) => x.toString(16).padStart(2, '0')).join('');
  }
  MG.md5 = md5;
  MG.sha256 = sha256;

  function hashCommand(name, fn) {
    return async (ctx) => {
      const { opts, rest } = getopts(ctx.args, 'cbtqsw', { check: 'c', binary: 'b', text: 't', quiet: 'q', status: 's', warn: 'w' });
      if (opts.c) {
        const lists = rest.length ? rest : ['-'];
        let bad = 0, unread = 0, n = 0;
        for (const lf of lists) {
          const text = lf === '-' ? new TextDecoder().decode(await stdinBytes(ctx)) : await ctx.fs.readText(lf).catch(() => {
            throw userErr(`${name}: ${lf}: No such file or directory`);
          });
          for (const line of linesOf(text)) {
            const m = /^([0-9a-f]{32,64})\s[ *](.+)$/i.exec(line.trim());
            if (!m) continue;
            n++;
            const f = m[2];
            let h;
            try {
              h = await fn(await fileBytes(ctx, f, name));
            } catch (e) {
              ctx.err(`${name}: ${f}: No such file or directory\n`);
              ctx.out(`${f}: FAILED open or read\n`);
              unread++;
              continue;
            }
            if (h.toLowerCase() === m[1].toLowerCase()) {
              if (!opts.q && !opts.s) ctx.out(`${f}: OK\n`);
            } else {
              if (!opts.s) ctx.out(`${f}: FAILED\n`);
              bad++;
            }
          }
        }
        if (!n) throw userErr(`${name}: ${lists.join(' ')}: no properly formatted checksum lines found`);
        if (unread && !opts.s) ctx.err(`${name}: WARNING: ${unread} listed file${unread > 1 ? 's' : ''} could not be read\n`);
        if (bad && !opts.s) ctx.err(`${name}: WARNING: ${bad} computed checksum${bad > 1 ? 's' : ''} did NOT match\n`);
        MG.bus.emit('hash:check', { name, ok: !bad && !unread, n });
        return bad || unread ? 1 : 0;
      }
      const files = rest.length ? rest : ['-'];
      let code = 0;
      for (const f of files) {
        try {
          const bytes = f === '-' ? await stdinBytes(ctx) : await fileBytes(ctx, f, name);
          ctx.out(`${await fn(bytes)}  ${f}\n`);
        } catch (e) {
          ctx.err((e.userMessage || e.message) + '\n');
          code = 1;
        }
      }
      MG.bus.emit('hash:made', { name, files });
      return code;
    };
  }
  B.md5sum = hashCommand('md5sum', async (b) => md5(b));
  B.sha256sum = hashCommand('sha256sum', sha256);

  /* ------------------------------------------------------------------ diff (GNU diff formats) */
  /** Myers' O(ND) difference algorithm -> list of ['=', i, j] | ['-', i] | ['+', j] */
  function myers(a, b) {
    const n = a.length, m = b.length, max = n + m;
    const v = new Map([[1, 0]]);
    const trace = [];
    outer: for (let d = 0; d <= max; d++) {
      trace.push(new Map(v));
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? v.get(k + 1) ?? 0 : (v.get(k - 1) ?? 0) + 1;
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) {
          x++;
          y++;
        }
        v.set(k, x);
        if (x >= n && y >= m) break outer;
      }
    }
    const ops = [];
    let x = n, y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
      const vv = trace[d];
      const k = x - y;
      const prevK = k === -d || (k !== d && (vv.get(k - 1) ?? -1) < (vv.get(k + 1) ?? -1)) ? k + 1 : k - 1;
      const px = vv.get(prevK) ?? 0, py = px - prevK;
      while (x > px && y > py) ops.push(['=', --x, --y]);
      if (d > 0) {
        if (x === px) ops.push(['+', --y]);
        else ops.push(['-', --x]);
      }
      x = px;
      y = py;
    }
    return ops.reverse();
  }
  function hunksOf(ops) {
    const hunks = [];
    let cur = null;
    ops.forEach((op, idx) => {
      if (op[0] === '=') {
        cur = null;
        return;
      }
      if (!cur) hunks.push((cur = { del: [], add: [], at: idx }));
      if (op[0] === '-') cur.del.push(op[1]);
      else cur.add.push(op[1]);
    });
    // where each hunk sits in the two files
    hunks.forEach((hk) => {
      let ai = 0, bi = 0;
      for (let i = 0; i < hk.at; i++) {
        if (ops[i][0] !== '+') ai++;
        if (ops[i][0] !== '-') bi++;
      }
      hk.a = ai;
      hk.b = bi;
    });
    return hunks;
  }
  const rng = (s, n) => (n <= 1 ? String(s + (n === 1 ? 1 : 0)) : `${s + 1},${s + n}`);
  B.diff = async (ctx) => {
    const { opts, rest } = getopts(ctx.args, 'quwiy', { brief: 'q', unified: 'u' });
    if (rest.length !== 2) throw userErr(`diff: ${rest.length < 2 ? 'missing operand after \'' + (rest[0] || 'diff') + '\'' : 'extra operand \'' + rest[2] + '\''}\ndiff: Try 'diff --help' for more information.`, 2);
    const read = async (f) => (f === '-' ? stdinBytes(ctx) : fileBytes(ctx, f, 'diff'));
    let A, Bb;
    try {
      A = await read(rest[0]);
      Bb = await read(rest[1]);
    } catch (e) {
      e.code = 2;
      throw e;
    }
    const same = A.length === Bb.length && A.every((x, i) => x === Bb[i]);
    if (same) return 0;
    const binary = (u) => u.subarray(0, 4000).some((x) => x === 0) || (u[0] === 0x1f && u[1] === 0x8b);
    if (opts.q || binary(A) || binary(Bb)) {
      ctx.out(`${opts.q ? 'Files' : 'Binary files'} ${rest[0]} and ${rest[1]} differ\n`);
      return 1;
    }
    const dec = new TextDecoder();
    const la = linesOf(dec.decode(A)), lb = linesOf(dec.decode(Bb));
    const norm = (l) => (opts.w ? l.replace(/\s+/g, '') : l) + '';
    const na = la.map(norm), nb = lb.map(norm);
    if (na.length * nb.length > 4e7) throw userErr('diff: the files are too large to compare in this browser – compare checksums (md5sum) or a few lines (head) instead', 2);
    const ops = myers(na, nb);
    if (ops.every((o) => o[0] === '=')) return 0;
    const out = [];
    if (opts.u) {
      const when = (f) => {
        const e = f === '-' ? null : ctx.fs.get(f);
        const d = new Date((e && e.mtime) || Date.now());
        return d.toISOString().replace('T', ' ').replace('Z', '').replace(/(\.\d{3})$/, '$1000000 +0000');
      };
      out.push(`--- ${rest[0]}\t${when(rest[0])}`, `+++ ${rest[1]}\t${when(rest[1])}`);
      const C = 3;
      let i = 0;
      while (i < ops.length) {
        if (ops[i][0] === '=') {
          i++;
          continue;
        }
        let start = Math.max(0, i - C), end = i;
        // extend the hunk while changes are close together
        for (;;) {
          while (end < ops.length && ops[end][0] !== '=') end++;
          let j = end;
          while (j < ops.length && ops[j][0] === '=') j++;
          if (j < ops.length && j - end <= 2 * C) end = j;
          else {
            end = Math.min(ops.length, end + C);
            break;
          }
        }
        const seg = ops.slice(start, end);
        let a0 = 0, b0 = 0;
        for (let k = 0; k < start; k++) {
          if (ops[k][0] !== '+') a0++;
          if (ops[k][0] !== '-') b0++;
        }
        const an = seg.filter((o) => o[0] !== '+').length, bn = seg.filter((o) => o[0] !== '-').length;
        const r = (s, n) => (n === 1 ? `${s + 1}` : `${n ? s + 1 : s},${n}`);
        out.push(`@@ -${r(a0, an)} +${r(b0, bn)} @@`);
        seg.forEach((o) => out.push(o[0] === '=' ? ' ' + la[o[1]] : o[0] === '-' ? '-' + la[o[1]] : '+' + lb[o[1]]));
        i = end;
      }
    } else {
      hunksOf(ops).forEach((hk) => {
        const d = hk.del.length, a = hk.add.length;
        if (d && a) out.push(`${rng(hk.a, d)}c${rng(hk.b, a)}`);
        else if (d) out.push(`${rng(hk.a, d)}d${hk.b}`);
        else out.push(`${hk.a}a${rng(hk.b, a)}`);
        hk.del.forEach((i) => out.push('< ' + la[i]));
        if (d && a) out.push('---');
        hk.add.forEach((j) => out.push('> ' + lb[j]));
      });
    }
    ctx.out(out.join('\n') + '\n');
    return 1;
  };

  /** remind the student when the editor holds changes the command will not see */
  function unsavedNote(ctx) {
    const ed = MG.app && MG.app.editor;
    const d = ed && ed.dirtyPaths ? ed.dirtyPaths() : [];
    if (d.length) ctx.io.note(`Unsaved changes in the editor: ${d.map((p) => ctx.fs.pretty(p)).join(', ')}. Commands use the saved files – press Ctrl+S in the Files tab to save.`);
  }
  MG.unsavedNote = unsavedNote;

  /* ------------------------------------------------------------------ chmod */
  B.chmod = (ctx) => {
    const args = ctx.args.filter((a) => a !== '-R' && a !== '-v');
    if (args.length < 2) throw userErr("chmod: missing operand\nTry: chmod +x script.sh   (make executable)   or   chmod -w file   (write-protect)");
    const mode = args[0];
    const perm = {};
    if (/^[0-7]{3,4}$/.test(mode)) {
      const u = parseInt(mode.slice(-3)[0], 10);
      perm.exec = (u & 1) === 1;
      perm.readonly = (u & 2) === 0;
    } else {
      const m = /^[ugoa]*([+\-=])([rwx]+)$/.exec(mode);
      if (!m) throw userErr(`chmod: invalid mode: '${mode}'`);
      if (m[2].includes('x')) perm.exec = m[1] !== '-';
      if (m[2].includes('w')) perm.readonly = m[1] === '-';
      if (m[1] === '=') {
        perm.exec = m[2].includes('x');
        perm.readonly = !m[2].includes('w');
      }
    }
    let code = 0;
    args.slice(1).forEach((f) => {
      const e = ctx.fs.get(f);
      if (!e) {
        ctx.err(`chmod: cannot access '${f}': No such file or directory\n`);
        code = 1;
        return;
      }
      if (e.protected) {
        ctx.err(`chmod: changing permissions of '${f}': Operation not permitted (course data)\n`);
        code = 1;
        return;
      }
      const targets = e.kind === 'dir' && ctx.args.includes('-R') ? Array.from(ctx.fs.entries.keys()).filter((k) => k.startsWith(ctx.fs.resolve(f) + '/')) : [f];
      targets.forEach((t) => {
        const te = ctx.fs.get(t);
        if (te && te.kind !== 'dir') ctx.fs.chmod(t, perm);
      });
    });
    return code;
  };

  B.ll = (ctx) => B.ls(Object.assign({}, ctx, { args: ['-l'].concat(ctx.args) }));

  /* ------------------------------------------------------------------ bash, sh, source */
  const runBash = async (ctx) => {
    const args = ctx.args.slice();
    const flags = [];
    while (args.length && /^-[euxo]+$/.test(args[0])) {
      flags.push(args.shift());
      if (flags[flags.length - 1].endsWith('o')) flags.push(args.shift());
    }
    if (args[0] === '-c') {
      if (!args[1]) throw userErr('bash: -c: option requires an argument');
      const f = MG.shellUtil.applySetFlags(flags.join(' '), {});
      return ctx.shell.exec(args[1], ctx.io, Object.assign({}, ctx.opts, { errexit: !!f.e, pipefail: !!f.pipefail }));
    }
    if (!args.length) {
      ctx.io.note('You are already in a bash-like shell. To run a script: bash script.sh');
      return 0;
    }
    const path = args[0];
    const e = ctx.fs.get(path);
    if (!e) throw userErr(`bash: ${path}: No such file or directory`);
    if (e.kind === 'dir') throw userErr(`bash: ${path}: Is a directory`);
    const io = Object.assign({}, ctx.io, { out: ctx.out, err: ctx.err });
    unsavedNote(ctx);
    MG.bus.emit('script:start', { path: ctx.fs.resolve(path) });
    const code = await ctx.shell.runScript(path, args.slice(1), io, Object.assign({}, ctx.opts, { initialFlags: flags.join(' '), sourced: ctx.name === 'source' || ctx.name === '.' }));
    MG.bus.emit('script:done', { path: ctx.fs.resolve(path), code });
    return code;
  };
  B.bash = runBash;
  B.sh = runBash;
  B.source = async (ctx) => {
    if (!ctx.args[0]) throw userErr('source: filename argument required');
    return runBash(ctx);
  };
  B['.'] = B.source;

  /* ------------------------------------------------------------------ which, type */
  B.which = (ctx) => {
    let code = 0;
    ctx.args.filter((a) => !a.startsWith('-')).forEach((c) => {
      if (MG.conda.managed(c)) {
        const p = MG.conda.which(c);
        if (p) ctx.out(p + '\n');
        else code = 1;
      } else if (MG.shellTools[c] || MG.shellBuiltins[c]) ctx.out(`/usr/bin/${c}\n`);
      else code = 1;
    });
    return code;
  };
  B.type = (ctx) => {
    let code = 0;
    ctx.args.forEach((c) => {
      if (MG.conda.managed(c)) {
        const p = MG.conda.which(c);
        if (p) ctx.out(`${c} is ${p}\n`);
        else {
          ctx.err(`bash: type: ${c}: not found\n`);
          code = 1;
        }
      } else if (['cd', 'echo', 'export', 'set', 'source', 'type', 'pwd', 'history'].includes(c)) ctx.out(`${c} is a shell builtin\n`);
      else if (MG.shellTools[c] || MG.shellBuiltins[c]) ctx.out(`${c} is /usr/bin/${c}\n`);
      else {
        ctx.err(`bash: type: ${c}: not found\n`);
        code = 1;
      }
    });
    return code;
  };

  /* ------------------------------------------------------------------ small file-name commands */
  B.basename = (ctx) => {
    const [p, suf] = ctx.args.filter((a) => !a.startsWith('-'));
    if (p == null) throw userErr('basename: missing operand');
    let b = p.replace(/\/+$/, '').split('/').pop();
    if (suf && b.endsWith(suf) && b !== suf) b = b.slice(0, -suf.length);
    ctx.out(b + '\n');
  };
  B.dirname = (ctx) => {
    const p = ctx.args[0];
    if (p == null) throw userErr('dirname: missing operand');
    const s = p.replace(/\/+$/, '');
    const i = s.lastIndexOf('/');
    ctx.out((i < 0 ? '.' : i === 0 ? '/' : s.slice(0, i)) + '\n');
  };
  B.realpath = (ctx) => {
    ctx.args.filter((a) => !a.startsWith('-')).forEach((p) => ctx.out(ctx.fs.resolve(p) + '\n'));
  };
  B.readlink = (ctx) => B.realpath(ctx);
  B.sleep = async (ctx) => {
    const s = parseFloat(ctx.args[0] || '0');
    await new Promise((r) => setTimeout(r, Math.min(10, isNaN(s) ? 0 : s) * 1000));
  };
  B.find = (ctx) => {
    const args = ctx.args.slice();
    const paths = [];
    while (args.length && !args[0].startsWith('-')) paths.push(args.shift());
    if (!paths.length) paths.push('.');
    let name = null, type = null, maxdepth = Infinity;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-name' || args[i] === '-iname') name = new RegExp('^' + args[++i].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', args[i - 1] === '-iname' ? 'i' : '');
      else if (args[i] === '-type') type = args[++i];
      else if (args[i] === '-maxdepth') maxdepth = parseInt(args[++i], 10);
      else throw userErr(`find: unknown predicate '${args[i]}' (this terminal knows -name, -type f|d and -maxdepth)`);
    }
    const out = [];
    for (const p of paths) {
      const abs = ctx.fs.resolve(p);
      const root = ctx.fs.get(abs);
      if (!root) {
        ctx.err(`find: '${p}': No such file or directory\n`);
        continue;
      }
      const show = (full) => (full === abs ? p : p.replace(/\/$/, '') + full.slice(abs.length));
      const consider = (full, e, depth) => {
        const base = full.split('/').pop();
        if ((!type || (type === 'd' ? e.kind === 'dir' : e.kind !== 'dir')) && (!name || name.test(base))) out.push(show(full));
        if (e.kind === 'dir' && depth < maxdepth) ctx.fs.list(full).forEach((c) => consider(c.path, c.entry, depth + 1));
      };
      consider(abs, root, 0);
    }
    if (out.length) ctx.out(out.join('\n') + '\n');
  };

  /* ------------------------------------------------------------------ Python, pip */
  const pyVersion = () => (MG.py && MG.py.versions && MG.py.versions.python) || '3.13.2';
  async function runPython(ctx) {
    const a = ctx.args;
    if (a[0] === '--version' || a[0] === '-V') {
      ctx.out(`Python ${pyVersion()}\n`);
      return 0;
    }
    if (a[0] === '-m' && (a[1] === 'pip' || a[1] === 'venv')) {
      if (a[1] === 'pip') return B.pip(Object.assign({}, ctx, { args: a.slice(2) }));
      ctx.err('The venv module cannot create folders of programs in this browser. Environments here are made with conda:  conda create -n NAME python pandas\n');
      return 1;
    }
    if (!MG.py) throw userErr('python: Python is not available on this page');
    if (a.length) unsavedNote(ctx);
    return MG.py.term('python', a, ctx);
  }
  B.python = runPython;
  B.python3 = runPython;

  const PIP_PKGS = () => {
    const env = MG.conda.envs[MG.conda.active];
    const names = MG.conda.packages(MG.conda.active).filter((p) => MG.conda.CATALOGUE[p].py && p !== 'python');
    return names.map((n) => ({ name: n === 'pyyaml' ? 'PyYAML' : n, version: MG.conda.CATALOGUE[n].v })).concat(env && env.pkgs.includes('snakemake') ? [{ name: 'snakemake', version: '9.27.0' }] : []);
  };
  B.pip = async (ctx) => {
    const [sub, ...rest] = ctx.args;
    if (!sub || sub === '--help' || sub === '-h') {
      ctx.out('Usage:\n  pip <command> [options]\n\nCommands:\n  list      List installed packages.\n  freeze    Output installed packages in requirements format.\n  show      Show information about installed packages.\n  install   Install packages (not available in this browser).\n');
      return 0;
    }
    if (sub === '--version' || sub === '-V') {
      ctx.out(`pip 25.0 from ${MG.conda.prefix(MG.conda.active)}/lib/python3.13/site-packages/pip (python 3.13)\n`);
      return 0;
    }
    const pkgs = PIP_PKGS().sort((x, y) => x.name.toLowerCase().localeCompare(y.name.toLowerCase()));
    if (sub === 'list') {
      const w = Math.max(7, ...pkgs.map((p) => p.name.length));
      ctx.out(`${'Package'.padEnd(w)} Version\n${'-'.repeat(w)} ${'-'.repeat(11)}\n` + pkgs.map((p) => `${p.name.padEnd(w)} ${p.version}`).join('\n') + '\n');
      return 0;
    }
    if (sub === 'freeze') {
      ctx.out(pkgs.map((p) => `${p.name}==${p.version}`).join('\n') + '\n');
      return 0;
    }
    if (sub === 'show') {
      let code = 0;
      rest.forEach((n, i) => {
        const p = pkgs.find((x) => x.name.toLowerCase() === n.toLowerCase());
        if (!p) {
          ctx.err(`WARNING: Package(s) not found: ${n}\n`);
          code = 1;
          return;
        }
        ctx.out(`${i ? '---\n' : ''}Name: ${p.name}\nVersion: ${p.version}\nLocation: ${MG.conda.prefix(MG.conda.active)}/lib/python3.13/site-packages\n`);
      });
      return code;
    }
    if (sub === 'install' || sub === 'uninstall') {
      ctx.err(`ERROR: pip ${sub} needs to download packages from the internet, which this browser's Python cannot do.\n`);
      ctx.io.note('The packages this practical needs are already installed (pip list). On your own computer, record what you install – for example in environment.yml – so that others can reproduce it.');
      return 1;
    }
    throw userErr(`ERROR: unknown command "${sub}"`);
  };
  B.pip3 = B.pip;

  /* ------------------------------------------------------------------ conda / mamba */
  const C = () => MG.conda;
  function envTable() {
    const names = Object.keys(C().envs).sort((a, b) => (a === 'base' ? -1 : b === 'base' ? 1 : a.localeCompare(b)));
    const w = Math.max(24, ...names.map((n) => n.length + 2));
    return '# conda environments:\n#\n' + names.map((n) => `${n.padEnd(w)} ${n === C().active ? '*' : ' '}  ${C().prefix(n)}`).join('\n') + '\n\n';
  }
  function listTable(name) {
    const pk = C().packages(name);
    const rows = pk.map((p) => {
      const c = C().CATALOGUE[p];
      const vb = C().version(name, p);
      return `${p.padEnd(25)} ${vb.v.padEnd(15)} ${vb.build.padStart(15)}    ${c.ch}`;
    });
    return `# packages in environment at ${C().prefix(name)}:\n#\n# Name                    Version                   Build  Channel\n` + rows.join('\n') + '\n';
  }
  function exportYaml(name, fromHistory) {
    const env = C().envs[name];
    const deps = fromHistory ? env.specs.filter((s) => s !== 'conda') : C().packages(name).map((p) => {
      const vb = C().version(name, p);
      return `${p}=${vb.v}=${vb.build}`;
    });
    return `name: ${name}\nchannels:\n${env.channels.map((c) => '  - ' + c).join('\n')}\ndependencies:\n${deps.map((d) => '  - ' + d).join('\n')}\nprefix: ${C().prefix(name)}\n`;
  }
  function planText(name, specs, channels, pkgs, pins) {
    const lines = [];
    lines.push('Channels:');
    (channels.length ? channels : ['conda-forge', 'bioconda']).forEach((c) => lines.push(' - ' + c));
    lines.push('Platform: linux-64 (in your web browser)');
    lines.push('Collecting package metadata (repodata.json): done');
    lines.push('Solving environment: done');
    lines.push('');
    lines.push('## Package Plan ##');
    lines.push('');
    lines.push(`  environment location: ${C().prefix(name)}`);
    lines.push('');
    lines.push('  added / updated specs:');
    specs.forEach((s) => lines.push('    - ' + s));
    lines.push('');
    lines.push('');
    lines.push('The following NEW packages will be INSTALLED:');
    lines.push('');
    const all = new Set();
    const add = (p) => {
      const c = C().CATALOGUE[p];
      if (!c || all.has(p)) return;
      all.add(p);
      (c.deps || []).forEach(add);
    };
    pkgs.forEach(add);
    Array.from(all).sort().forEach((p) => {
      const c = C().CATALOGUE[p];
      const v = (pins && pins[p]) || c.v;
      const build = v === c.v ? c.build : (c.alt || {})[v] || c.build;
      lines.push(`  ${p.padEnd(18)} ${c.ch}/linux-64::${p}-${v}-${build}`);
    });
    lines.push('');
    return lines.join('\n') + '\n';
  }
  /* conda's message when two packages need different versions of the same library */
  function conflictText(all, channels) {
    const conflicts = all.filter((c) => c.lib === all[0].lib); // conda reports one problem at a time
    const lines = ['Channels:'].concat((channels && channels.length ? channels : ['conda-forge', 'bioconda']).map((c) => ' - ' + c));
    lines.push('Platform: linux-64', 'Collecting package metadata (repodata.json): done', 'Solving environment: failed', '');
    lines.push('LibMambaUnsatisfiableError: Encountered problems while solving:');
    const tools = conflicts.filter((c) => c.pkg !== c.lib);
    const pin = conflicts.find((c) => c.pkg === c.lib);
    const loser = tools[tools.length - 1];
    lines.push(`  - package ${loser.text}, but none of the providers can be installed`, '', 'Could not solve for environment specs', 'The following packages are incompatible');
    const rows = [];
    if (pin) rows.push([pin.spec, 'is requested and can be installed;']);
    tools.forEach((c, i) => {
      const last = i === tools.length - 1;
      rows.push([c.spec, last ? 'is not installable because it requires' : 'is installable and it requires', `${c.lib} >=${c.range[0]},<${c.range[1]}.0a0 *, ${last ? 'which conflicts with any installable versions previously reported.' : 'which can be installed;'}`]);
    });
    rows.forEach((r, i) => {
      const end = i === rows.length - 1;
      lines.push(`${end ? '└─' : '├─'} ${r[0]} ${r[1]}`);
      if (r[2]) lines.push(`${end ? '   ' : '│  '}└─ ${r[2]}`);
    });
    return lines.join('\n') + '\n\n';
  }
  function notFound(problems) {
    return `\nPackagesNotFoundError: The following packages are not available from current channels:\n\n${problems.join('\n')}\n\nCurrent channels:\n\n  - https://conda.anaconda.org/conda-forge\n  - https://conda.anaconda.org/bioconda\n\n`;
  }
  async function condaCmd(ctx) {
    const args = ctx.args.slice();
    const sub = args.shift();
    const cmdName = ctx.name || 'conda';
    const opt = (names) => {
      for (const n of names) {
        const i = args.indexOf(n);
        if (i >= 0) {
          const v = args[i + 1];
          args.splice(i, 2);
          return v;
        }
        const j = args.findIndex((a) => a.startsWith(n + '='));
        if (j >= 0) {
          const v = args[j].split('=').slice(1).join('=');
          args.splice(j, 1);
          return v;
        }
      }
      return null;
    };
    const flag = (names) => {
      let hit = false;
      names.forEach((n) => {
        const i = args.indexOf(n);
        if (i >= 0) {
          args.splice(i, 1);
          hit = true;
        }
      });
      return hit;
    };
    if (!sub || sub === '-h' || sub === '--help') {
      ctx.out(`usage: ${cmdName} [-h] [-v] [--version] COMMAND ...\n\ncommands:\n  activate     Activate a conda environment.\n  deactivate   Deactivate the current active conda environment.\n  create       Create a new conda environment from a list of specified packages.\n  env          See \`conda env --help\` (create -f, export, list, remove).\n  info         Display information about current conda install.\n  install      Install a list of packages into a specified conda environment.\n  list         List installed packages in a conda environment.\n  remove       Remove a list of packages from a specified conda environment.\n  search       Search for packages and display associated information.\n`);
      return 0;
    }
    if (sub === '--version' || sub === '-V') {
      ctx.out(`${cmdName === 'mamba' ? 'mamba 2.3.2\nconda' : 'conda'} ${C().VERSION}\n`);
      return 0;
    }
    if (sub === 'activate') {
      const name = args.filter((a) => !a.startsWith('-'))[0] || 'base';
      const n = C().envs[name] ? name : Object.keys(C().envs).find((k) => C().prefix(k) === name);
      if (!n) {
        ctx.err(`\nEnvironmentNameNotFound: Could not find conda environment: ${name}\nYou can list all discoverable environments with \`conda info --envs\`.\n\n`);
        return 1;
      }
      if (C().active !== n) C().stack.push(n);
      if (C().stack.length > 6) C().stack.splice(1, C().stack.length - 6);
      C().save();
      MG.bus.emit('conda:activate', { name: n });
      return 0;
    }
    if (sub === 'deactivate') {
      if (C().stack.length > 1) C().stack.pop();
      C().save();
      MG.bus.emit('conda:deactivate', { name: C().active });
      return 0;
    }
    if (sub === 'info') {
      if (flag(['--envs', '-e'])) {
        ctx.out(envTable());
        return 0;
      }
      ctx.out(`\n     active environment : ${C().active}\n    active env location : ${C().prefix(C().active)}\n       user config file : /home/student/.condarc\n          conda version : ${C().VERSION}\n       python version : ${pyVersion()}\n       base environment : ${C().ROOT}  (writable)\n           channel URLs : https://conda.anaconda.org/conda-forge/linux-64\n                          https://conda.anaconda.org/bioconda/linux-64\n               platform : linux-64 (WebAssembly in your browser)\n\n`);
      return 0;
    }
    if (sub === 'list') {
      const name = opt(['-n', '--name']) || C().active;
      if (!C().envs[name]) {
        ctx.err(`\nEnvironmentLocationNotFound: Not a conda environment: ${C().prefix(name)}\n\n`);
        return 1;
      }
      if (flag(['--export', '-e'])) {
        ctx.out(`# This file may be used to create an environment using:\n# $ conda create --name <env> --file <this file>\n# platform: linux-64\n` + C().packages(name).map((p) => {
          const vb = C().version(name, p);
          return `${p}=${vb.v}=${vb.build}`;
        }).join('\n') + '\n');
        return 0;
      }
      const pat = args.filter((a) => !a.startsWith('-'))[0];
      let text = listTable(name);
      if (pat) text = text.split('\n').filter((l) => l.startsWith('#') || l.includes(pat)).join('\n') + '\n';
      ctx.out(text);
      if (name === 'pipelines' && !pat) ctx.io.note(PIPELINES_NOTE);
      return 0;
    }
    if (sub === 'search') {
      const q = args.filter((a) => !a.startsWith('-'))[0] || '';
      const name = q.split(/[=<>]/)[0];
      const hits = Object.keys(C().CATALOGUE).filter((k) => !C().CATALOGUE[k].dep && k.includes(name));
      if (!hits.length) {
        ctx.err(notFound([`  - ${q}`]));
        return 1;
      }
      ctx.out('Loading channels: done\n# Name                       Version           Build  Channel\n' + hits.map((k) => `${k.padEnd(28)} ${C().CATALOGUE[k].v.padEnd(17)} ${C().CATALOGUE[k].build.padEnd(6)} ${C().CATALOGUE[k].ch}`).join('\n') + '\n');
      ctx.io.note('A real conda search lists every published version; this browser has exactly one version of each program.');
      return 0;
    }
    if (sub === 'env') {
      const sub2 = args.shift();
      if (sub2 === 'list') {
        ctx.out(envTable());
        return 0;
      }
      if (sub2 === 'export') {
        const name = opt(['-n', '--name']) || C().active;
        const hist = flag(['--from-history']);
        const file = opt(['-f', '--file']);
        if (!C().envs[name]) {
          ctx.err(`\nEnvironmentLocationNotFound: Not a conda environment: ${C().prefix(name)}\n\n`);
          return 1;
        }
        const y = exportYaml(name, hist);
        if (file) ctx.fs.writeText(file, y);
        else ctx.out(y);
        if (name === 'pipelines') ctx.io.note(PIPELINES_NOTE);
        MG.bus.emit('conda:export', { name, fromHistory: hist });
        return 0;
      }
      if (sub2 === 'remove') {
        const name = opt(['-n', '--name']);
        flag(['-y', '--yes']);
        return removeEnv(ctx, name);
      }
      if (sub2 === 'create') {
        const file = opt(['-f', '--file']) || 'environment.yml';
        let name = opt(['-n', '--name']);
        flag(['-y', '--yes']);
        let text;
        try {
          text = await ctx.fs.readText(file);
        } catch (e) {
          ctx.err(`\nEnvironmentFileNotFound: '${ctx.fs.resolve(file)}' file not found\n\n`);
          return 1;
        }
        const y = parseEnvYaml(text);
        if (!y) {
          ctx.err(`\nEnvironmentFileNotFound or invalid YAML: ${file} needs  name:,  channels:  and  dependencies:\n\n`);
          return 1;
        }
        name = name || y.name;
        if (!name) {
          ctx.err('\nCondaValueError: the environment file has no name: – give one with  -n NAME\n\n');
          return 1;
        }
        return createEnv(ctx, name, y.deps, y.channels, true);
      }
      ctx.err(`usage: conda env [-h] {create,export,list,remove} ...\n`);
      return 2;
    }
    if (sub === 'create') {
      const name = opt(['-n', '--name']);
      const channels = [];
      let ch;
      while ((ch = opt(['-c', '--channel']))) channels.push(ch);
      const file = opt(['--file']);
      flag(['-y', '--yes', '--quiet', '-q']);
      if (!name) {
        ctx.err('\nCondaValueError: one of the arguments -n/--name -p/--prefix is required\n\n');
        return 2;
      }
      let specs = args.filter((a) => !a.startsWith('-'));
      if (file) specs = specs.concat(linesOf(await ctx.fs.readText(file)).filter((l) => l.trim() && !l.startsWith('#')));
      return createEnv(ctx, name, specs, channels, false);
    }
    if (sub === 'install') {
      const name = opt(['-n', '--name']) || C().active;
      const channels = [];
      let ch;
      while ((ch = opt(['-c', '--channel']))) channels.push(ch);
      flag(['-y', '--yes', '--quiet', '-q']);
      const specs = args.filter((a) => !a.startsWith('-'));
      if (!C().envs[name]) {
        ctx.err(`\nEnvironmentLocationNotFound: Not a conda environment: ${C().prefix(name)}\n\n`);
        return 1;
      }
      const env0 = C().envs[name];
      const r = C().solve(env0.specs.filter((x) => x !== 'conda').concat(specs));
      if (r.problems.length) {
        ctx.err(notFound(r.problems));
        ctx.io.note('On a real computer conda would download these from the internet. This browser has exactly one version of each program: see  conda search NAME');
        return 1;
      }
      if (r.conflicts.length && name !== 'pipelines') {
        ctx.err(conflictText(r.conflicts, channels));
        ctx.io.note(conflictNote(r.conflicts));
        return 1;
      }
      ctx.out(planText(name, specs, channels, r.pkgs, r.pins) + '\nProceed ([y]/n)? y\n\nDownloading and Extracting Packages: done\nPreparing transaction: done\nVerifying transaction: done\nExecuting transaction: done\n');
      const env = C().envs[name];
      env.specs = Array.from(new Set(env.specs.concat(specs)));
      env.pkgs = Array.from(new Set(env.pkgs.concat(r.pkgs)));
      env.pins = Object.assign({}, env.pins || {}, r.pins);
      C().save();
      r.notes.forEach((n) => ctx.io.note(n));
      return 0;
    }
    if (sub === 'remove' || sub === 'uninstall') {
      const name = opt(['-n', '--name']) || C().active;
      flag(['-y', '--yes']);
      if (flag(['--all'])) return removeEnv(ctx, name);
      const env = C().envs[name];
      if (!env) {
        ctx.err(`\nEnvironmentLocationNotFound: Not a conda environment: ${C().prefix(name)}\n\n`);
        return 1;
      }
      const names = args.filter((a) => !a.startsWith('-'));
      env.pkgs = env.pkgs.filter((p) => !names.includes(p));
      env.specs = env.specs.filter((s) => !names.includes(s.split(/[=<>]/)[0]));
      C().save();
      ctx.out(`\n## Package Plan ##\n\n  environment location: ${C().prefix(name)}\n\n  removed specs:\n${names.map((n) => '    - ' + n).join('\n')}\n\nPreparing transaction: done\nVerifying transaction: done\nExecuting transaction: done\n`);
      return 0;
    }
    if (sub === 'config' || sub === 'init' || sub === 'update' || sub === 'clean') {
      ctx.io.note(`conda ${sub} is not needed in this browser practical.`);
      return 0;
    }
    ctx.err(`${cmdName}: error: argument COMMAND: invalid choice: '${sub}'\n`);
    return 2;
  }
  const PIPELINES_NOTE = 'The pipelines environment exists only in this browser, where every program brings its own copies of htslib and zlib, so one environment can hold them all. On a real computer Python 3.13 and these old tool versions could not share one environment (chapter 6).';
  function conflictNote(all) {
    const lib = all[0].lib;
    const conflicts = all.filter((c) => c.lib === lib);
    const pin = conflicts.find((c) => c.pkg === c.lib);
    const tools = conflicts.filter((c) => c.pkg !== c.lib);
    const C = MG.conda.CATALOGUE;
    const cmp = (a, b) => (MG.conda.versionOk(a, '>', b) ? 1 : MG.conda.versionOk(a, '==', b) ? 0 : -1);
    const libName = lib === 'libzlib' ? 'zlib' : lib;
    const nice = (p) => (p === 'python' ? 'Python ' + C[p].v.split('.').slice(0, 2).join('.') : `${p} ${C[p].v}`);
    const join = (xs) => (xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]);
    // which bound decides: the lowest upper bound, or the highest lower bound
    const minHi = tools.map((c) => c.range[1]).reduce((a, b) => (cmp(a, b) <= 0 ? a : b));
    const older = tools.filter((c) => !pin && c.range[1] === minHi && tools.some((o) => cmp(o.range[0], minHi) >= 0));
    const newer = tools.filter((c) => !older.includes(c));
    const parts = [];
    if (older.length) parts.push(`${join(older.map((c) => nice(c.pkg)))} ${older.length > 1 ? 'need' : 'needs'} ${libName} older than ${minHi}${lib === 'libzlib' ? ' (these builds were made with zlib 1.2)' : ''}`);
    newer.forEach((c) => parts.push(`${nice(c.pkg)} needs ${libName} ${c.range[0]} or newer`));
    const why = parts.join(older.length ? ', but ' : '; ');
    return `An environment holds ONE version of each library. ${why}${pin ? `, but you asked for exactly ${libName} ${pin.v}` : ''}. Put them in separate environments (in a Snakefile: a different conda: file for each rule).`;
  }
  function createEnv(ctx, name, specs, channels, fromFile) {
    if (!/^[\w.\-]+$/.test(name)) {
      ctx.err(`\nCondaValueError: Invalid environment name: '${name}'\n\n`);
      return 1;
    }
    if (C().envs[name]) {
      ctx.err(`\nCondaValueError: prefix already exists: ${C().prefix(name)}\n\n`);
      ctx.io.note(`Remove it first with  conda env remove -n ${name}  – or choose another name.`);
      return 1;
    }
    const r = C().solve(specs);
    if (r.problems.length) {
      ctx.err('Channels:\n' + (channels.length ? channels : ['conda-forge', 'bioconda']).map((c) => ' - ' + c).join('\n') + '\nPlatform: linux-64\nCollecting package metadata (repodata.json): done\nSolving environment: failed\n' + notFound(r.problems));
      ctx.io.note('On a real computer conda downloads the versions you ask for. This browser has exactly one version of each program (see  conda search samtools) – so pin the versions that are here.');
      MG.bus.emit('conda:create', { name, ok: false });
      return 1;
    }
    if (r.conflicts.length) {
      ctx.err(conflictText(r.conflicts, channels));
      ctx.io.note(conflictNote(r.conflicts));
      MG.bus.emit('conda:create', { name, ok: false, conflict: true });
      return 1;
    }
    ctx.out(planText(name, specs, channels, r.pkgs, r.pins) + (fromFile ? '' : '\nProceed ([y]/n)? y\n') + '\nDownloading and Extracting Packages: done\nPreparing transaction: done\nVerifying transaction: done\nExecuting transaction: done\n#\n# To activate this environment, use\n#\n#     $ conda activate ' + name + '\n#\n# To deactivate an active environment, use\n#\n#     $ conda deactivate\n\n');
    C().create(name, specs, channels);
    r.notes.forEach((n) => ctx.io.note(n));
    MG.bus.emit('conda:create', { name, ok: true, specs });
    return 0;
  }
  function removeEnv(ctx, name) {
    if (!name) {
      ctx.err('\nCondaValueError: no environment specified – use  -n NAME\n\n');
      return 2;
    }
    if (name === 'base' || name === 'pipelines') {
      ctx.err(`\nCondaEnvironmentError: cannot remove the environment '${name}' in this practical (you need it).\n\n`);
      return 1;
    }
    if (!C().envs[name]) {
      ctx.err(`\nEnvironmentLocationNotFound: Not a conda environment: ${C().prefix(name)}\n\n`);
      return 1;
    }
    if (C().stack.includes(name)) {
      ctx.err(`\nCondaEnvironmentError: cannot remove current environment. Deactivate and run conda remove again\n\n`);
      return 1;
    }
    delete C().envs[name];
    C().save();
    ctx.out(`\nRemove all packages in environment ${C().prefix(name)}:\n\nPreparing transaction: done\nVerifying transaction: done\nExecuting transaction: done\n`);
    return 0;
  }
  /* a small reader for environment.yml files: name, channels, dependencies (and pip:) */
  function parseEnvYaml(text) {
    const out = { name: null, channels: [], deps: [] };
    let section = null;
    let ok = false;
    for (const raw of linesOf(text)) {
      const line = raw.replace(/\s+#.*$/, '');
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const top = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
      if (top) {
        section = top[1];
        if (section === 'name') out.name = top[2].trim();
        ok = true;
        continue;
      }
      const item = /^\s*-\s*(.+)$/.exec(line);
      if (item && section === 'channels') out.channels.push(item[1].trim());
      else if (item && section === 'dependencies' && !/^pip\s*:/.test(item[1])) out.deps.push(item[1].trim());
    }
    return ok ? out : null;
  }
  MG.parseEnvYaml = parseEnvYaml;
  B.conda = condaCmd;
  B.mamba = condaCmd;
  B.micromamba = condaCmd;

  /* ------------------------------------------------------------------ snakemake */
  B.snakemake = async (ctx) => {
    if (!MG.py) throw userErr('snakemake: Python is not available on this page');
    unsavedNote(ctx);
    return MG.py.term('smk', ctx.args, ctx);
  };

  /* ------------------------------------------------------------------ dot (Graphviz, via viz.js) */
  let vizP = null;
  MG.viz = () => {
    if (!vizP) {
      vizP = new Promise((resolve, reject) => {
        const go = () => window.Viz.instance().then(resolve, reject);
        if (window.Viz) return go();
        const s = document.createElement('script');
        s.src = 'assets/vendor/viz/viz-global.js';
        s.onload = go;
        s.onerror = () => reject(new Error('could not load Graphviz'));
        document.head.appendChild(s);
      });
      vizP.catch(() => (vizP = null));
    }
    return vizP;
  };
  MG.svgToPng = (svg, scale = 2) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        const g = c.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG failed'))), 'image/png');
      };
      img.onerror = () => reject(new Error('could not draw the SVG'));
      img.src = url;
    });
  B.dot = async (ctx) => {
    let fmt = 'dot', outFile = null, engine = 'dot';
    const files = [];
    const a = ctx.args;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (/^-T/.test(x)) fmt = x.length > 2 ? x.slice(2) : a[++i];
      else if (/^-o/.test(x)) outFile = x.length > 2 ? x.slice(2) : a[++i];
      else if (/^-K/.test(x)) engine = x.length > 2 ? x.slice(2) : a[++i];
      else if (x === '-V' || x === '--version') {
        const v = await MG.viz();
        ctx.err(`dot - graphviz version ${v.graphvizVersion} (viz.js, WebAssembly)\n`);
        return 0;
      } else if (x.startsWith('-')) throw userErr(`dot: option ${x} is not available in this terminal (use -Tsvg, -Tpng and -o FILE)`);
      else files.push(x);
    }
    fmt = (fmt || 'dot').split(':')[0];
    let src = '';
    if (files.length) {
      for (const f of files) src += await ctx.fs.readText(f).catch(() => {
        throw userErr(`Error: dot: can't open ${f}`);
      });
    } else if (ctx.stdin != null) src = new TextDecoder().decode(await stdinBytes(ctx));
    else throw userErr('dot: reading from the keyboard is not available here – give a file, or pipe:  snakemake --dag | dot -Tsvg > dag.svg');
    if (!src.trim()) throw userErr('Error: <stdin>: syntax error in line 1 near \'\' (the input is empty)');
    const viz = await MG.viz();
    const textFormats = ['svg', 'dot', 'gv', 'plain', 'plain-ext', 'json', 'json0', 'xdot', 'canon', 'ps', 'eps'];
    if (!textFormats.includes(fmt) && fmt !== 'png') {
      ctx.err(`Format: "${fmt}" not recognized. Use one of: canon dot eps gv json json0 plain plain-ext png ps svg xdot\n`);
      if (fmt === 'pdf') ctx.io.note('PDF output needs a Graphviz with Cairo, which this browser does not have. Use -Tsvg (or -Tpng); SVG opens in any web browser and prints to PDF.');
      return 1;
    }
    const r = viz.render(src, { format: fmt === 'png' ? 'svg' : fmt, engine });
    if (r.status !== 'success') {
      const msgs = (r.errors || []).map((e) => (e.level ? e.level[0].toUpperCase() + e.level.slice(1) + ': ' : '') + e.message.trim());
      ctx.err((msgs.join('\n') || 'Error: could not draw the graph') + '\n');
      return 1;
    }
    const target = outFile || ctx.redirectTarget;
    if (fmt === 'png') {
      if (!target) {
        ctx.io.note('PNG is a binary format – save it to a file:  ... | dot -Tpng > dag.png');
        return 1;
      }
      const blob = await MG.svgToPng(r.output, 2);
      if (target !== '/dev/null') ctx.fs.put(target, { kind: 'blob', blob, size: blob.size, fresh: true });
      if (!outFile) ctx.wroteRedirect = true;
    } else if (outFile) ctx.fs.writeText(outFile, r.output);
    else ctx.out(r.output);
    MG.bus.emit('dot:render', { format: fmt, file: target ? ctx.fs.resolve(target) : null });
    return 0;
  };

  /* ------------------------------------------------------------------ open, edit */
  B.open = B['xdg-open'] = async (ctx) => {
    const f = ctx.args.filter((a) => !a.startsWith('-'))[0];
    if (!f) throw userErr('usage: open FILE   (shows a file: pictures, SVG, text, tables)');
    const e = ctx.fs.get(f);
    if (!e) throw userErr(`open: ${f}: No such file or directory`);
    if (MG.app && MG.app.openFile) await MG.app.openFile(ctx.fs.resolve(f));
    return 0;
  };
  const edit = async (ctx) => {
    const f = ctx.args.filter((a) => !a.startsWith('-') && !a.startsWith('+'))[0];
    if (!f) throw userErr(`usage: ${ctx.name} FILE   (opens the file in the Editor tab)`);
    const abs = ctx.fs.resolve(f);
    if (ctx.fs.isDir(abs)) throw userErr(`${ctx.name}: ${f} is a directory`);
    if (!ctx.fs.isDir(MG.path.dirname(abs))) throw userErr(`${ctx.name}: ${MG.path.dirname(f)}: No such directory (make it with  mkdir -p ${MG.path.dirname(f)})`);
    if (MG.app && MG.app.editFile) await MG.app.editFile(abs, { create: true });
    ctx.io.note(`${f} is open in the Editor tab. Save with Ctrl+S (⌘+S on a Mac).`);
    return 0;
  };
  ['nano', 'vim', 'vi', 'emacs', 'edit', 'code', 'gedit', 'pico'].forEach((n) => (B[n] = edit));

  /* help: add this practical's commands */
  const helpOrig = B.help;
  B.help = (ctx) => {
    ctx.out(
      [
        'Commands available in this terminal',
        '',
        'Workflow and environments:',
        '  snakemake    Snakemake 9 (browser teaching edition): snakemake -n, snakemake --cores 1, --dag, --summary',
        '  conda        environments: conda env list, conda activate NAME, conda list, conda env export, conda create',
        '  python       run a Python script: python script.py (the Notebook tab is for interactive Python)',
        '  pip          pip list, pip freeze',
        '  dot          Graphviz: snakemake --dag | dot -Tsvg > dag.svg',
        '',
        'Bioinformatics (real programs compiled to WebAssembly):',
        '  minimap2 2.22, samtools 1.17, bcftools 1.10, bgzip / tabix (htslib 1.17)',
        '',
        'Files and text:',
        '  ls, cd, pwd, mkdir, cp, mv, rm, touch, cat, less, head, tail, wc, grep, sed, awk, cut, sort, uniq,',
        '  zcat, tree, find, md5sum, sha256sum, chmod, basename, dirname, open FILE (view), nano FILE (edit)',
        '  bash script.sh   run a script    ·   set -euo pipefail   stop scripts at the first error',
        '',
        'Shell: quotes, $VAR, globs (* ?), |, &&, ||, ;, >, >>, <, 2>, 2>&1. No loops or $( ) on the command line.',
        'Tips: ↑/↓ recall commands · Tab completes names · Ctrl+C stops after the current program · man TOOL',
        ''
      ].join('\n')
    );
  };
  void helpOrig;
})();
