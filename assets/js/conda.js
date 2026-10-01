/* =====================================================================
   A model of conda for the browser practical.

   The programs here are real (WebAssembly builds of minimap2, samtools,
   bcftools, htslib, Graphviz, and Python 3.13 with pandas and matplotlib
   from Pyodide), but only one version of each exists in the browser.
   Environments decide which of them a command can use, exactly as on a
   real computer: a program outside the active environment is "not found".
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { store } = MG;

  const ROOT = '/home/student/miniforge3';
  const CONDA_VERSION = '26.7.3';

  /* everything this browser can provide: name -> version, build, channel, programs */
  const CATALOGUE = {
    snakemake: { v: '9.27.0', build: 'hdfd78af_0', ch: 'bioconda', prog: ['snakemake'], deps: ['python', 'pyyaml'] },
    'snakemake-minimal': { v: '9.27.0', build: 'pyhdfd78af_0', ch: 'bioconda', prog: ['snakemake'], deps: ['python', 'pyyaml'] },
    // run requirements as in bioconda's (patched) repodata: htslib >=X,<1.25; these old builds
    // were made against zlib 1.2 and need zlib <1.3 (Python 3.13 needs zlib >=1.3.1)
    minimap2: { v: '2.22', build: 'h5bf99c6_0', ch: 'bioconda', prog: ['minimap2'], deps: ['libzlib'], needs: { libzlib: ['1.2.11', '1.3'] } },
    samtools: { v: '1.17', build: 'hd87286a_2', ch: 'bioconda', prog: ['samtools'], deps: ['htslib', 'libzlib', 'ncurses'], needs: { htslib: ['1.17', '1.25'], libzlib: ['1.2.13', '1.3'] } },
    bcftools: { v: '1.10', build: 'h5d15f04_0', ch: 'bioconda', prog: ['bcftools'], deps: ['htslib', 'libzlib'], needs: { htslib: ['1.10', '1.25'], libzlib: ['1.2.11', '1.3'] }, newest: { '1.10': '1.10.2' } },
    htslib: { v: '1.17', build: 'h81da01d_2', ch: 'bioconda', prog: ['bgzip', 'tabix'], deps: ['libzlib'], alt: { '1.10': 'h78d89cc_1' } },
    tabix: { v: '1.17', build: 'h81da01d_2', ch: 'bioconda', prog: ['tabix', 'bgzip'], alias: 'htslib' },
    graphviz: { v: '16.1.0', build: 'wasm_viz3.31', ch: 'conda-forge', prog: ['dot'] },
    python: { v: '3.13.2', build: 'pyodide_0.29', ch: 'conda-forge', prog: ['python', 'python3'], py: true, deps: ['pip'], needs313: { libzlib: ['1.3.1', '2'] } },
    pip: { v: '25.0', build: 'pyh145f28c_0', ch: 'conda-forge', prog: ['pip', 'pip3'], py: true },
    pandas: { v: '2.3.3', build: 'pyodide', ch: 'conda-forge', py: true, deps: ['numpy', 'python-dateutil', 'pytz'] },
    numpy: { v: '2.2.5', build: 'pyodide', ch: 'conda-forge', py: true },
    matplotlib: { v: '3.8.4', build: 'pyodide', ch: 'conda-forge', py: true, deps: ['numpy', 'pillow'] },
    'matplotlib-base': { v: '3.8.4', build: 'pyodide', ch: 'conda-forge', py: true, alias: 'matplotlib' },
    pyyaml: { v: '6.0.2', build: 'pyodide', ch: 'conda-forge', py: true },
    scipy: { v: '1.14.1', build: 'pyodide', ch: 'conda-forge', py: true, deps: ['numpy'] },
    'python-dateutil': { v: '2.9.0.post0', build: 'pyhd8ed1ab_1', ch: 'conda-forge', py: true, dep: true },
    pytz: { v: '2025.2', build: 'pyhd8ed1ab_0', ch: 'conda-forge', py: true, dep: true },
    pillow: { v: '11.3.0', build: 'pyodide', ch: 'conda-forge', py: true, dep: true },
    libzlib: { v: '1.3.1', build: 'hb9d3cd8_2', ch: 'conda-forge', dep: true, alt: { '1.2.13': 'h4ab18f5_6' } },
    ncurses: { v: '6.5', build: 'h2d0b736_3', ch: 'conda-forge', dep: true }
  };
  /* programs whose availability depends on the environment */
  const MANAGED = new Set(['snakemake', 'minimap2', 'samtools', 'bcftools', 'bgzip', 'tabix', 'dot', 'python', 'python3', 'pip', 'pip3']);

  const DEFAULT_ENVS = {
    base: { specs: ['python=3.13', 'pip', 'conda'], pkgs: ['python', 'pip'], channels: ['conda-forge'], created: 'installed with Miniforge' },
    pipelines: {
      specs: ['snakemake=9.27', 'minimap2=2.22', 'samtools=1.17', 'bcftools=1.10', 'htslib=1.17', 'python=3.13', 'pandas', 'matplotlib', 'graphviz'],
      pkgs: ['snakemake', 'minimap2', 'samtools', 'bcftools', 'htslib', 'python', 'pip', 'pandas', 'numpy', 'matplotlib', 'pyyaml', 'graphviz'],
      channels: ['conda-forge', 'bioconda'],
      created: 'prepared for the practical'
    }
  };

  const conda = {
    ROOT,
    VERSION: CONDA_VERSION,
    CATALOGUE,
    envs: null,
    stack: null,
    load() {
      const saved = store.get('condaEnvs', null);
      this.envs = Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_ENVS)), saved && typeof saved === 'object' ? saved : {});
      // the two built-in environments cannot be lost
      this.envs.base = JSON.parse(JSON.stringify(DEFAULT_ENVS.base));
      if (!this.envs.pipelines) this.envs.pipelines = JSON.parse(JSON.stringify(DEFAULT_ENVS.pipelines));
      const st = store.get('condaStack', null);
      this.stack = Array.isArray(st) && st.length && st.every((n) => this.envs[n]) ? st : ['base', 'pipelines'];
    },
    save() {
      const custom = {};
      for (const [k, v] of Object.entries(this.envs)) if (k !== 'base') custom[k] = v;
      store.set('condaEnvs', custom);
      store.set('condaStack', this.stack);
      MG.bus.emit('conda:changed', { active: this.active });
    },
    get active() {
      return this.stack[this.stack.length - 1];
    },
    prefix(name) {
      return name === 'base' ? ROOT : `${ROOT}/envs/${name}`;
    },
    managed(prog) {
      return MANAGED.has(prog);
    },
    /** all packages of an environment including dependencies */
    packages(name) {
      const env = this.envs[name];
      if (!env) return [];
      const out = new Set();
      const add = (p) => {
        const real = CATALOGUE[p] && CATALOGUE[p].alias ? CATALOGUE[p].alias : p;
        if (out.has(real) || !CATALOGUE[real]) return;
        out.add(real);
        (CATALOGUE[real].deps || []).forEach(add);
      };
      env.pkgs.forEach(add);
      return Array.from(out).sort();
    },
    programs(name) {
      const progs = new Set();
      this.packages(name).forEach((p) => (CATALOGUE[p].prog || []).forEach((x) => progs.add(x)));
      if (progs.has('python')) ['pip', 'pip3'].forEach((x) => progs.add(x));
      return Array.from(progs);
    },
    activePrograms() {
      return this.programs(this.active);
    },
    envsWith(prog) {
      return Object.keys(this.envs).filter((n) => this.programs(n).includes(prog));
    },
    which(prog) {
      if (!this.managed(prog)) return null;
      if (!this.activePrograms().includes(prog)) return null;
      return `${this.prefix(this.active)}/bin/${prog}`;
    },
    /** check package specs against what the browser has -> {pkgs, problems, notes} */
    solve(specs) {
      const pkgs = [];
      const problems = [];
      const notes = [];
      const pins = {};
      const asked = {};
      for (const raw of specs) {
        const spec = String(raw).split('::').pop().trim();
        if (!spec || spec === 'conda') continue;
        const m = /^([A-Za-z0-9_.\-]+)\s*(==|=|>=|<=|>|<|!=)?\s*([^=\s]*)(=\S*)?$/.exec(spec);
        if (!m) {
          problems.push(`  - ${spec}  (not a package specification, e.g. samtools=1.17)`);
          continue;
        }
        const name = m[1].toLowerCase();
        const op = m[2] || '';
        const want = m[3] || '';
        const c = CATALOGUE[name];
        if (!c) {
          problems.push(`  - ${spec}  (${name} cannot run inside this web browser)`);
          continue;
        }
        const versions = [c.v].concat(Object.keys(c.alt || {}));
        if (want && !versions.some((v) => versionOk(v, op || '=', want))) {
          if (c.py) notes.push(`${name} ${c.v} from Pyodide stands in for ${name}${op || '='}${want} in this browser`);
          else {
            problems.push(`  - ${spec}  (this browser only has ${name} ${versions.join(' or ')})`);
            continue;
          }
        }
        const chosen = want ? versions.find((v) => versionOk(v, op || '=', want)) : c.v;
        if (chosen && chosen !== c.v && !c.py) pins[c.alias || name] = chosen;
        if (want) asked[c.alias || name] = { op: op || '=', want, spec };
        pkgs.push(c.alias || name);
      }
      // an environment holds ONE version of each library. Every package that needs htslib
      // gives a range (samtools 1.17: >=1.17,<1.25; bcftools 1.10: >=1.10,<1.25); conda takes
      // the newest version inside all ranges – or fails if a pin rules them all out.
      const conflicts = [];
      const needs = {};
      // Python 3.13 needs zlib 1.3.1 or newer – only when 3.13 is asked for (unpinned, a real conda
      // would choose an older Python that fits the old tools)
      const py313 = asked.python && /^3\.(1[3-9]|[2-9]\d)/.test(asked.python.want) && asked.python.op !== '<' && asked.python.op !== '<=';
      pkgs.forEach((p) => Object.entries(Object.assign({}, CATALOGUE[p].needs || {}, p === 'python' && py313 ? CATALOGUE[p].needs313 : {})).forEach(([lib, rg]) => (needs[lib] = needs[lib] || []).push([p, rg])));
      for (const [lib, list] of Object.entries(needs)) {
        const L = CATALOGUE[lib];
        const have = [L.v].concat(Object.keys(L.alt || {})).sort((a, b) => cmp(b, a));
        const pin = asked[lib];
        const ok = have.filter((v) => list.every(([, rg]) => cmp(v, rg[0]) >= 0 && cmp(v, rg[1]) < 0) && (!pin || versionOk(v, pin.op, pin.want)));
        if (!ok.length) {
          // with a pin, blame the packages whose range excludes it; otherwise all of them
          const fits = (rg) => have.some((v) => cmp(v, rg[0]) >= 0 && cmp(v, rg[1]) < 0 && (!pin || versionOk(v, pin.op, pin.want)));
          const culprits = pin ? list.filter(([, rg]) => !fits(rg)) : list;
          const spec = (p) => (asked[p] ? `${p} ${asked[p].op}${asked[p].want} *` : `${p} *`);
          // the package that needs the newest library first, as in conda's report
          const order = Object.keys(CATALOGUE);
          const top = (culprits.length ? culprits : list).map(([, rg]) => rg[0]).reduce((x, y) => (cmp(x, y) >= 0 ? x : y));
          const first = ([, rg]) => (cmp(rg[0], top) === 0 ? 0 : 1);
          (culprits.length ? culprits : list).slice().sort((a, b) => first(a) - first(b) || order.indexOf(a[0]) - order.indexOf(b[0])).forEach(([p, rg]) => conflicts.push({ pkg: p, spec: spec(p), text: `${p}-${CATALOGUE[p].v}-${CATALOGUE[p].build} requires ${lib} >=${rg[0]},<${rg[1]}.0a0`, lib, range: rg }));
          if (pin) conflicts.push({ pkg: lib, spec: spec(lib), text: `${lib} ${pin.op}${pin.want} was requested`, lib, v: pin.want });
        } else {
          if (ok[0] !== L.v) pins[lib] = ok[0];
          else delete pins[lib];
          if (!pkgs.includes(lib)) pkgs.push(lib);
        }
      }
      // a loose pin such as bcftools=1.10 means "any 1.10.x": say what a real conda would pick
      for (const [name, a] of Object.entries(asked)) {
        const c = CATALOGUE[name];
        if (a.op === '=' && c.newest && c.newest[a.want]) notes.push(`${name}=${a.want} means “any ${a.want}.x version”: on a real computer conda would install the newest, ${name} ${c.newest[a.want]}. This browser only has ${name} ${c.v}. Use ${name}==${c.v} to ask for exactly ${c.v}.`);
      }
      return { pkgs: Array.from(new Set(pkgs)), problems, notes, pins, conflicts };
    },
    create(name, specs, channels) {
      const r = this.solve(specs);
      this.envs[name] = { specs: specs.slice(), pkgs: r.pkgs, pins: r.pins, channels: channels && channels.length ? channels : ['conda-forge', 'bioconda'], created: new Date().toISOString() };
      this.save();
    },
    /** version and build of a package in an environment */
    version(envName, pkg) {
      const c = CATALOGUE[pkg];
      const env = this.envs[envName] || {};
      const v = (env.pins && env.pins[pkg]) || c.v;
      return { v, build: v === c.v ? c.build : (c.alt || {})[v] || c.build };
    }
  };

  function vkey(v) {
    return String(v).toLowerCase().match(/\d+|[a-z]+/g).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  }
  function cmp(a, b) {
    const A = vkey(a), B = vkey(b);
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
      const x = A[i] == null ? 0 : A[i], y = B[i] == null ? 0 : B[i];
      if (x === y) continue;
      if (typeof x === 'number' && typeof y === 'number') return x - y;
      return String(x) < String(y) ? -1 : 1;
    }
    return 0;
  }
  function versionOk(have, op, want) {
    want = String(want).replace(/\.?\*$/, '');
    if (!want) return true;
    if (op === '=' ) return have === want || have.startsWith(want + '.');
    if (op === '==') return cmp(have, want) === 0;
    if (op === '>=') return cmp(have, want) >= 0;
    if (op === '<=') return cmp(have, want) <= 0;
    if (op === '>') return cmp(have, want) > 0;
    if (op === '<') return cmp(have, want) < 0;
    if (op === '!=') return cmp(have, want) !== 0;
    return true;
  }
  conda.versionOk = versionOk;

  conda.load();
  MG.conda = conda;
})();
