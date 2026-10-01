"""Chapters 7–10: Galaxy, the AI agent, which is best (burn, build, export), reference."""
from chapters_lib import *


def ch_galaxy():
    body = f'''
  {callout('concept', 'A graphical workflow engine', """<p>Galaxy (usegalaxy.org, usegalaxy.eu and many institutional servers) runs bioinformatics tools through web forms, keeps every dataset in a <b>history</b> with a full record of how it was made, and lets you build <b>workflows</b> by connecting tools on a canvas. James Taylor and Anton Nekrutenko began Galaxy at Penn State; it was first described in 2005. In James Taylor’s words: <i>“Good ideas don’t have owners – they belong to everyone.”</i></p>
  <p class="small muted">The Galaxy tab is a practice server that works like Galaxy and runs the same WebAssembly programs as your terminal and your Snakefile.</p>""")}

  <h2 id="x-data">7.1 Data into a history</h2>
  {activity('Activity 7.1 · Upload', [
      task('x-open', f'Open the Galaxy tab. {bench("galaxy", "open Galaxy")} Tools are on the left, your history on the right.', auto='app:bench name=galaxy'),
      task('x-up', 'Press <b>Upload Data</b> (top left), tick <code>SRR098401_1.fastq</code>, <code>SRR098401_2.fastq</code> and <code>hg19_CYP2C_slices.fa</code> (or your copies in <code>data/raw/</code>), and press <b>Start</b>. Galaxy detects the format of each file (<i>fastqsanger</i>, <i>fasta</i>).', check='gxUploads:3'),
      task('x-peek', 'Click the name of a dataset in the history to expand it; the <b>eye</b> shows its contents.', auto='gx:view'),
  ])}
  <p class="small muted">This practice server keeps your history only while the page is open (your workflows are saved). A real Galaxy server keeps every history until you delete it.</p>

  <h2 id="x-tool">7.2 One tool, by hand</h2>
  {activity('Activity 7.2 · Map with minimap2', [
      task('x-form', 'Click <b>Map with minimap2</b> in the tool panel.', auto='gx:toolform tool=minimap2'),
      task('x-run', 'Check the inputs – the reference, the forward reads (<code>_1</code>) and the reverse reads (<code>_2</code>) – and the preset (<code>sr</code>), then press <b>Run tool</b>. Watch the new dataset: grey = queued, yellow = running, green = done.', auto='gx:job tool=minimap2 state=ok'),
      task('x-info', 'Expand the new BAM dataset and click its <b>ⓘ</b> (dataset details). Scroll through: tool ID and version, dependencies, command line, parameters.', auto='gx:details tool=minimap2'),
  ])}
  {q('x-cmd', 'Compare Galaxy’s command line with your <code>map_reads</code> rule. What is the same? What did Galaxy add, and what does it record for every dataset?',
     """<p>The same programs and options: <code>minimap2 -x sr -a</code> with a read group, piped into <code>samtools sort</code>. Galaxy first <b>links</b> the history datasets into a job working folder under simple names (<code>ln -s … input_f.fastq</code>), writes to <code>output.bam</code> and moves the result into its dataset store; it also indexes BAM datasets itself. For every dataset it records the <b>tool ID and version</b> (<code>…/iuc/minimap2/minimap2/2.22+galaxy0</code>), the <b>dependencies</b> with versions (minimap2 2.22, samtools 1.17), every <b>parameter</b>, the <b>input datasets</b> and the exact <b>command line</b> – provenance, automatically, without the user writing anything down.</p>""")}

  <h2 id="x-build">7.3 Build the workflow</h2>
  <p>Now draw the whole pipeline. Each box is a step; each connection carries a dataset from an <b>output</b> (dot on the right of a box) to an <b>input</b> (dot on the left). Only matching data types can be connected.</p>
  {activity('Activity 7.3 · The workflow editor', [
      task('x-new', 'Click <b>Workflows</b> (top bar of the Galaxy tab), then <b>Create a new workflow</b>.', auto='gx:editor'),
      task('x-inputs', 'Press <b>+ Input dataset</b> three times. Click each box to set its <b>label</b> (forward reads, reverse reads, reference) and <b>format</b> (fastqsanger for the reads, fasta for the reference).', check='gxWf:inputs'),
      task('x-tools', 'With the editor open, click these tools in the tool panel to add them: <b>Map with minimap2</b>, <b>Samtools flagstat</b>, <b>bcftools mpileup</b>, <b>bcftools call</b>, <b>bcftools filter</b>.', check='gxWf:tools'),
      task('x-bad', 'Try a wrong connection: drag from the <b>forward reads</b> output to the <b>reference</b> input of bcftools mpileup. What happens?', auto='gx:badwire'),
      task('x-wire', 'Now connect everything correctly: the three inputs into minimap2; minimap2’s BAM into flagstat and into mpileup (and the reference into mpileup); mpileup into call; call into filter. Click an empty part of the canvas: the <b>Checks</b> panel on the right says when every input is connected. (<b>Tidy layout</b> arranges the boxes.)', check='gxWf:wired'),
      task('x-param', 'Click the <b>bcftools filter</b> box and check its expression: <code>QUAL&gt;=20 &amp;&amp; INFO/DP&gt;=5</code> – the same as <code>min_qual</code> and <code>min_depth</code> in your config file.', auto='gx:step tool=bcftools_filter'),
  ])}
  {q('x-types', 'Why did Galaxy refuse the first connection? How does that help you?',
     """<p>Every dataset has a <b>datatype</b> and every tool input accepts only some: mpileup’s reference input needs <i>fasta</i>, and the reads are <i>fastqsanger</i>. The editor checks while you build, so mistakes surface immediately rather than as a failed (or silently wrong) job later. On the command line and in a Snakefile nothing checks file types for you – you find out from an error message, or from strange results.</p>""")}

  <h2 id="x-run">7.4 Run it – and compare with Snakemake</h2>
  {activity('Activity 7.4 · One click, five jobs', [
      task('x-go', 'Press <b>Run</b> (in the editor). Check that each input has the right dataset, then press <b>Run workflow</b>.', auto='gx:invoked'),
      task('x-done', 'Watch the jobs finish in the history and on the invocation page (about 15 seconds).', auto='gx:invocation ok=true'),
      task('x-copy', 'On the history dataset made by <b>bcftools filter</b>, click <b>copy to my files</b>. It is copied into <code>~/galaxy/</code>.', auto='gx:copy tool=bcftools_filter'),
      task('x-md5', f'In the terminal: {cmd("ls ~/galaxy")} then compare the checksum of its records with your Snakemake result: {cmd("bcftools view -H ~/galaxy/*filter*.vcf.gz | md5sum")} <span class="small muted">(if you ran bcftools filter more than once, use the full name of one file – press <kbd>Tab</kbd> to complete it)</span>', auto='term:command line~galaxy code=0 line~md5sum'),
  ])}
  {q('x-same', 'Is Galaxy’s result the same as Snakemake’s? Why?',
     f"""<p><b>Yes</b> – the variant records have the same checksum, <code>{FILTERED_MD5}</code>. Two very different engines – one written as code, one drawn on a canvas – ran the same programs, in the same versions, with the same parameters, on the same data. The result depends on data, software and settings, not on the engine. (Galaxy’s VCF <i>files</i> differ from yours in their headers, which record dates and file names – the reason we compare the records.)</p>""",
     accept=rf'^(?![\s\S]*\b(not|no|different|differs?)\b)[\s\S]*\b(yes|same|identical)\b||{FILTERED_MD5[:8]}', hint='compare the two md5sums')}

  <h2 id="x-share">7.5 Extract and share</h2>
  {activity('Activity 7.5 · A workflow from the history', [
      task('x-extract', 'In the history, press <b>Extract workflow</b>. Galaxy turns the jobs in your history into a workflow. Compare it with the one you drew – what is different?', auto='gx:extract'),
      task('x-ga', 'On the <b>Workflows</b> page, save your workflow into your project with <b>to project</b> (it becomes <code>workflow/galaxy/….ga</code>), or download it with <b>.ga</b>. Open the <code>.ga</code> file in the Files tab: it is JSON text describing every step.', auto='gx:export'),
  ])}
  {q('x-rerun', 'What would a colleague need to re-run your Galaxy workflow and get the same result?',
     """<p>The <b>.ga file</b> (it lists every tool by Tool Shed ID and version, every parameter and every connection), a <b>Galaxy server with those tool versions</b> installed, and the <b>same input data</b>, uploaded with the right datatypes. A shared history adds the full record of each dataset. The weak point is the server: re-running depends on a server that still offers those exact tool versions. (The extracted workflow also contains any extra jobs you ran – here the separate minimap2 run – so check it before sharing.)</p>""")}
  {ai('gx:share', 'Ask the assistant how others re-run a Galaxy workflow')}
'''
    return chapter('galaxy', 7, 'The same pipeline in Galaxy', 'galaxy', 'The same pipeline in Galaxy', 40,
                   'Galaxy runs pipelines without programming: tools in forms, a history of every dataset, and workflows you build by drawing connections. Build yours – and compare the result with Snakemake’s.', body)


def ch_agent():
    f1 = '~/ai-agent/NA12878_variants.vcf'
    body = f'''
  {callout('warn', 'Before you start', """<p>The agent in this practical is a <b>scripted simulation</b>: it does not run any analysis. It was written to show, in miniature, problems people meet with AI tools – confident answers that are not based on your data, invented details, and answers that change when you ask again. Your job is to find out what its result is worth <b>from the evidence alone</b>, as if it were real. Real agents can run tools – and when they do, the same questions apply: which tool, which version, which data, and where is the record?</p><p>If you have switched the assistant to <b>live</b> mode (⚙), use the <b>suggested tasks</b> under the box for 8.1–8.4: a task you type goes to a real agent instead (see the extension at the end of this chapter).</p>""")}

  <h2 id="a-task">8.1 Give the agent the job</h2>
  {activity('Activity 8.1 · Delegate', [
      task('a-open', f'Open the AI assistant and choose the <b>Agent</b> tab. {bench("assistant", "open the assistant")}', auto='ai:tab tab=agent'),
      task('a-call', 'Give it the task <b>“Call the variants for NA12878 from my reads and give me a VCF file”</b> (the first suggestion under the box). Read what it says it did, and what it concludes.', auto='agent:file run=run1'),
  ])}
  {q('a-trust', 'Before you look at the file: what would you need to know to trust this result?',
     """<p>Which data it used (your reads? which reference?), which programs and versions, which parameters and filters, what happened at each step (logs), and ideally a way to re-run it and get the same file. In short: its provenance – the same things your Snakefile and Galaxy history record.</p>""")}

  <h2 id="a-check">8.2 Check the file</h2>
  {activity('Activity 8.2 · Evidence', [
      task('a-head', f'The records: {cmd("grep -v \'^##\' " + f1 + " | head -5")}', auto='term:command line~ai-agent code=0'),
      task('a-hdr', f'Which software and reference does the file’s header name? {cmd("grep -E \'^##(source|reference|contig|GATKCommandLine)\' " + f1)}', auto='term:command line~GATKCommandLine code=0'),
      task('a-gatk', f'Is that software available to you at all? {cmd("type gatk bwa")} {cmd("conda list | grep -i gatk")}', auto='term:command line~gatk'),
      task('a-star2', f'<i>CYP2C19*2</i> (rs4244285) is at hg19 chr10:96,541,616 – position 11,616 of your <code>human_CYP2C19</code> slice. Your pipeline’s call: {cmd("bcftools view -H results/variants/NA12878.filtered.vcf.gz | grep -w 11616")} The agent’s: {cmd("grep rs4244285 " + f1)}', auto='term:command line~rs4244285 code=0'),
      task('a-17', f'The agent also reports <i>CYP2C19*17</i> (rs12248560, GRCh38 chr10:94,761,900 = hg19 chr10:96,521,657). Look up the region your reads come from: {cmd("grep -A2 human_CYP2C19 /data/course/provenance.json | head -8")}', auto='term:command line~provenance.json code=0'),
  ])}
  {q('a-evidence', 'List at least three pieces of evidence that the agent’s file was not made from your reads with your reference.',
     """<ul>
  <li>The positions are on <b>GRCh38</b> <code>chr10</code> (header: <code>Homo_sapiens_assembly38.fasta</code>, contig length 133,797,422) – you gave it hg19 slices called <code>human_CYP2C19</code> and <code>human_CYP2C9</code>.</li>
  <li>The header names <b>GATK HaplotypeCaller 4.5.0.0</b> – not installed anywhere in your environment.</li>
  <li>It calls <b>rs4244285 homozygous (1/1)</b> with all 104 reads showing A (<code>AD 0,104</code>), but your reads show both alleles: DP4 <code>40,4,46,2</code> – about 44 high-quality reference bases and 48 alternative ones, a heterozygote (0/1).</li>
  <li>It reports <b>rs12248560</b> at GRCh38 chr10:94,761,900 – that is hg19 96,521,657, <b>outside</b> the region the reads were collected from (96,530,001–96,560,000): there are no reads there to call anything from.</li>
</ul>""")}
  <p class="small muted">The position of rs4244285 on GRCh38 (chr10:94,781,859) and hg19 (chr10:96,541,616) can be checked in <a href="https://www.ncbi.nlm.nih.gov/clinvar/variation/16897/" target="_blank" rel="noopener">ClinVar</a>; rs12248560 in <a href="https://www.ncbi.nlm.nih.gov/clinvar/variation/39357/" target="_blank" rel="noopener">ClinVar</a> too.</p>

  <h2 id="a-again">8.3 Ask again – and ask for proof</h2>
  {activity('Activity 8.3 · Reproducible?', [
      task('a-again', 'Ask the agent to <b>run the analysis again</b>. Read its new conclusion.', auto='agent:file run=run2'),
      task('a-diff', f'{cmd("md5sum ~/ai-agent/*.vcf")} {cmd("grep rs4244285 ~/ai-agent/*.vcf")}', auto='term:command line~ai-agent code=0 line~md5sum'),
      task('a-how', 'Ask it <b>which exact commands and software versions</b> it used. Compare the answer with the two file headers.', auto='agent:answer entry=ag:how'),
      task('a-proof', 'Ask it to <b>show the log files and the BAM file</b>.', auto='agent:answer entry=ag:proof'),
      task('a-real', 'Finally ask: <b>did you actually run these tools on my reads?</b>', auto='agent:answer entry=ag:real'),
  ])}
  {q('a-once', 'The two runs disagree (1/1 and 0/1 for rs4244285, “poor” and “intermediate” metaboliser). What would you have concluded if you had asked only once – and how could you have known which run to believe?',
     """<p>You would have reported whichever answer you happened to get – and with a single run nothing looks wrong. From the agent’s output alone there was no way to decide between them: no record of the inputs, programs, versions or parameters, no logs, no intermediate files, and no way to re-run the same process. Only your own reads (8.2) could settle it. Its excuse – that variant calling is “stochastic” – does not hold either: a genotype changing from 1/1 to 0/1 at about 100 reads is not a small difference, and your pinned pipeline gave the same checksum in the browser, in Galaxy and on another computer. Only an analysis you can re-run, and that gives the same answer when you do, can be checked.</p>""")}
  {q('a-story', 'When asked, the agent listed commands and versions. Why is that not provenance?',
     """<p>It is a <b>story told afterwards</b>, not a <b>record made while running</b>. Nothing links it to the file: it contradicts the second run (BWA-MEM2 2.2.1 and GATK 4.4.0.0), names files that do not exist (the BAM, the logs – “no longer available”), and in the end the agent admits it did not run anything. Provenance has to be produced by the process itself – like Snakemake’s metadata or Galaxy’s job records – and be checkable, for example by re-running.</p>""")}

  <h2 id="a-glass">8.4 An agent that works in the open</h2>
  <p>AI agents <i>can</i> be useful here – if they work through your pipeline, where every step leaves a record. (Agents that really run tools usually show the commands they ran; that transcript is part of the provenance, but only part: it does not record the software versions or prove which files were used. A pipeline does.)</p>
  {activity('Activity 8.4 · A glass box', [
      task('a-pipe', 'Give the agent the task <b>“Run my Snakemake pipeline for me and tell me what you did”</b>. Then look at the <b>Terminal</b>: its commands are there, with their complete output.', auto='agent:glassbox ok=true'),
  ])}
  {q('a-claerbout', 'In Claerbout’s terms, what is the difference between what the two agents gave you?',
     """<p>The first agent gave you <b>advertising</b>: a file and a confident story, with no code, data record or environment behind it – nothing that can be inspected or re-run. The second ran <b>your</b> pipeline, so the <b>scholarship</b> exists: the Snakefile, the config, the environment files, the data with checksums, and Snakemake’s record of every job – visible in your terminal and in <code>.snakemake/metadata</code>. It does not matter who (or what) typed the commands, as long as the record is made by the process and can be checked.</p>""")}
  <div class="optional">
    <h3>Extension: a real agent <span class="pill ext">Extension</span></h3>
    <p>With a live model connected (⚙ in the assistant – for example a free Google Gemini key), a task you <b>type</b> in the Agent tab goes to a <b>real agent</b>: the model chooses a command, runs it in your terminal, reads the output and decides what to do next. It works in a folder of its own, <code>~/ai-agent/live-1</code> (then <code>live-2</code>, …), with copies of the course data; anything it changes elsewhere is undone. Each step is a request to the AI service, so a task uses about 5–15 of your free requests.</p>
    {activity('Extension · A real agent', [
        task('a-live', 'In the Agent tab, type the task <b>“Call the variants for NA12878 from the reads in input/ and give me a filtered VCF file”</b>. Watch its commands in the <b>Terminal</b>, then read its report.', auto='agent:live ok=true'),
        task('a-live2', 'Give it <b>exactly the same task again</b>, and compare the two runs: the commands and options it chose, the files it made, and the number of variants. For each run’s VCF, a checksum of the records: <code>bcftools view -H FILE | md5sum</code>.', auto='agent:live ok=true run>1'),
    ])}
    {q('a-live-q', 'This agent really ran the tools on your reads. Is its result as trustworthy as your pipeline’s? What record is there of how it was made, and what is missing?',
       """<p>It is far better than the simulation: the commands, their output and the files are real, and you saw them happen. But it is not a pipeline. The commands and options – mapping preset, read groups, calling model, filters – were <b>chosen during the run</b>; a second run often chooses differently, and its results then differ. The transcript stays in the browser tab, not with the results; nothing pins the software versions; and giving the agent the task again does not repeat the same steps. To make the result reproducible, turn its commands into rules in your Snakefile, with pinned environments: use the agent to help <b>write</b> the pipeline, not to produce the result.</p>""")}
  </div>
  {callout('info', 'Using AI in an analysis', """<ul>
    <li>Use AI to <b>write and explain code</b> you can read, run, test and keep – a Snakefile rule, a script – not to produce results you cannot check.</li>
    <li>Never accept a result without <b>provenance</b>: which data, which software and version, which parameters – recorded by the process, not described afterwards.</li>
    <li><b>Check</b> AI output: run it, read the errors, look at file headers, compare checksums with a trusted run.</li>
    <li><b>Say</b> where AI was used (tool, version, for what) in your methods or README.</li>
    <li>Never paste <b>personal or patient data</b> into an AI tool.</li>
  </ul>""")}
  <div class="optional">
    <h3>Clean up <span class="pill ext">Tidy</span></h3>
    <p>The agent’s files should not be mistaken for results later: {cmd("rm -r ~/ai-agent")}</p>
  </div>
'''
    return chapter('agent', 8, 'An AI agent', 'assistant', 'An AI agent: results without provenance', 30,
                   'An AI agent can do the whole analysis for you and hand you a file. Convenient – but can you check how it was made?', body)


def ch_compare():
    readme_run = README_FINAL_RUN + f"""
## Checking a re-run
The variant records of a correct run have this checksum (on a Mac: md5 instead of md5sum):

    gunzip -c results/variants/NA12878.filtered.vcf.gz | grep -v '^#' | md5sum
    {FILTERED_MD5}  -
"""
    body = f'''
  <h2 id="c-burn">9.1 Burn, build, view</h2>
  <p>Claerbout’s test: can every result be deleted and rebuilt, with one command, identically?</p>
  {activity('Activity 9.1 · The test', [
      task('c-burn', f'<b>Burn</b> – let Snakemake delete every output file it made (log files and empty folders stay): {cmd("snakemake --delete-all-output")} then {cmd("ls -R results")}', auto='smk:run argv~--delete-all-output ok=true'),
      task('c-build', f'<b>Build</b> – one command: {cmd("snakemake --cores 1 --use-conda")}', auto='smk:run argv~--use-conda ok=true'),
      task('c-view', f'<b>View</b> – the same result? {cmd("bcftools view -H results/variants/NA12878.filtered.vcf.gz | md5sum")} and {cmd("open results/report/variant_quality.png")}', auto='term:command line~md5sum code=0 line~filtered'),
  ])}
  <div class="optional">
    <h3>Extension: clean <span class="pill ext">Extension</span></h3>
    <p>The fourth command, <b>clean</b>, removes intermediate files. In Snakemake you mark them with <code>temp()</code>: change the output of <code>call_variants</code> to <code>temp("results/variants/{{sample}}.raw.vcf.gz")</code> and save. Then burn and build again – {cmd("snakemake --delete-all-output")} and {cmd("snakemake --cores 1 --use-conda")} – and see Snakemake delete the raw VCF as soon as <code>filter_variants</code> has used it. (A file that already existed is only treated as temporary once it is made again. Keep intermediates you might want to inspect – such as the BAM file – until you are sure.)</p>
  </div>

  <h2 id="c-compare">9.2 Which is best?</h2>
  <table class="table small compare">
    <tr><th></th><th>Bash script</th><th>Snakemake</th><th>Galaxy</th><th>AI agent (black box)</th></tr>
    <tr><th>The pipeline is…</th><td>a text file of commands</td><td>a text file of rules (Python)</td><td>a graph on a server (.ga file)</td><td>a conversation</td></tr>
    <tr><th>Record of how each result was made</th><td>none (unless you add it)</td><td>per output: code, params, inputs, environment, logs</td><td>per dataset: tool, version, parameters, command</td><td>none – a story told afterwards</td></tr>
    <tr><th>Software versions</th><td>whatever is installed</td><td>declared per rule (conda / containers)</td><td>fixed by each tool version on the server</td><td>unknown</td></tr>
    <tr><th>Re-runs only what is needed</th><td>no</td><td>yes</td><td>per job, by hand</td><td>no – and may answer differently</td></tr>
    <tr><th>Stops cleanly on errors</th><td>only with strict mode</td><td>yes, and removes broken outputs</td><td>yes (red datasets)</td><td>you cannot tell</td></tr>
    <tr><th>Many samples, clusters, cloud</th><td>hard</td><td>built in</td><td>possible on a large server</td><td>–</td></tr>
    <tr><th>Getting started</th><td>easy</td><td>some Python and command line</td><td>easiest – forms and menus</td><td>easiest of all</td></tr>
    <tr><th>Sharing</th><td>the file (if it runs elsewhere)</td><td>a folder or git repository; runs wherever conda has the pinned packages</td><td>a .ga file, histories – needs a server with the same tools</td><td>–</td></tr>
  </table>
  {q('c-scenarios', 'Which approach would you choose – and why – for (a) a diagnostic lab running the same analysis on hundreds of exomes a week, under audit; (b) a biologist with no programming experience analysing three samples and sharing the analysis with a collaborator; (c) trying out a new variant caller quickly?',
     """<p>(a) A code-based workflow engine (Snakemake, or Nextflow) with pinned environments or containers, under version control – it scales, runs unattended and records the provenance of every result; a validated Galaxy server is a possible alternative. (b) <b>Galaxy</b>: no programming, a complete history for every dataset, and workflows and histories that can be shared on the same server. (c) Ask an AI assistant to help write the new rule – then add it to your pipeline, so that it runs with a record; not an agent that returns a file. An agent-produced result without provenance is not acceptable in any of the three.</p>""")}
  {q('c-you', 'Which did you find easiest to use, and which gives you the most confidence in a result? Are they the same?',
     """<p>Personal answers. Often the easiest (the agent, or Galaxy) is not the one that gives the most confidence; confidence comes from a record you can check and a result you can regenerate.</p>""")}

  <h2 id="c-export">9.3 Export your project</h2>
  <p>Finish the README: replace its <b>How to run</b> section – the placeholder – with these two sections, and fill in your name and the date. Then download the project. It runs with conda on Linux, on a Mac, or on Windows with WSL.</p>
  {snippet(readme_run)}
  {activity('Activity 9.2 · Take it with you', [
      task('c-readme', 'Complete <code>README.md</code> and save it.', check='has:README.md|use-conda'),
      task('c-zip', '<button class="do" type="button" data-download-project="lite">Download my project (code, settings, data)</button> – everything needed to run the pipeline, without the results (they can be rebuilt). <button class="do showme" type="button" data-download-project="full">… with the results</button>', auto='project:download'),
      task('c-ans', '<button class="do" type="button" data-export-answers="1">Download my answers</button>', auto='answers:export'),
  ])}
  {callout('info', 'Run it on your own computer', f"""<ol>
    <li>Install <a href="https://conda-forge.org/download/" target="_blank" rel="noopener">Miniforge</a> (conda with the conda-forge channel).</li>
    <li>Make an environment with Snakemake: <code>conda create -n snakemake -c conda-forge -c bioconda snakemake=9.27</code>, then <code>conda activate snakemake</code>.</li>
    <li>Unzip the project, <code>cd cyp2c19-pipeline</code>, and run <code>snakemake --cores 1 --use-conda</code>. Snakemake downloads and builds the three environments the first time.
      On a Mac with an Apple processor (M1 or later), run <code>CONDA_SUBDIR=osx-64 snakemake --cores 1 --use-conda</code> instead: these older tool versions were only ever built for Intel Macs, and macOS runs them with Rosetta 2. (The computer is part of the environment, too.)</li>
    <li>Check: <code>bcftools</code> is not on your computer outside the environments, so look at the result with <code>gunzip -c results/variants/NA12878.filtered.vcf.gz | grep -v '^#' | md5sum</code> (on a Mac: <code>md5</code> instead of <code>md5sum</code>) – it should print <code>{FILTERED_MD5}</code>.</li>
  </ol>
  <p class="small muted">We ran the exported project this way on Linux (Snakemake 9.27.0, conda 26.7): same checksum. With <code>CONDA_SUBDIR=osx-64</code> the same three environments resolve for macOS, with the same versions (checked with conda; not run on a Mac).</p>""")}
  {q('c-claerbout', 'Does your exported project meet Claerbout’s principle? What does it contain – and what is still missing?',
     """<p>It contains the <b>data</b> (with checksums and its source in the README), the <b>code</b> (Snakefile and script), the <b>settings</b> (config file), the <b>software environment</b> as pinned environment files, and instructions. Missing or weaker: an exact lock of every package and build (<code>conda env export</code> or a container image), the provenance records themselves (<code>.snakemake/metadata</code>, logs) if you do not include results, the operating system and processor type (these old tool versions exist only for Linux and Intel Macs), a version-control history of how the code changed, and tests. Good enough for a reader to regenerate and check the result – which is the point.</p>""")}
'''
    return chapter('compare', 9, 'Which is best?', 'terminal', 'Burn, build – and which is best?', 30,
                   'Put your pipeline through Claerbout’s test, compare four ways of running an analysis, and take your reproducible project with you.', body)


def ch_ref():
    body = '''
  <h2 id="r-smk">Snakemake</h2>
  <table class="table small">
    <tr><td><code>snakemake -n</code></td><td>dry run: show the jobs and the reason for each, run nothing</td></tr>
    <tr><td><code>snakemake --cores 1</code></td><td>run the pipeline (build the first rule – usually <code>all</code>)</td></tr>
    <tr><td><code>snakemake --cores 1 FILE</code></td><td>build one file (and what it needs)</td></tr>
    <tr><td><code>-p</code></td><td>print the shell commands</td></tr>
    <tr><td><code>--use-conda</code></td><td>run each rule in its <code>conda:</code> environment</td></tr>
    <tr><td><code>-R RULE</code> / <code>-F</code></td><td>force a rule (and everything after it) / everything to run</td></tr>
    <tr><td><code>--config key=value</code></td><td>override a setting of the config file</td></tr>
    <tr><td><code>--dag | dot -Tsvg &gt; dag.svg</code></td><td>draw the graph of jobs (<code>--rulegraph</code>: of rules)</td></tr>
    <tr><td><code>--summary</code>, <code>-D</code></td><td>the record of every output: rule, date, status (and inputs, command)</td></tr>
    <tr><td><code>--delete-all-output</code></td><td>delete every output file the pipeline made (not logs)</td></tr>
    <tr><td><code>--lint</code></td><td>check the Snakefile for common problems</td></tr>
  </table>
  <h2 id="r-rule">A rule</h2>
  <pre class="codeblock">rule call_variants:                        # a name, a colon, an indented body
    input:
        ref=REF,                           # named inputs: {input.ref} in the command
        bam="results/mapped/{sample}.sorted.bam",   # {sample} is a wildcard
    output:
        "results/variants/{sample}.raw.vcf.gz",
    log:
        "logs/call_variants/{sample}.log",
    params:
        depth=250,                         # {params.depth}
    conda:
        "envs/calling.yaml"                # with --use-conda
    shell:
        "bcftools mpileup -d {params.depth} -f {input.ref} {input.bam} -Ou 2&gt; {log} "
        "| bcftools call -mv -Oz -o {output} 2&gt;&gt; {log}"
# braces meant for the shell are doubled:  awk '{{print $1}}'
# script: "scripts/x.py"  runs Python with a `snakemake` object (snakemake.input, snakemake.output ...)</pre>
  <h2 id="r-py">Python</h2>
  <table class="table small">
    <tr><td><code>x = "text"</code>, <code>n = 20</code></td><td>variables: a string (quotes) and a number</td></tr>
    <tr><td><code>[a, b]</code>, <code>xs[0]</code>, <code>len(xs)</code></td><td>a list, its first item, its length – mind the commas</td></tr>
    <tr><td><code>{"k": v}</code>, <code>d["k"]</code></td><td>a dictionary and a lookup</td></tr>
    <tr><td><code>f"{x}.bam"</code>, <code>"{s}.bam".format(s=x)</code></td><td>fill values into text now / later</td></tr>
    <tr><td><code>for x in xs:</code> + indented lines</td><td>repeat for each item</td></tr>
    <tr><td><code>def f(a, b=1):</code> … <code>return</code></td><td>a function with a default argument</td></tr>
  </table>
  <h2 id="r-conda">conda and the shell</h2>
  <table class="table small">
    <tr><td><code>conda env list</code> / <code>conda activate NAME</code></td><td>environments / switch to one</td></tr>
    <tr><td><code>conda list</code>, <code>conda env export</code></td><td>what is installed (exact versions and builds)</td></tr>
    <tr><td><code>conda create -n NAME pkg=1.2</code></td><td><code>=1.2</code>: any 1.2.x; <code>==1.2</code>: exactly 1.2</td></tr>
    <tr><td><code>pip freeze</code></td><td>Python packages as <code>name==version</code></td></tr>
    <tr><td><code>set -euo pipefail</code></td><td>bash strict mode: stop at the first error</td></tr>
    <tr><td><code>md5sum FILES &gt; MD5SUMS</code>, <code>md5sum -c MD5SUMS</code></td><td>record / check checksums</td></tr>
    <tr><td><code>chmod a-w FILE</code></td><td>make read-only</td></tr>
    <tr><td><code>diff A B</code></td><td>compare two text files line by line</td></tr>
  </table>
  <h2 id="r-words">Words</h2>
  <table class="table small">
    <tr><td><b>Pipeline / workflow</b></td><td>a set of steps executed in a defined order to process data</td></tr>
    <tr><td><b>Workflow engine</b></td><td>the software that runs a pipeline (Snakemake, Nextflow, Galaxy)</td></tr>
    <tr><td><b>DAG</b></td><td>directed acyclic graph: the jobs and the files that connect them</td></tr>
    <tr><td><b>Re-entrancy</b></td><td>continuing where a pipeline stopped, redoing only what is needed</td></tr>
    <tr><td><b>Provenance</b></td><td>the record of how a result was made: data, code, parameters, software</td></tr>
    <tr><td><b>Environment</b></td><td>a set of installed programs and libraries with particular versions</td></tr>
    <tr><td><b>Pinning</b></td><td>fixing the exact version of a package</td></tr>
  </table>
  <h2 id="r-read">Further reading</h2>
  <ul class="small">
    <li>Mölder F, Jablonski KP, Letcher B, et al. Sustainable data analysis with Snakemake. <i>F1000Research</i> 2021, 10:33.</li>
    <li>Köster J, Rahmann S. Snakemake – a scalable bioinformatics workflow engine. <i>Bioinformatics</i> 2012; 28(19):2520–2522.</li>
    <li>Leipzig J. A review of bioinformatic pipeline frameworks. <i>Brief Bioinform</i> 2017; 18(3):530–536.</li>
    <li>Jackson M, Kavoussanakis K, Wallace EWJ. Using prototyping to choose a bioinformatics workflow management system. <i>PLoS Comput Biol</i> 2021; 17(2):e1008622.</li>
    <li>Sandve GK, Nekrutenko A, Taylor J, Hovig E. Ten simple rules for reproducible computational research. <i>PLoS Comput Biol</i> 2013; 9(10):e1003285.</li>
    <li>Noble WS. A quick guide to organizing computational biology projects. <i>PLoS Comput Biol</i> 2009; 5(7):e1000424.</li>
    <li>Claerbout J. <a href="https://sepwww.stanford.edu/sep/jon/reproducible.html" target="_blank" rel="noopener">Reproducible computational research</a> (Stanford Exploration Project).</li>
    <li>Claerbout J, Karrenbach M. Electronic documents give reproducible research a new meaning. <i>SEG Technical Program Expanded Abstracts</i> 1992. <a href="https://doi.org/10.1190/1.1822162" target="_blank" rel="noopener">doi:10.1190/1.1822162</a></li>
    <li>Buckheit JB, Donoho DL. WaveLab and reproducible research. In: Antoniadis A, Oppenheim G (eds) <i>Wavelets and Statistics</i>. Lecture Notes in Statistics 103. Springer, 1995: 55–81.</li>
    <li><a href="https://snakemake.readthedocs.io/" target="_blank" rel="noopener">Snakemake documentation</a> · <a href="https://training.galaxyproject.org/" target="_blank" rel="noopener">Galaxy Training Network</a></li>
  </ul>
'''
    return chapter('ref', 10, 'Reference', 'terminal', 'Reference', 5, 'Commands, syntax and words from this practical, in one place.', body)
