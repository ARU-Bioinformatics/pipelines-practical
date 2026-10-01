"""
smk - a Snakemake-compatible workflow engine for the browser practical
("browser teaching edition").

It reads real Snakefiles (Snakemake 9 syntax), builds the graph (DAG) of jobs,
decides which jobs must run the way Snakemake 9 does (missing output, newer
input whose content changed, changed code, params, set of input files or
software environment), runs shell commands through the page's shell (real
WebAssembly tools), runs `run:` blocks and `script:` Python scripts in this
Python, and records provenance in .snakemake/ where Snakemake keeps it.

Messages follow Snakemake 9.27 closely, so what students learn transfers to
the real program. It implements the commonly used core of Snakemake, not all
of it; unsupported features say so. Shell commands are executed by a bridge
supplied by the host page (`set_bridge`), so the engine can also be tested
natively with a subprocess bridge.
"""
import ast
import asyncio
import base64
import collections
import datetime
import hashlib
import inspect
import io
import itertools
import json
import os
import re
import shlex
import string
import sys
import textwrap
import time
import tokenize
import traceback
import uuid

VERSION = "9.27.0"
EDITION = "browser teaching edition"
RECORD_FORMAT_VERSION = 6
MAX_CHECKSUM_FILE_SIZE = 1_000_000
EMPTY_MD5 = hashlib.md5(b"").hexdigest()
META_DIR = os.path.join(".snakemake", "metadata")

# ============================================================================
# errors
# ============================================================================


class WorkflowError(Exception):
    """An error reported to the user in Snakemake's format (no Python traceback)."""

    def __init__(self, msg, kind="WorkflowError", lineno=None, snakefile=None, rule=None, trace=None, hint=None):
        super().__init__(msg)
        self.msg = msg
        self.kind = kind
        self.lineno = lineno
        self.snakefile = snakefile
        self.rule = rule
        self.trace = trace
        self.hint = hint

    def render(self):
        loc = ""
        if self.lineno is not None and self.snakefile:
            loc = f' in file "{self.snakefile}", line {self.lineno}'
            if self.rule:
                loc = f" in rule {self.rule}{loc}"
        text = self.kind + loc + (":\n" + self.msg if self.msg else ".")
        if self.trace:
            text += "\n" + self.trace
        return text


class SnakefileSyntaxError(WorkflowError):
    def __init__(self, msg, lineno, snakefile, text=None, hint=None):
        super().__init__(msg, "SyntaxError", lineno, snakefile, hint=hint)
        self.text = text

    def render(self):
        return f'SyntaxError in file "{self.snakefile}", line {self.lineno}:\n{self.msg}:\n{(self.text or "").rstrip()}'


class _JobFailed(Exception):
    """a job failed; `text` is printed before the 'Error in rule' block"""

    def __init__(self, text, shell_failed=False, cmd=None, code=1):
        super().__init__(text)
        self.text = text
        self.shell_failed = shell_failed
        self.cmd = cmd
        self.code = code


# ============================================================================
# files, flags and helper functions available in Snakefiles
# ============================================================================


class _IOFile(str):
    """a file name with Snakemake flags (temp, protected, directory, ...)"""

    def __new__(cls, value, **flags):
        s = super().__new__(cls, value)
        s.flags = dict(getattr(value, "flags", {}))
        s.flags.update(flags)
        return s


def _flag(value, **flags):
    if isinstance(value, (list, tuple)):
        return [_flag(v, **flags) for v in value]
    if isinstance(value, dict):
        return {k: _flag(v, **flags) for k, v in value.items()}
    if callable(value):
        def flagged(*a, **kw):
            return _flag(value(*a, **kw), **flags)
        flagged.__signature__ = inspect.signature(value)
        return flagged
    return _IOFile(value, **flags)


def _flags_of(value):
    return getattr(value, "flags", {}) or {}


def temp(value):
    """temp("results/x.bam"): delete the file once no job needs it any more"""
    return _flag(value, temp=True)


def protected(value):
    """protected("results/x"): make the file read-only after it is made"""
    return _flag(value, protected=True)


def directory(value):
    """directory("results/dir"): the output is a folder"""
    return _flag(value, directory=True)


def ancient(value):
    """ancient("file"): ignore this input's modification time"""
    return _flag(value, ancient=True)


def touch(value):
    """touch("done.txt"): Snakemake creates the file after the job"""
    return _flag(value, touch=True)


def report(value, caption=None, category=None, subcategory=None, labels=None, **kw):
    return _flag(value, report=True)


def pipe(value):
    raise WorkflowError("pipe() output files are not supported in this browser edition of Snakemake.")


def service(value):
    raise WorkflowError("service() output files are not supported in this browser edition of Snakemake.")


def multiext(prefix, *exts, **named):
    if named:
        return {k: prefix + v for k, v in named.items()}
    return [prefix + e for e in exts]


def unpack(fn):
    fn._snakemake_unpack = True
    return fn


def min_version(v):
    def parse(x):
        return tuple(int(p) for p in re.findall(r"\d+", str(x))[:3])

    if parse(VERSION) < parse(v):
        raise WorkflowError(f"Expecting Snakemake version {v} or higher (you are currently using {VERSION}).")


_WC = re.compile(r"\{\s*(?P<name>\w+?)(\s*,\s*(?P<constraint>([^{}]+|\{\d+(,\d+)?\})*))?\s*\}")


def _strip_escapes(pattern):
    return str(pattern).replace("{{", "\x00").replace("}}", "\x01")


def _restore_escapes(s):
    return s.replace("\x00", "{").replace("\x01", "}")


def _wildcard_names(pattern):
    return list(dict.fromkeys(m.group("name") for m in _WC.finditer(_strip_escapes(pattern))))


def expand(*args, **wildcards):
    """expand("results/{sample}.bam", sample=["A", "B"]) -> ["results/A.bam", "results/B.bam"]"""
    if not args:
        raise WorkflowError("expand() needs a file pattern, e.g. expand('results/{sample}.bam', sample=SAMPLES)",
                            kind="WildcardError")
    combinator = itertools.product
    patterns = args[0]
    if len(args) > 1:
        combinator = args[1]
    allow_missing = wildcards.pop("allow_missing", False)
    if isinstance(patterns, str):
        patterns = [patterns]
    values = {}
    for k, v in wildcards.items():
        if isinstance(v, str) or not hasattr(v, "__iter__"):
            v = [v]
        values[k] = list(v)
    out = []
    for pattern in patterns:
        names = [n for n in _wildcard_names(pattern) if n in values]
        missing = [n for n in _wildcard_names(pattern) if n not in values]
        if missing and not allow_missing:
            raise WorkflowError(f"No values given for wildcard '{missing[0]}'.", kind="WildcardError")
        lists = [[(n, v) for v in values[n]] for n in names]
        for combo in (combinator(*lists) if names else [()]):
            out.append(_fill(pattern, dict(combo), keep_missing=True))
    return out


collect = expand


def _fill(pattern, values, keep_missing=False):
    """replace {name} and {name,regex} by values; {{ }} are literal braces"""
    s = _strip_escapes(pattern)

    def rep(m):
        n = m.group("name")
        if n in values:
            return str(values[n])
        if keep_missing:
            return m.group(0)
        raise KeyError(n)

    return _restore_escapes(_WC.sub(rep, s))


def _pattern_regex(pattern, constraints):
    """turn an output pattern into a regular expression with named groups"""
    s = _strip_escapes(pattern)
    out, pos, seen = [], 0, set()
    for m in _WC.finditer(s):
        out.append(re.escape(_restore_escapes(s[pos:m.start()])))
        n = m.group("name")
        if n in seen:
            out.append(f"(?P={n})")
        else:
            c = m.group("constraint") or constraints.get(n) or ".+"
            out.append(f"(?P<{n}>{c})")
            seen.add(n)
        pos = m.end()
    out.append(re.escape(_restore_escapes(s[pos:])))
    return "".join(out)


def glob_wildcards(pattern, files=None):
    """glob_wildcards("data/raw/{sample}_R1.fastq").sample -> ["NA12878", ...]"""
    rx = re.compile(_pattern_regex(os.path.normpath(str(pattern)), {}))
    names = _wildcard_names(pattern)
    found = collections.OrderedDict((n, []) for n in names)
    prefix = _strip_escapes(str(pattern)).split("{")[0]
    root = os.path.dirname(prefix) or "."
    paths = files
    if paths is None:
        paths = []
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort()
            for f in sorted(filenames + dirnames):
                p = os.path.normpath(os.path.join(dirpath, f))
                paths.append(p)
    for p in paths:
        m = rx.fullmatch(p)
        if m:
            for n in names:
                found[n].append(m.group(n))
    ns = Wildcards()
    for n, v in found.items():
        ns._add(n, v)
    return ns


class Namedlist(list):
    """a list whose items can also have names: input[0], input.ref"""

    _kind = "Namedlist"

    def __init__(self, items=None):
        super().__init__(items or [])
        object.__setattr__(self, "_names", collections.OrderedDict())

    def _add(self, name, value):
        start = len(self)
        if isinstance(value, (list, tuple)) and not isinstance(value, str):
            self.extend(value)
            end = len(self)
        else:
            self.append(value)
            end = start + 1
        if name is not None:
            self._names[name] = (start, end)

    def keys(self):
        return list(self._names.keys())

    def items(self):
        return [(k, self._get(k)) for k in self._names]

    def _get(self, name):
        start, end = self._names[name]
        if end - start == 1:
            return self[start]
        return Namedlist(self[start:end])

    def get(self, name, default=None):
        return self._get(name) if name in self._names else default

    def __getattr__(self, name):
        names = object.__getattribute__(self, "_names")
        if name in names:
            return self._get(name)
        raise AttributeError(f"'{type(self).__name__}' object has no attribute '{name}'", name=name, obj=self)

    def __dir__(self):
        return list(super().__dir__()) + list(object.__getattribute__(self, "_names"))

    def __getitem__(self, key):
        if isinstance(key, str):
            if key in self._names:
                return self._get(key)
            raise KeyError(key)
        return super().__getitem__(key)

    def __str__(self):
        return " ".join(str(x) for x in self)

    def __format__(self, spec):
        return format(str(self), spec)


class InputFiles(Namedlist):
    pass


class OutputFiles(Namedlist):
    pass


class Params(Namedlist):
    pass


class Log(Namedlist):
    pass


class Resources(Namedlist):
    pass


class Wildcards(Namedlist):
    pass


# ---------------------------------------------------------------------------
# Snakemake-style string formatting ("{input.ref}", lists joined by spaces)
# ---------------------------------------------------------------------------


class _SeqFormatter(string.Formatter):
    def format_field(self, value, spec):
        quote = spec.endswith("q")
        if spec.endswith("q") or spec.endswith("u"):
            spec = spec[:-1]
        if isinstance(value, Wildcards):
            return ",".join(f"{k}={v}" for k, v in sorted(value.items(), key=lambda kv: kv[0]))
        if isinstance(value, (list, tuple, set, frozenset)):
            parts = [format(v, spec) for v in value]
            return " ".join(shlex.quote(p) if quote and p else p for p in parts)
        s = format(value, spec)
        return shlex.quote(s) if quote and s else s


def _sm_format(pattern, variables):
    try:
        return _SeqFormatter().vformat(pattern, (), variables)
    except KeyError as ex:
        name = str(ex).strip("'")
        wc = variables.get("wildcards")
        if isinstance(wc, Wildcards) and name in wc.keys():
            raise NameError(f"The name '{name}' is unknown in this context. Did you mean 'wildcards.{name}'?")
        raise NameError(
            "The name {} is unknown in this context. Please make sure that you defined that variable. "
            "Also note that braces not used for variable access have to be escaped by repeating them, "
            "i.e. {{{{print $1}}}}".format(str(ex)))


# ============================================================================
# Snakefile -> Python
# ============================================================================

RULE_DIRECTIVES = {
    "input", "output", "params", "log", "benchmark", "threads", "resources", "conda", "shell", "run",
    "script", "message", "wildcard_constraints", "priority", "container", "singularity", "default_target",
    "localrule", "retries", "group", "shadow", "name", "notebook", "wrapper", "cache", "handover",
    "envmodules", "template_engine", "cwl", "handover", "pathvars",
}
ARGLIST = {"input", "output", "params", "log", "resources", "wildcard_constraints"}
TOPLEVEL = {
    "configfile", "include", "localrules", "ruleorder", "wildcard_constraints", "workdir", "onstart",
    "onsuccess", "onerror", "container", "containerized", "singularity", "conda", "envvars", "report",
    "pepfile", "pepschema", "module", "use", "scattergather", "inputflags", "outputflags", "storage",
    "resource_scopes",
}
RUN_ARGS = ("input, output, params, wildcards, threads, resources, log, rule, conda_env=None, "
            "container_img=None, singularity_args=None, use_singularity=False, env_modules=None, "
            "bench_record=None, jobid=None, is_shell=False, bench_iteration=None, cleanup_scripts=True, "
            "shadow_dir=None, edit_notebook=None, conda_base_path=None, basedir=None, sourcecache_path=None, "
            "runtime_sourcecache_path=None")


def _clean_msg(msg):
    return re.sub(r"\s*\(detected at line \d+\)", "", msg)


def _logical_starts(src, filename):
    """(row, col, depth, token) for the first token of every logical line"""
    starts = []
    depth = 0
    at_start = True
    lines = src.split("\n")
    try:
        for tok in tokenize.generate_tokens(io.StringIO(src).readline):
            if tok.type == tokenize.INDENT:
                depth += 1
                continue
            if tok.type == tokenize.DEDENT:
                depth -= 1
                continue
            if tok.type in (tokenize.NL, tokenize.COMMENT, tokenize.ENCODING):
                continue
            if tok.type == tokenize.NEWLINE:
                at_start = True
                continue
            if tok.type == tokenize.ENDMARKER:
                break
            if at_start:
                starts.append((tok.start[0], tok.start[1], depth, tok))
                at_start = False
    except tokenize.TokenError as e:
        msg, (row, col) = e.args
        if "EOF in multi-line string" in msg:
            msg = "unterminated triple-quoted string literal"
        elif "EOF in multi-line statement" in msg:
            msg = "'(' was never closed"
            row = _unclosed_bracket_line(src) or row
        row = min(max(row, 1), len(lines))
        raise SnakefileSyntaxError(_clean_msg(msg), row, filename, lines[row - 1] if lines else "")
    except (IndentationError, SyntaxError) as e:
        row = e.lineno or 1
        raise SnakefileSyntaxError(_clean_msg(e.msg), row, filename, (e.text or (lines[row - 1] if 0 < row <= len(lines) else "")))
    return starts


def _unclosed_bracket_line(src):
    stack = []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(src).readline):
            if tok.type == tokenize.OP and tok.string in "([{":
                stack.append(tok.start[0])
            elif tok.type == tokenize.OP and tok.string in ")]}" and stack:
                stack.pop()
    except (tokenize.TokenError, SyntaxError):
        pass
    return stack[0] if stack else None


class _Gen:
    """generated Python code, remembering the Snakefile line of each line"""

    def __init__(self):
        self.lines = []

    def add(self, text, orig):
        for i, t in enumerate(str(text).split("\n")):
            self.lines.append((t, orig + i if isinstance(orig, int) else orig))

    def add_map(self, text, origs):
        for t, o in zip(str(text).split("\n"), origs):
            self.lines.append((t, o))

    def code(self):
        return "\n".join(t for t, _ in self.lines) + "\n"

    def origin(self, genline):
        if genline and 1 <= genline <= len(self.lines):
            return self.lines[genline - 1][1]
        return genline


def translate(src, filename):
    """Snakefile text -> _Gen (Python code + line map)"""
    lines = src.split("\n")
    starts = _logical_starts(src, filename)
    gen = _Gen()
    top = [s for s in starts if s[2] == 0]
    for k, (row, col, depth, tok) in enumerate(top):
        end = top[k + 1][0] - 1 if k + 1 < len(top) else len(lines)
        first = lines[row - 1]
        m_rule = re.match(r"^(rule|checkpoint)\b\s*(\w*)\s*(:)?", first)
        m_kw = re.match(r"^(\w+)\s*:(?!=)", first)
        if m_rule and tok.string in ("rule", "checkpoint") and (m_rule.group(3) or re.match(r"^(rule|checkpoint)\s+\w+\s*$", first.split("#")[0].rstrip())):
            if not m_rule.group(3):
                raise SnakefileSyntaxError("Colon expected after rule name", row, filename, first)
            if m_rule.group(1) == "checkpoint":
                raise SnakefileSyntaxError("checkpoints are not available in this browser edition of Snakemake", row, filename, first)
            _translate_rule(gen, lines, starts, row, end, m_rule.group(2) or None, filename)
        elif m_kw and m_kw.group(1) in TOPLEVEL:
            _translate_toplevel(gen, lines, row, end, m_kw.group(1), first[m_kw.end():], filename)
        elif m_kw and m_kw.group(1) in RULE_DIRECTIVES and m_kw.group(1) not in ("input",):
            raise SnakefileSyntaxError(f"Keyword {m_kw.group(1)} is only allowed inside a rule. "
                                       "Indent it below a rule line (e.g. rule map_reads:)", row, filename, first)
        elif m_kw and m_kw.group(1) == "input":
            raise SnakefileSyntaxError("Keyword input is only allowed inside a rule. "
                                       "Indent it below a rule line (e.g. rule map_reads:)", row, filename, first)
        else:
            for r in range(row, end + 1):
                gen.add(lines[r - 1], r)
    return gen


def _block_text(lines, first_rest, row, end):
    """text of a directive: the rest of its first line and the lines below it"""
    body = [first_rest] + [lines[r - 1] for r in range(row + 1, end + 1)]
    rows = list(range(row, end + 1))
    while len(body) > 1 and (not body[-1].strip() or body[-1].strip().startswith("#")):
        body.pop()
        rows.pop()
    return body, rows


def _value_line(body, rows):
    for text, r in zip(body, rows):
        t = text.strip()
        if t and not t.startswith("#"):
            return r
    return rows[0]


def _translate_toplevel(gen, lines, row, end, kw, rest, filename):
    body, rows = _block_text(lines, rest, row, end)
    text = "\n".join(body).strip()
    if kw in ("onstart", "onsuccess", "onerror"):
        code_lines = body[1:] if not body[0].strip() else [body[0].strip()] + body[1:]
        code_rows = rows[1:] if not body[0].strip() else rows
        code = textwrap.dedent("\n".join(code_lines)) if code_lines else ""
        gen.add(f"def __{kw}_handler(log=None):", row)
        if code.strip():
            gen.add_map(textwrap.indent(code, "    "), code_rows)
        else:
            gen.add("    pass", row)
        gen.add(f"workflow.set_handler({kw!r}, __{kw}_handler)", row)
        return
    if kw in ("localrules", "ruleorder"):
        items = [x.strip() for x in re.split(r"[,>\s]+", re.sub(r"#.*", "", text)) if x.strip()]
        gen.add(f"workflow.toplevel({kw!r}, {row}, {items!r})", row)
        return
    if kw == "wildcard_constraints":
        gen.add(f"workflow.toplevel({kw!r}, {row}, dict(", row)
        gen.add_map("\n".join(body), rows)
        gen.add("))", rows[-1])
        return
    if kw not in ("configfile", "include"):
        gen.add(f"workflow.unsupported_toplevel({kw!r}, {row})", row)
        return
    gen.add(f"workflow.toplevel({kw!r}, {row}, (", row)
    gen.add_map("\n".join(body), rows)
    gen.add("))", rows[-1])


def _translate_rule(gen, lines, starts, row, end, name, filename):
    inner = [s for s in starts if row < s[0] <= end]
    rid = f"__r{row}"
    gen.add(f"{rid} = workflow.rule_begin({name!r}, {row})", row)
    if not inner:
        raise SnakefileSyntaxError("Expecting rule keyword, comment or docstrings inside a rule definition.",
                                   min(row + 1, len(lines)), filename, lines[min(row, len(lines) - 1)])
    body_depth = inner[0][2]
    items = [s for s in inner if s[2] == body_depth]
    if items and items[0][3].type == tokenize.STRING:
        items = items[1:]  # docstring
    seen_exec = None
    for k, (r, c, d, tok) in enumerate(items):
        e = items[k + 1][0] - 1 if k + 1 < len(items) else end
        text = lines[r - 1]
        if tok.type != tokenize.NAME:
            raise SnakefileSyntaxError("Expecting rule keyword, comment or docstrings inside a rule definition.", r, filename, text)
        m = re.match(r"^\s*(\w+)\s*(:)?", text)
        kw = m.group(1)
        if kw not in RULE_DIRECTIVES:
            raise SnakefileSyntaxError(f"Unexpected keyword {kw} in rule definition", r, filename, text)
        if not m.group(2):
            raise SnakefileSyntaxError(f"Colon expected after keyword {kw}.", r, filename, text)
        if kw in ("run", "shell", "script", "notebook", "wrapper", "template_engine", "cwl"):
            if seen_exec:
                raise SnakefileSyntaxError(
                    f"Multiple run/shell/script/notebook/wrapper/template_engine/cwl keywords in rule {name or row}.",
                    r, filename, text)
            seen_exec = kw
        rest = text[m.end():]
        body, rows = _block_text(lines, rest, r, e)
        vline = _value_line(body, rows)
        if kw == "run":
            code_lines = body[1:] if not body[0].strip() else [body[0].strip()] + body[1:]
            code_rows = rows[1:] if not body[0].strip() else rows
            code = textwrap.dedent("\n".join(code_lines)) if code_lines else ""
            fname = f"__rule_{name or row}"
            gen.add(f"def {fname}({RUN_ARGS}):", r)
            if code.strip():
                gen.add_map(textwrap.indent(code, "    "), code_rows)
            else:
                gen.add("    pass", r)
            gen.add(f"{rid}.directive('run', {r}, {vline}, {fname}, {code!r})", r)
        elif kw in ARGLIST:
            gen.add(f"{rid}.directive({kw!r}, {r}, {vline}, *__args(", r)
            gen.add_map("\n".join(body), rows)
            gen.add("))", rows[-1])
        else:
            src_text = "\n".join(body[1:] if not body[0].strip() else body) + "\n"
            gen.add(f"{rid}.directive({kw!r}, {r}, {vline}, __value(", r)
            gen.add_map("\n".join(body), rows)
            gen.add(f"), {src_text!r})", rows[-1])
    gen.add(f"workflow.rule_end({rid})", end)


def _args_helper(*args, **kwargs):
    return args, kwargs


def _value_helper(*args, **kwargs):
    if kwargs:
        raise TypeError("this keyword expects a single value, not name=value pairs")
    if len(args) != 1:
        return args
    return args[0]


# ============================================================================
# rules and the workflow
# ============================================================================


class Rule:
    def __init__(self, workflow, name, lineno):
        self.workflow = workflow
        self.name = name
        self.lineno = lineno
        self.snakefile = workflow.current_snakefile
        self.basedir = os.path.dirname(self.snakefile)
        self.input = ((), {})
        self.output = ((), {})
        self.params = ((), {})
        self.log = ((), {})
        self.resources = ((), {})
        self.wildcard_constraints = {}
        self.benchmark = None
        self.threads = 1
        self.conda = None
        self.shellcmd = None
        self.run = None
        self.run_src = None
        self.script = None
        self.script_code = None
        self.message = None
        self.localrule = False
        self.default_target = False
        self.retries = 0
        self.priority = 0
        self.lines = {}

    def directive(self, kw, lineno, vline, *args):
        self.lines[kw] = (lineno, vline)
        if kw in ARGLIST:
            args, kwargs = args
            if kw == "wildcard_constraints":
                self.wildcard_constraints.update(kwargs)
                return
            setattr(self, kw, (args, kwargs))
            return
        value = args[0] if args else None
        src_text = args[1] if len(args) > 1 else None
        where = dict(kind="SyntaxError", lineno=lineno, snakefile=self.snakefile)
        if kw == "shell":
            if isinstance(value, tuple):
                raise WorkflowError(
                    f"shell: expects one command (a single text string) but got {len(value)} parts separated by "
                    "commas. Remove the commas between the lines of the command - Python joins neighbouring "
                    "strings by itself.", "TypeError", lineno, self.snakefile)
            if not isinstance(value, str):
                raise WorkflowError(f"shell: expects a text string with the command, not {type(value).__name__}.",
                                    "TypeError", lineno, self.snakefile)
            self.shellcmd = value
            return
        if kw == "run":
            self.run = value
            self.run_src = src_text
            return
        if kw == "script":
            self.script = value
            self.script_code = src_text
            return
        if kw in ("message", "benchmark", "conda", "threads", "priority", "retries", "localrule", "default_target"):
            if isinstance(value, tuple) and kw != "conda":
                raise WorkflowError(f"{kw}: expects a single value.", **where)
            setattr(self, kw, value)
            return
        if kw == "name":
            self.name = value
            return
        if kw in ("container", "singularity", "envmodules", "group", "shadow", "cache", "handover", "pathvars"):
            self.workflow.note(f"Note: '{kw}:' in rule {self.name} is ignored in this browser edition.")
            return
        if kw in ("notebook", "wrapper", "cwl", "template_engine"):
            raise WorkflowError(
                f"'{kw}:' needs software from the internet, which this browser edition cannot fetch. "
                "Use shell: or script: instead.", "WorkflowError", lineno, self.snakefile, self.name)

    @property
    def norun(self):
        return self.shellcmd is None and self.run is None and self.script is None

    def output_patterns(self):
        args, kwargs = self.output
        return _flatten(list(args) + list(kwargs.values()))

    def log_patterns(self):
        args, kwargs = self.log
        return _flatten(list(args) + list(kwargs.values()))

    def wildcard_names(self):
        names = []
        for p in self.output_patterns():
            for n in _wildcard_names(p):
                if n not in names:
                    names.append(n)
        return names

    def code_record(self):
        if self.shellcmd is not None:
            return self.shellcmd
        if self.run is not None:
            return self.run_src
        if self.script is not None:
            return self.script_code
        return None

    def script_path(self):
        if self.script is None:
            return None
        return self.script if os.path.isabs(self.script) else os.path.join(self.basedir, self.script)

    def conda_path(self):
        if not self.conda:
            return None
        return self.conda if os.path.isabs(self.conda) else os.path.join(self.basedir, self.conda)


class _RulesNS:
    def __init__(self):
        self._rules = {}

    def __getattr__(self, name):
        rules = object.__getattribute__(self, "_rules")
        if name in rules:
            return rules[name]
        raise AttributeError(f"There is no rule called '{name}' (yet): rules can only be referred to after they are defined.")


class _RuleProxy:
    def __init__(self, rule):
        self._rule = rule

    def _ns(self, cls, spec):
        ns = cls()
        args, kwargs = spec
        for a in args:
            ns._add(None, a)
        for k, v in kwargs.items():
            ns._add(k, v)
        return ns

    @property
    def output(self):
        return self._ns(OutputFiles, self._rule.output)

    @property
    def input(self):
        return self._ns(InputFiles, self._rule.input)

    @property
    def log(self):
        return self._ns(Log, self._rule.log)

    @property
    def name(self):
        return self._rule.name

    @property
    def rule(self):
        return self._rule


class _WorkflowAPI:
    """the `workflow` object seen by Snakefiles"""

    def __init__(self, wf):
        self._wf = wf

    def __getattr__(self, name):
        wf = object.__getattribute__(self, "_wf")
        if name in ("rule_begin", "rule_end", "toplevel", "unsupported_toplevel", "set_handler"):
            return getattr(wf, name)
        if name == "basedir":
            return os.path.dirname(wf.current_snakefile)
        if name == "main_snakefile" or name == "snakefile":
            return wf.snakefile
        if name == "cores":
            return wf.cores
        if name == "config":
            return wf.config
        raise AttributeError(f"'Workflow' object has no attribute '{name}' in this browser edition")


class Workflow:
    def __init__(self, snakefile, overwrite_config=None, configfiles=None, cores=1):
        self.snakefile = os.path.abspath(snakefile)
        self.current_snakefile = self.snakefile
        self.rules = []
        self.rule_by_name = {}
        self.config = {}
        self.configfiles = []
        self.overwrite_config = overwrite_config or {}
        self.extra_configfiles = configfiles or []
        self.global_constraints = {}
        self.ruleorder = []
        self.localrules = set()
        self.handlers = {}
        self.notes = []
        self.rules_ns = _RulesNS()
        self.globals = None
        self.linemaps = {}
        self.sources = {}
        self.cores = cores

    def note(self, msg):
        if msg not in self.notes:
            self.notes.append(msg)

    # --- called from the translated Snakefile
    def rule_begin(self, name, lineno):
        if name is None:
            name = str(len(self.rules) + 1)
        if name in self.rule_by_name:
            raise WorkflowError(f"The name {name} is already used by another rule", "CreateRuleException",
                                lineno, self.current_snakefile)
        return Rule(self, name, lineno)

    def rule_end(self, rule):
        sets = [set(_wildcard_names(p)) for p in rule.output_patterns()]
        for lp in rule.log_patterns() + ([rule.benchmark] if rule.benchmark else []):
            sets.append(set(_wildcard_names(lp)))
        if sets and any(s != sets[0] for s in sets):
            raise WorkflowError(
                f"Not all output, log and benchmark files of rule {rule.name} contain the same wildcards. "
                "This is crucial though, in order to avoid that two or more jobs write to the same file.",
                "RuleException", rule.lineno, rule.snakefile)
        if rule.name in self.rule_by_name:
            raise WorkflowError(f"The name {rule.name} is already used by another rule", "CreateRuleException",
                                rule.lineno, rule.snakefile)
        self.rules.append(rule)
        self.rule_by_name[rule.name] = rule
        self.rules_ns._rules[rule.name] = _RuleProxy(rule)

    def toplevel(self, kw, lineno, value):
        if kw == "configfile":
            path = str(value)
            if not os.path.exists(path):
                raise WorkflowError(
                    f"Workflow defines configfile {path} but it is not present or accessible "
                    f"(full checked path: {os.path.abspath(path)}).", "WorkflowError", lineno, self.current_snakefile)
            self.load_configfile(path, lineno)
        elif kw == "include":
            path = value if os.path.isabs(value) else os.path.join(os.path.dirname(self.current_snakefile), value)
            if not os.path.exists(path):
                raise WorkflowError(f"Included file {path} not found.", "WorkflowError", lineno, self.current_snakefile)
            self.include(path)
        elif kw == "localrules":
            self.localrules.update(value)
        elif kw == "ruleorder":
            self.ruleorder.append(list(value))
        elif kw == "wildcard_constraints":
            self.global_constraints.update(value)

    def unsupported_toplevel(self, kw, lineno):
        self.note(f"Note: '{kw}:' (line {lineno}) is ignored in this browser edition.")

    def set_handler(self, kind, fn):
        self.handlers[kind] = fn

    def load_configfile(self, path, lineno=None):
        import yaml

        try:
            with open(path) as fh:
                text = fh.read()
            data = yaml.safe_load(text) if text.strip() else {}
        except yaml.YAMLError as e:
            mark = getattr(e, "problem_mark", None)
            where = f" (line {mark.line + 1}, column {mark.column + 1})" if mark else ""
            raise WorkflowError(f"Config file {path} is not valid YAML{where}: {getattr(e, 'problem', None) or e}",
                                "WorkflowError", lineno, self.current_snakefile)
        if data is None:
            data = {}
        if not isinstance(data, dict):
            raise WorkflowError(f"Config file {path} must contain names and values (a YAML mapping), e.g.  samples: [NA12878]",
                                "WorkflowError", lineno, self.current_snakefile)
        _deep_update(self.config, data)
        _deep_update(self.config, self.overwrite_config)
        if path not in self.configfiles:
            self.configfiles.append(path)

    def include(self, path):
        with open(path) as fh:
            src = fh.read()
        prev = self.current_snakefile
        self.current_snakefile = os.path.abspath(path)
        try:
            self._exec_snakefile(src, self.current_snakefile)
        finally:
            self.current_snakefile = prev

    def load(self):
        with open(self.snakefile) as fh:
            src = fh.read()
        g = {
            "__name__": "snakemake.workflow",
            "__builtins__": __builtins__,
            "workflow": _WorkflowAPI(self),
            "config": self.config,
            "rules": self.rules_ns,
            "expand": expand, "collect": collect, "temp": temp, "protected": protected,
            "directory": directory, "ancient": ancient, "touch": touch, "report": report, "pipe": pipe,
            "service": service, "multiext": multiext, "unpack": unpack, "glob_wildcards": glob_wildcards,
            "min_version": min_version, "shell": _ShellFunction(), "os": os, "sys": sys,
            "__args": _args_helper, "__value": _value_helper, "Path": __import__("pathlib").Path,
        }
        self.globals = g
        for cf in self.extra_configfiles:
            if not os.path.exists(cf):
                raise WorkflowError(f"Config file {cf} not found.", "WorkflowError")
            self.load_configfile(cf)
        _deep_update(self.config, self.overwrite_config)
        self._exec_snakefile(src, self.snakefile)

    def _exec_snakefile(self, src, path):
        self.sources[path] = src
        gen = translate(src, path)
        self.linemaps[path] = gen
        code_text = gen.code()
        src_lines = src.split("\n")
        try:
            code = compile(code_text, path, "exec")
        except SyntaxError as e:
            line = gen.origin(e.lineno or 1)
            text = src_lines[line - 1] if isinstance(line, int) and 0 < line <= len(src_lines) else (e.text or "")
            raise SnakefileSyntaxError(_clean_msg(e.msg), line, path, text)
        try:
            exec(code, self.globals)
        except WorkflowError as e:
            if e.lineno is None:
                e.lineno = _origin_from_tb(e, path, gen)
                e.snakefile = path if e.lineno is not None else e.snakefile
            raise
        except Exception as e:
            line = _origin_from_tb(e, path, gen)
            msg = str(e)
            hint = None
            if isinstance(e, KeyError):
                msg = repr(e.args[0]) if e.args else "KeyError"
                src_line = src_lines[line - 1] if line and 0 < line <= len(src_lines) else ""
                if "config" in src_line:
                    keys = ", ".join(map(str, self.config.keys())) or "(none)"
                    hint = (f"config has no entry {msg}. The entries in your config file are: {keys}. "
                            "Check the spelling in the Snakefile and in config/config.yaml.")
            if isinstance(e, NameError):
                hint = _name_hint(e)
            trace = f'  File "{path}", line {line}, in <module>' if line else None
            raise WorkflowError(msg, type(e).__name__, line, path, trace=trace, hint=hint)

    def constraints_for(self, rule):
        c = dict(self.global_constraints)
        c.update(rule.wildcard_constraints)
        return c

    def default_target_rule(self):
        for r in self.rules:
            if r.default_target:
                return r
        return self.rules[0] if self.rules else None

    def rule_rank(self, rule):
        for order in self.ruleorder:
            if rule.name in order:
                return order.index(rule.name)
        return None


def _origin_from_tb(e, path, gen):
    for fr in reversed(traceback.extract_tb(e.__traceback__)):
        if fr.filename == path:
            return gen.origin(fr.lineno)
    return None


def _flatten(x):
    out = []
    for v in x if isinstance(x, (list, tuple)) else [x]:
        if isinstance(v, (list, tuple)):
            out.extend(_flatten(v))
        elif isinstance(v, dict):
            out.extend(_flatten(list(v.values())))
        elif v is not None:
            out.append(v)
    return out


def _deep_update(a, b):
    for k, v in (b or {}).items():
        if isinstance(v, dict) and isinstance(a.get(k), dict):
            _deep_update(a[k], v)
        else:
            a[k] = v


def _name_hint(e):
    m = re.search(r"name '(\w+)' is not defined", str(e))
    if not m:
        return None
    n = m.group(1)
    return (f"Python does not know the name '{n}'. Is it spelt correctly, and is it defined above this line? "
            "Text such as a file name needs quotes: \"like/this.txt\".")


class _ShellFunction:
    """shell() outside a run: block (at the top of a Snakefile)"""

    def __call__(self, cmd, *a, **kwargs):
        raise WorkflowError("shell() can only be used inside a run: block of a rule in this browser edition.")


# ============================================================================
# jobs and the DAG
# ============================================================================


class Job:
    def __init__(self, rule, wildcards, dag):
        self.rule = rule
        self.dag = dag
        self.wildcards_dict = dict(wildcards)
        self.wildcards = Wildcards()
        for k, v in self.wildcards_dict.items():
            self.wildcards._add(k, v)
        self.jobid = None
        self.failed = False
        self._shellcmd = None
        self._expand()

    @property
    def name(self):
        return self.rule.name

    def __repr__(self):
        return f"Job({self.rule.name}, {self.wildcards_dict})"

    def _format(self, pattern, what):
        try:
            return os.path.normpath(_fill(pattern, self.wildcards_dict)) if pattern else pattern
        except KeyError as e:
            r = self.rule
            raise WorkflowError(f"Wildcards in {what} files cannot be determined from output files:\n'{e.args[0]}'",
                                "WildcardError", r.lineno, r.snakefile, r.name)

    def _call(self, fn, what):
        r = self.rule
        try:
            return _call_with_names(fn, wildcards=self.wildcards)
        except WorkflowError:
            raise
        except Exception as e:
            tb = [fr for fr in traceback.extract_tb(e.__traceback__) if fr.filename == r.snakefile]
            gen = r.workflow.linemaps.get(r.snakefile)
            trace = "\n".join(f'  File "{fr.filename}", line {gen.origin(fr.lineno) if gen else fr.lineno}, in {fr.name}' for fr in tb)
            raise WorkflowError(
                f"Error:\n  {type(e).__name__}: {e}\nWildcards:\n" + "\n".join(f"  {k}={v}" for k, v in self.wildcards_dict.items())
                + ("\nTraceback:\n" + trace if trace else ""),
                "InputFunctionException", r.lineno, r.snakefile, r.name)

    def _expand(self):
        r = self.rule
        self.output = OutputFiles()
        self.output_flags = {}
        oargs, okwargs = r.output
        for name, v in [(None, a) for a in oargs] + list(okwargs.items()):
            items = _flatten(v) if isinstance(v, (list, tuple, dict)) else [v]
            files = []
            for x in items:
                f = self._format(x, "output")
                self.output_flags[f] = _flags_of(x)
                files.append(f)
            self.output._add(name, files if isinstance(v, (list, tuple, dict)) else files[0])
        self.input = InputFiles()
        self.input_flags = {}
        iargs, ikwargs = r.input

        def add(name, item):
            v = item
            unpacked = getattr(item, "_snakemake_unpack", False)
            if callable(item):
                v = self._call(item, "input")
            if unpacked and isinstance(v, dict):
                for k2, v2 in v.items():
                    add(k2, v2)
                return
            if unpacked and isinstance(v, (list, tuple)):
                for v2 in v:
                    add(None, v2)
                return
            if isinstance(v, (list, tuple, dict)):
                files = []
                for x in _flatten(v):
                    f = self._format(x, "input")
                    self.input_flags[f] = _flags_of(x)
                    files.append(f)
                self.input._add(name, files)
            else:
                if v is None:
                    raise WorkflowError(f"An input of rule {r.name} is None: check the input function or config value.",
                                        "WorkflowError", r.lineno, r.snakefile, r.name)
                f = self._format(v, "input")
                self.input_flags[f] = _flags_of(v)
                self.input._add(name, f)

        for a in iargs:
            add(None, a)
        for k, v in ikwargs.items():
            add(k, v)
        self.log = Log()
        largs, lkwargs = r.log
        for name, v in [(None, a) for a in largs] + list(lkwargs.items()):
            self.log._add(name, self._format(v, "log"))
        self.benchmark = self._format(r.benchmark, "benchmark") if r.benchmark else None
        # threads, scaled down to the cores
        t = r.threads
        if callable(t):
            t = _call_with_names(t, wildcards=self.wildcards)
        try:
            t = int(t)
        except (TypeError, ValueError):
            t = 1
        self.threads = max(1, min(t, self.dag.cores if self.dag else t))
        self.resources = Resources()
        rargs, rkwargs = r.resources
        for k, v in rkwargs.items():
            self.resources._add(k, _call_with_names(v, wildcards=self.wildcards, input=self.input, threads=self.threads) if callable(v) else v)
        self.resources._add("tmpdir", "/tmp")
        # params (functions get the wildcards, and may ask for input/output/threads/resources)
        self.params = Params()
        self.derived_params = set()
        pargs, pkwargs = r.params
        for i, (name, v) in enumerate([(None, a) for a in pargs] + list(pkwargs.items())):
            if callable(v):
                names = _arg_names(v)
                if names & {"input", "output", "threads", "resources"}:
                    self.derived_params.add(i)
                try:
                    val = _call_with_names(v, wildcards=self.wildcards, input=self.input, output=self.output,
                                           threads=self.threads, resources=self.resources)
                except Exception as e:
                    raise WorkflowError(f"{type(e).__name__} in params function of rule {r.name}: {e}",
                                        "InputFunctionException", r.lineno, r.snakefile, r.name)
            else:
                val = v
                if isinstance(v, str):
                    try:
                        val = _fill(v, self.wildcards_dict)
                    except KeyError:
                        val = v
            self.params._add(name, val)

    def _wc_text(self):
        return ", ".join(f"{k}={v}" for k, v in self.wildcards_dict.items())

    def format_vars(self):
        v = dict(self.rule.workflow.globals or {})
        v.update(input=self.input, output=self.output, params=self.params, wildcards=self.wildcards,
                 threads=self.threads, resources=self.resources, log=self.log, jobid=self.jobid,
                 name=self.rule.name, rule=self.rule.name)
        return v

    def format(self, pattern):
        try:
            return _sm_format(pattern, self.format_vars())
        except Exception as ex:
            raise WorkflowError(f"{type(ex).__name__}: {ex}, when formatting the following:\n{pattern}",
                                "RuleException", self.rule.lineno, self.rule.snakefile, self.rule.name)

    @property
    def shellcmd(self):
        if self.rule.shellcmd is None:
            return None
        if self._shellcmd is None:
            self._shellcmd = self.format(self.rule.shellcmd)
        return self._shellcmd

    @property
    def message(self):
        if self.rule.message is None:
            return None
        return self.format(str(self.rule.message))

    def products(self):
        return list(self.output)

    def non_derived_params(self):
        return [p for i, p in enumerate(self.params) if i not in self.derived_params]


def _arg_names(fn):
    try:
        return set(inspect.signature(fn).parameters)
    except (TypeError, ValueError):
        return set()


def _call_with_names(fn, **avail):
    try:
        params = list(inspect.signature(fn).parameters.values())
    except (TypeError, ValueError):
        return fn(avail.get("wildcards"))
    args, kwargs = [], {}
    for i, p in enumerate(params):
        if p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
            continue
        if p.name in avail and p.name != "wildcards":
            kwargs[p.name] = avail[p.name]
        elif i == 0:
            args.append(avail.get("wildcards"))
        elif p.default is p.empty and p.name in avail:
            kwargs[p.name] = avail[p.name]
    return fn(*args, **kwargs)


class ParamsChange:
    def __init__(self, only_old=(), only_new=()):
        self.only_old = set(only_old)
        self.only_new = set(only_new)

    def __bool__(self):
        return bool(self.only_old or self.only_new)

    def __str__(self):
        def fmt(s, label):
            return f"{label}: {','.join(sorted(s))}" if s else f"{label}: <nothing exclusive>"

        return ("Union of exclusive params before and now across all output: "
                f"{fmt(self.only_old, 'before')} {fmt(self.only_new, 'now')} ")


class Reason:
    def __init__(self):
        self.forced = False
        self.noio = False
        self.nooutput = False
        self.missing_output = {}
        self.updated_input = {}
        self.updated_input_run = {}
        self.input_changed = False
        self.code_changed = False
        self.params_changed = None
        self.software_stack_changed = False

    def clear(self):
        self.__init__()

    def __bool__(self):
        return bool(self.forced or self.noio or self.nooutput or self.missing_output or self.updated_input
                    or self.updated_input_run or self.input_changed or self.code_changed or self.params_changed
                    or self.software_stack_changed)

    def names(self):
        if self.forced:
            yield "forced"
        if self.noio:
            yield "neither input nor output"
        if self.nooutput:
            yield "run or shell but no output"
        if self.missing_output:
            yield "output files have to be generated"
        if self.updated_input:
            yield "updated input files"
        if self.updated_input_run:
            yield "input files updated by another job"
        if self.input_changed:
            yield "set of input files has changed since last execution"
        if self.code_changed:
            yield "code has changed since last execution"
        if self.params_changed:
            yield "params have changed since last execution"
        if self.software_stack_changed:
            yield "software environment definition has changed since last execution"

    def provenance_triggered(self):
        return bool(self.input_changed or self.code_changed or self.params_changed or self.software_stack_changed)

    def __str__(self):
        s = []
        if self.forced:
            s.append("Forced execution")
        elif self.noio:
            s.append("Rules with neither input nor output files are always executed.")
        elif self.nooutput:
            s.append("Rules with a run or shell declaration but no output are always executed.")
        else:
            if self.missing_output:
                s.append("Missing output files: " + ", ".join(self.missing_output))
            upd = [f for f in self.updated_input if f not in self.updated_input_run]
            if upd:
                s.append("Updated input files: " + ", ".join(upd))
            if self.updated_input_run:
                s.append("Input files updated by another job: " + ", ".join(self.updated_input_run))
            if self.input_changed:
                s.append("Set of input files has changed since last execution")
            if self.code_changed:
                s.append("Code has changed since last execution")
            if self.params_changed:
                s.append(f"Params have changed since last execution: {self.params_changed}")
            if self.software_stack_changed:
                s.append("Software environment definition has changed since last execution")
        return "; ".join(s)


class DAG:
    def __init__(self, wf, targets, *, forceall=False, forcerun=None, force=False, until=(), cores=1,
                 use_conda=False, triggers=None):
        self.wf = wf
        self.cores = cores
        self.use_conda = use_conda
        self.triggers = triggers or {"mtime", "params", "input", "software-env", "code"}
        self.jobs = {}
        self.joblist = []
        self.dependencies = {}
        self.depending = {}
        self.targetjobs = []
        self.targetrules = set()
        self.targetfiles = set()
        self._building = []
        self._rx_cache = {}
        self.reasons = {}
        self.needrun = []
        self._resolve_targets(targets)
        self.forcerules, self.forcefiles = set(), set()
        if forceall:
            self.forcerules = {r.name for r in wf.rules}
        if force:
            self.forcerules |= {r.name for r in self.targetrules}
            self.forcefiles |= set(self.targetfiles)
        if forcerun is not None:
            items = forcerun or [r.name for r in self.targetrules]
            for x in items:
                if x in wf.rule_by_name:
                    self.forcerules.add(x)
                else:
                    self.forcefiles.add(os.path.normpath(x))
        self._number()
        if until:
            self._apply_until(until)

    # --- building
    def _resolve_targets(self, targets):
        wf = self.wf
        if not wf.rules:
            raise WorkflowError("There are no rules in the Snakefile yet.", "WorkflowError")
        if not targets:
            targets = [wf.default_target_rule().name]
        for t in targets:
            if t in wf.rule_by_name:
                r = wf.rule_by_name[t]
                if r.wildcard_names():
                    raise WorkflowError(
                        "Target rules may not contain wildcards. Please specify concrete files or a rule without "
                        "wildcards at the command line, or have a rule without wildcards at the very top of your "
                        "workflow (e.g. the typical \"rule all\" which just collects all results you want to "
                        "generate in the end).", "WorkflowError")
                job = self._job(r, {})
                self.targetrules.add(r)
                if job not in self.targetjobs:
                    self.targetjobs.append(job)
            else:
                path = os.path.normpath(t)
                self.targetfiles.add(path)
                cands = self._candidates(path)
                if not cands:
                    if os.path.exists(path):
                        continue
                    raise WorkflowError(
                        f"No rule to produce {t} (if you use input functions make sure that they don't raise "
                        "unexpected exceptions).", "MissingRuleException",
                        hint="Check the spelling of the file name, and compare it with the output: of your rules "
                             "(snakemake -l lists the rules).")
                job = self._choose(path, cands)
                if job not in self.targetjobs:
                    self.targetjobs.append(job)

    def _candidates(self, path):
        out = []
        for r in self.wf.rules:
            for pat in r.output_patterns():
                m = self._regex(r, pat).fullmatch(path)
                if m:
                    out.append((r, m.groupdict()))
                    break
        return out

    def _regex(self, rule, pat):
        key = (rule.name, str(pat))
        rx = self._rx_cache.get(key)
        if rx is None:
            p = str(pat)
            if "{" not in p:
                p = os.path.normpath(p)
            rx = re.compile(_pattern_regex(p, self.wf.constraints_for(rule)))
            self._rx_cache[key] = rx
        return rx

    def _choose(self, path, cands):
        wf = self.wf
        if len(cands) > 1:
            ranked = [(wf.rule_rank(r), r, wc) for r, wc in cands]
            if all(x[0] is not None for x in ranked):
                ranked.sort(key=lambda x: x[0])
                cands = [(ranked[0][1], ranked[0][2])]
        if len(cands) == 1:
            r, wc = cands[0]
            return self._job(r, wc)
        viable, errors = [], []
        for r, wc in cands:
            try:
                viable.append((r, self._job(r, wc)))
            except WorkflowError as e:
                if e.kind in ("MissingInputException", "WildcardError", "CyclicGraphException", "InputFunctionException"):
                    errors.append(e)
                    continue
                raise
        if len(viable) == 1:
            return viable[0][1]
        if not viable:
            raise errors[0]
        order = list(reversed(viable))
        names = " and ".join(r.name for r, _ in order)
        text = (f"Rules {names} are ambiguous for the file {path}.\n"
                "Consider starting rule output with a unique prefix, constrain your wildcards, or use the ruleorder directive.\n"
                "Wildcards:\n" + "\n".join(f"\t{r.name}: {j._wc_text()}" for r, j in order) +
                "\nExpected input files:\n" + "\n".join(f"\t{r.name}: {' '.join(j.input)}" for r, j in order) +
                "\nExpected output files:\n" + "\n".join(f"\t{r.name}: {' '.join(j.output)}" for r, j in order))
        raise WorkflowError(text, "AmbiguousRuleException",
                            hint="Two rules can make the same file. Rename one rule's output, or remove the duplicate rule.")

    def _job(self, rule, wildcards):
        key = (rule.name, tuple(sorted(wildcards.items())))
        if key in self.jobs:
            return self.jobs[key]
        if key in self._building:
            raise WorkflowError(f"Cyclic dependency on rule {rule.name}.", "CyclicGraphException",
                                rule.lineno, rule.snakefile, rule.name)
        job = Job(rule, wildcards, self)
        self._building.append(key)
        try:
            deps = collections.OrderedDict()
            missing = []
            for f in job.input:
                cands = self._candidates(f)
                if cands:
                    try:
                        dep = self._choose(f, cands)
                    except WorkflowError as e:
                        if e.kind == "MissingInputException" and os.path.exists(f):
                            continue
                        raise
                    if dep is job:
                        raise WorkflowError(f"Cyclic dependency on rule {rule.name}.", "CyclicGraphException",
                                            rule.lineno, rule.snakefile, rule.name)
                    deps.setdefault(dep, [])
                    if f not in deps[dep]:
                        deps[dep].append(f)
                elif not os.path.exists(f):
                    missing.append(f)
            if missing:
                text = f"Missing input files for rule {rule.name}:\n"
                if len(job.output):
                    text += f"    output: {', '.join(job.output)}\n"
                if job.wildcards_dict:
                    text += f"    wildcards: {job._wc_text()}\n"
                text += "    affected files:\n" + "\n".join("        " + m for m in missing)
                raise WorkflowError(text, "MissingInputException", rule.lineno, rule.snakefile, rule.name,
                                    hint=_missing_hint(missing))
        finally:
            self._building.pop()
        self.jobs[key] = job
        self.joblist.append(job)
        self.dependencies[job] = deps
        self.depending.setdefault(job, collections.OrderedDict())
        for dep, files in deps.items():
            self.depending.setdefault(dep, collections.OrderedDict()).setdefault(job, []).extend(files)
        return job

    def _number(self):
        """job ids: depth-first from the targets, in input order (like Snakemake)"""
        seen = set()
        order = []

        def visit(j):
            if j in seen:
                return
            seen.add(j)
            order.append(j)
            for d in self.dependencies[j]:
                visit(d)

        for t in self.targetjobs:
            visit(t)
        keep = set(order)
        for i, j in enumerate(order):
            j.jobid = i
        self.joblist = order
        for j in list(self.dependencies):
            if j not in keep:
                del self.dependencies[j]
        for j in list(self.depending):
            if j not in keep:
                del self.depending[j]
            else:
                self.depending[j] = collections.OrderedDict((k, v) for k, v in self.depending[j].items() if k in keep)

    def _apply_until(self, until):
        rules = {u for u in until if u in self.wf.rule_by_name}
        files = {os.path.normpath(u) for u in until if u not in self.wf.rule_by_name}
        roots = [j for j in self.joblist if j.name in rules or files & set(j.output)]
        keep = set()
        stack = list(roots)
        while stack:
            j = stack.pop()
            if j in keep:
                continue
            keep.add(j)
            stack.extend(self.dependencies[j])
        self.joblist = [j for j in self.joblist if j in keep]
        for j in list(self.dependencies):
            if j not in keep:
                del self.dependencies[j]
        for j in list(self.depending):
            if j not in keep:
                del self.depending[j]
            else:
                self.depending[j] = collections.OrderedDict((k, v) for k, v in self.depending[j].items() if k in keep)
        self.targetjobs = roots
        self.targetrules |= {j.rule for j in roots}

    # --- graph helpers
    def levels(self, jobs):
        jobs = list(jobs)
        jobset = set(jobs)
        remaining = {j: {d for d in self.dependencies.get(j, {}) if d in jobset} for j in jobs}
        levels = []
        while remaining:
            ready = [j for j, d in remaining.items() if not d]
            if not ready:
                raise WorkflowError("Cyclic dependency between jobs.", "CyclicGraphException")
            levels.append(ready)
            for j in ready:
                del remaining[j]
            for d in remaining.values():
                d.difference_update(ready)
        return levels

    def downstream(self, job):
        out, stack = set(), [job]
        while stack:
            j = stack.pop()
            if j in out:
                continue
            out.add(j)
            stack.extend(self.depending.get(j, {}))
        return out

    def requested(self, job):
        files = []
        for down, fl in self.depending.get(job, {}).items():
            files.extend(fl)
        files.extend(f for f in job.output if f in self.targetfiles)
        return list(dict.fromkeys(files))

    # --- which jobs have to run?
    def update_needrun(self):
        R = self.reasons = {j: Reason() for j in self.joblist}
        needrun = set()
        levels = self.levels(self.joblist)

        def is_forced(j):
            return j.name in self.forcerules or bool(self.forcefiles & set(j.output))

        if self.joblist and all(is_forced(j) for j in self.joblist):
            for j in self.joblist:
                R[j].forced = True
                needrun.add(j)
        else:
            omt = {}
            for level in reversed(levels):
                for j in level:
                    t = _output_mintime(j)
                    if t is None:
                        for d in self.depending.get(j, {}):
                            t = omt.get(d)
                            if t is not None:
                                break
                    omt[j] = t
            masked = set()
            queue = collections.deque()
            for level in levels:
                for j in level:
                    if j in masked:
                        continue
                    if self._update_needrun_job(j, R[j], omt, is_forced):
                        queue.append(j)
                        masked.update(self.downstream(j))
            visited = set(queue)
            while queue:
                j = queue.popleft()
                needrun.add(j)
                for dep, files in self.dependencies.get(j, {}).items():
                    missing = [f for f in files if not os.path.exists(f)]
                    for f in missing:
                        R[dep].missing_output[f] = True
                    if missing and dep not in visited:
                        visited.add(dep)
                        queue.append(dep)
                for down, files in self.depending.get(j, {}).items():
                    if down not in visited:
                        if all(down.input_flags.get(f, {}).get("ancient") and os.path.exists(f) for f in files):
                            continue
                        visited.add(down)
                        queue.append(down)
                    for f in files:
                        R[down].updated_input_run[f] = True
        self.needrun = [j for j in self.joblist if j in needrun]
        return self.needrun

    def _update_needrun_job(self, job, r, omt, is_forced):
        if is_forced(job):
            r.forced = True
        elif job in self.targetjobs:
            if not job.products():
                if len(job.input):
                    if job.rule.norun:
                        for f in job.input:
                            if not os.path.exists(f):
                                r.updated_input_run[f] = True
                    else:
                        r.nooutput = True
                else:
                    r.noio = True
            else:
                if job.rule in self.targetrules:
                    files = job.products()
                else:
                    files = self.requested(job)
                for f in job.output:
                    if f in files and not os.path.exists(f):
                        r.missing_output[f] = True
        if not r:
            t = omt.get(job)
            if t is not None:
                for f in job.input:
                    if job.input_flags.get(f, {}).get("ancient"):
                        continue
                    mt = _mtime(f)
                    if mt is not None and mt > t and not _same_checksum(f, job):
                        r.updated_input[f] = True
            if not r.updated_input:
                if "code" in self.triggers:
                    r.code_changed = _script_newer(job)
                records = [read_meta(f) for f in job.output]
                if job.output and all(records):
                    if "params" in self.triggers:
                        new = set(_params_record(job))
                        change = ParamsChange()
                        for rec in records:
                            if rec.get("record_format_version", 0) >= 6 and rec.get("params") is not None:
                                old = set(rec["params"])
                                change.only_old |= old - new
                                change.only_new |= new - old
                        r.params_changed = change if change else None
                    if "input" in self.triggers:
                        r.input_changed = any(rec.get("input") is not None and rec.get("input") != sorted(job.input)
                                              for rec in records)
                    if "code" in self.triggers:
                        code = job.rule.code_record()
                        r.code_changed = r.code_changed or any(
                            rec.get("code") is not None and rec.get("code") != code for rec in records)
                    if "software-env" in self.triggers:
                        h = _software_stack_hash(job, self.use_conda)
                        r.software_stack_changed = any(
                            rec.get("software_stack_hash") is not None and rec.get("software_stack_hash") != h
                            for rec in records)
        return bool(r)


def _missing_hint(missing):
    glued = [m for m in missing if re.search(r"\.(fa|fasta|fai|fq|fastq|bam|bai|vcf|gz|bcf|txt|tsv|yaml|py)"
                                             r"(?=[A-Za-z_][A-Za-z0-9_.-]*/)", m)]
    if glued:
        return ("This name looks like two file names run together. In Python, two strings with nothing between "
                "them are joined into one (\"a\" \"b\" is \"ab\"): check the commas between the files in input:.")
    d = os.path.dirname(missing[0])
    where = ("ls " + d + " shows what is there") if (not d or os.path.isdir(d)) else ("the folder " + d + " does not exist")
    return ("Snakemake could not find these files, and no rule makes them. Check the spelling of the file name "
            "(" + where + "), or add a rule whose output: matches it.")


def _mtime(p):
    try:
        return os.stat(p).st_mtime
    except OSError:
        return None


def _output_mintime(job):
    ts = [_mtime(f) for f in job.output]
    ts = [t for t in ts if t is not None]
    return min(ts) if ts else None


def _script_newer(job):
    path = job.rule.script_path()
    if not path or not os.path.exists(path):
        return False
    st = _mtime(path)
    for f in job.output:
        mt = _mtime(f)
        if mt is not None and not mt > st:
            return True
    return False


def _same_checksum(f, job):
    try:
        if not os.path.isfile(f) or os.path.getsize(f) > MAX_CHECKSUM_FILE_SIZE:
            return False
    except OSError:
        return False
    recorded = set()
    for o in job.output:
        rec = read_meta(o)
        recorded.add((rec or {}).get("input_checksums", {}).get(f) if rec else None)
    if len(recorded) != 1:
        return False
    value = recorded.pop()
    if not value:
        return False
    return checksum(f) == value


# ============================================================================
# provenance records (.snakemake/metadata)
# ============================================================================


def _meta_path(f):
    b64 = base64.urlsafe_b64encode(str(f).encode()).decode()
    parts = [b64[i:i + 255] for i in range(0, len(b64), 255)] or [b64]
    return os.path.join(META_DIR, *parts)


def read_meta(f):
    p = _meta_path(f)
    try:
        with open(p) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def write_meta(f, record):
    p = _meta_path(f)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as fh:
        json.dump(record, fh)


def delete_meta(f):
    try:
        os.remove(_meta_path(f))
        return True
    except OSError:
        return False


def checksum(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return "sha256:" + h.hexdigest()


def _params_record(job):
    out = []
    for v in job.non_derived_params():
        if v is None or isinstance(v, (int, float, bool, str, complex, range, list, tuple, dict, set, frozenset, bytes)):
            out.append(repr(v))
    return sorted(out)


def _conda_record(job):
    path = job.rule.conda_path()
    if not path:
        return None
    try:
        with open(path, "rb") as fh:
            return base64.b64encode(fh.read()).decode()
    except OSError:
        return None


def _env_hash(path):
    with open(path, "rb") as fh:
        content = fh.read()
    return hashlib.md5(os.path.abspath(path).encode() + b"\0" + content).hexdigest()


def _software_stack_hash(job, use_conda):
    md5 = hashlib.md5()
    path = job.rule.conda_path()
    if use_conda and path and os.path.exists(path):
        md5.update(_env_hash(path).encode())
    return md5.hexdigest()


def _record(job, start, use_conda):
    checks = {}
    for f in job.input:
        try:
            if os.path.isfile(f) and os.path.getsize(f) <= MAX_CHECKSUM_FILE_SIZE:
                checks[f] = checksum(f)
        except OSError:
            pass
    base = {
        "rule": job.name,
        "input": sorted(job.input),
        "log": sorted(job.log),
        "shellcmd": job.shellcmd,
        "params": _params_record(job),
        "code": job.rule.code_record(),
        "record_format_version": RECORD_FORMAT_VERSION,
        "conda_env": _conda_record(job),
        "container_img_url": None,
        "software_stack_hash": _software_stack_hash(job, use_conda),
        "job_hash": int(hashlib.md5(repr((job.name, sorted(job.wildcards_dict.items()))).encode()).hexdigest()[:11], 16),
        "starttime": start,
        "endtime": None,
        "incomplete": False,
        "external_jobid": None,
        "input_checksums": checks,
    }
    for f in job.output:
        rec = dict(base)
        rec["endtime"] = _mtime(f) or time.time()
        write_meta(f, rec)


# ============================================================================
# the software environment model (conda)
# ============================================================================

# programs of the practical's browser and the conda packages that provide them
PACKAGE_PROGRAMS = {
    "minimap2": ["minimap2"],
    "samtools": ["samtools"],
    "bcftools": ["bcftools"],
    "htslib": ["bgzip", "tabix", "htsfile"],
    "tabix": ["tabix", "bgzip"],
    "python": ["python", "python3", "pip", "pip3"],
    "snakemake": ["snakemake"],
    "snakemake-minimal": ["snakemake"],
    "graphviz": ["dot"],
    "gawk": ["awk", "gawk"],
    "sed": ["sed"],
    "grep": ["grep"],
    "coreutils": [],
    "pandas": [], "matplotlib": [], "matplotlib-base": [], "numpy": [], "pyyaml": [], "scipy": [],
    "seaborn": [], "pip": ["pip"],
}
# the tool versions this browser actually has (strictly checked)
BROWSER_TOOLS = {"minimap2": ["2.22"], "samtools": ["1.17"], "bcftools": ["1.10"], "htslib": ["1.17", "1.10"],
                 "tabix": ["1.17"], "graphviz": ["16.1.0"], "gawk": ["5.1.0"], "sed": ["4.8"], "grep": ["3.7"],
                 "coreutils": ["8.32"], "snakemake": [VERSION], "snakemake-minimal": [VERSION]}
# Python packages: provided by Pyodide; pins are accepted leniently
BROWSER_PY = {"python": "3.13.2", "pandas": "2.3.3", "matplotlib": "3.8.4", "matplotlib-base": "3.8.4",
              "numpy": "2.2.5", "pyyaml": "6.0.2", "scipy": "1.14.1", "pip": "25.0"}
IMPORT_PACKAGE = {"yaml": "pyyaml", "sklearn": "scikit-learn", "Bio": "biopython", "PIL": "pillow"}


def parse_env_file(path):
    import yaml

    with open(path) as fh:
        text = fh.read()
    try:
        data = yaml.safe_load(text) or {}
    except yaml.YAMLError as e:
        raise WorkflowError(f"The conda environment file {path} is not valid YAML: {e}", "WorkflowError")
    if not isinstance(data, dict):
        raise WorkflowError(f"The conda environment file {path} must have 'channels:' and 'dependencies:' sections.",
                            "WorkflowError")
    deps = []
    for d in data.get("dependencies", []) or []:
        if isinstance(d, str):
            spec = d.split("::")[-1].strip()
            m = re.match(r"^([A-Za-z0-9_.\-]+)\s*(?:(==|=|>=|<=|>|<|!=|~=)\s*([^\s]*))?", spec)
            if m:
                deps.append((m.group(1).lower(), m.group(2) or "", (m.group(3) or "").strip()))
        elif isinstance(d, dict) and "pip" in d:
            for p in d["pip"] or []:
                m = re.match(r"^([A-Za-z0-9_.\-]+)\s*(?:(==|>=|<=|~=)\s*(.*))?", str(p))
                if m:
                    deps.append((m.group(1).lower(), m.group(2) or "", (m.group(3) or "").strip()))
    return text, data, deps


def _version_ok(have, op, want):
    if not want:
        return True

    def key(v):
        return tuple(int(x) if x.isdigit() else x for x in re.findall(r"\d+|[a-z]+", v.lower()))

    want = want.rstrip("*").rstrip(".")
    if op in ("=", "=="):
        if op == "==" and "*" not in want:
            return key(have) == key(want)
        return have == want or have.startswith(want + ".")
    if op == ">=":
        return key(have) >= key(want)
    if op == "<=":
        return key(have) <= key(want)
    if op == ">":
        return key(have) > key(want)
    if op == "<":
        return key(have) < key(want)
    if op == "!=":
        return key(have) != key(want)
    if op == "~=":
        return key(have) >= key(want)
    return True


# which htslib versions each tool package accepts (bioconda's patched run requirements)
NEEDS_HTSLIB = {"samtools": (("1.17", "1.25"), "1.17", "hd87286a_2"), "bcftools": (("1.10", "1.25"), "1.10", "h5d15f04_0")}


def _vkey(v):
    return tuple(int(x) if x.isdigit() else x for x in re.findall(r"\d+|[a-z]+", str(v).lower()))


def htslib_choice(deps):
    """the htslib conda would install for these packages in this browser -> (version or None, conflict lines)"""
    need = [(n, NEEDS_HTSLIB[n]) for n, op, v in deps if n in NEEDS_HTSLIB]
    pinned = [(op, v) for n, op, v in deps if n == "htslib" and v]
    if not need and not pinned:
        return None, []
    ok = [h for h in sorted(BROWSER_TOOLS["htslib"], key=_vkey, reverse=True)
          if all(_vkey(rg[0]) <= _vkey(h) < _vkey(rg[1]) for _, (rg, _v, _b) in need)
          and all(_version_ok(h, op, v) for op, v in pinned)]
    if ok:
        return ok[0], []
    fits = lambda rg: any(_vkey(rg[0]) <= _vkey(h) < _vkey(rg[1]) and all(_version_ok(h, op, v) for op, v in pinned)
                          for h in BROWSER_TOOLS["htslib"])
    culprits = [x for x in need if not fits(x[1][0])] if pinned else need
    lines = [f"  - package {n}-{tv}-{b} requires htslib >={rg[0]},<{rg[1]}.0a0, but none of the providers can be installed"
             for n, (rg, tv, b) in (culprits or need)]
    lines += [f"  - requested htslib {op}{v}" for op, v in pinned]
    return None, lines


def htslib_conflicts(deps):
    return htslib_choice(deps)[1]


# these old bioconda builds were made against zlib 1.2 and need zlib <1.3; Python 3.13 needs zlib >=1.3.1
NEEDS_OLD_ZLIB = {"minimap2": ("1.2.11", "2.22", "h5bf99c6_0"), "samtools": ("1.2.13", "1.17", "hd87286a_2"),
                  "bcftools": ("1.2.11", "1.10", "h5d15f04_0")}


def zlib_conflicts(deps):
    """Python 3.13 (asked for explicitly) and the old tools cannot share one zlib -> conflict lines"""
    py = [(op, v) for n, op, v in deps if n == "python" and v]
    py313 = any(op not in ("<", "<=") and re.match(r"^3\.(1[3-9]|[2-9]\d)", v) for op, v in py)
    old = [n for n, op, v in deps if n in NEEDS_OLD_ZLIB]
    if not (py313 and old):
        return []
    lines = [f"  - package {n}-{NEEDS_OLD_ZLIB[n][1]}-{NEEDS_OLD_ZLIB[n][2]} requires libzlib >={NEEDS_OLD_ZLIB[n][0]},<1.3.0a0, "
             "but none of the providers can be installed" for n in old]
    lines.append("  - package python-3.13 requires libzlib >=1.3.1,<2.0a0")
    return lines


def env_problems(deps):
    """packages the browser cannot provide -> list of messages"""
    problems = htslib_conflicts(deps) or zlib_conflicts(deps)
    for name, op, want in deps:
        if name in BROWSER_TOOLS:
            have = BROWSER_TOOLS[name]
            if not any(_version_ok(v, op, want) for v in have):
                problems.append(f"  - nothing provides requested {name} {op}{want} "
                                f"(this browser only has {name} {' or '.join(have)})")
        elif name in BROWSER_PY:
            continue
        else:
            problems.append(f"  - nothing provides requested {name} (it cannot run inside this browser)")
    return problems


def env_programs(job):
    path = job.rule.conda_path()
    if not path:
        return None, None
    try:
        _, _, deps = parse_env_file(path)
    except WorkflowError:
        return [], []
    progs = set()
    for n, op, v in deps:
        progs.update(PACKAGE_PROGRAMS.get(n, [n]))
    return sorted(progs), [n for n, op, v in deps]


def env_location(path):
    return ".snakemake/conda/" + _env_hash(path) + "_"


# ============================================================================
# output (like Snakemake's logger)
# ============================================================================


class Out:
    """Snakemake's log messages: yellow/green info, red errors, on stderr, copied to the log file"""

    def __init__(self, emit, quiet=frozenset(), printshell=False, hints=True):
        self.emit = emit
        self.quiet = set(quiet)
        self.printshell = printshell
        self.hints = hints
        self.buf = []
        self.last_job_info = False

    def _w(self, text, color=None, log=True):
        self.last_job_info = False
        if log:
            self.buf.append(text)
        self.emit(text + "\n", "err", color)

    def info(self, text):
        if "all" in self.quiet:
            return
        self._w(text, "yellow")

    def green(self, text):
        if "all" in self.quiet:
            return
        self._w(text, "green")

    def run_info(self, text):
        if "progress" in self.quiet or "all" in self.quiet:
            return
        self._w(text, "yellow")

    def resources_info(self, text):
        if "progress" in self.quiet or "all" in self.quiet:
            return
        self._w(text, "green")

    def progress(self, text):
        if "progress" in self.quiet or "all" in self.quiet:
            return
        self._w(text, "green")

    def job_info(self, text):
        if "rules" in self.quiet or "all" in self.quiet:
            return
        if not self.last_job_info:
            self.buf.append("")
            self.emit("\n", "err", None)
        self.buf.append(text)
        self.emit(text + "\n", "err", "green")
        self.last_job_info = True

    def shellcmd(self, text):
        if not self.printshell or "rules" in self.quiet or "all" in self.quiet:
            return
        self._w(text, "yellow")

    def error(self, text):
        self._w(text, "red")

    def warning(self, text):
        self._w(text, "yellow")

    def stdout(self, text):
        self.emit(text, "out", None)

    def hint(self, text):
        if self.hints and text:
            self.emit("ℹ " + text + "\n", "err", "hint")

    def logfile(self):
        return "\n".join(self.buf) + "\n"


class Bridge:
    """how the engine runs shell commands - the host page provides a real one"""

    async def shell(self, cmd, tools=None, env=None):
        raise NotImplementedError

    async def sync(self):
        return None

    def cancelled(self):
        return False

    def machine(self):
        return {}


_bridge = Bridge()


def set_bridge(b):
    global _bridge
    _bridge = b


def get_bridge():
    return _bridge


# ============================================================================
# command line
# ============================================================================


class Args:
    pass


OPTIONS = {
    # long name: (short, kind) ; kind: flag | one | star | plus | optional
    "--dry-run": ("-n", "flag"), "--dryrun": (None, "flag"),
    "--cores": ("-c", "optional"), "--jobs": ("-j", "optional"),
    "--printshellcmds": ("-p", "flag"), "--forceall": ("-F", "flag"), "--force": ("-f", "flag"),
    "--forcerun": ("-R", "star"), "--configfile": (None, "plus"), "--configfiles": (None, "plus"),
    "--config": ("-C", "star"), "--snakefile": ("-s", "one"), "--use-conda": (None, "flag"),
    "--software-deployment-method": ("--sdm", "plus"), "--conda-create-envs-only": (None, "flag"),
    "--dag": (None, "graph"), "--rulegraph": (None, "graph"), "--list-rules": ("-l", "flag"), "--list": (None, "flag"),
    "--summary": ("-S", "flag"), "--detailed-summary": ("-D", "flag"), "--lint": (None, "lint"),
    "--delete-all-output": (None, "flag"), "--cleanup-metadata": ("--cm", "plus"),
    "--rerun-triggers": (None, "plus"), "--keep-going": ("-k", "flag"), "--quiet": ("-q", "quiet"),
    "--version": ("-v", "flag"), "--help": ("-h", "flag"), "--until": ("-U", "plus"),
    "--verbose": (None, "flag"), "--nocolor": (None, "flag"),
    "--rerun-incomplete": ("--ri", "flag"), "--show-failed-logs": (None, "flag"),
    "--printshellcmds-and-quit": (None, "flag"),
}
SHORT = {v[0]: k for k, v in OPTIONS.items() if v[0]}
QUIET_CHOICES = ("all", "host", "progress", "reason", "rules")
TRIGGER_CHOICES = ("code", "input", "mtime", "params", "software-env")

USAGE = ("usage: snakemake [-h] [--dry-run] [--cores [N]] [--printshellcmds] [--forceall]\n"
         "                 [--forcerun [TARGET ...]] [--force] [--configfile FILE [FILE ...]]\n"
         "                 [--config [KEY=VALUE ...]] [--snakefile FILE] [--use-conda]\n"
         "                 [--dag [{dot}]] [--rulegraph [{dot}]] [--list-rules] [--summary]\n"
         "                 [--detailed-summary] [--lint] [--delete-all-output]\n"
         "                 [--cleanup-metadata FILE [FILE ...]] [--until TARGET [TARGET ...]]\n"
         "                 [--rerun-triggers {code,input,mtime,params,software-env} [...]]\n"
         "                 [--keep-going] [--show-failed-logs] [--quiet [{all,host,progress,reason,rules} ...]]\n"
         "                 [--version]\n"
         "                 [targets ...]")

HELP = USAGE + """

Snakemake is a Python based language and execution environment for GNU Make-like
workflows. (This is the browser teaching edition used in the practical. It
supports the options below; everything else behaves as in Snakemake 9.)

  targets                  Targets to build: rule names or files (default: the first rule)
  --dry-run, -n            Do not execute anything, and display what would be done
  --cores [N], -c [N]      Use at most N CPU cores in parallel (required unless -n)
  --printshellcmds, -p     Print out the shell commands that will be executed
  --forceall, -F           Force the execution of the selected (or first) rule and all
                           rules it depends on
  --force, -f              Force the execution of the selected target or the first rule
  --forcerun [T ...], -R   Force the re-execution of these rules or files, and of
                           everything that depends on them
  --until T [T ...], -U    Run the pipeline only until these rules or files
  --configfile FILE        Specify or overwrite the config file of the workflow
  --config [KEY=VALUE ...] Set or overwrite values in the workflow config object
  --snakefile FILE, -s     The Snakefile to use (default: Snakefile or workflow/Snakefile)
  --use-conda              Run jobs in the conda environment given by their conda: directive
  --conda-create-envs-only Only create the conda environments, then stop
  --dag                    Print the directed acyclic graph of jobs in the dot language
  --rulegraph              Print the dependency graph of rules in the dot language
  --list-rules, -l         Show available rules in the Snakefile
  --summary, -S            Print a summary of all files created by the workflow
  --detailed-summary, -D   Also print the input files and shell command of each file
  --lint                   Check the workflow for common problems
  --delete-all-output      Remove all files generated by the workflow
  --cleanup-metadata FILE  Forget the provenance records of these output files
  --rerun-triggers T ...   What triggers re-running a job: code input mtime params software-env
  --keep-going, -k         Go on with independent jobs if a job fails
  --show-failed-logs       Print the log files of failed jobs
  --quiet [what], -q       Print less (progress, rules, all)
  --version, -v            Show the version and exit
"""


def _argerror(msg, hint=None):
    return WorkflowError(USAGE + "\nsnakemake: error: " + msg, "ArgumentError", hint=hint)


def parse_args(argv):
    a = Args()
    a.dryrun = a.printshell = a.forceall = a.force = a.use_conda = a.conda_create_only = False
    a.dag = a.rulegraph = a.list = a.summary = a.detailed = a.lint = a.delete_all = False
    a.keep_going = a.version = a.help = a.show_failed_logs = False
    a.cores = None
    a.forcerun = None
    a.configfiles, a.config, a.snakefile, a.targets, a.until, a.cleanup = [], {}, None, [], [], None
    a.rerun_triggers = set(TRIGGER_CHOICES)
    a.quiet = set()
    longs = list(OPTIONS)
    i = 0

    def canon(x):
        if x in OPTIONS:
            return x
        if x in SHORT:
            return SHORT[x]
        if x.startswith("--"):
            hits = [o for o in longs if o.startswith(x)]
            if len(hits) == 1:
                return hits[0]
            if len(hits) > 1:
                raise _argerror(f"ambiguous option: {x} could match {', '.join(hits)}")
        return None

    def values_after(i):
        vals = []
        j = i + 1
        while j < len(argv) and not (argv[j].startswith("-") and len(argv[j]) > 1 and not _is_number(argv[j])):
            vals.append(argv[j])
            j += 1
        return vals, j

    while i < len(argv):
        x = argv[i]
        if x == "--":
            a.targets.extend(argv[i + 1:])
            break
        inline = None
        if x.startswith("--") and "=" in x:
            x, inline = x.split("=", 1)
        # combined short flags like -np, -pn, -Fn, and -c1 / -j2
        if re.fullmatch(r"-[cj]\d+", x):
            a.cores = x[2:]
            i += 1
            continue
        if re.fullmatch(r"-[A-Za-z]{2,}", x) and x not in SHORT and all(("-" + ch) in SHORT for ch in x[1:]):
            expanded = ["-" + ch for ch in x[1:]]
            argv = argv[:i] + expanded + argv[i + 1:]
            continue
        if x.startswith("-") and len(x) > 1 and not _is_number(x):
            opt = canon(x)
            if opt is None:
                import difflib

                close = difflib.get_close_matches(x, longs + list(SHORT), n=1, cutoff=0.6)
                if x in ("-r", "--reason"):
                    raise _argerror(f"unrecognized arguments: {x}",
                                    hint="Snakemake 8 and later always print the reason for each job, so -r (--reason) was removed.")
                raise _argerror(f"unrecognized arguments: {x}",
                                hint=f"Did you mean {close[0]}?" if close else "snakemake --help lists the options.")
            kind = OPTIONS[opt][1]
            if inline is not None:
                vals, nxt = [inline], i + 1
            else:
                vals, nxt = values_after(i)
            name = opt[2:].replace("-", "_")
            if kind == "flag":
                setattr(a, {"dry_run": "dryrun", "printshellcmds": "printshell", "use_conda": "use_conda",
                            "list_rules": "list", "detailed_summary": "detailed", "delete_all_output": "delete_all",
                            "keep_going": "keep_going", "conda_create_envs_only": "conda_create_only"}.get(name, name), True)
                if opt == "--detailed-summary":
                    a.summary = True
                if opt == "--conda-create-envs-only":
                    a.use_conda = True
                i += 1
                continue
            if kind == "optional":
                if vals and (_is_number(vals[0]) or vals[0] == "all"):
                    a.cores = vals[0]
                    i = i + 1 if inline is not None else i + 2
                else:
                    a.cores = "all"
                    i += 1
                continue
            if kind == "one":
                if not vals:
                    raise _argerror(f"argument {opt}/{OPTIONS[opt][0]}: expected one argument")
                a.snakefile = vals[0]
                i = i + 1 if inline is not None else i + 2
                continue
            if kind == "graph":
                if vals and inline is None:
                    if vals[0] not in ("dot", "mermaid-js"):
                        raise _argerror(f"argument {opt}: invalid choice: '{vals[0]}' (choose from 'dot', 'mermaid-js')",
                                        hint=f"Put the target before {opt}, e.g.  snakemake {vals[0]} {opt} | dot -Tsvg > dag.svg")
                    if vals[0] == "mermaid-js":
                        raise _argerror(f"argument {opt}: only 'dot' is available in this browser edition")
                    i += 2
                else:
                    i += 1
                setattr(a, opt[2:], True)
                continue
            if kind == "lint":
                a.lint = True
                if vals and vals[0] in ("text", "json") and inline is None:
                    i += 2
                else:
                    i += 1
                continue
            if kind == "quiet":
                for v in vals:
                    if v not in QUIET_CHOICES:
                        raise _argerror(f"argument --quiet/-q: invalid choice: '{v}' (choose from {', '.join(repr(c) for c in QUIET_CHOICES)})",
                                        hint="Put the targets before -q, or use --quiet progress")
                a.quiet |= set(vals) if vals else {"progress", "rules"}
                i = nxt
                continue
            if kind in ("star", "plus"):
                if kind == "plus" and not vals:
                    raise _argerror(f"argument {opt}: expected at least one argument")
                if opt == "--forcerun":
                    a.forcerun = (a.forcerun or []) + vals
                elif opt in ("--configfile", "--configfiles"):
                    a.configfiles += vals
                elif opt == "--config":
                    for v in vals:
                        if "=" not in v:
                            raise _argerror(f"argument --config/-C: Invalid config definition: {v} (use KEY=VALUE)")
                        k, val = v.split("=", 1)
                        try:
                            import yaml

                            val = yaml.safe_load(val)
                        except Exception:
                            pass
                        a.config[k] = val
                elif opt == "--rerun-triggers":
                    bad = [v for v in vals if v not in TRIGGER_CHOICES]
                    if bad:
                        raise _argerror(f"argument --rerun-triggers: invalid choice: '{bad[0]}' (choose from {', '.join(repr(c) for c in TRIGGER_CHOICES)})")
                    a.rerun_triggers = set(vals)
                elif opt == "--until":
                    a.until += vals
                elif opt == "--cleanup-metadata":
                    a.cleanup = vals
                elif opt == "--software-deployment-method":
                    for v in vals:
                        if v != "conda":
                            raise _argerror(f"argument --software-deployment-method/--sdm: only 'conda' is available in this browser edition (not '{v}')")
                    a.use_conda = True
                i = nxt
                continue
        a.targets.append(argv[i])
        i += 1
    return a


def _is_number(s):
    return bool(re.fullmatch(r"-?\d+(\.\d+)?", s))


def find_snakefile(explicit=None):
    if explicit:
        if not os.path.exists(explicit):
            raise WorkflowError(f"Snakefile \"{explicit}\" not found.", "WorkflowError")
        return explicit
    for p in ("Snakefile", "snakefile", "workflow/Snakefile", "workflow/snakefile"):
        if os.path.exists(p):
            return p
    return None


# ============================================================================
# main
# ============================================================================


async def main(argv, emit, host=None):
    """run `snakemake argv...` in the current directory; returns the exit code

    emit(text, stream, color): stream is "out" or "err"; color is None, "yellow", "green", "red" or "hint".
    host: {"exe", "platform", "host", "user", "python", "cpus", "hints"}
    """
    host = host or {}
    out = Out(emit, hints=host.get("hints", True))
    try:
        args = parse_args(list(argv))
    except WorkflowError as e:
        emit(e.msg + "\n", "err", None)
        out.hint(e.hint)
        return 2
    if args.help:
        out.stdout(HELP)
        return 0
    if args.version:
        out.stdout(VERSION + "\n")
        return 0
    out.quiet = args.quiet
    out.printshell = args.printshell
    t_start = time.time()
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = _Stream(emit, "out"), _Stream(emit, "err")
    try:
        return await _main(args, argv, out, host, t_start)
    except WorkflowError as e:
        out.error(e.render())
        out.hint(e.hint)
        return 1
    except KeyboardInterrupt:
        out.error("Terminating processes on user request, this might take some time.")
        return 130
    finally:
        sys.stdout, sys.stderr = old_out, old_err


class _Stream:
    def __init__(self, emit, which):
        self.emit = emit
        self.which = which

    def write(self, s):
        if s:
            self.emit(s, self.which, None)
        return len(s)

    def flush(self):
        pass

    def isatty(self):
        return False


def _cores_value(args, host):
    if args.cores in (None, ""):
        return None
    if args.cores == "all":
        return int(host.get("cpus") or os.cpu_count() or 1)
    try:
        return max(1, int(float(args.cores)))
    except ValueError:
        raise _argerror(f"argument --cores/-c: invalid value: '{args.cores}'")


async def _main(args, argv, out, host, t_start):
    snakefile = find_snakefile(args.snakefile)
    if snakefile is None:
        out.error("Error: No Snakefile found, tried Snakefile, snakefile, workflow/Snakefile, workflow/snakefile.")
        out.hint("Are you in the project folder? Check with  pwd  and  ls")
        return 1
    cores = _cores_value(args, host)
    wf = Workflow(snakefile, overwrite_config=args.config, configfiles=args.configfiles, cores=cores or 1)
    wf.load()
    for n in wf.notes:
        out.warning(n)
    if args.config and wf.configfiles and not (args.list or args.lint):
        out.info(f"Config file {wf.configfiles[0]} is extended by additional config specified via the command line.")
    if args.list:
        for r in sorted(wf.rules, key=lambda r: r.name):
            out.stdout(r.name + "\n")
        return 0
    if args.lint:
        return _lint(wf, out)
    if args.cleanup is not None:
        for f in args.cleanup:
            delete_meta(os.path.normpath(f))
        return 0
    graph_mode = args.dag or args.rulegraph or args.summary or args.delete_all
    if not graph_mode:
        out.info("Assuming unrestricted shared filesystem usage.")
        needs_cores = not (args.dryrun or args.conda_create_only)
        if needs_cores and cores is None:
            out.error("Error: cores have to be specified for local execution (use --cores N with N being a number >= 1 or 'all')")
            out.hint("Try:  snakemake --cores 1")
            return 1
        _banner(out, wf, argv, host)
    out.info("Building DAG of jobs...")
    dag = DAG(wf, args.targets, forceall=args.forceall, forcerun=args.forcerun, force=args.force,
              until=args.until, cores=cores or 1, use_conda=args.use_conda, triggers=args.rerun_triggers)
    dag.update_needrun()
    if args.dag or args.rulegraph:
        out.stdout(_dot(dag, rulegraph=args.rulegraph))
        return 0
    if args.summary:
        _summary(dag, out, detailed=args.detailed)
        return 0
    if args.delete_all:
        return _delete_all(dag, out)
    todo = dag.needrun
    for j in todo:
        sp = j.rule.script_path()
        if sp and not os.path.exists(sp):
            raise WorkflowError(
                f"Failed to open source file {os.path.abspath(sp)}\n"
                f"FileNotFoundError: [Errno 2] No such file or directory: '{os.path.abspath(sp)}'",
                "WorkflowError", j.rule.lines.get("script", (j.rule.lineno, j.rule.lineno))[1], j.rule.snakefile,
                hint=f"script: paths are relative to the folder of the Snakefile ({os.path.relpath(j.rule.basedir)}/), "
                     f"so this rule looks for {os.path.relpath(sp)}")
    log_path = _new_log_path()
    if args.use_conda:
        ok = await _conda_envs(wf, dag, todo if not args.conda_create_only else dag.joblist, out, args.dryrun)
        if not ok:
            _write_log(log_path, out)
            return 1
        if args.conda_create_only:
            _write_log(log_path, out)
            return 0
    if not todo:
        out.info("Nothing to be done (all requested files are present and up to date).")
        _write_log(log_path, out)
        return 0
    order = _exec_order(dag, todo)
    if args.dryrun:
        out.run_info(_stats(dag, todo))
        for j in order:
            _job_info(out, j, dag, dry=True)
        out.run_info(_stats(dag, todo))
        _print_reasons(out, dag, todo)
        _provenance_info(out, dag, todo)
        out.info("This was a dry-run (flag -n). The order of jobs does not reflect the order of execution.")
        _write_log(log_path, out)
        return 0
    # --- real execution
    out.resources_info("Using shell: /usr/bin/bash")
    out.resources_info(f"Provided cores: {cores}" + (" (use --cores to define parallelism)" if cores == 1 else ""))
    out.resources_info("Rules claiming more threads will be scaled down.")
    if not args.use_conda and any(r.conda for r in wf.rules):
        out.info("Conda environments: ignored")
    out.run_info(_stats(dag, todo))
    code = await _execute(wf, dag, order, out, args)
    out.info(f"Complete log(s): {os.path.abspath(log_path)}")
    out.info(f"Elapsed time: {datetime.timedelta(seconds=time.time() - t_start)}")
    if code != 0:
        out.error("WorkflowError:\nAt least one job did not complete successfully.")
    _write_log(log_path, out)
    return code


def _banner(out, wf, argv, host):
    cfg_md5 = hashlib.md5(json.dumps(wf.config, sort_keys=True).encode()).hexdigest()
    exe = host.get("exe", "snakemake")
    lines = [
        "", "SNAKEMAKE", "=========",
        f"  Date: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"  Workflow ID: {uuid.uuid4()}",
        f"  Platform: {host.get('platform', sys.platform)}",
        f"  Host: {host.get('host', 'browser')}",
        f"  User: {host.get('user', 'student')}",
        f"  Snakemake version: {VERSION}" + (f" ({EDITION})" if host.get("edition", True) else ""),
        f"  Python version: {host.get('python', sys.version.splitlines()[0])}",
        f"  Command: {exe} {' '.join(argv)}".rstrip(),
        f"  Snakefile: {wf.snakefile}",
        f"  Base directory: {os.path.dirname(wf.snakefile)}",
        f"  Run directory: {os.getcwd()}",
        f"  Working directory: {os.getcwd()}",
        f"  Config file(s): {wf.configfiles!r}",
        f"  Config MD5: {cfg_md5}",
        "",
    ]
    out.green("\n".join(lines))


def _new_log_path():
    d = datetime.datetime.now()
    return os.path.join(".snakemake", "log", d.strftime("%Y-%m-%dT%H%M%S.") + f"{d.microsecond:06d}.snakemake.log")


def _write_log(path, out):
    if not path:
        return
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            fh.write(out.logfile())
    except OSError:
        pass


def _exec_order(dag, todo):
    order = []
    for level in dag.levels(todo):
        order.extend(sorted(level, key=lambda j: j.jobid))
    return order


def _stats(dag, todo):
    names = []
    for level in dag.levels(todo):
        for j in sorted(level, key=lambda j: j.name):
            names.append(j.name)
    counts = collections.Counter(names)
    rows = [(n, counts[n]) for n in dict.fromkeys(names)] + [("total", len(todo))]
    w1 = max([len("job") + 2] + [len(n) for n, _ in rows])
    w2 = max([len("count") + 2] + [len(str(c)) for _, c in rows])
    lines = ["Job stats:", "job".ljust(w1) + "  " + "count".rjust(w2), "-" * w1 + "  " + "-" * w2]
    lines += [n.ljust(w1) + "  " + str(c).rjust(w2) for n, c in rows]
    return "\n".join(lines) + "\n"


def _job_info(out, j, dag, dry=False):
    reason = str(dag.reasons[j])
    shellcmd = j.shellcmd  # may raise the formatting error, like Snakemake
    lines = [_timestamp()]
    msg = j.message
    if msg:
        lines.append(f"Job {j.jobid}: {msg}")
        if "reason" not in out.quiet:
            lines.append(f"Reason: {reason}")
    else:
        lines.append(f"{'' if dry else 'local'}rule {j.name}:")
        if len(j.input):
            lines.append(f"    input: {', '.join(j.input)}")
        if len(j.output):
            lines.append(f"    output: {', '.join(j.output)}")
        if len(j.log):
            lines.append(f"    log: {', '.join(j.log)}")
        lines.append(f"    jobid: {j.jobid}")
        if j.benchmark:
            lines.append(f"    benchmark: {j.benchmark}")
        if "reason" not in out.quiet:
            lines.append(f"    reason: {reason}")
        if j.wildcards_dict:
            lines.append(f"    wildcards: {j._wc_text()}")
        if j.rule.priority:
            lines.append(f"    priority: {j.rule.priority}")
        if j.threads != 1:
            lines.append(f"    threads: {j.threads}")
        res = ", ".join(f"{k}={v}" for k, v in j.resources.items())
        lines.append(f"    resources: {res}")
    out.job_info("\n".join(lines))
    out.shellcmd(f"Shell command: {shellcmd}")


def _timestamp():
    return f"[{time.asctime()}]"


def _print_reasons(out, dag, todo):
    reasons = collections.defaultdict(set)
    for j in todo:
        for name in dag.reasons[j].names():
            reasons[name].add(j.name)
    if not reasons:
        return
    msg = "Reasons:\n    (check individual jobs above for details)"
    for reason, rules in sorted(reasons.items()):
        rules = sorted(rules)
        if len(rules) > 50:
            rules = rules[:50] + ["..."]
        msg += f"\n    {reason}:\n        {', '.join(rules)}"
    out.info(msg)


def _provenance_info(out, dag, todo):
    trig = [j for j in todo if dag.reasons[j].provenance_triggered()]
    if trig:
        out.info("Some jobs were triggered by provenance information, see 'reason' section in the rule displays above.\n"
                 "If you prefer that only modification time is used to determine whether a job shall be executed, "
                 "use the command line option '--rerun-triggers mtime' (also see --help).\n"
                 "If you are sure that a change for a certain output file (say, <outfile>) won't change the result "
                 "(e.g. because you just changed the formatting of a script or environment definition), you can also "
                 "wipe its metadata to skip such a trigger via 'snakemake --cleanup-metadata <outfile>'. ")
        out.info("Rules with provenance triggered jobs: " + " ".join(sorted({j.name for j in trig})) + "\n")


# ============================================================================
# conda environments
# ============================================================================


async def _conda_envs(wf, dag, jobs, out, dry):
    envs = collections.OrderedDict()
    for j in _exec_order(dag, jobs) if jobs else []:
        p = j.rule.conda_path()
        if p:
            envs.setdefault(p, j.rule)
    for path, rule in envs.items():
        rel = os.path.relpath(path, os.getcwd())
        if not os.path.exists(path):
            out.error(f"WorkflowError:\nFailed to get conda environment file {rel} of rule {rule.name}: "
                      f"file does not exist (full checked path: {os.path.abspath(path)}).")
            return False
        text, data, deps = parse_env_file(path)
        loc = env_location(path)
        if os.path.exists(loc + ".env_setup_done"):
            continue
        if dry:
            out.info(f"Conda environment {rel} will be created.")
            continue
        out.info(f"Creating conda environment {rel}...")
        out.info("Downloading and installing remote packages.")
        problems = env_problems(deps)
        if problems:
            out.error(
                f"CreateCondaEnvironmentException:\nCould not create conda environment from {os.path.abspath(path)}:\n"
                f"Command:\nconda env create --quiet --no-default-packages --file \"{os.path.abspath(loc)}.yaml\" "
                f"--prefix \"{os.path.abspath(loc)}\"\nOutput:\nLibMambaUnsatisfiableError: Encountered problems while solving:\n"
                + "\n".join(problems))
            if htslib_conflicts(deps) or zlib_conflicts(deps):
                out.hint("An environment holds ONE version of each library, and these packages need different versions "
                         "of " + ("htslib" if htslib_conflicts(deps) else "zlib") + ". Put them in separate environment "
                         "files – one conda: file for each rule that needs them.")
            else:
                out.hint("On a real computer conda downloads the requested versions from the internet. This browser has "
                         "a fixed set of tools: minimap2 2.22, samtools 1.17, bcftools 1.10, htslib 1.17 or 1.10, and "
                         "Python 3.13 with pandas and matplotlib.")
            return False
        await asyncio.sleep(0.4)
        os.makedirs(os.path.join(loc, "conda-meta"), exist_ok=True)
        with open(loc + ".yaml", "w") as fh:
            fh.write(text)
        with open(os.path.join(loc, "conda-meta", "history"), "w") as fh:
            fh.write(f"==> {datetime.datetime.now():%Y-%m-%d %H:%M:%S} <==\n")
            fh.write(f"# cmd: conda env create --quiet --no-default-packages --file {os.path.abspath(loc)}.yaml "
                     f"--prefix {os.path.abspath(loc)}\n# conda version: 26.7.3 (browser practical)\n")
            hts, _ = htslib_choice(deps)
            listed = [d for d in deps if d[0] != "htslib"]
            if hts:
                listed.append(("htslib", "==", hts))  # installed as a dependency (or as pinned)
            for name, op, want in listed:
                tools = [v for v in BROWSER_TOOLS.get(name, []) if _version_ok(v, op, want)]
                have = (tools[0] if tools else None) or BROWSER_PY.get(name) or want or "?"
                chan = "bioconda" if name in ("minimap2", "samtools", "bcftools", "htslib", "tabix", "snakemake", "snakemake-minimal") else "conda-forge"
                fh.write(f"+{chan}/wasm32::{name}-{have}\n")
        with open(loc + ".env_setup_done", "w") as fh:
            fh.write("")
        out.info("Cleaning up conda package tarballs.")
        out.info(f"Environment for {os.path.abspath(path)} created (location: {loc})")
        notes = [f"{n} {BROWSER_PY[n]} (you asked for {n}{op}{v})" for n, op, v in deps
                 if n in BROWSER_PY and v and not _version_ok(BROWSER_PY[n], op, v)]
        if notes:
            out.hint("In this browser the Python packages come from Pyodide: " + "; ".join(notes) + ".")
    await _bridge.sync()
    return True


# ============================================================================
# running jobs
# ============================================================================


async def _execute(wf, dag, order, out, args):
    total = len(order)
    done = 0
    failed = []
    consumers = collections.defaultdict(set)
    for j in order:
        for dep, files in dag.dependencies.get(j, {}).items():
            for f in files:
                consumers[f].add(j)
    finished = set()
    for j in order:
        if _bridge.cancelled():
            out.error("Terminating processes on user request, this might take some time.")
            return 130
        if any(d.failed or (d in dag.needrun and d not in finished) for d in dag.dependencies.get(j, {})):
            j.failed = any(d.failed for d in dag.dependencies.get(j, {}))
            continue
        out.info("Select jobs to execute...")
        out.info("Execute 1 jobs...")
        _job_info(out, j, dag, dry=False)  # formatting errors stop the whole run here
        start = time.time()
        # like Snakemake: existing output files of a job are removed before it runs
        stale = [f for f in j.output if os.path.exists(f)]
        for f in stale:
            _remove(f, keep_meta=True)
        if stale:
            await _bridge.sync()
        for f in list(j.output) + list(j.log) + ([j.benchmark] if j.benchmark else []):
            d = os.path.dirname(f)
            if d:
                os.makedirs(d, exist_ok=True)
        for f in j.output:
            if j.output_flags.get(f, {}).get("directory"):
                os.makedirs(f, exist_ok=True)
        err = None
        env = None
        if args.use_conda and j.rule.conda_path():
            env = env_location(j.rule.conda_path())
            out.info(f"Activating conda environment: {env}")
        try:
            if j.rule.shellcmd is not None:
                progs = env_programs(j)[0] if env else None
                code = await _bridge.shell(j.shellcmd.strip(), tools=progs, env=env)
                if code != 0:
                    raise _JobFailed(
                        f"RuleException:\nCalledProcessError in file \"{j.rule.snakefile}\", line {j.rule.lines.get('shell', (0, j.rule.lineno))[1]}:\n"
                        f"Command 'set -euo pipefail;  {j.shellcmd.strip()}' returned non-zero exit status {code}.",
                        shell_failed=True, code=code)
            elif j.rule.run is not None:
                await _bridge.sync()
                await _run_block(j, out, env)
            elif j.rule.script is not None:
                await _bridge.sync()
                await _run_script(j, out, args, env)
        except _JobFailed as e:
            err = e
        except WorkflowError as e:
            err = _JobFailed(e.render())
        await _bridge.sync()
        for f in j.output:
            if j.output_flags.get(f, {}).get("touch"):
                with open(f, "a"):
                    os.utime(f, None)
        if err is None:
            missing = [f for f in j.output if not os.path.exists(f)]
            if missing:
                out.warning("Waiting at most 5 seconds for missing files:\n" + "\n".join(f"{f} (missing locally)" for f in missing))
                details = []
                for f in missing:
                    parent = os.path.dirname(f) or "."
                    try:
                        contents = ", ".join(sorted(os.listdir(parent)))
                    except OSError:
                        contents = ""
                    details.append(f"{f} (missing locally, parent dir contents: {contents})")
                out.error(
                    f'MissingOutputException in rule {j.name} in file "{j.rule.snakefile}", line {j.rule.lineno}:\n'
                    f"Job {j.jobid}  completed successfully, but some output files are missing. Missing files after 5 seconds. "
                    "This might be due to filesystem latency. If that is the case, consider to increase the wait time with --latency-wait:\n"
                    + "\n".join(details))
                out.hint("The command ran without an error but did not write the file named in output:. "
                         "Check that the command writes to {output} (compare the Shell command with the output: line).")
                for f in j.output:
                    if os.path.exists(f):
                        _remove(f)
                await _bridge.sync()
                j.failed = True
                failed.append(j)
                if not args.keep_going:
                    out.error("Shutting down, this might take some time.")
                    out.error("Exiting because a job execution failed. Look above for error messages")
                    return 1
                continue
        if err is None:
            if j.benchmark:
                _write_benchmark(j.benchmark, time.time() - start)
            for f in j.output:
                if j.output_flags.get(f, {}).get("protected") and os.path.exists(f):
                    out.info(f"Write-protecting output file {f}.")
                    try:
                        os.chmod(f, 0o444)
                    except OSError:
                        pass
            _record(j, start, args.use_conda)
            await _bridge.sync()
            finished.add(j)
            done += 1
            out.progress(f"{_timestamp()}\nFinished jobid: {j.jobid} (Rule: {j.name})")
            out.progress(f"{done} of {total} steps ({_percentage(done, total)}) done")
            # temporary files that no job needs any more
            removed = False
            for dep, files in dag.dependencies.get(j, {}).items():
                for f in files:
                    if dep.output_flags.get(f, {}).get("temp") and f not in dag.targetfiles and os.path.exists(f):
                        if all(c in finished for c in consumers[f]):
                            out.info(f"Removing temporary output {f}.")
                            _remove(f, keep_meta=True)
                            removed = True
            if removed:
                await _bridge.sync()
            continue
        # --- the job failed
        j.failed = True
        failed.append(j)
        out.error(err.text)
        lines = [_timestamp(), f"Error in rule {j.name}:", f"    message: {j.message}", f"    jobid: {j.jobid}"]
        if len(j.input):
            lines.append(f"    input: {', '.join(j.input)}")
        if len(j.output):
            lines.append(f"    output: {', '.join(j.output)}")
        if len(j.log):
            lines.append(f"    log: {', '.join(j.log)} (check log file(s) for error details)")
        if env:
            lines.append(f"    conda-env: {os.path.abspath(env)}")
        if err.shell_failed:
            lines.append(f"    shell:\n        {j.shellcmd.strip()}\n        (command exited with non-zero exit code)")
        if args.show_failed_logs:
            for lf in j.log:
                lines.extend(_show_log(lf))
        if "rules" not in out.quiet:
            out.error("\n".join(lines))
        present = [f for f in j.output if os.path.exists(f)]
        if present:
            out.error(f"Removing output files of failed job {j.name} since they might be corrupted:\n" + "\n".join(present))
            for f in present:
                _remove(f)
        await _bridge.sync()
        if len(j.log) and not args.show_failed_logs:
            out.hint(f"The tool's own messages are in the log file:  cat {j.log[0]}")
        if not args.keep_going:
            out.error("Shutting down, this might take some time.")
            out.error("Exiting because a job execution failed. Look above for error messages")
            return 1
    if failed:
        out.error("Exiting because a job execution failed. Look above for error messages")
        return 1
    return 0


def _show_log(f):
    try:
        with open(f) as fh:
            content = fh.read()
    except FileNotFoundError:
        return [f"Logfile {f} not found."]
    except UnicodeDecodeError:
        return [f"Logfile {f} is not a text file."]
    lines = content.splitlines()
    head = f"Logfile {f}:"
    if not lines:
        return [head + " empty file"]
    w = min(max(max(len(x) for x in lines), len(head)), 80)
    return [head, "=" * w] + lines + ["=" * w]


def _percentage(done, total):
    if done == total:
        return "100%"
    if done == 0:
        return "0%"
    precision = 0
    frac = done / total
    while True:
        s = f"{frac:.{precision}%}"
        if s not in ("100%", "0%"):
            return s
        precision += 1


def _remove(f, keep_meta=False):
    try:
        if os.path.isdir(f) and not os.path.islink(f):
            import shutil

            shutil.rmtree(f)
        else:
            os.chmod(f, 0o644)
            os.remove(f)
    except OSError:
        pass
    if not keep_meta:
        delete_meta(f)


def _write_benchmark(path, secs):
    with open(path, "w") as fh:
        fh.write("s\th:m:s\tmax_rss\tmax_vms\tmax_uss\tmax_pss\tio_in\tio_out\tmean_load\tcpu_time\n")
        fh.write(f"{secs:.4f}\t{datetime.timedelta(seconds=int(secs))}\tNA\tNA\tNA\tNA\tNA\tNA\tNA\tNA\n")


class _SnakemakeScriptObject:
    """the `snakemake` object that script: files see"""

    def __init__(self, job):
        self.input = job.input
        self.output = job.output
        self.params = job.params
        self.wildcards = job.wildcards
        self.threads = job.threads
        self.resources = job.resources
        self.log = job.log
        self.config = job.rule.workflow.config
        self.rule = job.name
        self.bench_iteration = None
        self.scriptdir = job.rule.basedir

    def log_fmt_shell(self, stdout=True, stderr=True, append=False):
        if not len(self.log):
            return ""
        lf = str(self.log)
        if stdout and stderr:
            return f" >> {lf} 2>&1" if append else f" > {lf} 2>&1"
        if stdout:
            return f" >> {lf}" if append else f" > {lf}"
        if stderr:
            return f" 2>> {lf}" if append else f" 2> {lf}"
        return ""


async def _run_script(job, out, args, env):
    rule = job.rule
    path = rule.script_path()
    vline = rule.lines.get("script", (rule.lineno, rule.lineno))[1]
    if not os.path.exists(path):
        raise _JobFailed(
            f"WorkflowError in file \"{rule.snakefile}\", line {vline}:\n"
            f"Failed to open source file {os.path.abspath(path)}\n"
            f"FileNotFoundError: [Errno 2] No such file or directory: '{os.path.abspath(path)}'\n"
            "(script: paths are relative to the folder of the Snakefile, "
            f"{os.path.relpath(rule.basedir)}/)")
    if not path.endswith(".py"):
        raise _JobFailed(f"WorkflowError:\nOnly Python scripts (.py) can run in this browser edition (not {rule.script}).")
    with open(path) as fh:
        src = fh.read()
    tmpname = f"tmp{uuid.uuid4().hex[:8]}.{os.path.basename(path)}"
    command = f"python {os.path.abspath(os.path.join('.snakemake', 'scripts', tmpname))}"
    fail_head = (f"RuleException:\nCalledProcessError in file \"{rule.snakefile}\", line {vline}:\n"
                 f"Command 'set -euo pipefail;  {command}' returned non-zero exit status 1.")
    if env:
        progs, pkgs = env_programs(job)
        if "python" not in (pkgs or []):
            raise _JobFailed("/usr/bin/bash: line 1: python: command not found\n" + fail_head.replace("status 1", "status 127"))
        for mod in _imports(src):
            base = mod.split(".")[0]
            pkg = IMPORT_PACKAGE.get(base, base)
            if pkg in PACKAGE_PROGRAMS or pkg in BROWSER_PY or pkg in ("scikit-learn", "biopython", "pillow", "seaborn"):
                if pkg not in pkgs and not (pkg == "matplotlib" and "matplotlib-base" in pkgs) and pkg != "pip":
                    raise _JobFailed(
                        f"Traceback (most recent call last):\n  File \"{os.path.abspath(path)}\", line {_import_line(src, base)}, in <module>\n"
                        f"    {src.splitlines()[_import_line(src, base) - 1].strip()}\n"
                        f"ModuleNotFoundError: No module named '{base}'\n" + fail_head)
    g = {"__name__": "__main__", "__file__": os.path.abspath(path), "__builtins__": __builtins__,
         "snakemake": _SnakemakeScriptObject(job)}
    try:
        code = compile(src, os.path.abspath(path), "exec")
    except SyntaxError as e:
        raise _JobFailed(f"  File \"{os.path.abspath(path)}\", line {e.lineno}\n    {(e.text or '').rstrip()}\n"
                         f"SyntaxError: {e.msg}\n" + fail_head)
    old_cwd = os.getcwd()
    try:
        exec(code, g)
        await asyncio.sleep(0)
    except SystemExit as e:
        if e.code not in (None, 0):
            raise _JobFailed(fail_head.replace("status 1", f"status {e.code if isinstance(e.code, int) else 1}"))
    except Exception as e:
        raise _JobFailed(_script_traceback(e, os.path.abspath(path), src) + "\n" + fail_head)
    finally:
        try:
            os.chdir(old_cwd)
        except OSError:
            pass
        try:
            mpl = sys.modules.get("matplotlib.pyplot")
            if mpl:
                mpl.close("all")
        except Exception:
            pass


def _script_traceback(e, path, src):
    lines = ["Traceback (most recent call last):"]
    tbe = traceback.TracebackException.from_exception(e)
    src_lines = src.split("\n")
    for fr in tbe.stack:
        if fr.filename != path:
            continue
        lines.append(f'  File "{fr.filename}", line {fr.lineno}, in {fr.name}')
        text = src_lines[fr.lineno - 1].strip() if fr.lineno and 0 < fr.lineno <= len(src_lines) else ""
        if text:
            lines.append("    " + text)
    lines.extend(l.rstrip("\n") for l in tbe.format_exception_only())
    return "\n".join(lines)


def _imports(src):
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return []
    mods = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            mods += [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            mods.append(node.module)
    return mods


def _import_line(src, base):
    for i, line in enumerate(src.split("\n"), 1):
        if re.match(rf"^\s*(import|from)\s+{re.escape(base)}\b", line):
            return i
    return 1


async def _run_block(job, out, env):
    rule = job.rule
    wf = rule.workflow
    gen = wf.linemaps.get(rule.snakefile)
    fn = rule.run
    ns = dict(input=job.input, output=job.output, params=job.params, wildcards=job.wildcards, threads=job.threads,
              resources=job.resources, log=job.log, rule=job.name, jobid=job.jobid)
    afn = _async_run_function(fn, wf, job, env)
    try:
        await afn(**ns)
    except _JobFailed:
        raise
    except WorkflowError:
        raise
    except Exception as e:
        line = rule.lines.get("run", (rule.lineno, rule.lineno))[1]
        for fr in reversed(traceback.extract_tb(e.__traceback__)):
            if fr.filename == rule.snakefile and gen:
                line = gen.origin(fr.lineno)
                break
        raise _JobFailed(f"RuleException:\n{type(e).__name__} in file \"{rule.snakefile}\", line {line}:\n{e}\n"
                         f"  File \"{rule.snakefile}\", line {line}, in {fn.__name__}")


def _async_run_function(fn, wf, job, env):
    """turn the run: block function into an async function whose shell() calls are awaited"""
    gen = wf.linemaps.get(job.rule.snakefile)
    code_text = gen.code()
    tree = ast.parse(code_text)
    fdef = None
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == fn.__name__:
            fdef = node
            break
    if fdef is None:
        raise WorkflowError("internal: could not find the run: block", "WorkflowError")

    class Awaiter(ast.NodeTransformer):
        def visit_Call(self, node):
            self.generic_visit(node)
            if isinstance(node.func, ast.Name) and node.func.id == "shell":
                new = ast.Call(func=ast.Name(id="__async_shell", ctx=ast.Load()),
                               args=node.args, keywords=node.keywords + [
                                   ast.keyword(arg="__line", value=ast.Constant(node.lineno)),
                                   ast.keyword(arg="__locals", value=ast.Call(func=ast.Name(id="locals", ctx=ast.Load()), args=[], keywords=[]))])
                return ast.copy_location(ast.Await(value=ast.copy_location(new, node)), node)
            return node

    fdef = Awaiter().visit(fdef)
    afdef = ast.AsyncFunctionDef(name=fdef.name, args=fdef.args, body=fdef.body, decorator_list=[], returns=None,
                                 type_comment=None)
    if sys.version_info >= (3, 12):
        afdef.type_params = []
    ast.copy_location(afdef, fdef)
    mod = ast.Module(body=[afdef], type_ignores=[])
    ast.fix_missing_locations(mod)
    g = wf.globals
    progs = env_programs(job)[0] if env else None

    async def __async_shell(cmd, *a, __line=None, __locals=None, **kw):
        variables = job.format_vars()
        variables.update(__locals or {})
        variables.update(kw)
        try:
            text = _sm_format(cmd, variables)
        except Exception as ex:
            raise WorkflowError(f"{type(ex).__name__}: {ex}, when formatting the following:\n{cmd}", "RuleException",
                                gen.origin(__line) if __line else None, job.rule.snakefile, job.name)
        out_cmd = text.strip()
        get_bridge()
        code = await _bridge.shell(out_cmd, tools=progs, env=env)
        if code != 0:
            raise _JobFailed(f"RuleException:\nCalledProcessError in file \"{job.rule.snakefile}\", line "
                             f"{gen.origin(__line) if __line else job.rule.lineno}:\n"
                             f"Command 'set -euo pipefail;  {out_cmd}' returned non-zero exit status {code}.")

    g["__async_shell"] = __async_shell
    local = {}
    exec(compile(mod, job.rule.snakefile, "exec"), g, local)
    return local[fdef.name]


# ============================================================================
# graphs, summary, lint, delete
# ============================================================================


def _new_wildcards(dag, job):
    new = set(job.wildcards_dict.items())
    for dep in dag.dependencies.get(job, {}):
        if not new:
            return set()
        for w in dep.wildcards_dict.items():
            new.discard(w)
    return new


def _dot(dag, rulegraph=False):
    jobs = dag.joblist
    rules = sorted({j.name for j in jobs})
    huefactor = 2 / (3 * max(len(rules), 1))
    color = {r: f"{i * huefactor:.2f} 0.6 0.85" for i, r in enumerate(rules)}
    head = ("digraph snakemake_dag {\n"
            "    graph[bgcolor=white, margin=0];\n"
            "    node[shape=box, style=rounded, fontname=sans,                 fontsize=10, penwidth=2];\n"
            "    edge[penwidth=2, color=grey];\n")
    nodes, edges = [], []
    needrun = set(dag.needrun)
    if rulegraph:
        ids = {}
        for j in jobs:
            ids.setdefault(j.name, len(ids))
        for name, i in ids.items():
            nodes.append(f'\t{i}[label = "{name}", color = "{color[name]}", style="rounded"];')
        seen = set()
        for j in jobs:
            for d in dag.dependencies.get(j, {}):
                e = (ids[d.name], ids[j.name])
                if e not in seen:
                    seen.add(e)
                    edges.append(f"\t{e[0]} -> {e[1]}")
    else:
        for j in jobs:
            label = "\\n".join([j.name] + sorted(f"{k}: {v}" for k, v in _new_wildcards(dag, j)))
            style = "rounded" if j in needrun else "rounded,dashed"
            nodes.append(f'\t{j.jobid}[label = "{label}", color = "{color[j.name]}", style="{style}"];')
        for j in jobs:
            for d in sorted(dag.dependencies.get(j, {}), key=lambda d: d.jobid):
                edges.append(f"\t{d.jobid} -> {j.jobid}")
    return head + "\n".join(nodes) + "\n" + "\n".join(edges) + "\n}            \n"


def _summary(dag, out, detailed=False):
    rows = ["output_file\tdate\trule\tlog-file(s)\tinput-file(s)\tshellcmd\tstatus\tplan" if detailed
            else "output_file\tdate\trule\tlog-file(s)\tstatus\tplan"]
    for j in dag.joblist:
        r = dag.reasons.get(j) or Reason()
        for f in j.output:
            exists = os.path.exists(f)
            date = time.ctime(os.path.getmtime(f)) if exists else "-"
            plan = "update pending" if r else "no update"
            rec = read_meta(f)
            log = "-" if rec is None else ",".join(rec.get("log") or [])
            inputs = "-" if rec is None else ",".join(rec.get("input") or [])
            shellcmd = "-" if rec is None or rec.get("shellcmd") is None else rec["shellcmd"].strip().replace("\n", "; ")
            status = "ok"
            if not exists:
                status = "removed temp file" if j.output_flags.get(f, {}).get("temp") else "missing"
            elif r.updated_input:
                status = "updated input files"
            elif rec and rec.get("code") is not None and rec.get("code") != j.rule.code_record():
                status = "rule implementation changed"
            elif rec and rec.get("input") is not None and rec.get("input") != sorted(j.input):
                status = "set of input files changed"
            elif rec and rec.get("params") is not None and set(rec["params"]) != set(_params_record(j)):
                status = "params changed"
            cols = [f, date, j.name, log] + ([inputs, shellcmd] if detailed else []) + [status, plan]
            rows.append("\t".join(cols))
    out.stdout("\n".join(rows) + "\n")


def _delete_all(dag, out):
    for j in dag.joblist:
        for f in j.output:
            if os.path.exists(f):
                if j.output_flags.get(f, {}).get("protected"):
                    out.info(f"Skipping write-protected file {f}.")
                    continue
                out.info(f"Deleting {f}")
                _remove(f)
    return 0


LINK_LOG = "https://snakemake.readthedocs.io/en/stable/snakefiles/rules.html#log-files"
LINK_PARAMS = "https://snakemake.readthedocs.io/en/stable/snakefiles/rules.html#non-file-parameters-for-rules"
LINK_RULES = "https://snakemake.readthedocs.io/en/latest/snakefiles/rules.html#rules"
LINK_CONDA = "https://snakemake.readthedocs.io/en/latest/snakefiles/deployment.html#integrated-package-management"
LINK_CONTAINERS = "https://snakemake.readthedocs.io/en/latest/snakefiles/deployment.html#running-jobs-in-containers"
LINK_CONFIG = "https://snakemake.readthedocs.io/en/latest/snakefiles/configuration.html#configuration"
LINK_SCRIPTS = "https://snakemake.readthedocs.io/en/latest/snakefiles/rules.html#external-scripts"
LINK_NOTEBOOKS = "https://snakemake.readthedocs.io/en/latest/snakefiles/rules.html#jupyter-notebook-integration"


def _lint_text(title, body, links=()):
    text = f"{title}:\n" + "\n".join("      " + ln for ln in textwrap.wrap(body, 74))
    if links:
        text += "\n      Also see:\n" + "\n".join("      " + l for l in links)
    return text


def _lint(wf, out):
    linted = False
    for path, src in wf.sources.items():
        lints = []
        for m in re.finditer(r"(?P<quote>['\"])(?P<path>(?:/[^/\n]+?)+?)(?P=quote)", src):
            line = src[:m.start()].count("\n") + 1
            lints.append(_lint_text(f'Absolute path "{m.group("path")}" in line {line}',
                                    "Do not define absolute paths inside of the workflow, since this renders your workflow "
                                    "irreproducible on other machines. Use path relative to the working directory instead, "
                                    "or make the path configurable via a config file.", [LINK_CONFIG]))
        for m in re.finditer(r"^ *\t", src, re.M):
            line = src[:m.start()].count("\n") + 1
            lints.append(_lint_text(f"Tab usage in line {line}.",
                                    "Both Python and Snakemake can get confused when mixing tabs and spaces for indentation. "
                                    "It is recommended to only use spaces for indentation."))
        if lints:
            linted = True
            out.warning(f"Lints for snakefile {path}:\n" + "\n".join("    * " + l for l in lints) + "\n")
    for r in wf.rules:
        lints = []
        for k, v in r.params[1].items():
            if isinstance(v, str) and v and any(isinstance(f, str) and f.startswith(v) for f in _flatten(list(r.input[0]) + list(r.input[1].values()) + list(r.output[0]) + list(r.output[1].values()))):
                lints.append(_lint_text(f"Param {k} is a prefix of input or output file but hardcoded",
                                        "If this is meant to represent a file path prefix, it will fail when running workflow in "
                                        "environments without a shared filesystem. Instead, provide a function that infers the "
                                        "appropriate prefix from the input or output file, e.g.: lambda w, input: os.path.splitext(input[0])[0]",
                                        [LINK_PARAMS]))
        if not r.log_patterns() and not r.norun:
            lints.append(_lint_text("No log directive defined",
                                    "Without a log directive, all output will be printed to the terminal. In distributed "
                                    "environments, this means that errors are harder to discover. In local environments, "
                                    "output of concurrent jobs will be mixed and become unreadable.", [LINK_LOG]))
        if r.shellcmd:
            for m in re.finditer(r"{(?P<name>[a-zA-Z_][a-zA-Z_0-9]*(?!\+)).*?}", r.shellcmd):
                name = m.group("name")
                before, after = m.start() - 1, m.end()
                if name not in {"input", "output", "log", "params", "wildcards", "threads", "resources"} and (
                        not (before >= 0 and after < len(r.shellcmd)) or (r.shellcmd[before] != "{" and r.shellcmd[after] != "}")):
                    lints.append(_lint_text(f"Shell command directly uses variable {name} from outside of the rule",
                                            "It is recommended to pass all files as input and output, and non-file parameters via "
                                            "the params directive. Otherwise, provenance tracking is less accurate.", [LINK_PARAMS]))
            if re.search(r"(input|output)\[[0-9]+\]", r.shellcmd):
                lints.append(_lint_text("Do not access input and output files individually by index in shell commands",
                                        "When individual access to input or output files is needed (i.e., just writing '{input}' "
                                        "is impossible), use names ('{input.somename}') instead of index based access.", [LINK_RULES]))
        if r.run is not None and r.run_src and len([l for l in r.run_src.split("\n") if l.strip()]) > 10:
            lints.append(_lint_text("Migrate long run directives into scripts or notebooks",
                                    "Long run directives hamper workflow readability. Use the script or notebook directive "
                                    "instead. Note that the script or notebook directive does not involve boilerplate. Similar to "
                                    "run, you will have direct access to params, input, output, and wildcards.Only use the run "
                                    "directive for a handful of lines.", [LINK_SCRIPTS, LINK_NOTEBOOKS]))
        if not r.norun and r.run is None and not r.conda:
            lints.append(_lint_text("Specify a conda environment or container for each rule.",
                                    "This way, the used software for each specific step is documented, and the workflow can be "
                                    "executed on any machine without prerequisites.", [LINK_CONDA, LINK_CONTAINERS]))
        if lints:
            linted = True
            out.warning(f"Lints for rule {r.name} (line {r.lineno}, {r.snakefile}):\n" + "\n".join("    * " + l for l in lints) + "\n")
    if not linted:
        out.info("Congratulations, your workflow is in a good condition!")
    return 1 if linted else 0
