"""Helpers and the canonical files of the pipelines practical (used by the chapters,
the tests and the native check of the exported project)."""
import html
import re

# ----------------------------------------------------------------------------- helpers


def esc(s):
    return html.escape(str(s), quote=True)


def c(s):
    """inline code"""
    return f'<code>{esc(s)}</code>'


def show(cmd, label='show me'):
    """a button that types a command into the terminal (the student presses Enter)"""
    return f'<button class="do showme" type="button" data-term="{esc(cmd)}">{label}</button>'


def run(cmd, label='run it'):
    """a button that types and runs a command"""
    return f'<button class="do" type="button" data-term-run="{esc(cmd)}">{label}</button>'


def cmd(line, label='show me'):
    return f'{c(line)} {show(line, label)}'


def edit(path, label=None):
    return f'<button class="do showme" type="button" data-edit="{esc(path)}">{label or "open " + esc(path.split("/")[-1])}</button>'


def ai(entry, label):
    return f'<button class="do ai" type="button" data-ai="{esc(entry)}">{label}</button>'


def bench(name, label):
    return f'<button class="do showme" type="button" data-bench="{esc(name)}">{label}</button>'


def codefile(path, text, create=True, note=None, button='Create this file'):
    """a file shown in the instructions, with Create / Copy buttons"""
    b = f'<button class="do" type="button" data-file-create="{esc(path)}">{button}</button>' if create else ''
    n = f'<div class="cf-note">{note}</div>' if note else ''
    return (f'<div class="codefile" data-path="{esc(path)}"><div class="cf-head"><span class="cf-name">{esc(path)}</span>'
            f'<span class="grow"></span>{b}<button class="btn small" type="button" data-copy-code="1">Copy</button></div>'
            f'<pre class="codeblock">{esc(text.rstrip())}</pre>{n}</div>')


def snippet(text, cls=''):
    """code to read (and copy), not a whole file"""
    return (f'<div class="codefile snippet {cls}"><div class="cf-head"><span class="grow"></span>'
            f'<button class="btn small" type="button" data-copy-code="1">Copy</button></div>'
            f'<pre class="codeblock">{esc(text.rstrip())}</pre></div>')


def nb(code, tag, runit=True, label=None):
    """notebook code with a button that puts it in a new cell (and runs it)"""
    lab = label or ('▶ Run it in the notebook' if runit else 'Put it in the notebook')
    return (f'<div class="codefile nbcode" data-tag="{esc(tag)}"><div class="cf-head"><span class="cf-name">Python</span><span class="grow"></span>'
            f'<button class="do" type="button" data-nb-code="{"run" if runit else "insert"}">{lab.replace("▶ ", "")}</button>'
            f'<button class="btn small" type="button" data-copy-code="1">Copy</button></div>'
            f'<pre class="codeblock">{esc(code.rstrip())}</pre></div>')


def task(tid, body, auto=None, check=None):
    a = f' data-auto="{esc(auto)}"' if auto else ''
    k = f' data-check="{esc(check)}"' if check else ''
    return f'<li data-task="{esc(tid)}"{a}{k}>{body}</li>'


def activity(title, tasks, extra=''):
    return f'<div class="activity">\n  <div class="act-t">{title}</div>\n  <ol class="steps">\n    ' + '\n    '.join(tasks) + f'\n  </ol>{extra}\n</div>'


def q(qid, text, model, accept=None, hint=None, placeholder=None):
    a = f' data-accept="{esc(accept)}"' if accept else ''
    h = f' data-hint="{esc(hint)}"' if hint else ''
    p = f' data-placeholder="{esc(placeholder)}"' if placeholder else ''
    return f'<div class="q" data-q="{esc(qid)}"{a}{h}{p}>\n  <div class="q-text">{text}</div>\n  <div class="q-model">{model}</div>\n</div>'


def mcq(qid, text, options, model=None):
    """options: list of (html, correct:bool, why)"""
    labs = ''.join(
        f'<label{" data-correct" if ok else ""} data-why="{esc(why)}"><input type="radio"> {opt}</label>'
        for opt, ok, why in options)
    m = f'\n  <div class="q-model">{model}</div>' if model else ''
    return f'<div class="q" data-q="{esc(qid)}" data-type="mcq">\n  <div class="q-text">{text}</div>\n  <div class="mcq">{labs}</div>{m}\n</div>'


def callout(kind, title, body):
    return f'<div class="callout {kind}">\n  <div class="co-t">{title}</div>\n  {body}\n</div>'


def chapter(cid, num, title, bench_name, h1, minutes, lede, body):
    return (f'<section class="chapter" id="{cid}" data-num="{num}" data-title="{esc(title)}" data-bench="{bench_name}" hidden>\n'
            f'  <h1>{h1}</h1>\n'
            f'  <div class="meta-row"><span class="pill time">≈ {minutes} min</span></div>\n'
            f'  <p class="lede">{lede}</p>\n{body}\n</section>\n')


# ----------------------------------------------------------------------------- the files students make

README_START = """# CYP2C19 / CYP2C9 variant calling for NA12878

## What this project does
Maps short exome reads of sample NA12878 to two slices of the human
reference genome (hg19) that cover parts of the genes CYP2C19 and CYP2C9,
calls the variants and summarises them.

## Data (data/raw – read-only, never edited)
| File | Where it came from |
| --- | --- |
| NA12878_R1.fastq | /data/course/SRR098401_1.fastq – run SRR098401, 1000 Genomes |
| NA12878_R2.fastq | /data/course/SRR098401_2.fastq |
| reference.fa (+ .fai) | /data/course/hg19_CYP2C_slices.fa – hg19 chr10:96,530,001-96,560,000 and chr10:96,699,001-96,725,000 |

Checksums: data/raw/MD5SUMS – check them with  md5sum -c data/raw/MD5SUMS

## How to run
(to be written when the pipeline exists)

## Author and date
(your name, today's date)
"""

GITIGNORE = """# Everything the pipeline can make again is not kept in version control
results/
logs/
.snakemake/
"""

RUN_ALL = r"""#!/bin/bash
# Variant calling for NA12878 – every step, in order (first version)
mkdir -p results/mapped results/qc results/variants

# 1. map the reads and sort the alignments
minimap2 -ax sr -R '@RG\tID:NA12878\tSM:NA12878' \
    data/raw/reference.fa data/raw/NA12878_R1.fastq data/raw/NA12878_R2.fastq \
    | samtools sort -o results/mapped/NA12878.sorted.bam -

# 2. index the BAM file, and count the mapped reads
samtools index results/mapped/NA12878.sorted.bam
samtools flagstat results/mapped/NA12878.sorted.bam > results/qc/NA12878.flagstat.txt

# 3. call the variants and keep the good ones
bcftools mpileup -f data/raw/reference.fa results/mapped/NA12878.sorted.bam -Ou \
    | bcftools call -mv -Oz -o results/variants/NA12878.raw.vcf.gz
bcftools filter -i 'QUAL>=20 && INFO/DP>=5' -Oz -o results/variants/NA12878.filtered.vcf.gz \
    results/variants/NA12878.raw.vcf.gz

echo "All steps finished."
"""

CONFIG = """# Settings for the pipeline. Change them here, not in the Snakefile.
samples:
  - NA12878

reference: data/raw/reference.fa

# variant filters
min_qual: 20
min_depth: 5
"""

HELLO = """# List the files the pipeline will make for each sample in config/config.yaml
import yaml

with open("config/config.yaml") as f:
    config = yaml.safe_load(f)

print("Reference:", config["reference"])
for sample in config["samples"]:
    print(f"results/variants/{sample}.filtered.vcf.gz")
    print(f"results/qc/{sample}.flagstat.txt")
"""

SMK_MAP = r"""rule map_reads:
    input:
        "data/raw/reference.fa",
        "data/raw/NA12878_R1.fastq",
        "data/raw/NA12878_R2.fastq",
    output:
        "results/mapped/NA12878.sorted.bam",
    shell:
        "minimap2 -ax sr -R '@RG\\tID:NA12878\\tSM:NA12878' {input} | samtools sort -o {output} -"
"""

SMK_INDEX = """rule index_bam:
    input:
        "results/mapped/NA12878.sorted.bam",
    output:
        "results/mapped/NA12878.sorted.bam.bai",
    shell:
        "samtools index {input}"
"""

SMK_FLAGSTAT = """rule flagstat:
    input:
        "results/mapped/NA12878.sorted.bam",
    output:
        "results/qc/NA12878.flagstat.txt",
    shell:
        "samtools flagstat {input} > {output}"
"""

SMK_CALL = """rule call_variants:
    input:
        "data/raw/reference.fa",
        "results/mapped/NA12878.sorted.bam",
    output:
        "results/variants/NA12878.raw.vcf.gz",
    shell:
        "bcftools mpileup -f {input} -Ou | bcftools call -mv -Oz -o {output}"
"""

SMK_FILTER = """rule filter_variants:
    input:
        "results/variants/NA12878.raw.vcf.gz",
    output:
        "results/variants/NA12878.filtered.vcf.gz",
    shell:
        "bcftools filter -i 'QUAL>=20 && INFO/DP>=5' -Oz -o {output} {input}"
"""

SMK_ALL1 = """rule all:
    input:
        "results/variants/NA12878.filtered.vcf.gz",
        "results/qc/NA12878.flagstat.txt",
"""

SNAKEFILE_B = ("# Variant calling for NA12878 – first version (one sample, names written out)\n\n"
               + SMK_ALL1 + "\n\n" + SMK_MAP + "\n\n" + SMK_INDEX + "\n\n" + SMK_FLAGSTAT + "\n\n" + SMK_CALL + "\n\n" + SMK_FILTER)

# the final pipeline: generalised, with logs, params, a script and one environment per step
SNAKEFILE_D = r'''# =====================================================================
#  Variant calling for CYP2C19 / CYP2C9 – a reproducible pipeline
#  Run from the project folder:   snakemake --cores 1 --use-conda
# =====================================================================

configfile: "config/config.yaml"

SAMPLES = config["samples"]
REF = config["reference"]


# the target rule: the files we want at the end
rule all:
    input:
        expand("results/variants/{sample}.filtered.vcf.gz", sample=SAMPLES),
        expand("results/qc/{sample}.flagstat.txt", sample=SAMPLES),
        "results/report/variant_summary.tsv",


# 1. align the reads to the reference and sort the alignments
rule map_reads:
    input:
        ref=REF,
        r1="data/raw/{sample}_R1.fastq",
        r2="data/raw/{sample}_R2.fastq",
    output:
        "results/mapped/{sample}.sorted.bam",
    log:
        "logs/map_reads/{sample}.log",
    threads: 1
    conda:
        "envs/mapping.yaml"
    shell:
        "minimap2 -ax sr -t {threads} -R '@RG\\tID:{wildcards.sample}\\tSM:{wildcards.sample}' "
        "{input.ref} {input.r1} {input.r2} 2> {log} "
        "| samtools sort -o {output} - 2>> {log}"


# 2. index the sorted BAM file
rule index_bam:
    input:
        "results/mapped/{sample}.sorted.bam",
    output:
        "results/mapped/{sample}.sorted.bam.bai",
    conda:
        "envs/mapping.yaml"
    shell:
        "samtools index {input}"


# 3. mapping statistics
rule flagstat:
    input:
        "results/mapped/{sample}.sorted.bam",
    output:
        "results/qc/{sample}.flagstat.txt",
    conda:
        "envs/mapping.yaml"
    shell:
        "samtools flagstat {input} > {output}"


# 4. call variants
rule call_variants:
    input:
        ref=REF,
        bam="results/mapped/{sample}.sorted.bam",
        bai="results/mapped/{sample}.sorted.bam.bai",
    output:
        "results/variants/{sample}.raw.vcf.gz",
    log:
        "logs/call_variants/{sample}.log",
    conda:
        "envs/calling.yaml"
    shell:
        "bcftools mpileup -f {input.ref} {input.bam} -Ou 2> {log} "
        "| bcftools call -mv -Oz -o {output} 2>> {log}"


# 5. keep good-quality calls
rule filter_variants:
    input:
        "results/variants/{sample}.raw.vcf.gz",
    output:
        "results/variants/{sample}.filtered.vcf.gz",
    params:
        min_qual=config["min_qual"],
        min_depth=config["min_depth"],
    conda:
        "envs/calling.yaml"
    shell:
        "bcftools filter -i 'QUAL>={params.min_qual} && INFO/DP>={params.min_depth}' "
        "-Oz -o {output} {input}"


# 6. a table and a plot, made by a Python script
rule summarise:
    input:
        expand("results/variants/{sample}.filtered.vcf.gz", sample=SAMPLES),
    output:
        table="results/report/variant_summary.tsv",
        plot="results/report/variant_quality.png",
    conda:
        "envs/python.yaml"
    script:
        "scripts/summarise_variants.py"
'''

# the same without the conda: lines (end of the chapter on generalising)
SNAKEFILE_C = re.sub(r'\n    conda:\n        "envs/\w+\.yaml"', '', SNAKEFILE_D).replace(
    '#  Run from the project folder:   snakemake --cores 1 --use-conda',
    '#  Run from the project folder:   snakemake --cores 1')

SUMMARISE = '''# Summarise the filtered variants: a table of counts and a plot of call quality.
# Snakemake runs this script and gives it an object called `snakemake`
# with the rule's input, output, params, wildcards, ...
import gzip

import pandas as pd
import matplotlib

matplotlib.use("Agg")  # draw plots into files, not on a screen
import matplotlib.pyplot as plt

rows = []
for path in snakemake.input:
    sample = path.split("/")[-1].split(".")[0]  # results/variants/NA12878.filtered.vcf.gz -> NA12878
    with gzip.open(path, "rt") as vcf:
        for line in vcf:
            if line.startswith("#"):  # skip the header lines
                continue
            fields = line.rstrip("\\n").split("\\t")
            chrom, pos, ref, alt, qual = fields[0], int(fields[1]), fields[3], fields[4], float(fields[5])
            genotype = fields[9].split(":")[0]
            kind = "SNP" if len(ref) == 1 and len(alt) == 1 else "indel"
            rows.append({"sample": sample, "chrom": chrom, "pos": pos, "ref": ref, "alt": alt,
                         "qual": qual, "genotype": genotype, "type": kind})

variants = pd.DataFrame(rows)
summary = variants.groupby(["sample", "chrom", "type", "genotype"]).size().reset_index(name="variants")
summary.to_csv(snakemake.output.table, sep="\\t", index=False)

fig, ax = plt.subplots(figsize=(6, 4))
for sample, group in variants.groupby("sample"):
    ax.hist(group["qual"], bins=20, alpha=0.7, label=sample)
ax.set_xlabel("Variant quality (QUAL)")
ax.set_ylabel("Number of variants")
ax.set_title("Quality of the filtered variant calls")
ax.legend()
fig.tight_layout()
fig.savefig(snakemake.output.plot, dpi=100)
'''

ENV_MAPPING = """channels:
  - conda-forge
  - bioconda
dependencies:
  - minimap2==2.22
  - samtools==1.17
  - htslib==1.17
"""

ENV_CALLING_LOOSE = """channels:
  - conda-forge
  - bioconda
dependencies:
  - bcftools=1.10
"""

ENV_CALLING = """channels:
  - conda-forge
  - bioconda
dependencies:
  - bcftools==1.10
  - htslib==1.10
"""

ENV_PYTHON = """channels:
  - conda-forge
dependencies:
  - python=3.13
  - pandas=2.3
  - matplotlib=3.9
"""

README_FINAL_RUN = """## How to run
Needs conda (e.g. Miniforge) and Snakemake 9, on Linux, a Mac or Windows with WSL:

    conda create -n snakemake -c conda-forge -c bioconda snakemake=9.27
    conda activate snakemake
    snakemake --cores 1 --use-conda

On a Mac with an Apple processor (M1 or later) the pinned tool versions exist
only for Intel Macs, so run  CONDA_SUBDIR=osx-64 snakemake --cores 1 --use-conda
(macOS runs them with Rosetta 2).

Settings are in config/config.yaml; the software of each step is in workflow/envs/.
"""

# the checksum of the variant records made by the pipeline (bcftools 1.10 + htslib 1.10)
FILTERED_MD5 = '09dd51431f385ed3863928eee0064125'
N_RAW = 60
N_FILTERED = 15

FILES_FINAL = {
    'workflow/Snakefile': SNAKEFILE_D,
    'config/config.yaml': CONFIG,
    'workflow/envs/mapping.yaml': ENV_MAPPING,
    'workflow/envs/calling.yaml': ENV_CALLING,
    'workflow/envs/python.yaml': ENV_PYTHON,
    'workflow/scripts/summarise_variants.py': SUMMARISE,
    '.gitignore': GITIGNORE,
}

# ----------------------------------------------------------------------------- snippets shown in chapters 4–6

FLAGSTAT_BLANK = '''rule flagstat:
    input:
        "____",
    output:
        "____",
    shell:
        "samtools flagstat {input} > {output}"'''

INDEX_BLANK = '''rule index_bam:
    input:
        "____",
    output:
        "____",
    shell:
        "samtools index {input}"'''

FILTER_BLANK = '''rule filter_variants:
    input:
        "results/variants/NA12878.raw.vcf.gz",
    output:
        "results/variants/NA12878.filtered.vcf.gz",
    shell:
        "____"'''

MAP_WILD = r'''rule map_reads:
    input:
        "data/raw/reference.fa",
        "data/raw/{sample}_R1.fastq",
        "data/raw/{sample}_R2.fastq",
    output:
        "results/mapped/{sample}.sorted.bam",
    shell:
        "minimap2 -ax sr -R '@RG\\tID:{wildcards.sample}\\tSM:{wildcards.sample}' {input} "
        "| samtools sort -o {output} -"'''

TOP_CONFIG = '''configfile: "config/config.yaml"

SAMPLES = config["samples"]
REF = config["reference"]


rule all:
    input:
        expand("results/variants/{sample}.filtered.vcf.gz", sample=SAMPLES),
        expand("results/qc/{sample}.flagstat.txt", sample=SAMPLES),'''

MAP_NAMED = r'''rule map_reads:
    input:
        ref=REF,
        r1="data/raw/{sample}_R1.fastq",
        r2="data/raw/{sample}_R2.fastq",
    output:
        "results/mapped/{sample}.sorted.bam",
    log:
        "logs/map_reads/{sample}.log",
    threads: 1
    shell:
        "minimap2 -ax sr -t {threads} -R '@RG\\tID:{wildcards.sample}\\tSM:{wildcards.sample}' "
        "{input.ref} {input.r1} {input.r2} 2> {log} "
        "| samtools sort -o {output} - 2>> {log}"'''

SUMMARISE_RULE = '''rule summarise:
    input:
        expand("results/variants/{sample}.filtered.vcf.gz", sample=SAMPLES),
    output:
        table="results/report/variant_summary.tsv",
        plot="results/report/variant_quality.png",
    script:
        "scripts/summarise_variants.py"'''

CONDA_EXAMPLE = '''rule call_variants:
    input:
        ...
    output:
        ...
    log:
        ...
    conda:
        "envs/calling.yaml"
    shell:
        ...'''
