# Third-party software, data and source provenance

This practical bundles independently licensed programs and libraries. Each keeps its own licence: the MIT licence of the Biowasm build framework does **not** relicense the GNU utilities, and none of the licences below applies to the practical's own text and code. Keep each component's notices and licence files when copying or redistributing its files.

## Command-line programs (WebAssembly, run in the browser)

These are real programs compiled to WebAssembly by [Biowasm](https://biowasm.com). They run on the student's own computer, inside the web page.

| Program | Version | Upstream licence | Included licence / notice | Source |
| --- | --- | --- | --- | --- |
| minimap2 | 2.22 | MIT | [LICENSE](assets/vendor/biowasm/minimap2/2.22/LICENSE), [NOTICE](assets/vendor/biowasm/minimap2/2.22/NOTICE.txt) | [upstream release](https://github.com/lh3/minimap2/tree/v2.22) |
| GNU coreutils: `cat`, `head`, `tail`, `wc`, `sort`, `uniq`, `cut`, `tr`, `tee`, `comm`, `join`, `paste`, `seq` | 8.32 | GPL version 3 or later | [LICENSE](assets/vendor/biowasm/coreutils/8.32/LICENSE), [NOTICE](assets/vendor/biowasm/coreutils/8.32/NOTICE.txt) | [release source](https://ftp.gnu.org/gnu/coreutils/coreutils-8.32.tar.xz) |
| GNU Awk (`gawk`, also as `awk`) | 5.1.0 | GPL version 3 or later | [LICENSE](assets/vendor/biowasm/gawk/5.1.0/LICENSE), [NOTICE](assets/vendor/biowasm/gawk/5.1.0/NOTICE.txt) | [release source](https://ftp.gnu.org/gnu/gawk/gawk-5.1.0.tar.xz) |
| GNU grep | 3.7 | GPL version 3 or later | [LICENSE](assets/vendor/biowasm/grep/3.7/LICENSE), [NOTICE](assets/vendor/biowasm/grep/3.7/NOTICE.txt) | [release source](https://ftp.gnu.org/gnu/grep/grep-3.7.tar.xz) |
| GNU sed | 4.8 | GPL version 3 or later | [LICENSE](assets/vendor/biowasm/sed/4.8/LICENSE), [NOTICE](assets/vendor/biowasm/sed/4.8/NOTICE.txt) | [release source](https://ftp.gnu.org/gnu/sed/sed-4.8.tar.xz) |
| SAMtools | 1.17 | MIT/Expat | [LICENSE](assets/vendor/biowasm/samtools/1.17/LICENSE) | [samtools](https://github.com/samtools/samtools/tree/1.17) |
| BCFtools (with its built-in HTSlib 1.10) | 1.10 | MIT/Expat (GPL only if built with the GNU Scientific Library); HTSlib: MIT/Expat and modified 3-clause BSD | [LICENSE](assets/vendor/biowasm/bcftools/1.10/LICENSE), [HTSlib 1.10](assets/vendor/biowasm/bcftools/1.10/HTSLIB-1.10-LICENSE) | [bcftools](https://github.com/samtools/bcftools/tree/1.10) |
| HTSlib utilities `bgzip`, `tabix` | 1.17 | MIT/Expat and modified 3-clause BSD | [LICENSE](assets/vendor/biowasm/htslib/1.17/LICENSE) | [htslib](https://github.com/samtools/htslib/tree/1.17) |
| Biowasm base module and the Aioli runner | 1.0.0 | MIT | [notice](assets/vendor/biowasm/LICENSE.txt) | [biowasm](https://github.com/biowasm/biowasm), [aioli](https://github.com/biowasm/aioli) |

The full GPL version 3 text is in [assets/vendor/licenses/GPL-3.0.txt](assets/vendor/licenses/GPL-3.0.txt). Copyright statements for the GNU programs and their included dependencies remain in their source releases; a general licence label in this table does not replace the notices in individual upstream source files.

**Where the builds came from.** SAMtools, BCFtools, the HTSlib utilities, the base module and Aioli were inherited from the reads-to-variants practical. minimap2 and the GNU utilities were inherited from the *Variant Lab* exploration site, which downloaded them from `https://biowasm.com/cdn/v3/NAME/VERSION/` on 30 September 2026; each of those component folders has its `NOTICE.txt` and `SHA256SUMS`.

**Local modifications.** The `.wasm` programs and `.data` files are unmodified. The JavaScript loaders record each program's exit status, and Aioli has an added method (`execIO`) that runs a program with real standard input, output and error. For this practical `execIO` also remounts the shared file system before each run and resets a program that aborted. All changes are listed in [assets/vendor/biowasm/RUNTIME-PATCHES.txt](assets/vendor/biowasm/RUNTIME-PATCHES.txt), and [execio-source.txt](assets/vendor/biowasm/execio-source.txt) is the readable source of the added method.

**Source code.** The release sources of the four GNU programs are included in [assets/vendor/licenses/sources/](assets/vendor/licenses/sources/) (`coreutils-8.32.tar.xz`, `gawk-5.1.0.tar.xz`, `grep-3.7.tar.xz`, `sed-4.8.tar.xz`); their SHA-256 values match those in [source-archives.json](assets/vendor/licenses/source-archives.json), which also records the official download URLs (and those of minimap2 and of Bowtie2, see below). The Biowasm recipe snapshot is pinned at commit [`97bb232`](https://github.com/biowasm/biowasm/tree/97bb23225892ba5cc59ba0deac8b212b957db66a); a small local copy of its licence, build configuration, helper scripts and relevant port patches is in [assets/vendor/licenses/biowasm-build/](assets/vendor/licenses/biowasm-build/), listed with checksums in [biowasm-build-manifest.json](assets/vendor/licenses/biowasm-build-manifest.json). Both manifests also cover Bowtie2 2.4.2, which the exploration site used; Bowtie2 is not part of this practical. The snapshot is a pinned recipe for inspection and rebuilding; the original CDN compilation commit is not known, so it is **not** a claim that rebuilding it gives identical binaries. GPL terms for object-code distribution and Corresponding Source are in section 6 of the GPL; whoever hosts this site should keep `assets/vendor/licenses/` (sources, build recipes, licence texts) and this file with it.

## JavaScript libraries (bundled)

| Library | Version | Licence | Files |
| --- | --- | --- | --- |
| CodeMirror 5 (editor, with the Python, YAML, shell and Markdown modes and three add-ons) | 5.65.18 | MIT | [assets/vendor/codemirror/LICENSE](assets/vendor/codemirror/LICENSE) |
| DOMPurify (cleans the AI assistant's formatted answers before display) | 3.4.16 | Apache 2.0 or MPL 2.0 | [assets/vendor/dompurify/LICENSE](assets/vendor/dompurify/LICENSE) |
| JSZip (project and workflow downloads; includes pako) | 3.10.1 | MIT or GPL v3 (pako: MIT) | [assets/vendor/jszip/LICENSE.markdown](assets/vendor/jszip/LICENSE.markdown) |
| Viz.js (Graphviz for `snakemake --dag \| dot`) | 3.31.0 | MIT | [assets/vendor/viz/LICENSE](assets/vendor/viz/LICENSE), [NOTICE](assets/vendor/viz/NOTICE.txt) |
| – Graphviz, compiled into Viz.js | 16.1.0 | Eclipse Public License 1.0 | [GRAPHVIZ-EPL-1.0.txt](assets/vendor/viz/GRAPHVIZ-EPL-1.0.txt); [source](https://gitlab.com/graphviz/graphviz/-/tree/16.1.0) |
| – Expat, compiled into Viz.js | 2.8.5 | MIT | [EXPAT-COPYING.txt](assets/vendor/viz/EXPAT-COPYING.txt); [source](https://github.com/libexpat/libexpat/releases/tag/R_2_8_5) |

`viz-global.js` is the unmodified `dist/viz-global.js` of the npm package `@viz-js/viz` 3.31.0; its SHA-256 and the build details are in the Viz.js notice.

## Loaded at run time, not bundled

**Pyodide 0.29.5** (MPL 2.0) – CPython 3.13 compiled to WebAssembly – is downloaded by the student's browser from the jsDelivr CDN (`https://cdn.jsdelivr.net/pyodide/v0.29.5/full/`) the first time Python is needed. It provides CPython 3.13.2 (PSF licence) and the Pyodide builds of NumPy 2.2.5 (BSD 3-clause), pandas 2.3.3 (BSD 3-clause), Matplotlib 3.8.4 (Matplotlib licence, BSD-compatible), PyYAML 6.0.2 (MIT) and their dependencies, each under its own licence (see the [Pyodide package list](https://pyodide.org/en/0.29.5/usage/packages-in-pyodide.html)). The README explains how to host Pyodide with the site instead.

In **live mode** only, the AI assistant sends the student's messages to the AI service the student chose, using the student's own API key. No AI model or service is part of the site.

## Re-implementations written for this practical

These files contain no code from the programs they imitate. Their names, options and messages follow the real programs, so that what students learn transfers:

| File | Imitates | Licence of the real program |
| --- | --- | --- |
| `assets/py/smk.py` | [Snakemake](https://snakemake.github.io) 9.27 (the commonly used core) | MIT |
| `assets/js/galaxy.js` | the [Galaxy](https://galaxyproject.org) interface, histories, workflow editor and `.ga` workflow format; tool IDs name real Galaxy Tool Shed tools | Academic Free License 3.0 |
| `assets/js/conda.js`, `assets/js/shell-extra.js` | [conda](https://docs.conda.io) (environments, `create`, `install`, `list`, `env export`, solver messages) with the real versions and dependencies of the packages used | BSD 3-clause |

## Data

| Data | Source | Terms |
| --- | --- | --- |
| `data/course/SRR098401_1.fastq`, `_2.fastq` | NA12878 exome reads (run SRR098401), reconstructed from the [1000 Genomes phase 3 exome alignment](https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/phase3/data/NA12878/exome_alignment/) of NA12878 | open data of the 1000 Genomes Project, distributed by the International Genome Sample Resource ([IGSR disclaimer](https://www.internationalgenome.org/IGSR_disclaimer), [data use FAQ](https://www.internationalgenome.org/faq/do-i-need-permission-to-use-igsr-data-in-my-own-scientific-research/)); NA12878 is the widely used public reference sample (Coriell cell line GM12878) |
| `data/course/hg19_CYP2C_slices.fa` (+ `.fai`) | two slices of the UCSC hg19 human reference (chr10) | [UCSC Genome Browser conditions of use](https://genome.ucsc.edu/conditions.html) |
| `data/course/colleague/` | made for this practical by running its pipeline with Snakemake 9.27.0 and conda 26.7.3 on Linux | part of the practical |

How the reads and reference were extracted – URLs, hashes, counts and limitations – is recorded in [data/course/provenance.json](data/course/provenance.json) and summarised in [data/course/README.md](data/course/README.md). The reads are real sequencing data; none are simulated.
