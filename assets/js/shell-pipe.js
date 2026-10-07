/* =====================================================================
   What the terminal of the "Pipelines and reproducibility" practical has
   beyond the shared shell (shell.js, shell-lang.js, shell-extra.js,
   tools-wasm.js – the same files as in the "AI agents" practical):

     conda (mamba, micromamba)   environments that decide which programs
                                 a command finds – see conda.js
     snakemake, python, pip      run in Python (Pyodide) – see pysync.js
     dot                         Graphviz, compiled to WebAssembly
     help, man                   the programs of this practical
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const B = MG.shellBuiltins;
  const T = MG.shellTools;
  const { userErr, linesOf } = MG.shellUtil;
  const enc = new TextEncoder();
  const unsavedNote = (ctx) => MG.unsavedNote && MG.unsavedNote(ctx);

  /** the bytes that are piped into a command */
  async function stdinBytes(ctx) {
    const s = ctx.stdin;
    if (s == null) {
      const rest = MG.shellUtil.inherited ? MG.shellUtil.inherited(ctx) : null;
      return rest == null ? new Uint8Array(0) : enc.encode(rest);
    }
    if (MG.FileRef && s instanceof MG.FileRef) return await MG.wasm.readBytes(s.apath);
    return typeof s === 'string' ? enc.encode(s) : s instanceof Uint8Array ? s : enc.encode(String(s));
  }

  /* ------------------------------------------------------------------ the programs of this practical */
  // programs of the shared terminal that this practical does not have
  ['fastp', 'bowtie2', 'bowtie2-align-s', 'bowtie2-build', 'bowtie2-build-s', 'seqtk', 'bedtools', 'jq'].forEach((n) => delete T[n]);
  // the examples of the manual pages, with the files of this practical
  const MAN = {
    minimap2: 'minimap2 -ax sr data/raw/reference.fa data/raw/NA12878_R1.fastq data/raw/NA12878_R2.fastq > results/mapped/NA12878.sam',
    samtools: 'samtools sort -o results/mapped/NA12878.sorted.bam results/mapped/NA12878.sam\nsamtools index results/mapped/NA12878.sorted.bam\nsamtools flagstat results/mapped/NA12878.sorted.bam',
    bcftools: "bcftools mpileup -f data/raw/reference.fa results/mapped/NA12878.sorted.bam -Ou | bcftools call -mv -Oz -o results/variants/NA12878.raw.vcf.gz\nbcftools filter -i 'QUAL>=20 && INFO/DP>=5' -Oz -o results/variants/NA12878.filtered.vcf.gz results/variants/NA12878.raw.vcf.gz\nbcftools view -H results/variants/NA12878.filtered.vcf.gz | head\nUse bcftools COMMAND --help for the options of a command.",
    bgzip: 'bgzip -c INPUT > OUTPUT.gz',
    tabix: 'tabix -p vcf results/variants/NA12878.filtered.vcf.gz'
  };
  for (const [name, example] of Object.entries(MAN)) if (T[name]) T[name].man = `${name} ${T[name].version} · compiled program, running in your browser\n\n${example}`;
  // md5sum is the GNU program; the tasks of the practical hear of a check (md5sum -c) and of new checksums as before
  if (T.md5sum) {
    const run = T.md5sum.run;
    T.md5sum.run = async (ctx) => {
      const check = ctx.args.some((a) => a === '--check' || /^-[a-z]*c/.test(a));
      const code = (await run(ctx)) || 0;
      if (check) MG.bus.emit('hash:check', { name: 'md5sum', ok: code === 0 });
      else if (!code) MG.bus.emit('hash:made', { name: 'md5sum', files: ctx.args.filter((a) => !a.startsWith('-')) });
      return code;
    };
  }

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

  /* ------------------------------------------------------------------ programs come from conda environments */
  // A program of a conda package (samtools, snakemake, python …) is found only while an environment that holds it
  // is active – in a job of Snakemake: only if the environment of the job's rule holds it (opts.tools of exec).
  const Shell = MG.Shell;
  const exec0 = Shell.prototype.exec;
  Shell.prototype.exec = async function (text, io, opts = {}) {
    if (!opts.tools) return exec0.call(this, text, io, opts);
    const before = this._jobTools;
    this._jobTools = opts.tools;
    try {
      return await exec0.call(this, text, io, opts);
    } finally {
      this._jobTools = before;
    }
  };
  const dispatch0 = Shell.prototype.dispatch;
  Shell.prototype.dispatch = function (name, ctx) {
    // A command of the real AI agent (chapter 8, live mode) runs only what the agent was told it has – however the
    // name came about: written out, taken from a variable, started by xargs or by find -exec. (assistant.js sets
    // _agentOnly while a command of the agent runs, and reads _agentRefused afterwards.)
    const only = this._agentOnly;
    if (only && !only.has(name)) {
      ctx.err(`bash: ${name}: not available to the agent\n`);
      if (this._agentRefused && !this._agentRefused.includes(name)) this._agentRefused.push(name);
      return 126;
    }
    if (MG.conda && MG.conda.managed(name)) {
      const job = this._jobTools;
      if (!(job || MG.conda.activePrograms()).includes(name)) {
        ctx.err(`bash: ${name}: command not found\n`);
        const where = MG.conda.envsWith(name);
        if (!job && where.length) ctx.io.note(`${name} is installed in the conda environment ${where.map((w) => "'" + w + "'").join(' and ')}. Activate it with:  conda activate ${where[0]}`);
        return 127;
      }
    }
    return dispatch0.call(this, name, ctx);
  };
  MG.shellHooks = MG.shellHooks || {};
  /** where a program is (which, type, command -v): in the active environment – or nowhere */
  MG.shellHooks.programPath = (name, shell) => {
    if (!MG.conda || !MG.conda.managed(name)) return undefined;
    if (shell && shell._jobTools) return shell._jobTools.includes(name) ? MG.conda.which(name) || `/usr/bin/${name}` : null;
    return MG.conda.which(name);
  };
  /** the active environment in front of the prompt, as conda shows it */
  MG.shellHooks.promptPrefix = () => (MG.conda ? `<span class="penv">(${MG.esc(MG.conda.active)})</span> ` : '');
  // conda activate changes the environment's variables in the terminal's shell, and the prompt
  MG.bus.on('conda:changed', () => {
    const t = MG.app && MG.app.term;
    if (!t) return;
    try {
      const st = t.shell._top();
      st.vars.CONDA_PREFIX = MG.conda.prefix(MG.conda.active);
      st.vars.CONDA_DEFAULT_ENV = MG.conda.active;
      if (st.exported) ['CONDA_PREFIX', 'CONDA_DEFAULT_ENV'].forEach((k) => st.exported.add(k));
    } catch (e) {
      /* the shell is not there yet */
    }
    t._renderPrompt();
  });

  /* ------------------------------------------------------------------ programs that are not here */
  if (MG.shellUtil.ABSENT)
    MG.shellUtil.ABSENT.splice(
      0,
      MG.shellUtil.ABSENT.length,
      [/^(bwa|bwa-mem2|bowtie|bowtie2|hisat2|STAR|bbmap|ngmlr|novoalign|subread-align)$/, 'is not installed in this terminal. For mapping reads there is minimap2.'],
      [/^(fastqc|multiqc|fastp|trimmomatic|cutadapt|trim_galore|bbduk\.sh|seqkit|seqtk|NanoPlot|prinseq)$/, 'is not installed in this terminal: this practical starts from reads that are ready to map.'],
      [/^(gatk|freebayes|picard|varscan|deepvariant|strelka|octopus|vardict|lofreq|snpEff|SnpSift|vep|annovar|vcftools|igv|qualimap|mosdepth|sambamba|bamtools|bedtools)$/, 'is not installed in this terminal. For variants there is bcftools (mpileup, call, filter, view, query, stats, norm); for alignments samtools.'],
      [/^(python2|R|Rscript|perl|ruby|java|julia|node|ipython|jupyter|jq)$/, 'is not installed in this terminal. There are Python (python script.py, and the Notebook tab) and the shell with its text tools: awk, sed, grep, sort, cut …'],
      [/^(apt|apt-get|yum|dnf|brew|docker|singularity|apptainer|nextflow|git|make|module)$/, 'is not available in this terminal. Programs come from conda environments here:  conda env list   conda list'],
      [/^(wget|curl|ssh|scp|rsync|ping|ftp|sftp)$/, 'is not available: this terminal has no network access. The course data is in /data/course.'],
      [/^(top|htop|ps|kill|free|lscpu|df|mount|su|chown|screen|tmux|nohup|watch|crontab|pkill|pgrep|uptime|stty|getconf|lsblk|dmesg|who|w|last|service|systemctl|chgrp|mknod)$/, 'is not available in this terminal: it is a web page, not a whole computer.'],
      [/^(mkfifo|flock)$/, 'is not available in this terminal: the commands here run one after the other, so there are no named pipes and nothing to lock. Use a file between two commands, or  COMMAND <(OTHER COMMAND)'],
      [/^install$/, 'is not available in this terminal. For a folder:  mkdir -p FOLDER   For a file with permissions:  cp FILE DESTINATION && chmod 755 DESTINATION'],
      [/^(iconv|recode)$/, 'is not installed in this terminal: text here is UTF-8, and the programs pass other bytes through as they are.'],
      [/^(dos2unix|unix2dos)$/, "is not installed in this terminal (nor on many Linux computers). To take the carriage returns of a Windows file away:  sed -i 's/\\r$//' FILE   or   tr -d '\\r' < FILE > NEWFILE"],
      [/^(cal|ncal|banner|figlet|cowsay|fortune)$/, 'is not installed in this terminal. Type  help  to see what is here.'],
      [/^ln$/, 'is not available in this terminal: there are no links here. Copy the file instead:  cp FILE NEWNAME'],
      [/^(tar|zip|unzip|7z|bzip2|bunzip2|xz|pigz)$/, 'is not installed in this terminal. For compressed files there are gzip, gunzip, zcat and bgzip. (A whole folder can be saved as a .zip with  download FOLDER.)'],
      [/^dc$/, 'is not installed in this terminal. For sums there are bc, $(( 2 + 3 )) and awk.'],
      [/^(sdiff|diff3)$/, 'is not available in this terminal: it works by starting diff as a second program, which a web page cannot do. Two files side by side:  diff -y A B'],
      [/^(patch|colordiff|vimdiff|wdiff)$/, 'is not installed in this terminal. To compare files there are diff and cmp.'],
      [/^strings$/, 'is not installed in this terminal. To look at the bytes of a file there are od -c, hexdump -C and xxd; to look into a compressed file,  zcat FILE | head'],
      [/^yes$/, "is not available in this terminal: the commands of a pipeline run one after the other, and yes never ends. For N lines:  seq N | sed \"s/.*/y/\"   or   printf 'y\\n%.0s' {1..N}"],
      [/^(csplit|numfmt|cksum|sum|dd|tsort|fmt|pr)$/, 'is not among the programs of this terminal. Type  help  to see what is here.'],
      [/^(alias|unalias)$/, 'is not available in this terminal. Write a function instead:  ll() { ls -l "$@"; }']
    );

  /* ------------------------------------------------------------------ man pages of this practical's own commands */
  const OWN_MAN = {
    snakemake: 'snakemake – Snakemake 9 (the browser edition of this practical): runs the rules of a Snakefile.\n\n  snakemake -n                       what would run, and why (a dry run)\n  snakemake --cores 1                run the pipeline\n  snakemake --cores 1 --use-conda    … each rule in the environment of its conda: file\n  snakemake --dag | dot -Tsvg > dag.svg\n  snakemake --summary                what made each output, and when\n\nAll its options:  snakemake --help',
    conda: 'conda – software environments (a model of conda, with the real versions and dependencies of the packages of this practical).\n\n  conda env list                 the environments\n  conda activate NAME            use one\n  conda list                     the packages of the active one\n  conda create -n NAME PACKAGE=VERSION …\n  conda env export               the active environment, as a file\n\nAll its commands:  conda --help   (mamba and micromamba are the same program here)',
    python: 'python – Python 3.13 (Pyodide) with pandas, NumPy, matplotlib and PyYAML.\n\n  python script.py [ARGUMENTS]\n  python -c "print(1 + 1)"\n  python --version\n\nFor interactive Python use the Notebook tab.',
    pip: 'pip – the Python packages of the active conda environment (nothing can be installed here).\n\n  pip list\n  pip freeze\n  pip show PACKAGE\n\nIts own help:  pip --help',
    dot: 'dot – Graphviz, compiled to WebAssembly: draws a graph that is described in the DOT language.\n\n  snakemake --dag | dot -Tsvg > dag.svg\n  dot -Tpng graph.dot -o graph.png\n\nIt makes SVG and PNG files (not PDF).'
  };
  const man0 = B.man;
  B.man = (ctx) => {
    const name = ctx.args.filter((a) => !a.startsWith('-'))[0];
    const key = { mamba: 'conda', micromamba: 'conda', python3: 'python', pip3: 'pip' }[name] || name;
    if (OWN_MAN[key]) return ctx.out(OWN_MAN[key] + '\n');
    return man0(ctx);
  };
  // python --help: the usage, not "can't open file '--help'"
  const python0 = B.python;
  B.python = B.python3 = (ctx) => {
    if (ctx.args[0] === '--help' || ctx.args[0] === '-h') {
      ctx.out('usage: python [option] ... [-c cmd | file] [arg] ...\n  -c cmd : a program passed in as a string\n  file   : a program read from a script file\n  -V     : print the Python version number and exit (also --version)\nFor interactive Python use the Notebook tab.\n');
      return 0;
    }
    return python0(ctx);
  };

  /* ------------------------------------------------------------------ help */
  B.help = (ctx) => {
    const v = (MG.wasm && MG.wasm.versions) || {};
    ctx.out(
      [
        'Programs in this terminal – every one runs here, in your browser',
        '',
        'Workflow and environments:',
        '  snakemake    Snakemake 9 (browser teaching edition): snakemake -n, snakemake --cores 1, --dag, --summary',
        '  conda        environments: conda env list, conda activate NAME, conda list, conda env export, conda create',
        '  python       run a Python script: python script.py (the Notebook tab is for interactive Python)',
        '  pip          pip list, pip freeze',
        '  dot          Graphviz: snakemake --dag | dot -Tsvg > dag.svg',
        '',
        'Bioinformatics (the real programs, compiled to WebAssembly; they come from the active conda environment):',
        `  minimap2 ${v.minimap2}           map reads:  minimap2 -ax sr REF.fa R1.fastq R2.fastq > out.sam`,
        `  samtools ${v.samtools}           sort, index, view, flagstat, stats, depth, faidx …`,
        `  bcftools ${v.bcftools}           mpileup, call, view, filter, query, stats, norm, index …`,
        `  bgzip, tabix (htslib ${v.htslib})`,
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
        '  open FILE   show a file (a picture, a table)            nano FILE   edit a file in the Files tab',
        '  download FILE   save a copy on your computer',
        '',
        'The shell is bash-like: | && || ; > >> < 2> 2>&1, quotes, $VAR and ${VAR}, $( ), $(( )), * ? globs,',
        '  if / for / while / case, [ ] and [[ ]], functions, here-documents, <( ), getopts, xargs, printf, read.',
        '  Scripts: bash script.sh   (set -euo pipefail stops a script at the first error)',
        '  Not there: background jobs (&), a network, sudo, apt. Every program runs on one thread.',
        '',
        'Tips: ↑/↓ recall commands · Tab completes names · Ctrl+C stops · PROGRAM --help or man PROGRAM for its options',
        '  (ls, find, stat, bc … are the terminal\'s own: NAME --help says which options of the GNU program they have)',
        ''
      ].join('\n')
    );
  };
})();
