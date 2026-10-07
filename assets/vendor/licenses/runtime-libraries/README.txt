Libraries that are part of the WebAssembly programs
===================================================
A program that is compiled to WebAssembly carries the libraries it uses inside its .wasm file and
its JavaScript loader. Their licences ask that the notices go with the programs; here they are.

EMSCRIPTEN-LICENSE.txt   Emscripten (the compiler's runtime and the JavaScript loaders): MIT, or
                         University of Illinois/NCSA – in every program
MUSL-COPYRIGHT.txt       musl, the C library: MIT – in every program
LLVM-LICENSE.txt         compiler-rt, and for the C++ programs libc++ and libc++abi (LLVM project):
                         Apache License 2.0 with LLVM exceptions (older parts: MIT, or University
                         of Illinois/NCSA)
ZLIB-LICENSE.txt         zlib – in the programs that read or write compressed files (samtools,
                         bcftools, bgzip, tabix and others)
BZIP2-LICENSE.txt        bzip2 (libbzip2) – in the programs built on HTSlib (samtools, bcftools,
                         bgzip, tabix)
XZ-COPYING.txt           XZ Utils: liblzma, which is in the public domain – in the programs built
                         on HTSlib

The texts of Emscripten, musl and LLVM are those of Emscripten 6.0.10, with which diff, cmp and
the grep for "grep -P" were compiled. The Biowasm builds were made with earlier versions of
Emscripten, under the same licences.
