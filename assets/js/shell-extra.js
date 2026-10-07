/* =====================================================================
   More commands for the terminal, written in JavaScript:
   sha256sum, chmod, find, basename, dirname, realpath, sleep, od, xxd,
   base64, split, bc …, open and nano (the Files tab), help.
   (diff and cmp are the GNU programs: tools-wasm.js.)
   (md5sum is the GNU program; MG.md5 here is for the agent's run records.)
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const B = MG.shellBuiltins;
  const { getopts, userErr, linesOf } = MG.shellUtil;
  const enc = new TextEncoder();

  /* ------------------------------------------------------------------ bytes of the input */
  async function stdinBytes(ctx) {
    const s = ctx.stdin;
    // (what is piped in can be read once: a command that names its input twice – diff - /dev/stdin – finds it
    // empty the second time, as on Linux)
    if (ctx.stdinTaken) return new Uint8Array(0);
    ctx.stdinTaken = true;
    if (s == null) {
      // the input of the block, the function or the script the command stands in (see inherited() in shell.js):
      // from its start, the bytes of the file itself
      const h = ctx.inherit;
      if (h && h.pos === 0 && h.path && h.text.length && ctx.fs.exists(h.path) && !ctx.fs.isDir(h.path)) {
        h.pos = h.text.length;
        return await ctx.fs.readBytes(h.path);
      }
      const rest = MG.shellUtil.inherited(ctx);
      return rest == null ? new Uint8Array(0) : enc.encode(rest);
    }
    if (MG.FileRef && s instanceof MG.FileRef) return await MG.wasm.readBytes(s.apath);
    return enc.encode(String(s));
  }
  /** a file name in a message: as it is – in quotes when it holds a blank or another character special to the shell */
  const qf = (f) => (f === '' || /[^\w%+,\-./:=@^~#]/.test(f) || /^[~#]/.test(f) ? "'" + f.replace(/'/g, "'\\''") + "'" : f);
  async function fileBytes(ctx, f, cmd) {
    if (f === '/dev/null') return new Uint8Array(0);
    if (f === '/dev/stdin') return stdinBytes(ctx);
    const e = f === '' ? null : ctx.fs.get(f);
    if (!e) throw userErr(`${cmd}: ${qf(f)}: No such file or directory`);
    if (e.kind === 'dir') throw userErr(`${cmd}: ${qf(f)}: Is a directory`);
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

  /* sha256sum, sha1sum, sha384sum, sha512sum [-b] [--tag] [-z] [FILE…]: the checksum of each file (- or no file: the
     input).  -c LIST: check the files named in a list of checksums – [--quiet] only what failed, [--status] nothing
     but the exit status, [-w] say which lines are no checksum lines, [--strict] such lines count as a failure,
     [--ignore-missing] files that are not there are left out. (md5sum is the GNU program itself.) */
  function hashCommand(name, fn, hexLen) {
    const ALGO = name.replace(/sum$/, '').toUpperCase();
    return async (ctx) => {
      const { opts, rest } = getopts(ctx.args, 'cbtwz', { check: 'c', binary: 'b', text: 't', quiet: 'q', status: 's', warn: 'w', strict: 'S', 'ignore-missing': 'i', tag: 'T', zero: 'z' }, 'qsSiT');
      const usage = (msg) => userErr(`${name}: ${msg}\nTry '${name} --help' for more information.`);
      if (opts.T && opts.c) throw usage('the --tag option is meaningless when verifying checksums');
      for (const [k, long] of [['s', 'status'], ['w', 'warn'], ['q', 'quiet'], ['S', 'strict'], ['i', 'ignore-missing']]) if (opts[k] && !opts.c) throw usage(`the --${long} option is meaningful only when verifying checksums`);
      // (a name with a backslash or a newline in it is written with \\ and \n, and the line begins with a backslash)
      const escaped = (f) => (/[\\\n\r]/.test(f) && !opts.z ? f.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r') : null);
      if (opts.c) {
        const lists = rest.length ? rest : ['-'];
        let code = 0;
        for (const lf of lists) {
          const shown = lf === '-' ? "'standard input'" : lf;
          let text;
          if (lf === '-') text = new TextDecoder().decode(await stdinBytes(ctx));
          else {
            const le = ctx.fs.get(lf);
            if (!le || le.kind === 'dir') {
              ctx.err(`${name}: ${lf}: ${le ? 'Is a directory' : 'No such file or directory'}\n`);
              code = 1;
              continue;
            }
            text = await ctx.fs.readText(lf);
          }
          let bad = 0, unread = 0, n = 0, malformed = 0, verified = 0, lineNo = 0;
          for (const raw of text.split(opts.z ? '\0' : '\n')) {
            lineNo++;
            let line = raw.replace(/\r$/, '');
            if (line === '' || line[0] === '#') continue;
            const esc = line[0] === '\\';
            if (esc) line = line.slice(1);
            // HASH  NAME, HASH *NAME (binary), or the --tag form: SHA256 (NAME) = HASH
            let m = new RegExp(`^${ALGO} \\((.*)\\) = ([0-9a-fA-F]{${hexLen}})$`).exec(line), f, sum;
            if (m) (f = m[1]), (sum = m[2]);
            else if ((m = new RegExp(`^([0-9a-fA-F]{${hexLen}}) [ *]?(.+)$`).exec(line))) (f = m[2]), (sum = m[1]);
            else {
              malformed++;
              if (opts.w) ctx.err(`${name}: ${lf === '-' ? 'standard input' : lf}: ${lineNo}: improperly formatted ${ALGO} checksum line\n`);
              continue;
            }
            if (esc) f = f.replace(/\\(\\|n|r)/g, (x, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : '\\'));
            n++;
            let h;
            const fe = f === '-' ? { kind: 'text' } : ctx.fs.get(f);
            if (!fe || fe.kind === 'dir') {
              if (!fe && opts.i) continue;
              ctx.err(`${name}: ${f}: ${fe ? 'Is a directory' : 'No such file or directory'}\n`);
              if (!opts.s) ctx.out(`${f}: FAILED open or read\n`);
              unread++;
              continue;
            }
            try {
              h = await fn(f === '-' ? await stdinBytes(ctx) : await fileBytes(ctx, f, name));
            } catch (e) {
              ctx.err(`${name}: ${f}: No such file or directory\n`);
              if (!opts.s) ctx.out(`${f}: FAILED open or read\n`);
              unread++;
              continue;
            }
            if (h.toLowerCase() === sum.toLowerCase()) {
              verified++;
              if (!opts.q && !opts.s) ctx.out(`${f}: OK\n`);
            } else {
              if (!opts.s) ctx.out(`${f}: FAILED\n`);
              bad++;
            }
          }
          if (!n) {
            ctx.err(`${name}: ${shown}: no properly formatted checksum lines found\n`);
            code = 1;
            continue;
          }
          if (!opts.s) {
            if (malformed) ctx.err(`${name}: WARNING: ${malformed} line${malformed > 1 ? 's are' : ' is'} improperly formatted\n`);
            if (unread) ctx.err(`${name}: WARNING: ${unread} listed file${unread > 1 ? 's' : ''} could not be read\n`);
            if (bad) ctx.err(`${name}: WARNING: ${bad} computed checksum${bad > 1 ? 's' : ''} did NOT match\n`);
            if (opts.i && !verified) ctx.err(`${name}: ${lf === '-' ? 'standard input' : lf}: no file was verified\n`);
          }
          if (bad || unread || (opts.S && malformed) || (opts.i && !verified)) code = 1;
          MG.bus.emit('hash:check', { name, ok: !bad && !unread, n });
        }
        return code;
      }
      const files = rest.length ? rest : ['-'];
      let code = 0;
      for (const f of files) {
        let h;
        try {
          h = await fn(f === '-' ? await stdinBytes(ctx) : await fileBytes(ctx, f, name));
        } catch (e) {
          ctx.err((e.userMessage || e.message) + '\n');
          code = 1;
          continue;
        }
        const esc = escaped(f), shown = esc != null ? esc : f;
        ctx.out((esc != null ? '\\' : '') + (opts.T ? `${ALGO} (${shown}) = ${h}` : `${h} ${opts.b ? '*' : ' '}${shown}`) + (opts.z ? '\0' : '\n'));
      }
      MG.bus.emit('hash:made', { name, files });
      return code;
    };
  }
  B.sha256sum = hashCommand('sha256sum', sha256, 64);

  /* diff and cmp are the GNU programs (diffutils, compiled to WebAssembly): see tools-wasm.js */

  /** remind the student when the editor holds changes the command will not see */
  function unsavedNote(ctx) {
    const ed = MG.app && MG.app.editor;
    const d = ed && ed.dirtyPaths ? ed.dirtyPaths() : [];
    if (d.length) ctx.io.note(`Unsaved changes in the editor: ${d.map((p) => ctx.fs.pretty(p)).join(', ')}. Commands use the saved files – press Ctrl+S in the Files tab to save.`);
  }
  MG.unsavedNote = unsavedNote;

  /* ------------------------------------------------------------------ file */
  /* file [-b] [-i] [-N] [-0] [-E] [-F SEPARATOR] [-f NAMEFILE] FILE…: what kind of file it is, judged by its
     first bytes – as the file command of Linux judges (the words are those of its "magic" list): a script by its
     first line, text by its characters and line ends, BAM and .gz by their headers, pictures, archives. */
  const dec8 = new TextDecoder('utf-8', { fatal: true });
  const latin = (b, from, to) => String.fromCharCode.apply(null, Array.from(b.subarray(from, to)));
  /** what the bytes are → { text: the description, mime, charset } */
  function describeBytes(head, size, tail) {
    const b = head, n = b.length;
    const starts = (...sig) => sig.every((x, k) => b[k] === x);
    const u16 = (k) => b[k] | (b[k + 1] << 8), u32be = (k) => ((b[k] << 24) | (b[k + 1] << 16) | (b[k + 2] << 8) | b[k + 3]) >>> 0;
    const bin = (text, mime) => ({ text, mime: mime || 'application/octet-stream', charset: 'binary' });
    if (size === 1) return bin('very short file (no magic)');
    // ---- files that are known by their first bytes
    if (starts(0x1f, 0x8b)) {
      if (n >= 18 && b[3] & 4 && b[12] === 0x42 && b[13] === 0x43) return bin(`Blocked GNU Zip Format (BGZF; gzip compatible), block length ${u16(16) + 1}`, 'application/x-gzip');
      let s = 'gzip compressed data', k = 10;
      if (b[3] & 4) k += 2 + u16(10);
      if (b[3] & 8) {
        let e = k;
        while (e < n && b[e]) e++;
        s += `, was "${latin(b, k, e)}"`;
      }
      const t = (b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24)) >>> 0;
      if (t) s += ', last modified: ' + MG.shellUtil.strftime('%a %b %e %H:%M:%S %Y', t * 1000, 'UTC');
      if (b[8] === 2) s += ', max compression';
      else if (b[8] === 4) s += ', max speed';
      s += b[9] === 3 ? ', from Unix' : b[9] === 0 ? ', from FAT filesystem (MS-DOS, OS/2, NT)' : b[9] === 11 ? ', from NTFS filesystem (NT)' : b[9] === 7 ? ', from MacOS' : '';
      if (tail && tail.length === 4) s += `, original size modulo 2^32 ${(tail[0] | (tail[1] << 8) | (tail[2] << 16) | (tail[3] << 24)) >>> 0}`;
      return bin(s, 'application/gzip');
    }
    if (starts(0x42, 0x5a, 0x68) && b[3] >= 0x31 && b[3] <= 0x39) return bin(`bzip2 compressed data, block size = ${b[3] - 0x30}00k`, 'application/x-bzip2');
    if (starts(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return bin('XZ compressed data' + (b[7] === 4 ? ', checksum CRC64' : b[7] === 1 ? ', checksum CRC32' : b[7] === 10 ? ', checksum SHA-256' : b[7] === 0 ? ', checksum NONE' : ''), 'application/x-xz');
    if (starts(0x28, 0xb5, 0x2f, 0xfd)) return bin('Zstandard compressed data (v0.8+), Dictionary ID: None', 'application/zstd');
    if (starts(0x50, 0x4b, 0x03, 0x04) && n >= 30) return bin(`Zip archive data, at least v${Math.floor(b[4] / 10)}.${b[4] % 10} to extract, compression method=${u16(8) === 8 ? 'deflate' : u16(8) === 0 ? 'store' : 'unknown'}`, 'application/zip');
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) && n >= 29) {
      const color = { 0: 'grayscale', 2: '/color RGB', 3: 'colormap', 4: 'gray+alpha', 6: '/color RGBA' }[b[25]];
      return bin(`PNG image data, ${u32be(16)} x ${u32be(20)}, ${b[24]}-bit${color ? (color[0] === '/' ? color : ' ' + color) : ''}, ${b[28] ? 'interlaced' : 'non-interlaced'}`, 'image/png');
    }
    if (starts(0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return bin(`GIF image data, version 8${String.fromCharCode(b[4])}a, ${u16(6)} x ${u16(8)}`, 'image/gif');
    if (starts(0xff, 0xd8, 0xff)) return bin('JPEG image data', 'image/jpeg');
    if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return bin(`PDF document, version ${latin(b, 5, 8)}`, 'application/pdf');
    if (starts(0x7f, 0x45, 0x4c, 0x46)) return bin(`ELF ${b[4] === 2 ? '64' : '32'}-bit ${b[5] === 2 ? 'MSB' : 'LSB'} ${{ 1: 'relocatable', 2: 'executable', 3: 'shared object', 4: 'core file' }[b[5] === 2 ? b[17] : b[16]] || 'file'}`, 'application/x-executable');
    if (starts(0x42, 0x41, 0x49, 0x01)) return bin(`SAMtools BAI (BAM indexing format), with ${u16(4) | (u16(6) << 16)} reference sequences`);
    if (starts(0x43, 0x52, 0x41, 0x4d) && n >= 26) {
      let e = 6;
      while (e < 26 && b[e]) e++;
      return bin(`CRAM version ${b[4]}.${b[5]} (identified as ${latin(b, 6, e)})`);
    }
    if (n >= 263 && latin(b, 257, 262) === 'ustar') return bin(b[262] === 0x20 ? 'POSIX tar archive (GNU)' : 'POSIX tar archive', 'application/x-tar');
    // ---- text, by its characters: ASCII, UTF-8, ISO-8859 … – or data
    let ascii = true, ctrl = false, kind, charset, body = b;
    // (UTF-16 with its mark in front: looked at as the characters it spells)
    const wide = starts(0xff, 0xfe) ? 'little' : starts(0xfe, 0xff) ? 'big' : null;
    if (wide && n % 2 === 0) {
      const chars = [];
      for (let k = 2; k + 1 < n; k += 2) chars.push(wide === 'little' ? b[k] | (b[k + 1] << 8) : (b[k] << 8) | b[k + 1]);
      if (chars.every((c) => c >= 32 || (c >= 7 && c <= 10) || c === 12 || c === 13 || c === 27)) {
        kind = `Unicode text, UTF-16, ${wide}-endian text`;
        charset = `utf-16${wide === 'little' ? 'le' : 'be'}`;
        body = Uint8Array.from(chars, (c) => (c < 128 ? c : 0x41));
      }
    }
    for (let k = 0; k < n && !kind; k++) {
      const c = b[k];
      if (c >= 0x80) ascii = false;
      else if (!(c >= 32 && c <= 126) && !(c >= 7 && c <= 10) && c !== 12 && c !== 13 && c !== 27) {
        ctrl = true;
        break;
      }
    }
    if (kind) {
      /* UTF-16: see above */
    } else if (ctrl) return bin('data');
    else if (ascii) (kind = 'ASCII text'), (charset = 'us-ascii');
    else {
      let utf8 = true;
      try {
        // (the last character may be cut off where the look at the file ends)
        dec8.decode(size > n ? b.subarray(0, n - 4) : b);
      } catch (e) {
        utf8 = false;
      }
      if (utf8) {
        const bom = starts(0xef, 0xbb, 0xbf) && n > 3;
        kind = bom ? 'Unicode text, UTF-8 (with BOM) text' : 'Unicode text, UTF-8 text';
        charset = 'utf-8';
        if (bom) body = b.subarray(3);
      } else if (b.every((c) => c < 0x80 || c >= 0xa0)) (kind = 'ISO-8859 text'), (charset = 'iso-8859-1');
      else (kind = 'Non-ISO extended-ASCII text'), (charset = 'unknown-8bit');
    }
    // ---- what kind of text: a script (by its first line), JSON, CSV, HTML, XML …
    const start = latin(body, 0, Math.min(body.length, 4096));
    const firstLine = start.split(/\r?\n|\r/)[0];
    let sub = null, mime = 'text/plain', exec = false, plain = null;
    const whole = size <= n ? latin(body, 0, body.length) : null;
    if (whole != null && /^\s*[[{]/.test(whole)) {
      try {
        JSON.parse(charset === 'utf-8' ? dec8.decode(body) : whole);
        return { text: 'JSON text data', mime: 'application/json', charset };
      } catch (e) {
        /* no JSON */
      }
    }
    // (CSV, as file counts: the same number of commas – at least one – in each of the first ten lines, two lines or more)
    const csv = (() => {
      let nf = 0, tf = 0, nl = 0, quote = false;
      for (let k = 0; k < body.length; k++) {
        const c = body[k];
        if (quote) {
          if (c === 0x22) quote = false;
          continue;
        }
        if (c === 0x22) quote = true;
        else if (c === 0x2c) nf++;
        else if (c === 0x0a) {
          nl++;
          if (nl === 10) return tf !== 0 && tf === nf;
          if (tf === 0) {
            if (nf === 0) return false;
            tf = nf;
          } else if (tf !== nf) return false;
          nf = 0;
        }
      }
      return tf !== 0 && nl >= 2;
    })();
    const she = /^#! ?(\S+)(?:[ \t]+(.*))?$/.exec(firstLine);
    if (csv) (plain = 'CSV ' + kind), (mime = 'text/csv');
    else if (she) {
      // #!/bin/bash, #!/usr/bin/env python3 …
      const viaEnv = /(^|\/)env$/.test(she[1]) && she[2];
      const prog = viaEnv ? she[2].split(/\s+/)[0] : she[1], name = prog.split('/').pop();
      exec = true;
      mime = 'text/x-shellscript';
      if (/^bash$/.test(name) && firstLine.length < start.length) sub = 'Bourne-Again shell script';
      else if (/^(sh|dash|ash)$/.test(name)) sub = 'POSIX shell script';
      else if (/^zsh$/.test(name)) sub = "Paul Falstad's zsh script";
      else if (/^ksh$/.test(name)) sub = 'Korn shell script';
      else if (/^t?csh$/.test(name)) sub = name === 'csh' ? 'C shell script' : 'Tenex C shell script';
      else if (/^python[\d.]*$/.test(name)) (sub = 'Python script'), (mime = 'text/x-script.python');
      else if (/^perl[\d.]*$/.test(name)) return { text: 'Perl script text executable', mime: 'text/x-perl', charset };
      else if (/^ruby[\d.]*$/.test(name)) (sub = 'Ruby script'), (mime = 'text/x-ruby');
      else if (/^(awk|nawk|mawk)$/.test(name)) (sub = 'awk script'), (mime = 'text/x-awk');
      else if (name === 'gawk') (sub = 'GNU awk script'), (mime = 'text/x-gawk');
      else if (name === 'node' || name === 'nodejs') return { text: 'Node.js script executable, ' + kind, mime: 'application/javascript', charset };
      else (sub = `a ${viaEnv ? she[2] : she[1] + (she[2] ? ' ' + she[2] : '')} script`), (mime = 'text/plain');
    } else if (/^\s*(<!DOCTYPE html|<html)/i.test(start)) (sub = 'HTML document'), (mime = 'text/html');
    else if (/^<\?xml version="([\d.]+)"/.test(start)) {
      if (/<svg[\s>]/.test(start)) return { text: 'SVG Scalable Vector Graphics image', mime: 'image/svg+xml', charset };
      (sub = `XML ${/^<\?xml version="([\d.]+)"/.exec(start)[1]} document`), (mime = 'text/xml');
    } else if (/^<svg[\s>]/.test(start)) return { text: 'SVG Scalable Vector Graphics image', mime: 'image/svg+xml', charset };
    else if (/^##fileformat=VCFv([\d.]+)/.test(start)) sub = `Variant Call Format (VCF) version ${/^##fileformat=VCFv([\d.]+)/.exec(start)[1]}`;
    else if (/^@HD\t(.*\t)?VN:([\d.]+)/.test(firstLine)) return { text: `Sequence Alignment/Map (SAM), with header version ${/VN:([\d.]+)/.exec(firstLine)[1]}`, mime: 'text/plain', charset };
    else if (/^@SQ\tSN:/.test(firstLine)) return { text: 'Sequence Alignment/Map (SAM)', mime: 'text/plain', charset };
    else if (/^diff /.test(firstLine)) (sub = 'diff output'), (mime = 'text/x-diff');
    else if (/^--- .*\n\+\+\+ /.test(start)) (sub = 'unified diff output'), (mime = 'text/x-diff');
    else if (/^(\/\*[\s\S]*?\*\/\s*)?#include\s*[<"]/m.test(start)) (sub = 'C source'), (mime = 'text/x-c');
    let text = plain || (sub ? `${sub}, ${kind}${exec ? ' executable' : ''}` : kind);
    // ---- its lines: very long ones, and how they end
    let crlf = 0, cr = 0, lf = 0, longest = 0, cur = 0, esc = false, bs = false;
    for (let k = 0; k < body.length; k++) {
      const c = body[k];
      if (c === 0x0d || c === 0x0a) {
        if (c === 0x0d && body[k + 1] === 0x0a) {
          crlf++;
          k++;
        } else if (c === 0x0d) cr++;
        else lf++;
        longest = Math.max(longest, cur);
        cur = 0;
        continue;
      }
      cur++;
      if (c === 27) esc = true;
      else if (c === 8) bs = true;
    }
    longest = Math.max(longest, cur);
    if (longest > 300) text += `, with very long lines (${longest})`;
    if (!crlf && !cr && !lf) text += ', with no line terminators';
    else if (crlf || cr) text += `, with ${[crlf ? 'CRLF' : '', cr ? 'CR' : '', lf ? 'LF' : ''].filter(Boolean).join(', ')} line terminators`;
    if (esc) text += ', with escape sequences';
    if (bs) text += ', with overstriking';
    return { text, mime, charset };
  }
  B.file = async (ctx) => {
    let brief = false, mime = null, options = true, pad = true, sep = ':', nul = false, strict = false;
    const files = [];
    const usage = 'Usage: file [-bcCdEhikLlNnprsSvzZ0] [--apple] [--extension] [--mime-encoding]\n            [--mime-type] [-e <testname>] [-F <separator>]  [-f <namefile>]\n            [-m <magicfiles>] [-P <parameter=value>] [--exclude-quiet]\n            <file> ...\n       file -C [-m <magicfiles>]\n       file [--help]';
    const fromList = async (f) => {
      let text;
      try {
        text = f === '-' ? new TextDecoder().decode(await stdinBytes(ctx)) : await ctx.fs.readText(f);
      } catch (e) {
        throw userErr(`file: Cannot open \`${f}' (No such file or directory)`);
      }
      files.push(...linesOf(text));
    };
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!options || a === '-' || !a.startsWith('-')) files.push(a);
      else if (a === '--') options = false;
      else if (a === '--brief') brief = true;
      else if (a === '--mime') mime = 'full';
      else if (a === '--mime-type') mime = 'type';
      else if (a === '--mime-encoding') mime = 'encoding';
      else if (a === '--no-pad') pad = false;
      else if (a === '--print0') nul = true;
      else if (a === '--files-from') await fromList(args[++i] || '');
      else if (/^--files-from=/.test(a)) await fromList(a.slice(13));
      else if (/^--separator=/.test(a)) sep = a.slice(12);
      else if (/^--(dereference|no-dereference|keep-going|special-files|raw|preserve-date|no-buffer|uncompress|uncompress-noreport|exclude=.*|exclude-quiet=.*|no-sandbox)$/.test(a)) continue;
      else if (a.startsWith('--')) throw userErr(`file: unrecognized option '${a}'\n${usage}`);
      else {
        for (let j = 1; j < a.length; j++) {
          const c = a[j];
          const value = () => {
            const v = j + 1 < a.length ? a.slice(j + 1) : args[++i];
            if (v === undefined) throw userErr(`file: option requires an argument -- '${c}'\n${usage}`);
            j = a.length;
            return v;
          };
          if (c === 'b') brief = true;
          else if (c === 'i') mime = 'full';
          else if (c === 'N') pad = false;
          else if (c === '0') nul = true;
          else if (c === 'E') strict = true;
          else if (c === 'F') sep = value();
          else if (c === 'f') await fromList(value());
          else if (c === 'e' || c === 'm' || c === 'P') value();
          else if (!'kLhnprsSzZ'.includes(c)) throw userErr(`file: invalid option -- '${c}'\n${usage}`);
        }
      }
    }
    if (!files.length) throw userErr(usage);
    const width = pad ? Math.max(...files.map((f) => (f === '-' ? '/dev/stdin' : f).length)) + sep.length : 0;
    let code = 0;
    for (const f of files) {
      const shown = f === '-' ? '/dev/stdin' : f;
      const e = f === '-' ? null : f === '' ? null : ctx.fs.get(f) || MG.shellUtil.deviceEntry(ctx.fs, f);
      let d = null, type = 'text/plain', charset = 'us-ascii';
      const bin = (t) => {
        type = t;
        charset = 'binary';
      };
      try {
        if (f !== '-' && !e) {
          if (strict) {
            ctx.out(`${shown}: ERROR: cannot stat \`${f}' (No such file or directory)\n`);
            return 1;
          }
          d = `cannot open \`${f}' (${(ctx.fs.pathError && ctx.fs.pathError(f)) || 'No such file or directory'})`;
        } else if (e && e.kind === 'dir') (d = 'directory'), bin('inode/directory');
        else if (e && e.kind === 'dev') (d = `character special (${e.major}/${e.minor})`), bin('inode/chardevice');
        else if (e && e.kind === 'link') (d = `symbolic link to ${e.to}`), bin('inode/symlink');
        else if (e && !ctx.fs.size(e)) (d = 'empty'), bin('inode/x-empty');
        else {
          let head, tail = null, size;
          if (e && e.kind === 'blob') {
            size = e.blob.size;
            head = new Uint8Array(await e.blob.slice(0, 1048576).arrayBuffer());
            tail = new Uint8Array(await e.blob.slice(Math.max(0, size - 4)).arrayBuffer());
          } else {
            const all = f === '-' ? await stdinBytes(ctx) : await ctx.fs.readBytes(f);
            size = all.length;
            head = all.subarray(0, 1048576);
            tail = all.subarray(Math.max(0, size - 4));
          }
          if (!size) (d = 'empty'), bin('inode/x-empty');
          else {
            const r = describeBytes(head, size, tail);
            d = r.text;
            type = r.mime;
            charset = r.charset;
          }
        }
      } catch (err) {
        // (a file of the page that has no bytes to look at: said by its name)
        d = /\.(fa|fasta|fna|fq|fastq|sam|vcf|txt|tsv|csv|sh|md)$/.test(f) ? 'ASCII text' : 'data';
        if (d === 'data') bin('application/octet-stream');
      }
      if ((f === '-' || e) && mime && !/^cannot open/.test(d)) d = mime === 'type' ? type : mime === 'encoding' ? charset : `${type}; charset=${charset}`;
      ctx.out(brief || !files.some((x) => x !== '') ? d + '\n' : nul ? `${shown}\0${sep === ':' ? ':' : sep} ${d}\n` : `${(shown + sep).padEnd(width)} ${d}\n`);
    }
    return code;
  };
  /* ------------------------------------------------------------------ chmod */
  /* chmod MODE FILE…: what the page keeps of the permissions is whether the owner may run a file (x) and may write
     to it (w). 755, u+x, a+x, +x, u-w, u=rx and lists of these (u+x,go-w); what is said about group and others
     is taken and changes nothing. */
  B.chmod = (ctx) => {
    const flag = (c, long) => ctx.args.some((a) => new RegExp(`^-[Rvcf]*${c}[Rvcf]*$`).test(a) || a === long);
    const recursive = flag('R', '--recursive'), verbose = flag('v', '--verbose'), changes = flag('c', '--changes');
    const silent = flag('f', '--silent') || ctx.args.includes('--quiet');
    let ref = null;
    const args = [];
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (/^-[Rvcf]+$/.test(a) || /^--(recursive|verbose|changes|silent|quiet)$/.test(a)) continue;
      if (a === '--reference') ref = ctx.args[++i];
      else if (/^--reference=/.test(a)) ref = a.slice(12);
      // (-x, -rw, -w … are modes; another letter after the dash is an option that chmod does not have)
      else if (!args.length && /^--./.test(a)) throw userErr(`chmod: unrecognized option '${a}'\nTry 'chmod --help' for more information.`);
      else if (!args.length && /^-[^-rwxXstugo0-7,+=]/.test(a)) throw userErr(`chmod: invalid option -- '${a[1]}'\nTry 'chmod --help' for more information.`);
      else args.push(a);
    }
    if (ref != null) {
      const re = ctx.fs.get(ref);
      if (!re) throw userErr(`chmod: failed to get attributes of '${ref}': No such file or directory`);
      args.unshift(MG.permBits(re).toString(8));
    }
    if (!args.length) throw userErr("chmod: missing operand\nTry: chmod +x script.sh   (make executable)   or   chmod -w file   (write-protect)");
    if (args.length < 2) throw userErr(`chmod: missing operand after \u2018${args[0]}\u2019\nTry 'chmod --help' for more information.`);
    const mode = args[0];
    // 644, 2755 – or clauses: u+x, go-w, a=r, g=u (the same as the owner has), +X (x for folders and for what is executable)
    const clauses = /^[0-7]{1,4}$/.test(mode) ? null : mode.split(',').map((part) => {
      const m = /^([ugoa]*)([+\-=])([rwxXst]*|[ugo])$/.exec(part);
      if (!m) throw userErr(`chmod: invalid mode: \u2018${mode}\u2019\nTry 'chmod --help' for more information.`);
      return m;
    });
    // the new permissions of an entry, as a number
    const bitsFor = (e) => {
      if (!clauses) return parseInt(mode, 8) & 0o7777;
      let bits = MG.permBits(e);
      const shift = { u: 6, g: 3, o: 0 };
      for (const m of clauses) {
        // (+x without a name: for everybody, less what the umask 022 takes away – others and group do not get w)
        const who = m[1] === '' || m[1].includes('a') ? 'ugo' : m[1];
        let set = 0;
        for (const w of who) {
          if (/^[ugo]$/.test(m[3])) {
            set |= ((bits >> shift[m[3]]) & 7) << shift[w];
            continue;
          }
          for (const c of m[3]) {
            const bit = c === 'X' ? (e.kind === 'dir' || bits & 0o111 ? 1 : 0) : { r: 4, w: 2, x: 1 }[c];
            if (bit && !(m[1] === '' && c === 'w' && w !== 'u')) set |= bit << shift[w];
            if (c === 's' && w !== 'o') set |= w === 'u' ? 0o4000 : 0o2000;
            if (c === 't') set |= 0o1000;
          }
        }
        if (m[2] === '+') bits |= set;
        else if (m[2] === '-') bits &= ~set;
        else {
          for (const w of who) bits &= ~(7 << shift[w]);
          bits |= set;
        }
      }
      return bits;
    };
    let code = 0;
    const octal = (b) => b.toString(8).padStart(4, '0');
    const text = (e, b) => MG.permText(Object.assign({}, e, { perm: b, mode: b & 0o100 ? 'x' : undefined, readonly: !(b & 0o200), protected: false })).slice(1);
    args.slice(1).forEach((f) => {
      const e = ctx.fs.get(f);
      if (!e) {
        if (!silent) ctx.err(`chmod: cannot access '${f}': No such file or directory\n`);
        code = 1;
        return;
      }
      if (e.protected) {
        ctx.err(`chmod: changing permissions of '${f}': Operation not permitted (course data)\n`);
        code = 1;
        return;
      }
      const abs = ctx.fs.resolve(f), shown = f.replace(/(.)\/+$/, '$1');
      const targets = [[abs, shown]];
      if (e.kind === 'dir' && recursive) for (const k of Array.from(ctx.fs.entries.keys()).sort()) if (k.startsWith(abs + '/')) targets.push([k, shown + k.slice(abs.length)]);
      targets.forEach(([t, name]) => {
        const te = ctx.fs.get(t);
        if (!te || te.protected) return;
        const was = MG.permBits(te), bits = bitsFor(te);
        // a folder: the permissions are kept and shown (ls -l, stat); they change nothing about what can be done in it
        if (te.kind === 'dir') ctx.fs.chmod(t, { bits });
        else ctx.fs.chmod(t, { exec: !!(bits & 0o100), readonly: !(bits & 0o200), bits });
        if (was !== bits && (verbose || changes)) ctx.out(`mode of '${name}' changed from ${octal(was)} (${text(te, was)}) to ${octal(bits)} (${text(te, bits)})\n`);
        else if (verbose) ctx.out(`mode of '${name}' retained as ${octal(bits)} (${text(te, bits)})\n`);
      });
    });
    return code;
  };

  /* ------------------------------------------------------------------ small file-name commands */
  /* basename NAME [SUFFIX];  basename -a NAME…;  basename -s SUFFIX NAME… */
  B.basename = (ctx) => {
    const names = [];
    let suffix = null, many = false, zero = false, options = true;
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (options && a === '--') options = false;
      else if (options && (a === '-a' || a === '--multiple')) many = true;
      else if (options && (a === '-z' || a === '--zero')) zero = true;
      else if (options && a === '-s') {
        suffix = ctx.args[++i];
        many = true;
      } else if (options && /^-s./.test(a)) {
        suffix = a.slice(2);
        many = true;
      } else if (options && /^--suffix=/.test(a)) {
        suffix = a.slice(9);
        many = true;
      } else if (options && /^-[az]+s?$/.test(a)) {
        // (-as SUFFIX: letters together, the last one takes the value)
        if (a.includes('a')) many = true;
        if (a.includes('z')) zero = true;
        if (a.endsWith('s')) {
          suffix = ctx.args[++i];
          many = true;
        }
      } else if (options && /^-./.test(a)) throw MG.shellUtil.refuseOption('basename', a.startsWith('--') ? a : '-' + (/[^az]/.exec(a.slice(1)) || [a[1]])[0]);
      else names.push(a);
    }
    if (!names.length) throw userErr("basename: missing operand\nTry 'basename --help' for more information.");
    if (!many) {
      if (names.length > 2) throw userErr(`basename: extra operand \u2018${names[2]}\u2019\nTry 'basename --help' for more information.`);
      if (names.length === 2) suffix = names.pop();
    }
    names.forEach((p) => {
      let b = /^\/+$/.test(p) ? '/' : p.replace(/\/+$/, '').split('/').pop();
      if (suffix && b.endsWith(suffix) && b !== suffix) b = b.slice(0, -suffix.length);
      ctx.out(b + (zero ? '\0' : '\n'));
    });
  };
  B.dirname = (ctx) => {
    let zero = false, options = true;
    const names = [];
    for (const a of ctx.args) {
      if (options && a === '--') options = false;
      else if (options && (a === '-z' || a === '--zero')) zero = true;
      else if (options && /^-./.test(a)) throw MG.shellUtil.refuseOption('dirname', a);
      else names.push(a);
    }
    if (!names.length) throw userErr("dirname: missing operand\nTry 'dirname --help' for more information.");
    names.forEach((p) => {
      const s = /^\/+$/.test(p) ? '/' : p.replace(/\/+$/, '');
      const i = s.lastIndexOf('/');
      ctx.out((i < 0 ? '.' : i === 0 ? '/' : s.slice(0, i).replace(/\/+$/, '') || '/') + (zero ? '\0' : '\n'));
    });
  };
  /* realpath [-m] [-e] [--relative-to=DIR] [--relative-base=DIR] FILE…: the full path (there are no links here) */
  B.realpath = (ctx) => {
    let rel = null, base = null, need = false, missingOK = false, options = true, quiet = false, end = '\n';
    const names = [];
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (options && a === '--') options = false;
      else if (options && /^--relative-(to|base)(=|$)/.test(a)) {
        const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : ctx.args[++i];
        if (v === undefined) throw userErr(`realpath: option '${a}' requires an argument\nTry 'realpath --help' for more information.`);
        if (/^--relative-to/.test(a)) rel = v;
        else base = v;
      }
      else if (options && a === '--canonicalize-existing') need = true;
      else if (options && a === '--canonicalize-missing') missingOK = true;
      else if (options && a === '--quiet') quiet = true;
      else if (options && a === '--zero') end = '\0';
      else if (options && /^--(logical|physical|strip|no-symlinks)$/.test(a)) continue; // (there are no links here)
      else if (options && /^--/.test(a)) throw userErr(`realpath: unrecognized option '${a}'\nTry 'realpath --help' for more information.`);
      else if (options && /^-./.test(a)) {
        for (const c of a.slice(1)) {
          if (c === 'e') need = true;
          else if (c === 'm') missingOK = true;
          else if (c === 'q') quiet = true;
          else if (c === 'z') end = '\0';
          else if (!'sLP'.includes(c)) throw userErr(`realpath: invalid option -- '${c}'\nTry 'realpath --help' for more information.`);
        }
      } else names.push(a);
    }
    if (!names.length) throw userErr("realpath: missing operand\nTry 'realpath --help' for more information.");
    let code = 0;
    // --relative-base=B: a path under B is written from there (or from --relative-to, which must be under B itself);
    // any other in full
    const under = (dir, p) => dir === '/' || p === dir || p.startsWith(dir + '/');
    let from = rel != null ? ctx.fs.resolve(rel) : null, within = base != null ? ctx.fs.resolve(base) : null;
    if (within != null && from == null) from = within;
    else if (within != null && !under(within, from)) from = null;
    // (a look at the folder above is no use of it: see watched in terminal.js)
    const look = ctx.fs.__real || ctx.fs;
    names.forEach((p) => {
      const abs = missingOK && p !== '' ? MG.path.norm(p.startsWith('/') ? p : ctx.fs.cwd + '/' + p) : ctx.fs.resolve(p);
      // (the folder it is in has to be there – with -e the file itself too, with -m nothing)
      if (p === '' || (need && !ctx.fs.exists(abs)) || (!missingOK && !look.isDir(MG.path.dirname(abs)))) {
        if (!quiet) ctx.err(`realpath: ${p === '' ? "''" : p}: ${p !== '' && look.exists(MG.path.dirname(abs)) && !look.isDir(MG.path.dirname(abs)) ? 'Not a directory' : 'No such file or directory'}\n`);
        code = 1;
        return;
      }
      if (from == null || (within != null && !under(within, abs))) return ctx.out(abs + end);
      const A = from.split('/').filter(Boolean), B2 = abs.split('/').filter(Boolean);
      let k = 0;
      while (k < A.length && k < B2.length && A[k] === B2[k]) k++;
      ctx.out((Array(A.length - k).fill('..').concat(B2.slice(k)).join('/') || '.') + end);
    });
    return code;
  };
  /* readlink -f FILE (also -e, -m): the full path of a file, as realpath gives it – SCRIPT=$(readlink -f "$0").
     Without one of these readlink names what a link points to: there are no links here, so it prints nothing and
     its status is 1, as for any file that is no link. */
  B.readlink = (ctx) => {
    let mode = null, end = '\n', verbose = false, options = true;
    const names = [];
    const bad = (msg) => userErr(`readlink: ${msg}\nTry 'readlink --help' for more information.`);
    for (const a of ctx.args) {
      if (!options || a === '-' || !a.startsWith('-')) names.push(a);
      else if (a === '--') options = false;
      else if (a === '--canonicalize') mode = 'f';
      else if (a === '--canonicalize-existing') mode = 'e';
      else if (a === '--canonicalize-missing') mode = 'm';
      else if (a === '--no-newline') end = '';
      else if (a === '--zero') end = '\0';
      else if (a === '--verbose') verbose = true;
      else if (a === '--quiet' || a === '--silent') verbose = false;
      else if (a.startsWith('--')) throw bad(`unrecognized option '${a}'`);
      else {
        for (const c of a.slice(1)) {
          if ('fem'.includes(c)) mode = c;
          else if (c === 'n') end = '';
          else if (c === 'z') end = '\0';
          else if (c === 'v') verbose = true;
          else if (c !== 'q' && c !== 's') throw bad(`invalid option -- '${c}'`);
        }
      }
    }
    if (!names.length) throw bad('missing operand');
    if (!mode) {
      if (verbose) names.forEach((n) => ctx.err(`readlink: ${n}: ${ctx.fs.exists(n) ? 'Invalid argument' : 'No such file or directory'}\n`));
      return 1;
    }
    const one = end === '' && names.length === 1;
    return B.realpath(Object.assign({}, ctx, {
      args: (mode === 'e' ? ['-e'] : mode === 'm' ? ['-m'] : []).concat(end === '\0' ? ['-z'] : [], verbose ? [] : ['-q'], ['--'], names),
      out: (t) => ctx.out(one && typeof t === 'string' ? t.replace(/\n$/, '') : t),
      err: (t) => ctx.err(String(t).replace(/^realpath:/, 'readlink:'))
    }));
  };
  /* sleep NUMBER[smhd]…: wait for the sum of the times – in this terminal for 10 seconds at most */
  B.sleep = async (ctx) => {
    let total = 0, n = 0, options = true;
    for (const a of ctx.args) {
      if (options && a === '--') {
        options = false;
        continue;
      }
      if (options && /^-./.test(a)) throw MG.shellUtil.refuseOption('sleep', a);
      const m = /^(\d+\.?\d*|\.\d+)(?:[eE]([-+]?\d+))?([smhd]?)$/.exec(a);
      if (!m) throw userErr(`sleep: invalid time interval \u2018${a}\u2019\nTry 'sleep --help' for more information.`);
      total += parseFloat(m[1] + (m[2] ? 'e' + m[2] : '')) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[3]];
      n++;
    }
    if (!n) throw userErr("sleep: missing operand\nTry 'sleep --help' for more information.");
    // The wait ends after 10 seconds at most; with Ctrl+C; and – under "timeout N sleep M" with M greater than N –
    // when the limit runs out (then timeout reports 124, as on Linux).
    const sh = ctx.shell, now = Date.now(), limit = sh._deadline ? sh._deadline() : null;
    const over = !!limit && now + total * 1000 > limit.at;
    const wait = Math.min(total * 1000, over ? limit.at - now : Infinity);
    if (wait > 10000) ctx.io.note('sleep: in this terminal a sleep ends after 10 seconds');
    // (measured with the clock that "time" uses: a sleep never ends before its time – time sleep 0.2 says 0.200 or more)
    const start = performance.now(), span = Math.min(10000, Math.max(0, wait));
    while (performance.now() - start < span) {
      await new Promise((r) => setTimeout(r, Math.min(50, Math.max(0, span - (performance.now() - start)))));
      if (ctx.term && ctx.term.cancelled) return 130;
    }
    if (over) sh._expire(limit);
    return 0;
  };
  /* ------------------------------------------------------------------ find */
  B.find = async (ctx) => {
    const args = ctx.args.slice();
    // (find -H -L -P -O2 …: there are no links here, and nothing to tune)
    while (args.length && /^-([HLP]|O\d*)$/.test(args[0])) args.shift();
    if (args[0] === '-D') args.splice(0, 2);
    const paths = [];
    while (args.length && !/^(-|\(|\)|!|,)/.test(args[0])) paths.push(args.shift());
    if (!paths.length) paths.push('.');
    const fs = ctx.fs;
    const st = (ctx.opts && ctx.opts.st) || ctx.shell._top();
    const io = MG.shellUtil.innerIO(ctx);
    let maxdepth = Infinity, mindepth = 0, hasAction = false, k = 0, quit = false, depthFirst = false, code = 0, pruned = false, depthSaid = false, daystart = false;
    const zone = MG.time.zoneOf(ctx);
    const batches = [], outFiles = new Map();
    const yes = async () => true;
    const q = (s) => `‘${s}’`;
    // the permissions of a file, as the page keeps them: its own files 644 (755 when executable), the course data 444
    const modeOf = (e) => MG.permBits(e);
    const sizeOf = (e) => (e.kind === 'dir' ? 4096 : fs.size(e));
    const linksOf = (it) => (it.e.kind === 'dir' ? 2 + fs.list(it.abs).filter((c) => c.entry.kind === 'dir').length : 1);
    // 644, u+x, a=r, +x → the bits
    const modeBits = (spec) => {
      if (/^[0-7]{1,4}$/.test(spec)) return parseInt(spec, 8);
      let bits = 0;
      for (const part of spec.split(',')) {
        const m = /^([ugoa]*)[+=]([rwxX]*)$/.exec(part);
        if (!m) throw userErr(`find: invalid mode ${q(spec)}`);
        const who = m[1] === '' || m[1].includes('a') ? 'ugo' : m[1];
        for (const w of who) for (const c of m[2].toLowerCase()) bits |= { r: 4, w: 2, x: 1 }[c] << { u: 6, g: 3, o: 0 }[w];
      }
      return bits;
    };
    const atEnd = () => k >= args.length || args[k] === ')';
    // EXPR , EXPR: both are carried out, the second one counts
    const parseComma = () => {
      let l = parseOr();
      while (args[k] === ',') {
        k++;
        if (atEnd()) throw userErr("find: expected an expression after ','");
        const a = l, r = parseOr();
        l = async (it) => {
          await a(it);
          return quit ? false : r(it);
        };
      }
      return l;
    };
    const parseOr = () => {
      if (args[k] === '-o' || args[k] === '-or' || args[k] === '-a' || args[k] === '-and' || args[k] === ',') throw userErr(`find: invalid expression; you have used a binary operator '${args[k]}' with nothing before it.`);
      let l = parseAnd();
      while (args[k] === '-o' || args[k] === '-or') {
        const op = args[k++];
        if (atEnd()) throw userErr(`find: expected an expression after '${op}'`);
        const a = l, r = parseAnd();
        l = async (it) => (await a(it)) || (await r(it));
      }
      return l;
    };
    const parseAnd = () => {
      let l = parseNot();
      for (;;) {
        if (args[k] === '-a' || args[k] === '-and') {
          const op = args[k++];
          if (atEnd()) throw userErr(`find: expected an expression after '${op}'`);
        } else if (k >= args.length || args[k] === '-o' || args[k] === '-or' || args[k] === ')' || args[k] === ',') break;
        const a = l, r = parseNot();
        // (after -quit nothing more is done: find . -type f -quit -print prints nothing)
        l = async (it) => (await a(it)) && !quit && (await r(it));
      }
      return l;
    };
    const parseNot = () => {
      if (args[k] === '!' || args[k] === '-not') {
        const op = args[k++];
        if (atEnd()) throw userErr(`find: expected an expression after '${op}'`);
        const p = parseNot();
        return async (it) => !(await p(it));
      }
      return parsePrim();
    };
    const number = (spec, what) => {
      const m = /^([+-]?)(\d+)$/.exec(spec);
      if (!m) throw userErr(`find: invalid argument \`${spec}' to \`${what}'`);
      return (x) => (m[1] === '+' ? x > +m[2] : m[1] === '-' ? x < +m[2] : x === +m[2]);
    };
    const depthArg = (what, v) => {
      if (!/^\d+$/.test(v)) throw userErr(`find: Expected a positive decimal integer argument to ${what}, but got ${q(v)}`);
      return parseInt(v, 10);
    };
    // the time a test goes by: of the last reading (-amin, -atime, -anewer) or of the last change
    const stamp = (it, which) => (which === 'a' && it.e.atime != null ? it.e.atime : it.e.mtime || 0);
    const refTime = (f, which) => {
      const ref = fs.get(f);
      if (!ref) throw userErr(`find: ${q(f)}: No such file or directory`);
      return which === 'a' && ref.atime != null ? ref.atime : ref.mtime || 0;
    };
    // where what an action writes goes: the output, or the file of -fprint, -fprintf, -fls
    const sink = (file) => {
      if (file == null) return (t) => ctx.out(t);
      if (!outFiles.has(file)) {
        if (!fs.isDir(MG.path.dirname(fs.resolve(file)))) throw userErr(`find: ${q(file)}: No such file or directory`);
        outFiles.set(file, []);
      }
      return (t) => outFiles.get(file).push(t);
    };
    const lsLine = (it) => {
      const size = sizeOf(it.e), who = it.e.protected ? 'root    ' : 'student ', t = it.e.mtime || Date.now();
      return `${'0'.padStart(9)} ${String(it.e.kind === 'dir' ? 4 : Math.ceil(size / 4096) * 4).padStart(6)} ${MG.permText(it.e)} ${String(linksOf(it)).padStart(3)} ${who} ${who} ${String(size).padStart(8)} ${MG.time.strftime(Math.abs(Date.now() - t) > 15778800000 ? '%b %e  %Y' : '%b %e %H:%M', t, zone)} ${it.shown}\n`;
    };
    /* -printf FORMAT. %p the path, %f the name, %h the folder, %H the starting point, %P the path below it, %s the
       size, %y the type, %d the depth, %m %M the permissions, %u %g %U %G owner and group, %n links, %b %k blocks,
       %T@ %t %TY … the time of the last change (%A…: of the last reading); a number between % and the letter is a
       width (%-20f, %10s), .N cuts off; \n \t \0 \\ \101, \c ends the output. */
    const printfAction = (fmt, out) => {
      // (what is wrong with the format is said once, before the search)
      const ESC = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };
      const KNOWN = 'abcdDfFgGhHiklmMnpPsStuUyYZ';
      const parts = [];
      const re = /\\([0-7]{1,3}|[\s\S])|\\$|%([-+ #0]*)(\d*)(?:\.(\d+))?([TAC][\s\S]|[\s\S])|%$/g;
      let at = 0, m;
      while ((m = re.exec(fmt))) {
        if (m.index > at) parts.push(fmt.slice(at, m.index));
        at = re.lastIndex;
        if (m[0] === '\\') {
          ctx.err("find: warning: escape `\\' followed by nothing at all\n");
          parts.push('\\');
        } else if (m[0][0] === '\\') {
          const c = m[1];
          if (/^[0-7]/.test(c)) parts.push(String.fromCharCode(parseInt(c, 8) & 255));
          else if (c === 'c') {
            parts.push({ stop: true });
            break;
          } else if (c in ESC) parts.push(ESC[c]);
          else {
            ctx.err(`find: warning: unrecognized escape \`\\${c}'\n`);
            parts.push('\\' + c);
          }
        } else if (m[0] === '%') throw userErr('find: error: % at end of format string');
        else if (m[5] === '%') parts.push('%');
        else if (m[5].length === 1 && !KNOWN.includes(m[5])) {
          ctx.err(`find: warning: unrecognized format directive \`%${m[5]}'\n`);
          parts.push(m[0]);
        } else parts.push({ left: m[2].includes('-'), width: m[3] ? +m[3] : 0, prec: m[4] != null ? +m[4] : null, c: m[5] });
      }
      if (at < fmt.length && !(parts.length && parts[parts.length - 1].stop)) parts.push(fmt.slice(at));
      return async (it) => {
        const value = (c) => {
          // %T@ seconds since 1970, %T+ date and time, %TY %Tm %Td %TH %TM %TS … the parts (also %A…, %C…)
          if (/^[TAC].$/.test(c)) {
            const when = new Date(stamp(it, c[0] === 'A' ? 'a' : 'm') || Date.now()), tf = (f) => MG.time.strftime(f, when, zone);
            if (c[1] === '@') return (when.getTime() / 1000).toFixed(10);
            if (c[1] === '+') return tf('%Y-%m-%d+%H:%M:%S') + '.0000000000';
            if (c[1] === 'S') return tf('%S') + '.0000000000';
            if (c[1] === 'T') return tf('%H:%M:%S') + '.0000000000';
            if (c[1] === 'c') return tf('%a %b %e %H:%M:%S') + '.0000000000 ' + tf('%Y');
            return tf('%' + c[1]);
          }
          const day = (which) => {
            const when = new Date(stamp(it, which) || Date.now());
            return MG.time.strftime('%a %b %e %H:%M:%S', when, zone) + '.0000000000 ' + MG.time.strftime('%Y', when, zone);
          };
          switch (c) {
            case 'M': return MG.permText(it.e);
            case 'b': return String(it.e.kind === 'dir' ? 8 : Math.ceil(fs.size(it.e) / 4096) * 8);
            case 'i': return String(MG.shellUtil.inodeOf(it.abs));
            case 'n': return String(linksOf(it));
            case 'l': return '';
            case 'U':
            case 'G': return it.e.protected ? '0' : '1000';
            case 'a': return day('a');
            case 'p': return it.shown;
            case 'f': return it.base;
            case 'h': return it.shown.replace(/\/+$/, '').includes('/') ? it.shown.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/' : '.';
            case 'H': return it.top;
            case 'P': return it.abs.slice(it.root.length).replace(/^\//, '');
            case 's': return String(sizeOf(it.e));
            case 'S': return sizeOf(it.e) && it.e.kind !== 'dir' ? String(Number(((Math.ceil(sizeOf(it.e) / 4096) * 4096) / sizeOf(it.e)).toPrecision(6))) : '1';
            case 'k': return String(Math.ceil(sizeOf(it.e) / 4096) * 4);
            case 'y':
            case 'Y': return it.e.kind === 'dir' ? 'd' : 'f';
            case 'd': return String(it.depth);
            case 'D': return '2049';
            case 'F': return 'ext4';
            case 'm': return modeOf(it.e).toString(8);
            case 'u':
            case 'g': return it.e.protected ? 'root' : 'student';
            case 'c':
            case 't': return day('m');
            default: return '';
          }
        };
        let text = '';
        for (const p of parts) {
          if (typeof p === 'string') text += p;
          else if (p.stop) break;
          else {
            let v = value(p.c);
            if (p.prec != null) v = v.slice(0, p.prec);
            text += p.width ? (p.left ? v.padEnd(p.width) : v.padStart(p.width)) : v;
          }
        }
        out(text);
        return true;
      };
    };
    // the lines that answer -ok and -okdir: of what is piped in (nobody can answer at the terminal: that is a no)
    let answers = null;
    const asked = async (cmd, it) => {
      ctx.err(`< ${cmd[0]} ... ${it.shown} > ? `);
      if (answers == null) answers = ctx.stdin != null || (ctx.inherit && ctx.inherit.pos < ctx.inherit.text.length) ? (await MG.shellUtil.inputOf(ctx, [], 'find')).split('\n') : [];
      const a = answers.shift();
      return a !== undefined && /^[yY]/.test(a);
    };
    const PATTERNS = /^-(i?name|i?path|i?wholename|i?regex|lname|ilname)$/;
    const parsePrim = () => {
      const a = args[k++];
      const need = () => {
        if (k >= args.length) throw userErr(`find: missing argument to \`${a}'`);
        return args[k++];
      };
      const times = (which) => {
        // -mtime N, -mmin N: N whole days (minutes) ago; -daystart: counted from the end of today
        const cmp = number(need(), a), unit = /min$/.test(a) ? 60000 : 86400000;
        return async (it) => {
          let now = Date.now();
          if (daystart) {
            const f = MG.time.fields(now, zone);
            now = MG.time.at(f.Y, f.M, f.D, 0, 0, 0, zone) + 86400000;
          }
          return cmp(Math.floor((now - (stamp(it, which) || now)) / unit));
        };
      };
      switch (a) {
        case '(': {
          if (atEnd()) throw userErr(args[k] === ')' ? 'find: invalid expression; empty parentheses are not allowed.' : "find: invalid expression; I was expecting to find a ')' somewhere but did not see one.");
          const p = parseComma();
          if (args[k++] !== ')') throw userErr("find: invalid expression; I was expecting to find a ')' somewhere but did not see one.");
          return p;
        }
        case ')':
          throw userErr("find: you have too many ')'");
        case '-name':
        case '-iname': {
          const re = new RegExp(MG.globRe(need(), '', true).source, a === '-iname' ? 'i' : '');
          return async (it) => re.test(it.base);
        }
        case '-path':
        case '-wholename': {
          const re = MG.globRe(need(), '', true);
          return async (it) => re.test(it.shown);
        }
        case '-regex':
        case '-iregex': {
          // (the whole path has to match; the pattern is read as an extended regular expression)
          let re;
          try {
            re = new RegExp('^(?:' + need().replace(/\\([(){}|+?])/g, '$1') + ')$', a === '-iregex' ? 'i' : '');
          } catch (e) {
            throw userErr(`find: invalid regular expression ${q(args[k - 1])}`);
          }
          return async (it) => re.test(it.shown);
        }
        case '-regextype':
          need();
          return yes;
        case '-type':
        case '-xtype': {
          // -type f, -type d, -type f,d (links and the other kinds do not exist here)
          const t = need();
          for (const c of t.split(',')) {
            if (c.length > 1) throw userErr("find: Must separate multiple arguments to -type using: ','");
            if (!'bcdpflsD'.includes(c) || c === '') throw userErr(`find: Unknown argument to -type: ${c}`);
          }
          const kinds = t.split(',');
          return async (it) => kinds.includes(it.e.kind === 'dir' ? 'd' : 'f');
        }
        case '-maxdepth':
          maxdepth = depthArg(a, need());
          return yes;
        case '-mindepth':
          mindepth = depthArg(a, need());
          return yes;
        case '-empty':
          return async (it) => (it.e.kind === 'dir' ? !fs.list(it.abs).length : fs.size(it.e) === 0);
        case '-size': {
          // (in blocks of 512 bytes – or c bytes, k, M, G –, rounded up; a folder is 4096 bytes)
          const m = /^([+-]?\d+)([cwbkMG]?)$/.exec(need());
          if (!m) throw userErr(`find: invalid argument \`${args[k - 1]}' to \`-size'`);
          const unit = { c: 1, w: 2, b: 512, '': 512, k: 1024, M: 1048576, G: 1073741824 }[m[2]];
          const cmp = number(m[1], '-size');
          return async (it) => cmp(Math.ceil(sizeOf(it.e) / unit));
        }
        case '-newer':
        case '-anewer':
        case '-cnewer': {
          const which = a === '-anewer' ? 'a' : 'm', t = refTime(need(), 'm');
          return async (it) => stamp(it, which) > t;
        }
        case '-samefile': {
          const f = need();
          if (!fs.get(f)) throw userErr(`find: ${q(f)}: No such file or directory`);
          const abs = fs.resolve(f);
          return async (it) => it.abs === abs;
        }
        case '-inum': {
          const cmp = number(need(), a);
          return async (it) => cmp(MG.shellUtil.inodeOf(it.abs));
        }
        case '-links': {
          const cmp = number(need(), a);
          return async (it) => cmp(linksOf(it));
        }
        case '-user':
        case '-group': {
          const name = need();
          if (!/^(student|root|1000|0)$/.test(name)) throw userErr(`find: ${q(name)} is not the name of a known ${a.slice(1)}`);
          const root = name === 'root' || name === '0';
          return async (it) => !!it.e.protected === root;
        }
        case '-uid':
        case '-gid': {
          const cmp = number(need(), a);
          return async (it) => cmp(it.e.protected ? 0 : 1000);
        }
        case '-nouser':
        case '-nogroup':
          return async () => false;
        case '-mmin':
        case '-cmin':
        case '-mtime':
        case '-ctime':
          return times('m');
        case '-amin':
        case '-atime':
          return times('a');
        case '-used': {
          const cmp = number(need(), a);
          return async (it) => cmp(Math.floor((stamp(it, 'a') - stamp(it, 'm')) / 86400000));
        }
        case '-daystart':
          daystart = true;
          return yes;
        case '-readable':
        case '-true':
          return yes;
        case '-writable':
          return async (it) => !it.e.readonly && !it.e.protected;
        case '-executable':
          return async (it) => it.e.kind === 'dir' || it.e.mode === 'x';
        case '-perm': {
          // -perm 644: exactly; -perm -u+x: all of these bits; -perm /111: any of them
          const spec = need(), kind = /^[-/]/.test(spec) ? spec[0] : '=', bits = modeBits(kind === '=' ? spec : spec.slice(1));
          return async (it) => (kind === '=' ? modeOf(it.e) === bits : kind === '-' ? (modeOf(it.e) & bits) === bits : !bits || (modeOf(it.e) & bits) !== 0);
        }
        case '-prune':
          pruned = true;
          return async (it) => ((it.prune = true), true);
        case '-quit':
          hasAction = true; // (with -quit nothing is printed unless -print says so)
          return async () => ((quit = true), true);
        case '-depth':
        case '-d':
          // what is in a folder first, then the folder itself
          depthFirst = depthSaid = true;
          return yes;
        case '-xdev':
        case '-mount':
        case '-follow':
        case '-noleaf':
        case '-warn':
        case '-nowarn':
        case '-ignore_readdir_race':
        case '-noignore_readdir_race':
          return yes;
        case '-iwholename':
        case '-ipath': {
          const re = new RegExp(MG.globRe(need(), '', true).source, 'i');
          return async (it) => re.test(it.shown);
        }
        case '-lname':
        case '-ilname':
          need();
          return async () => false;
        case '-printf':
          hasAction = true;
          return printfAction(need(), sink(null));
        case '-fprintf': {
          hasAction = true;
          const out = sink(need());
          return printfAction(need(), out);
        }
        case '-false':
          return async () => false;
        case '-print':
        case '-fprint': {
          hasAction = true;
          const out = sink(a === '-fprint' ? need() : null);
          return async (it) => (out(it.shown + '\n'), true);
        }
        case '-print0':
        case '-fprint0': {
          hasAction = true;
          const out = sink(a === '-fprint0' ? need() : null);
          return async (it) => (out(it.shown + '\0'), true);
        }
        case '-ls':
        case '-fls': {
          hasAction = true;
          const out = sink(a === '-fls' ? need() : null);
          return async (it) => (out(lsLine(it)), true);
        }
        case '-delete':
          // -delete: each file as it is come to – what is in a folder before the folder (so -depth is on with it)
          hasAction = true;
          depthFirst = true;
          if (pruned && !depthSaid) throw userErr('find: The -delete action automatically turns on -depth, but -prune does nothing when -depth is in effect.  If you want to carry on anyway, just explicitly use the -depth option.');
          return async (it) => {
            const fail = (why) => {
              ctx.err(`find: cannot delete ${q(it.shown)}: ${why}\n`);
              code = 1;
              return false;
            };
            // (the starting point "." itself is never removed)
            if (/(^|\/)\.\/*$/.test(it.shown)) return true;
            if (it.e.protected) return fail('Permission denied');
            if (it.e.kind === 'dir' && fs.list(it.abs).length) return fail('Directory not empty');
            fs.remove(it.abs);
            return true;
          };
        case '-exec':
        case '-execdir':
        case '-ok':
        case '-okdir': {
          hasAction = true;
          const cmd = [];
          const inDir = /dir$/.test(a), ask = /^-ok/.test(a);
          let plus = false;
          for (;;) {
            if (k >= args.length) throw userErr(`find: missing argument to \`${a}'`);
            const w = args[k++];
            if (w === ';') break;
            if (w === '+' && cmd[cmd.length - 1] === '{}' && !ask) {
              plus = true;
              cmd.pop();
              break;
            }
            cmd.push(w);
          }
          if (!cmd.length) throw userErr(`find: missing argument to \`${a}'`);
          // -execdir: the command runs in the folder of the file, which it is given as ./NAME
          const name = (it) => (inDir ? './' + it.base : it.shown), dir = (it) => (it.abs === '/' ? '/' : MG.path.dirname(it.abs));
          const run = async (argv, where) => {
            const cwd = fs.cwd;
            if (where != null) fs.cwd = where;
            try {
              return await ctx.shell.runArgv(argv, st, io, '', 'find');
            } finally {
              if (where != null && fs.isDir(cwd)) fs.cwd = cwd;
            }
          };
          if (plus) {
            // {} +: as many names as there are in one command (-execdir: one command for each folder)
            const groups = new Map();
            batches.push({ cmd, groups, run });
            return async (it) => {
              const where = inDir ? dir(it) : null;
              if (!groups.has(where)) groups.set(where, []);
              groups.get(where).push(name(it));
              return true;
            };
          }
          return async (it) => {
            if (ask && !(await asked(cmd, it))) return false;
            return (await run(cmd.map((w) => w.split('{}').join(name(it))), inDir ? dir(it) : null)) === 0;
          };
        }
        case '-version':
        case '--version':
          ctx.out('find (GNU findutils) 4.9.0 – the find of this terminal, written for the page\n');
          quit = true;
          hasAction = true;
          return yes;
        case '-help':
        case '--help':
          ctx.out(MG.shellHelp ? MG.shellHelp('find') || '' : '');
          quit = true;
          hasAction = true;
          return yes;
        default: {
          // -newerXY: X – which time of the file (a: last reading, m, c: last change), Y – of what: of a file
          // (-newermm FILE is -newer FILE), or t: a date (-newermt 2024-07-15, -newermt "2 days ago")
          const nm = /^-newer([acmB])([acmBt])$/.exec(a || '');
          if (nm) {
            const spec = need(), which = nm[1] === 'a' ? 'a' : 'm';
            if (nm[2] !== 't') {
              const t = refTime(spec, nm[2] === 'a' ? 'a' : 'm');
              return async (it) => stamp(it, which) > t;
            }
            let t = null;
            return async (it) => {
              if (t === null) {
                t = await MG.time.gnu(ctx, spec);
                if (Number.isNaN(t)) throw userErr(`find: I cannot figure out how to interpret ${q(spec)} as a date or time`);
              }
              return stamp(it, which) > t;
            };
          }
          // (a word that is no test: a path that came too late – often a pattern that the shell filled in: -name *.txt)
          if (a !== undefined && !/^-/.test(a)) throw userErr(`find: paths must precede expression: \`${a}'` + (k >= 3 && PATTERNS.test(args[k - 3]) ? `\nfind: possible unquoted pattern after predicate \`${args[k - 3]}'?` : ''));
          throw userErr(`find: unknown predicate \`${a}'`);
        }
      }
    };
    const test = k < args.length ? parseComma() : yes;
    if (k < args.length) throw userErr(args[k] === ')' ? "find: you have too many ')'" : `find: paths must precede expression: \`${args[k]}'`);
    for (const p of paths) {
      const abs = fs.resolve(p);
      const root = p === '' ? null : fs.get(abs);
      if (!root) {
        ctx.err(`find: ${q(p)}: No such file or directory\n`);
        code = 1;
        continue;
      }
      // (the names are the starting point as it was written and what follows below it: d1//x.txt for find d1//)
      const stem = p.endsWith('/') ? p : p + '/';
      const walk = async (full, e, depth) => {
        if (ctx.term && ctx.term.cancelled) return;
        if (quit) return;
        const it = { abs: full, e, base: full === abs ? p.replace(/\/+$/, '').split('/').pop() || '/' : full.split('/').pop(), shown: full === abs ? p : stem + full.slice(abs.length).replace(/^\//, ''), depth, root: abs, top: p };
        const below = async () => {
          if (e.kind !== 'dir' || depth >= maxdepth || it.prune) return;
          // (the folder is looked into after it was dealt with itself: one that -exec rm -r {} \; or -exec mv has
          // taken away by then cannot be read – find says so and ends with status 1, as on Linux; -depth and -prune
          // are the ways around it)
          if (!depthFirst && !fs.isDir(full)) {
            ctx.err(`find: ${q(it.shown)}: No such file or directory\n`);
            code = 1;
            return;
          }
          for (const c of fs.list(full)) await walk(c.path, c.entry, depth + 1);
        };
        if (depthFirst) await below();
        if (quit) return;
        if (depth >= mindepth && (await test(it)) && !hasAction) ctx.out(it.shown + '\n');
        if (!depthFirst) await below();
      };
      await walk(abs, root, 0);
    }
    for (const { cmd, groups, run } of batches) for (const [where, names] of groups) if (names.length && (await run(cmd.concat(names), where))) code = 1;
    for (const [file, parts] of outFiles) fs.rewrite(file, parts.join(''));
    return code;
  };

  /* ------------------------------------------------------------------ more checksums: sha1sum, sha512sum … */
  const shaOf = (algo) => async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest(algo, bytes)), (x) => x.toString(16).padStart(2, '0')).join('');
  B.sha1sum = hashCommand('sha1sum', shaOf('SHA-1'), 40);
  B.sha384sum = hashCommand('sha384sum', shaOf('SHA-384'), 96);
  B.sha512sum = hashCommand('sha512sum', shaOf('SHA-512'), 128);

  /* ------------------------------------------------------------------ bytes: od, hexdump, xxd, base64, split, truncate */
  /** the bytes of the files a command was given, joined – or of its input */
  async function allBytes(ctx, files, name) {
    if (!files.length) return stdinBytes(ctx);
    const parts = [];
    for (const f of files) parts.push(f === '-' ? await stdinBytes(ctx) : await fileBytes(ctx, f, name));
    const all = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const b of parts) {
      all.set(b, at);
      at += b.length;
    }
    return all;
  }
  /** the bytes of each file a command was given, in turn (- or no file: the input). A file that cannot be read is
      an entry { error } – the command says so and goes on with the others, as the GNU programs do. */
  async function bytesOfEach(ctx, files, name) {
    const out = [];
    for (const f of files.length ? files : ['-']) {
      try {
        out.push({ bytes: f === '-' ? await stdinBytes(ctx) : await fileBytes(ctx, f, name) });
      } catch (e) {
        if (!e || !e.userMessage) throw e;
        out.push({ error: e.userMessage, dir: /Is a directory$/.test(e.userMessage) });
      }
    }
    return out;
  }
  /** what a command prints: bytes to a file or a pipe; to the screen as text (and a note if it is not text) */
  function putBytes(ctx, bytes, name) {
    if (ctx.takesBytes) return ctx.out(bytes);
    let text = null;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      text = null;
    }
    // eslint-disable-next-line no-control-regex
    if (text == null || /[\x00-\x08\x0e-\x1f]/.test(text)) ctx.io.note(`${name}: binary output (${bytes.length} bytes) – save it in a file with  > FILE`);
    else ctx.out(text);
  }
  const sizeArg = (v, name, what) => {
    const m = /^([+-]?)(\d+)([KMGkmg]?)(i?B|B)?$/.exec(String(v));
    if (!m) throw userErr(`${name}: invalid ${what}: ‘${v}’`);
    const unit = { '': 1, k: 1024, m: 1048576, g: 1073741824 }[m[3].toLowerCase()] / (m[4] === 'B' && m[3] ? 1.024 ** { k: 1, m: 2, g: 3 }[m[3].toLowerCase()] : 1);
    return { sign: m[1], n: Math.round(+m[2] * unit) };
  };
  /* od [-A d|o|x|n] [-t TYPE] [-c] [-b] [-x] [-d] [-o] [-N COUNT] [-j SKIP] [-v] [-w WIDTH] [FILE …]: the bytes of a
     file, written out – od -c shows every character (\n, \t …), od -An -tx1 the bytes in hexadecimal */
  B.od = async (ctx) => {
    let radix = 'o', width = 16, skip = 0, count = Infinity, every = false;
    const types = [], files = [];
    const args = ctx.args.slice();
    const need = (v, a) => {
      if (v == null) throw userErr(`od: option requires an argument -- '${a.replace(/^-+/, '')}'`);
      return v;
    };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      let m;
      if (a === '--') {
        files.push(...args.slice(i + 1));
        break;
      }
      if (a === '-' || !a.startsWith('-')) files.push(a);
      else if ((m = /^--(address-radix|format|read-bytes|skip-bytes|width)(?:=(.*))?$/.exec(a))) args.splice(i + 1, 0, { 'address-radix': '-A', format: '-t', 'read-bytes': '-N', 'skip-bytes': '-j', width: '-w' }[m[1]] + (m[2] != null ? m[2] : ''));
      else if (a === '--output-duplicates') every = true;
      else if ((m = /^-([AtNjw])(.*)$/.exec(a))) {
        const v = m[2] !== '' ? m[2] : m[1] === 'w' && !/^\d+$/.test(args[i + 1] || '') ? '32' : need(args[++i], a);
        if (m[1] === 'A') radix = v.slice(0, 1);
        else if (m[1] === 't') types.push(...(v.match(/[acdfoux]\d?z?/g) || [v]));
        else if (m[1] === 'N' || m[1] === 'j') {
          // (a number of bytes: 16, 0x10, 020 – with b, K, M … behind it)
          const x = /^(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9]\d*)(b|[KMGkmg](?:i?B)?)?$/.exec(v);
          if (!x) throw userErr(`od: invalid -${m[1]} argument '${v}'`);
          const u = x[2] || '', mult = u === 'b' ? 512 : u ? (/B$/.test(u) && !/iB$/.test(u) ? 1000 : 1024) ** { k: 1, m: 2, g: 3 }[u[0].toLowerCase()] : 1;
          const n = (/^0[xX]/.test(x[1]) ? parseInt(x[1], 16) : x[1].length > 1 && x[1][0] === '0' ? parseInt(x[1], 8) : parseInt(x[1], 10)) * mult;
          if (m[1] === 'N') count = n;
          else skip = n;
        }
        else width = parseInt(v, 10) || 16;
      } else if ((m = /^-([abcdosxvil]+)([AtNjw][\s\S]*)$/.exec(a))) {
        // -cAn: letters first, then an option with a value
        args.splice(i, 1, '-' + m[1], '-' + m[2]);
        i--;
      } else if (/^-[abcdosxvil]+$/.test(a)) {
        for (const c of a.slice(1)) {
          if (c === 'v') every = true;
          else types.push({ a: 'a', b: 'o1', c: 'c', d: 'u2', o: 'o2', s: 'd2', x: 'x2', i: 'd4', l: 'd8' }[c]);
        }
      } else throw userErr((a.startsWith('--') ? `od: unrecognized option '${a}'` : `od: invalid option -- '${Array.from(a.slice(1)).find((c) => !'abcdosxvil'.includes(c)) || a.slice(1)}'`) + "\nTry 'od --help' for more information.", 1);
    }
    if (!/^[doxn]$/.test(radix)) throw userErr(`od: invalid output address radix ‘${radix[0]}’; it must be one character from [doxn]`);
    if (!types.length) types.push('o2');
    const NAMED = ['nul', 'soh', 'stx', 'etx', 'eot', 'enq', 'ack', 'bel', 'bs', 'ht', 'nl', 'vt', 'ff', 'cr', 'so', 'si', 'dle', 'dc1', 'dc2', 'dc3', 'dc4', 'nak', 'syn', 'etb', 'can', 'em', 'sub', 'esc', 'fs', 'gs', 'rs', 'us', 'sp'];
    const ESC = { 0: '\\0', 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' };
    // one type: the size of a unit in bytes, the width of a field, and how a unit is written
    const spec = types.map((t) => {
      const m = /^([acdfoux])(\d?)(z?)$/.exec(t);
      if (!m || m[1] === 'f') throw userErr(`od: invalid type string ‘${t}’${m ? ' – floating point numbers are not available in this terminal' : ''}`);
      const k = m[1], size = k === 'a' || k === 'c' ? 1 : +(m[2] || (k === 'd' || k === 'u' || k === 'o' || k === 'x' ? 4 : 1));
      if (![1, 2, 4, 8].includes(size)) throw userErr(`od: invalid type string ‘${t}’`);
      const digits = { o: { 1: 3, 2: 6, 4: 11, 8: 22 }, x: { 1: 2, 2: 4, 4: 8, 8: 16 }, u: { 1: 3, 2: 5, 4: 10, 8: 20 }, d: { 1: 4, 2: 6, 4: 11, 8: 20 }, a: { 1: 3 }, c: { 1: 3 } }[k][size];
      const unit = (b, at) => {
        if (k === 'c') return ESC[b[at]] != null ? ESC[b[at]] : b[at] >= 32 && b[at] < 127 ? String.fromCharCode(b[at]) : b[at].toString(8).padStart(3, '0');
        if (k === 'a') return (b[at] & 127) === 127 ? 'del' : (b[at] & 127) <= 32 ? NAMED[b[at] & 127] : String.fromCharCode(b[at] & 127);
        let v = BigInt(0);
        for (let j = size - 1; j >= 0; j--) v = (v << BigInt(8)) | BigInt(at + j < b.length ? b[at + j] : 0);
        if (k === 'd' && v >> BigInt(size * 8 - 1)) v -= BigInt(1) << BigInt(size * 8);
        return k === 'o' ? v.toString(8).padStart(digits, '0') : k === 'x' ? v.toString(16).padStart(digits, '0') : v.toString();
      };
      return { size, digits, unit, chars: !!m[3] };
    });
    // every type is set out so that the fields of one byte stand under each other
    const per = Math.max(...spec.map((s) => (s.digits + 1) / s.size));
    // the files in turn. One that is not there is said and left out (status 1); /dev/zero and /dev/urandom have no
    // end: -N says how many bytes of them (od -An -N4 -tu4 /dev/urandom: a random number)
    const parts = [];
    for (const f of files.length ? files : ['-']) {
      if (/^\/dev\/(zero|u?random)$/.test(f)) {
        if (count === Infinity) throw userErr(`od: ${f} has no end – say how many bytes:  od -N 16 ${f}`);
        const b = new Uint8Array(Math.min(skip + count, 1 << 24));
        if (f !== '/dev/zero') for (let k = 0; k < b.length; k += 65536) crypto.getRandomValues(b.subarray(k, Math.min(b.length, k + 65536)));
        parts.push({ bytes: b });
      } else parts.push(...(await bytesOfEach(ctx, [f], 'od')));
    }
    const errors = [];
    let total = 0, opened = 0;
    for (const p of parts) {
      if (p.error) {
        errors.push({ at: total, msg: p.error });
        if (p.dir) opened++;
      } else {
        total += p.bytes.length;
        opened++;
      }
    }
    if (skip > total) {
      errors.forEach((e) => ctx.err(e.msg + '\n'));
      ctx.err('od: cannot skip past end of combined input\n');
      return 1;
    }
    const all = new Uint8Array(total);
    let fill = 0;
    for (const p of parts) {
      if (p.bytes) {
        all.set(p.bytes, fill);
        fill += p.bytes.length;
      }
    }
    const data = all.subarray(skip, Math.min(total, skip + count));
    const addr = (n) => (radix === 'n' ? '' : n.toString(radix === 'o' ? 8 : radix === 'd' ? 10 : 16).padStart(radix === 'x' ? 6 : 7, '0'));
    const code = errors.length ? 1 : 0;
    let out = [];
    // (what od says about a missing file comes where the file would have come: after the full lines before it)
    const said = (upTo) => {
      while (errors.length && errors[0].at < upTo) {
        if (out.length) ctx.out(out.join('\n') + '\n');
        out = [];
        ctx.err(errors.shift().msg + '\n');
      }
    };
    let prev = null, starred = false;
    for (let at = 0; at < data.length; at += width) {
      said(skip + at + width);
      const row = data.subarray(at, Math.min(data.length, at + width));
      const key = row.length === width ? Array.from(row).join(',') : null;
      if (!every && key != null && key === prev) {
        if (!starred) out.push('*');
        starred = true;
        continue;
      }
      prev = key;
      starred = false;
      spec.forEach((s, k) => {
        let line = k === 0 ? addr(skip + at) : ' '.repeat(addr(0).length);
        for (let j = 0; j < row.length; j += s.size) line += s.unit(row, j).padStart(Math.round(per * s.size));
        // eslint-disable-next-line no-control-regex
        if (s.chars) line += ' '.repeat(Math.max(0, Math.round(per * (width - row.length)))) + '  >' + Array.from(row, (c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('') + '<';
        out.push(line);
      });
    }
    said(Infinity);
    if (radix !== 'n' && opened) out.push(addr(skip + data.length));
    if (out.length) ctx.out(out.join('\n') + '\n');
    return code;
  };
  /* hexdump [-C] [-n LENGTH] [-s SKIP] [-v] [FILE …]: -C: the offset, 16 bytes in hexadecimal, and the text between | | */
  B.hexdump = B.hd = async (ctx) => {
    let canon = ctx.name === 'hd', skip = 0, count = Infinity, every = false;
    const files = [];
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (a === '-C' || a === '--canonical') canon = true;
      else if (a === '-v' || a === '--no-squeezing') every = true;
      else if (a === '-n' || a === '--length') count = sizeArg(ctx.args[++i], 'hexdump', 'length').n;
      else if (a === '-s' || a === '--skip') skip = sizeArg(ctx.args[++i], 'hexdump', 'offset').n;
      else if (/^-[nsCv]/.test(a) && a.length > 2 && /^-n\d|^-s\d/.test(a)) (a[1] === 'n' ? (count = sizeArg(a.slice(2), 'hexdump', 'length').n) : (skip = sizeArg(a.slice(2), 'hexdump', 'offset').n));
      else if (a.startsWith('-') && a !== '-') throw userErr(`hexdump: the option ${a} is not available in this terminal. There are: hexdump -C FILE (offset, bytes, text), hexdump FILE, -n LENGTH, -s SKIP, -v; and od -c, od -An -tx1, xxd`);
      else files.push(a);
    }
    let data = await allBytes(ctx, files, 'hexdump');
    data = data.subarray(Math.min(skip, data.length), Math.min(data.length, skip + count));
    const hex = (c) => c.toString(16).padStart(2, '0');
    const out = [];
    let prev = null, starred = false;
    for (let at = 0; at < data.length; at += 16) {
      const row = data.subarray(at, Math.min(data.length, at + 16));
      const key = row.length === 16 ? Array.from(row).join(',') : null;
      if (!every && key != null && key === prev) {
        if (!starred) out.push('*');
        starred = true;
        continue;
      }
      prev = key;
      starred = false;
      if (canon) {
        const left = Array.from(row.subarray(0, 8), hex).join(' '), right = Array.from(row.subarray(8), hex).join(' ');
        out.push(`${(skip + at).toString(16).padStart(8, '0')}  ${left.padEnd(23)}  ${right.padEnd(23)}  |${Array.from(row, (c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('')}|`);
      } else {
        // words of two bytes, the lower byte first – as hexdump shows them on this kind of computer
        const words = [];
        for (let j = 0; j < row.length; j += 2) words.push(hex(j + 1 < row.length ? row[j + 1] : 0) + hex(row[j]));
        out.push(`${(skip + at).toString(16).padStart(7, '0')} ${words.join(' ')}`.padEnd(47));
      }
    }
    if (data.length || canon) out.push((skip + data.length).toString(16).padStart(canon ? 8 : 7, '0'));
    if (out.length) ctx.out(out.join('\n') + '\n');
    return 0;
  };
  /* xxd [-p] [-r] [-u] [-l LENGTH] [-s SKIP] [-c COLUMNS] [-g BYTES] [FILE]: a hex dump – and back again with -r */
  B.xxd = async (ctx) => {
    let plain = false, reverse = false, upper = false, count = Infinity, skip = 0, cols = null, group = 2;
    const files = [];
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      let m;
      if (a === '-p' || a === '-ps' || a === '-postscript' || a === '-plain') plain = true;
      else if (a === '-r' || a === '-revert') reverse = true;
      else if (a === '-u') upper = true;
      else if ((m = /^-(l|len|s|seek|c|cols|g|groupsize)$/.exec(a))) {
        const v = ctx.args[++i];
        if (m[1][0] === 'l') count = parseInt(v, 0) || 0;
        else if (m[1][0] === 's') skip = Math.max(0, parseInt(v, 0) || 0);
        else if (m[1][0] === 'c') cols = parseInt(v, 0) || 16;
        else group = parseInt(v, 0) || 0;
      } else if (/^-(rp|pr)$/.test(a)) plain = reverse = true;
      else if (a.startsWith('-') && a !== '-') throw userErr(`xxd: the option ${a} is not available in this terminal. There are: xxd FILE, -p (plain), -r (back to bytes), -l LENGTH, -s SKIP, -c COLUMNS, -g BYTES, -u`);
      else files.push(a);
    }
    let data = await allBytes(ctx, files.slice(0, 1), 'xxd');
    if (reverse) {
      const text = new TextDecoder().decode(data);
      const hexes = plain ? text.replace(/[^0-9a-fA-F]/g, '') : linesOf(text).map((l) => l.replace(/^[0-9a-fA-F]+:\s?/, '').replace(/\s{2,}.*$/, '').replace(/\s/g, '')).join('');
      const bytes = new Uint8Array(Math.floor(hexes.length / 2));
      for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(hexes.substr(2 * k, 2), 16);
      putBytes(ctx, bytes, 'xxd');
      return 0;
    }
    data = data.subarray(Math.min(skip, data.length), Math.min(data.length, skip + count));
    const hex = (c) => (upper ? c.toString(16).toUpperCase() : c.toString(16)).padStart(2, '0');
    const n = cols || (plain ? 30 : 16), out = [];
    for (let at = 0; at < data.length; at += n) {
      const row = data.subarray(at, Math.min(data.length, at + n));
      if (plain) {
        out.push(Array.from(row, hex).join(''));
        continue;
      }
      let h = '';
      for (let j = 0; j < n; j++) {
        if (group && j && j % group === 0) h += ' ';
        h += j < row.length ? hex(row[j]) : '  ';
      }
      out.push(`${(skip + at).toString(16).padStart(8, '0')}: ${h}  ${Array.from(row, (c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('')}`);
    }
    if (out.length) ctx.out(out.join('\n') + '\n');
    return 0;
  };
  /* base64 [-d] [-w COLUMNS] [FILE]: bytes as text of 64 characters, and back */
  B.base64 = async (ctx) => {
    let decode = false, wrap = 76, garbage = false;
    const files = [];
    const bad = (msg) => userErr(`base64: ${msg}\nTry 'base64 --help' for more information.`);
    const width = (v) => {
      if (!/^\d+$/.test(v || '')) throw userErr(`base64: invalid wrap size: ‘${v}’`);
      return parseInt(v, 10);
    };
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      let m;
      if (a === '-' || !a.startsWith('-')) files.push(a);
      else if (a === '--decode') decode = true;
      else if (a === '--ignore-garbage') garbage = true;
      else if (a === '--wrap') wrap = width(ctx.args[++i]);
      else if ((m = /^--wrap=(.*)$/.exec(a))) wrap = width(m[1]);
      else if (a === '--') {
        files.push(...ctx.args.slice(i + 1));
        break;
      } else if (a.startsWith('--')) throw bad(`unrecognized option '${a}'`);
      else {
        for (let j = 1; j < a.length; j++) {
          const c = a[j];
          if (c === 'd' || c === 'D') decode = true;
          else if (c === 'i') garbage = true;
          else if (c === 'w') {
            wrap = width(j + 1 < a.length ? a.slice(j + 1) : ctx.args[++i]);
            break;
          } else throw bad(`invalid option -- '${c}'`);
        }
      }
    }
    if (files.length > 1) throw bad(`extra operand ‘${files[1]}’`);
    if (files.length && files[0] !== '-' && ctx.fs.isDir(files[0])) throw userErr('base64: read error: Is a directory');
    const data = await allBytes(ctx, files, 'base64');
    if (decode) {
      // (newlines may stand anywhere; -i: whatever is not of the alphabet is left out)
      let text = '';
      for (let k = 0; k < data.length; k += 0x8000) text += String.fromCharCode.apply(null, data.subarray(k, k + 0x8000));
      text = garbage ? text.replace(/[^A-Za-z0-9+/=]/g, '') : text.replace(/\n/g, '');
      const out = [];
      let ok = true, at = 0;
      const put = (g) => {
        for (const ch of atob(g)) out.push(ch.charCodeAt(0));
      };
      for (; at + 4 <= text.length; at += 4) {
        const g = text.slice(at, at + 4);
        if (!/^[A-Za-z0-9+/]{2}(?:[A-Za-z0-9+/]{2}|[A-Za-z0-9+/]=|==)$/.test(g)) break;
        put(g);
      }
      if (at < text.length) {
        // what is left is no whole group: what it still spells is written, and the input is said to be invalid
        ok = false;
        const rest = /^[A-Za-z0-9+/]{2,3}/.exec(text.slice(at, at + 4));
        if (rest) put(rest[0] + '='.repeat(4 - rest[0].length));
      }
      if (out.length) putBytes(ctx, Uint8Array.from(out), 'base64');
      if (!ok) {
        ctx.err('base64: invalid input\n');
        return 1;
      }
      return 0;
    }
    let bin = '';
    for (let k = 0; k < data.length; k += 0x8000) bin += String.fromCharCode.apply(null, data.subarray(k, k + 0x8000));
    const b64 = btoa(bin);
    ctx.out(wrap > 0 ? (b64.match(new RegExp(`.{1,${wrap}}`, 'g')) || []).map((l) => l + '\n').join('') : b64);
    return 0;
  };
  /* split [-l LINES | -b BYTES | -C BYTES | -n CHUNKS] [-d] [-x] [-a N] [--additional-suffix=S] [-e] [--verbose]
     [FILE [PREFIX]]: a file in pieces – xaa, xab, … (CHUNKS: N, K/N, l/N, l/K/N, r/N, r/K/N) */
  B.split = async (ctx) => {
    let lines = 1000, bytes = null, lineBytes = null, chunks = null, digits = '', start = 0, alen = null, more = '', verbose = false, elide = false;
    const rest = [];
    const bad = (msg) => userErr(`split: ${msg}\nTry 'split --help' for more information.`);
    const count = (v, what) => {
      if (!/^\d+$/.test(v || '') ) throw userErr(`split: invalid number of ${what}: ‘${v}’`);
      return parseInt(v, 10);
    };
    const size = (v) => {
      const m = /^(\d+)([KMGTkmgt]?)(i?B)?$|^(\d+)b$/.exec(v || '');
      if (!m) throw userErr(`split: invalid number of bytes: ‘${v}’`);
      if (m[4]) return +m[4] * 512;
      const p = { '': 0, k: 1, m: 2, g: 3, t: 4 }[(m[2] || '').toLowerCase()];
      return +m[1] * (m[3] === 'B' ? 1000 : 1024) ** p;
    };
    const set = (k, v) => {
      if (k === 'l') lines = count(v, 'lines');
      else if (k === 'b') bytes = size(v);
      else if (k === 'C') lineBytes = size(v);
      else if (k === 'n') chunks = v;
      else if (k === 'a') alen = count(v, 'suffix length');
    };
    const LONG = { lines: 'l', bytes: 'b', 'line-bytes': 'C', number: 'n', 'suffix-length': 'a' };
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      let m;
      if (a === '-' || !a.startsWith('-')) rest.push(a);
      else if (a === '--') {
        rest.push(...ctx.args.slice(i + 1));
        break;
      } else if ((m = /^--(numeric|hex)-suffixes(?:=(\d+))?$/.exec(a))) {
        digits = m[1] === 'hex' ? '0123456789abcdef' : '0123456789';
        start = +(m[2] || 0);
      } else if ((m = /^--additional-suffix=(.*)$/.exec(a))) more = m[1];
      else if (a === '--additional-suffix') more = ctx.args[++i] || '';
      else if (a === '--verbose') verbose = true;
      else if (a === '--elide-empty-files') elide = true;
      else if (/^--(filter|separator|unbuffered)(=|$)/.test(a)) throw userErr(`split: ${a.replace(/=.*/, '')} is not available in this terminal`);
      else if ((m = /^--([a-z-]+)(?:=(.*))?$/.exec(a))) {
        if (!LONG[m[1]]) throw bad(`unrecognized option '${a}'`);
        const v = m[2] != null ? m[2] : ctx.args[++i];
        if (v == null) throw bad(`option '--${m[1]}' requires an argument`);
        set(LONG[m[1]], v);
      } else if (/^-\d+$/.test(a)) lines = +a.slice(1);
      else {
        for (let j = 1; j < a.length; j++) {
          const c = a[j];
          if (c === 'd') digits = '0123456789';
          else if (c === 'x') digits = '0123456789abcdef';
          else if (c === 'e') elide = true;
          else if ('lbCna'.includes(c)) {
            const v = j + 1 < a.length ? a.slice(j + 1) : ctx.args[++i];
            if (v == null) throw bad(`option requires an argument -- '${c}'`);
            set(c, v);
            break;
          } else if (c === 't' || c === 'u') throw userErr(`split: -${c} is not available in this terminal`);
          else throw bad(`invalid option -- '${c}'`);
        }
      }
    }
    if (rest.length > 2) throw bad(`extra operand ‘${rest[2]}’`);
    if (!(lines > 0)) throw userErr('split: invalid number of lines: ‘0’');
    if (bytes === 0 || lineBytes === 0) throw userErr('split: invalid number of bytes: ‘0’');
    const input = rest.length && rest[0] !== '-' ? rest[0] : null;
    if (input != null) {
      const e = ctx.fs.get(input);
      if (!e) throw userErr(`split: cannot open '${input}' for reading: No such file or directory`);
      if (e.kind === 'dir') throw userErr(`split: ${input}: Is a directory`);
    }
    const data = await allBytes(ctx, input != null ? [input] : [], 'split');
    const prefix = rest[1] != null ? rest[1] : 'x';
    let pieces = [], toStdout = null;
    const lineEnds = () => {
      const ends = [];
      for (let k = 0; k < data.length; k++) if (data[k] === 10) ends.push(k + 1);
      if (!ends.length || ends[ends.length - 1] !== data.length) ends.push(data.length);
      return data.length ? ends : [];
    };
    if (chunks != null) {
      const m = /^(?:(l|r)\/)?(?:(\d+)\/)?(\d+)$/.exec(chunks);
      if (!m || +m[3] < 1 || (m[2] != null && (+m[2] < 1 || +m[2] > +m[3]))) throw userErr(`split: invalid number of chunks: ‘${chunks}’`);
      const n = +m[3], sz = Math.floor(data.length / n), rem = data.length % n;
      // (the first pieces are one byte longer when the size does not divide evenly)
      const endOf = (k) => (k + 1) * sz + Math.min(k + 1, rem);
      if (m[1] === 'r') {
        // r/N: the lines dealt out in turn
        const parts = Array.from({ length: n }, () => []);
        let from = 0;
        lineEnds().forEach((end, i) => {
          parts[i % n].push(data.subarray(from, end));
          from = end;
        });
        pieces = parts.map((ps) => {
          const all = new Uint8Array(ps.reduce((t, p) => t + p.length, 0));
          let at = 0;
          ps.forEach((p) => {
            all.set(p, at);
            at += p.length;
          });
          return all;
        });
      } else {
        let from = 0;
        for (let k = 0; k < n; k++) {
          let end = k === n - 1 ? data.length : endOf(k);
          // l/N: no line is cut – a piece ends with the line that reaches its last byte
          if (m[1] === 'l' && k < n - 1) {
            end = Math.max(end, from);
            while (end > from && end < data.length && data[end - 1] !== 10) end++;
          }
          pieces.push(data.subarray(Math.min(from, data.length), Math.min(Math.max(end, from), data.length)));
          from = Math.max(from, end);
        }
      }
      // K/N: only the Kth piece, to the output
      if (m[2] != null) toStdout = pieces[+m[2] - 1];
      else if (elide) pieces = pieces.filter((p) => p.length);
    } else if (bytes != null) {
      for (let k = 0; k < data.length; k += bytes) pieces.push(data.subarray(k, Math.min(data.length, k + bytes)));
    } else if (lineBytes != null) {
      // -C: whole lines while they fit into so many bytes; a line that is longer is cut
      let from = 0, at = 0;
      for (const end of lineEnds()) {
        if (end - from > lineBytes && at > from) {
          pieces.push(data.subarray(from, at));
          from = at;
        }
        while (end - from > lineBytes) {
          pieces.push(data.subarray(from, from + lineBytes));
          from += lineBytes;
        }
        at = end;
      }
      if (from < data.length) pieces.push(data.subarray(from));
    } else {
      let from = 0;
      lineEnds().forEach((end, i) => {
        if ((i + 1) % lines === 0) {
          pieces.push(data.subarray(from, end));
          from = end;
        }
      });
      if (from < data.length) pieces.push(data.subarray(from));
    }
    if (toStdout) {
      if (toStdout.length) putBytes(ctx, toStdout.slice(), 'split');
      return 0;
    }
    // the names: xaa, xab … – without -a the suffix grows when the names run out (… xyz, xzaaa)
    const abc = digits || 'abcdefghijklmnopqrstuvwxyz', base = abc.length;
    const suffix = (k) => {
      k += start;
      if (alen != null) {
        if (k >= base ** alen) throw userErr('split: output file suffixes exhausted');
        let t = '';
        for (let j = 0; j < alen; j++) {
          t = abc[k % base] + t;
          k = Math.floor(k / base);
        }
        return t;
      }
      let len = 2, lead = '';
      for (;;) {
        const room = (base - 1) * base ** (len - 1);
        if (k < room) break;
        k -= room;
        lead += abc[base - 1];
        len++;
      }
      let t = '';
      for (let j = 0; j < len; j++) {
        t = abc[k % base] + t;
        k = Math.floor(k / base);
      }
      return lead + t;
    };
    for (let k = 0; k < pieces.length; k++) {
      const name = prefix + suffix(k) + more, abs = ctx.fs.resolve(name);
      if (!ctx.fs.isDir(MG.path.dirname(abs))) throw userErr(`split: ${name}: No such file or directory`);
      if (ctx.fs.isDir(abs)) throw userErr(`split: ${name}: Is a directory`);
      if (verbose) ctx.out(`creating file '${name}'\n`);
      await MG.wasm.writeBytes(ctx.fs, abs, pieces[k].slice());
    }
    return 0;
  };
  /* truncate -s [+|-|<|>|/|%]SIZE [-c] [-r FILE] FILE …: make a file so many bytes long (cut off, or filled with
     zero bytes). + more, - less, < at most, > at least, / down and % up to a multiple. */
  B.truncate = async (ctx) => {
    let size = null, create = true, ref = null, blocks = false;
    const files = [];
    const bad = (msg) => userErr(`truncate: ${msg}\nTry 'truncate --help' for more information.`);
    const value = (i, a) => {
      if (i >= ctx.args.length) throw bad(a.startsWith('--') ? `option '${a}' requires an argument` : `option requires an argument -- '${a[1]}'`);
      return ctx.args[i];
    };
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      let m;
      if (a === '-s' || a === '--size') size = value(++i, a);
      else if ((m = /^(?:-s|--size=)([\s\S]+)$/.exec(a))) size = m[1];
      else if (a === '-r' || a === '--reference') ref = value(++i, a);
      else if ((m = /^(?:-r|--reference=)(.+)$/.exec(a))) ref = m[1];
      else if (a === '-c' || a === '--no-create') create = false;
      // -o: SIZE counts blocks of 4096 bytes
      else if (a === '-o' || a === '--io-blocks') blocks = true;
      else if (a === '--') {
        files.push(...ctx.args.slice(i + 1));
        break;
      } else if (a.startsWith('-') && a !== '-') throw bad(a.startsWith('--') ? `unrecognized option '${a}'` : `invalid option -- '${a[1]}'`);
      else files.push(a);
    }
    if (size == null && ref == null) throw bad('you must specify either ‘--size’ or ‘--reference’');
    if (!files.length) throw bad('missing file operand');
    let mode = '', n = 0;
    if (size != null) {
      const m = /^\s*([-+<>/%]?)(\d+)([KMGTkmgt]?)(i?B)?$/.exec(size);
      if (!m) throw userErr(`truncate: Invalid number: ‘${size}’`);
      mode = m[1];
      n = +m[2] * (m[4] === 'B' ? 1000 : 1024) ** { '': 0, k: 1, m: 2, g: 3, t: 4 }[m[3].toLowerCase()] * (blocks ? 4096 : 1);
      if ((mode === '/' || mode === '%') && n === 0) throw userErr('truncate: division by zero');
    }
    let refSize = null;
    if (ref != null) {
      const e = ctx.fs.get(ref);
      if (!e) throw userErr(`truncate: cannot stat '${ref}': No such file or directory`);
      refSize = ctx.fs.size(e);
      if (size != null && !mode) throw bad('you must specify a relative ‘--size’ with ‘--reference’');
    }
    let code = 0;
    for (const f of files) {
      const e = ctx.fs.get(f);
      if (!e && !create) continue;
      if (e && (e.kind === 'dir' || e.readonly || e.protected)) {
        ctx.err(`truncate: cannot open '${f}' for writing: ${e.kind === 'dir' ? 'Is a directory' : 'Permission denied'}\n`);
        code = 1;
        continue;
      }
      if (f === '' || !ctx.fs.isDir(MG.path.dirname(ctx.fs.resolve(f)))) {
        ctx.err(`truncate: cannot open '${f}' for writing: No such file or directory\n`);
        code = 1;
        continue;
      }
      const old = e ? await ctx.fs.readBytes(f) : new Uint8Array(0);
      const was = refSize != null ? refSize : old.length;
      const len = size == null ? was : Math.max(0, mode === '+' ? was + n : mode === '-' ? was - n : mode === '<' ? Math.min(was, n) : mode === '>' ? Math.max(was, n) : mode === '/' ? was - (was % n) : mode === '%' ? Math.ceil(was / n) * n : n);
      if (len === old.length && e) continue;
      if (len === 0) {
        if (e) ctx.fs.rewrite(f, '');
        else ctx.fs.writeText(f, '');
        continue;
      }
      const now = new Uint8Array(len);
      now.set(old.subarray(0, Math.min(len, old.length)));
      await MG.wasm.writeBytes(ctx.fs, ctx.fs.resolve(f), now);
    }
    return code;
  };
  /* expand [-t N | -t LIST] [-i] [FILE …]: tabs become spaces, up to the next tab stop (every 8 columns; -t 4: every 4;
     -t 3,8: stops at these columns, one space after the last). -i: only the tabs at the start of a line. */
  B.expand = async (ctx) => {
    let spec = null, initial = false;
    const files = [];
    const bad = (msg) => userErr(`expand: ${msg}\nTry 'expand --help' for more information.`);
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      let m;
      if (a === '-t' || a === '--tabs') spec = (spec ? spec + ',' : '') + (ctx.args[++i] || '');
      else if ((m = /^(?:-t|--tabs=)(.+)$/.exec(a))) spec = (spec ? spec + ',' : '') + m[1];
      else if ((m = /^-(\d[\d,]*)$/.exec(a))) spec = (spec ? spec + ',' : '') + m[1];
      else if (a === '-i' || a === '--initial') initial = true;
      else if ((m = /^-i(\d[\d,]*)$/.exec(a))) {
        initial = true;
        spec = (spec ? spec + ',' : '') + m[1];
      } else if (a === '--') {
        files.push(...ctx.args.slice(i + 1));
        break;
      } else if (a.startsWith('-') && a !== '-') throw bad(a.startsWith('--') ? `unrecognized option '${a}'` : `invalid option -- '${a[1]}'`);
      else files.push(a);
    }
    // the tab stops: one number – every so many columns; a list – at these columns (/N or +N at its end: from there
    // on every N columns)
    let every = 8, stops = [], after = 0;
    if (spec != null) {
      const items = spec.split(/[, ]+/).filter((x) => x !== '');
      const nums = [];
      items.forEach((x, k) => {
        const m = /^([/+]?)(\d+)$/.exec(x);
        if (!m) throw userErr(`expand: tab size contains invalid character(s): ‘${x}’`);
        if (m[1] && k !== items.length - 1) throw userErr(`expand: ‘${m[1]}’ specifier only allowed with the last value`);
        if (m[1]) after = m[1] === '/' ? +m[2] : -+m[2];
        else nums.push(+m[2]);
      });
      if (nums.length === 1 && !after) {
        every = nums[0];
        if (!every) throw userErr('expand: tab size cannot be 0');
      } else {
        for (let k = 1; k < nums.length; k++) if (nums[k] <= nums[k - 1]) throw userErr('expand: tab sizes must be ascending');
        stops = nums;
        every = 0;
      }
    }
    const next = (col) => {
      if (every) return col + every - (col % every);
      for (const s of stops) if (s > col) return s;
      const lastStop = stops.length ? stops[stops.length - 1] : 0;
      if (after > 0) return col + after - (col % after); // /N: multiples of N
      if (after < 0) return lastStop + (Math.floor((col - lastStop) / -after) + 1) * -after; // +N: every N after the last
      return col + 1; // behind the last stop a tab is one space
    };
    // (the files in turn; one that is not there is said and left out)
    let col = 0, lead = true, code = 0;
    for (const p of await bytesOfEach(ctx, files, 'expand')) {
      if (p.error) {
        ctx.err(p.error + '\n');
        code = 1;
        continue;
      }
      let out = '';
      for (const c of new TextDecoder().decode(p.bytes)) {
        if (c === '\n') {
          out += c;
          col = 0;
          lead = true;
        } else if (c === '\t' && (lead || !initial)) {
          const to = next(col);
          out += ' '.repeat(to - col);
          col = to;
        } else if (c === '\b') {
          out += c;
          col = Math.max(0, col - 1);
        } else {
          if (c !== ' ' && c !== '\t') lead = false;
          out += c;
          col++;
        }
      }
      ctx.out(out);
    }
    return code;
  };
  /* unexpand [-a] [-t N] [--first-only] [FILE…]: blanks to tabs – at the start of each line, with -a (or -t)
     everywhere a run of blanks reaches a tab stop (every 8 columns, or every N) */
  B.unexpand = async (ctx) => {
    let every = 8, allBlanks = false, firstOnly = false;
    const files = [];
    const bad = (msg) => userErr(`unexpand: ${msg}\nTry 'unexpand --help' for more information.`);
    const size = (v) => {
      if (!/^\d+$/.test(v || '')) throw userErr(`unexpand: tab size contains invalid character(s): \u2018${v}\u2019`);
      if (!+v) throw userErr('unexpand: tab size cannot be 0');
      allBlanks = true;
      return +v;
    };
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      let m;
      if (a === '-a' || a === '--all') allBlanks = true;
      else if (a === '--first-only') firstOnly = true;
      else if (a === '-t' || a === '--tabs') every = size(ctx.args[++i]);
      else if ((m = /^(?:-t|--tabs=)(.+)$/.exec(a))) every = size(m[1]);
      else if ((m = /^-(\d+)$/.exec(a))) every = size(m[1]);
      else if (a === '--') {
        files.push(...ctx.args.slice(i + 1));
        break;
      } else if (a.startsWith('-') && a !== '-') throw bad(a.startsWith('--') ? `unrecognized option '${a}'` : `invalid option -- '${a[1]}'`);
      else files.push(a);
    }
    if (firstOnly) allBlanks = false;
    let code = 0;
    for (const p of await bytesOfEach(ctx, files, 'unexpand')) {
      if (p.error) {
        ctx.err(p.error + '\n');
        code = 1;
        continue;
      }
      ctx.out(new TextDecoder().decode(p.bytes).split('\n').map((line) => {
        let out = '', col = 0, lead = true, run = '', runStart = 0;
        // a run of blanks that ends at column COL: tabs up to the last tab stop in it, the rest as it was
        const flush = () => {
          if (!run) return;
          const end = col, lastStop = end - (end % every);
          if ((lead || allBlanks) && lastStop > runStart && !(end - runStart === 1 && run === ' ')) {
            let c = runStart, tabs = '';
            while (c - (c % every) + every <= lastStop) {
              tabs += '\t';
              c = c - (c % every) + every;
            }
            out += tabs + ' '.repeat(end - lastStop);
          } else out += run;
          run = '';
        };
        for (const c of line) {
          if (c === ' ' || c === '\t') {
            if (!run) runStart = col;
            run += c;
            col = c === '\t' ? col - (col % every) + every : col + 1;
          } else {
            flush();
            lead = false;
            out += c;
            col = c === '\b' ? Math.max(0, col - 1) : col + 1;
          }
        }
        flush();
        return out;
      }).join('\n'));
    }
    return code;
  };
  /* ------------------------------------------------------------------ bc: the calculator
     Numbers of any length with a fixed number of digits after the point ("scale"), as POSIX bc does its sums:
       a + b, a - b   as many digits after the point as the longer of the two
       a * b          min(digits of a + digits of b, max(scale, digits of a, digits of b))
       a / b          scale digits, cut off (not rounded)
       a % b          a - (a / b) * b
       a ^ b          b a whole number
     Variables, scale, comparisons (1 or 0), if / while / for, { }, define f(x) { … return (…) }, print, sqrt(x),
     length(x), scale(x); ibase and obase (numbers read and printed in another base: obase=2; 99); with bc -l:
     scale = 20 and s(x) c(x) a(x) l(x) e(x) – sine, cosine, arc tangent, natural logarithm, exponential. */
  const Bn = (x) => BigInt(x);
  const P10 = (k) => Bn(10) ** Bn(k);
  const bcNum = (n, s) => ({ n, s });
  const bcParse = (t) => {
    const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
    return bcNum(Bn((m[1] || '') + (m[2] || '') || '0'), (m[2] || '').length);
  };
  const bcAt = (a, s) => (s >= a.s ? a.n * P10(s - a.s) : a.n / P10(a.s - s));
  // (long numbers go over several lines, each ending with a backslash)
  let bcLine = 70; // (BC_LINE_LENGTH: the length of a line of output, the backslash included; 0: no limit)
  const bcWrap = (d) => {
    let out = '';
    if (bcLine < 3) return d;
    while (d.length > bcLine - 2) {
      out += d.slice(0, bcLine - 2) + '\\\n';
      d = d.slice(bcLine - 2);
    }
    return out + d;
  };
  const bcText = (a, base) => {
    const neg = a.n < Bn(0);
    if (a.n === Bn(0)) return '0';
    if (base != null && base !== Bn(10)) {
      // another base (obase): the digits of the whole part; then those behind the point, as many as say as much
      // as the decimal ones did. Above base 16 a "digit" is a decimal number, with spaces between them.
      const abs = neg ? -a.n : a.n, lim = P10(a.s), small = base <= Bn(16), width = String(base - Bn(1)).length;
      const digit = (d) => (small ? '0123456789ABCDEF'[Number(d)] : String(d).padStart(width, '0'));
      let ip = abs / lim, fr = abs % lim, out = neg ? '-' : '';
      const digs = [];
      for (; ip > Bn(0); ip /= base) digs.push(ip % base);
      digs.reverse().forEach((d) => (out += (small ? '' : ' ') + digit(d)));
      if (a.s > 0) {
        out += '.';
        let first = true;
        for (let t = Bn(1); t < lim; t *= base) {
          fr *= base;
          out += (small || first ? '' : ' ') + digit(fr / lim);
          fr %= lim;
          first = false;
        }
      }
      return bcWrap(out);
    }
    let d = (neg ? -a.n : a.n).toString();
    if (a.s > 0) {
      d = d.padStart(a.s + 1, '0');
      d = d.slice(0, -a.s).replace(/^0$/, '') + '.' + d.slice(-a.s);
    }
    return bcWrap((neg ? '-' : '') + d);
  };
  const bcSqrt = (v) => {
    if (v < Bn(2)) return v;
    let x = Bn(1) << Bn(Math.ceil(v.toString(2).length / 2)), y = (x + v / x) >> Bn(1);
    while (y < x) {
      x = y;
      y = (x + v / x) >> Bn(1);
    }
    return x;
  };
  function bcMachine(lib, print, fail) {
    const vars = { scale: bcNum(Bn(lib ? 20 : 0), 0) }, arrays = {}, funcs = {};
    let last = bcNum(Bn(0), 0), lineBase = 0;
    const scale = () => Number(vars.scale.n);
    const add = (a, b, sign) => {
      const s = Math.max(a.s, b.s);
      return bcNum(bcAt(a, s) + Bn(sign) * bcAt(b, s), s);
    };
    const mul = (a, b, t) => {
      const full = a.s + b.s, s = t != null ? t : Math.min(full, Math.max(scale(), a.s, b.s));
      return bcNum(s >= full ? a.n * b.n * P10(s - full) : (a.n * b.n) / P10(full - s), s);
    };
    const div = (a, b, t) => {
      if (b.n === Bn(0)) throw fail('Divide by zero');
      const s = t != null ? t : scale();
      return bcNum((a.n * P10(s + b.s)) / (b.n * P10(a.s)), s);
    };
    const mod = (a, b) => {
      if (b.n === Bn(0)) throw fail('Modulo by zero');
      const q = div(a, b), s = Math.max(scale() + b.s, a.s);
      const prod = bcNum(q.n * b.n, q.s + b.s);
      return bcNum(bcAt(a, s) - bcAt(prod, s), s);
    };
    const pow = (a, b) => {
      let e = b.n / P10(b.s);
      if (b.s && bcAt(bcNum(e, 0), b.s) !== b.n) print.err('Runtime warning (func=(main), adr=0): non-zero scale in exponent\n');
      if (e === Bn(0)) return bcNum(Bn(1), 0);
      const neg = e < Bn(0);
      if (neg) e = -e;
      if (e > Bn(100000)) throw fail('exponent too large in raise');
      let r = bcNum(Bn(1), 0), x = a, k = e;
      while (k > Bn(0)) {
        if (k & Bn(1)) r = bcNum(r.n * x.n, r.s + x.s);
        k >>= Bn(1);
        if (k > Bn(0)) x = bcNum(x.n * x.n, x.s * 2);
      }
      if (neg) return div(bcNum(Bn(1), 0), r);
      const s = Math.min(a.s * Number(e), Math.max(scale(), a.s));
      return bcNum(bcAt(r, s), s);
    };
    const cmp = (a, b) => {
      const s = Math.max(a.s, b.s), x = bcAt(a, s), y = bcAt(b, s);
      return x < y ? -1 : x > y ? 1 : 0;
    };
    const num = (k) => bcNum(Bn(k), 0);
    const neg = (a) => bcNum(-a.n, a.s);
    // ---- the mathematical functions of bc -l. Each follows the steps that bc's own library takes – the same series,
    // the same number of extra digits at each point – so that the last digit comes out as it does in bc.
    const setScale = (k) => (vars.scale = bcNum(Bn(Math.max(0, Math.trunc(k))), 0));
    const whole = (a) => Number(a.n / P10(a.s));
    const lit = (t) => bcParse(t);
    const mathE = (x0) => {
      const z = scale();
      let x = x0, minus = false, f = 0;
      if (x.n < Bn(0)) {
        minus = true;
        x = neg(x);
      }
      try {
        // e^x = (e^(x/2))^2: x is halved until it is at most 1; then 1 + x + x²/2! + x³/3! …
        const n = 6 + z + whole(mul(lit('.44'), x));
        setScale(x.s + 1);
        while (cmp(x, num(1)) > 0) {
          f++;
          x = div(x, num(2));
          setScale(scale() + 1);
        }
        setScale(n);
        let v = add(num(1), x, 1), a = x, d = num(1);
        for (let i = 2; ; i++) {
          a = mul(a, x);
          d = mul(d, num(i));
          const e = div(a, d);
          if (e.n === Bn(0)) {
            while (f-- > 0) v = mul(v, v);
            setScale(z);
            return minus ? div(num(1), v) : div(v, num(1));
          }
          v = add(v, e, 1);
          if (i > 100000) throw fail('the calculation went on for too long and was stopped');
        }
      } finally {
        setScale(z);
      }
    };
    const root = (v) => {
      const t = Math.max(scale(), v.s);
      return bcNum(bcSqrt(v.n * P10(2 * t - v.s)), t);
    };
    const mathL = (x0) => {
      const z = scale();
      // (the logarithm of 0 or of a negative number: bc gives a very large negative number)
      if (x0.n <= Bn(0)) return div(add(num(1), pow(num(10), num(z)), -1), num(1));
      let x = x0, f = num(2);
      try {
        // ln x² = 2 ln x: square roots bring x between .5 and 2; then ln x = 2 (a + a³/3 + a⁵/5 …), a = (x-1)/(x+1)
        setScale(6 + z);
        while (cmp(x, num(2)) >= 0) {
          f = mul(f, num(2));
          x = root(x);
        }
        while (cmp(x, lit('.5')) <= 0) {
          f = mul(f, num(2));
          x = root(x);
        }
        let n = div(add(x, num(1), -1), add(x, num(1), 1)), v = n;
        const m = mul(n, n);
        for (let i = 3; ; i += 2) {
          n = mul(n, m);
          const e = div(n, num(i));
          if (e.n === Bn(0)) {
            v = mul(f, v);
            setScale(z);
            return div(v, num(1));
          }
          v = add(v, e, 1);
          if (i > 200000) throw fail('the calculation went on for too long and was stopped');
        }
      } finally {
        setScale(z);
      }
    };
    const ATAN1 = ['.7853981633974483096156608', '.7853981633974483096156608458198757210492', '.785398163397448309615660845819875721049292349843776455243736'];
    const ATAN02 = ['.1973955598498807583700497', '.1973955598498807583700497651947902934475', '.197395559849880758370049765194790293447585103787852101517688'];
    const mathA = (x0) => {
      const z = scale();
      let x = x0, m = num(1);
      if (x.n < Bn(0)) {
        m = num(-1);
        x = neg(x);
      }
      // (π/4 and atan .2 are known numbers)
      const known = (list) => (z <= 25 ? list[0] : z <= 40 ? list[1] : z <= 60 ? list[2] : null);
      if (cmp(x, num(1)) === 0 && known(ATAN1)) return div(lit(known(ATAN1)), m);
      if (cmp(x, lit('.2')) === 0 && known(ATAN02)) return div(lit(known(ATAN02)), m);
      try {
        // atan x = atan c + atan ((x - c) / (1 + x c)) with c = .2; below .2 the series x - x³/3 + x⁵/5 …
        let a = num(0), f = num(0);
        const c = lit('.2');
        if (cmp(x, c) > 0) {
          setScale(z + 5);
          a = mathA(c);
        }
        setScale(z + 3);
        while (cmp(x, c) > 0) {
          f = add(f, num(1), 1);
          x = div(add(x, c, -1), add(num(1), mul(x, c), 1));
        }
        let n = x, v = x;
        const s = neg(mul(x, x));
        for (let i = 3; ; i += 2) {
          n = mul(n, s);
          const e = div(n, num(i));
          if (e.n === Bn(0)) {
            setScale(z);
            return div(add(mul(f, a), v, 1), m);
          }
          v = add(v, e, 1);
          if (i > 200000) throw fail('the calculation went on for too long and was stopped');
        }
      } finally {
        setScale(z);
      }
    };
    const mathS = (x0) => {
      const z = scale();
      let x = x0, minus = false;
      try {
        // the angle less a whole number of half turns (π = 4 atan 1), then x - x³/3! + x⁵/5! …
        setScale(whole(add(mul(lit('1.1'), num(z)), num(2), 1)));
        let v = mathA(num(1));
        if (x.n < Bn(0)) {
          minus = true;
          x = neg(x);
        }
        setScale(0);
        const n = div(add(div(x, v), num(2), 1), num(4));
        x = add(x, mul(mul(num(4), n), v), -1);
        if (mod(n, num(2)).n !== Bn(0)) x = neg(x);
        setScale(z + 2);
        let e = x;
        v = x;
        const s = neg(mul(x, x));
        for (let i = 3; ; i += 2) {
          e = mul(e, div(s, num(i * (i - 1))));
          if (e.n === Bn(0)) {
            setScale(z);
            return minus ? div(neg(v), num(1)) : div(v, num(1));
          }
          v = add(v, e, 1);
          if (i > 200000) throw fail('the calculation went on for too long and was stopped');
        }
      } finally {
        setScale(z);
      }
    };
    const mathC = (x) => {
      // cos x = sin (x + π/2), with a fifth more digits
      const z = scale();
      try {
        setScale(whole(mul(num(z), lit('1.2'))));
        const v = mathS(add(x, mul(mathA(num(1)), num(2)), 1));
        setScale(z);
        return div(v, num(1));
      } finally {
        setScale(z);
      }
    };
    // ---- the language
    function lexBc(src) {
      const toks = [];
      const re = /[ \t\r]*(?:(\/\*[\s\S]*?\*\/|#[^\n]*)|(\n|;)|("(?:[^"])*")|((?:[0-9A-F]+\.?[0-9A-F]*|\.[0-9A-F]+))|([a-z][a-z0-9_]*|\.)|(\+\+|--|[-+*/%^]=|==|<=|>=|!=|&&|\|\||[-+*/%^=<>!(){},[\]]))/y;
      let pos = 0, ln = 0;
      src = src.replace(/\\\n/g, '');
      while (pos < src.length) {
        re.lastIndex = pos;
        const m = re.exec(src);
        if (!m || m.index !== pos) {
          if (!src.slice(pos).trim()) break;
          // (a character that bc does not know: said, left out, and the line goes on)
          const at = pos + /^[ \t\r]*/.exec(src.slice(pos))[0].length;
          print.err(`(standard_in) ${lineBase + ln + 1}: illegal character: ${src[at]}\n`);
          pos = at + 1;
          continue;
        }
        pos = re.lastIndex;
        if (m[1]) {
          ln += m[1].split('\n').length - 1;
          continue;
        }
        if (m[2]) {
          toks.push({ t: ';', line: ln, nl: m[2] === '\n' });
          if (m[2] === '\n') ln++;
        } else if (m[3]) {
          toks.push({ t: 'str', v: m[3].slice(1, -1), line: ln });
          ln += m[3].split('\n').length - 1;
        } else if (m[4]) toks.push({ t: 'num', v: m[4], line: ln });
        else if (m[5]) toks.push({ t: 'id', v: m[5] === '.' ? 'last' : m[5], line: ln }); // (a lone . is the last number that was printed)
        else if (m[6]) toks.push({ t: m[6], line: ln });
      }
      return toks;
    }
    function parseBc(toks) {
      let p = 0;
      // (a mistake is reported with the line it stands in – found at the end of a line, with the next one, as bc does)
      const synErr = () => {
        const t = toks[p], lastTok = toks[toks.length - 1];
        return Object.assign(fail('syntax error', true), { line: t ? t.line + (t.nl ? 1 : 0) : lastTok ? lastTok.line + (lastTok.nl ? 1 : 0) : 0 });
      };
      const peek = () => toks[p], is = (t) => toks[p] && toks[p].t === t, isId = (v) => toks[p] && toks[p].t === 'id' && toks[p].v === v;
      const eat = (t) => {
        if (!is(t)) throw synErr();
        return toks[p++];
      };
      const skip = () => {
        while (is(';')) p++;
      };
      const KEY = ['if', 'else', 'while', 'for', 'define', 'return', 'break', 'continue', 'quit', 'halt', 'print', 'auto', 'sqrt', 'length', 'scale', 'ibase', 'obase', 'last', 'read'];
      const primary = () => {
        const t = peek();
        if (!t) throw synErr();
        if (t.t === 'num') return p++, { k: 'num', raw: t.v };
        if (t.t === '(') {
          p++;
          const e = expr();
          eat(')');
          // ((x = 6) is an expression like any other: bc prints its value; x = 6 alone is not printed)
          return e.k === 'assign' ? Object.assign({}, e, { shown: true }) : e;
        }
        if (t.t === 'id') {
          p++;
          if (is('(')) {
            p++;
            const args = [];
            while (!is(')')) {
              args.push(expr());
              if (is(',')) p++;
              else break;
            }
            eat(')');
            return { k: 'call', name: t.v, args };
          }
          if (is('[')) {
            p++;
            const idx = expr();
            eat(']');
            return { k: 'elem', name: t.v, idx };
          }
          return { k: 'var', name: t.v };
        }
        throw synErr();
      };
      const lvalue = (e) => e.k === 'var' || e.k === 'elem';
      const postfix = () => {
        if (is('++') || is('--')) {
          const op = toks[p++].t, e = primary();
          if (!lvalue(e)) throw synErr();
          return { k: 'pre', op, e };
        }
        const e = primary();
        if ((is('++') || is('--')) && lvalue(e)) return { k: 'post', op: toks[p++].t, e };
        return e;
      };
      const unary = () => {
        if (is('-')) return p++, { k: 'neg', e: unary() };
        return postfix();
      };
      const power = () => {
        const b = unary();
        if (is('^')) return p++, { k: 'bin', op: '^', a: b, b: power() };
        return b;
      };
      const level = (ops, next) => () => {
        let a = next();
        while (peek() && ops.includes(peek().t)) a = { k: 'bin', op: toks[p++].t, a, b: next() };
        return a;
      };
      const term = level(['*', '/', '%'], power), sum = level(['+', '-'], term);
      const assign = () => {
        const save = p;
        if (is('id')) {
          const e = primary();
          if (lvalue(e) && peek() && /^([-+*/%^]?=)$/.test(peek().t)) {
            const op = toks[p++].t;
            return { k: 'assign', op, e, v: assign() };
          }
          p = save;
        }
        return sum();
      };
      const rel = () => {
        let a = assign();
        while (peek() && ['<', '<=', '>', '>=', '==', '!='].includes(peek().t)) a = { k: 'bin', op: toks[p++].t, a, b: assign() };
        return a;
      };
      const not = () => (is('!') ? (p++, { k: 'not', e: not() }) : rel());
      const and = level(['&&'], not), or = level(['||'], and);
      function expr() {
        return or();
      }
      const block = () => {
        eat('{');
        const list = [];
        skip();
        while (!is('}')) {
          if (!peek()) throw synErr();
          list.push(stmt());
          skip();
        }
        p++;
        return { k: 'block', list };
      };
      function stmt() {
        skip();
        const t = peek();
        if (!t) return { k: 'block', list: [] };
        if (t.t === '{') return block();
        if (t.t === 'str') return p++, { k: 'str', v: t.v };
        if (t.t === 'id' && KEY.includes(t.v) && !['sqrt', 'length', 'scale', 'ibase', 'obase', 'last', 'read'].includes(t.v)) {
          p++;
          switch (t.v) {
            case 'if': {
              eat('(');
              const c = expr();
              eat(')');
              while (is(';') && toks[p + 1] && (toks[p + 1].t === '{' || false)) p++;
              const a = stmt();
              let b = null;
              const save = p;
              skip();
              if (isId('else')) {
                p++;
                b = stmt();
              } else p = save;
              return { k: 'if', c, a, b };
            }
            case 'while': {
              eat('(');
              const c = expr();
              eat(')');
              return { k: 'while', c, body: stmt() };
            }
            case 'for': {
              eat('(');
              const init = is(';') ? null : expr();
              eat(';');
              const c = is(';') ? null : expr();
              eat(';');
              const step = is(')') ? null : expr();
              eat(')');
              return { k: 'for', init, c, step, body: stmt() };
            }
            case 'define': {
              // (define void f(x) { … }: a function whose result is not printed when it is called by itself)
              const isVoid = isId('void');
              if (isVoid) p++;
              const name = eat('id').v;
              eat('(');
              const params = [];
              while (is('id')) {
                params.push(toks[p++].v);
                if (is('[')) p += 2;
                if (is(',')) p++;
              }
              eat(')');
              skip();
              eat('{');
              skip();
              const autos = [];
              if (isId('auto')) {
                p++;
                while (is('id')) {
                  autos.push(toks[p++].v);
                  if (is('[')) p += 2;
                  if (is(',')) p++;
                }
              }
              const list = [];
              skip();
              while (!is('}')) {
                if (!peek()) throw synErr();
                list.push(stmt());
                skip();
              }
              p++;
              return { k: 'define', name, params, autos, isVoid, body: { k: 'block', list } };
            }
            case 'return': {
              if (is(';') || !peek() || is('}')) return { k: 'return', e: null };
              return { k: 'return', e: expr() };
            }
            case 'break': return { k: 'break' };
            case 'continue': return { k: 'continue' };
            case 'quit': return { k: 'quit' };
            case 'halt': return { k: 'halt' };
            case 'print': {
              const items = [];
              for (;;) {
                if (is('str')) items.push({ k: 'str', v: toks[p++].v });
                else items.push(expr());
                if (is(',')) p++;
                else break;
              }
              return { k: 'print', items };
            }
            default: throw synErr();
          }
        }
        return { k: 'expr', e: expr() };
      }
      const prog = [];
      for (;;) {
        skip();
        if (!peek()) break;
        prog.push(stmt());
        if (peek() && !is(';') && !is('}')) throw synErr();
      }
      return prog;
    }
    const BREAK = { ctl: 'break' }, CONTINUE = { ctl: 'continue' };
    let steps = 0;
    const getVar = (name) => {
      if (name === 'last') return last;
      if (name === 'ibase' || name === 'obase') return vars[name] || num(10);
      return vars[name] || num(0);
    };
    // a number as it was written, read in the base that ibase names when the line is carried out: a single digit
    // is itself (A is 10 in any base); in a longer number a digit that is too large counts as the largest
    const constant = (raw) => {
      const base = getVar('ibase').n;
      if (base === Bn(10) && !/[A-F]/.test(raw)) return bcParse(raw);
      if (raw.length === 1) return num(parseInt(raw, 16));
      const [ip, fp = ''] = raw.split('.');
      const dig = (ch) => {
        const d = Bn(parseInt(ch, 16));
        return d >= base ? base - Bn(1) : d;
      };
      let n = Bn(0), f = Bn(0);
      for (const ch of ip) n = n * base + dig(ch);
      if (!fp) return bcNum(n, 0);
      for (const ch of fp) f = f * base + dig(ch);
      return bcNum(n * P10(fp.length) + (f * P10(fp.length)) / base ** Bn(fp.length), fp.length);
    };
    const show = (v) => bcText(v, getVar('obase').n);
    const setRef = (e, v) => {
      if (e.k === 'var') {
        if (e.name === 'scale') {
          if (v.n / P10(v.s) > Bn(2000)) throw fail('scale must be between 0 and 2000 in this terminal');
          if (v.n < Bn(0)) print.err('Runtime warning (func=(main), adr=0): negative scale, set to 0\n');
          vars.scale = v.n < Bn(0) ? bcNum(Bn(0), 0) : bcNum(v.n / P10(v.s), 0);
        } else if (e.name === 'ibase' || e.name === 'obase') {
          let b = v.n / P10(v.s);
          const top = e.name === 'ibase' ? Bn(16) : Bn(2147483647);
          if (b < Bn(2) || b > top) {
            print.err(`Runtime warning (func=(main), adr=0): ${e.name} too ${b < Bn(2) ? 'small' : 'large'}, set to ${b < Bn(2) ? 2 : top}\n`);
            b = b < Bn(2) ? Bn(2) : top;
          }
          vars[e.name] = bcNum(b, 0);
        } else vars[e.name] = v;
      } else {
        const i = ev(e.idx);
        (arrays[e.name] = arrays[e.name] || {})[(i.n / P10(i.s)).toString()] = v;
      }
    };
    const getRef = (e) => {
      if (e.k === 'var') return getVar(e.name);
      const i = ev(e.idx);
      return (arrays[e.name] || {})[(i.n / P10(i.s)).toString()] || num(0);
    };
    const truth = (v) => v.n !== Bn(0);
    function ev(e) {
      switch (e.k) {
        case 'num': return constant(e.raw);
        case 'var':
        case 'elem': return getRef(e);
        case 'neg': return neg(ev(e.e));
        case 'not': return num(truth(ev(e.e)) ? 0 : 1);
        case 'pre': {
          const v = add(getRef(e.e), num(1), e.op === '++' ? 1 : -1);
          setRef(e.e, v);
          return v;
        }
        case 'post': {
          const v = getRef(e.e);
          setRef(e.e, add(v, num(1), e.op === '++' ? 1 : -1));
          return v;
        }
        case 'assign': {
          let v = ev(e.v);
          if (e.op !== '=') v = binary(e.op[0], getRef(e.e), v);
          setRef(e.e, v);
          return v;
        }
        case 'bin': {
          // (a long sum – seq 1 50000 | paste -sd+ | bc – is a chain of 50,000 of these, each one the left side of
          // the next: it is worked off in a loop, not by one call inside the other)
          const chain = [];
          let x = e;
          while (x.k === 'bin') {
            chain.push(x);
            x = x.a;
          }
          let v = ev(x);
          for (let i = chain.length - 1; i >= 0; i--) {
            const c = chain[i];
            if (c.op === '&&') v = num(truth(v) && truth(ev(c.b)) ? 1 : 0);
            else if (c.op === '||') v = num(truth(v) || truth(ev(c.b)) ? 1 : 0);
            else v = binary(c.op, v, ev(c.b));
          }
          return v;
        }
        case 'call': return call(e);
        default: throw fail('syntax error', true);
      }
    }
    function binary(op, a, b) {
      switch (op) {
        case '+': return add(a, b, 1);
        case '-': return add(a, b, -1);
        case '*': return mul(a, b);
        case '/': return div(a, b);
        case '%': return mod(a, b);
        case '^': return pow(a, b);
        case '<': return num(cmp(a, b) < 0 ? 1 : 0);
        case '<=': return num(cmp(a, b) <= 0 ? 1 : 0);
        case '>': return num(cmp(a, b) > 0 ? 1 : 0);
        case '>=': return num(cmp(a, b) >= 0 ? 1 : 0);
        case '==': return num(cmp(a, b) === 0 ? 1 : 0);
        case '!=': return num(cmp(a, b) !== 0 ? 1 : 0);
        default: throw fail('syntax error', true);
      }
    }
    function call(e) {
      const a = e.args.map(ev);
      const one = () => {
        if (a.length !== 1) throw fail(`Parameter number mismatch`);
        return a[0];
      };
      switch (e.name) {
        case 'sqrt': {
          const x = one();
          if (x.n < Bn(0)) throw fail('Square root of a negative number');
          const s = Math.max(scale(), x.s);
          return bcNum(bcSqrt(x.n * P10(2 * s - x.s)), s);
        }
        case 'length': {
          const x = one(), d = (x.n < Bn(0) ? -x.n : x.n).toString();
          return num(x.n === Bn(0) ? Math.max(1, x.s) : Math.max(d.length, x.s));
        }
        case 'scale': return num(one().s);
        default:
      }
      if (funcs[e.name]) {
        const f = funcs[e.name];
        if (a.length !== f.params.length) throw fail('Parameter number mismatch');
        const names = f.params.concat(f.autos), saved = names.map((k) => vars[k]);
        f.params.forEach((k, i) => (vars[k] = a[i]));
        f.autos.forEach((k) => (vars[k] = num(0)));
        try {
          run(f.body);
          return num(0);
        } catch (r) {
          if (r && r.ctl === 'return') return r.v;
          throw r;
        } finally {
          names.forEach((k, i) => {
            if (saved[i] === undefined) delete vars[k];
            else vars[k] = saved[i];
          });
        }
      }
      if (lib) {
        switch (e.name) {
          case 'e': return mathE(one());
          case 'l': return mathL(one());
          case 's': return mathS(one());
          case 'c': return mathC(one());
          case 'a': return mathA(one());
          default:
        }
      }
      throw fail(`Function ${e.name} not defined.`);
    }
    function run(s) {
      if (++steps > 2000000) throw fail('the calculation went on for too long and was stopped');
      switch (s.k) {
        case 'block':
          for (const x of s.list) run(x);
          return;
        case 'expr': {
          const v = ev(s.e);
          if ((s.e.k !== 'assign' || s.e.shown) && !(s.e.k === 'call' && funcs[s.e.name] && funcs[s.e.name].isVoid)) {
            print.out(show(v) + '\n');
            last = v;
          }
          return;
        }
        case 'str': return print.out(s.v);
        case 'print':
          for (const it of s.items) {
            if (it.k === 'str') print.out(it.v.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\q/g, '"').replace(/\\\\/g, '\\'));
            else {
              const v = ev(it);
              print.out(show(v));
              last = v;
            }
          }
          return;
        case 'if':
          if (truth(ev(s.c))) run(s.a);
          else if (s.b) run(s.b);
          return;
        case 'while':
          while (truth(ev(s.c))) {
            try {
              run(s.body);
            } catch (c) {
              if (c === BREAK) break;
              if (c !== CONTINUE) throw c;
            }
          }
          return;
        case 'for':
          if (s.init) ev(s.init);
          while (!s.c || truth(ev(s.c))) {
            try {
              run(s.body);
            } catch (c) {
              if (c === BREAK) break;
              if (c !== CONTINUE) throw c;
            }
            if (s.step) ev(s.step);
          }
          return;
        case 'define':
          funcs[s.name] = s;
          return;
        case 'return': throw { ctl: 'return', v: s.e ? ev(s.e) : num(0) };
        case 'break': throw BREAK;
        case 'continue': throw CONTINUE;
        case 'quit':
        case 'halt': throw { ctl: 'quit' };
        default:
      }
    }
    return {
      run,
      parse: (src, base) => {
        lineBase = base || 0;
        return parseBc(lexBc(src));
      }
    };
  }
  B.bc = async (ctx) => {
    let lib = false;
    const files = [];
    for (const a of ctx.args) {
      if (a === '-l' || a === '--mathlib') lib = true;
      else if (/^-[lqsw]+$/.test(a)) lib = lib || a.includes('l');
      else if (a === '--quiet' || a === '--standard' || a === '--warn') continue;
      else if (a === '--version' || a === '-v') {
        ctx.out('bc of this terminal: a calculator written for the practical (it is not GNU bc; it does the same sums).\n');
        return 0;
      } else if (a === '-h' || a === '--help') {
        ctx.out('usage: bc [options] [file ...]\n  -h  --help         print this usage and exit\n  -i  --interactive  force interactive mode\n  -l  --mathlib      use the predefined math routines\n  -q  --quiet        don\'t print initial banner\n  -s  --standard     non-standard bc constructs are errors\n  -w  --warn         warn about non-standard bc constructs\n  -v  --version      print version information and exit\n');
        return 0;
      } else if (a.startsWith('-') && a !== '-') throw userErr(`bc: invalid option -- '${a.replace(/^-+/, '')}'\nusage: bc [options] [file ...]`);
      else files.push(a);
    }
    let src = '', missing = null;
    for (const f of files) {
      const e = ctx.fs.get(f);
      if (!e || e.kind === 'dir') {
        missing = f;
        break;
      }
      src += new TextDecoder().decode(await fileBytes(ctx, f, 'bc'));
    }
    if (missing == null && (!files.length || ctx.stdin != null || (ctx.inherit && ctx.inherit.pos < ctx.inherit.text.length))) {
      if (ctx.stdin == null && !(ctx.inherit && ctx.inherit.pos < ctx.inherit.text.length)) {
        ctx.io.note('bc: this terminal cannot ask you for input – give the sum like this:  echo "scale=2; 10 / 3" | bc');
        return 0;
      }
      src += new TextDecoder().decode(await stdinBytes(ctx));
    }
    class BcError extends Error {}
    const fail = (msg, syntax) => Object.assign(new BcError(msg), { syntax: !!syntax });
    const machine = bcMachine(lib, { out: (t) => ctx.out(t), err: (t) => ctx.err(t) }, fail);
    // BC_LINE_LENGTH=0: long numbers on one line (default: lines of 70 characters, cut with a backslash)
    const len = ctx.env && ctx.env.BC_LINE_LENGTH;
    bcLine = /^\d+$/.test(len || '') ? (+len === 0 ? 0 : Math.max(3, +len)) : 70;
    // (does a statement – or one inside it – say quit? bc ends when it READS quit, before it carries anything out)
    // (looked for with a list of what is still to be looked at: a sum of 50,000 terms is 50,000 levels deep)
    const quits = (root) => {
      const todo = [root];
      while (todo.length) {
        const x = todo.pop();
        if (!x || typeof x !== 'object') continue;
        if (x.k === 'quit') return true;
        for (const v of Array.isArray(x) ? x : Object.values(x)) if (v && typeof v === 'object') todo.push(v);
      }
      return false;
    };
    // bc reads and carries out its input line by line: a line with a mistake is reported, and the next ones still run
    // (a statement that is not finished at the end of a line – an open { – goes on in the next)
    const linesIn = src.split('\n');
    // (the last line has to end with a newline – bc does not carry out one that does not: printf '1+1' | bc)
    const cutOff = !src.endsWith('\n') && linesIn[linesIn.length - 1].trim() !== '' ? linesIn.pop() : null;
    if (cutOff == null) linesIn.pop();
    let buf = '', lineNo = 0, start = 1;
    const open = (t) => {
      let depth = 0, quote = false;
      for (const c of t.replace(/\/\*[\s\S]*?\*\//g, '')) {
        if (c === '"') quote = !quote;
        else if (!quote && (c === '{' || c === '(')) depth++;
        else if (!quote && (c === '}' || c === ')')) depth--;
      }
      return depth > 0 || quote || /\/\*(?![\s\S]*\*\/)/.test(t);
    };
    for (const line of linesIn) {
      lineNo++;
      if (buf === '') start = lineNo;
      buf += line + '\n';
      if (open(buf) || /\\$/.test(line)) continue;
      const text = buf;
      buf = '';
      let prog;
      try {
        prog = machine.parse(text, start - 1);
      } catch (e) {
        if (!(e instanceof BcError)) throw e;
        ctx.err(`(standard_in) ${start + (e.line || 0)}: ${e.message}\n`);
        continue;
      }
      if (prog.some(quits)) return 0;
      try {
        for (const s of prog) machine.run(s);
      } catch (e) {
        if (e && e.ctl === 'quit') return 0;
        if (e && e.ctl) continue;
        if (!(e instanceof BcError)) throw e;
        ctx.err(e.syntax ? `(standard_in) ${start}: ${e.message}\n` : `Runtime error (func=(main), adr=0): ${e.message}\n`);
      }
    }
    if (buf.trim()) ctx.err(`(standard_in) ${lineNo + 1}: syntax error\n`);
    else if (cutOff != null) {
      ctx.err(`(standard_in) ${lineNo + 1}: syntax error\n`);
      ctx.io.note('bc carries out a line when the line has ended: the last line needs a newline at its end. echo adds one; printf needs \\n:  printf \'1+1\\n\' | bc');
    }
    // (a file that is not there: what stood before it has been carried out; bc says so and ends)
    if (missing != null) {
      ctx.err(`File ${missing} is unavailable.\n`);
      return 1;
    }
    return 0;
  };

  /* ------------------------------------------------------------------ open, edit */
  /* open, nano …, download and clear act on the page of the person at the terminal. In a command of the AI agent
     (also inside a script it runs) they do nothing. */
  const forPerson = (ctx) => {
    if (!(MG.app && MG.app.term && MG.app.term.agentCmd)) return false;
    ctx.err(`${ctx.name}: this opens a window for the person at the terminal – not available to the agent (use cat, head or grep to look at a file)\n`);
    return true;
  };
  MG.shellUtil.forPerson = forPerson;
  B.open = B['xdg-open'] = async (ctx) => {
    if (forPerson(ctx)) return 1;
    const unknown = ctx.args.find((a) => /^-./.test(a));
    if (unknown) throw userErr(`${ctx.name}: unknown option ${unknown}\nusage: open FILE   (shows a file: pictures, SVG, text, tables)`);
    const f = ctx.args.filter((a) => !a.startsWith('-'))[0];
    if (!f) throw userErr('usage: open FILE   (shows a file: pictures, SVG, text, tables)');
    const e = ctx.fs.get(f);
    if (!e) throw userErr(`open: ${f}: No such file or directory`);
    if (MG.app && MG.app.openFile) await MG.app.openFile(ctx.fs.resolve(f));
    return 0;
  };
  const edit = async (ctx) => {
    if (forPerson(ctx)) return 1;
    const f = ctx.args.filter((a) => !a.startsWith('-') && !a.startsWith('+'))[0];
    if (!f) throw userErr(`usage: ${ctx.name} FILE   (opens the file in the editor of the Files tab)`);
    const abs = ctx.fs.resolve(f);
    if (ctx.fs.isDir(abs)) throw userErr(`${ctx.name}: ${f} is a directory`);
    if (!ctx.fs.isDir(MG.path.dirname(abs))) throw userErr(`${ctx.name}: ${MG.path.dirname(f)}: No such directory (make it with  mkdir -p ${MG.path.dirname(f)})`);
    if (MG.app && MG.app.editFile) await MG.app.editFile(abs, { create: true });
    ctx.io.note(`${f} is open in the editor of the Files tab. Save with Ctrl+S (⌘+S on a Mac).`);
    return 0;
  };
  ['nano', 'vim', 'vi', 'emacs', 'edit', 'code', 'gedit', 'pico'].forEach((n) => (B[n] = edit));

  /* ------------------------------------------------------------------ NAME --help
     What this terminal's own commands can do. They are written for the practical after the GNU programs and do
     not have all of their options: these texts say which they have. (NAME --help, man NAME) */
  const OWN = 'This is the terminal\'s own NAME, written for the practical after the program of that name on Linux: it has the options above, not all of the original\'s.';
  const HELP = {
    ls: `Usage: ls [OPTION]... [FILE]...
List files and what is in folders, in the order of the names. One name per line (at this terminal too).
  -a  also names that begin with a dot        -A  the same, without . and ..
  -l  long: permissions, links, owner, group, size, time of the last change, name
  -h  sizes as 4.0K, 1.2M (with -l, -s)       -s  the space each file takes, in blocks of 1 K
  -d  a folder itself, not what is in it      -R  the folders inside, too
  -1  one name per line    -C  in columns    -x  in columns, across    -m  on one line, with commas
  -t  newest first   -S  largest first   -X  by extension   -v  by the numbers in the names   -r  backwards   -U  as stored
  -u, --time=atime  show the time of the last reading (and sort by it, with -t)   -c, --time=ctime  that of the last change
  -F  mark folders (/) and programs (*)       -p  mark folders
  -I PATTERN, --hide=PATTERN  leave these names out      -B  leave out names that end with ~
  -Q  names in "quotes"    -b  odd characters as \\escapes    -q  ? for characters that cannot be printed
  -i  a number for each file    -n  owner and group as numbers    -g, -o  without owner, without group
  -w COLUMNS  the width for -C, -x, -m        --time-style=long-iso|iso|full-iso|+FORMAT, --full-time
  --block-size=SIZE  sizes in units of SIZE (K, M, 1000 …)      --si  as -h, in powers of 1000      --author
  --group-directories-first, --sort=WORD, --format=WORD, --indicator-style=WORD, --quoting-style=WORD
  --color is taken; the names are printed without colours.`,
    mkdir: `Usage: mkdir [-p] [-v] [-m MODE] FOLDER...
Make folders.   -p  also the folders above; no error if the folder is there   -v  say what was made   -m MODE  permissions (755, u=rwx,go=)`,
    rmdir: `Usage: rmdir [-p] [-v] [--ignore-fail-on-non-empty] FOLDER...
Remove empty folders.   -p  also the folders above that become empty`,
    rm: `Usage: rm [-r] [-f] [-i | -I] [-d] [-v] FILE...
Remove files.   -r, -R  folders with all that is in them   -f  no error for what is not there, and no question   -d  empty folders
  -v  say what was removed   -i  ask before each file   -I  ask once, before more than three files or a folder with all that is in it
The answer to a question is read from the input:  echo y | rm -i FILE. Typed at this terminal a question cannot be answered,
and counts as "no" (the terminal says so).   The course data in /data/course cannot be removed.`,
    cp: `Usage: cp [OPTION]... SOURCE DEST      cp [OPTION]... SOURCE... FOLDER      cp [OPTION]... -t FOLDER SOURCE...
Copy files.   -r, -R  folders with all that is in them   -a  the same, with their times and permissions   -p, --preserve[=mode,timestamps]  keep these
  -n  do not write over a file that is there   -u  only where the source is newer, or nothing is there   -i  ask before writing over a file (see rm --help)
  -f  replace a file that is write-protected   -T  DEST is the name of the copy, never a folder to copy into   --parents  under FOLDER, with the folders of its path
  -v  say what was copied   A copy has the time at which it was made, as on Linux – its source's time only with -p or -a.   Links (-l, -s) are not here.`,
    mv: `Usage: mv [OPTION]... SOURCE DEST      mv [OPTION]... SOURCE... FOLDER      mv [OPTION]... -t FOLDER SOURCE...
Move or rename files and folders.   -n  do not write over a file that is there   -u  only where the source is newer, or nothing is there
  -i  ask before writing over a file (see rm --help)   -f  do not ask   -T  DEST is the new name, never a folder to move into   -v  say what was moved`,
    touch: `Usage: touch [-c] [-a] [-m] [-d DATE] [-r FILE] [-t [[CC]YY]MMDDhhmm[.ss]] FILE...
Make an empty file, or set the times of one that is there (to now, to DATE, or to those of FILE).   -c  do not make a file
  -a  only the time of the last reading   -m  only the time of the last change (the one that ls -l shows)
DATE as for date -d: 2024-07-15, "2024-07-15 12:30", @1700000000, yesterday, "2 days ago", "next month" …`,
    tree: `Usage: tree [-adfiF] [-L LEVEL] [-I PATTERN] [-P PATTERN] [--dirsfirst] [--noreport] [FOLDER]...
The folders and files below a folder, as a tree.   -a  also names that begin with a dot   -d  folders only   -L N  at most N levels
  -f  each name with its path   -i  without the lines of the tree   -F  mark folders (/) and programs (*)   --dirsfirst  folders before files
  -I PATTERN  leave out the names that match (a|b for several)   -P PATTERN  only the files that match   --noreport  without the last line
  -C is taken (there are no colours). Sizes (-s, -h) are not here: ls -lhR, du -ah.`,
    find: `Usage: find [FOLDER]... [EXPRESSION]
The files and folders below FOLDER (default: .) for which the expression holds.
Tests:    -name PATTERN, -iname   -path PATTERN, -ipath   -regex PATTERN, -iregex   -type f|d (also f,d)
          -size [+-]N[ckMG]   -empty   -newer FILE   -newermt DATE   -mtime [+-]N   -mmin [+-]N   -atime, -amin   -perm MODE
          -readable   -writable   -executable   -samefile FILE   -links N   -user NAME   -group NAME   -true   -false
          -maxdepth N   -mindepth N   -daystart (days are counted from the end of today)
Join:     ( … )   ! EXPR, -not   EXPR -a EXPR, -and   EXPR -o EXPR, -or   EXPR , EXPR (both; the second one counts)
Actions:  -print   -print0   -printf FORMAT (%p %f %h %P %s %k %b %y %m %M %u %g %n %i %d %t %T… %a %c \\n \\t)
          -ls   -delete   -prune   -quit   -exec COMMAND {} \;   -exec COMMAND {} +   -execdir COMMAND {} \;
          -fprint FILE   -fprint0 FILE   -fprintf FILE FORMAT   -fls FILE   the same, written to FILE
          -ok COMMAND {} \;   asks before each run; the answers are read from the input (see rm --help)
          -depth (a folder after what is in it; -delete does so by itself)
The names come in the order of their characters. There are no links here: -L, -H, -P and -follow change nothing.`,
    du: `Usage: du [OPTION]... [FILE]...
The space that files and folders take (in blocks of 1 K; a file takes whole blocks of 4 K, as on a Linux disk).
  -s  one total for each argument   -a  every file, not only folders   -c  a grand total   -h  as 4.0K, 1.2M   --si  in powers of 1000
  -k, -m  in K, in M   -B SIZE, --block-size=SIZE  in units of SIZE   --apparent-size  what the files hold, not the blocks they take
  -b  the bytes of the files (--apparent-size --block-size=1)   -d N, --max-depth=N  not deeper than N   -S  without the folders inside
  -t SIZE, --threshold=SIZE  only what is at least that large (-SIZE: at most)   --exclude=PATTERN, -X FILE  leave these names out
  --time  with the time of the last change (--time-style=iso|long-iso|full-iso|+FORMAT)   --inodes  count the files, not the space
  -0  end each line with NUL`,
    stat: `Usage: stat [-c FORMAT | --printf=FORMAT] [-t] FILE...
What is known about a file: size, kind, permissions, times.   -t  on one line
FORMAT:  %n name   %s size   %F kind   %a %A permissions (644, -rw-r--r--)   %U %G %u %g owner and group   %h links
         %i number of the file   %b %B blocks   %y %Y time of the last change (text, seconds)   %x %X %z %Z %w %W   %N quoted name
A number may stand between % and the letter (%10s, %-20n). --printf takes \\n and \\t and adds no newline. -f (the file system) is not here.`,
    file: `Usage: file [-b] [-i] [-N] [-0] [-E] [-F SEPARATOR] [-f NAMEFILE] FILE...
What kind of file it is, judged by its first bytes: ASCII or UTF-8 text (and how its lines end), a script (by its
first line), CSV, JSON, HTML, gzip and BGZF (.bam, .vcf.gz), pictures, archives – or "data".   - : the input
  -b  without the name   -i  as a MIME type (text/plain; charset=us-ascii)   --mime-type   --mime-encoding
  -N  names not padded   -F SEP  SEP instead of the colon   -f NAMEFILE  the files named in NAMEFILE   -E  a missing file is an error`,
    chmod: `Usage: chmod [-R] [-v] [-c] [-f] MODE FILE...      chmod --reference=FILE FILE...
Set permissions: 755, 644, u+x, a+x, +x, go-w, u=rw, g=u, +X and lists of these (u+x,go-w).   -R  what is in a folder, too
What counts in this terminal: x – the file can be run as ./file –, and w for the owner: without it the file cannot be changed.`,
    basename: `Usage: basename NAME [SUFFIX]      basename -a [-s SUFFIX] NAME...
The name without its folders (and without SUFFIX).   -a  several names   -s SUFFIX  take this ending off   -z  end each name with NUL`,
    dirname: `Usage: dirname [-z] NAME...
The folder part of a name: dirname a/b/c.txt is a/b.`,
    realpath: `Usage: realpath [-e] [-m] [-q] [-z] [--relative-to=FOLDER] [--relative-base=FOLDER] FILE...
The full path of a file.   -e  the file must be there   -m  nothing has to be there   -q  no messages   -z  end each name with NUL`,
    readlink: `Usage: readlink -f|-e|-m [-n] [-z] FILE...
The full path of a file, as realpath gives it: readlink -f "$0".   -n  no newline at the end
Without -f, -e or -m readlink names what a link points to: there are no links in this terminal, so it prints nothing (status 1).`,
    mktemp: `Usage: mktemp [-d] [-u] [-q] [-p FOLDER] [-t] [--suffix=TEXT] [TEMPLATE]
Make a new file (-d: a folder) with a name of its own, and print the name. TEMPLATE ends with XXX… (default tmp.XXXXXXXXXX,
in $TMPDIR or /tmp).   -u  only the name   -p FOLDER, --tmpdir[=FOLDER]  where   -t  in $TMPDIR or /tmp`,
    sha256sum: `Usage: sha256sum [-b] [--tag] [-z] [FILE]...      sha256sum -c [--quiet] [--status] [--strict] [-w] [--ignore-missing] LIST
Checksums of files (- or no file: the input); -c checks the files named in a list of checksums.
  -b  mark the files as binary (*)   --tag  as "SHA256 (FILE) = …"   -z  end each line with NUL
  with -c:   --quiet  only what failed   --status  no output, the exit status says it   -w  name the lines that are no checksum lines
             --strict  such lines are a failure   --ignore-missing  leave out files that are not there
The same: sha1sum, sha384sum, sha512sum – and md5sum (the GNU program).`,
    split: `Usage: split [OPTION]... [FILE [PREFIX]]
A file in pieces: PREFIXaa, PREFIXab … (PREFIX is x if none is given; - or no FILE: the input).
  -l N  N lines each (default 1000)   -b SIZE  SIZE bytes each (5K, 1M)   -C SIZE  whole lines, at most SIZE bytes
  -n N  N pieces of the same size   -n l/N  N pieces, no line cut   -n r/N  the lines dealt out in turn   -n K/N  only piece K, printed
  -d  numbers as suffixes (-x: hexadecimal)   -a N  suffixes of N characters   --additional-suffix=TEXT   -e  no empty files   --verbose`,
    truncate: `Usage: truncate -s [+|-|<|>|/|%]SIZE [-c] [-r FILE] FILE...
Make a file SIZE bytes long: what is beyond is cut off, what is missing is filled with zero bytes. SIZE: 100, 5K, 1M.
  +SIZE longer by   -SIZE shorter by   <SIZE at most   >SIZE at least   /SIZE down, %SIZE up to a multiple   -c  do not make a file   -r FILE  as long as FILE`,
    tac: `Usage: tac [-b] [-r] [-s SEPARATOR] [FILE]...
The lines of each file, last line first.   -s TEXT  what ends a record instead of the newline (-r: a regular expression)   -b  the separator stands before its record`,
    rev: `Usage: rev [FILE]...
Each line backwards, character by character.`,
    nl: `Usage: nl [OPTION]... [FILE]...
Number the lines.   -b a  all lines   -b t  the lines that are not empty (default)   -b n  none   -b pREGEX  the lines that match
  -n ln|rn|rz  left, right, right with zeros   -w N  width of the numbers (6)   -s TEXT  what stands behind the number (a tab)
  -v N  first number   -i N  step   -l N  of N empty lines one is counted   -h, -f STYLE, -d CC, -p  header, footer and pages`,
    column: `Usage: column -t [-s SEPARATORS] [-o TEXT] [FILE]...
A table with its columns lined up.   -s  what separates the columns in the input (blanks)   -o  what stands between them in the output (two spaces)`,
    expand: `Usage: expand [-t N | -t LIST] [-i] [FILE]...
Tabs become spaces.   -t N  tab stops every N columns (8)   -t 3,8,20  tab stops at these columns   -i  only the tabs at the start of a line`,
    unexpand: `Usage: unexpand [-a] [-t N] [--first-only] [FILE]...
Blanks become tabs: at the start of each line – with -a wherever a run of blanks reaches a tab stop.   -t N  tab stops every N columns (8)`,
    xargs: `Usage: xargs [OPTION]... [COMMAND [ARGUMENT]...]
Run COMMAND (default: echo) with the words of the input as arguments.
  -n N  at most N words for each run   -I {}  one run for each line, the line in place of {}   -L N  N lines for each run
  -0  the words are separated by NUL (find -print0)   -d C  by the character C   -r  no run if there is no input   -t  show each command
  -P N is taken: the runs come one after the other.   xargs runs programs and the shell's own commands, not functions.`,
    env: `Usage: env [-i] [-u NAME]... [-C FOLDER] [NAME=VALUE]... [COMMAND [ARGUMENT]...]
Run COMMAND with these variables set (or, without a command, print the environment: the exported variables).
  -i  start with an empty environment   -u NAME  without this variable   -C FOLDER  run the command in that folder
  -0  end each line of the list with NUL   (-S is not here.)`,
    printenv: `Usage: printenv [NAME]...
The exported variables, or the values of those named (status 1 if one is not set).`,
    getopt: `Usage: getopt [OPTION]... -o LETTERS [--long NAMES] [--] WORD...        (also: getopt LETTERS WORD...)
Put the options of a script in order: each option a word of its own, its value in quotes, then --, then the other words.
    OPTS=$(getopt -o hi:o: --long help,input:,output: -n "$0" -- "$@") || exit 2
    eval set -- "$OPTS"          # then: while true; do case "$1" in -i|--input) IN=$2; shift 2;; ... --) shift; break;; esac; done
  -o LETTERS  the one-letter options: "i:" takes a value, "v::" may have one glued to it (-v3)
  -l NAMES, --long NAMES  the long options, with commas between them: "input:" takes a value, "level::" may have one (--level=3)
  -n NAME  the name in the messages   -q  no messages   -Q  no output   -a  long options may begin with one -
  -u  no quotes   -s sh|bash|csh|tcsh  whose quotes   -T  status 4: this is the getopt that knows long options
Status 0, or 1 if an option was not understood. Not to be confused with getopts, the shell's own, which knows letters only.`,
    stdbuf: `Usage: stdbuf [-i MODE] [-o MODE] [-e MODE] COMMAND [ARGUMENT]...
Run COMMAND. (On Linux the options change how the program gathers its output before writing it – stdbuf -oL: line by line.
In this terminal that makes no difference: the options are taken, and the command is run.)`,
    tty: `Usage: tty [-s]
The name of the terminal that the input comes from (/dev/pts/0), or "not a tty" and status 1 when the input is a file or a pipe.   -s  print nothing`,
    locale: `Usage: locale [-a] [charmap]
The language settings as the programs see them: LANG, LC_ALL and the LC_ variables.   -a  the settings that exist here (C, C.utf8, POSIX)
  charmap  the encoding: UTF-8, or plain ASCII when the setting is C or POSIX (export LC_ALL=C: sort, grep, sed, wc and awk then work on bytes)`,
    logname: `Usage: logname
The name of the user: student.`,
    groups: `Usage: groups [USER]...
The groups of the user: student.`,
    sync: `Usage: sync
Wait until everything that was written is stored. In this terminal there is nothing to wait for.`,
    timeout: `Usage: timeout [OPTION] DURATION COMMAND [ARGUMENT]...
Run COMMAND, and stop it when DURATION is over (5, 0.5, 2m, 1h): the status is then 124.
  -s SIGNAL  the signal that is sent (KILL: status 137)   --preserve-status  128 + the number of the signal   -k DURATION, --foreground, -v  taken
What this terminal carries out itself – sleep, a loop, a script, bash -c – is stopped at once. A program that is running (samtools,
minimap2 …) cannot be stopped from outside here: it runs to its end, and if that took longer than DURATION the status is 124 all the same.`,
    sleep: `Usage: sleep SECONDS
Wait (in this terminal at most 10 seconds).`,
    od: `Usage: od [OPTION]... [FILE]...
The bytes of a file, written out.   -c  as characters (\\n \\t, octal for the rest)   -b  octal bytes   -x  hexadecimal words   -d  decimal words
  -t TYPE  c, a, o1 o2 o4, x1 x2 x4 x8, d1 d2 d4 d8, u1 u2 u4 u8 (a z behind it adds the text)   -A d|o|x|n  how the offset is written (n: not at all)
  -N COUNT  only so many bytes   -j SKIP  leave out the first bytes   -w N  N bytes on a line   -v  no * for lines that repeat
Often used: od -c FILE   od -An -tx1 FILE   Floating point types are not here.`,
    hexdump: `Usage: hexdump [-C] [-n LENGTH] [-s SKIP] [-v] [FILE]...
The bytes of a file in hexadecimal.   -C  offset, 16 bytes, and the text between | |   -n LENGTH  only so many bytes   -s SKIP  leave out the first bytes
  -v  no * for lines that repeat   The format options (-e, -f) are not here; see also od and xxd.`,
    xxd: `Usage: xxd [-p] [-r] [-u] [-l LENGTH] [-s SKIP] [-c COLUMNS] [-g BYTES] [FILE]
A hex dump.   -p  plain: only the hexadecimal digits   -r  back from a dump to the bytes (with -p: from plain digits)   -u  capital letters
  -l LENGTH  only so many bytes   -s SKIP  leave out the first bytes   -c N  N bytes on a line   -g N  groups of N bytes`,
    base64: `Usage: base64 [-d] [-i] [-w COLUMNS] [FILE]
Bytes as text of 64 characters, and back.   -d  decode   -i  when decoding, pass over characters that do not belong   -w N  lines of N characters (76; 0: one line)`,
    bc: `Usage: bc [-l] [FILE]...      echo "scale=3; 10/3" | bc
A calculator with numbers of any size. scale is the number of digits behind the point (0 at the start; 20 with -l).
  + - * / % ^   == != < <= > >= (1 or 0)   variables: a = 5; a * 2   ++ -- += -= *= /=   sqrt(x) length(x) scale(x)
  if (…) … else …   while (…) { … }   for (i = 1; i <= 3; i++) …   define f(x) { … return (…); }   print "text", x, "\\n"
  ibase, obase: other number bases (obase=2; 99)   last or . : the last number printed   quit
  -l  the mathematics library: s(x) c(x) a(x) (sine, cosine, arc tangent, in radians), l(x) natural logarithm, e(x) e to the power of x
This is the terminal's own bc, written for the practical: it does the sums as GNU bc does them. Not here: read().`,
    expr: `Usage: expr EXPRESSION      each part is an argument of its own: expr 5 + 3, expr 6 \\* 7
  + - * / %   = != < <= > >=   | &   STRING : REGEX   match STRING REGEX   substr STRING POS LENGTH   index STRING CHARS   length STRING   ( … )
Status 0 if the result is neither empty nor 0, 1 if it is, 2 for a mistake. Whole numbers of any size.`,
    download: `Usage: download FILE|FOLDER...
Save a copy on your computer (a folder as a .zip). For the person at the terminal: the agent cannot use it.`,
    open: `Usage: open FILE
Show a file in the Files tab (an HTML report, a table, a text).`
  };
  ['sha1sum', 'sha384sum', 'sha512sum'].forEach((n) => (HELP[n] = HELP.sha256sum.replace(/sha256sum/g, n).replace(`The same: sha1sum, sha384sum, sha512sum`, 'The same: sha256sum, sha1sum, sha384sum, sha512sum').replace(new RegExp(`${n}, `), '')));
  HELP.hd = HELP.hexdump;
  HELP.dir = HELP.ls;
  HELP.ll = 'Usage: ll [OPTION]... [FILE]...\nThe same as ls -l.\n\n' + HELP.ls;
  MG.shellHelp = (name, version) => {
    const text = HELP[name];
    if (!text) return null;
    if (version) return `${name} (the terminal of this practical) – written for the practical after the program of that name on Linux; it is not that program and has no version of it.\n`;
    return text + (/terminal's own/.test(text) || /^(download|open|sleep|timeout)$/.test(name) ? '' : '\n' + OWN.replace('NAME', name)) + '\n';
  };

  /* ------------------------------------------------------------------ help */
  B.help = (ctx) => {
    const v = (MG.wasm && MG.wasm.versions) || {};
    ctx.out(
      [
        'Programs in this terminal – every one runs here, in your browser',
        '',
        'Bioinformatics (the real programs, compiled to WebAssembly):',
        `  fastp ${v.fastp}            quality control and trimming of FASTQ files; writes an HTML and a JSON report`,
        `  minimap2 ${v.minimap2}           map reads:  minimap2 -ax sr REF.fa R1.fastq R2.fastq > out.sam`,
        `  bowtie2 ${v.bowtie2}           map reads:  bowtie2-build REF.fa INDEX   then   bowtie2 -x INDEX -1 R1.fastq -2 R2.fastq -S out.sam`,
        `  samtools ${v.samtools}           sort, index, view, flagstat, stats, depth, faidx …`,
        `  bcftools ${v.bcftools}           mpileup, call, view, filter, query, stats, norm, index …`,
        `  bgzip, tabix (htslib ${v.htslib})   seqtk ${v.seqtk}   bedtools ${v.bedtools}   jq ${v.jq}`,
        '',
        'GNU text tools (WebAssembly):',
        `  cat head tail wc sort uniq cut tr tee paste join comm seq fold shuf md5sum date (coreutils ${v.coreutils})`,
        `  grep egrep fgrep (grep ${v.grep})   sed (sed ${v.sed})   awk gawk (gawk ${v.gawk})   diff cmp (diffutils ${v.diffutils})`,
        '  gzip gunzip zcat zgrep (done by bgzip)',
        '',
        'Files and folders:',
        '  ls cd pwd pushd popd dirs mkdir cp mv rm rmdir touch tree find du stat file chmod',
        '  basename dirname realpath readlink mktemp   xargs env printenv timeout sleep getopt',
        '  sha256sum sha1sum sha384sum sha512sum   split truncate   tac rev nl column expand unexpand',
        '  od hexdump xxd base64   the bytes of a file      bc, expr   sums:  echo "scale=3; 10/3" | bc',
        '  open FILE   show a file (an HTML report, a table)       nano FILE   edit a file in the Files tab',
        '  download FILE   save a copy on your computer',
        '',
        'The shell is bash-like: | && || ; > >> < 2> 2>&1, quotes, $VAR and ${VAR}, $( ), $(( )), * ? globs,',
        '  if / for / while / case, [ ] and [[ ]], functions, here-documents, <( ), getopts, xargs, printf, read.',
        '  Scripts: bash script.sh   (set -euo pipefail stops a script at the first error)',
        '  Not there: background jobs (&), a network, sudo, installing anything. Every program runs on one thread.',
        '',
        'Tips: ↑/↓ recall commands · Tab completes names · Ctrl+C stops · PROGRAM --help or man PROGRAM for its options',
        '  (ls, find, stat, bc … are the terminal\'s own: NAME --help says which options of the GNU program they have)',
        ''
      ].join('\n')
    );
  };
})();
