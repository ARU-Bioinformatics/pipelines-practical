/* Real, pinned programs compiled to WebAssembly (Biowasm builds; Bowtie 2, diff and cmp built for
 * this practical). One shared filesystem backs the terminal and the AI agent. Pipes use
 * byte-preserving temporary files (run one after another, not as concurrent processes).
 * Aioli's local execIO patch binds real file descriptors and reports each exit status.
 */
(function () {
  'use strict';
  const MG = window.MG;
  const ROOT = '/shared/vfs', TMP = ROOT + '/tmp/.pipes';
  // copies of files the AI agent could change (see keep): in the file system of the page, where no program looks
  const KEEP = '/keep';
  const TEXT_MAX = 262144;
  const CORE = ['cat','head','tail','wc','sort','uniq','cut','tr','tee','comm','join','paste','seq','fold','shuf','md5sum','date'];
  class FileRef { constructor(apath, binary=false) { this.apath=apath; this.binary=binary; } }
  // While a command of the AI agent runs, the shell's file system notes every path that is worked out through it
  // (terminal.js: watched). What is done here looks at all files, whatever the command names: it uses the file system itself.
  const real=fs=>(fs&&fs.__real)||fs;
  MG.FileRef=FileRef;
  /** The environment of a program, as NAME=value: the variables that the shell exports (export NAME, declare -x,
      NAME=value COMMAND, env NAME=value COMMAND) – awk's ENVIRON, jq's env and getenv() in every program see them,
      and LC_ALL=C means bytes to sort, grep, sed, wc and awk as it does on Linux. PWD and _ are there as bash sets
      them. Left out: TMPDIR when it names a folder outside the home folder (a program's own /tmp is not the /tmp of
      this terminal: sort would look for a folder that it cannot see). */
  function envOf(ctx,program,fs){
    const st=ctx.opts&&ctx.opts.st,vars=ctx.env||{},out=[],home=fs.home;
    const names=st&&st.exported?Array.from(st.exported):Object.keys(vars);
    let pwd=false;
    for(const k of names){
      let v=vars[k];
      // (a variable that a function declared local and gave no value: the program still gets the value from outside)
      if(v===undefined&&st&&st.locals&&st.locals.has(k))v=st.locals.get(k);
      if(typeof v!=='string'||k==='_'||!/^[A-Za-z_]\w*$/.test(k)||v.includes('\0'))continue;
      if(k==='TMPDIR'&&!(v===home||v.startsWith(home+'/')))continue;
      if(k==='PWD')pwd=true;
      // (cmp says "differ: byte 7" – and "char 7" where the language of the messages is C or POSIX; diff -c dates
      // its files "2024-03-05 12:34:56.000000000 +0000" – and "Tue Mar  5 12:34:56 2024" where the language of
      // times is C or POSIX. The C library of these builds takes C.UTF-8 for C in these respects, Linux's does
      // not: the two programs get the name of a language instead.)
      out.push(k+'='+((program==='cmp'||program==='diff')&&/^(LANG|LC_ALL|LC_MESSAGES|LC_TIME)$/.test(k)&&/^C\.utf-?8$/i.test(v)?'en_US.UTF-8':v));
    }
    if(!pwd&&(!st||!st.exported||st.exported.has('PWD')))out.push('PWD='+fs.cwd);
    if(ctx.shell&&ctx.shell.oldpwd&&(!st||!st.exported||st.exported.has('OLDPWD'))&&typeof vars.OLDPWD!=='string')out.push('OLDPWD='+ctx.shell.oldpwd);
    const name=String(ctx.name||program);
    if(!(st&&st.envEmptied))out.push('_='+(name.includes('/')?name:'/usr/bin/'+name));
    return out;
  }
  const W = {
    ready:false, loading:null, cli:null, pipeN:0, mountN:0,
    synced:new Map(), placed:new Map(), managed:new Set(), dirs:new Set(), gone:[],
    gen:0, kept:new Map(), keepN:0,
    versions:{fastp:'0.20.1',minimap2:'2.22',bowtie2:'2.4.2',samtools:'1.17',bcftools:'1.10',htslib:'1.17',seqtk:'1.4',bedtools:'2.31.0',jq:'1.7',gawk:'5.1.0',grep:'3.7',sed:'4.8',coreutils:'8.32',diffutils:'3.10'},
    apath(abs) { return ROOT+abs; },
    ensure(status) {
      if(this.ready)return Promise.resolve(this.cli);
      if(this.loading)return this.loading;
      const base=new URL(MG.config.biowasmBase||'assets/vendor/biowasm',location.href).href.replace(/\/$/,'');
      this.loading=(async()=>{
        if(!window.Aioli)await loadScript(base+'/aioli.js');
        status?.('Starting the local WebAssembly filesystem…');
        // 'base' holds the shared file system and never runs a program: a tool that aborts is replaced without losing the files
        const specs=[['base','1.0.0'],['samtools','1.17'],['bcftools','1.10'],['htslib','1.17','bgzip'],['htslib','1.17','tabix'],['minimap2','2.22'],['bowtie2','2.4.2','bowtie2-align-s'],['bowtie2','2.4.2','bowtie2-build-s'],['fastp','0.20.1'],['seqtk','1.4'],['bedtools','2.31.0'],['jq','1.7'],['gawk','5.1.0'],['grep','3.7'],['grep','3.11','grep-perl'],['sed','4.8'],['diffutils','3.10','diff'],['diffutils','3.10','cmp'],...CORE.map(p=>['coreutils','8.32',p])];
        const tools=specs.map(([tool,version,program])=>({tool,version,program:program||tool,urlPrefix:`${base}/${tool}/${version}`,loading:'lazy',features:{}}));
        this.cli=await new window.Aioli(tools,{printInterleaved:false,urlCDN:base,debug:false});
        await mkdirp(this.cli,TMP); await mkdirp(this.cli,KEEP); this.ready=true; MG.bus.emit('wasm:ready',{}); return this.cli;
      })().catch(e=>{this.loading=null;throw e;});
      return this.loading;
    },
    // (decoded here, not by the programs' file system: that one stops at the first NUL byte – find -print0 | sort -z)
    async readText(p){return new TextDecoder('utf-8',{ignoreBOM:true}).decode(await (await this.ensure()).fs.readFile(p));},
    async readBytes(p){return (await this.ensure()).fs.readFile(p);},
    /* how many bytes a file of the programs holds (what one program wrote for the next) */
    async sizeOf(p){const s=await stat(await this.ensure(),p);return s?s.size:0;},
    async readTextSmart(p){return this.readText(p);},
    async stat(p){return stat(await this.ensure(),p);},
    /* known: what is in the programs' file system (see snapshot) – asked once for all files, not once per file. */
    async syncIn(fs,abs,known){
      fs=real(fs);
      const e=fs.entries.get(abs), cli=this.cli, dest=this.apath(abs);
      if(!e)return;
      // (what is under ROOT, and no file of a pipe, is in the list – or is not there)
      const look=p=>known&&p.startsWith(ROOT+'/')&&!p.startsWith(TMP)?Promise.resolve(known.get(p)||null):stat(cli,p);
      const folder=async d=>{
        if(known&&(d===ROOT||(known.get(d)||{}).isDir))return;
        await mkdirp(cli,d);
        if(known)for(let q=d;q.length>ROOT.length;q=MG.path.dirname(q))known.set(q,{size:0,mtime:0,isDir:true,sig:''});
      };
      if(e.kind==='dir'){await folder(dest);this.dirs.add(abs);return;}
      await folder(MG.path.dirname(dest));
      // a folder of that name that is still there (it could not be removed) must not stop every later program
      const there=await look(dest);
      if(there&&there.isDir){await rmtree(cli,dest);if(known)known.delete(dest);}
      if(e.kind==='virtual')throw MG.shellUtil.userErr('This lab requires actual file bytes; simulated files cannot be processed.');
      const prior=this.synced.get(abs);
      // a read-only file is read-only for the programs too (they get "Permission denied")
      const locked=!!(e.readonly||e.protected);
      // (the file keeps the time of its last change: diff -u and diff -c print it. Last of all: in this file system
      // a change of the permissions sets the time, too)
      const stamp=async()=>{if(e.mtime)try{await cli.fs.utime(dest,e.mtime,e.mtime);}catch(x){}};
      const write=async data=>{if(await stat(cli,dest))await cli.fs.chmod(dest,0o644);await cli.fs.writeFile(dest,data);if(locked)await cli.fs.chmod(dest,0o444);await stamp();};
      if(e.kind==='text'){
        if(prior!==e||e.dirty||!(await look(dest))){await write(e.text);e.dirty=false;}
      }else if(e.kind==='aioli'){
        if(prior!==e||e.apath!==dest){
          if(!(await look(e.apath))){
            // its bytes are gone: a name without contents must not stay behind (every later program would stop)
            fs.entries.delete(abs);fs._changed(abs,'remove');this.synced.delete(abs);this.managed.delete(abs);this.gone.push(abs);return;
          }
          if(e.apath!==dest){await write(await cli.fs.readFile(e.apath));e.apath=dest;}
          else{await cli.fs.chmod(dest,locked?0o444:0o644);await stamp();}
        }
      }else if(e.kind==='url'||e.kind==='blob'){
        // the course data is copied in as real bytes
        if(prior!==e||!(await look(dest)))await write(await fs.readBytes(abs));
      }else throw MG.shellUtil.userErr(`Unsupported file entry: ${e.kind}`);
      this.synced.set(abs,e);this.managed.add(abs);
    },
    /* A file that was copied or moved (cp, mv) still has its bytes at the old place, until a program
       needs it. settle gives every such file its own bytes: all of them are read first, then written –
       so that it does not matter in which order they are, or what else is written to the old places.
       between() runs after the reading and before the writing. */
    async settle(fs,between){
      fs=real(fs);
      const cli=this.cli,moved=[];
      for(const [abs,e] of Array.from(fs.entries))if(e.kind==='aioli'&&e.apath!==this.apath(abs)){
        if(await stat(cli,e.apath))moved.push([abs,e,await cli.fs.readFile(e.apath)]);
        else{fs.entries.delete(abs);fs._changed(abs,'remove');this.gone.push(abs);}
      }
      if(between)await between();
      for(const [abs,e,bytes] of moved){
        if(fs.entries.get(abs)!==e)continue;
        const dest=this.apath(abs);
        await place(cli,dest,bytes);e.apath=dest;this.noteDirs(abs);
        if(e.readonly||e.protected)await cli.fs.chmod(dest,0o444);
        this.synced.set(abs,e);this.managed.add(abs);
      }
    },
    /** the folders above abs exist in the programs' file system: remember them (syncAll removes those the page no longer has) */
    noteDirs(abs){for(let d=MG.path.dirname(abs);d&&d!=='/';d=MG.path.dirname(d))this.dirs.add(d);},
    /* Make the programs' file system the same as the page's.
       1. Copied and moved files get their own bytes (settle).
       2. In between: files that are no longer there are removed – and folders too, deepest first.
          (Left there, a folder that was removed with rm -r would come back, empty, after the next
          program.) The programs first leave the folder they were in: a folder cannot be removed while
          it is somebody's working directory.
       3. Everything else is brought up to date. */
    async syncAll(fs){
      fs=real(fs);
      const cli=this.cli;
      await this.settle(fs,async()=>{
        await cli.cd(ROOT);
        for(const abs of Array.from(this.managed)){
          const e=fs.entries.get(abs);
          if(!e||e.kind==='dir'){
            try{await cli.fs.unlink(this.apath(abs));}catch(x){}
            this.managed.delete(abs);this.synced.delete(abs);
          }
        }
        for(const abs of Array.from(this.dirs).sort((a,b)=>b.length-a.length))if(!fs.isDir(abs)){
          try{await cli.fs.rmdir(this.apath(abs));}catch(x){}
          this.dirs.delete(abs);
        }
      });
      // (what is there now: one answer for the whole tree)
      const known=await this.snapshot();
      for(const [abs] of Array.from(fs.entries))await this.syncIn(fs,abs,known);
    },
    /* ---- for the AI agent: what it changes outside its own folder is put back (assistant.js) ----
       A file of kind 'aioli' has its bytes only here, in the programs' memory. Before a command of the
       agent runs, each such file outside the agent's folder is copied (once per run of the agent);
       putBack writes the copy back where a command changed or removed the file. */
    async keep(list){
      if(!this.ready)return 0;
      const cli=this.cli;let n=0;
      for(const [,e] of list){
        if(e.kind!=='aioli')continue;
        const had=this.kept.get(e);
        if(had&&had.gen===this.gen)continue;
        const s=await stat(cli,e.apath);
        if(!s||s.isDir)continue;
        const path=`${KEEP}/${++this.keepN}`;
        await cli.fs.writeFile(path,await cli.fs.readFile(e.apath));
        this.kept.set(e,{path,sig:s.size+':'+s.mtime,gen:this.gen});n++;
      }
      return n;
    },
    /** the entry e is at abs in the page's file system again: make sure its bytes are there too.
        since: when the command started (ms). → false: the bytes are lost */
    async putBack(abs,e,since){
      if(!this.ready)return false;
      const cli=this.cli,dest=this.apath(abs),now=await stat(cli,e.apath);
      let k=this.kept.get(e);if(k&&k.gen!==this.gen)k=null;
      // untouched: the file is as it was when the copy was made. (Without a copy: there, of the size the
      // entry records, and not written since the command started.)
      const same=!!now&&!now.isDir&&(k?now.size+':'+now.mtime===k.sig:now.size===e.size&&(!since||now.mtime<since));
      if(!same&&!k)return false;
      const moved=!same||e.apath!==dest;
      if(moved){await place(cli,dest,await cli.fs.readFile(same?e.apath:k.path));e.apath=dest;this.noteDirs(abs);}
      await cli.fs.chmod(dest,e.readonly||e.protected?0o444:0o644);
      // (the time of the file changes with chmod: the mark of "untouched" is taken afterwards)
      if(k){const s=await stat(cli,dest);k.sig=s.size+':'+s.mtime;}
      this.synced.set(abs,e);this.managed.add(abs);
      return true;
    },
    async dropKept(){
      const all=Array.from(this.kept.values());this.kept.clear();
      if(!this.ready)return;
      for(const k of all)if(k.gen===this.gen)try{await this.cli.fs.unlink(k.path);}catch(x){}
    },
    /* everything in the programs' file system (but the files of pipes): path → {size, mtime, isDir, sig}. The
       worker answers for the whole tree at once (statTree, a local addition to aioli.js): asked file by file,
       a folder of a thousand files made every program take a second longer. */
    async snapshot(){
      const out=new Map();
      for(const [p,size,mtime,isDir] of await this.cli.statTree(ROOT,'.pipes'))out.set(p,{size,mtime,isDir,sig:size+':'+mtime});
      return out;
    },
    /* A file that a program wrote joins the page's file system. A small text file (a table, a log,
       a JSON report, an edited script) becomes an ordinary text file: it can be edited and is saved
       with the student's work. Anything else (BAM, .gz, large files) stays in the programs' memory. */
    async adopt(fs,abs,apath,size,bytes,like){
      fs=real(fs);
      const there=fs.get(abs),was=there&&there.kind!=='dir'?there:(like||null),keep={};
      // (a file that took the place of a read-only one is read-only, too: sed -i gives the new file the old one's permissions.
      // like: the file that a program renamed to this name – it keeps its permissions under the new name, see importChanges)
      if(was&&was.kind!=='dir'){if(was.mode)keep.mode=was.mode;if(was.perm!=null)keep.perm=was.perm;if(was.readonly&&!was.protected)keep.readonly=true;}
      let text=null;
      if(size<=TEXT_MAX){
        try{
          if(!bytes)bytes=await this.cli.fs.readFile(apath);
          const t=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
          if(t.indexOf('\u0000')<0)text=t;
        }catch(e){text=null;}
      }
      // (its time is the time at which the program wrote it)
      const made=await stat(this.cli,apath);if(made&&made.mtime)keep.mtime=made.mtime;
      if(text!=null){fs.put(abs,Object.assign({kind:'text',text,fresh:true},keep));fs.get(abs).dirty=false;}
      else fs.put(abs,Object.assign({kind:'aioli',apath,size,fresh:true},keep));
      this.synced.set(abs,fs.get(abs));this.managed.add(abs);
    },
    /* what a program changed in the WebAssembly file system becomes part of the page's file system.
       A file of the course data that a program changed or removed is put back (the folder is not the student's).
       A read-only file of the student's own is another matter: the programs cannot write into it (it has mode 444
       in their file system: "Permission denied"), but a program may put a new file in its place or remove it
       – sed -i, gzip, bgzip do: that takes a folder one may write to, as on Linux.
       The inputs of an agent's run (~/runs/N-…/data/NAME: read-only copies of the course data) are such files:
       an agent can replace its own copies, and the script made from the run does the same – which is why the
       practical tests a script on a fresh copy of the course data. */
    async importChanges(fs,before){
      fs=real(fs);
      const after=await this.snapshot(),created=[];this.denied=[];
      const guarded=abs=>{const e=fs.get(abs);return !!e&&e.kind!=='aioli'&&e.kind!=='dir'&&!!e.protected;};
      // A file that a program renamed – sed -i.bak: FILE becomes FILE.bak, and a new FILE is written – keeps its
      // permissions under the new name, as on Linux. The programs' file system does not hold them (the page does), so
      // a renamed file is told by what a rename leaves as it was, its size and its time: a name that is new and has the
      // size and time that another file had before the program ran – a file that is gone now, or has changed. Where
      // several files had that size and time (three files written by one loop), the names decide: FILE.bak begins with
      // FILE, and a backup in a folder of its own (sed -i'bak/*') has the name of its file.
      const moved=new Map();
      for(const [p,s] of before){if(s.isDir)continue;const now=after.get(p);if(!now||now.isDir||now.sig!==s.sig){if(!moved.has(s.sig))moved.set(s.sig,[]);moved.get(s.sig).push(p.slice(ROOT.length));}}
      const last=x=>x.slice(x.lastIndexOf('/')+1);
      const renamedFrom=(old,s,abs)=>{
        const c=old?null:moved.get(s.sig);
        if(!c)return null;
        const from=c.filter(q=>abs.length>q.length&&abs.startsWith(q)).sort((a,b)=>b.length-a.length)[0]||c.find(q=>last(q)===last(abs))||(c.length===1?c[0]:null);
        const e=from?fs.get(from):null;
        return e&&e.kind!=='dir'&&!e.protected?e:null;
      };
      for(const [p,s] of after){
        const abs=p.slice(ROOT.length), old=before.get(p);
        if(s.isDir){
          this.dirs.add(abs);
          if(!fs.exists(abs))fs.mkdirp(abs);
          // (a program that made, renamed or removed a name in a folder – sed -i does all three – has changed the folder:
          // its time moves on, as on Linux; see _dirTouched in vfs.js)
          else if(old&&s.mtime>old.mtime){const d=fs.entries.get(abs);if(d&&d.kind==='dir'&&s.mtime>(d.mtime||0))d.mtime=s.mtime;}
          continue;
        }
        if(old&&old.sig===s.sig)continue;
        if(guarded(abs)){this.denied.push(abs);this.synced.delete(abs);continue;}
        await this.adopt(fs,abs,p,s.size,undefined,renamedFrom(old,s,abs));created.push(abs);
      }
      for(const [p,s] of before)if(!s.isDir&&!after.has(p)){
        const abs=p.slice(ROOT.length);
        if(guarded(abs)){this.denied.push(abs);this.synced.delete(abs);continue;}
        fs.remove(abs);this.managed.delete(abs);
      }
      return created;
    },
    /* Bytes that the shell has in hand (what a block printed: { samtools view -b …; } > x.bam, f | samtools …):
       writeBytes makes them a file of the page; tempBytes a file for the next command of a pipe to read. */
    async writeBytes(fs,abs,bytes){
      fs=real(fs);const cli=await this.ensure(),dest=this.apath(abs);
      // (a file that was copied or moved – cp, mv – may still have its bytes at this very place: see settle.
      // Each such file gets its own bytes before anything is written here.)
      await this.settle(fs);
      await mkdirp(cli,MG.path.dirname(dest));
      const there=await stat(cli,dest);
      if(there&&there.isDir)await rmtree(cli,dest);else if(there)await cli.fs.chmod(dest,0o644);
      await cli.fs.writeFile(dest,bytes);
      await this.adopt(fs,abs,dest,bytes.length,bytes);
      this.noteDirs(abs);
    },
    async tempBytes(bytes,binary){
      const cli=await this.ensure(),path=`${TMP}/i${++this.pipeN}`;
      await cli.fs.writeFile(path,bytes);
      return new FileRef(path,!!binary);
    },
    /* a file of a pipe that is still needed (the input of a block or a script that runs several programs) is not
       tidied away: see cleanupPipes */
    held:new Map(),
    hold(p){this.held.set(p,(this.held.get(p)||0)+1);},
    release(p){const n=(this.held.get(p)||0)-1;if(n>0)this.held.set(p,n);else this.held.delete(p);},
    /* one WebAssembly program at a time */
    lock:Promise.resolve(),
    async run(ctx,program,args,opts={}){
      let release;const prev=this.lock;this.lock=new Promise(r=>(release=r));
      await prev;
      try{return await this._run(ctx,program,args,opts);}finally{release();}
    },
    async _run(ctx,program,args,opts={}){
      const start=performance.now(),fs=real(ctx.fs);
      // … but the arguments that name a file or a folder that is there are paths the command uses: they are noted.
      // (A pattern or a program – /^#/d, /human_CYP2C19/ – names none. A file that the command makes is seen
      // afterwards, when the page looks at what has changed.)
      if(ctx.fs!==fs){
        const kinds=MG.shellLang&&MG.shellLang.argKinds?MG.shellLang.argKinds(ctx.name||program,args):[];
        args.forEach((v,i)=>{
          const m=/^--[^=]+=(.+)$/.exec(v),w=m?m[1]:v;
          if(kinds[i]!=='skip'&&w&&!w.startsWith('-')&&fs.exists(w))ctx.fs.resolve(w);
        });
      }
      const status=s=>{if(ctx.term?.statusEl)ctx.term.statusEl.textContent=s;};
      await this.ensure(status);this.gone=[];await this.syncAll(fs);
      const cli=this.cli;let stdin=null,inherit=null;
      if(ctx.stdin instanceof FileRef)stdin=ctx.stdin.apath;
      else if(ctx.stdin!=null){
        if(typeof ctx.stdin!=='string')throw MG.shellUtil.userErr('Only real byte streams can enter a tool.');
        stdin=`${TMP}/i${++this.pipeN}`;await cli.fs.writeFile(stdin,ctx.stdin);
      }else if(ctx.inherit&&ctx.inherit.pos<ctx.inherit.text.length){
        // No input of its own: the program stands in a block, a function or a script that has one
        // ({ head -n 1; sort; } < FILE,  f() { wc -l; }; f < FILE,  while read x; do PROGRAM; done < FILE).
        // It gets what is left of that input, and afterwards the page looks at how much of it the program read:
        // a program that does not read leaves it to the commands after it. From the start of a file the program
        // gets the file itself (byte for byte); otherwise the rest of the text.
        inherit=ctx.inherit;
        const own=inherit.pos===0?(inherit.apath||(inherit.path&&fs.exists(inherit.path)&&!fs.isDir(inherit.path)?this.apath(inherit.path):null)):null;
        if(own&&await stat(cli,own))stdin=own;
        else{stdin=`${TMP}/i${++this.pipeN}`;await cli.fs.writeFile(stdin,inherit.text.slice(inherit.pos));}
        inherit.size=((await stat(cli,stdin))||{}).size||0;
      }
      await this.cleanupPipes(fs,stdin);
      // Paths in the student's home are given to the programs as typed: each program has a link
      // /home/student -> the shared folder (see links below), and prints the names it was given.
      // Other absolute paths (/tmp/…) are in the shared folder under ROOT.
      const home=fs.home,inHome=p=>p===home||p.startsWith(home+'/');
      const pathToken=p=>p.startsWith(ROOT)||p.startsWith('/dev/')||inHome(p)?p:(p.startsWith('/')?this.apath(MG.path.norm(p)):p);
      // What is no path goes to the program as it was typed: a pattern (grep /tmp, awk '/chr1/'), a set of characters
      // (tr / _), a delimiter (cut -d /). Of the rest, absolute paths and absolute output destinations are rewritten.
      const kinds=MG.shellLang&&MG.shellLang.argKinds?MG.shellLang.argKinds(ctx.name||program,args):args.map(()=>'path');
      const stdoutPath=`${TMP}/o${++this.pipeN}`,stderrPath=`${TMP}/e${this.pipeN}`;
      // /dev/stdin, /dev/stdout and /dev/stderr as arguments (sort /dev/stdin, samtools sort -o /dev/stdout): the files
      // that are the program's input and output here. (In what the program prints they get their names back.)
      const dev={'/dev/stdin':()=>stdin||'/dev/null','/dev/fd/0':()=>stdin||'/dev/null','/dev/stdout':()=>stdoutPath,'/dev/fd/1':()=>stdoutPath,'/dev/stderr':()=>ctx.mergeStderr?stdoutPath:stderrPath,'/dev/fd/2':()=>ctx.mergeStderr?stdoutPath:stderrPath};
      const devUsed=new Map();
      // An operand that names nothing because of the way it is written – "FILE/", "nosuch/../x" (see VFS.forShell):
      // the programs' file system would take the dots and the slash away and find the file. So the program is given a
      // name in a folder that is not there (it can neither read nor make anything under it), and in what it prints the
      // name that was typed is put back (the same way as for /dev/stdin, see named below).
      let nowhere=0;const notDir=[];
      // (the shell is in a folder that was removed – a script after  rm -rf "$PWD" : the program cannot be started
      // there. An operand that names something that is there – ../a.txt – is handed over with its whole path.)
      const adrift=!fs.isDir(fs.cwd);
      const a=args.map((v,i)=>{
        if(kinds[i]==='skip')return v;
        if(adrift&&v&&!v.startsWith('-')&&!v.startsWith('/')&&v.includes('/')){const abs=ctx.fs.resolve(v);if(fs.entries.has(abs)){const full=pathToken(abs);devUsed.set(full,v);return full;}}
        if(v.includes('/')&&!v.startsWith('-')&&ctx.fs.pathError&&ctx.fs.pathError(v)){const fake=`.no-such-folder-${++nowhere}/x`;devUsed.set(fake,v);if(ctx.fs.pathError(v)==='Not a directory')notDir.push(v);return fake;}
        const d=/^(-[A-Za-z]|--[^=]+=)?(\/dev\/(?:stdin|stdout|stderr|fd\/[012]))$/.exec(v);
        if(d&&!(d[1]&&/^-[A-Za-z]$/.test(d[1])&&MG.shellLang&&MG.shellLang.optionSkips&&MG.shellLang.optionSkips(ctx.name||program,d[1]))){const real=dev[d[2]]();if(real!=='/dev/null')devUsed.set(real,d[2].replace('/dev/fd/0','/dev/stdin').replace('/dev/fd/1','/dev/stdout').replace('/dev/fd/2','/dev/stderr'));return (d[1]||'')+real;}
        if(v.startsWith('/')&&(fs.exists(v)||fs.isDir(MG.path.dirname(v))))return pathToken(v);
        // -o/tmp/x.bam, -f/tmp/patterns.txt: a path glued to its option (not the value of an option that takes a
        // pattern or a delimiter: -F/, -d/, -e/x/d)
        const o=/^(-[A-Za-z])(\/[^/]+\/.*)$/.exec(v);
        if(o&&!(MG.shellLang&&MG.shellLang.optionSkips&&MG.shellLang.optionSkips(ctx.name||program,o[1]))&&(fs.exists(o[2])||fs.isDir(MG.path.dirname(o[2]))))return o[1]+pathToken(o[2]);
        const m=/^(--[^=]+=)(\/.*)$/.exec(v);return m?m[1]+pathToken(m[2]):v;
      });
      if(ctx.mergeStderr)await cli.fs.writeFile(stdoutPath,'');
      // date -u, TZ=UTC date, TZ=America/New_York date: the clock of that zone (the programs take the time zone from the
      // browser, and no notice of TZ); and the short name of the time zone (BST), as date prints it on Linux.
      // The same for awk's strftime and mktime, and for the times of the files in the headers of diff -u and diff -c.
      let clock={};
      if(program==='date'||program==='gawk'||program==='diff'){
        const tz=ctx.env&&typeof ctx.env.TZ==='string'&&(!(ctx.opts&&ctx.opts.st&&ctx.opts.st.exported)||ctx.opts.st.exported.has('TZ'))?ctx.env.TZ:null;
        let zone=MG.time.zoneOf(ctx);
        if(program==='date'&&dateUTC(args))zone='UTC';
        if(tz&&!zone)ctx.io.note(`${ctx.name||program}: the time zone ${tz} (TZ) is not known in this browser – the time is that of this computer's zone`);
        clock={zoneName:true,zone:zone||null};
      }
      // sed in a block whose input is a file ({ sed 1q; cat; } < FILE): what sed did not use is left for the next command.
      // On Linux the C library puts the rest back when sed ends; here sed is handed its input a line at a time.
      const lines=program==='sed'&&!!inherit&&!inherit.pipe;
      // wc sets the width of its columns by what its input is: 7 for a pipe ("cat f | wc" →  "      3       3      17"),
      // the digits of the size for a file ("wc < f" → " 3  3 17"). Here a pipe is a file too – so wc is told. (bash
      // hands a here-document over as a pipe when it has 64 KiB at most, as a file when it has more.)
      const fifo=program==='wc'&&stdin!=null&&(ctx.stdin instanceof FileRef?(!ctx.stdin.fromFile||!!ctx.stdin.psub):ctx.stdin!=null?!(ctx.hereInput&&new Blob([ctx.stdin]).size>65536):!!(inherit&&inherit.pipe));
      const before=await this.snapshot();await cli.cd(this.apath(fs.isDir(fs.cwd)?fs.cwd:fs.home));
      status(`${program} is running locally…`);
      const timer=setInterval(()=>status(`${program} · ${((performance.now()-start)/1000).toFixed(0)} s`),1000);
      let result;
      const killed=new Promise((_,reject)=>{this._killed=reject;});
      this.running=program;
      try{result=await Promise.race([cli.execIO(program,a,{stdin,stdout:stdoutPath,stderr:ctx.mergeStderr?stdoutPath:stderrPath,merge:!!ctx.mergeStderr,links:[[this.apath(home),home]],lines,fifo,env:envOf(ctx,program,fs),...clock}),killed]);}
      catch(e){
        // not a forced stop (then there is nothing left to look at): the page's file system must still learn what was written.
        // No program is running any more: a forced stop that came now would end the worker under this very call.
        this._killed=null;this.running=null;
        if(this.ready&&this.cli===cli)try{await this.importChanges(fs,before);}catch(x){}
        throw e;
      }finally{clearInterval(timer);this._killed=null;this.running=null;}
      if(inherit){
        // how far the program read: in a file, where it left off (head -n 1 goes back behind the first line);
        // in what came through a pipe, the furthest byte it took
        const n=devUsed.has(stdin)?Infinity:inherit.pipe?Math.max(result.stdinMax||0,result.stdinPos||0):(result.stdinPos||0);
        if(n>0){
          // (n bytes of the file are so many characters of the text)
          const t=inherit.text;let k=inherit.pos,b=0;
          if(n>=inherit.size)k=t.length;
          else while(k<t.length&&b<n){const c=t.codePointAt(k);b+=c<0x80?1:c<0x800?2:c<0x10000?3:4;k+=c>0xffff?2:1;}
          inherit.pos=k;
        }
      }
      const created=await this.importChanges(fs,before);
      if(ctx.mergeStderr){
        // 2>&1: what the program wrote to stderr is in the output file – tidy it like stderr (see tidy)
        const st=await stat(cli,stdoutPath);
        if(st&&st.size&&st.size<=1048576)try{
          const t=new TextDecoder('utf-8',{fatal:true}).decode(await this.readBytes(stdoutPath)),t2=tidy(t,ctx.name||program);
          if(t2!==t)await cli.fs.writeFile(stdoutPath,t2);
        }catch(e){}
      }
      // (a file that stood for /dev/stdin … is called that again in what the program printed)
      // (… and of a name that asks for a folder where a file is – "a.txt/", "a.txt/../x" – the program is told, in
      // Linux's words, why it was not found)
      const named=t=>{for(const [real,name] of devUsed)t=t.split(real).join(name);if(notDir.length)t=t.split('\n').map(l=>notDir.some(v=>l.includes(v))?l.replace('No such file or directory','Not a directory'):l).join('\n');return t;};
      if(devUsed.size){
        const st=await stat(cli,stdoutPath);
        if(st&&st.size&&st.size<=1048576)try{
          const t=new TextDecoder('utf-8',{fatal:true}).decode(await this.readBytes(stdoutPath)),t2=named(t);
          if(t2!==t)await cli.fs.writeFile(stdoutPath,t2);
        }catch(e){}
      }
      const stderr=ctx.mergeStderr?'':named(await this.readText(stderrPath)),outStat=await stat(cli,stdoutPath);
      // exit(-1) in C gives status 255 on Linux (bcftools' error() does this)
      const raw=result.code==null?(result.error?1:0):result.code,code=((raw%256)+256)%256;
      const stdout=opts.binaryOut?'':tidy(await this.readText(stdoutPath),ctx.name||program);
      for(const path of created)MG.bus.emit('vfs:created',{path,program,sub:args[0]});
      // (how many changes were put back so far: the agent's run asks, see agentRun – the message may go to /dev/null)
      if(this.denied.length)this.deniedN=(this.deniedN||0)+this.denied.length;
      const undone=this.denied.map(abs=>`${program}: ${fs.pretty(abs)} is read-only (the course data): the change to it was undone\n`).join('');
      const gone=this.gone.map(abs=>`${fs.pretty(abs)}: the contents of this file were lost when the programs were stopped – make it again\n`).join('');this.gone=[];
      const failure=result.error?(/FS error/.test(result.error)?`${ctx.name||program}: stopped – it could not read or write a file. Check the file names in the command.`:result.error):'';
      // The two outputs in the order in which the program wrote to them (wc -l a nosuch b: the count of a, the
      // message, the count of b): the run reports that order, and where both go the same way – to the terminal, to
      // the file or the pipe of a block or a script – they are passed on in it (see runReal). parts: [1 or 2,
      // bytes] in turn; only when the list accounts for every byte of both files.
      let parts=null;const ord=result.order||[],tail=(failure?`\n${failure}\n`:'')+undone+gone;
      if(!ctx.mergeStderr&&!opts.binaryOut&&!devUsed.size&&ord.length>2){
        const ob=await this.readBytes(stdoutPath),eb=await this.readBytes(stderrPath);let no=0,ne=0;
        for(let k=0;k<ord.length;k+=2){if(ord[k]===1)no+=ord[k+1];else ne+=ord[k+1];}
        if(no===ob.length&&ne===eb.length){
          let oi=0,ei=0;parts=[];
          for(let k=0;k<ord.length;k+=2){
            const n=ord[k+1];
            if(ord[k]===1){parts.push([1,ob.subarray(oi,oi+n)]);oi+=n;}
            else{parts.push([2,eb.subarray(ei,ei+n)]);ei+=n;}
          }
        }
      }
      // how far the program read what was piped in (see "the reader left early" in runPipeline) – Infinity: it was
      // named as a file (cat - , sort /dev/stdin), and so read as one
      const stdinUsed=stdin&&!inherit?(devUsed.has(stdin)?Infinity:Math.max(result.stdinMax||0,result.stdinPos||0)):null;
      return {stdout,stderr:stderr+tail,parts,tail,stdoutPath,stdoutSize:outStat?.size||0,created,secs:(performance.now()-start)/1000,code:code||(undone?1:0),statusKnown:result.code!=null,stdinUsed};
    },
    /* A program that does not end blocks every later command. kill() stops the worker that runs the
       programs; the next command starts a new one. What programs had written lived in that worker's
       memory and is lost (returned as a list); the course data and text files are not. */
    kill(fs){
      fs=real(fs);
      const w=window.Aioli&&window.Aioli.lastWorker;
      if(!this.cli||!w)return [];
      const program=this.running;
      try{w.terminate();}catch(e){}
      window.Aioli.lastWorker=null;
      this.ready=false;this.loading=null;this.cli=null;this.synced.clear();this.placed.clear();this.managed.clear();this.dirs.clear();this.gen++;
      const lost=[];this.lostTimes=new Map();this.lostEntries=new Map();
      for(const [abs,e] of Array.from(fs.entries))if(e.kind==='aioli'){this.lostTimes.set(abs,e.mtime||0);this.lostEntries.set(abs,e);fs.entries.delete(abs);fs._changed(abs,'remove');lost.push(abs);}
      if(this._killed)this._killed(Object.assign(new Error('Killed'),{userMessage:`${program||'program'}: Killed`,code:137}));
      MG.bus.emit('wasm:killed',{program,lost:lost.length});
      return lost;
    },
    async gunzipText(ctx,file){const r=await this.run({...ctx,stdin:null,inherit:null},'bgzip',['-dc',file]);if(r.code)throw MG.shellUtil.userErr(r.stderr||'Decompression failed');return r.stdout;},
    async cleanupPipes(fs,keep){
      fs=real(fs);
      if(!this.ready)return;
      const refs=new Set(keep?[keep]:[]);for(const e of fs.entries.values())if(e.apath)refs.add(e.apath);for(const p of this.held.keys())refs.add(p);
      for(const n of await readdir(this.cli,TMP)){const p=TMP+'/'+n;if(n!=='.'&&n!=='..'&&!refs.has(p))try{await this.cli.fs.unlink(p);}catch(e){}}
    }
  };
  async function stat(cli,p){try{const s=await cli.fs.lstat(p);return {size:s.size,mtime:+new Date(s.mtime),isDir:(s.mode&0o170000)===0o040000};}catch(e){return null;}}
  async function readdir(cli,p){try{return await cli.fs.readdir(p);}catch(e){return [];}}
  async function mkdirp(cli,p){let cur='';for(const part of p.split('/').filter(Boolean)){cur+='/'+part;const s=await stat(cli,cur);if(s&&!s.isDir)try{await cli.fs.unlink(cur);}catch(e){}if(!s||!s.isDir)try{await cli.mkdir(cur);}catch(e){}}}
  /* write a file at dest, whatever is in the way: a folder of that name, a file where a folder should be */
  async function place(cli,dest,data){
    const parts=dest.split('/').filter(Boolean);let cur='';
    for(let i=0;i<parts.length-1;i++){
      cur+='/'+parts[i];const s=await stat(cli,cur);
      if(s&&!s.isDir)await cli.fs.unlink(cur);
      if(!s||!s.isDir)await cli.mkdir(cur); // Aioli's mkdir: FS.mkdir returns a node, which cannot be sent to the page
    }
    const s=await stat(cli,dest);
    if(s&&s.isDir)await rmtree(cli,dest);else if(s)await cli.fs.chmod(dest,0o644);
    await cli.fs.writeFile(dest,data);
  }
  async function rmtree(cli,p){
    for(const n of await readdir(cli,p)){
      if(n==='.'||n==='..')continue;
      const q=p+'/'+n,s=await stat(cli,q);
      if(s&&s.isDir)await rmtree(cli,q);else if(s)await cli.fs.unlink(q);
    }
    await cli.fs.rmdir(p);
  }
  function loadScript(src){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=()=>reject(new Error('Could not load '+src));document.head.appendChild(s);});}
  MG.wasm=W;
  /* date -u …: is the time asked for in UTC? (-u among the letters of an option – not in the value of -d or -I) */
  function dateUTC(args){
    for(let i=0;i<args.length;i++){
      const v=args[i];
      if(v==='--utc'||v==='--universal')return true;
      if(v==='--')break;
      if(!/^-[A-Za-z]/.test(v))continue;
      for(let j=1;j<v.length;j++){
        const c=v[j];
        if(c==='u')return true;
        if(c==='I')break;
        if('dfrs'.includes(c)){if(j===v.length-1)i++;break;}
      }
    }
    return false;
  }
  /* date -r FILE: the time of the last change of a file. The page knows it; the programs' copy of the file is newer. */
  function dateArgs(ctx){
    const a=ctx.args,out=[];
    for(let i=0;i<a.length;i++){
      const v=a[i],m=/^--reference=(.*)$/.exec(v),c=/^-([uR]*)r(.*)$/.exec(v);
      let f=null;
      if(m)f=m[1];
      else if(v==='--reference')f=a[++i];
      else if(c){if(c[1])out.push('-'+c[1]);f=c[2]!==''?c[2]:a[++i];}
      else{out.push(v);if(/^-[uR]*[dfs]$/.test(v)&&i+1<a.length)out.push(a[++i]);continue;}
      const e=f!=null?ctx.fs.get(f):null;
      if(!e)throw MG.shellUtil.userErr(`date: ${f==null?'option requires an argument -- \'r\'':f+': No such file or directory'}`);
      out.push('-d','@'+Math.floor((e.mtime||Date.now())/1000));
    }
    return out;
  }
  /* cat FILE >> FILE, cat A FILE > FILE: GNU cat does not read a file that it is itself writing to once something is
     in it ("input file is output file") – it names the file, leaves it out, and ends with status 1. (After > the file
     is empty at first: cat FILE > FILE reads nothing, and nothing is said.) */
  async function catRun(ctx){
    const out=ctx.redirectTarget?ctx.fs.resolve(ctx.redirectTarget):ctx.toCaller&&ctx.io.outFile?ctx.io.outFile.path:null;
    const e=out&&ctx.redirectTarget!=='/dev/null'?ctx.fs.get(out):null;
    if(!e||e.kind==='dir')return runReal(ctx,'cat');
    const fromIt=ctx.stdin instanceof FileRef&&ctx.stdin.fromFile&&ctx.stdin.apath===W.apath(out);
    const names=[];let opts=true;
    for(const a of ctx.args){if(opts&&a==='--')opts=false;else if(!(opts&&a.startsWith('-')&&a!=='-'))names.push(a);}
    if(!fromIt&&!names.some(a=>a!=='-'&&ctx.fs.resolve(a)===out))return runReal(ctx,'cat');
    // how much is in the output file when cat comes to each of its inputs: with >> what was there, with > what cat
    // itself has written by then
    const sizeOf=async a=>{
      if(a!=='-'){const f=ctx.fs.get(a);return f&&f.kind!=='dir'?ctx.fs.size(f):0;}
      const s=ctx.stdin;
      return s==null?(ctx.inherit?1:0):s instanceof FileRef?(await W.readBytes(s.apath)).length:String(s).length;
    };
    // (the file of a block – { echo start; cat FILE; } > FILE –: what the block has written into it so far counts)
    let written=ctx.redirectTarget?(ctx.redirectAppend?ctx.fs.size(e):0):ctx.fs.size(e);
    const args=[];let files=0,bad=0;opts=true;
    for(const a of ctx.args){
      if(opts&&a==='--'){opts=false;args.push(a);continue;}
      if(opts&&a.startsWith('-')&&a!=='-'){args.push(a);continue;}
      files++;
      const same=a==='-'?fromIt:ctx.fs.resolve(a)===out;
      if(same&&written>0){ctx.err(`cat: ${a}: input file is output file\n`);bad++;}
      else{args.push(a);if(!same)written+=await sizeOf(a);}
    }
    if(!files&&fromIt&&written>0){ctx.err('cat: -: input file is output file\n');return 1;}
    if(!bad)return runReal(ctx,'cat');
    if(bad===files)return 1;
    await withArgs(ctx,args,'cat');
    return 1;
  }
  /* tee /dev/stdout, tee /dev/stderr: one more copy of the input on the output (or among the messages). The page
     makes the copy: tee writes its input into a file of its own, too, and that file is printed once more. */
  async function teeRun(ctx){
    const isOut=a=>a==='/dev/stdout'||a==='/dev/fd/1',isErr=a=>a==='/dev/stderr'||a==='/dev/fd/2'||a==='/dev/tty';
    let opts=true,outs=0,errs=0;const args=[];
    for(const a of ctx.args){
      if(opts&&a==='--'){opts=false;args.push(a);}
      else if(opts&&a.startsWith('-')&&a!=='-')args.push(a);
      else if(isOut(a))outs++;
      else if(isErr(a))errs++;
      else args.push(a);
    }
    if(!outs&&!errs)return runReal(ctx,'tee');
    const copy=`${TMP}/t${++W.pipeN}`;
    const code=await withArgs(ctx,[...args,copy],'tee');
    let bytes;
    try{bytes=await W.readBytes(copy);}catch(e){return code;}
    try{await W.cli.fs.unlink(copy);}catch(e){}
    // (tee /dev/stdout > FILE: on Linux both copies are written to the same place in FILE – it holds the input once)
    if(!ctx.redirectTarget)for(let k=0;k<outs;k++)if(bytes.length)ctx.out(bytes);
    for(let k=0;k<errs;k++)if(bytes.length)ctx.err(MG.shellUtil.bytesText(bytes));
    return code;
  }
  function binaryOutput(program,a){
    if(program==='samtools')return ['sort','merge','markdup','fixmate','collate'].includes(a[0])&&!a.some(x=>x==='SAM'||x==='sam'||/^(-O|--output-fmt=)sam(,|$)/i.test(x))||a[0]==='view'&&a.some(x=>/^-[A-Za-z]*[bu]/.test(x))&&!a.some(x=>x==='-c'||x==='--count');
    if(program==='bcftools')return a.some((x,i)=>/^-[A-Za-z]*O[buz]/.test(x)||x==='-O'&&/^[buz]/.test(a[i+1]||'')||/^--output-type=[buz]/.test(x));
    return program==='bgzip'&&!a.some(x=>/^-\w*d/.test(x)||x==='--decompress');
  }
  /* Messages of the programs: paths as the student sees them, and the program's name where the
     WebAssembly build has none ("(null): cannot open …"). */
  function tidy(text,name){return text.replace(/\/shared\/vfs/g,'').replace(/^\(null\):/gm,name+':');}
  async function runReal(ctx,program,opts={}){
    // this build of jq does not know its own version number
    if(program==='jq'&&ctx.args.length===1&&(ctx.args[0]==='--version'||ctx.args[0]==='-V')){ctx.out('jq-'+W.versions.jq+'\n');return 0;}
    const binary=binaryOutput(program,ctx.args),r=await W.run(ctx,program,ctx.args,{...opts,binaryOut:binary});
    if(r.stdinUsed!=null)ctx.stdinUsed=r.stdinUsed;
    // Messages and output that go the same way – to the terminal, or to whoever takes the output of the block or
    // the script this command stands in – are passed on in the order in which the program wrote them. (To the
    // terminal as text; to a block's file or pipe the output goes as bytes, as it is.)
    const inTurn=!!r.parts&&!ctx.redirectTarget&&!!ctx.toCaller;
    // (> FILE 2>&1: the program's messages are in its output already; what the page adds – "… is read-only: the
    // change to it was undone" – follows them into the file)
    const tailBytes=ctx.mergeStderr&&ctx.redirectTarget&&r.tail?new TextEncoder().encode(tidy(r.tail,ctx.name||program).replace(/^\n/,'')):null;
    if(inTurn){
      const name=ctx.name||program,od=new TextDecoder('utf-8',{ignoreBOM:true}),ed=new TextDecoder('utf-8',{ignoreBOM:true});
      for(const [fd,bytes] of r.parts){
        if(!bytes.length)continue;
        if(fd===2)ctx.err(tidy(ed.decode(bytes,{stream:true}),name));
        else if(ctx.isPipedOut)ctx.out(bytes);
        else ctx.out(tidy(od.decode(bytes,{stream:true}),name));
      }
      if(r.tail)ctx.err(tidy(r.tail,name));
    }else if(r.stderr&&!tailBytes)ctx.err(tidy(r.stderr,ctx.name||program));
    if(inTurn){/* (passed on above) */}
    else if(ctx.redirectTarget){
      if(ctx.redirectTarget!=='/dev/null'){
        const target=ctx.fs.resolve(ctx.redirectTarget);let bytes=await W.readBytes(r.stdoutPath);
        if(tailBytes){const all=new Uint8Array(bytes.length+tailBytes.length);all.set(bytes);all.set(tailBytes,bytes.length);bytes=all;}
        // (The program printed nothing: the file stays as it was opened – made, or emptied, before the program ran –
        // or as the program itself wrote it by name:  samtools sort x.bam -o s.bam > s.bam 2>&1,  sort -o F a > F.)
        const nothing=!bytes.length&&ctx.fs.exists(target)&&!ctx.fs.isDir(target);
        if(!nothing){
        if(ctx.redirectAppend&&ctx.fs.exists(target)){const old=await ctx.fs.readBytes(target),joined=new Uint8Array(old.length+bytes.length);joined.set(old);joined.set(bytes,old.length);bytes=joined;}
        const dest=W.apath(target);await mkdirp(W.cli,MG.path.dirname(dest));await W.cli.fs.writeFile(dest,bytes);
        await W.adopt(ctx.fs,target,dest,bytes.length,bytes);
        }
        r.created.push(target);MG.bus.emit('vfs:created',{path:target,program,sub:ctx.args[0]});
      }
      ctx.wroteRedirect=true;
    }else if(ctx.isPipedOut)ctx.out(new FileRef(r.stdoutPath,binary));
    else if(binary&&r.stdoutSize){
      // (what the options promise is not always what was written: samtools view -b -c prints a count, and so text)
      let text=null;
      if(r.stdoutSize<=4194304)try{const t=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await W.readBytes(r.stdoutPath));if(t.indexOf('\u0000')<0)text=t;}catch(e){}
      if(text!=null)ctx.out(tidy(text,ctx.name||program));
      else ctx.io.note(`Binary output: ${MG.humanSize(r.stdoutSize)} bytes. Save with > FILE, or inspect using samtools/bcftools view.`);
    }
    // (… and the other way round: BAM where the options did not say so – samtools view --bam, -1 – is not text for the screen)
    else if(r.stdout&&r.stdout.slice(0,4096).indexOf('\u0000')>=0&&/^(samtools|bcftools|bgzip)$/.test(program))ctx.io.note(`Binary output: ${MG.humanSize(r.stdoutSize)} bytes. Save with > FILE, or inspect using samtools/bcftools view.`);
    else if(r.stdout)ctx.out(r.stdout);
    MG.bus.emit('tool:run',{program,sub:ctx.args[0]||'',args:ctx.args,code:r.code,secs:r.secs,created:r.created,real:true,line:ctx.rawLine,statusKnown:r.statusKnown});
    return r.code;
  }
  MG.runReal=runReal;
  /* A browser tab runs these programs on one thread. Asked for more, these builds stop (minimap2) or
     abort (samtools, bcftools), so the option is left out – and the terminal says so. */
  function oneThread(name,args,io){
    const sam=name==='samtools',bcf=name==='bcftools',mm=name==='minimap2',bgz=name==='bgzip';
    if(!sam&&!bcf&&!mm&&!bgz)return args;
    const out=[];let dropped='';
    for(let i=0;i<args.length;i++){
      const a=args[i];
      // (asked for what there is – minimap2 -t 1, samtools -@ 0, bgzip -@ 1: the option stays as it was written)
      const same=(v)=>mm?v==='1':bgz?v==='0'||v==='1':v==='0';
      if((((sam||bgz)&&a==='-@')||((sam||bcf||bgz)&&a==='--threads')||(mm&&a==='-t'))&&same(args[i+1])){out.push(a,args[++i]);continue;}
      if((((sam||bgz)&&/^-@\d+$/.test(a))&&same(a.slice(2)))||((sam||bcf||bgz)&&/^--threads=\d+$/.test(a)&&same(a.slice(10)))||(mm&&/^-t\d+$/.test(a)&&same(a.slice(2)))){out.push(a);continue;}
      if(((sam||bgz)&&a==='-@')||((sam||bcf||bgz)&&a==='--threads')||(mm&&a==='-t')){dropped=a+' '+(args[i+1]||'');i++;continue;}
      if(((sam||bgz)&&/^-@\d+$/.test(a))||((sam||bcf||bgz)&&/^--threads=\d+$/.test(a))||(mm&&/^-t\d+$/.test(a))){dropped=a;continue;}
      out.push(a);
    }
    if(dropped&&io&&io.note)io.note(`${name}: ${dropped.trim()} left out – in the browser every program runs on one thread.`);
    return out;
  }
  /* Run with other arguments on the same context object: the shell reads what a program did
     (a redirect already written, for one) from that object afterwards. */
  async function withArgs(ctx,args,program){
    const given=ctx.args;ctx.args=args;
    try{return await runReal(ctx,program);}finally{ctx.args=given;}
  }
  const T=MG.shellTools=MG.shellTools||{};
  // [program, version, summary, example] – the name typed in the terminal can differ from the program file
  const definitions={
    fastp:['fastp','0.20.1','Quality control, adapter and quality trimming of FASTQ files; writes an HTML and a JSON report','fastp -i data/NA12878_R1.fastq -I data/NA12878_R2.fastq -o trimmed_R1.fastq -O trimmed_R2.fastq -h fastp.html -j fastp.json\nopen fastp.html'],
    minimap2:['minimap2','2.22','Minimizer-based alignment; use -ax sr for short paired reads','minimap2 -ax sr data/reference.fa data/NA12878_R1.fastq data/NA12878_R2.fastq > mapped.sam'],
    bowtie2:['bowtie2-align-s','2.4.2','Bowtie 2 short-read aligner (needs an index from bowtie2-build)','bowtie2-build data/reference.fa reference\nbowtie2 -x reference -1 data/NA12878_R1.fastq -2 data/NA12878_R2.fastq -S mapped.sam'],
    'bowtie2-align-s':['bowtie2-align-s','2.4.2','Bowtie 2 aligner (the program behind the bowtie2 command)','bowtie2-align-s -x reference -1 data/NA12878_R1.fastq -2 data/NA12878_R2.fastq -S mapped.sam'],
    'bowtie2-build':['bowtie2-build-s','2.4.2','Builds a Bowtie 2 index from a FASTA file (six .bt2 files)','bowtie2-build data/reference.fa reference'],
    'bowtie2-build-s':['bowtie2-build-s','2.4.2','Builds a Bowtie 2 index (the program behind bowtie2-build)','bowtie2-build-s data/reference.fa reference'],
    samtools:['samtools','1.17','Inspect, sort, index and transform SAM/BAM/CRAM','samtools sort -o mapped.bam mapped.sam\nsamtools index mapped.bam\nsamtools flagstat mapped.bam'],
    bcftools:['bcftools','1.10','Genotype likelihoods, calling models, normalisation and VCF operations','bcftools mpileup -f data/reference.fa mapped.bam | bcftools call -mv -Oz -o calls.vcf.gz\nbcftools view -H calls.vcf.gz | head\nUse bcftools COMMAND --help for the options of a command.'],
    bgzip:['bgzip','1.17','Block gzip compression / decompression (BGZF files are valid gzip files)','bgzip -c INPUT > OUTPUT.gz'],
    tabix:['tabix','1.17','Index and query sorted tabular BGZF data','tabix -p vcf calls.vcf.gz'],
    seqtk:['seqtk','1.4','Toolkit for FASTA/FASTQ files: subsample, convert, trim, statistics','seqtk fqchk data/NA12878_R1.fastq | head\nseqtk sample -s 11 data/NA12878_R1.fastq 1000 > sample.fastq'],
    bedtools:['bedtools','2.31.0','Genome arithmetic on BED, VCF, SAM/BAM files','bedtools genomecov -ibam mapped.bam -bg | head'],
    jq:['jq','1.7','Command-line JSON processor','jq .summary fastp.json']
  };
  for(const [name,[program,version,summary,man]] of Object.entries(definitions))T[name]={version,summary,man:`${name} ${version} · compiled program, running in your browser\n\n${man}`,run:ctx=>{
    const here=(what,err)=>{if(MG.shellUtil.notHere)MG.shellUtil.notHere(what);return err;};
    // (tview draws on a terminal; with -d T or -d H it prints text or HTML and needs none)
    if(name==='samtools'&&ctx.args[0]==='tview'&&!ctx.args.some((x,i)=>/^-d[TH]$/.test(x)||(x==='-d'&&/^[TH]$/.test(ctx.args[i+1]||''))))throw here('samtools tview without -d',MG.shellUtil.userErr('samtools tview requires a terminal device; use samtools view instead – or samtools tview -d T -p CHR:POS FILE.bam REF.fa, which prints text.'));
    // samtools reheader -c CMD hands the header to another program – which a program cannot start here
    if(name==='samtools'&&ctx.args[0]==='reheader'&&ctx.args.some(x=>x==='-c'||x==='--command'||/^--command=/.test(x)))throw here('samtools reheader -c',MG.shellUtil.userErr("samtools reheader: -c (--command) runs another program on the header, and a program cannot start a program in this terminal. Do it in two steps:  samtools view -H in.bam | sed 's/old/new/' > header.sam  and then  samtools reheader header.sam in.bam > out.bam"));
    // bcftools +NAME loads a plugin from a shared library, which a WebAssembly program in a web page cannot do
    if(name==='bcftools'&&(/^\+/.test(ctx.args[0]||'')||(ctx.args[0]==='plugin'&&ctx.args.length>1&&ctx.args[1]!=='-l'&&ctx.args[1]!=='--list-plugins')))throw here('the plugins of bcftools',MG.shellUtil.userErr(`bcftools: plugins (${ctx.args[0]==='plugin'?'bcftools plugin NAME':ctx.args[0]}) are not available in this build. The built-in commands are: view, query, filter, norm, stats, annotate, call, mpileup, index, sort, concat, merge, isec, consensus, reheader.`));
    // bowtie2 and bowtie2-build are wrapper scripts around these programs; like them, say that a wrapper made the call
    if(name==='bowtie2'){
      // these options are carried out by the wrapper script itself (it reads the aligner's output), which is not here
      const w=ctx.args.find(a=>/^--(un|al)(-conc|-mates)?(-gz|-bz2|-lz4)?(=|$)/.test(a));
      if(w)throw here('bowtie2 '+w.split('=')[0],MG.shellUtil.userErr(`bowtie2: ${w.split('=')[0]} is not available here: it is done by bowtie2's wrapper script (perl), and this terminal runs the aligner itself. To get the reads that did not align:  samtools fastq -f 4 mapped.bam > unaligned.fastq`));
    }
    if(name==='bowtie2')return bowtie2Run(ctx,program);
    if(name==='bowtie2-build')return withArgs(ctx,['--wrapper','basic-0',...ctx.args],program);
    if(name==='samtools')seedNote(ctx);
    return withArgs(ctx,oneThread(name,ctx.args,ctx.io),program);
  }};
  /* bowtie2 is a wrapper script (perl) around the aligner, bowtie2-align-s. This terminal runs the aligner itself –
     and does here the two things of the wrapper that a script or a person meets:
     - before anything else it looks for the index (-x NAME: any file NAME*.bt2 or NAME*.bt2l, also below
       $BOWTIE2_INDEXES): if there is none it says so in its own words and ends with status 255;
     - when the aligner fails, it adds its line "(ERR): bowtie2-align exited with value N" and ends with N. */
  async function bowtie2Run(ctx,program){
    const a=ctx.args,xi=a.indexOf('-x');
    if(xi>=0&&a[xi+1]!=null){
      const fs=ctx.fs,there=base=>{
        const abs=fs.resolve(base),dir=/\/$/.test(base)?abs:MG.path.dirname(abs),stem=/\/$/.test(base)?'':abs.slice(dir.length).replace(/^\//,'');
        return fs.isDir(dir)&&fs.list(dir).some(c=>c.entry.kind!=='dir'&&c.name.startsWith(stem)&&/\.bt2l?$/.test(c.name.slice(stem.length)));
      };
      const env=(ctx.env&&ctx.env.BOWTIE2_INDEXES)||'';
      if(!there(a[xi+1])&&!(env&&there(env.replace(/\/+$/,'')+'/'+a[xi+1]))){
        ctx.err(`(ERR): "${env?env+'/':''}${a[xi+1]}" does not exist or is not a Bowtie 2 index\nExiting now ...\n`);
        return 255;
      }
    }
    const code=await withArgs(ctx,['--wrapper','basic-0',...a],program);
    if(code)ctx.err(`(ERR): bowtie2-align exited with value ${code}\n`);
    return code;
  }
  /* samtools view -s SEED.FRACTION (and --subsample-seed): samtools turns the seed into a pseudo-random number with
     the C library's rand(), and the C library of these WebAssembly programs (musl) gives other numbers than the
     one on Linux (glibc). So with a seed other than 0 the same command keeps other reads on Linux – about as many,
     not the same. With seed 0 samtools does not call rand(): -s 0.25 gives the same reads everywhere. */
  function seedNote(ctx){
    const a=ctx.args;
    if(a[0]!=='view'||!ctx.io||!ctx.io.note)return;
    let seed=null;
    for(let i=1;i<a.length;i++){
      let m;
      if(a[i]==='-s'&&(m=/^(\d+)\.\d+$/.exec(a[i+1]||'')))seed=m[1];
      else if((m=/^-s(\d+)\.\d+$/.exec(a[i])))seed=m[1];
      else if(a[i]==='--subsample-seed'&&/^\d+$/.test(a[i+1]||''))seed=a[i+1];
      else if((m=/^--subsample-seed=(\d+)$/.exec(a[i])))seed=m[1];
    }
    if(seed!=null&&+seed!==0)ctx.io.note(`samtools view: with the seed ${seed} this program keeps other reads than samtools on Linux does (about as many, but not the same ones): samtools feeds the seed through the C library's random numbers, and the library of this terminal's programs is another one. With seed 0 (-s 0.25, or --subsample 0.25 alone) the reads are the same everywhere; so are those of seqtk sample -s.`);
  }
  /* gzip, gunzip, zcat: bgzip does the work (what it writes, BGZF, is a valid gzip file). gzip takes any number of
     files, bgzip one: each file is done by itself –  gzip a.txt b.txt  makes two .gz files,  zcat x.gz y.gz  prints
     both, one after the other. */
  const gzLong={'--recursive':'r','--stdout':'c','--to-stdout':'c','--decompress':'d','--uncompress':'d','--keep':'k','--force':'f','--best':'9','--fast':'1','--quiet':'q','--verbose':'v','--test':'t','--no-name':'n','--name':'N'};
  async function gzRun(ctx,name){
    const u=MG.shellUtil;
    let toStdout=name==='zcat'||name==='gzcat',decompress=name!=='gzip',keep=false,force=false,test=false,level=null,noMore=false,quiet=false,recursive=false;
    const files=[];
    for(const a of ctx.args){
      if(noMore||a==='-'||!a.startsWith('-')){files.push(a);continue;}
      if(a==='--'){noMore=true;continue;}
      if(a==='--help'||a==='--version'){ctx.out(`${name}: ${name==='gzip'?'compress':'decompress'} gzip files – in this terminal bgzip ${W.versions.htslib} does the work.\nUsage: ${name} [-c] [-d] [-k] [-f] [-r] [-t] [-q] [-1 … -9] [FILE …]\n`);return 0;}
      const letters=a.startsWith('--')?(gzLong[a]||''):a.slice(1);
      if(!letters)throw u.userErr(`${name}: unrecognized option '${a}'\nTry \`${name} --help' for more information.`);
      for(const c of letters){
        if(c==='c')toStdout=true;else if(c==='d')decompress=true;else if(c==='k')keep=true;else if(c==='f')force=true;else if(c==='t')test=true;
        else if(/[1-9]/.test(c))level=c;else if(c==='q')quiet=true;else if(c==='r')recursive=true;else if('vnN'.includes(c))continue;
        else if(c==='l'||c==='S')throw u.userErr(`${name}: -${c} is not available in this terminal (the work is done by bgzip). The size of what is in a .gz file:  zcat FILE.gz | wc -c`);
        else throw u.userErr(`${name}: invalid option -- '${c}'\nTry \`${name} --help' for more information.`);
      }
    }
    // (gzip -t looks at compressed files, as gzip -d does: NAME stands for NAME.gz where there is no NAME)
    if(test)decompress=true;
    // -r: a folder stands for every file in it and below it (and gzip then says nothing about the files it leaves alone)
    if(recursive){
      const all=[];
      for(const f of files){
        if(f==='-'||f===''||!ctx.fs.isDir(f)){all.push(f);continue;}
        const abs=ctx.fs.resolve(f),pre=abs==='/'?'/':abs+'/',lead=f.endsWith('/')?f:f+'/';
        all.push(...Array.from(real(ctx.fs).entries).filter(([k,e])=>k.startsWith(pre)&&e.kind!=='dir').map(([k])=>lead+k.slice(pre.length)).sort());
      }
      // (folders without a file in them: there is nothing to do – and nothing is read from the input)
      if(files.length&&!all.length)return 0;
      files.length=0;files.push(...all);
    }
    const one=f=>[...(test?['-t']:[]),...(decompress&&!test?['-d']:[]),...(toStdout&&!test?['-c']:[]),...(keep?['-k']:[]),...(force&&!toStdout?['-f']:[]),...(level&&!decompress?['-l',level]:[]),...(f==null||f==='-'?[]:[f])];
    // zcat -f, gunzip -cf: a file that is not compressed is given as it is
    const plain=async f=>{
      if(!(force&&decompress&&toStdout)||f==null||f==='-'||!ctx.fs.exists(f)||ctx.fs.isDir(f))return null;
      const bytes=await ctx.fs.readBytes(f);
      return bytes.length>=2&&bytes[0]===0x1f&&bytes[1]===0x8b?null:bytes;
    };
    // The suffixes that gzip knows (in any case of the letters): a file that has one is compressed already – gzip leaves
    // it alone –, and only a file that has one is decompressed (.tgz and .taz give .tar, the others are cut off).
    const sfx=f=>{const b=String(f).split('/').pop(),m=/(\.gz|\.tgz|\.taz|\.z|-gz|-z|_z)$/i.exec(b);return m&&m[1].length<b.length?m[1]:null;};
    const result=f=>{const s=sfx(f);return f.slice(0,f.length-s.length)+(/^\.t[ag]z$/i.test(s)?'.tar':'');};
    // What gzip refuses before it reads anything, in gzip's words and with its statuses (1: an error, 2: a warning;
    // an error counts more): a folder ("-- ignored" – bgzip would make DIR.gz), a file that is not there, a file that
    // has the suffix already (gzip *  in a folder where some files are compressed: bgzip would compress them again), a
    // file without the suffix that is to be decompressed, and a result that is there already.
    const refused=f=>{
      if(f==null||f==='-')return null;
      const e=f===''?null:ctx.fs.get(f),s=sfx(f);
      if(!e&&!(decompress&&!s&&f!==''&&ctx.fs.exists(f+'.gz')))return [`gzip: ${decompress&&!s?f+'.gz':f}: ${(ctx.fs.pathError&&ctx.fs.pathError(f))||'No such file or directory'}\n`,1];
      if(e&&e.kind==='dir')return [quiet?'':`gzip: ${f} is a directory -- ignored\n`,2];
      // (gzip -rt: of what is in a folder only the files with the suffix are looked at)
      if(e&&recursive&&test&&!s)return ['',0];
      if(!e||toStdout||test)return null;
      if(!decompress){
        if(s&&!force)return [quiet||recursive?'':`gzip: ${f} already has ${s} suffix -- unchanged\n`,0];
        if(!force&&ctx.fs.exists(f+'.gz'))return [`gzip: ${f}.gz already exists;\tnot overwritten\n`,2];
        return null;
      }
      if(!s)return [quiet||recursive?'':`gzip: ${f}: unknown suffix -- ignored\n`,quiet||recursive?0:2];
      if(!force&&ctx.fs.exists(result(f)))return [`gzip: ${result(f)} already exists;\tnot overwritten\n`,2,'result'];
      return null;
    };
    // How a file that is to be unpacked begins: 'short' – it ends before its second byte –, 'other' – not as a
    // compressed file does (gzip, and the older formats that gzip reads) –, or null.
    const begins=async f=>{
      if(f==null||f==='-'||f==='')return null;
      const n=ctx.fs.exists(f)?f:f+'.gz';
      if(!ctx.fs.exists(n)||ctx.fs.isDir(n))return null;
      const b=await ctx.fs.readBytes(n);
      if(b.length<2)return ['short',n];
      const two=(b[0]<<8)|b[1];
      return two===0x1f8b||two===0x1f9e||two===0x1f1e||two===0x1f9d||two===0x1fa0||two===0x504b?null:['other',n];
    };
    let said=0;
    const count=c=>{if(c===1||said===1)said=1;else if(c)said=Math.max(said,c);};
    // gzip gives the file it makes the permissions and the time of the file it was made from: a script is still
    // executable after gzip and gunzip, and "is the .gz older than the file?" (make-like checks) is answered as on Linux
    const carry=(src,name)=>{
      const fs=real(ctx.fs),abs=ctx.fs.resolve(name),out=fs.entries.get(abs);
      if(!src||!out||out.kind==='dir'||out===src)return;
      const n=Object.assign({},out);
      if(src.mode)n.mode=src.mode;else delete n.mode;
      if(src.perm!=null)n.perm=src.perm;else delete n.perm;
      // (a read-only file of one's own gives a read-only .gz, and the other way round; the course data's protection is not handed on)
      if(src.readonly&&!src.protected)n.readonly=true;else delete n.readonly;
      if(src.mtime)n.mtime=src.mtime;
      fs.entries.set(abs,n);
    };
    if(files.length&&(!toStdout||test)){
      // each file is replaced by its .gz (or the .gz by the file) – one after the other, each looked at when its turn comes
      for(let f of files){
        const r=refused(f);
        // gzip looks into a file before it looks at the name of the result. A file that ends before its second byte
        // ends gzip itself ("unexpected end of file", status 1: the files after it are not looked at); one that does
        // not begin as a compressed file is an error (status 1) – whether or not the result is there already.
        if(decompress&&!test&&(!r||r[2]==='result')){
          const g=await begins(f);
          if(g&&g[0]==='short'){ctx.err(`\ngzip: ${g[1]}: unexpected end of file\n`);return 1;}
          if(g){ctx.err(`\ngzip: ${g[1]}: not in gzip format\n`);count(1);continue;}
        }
        if(r){if(r[0])ctx.err(r[0]);count(r[1]);continue;}
        // (gunzip NAME: NAME.gz is meant where there is no NAME)
        if(f!=='-'&&decompress&&!ctx.fs.exists(f))f+='.gz';
        if(f!=='-'&&decompress&&!test&&!/\.gz$/.test(f)){
          // a suffix that bgzip does not know (.tgz, .GZ, .z, -gz …): its output is written under the name gzip gives the result
          const run=await W.run({...ctx,redirectTarget:null,mergeStderr:false},'bgzip',['-dc',f],{binaryOut:true});
          if(run.stderr)ctx.err(tidy(run.stderr,name));
          if(run.code){count(1);continue;}
          const from=ctx.fs.get(f);
          await W.writeBytes(ctx.fs,ctx.fs.resolve(result(f)),await W.readBytes(run.stdoutPath));
          carry(from,result(f));
          if(!keep)ctx.fs.remove(f);
          continue;
        }
        const from=f==='-'?null:ctx.fs.get(f);
        // (-f: a result that is there already is removed first, as gzip does – so a read-only one is no obstacle)
        if(force&&from&&!test){const old=ctx.fs.get(decompress?result(f):f+'.gz');if(old&&old.kind!=='dir'&&old.readonly&&!old.protected)ctx.fs.remove(decompress?result(f):f+'.gz');}
        if(await withArgs(ctx,one(f),'bgzip'))count(1);
        else if(from&&!test)carry(from,decompress?result(f):f+'.gz');
      }
      return said;
    }
    const todo=[];
    for(const f of files){const r=refused(f);if(r){if(r[0])ctx.err(r[0]);count(r[1]);}else todo.push(f!=='-'&&decompress&&!ctx.fs.exists(f)?f+'.gz':f);}
    if(files.length&&!todo.length)return said;
    if(todo.length<=1&&!(await plain(todo[0]))){const c=await withArgs(ctx,one(todo[0]),'bgzip');return c?(said===1?1:c):said;}
    // to the output: what each file gives, one after the other
    const sink=new u.Sink();let code=said;
    for(const f of todo){
      const raw=await plain(f);
      if(raw){sink.add(raw);continue;}
      const r=await W.run({...ctx,redirectTarget:null,mergeStderr:false},'bgzip',one(f),{binaryOut:true});
      if(r.stderr)ctx.err(tidy(r.stderr,name));
      if(r.code)code=r.code;
      sink.add(await W.readBytes(r.stdoutPath));
      MG.bus.emit('tool:run',{program:'bgzip',sub:'',args:one(f),code:r.code,secs:r.secs,created:r.created,real:true,line:ctx.rawLine,statusKnown:r.statusKnown});
    }
    if(ctx.takesBytes)ctx.out(sink.bytes());
    else if(!decompress){if(!sink.empty)ctx.io.note(`Binary output: ${MG.humanSize(sink.bytes().length)} bytes. Save with > FILE, or inspect using samtools/bcftools view.`);}
    else ctx.out(sink.text());
    return code;
  }
  for(const name of ['gzip','gunzip','zcat','gzcat'])T[name]={hidden:true,summary:'gzip files (done by bgzip)',man:`${name}: ${name==='gzip'?'compress':'decompress'} gzip files. In this terminal bgzip ${W.versions.htslib} does the work.`,run:ctx=>gzRun(ctx,name)};
  /* zgrep PATTERN FILE… = for each file: zcat -f FILE | grep --label=FILE PATTERN. A file that is not compressed is
     searched as it is; with several files each line is given with the name of its file (not with -h), as grep
     does; the status is 0 if something was found in any file, 2 after an error, else 1. */
  T.zgrep={hidden:true,summary:'grep in gzip files',man:'zgrep [OPTIONS] PATTERN FILE…: search gzip files (for each: zcat -f FILE | grep PATTERN).',run:async ctx=>{
    const opts=[],rest=[];
    for(let i=0;i<ctx.args.length;i++){const a=ctx.args[i];if(a==='-e'||a==='-m'||a==='-A'||a==='-B'||a==='-C')opts.push(a,ctx.args[++i]);else if(a.startsWith('-')&&a.length>1)opts.push(a);else rest.push(a);}
    if(!rest.length&&!opts.includes('-e'))throw MG.shellUtil.userErr('usage: zgrep [OPTIONS] PATTERN FILE.gz',2);
    const pattern=opts.includes('-e')?[]:[rest.shift()];
    const io=MG.shellUtil.innerIO(ctx);
    if(!rest.length){
      // (what comes in is searched as it is when it is not compressed: zgrep PATTERN < plain.txt)
      let packed=true;
      try{const s=ctx.stdin;if(typeof s==='string')packed=s.charCodeAt(0)===0x1f&&s.charCodeAt(1)===0x8b;else if(s instanceof FileRef){const b=await W.readBytes(s.apath);packed=b.length>=2&&b[0]===0x1f&&b[1]===0x8b;}}catch(e){}
      const parts=packed?[{argv:['gzip','-dcfq'],redirs:[]},{argv:['grep',...opts,...pattern],redirs:[]}]:[{argv:['grep',...opts,...pattern],redirs:[]}];
      return ctx.shell.runPipeline(parts,io,ctx.rawLine,Object.assign({},ctx.opts,{stdin:ctx.stdin}));
    }
    const named=rest.length>1&&!opts.some(a=>a==='--no-filename'||(/^-[A-Za-z]+$/.test(a)&&a.includes('h')));
    let found=false,failed=false;
    for(const f of rest){
      const o=Object.assign({},ctx.opts,{stdin:undefined});
      const c=await ctx.shell.runPipeline([{argv:['gzip','-dcfq',f],redirs:[]},{argv:['grep',...opts,...(named?['-H']:[]),'--label='+f,...pattern],redirs:[]}],io,ctx.rawLine,o);
      if((o.codes&&o.codes[0])||c>1)failed=true;else if(c===0)found=true;
    }
    return failed?2:found?0:1;
  }};
  /* grep -P. The Biowasm build of grep 3.7 has no PCRE ("Perl matching not supported in a --disable-perl-regexp
     build"), so a command line that asks for Perl patterns is carried out by a second program: GNU grep 3.11 with
     PCRE2 10.42, built for this practical (grep-perl; see its NOTICE.txt). Whether a command line asks for them is
     decided as grep's getopt decides it: -P alone or in a group of letters (-oP, -oPm1 – but not behind a letter that
     takes a value: -eP is the pattern "P"), --perl-regexp or a beginning of that word, anywhere before "--". */
  const GREP_VALUE='ABCDXdefm',GREP_LONG={'after-context':1,'before-context':1,'binary-files':1,'context':1,'devices':1,'directories':1,'exclude':1,'exclude-from':1,'exclude-dir':1,'file':1,'group-separator':1,'include':1,'label':1,'max-count':1,'regexp':1,
    'basic-regexp':0,'extended-regexp':0,'fixed-regexp':0,'fixed-strings':0,'perl-regexp':0,'byte-offset':0,'color':0,'colour':0,'count':0,'files-with-matches':0,'files-without-match':0,'help':0,'ignore-case':0,'no-ignore-case':0,'initial-tab':0,'line-buffered':0,'line-number':0,'line-regexp':0,'no-filename':0,'no-group-separator':0,'no-messages':0,'null':0,'null-data':0,'only-matching':0,'quiet':0,'recursive':0,'dereference-recursive':0,'invert-match':0,'silent':0,'text':0,'binary':0,'unix-byte-offsets':0,'version':0,'with-filename':0,'word-regexp':0};
  function wantsPerl(args){
    let perl=false;
    for(let i=0;i<args.length;i++){
      const a=String(args[i]);
      if(a==='--')break;
      if(a.startsWith('--')){
        const word=a.slice(2).split('=')[0];
        // (the whole word, or a beginning that only one word has)
        const hits=word in GREP_LONG?[word]:Object.keys(GREP_LONG).filter(k=>k.startsWith(word));
        if(hits.length!==1)continue;
        if(hits[0]==='perl-regexp')perl=true;
        else if(GREP_LONG[hits[0]]&&!a.includes('='))i++;
      }else if(a.length>1&&a[0]==='-'){
        for(let k=1;k<a.length;k++){
          if(a[k]==='P')perl=true;
          else if(GREP_VALUE.includes(a[k])){if(k===a.length-1)i++;break;}
        }
      }
    }
    return perl;
  }
  MG.wantsPerl=wantsPerl;
  const grepRun=(ctx,name)=>{
    const first=name==='egrep'?['-E']:name==='fgrep'?['-F']:[],program=wantsPerl(ctx.args)?'grep-perl':'grep';
    return first.length?withArgs(ctx,[...first,...ctx.args],program):runReal(ctx,program);
  };
  for(const name of ['awk','gawk','grep','egrep','fgrep','sed','diff','cmp',...CORE]){
    const program=name==='awk'?'gawk':name==='egrep'||name==='fgrep'?'grep':name;
    T[name]={summary:'GNU '+name+' (real WebAssembly executable)',man:`GNU ${name}: use ${name} --help for its supported options. Shell constructs are documented in help.`,run:ctx=>program==='grep'?grepRun(ctx,name):name==='date'?withArgs(ctx,dateArgs(ctx),program):name==='cat'?catRun(ctx):name==='tee'?teeRun(ctx):runReal(ctx,program)};
    delete MG.shellBuiltins[name];
  }
})();
