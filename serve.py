#!/usr/bin/env python3
"""Serve this folder on http://localhost:PORT with HTTP range requests
(needed to read the BAM and reference files in pieces, as GitHub Pages does).
usage:  python3 serve.py [PORT]"""
import os, re, sys, http.server, socketserver

class Handler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path) or 'Range' not in self.headers:
            return super().send_head()
        m = re.match(r'bytes=(\d*)-(\d*)', self.headers['Range'])
        if not m:
            return super().send_head()
        try:
            f = open(path, 'rb')
        except OSError:
            self.send_error(404)
            return None
        size = os.fstat(f.fileno()).st_size
        a = int(m.group(1)) if m.group(1) else max(0, size - int(m.group(2)))
        b = int(m.group(2)) if (m.group(2) and m.group(1)) else size - 1
        b = min(b, size - 1)
        if a >= size:
            self.send_error(416)
            return None
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', f'bytes {a}-{b}/{size}')
        self.send_header('Content-Length', str(b - a + 1))
        self.end_headers()
        f.seek(a)
        self._remaining = b - a + 1
        return f

    def copyfile(self, source, outputfile):
        rem = getattr(self, '_remaining', None)
        if rem is None:
            return super().copyfile(source, outputfile)
        while rem > 0:
            chunk = source.read(min(65536, rem))
            if not chunk:
                break
            outputfile.write(chunk)
            rem -= len(chunk)
        self._remaining = None

    def end_headers(self):
        self.send_header('Accept-Ranges', 'bytes')
        super().end_headers()

class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f'Serving on http://localhost:{port}  (Ctrl+C to stop)')
    Server(('127.0.0.1', port), Handler).serve_forever()
