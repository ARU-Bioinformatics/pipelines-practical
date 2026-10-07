How the diff and cmp of this practical were built
=================================================
diff and cmp (assets/vendor/biowasm/diffutils/3.10/) are GNU diffutils 3.10, compiled to WebAssembly
with Emscripten 6.0.10. GNU diffutils is licensed under the GNU General Public License version 3 or
later; this folder and ../sources/diffutils-3.10.tar.xz are its Corresponding Source for these programs.

To build them again (Linux; needs tar, patch, make, python3 and the Emscripten SDK):

  tar -xf ../sources/diffutils-3.10.tar.xz
  (cd diffutils-3.10 && patch -p1 < ../diffutils-3.10-webassembly.patch)
  source /path/to/emsdk/emsdk_env.sh                         # Emscripten 6.0.10 was used
  bash build-diffutils.sh                                    # writes out/diffutils/NAME.js and NAME.wasm

(Keep build-diffutils.sh, the patch and the source folder in one folder.)

The patch changes one line of src/cmp.c: see NOTICE.txt next to the programs. The build script
configures without native language support, answers two of configure's tests itself (they would
wait for ever under node), builds lib/ and then only diff and cmp, and makes two small changes to
the JavaScript loaders that Emscripten writes (the exit status; the program's name).

Built in this way with Emscripten 6.0.10, the four files come out identical, byte for byte, to the
ones in the site (checked on 3 October 2026). A build with another version of Emscripten gives
programs that work the same but are not byte-identical.
