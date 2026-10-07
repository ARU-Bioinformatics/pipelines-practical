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
6. [The terminal](#the-terminal)
7. [The AI assistant and the agent](#the-ai-assistant-and-the-agent)
8. [What students keep](#what-students-keep)
9. [Settings: `config.js`](#settings-configjs)
10. [Editing the content](#editing-the-content)
11. [Files](#files)
12. [Data](#data)
13. [Privacy](#privacy)
14. [Browser support and limitations](#browser-support-and-limitations)
15. [Credits and licences](#credits-and-licences)
16. [Changes](#changes)

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

There are 148 activities, most of which tick themselves when the student does them, and 45 questions (short answers checked automatically, multiple choice, or free text with a model answer). Almost every command in the instructions has a **show me** button that types it into the terminal. Answers are saved in the student's browser; **My answers** downloads them as an HTML file.

The staff notes (timings, answers, the assistant's planted mistakes, the agent's evidence, troubleshooting) are supplied separately. **Do not add the staff notes to this repository** – anything in a public GitHub Pages repository can be read by students.

## What is real and what is simulated

| Real – runs in the browser | Written for this practical |
|---|---|
| **minimap2 2.22, samtools 1.17, bcftools 1.10, bgzip/tabix 1.17** and GNU **coreutils, grep, sed, awk** and **diffutils**, compiled to WebAssembly (most of them by [Biowasm](https://biowasm.com)). Every command students type, and every job of Snakemake and Galaxy, runs these programs on real files | **The shell**: bash's language, written in JavaScript – pipes, redirection, quoting, globs, variables and `${…}`, `$( )`, `$(( ))`, `if`/`for`/`while`/`case`, functions, here-documents, `set -euo pipefail`, scripts. It is compared with real bash by tests (see [The terminal](#the-terminal)). The commands for files and folders (`ls`, `cp`, `mv`, `find` …) are the page's own, written to behave like the GNU ones |
| **Python 3.13** (Pyodide) with pandas, NumPy, matplotlib and PyYAML: the notebook, `python script.py`, and the pipeline's `script:` | **Snakemake** (`assets/py/smk.py`): a re-implementation of the commonly used core of Snakemake 9.27 in Python – rules, wildcards, `expand`, config, params, logs, `conda:`, `script:`, `temp()`, the DAG, rerun reasons, `.snakemake` metadata, `--summary`, `--delete-all-output`, `--dag`. Its messages follow the real program's; unsupported features say so |
| **Graphviz** (Viz.js) for `snakemake --dag \| dot -Tsvg` | **conda**: environments that decide which programs a command may use, with the real versions and dependencies of the packages involved (including the real htslib and zlib conflicts). Only one build of each program exists in the browser |
| The **colleague's run** in `data/course/colleague/` was made on Linux with Snakemake 9.27.0 and conda 26.7.3 | **Galaxy** (`assets/js/galaxy.js`): the interface, histories, dataset details, workflow editor, invocations, “extract workflow” and `.ga` export, running the real programs above |
| The **live** AI assistant and the **real agent** (optional, with the student's own API key) | The **guided** AI assistant (prepared answers) and the **AI agent** of chapter 8 (scripted) |

Because the programs are real, results agree exactly: the pipeline gives `09dd51431f385ed3863928eee0064125` in the browser (Snakemake and Galaxy) and on a real computer with the exported project.

## Put it on GitHub Pages

1. On GitHub, create a **new repository** (for example `pipelines-practical`). It must be public unless your plan supports Pages for private repositories.
2. Upload the site: `index.html` must be at the **top level**, with `assets/` and `data/` beside it.
   - **With [GitHub Desktop](https://desktop.github.com/)** (easiest): *File → Add local repository* (choose the unzipped folder and let it create a repository), *Commit*, then *Publish repository* with “Keep this code private” unticked. GitHub’s upload page in the browser is not suitable: it takes at most 100 files at a time, and the site has about 220 (the biggest is 5.5 MB; about 33 MB in all).
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

## The terminal

**Real programs, compiled to WebAssembly, running in the browser** on the student's computer: minimap2 2.22, samtools 1.17, bcftools 1.10, bgzip and tabix (HTSlib 1.17); GNU coreutils 8.32 (`cat head tail wc sort uniq cut tr tee paste join comm seq fold shuf md5sum date`), grep 3.7, sed 4.8, awk (gawk 5.1.0) and diffutils 3.10 (`diff`, `cmp`). `gzip`, `gunzip`, `zcat` and `zgrep` are carried out by bgzip; `grep -P` by a second grep (3.11, with PCRE2). The bioinformatics programs come from conda environments, as on a real computer: `samtools` is “command not found” until an environment that holds it is active (chapter 6 is about this).

**Written for the practical, in JavaScript:** the shell, and the commands that work on the page's folders rather than on the bytes of files – `ls cd pwd mkdir cp mv rm rmdir touch find xargs du stat tree file chmod basename dirname realpath mktemp column tac rev nl sleep env timeout`, `sha256sum`, `od`, `base64`, `bc` and others (`help` in the terminal lists them; `NAME --help` says which options a command has). `snakemake`, `conda`, `python`, `pip` and `dot` are commands of the page as well (see [What is real and what is simulated](#what-is-real-and-what-is-simulated)).

**The shell** understands what a bash script of the usual kind uses: pipes and lists (`| && || ;`), redirection (`> >> < 2> 2>&1`, here-documents and here-strings), quoting, variables and arrays, parameter expansion (`${x:-y}`, `${f%.bam}`, `${x/a/b}`, `${#x}`), `$( )`, `$(( ))`, globs and brace expansion, `if` / `for` / `while` / `case`, `[ ]` and `[[ ]]`, functions, `read`, `printf`, `getopts`, `trap … EXIT`, and `set -euo pipefail` with bash's rules for where a failing command does not end a script. A script gets only the exported variables; a file that is started is run by the program its first line names. In a script, a failed command is reported with the script's name and the line.

How it was checked: 899 scripts are run in this page and in real bash 5.2 and must print the same and end with the same status. The shell and its commands are those of the practical *AI agents for bioinformatics*, where they were compared with bash and the GNU programs on about 9,200 more command lines, most of them written by reviewers who were looking for differences. Snakemake's jobs run through this shell as real Snakemake runs them, with `bash -c "set -euo pipefail; …"`: a rule that uses a variable nobody set, or `awk "{{print $1}}"` in double quotes, fails here as it does on a real computer (“unbound variable”).

**Different from bash and Linux:**

- There are no background jobs (`&`, `wait`), no network, and no `sudo`. Programs that are not installed (`bwa`, `gatk`, `fastqc`, `wget` …) give “command not found” and a hint at what is there instead.
- The commands of a pipeline run one after the other, each one's output being the next one's input. The result is the same, but a command that never ends cannot feed a pipe: `yes` is not there for that reason (the terminal says what to use instead), and a loop without an end runs until Ctrl+C.
- Every program runs on one thread. An option that asks for more (`samtools sort -@ 4`, `minimap2 -t 8`, `bcftools --threads 2`) is left out, and the terminal says so; `minimap2 -t 1`, which a rule with `threads: 1` runs, stays as it is.
- `awk` cannot start other programs (`system()`, `print | "sort"`), and `bcftools` has no plugins.
- `ls` and `*` give names in the order of the characters, capital letters first (as with `LANG=C`).
- Of a very long output the terminal shows the beginning and the end, and says how many lines it left out.
- **Ctrl+C** once lets the program that is running finish and skips the rest; a second Ctrl+C stops the program by force. The programs are then started again, and the files that programs had written (BAM, VCF.gz …) are gone – they live in the programs' memory, and this practical keeps no copies of results on purpose: the pipeline makes them again. The terminal names the files that were lost. Text files are not affected.
- The files of the course data in `/data/course` cannot be changed or removed. (A new file can be made beside them, as in the first version; nothing in the practical does that.) A read-only file of the student's own (`chmod a-w`, chapter 1) is treated as Linux treats it: nothing can be written into it, but `rm -f` and `mv -f` in a folder one may write to still work.

What was changed in the programs and their runtime to make them behave in a browser as on Linux is listed in [`assets/vendor/biowasm/RUNTIME-PATCHES.txt`](assets/vendor/biowasm/RUNTIME-PATCHES.txt).

## The AI assistant and the agent

The **AI assistant** tab has two parts:

- **Chat** – a coding assistant. In **guided mode** (the default) its answers to the practical's questions were written in advance, to read like a real assistant's replies. **Some contain mistakes of the kind AI assistants really make, on purpose**, and the instructions lead students to run the code, read the error and ask again. A failed command in the terminal offers **Ask the AI assistant about this error**, and code blocks can be added to the Snakefile (or replace a rule), saved as a file, inserted into the notebook or typed into the terminal. Questions that match no prepared answer get a short explanation of guided mode and a prompt students can copy into another AI tool.
- **Agent** – a *scripted simulation* of an AI agent, used in chapter 8. The page tells students it is simulated. Its “black box” mode writes a VCF file with no provenance into `~/ai-agent/`; its “glass box” mode runs the student's own pipeline in the terminal, where every command and its output can be seen. The suggested tasks under the box stay simulated in every mode, because chapter 8 is written for them.

In **live mode** (below), a task a student *types* in the Agent tab goes instead to a **real agent**, which the extension at the end of chapter 8 uses: the live model writes a step – a command, or a few that belong together –, the page runs it in the student's terminal, the output goes back to the model, and so on: up to 15 steps, then a report. Each task gets a folder of its own (`~/ai-agent/live-1`, `live-2`, …) with copies of the course data. What the page does around the agent – none of it is left to the model:

- **What it may run:** minimap2, samtools, bcftools, bgzip, tabix and the file and text commands – no `cd`, Python, Snakemake, conda or scripts. Loops, `$( )`, variables and here-documents are allowed. This is checked twice. A step that names another program is refused whole, before anything runs. And when a command starts, the shell looks again – so a program whose name comes from a variable, or that `xargs` or `find -exec` would start, is stopped as well.
- **Where it works:** in a shell of its own – it does not see the student's variables, functions or options, and leaves none behind – with its five programs, whatever conda environment is active in the terminal. The terminal is locked for typing meanwhile. Anything a step changes outside the agent's folder is put back: text files, and the files that programs wrote (BAM, VCF), byte for byte.
- **When a step goes wrong:** of a step with several commands, what follows a command that failed is not run, and the model is told. A step that has not ended after 150 seconds (`agentCommandSeconds`) is stopped by force. **Stop** ends the task; while a program is running, the first press lets that program finish, and a second press stops it by force. After a forced stop, what programs wrote in that step is gone; the files they had written before – in the student's folders and in the agent's – are written back as they were (the page holds a copy of them while the agent works).
- **When the service cannot answer:** if every model is busy or over its limit per minute, the agent waits as long as the service asks (a countdown is shown; between 5 and 90 seconds) and asks again, up to three times for one reply. It ends at once when waiting cannot help: every model over its limit for today, or a key that is not accepted.

**Live mode** (optional) sends the chat to a real AI model – Google Gemini, Anthropic's Claude or any OpenAI-compatible service – using an API key that each student enters in the assistant's settings. With each question it sends the student's Snakefile and config file (not the data), and, for a failed command, the command and its output; the real agent sends its task, its commands and their output (for example the first lines of a VCF file). Live answers vary and are not planted with mistakes, so the guided mode is the one the instructions are written for. Each answer says which model replied.

**Keys.** Gemini is offered first because the Gemini API has a **free tier**: students make their own key with a Google account at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (18 or over). **Read Google's [Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms) before you plan on free keys.** The version in force when this was written (effective 23 March 2026) says: *“You may use only Paid Services when making API Clients available to users in the European Economic Area, Switzerland, or the United Kingdom.”* Whether a class in which each student uses a free key of their own, in a page that you provide, falls under that sentence is for your institution to decide. (For users there the same terms apply the data rules of the paid service to the free tier as well: what is sent is not used to improve Google's products. Elsewhere Google may use what is sent on the free tier for that, and people may read it.) Nothing sensitive, confidential or personal should be sent in any case. The alternatives are a paid key for each student, one key of yours for the session (check the terms of the service first, and delete the key afterwards), or another service – for example one that your university provides.

**What a free key gave on 6 October 2026**, as the service itself reported it: 20 requests a day for each of `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash` and `gemini-3.5-flash`; 15 a minute for `gemini-3.5-flash-lite`, which answered more than 85 requests that day without reaching a limit per day. The limits are counted per project, not per key, and Google changes them ([AI Studio](https://aistudio.google.com/rate-limit) shows them). Around midday the newest models answered most requests with “busy” (“high demand”, HTTP 503) – and a request that is answered “busy” counts against the limit per day. A task of the real agent takes up to 16 requests (15 steps and the report), and the extension of chapter 8 asks for two; each question in the chat is one.

**When a Gemini model cannot answer**, the page asks the next model of `geminiFallbackModels`, and remembers what the first one said, so that it is not asked again before that can have changed:

| The model … | The page … |
|---|---|
| is busy (“high demand”, HTTP 500–504) | asks the next model, and leaves this one alone for 2 minutes – for 4, 8, at most 15 if it is busy again when its rest is over |
| is over its limit per minute (429) | asks the next model, and comes back when the service says the limit is over (usually within a minute) |
| is over its limit per day (429, and the service names the limit) | asks the next model, and does not ask this one again before the time the service gives |
| is not found (404: retired, or a wrong name) | asks the next model, and never this one |
| gives no answer: the connection fails, or nothing comes for `aiWaitSeconds` (60) | asks the next model, and leaves this one alone for a minute. Two models in a row without an answer: the page stops, and says that the connection may be down – unless another model answered a moment before |
| breaks off in the middle of an answer | takes back what had arrived, and asks the next model |

When no model is left that is not at rest, the two that have rested longest of the busy or silent ones are asked again. The memory belongs to the key and is gone when the page is loaded again. An error of another kind – a key that is not accepted, a request that the service refuses – is shown at once. For the other services there is one model: if it is busy, the page tries once more. A reply that Gemini cuts off as a “malformed function call” – the service sometimes takes the ` ```bash ` block of a model for the call of a tool – gets its commands back, so the agent's step is not lost.

**The key** is kept only in that browser tab (`sessionStorage`) and sent only to the chosen service; it is never saved in the site, in the student's files or in their work file. **Never put an API key in `config.js`** or anywhere else in the site: anyone can read a public site's files.

**How this was tested.** The page was developed and tested against stand-ins for the AI services that replay prepared replies and the errors of the real service. On 6 October 2026 the live assistant and the real agent were also run with a free Gemini key, in three sessions: the connection test, five questions in the chat (two about the student's Snakefile, one after a failed command), the task of chapter 8's extension six times and a second task twice – 108 requests, of which the service answered 69. The four larger models were over their limit for the day, so the two “lite” models did the work, slowly at times: when the service answered “busy” or not at all, a run of the agent took up to four minutes. What the models did – and the four kinds of reply that the page learned to read from them – is in the staff notes. That is one afternoon, with the models and the limits of that day. The requests to Anthropic and to an OpenAI-compatible service have only been tested against stand-ins: if you plan to use one of them, try it first.

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
| `geminiModel`, `anthropicModel` | The models used in live mode (students can change them in the assistant's settings). Models are retired from time to time: if live mode reports that a model is not found, put a current one here ([Gemini models](https://ai.google.dev/gemini-api/docs/models)). Students who have not typed a model of their own get the new one straight away. A retired model in `geminiFallbackModels` costs every student one request, which is answered “not found”; after that the page leaves it out. |
| `geminiFallbackModels` | The Gemini models asked in turn when the chosen one is busy, over a limit, not found or silent – five models that answered a free key on 6 October 2026. On the free tier each model has limits of its own, so a longer list gives a key more requests in a day; put the models you would rather have first. `[]` turns this off. |
| `aiWaitSeconds` | How long a Gemini model may say nothing – before its answer begins, or in the middle of it – until the page gives that request up and asks the next model (60). |
| `agentCommandSeconds` | After how many seconds a step of the real agent that has not ended is stopped (150; at least 5). |
| `courseTitle`, `courseSubtitle`, `storePrefix`, `hostname` | Page title, subtitle, the prefix of the browser-storage keys, and the name in the terminal prompt. |

## Editing the content

All text is plain HTML in `index.html`, between the markers `<!--CHAPTERS-->` and `<!--/CHAPTERS-->`. Each chapter is a `<section class="chapter" id="…" data-num="…" data-title="…" data-bench="…">`; `data-bench` chooses the workbench tab shown with it.

- **Activities:** `<li data-task="unique-id">…</li>` inside `<ol class="steps">`. Add `data-auto="EVENT key=value …"` to tick it automatically – e.g. `data-auto="term:command line~snakemake code=0"` (a terminal command containing `snakemake` that succeeded), `data-auto="gx:job tool=minimap2 state=ok"` (a Galaxy job) – or `data-check="name:arg"` for a check of the files, e.g. `data-check="exists:workflow/Snakefile"` or `data-check="has:workflow/Snakefile|conda:"`.
- **Questions:** `<div class="q" data-q="id"><div class="q-text">…</div><div class="q-model">model answer</div></div>`. Add `data-accept="regex||regex"` for a short answer checked automatically, or `data-type="mcq"` with `<div class="mcq"><label data-correct data-why="…"><input type="radio"> …</label>…</div>`.
- **Buttons:** `<button class="do showme" data-term="snakemake -n">show me</button>` types a command into the terminal (`data-term-run` also runs it); `data-file-create` (with a `<pre>` of the file) creates a file; `data-ai="entry-id"` asks the assistant a prepared question.

The chapters were written in Python, in `build/chapters_*.py`, and assembled into `index.html` with `python3 build/make_chapters.py` (Python 3.12 or later with PyYAML). Either edit `index.html` directly – simplest – or edit the Python and rebuild, which replaces everything between the markers. Don't mix the two: a rebuild overwrites direct edits. The assistant's prepared answers are built the same way from `build/make_ai_script.py` into `assets/js/assistant-script.js`.

The page logic is in `assets/js/page-pipe.js` (the file system with the course data, the terminal, the checks and buttons); Galaxy's tools are defined at the top of `assets/js/galaxy.js`. The terminal's files – `vfs.js`, `shell.js`, `shell-lang.js`, `shell-extra.js`, `terminal.js`, `tools-wasm.js` and `assets/vendor/biowasm/` – are shared with the practical *AI agents for bioinformatics*; what belongs to this practical alone (conda, Snakemake, Python, Graphviz, the hints for programs that are not installed, `help`) is in `shell-pipe.js`.

## Files

```
index.html                 the practical
serve.py                   local test server
README.md, THIRD_PARTY.md  this file; licences and sources
assets/css/                app.css (layout), genomics.css (terminal, Galaxy), pipe.css (this practical)
assets/js/
  config.js                  settings
  core.js, icons.js, tutorial.js      page framework: chapters, tasks, questions, progress, answers
  vfs.js                     the file system of the page
  shell.js, shell-lang.js    the shell: how commands are run; bash's language
  shell-extra.js             more commands (find, stat, du, bc, od, split …) and their help texts
  shell-pipe.js              this practical's commands: conda, snakemake, python, pip, dot, help
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

A recent Chrome, Edge, Firefox or Safari on a laptop or desktop computer (the page needs WebAssembly and Web Workers). This version was tested in Chromium, the engine of Chrome and Edge; Firefox and Safari were not tried, so before a class open the site in the browser your students will use and run `snakemake --version` in its terminal. The first time Python is needed the browser downloads about 30 MB (19 files; about 22 MB over the network from the CDN, which sends them compressed); later visits use the browser's cache. Phones and small tablets are not supported.

Known limitations, all explained to students where they matter:

- The terminal is not a whole computer: no background jobs, no network, one thread, and a forced stop loses the files that programs wrote (see [The terminal](#the-terminal)).
- `dot` makes SVG and PNG, not PDF.
- In the browser each program has its own built-in htslib, so bcftools always uses htslib 1.10 while `conda list` shows htslib 1.17 (the one samtools uses); chapter 6 turns this into a question.
- Pyodide provides matplotlib 3.8 while `workflow/envs/python.yaml` asks for 3.9 (the first version for Python 3.13 on conda-forge); Snakemake says so when it builds the environment. The table is the same; the plot looks the same.
- The terminal's own environment, `pipelines`, holds Python 3.13 and the old tool versions together – possible only in the browser, where each program carries its own libraries. The page says so where students meet it.
- The Galaxy history is not kept after the page is closed (workflows are).
- The AI agent of chapter 8 is scripted, and the guided assistant answers only the practical's questions. (The real agent of the extension needs live mode and a key.)

## Credits and licences

The practical's text and code were written for masters teaching at Anglia Ruskin University. The bundled programs and libraries keep their own licences – minimap2, samtools, bcftools, htslib, the GNU tools (coreutils, grep, sed, gawk, diffutils), PCRE2, Biowasm and Aioli (with Comlink), CodeMirror, DOMPurify, JSZip and Viz.js/Graphviz – and Python comes from Pyodide. **[THIRD_PARTY.md](THIRD_PARTY.md)** lists every component with its version, licence, source and any local change. Keep it and `assets/vendor/licenses/` (licence texts, the source code of the GPL programs and their build recipes) with any copy of the site you host.

Claerbout's principle is from J. Claerbout and M. Karrenbach (1992), *Electronic documents give reproducible research a new meaning* (SEG Expanded Abstracts); its best-known wording is Buckheit and Donoho's (1995, *WaveLab and reproducible research*), and the four rules burn, build, view and clean are described on Claerbout's page [Reproducible computational research](https://sepwww.stanford.edu/sep/jon/reproducible.html). Snakemake: Mölder *et al.* (2021) *F1000Research* 10:33. Galaxy: The Galaxy Community (2024) *Nucleic Acids Research* 52:W83–W94. Project layout: Noble (2009) *PLoS Computational Biology* 5:e1000424.

## Changes

**6 October 2026** (the first version was of 1 October 2026):

- **The terminal is a new one** – the shell and the program runner of the practical *AI agents for bioinformatics*. Loops, `if`, `$( )`, `$(( ))`, `${f%.bam}`, here-documents and functions work: the first version's shell had none of them. `set -e`, `set -u` and `set -o pipefail` work at the prompt as they do in a script (in the first version only in a script). And the first version gave wrong results without a message for several things a student might type (`${f%.bam}`, `"$(…)"`, `{a..c}`, `date +%F`, an unquoted `$x` with blanks in it).
- **Each run of a program starts afresh.** In the first version minimap2 kept the read group of an earlier `-R` and wrote it into every later alignment, and `samtools sort -@ 2` (any option for more than one thread) left every later command failing with “FS error” until the page was loaded again.
- **Snakemake's jobs run with `set -euo pipefail`**, as the real program runs them. In the first version `-u` was missing: a rule that used a variable nobody had set ran, and wrote a wrong file.
- **Galaxy's tools no longer depend on the conda environment that is active in the terminal** (with `base` active they failed with “command not found”).
- **Live mode:** more Gemini models to fall back on, and a memory for the ones that cannot answer; limits per day are told apart from limits per minute. The real agent may use loops and `$( )`, is checked again when each command starts, works in a shell of its own, and can be stopped while a program runs.
- `ls` prints as GNU `ls` does (no `/` after folders unless `-F` is given; `total` in blocks), and names are in the order of the characters, capital letters first.

Students' saved work from the first version opens in this one.
