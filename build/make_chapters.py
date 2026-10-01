"""Assemble the chapters into ../index.html (between <!--CHAPTERS--> and <!--/CHAPTERS-->).
Needs Python 3.12 or later (f-strings with backslashes in their expressions) and PyYAML."""
import os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from chapters_a import ch_start, ch_project, ch_script, ch_python
from chapters_b import ch_snakefile, ch_generalise, ch_envs
from chapters_c import ch_galaxy, ch_agent, ch_compare, ch_ref

parts = [ch_start(), ch_project(), ch_script(), ch_python(), ch_snakefile(), ch_generalise(), ch_envs(),
         ch_galaxy(), ch_agent(), ch_compare(), ch_ref()]
html = '\n'.join(parts)
# the first chapter is visible on load
html = html.replace('data-bench="terminal" hidden>', 'data-bench="terminal">', 1)
p = os.path.join(HERE, '..', 'index.html')
s = open(p).read()
a = s.index('<!--CHAPTERS-->') + len('<!--CHAPTERS-->')
b = s.index('<!--/CHAPTERS-->')
s = s[:a] + '\n' + html + s[b:]
open(p, 'w').write(s)
# sanity checks: unique ids
ids = re.findall(r'data-task="([^"]+)"', html)
dup = {x for x in ids if ids.count(x) > 1}
qs = re.findall(r'data-q="([^"]+)"', html)
dq = {x for x in qs if qs.count(x) > 1}
hid = re.findall(r'<h2 id="([^"]+)"', html)
dh = {x for x in hid if hid.count(x) > 1}
print('chapters', len(parts), 'tasks', len(ids), 'questions', len(qs), 'dup tasks', dup, 'dup q', dq, 'dup h2', dh, 'bytes', len(html))
