#!/bin/bash
# Builds GNU grep 3.11 with PCRE2 10.42 as a WebAssembly module that the practical's Aioli runtime can load.
# The practical uses it for "grep -P" only (the Biowasm build of grep 3.7, which runs every other grep, has no PCRE).
# Needs: tar, make, python3 and the Emscripten SDK (emsdk). Built for the practical with the emsdk named in README.txt,
# from the two release sources, unchanged:
#
#   tar -xf ../sources/grep-3.11.tar.xz ; tar -xf ../sources/pcre2-10.42.tar.bz2      (into grep-src/)
#   source /path/to/emsdk/emsdk_env.sh
#   bash build-grep-perl.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$HERE/grep-src
[ -f "$SRC/grep-3.11/configure" ] && [ -f "$SRC/pcre2-10.42/configure" ] || { echo "grep-src/grep-3.11 and grep-src/pcre2-10.42 are not there: see the top of this script"; exit 1; }
BP=$SRC/pcre2-wasm-build
BG=$SRC/grep-wasm-build
OUT=$HERE/out/grep-perl
mkdir -p "$BP" "$BG" "$OUT"

# ---- PCRE2: the 8-bit library only, static, with Unicode support and without the just-in-time compiler
# (there is none for WebAssembly; grep then uses PCRE2's interpreter, as it does on any computer without JIT)
cd "$BP"
if [ ! -f Makefile ]; then
  emconfigure ../pcre2-10.42/configure --host=wasm32-unknown-emscripten --disable-shared --enable-static \
    --disable-jit --enable-unicode --disable-pcre2-16 --disable-pcre2-32 --disable-dependency-tracking CFLAGS="-O2"
fi
emmake make -j2 libpcre2-8.la

# ---- grep. configure runs small test programs (with node); a few of gnulib's tests wait for a signal that never
# comes there and would run for ever – their answers are given (as for diffutils: see build-diffutils.sh).
# (The source folder is named relative to the build folder, so that the program does not hold the paths of the
# build computer.)
cd "$BG"
if [ ! -f Makefile ]; then
  emconfigure ../grep-3.11/configure --host=wasm32-unknown-emscripten --disable-nls --disable-dependency-tracking \
    --enable-perl-regexp CFLAGS="-O2" PCRE_CFLAGS="-I../pcre2-wasm-build/src" PCRE_LIBS="-L../pcre2-wasm-build/.libs -lpcre2-8" \
    gl_cv_func_nanosleep=yes gl_cv_func_sleep_works=yes
fi
grep -q '^#define HAVE_LIBPCRE 1' config.h || { echo "configure did not find PCRE2"; exit 1; }

# What the practical's runtime needs of a program: main() is called by the page (INVOKE_RUN=0), once per module
# (the page makes a new one for every run); exit() ends the runtime, so that the C library writes out what is
# still in its buffers (EXIT_RUNTIME=1); the file system can be shared (PROXYFS, WORKERFS).
EM_FLAGS='-sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=["callMain","FS","PROXYFS","WORKERFS"] -sMODULARIZE=1 -sENVIRONMENT=web,worker -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=4MB -lworkerfs.js -lproxyfs.js'
emmake make -j2 -C lib
# Emscripten's C library has no splice(): grep-perl-splice.c gives one that always fails with EINVAL, which is the
# case grep is written for (it then reads instead).
emcc -O2 -c "$HERE/grep-perl-splice.c" -o splice.o
# (the compiler runs in src/: the PCRE2 folders are named from there)
emmake make -j2 -C src grep.js EXEEXT=.js LDFLAGS="$EM_FLAGS" PCRE_CFLAGS="-I../../pcre2-wasm-build/src" PCRE_LIBS="-L../../pcre2-wasm-build/.libs -lpcre2-8 ../splice.o"
cp src/grep.js "$OUT/grep-perl.js"
cp src/grep.wasm "$OUT/grep-perl.wasm"
chmod 644 "$OUT"/*.wasm

# The runtime needs the program's exit status: record it where exit() is handled. The program is told its name
# ("grep"), and the loader is told the name of its .wasm file.
python3 - "$OUT" <<'PY'
import sys
p = sys.argv[1] + '/grep-perl.js'
s = open(p).read()
old = 'var exitJS=(status,implicit)=>{EXITSTATUS=status;'
assert s.count(old) == 1, 'exitJS'
s = s.replace(old, 'var exitJS=(status,implicit)=>{Module.__exitStatus=status;EXITSTATUS=status;')
old = 'var thisProgram="./this.program"'
assert s.count(old) == 1, 'thisProgram'
s = s.replace(old, 'var thisProgram="grep"')
# (the runtime hands every program the name of its files, here "grep-perl": this one keeps the name grep,
# with which its messages begin)
old = 'if(Module["thisProgram"])thisProgram=Module["thisProgram"];'
assert s.count(old) == 1, 'thisProgram from the Module'
s = s.replace(old, '')
assert s.count('"grep.wasm"') >= 1, 'wasm name'
s = s.replace('"grep.wasm"', '"grep-perl.wasm"')
s = '// GNU grep 3.11 with PCRE2 10.42, compiled to WebAssembly for this practical: it carries out "grep -P" (see THIRD_PARTY.md). exit(status) is recorded as Module.__exitStatus.\n' + s
open(p, 'w').write(s)
PY
ls -l "$OUT"
