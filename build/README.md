# build/ – sources of the page (not needed by the site)

The site runs without anything in this folder. These scripts generated parts of it:

| Script | Writes | Run with |
|---|---|---|
| `make_chapters.py` | the chapters in `../index.html` (everything between `<!--CHAPTERS-->` and `<!--/CHAPTERS-->`) from `chapters_a.py`, `chapters_b.py`, `chapters_c.py` and `chapters_lib.py` | `python3 make_chapters.py` |
| `make_ai_script.py` | `../assets/js/assistant-script.js`: the AI assistant's prepared answers and the agent's script | `python3 make_ai_script.py` |
| `make_agent_vcfs.py` | `agent_vcfs.json`: the VCF files the simulated agent hands out (run before `make_ai_script.py`) | `python3 make_agent_vcfs.py` |
| `fetch_pyodide.py` | `../assets/vendor/pyodide/`: the part of Pyodide the practical needs, to host Python with the site instead of the CDN | `python3 fetch_pyodide.py` |

They need Python 3.12 or later and PyYAML (`pip install pyyaml`).

**Editing:** either edit `../index.html` directly – simplest – or edit the chapter scripts and run `make_chapters.py`, which replaces the chapters in `index.html`. Don't mix the two: a rebuild overwrites direct edits to the chapters.

`chapters_lib.py` also holds the files students create (Snakefile versions, config, environment files, the summary script) and the expected results (`FILTERED_MD5 = '09dd51431f385ed3863928eee0064125'`, 60 raw and 15 filtered calls). If you change a command or a threshold, check the numbers again – the questions' model answers quote them.
