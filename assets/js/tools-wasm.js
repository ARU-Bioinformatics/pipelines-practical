/* Real, pinned biowasm programs. A single shared filesystem backs both interfaces.
 * Pipelines use byte-preserving temporary files (sequential, not POSIX processes).
 * Aioli's local execIO patch binds genuine file descriptors and reports exit status.
 */
(function () {
  'use strict';
  const MG = window.MG;
  const ROOT = '/shared/vfs', TMP = ROOT + '/tmp/.pipes';
  const CORE = ['cat','head','tail','wc','sort','uniq','cut','tr','tee','comm','join','paste','seq'];
  class FileRef { constructor(apath, binary=false) { this.apath=apath; this.binary=binary; } }
  MG.FileRef=FileRef;
  const W = {
    ready:false, loading:null, cli:null, pipeN:0, mountN:0,
    synced:new Map(), placed:new Map(), managed:new Set(),
    versions:{samtools:'1.17',bcftools:'1.10',htslib:'1.17',minimap2:'2.22',gawk:'5.1.0',grep:'3.7',sed:'4.8',coreutils:'8.32'},
    apath(abs) { return ROOT+abs; },
    ensure(status) {
      if(this.ready)return Promise.resolve(this.cli);
      if(this.loading)return this.loading;
      const base=new URL(MG.config.biowasmBase||'assets/vendor/biowasm',location.href).href.replace(/\/$/,'');
      this.loading=(async()=>{
        if(!window.Aioli)await loadScript(base+'/aioli.js');
        status?.('Starting the local WebAssembly filesystem…');
        const specs=[['samtools','1.17'],['bcftools','1.10'],['htslib','1.17','bgzip'],['htslib','1.17','tabix'],['minimap2','2.22'],['gawk','5.1.0'],['grep','3.7'],['sed','4.8'],...CORE.map(p=>['coreutils','8.32',p])];
        const tools=specs.map(([tool,version,program])=>({tool,version,program:program||tool,urlPrefix:`${base}/${tool}/${version}`,loading:'lazy',features:{}}));
        this.cli=await new window.Aioli(tools,{printInterleaved:false,urlCDN:base,debug:false});
        await mkdirp(this.cli,TMP); this.ready=true; MG.bus.emit('wasm:ready',{}); return this.cli;
      })().catch(e=>{this.loading=null;throw e;});
      return this.loading;
    },
    async readText(p){return (await this.ensure()).fs.readFile(p,{encoding:'utf8'});},
    async readBytes(p){return (await this.ensure()).fs.readFile(p);},
    async readTextSmart(p){return this.readText(p);},
    async stat(p){return stat(await this.ensure(),p);},
    async syncIn(fs,abs){
      const e=fs.entries.get(abs), cli=this.cli, dest=this.apath(abs);
      if(!e)return;
      if(e.kind==='dir'){await mkdirp(cli,dest);return;}
      await mkdirp(cli,MG.path.dirname(dest));
      if(e.kind==='virtual')throw MG.shellUtil.userErr('This lab requires actual file bytes; simulated files cannot be processed.');
      const prior=this.synced.get(abs);
      if(e.kind==='text'){
        if(prior!==e||e.dirty||!(await stat(cli,dest))){await cli.fs.writeFile(dest,e.text);e.dirty=false;}
      }else if(e.kind==='aioli'){
        if(e.apath!==dest){await cli.fs.writeFile(dest,await cli.fs.readFile(e.apath));e.apath=dest;}
      }else if(e.kind==='url'||e.kind==='blob'){
        if(prior!==e||!(await stat(cli,dest))){
          // Small teaching inputs are copied as real bytes, also supporting static hosts without Range.
          const bytes=await fs.readBytes(abs);await cli.fs.writeFile(dest,bytes);
        }
      }else throw MG.shellUtil.userErr(`Unsupported file entry: ${e.kind}`);
      this.synced.set(abs,e);this.managed.add(abs);
    },
    async syncAll(fs){
      // Copy aliases before removing old paths: cp/mv of BAM/BCF preserve their bytes.
      for(const [abs,e] of fs.entries)await this.syncIn(fs,abs);
      for(const abs of this.managed)if(!fs.entries.has(abs)){
        try{await this.cli.fs.unlink(this.apath(abs));}catch(e){}
        this.managed.delete(abs);this.synced.delete(abs);
      }
    },
    async snapshot(){
      const out=new Map(),cli=this.cli;
      async function walk(dir){for(const n of await readdir(cli,dir)){
        if(n==='.'||n==='..'||n==='.pipes')continue;
        const p=dir+'/'+n,s=await stat(cli,p);if(!s)continue;
        out.set(p,{...s,sig:s.size+':'+s.mtime});if(s.isDir)await walk(p);
      }}
      await walk(ROOT);return out;
    },
    async importChanges(fs,before){
      const after=await this.snapshot(),created=[];
      for(const [p,s] of after){
        const abs=p.slice(ROOT.length), old=before.get(p);
        if(s.isDir){if(!fs.exists(abs))fs.mkdirp(abs);continue;}
        if(old&&old.sig===s.sig)continue;
        fs.put(abs,{kind:'aioli',apath:p,size:s.size,fresh:true});
        this.synced.set(abs,fs.get(abs));this.managed.add(abs);created.push(abs);
      }
      for(const [p,s] of before)if(!s.isDir&&!after.has(p)){fs.remove(p.slice(ROOT.length));this.managed.delete(p.slice(ROOT.length));}
      return created;
    },
    /* one WebAssembly program at a time: the terminal, Snakemake and Galaxy share the tools */
    lock:Promise.resolve(),
    async run(ctx,program,args,opts={}){
      let release;const prev=this.lock;this.lock=new Promise(r=>(release=r));
      await prev;
      try{return await this._run(ctx,program,args,opts);}finally{release();}
    },
    async _run(ctx,program,args,opts={}){
      const start=performance.now(),fs=ctx.fs;
      const status=s=>{if(ctx.term?.statusEl)ctx.term.statusEl.textContent=s;};
      await this.ensure(status);await this.syncAll(fs);
      const cli=this.cli;let stdin=null;
      if(ctx.stdin instanceof FileRef)stdin=ctx.stdin.apath;
      else if(ctx.stdin!=null){
        if(typeof ctx.stdin!=='string')throw MG.shellUtil.userErr('Only real byte streams can enter a tool.');
        stdin=`${TMP}/i${++this.pipeN}`;await cli.fs.writeFile(stdin,ctx.stdin);
      }
      await this.cleanupPipes(fs,stdin);
      const pathToken=p=>p.startsWith(ROOT)||p.startsWith('/dev/')?p:(p.startsWith('/')?this.apath(MG.path.norm(p)):p);
      const a=args.map(v=>{
        // Preserve expressions; rewrite known absolute paths and absolute output destinations.
        if(v.startsWith('/')&&(fs.exists(v)||fs.isDir(MG.path.dirname(v))))return pathToken(v);
        const m=/^(--[^=]+=)(\/.*)$/.exec(v);return m?m[1]+pathToken(m[2]):v;
      });
      const stdoutPath=`${TMP}/o${++this.pipeN}`,stderrPath=`${TMP}/e${this.pipeN}`;
      if(ctx.mergeStderr)await cli.fs.writeFile(stdoutPath,'');
      const before=await this.snapshot();await cli.cd(this.apath(fs.cwd));
      status(`${program} is running locally…`);
      const timer=setInterval(()=>status(`${program} · ${((performance.now()-start)/1000).toFixed(0)} s`),1000);
      let result;
      try{result=await cli.execIO(program,a,{stdin,stdout:stdoutPath,stderr:ctx.mergeStderr?stdoutPath:stderrPath,merge:!!ctx.mergeStderr});}finally{clearInterval(timer);}
      const created=await this.importChanges(fs,before);
      const stderr=ctx.mergeStderr?'':await this.readText(stderrPath),outStat=await stat(cli,stdoutPath);
      // exit(-1) in C gives status 255 on Linux (bcftools' error() does this)
      const raw=result.code==null?(result.error?1:0):result.code,code=((raw%256)+256)%256;
      const stdout=opts.binaryOut?'':await this.readText(stdoutPath);
      for(const path of created)MG.bus.emit('vfs:created',{path,program,sub:args[0]});
      return {stdout,stderr:stderr+(result.error?`\n${result.error}\n`:''),stdoutPath,stdoutSize:outStat?.size||0,created,secs:(performance.now()-start)/1000,code,statusKnown:result.code!=null};
    },
    async gunzipText(ctx,file){const r=await this.run({...ctx,stdin:null},'bgzip',['-dc',file]);if(r.code)throw MG.shellUtil.userErr(r.stderr||'Decompression failed');return r.stdout;},
    async cleanupPipes(fs,keep){
      if(!this.ready)return;
      const refs=new Set(keep?[keep]:[]);for(const e of fs.entries.values())if(e.apath)refs.add(e.apath);
      for(const n of await readdir(this.cli,TMP)){const p=TMP+'/'+n;if(n!=='.'&&n!=='..'&&!refs.has(p))try{await this.cli.fs.unlink(p);}catch(e){}}
    }
  };
  async function stat(cli,p){try{const s=await cli.fs.lstat(p);return {size:s.size,mtime:+new Date(s.mtime),isDir:(s.mode&0o170000)===0o040000};}catch(e){return null;}}
  async function readdir(cli,p){try{return await cli.fs.readdir(p);}catch(e){return [];}}
  async function mkdirp(cli,p){let cur='';for(const part of p.split('/').filter(Boolean)){cur+='/'+part;if(!(await stat(cli,cur)))try{await cli.mkdir(cur);}catch(e){}}}
  function loadScript(src){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=()=>reject(new Error('Could not load '+src));document.head.appendChild(s);});}
  MG.wasm=W;
  function binaryOutput(program,a){
    if(program==='samtools')return ['sort','merge','markdup','fixmate','collate'].includes(a[0])&&!a.some(x=>x==='SAM'||x==='sam'||/^-OSAM$/i.test(x))||a[0]==='view'&&a.some(x=>/^-[A-Za-z]*[bu]/.test(x));
    if(program==='bcftools')return a.some((x,i)=>/^-[A-Za-z]*O[buz]/.test(x)||x==='-O'&&/^[buz]/.test(a[i+1]||'')||/^--output-type=[buz]/.test(x));
    return program==='bgzip'&&!a.some(x=>/^-\w*d/.test(x)||x==='--decompress');
  }
  async function runReal(ctx,program,opts={}){
    const binary=binaryOutput(program,ctx.args),r=await W.run(ctx,program,ctx.args,{...opts,binaryOut:binary});
    if(r.stderr)ctx.err(r.stderr.replace(/\/shared\/vfs/g,'').replace(/^\(null\):/gm,(ctx.name||program)+':'));
    if(ctx.redirectTarget){
      if(ctx.redirectTarget!=='/dev/null'){
        const target=ctx.fs.resolve(ctx.redirectTarget);let bytes=await W.readBytes(r.stdoutPath);
        if(ctx.redirectAppend&&ctx.fs.exists(target)){const old=await ctx.fs.readBytes(target),joined=new Uint8Array(old.length+bytes.length);joined.set(old);joined.set(bytes,old.length);bytes=joined;}
        const dest=W.apath(target);await mkdirp(W.cli,MG.path.dirname(dest));await W.cli.fs.writeFile(dest,bytes);
        ctx.fs.put(target,{kind:'aioli',apath:dest,size:bytes.length,fresh:true});W.synced.set(target,ctx.fs.get(target));W.managed.add(target);
        r.created.push(target);MG.bus.emit('vfs:created',{path:target,program,sub:ctx.args[0]});
      }
      ctx.wroteRedirect=true;
    }else if(ctx.isPipedOut)ctx.out(new FileRef(r.stdoutPath,binary));
    else if(binary&&r.stdoutSize)ctx.io.note(`Binary output: ${MG.humanSize(r.stdoutSize)} bytes. Save with > FILE, or inspect using samtools/bcftools view.`);
    else if(r.stdout)ctx.out(r.stdout);
    MG.bus.emit('tool:run',{program,sub:ctx.args[0]||'',args:ctx.args,code:r.code,secs:r.secs,created:r.created,real:true,line:ctx.rawLine,statusKnown:r.statusKnown});
    return r.code;
  }
  MG.runReal=runReal;
  const T=MG.shellTools=MG.shellTools||{};
  const definitions={
    minimap2:['2.22','Minimizer-based alignment; use -ax sr for short paired reads','minimap2 -ax sr data/raw/reference.fa data/raw/NA12878_R1.fastq data/raw/NA12878_R2.fastq > results/mapped/NA12878.sam'],
    samtools:['1.17','Inspect, sort, index and transform SAM/BAM/CRAM','samtools sort -o results/mapped/NA12878.sorted.bam results/mapped/NA12878.sam\nsamtools index results/mapped/NA12878.sorted.bam\nsamtools flagstat results/mapped/NA12878.sorted.bam'],
    bcftools:['1.10','Genotype likelihoods, calling models, normalization and VCF operations','bcftools mpileup -f data/raw/reference.fa results/mapped/NA12878.sorted.bam -Ou | bcftools call -mv -Oz -o results/variants/NA12878.raw.vcf.gz\nbcftools filter -i \'QUAL>=20 && INFO/DP>=5\' -Oz -o results/variants/NA12878.filtered.vcf.gz results/variants/NA12878.raw.vcf.gz\nbcftools view -H results/variants/NA12878.filtered.vcf.gz | head\nUse bcftools COMMAND --help for the options of a command.'],
    bgzip:['1.17','Block gzip compression / decompression','bgzip -c INPUT > OUTPUT.gz'],
    tabix:['1.17','Index and query sorted tabular BGZF data','tabix -p vcf results/variants/NA12878.filtered.vcf.gz']
  };
  for(const [name,[version,summary,man]] of Object.entries(definitions))T[name]={version,summary,man:`${name} ${version} · compiled program, executing locally\n\n${man}`,run:ctx=>{
    if(name==='samtools'&&ctx.args[0]==='tview')throw MG.shellUtil.userErr('samtools tview requires a terminal device; use samtools view or the results inspector.');
    return runReal(ctx,name);
  }};
  for(const name of ['awk','gawk','grep','egrep','sed',...CORE]){
    const program=name==='awk'?'gawk':name==='egrep'?'grep':name;
    T[name]={summary:'GNU '+name+' (real WebAssembly executable)',man:`GNU ${name}: use ${name} --help for its supported options. Shell constructs are documented in help.`,run:ctx=>runReal(name==='egrep'?{...ctx,args:['-E',...ctx.args]}:ctx,program)};
    delete MG.shellBuiltins[name];
  }
})();
