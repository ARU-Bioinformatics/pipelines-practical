# Pipelines and reproducibility – a browser practical

**An extension practical that turns the reads-to-variants analysis into a reproducible pipeline – with Snakemake, with Galaxy and with an AI agent – and asks which one meets Claerbout's principle.**

Students set up a project the data-science way, run the analysis by hand and as a bash script, learn the Python they need, write a Snakefile (partly with an AI assistant whose answers contain real-world mistakes), generalise it with wildcards, a config file, logs, parameters and a Python script, pin its software with conda, rebuild the same pipeline graphically as a Galaxy workflow, and test an AI agent that hands back a file without provenance. Every route that runs the pipeline gives the same variant calls (checksum `09dd51431f385ed3863928eee0064125`), and students leave with a project folder that runs on a real computer with `snakemake --cores 1 --use-conda`.

Everything runs in the student's browser: a bash-like terminal with real **minimap2, samtools and bcftools** (WebAssembly), **Python 3.13** with pandas and matplotlib, a **notebook**, a code **editor**, **Snakemake** and **conda**, a **Galaxy**-style server with a graphical workflow editor, and an **AI assistant**. Nothing needs to be installed, and the site is static (HTML, CSS and JavaScript, no build step), so it can be hosted free on **GitHub Pages**.

---

## Contents

1. [The practical](#the-practical)
2. [What is real and what is simulated](#what-is-real-and-what-is-simulated)
3. [Put it on GitHub Pages](#put-it-on-github-pages)
4. [Try it on your own computer](#try-it-on-your-own-computer)
5. [Timetable](#timetable)
6. [The AI assistant and the agent](#the-ai-assistant-and-the-agent)
7. [What students keep](#what-students-keep)
8. [Settings: `config.js`](#settings-configjs)
9. [Editing the content](#editing-the-content)
10. [Files](#files)
11. [Data](#data)
12. [Privacy](#privacy)
13. [Browser support and limitations](#browser-support-and-limitations)
14. [Credits and licences](#credits-and-licences)

---

## The practical

One page, `index.html`, with the instructions on the left and a workbench on the right (Terminal · Files · Notebook · Galaxy · AI assistant). It builds on the *Reads to variants* practical (the same NA12878 reads around *CYP2C19* and *CYP2C9*), with minimap2 in place of BWA.

| Chapter | What students do | Workbench | Time |
|---|---|---|---|
| 0 · Start here | Claerbout's principle and the Stanford Exploration Project's *burn, build, view, clean* test; the route; the workbench | Terminal | 15 min |
| 1 · A project folder | A project skeleton in one command (brace expansion); copy the data under sample names; `md5sum` and `MD5SUMS`; read-only raw data (`chmod a-w`, what `ls -l` shows); a README; `.gitignore` | Terminal, Files | 20 min |
| 2 · By hand, then a script | The seven commands of the analysis (minimap2 → samtools → bcftools; 15 of 60 calls pass the filter); the same as a bash script; strict mode (`set -euo pipefail`) and a failing step; why a script lacks dependencies and re-entrancy | Terminal | 30 min |
| 3 · Python for Snakemake | First Python, explained line by line: values, lists, **the comma trap**, dictionaries and `config.yaml`, making file names (f-strings, `.format`, `expand`), functions and keyword arguments; notebook or script (hidden state; the same code as `python hello.py`) | Notebook | 35 min |
| 4 · Your first Snakefile | `rule map_reads`; dry runs and their reasons; `index_bam` and `flagstat` written by the students; `call_variants` from the AI assistant, to be checked; filter and `rule all`; the DAG (`--dag \| dot`); re-entrancy (deleted outputs, changed code) and a clean failure | Editor | 45 min |
| 5 · Any sample, any setting | Wildcards; settings from the config file; named inputs and logs, and parameters – both with help from the AI assistant; a Python script with pandas and matplotlib via `script:` | Editor | 50 min |
| 6 · Software environments | `conda env list`, `conda list`, versions; a colleague's run of the same pipeline gives different numbers – why?; `--config`; a single environment for everything, suggested by the AI assistant, against one exactly pinned environment per rule with `--use-conda`; real conda conflicts; `conda env export`, `pip freeze`, `--summary` | Terminal, Editor | 40 min |
| 7 · The same pipeline in Galaxy | Upload to a history; run minimap2 from its form and read the dataset details (tool ID, version, command line); build the workflow on a canvas with typed connections; run it – the same checksum as Snakemake; extract a workflow from the history; save the `.ga` file into the project | Galaxy | 40 min |
| 8 · An AI agent | A (simulated) agent returns a VCF file: students judge it from the evidence in the file and their own results, ask again, and ask for proof; then an agent that runs their pipeline in the open. Extension, in live mode: a real agent does the task twice, and students compare the runs | AI assistant, Terminal | 30 min |
| 9 · Which is best? | Burn, build, view with one command (and `temp()` for clean); compare script, Snakemake, Galaxy and agent for three scenarios; finish the README and download the project, which runs on a real computer | Terminal | 30 min |
| 10 · Reference | Commands, syntax and words from the practical | – | – |

There are 146 activities, most of which tick themselves when the student does them, and 44 questions (short answers checked automatically, multiple choice, or free text with a model answer). Almost every command in the instructions has a **show me** button that types it into the terminal. Answers are saved in the student's browser; **My answers** downloads them as an HTML file.

The staff notes (timings, answers, the assistant's planted mistakes, the agent's evidence, troubleshooting) are supplied separately. **Do not add the staff notes to this repository** – anything in a public GitHub Pages repository can be read by students.

## What is real and what is simulated

| Real – runs in the browser | Written for this practical |
|---|---|
| **minimap2 2.22, samtools 1.17, bcftools 1.10, bgzip/tabix 1.17** and GNU **coreutils, grep, sed, awk**, compiled to WebAssembly by [Biowasm](https://biowasm.com). Every command students type, and every job of Snakemake and Galaxy, runs these programs on real files | **The shell**: a bash-like shell in JavaScript (pipes, redirects, globs, brace expansion, `&&`/`\|\|`, variables, `set -euo pipefail`, scripts). No loops and no `$(…)` |
| **Python 3.13** (Pyodide) with pandas, NumPy, matplotlib and PyYAML: the notebook, `python script.py`, and the pipeline's `script:` | **Snakemake** (`assets/py/smk.py`): a re-implementation of the commonly used core of Snakemake 9.27 in Python – rules, wildcards, `expand`, config, params, logs, `conda:`, `script:`, `temp()`, the DAG, rerun reasons, `.snakemake` metadata, `--summary`, `--delete-all-output`, `--dag`. Its messages follow the real program's; unsupported features say so |
| **Graphviz** (Viz.js) for `snakemake --dag \| dot -Tsvg` | **conda**: environments that decide which programs a command may use, with the real versions and dependencies of the packages involved (including the real htslib and zlib conflicts). Only one build of each program exists in the browser |
| The **colleague's run** in `data/course/colleague/` was made on Linux with Snakemake 9.27.0 and conda 26.7.3 | **Galaxy** (`assets/js/galaxy.js`): the interface, histories, dataset details, workflow editor, invocations, “extract workflow” and `.ga` export, running the real programs above |
| The **live** AI assistant and the **real agent** (optional, with the student's own API key) | The **guided** AI assistant (prepared answers) and the **AI agent** of chapter 8 (scripted) |

Because the programs are real, results agree exactly: the pipeline gives `09dd51431f385ed3863928eee0064125` in the browser (Snakemake and Galaxy) and on a real computer with the exported project.

## Put it on GitHub Pages

1. On GitHub, create a **new repository** (for example `pipelines-practical`). It must be public unless your plan supports Pages for private repositories.
2. Upload the site: `index.html` must be at the **top level**, with `assets/` and `data/` beside it.
   - **With [GitHub Desktop](https://desktop.github.com/)** (easiest): *File → Add local repository* (choose the unzipped folder and let it create a repository), *Commit*, then *Publish repository* with “Keep this code private” unticked. GitHub’s upload page in the browser is not suitable: it takes at most 100 files at a time, and the site has about 170 (the biggest is 5.5 MB; about 25 MB in all).
   - **Or with git:**
     ```bash
     cd pipelines-practical
     git init && git add . && git commit -m "Pipelines and reproducibility practical"
     git branch -M main
     git remote add origin https://github.com/<you>/pipelines-practical.git
     git push -u origin main
     ```
3. *Settings → Pages → Build and deployment*: Source **Deploy from a branch**, branch **main**, folder **/ (root)**. Save.
4. After a minute the site is at `https://<you>.github.io/pipelines-practical/`. Share that address on Canvas.

The empty file `.nojekyll` stops GitHub from processing the site. The `build/` folder is not needed by the site (see [Editing the content](#editing-the-content)); leave it out of the repository if you prefer.

## Try it on your own computer

Opening `index.html` directly (`file://…`) does not work – browsers block the data files and the Web Workers. Serve the folder instead:

```bash
cd pipelines-practical
python3 serve.py 8000        # then open http://localhost:8000
```

## Timetable

The chapters add up to about 5½ hours. Two sessions work well:

| Session | Chapters | Ends with |
|---|---|---|
| A (≈ 3¼ h) | 0–5 | a general Snakefile with config, logs, parameters and a Python script |
| B (≈ 2¼ h) | 6–9 | pinned environments, the Galaxy workflow, the agent, and the exported project |

Students' work is saved in the browser between sessions (see [What students keep](#what-students-keep)). If they may use a different computer next time – or the lab computers clear the browser's storage at log-out – tell them to use **My answers → Save all my work to a file** at the end of session A, and **Open my work from a file** at the start of session B.

## The AI assistant and the agent

The **AI assistant** tab has two parts:

- **Chat** – a coding assistant. In **guided mode** (the default) its answers to the practical's questions were written in advance, to read like a real assistant's replies. **Some contain mistakes of the kind AI assistants really make, on purpose**, and the instructions lead students to run the code, read the error and ask again. A failed command in the terminal offers **Ask the AI assistant about this error**, and code blocks can be added to the Snakefile (or replace a rule), saved as a file, inserted into the notebook or typed into the terminal. Questions that match no prepared answer get a short explanation of guided mode and a prompt students can copy into another AI tool.
- **Agent** – a *scripted simulation* of an AI agent, used in chapter 8. The page tells students it is simulated. Its “black box” mode writes a VCF file with no provenance into `~/ai-agent/`; its “glass box” mode runs the student's own pipeline in the terminal, where every command and its output can be seen. In **live mode** (below), a task a student *types* in the Agent tab goes instead to a **real agent**: the live model chooses a command, it runs in the student's terminal, the output goes back to the model, and so on – up to 15 commands, then a report. Each task gets its own folder (`~/ai-agent/live-1`, `live-2`, …) with copies of the course data. The agent may run only minimap2, samtools, bcftools, bgzip, tabix and the file and text commands (no `cd`, Python, Snakemake, conda or scripts), and anything a command changes outside its folder is put back. The suggested tasks under the box stay simulated, because chapter 8 is written for them; an extension at the end of chapter 8 uses the real agent.

**Live mode** (optional) sends the chat to a real AI model – Google Gemini, Anthropic's Claude or any OpenAI-compatible service – using an API key that each student enters in the assistant's settings. Gemini is offered first because the Gemini API has a **free tier**: students make their own key with a Google account at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Google's terms for the free tier say that users must be 18 or over, that Google may use what is sent to improve its products, that human reviewers may read it, and that nothing sensitive, confidential or personal should be sent; the free tier also allows only a few requests per minute and per day, so each student should use their own key. Google's servers are sometimes busy for a model – most often the newest one – and answer “This model is currently experiencing high demand” (HTTP 503); the assistant then asks the next model in `geminiFallbackModels` (also when a model is over its free-tier limit or not found), and each answer says which model replied. With each question it sends the student's Snakefile and config file (not the data), and, for a failed command, the command and its output; the real agent sends its task, its commands and their output (for example the first lines of a VCF file). Each step of the real agent is one request, so a task uses about 5–15 of the free requests; when all models are over their per-minute limit, the agent waits as long as Google asks (a countdown is shown) and then carries on. The key is kept only in that browser tab (`sessionStorage`) and sent only to the chosen service; it is never saved in the site, in the student's files or in their work file. **Never put an API key in `config.js`** or anywhere else in the site: anyone can read a public site's files. Live answers vary and are not planted with mistakes, so the guided mode is the one the instructions are written for.

## What students keep

- **Saved in the browser** (localStorage, per browser and computer): their files (but not what is inside `results/`, `logs/` or `.snakemake/` – the pipeline rebuilds that), conda environments, Galaxy workflows, the notebook, ticks and answers. The Galaxy history is kept only while the page is open.
- **My answers → Save all my work to a file** saves everything above in one small `.json` file; **Open my work from a file** restores it in any browser, on any computer.
- **My answers → Download my answers** saves the answers as an HTML file (to hand in, or to open in Word); **Start again** deletes everything this page has saved.
- **Chapter 9** downloads the project as a zip – code, settings, environments, data, README; optionally with results – which runs on a real computer with `snakemake --cores 1 --use-conda` (Linux, Windows with WSL, or a Mac; on an Apple-silicon Mac with `CONDA_SUBDIR=osx-64` in front, because bioconda has the pinned tool versions only for Intel Macs). The notebook downloads as `.ipynb` and Galaxy workflows as `.ga` files.

## Settings: `config.js`

`assets/js/config.js`:

| Setting | Meaning |
|---|---|
| `showModelAnswers` | `true`: students can reveal a model answer after trying a question. `false`: the buttons are hidden (add `?answers` to the address to see them, e.g. when demonstrating). The answers are still in the page source, so to withhold them completely remove the `q-model` blocks from your copy. |
| `pyodideBase` | Where Python is loaded from – by default the jsDelivr CDN. If your network blocks it, run `python3 build/fetch_pyodide.py` (downloads the 30 MB that the practical needs into `assets/vendor/pyodide/`, checking every file) and set this to `'assets/vendor/pyodide/'`. |
| `biowasmBase` | Where the WebAssembly programs are (`assets/vendor/biowasm`). |
| `assistantDefaultMode` | `'guided'` (recommended) or `'live'`. |
| `liveProvider` | The service offered first in live mode: `'gemini'`, `'anthropic'` or `'openai'`. |
| `geminiModel`, `anthropicModel` | The models used in live mode (students can change them in the assistant's settings). Models are retired from time to time: if live mode reports that a model is not found, put a current one here ([Gemini models](https://ai.google.dev/gemini-api/docs/models)). Students who have not typed a model of their own get the new one straight away. |
| `geminiFallbackModels` | The Gemini models asked in turn when the chosen one is busy (HTTP 503), over its free-tier limit (429) or not found (404) – by default `gemini-3.6-flash`, then `gemini-3.5-flash-lite`. `[]` turns this off. |
| `courseTitle`, `courseSubtitle`, `storePrefix`, `hostname` | Page title, subtitle, the prefix of the browser-storage keys, and the name in the terminal prompt. |

## Editing the content

All text is plain HTML in `index.html`, between the markers `<!--CHAPTERS-->` and `<!--/CHAPTERS-->`. Each chapter is a `<section class="chapter" id="…" data-num="…" data-title="…" data-bench="…">`; `data-bench` chooses the workbench tab shown with it.

- **Activities:** `<li data-task="unique-id">…</li>` inside `<ol class="steps">`. Add `data-auto="EVENT key=value …"` to tick it automatically – e.g. `data-auto="term:command line~snakemake code=0"` (a terminal command containing `snakemake` that succeeded), `data-auto="gx:job tool=minimap2 state=ok"` (a Galaxy job) – or `data-check="name:arg"` for a check of the files, e.g. `data-check="exists:workflow/Snakefile"` or `data-check="has:workflow/Snakefile|conda:"`.
- **Questions:** `<div class="q" data-q="id"><div class="q-text">…</div><div class="q-model">model answer</div></div>`. Add `data-accept="regex||regex"` for a short answer checked automatically, or `data-type="mcq"` with `<div class="mcq"><label data-correct data-why="…"><input type="radio"> …</label>…</div>`.
- **Buttons:** `<button class="do showme" data-term="snakemake -n">show me</button>` types a command into the terminal (`data-term-run` also runs it); `data-file-create` (with a `<pre>` of the file) creates a file; `data-ai="entry-id"` asks the assistant a prepared question.

The chapters were written in Python, in `build/chapters_*.py`, and assembled into `index.html` with `python3 build/make_chapters.py` (Python 3.12 or later with PyYAML). Either edit `index.html` directly – simplest – or edit the Python and rebuild, which replaces everything between the markers. Don't mix the two: a rebuild overwrites direct edits. The assistant's prepared answers are built the same way from `build/make_ai_script.py` into `assets/js/assistant-script.js`.

The page logic is in `assets/js/page-pipe.js` (the file system with the course data, the terminal, the checks and buttons); Galaxy's tools are defined at the top of `assets/js/galaxy.js`.

## Files

```
index.html                 the practical
serve.py                   local test server
README.md, THIRD_PARTY.md  this file; licences and sources
assets/css/                app.css (layout), genomics.css (terminal, Galaxy), pipe.css (this practical)
assets/js/
  config.js                  settings
  core.js, icons.js, tutorial.js      page framework: chapters, tasks, questions, progress, answers
  vfs.js, shell.js, shell-extra.js    the file system and a bash-like shell with its commands
  terminal.js                the terminal
  tools-wasm.js              the WebAssembly programs (minimap2, samtools, bcftools, htslib, GNU tools)
  conda.js                   the conda model: packages, versions, dependencies, the solver
  py-worker.js, pysync.js    Python (Pyodide) in a Web Worker, sharing the page's files
  notebook.js, editor.js     the notebook and the file editor
  galaxy.js                  the Galaxy-style server and workflow editor
  assistant.js, assistant-script.js   the AI assistant and agent; the prepared answers
  project.js                 saving in the browser; project downloads
  page-pipe.js               this practical's set-up
assets/py/smk.py           the Snakemake engine
assets/vendor/             third-party libraries and programs, with their licences (see THIRD_PARTY.md)
data/course/               the course data (read-only in the terminal as /data/course)
build/                     sources of the chapters and the assistant's answers (not needed by the site)
```

## Data

`data/course/` holds 3,519 pairs of real 76-base Illumina exome reads from **NA12878** (run SRR098401, 1000 Genomes), extracted from the public alignment for two regions of chromosome 10, and the matching slices of the hg19 reference (`human_CYP2C19` = chr10:96,530,001–96,560,000, `human_CYP2C9` = chr10:96,699,001–96,725,000). Its `README.md` and `provenance.json` record the source URLs, hashes, counts and limitations; `MD5SUMS` lets students check their copies. `colleague/` holds the output of a second run of the pipeline on Linux with a looser environment file, used in chapter 6.

## Privacy

- The course data are public (1000 Genomes); no patient data are used, and the practical tells students never to paste personal or patient data into an AI tool.
- Students' files, answers and settings stay in their own browser. Nothing is uploaded anywhere, with two exceptions: the browser downloads Python from the jsDelivr CDN (unless you host it, see `pyodideBase`), and in **live** AI mode the student's messages, their Snakefile and config file, any error they ask about, and the real agent's commands and their output go to the AI service they chose, under their own account – on Gemini's free tier, under Google's terms for unpaid services (see above).
- There is no analytics, tracking or login.

## Browser support and limitations

A recent Chrome, Edge, Firefox or Safari on a laptop or desktop computer (the page needs WebAssembly and Web Workers). The first time Python is needed the browser downloads about 30 MB; later visits use the browser's cache. Phones and small tablets are not supported.

Known limitations, all explained to students where they matter:

- The shell has no loops (`for`, `while`) and no command substitution (`$(…)`).
- `dot` makes SVG and PNG, not PDF.
- In the browser each program has its own built-in htslib, so bcftools always uses htslib 1.10 while `conda list` shows htslib 1.17 (the one samtools uses); chapter 6 turns this into a question.
- Pyodide provides matplotlib 3.8 while `workflow/envs/python.yaml` asks for 3.9 (the first version for Python 3.13 on conda-forge); Snakemake says so when it builds the environment. The table is the same; the plot looks the same.
- The terminal's own environment, `pipelines`, holds Python 3.13 and the old tool versions together – possible only in the browser, where each program carries its own libraries. The page says so where students meet it.
- The Galaxy history is not kept after the page is closed (workflows are).
- The AI agent is scripted, and the guided assistant answers only the practical's questions.

## Credits and licences

The practical's text and code were written for masters teaching at Anglia Ruskin University. The bundled programs and libraries keep their own licences – minimap2, samtools, bcftools, htslib, the GNU tools, Biowasm and Aioli, CodeMirror, DOMPurify, JSZip and Viz.js/Graphviz – and Python comes from Pyodide. **[THIRD_PARTY.md](THIRD_PARTY.md)** lists every component with its version, licence, source and any local change. Keep it and `assets/vendor/licenses/` (licence texts, the source code of the GPL programs and their build recipes) with any copy of the site you host.

Claerbout's principle is from J. Claerbout and M. Karrenbach (1992), *Electronic documents give reproducible research a new meaning* (SEG Expanded Abstracts); its best-known wording is Buckheit and Donoho's (1995, *WaveLab and reproducible research*), and the four rules burn, build, view and clean are described on Claerbout's page [Reproducible computational research](https://sepwww.stanford.edu/sep/jon/reproducible.html). Snakemake: Mölder *et al.* (2021) *F1000Research* 10:33. Galaxy: The Galaxy Community (2024) *Nucleic Acids Research* 52:W83–W94. Project layout: Noble (2009) *PLoS Computational Biology* 5:e1000424.
