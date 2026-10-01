"""Chapters 4–6: the first Snakefile, generalising it, software environments."""
from chapters_lib import *

SF = 'workflow/Snakefile'

def ch_snakefile():
    body = f'''
  {callout('concept', 'A rule', """<p>A Snakefile is a set of <b>rules</b>. Each rule says how to make its <code>output</code> files from its <code>input</code> files – with a <code>shell</code> command, a Python <code>script</code> or a <code>run</code> block – and refers to its files as <code>{input}</code> and <code>{output}</code> in the command. Snakemake starts from the files you ask for (by default those of the <b>first</b> rule: its outputs – or, for a target rule such as <code>all</code>, its inputs), finds the rules that make them, then the rules that make <i>their</i> inputs, and so on – building a <b>DAG</b> (directed acyclic graph) of jobs.</p>""")}

  <h2 id="k-first">4.1 The first rule</h2>
  {codefile(SF, SMK_MAP, note='The <code>\\\\t</code> inside the Python string becomes <code>\\t</code> in the command, which minimap2 turns into a tab.')}
  <table class="table small">
    <tr><td><code>rule map_reads:</code></td><td>a rule and its name (just a label), then an indented body</td></tr>
    <tr><td><code>input:</code></td><td>the files the rule needs – a list of strings, so <b>commas</b> between them</td></tr>
    <tr><td><code>output:</code></td><td>the files it makes</td></tr>
    <tr><td><code>shell:</code></td><td>the command. <code>{{input}}</code> becomes all the input files, in order, separated by spaces; <code>{{output}}</code> the output file</td></tr>
  </table>
  {activity('Activity 4.1 · Run a Snakefile', [
      task('k-create', 'Create <code>workflow/Snakefile</code> with the button above. (Snakemake finds <code>workflow/Snakefile</code> by itself.)', check='exists:workflow/Snakefile'),
      task('k-burn', f'“Burn” the results you made by hand – from now on the pipeline makes them: {cmd("rm -r results")}', auto='term:command line~rm -r results code=0'),
      task('k-dry', f'Ask Snakemake what it <i>would</i> do – a <b>dry run</b>: {cmd("snakemake -n")}. Find the job, and the <b>reason</b> it gives for running it.', auto='smk:run argv~-n ok=true'),
      task('k-run', f'Run it, printing the command it runs (<code>-p</code>), on one CPU core: {cmd("snakemake --cores 1 -p")}', auto='smk:run argv~--cores ok=true'),
      task('k-again', f'Run it again: {cmd("snakemake --cores 1")}', auto='smk:run argv~--cores ok=true'),
  ])}
  {mcq('k-nothing', 'The second run said “Nothing to be done”. Why?', [
      ('Snakemake only runs a rule once per session', False, 'Snakemake decides from the files, not from the session.'),
      ('the output file exists and is newer than its inputs, and nothing it was made with has changed', True, 'So the job would produce the same file again – there is nothing to do.'),
      ('the dry run already made the file', False, 'A dry run (-n) never runs anything.'),
  ], model='<p>Snakemake runs a job only if its output is missing, older than an input, or was made with different code, parameters, inputs or software than now (it keeps records in <code>.snakemake/metadata</code>) – or if you force it. This is <b>re-entrancy</b>: re-run a pipeline at any time and only what is needed happens.</p>')}

  <h2 id="k-more">4.2 Two rules of your own</h2>
  <p>Now write the rules for the next two steps yourself. Here is the skeleton of <code>flagstat</code>: add it <b>below</b> <code>map_reads</code> in the editor, and replace each <code>____</code> with a file name. Its input is the sorted BAM file; its output should be <code>results/qc/NA12878.flagstat.txt</code>.</p>
  {snippet(FLAGSTAT_BLANK)}
  <p>Then write <code>index_bam</code> the same way. <code>samtools index</code> writes its output, the index <code>results/mapped/NA12878.sorted.bam.bai</code>, next to the BAM file by itself – so the command does not mention <code>{{output}}</code>, but the rule still needs an <code>output:</code> line to tell Snakemake which file it makes.</p>
  {snippet(INDEX_BLANK)}
  {activity('Activity 4.2 · Write, check, run', [
      task('k-flag', f'Add <code>rule flagstat</code> and save. Ask for its output file – Snakemake works out the rest: {cmd("snakemake --cores 1 -p results/qc/NA12878.flagstat.txt")}', check='has:workflow/Snakefile|rule flagstat'),
      task('k-idx', f'Add <code>rule index_bam</code>, save, and ask for the index: {cmd("snakemake --cores 1 -p results/mapped/NA12878.sorted.bam.bai")}', check='has:workflow/Snakefile|rule index_bam'),
  ])}
  <p class="small">Stuck? {ai('smk:index', 'Ask the assistant for these two rules')} – and compare its answer with yours.</p>

  <h2 id="k-ai">4.3 A rule from the AI assistant</h2>
  <p>Variant calling is a longer command. Ask the AI assistant to write the rule – and treat its answer the way you would treat code from a stranger.</p>
  {activity('Activity 4.3 · Check the AI’s code', [
      task('k-ask', f'{ai("smk:call", "Ask the assistant for a variant-calling rule")} Read the answer: does the explanation match the code?', auto='ai:answer entry=smk:call'),
      task('k-add', 'Press <b>Add rule call_variants to Snakefile</b> under the code (it goes at the end of your Snakefile), then check it with a dry run: ' + cmd('snakemake -n results/variants/NA12878.raw.vcf.gz'), auto='ai:insert target=snakefile rules~call_variants'),
      task('k-err', 'Read the error message carefully. What file is Snakemake looking for? Fix the rule yourself in the editor – or press <b>✦ Ask the AI assistant about this error</b> under the error in the terminal.', auto='smk:run argv~raw.vcf.gz ok=true'),
      task('k-call', f'When the dry run works, run it: {cmd("snakemake --cores 1 results/variants/NA12878.raw.vcf.gz")}', check='exists:results/variants/NA12878.raw.vcf.gz'),
  ])}
  {q('k-comma', 'What was wrong with the assistant’s rule, how did you find out, and why did Python not complain?',
     """<p>A <b>comma was missing</b> after <code>"data/raw/reference.fa"</code>. Python joins two adjacent strings into one, so Snakemake looked for a single input file called <code>data/raw/reference.faresults/mapped/NA12878.sorted.bam</code> – the dry run’s <b>MissingInputException</b> showed the glued name. Python raises no error because joining adjacent strings is legal (it is how long commands are split over lines). The assistant also explained the code confidently – an explanation is not evidence that code works; running it is.</p>""")}

  <h2 id="k-all">4.4 Filter – and one rule to rule them all</h2>
  <p>Write the last step yourself. The command is the one you ran by hand in chapter 2 – with the file names replaced by <code>{{input}}</code> and <code>{{output}}</code>:</p>
  {snippet(FILTER_BLANK)}
  <p>Finally, a <b>target rule</b>. Snakemake builds the first rule of the Snakefile when you give no target, so pipelines start with a rule – by convention called <code>all</code> – whose inputs are the files you want at the end. It has no output and no command. Put it at the <b>very top</b> of the Snakefile:</p>
  {snippet(SMK_ALL1)}
  {activity('Activity 4.4 · The whole pipeline', [
      task('k-filter', f'Add <code>rule filter_variants</code> (with your command) below the other rules, and save.', check='has:workflow/Snakefile|rule filter_variants'),
      task('k-top', 'Add <code>rule all</code> at the top, and save.', check='has:workflow/Snakefile|^rule all'),
      task('k-burn2', f'Burn and build: {cmd("rm -r results")} then {cmd("snakemake --cores 1")}', auto='smk:run argv~--cores ok=true'),
      task('k-md5', f'Is the result the same as by hand? {cmd("bcftools view -H results/variants/NA12878.filtered.vcf.gz | md5sum")}', auto='term:command line~md5sum code=0 line~filtered'),
  ])}
  {q('k-notrun', 'Look at the job list of the last run. Which of your rules did <b>not</b> run, and why not?',
     """<p><b>index_bam</b> did not run. No rule needs its output: <code>rule all</code> does not ask for the <code>.bai</code> file, and <code>call_variants</code> does not list it as an input (bcftools reads the whole BAM file without the index). Snakemake runs only the jobs needed for the files you ask for: a job runs if its output is a target or is needed by another job – and only if that output is missing or out of date.</p>""")}
  <p class="small">If something does not work, compare your Snakefile with this reference version (it is what you should have now):</p>
  {codefile(SF, SNAKEFILE_B, button='Replace my Snakefile with this')}

  <h2 id="k-dag">4.5 See the DAG</h2>
  {activity('Activity 4.5 · Draw the graph', [
      task('k-dagrun', f'Snakemake describes its DAG in the <code>dot</code> language; the Graphviz program <code>dot</code> draws it: {cmd("snakemake --dag | dot -Tsvg > dag.svg")}', auto='dot:render format=svg'),
      task('k-dagopen', f'Open the picture: {cmd("open dag.svg")}', auto='editor:view name=dag.svg'),
  ])}
  <p class="small muted">On your own computer, <code>snakemake --dag | dot -Tpdf &gt; dag.pdf</code> makes a PDF; this browser’s Graphviz makes SVG and PNG pictures, but not PDF. <code>snakemake --rulegraph</code> draws one box per rule instead of per job – simpler when there are many samples. {ai('smk:dag', 'Ask the assistant about the DAG')}</p>

  <h2 id="k-reentry">4.6 Re-entrancy and provenance</h2>
  <p>Now test the promises of a workflow engine. Run each dry run and read the <b>reason</b> Snakemake gives for each job.</p>
  {activity('Activity 4.6 · What does Snakemake re-run?', [
      task('k-rm1', f'Delete one result: {cmd("rm results/qc/NA12878.flagstat.txt")}, then {cmd("snakemake -n")}. Which jobs would run?', auto='smk:run argv~-n ok=true'),
      task('k-code', f'Change <code>QUAL&gt;=20</code> to <code>QUAL&gt;=30</code> in <code>filter_variants</code>, save, and dry-run again: {cmd("snakemake -n")}', check='has:workflow/Snakefile|QUAL>=30'),
      task('k-codeback', f'Change it back to 20, save, and dry-run once more: {cmd("snakemake -n")} – then build what is missing: {cmd("snakemake --cores 1")}', auto='smk:run argv~--cores ok=true'),
      task('k-fail', f'Now make a step fail: in <code>rule flagstat</code> change <code>samtools flagstat</code> to <code>samtools flagstatt</code> (a typo), save, and force that rule to run: {cmd("snakemake --cores 1 -R flagstat")}. Read the whole message.', auto='smk:run argv~flagstat ok=false'),
      task('k-gone', f'Is there a half-made flagstat file left? {cmd("ls -l results/qc")} Then fix the typo, save, and run {cmd("snakemake --cores 1")}.', auto='term:command line~ls -l results/qc'),
  ])}
  {q('k-reasons', 'What reasons did Snakemake give (a) after you deleted the flagstat file and (b) after you changed the threshold? Why did changing it back need no re-run?',
     """<p>(a) <b>Missing output files</b>: only <code>flagstat</code> (and <code>all</code>) had to run – not the mapping or calling. (b) <b>Code has changed since last execution</b> for <code>filter_variants</code>: Snakemake stores the code each output was made with (in <code>.snakemake/metadata</code>) and notices that the rule is no longer the same – <i>provenance information</i>, beyond comparing the times of the files. After changing it back, the code matched the record of the last run again, so the existing file was still valid.</p>""")}
  {q('k-failq', 'Compare what Snakemake did when the flagstat step failed with what your bash script did in chapter 2.',
     """<p>Snakemake stopped at the failing job with a clear <b>Error in rule flagstat</b> block (and the program’s own error message), exited with a non-zero status, and <b>removed the output</b> of the failed job – the shell had already created an empty flagstat file with <code>&gt;</code> – so no half-made file could be mistaken for a result. The bash script without strict mode carried on, reported success and left wrong (empty) results behind.</p>""")}
'''
    return chapter('snakefile', 4, 'Your first Snakefile', 'editor', 'Your first Snakefile', 45,
                   'Describe each step as a rule – what it needs, what it makes and the command in between – and let Snakemake work out the order, run only what is needed, and keep a record.', body)


def ch_generalise():
    body = f'''
  <p>Your pipeline works – for one sample, with its name and the thresholds written into every rule. Now make it general: <b>wildcards</b> for samples, the <b>config file</b> for settings, <b>named inputs</b>, <b>parameters</b>, <b>logs</b>, and a <b>Python script</b> for a report.</p>

  <h2 id="g-wild">5.1 Wildcards</h2>
  <p>Replace the sample name with a <b>wildcard</b>, <code>{{sample}}</code>. When Snakemake needs <code>results/mapped/NA12878.sorted.bam</code>, it matches it against the output pattern <code>results/mapped/{{sample}}.sorted.bam</code>, sets <code>sample = NA12878</code>, and fills the same value into the inputs. Inside the command, the value is <code>{{wildcards.sample}}</code>. Here is <code>map_reads</code> with wildcards – replace yours with it:</p>
  {snippet(MAP_WILD)}
  {activity('Activity 5.1 · Any sample', [
      task('g-map', 'Replace your <code>map_reads</code> rule with the one above, and save. (Two strings next to each other in <code>shell:</code> are joined into one command – on purpose this time.)', check='has:workflow/Snakefile|wildcards\\.sample'),
      task('g-rest', 'Now do the same in <code>index_bam</code>, <code>flagstat</code>, <code>call_variants</code> and <code>filter_variants</code> yourself: replace <code>NA12878</code> by <code>{sample}</code> in their <code>input:</code> and <code>output:</code>. Leave <code>rule all</code> as it is – it names the files you want. Save.', check='has:workflow/Snakefile|variants/\\{sample\\}\\.filtered'),
      task('g-dry', f'Dry run: {cmd("snakemake -n")}. Which job has a different reason from the others? Then run it: {cmd("snakemake --cores 1")}', auto='smk:run argv~--cores ok=true'),
  ])}
  {q('g-why', 'Which job re-ran because of its own change, and why did the jobs after it re-run too?',
     """<p><b>map_reads</b>: <i>Code has changed since last execution</i> – its command now uses <code>{wildcards.sample}</code>. The jobs downstream re-ran with the reason <i>Input files updated by another job</i>: their input, the BAM file, was about to be remade. Rules whose command did not change (e.g. <code>samtools flagstat {input} &gt; {output}</code>) were only re-run because their input changed – replacing <code>NA12878</code> by <code>{sample}</code> in a file pattern changes no command.</p>""")}

  <h2 id="g-config">5.2 Settings from the config file</h2>
  <p>You created <code>config/config.yaml</code> in chapter 3. <code>configfile:</code> reads it into a Python dictionary called <code>config</code> – exactly what you did with <code>yaml.safe_load</code> in the notebook. Replace your <code>rule all</code> (at the top) with this block, which uses the sample list from the config file and <code>expand()</code>:</p>
  {snippet(TOP_CONFIG)}
  {activity('Activity 5.2 · One list of samples', [
      task('g-top', f'Replace <code>rule all</code> with the block above, save, and dry-run: {cmd("snakemake -n")}. Nothing to do – the same files, now listed by <code>expand()</code>.', check='has:workflow/Snakefile|configfile'),
      task('g-new', 'Pretend a second sample arrives: in <code>config/config.yaml</code> add a line <code>  - NA12891</code> under <code>- NA12878</code>, save, and dry-run: ' + cmd('snakemake -n') + '. Read the error: which files would the new sample need? Then remove <code>NA12891</code> again (we have no reads for it) and save.', auto='smk:run argv~-n ok=false'),
  ])}
  {q('g-newq', 'What did Snakemake tell you about the new sample, and what would you need to do to analyse it?',
     """<p>A <b>MissingInputException</b> for rule <code>map_reads</code>: to make <code>results/mapped/NA12891.sorted.bam</code> it needs <code>data/raw/NA12891_R1.fastq</code> and <code>data/raw/NA12891_R2.fastq</code>, which do not exist. With the two read files in <code>data/raw/</code>, one command would analyse the new sample – and leave NA12878’s results untouched, because they are up to date.</p>""")}

  <h2 id="g-named">5.3 Named inputs and logs</h2>
  <p>With several inputs, <b>names</b> are clearer than positions: <code>ref=…</code> in <code>input:</code>, <code>{{input.ref}}</code> in the command. A <code>log:</code> file keeps each program’s messages. Replace your <code>map_reads</code> with this version – it also takes the reference from the config file:</p>
  {snippet(MAP_NAMED)}
  <table class="table small">
    <tr><td><code>ref=REF</code></td><td>a <b>named</b> input, used as <code>{{input.ref}}</code> in the command. <code>REF</code> is the Python variable set from the config file at the top of the Snakefile.</td></tr>
    <tr><td><code>threads: 1</code></td><td>how many CPU cores the job may use; <code>{{threads}}</code> puts the number into the command (<code>-t</code> is minimap2’s option for threads).</td></tr>
    <tr><td><code>log:</code></td><td>the job’s log file, <code>{{log}}</code> in the command.</td></tr>
    <tr><td><code>2&gt; {{log}}</code></td><td>sends a program’s messages – its <i>standard error</i>, stream 2 – to the log file. <code>2&gt;&gt;</code> adds them to the end of the file instead of replacing it, so both programs’ messages are kept.</td></tr>
  </table>
  {activity('Activity 5.3 · Names, logs – and the AI again', [
      task('g-mapnamed', f'Replace <code>map_reads</code> with the version above, save, and run {cmd("snakemake --cores 1")}. Then read the log: {cmd("cat logs/map_reads/NA12878.log")}', check='has:workflow/Snakefile|input\\.r1'),
      task('g-ainamed', f'Ask the assistant to do the same for variant calling: {ai("gen:named", "Rewrite call_variants with named inputs")} Press <b>Replace rule call_variants in Snakefile</b> under its code.', auto='ai:insert target=snakefile rules~call_variants'),
      task('g-runnamed', f'Run it: {cmd("snakemake --cores 1")}. If it fails, read the error <b>and</b> the log file it points to – then fix the rule, or ask the assistant about the error.', auto='smk:run argv~--cores ok=true'),
  ])}
  {q('g-input', 'What was wrong with the assistant’s <code>call_variants</code>, and why did <code>index_bam</code> run this time?',
     """<p>The command still used <code>{input}</code>, which – with named inputs too – means <b>all</b> the inputs: the reference, the BAM <i>and the index</i>. bcftools tried to read the <code>.bai</code> index as a BAM file (“Exec format error”) and failed. The fix is <code>-f {input.ref} {input.bam}</code>. <code>index_bam</code> ran because the new rule lists the index as an input (<code>bai=…</code>): now a job needs it.</p>""")}

  <h2 id="g-params">5.4 Parameters</h2>
  <p>The filter thresholds are settings, so they belong in the config file. <code>params:</code> passes values to the command as <code>{{params.name}}</code> – and Snakemake records them.</p>
  {activity('Activity 5.4 · Thresholds from the config file', [
      task('g-aiparams', f'{ai("gen:params", "Ask how to take the thresholds from config.yaml")} Press <b>Replace rule filter_variants in Snakefile</b> under the rule, and run {cmd("snakemake --cores 1")}.', auto='ai:insert target=snakefile rules~filter_variants'),
      task('g-fixparams', 'If it fails, find out why (the program’s help text is printed with the error) and fix the command – keeping <code>{params.min_qual}</code> and <code>{params.min_depth}</code>. Run again until it works.', check='has:workflow/Snakefile|QUAL>=\\{params\\.min_qual\\}'),
      task('g-md5', f'Same result as ever? {cmd("bcftools view -H results/variants/NA12878.filtered.vcf.gz | md5sum")}', auto='term:command line~md5sum code=0 line~filtered'),
      task('g-30', f'Change <code>min_qual: 20</code> to <code>min_qual: 30</code> in <code>config/config.yaml</code>, save, and dry-run: {cmd("snakemake -n")}. Then run it and count: {cmd("snakemake --cores 1")} {cmd("bcftools view -H results/variants/NA12878.filtered.vcf.gz | wc -l")} Finally set it back to <b>20</b>, save, and run {cmd("snakemake --cores 1")} once more.', check='has:config/config.yaml|min_qual: 30'),
  ])}
  {q('g-options', 'What was wrong with the assistant’s <code>filter_variants</code>? What does this tell you about AI-written code?',
     """<p>It used options that <b>do not exist</b>: bcftools filter has no <code>--min-qual</code> or <code>--min-depth</code> (bcftools printed “unrecognized option” and its real options). The fix is an expression, <code>-i 'QUAL&gt;={params.min_qual} &amp;&amp; INFO/DP&gt;={params.min_depth}'</code>. AI assistants can invent plausible options, functions or even tools; check against <code>--help</code> or the manual, and test.</p>""")}
  {q('g-30q', 'With <code>min_qual: 30</code>, how many variants passed – and what reason did the dry run give?', """<p><b>13</b> (two calls have QUAL between 20 and 30). The reason was <i>Params have changed since last execution</i>, showing the old and new value – Snakemake compared the recorded parameters of the existing file with the config file. Only <code>filter_variants</code> and what comes after it re-ran.</p>""", accept=r'\b13\b', hint='count with wc -l after the run')}

  <h2 id="g-script">5.5 A Python script in the pipeline</h2>
  <p>The last step makes a table and a plot with Python. With <code>script:</code>, Snakemake runs a Python script and gives it an object called <code>snakemake</code>, so the script reads <code>snakemake.input</code> and writes <code>snakemake.output.table</code> instead of file names written into it. Read the script with the table below it: some ideas are from chapter 3, the others are new – you need to read them, not write them.</p>
  {codefile('workflow/scripts/summarise_variants.py', SUMMARISE)}
  <table class="table small">
    <tr><td><code>for path in snakemake.input:</code></td><td>repeat the indented lines for each input file of the rule</td></tr>
    <tr><td><code>path.split("/")[-1].split(".")[0]</code></td><td><code>.split("/")</code> cuts text into a list at every <code>/</code>; <code>[-1]</code> is the <i>last</i> item (the file name); the part before the first <code>.</code> is the sample name</td></tr>
    <tr><td><code>with gzip.open(path, "rt") as vcf:</code></td><td>open a compressed file as text (<code>"rt"</code>) for the indented block</td></tr>
    <tr><td><code>if …: continue</code></td><td>if the line is a header line, skip to the next line</td></tr>
    <tr><td><code>line.rstrip("\\n").split("\\t")</code></td><td>remove the line break, then cut the line into its tab-separated columns</td></tr>
    <tr><td><code>chrom, pos, … = fields[0], int(fields[1]), …</code></td><td>several variables at once; <code>int()</code> and <code>float()</code> turn text into numbers</td></tr>
    <tr><td><code>"SNP" if … else "indel"</code></td><td>one of two values, chosen by a condition</td></tr>
    <tr><td><code>rows.append({{…}})</code></td><td>add one row – a dictionary – to the list <code>rows</code></td></tr>
    <tr><td><code>pd.DataFrame(rows)</code>, <code>.groupby([…]).size()</code></td><td>pandas: a table made from the rows; count the rows in each group (sample, chromosome, type, genotype)</td></tr>
    <tr><td><code>plt.subplots()</code>, <code>ax.hist(…)</code>, <code>fig.savefig(…)</code></td><td>matplotlib: make a figure, draw a histogram of the QUAL values, save it as a file</td></tr>
  </table>
  {snippet(SUMMARISE_RULE)}
  {activity('Activity 5.5 · A report', [
      task('g-sfile', 'Create the script (button above).', check='exists:workflow/scripts/summarise_variants.py'),
      task('g-srule', 'Add <code>rule summarise</code> (above) at the end of the Snakefile, and add <code>"results/report/variant_summary.tsv",</code> to the inputs of <code>rule all</code>. Save.', check='has:workflow/Snakefile|rule summarise'),
      task('g-srun', f'Run it: {cmd("snakemake --cores 1")} – then {cmd("cat results/report/variant_summary.tsv")} and {cmd("open results/report/variant_quality.png")}', check='exists:results/report/variant_summary.tsv'),
  ])}
  {q('g-table', 'According to the summary table, how many homozygous (1/1) variants are there on <code>human_CYP2C9</code>?', '<p><b>3</b> – and 8 heterozygous (0/1) ones; <i>CYP2C19</i> has 4, all heterozygous.</p>', accept=r'(^|\D)3(\D|$)', hint='the row with human_CYP2C9 and 1/1')}
  {ai('gen:script', 'Ask the assistant to explain the script')}
  <p class="small">Your Snakefile should now be equivalent to this reference version – compare, or replace yours if it will not work:</p>
  {codefile(SF, SNAKEFILE_C, button='Replace my Snakefile with this')}

  <div class="optional">
    <h3>Extension: a one-liner from the assistant <span class="pill ext">Extension</span></h3>
    <p>{ai('gen:count', 'Ask for a quick rule that counts variants per chromosome')} Add it, run <code>snakemake --cores 1 results/qc/NA12878.per_chrom.txt</code>, and work out from the error message how to fix it.</p>
  </div>
'''
    return chapter('generalise', 5, 'Any sample, any setting', 'editor', 'One Snakefile for any sample', 50,
                   'Make the pipeline general – wildcards, a config file, named inputs, parameters, logs and a Python script – and watch Snakemake keep track of what each result was made with.', body)


def ch_envs():
    body = f'''
  <p>Same data, same Snakefile, same settings – different results? It happens when the <b>software</b> differs. In Claerbout’s principle, the scholarship includes “the complete software development environment”.</p>

  <h2 id="e-what">6.1 Which software are you using?</h2>
  <p>This practical uses the package manager <b>conda</b> – here Miniforge, with the conda-forge and bioconda channels. An <b>environment</b> is a folder of programs with particular versions; the active one decides which program a command runs.</p>
  {activity('Activity 6.1 · Look at your environment', [
      task('e-list', f'{cmd("conda env list")} – the <code>*</code> marks the active environment (also shown in the prompt).', auto='term:command line~conda env list code=0'),
      task('e-pkgs', f'{cmd("conda list")} – every package in it, with version, build and channel.', auto='term:command line~conda list code=0'),
      task('e-which', f'{cmd("which bcftools")} then {cmd("bcftools --version | head -2")}', auto='term:command line~bcftools --version code=0'),
      task('e-py', f'Python has its own package list: {cmd("python --version")} {cmd("pip list")}', auto='term:command line~pip list code=0'),
  ])}
  {q('e-hts', 'Which version of the htslib library does <code>bcftools --version</code> say it uses – and which htslib version does <code>conda list</code> show?',
     """<p>bcftools says <b>htslib 1.10</b>, conda lists <b>htslib 1.17</b> (the one samtools uses). In this browser each program was compiled with its own built-in copies of its libraries (htslib, zlib), so bcftools always uses htslib 1.10 – and one environment can hold every program. On a real computer the programs in an environment share its <b>single</b> copy of each library – whichever version conda chose. Keep this in mind for the next activities.</p>""", accept=r'1\.10', hint='the second line of bcftools --version')}

  <h2 id="e-colleague">6.2 The same pipeline on another computer</h2>
  <p>A second run of this pipeline – the same rules, config and data, with the variant-calling steps in a conda environment – was made on a Linux computer with <code>snakemake --use-conda</code>. Its result is in <code>/data/course/colleague/</code>.</p>
  {activity('Activity 6.2 · Spot the difference', [
      task('e-readme', f'{cmd("cat /data/course/colleague/README.md")}', auto='term:command line~colleague/README code=0'),
      task('e-md5', f'Compare checksums: {cmd("bcftools view -H /data/course/colleague/NA12878.filtered.vcf.gz | md5sum")} (yours was <code>{FILTERED_MD5}</code>).', auto='term:command line~colleague code=0 line~md5sum'),
      task('e-files', f'Save both sets of records as text and compare them line by line – in a scratch folder outside the project, because nothing in <code>results/</code> is made by hand: {cmd("mkdir -p ~/compare && bcftools view -H results/variants/NA12878.filtered.vcf.gz > ~/compare/mine.txt")} {cmd("bcftools view -H /data/course/colleague/NA12878.filtered.vcf.gz > ~/compare/colleague.txt")}', check='exists:~/compare/colleague.txt'),
      task('e-diff', f'{cmd("diff ~/compare/mine.txt ~/compare/colleague.txt | head -20")} – <code>&lt;</code> lines are yours, <code>&gt;</code> lines the colleague’s.', auto='term:command line~diff code=0'),
      task('e-cut', f'Just position, genotype and quality: {cmd("cut -f 1,2,6,10 ~/compare/mine.txt > ~/compare/mine.short")} {cmd("cut -f 1,2,6,10 ~/compare/colleague.txt > ~/compare/colleague.short")} {cmd("diff ~/compare/mine.short ~/compare/colleague.short")}', auto='term:command line~diff line~short'),
      task('e-hdr', f'The VCF header records the software that made it: {cmd("bcftools view -h /data/course/colleague/NA12878.filtered.vcf.gz | grep Version")} {cmd("bcftools view -h results/variants/NA12878.filtered.vcf.gz | grep Version")}', auto='term:command line~grep Version code=0'),
      task('e-env', f'And the colleague’s environment: {cmd("grep -E \'bcftools|htslib\' /data/course/colleague/calling-environment.yml")}', auto='term:command line~calling-environment code=0'),
  ])}
  {q('e-same', 'What is the same in the two runs, and what differs? What caused the difference?',
     """<p><b>The same:</b> all 15 variant sites, their alleles and their genotypes. <b>Different:</b> the QUAL of three calls (e.g. <code>human_CYP2C9</code> 23059: 111 in yours, 132 in theirs; 1402: 50 vs 56; 20827: 167 vs 165), the genotype likelihoods (PL) of several calls, and statistics in INFO such as DP4. <b>Cause:</b> the software. The colleague’s environment file asked for <code>bcftools=1.10</code>, which conda read as “any 1.10.x” and resolved to <b>bcftools 1.10.2</b> – a build from 2020 – installed with <b>htslib 1.21</b>; yours is bcftools 1.10 with htslib 1.10. The <code>##bcftoolsVersion</code> header lines record the htslib each run actually used. Same code, same data, different environment – different numbers.</p>""")}
  {activity('Activity 6.3 · Does it matter?', [
      task('e-120', f'Imagine a stricter filter, <code>QUAL&gt;=120</code>. Count what each run keeps – yours, by changing the setting on the command line: {cmd("snakemake --cores 1 --config min_qual=120")} {cmd("bcftools view -H results/variants/NA12878.filtered.vcf.gz | wc -l")}', auto='smk:run argv~min_qual=120 ok=true'),
      task('e-120c', f'…and the colleague’s: {cmd("bcftools filter -i \'QUAL>=120\' /data/course/colleague/NA12878.filtered.vcf.gz | bcftools view -H | wc -l")}', auto='term:command line~QUAL>=120 code=0'),
      task('e-back', f'Go back to the settings in the config file: {cmd("snakemake --cores 1")}', auto='smk:run argv~--cores ok=true'),
  ])}
  {q('e-120q', 'How many variants does each run keep with <code>QUAL&gt;=120</code>?', '<p><b>6 in yours, 7 in the colleague’s</b>: the call at <code>human_CYP2C9</code> 23059 has QUAL 111 in one run and 132 in the other. A version difference that looks harmless can change which variants are reported.</p>', accept=r'6.*7|7.*6', hint='two numbers: yours and the colleague’s')}

  <h2 id="e-one">6.3 One environment for everything?</h2>
  {activity('Activity 6.4 · Ask the assistant', [
      task('e-aione', f'{ai("env:one", "Ask for a conda environment file for the whole pipeline")} Press <b>Save as</b>, then build it: {cmd("conda env create -f workflow/envs/pipeline.yaml")} Read the whole message.', auto='conda:create ok=false name=cyp2c19-pipeline'),
      task('e-aizlib', 'Press <b>✦ Ask the AI assistant about this error</b> under the message.', auto='ai:answer entry=env:zlib'),
      task('e-aisame', 'Ask its follow-up question: <b>without Python, would that environment give exactly the same bcftools and htslib as your pipeline?</b> Compare with the colleague’s environment.', auto='ai:answer entry=env:same'),
      task('e-exact', f'Try to pin bcftools <b>and</b> its library exactly, in one environment with samtools: {cmd("conda create -n exact samtools=1.17 bcftools==1.10 htslib==1.10")}', auto='conda:create ok=false name=exact'),
  ])}
  {q('e-conflictq', 'The assistant called its single environment “fully reproducible”. What was wrong with it – and why does pinning bcftools and htslib exactly in one environment not help either?',
     """<p><b>It could not even be built.</b> The bioconda builds of minimap2 2.22, samtools 1.17 and bcftools 1.10 were made against zlib 1.2 and need zlib older than 1.3, while Python 3.13 needs zlib 1.3.1 or newer – and an environment holds only one version of each library, so conda refuses (<i>LibMambaUnsatisfiableError</i>).</p>
  <p><b>Without Python its pins are loose:</b> <code>bcftools=1.10</code> installs the newest 1.10.x (1.10.2), htslib is not mentioned so the solver picks the newest one that fits (1.21 today), and pandas and matplotlib have no version at all – exactly the colleague’s environment, with its different QUAL values.</p>
  <p><b>Exact pins conflict too:</b> <code>htslib==1.10</code> for bcftools rules out samtools 1.17, which needs htslib 1.17 or newer. One environment for everything is fragile; pipelines give each step its own small, exactly pinned environment.</p>""")}

  <h2 id="e-rules">6.4 One environment per rule</h2>
  <p>Create three environment files. The tools and their htslib are pinned exactly (<code>==</code>) – the lesson of the colleague’s run. For the Python step, minor versions are enough here; <code>conda env export</code> records the exact ones (6.5).</p>
  {codefile('workflow/envs/mapping.yaml', ENV_MAPPING)}
  {codefile('workflow/envs/calling.yaml', ENV_CALLING)}
  {codefile('workflow/envs/python.yaml', ENV_PYTHON, note='In this browser, Python and its packages come from Pyodide (Python 3.13, pandas 2.3, matplotlib 3.8): Snakemake says so when it builds this environment. The file is written for a real computer, where matplotlib 3.9 is the first version available for Python 3.13.')}
  <p>Then give every rule a <code>conda:</code> line with its environment (the path is relative to the Snakefile): <code>envs/mapping.yaml</code> for <code>map_reads</code>, <code>index_bam</code> and <code>flagstat</code>; <code>envs/calling.yaml</code> for <code>call_variants</code> and <code>filter_variants</code>; <code>envs/python.yaml</code> for <code>summarise</code>. Put the <code>conda:</code> line <b>above</b> <code>shell:</code> or <code>script:</code> – Snakemake allows nothing after them. For example:</p>
  {snippet(CONDA_EXAMPLE)}
  {activity('Activity 6.5 · Environments in the Snakefile', [
      task('e-rmone', f'The assistant’s environment file cannot be built – delete it, so that nobody mistakes it for part of the pipeline: {cmd("rm workflow/envs/pipeline.yaml")}', auto='term:command line~rm line~pipeline.yaml code=0'),
      task('e-envfiles', 'Create the three environment files (buttons above).', check='exists:workflow/envs/python.yaml'),
      task('e-conda', 'Add a <code>conda:</code> line to each of the six rules, and save.', check='has:workflow/Snakefile|envs/python\\.yaml'),
      task('e-use', f'Run with the environments: {cmd("snakemake --cores 1 --use-conda")}. Snakemake builds each environment once (in <code>.snakemake/conda/</code>). What reason does it give for re-running the jobs?', auto='smk:run argv~--use-conda ok=true'),
      task('e-pinmd5', f'Still the same result? {cmd("bcftools view -H results/variants/NA12878.filtered.vcf.gz | md5sum")}', auto='term:command line~md5sum code=0 line~filtered'),
  ])}
  {q('e-pins', 'What is the difference between <code>bcftools=1.10</code> and <code>bcftools==1.10</code>, and why pin <code>htslib</code> as well?',
     """<p><code>bcftools=1.10</code> means “any version starting with 1.10” – 1.10, 1.10.1 or 1.10.2 – and conda picks the newest, together with whatever htslib that build needs; <code>bcftools==1.10</code> means exactly 1.10. The numbers come from the library as much as from bcftools itself, and the dependency ranges of old packages are sometimes widened later – which is how a 2020 build of bcftools came to be installed with htslib 1.21 – so pinning <code>htslib==1.10</code> too fixes the part that actually changed the colleague’s results. The most exact records are a lock file of the package files (<code>conda list --explicit --md5</code>; Snakemake uses one saved as <code>envs/calling.linux-64.pin.txt</code>) or a container image; <code>conda env export</code> lists every package with version and build.</p>""")}
  {callout('warn', 'Always the same way', """<p>Once your rules have <code>conda:</code> environments, run the pipeline with <code>--use-conda</code> every time. Without it, Snakemake notices that the software would not be the one recorded for your results (<i>Software environment definition has changed</i>) and wants to re-run everything – the provenance record at work.</p>""")}

  <h2 id="e-record">6.5 Record the environment</h2>
  {activity('Activity 6.6 · Records', [
      task('e-mkcalling', f'Make the calling environment as a named environment: {cmd("conda env create -n calling -f workflow/envs/calling.yaml")}', auto='conda:create ok=true name=calling'),
      task('e-export', f'The packages you asked for: {cmd("conda env export -n calling --from-history")}; every package, version and build: {cmd("conda env export -n calling")} (on a real computer this lists about thirty packages: every library bcftools needs).', auto='conda:export name=calling'),
      task('e-freeze', f'Python packages in the format of a <code>requirements.txt</code> file: {cmd("pip freeze")}', auto='term:command line~pip freeze code=0'),
      task('e-summary', f'Snakemake’s own record of every result – which rule made it, when, from which inputs, with which command: {cmd("snakemake --summary --use-conda")} and {cmd("snakemake -D --use-conda | head -4")}', auto='smk:run argv~--summary ok=true'),
  ])}
  {mcq('e-best', 'A reader wants the <i>exact</i> software you used, years from now. Which record helps most?', [
      ('the environment files with loose pins (<code>bcftools=1.10</code>)', False, 'They allow many different builds – the colleague’s run shows what that does.'),
      ('<code>conda env export</code> (every package with version and build), a lock file, or a container image', True, 'An exact list of what was installed – or a frozen image of it – can recreate the environment.'),
      ('the version numbers in the README', False, 'Better than nothing, but they miss the libraries and builds.'),
  ])}
  {ai('env:record', 'Ask the assistant how to record software versions')} {ai('env:container', 'Ask about containers')}
  <p class="small">Your finished Snakefile – for comparison, or to replace yours if it will not work:</p>
  {codefile(SF, SNAKEFILE_D, button='Replace my Snakefile with this')}
'''
    return chapter('envs', 6, 'Software environments', 'terminal', 'Software environments', 40,
                   'Same data, same Snakefile, same settings – different results. Find out why, pin the software, and record the environment.', body)
