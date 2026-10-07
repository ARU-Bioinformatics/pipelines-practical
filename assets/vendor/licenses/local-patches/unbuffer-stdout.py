#!/usr/bin/env python3
"""Make the C library's stdout unbuffered in a WebAssembly program built with Emscripten.

Why: the GNU coreutils programs flush stdout in a function registered with atexit(). The biowasm
builds are linked without EXIT_RUNTIME, so that function never runs, and the C library's stdout is
line-buffered: output that does not end with a newline stayed in the buffer and was lost
(seq 3 | tr '\n' ' ' printed nothing). The programs do not export fflush, so the page cannot
flush for them.

What: in the program's initial memory there are three FILE objects (musl libc): stdin, stdout,
stderr. stderr is unbuffered because its buf_size is 0. This script sets buf_size of stdout from
1024 to 0 as well – one byte of the data section changes (04 -> 00); nothing else, and the
file keeps its size. With buf_size 0 every write goes straight to the file descriptor.

Usage: unbuffer-stdout.py FILE.wasm [FILE.wasm ...]     (changes the files in place)
       unbuffer-stdout.py --check FILE.wasm ...          (reports only)
"""
import struct, sys


def leb(b, p):
    r = s = 0
    while True:
        c = b[p]; p += 1
        r |= (c & 0x7F) << s; s += 7
        if c < 0x80:
            return r, p


def sleb(b, p):
    r = s = 0
    while True:
        c = b[p]; p += 1
        r |= (c & 0x7F) << s; s += 7
        if c < 0x80:
            return (r - (1 << s) if c & 0x40 else r), p


def segments(b):
    """active data segments: (memory address, length, offset in the file)"""
    assert b[:8] == b'\0asm\x01\0\0\0', 'not a WebAssembly module'
    p, out = 8, []
    while p < len(b):
        sid = b[p]; p += 1
        size, p = leb(b, p)
        if sid == 11:
            q = p
            n, q = leb(b, q)
            for _ in range(n):
                flag, q = leb(b, q)
                if flag == 1:  # passive
                    ln, q = leb(b, q); q += ln
                    continue
                if flag == 2:
                    _, q = leb(b, q)
                assert b[q] == 0x41, 'unexpected offset expression'
                addr, q = sleb(b, q + 1)
                assert b[q] == 0x0B
                ln, q = leb(b, q + 1)
                out.append((addr, ln, q))
                q += ln
        p += size
    return out


def stdio(b):
    """the standard FILE objects of musl in the initial memory: fd -> (address, buf_size, file offset of buf_size)"""
    segs = segments(b)
    mem = bytearray(max(a + l for a, l, _ in segs) + 256)
    where = {}
    for a, l, off in segs:
        mem[a:a + l] = b[off:off + l]
        for i in range(l):
            where[a + i] = off + i
    found = {}
    for a in range(0, len(mem) - 160, 4):
        flags, rpos, rend, close, wend, wpos, mbz, wbase, read, write, seek, buf, size, prev, nxt, fd = struct.unpack_from('<16I', mem, a)
        if flags not in (5, 9) or rpos or rend or wend or wpos or mbz or wbase or prev or nxt or fd > 2 or not seek or not close:
            continue
        if (flags == 9) != (fd == 0) or (fd == 0 and not read) or (fd > 0 and not write):
            continue
        assert fd not in found, 'two candidates for fd %d' % fd
        # 1024 is stored as the bytes 00 04 00 00; only the non-zero one need be in the file
        found[fd] = (a, size, where.get(a + 49))
    return found


def main(argv):
    check = argv[:1] == ['--check']
    for f in argv[1:] if check else argv:
        b = bytearray(open(f, 'rb').read())
        s = stdio(b)
        if 1 not in s or 2 not in s:
            print(f'{f}: stdout/stderr objects not found – left alone'); continue
        addr, size, off = s[1]
        if s[2][1] != 0:
            print(f'{f}: stderr is not unbuffered (buf_size {s[2][1]}) – unexpected layout, left alone'); continue
        if size == 0:
            print(f'{f}: stdout is unbuffered already'); continue
        if size != 1024 or off is None or b[off] != 4:
            print(f'{f}: stdout buf_size is {size} – unexpected, left alone'); continue
        if check:
            print(f'{f}: stdout at {addr}, buf_size {size} (byte {off} of the file)'); continue
        b[off] = 0
        assert stdio(b)[1][1] == 0
        open(f, 'wb').write(b)
        print(f'{f}: stdout buf_size 1024 -> 0 (byte {off}: 04 -> 00)')


if __name__ == '__main__':
    main(sys.argv[1:])
