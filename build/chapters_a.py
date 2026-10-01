"""Chapters 0–3: start, project folder, by hand then a script, Python for Snakemake."""
from chapters_lib import *

P = 'cyp2c19-pipeline'


def ch_start():
    body = f'''
  {callout('lecture', 'Claerbout’s principle', f"""<blockquote class="quote">“An article about computational result is advertising, not scholarship. The actual scholarship is the full software environment, code and data, that produced the result.”</blockquote>
  <p class="small muted">The lecture’s summary of the idea of Claerbout &amp; Karrenbach (<i>Electronic documents give reproducible research a new meaning</i>, SEG Technical Program Expanded Abstracts, 1992, 601–604). Its best-known wording is Buckheit &amp; Donoho’s (1995): “An article about computational science in a scientific publication is not the scholarship itself, it is merely advertising of the scholarship. The actual scholarship is the complete software development environment and the complete set of instructions which generated the figures.”</p>
  <p>Claerbout and Karrenbach also came up with four basic rules for reproducible research at the Stanford Exploration Project: every result could be <b>burned</b> (deleted), <b>built</b> again, <b>viewed</b>, and its folder <b>cleaned</b> of intermediate files – each with one command. By the end of this practical your own analysis will pass the same test.</p>""")}

  <p>In the reads-to-variants practical you turned sequencing reads into variant calls, typing one command at a time. Could someone else – or you, in six months – get <i>exactly</i> the same calls again? Only if they know <b>which data</b> you used, <b>every command and option</b>, in <b>which order</b>, with <b>which settings</b>, and with <b>which versions</b> of the programs. A pipeline writes all of that down in a form a computer can run.</p>

  <h2 id="s-route">0.1 The route</h2>
  <table class="table small route">
    <tr><th>Chapter</th><th>You will…</th></tr>
    <tr><td>1 · A project folder</td><td>set up a project the data-science way: raw data read-only and checksummed, a README</td></tr>
    <tr><td>2 · By hand, then a script</td><td>run the analysis by hand, then as a bash script – and see what a script cannot do</td></tr>
    <tr><td>3 · Python for Snakemake</td><td>learn the Python you need to read and write a Snakefile, in the notebook and as a script</td></tr>
    <tr><td>4 · Your first Snakefile</td><td>write the pipeline as Snakemake rules, with help (and mistakes) from an AI assistant</td></tr>
    <tr><td>5 · Any sample, any setting</td><td>wildcards, a config file, parameters, logs and a Python script in the pipeline</td></tr>
    <tr><td>6 · Software environments</td><td>find out why the same pipeline can give different numbers on another computer, and pin the software</td></tr>
    <tr><td>7 · The same pipeline in Galaxy</td><td>build the workflow graphically in Galaxy – and get the identical result</td></tr>
    <tr><td>8 · An AI agent</td><td>let an AI agent “do the analysis” and ask what it can prove</td></tr>
    <tr><td>9 · Which is best?</td><td>burn and rebuild your results, compare the four approaches, and export your project</td></tr>
  </table>

  {callout('info', 'The data', """<p>The same sample and genes as in the reads-to-variants practical, made small enough for every step to run in seconds in your browser:</p>
  <ul>
    <li><b>Reads:</b> 3,519 pairs of real 76-base Illumina exome reads from <b>NA12878</b> (1000 Genomes run SRR098401) that map around <i>CYP2C19</i> and <i>CYP2C9</i>, two genes that metabolise many drugs.</li>
    <li><b>Reference:</b> two 26–30 kb slices of the human genome (hg19), each covering part of one gene – including the sites of <i>CYP2C19*2</i> and <i>CYP2C9*2</i>.</li>
    <li><b>Programs:</b> minimap2 2.22, samtools 1.17 and bcftools 1.10 – the real programs, compiled to WebAssembly and running in your browser. (minimap2 replaces BWA, which is not available in a browser.)</li>
  </ul>
  <p class="small muted">NA12878 is a public reference sample whose donor consented to open data sharing. Nothing in this practical is a clinical result.</p>""")}

  <h2 id="s-bench">0.2 The workbench</h2>
  {activity('Activity 0.2 · Look around', [
      task('s-term', f'The <b>Terminal</b> is a Linux-like shell. List the course data: {cmd("ls -l /data/course")}', auto='term:command line~/data/course code=0'),
      task('s-readme', f'Read what the data is: {cmd("cat /data/course/README.md")}', auto='term:command line~README.md code=0'),
      task('s-files', f'The <b>Files</b> tab shows your folders and has an editor for Snakefiles, scripts and config files. {bench("editor", "open Files")}', auto='app:bench name=editor'),
      task('s-nb', f'The <b>Notebook</b> runs Python in your browser (the first time, it takes 10–30 seconds to start). {bench("notebook", "open Notebook")}', auto='app:bench name=notebook'),
      task('s-gx', f'<b>Galaxy</b> is a practice Galaxy server running in the page (chapter 7). {bench("galaxy", "open Galaxy")}', auto='app:bench name=galaxy'),
      task('s-ai', f'The <b>AI assistant</b> has a Chat tab (a coding assistant) and an Agent tab (chapter 8). Its prepared answers contain <b>mistakes on purpose</b> – spotting them is part of the practical. {bench("assistant", "open the assistant")}', auto='app:bench name=assistant'),
  ])}
  <p class="small muted">The practical takes about 5½ hours – for example chapters 0–5 in one session and 6–9 in another; stop whenever you like and carry on later. Your own files (Snakefile, config, scripts …), conda environments, Galaxy workflows, the notebook, ticks and answers are saved in this browser – use the same browser next time. To continue on another computer (lab computers may clear the browser when you log out), use <b>My answers → Save all my work to a file</b> before you leave, and <b>Open my work from a file</b> on the next computer. Results are <i>not</i> saved: rebuilding them is one command, which is rather the point. <b>My answers</b> also downloads your answers; the last chapter shows how to download your whole project.</p>

  {q('s-need', 'Think back to the reads-to-variants practical. If a colleague wanted to regenerate your filtered VCF file <i>exactly</i>, what would they need from you? List as many things as you can.',
     """<p>At least: the <b>raw data</b> – the exact read files and the exact reference genome (version and any changes) – ideally with checksums; <b>every command</b>, in order, with all its options; the <b>parameters</b> (e.g. the filter thresholds); the <b>program versions</b> (and the libraries they were built with); the <b>computing environment</b> (operating system, how the software was installed); anything done <b>by hand</b> (renamed files, a step repeated after an error, a file edited in a text editor). A shell history or lab-book notes rarely record all of this – that is what this practical fixes.</p>""")}
  {mcq('s-scholar', 'In Claerbout’s principle, a paper is only “advertising”. What is the “scholarship”?', [
      ('the figures and tables in the paper', False, 'The figures are part of the advertising: they show the results but cannot regenerate them.'),
      ('the full software environment, code and data that produced the results', True, 'Only these let someone regenerate – and check – every result.'),
      ('the methods section of the paper', False, 'A methods section describes the analysis in words; it cannot be run, and it is rarely complete.'),
      ('the peer reviews', False, 'Reviewers usually see only the advertising, too.'),
  ])}
'''
    return chapter('start', 0, 'Start here', 'terminal', 'Pipelines and reproducibility', 15,
                   'Turn a variant-calling analysis into a pipeline anyone can re-run with one command – with Snakemake and with Galaxy – and find out what an AI agent can and cannot prove about its results.', body)


def ch_project():
    mk = 'mkdir -p cyp2c19-pipeline/{config,data/raw,logs,results,workflow/{envs,scripts}}'
    cp1 = 'cp /data/course/SRR098401_1.fastq data/raw/NA12878_R1.fastq && cp /data/course/SRR098401_2.fastq data/raw/NA12878_R2.fastq'
    cp2 = 'cp /data/course/hg19_CYP2C_slices.fa data/raw/reference.fa && cp /data/course/hg19_CYP2C_slices.fa.fai data/raw/reference.fa.fai'
    md5 = 'md5sum data/raw/NA12878_R1.fastq data/raw/NA12878_R2.fastq data/raw/reference.fa > data/raw/MD5SUMS'
    body = f'''
  <p>Before the first command, decide where everything goes. A good layout keeps apart what you were <b>given</b> (data), what you <b>write</b> (code and settings) and what the computer <b>makes</b> (results) – so that anyone can see at a glance what can be regenerated and what cannot.</p>

  <h2 id="p-folders">1.1 Make the folders</h2>
  {activity('Activity 1.1 · A project skeleton', [
      task('p-home', f'Make sure you are in your home folder: {cmd("cd ~")}', auto='term:command line~cd code=0'),
      task('p-mkdir', f'Make the folders in one go: {cmd(mk)}<br><span class="small muted">The braces are <b>brace expansion</b>: the shell turns <code>{{a,b}}</code> into two words, so one command makes the project folder and all eight folders inside it.</span>', check='exists:workflow/scripts'),
      task('p-tree', f'Go into the project and look at it: {cmd("cd cyp2c19-pipeline && tree")}', auto='term:command line~tree code=0'),
  ])}
  <table class="table small">
    <tr><th>Folder</th><th>What goes in it</th><th>Can it be deleted and made again?</th></tr>
    <tr><td><code>data/raw/</code></td><td>the input data, exactly as received</td><td><b>No</b> – protect it</td></tr>
    <tr><td><code>config/</code></td><td>settings: sample names, file paths, thresholds</td><td>no – you write it</td></tr>
    <tr><td><code>workflow/</code></td><td>the pipeline (<code>Snakefile</code>), software environments (<code>envs/</code>), scripts (<code>scripts/</code>)</td><td>no – you write it</td></tr>
    <tr><td><code>results/</code>, <code>logs/</code></td><td>everything the pipeline makes</td><td><b>Yes</b> – so never edit anything in here by hand</td></tr>
  </table>
  <p class="small muted">This is close to the layout the Snakemake documentation recommends, and to W. S. Noble’s classic guide, <i>A quick guide to organizing computational biology projects</i> (PLoS Comput Biol 2009). {ai('proj:layout', 'Ask the assistant about project layouts')}</p>

  <h2 id="p-data">1.2 Bring in the data – and prove it is the same data</h2>
  {activity('Activity 1.2 · Copy and checksum', [
      task('p-cp1', f'Copy the reads, giving them names that say which sample they are: {cmd(cp1)}', check='exists:data/raw/NA12878_R2.fastq'),
      task('p-cp2', f'Copy the reference and its index: {cmd(cp2)}', check='exists:data/raw/reference.fa.fai'),
      task('p-md5', f'Record a <b>checksum</b> of each file: {cmd(md5)}', check='exists:data/raw/MD5SUMS'),
      task('p-cmp', f'Compare your checksums with the ones published with the course data: {cmd("cat data/raw/MD5SUMS /data/course/MD5SUMS")}', auto='term:command line~MD5SUMS code=0 name=cat'),
      task('p-check', f'Anyone can now check that their copies are identical to yours: {cmd("md5sum -c data/raw/MD5SUMS")}', auto='hash:check ok=true'),
  ])}
  {q('p-md5q', 'The reads now have new names. How do the checksums show that <code>data/raw/NA12878_R1.fastq</code> is still exactly the file <code>SRR098401_1.fastq</code>?',
     """<p>Both files have the same MD5 checksum, <code>d2b8ddb488975fa5ef18e6e59edb5681</code>. A checksum is calculated from the <b>contents</b> only – not the name or the date – and changing even one byte gives a completely different checksum. Same checksum = same data, whatever the file is called.</p>""",
     accept=r'd2b8|same|identical|match|content|equal', hint='compare the two long codes printed for the R1 files')}

  <h2 id="p-protect">1.3 Protect the raw data</h2>
  {activity('Activity 1.3 · Read-only', [
      task('p-ro', f'Take away write permission from everyone (<code>a-w</code>): {cmd("chmod a-w data/raw/*")}', check='readonly:data/raw/NA12878_R1.fastq'),
      task('p-ls', f'Look at the permissions: {cmd("ls -l data/raw")} – <code>-r--r--r--</code> means readable, not writable. (Compare <code>ls -l /data/course</code>: those files belong to <code>root</code>, so you could never change them.)', auto='term:command line~ls -l data/raw code=0'),
      task('p-oops', f'Try an accident – writing over the reference: {cmd("echo oops > data/raw/reference.fa")}', auto='term:command line~oops code=1'),
  ])}
  {q('p-why', 'Why protect the raw data, but not the results?',
     """<p>Everything else is derived from the raw data: if it changes, every result and conclusion silently loses its foundation, and the data often cannot be obtained again. Results, on the other hand, are <b>disposable</b>: the pipeline can make them again at any time – so they are never edited by hand, and they need no protection. (Write protection prevents <i>accidents</i>; as the owner you could still change the permissions back.)</p>""")}

  <h2 id="p-readme">1.4 Say what it is: a README</h2>
  <p>The README is the first thing anyone (including you, later) reads. Start it now and complete it as the project grows.</p>
  {codefile('README.md', README_START)}
  {activity('Activity 1.4 · README and .gitignore', [
      task('p-readme', 'Press <b>Create this file</b> above. It opens in the <b>Files</b> tab: fill in your name and the date, and save with <kbd>Ctrl</kbd>+<kbd>S</kbd>.', check='exists:README.md'),
      task('p-git', 'Real projects are kept under <b>version control</b> with git, so every change to the code is recorded. Results are not put in git – they can be regenerated. Create the <code>.gitignore</code> file below that says so (git is not available in this browser, but the file will be part of your project when you download it).', check='exists:.gitignore'),
  ])}
  {codefile('.gitignore', GITIGNORE)}
  {q('p-readmeq', 'The README says where the data came from. What do the checksums add that the README text cannot?',
     """<p>The README <i>claims</i> which files were used; the checksums let anyone <b>verify</b> the claim – that their copy is byte-for-byte the same as yours, and that nothing has changed since. Provenance you can check is worth much more than provenance you have to trust.</p>""")}
'''
    return chapter('project', 1, 'A project folder', 'terminal', 'A project folder', 20,
                   'Reproducibility starts before the first command: with a folder in which data, code, settings and results each have their place – and raw data that cannot change unnoticed.', body)


def ch_script():
    mkd = 'mkdir -p results/mapped results/qc results/variants'
    mapc = "minimap2 -ax sr -R '@RG\\tID:NA12878\\tSM:NA12878' data/raw/reference.fa data/raw/NA12878_R1.fastq data/raw/NA12878_R2.fastq | samtools sort -o results/mapped/NA12878.sorted.bam -"
    idx = 'samtools index results/mapped/NA12878.sorted.bam'
    flag = 'samtools flagstat results/mapped/NA12878.sorted.bam > results/qc/NA12878.flagstat.txt'
    call = 'bcftools mpileup -f data/raw/reference.fa results/mapped/NA12878.sorted.bam -Ou | bcftools call -mv -Oz -o results/variants/NA12878.raw.vcf.gz'
    filt = "bcftools filter -i 'QUAL>=20 && INFO/DP>=5' -Oz -o results/variants/NA12878.filtered.vcf.gz results/variants/NA12878.raw.vcf.gz"
    count = 'bcftools view -H results/variants/NA12878.filtered.vcf.gz | wc -l'
    md5 = 'bcftools view -H results/variants/NA12878.filtered.vcf.gz | md5sum'
    body = f'''
  <p>Make sure the terminal is in your project folder (the prompt ends in <code>cyp2c19-pipeline</code>; if not: {cmd("cd ~/cyp2c19-pipeline")}). All paths from now on are <b>relative</b> to the project folder.</p>

  <h2 id="h-hand">2.1 By hand</h2>
  <p>These are the steps of the reads-to-variants practical, with minimap2 for mapping. Run them one after the other and read what each one prints.</p>
  {activity('Activity 2.1 · Seven commands', [
      task('h-mkdir', f'Folders for the results: {cmd(mkd)}', check='exists:results/variants'),
      task('h-map', f'Map the read pairs to the reference and sort the alignments by position (about 5 s): {cmd(mapc)}<br><span class="small muted"><code>-ax sr</code>: short reads, SAM output; <code>-R</code> adds a <i>read group</i> naming the sample (<code>\\t</code> means a tab); the final <code>-</code> tells samtools to read from the pipe.</span>', check='exists:results/mapped/NA12878.sorted.bam'),
      task('h-idx', f'Index the BAM file: {cmd(idx)}', check='exists:results/mapped/NA12878.sorted.bam.bai'),
      task('h-flag', f'Count the mapped reads: {cmd(flag)} then {cmd("head -5 results/qc/NA12878.flagstat.txt")}', check='exists:results/qc/NA12878.flagstat.txt'),
      task('h-call', f'Call the variants: {cmd(call)}', check='exists:results/variants/NA12878.raw.vcf.gz'),
      task('h-filt', f'Keep the confident calls: {cmd(filt)}', check='exists:results/variants/NA12878.filtered.vcf.gz'),
      task('h-count', f'How many variants passed? {cmd(count)}', auto='term:command line~wc -l code=0 line~filtered'),
  ])}
  {q('h-n', 'How many variants passed the filter?', f'<p><b>{N_FILTERED}</b> of {N_RAW} raw calls.</p>', accept=rf'(^|\D){N_FILTERED}(\D|$)', hint='the number printed by wc -l')}
  <p>A number is easy to compare, but it does not prove two files are the same. A checksum of the variant records does. (Checksum the <i>records</i>, not the file: the header of a VCF file records the date and time it was made, so two identical analyses never give identical files.)</p>
  {activity('Activity 2.2 · A fingerprint of the result', [
      task('h-md5', f'{cmd(md5)} – <code>-H</code> prints the variant records without the header.', auto='term:command line~md5sum code=0 line~filtered'),
  ])}
  {q('h-md5q', 'Copy the checksum here. You will compare every later run – Snakemake, Galaxy, a colleague’s computer – with it.',
     f'<p><code>{FILTERED_MD5}</code> – if yours differs, check that you used exactly the commands above.</p>', accept=rf'{FILTERED_MD5[:10]}', hint='the 32-character code printed by md5sum', placeholder='32 letters and digits')}

  <h2 id="h-script">2.2 A script – the simplest pipeline</h2>
  <p>Typing commands is slow and error-prone, and the only record is your shell history. Put them in a file instead: a <b>bash script</b>. Lines starting with <code>#</code> are comments; a <code>\\</code> at the end of a line continues the command on the next line.</p>
  {codefile('workflow/run_all.sh', RUN_ALL)}
  {activity('Activity 2.3 · Run the script', [
      task('h-create', 'Press <b>Create this file</b>. Read it in the editor: it is exactly the commands you typed.', check='exists:workflow/run_all.sh'),
      task('h-run', f'Run it: {cmd("bash workflow/run_all.sh")} – watch the time in the status bar under the terminal.', auto='script:done code=0 path~run_all'),
      task('h-run2', f'Run it again: {cmd("bash workflow/run_all.sh")}. Nothing has changed – what does the script do?', auto='script:done code=0 path~run_all'),
  ])}
  {q('h-rerun', 'The second run redid every step. Why is that a problem for a real project – say 100 samples, when one new sample arrives, or when only the filter threshold changes?',
     """<p>A script has no idea what is already done: it cannot tell that the BAM files are up to date, so it repeats hours of mapping to change one threshold or add one sample. It lacks the two features the lecture named: <b>dependencies</b> (which file is made from which) and <b>re-entrancy</b> (continuing from where it stopped, redoing only what is needed). You could add checks by hand (“if the file exists, skip”) – but then an outdated file would never be updated.</p>""")}

  <h2 id="h-fail">2.3 When a step fails</h2>
  <p>A typo is all it takes. Break the script on purpose and see what it reports.</p>
  {activity('Activity 2.4 · A silent failure', [
      task('h-break', f'In the editor, change <code>NA12878_R1.fastq</code> in the minimap2 command to <code>NA12878_R3.fastq</code> (a file that does not exist) and save with <kbd>Ctrl</kbd>+<kbd>S</kbd>. {edit("workflow/run_all.sh", "open run_all.sh")}', check='has:workflow/run_all.sh|NA12878_R3'),
      task('h-broken', f'Run it: {cmd("bash workflow/run_all.sh")} – read <b>all</b> the output. Then ask the shell for the script’s exit status: {cmd("echo $?")} (0 means success).', auto='term:command line~echo $?'),
      task('h-stale', f'Look at the results: {cmd("ls -l results/mapped results/variants")} – compare the sizes with before. How many reads are in the new BAM file? {cmd("samtools view -c results/mapped/NA12878.sorted.bam")}', auto='term:command line~view -c code=0'),
  ])}
  {q('h-stale-q', 'minimap2 could not open its input – yet the script made new results and said “All steps finished.” Why did the later steps still “work”, and why is this dangerous?',
     """<p>minimap2 writes the SAM <b>header</b> before it opens the reads. So samtools sort received a valid header with no reads and wrote an <b>empty</b> BAM file (309 bytes, 0 reads, instead of about 500 kB). Indexing, flagstat, calling and filtering all ran without complaint on it and made empty results, and the script exited with status 0 – the status of its last command, <code>echo</code>. Nothing reports the failure: the results are simply wrong. Here they are conspicuously empty, but a failure halfway through a file – or one of two read files missing – gives results that look normal, and a report would say “no variants” where there are some.</p>""")}
  <p>Bash can be told to stop at the first error. Three settings, known together as <b>strict mode</b>:</p>
  <table class="table small">
    <tr><td><code>set -e</code></td><td>stop as soon as a command fails</td></tr>
    <tr><td><code>set -u</code></td><td>treat a variable that was never set as an error</td></tr>
    <tr><td><code>set -o pipefail</code></td><td>a pipe (<code>a | b</code>) fails if <i>any</i> program in it fails, not only the last one</td></tr>
  </table>
  {activity('Activity 2.5 · Strict mode', [
      task('h-strict', 'Add the line <code>set -euo pipefail</code> as the <b>second</b> line of the script (after <code>#!/bin/bash</code>), and save.', check='has:workflow/run_all.sh|set -euo pipefail'),
      task('h-stop', f'Run the broken script again: {cmd("bash workflow/run_all.sh")} then {cmd("echo $?")}. Where does it stop now?', auto='script:done path~run_all code>0'),
      task('h-fixit', f'Fix the typo (back to <code>NA12878_R1.fastq</code>), save, and run the script once more: {cmd("bash workflow/run_all.sh")}', auto='script:done code=0 path~run_all'),
  ])}
  {ai('sh:strict', 'Ask the assistant what strict mode does')}
  {mcq('h-pipefail', 'Without <code>set -o pipefail</code>, what is the exit status of <code>minimap2 … | samtools sort …</code> when minimap2 fails but samtools sort succeeds?', [
      ('the exit status of minimap2 (the first program)', False, 'Bash reports the status of the last program in a pipe.'),
      ('the exit status of samtools sort – success', True, 'Without pipefail only the last program counts, so the failure of minimap2 is hidden.'),
      ('always 1', False, 'Bash does not look at the other programs unless pipefail is on.'),
  ])}
  {callout('info', 'What a workflow engine adds', """<p>Strict mode stops a script at the first error – but it still cannot tell which files are up to date, it still redoes everything, and it leaves half-made files behind. A <b>workflow engine</b> such as Snakemake adds exactly what is missing:</p>
  <ul><li><b>dependencies</b> – it knows which file is made from which;</li><li><b>re-entrancy</b> – it redoes only what is needed;</li><li><b>clean failures</b> – it deletes the output of a failed step so that nothing half-made is mistaken for a result;</li><li><b>a record</b> – of what was run, when, with which code and settings.</li></ul>""")}
'''
    return chapter('script', 2, 'By hand, then a script', 'terminal', 'By hand, then a script', 30,
                   'First the familiar way: type each step. Then put the steps in a bash script – the simplest kind of pipeline – and find out what a script cannot do.', body)


def ch_python():
    values = '''sample = "NA12878"          # text (a "string") needs quotes
min_qual = 20               # a number does not
samples = ["NA12878", "NA12891", "NA12892"]   # a list: items in [ ], separated by commas

print(sample, min_qual)
print(samples[0], len(samples))'''
    comma = '''bad = ["NA12878" "NA12891"]     # oops: no comma between the two names
print(bad, len(bad))'''
    cfg = '''import yaml                               # a package that reads YAML files

with open("config/config.yaml") as f:     # open the file; the indented block uses it
    config = yaml.safe_load(f)            # YAML text -> Python dictionaries and lists

print(config)
print(config["min_qual"], config["samples"])'''
    names = '''for s in config["samples"]:                 # repeat the indented line for each sample
    print(f"data/raw/{s}_R1.fastq")           # an f-string fills in {s}

pattern = "results/variants/{sample}.filtered.vcf.gz"
print(pattern.format(sample="NA12878"))       # .format fills in {sample} later – as Snakemake does'''
    expand = '''from snakemake.io import expand

print(expand("results/variants/{sample}.filtered.vcf.gz", sample=config["samples"]))
print(expand("results/qc/{sample}.flagstat.txt", sample=["A", "B", "C"]))'''
    func = '''def vcf_name(sample, kind="filtered"):      # def: a reusable, named piece of code
    return f"results/variants/{sample}.{kind}.vcf.gz"

print(vcf_name("NA12878"))                   # kind uses its default value
print(vcf_name("NA12878", kind="raw"))       # a keyword argument: name=value'''
    stateA = 'threshold = 20'
    stateB = 'print("keeping variants with QUAL >=", threshold)'
    body = f'''
  <p>Snakemake is written in Python, and so is a Snakefile: a Python file with a few extra keywords. You do not need to be a programmer to write one – but you need to <b>read</b> a handful of Python ideas. Try each of them in the notebook, where you can change a line and run it again.</p>
  {callout('info', 'How the notebook works', """<p>Each grey box is a <b>cell</b> of Python. Run a cell with ▶ or <kbd>Shift</kbd>+<kbd>Enter</kbd>; its output appears below it. Python <b>remembers</b> the variables made by the cells you have run – in the order you ran them. The buttons in these instructions put code into a new cell and run it; you can then edit it and run it again.</p>
  <p class="small muted">The notebook works in your project folder, so <code>config/config.yaml</code> means <code>~/cyp2c19-pipeline/config/config.yaml</code>.</p>""")}

  <h2 id="y-values">3.1 Values, variables and lists</h2>
  {nb(values, 'py-values')}
  <table class="table small">
    <tr><td><code>name = value</code></td><td>makes a <b>variable</b>: a name for a value</td></tr>
    <tr><td><code>"NA12878"</code></td><td>a <b>string</b> (text) – always in quotes; <code>20</code> is a number</td></tr>
    <tr><td><code>[a, b, c]</code></td><td>a <b>list</b>; <code>samples[0]</code> is the first item (Python counts from 0)</td></tr>
    <tr><td><code>len(x)</code>, <code>print(x)</code></td><td><b>calling a function</b>: its name, then the inputs (<i>arguments</i>) in brackets</td></tr>
    <tr><td><code># …</code></td><td>a comment, ignored by Python</td></tr>
  </table>
  {activity('Activity 3.1 · Your first Python', [
      task('y-run', 'Run the cell above (the button puts it in the notebook and runs it).', auto='nb:run ok=true tag=py-values'),
      task('y-edit', 'In the notebook, add the line <code>print(samples[1])</code> at the end of the cell, and run it again.', auto='nb:run ok=true code~samples[1]'),
  ])}
  {q('y-index', 'What does <code>samples[2]</code> give?', '<p><code>NA12892</code> – the third item, because counting starts at 0.</p>', accept=r'NA12892', hint='counting starts at 0')}

  <h2 id="y-comma">3.2 The comma trap</h2>
  {nb(comma, 'py-comma')}
  {q('y-len', 'What is <code>len(bad)</code>, and why?', """<p><b>1</b>. With no comma between them, Python joins two strings that stand next to each other into one: the list holds a single item, <code>'NA12878NA12891'</code>. There is no error message – it is a <i>silent</i> bug. Remember it: in a Snakefile, a missing comma between two input files glues their names together.</p>""", accept=r'^\D*1\b', hint='count the items in the list that is printed')}
  {ai('py:comma', 'Ask the assistant why this happens')}

  <h2 id="y-dict">3.3 Dictionaries and a config file</h2>
  <p>Settings belong in a <b>config file</b>, not in the code. YAML is a simple text format for them: <code>key: value</code> pairs, and lists with <code>-</code>. Create the pipeline’s config file now – Snakemake will read it in chapter 5.</p>
  {codefile('config/config.yaml', CONFIG)}
  {nb(cfg, 'py-config')}
  <table class="table small">
    <tr><td><code>{{"min_qual": 20, ...}}</code></td><td>a <b>dictionary</b>: values looked up by a key – <code>config["min_qual"]</code> gives 20</td></tr>
    <tr><td><code>import yaml</code></td><td>loads a <b>package</b> (a library of ready-made functions)</td></tr>
    <tr><td><code>with open(...) as f:</code></td><td>opens a file for the <b>indented block</b> below it, and closes it afterwards. Indentation (4 spaces) is how Python groups lines – it is not decoration.</td></tr>
  </table>
  {activity('Activity 3.2 · Read the settings', [
      task('y-cfg', 'Create <code>config/config.yaml</code> (button above), then run the notebook cell that reads it.', auto='nb:run ok=true tag=py-config'),
  ])}
  {q('y-type', 'What kind of Python value is <code>config["samples"]</code>?', '<p>A <b>list</b> (<code>[\'NA12878\']</code>) – because the YAML file lists the samples with <code>-</code>.</p>', accept=r'list', hint='look at the brackets in the printed value')}

  <h2 id="y-names">3.4 Making file names – the heart of Snakemake</h2>
  {nb(names, 'py-names')}
  <p>An <b>f-string</b> (<code>f"…{{s}}…"</code>) fills in a value <i>now</i>; <code>.format()</code> fills in a pattern <i>later</i>. Snakemake works like <code>.format()</code>: your rules contain patterns such as <code>results/{{sample}}.bam</code>, and Snakemake fills in the sample when it knows which file you want. Snakemake’s <code>expand()</code> makes one name per value:</p>
  {nb(expand, 'py-expand')}
  {q('y-expand', 'What does <code>expand("results/qc/{sample}.flagstat.txt", sample=["A", "B", "C"])</code> return?', '<p>A list of three file names: <code>[\'results/qc/A.flagstat.txt\', \'results/qc/B.flagstat.txt\', \'results/qc/C.flagstat.txt\']</code>.</p>', accept=r'A\.flagstat.*B\.flagstat.*C\.flagstat|three|3', hint='run the cell and copy what it prints')}

  <h2 id="y-func">3.5 Functions and keyword arguments</h2>
  {nb(func, 'py-func', runit=True)}
  <p>A rule in a Snakefile looks much like this: a name followed by a colon, an indented body, and <code>keyword=value</code> pairs such as <code>ref="data/raw/reference.fa"</code>. {ai('py:basics', 'Ask the assistant to explain the Python in a Snakefile')}</p>

  <h2 id="y-state">3.6 Notebook or script?</h2>
  <p>A notebook remembers what you ran, in the order you ran it – not the order of the cells on the page. That makes it easy to fool yourself.</p>
  {activity('Activity 3.3 · Hidden state', [
      task('y-a', f'Put this in a cell and run it: {c(stateA)} <button class="do" type="button" data-nb-run="{esc(stateA)}">run it</button>', auto='nb:run ok=true code~threshold = 20'),
      task('y-b', f'And this in the next cell: {c(stateB)} <button class="do" type="button" data-nb-run="{esc(stateB)}">run it</button>', auto='nb:run ok=true code~keeping variants'),
      task('y-c', 'Now edit the first cell to <code>threshold = 30</code> – but do <b>not</b> run it. Run only the second cell. What does the notebook claim now?', auto='nb:run ok=true code~keeping variants'),
      task('y-d', 'Press <b>Restart</b> (notebook toolbar) and then <b>Run all</b>. Which value is printed now?', auto='nb:kernel state=restarted'),
  ])}
  {q('y-hidden', 'After the edit, the page showed <code>threshold = 30</code> but printed 20. Why is that a reproducibility problem, and how do scripts avoid it?',
     """<p>The notebook’s memory (<i>state</i>) no longer matched the code on the page, so the output could not be reproduced from the code you can see. A <b>script</b> always runs from the top, in a fresh Python, so the code <i>is</i> the record. Good practice: explore in a notebook, check with <b>Restart and Run all</b>, and move the code that makes results into scripts that the pipeline runs.</p>""")}
  <p>Now the same idea as a script: save it, then run it from the terminal.</p>
  {codefile('workflow/scripts/hello.py', HELLO)}
  {activity('Activity 3.4 · From notebook to script', [
      task('y-script', 'Create <code>workflow/scripts/hello.py</code> (button above).', check='exists:workflow/scripts/hello.py'),
      task('y-pyrun', f'In the <b>Terminal</b>, in your project folder: {cmd("python workflow/scripts/hello.py")}', auto='py:script ok=true argv~hello.py'),
  ])}
  {callout('lecture', 'Claerbout on interactive programs', """<p>“Interactive programs should always be able to save their state so they can restart. Otherwise, dependence on an interactive program can be a form of slavery (nonreproducible research).” – Jon Claerbout, <a href="https://sepwww.stanford.edu/sep/jon/reproducible.html" target="_blank" rel="noopener">Reproducible computational research</a></p>""")}
  {ai('py:nb', 'Ask the assistant: notebook or script?')}
'''
    return chapter('python', 3, 'Python for Snakemake', 'notebook', 'Python for Snakemake', 35,
                   'A Snakefile is Python with a few extra keywords. Learn the handful of Python ideas you need – values, lists, dictionaries, file-name patterns, indentation – in the notebook, then run the same code as a script.', body)
