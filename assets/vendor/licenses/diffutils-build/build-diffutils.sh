#!/bin/bash
# Builds GNU diffutils 3.10 (the programs diff and cmp) as WebAssembly modules that the practical's
# Aioli runtime can load. Needs: tar, patch, make, python3 and the Emscripten SDK (emsdk).
# Built for the practical with Emscripten 6.0.10, from the release source with a one-line patch (cmp.c).
#
#   tar -xf ../sources/diffutils-3.10.tar.xz
#   (cd diffutils-3.10 && patch -p1 < ../diffutils-3.10-webassembly.patch)
#   source /path/to/emsdk/emsdk_env.sh
#   bash build-diffutils.sh
# (See README.txt in this folder.)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
[ -f "$HERE/diffutils-3.10/configure" ] || { echo "diffutils-3.10/ is not next to this script: see README.txt"; exit 1; }
B=$HERE/diffutils-wasm-build
OUT=$HERE/out/diffutils
mkdir -p "$B" "$OUT"
cd "$B"

# configure runs small test programs (with node). A few of gnulib's tests wait for a signal that
# never comes there and would run for ever; their answers are given here instead:
#   nanosleep and sleep "work" (the C library's own are used); neither program sleeps.
# (The source folder is named relative to the build folder: the programs hold the names of some
# source files, in messages for failed checks, and should not hold the paths of the build computer.)
if [ ! -f Makefile ]; then
  emconfigure ../diffutils-3.10/configure --host=wasm32-unknown-emscripten --disable-nls --disable-dependency-tracking \
    CFLAGS="-O2" gl_cv_func_nanosleep=yes gl_cv_func_sleep_works=yes
fi

# What the practical's runtime needs of a program: main() is called by the page (INVOKE_RUN=0), once
# per module (the page makes a new one for every run); exit() ends the runtime, so that the C library
# writes out what is still in its buffers (EXIT_RUNTIME=1); the file system can be shared (PROXYFS, WORKERFS).
EM_FLAGS='-sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=["callMain","FS","PROXYFS","WORKERFS"] -sMODULARIZE=1 -sENVIRONMENT=web,worker -sALLOW_MEMORY_GROWTH=1 -lworkerfs.js -lproxyfs.js'
emmake make -j2 -C lib
emmake make -C src paths.h version.c version.h      # (the files that "make all" would generate first)
emmake make -j2 -C src diff.js cmp.js EXEEXT=.js LDFLAGS="$EM_FLAGS"
cp src/diff.js src/diff.wasm src/cmp.js src/cmp.wasm "$OUT/"
chmod 644 "$OUT"/*.wasm

# The runtime needs each program's exit status: record it where exit() is handled. And each program is told its name.
python3 - "$OUT" <<'PY'
import sys
for name in ('diff.js', 'cmp.js'):
    p = sys.argv[1] + '/' + name
    s = open(p).read()
    old = 'var exitJS=(status,implicit)=>{EXITSTATUS=status;'
    assert s.count(old) == 1, name
    s = s.replace(old, 'var exitJS=(status,implicit)=>{Module.__exitStatus=status;EXITSTATUS=status;')
    # the program's own name, as it stands at the start of its messages ("diff: a.txt: No such file or directory")
    old = 'var thisProgram="./this.program"'
    assert s.count(old) == 1, name
    s = s.replace(old, 'var thisProgram="%s"' % name[:-3])
    s = '// GNU diffutils 3.10 compiled to WebAssembly for this practical (see THIRD_PARTY.md). exit(status) is recorded as Module.__exitStatus.\n' + s
    open(p, 'w').write(s)
PY
ls -l "$OUT"
