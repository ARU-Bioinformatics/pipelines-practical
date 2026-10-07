How the "grep -P" of this practical was built
=============================================
grep-perl (assets/vendor/biowasm/grep/3.11/) is GNU grep 3.11 with PCRE2 10.42, compiled to
WebAssembly with Emscripten 6.0.10. GNU grep is licensed under the GNU General Public License
version 3 or later; this folder and ../sources/grep-3.11.tar.xz are its Corresponding Source for
this program. PCRE2 is under a BSD licence; its source is ../sources/pcre2-10.42.tar.bz2.

To build it again (Linux; needs tar, make, python3 and the Emscripten SDK):

  mkdir grep-src
  tar -xf ../sources/grep-3.11.tar.xz -C grep-src
  tar -xf ../sources/pcre2-10.42.tar.bz2 -C grep-src
  source /path/to/emsdk/emsdk_env.sh                         # Emscripten 6.0.10 was used
  bash build-grep-perl.sh                                    # writes out/grep-perl/grep-perl.js and .wasm

(Keep build-grep-perl.sh, grep-perl-splice.c and the folder grep-src in one folder.)

Neither source is changed. grep-perl-splice.c adds the one function that Emscripten's C library
lacks: see NOTICE.txt next to the program. The build script also changes three places of the
JavaScript loader that Emscripten writes (the exit status, the program's name, the name of the
.wasm file).

A build with another version of Emscripten gives a program that works the same but is not
byte-identical to the one here.
