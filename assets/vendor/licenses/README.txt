Licences, sources and build recipes of the bundled programs
===========================================================
This folder belongs to the WebAssembly programs in ../biowasm/. Keep it with the site: some of
those programs are under the GNU General Public License, which asks whoever distributes the
programs to offer their source code and build scripts in the same place.

GPL-3.0.txt                    the GNU General Public License, version 3
Apache-2.0.txt                 the Apache License, version 2.0 – for Comlink, which is part of
                                 ../biowasm/aioli.js (see ../biowasm/LICENSE.txt)
sources/                       the source code of the GPL programs, as released:
                                 coreutils 8.32, diffutils 3.10, gawk 5.1.0, grep 3.7 and 3.11,
                                 sed 4.8 (GNU) – and of PCRE2 10.42 (BSD), which is part of the
                                 grep that carries out "grep -P"
source-archives.json           where each archive came from, its size and SHA-256
biowasm-build/                 the Biowasm recipes (scripts and patches) with which the programs
                                 other than diff, cmp and the grep for "grep -P" were compiled –
                                 one pinned commit
biowasm-build-manifest.json    the list of those files, with their addresses and SHA-256
diffutils-build/               how diff and cmp (GNU diffutils) were compiled: patch, build
                                 script, instructions
grep-perl-build/               how GNU grep 3.11 with PCRE2 10.42 ("grep -P") was compiled: build
                                 script, one added function, instructions
runtime-libraries/             the licences of the libraries that are part of every program (Emscripten's
                                 runtime, the C library musl, LLVM's libraries, zlib, bzip2, liblzma)
local-patches/                 unbuffer-stdout.py – the one-byte change made to the 17 coreutils programs
                                 and to grep (see the NOTICE.txt in ../biowasm/coreutils/8.32/ and
                                 ../biowasm/grep/3.7/)
                               fix-day-of-year.py – the day of the year in the loaders of date and gawk
                                 (see ../biowasm/RUNTIME-PATCHES.txt, section 2)
SHA256SUMS                     checksums of everything in this folder

diff, cmp and the grep for "grep -P" were compiled for the practical "AI agents for bioinformatics",
whose terminal this practical shares; where their build notes say "this practical", that one is meant.

Next to each program in ../biowasm/NAME/VERSION/ are its licence, a NOTICE.txt (origin, local
changes) and SHA256SUMS (the base module has a notice and checksums only; its licence is ../biowasm/LICENSE.txt). ../biowasm/RUNTIME-PATCHES.txt lists the changes to the runtime.
The table of all third-party parts is THIRD_PARTY.md at the top of the site.
