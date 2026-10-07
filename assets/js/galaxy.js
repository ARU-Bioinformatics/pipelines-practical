/* =====================================================================
   A Galaxy-style server that runs in the page (for teaching).

   Tools panel · history of datasets · tool forms · dataset details
   (tool, version, command line and parameters: Galaxy's provenance) ·
   a graphical workflow editor with typed connections · workflow runs
   (invocations) · "extract workflow from history" · .ga export/import.

   Jobs run the same WebAssembly programs as the terminal and Snakemake,
   in a job working directory, the way Galaxy does – so the same workflow
   gives the same variant calls.
   ===================================================================== */
(function () {
  'use strict';
  const MG = window.MG;
  const { h, esc, bus, toast, store } = MG;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const GX_ROOT = '/galaxy';

  /* ------------------------------------------------------------------ the tools */
  const TS = 'toolshed.g2.bx.psu.edu/repos';
  const TOOLS = [
    {
      id: 'minimap2',
      toolId: `${TS}/iuc/minimap2/minimap2/2.22+galaxy0`,
      name: 'Map with minimap2',
      desc: 'A fast pairwise aligner for genomic and spliced nucleotide sequences',
      version: '2.22+galaxy0',
      section: 'Mapping',
      requirements: [['minimap2', '2.22'], ['samtools', '1.17']],
      inputs: [
        { name: 'reference', short: 'reference', label: 'Use the following dataset as the reference sequence', ext: ['fasta'], nice: 'reference.fa' },
        { name: 'fastq1', short: 'forward reads', label: 'Select fastq dataset (forward reads)', ext: ['fastqsanger'], nice: 'input_f.fastq', pick: /_1|R1|forward/i },
        { name: 'fastq2', short: 'reverse reads', label: 'Select fastq dataset (reverse reads)', ext: ['fastqsanger'], nice: 'input_r.fastq', pick: /_2|R2|reverse/i }
      ],
      params: [
        { name: 'preset', short: 'preset', label: 'Select a profile of preset options', type: 'select', default: 'sr', options: [['sr', 'Short single-end reads without splicing (-k21 -w11 --sr --frag=yes …) (sr)'], ['map-ont', 'Oxford Nanopore read to reference mapping (map-ont)'], ['map-pb', 'PacBio CLR read to reference mapping (map-pb)']], help: 'sr is the profile for short Illumina reads, as in the command line minimap2 -ax sr.' },
        { name: 'rg_id', short: 'read group ID', label: 'Read group identifier (ID)', type: 'text', default: 'NA12878' },
        { name: 'rg_sm', short: 'sample (SM)', label: 'Sample name (SM)', type: 'text', default: 'NA12878' }
      ],
      outputs: [{ name: 'alignment_output', short: 'BAM', ext: 'bam', file: 'output.bam', label: (ins) => `Map with minimap2 on ${dataList(ins)} (mapped reads in BAM format)` }],
      command: (i, p) => `minimap2 -x ${p.preset} -a -t 1 -R '@RG\\tID:${p.rg_id}\\tSM:${p.rg_sm}' ${i.reference} ${i.fastq1} ${i.fastq2} | samtools sort -o output.bam -`,
      help: '<p><b>minimap2</b> aligns the reads to the reference; the output is sorted by position with <b>samtools sort</b>, like <code>minimap2 -ax sr … | samtools sort</code>. Galaxy indexes BAM files by itself (the index is stored with the dataset), so there is no separate indexing step.</p>'
    },
    {
      id: 'samtools_flagstat',
      toolId: `${TS}/devteam/samtools_flagstat/samtools_flagstat/2.0.5`,
      name: 'Samtools flagstat',
      desc: 'tabulate descriptive stats for BAM datset',
      version: '2.0.5',
      section: 'SAM/BAM',
      requirements: [['samtools', '1.17']],
      inputs: [{ name: 'input1', short: 'BAM', label: 'BAM File to Convert', ext: ['bam'], nice: 'input.bam' }],
      params: [],
      outputs: [{ name: 'output1', short: 'stats', ext: 'txt', file: 'output.txt', label: (ins) => `Samtools flagstat on ${dataList(ins)}` }],
      command: (i) => `samtools flagstat ${i.input1} > output.txt`,
      help: '<p>Counts the reads by their SAM flags: mapped, properly paired, duplicates…</p>'
    },
    {
      id: 'bcftools_mpileup',
      toolId: `${TS}/iuc/bcftools_mpileup/bcftools_mpileup/1.10`,
      name: 'bcftools mpileup',
      desc: 'Generate VCF or BCF containing genotype likelihoods for one or multiple alignment (BAM or CRAM) files',
      version: '1.10',
      section: 'Variant calling',
      requirements: [['bcftools', '1.10']],
      inputs: [
        { name: 'reference', short: 'reference', label: 'Choose the source for the reference genome: use a genome from the history', ext: ['fasta'], nice: 'ref.fa' },
        { name: 'input_bam', short: 'BAM', label: 'Input BAM/CRAM', ext: ['bam'], nice: 'input.bam' }
      ],
      params: [{ name: 'output_type', short: 'output type', label: 'Output type', type: 'select', default: 'u', options: [['u', 'uncompressed BCF'], ['b', 'compressed BCF'], ['v', 'uncompressed VCF'], ['z', 'compressed VCF']] }],
      outputs: [{ name: 'output_file', short: 'likelihoods', ext: (p) => (p.output_type === 'v' ? 'vcf' : p.output_type === 'z' ? 'vcf_bgzip' : 'bcf'), file: 'output', label: (ins) => `bcftools mpileup on ${dataList(ins)}` }],
      command: (i, p) => `bcftools mpileup -f ${i.reference} ${i.input_bam} -O${p.output_type} -o output`,
      help: '<p>Collects, for every position of the reference, the evidence in the reads (<i>genotype likelihoods</i>). The next step, <b>bcftools call</b>, decides the genotypes.</p>'
    },
    {
      id: 'bcftools_call',
      toolId: `${TS}/iuc/bcftools_call/bcftools_call/1.10`,
      name: 'bcftools call',
      desc: 'SNP/indel variant calling from VCF/BCF',
      version: '1.10',
      section: 'Variant calling',
      requirements: [['bcftools', '1.10']],
      inputs: [{ name: 'input_file', short: 'likelihoods', label: 'VCF/BCF Data', ext: ['bcf', 'vcf', 'vcf_bgzip'], nice: 'input.bcf' }],
      params: [
        { name: 'method', short: 'caller', label: 'Calling method', type: 'select', default: 'm', options: [['m', 'Multiallelic and rare-variant caller (-m)'], ['c', 'Consensus caller (-c)']] },
        { name: 'variants_only', short: 'variants only', label: 'Output variant sites only (-v)', type: 'bool', default: true },
        { name: 'output_type', short: 'output type', label: 'Output type', type: 'select', default: 'z', options: [['z', 'compressed VCF'], ['v', 'uncompressed VCF'], ['b', 'compressed BCF'], ['u', 'uncompressed BCF']] }
      ],
      outputs: [{ name: 'output_file', short: 'VCF', ext: (p) => (p.output_type === 'z' ? 'vcf_bgzip' : p.output_type === 'v' ? 'vcf' : 'bcf'), file: 'output', label: (ins) => `bcftools call on ${dataList(ins)}` }],
      command: (i, p) => `bcftools call -${p.method}${p.variants_only ? 'v' : ''} -O${p.output_type} -o output ${i.input_file}`,
      help: '<p>Calls the variants: for each position it chooses the most likely genotype (0/0, 0/1 or 1/1) from the likelihoods made by mpileup. With <b>-v</b> only the variant sites are written.</p>'
    },
    {
      id: 'bcftools_filter',
      toolId: `${TS}/iuc/bcftools_filter/bcftools_filter/1.10`,
      name: 'bcftools filter',
      desc: 'Apply fixed-threshold filters',
      version: '1.10',
      section: 'Variant calling',
      requirements: [['bcftools', '1.10']],
      inputs: [{ name: 'input_file', short: 'VCF', label: 'VCF/BCF Data', ext: ['vcf_bgzip', 'vcf', 'bcf'], nice: 'input.vcf.gz' }],
      params: [
        { name: 'include', short: 'include', label: 'Include (expression)', type: 'text', default: 'QUAL>=20 && INFO/DP>=5', help: 'Keep only the sites for which the expression is true, e.g. QUAL>=20 && INFO/DP>=5' },
        { name: 'output_type', short: 'output type', label: 'Output type', type: 'select', default: 'z', options: [['z', 'compressed VCF'], ['v', 'uncompressed VCF']] }
      ],
      outputs: [{ name: 'output_file', short: 'VCF', ext: (p) => (p.output_type === 'z' ? 'vcf_bgzip' : 'vcf'), file: 'output', label: (ins) => `bcftools filter on ${dataList(ins)}` }],
      command: (i, p) => `bcftools filter -i '${String(p.include).replace(/'/g, '')}' -O${p.output_type} -o output ${i.input_file}`,
      help: '<p>Keeps the variant sites that pass a filter expression – the same thresholds as your Snakemake rule <code>filter_variants</code>.</p>'
    },
    {
      id: 'bcftools_view_h',
      toolId: `${TS}/iuc/bcftools_view/bcftools_view/1.10`,
      name: 'bcftools view',
      desc: 'VCF/BCF conversion, view, subset and filter VCF/BCF files',
      version: '1.10',
      section: 'Variant calling',
      requirements: [['bcftools', '1.10']],
      inputs: [{ name: 'input_file', short: 'VCF', label: 'VCF/BCF Data', ext: ['vcf_bgzip', 'vcf', 'bcf'], nice: 'input.vcf.gz' }],
      params: [{ name: 'header', short: 'header', label: 'Header', type: 'select', default: 'H', options: [['H', 'suppress the header (-H): records only'], ['h', 'header only (-h)'], ['', 'header and records']] }],
      outputs: [{ name: 'output_file', short: 'text', ext: 'tabular', file: 'output.tsv', label: (ins) => `bcftools view on ${dataList(ins)}` }],
      command: (i, p) => `bcftools view ${p.header ? '-' + p.header + ' ' : ''}${i.input_file} > output.tsv`,
      help: '<p>Shows a VCF as text. With <b>-H</b> only the variant records are written, without the header (whose lines record dates, file names and commands, so they differ between runs).</p>'
    }
  ];
  const TOOL = new Map(TOOLS.map((t) => [t.id, t]));
  const EXT_OF = (o, p) => (typeof o.ext === 'function' ? o.ext(p || {}) : o.ext);
  const FILE_EXT = { fastqsanger: 'fastqsanger', fasta: 'fasta', bam: 'bam', bcf: 'bcf', vcf: 'vcf', vcf_bgzip: 'vcf_bgzip', txt: 'txt', tabular: 'tabular' };
  const DOWNLOAD_EXT = { fastqsanger: 'fastq', fasta: 'fasta', bam: 'bam', bcf: 'bcf', vcf: 'vcf', vcf_bgzip: 'vcf.gz', txt: 'txt', tabular: 'tabular' };
  function dataList(ins) {
    const hids = ins.map((x) => 'data ' + x.hid);
    if (hids.length <= 1) return hids.join('');
    if (hids.length === 2) return hids.join(' and ');
    return hids.slice(0, -1).join(', ') + ', and ' + hids[hids.length - 1];
  }
  function sniff(name) {
    const n = name.toLowerCase();
    if (/\.(fastq|fq)$/.test(n)) return 'fastqsanger';
    if (/\.(fa|fasta|fna)$/.test(n)) return 'fasta';
    if (/\.bam$/.test(n)) return 'bam';
    if (/\.vcf\.gz$/.test(n)) return 'vcf_bgzip';
    if (/\.vcf$/.test(n)) return 'vcf';
    if (/\.bcf$/.test(n)) return 'bcf';
    if (/\.(tsv|tab|tabular)$/.test(n)) return 'tabular';
    return 'txt';
  }
  const uid = () => Math.random().toString(36).slice(2, 10);
  const uuid = () => ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));

  class GalaxyApp {
    constructor(root, opts) {
      this.root = root;
      this.fs = opts.fs;
      // Galaxy has its own working directory: a view of the shared file system with its own cwd
      this.gfs = Object.create(this.fs);
      this.gfs.cwd = GX_ROOT;
      this.fs.mkdirp(GX_ROOT + '/database/files/000');
      this.fs.mkdirp(GX_ROOT + '/jobs');
      this.shell = new MG.Shell({ fs: this.gfs, term: null });
      // Galaxy installs the programs of its tools itself (the "requirements" of each tool): they are there whatever
      // conda environment is active in the terminal. (See dispatch in shell-pipe.js.)
      this.shell._jobTools = ['minimap2', 'samtools', 'bcftools', 'bgzip', 'tabix'];
      this.datasets = [];
      this.jobs = [];
      this.invocations = [];
      this.hid = 0;
      this.jobN = 0;
      this.queue = Promise.resolve();
      const saved = store.get('galaxy', null);
      this.workflows = saved && Array.isArray(saved.workflows) ? saved.workflows : [];
      this.historyName = 'CYP2C19 variant calling';
      this._build();
      this.showHome();
    }
    save() {
      store.set('galaxy', { workflows: this.workflows });
    }

    /* ================= layout ================= */
    _build() {
      const r = this.root;
      r.classList.add('gx');
      const nav = h('div.gx-nav');
      const navb = (icon, label, fn) => {
        const b = h('button.gx-navb', { type: 'button', html: MG.icon(icon) + '<span>' + esc(label) + '</span>' });
        b.addEventListener('click', fn);
        return b;
      };
      this.navHome = navb('database', 'Analyse data', () => this.showHome());
      this.navWf = navb('workflow', 'Workflows', () => this.showWorkflows());
      this.navInv = navb('history', 'Invocations', () => this.showInvocations());
      nav.append(h('span.gx-brand', { html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#f6c343" stroke-width="2"><path d="M12 3l2.6 5.6L20 9.5l-4 4 1 5.8L12 16.6 7 19.3l1-5.8-4-4 5.4-.9z"/></svg><b>Galaxy</b><small>practice server in your browser</small>' }), this.navHome, this.navWf, this.navInv);
      this.toolSearch = h('input.gx-search', { type: 'search', placeholder: 'search tools', 'aria-label': 'Search tools' });
      this.toolList = h('div.gx-toollist');
      this.toolSearch.addEventListener('input', () => this.renderTools());
      const up = h('button.btn.small.gx-upload', { type: 'button', html: MG.icon('upload') + '<span>Upload Data</span>' });
      up.addEventListener('click', () => this.showUpload());
      this.toolPanel = h('aside.gx-tools', h('div.gx-ph', 'Tools'), h('div.gx-upwrap', up), this.toolSearch, this.toolList);
      this.center = h('main.gx-center');
      this.histHead = h('div.gx-hh');
      this.histList = h('div.gx-hlist');
      this.histPanel = h('aside.gx-history', h('div.gx-ph', 'History'), this.histHead, this.histList);
      this.sideCol = h('aside.gx-sidecol');
      r.append(nav, h('div.gx-body', this.toolPanel, this.center, this.histPanel, this.sideCol));
      this.renderTools();
      this.renderHistory();
    }
    setNav(which) {
      this.navHome.classList.toggle('on', which === 'home');
      this.navWf.classList.toggle('on', which === 'wf');
      this.navInv.classList.toggle('on', which === 'inv');
    }
    _center(view) {
      this.view = view;
      if (view !== 'editor') {
        this.root.classList.remove('gx-editing');
        this.editing = null;
      }
      this.center.innerHTML = '';
      this.center.scrollTop = 0;
      return this.center;
    }

    /* ================= tools panel ================= */
    renderTools() {
      const q = this.toolSearch.value.trim().toLowerCase();
      const L = this.toolList;
      L.innerHTML = '';
      const sections = [];
      TOOLS.forEach((t) => {
        if (q && !(t.name + ' ' + t.desc + ' ' + t.section).toLowerCase().includes(q)) return;
        let s = sections.find((x) => x.name === t.section);
        if (!s) sections.push((s = { name: t.section, tools: [] }));
        s.tools.push(t);
      });
      sections.forEach((s) => {
        const det = h('details.gx-sec', { open: true });
        det.appendChild(h('summary', s.name));
        s.tools.forEach((t) => {
          const b = h('button.gx-tool', { type: 'button', title: t.desc, dataset: { tool: t.id } }, h('b', t.name), h('span', ' ' + t.desc));
          b.addEventListener('click', () => {
            if (this.view === 'editor' && this.editing) this.editorAddTool(t.id);
            else this.showTool(t.id);
          });
          det.appendChild(b);
        });
        L.appendChild(det);
      });
      if (!sections.length) L.appendChild(h('p.muted.small', 'No tools match.'));
    }

    /* ================= history ================= */
    addDataset(d) {
      const hid = ++this.hid;
      const ds = Object.assign({ hid, state: 'ok', created: new Date(), dbkey: '?', uuid: uuid() }, d);
      ds.path = `${GX_ROOT}/database/files/000/dataset_${ds.uuid}.dat`;
      this.datasets.push(ds);
      this.renderHistory();
      return ds;
    }
    ds(hid) {
      return this.datasets.find((d) => d.hid === hid);
    }
    renderHistory() {
      const vis = this.datasets.filter((d) => !d.deleted);
      const size = vis.reduce((s, d) => s + (d.size || 0), 0);
      this.histHead.innerHTML = '';
      const name = h('div.gx-hname', { title: 'Click to rename the history' }, this.historyName);
      name.addEventListener('click', () => {
        const n = window.prompt('History name:', this.historyName);
        if (n) {
          this.historyName = n;
          this.renderHistory();
        }
      });
      const extract = h('button.btn.small', { type: 'button', title: 'Turn the jobs in this history into a workflow', html: MG.icon('workflow') + '<span>Extract workflow</span>' });
      extract.addEventListener('click', () => this.extractWorkflow());
      this.histHead.append(name, h('div.gx-hmeta', `${vis.length} dataset${vis.length === 1 ? '' : 's'} · ${MG.humanSize(size)}B`), h('div.gx-hacts', extract));
      const L = this.histList;
      const openSet = new Set(Array.from(L.querySelectorAll('.gx-ds.open')).map((e) => +e.dataset.hid));
      L.innerHTML = '';
      vis.slice().reverse().forEach((d) => {
        const row = h('div.gx-ds.' + d.state, { dataset: { hid: d.hid } });
        const title = h('div.gx-ds-t', { role: 'button', tabindex: '0' }, h('span.gx-hid', d.hid + ':'), h('span.gx-dname', d.name));
        const icons = h('span.gx-ds-ic');
        const mk = (ic, tip, fn) => {
          const b = h('button.gx-ib', { type: 'button', title: tip, 'aria-label': tip, html: MG.icon(ic) });
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            fn();
          });
          return b;
        };
        if (d.state === 'ok') icons.append(mk('eye', 'View data', () => this.showDataset(d.hid)));
        icons.append(mk('x', 'Delete', () => this.deleteDataset(d.hid)));
        row.append(h('div.gx-ds-top', title, icons));
        const body = h('div.gx-ds-body');
        if (d.state === 'queued') body.appendChild(h('div.gx-stateline', 'This job is waiting to run'));
        else if (d.state === 'running') body.appendChild(h('div.gx-stateline', { html: '<span class="spinner small"></span> This job is currently running' }));
        else if (d.state === 'error') body.appendChild(h('div.gx-stateline.err', 'An error occurred with this dataset – click the ⓘ to see the error message'));
        if (d.state === 'ok' || d.state === 'error') {
          if (d.info) body.appendChild(h('div.gx-blurb', d.info));
          body.appendChild(h('div.gx-fmt', { html: `format <b>${esc(d.ext)}</b>, database <b>${esc(d.dbkey)}</b>` }));
          if (d.peek) body.appendChild(h('pre.gx-peek', d.peek));
          const acts = h('div.gx-acts');
          acts.append(mk('download', 'Download', () => this.download(d.hid)), mk('info', 'Dataset details (how was this made?)', () => this.showDetails(d.hid)));
          if (d.job) acts.append(mk('rerun', 'Run this job again', () => this.showTool(d.job.toolId, d.job)));
          if (d.state === 'ok') {
            const cp = h('button.gx-link', { type: 'button', title: 'Copy this dataset into your home folder, to use it in the Terminal' }, 'copy to my files');
            cp.addEventListener('click', (e) => {
              e.stopPropagation();
              this.copyToFiles(d.hid);
            });
            acts.appendChild(cp);
          }
          body.appendChild(acts);
        }
        row.appendChild(body);
        if (openSet.has(d.hid) || d.state !== 'ok') row.classList.add('open');
        const toggle = () => row.classList.toggle('open');
        title.addEventListener('click', toggle);
        title.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle()));
        L.appendChild(row);
      });
      if (!vis.length) L.appendChild(h('div.gx-empty', h('p', 'This history is empty.'), h('p.muted.small', { html: 'Use <b>Upload Data</b> (top left) to bring in the reads and the reference.' })));
    }
    deleteDataset(hid) {
      const d = this.ds(hid);
      if (!d) return;
      d.deleted = true;
      this.renderHistory();
    }
    fileName(d) {
      return `Galaxy${d.hid}-[${d.name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}].${DOWNLOAD_EXT[d.ext] || d.ext}`;
    }
    async download(hid) {
      const d = this.ds(hid);
      try {
        MG.downloadBlob(await this.fs.toBlob(d.path), this.fileName(d));
        bus.emit('gx:download', { hid, ext: d.ext });
      } catch (e) {
        toast('Could not download: ' + esc(e.message), 'error');
      }
    }
    copyToFiles(hid) {
      const d = this.ds(hid);
      const dir = MG.app.HOME + '/galaxy';
      this.fs.mkdirp(dir);
      const target = dir + '/' + this.fileName(d);
      this.fs.copy(d.path, target);
      toast(`Copied to <b>${esc(this.fs.pretty(target))}</b> – use it in the Terminal.`, null, 5000);
      bus.emit('gx:copy', { hid, ext: d.ext, path: target, tool: d.job ? d.job.toolId : null });
    }

    /* ================= upload ================= */
    showUpload() {
      const C = this._center('upload');
      this.setNav('home');
      C.appendChild(h('h3', 'Upload Data'));
      C.appendChild(h('p.muted', 'Choose files to bring into your history. In a real Galaxy you would upload from your computer or import from a shared data library; here you choose from the course data and from your home folder.'));
      const files = [];
      const add = (p) => {
        const e = this.fs.get(p);
        if (e && e.kind !== 'dir' && !/\.(fai|bai|md|json)$|MD5SUMS$/.test(p)) files.push(p);
      };
      // (in the order of a dictionary, as before: the terminal's own order – ls – has capital letters first)
      this.fs.list('/data/course').sort((a, b) => a.name.localeCompare(b.name)).forEach((c) => add(c.path));
      for (const [p, e] of this.fs.entries) {
        if (!p.startsWith(MG.app.HOME + '/') || e.kind === 'dir' || /\/\.|\/results\/|\/logs\//.test(p.slice(MG.app.HOME.length))) continue;
        if (/\.(fastq|fq|fa|fasta)$/i.test(p)) add(p);
      }
      const form = h('form.gx-form');
      const list = h('div.gx-uplist');
      files.forEach((p) => {
        const cb = h('input', { type: 'checkbox', value: p });
        const sel = h('select', { 'aria-label': 'Format of ' + p });
        ['auto-detect', 'fastqsanger', 'fasta', 'bam', 'vcf', 'vcf_bgzip', 'txt'].forEach((x) => sel.appendChild(h('option', { value: x }, x)));
        list.appendChild(h('label.gx-uprow', cb, h('code', this.fs.pretty(p)), h('small.muted', MG.humanSize(this.fs.size(this.fs.get(p))) + 'B'), sel));
      });
      form.appendChild(list);
      const go = h('button.btn.primary', { type: 'submit', html: MG.icon('upload') + '<span>Start</span>' });
      form.appendChild(h('div.gx-runrow', go));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const rows = Array.from(list.querySelectorAll('.gx-uprow')).filter((r) => r.querySelector('input').checked);
        if (!rows.length) return toast('Tick at least one file.', 'warn');
        rows.forEach((r) => {
          const p = r.querySelector('input').value;
          const f = r.querySelector('select').value;
          this.upload(p, f === 'auto-detect' ? sniff(p) : f);
        });
        this.showHome();
      });
      C.appendChild(form);
      bus.emit('gx:uploadform', {});
    }
    upload(path, ext) {
      const name = path.split('/').pop();
      const d = this.addDataset({ name, ext: ext || sniff(name), state: 'queued', source: 'Uploaded from ' + path });
      const job = { id: ++this.jobN, toolId: 'upload1', toolName: 'Upload File', version: '1.1.7', inputs: [], params: { file: path, file_type: ext }, state: 'queued', created: new Date(), outputs: [d.hid] };
      d.upload = job;
      this.queue = this.queue.then(async () => {
        await sleep(350);
        d.state = 'running';
        this.renderHistory();
        await sleep(450);
        this.fs.copy(path, d.path);
        d.size = this.fs.size(this.fs.get(d.path));
        await this._describe(d);
        d.state = 'ok';
        job.state = 'ok';
        this.renderHistory();
        bus.emit('gx:upload', { hid: d.hid, name, ext: d.ext });
      });
      return d;
    }

    /* ================= home ================= */
    showHome() {
      const C = this._center('home');
      this.setNav('home');
      C.append(
        h('h3', 'Welcome to Galaxy'),
        h('p', { html: 'This practice server works like <b>Galaxy</b> (usegalaxy.org and its sister servers): <b>tools</b> on the left, your <b>history</b> of datasets on the right, forms and results in the middle. Jobs run the same programs as your terminal and your Snakefile – minimap2 2.22, samtools 1.17 and bcftools 1.10 compiled to WebAssembly.' }),
        h('div.gx-cards',
          card('upload', '1 · Get data', 'Upload Data (top left) brings the reads and the reference into your history.'),
          card('wrench', '2 · Run tools', 'Click a tool, choose its inputs from the history and press Run tool. New datasets appear at the top of the history: grey = queued, yellow = running, green = done.'),
          card('workflow', '3 · Workflows', 'Build the pipeline as a graph of tools – or extract it from your history – and run it again with one click.')
        )
      );
    }

    /* ================= tool form ================= */
    showTool(id, rerunJob) {
      const t = TOOL.get(id);
      if (!t) return;
      const C = this._center('tool');
      this.setNav('home');
      C.appendChild(h('div.gx-toolh', h('h3', t.name), h('span.muted', `${t.desc} (Galaxy Version ${t.version})`)));
      const form = h('form.gx-form');
      const values = {};
      const prev = rerunJob || null;
      t.inputs.forEach((inp) => {
        const sel = h('select', { name: inp.name });
        const cand = this.datasets.filter((d) => !d.deleted && d.state === 'ok' && inp.ext.includes(d.ext));
        cand.slice().reverse().forEach((d) => sel.appendChild(h('option', { value: String(d.hid) }, `${d.hid}: ${d.name}`)));
        if (!cand.length) sel.appendChild(h('option', { value: '' }, `No ${inp.ext.join(' / ')} dataset in the history`));
        if (prev && prev.inputs) {
          const p = prev.inputs.find((x) => x.name === inp.name);
          if (p) sel.value = String(p.hid);
        } else if (inp.pick) {
          const pick = cand.slice().reverse().find((d) => inp.pick.test(d.name));
          if (pick) sel.value = String(pick.hid);
        }
        values[inp.name] = sel;
        form.appendChild(field(inp.label, sel, inp.ext.join(', ')));
      });
      t.params.forEach((p) => {
        const cur = prev && prev.params && p.name in prev.params ? prev.params[p.name] : p.default;
        const ctl = control(p, cur);
        values[p.name] = ctl;
        form.appendChild(field(p.label, ctl, null, p.help));
      });
      const run = h('button.btn.primary', { type: 'submit', html: MG.icon('play') + '<span>Run tool</span>' });
      form.appendChild(h('div.gx-runrow', run));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const inputs = t.inputs.map((inp) => ({ name: inp.name, hid: +values[inp.name].value }));
        if (inputs.some((x) => !x.hid)) return toast('Choose an input dataset for every input first.', 'warn');
        const params = {};
        t.params.forEach((p) => (params[p.name] = readControl(p, values[p.name])));
        this.submit(t.id, inputs, params);
        C.innerHTML = '';
        C.appendChild(h('div.gx-queued', h('h3', { html: MG.icon('check') + ' Job submitted' }), h('p', `${t.name} has been added to the queue. Its output appears at the top of your history.`)));
      });
      C.appendChild(form);
      if (t.help) C.appendChild(h('div.gx-help', h('h4', 'What it does'), h('div', { html: t.help })));
      bus.emit('gx:toolform', { tool: id });
    }

    /* ================= jobs ================= */
    submit(toolId, inputs, params, opts = {}) {
      const t = TOOL.get(toolId);
      const inDs = inputs.map((x) => ({ name: x.name, hid: x.hid, ds: this.ds(x.hid) }));
      const job = { id: ++this.jobN, toolId, toolShedId: t.toolId, toolName: t.name, version: t.version, inputs: inputs.map((x) => ({ name: x.name, hid: x.hid })), params, state: 'queued', created: new Date(), invocation: opts.invocation || null, step: opts.step || null };
      const outs = t.outputs.map((o) => this.addDataset({ name: o.label(inDs, params), ext: EXT_OF(o, params), state: 'queued', job, outName: o.name, dbkey: '?' }));
      job.outputs = outs.map((d) => d.hid);
      this.jobs.push(job);
      const done = (this.queue = this.queue.then(() => this._runJob(job, t, inDs, outs)));
      bus.emit('gx:submitted', { tool: toolId, job: job.id, invocation: job.invocation });
      return { job, outs, done };
    }
    async _runJob(job, t, inDs, outs) {
      if (inDs.some((x) => !x.ds || x.ds.state !== 'ok')) {
        await Promise.resolve();
        outs.forEach((d) => (d.state = 'error'));
        job.state = 'error';
        job.stderr = 'An input dataset is not ready (it is in the error state or was deleted), so this job was not run.';
        this.renderHistory();
        bus.emit('gx:job', { tool: t.id, state: 'error', job: job.id, invocation: job.invocation });
        return;
      }
      await sleep(500);
      outs.forEach((d) => (d.state = 'running'));
      job.state = 'running';
      job.started = new Date();
      this.renderHistory();
      const wd = `${GX_ROOT}/jobs/000/${job.id}/working`;
      this.fs.mkdirp(wd);
      const links = [];
      const paths = {};
      inDs.forEach((x) => {
        const inp = t.inputs.find((i) => i.name === x.name);
        const nice = inp.nice || x.name;
        this.fs.copy(x.ds.path, wd + '/' + nice);
        links.push(`ln -f -s '${x.ds.path}' '${nice}'`);
        if (x.ds.ext === 'bam' && this.fs.exists(x.ds.path + '.bai')) {
          this.fs.copy(x.ds.path + '.bai', wd + '/' + nice + '.bai');
          links.push(`ln -f -s '${x.ds.path}.bai' '${nice}.bai'`);
        }
        paths[x.name] = nice;
      });
      const cmd = t.command(paths, job.params);
      job.command = links.join(' && ') + (links.length ? ' && ' : '') + cmd;
      let stdout = '', stderr = '';
      const io = { out: (x) => (stdout += x), err: (x) => (stderr += x), colored: (x) => (stderr += x), note: () => {}, html: () => {}, progress: () => {}, clear: () => {} };
      const t0 = performance.now();
      let code = 0;
      this.gfs.cwd = wd;
      try {
        code = await this.shell.exec(cmd, io, { errexit: true, pipefail: true });
      } catch (e) {
        stderr += String(e && e.message ? e.message : e);
        code = 1;
      }
      const el = performance.now() - t0;
      if (el < 900) await sleep(900 - el);
      job.stdout = stdout;
      job.stderr = stderr.replace(/\/shared\/vfs/g, '');
      job.exitCode = code;
      job.finished = new Date();
      job.runtime = (performance.now() - t0) / 1000;
      const ok = code === 0 && t.outputs.every((o) => this.fs.exists(wd + '/' + o.file));
      if (!ok) {
        job.state = 'error';
        outs.forEach((d) => (d.state = 'error'));
        this.renderHistory();
        bus.emit('gx:job', { tool: t.id, state: 'error', job: job.id, invocation: job.invocation });
        return;
      }
      for (const d of outs) {
        const o = t.outputs.find((x) => x.name === d.outName);
        this.fs.rename(wd + '/' + o.file, d.path);
        d.size = this.fs.size(this.fs.get(d.path));
        if (d.ext === 'bam') {
          // Galaxy indexes BAM datasets itself (the index is stored as metadata of the dataset)
          const r = await this.shell.exec(`samtools index '${d.path}'`, { out: () => {}, err: (x) => (job.stderr += x), note() {}, html() {}, progress() {}, colored() {} }, { errexit: true });
          if (r !== 0) job.stderr += '\n(indexing the BAM failed)';
        }
        try {
          await this._describe(d);
        } catch (err) {
          console.error(err);
        }
        d.state = 'ok';
      }
      job.state = 'ok';
      this.renderHistory();
      bus.emit('gx:job', { tool: t.id, state: 'ok', job: job.id, invocation: job.invocation });
    }
    /** the short summary and peek Galaxy shows under a dataset */
    async _describe(d) {
      const quiet = { out: () => {}, err: () => {}, note() {}, html() {}, progress() {}, colored() {} };
      const text = async (cmd) => {
        let o = '';
        await this.shell.exec(cmd, Object.assign({}, quiet, { out: (x) => (o += x) }), {});
        return o;
      };
      try {
        if (d.ext === 'fastqsanger') {
          const t = await this.fs.readText(d.path);
          const n = t.split('\n').filter(Boolean).length / 4;
          d.info = `${MG.fmt(n)} sequences`;
          d.peek = t.split('\n').slice(0, 4).join('\n');
        } else if (d.ext === 'fasta') {
          const t = await this.fs.readText(d.path);
          const seqs = (t.match(/^>/gm) || []).length;
          d.info = `${seqs} sequences`;
          d.peek = t.split('\n').slice(0, 3).map((l) => (l.length > 60 ? l.slice(0, 60) + '…' : l)).join('\n');
        } else if (d.ext === 'bam') {
          d.info = 'Alignments sorted by coordinate (indexed)';
          d.peek = (await text(`samtools view '${d.path}' | head -n 2 | cut -f 1-6`)).trim();
        } else if (d.ext === 'bcf') {
          d.info = 'Genotype likelihoods (binary BCF)';
        } else if (d.ext === 'vcf_bgzip' || d.ext === 'vcf') {
          const n = (await text(`bcftools view -H '${d.path}' | wc -l`)).trim();
          d.info = `${n} variant sites`;
          d.peek = (await text(`bcftools view -H '${d.path}' | head -n 3 | cut -f 1-6`)).trim();
        } else if (d.ext === 'txt' || d.ext === 'tabular') {
          const t = await this.fs.readText(d.path);
          const L = t.split('\n').filter(Boolean);
          d.info = `${L.length} lines`;
          d.peek = L.slice(0, 4).map((l) => (l.length > 90 ? l.slice(0, 90) + '…' : l)).join('\n');
        }
      } catch (e) {
        /* the summary is optional */
      }
    }

    /* ================= dataset views ================= */
    async showDataset(hid) {
      const d = this.ds(hid);
      if (!d) return;
      const C = this._center('dataset');
      C.appendChild(h('div.gx-toolh', h('h3', `${d.hid}: ${d.name}`), h('span.muted', `${d.ext} · ${MG.humanSize(d.size || 0)}B`)));
      bus.emit('gx:view', { hid, ext: d.ext });
      if (d.ext === 'bam' || d.ext === 'bcf') {
        C.appendChild(h('p', `This is a binary ${d.ext.toUpperCase()} file, so Galaxy cannot show it as text. Its first records:`));
        C.appendChild(h('pre.gx-pre', d.peek || '(binary)'));
        return;
      }
      let text = '';
      try {
        if (d.ext === 'vcf_bgzip') {
          await this.shell.exec(`bcftools view '${d.path}'`, { out: (x) => (text += x), err() {}, note() {}, html() {}, progress() {}, colored() {} }, {});
        } else text = await this.fs.readText(d.path);
      } catch (e) {
        text = '(could not read the dataset)';
      }
      if (d.ext === 'vcf' || d.ext === 'vcf_bgzip' || d.ext === 'tabular') C.appendChild(tsvTable(text, d.ext !== 'tabular'));
      else C.appendChild(h('pre.gx-pre', text.length > 200000 ? text.slice(0, 200000) + '\n…' : text));
    }
    showDetails(hid) {
      const d = this.ds(hid);
      if (!d) return;
      const C = this._center('details');
      C.appendChild(h('h3', 'Dataset Information'));
      const tbl = h('table.table.small.gx-details');
      const row = (k, v) => tbl.appendChild(h('tr', h('th', k), h('td', v instanceof Node ? v : String(v == null ? '' : v))));
      row('Number', d.hid);
      row('Name', d.name);
      row('Created', d.created.toLocaleString('en-GB'));
      row('Filesize', MG.humanSize(d.size || 0) + 'B');
      row('Dbkey', d.dbkey);
      row('Format', d.ext);
      row('UUID', d.uuid);
      row('Full Path', d.path);
      C.appendChild(tbl);
      const job = d.job || d.upload;
      if (job) {
        const t = TOOL.get(job.toolId);
        C.appendChild(h('h4', 'Job Information'));
        const jt = h('table.table.small.gx-details');
        const jr = (k, v) => jt.appendChild(h('tr', h('th', k), h('td', v instanceof Node ? v : String(v == null ? '' : v))));
        jr('Galaxy Tool ID', t ? t.toolId : job.toolId);
        jr('Galaxy Tool Version', job.version);
        jr('Job State', job.state);
        if (job.exitCode != null) jr('Command Exit Code', job.exitCode);
        if (job.runtime != null) jr('Job Runtime (Wall Clock)', job.runtime.toFixed(1) + ' seconds');
        if (job.invocation) jr('Workflow Invocation', '#' + job.invocation);
        C.appendChild(jt);
        if (t) {
          C.appendChild(h('h4', 'Dependencies'));
          C.appendChild(h('p.muted.small', 'The exact software versions the tool ran with – Galaxy records them for every job.'));
          const dt = h('table.table.small');
          dt.appendChild(h('tr', h('th', 'Dependency'), h('th', 'Dependency Type'), h('th', 'Version')));
          t.requirements.forEach(([n, v]) => dt.appendChild(h('tr', h('td', n), h('td', 'conda'), h('td', v))));
          C.appendChild(dt);
          C.appendChild(h('h4', 'Command Line'));
          C.appendChild(h('p.muted.small', 'Galaxy writes a script for every job. This is the command it ran in the job’s working directory.'));
          C.appendChild(h('pre.gx-cmd', job.command || ''));
          C.appendChild(h('h4', 'Tool Parameters'));
          const pt = h('table.table.small');
          pt.appendChild(h('tr', h('th', 'Input Parameter'), h('th', 'Value')));
          t.inputs.forEach((inp) => {
            const x = job.inputs.find((i) => i.name === inp.name);
            const src = x && this.ds(x.hid);
            pt.appendChild(h('tr', h('td', inp.label), h('td', src ? `${src.hid}: ${src.name}` : '')));
          });
          t.params.forEach((p) => pt.appendChild(h('tr', h('td', p.label), h('td', fmtParam(p, job.params[p.name])))));
          C.appendChild(pt);
          C.appendChild(h('h4', 'Tool Standard Error'));
          C.appendChild(h('pre.gx-pre.small', (job.stderr || '').trim() || '(empty)'));
        } else {
          C.appendChild(h('h4', 'Upload'));
          C.appendChild(h('p', `Uploaded from ${job.params.file} as ${job.params.file_type}.`));
        }
      }
      bus.emit('gx:details', { hid, tool: job && job.toolId });
    }

    /* ================= workflows ================= */
    showWorkflows() {
      const C = this._center('workflows');
      this.setNav('wf');
      C.appendChild(h('h3', 'Workflows'));
      C.appendChild(h('p.muted', 'A workflow is a saved graph of tools: each step’s inputs are connected to the outputs of earlier steps, so the whole analysis can be run again – on the same or on new data – with one click.'));
      if (this.workflows.length) {
        const t = h('table.table.gx-wft');
        t.appendChild(h('tr', h('th', 'Name'), h('th', 'Steps'), h('th', 'Updated'), h('th', '')));
        this.workflows.forEach((w, i) => {
          const b = (icon, label, fn, cls) => {
            const x = h('button.btn.small' + (cls || ''), { type: 'button', html: MG.icon(icon) + '<span>' + label + '</span>' });
            x.addEventListener('click', fn);
            return x;
          };
          t.appendChild(h('tr',
            h('td', h('b', w.name), h('div.muted.small', w.annotation || '')),
            h('td', String(w.steps.length)),
            h('td.small', w.updated ? new Date(w.updated).toLocaleString('en-GB') : ''),
            h('td.nowrap', b('pencil', 'Edit', () => this.showEditor(i)), ' ', b('play', 'Run', () => this.showRunForm(i), '.primary'), ' ', b('download', '.ga', () => this.exportGa(i)), ' ', b('save', 'to project', () => this.saveGa(i)), ' ', b('trash', '', () => this.deleteWorkflow(i)))));
        });
        C.appendChild(t);
      } else C.appendChild(h('p', h('i', 'You have no workflows yet.')));
      const nw = h('button.btn.primary', { type: 'button', html: MG.icon('plus') + '<span>Create a new workflow</span>' });
      nw.addEventListener('click', () => {
        const w = { id: uid(), name: 'Variant calling ' + (this.workflows.length + 1), annotation: '', steps: [], created: Date.now(), updated: Date.now() };
        this.workflows.push(w);
        this.save();
        this.showEditor(this.workflows.length - 1);
        bus.emit('gx:wfnew', { name: w.name });
      });
      const imp = h('button.btn', { type: 'button', html: MG.icon('upload') + '<span>Import a .ga file</span>' });
      imp.addEventListener('click', () => this.importGa());
      C.appendChild(h('div.gx-runrow', nw, ' ', imp));
      bus.emit('gx:workflows', {});
    }
    deleteWorkflow(i) {
      if (!window.confirm(`Delete the workflow “${this.workflows[i].name}”?`)) return;
      this.workflows.splice(i, 1);
      this.save();
      this.showWorkflows();
    }

    /* ---------- extract a workflow from the history ---------- */
    extractWorkflow() {
      const used = this.jobs.filter((j) => j.state === 'ok' && j.outputs.some((hid) => !this.ds(hid).deleted));
      if (!used.length) return toast('There are no finished tool jobs in this history yet – run some tools first.', 'warn');
      const w = { id: uid(), name: 'Workflow constructed from history ‘' + this.historyName + '’', annotation: 'Extracted from the history on ' + new Date().toLocaleString('en-GB'), steps: [], created: Date.now(), updated: Date.now() };
      const stepOfHid = {};
      const inputOf = (hid) => {
        if (stepOfHid[hid]) return stepOfHid[hid];
        const d = this.ds(hid);
        const st = { id: 's' + uid(), type: 'input', label: d.name.replace(/\.[^.]+$/, ''), ext: [d.ext], x: 0, y: 0 };
        w.steps.push(st);
        stepOfHid[hid] = { step: st.id, output: 'output' };
        return stepOfHid[hid];
      };
      used.sort((a, b) => a.id - b.id).forEach((j) => {
        const st = { id: 's' + uid(), type: 'tool', tool: j.toolId, params: Object.assign({}, j.params), connections: {}, x: 0, y: 0 };
        j.inputs.forEach((inp) => {
          const src = this.ds(inp.hid);
          st.connections[inp.name] = src && src.job && stepOfHid[inp.hid] ? stepOfHid[inp.hid] : inputOf(inp.hid);
        });
        w.steps.push(st);
        const t = TOOL.get(j.toolId);
        j.outputs.forEach((hid, k) => (stepOfHid[hid] = { step: st.id, output: t.outputs[k].name }));
      });
      autoLayout(w);
      this.workflows.push(w);
      this.save();
      toast('Workflow extracted from your history – it opens in the editor.');
      bus.emit('gx:extract', { steps: w.steps.length });
      this.showEditor(this.workflows.length - 1);
    }

    /* ---------- the editor ---------- */
    showEditor(i) {
      const w = this.workflows[i];
      const C = this._center('editor');
      this.root.classList.add('gx-editing');
      this.editing = w;
      this.editingIndex = i;
      this.setNav('wf');
      const nameIn = h('input.gx-wfname', { type: 'text', value: w.name, 'aria-label': 'Workflow name' });
      nameIn.addEventListener('input', () => {
        w.name = nameIn.value;
        this._touch();
      });
      const b = (icon, label, fn, cls) => {
        const x = h('button.btn.small' + (cls || ''), { type: 'button', html: (icon ? MG.icon(icon) : '') + '<span>' + label + '</span>' });
        x.addEventListener('click', fn);
        return x;
      };
      const addIn = b('plus', 'Input dataset', () => {
        const n = w.steps.filter((s) => s.type === 'input').length + 1;
        w.steps.push({ id: 's' + uid(), type: 'input', label: 'Input dataset ' + n, ext: ['fastqsanger'], x: 16, y: 16 + 96 * (n - 1) });
        this._touch();
        this.drawEditor();
        bus.emit('gx:addinput', {});
      });
      C.appendChild(h('div.gx-edbar', b('', '← Workflows', () => this.showWorkflows()), nameIn, h('span.grow'), addIn, b('', 'Tidy layout', () => {
        autoLayout(w);
        this.drawEditor();
      }), b('download', '.ga', () => this.exportGa(i)), b('play', 'Run', () => this.showRunForm(i), '.primary')));
      C.appendChild(h('p.muted.small.gx-edhint', { html: 'Add <b>Input dataset</b> boxes and click tools on the left to add steps. Drag from an <b>output</b> (dot on the right of a box) to an <b>input</b> (dot on the left) to connect them – only matching formats connect. Click a box to change its settings. Changes are saved as you go.' }));
      this.canvas = h('div.gx-canvas');
      // a click on the empty canvas deselects the step and shows the checks
      this.canvas.addEventListener('click', (e) => {
        if (!e.target.closest('.gx-node') && !e.target.closest('.gx-wire')) this.showStepSettings(null);
      });
      this.side = this.sideCol;
      this.side.innerHTML = '';
      C.appendChild(h('div.gx-edwrap', this.canvas));
      this.drawEditor();
      bus.emit('gx:editor', { name: w.name });
    }
    _touch() {
      if (this.editing) this.editing.updated = Date.now();
      this.save();
    }
    editorAddTool(id) {
      const w = this.editing;
      const t = TOOL.get(id);
      const maxX = Math.max(0, ...w.steps.map((s) => s.x || 0));
      const params = {};
      t.params.forEach((p) => (params[p.name] = p.default));
      const st = { id: 's' + uid(), type: 'tool', tool: id, params, connections: {}, x: Math.min(maxX + 220, 1100), y: 20 + (w.steps.length % 4) * 70 };
      w.steps.push(st);
      this._touch();
      this.drawEditor();
      this.showStepSettings(st);
      // a reminder for the first few steps only, so toasts do not pile up
      this._addedN = (this._addedN || 0) + 1;
      if (this._addedN <= 2) toast(`Added <b>${esc(t.name)}</b> – now connect its input${t.inputs.length > 1 ? 's' : ''}: drag from an output dot (right of a box) to an input dot (left).`, null, 4000);
      bus.emit('gx:added', { tool: id, steps: w.steps.length });
    }
    drawEditor() {
      const w = this.editing;
      const cv = this.canvas;
      cv.innerHTML = '';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'gx-wires');
      cv.appendChild(svg);
      if (!w.steps.length) cv.appendChild(h('div.gx-canvas-empty', h('p', { html: 'An empty workflow. Start with <b>+ Input dataset</b> (above), then click tools on the left.' })));
      w.steps.forEach((st) => {
        const t = st.type === 'tool' ? TOOL.get(st.tool) : null;
        const el = h('div.gx-node' + (st.type === 'input' ? '.input' : ''), { dataset: { id: st.id } });
        el.style.left = (st.x || 0) + 'px';
        el.style.top = (st.y || 0) + 'px';
        const title = h('div.gx-node-t', h('span', st.type === 'input' ? st.label : t.name));
        const del = h('button.gx-node-x', { type: 'button', title: 'Remove this step', 'aria-label': 'Remove this step', html: MG.icon('x') });
        del.addEventListener('pointerdown', (e) => e.stopPropagation());
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          w.steps = w.steps.filter((s) => s !== st);
          w.steps.forEach((s) => Object.keys(s.connections || {}).forEach((k) => s.connections[k] && s.connections[k].step === st.id && delete s.connections[k]));
          this._touch();
          this.drawEditor();
        });
        title.appendChild(del);
        el.appendChild(title);
        const ins = st.type === 'input' ? [] : t.inputs;
        const outs = st.type === 'input' ? [{ name: 'output', ext: st.ext, label: st.ext.join('/') }] : t.outputs.map((o) => ({ name: o.name, ext: [EXT_OF(o, st.params)], label: o.short || o.name }));
        const portsIn = h('div.gx-ports.in');
        ins.forEach((inp) => {
          const connected = !!(st.connections || {})[inp.name];
          portsIn.appendChild(h('div.gx-port.in' + (connected ? '.on' : ''), { dataset: { step: st.id, name: inp.name }, title: inp.label + ' – accepts ' + inp.ext.join(', ') }, h('i.dot'), h('span', inp.short || inp.name), h('small', inp.ext.join('/'))));
        });
        const portsOut = h('div.gx-ports.out');
        outs.forEach((o) => {
          const p = h('div.gx-port.out', { dataset: { step: st.id, name: o.name, ext: o.ext.join(',') }, title: 'produces ' + o.ext.join(', ') + ' – drag from the dot to an input' }, h('small', o.ext.join('/')), h('span', o.label), h('i.dot'));
          portsOut.appendChild(p);
          p.querySelector('.dot').addEventListener('pointerdown', (e) => this._startWire(e, st, o, svg));
        });
        el.append(portsIn, portsOut);
        this._draggable(el, st);
        el.addEventListener('click', () => this.showStepSettings(st));
        cv.appendChild(el);
      });
      const maxX = Math.max(640, ...w.steps.map((s) => (s.x || 0) + 230));
      const maxY = Math.max(380, ...w.steps.map((s) => (s.y || 0) + 170));
      cv.style.width = maxX + 'px';
      cv.style.height = maxY + 'px';
      svg.setAttribute('width', maxX);
      svg.setAttribute('height', maxY);
      requestAnimationFrame(() => this._drawWires(svg));
      this.showStepSettings(this._selStep && w.steps.includes(this._selStep) ? this._selStep : null);
    }
    _portPos(stepId, name, dir) {
      const el = this.canvas.querySelector(`.gx-port.${dir}[data-step="${stepId}"][data-name="${CSS.escape(name)}"] .dot`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const c = this.canvas.getBoundingClientRect();
      return { x: r.left - c.left + r.width / 2, y: r.top - c.top + r.height / 2 };
    }
    _drawWires(svg) {
      const w = this.editing;
      if (!w) return;
      Array.from(svg.querySelectorAll('path')).forEach((p) => p.remove());
      w.steps.forEach((st) => {
        Object.entries(st.connections || {}).forEach(([inName, c]) => {
          if (!c) return;
          const a = this._portPos(c.step, c.output, 'out');
          const b = this._portPos(st.id, inName, 'in');
          if (!a || !b) return;
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
          path.setAttribute('d', `M${a.x} ${a.y} C${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`);
          path.setAttribute('class', 'gx-wire');
          path.addEventListener('click', () => {
            delete st.connections[inName];
            this._touch();
            this.drawEditor();
          });
          const tt = document.createElementNS('http://www.w3.org/2000/svg', 'title');
          tt.textContent = 'Click to remove this connection';
          path.appendChild(tt);
          svg.appendChild(path);
        });
      });
    }
    _draggable(el, st) {
      let start = null;
      el.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.dot') || e.target.closest('button')) return;
        start = { x: e.clientX, y: e.clientY, sx: st.x || 0, sy: st.y || 0, moved: false };
        el.setPointerCapture(e.pointerId);
      });
      el.addEventListener('pointermove', (e) => {
        if (!start) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) start.moved = true;
        st.x = Math.max(0, start.sx + dx);
        st.y = Math.max(0, start.sy + dy);
        el.style.left = st.x + 'px';
        el.style.top = st.y + 'px';
        this._drawWires(this.canvas.querySelector('svg'));
      });
      el.addEventListener('pointerup', (e) => {
        if (start && start.moved) {
          e.stopPropagation();
          this._touch();
        }
        start = null;
      });
    }
    /** connect an output to an input (used by dragging, and by tests) */
    connect(fromStep, outName, toStep, inName) {
      const w = this.editing;
      const a = w.steps.find((s) => s.id === fromStep);
      const b = w.steps.find((s) => s.id === toStep);
      if (!a || !b || a === b || b.type !== 'tool') return false;
      const t = TOOL.get(b.tool);
      const inp = t.inputs.find((i) => i.name === inName);
      const outExt = a.type === 'input' ? a.ext : [EXT_OF(TOOL.get(a.tool).outputs.find((o) => o.name === outName), a.params)];
      if (!inp || !outExt.some((x) => inp.ext.includes(x))) {
        toast(`Can't connect: <b>${esc(t.name)}</b> needs <b>${esc(inp ? inp.ext.join(' or ') : '?')}</b>, but this output is <b>${esc(outExt.join(', '))}</b>.`, 'error', 6000);
        bus.emit('gx:badwire', { from: a.tool || 'input', to: b.tool, need: inp ? inp.ext.join(',') : '', got: outExt.join(',') });
        return false;
      }
      b.connections = b.connections || {};
      b.connections[inName] = { step: fromStep, output: outName };
      this._touch();
      this.drawEditor();
      bus.emit('gx:wire', { from: a.tool || 'input', to: b.tool, input: inName, n: countWires(w) });
      return true;
    }
    _startWire(e, st, out, svg) {
      e.preventDefault();
      e.stopPropagation();
      const c = this.canvas.getBoundingClientRect();
      const a = this._portPos(st.id, out.name, 'out');
      const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      tmp.setAttribute('class', 'gx-wire tmp');
      svg.appendChild(tmp);
      this.canvas.querySelectorAll('.gx-port.in').forEach((p) => {
        const step = this.editing.steps.find((s) => s.id === p.dataset.step);
        const t = step && TOOL.get(step.tool);
        const inp = t && t.inputs.find((i) => i.name === p.dataset.name);
        const ok = inp && out.ext.some((x) => inp.ext.includes(x)) && step.id !== st.id;
        p.classList.add(ok ? 'ok' : 'bad');
      });
      const move = (ev) => {
        const x = ev.clientX - c.left, y = ev.clientY - c.top;
        const dx = Math.max(40, Math.abs(x - a.x) / 2);
        tmp.setAttribute('d', `M${a.x} ${a.y} C${a.x + dx} ${a.y} ${x - dx} ${y} ${x} ${y}`);
      };
      const up = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        tmp.remove();
        this.canvas.querySelectorAll('.gx-port.in').forEach((p) => p.classList.remove('ok', 'bad'));
        const target = document.elementFromPoint(ev.clientX, ev.clientY);
        const port = target && target.closest('.gx-port.in');
        if (!port) return;
        this.connect(st.id, out.name, port.dataset.step, port.dataset.name);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    }
    showStepSettings(st) {
      this._selStep = st;
      if (st) bus.emit('gx:step', { tool: st.tool || 'input' });
      const S = this.side;
      if (!S || !this.canvas) return;
      S.innerHTML = '';
      this.canvas.querySelectorAll('.gx-node').forEach((n) => n.classList.toggle('sel', !!st && n.dataset.id === st.id));
      if (!st) {
        S.appendChild(h('div.gx-ph', 'Step settings'));
        S.appendChild(h('p.muted.small.gx-pad', 'Click a step in the workflow to see and change its settings.'));
        const probs = validateWorkflow(this.editing);
        S.appendChild(h('div.gx-ph', 'Checks'));
        S.appendChild(probs.length ? h('ul.gx-probs', ...probs.map((p) => h('li', p))) : h('p.okline.gx-pad', '✓ Every input is connected.'));
        return;
      }
      if (st.type === 'input') {
        S.appendChild(h('div.gx-ph', 'Input dataset'));
        const lab = h('input', { type: 'text', value: st.label });
        lab.addEventListener('input', () => {
          st.label = lab.value;
          const n = this.canvas.querySelector(`.gx-node[data-id="${st.id}"] .gx-node-t span`);
          if (n) n.textContent = st.label;
          this._touch();
        });
        const fmt = h('select');
        [['fastqsanger', 'fastqsanger (reads)'], ['fasta', 'fasta (reference sequence)'], ['bam', 'bam (alignments)'], ['vcf_bgzip', 'vcf_bgzip (variants)']].forEach(([v, l]) => fmt.appendChild(h('option', { value: v }, l)));
        fmt.value = st.ext[0];
        fmt.addEventListener('change', () => {
          st.ext = [fmt.value];
          this._touch();
          this.drawEditor();
          bus.emit('gx:inputformat', { ext: fmt.value });
        });
        S.append(h('div.gx-pad', field('Label', lab), field('Format', fmt)));
        return;
      }
      const t = TOOL.get(st.tool);
      S.appendChild(h('div.gx-ph', t.name));
      const box = h('div.gx-pad');
      box.appendChild(h('p.muted.small', t.desc + ' · version ' + t.version));
      t.params.forEach((p) => {
        const cur = st.params && p.name in st.params ? st.params[p.name] : p.default;
        const ctl = control(p, cur);
        ctl.addEventListener('change', () => {
          st.params = st.params || {};
          st.params[p.name] = readControl(p, ctl);
          this._touch();
          if (p.name === 'output_type') this.drawEditor();
          bus.emit('gx:param', { tool: st.tool, name: p.name, value: st.params[p.name] });
        });
        box.appendChild(field(p.label, ctl, null, p.help));
      });
      const missing = t.inputs.filter((i) => !(st.connections || {})[i.name]);
      if (missing.length) box.appendChild(h('p.warnline', `Not connected: ${missing.map((m) => m.short || m.name).join(', ')}`));
      S.appendChild(box);
    }

    /* ---------- .ga export / import ---------- */
    toGa(w) {
      const order = orderSteps(w);
      const idx = new Map(order.map((s, i) => [s.id, i]));
      const steps = {};
      order.forEach((s, i) => {
        if (s.type === 'input') {
          steps[i] = { annotation: '', content_id: null, errors: null, id: i, input_connections: {}, inputs: [{ description: '', name: s.label }], label: s.label, name: 'Input dataset', outputs: [], position: { left: s.x || 0, top: s.y || 0 }, tool_id: null, tool_state: JSON.stringify({ optional: false, format: s.ext, tag: null }), tool_version: null, type: 'data_input', uuid: uuid(), when: null, workflow_outputs: [] };
        } else {
          const t = TOOL.get(s.tool);
          const conns = {};
          Object.entries(s.connections || {}).forEach(([k, c]) => (conns[k] = { id: idx.get(c.step), output_name: c.output }));
          steps[i] = { annotation: '', content_id: t.toolId, errors: null, id: i, input_connections: conns, inputs: [], label: null, name: t.name, outputs: t.outputs.map((o) => ({ name: o.name, type: EXT_OF(o, s.params) })), position: { left: s.x || 0, top: s.y || 0 }, post_job_actions: {}, tool_id: t.toolId, tool_shed_repository: { changeset_revision: 'practice', name: t.toolId.split('/')[3], owner: t.toolId.split('/')[2], tool_shed: 'toolshed.g2.bx.psu.edu' }, tool_state: JSON.stringify(Object.assign({}, s.params, { __page__: null, __rerun_remap_job_id__: null })), tool_version: t.version, type: 'tool', uuid: uuid(), when: null, workflow_outputs: [] };
        }
      });
      return { a_galaxy_workflow: 'true', annotation: w.annotation || '', 'format-version': '0.1', name: w.name, steps, tags: [], uuid: uuid(), version: 1 };
    }
    exportGa(i) {
      const w = this.workflows[i];
      const ga = this.toGa(w);
      MG.downloadText(JSON.stringify(ga, null, 4), `Galaxy-Workflow-${w.name.replace(/[^A-Za-z0-9._-]+/g, '_')}.ga`, 'application/json');
      bus.emit('gx:export', { name: w.name, steps: w.steps.length });
    }
    /** keep the workflow with the pipeline: workflow/galaxy/NAME.ga in the project (or ~/galaxy) */
    saveGa(i) {
      const w = this.workflows[i];
      const text = JSON.stringify(this.toGa(w), null, 4);
      const proj = MG.app.PROJECT;
      const dir = this.fs.isDir(proj) ? proj + '/workflow/galaxy' : MG.app.HOME + '/galaxy';
      this.fs.mkdirp(dir);
      const path = `${dir}/${w.name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}.ga`;
      this.fs.writeText(path, text + '\n');
      toast(`Saved <b>${esc(this.fs.pretty(path))}</b> – open it in the Files tab.`, null, 5000);
      bus.emit('gx:export', { name: w.name, steps: w.steps.length, to: 'files', path });
    }
    importGa() {
      const inp = h('input', { type: 'file', accept: '.ga,.json' });
      inp.addEventListener('change', async () => {
        const f = inp.files[0];
        if (!f) return;
        try {
          const ga = JSON.parse(await f.text());
          const w = fromGa(ga);
          this.workflows.push(w);
          this.save();
          toast(`Imported <b>${esc(w.name)}</b>.`);
          this.showEditor(this.workflows.length - 1);
        } catch (e) {
          toast('This is not a workflow that this practice server can read: ' + esc(e.message), 'error', 7000);
        }
      });
      inp.click();
    }

    /* ---------- run a workflow ---------- */
    showRunForm(i) {
      const w = this.workflows[i];
      const C = this._center('runform');
      this.setNav('wf');
      const problems = validateWorkflow(w);
      C.appendChild(h('h3', 'Run workflow: ' + w.name));
      if (problems.length) {
        C.appendChild(h('div.callout.warn', h('div.co-t', 'This workflow is not ready to run'), h('ul', ...problems.map((p) => h('li', p)))));
        const ed = h('button.btn', { type: 'button', text: 'Open it in the editor' });
        ed.addEventListener('click', () => this.showEditor(i));
        C.appendChild(ed);
        bus.emit('gx:runblocked', { problems: problems.length });
        return;
      }
      const form = h('form.gx-form');
      const pickers = {};
      orderSteps(w).filter((s) => s.type === 'input').forEach((s) => {
        const sel = h('select');
        const cand = this.datasets.filter((d) => !d.deleted && d.state === 'ok' && s.ext.includes(d.ext));
        cand.slice().reverse().forEach((d) => sel.appendChild(h('option', { value: String(d.hid) }, `${d.hid}: ${d.name}`)));
        if (!cand.length) sel.appendChild(h('option', { value: '' }, `No ${s.ext.join('/')} dataset in the history`));
        const words = s.label.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 1);
        const guess = cand.find((d) => words.some((wd) => d.name.toLowerCase().includes(wd))) || (/(forward|_1|r1)/i.test(s.label) && cand.find((d) => /_1|R1/.test(d.name))) || (/(reverse|_2|r2)/i.test(s.label) && cand.find((d) => /_2|R2/.test(d.name)));
        if (guess) sel.value = String(guess.hid);
        pickers[s.id] = sel;
        form.appendChild(field(s.label, sel, s.ext.join(', ')));
      });
      const summary = h('ol.gx-steps');
      orderSteps(w).filter((s) => s.type === 'tool').forEach((s) => {
        const t = TOOL.get(s.tool);
        const ps = t.params.map((p) => `${p.short || p.label}: ${fmtParam(p, s.params && p.name in s.params ? s.params[p.name] : p.default)}`).join(' · ');
        summary.appendChild(h('li', h('b', t.name), ps ? h('span.muted.small', ' – ' + ps) : null));
      });
      form.appendChild(h('div.gx-field', h('label', 'Steps that will run'), summary));
      const run = h('button.btn.primary', { type: 'submit', html: MG.icon('play') + '<span>Run workflow</span>' });
      form.appendChild(h('div.gx-runrow', run));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const inputs = {};
        for (const [sid, sel] of Object.entries(pickers)) {
          if (!sel.value) return toast('Choose a dataset for every input.', 'warn');
          inputs[sid] = +sel.value;
        }
        this.invoke(w, inputs);
      });
      C.appendChild(form);
      bus.emit('gx:runform', { workflow: w.name });
    }
    invoke(w, inputs) {
      const inv = { id: this.invocations.length + 1, workflow: w.name, created: new Date(), items: [], state: 'scheduled' };
      this.invocations.push(inv);
      const produced = {};
      Object.entries(inputs).forEach(([sid, hid]) => (produced[sid] = { output: hid }));
      const steps = orderSteps(w).filter((s) => s.type === 'tool');
      steps.forEach((s) => {
        const t = TOOL.get(s.tool);
        const ins = t.inputs.map((inp) => {
          const c = s.connections[inp.name];
          return { name: inp.name, hid: produced[c.step] && produced[c.step][c.output] };
        });
        const params = {};
        t.params.forEach((p) => (params[p.name] = s.params && p.name in s.params ? s.params[p.name] : p.default));
        const { job } = this.submit(t.id, ins, params, { invocation: inv.id, step: s.id });
        produced[s.id] = {};
        t.outputs.forEach((o, k) => (produced[s.id][o.name] = job.outputs[k]));
        inv.items.push({ tool: t.name, job });
      });
      bus.emit('gx:invoked', { inv: inv.id, workflow: w.name, steps: steps.length });
      this.showInvocation(inv.id);
      const watch = setInterval(() => {
        const done = inv.items.filter((x) => x.job.state === 'ok' || x.job.state === 'error').length;
        if (done === inv.items.length) {
          clearInterval(watch);
          inv.state = inv.items.every((x) => x.job.state === 'ok') ? 'ok' : 'error';
          if (this.view === 'invocation' && this._invShown === inv.id) this.showInvocation(inv.id);
          bus.emit('gx:invocation', { inv: inv.id, ok: inv.state === 'ok', steps: inv.items.length, workflow: w.name });
        } else if (this.view === 'invocation' && this._invShown === inv.id) this._invStates(inv);
      }, 500);
    }
    showInvocations() {
      const C = this._center('invocations');
      this.setNav('inv');
      C.appendChild(h('h3', 'Workflow Invocations'));
      if (!this.invocations.length) return C.appendChild(h('p.muted', 'No workflow has been run yet.'));
      const t = h('table.table.small');
      t.appendChild(h('tr', h('th', '#'), h('th', 'Workflow'), h('th', 'Invoked'), h('th', 'State'), h('th', '')));
      this.invocations.slice().reverse().forEach((inv) => {
        const b = h('button.btn.small', { type: 'button' }, 'View');
        b.addEventListener('click', () => this.showInvocation(inv.id));
        t.appendChild(h('tr', h('td', String(inv.id)), h('td', inv.workflow), h('td', inv.created.toLocaleString('en-GB')), h('td', inv.state), h('td', b)));
      });
      C.appendChild(t);
    }
    showInvocation(id) {
      const inv = this.invocations.find((x) => x.id === id);
      const C = this._center('invocation');
      this._invShown = id;
      this.setNav('inv');
      C.appendChild(h('h3', { html: MG.icon('workflow') + ' Workflow invocation #' + inv.id }));
      C.appendChild(h('p', `“${inv.workflow}” – ${inv.items.length} jobs, invoked ${inv.created.toLocaleString('en-GB')}. The outputs appear in your history: grey (queued) → yellow (running) → green (done).`));
      const list = h('ol.gx-inv');
      inv.items.forEach((x) => {
        const st = h('span.gx-invstate.' + x.job.state, x.job.state);
        const li = h('li', h('b', x.tool), ' ', st);
        x.el = st;
        list.appendChild(li);
      });
      C.appendChild(list);
      if (inv.state === 'ok') C.appendChild(h('p.okline', '✓ All steps finished. Open the datasets in your history – the ⓘ of each one shows exactly how it was made.'));
      else if (inv.state === 'error') C.appendChild(h('p.warnline', 'Some steps failed – open the ⓘ of the red dataset to see why.'));
    }
    _invStates(inv) {
      inv.items.forEach((x) => {
        if (x.el) {
          x.el.textContent = x.job.state;
          x.el.className = 'gx-invstate ' + x.job.state;
        }
      });
    }
  }

  /* ================= helpers ================= */
  function control(p, cur) {
    let ctl;
    if (p.type === 'select') {
      ctl = h('select');
      p.options.forEach(([v, l]) => ctl.appendChild(h('option', { value: v }, l)));
      ctl.value = cur;
    } else if (p.type === 'bool') {
      ctl = h('input', { type: 'checkbox' });
      ctl.checked = !!cur;
    } else {
      ctl = h('input', { type: p.type === 'text' ? 'text' : 'number', step: p.type === 'float' ? 'any' : '1' });
      ctl.value = cur;
    }
    return ctl;
  }
  function readControl(p, c) {
    return p.type === 'bool' ? c.checked : p.type === 'int' ? parseInt(c.value, 10) : p.type === 'float' ? parseFloat(c.value) : c.value;
  }
  function fmtParam(p, v) {
    if (p.type === 'select') return (p.options.find((o) => o[0] === v) || [v, v])[1];
    if (p.type === 'bool') return v ? 'Yes' : 'No';
    return String(v);
  }
  function field(label, ctl, ext, help) {
    const f = h('div.gx-field');
    f.appendChild(h('label', label));
    f.appendChild(ctl);
    if (ext) f.appendChild(h('small.muted', 'Format: ' + ext));
    if (help) f.appendChild(h('small.gx-fhelp', help));
    return f;
  }
  function card(ic, title, text) {
    return h('div.gx-card', h('div.gx-card-t', { html: MG.icon(ic) + '<b>' + esc(title) + '</b>' }), h('p', text));
  }
  function tsvTable(text, vcf) {
    const L = text.split('\n').filter(Boolean);
    const meta = vcf ? L.filter((l) => l.startsWith('##')) : [];
    const rows = L.filter((l) => !l.startsWith('##'));
    const wrap = h('div.gx-tablewrap');
    if (meta.length) {
      const d = h('details');
      d.appendChild(h('summary', `${meta.length} header lines (##) – click to show`));
      d.appendChild(h('pre.gx-pre.small', meta.join('\n')));
      wrap.appendChild(d);
    }
    const t = h('table.table.small.mono');
    rows.slice(0, 300).forEach((r, i) => {
      const tr = h('tr');
      r.split('\t').forEach((c) => tr.appendChild(h(i === 0 && r.startsWith('#') ? 'th' : 'td', c.length > 60 ? c.slice(0, 57) + '…' : c)));
      t.appendChild(tr);
    });
    wrap.appendChild(h('div.ch-table-scroll', t));
    if (rows.length > 300) wrap.appendChild(h('p.muted.small', `Showing the first 300 of ${rows.length} lines.`));
    return wrap;
  }
  function orderSteps(w) {
    const done = new Set();
    const out = [];
    let guard = 0;
    while (out.length < w.steps.length && guard++ < 200) {
      w.steps.forEach((s) => {
        if (done.has(s.id)) return;
        const deps = Object.values(s.connections || {}).filter(Boolean).map((c) => c.step);
        if (deps.every((d) => done.has(d) || !w.steps.some((x) => x.id === d))) {
          done.add(s.id);
          out.push(s);
        }
      });
    }
    w.steps.forEach((s) => !done.has(s.id) && out.push(s));
    return out;
  }
  function countWires(w) {
    return w.steps.reduce((n, s) => n + Object.values(s.connections || {}).filter(Boolean).length, 0);
  }
  function validateWorkflow(w) {
    const probs = [];
    if (!w.steps.some((s) => s.type === 'input')) probs.push('It has no input dataset.');
    if (!w.steps.some((s) => s.type === 'tool')) probs.push('It has no tool steps.');
    w.steps.forEach((s) => {
      if (s.type !== 'tool') return;
      const t = TOOL.get(s.tool);
      t.inputs.forEach((i) => {
        const c = (s.connections || {})[i.name];
        if (!c) probs.push(`${t.name}: “${i.short || i.name}” is not connected.`);
        else if (!w.steps.find((x) => x.id === c.step)) probs.push(`${t.name}: “${i.short || i.name}” is connected to a step that was removed.`);
      });
    });
    return probs;
  }
  function autoLayout(w) {
    const depth = {};
    orderSteps(w).forEach((s) => {
      const deps = Object.values(s.connections || {}).filter(Boolean).map((c) => depth[c.step] || 0);
      depth[s.id] = deps.length ? Math.max(...deps) + 1 : 0;
    });
    const cols = {};
    w.steps.forEach((s) => {
      const d = depth[s.id] || 0;
      cols[d] = (cols[d] || 0) + 1;
      s.x = 16 + d * 222;
      s.y = 16 + (cols[d] - 1) * 118;
    });
  }
  function fromGa(ga) {
    if (!ga || ga.a_galaxy_workflow !== 'true' || !ga.steps) throw new Error('no a_galaxy_workflow / steps');
    const w = { id: uid(), name: ga.name || 'Imported workflow', annotation: ga.annotation || '', steps: [], created: Date.now(), updated: Date.now() };
    const ids = {};
    Object.values(ga.steps).forEach((s) => (ids[s.id] = 's' + uid()));
    Object.values(ga.steps).forEach((s) => {
      if (s.type === 'data_input') {
        let fmt = ['fastqsanger'];
        try {
          const st = JSON.parse(s.tool_state || '{}');
          if (st.format && st.format.length) fmt = st.format;
        } catch (e) {}
        w.steps.push({ id: ids[s.id], type: 'input', label: s.label || (s.inputs && s.inputs[0] && s.inputs[0].name) || 'Input dataset', ext: fmt, x: (s.position && s.position.left) || 0, y: (s.position && s.position.top) || 0 });
      } else if (s.type === 'tool') {
        const t = TOOLS.find((x) => x.toolId === s.tool_id || x.toolId.split('/').slice(0, -1).join('/') === String(s.tool_id).split('/').slice(0, -1).join('/'));
        if (!t) throw new Error(`the tool ${s.tool_id} is not installed on this server`);
        let params = {};
        try {
          params = JSON.parse(s.tool_state || '{}');
        } catch (e) {}
        const clean = {};
        t.params.forEach((p) => (clean[p.name] = p.name in params ? params[p.name] : p.default));
        const conns = {};
        Object.entries(s.input_connections || {}).forEach(([k, c]) => {
          const cc = Array.isArray(c) ? c[0] : c;
          conns[k] = { step: ids[cc.id], output: cc.output_name };
        });
        w.steps.push({ id: ids[s.id], type: 'tool', tool: t.id, params: clean, connections: conns, x: (s.position && s.position.left) || 0, y: (s.position && s.position.top) || 0 });
      }
    });
    return w;
  }

  MG.GalaxyApp = GalaxyApp;
  MG.galaxyUtil = { TOOLS, orderSteps, validateWorkflow, autoLayout, fromGa };
})();
