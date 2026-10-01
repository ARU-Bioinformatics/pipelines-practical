"""Download the part of Pyodide 0.29.5 this practical needs into ../assets/vendor/pyodide/,
so that the site does not depend on the jsDelivr CDN (for networks that block it).

    python3 fetch_pyodide.py            # about 30 MB
then set  pyodideBase: 'assets/vendor/pyodide/'  in assets/js/config.js.

Only Python itself and the packages the practical loads (NumPy, pandas, Matplotlib,
PyYAML and what they depend on) are fetched. Every file is checked against the
SHA-256 in Pyodide's own lock file. Pyodide is under the Mozilla Public Licence 2.0;
the packages keep their own licences (see THIRD_PARTY.md).
"""
import hashlib
import json
import os
import sys
import urllib.request

VERSION = "0.29.5"
CDN = f"https://cdn.jsdelivr.net/pyodide/v{VERSION}/full/"
PACKAGES = ["numpy", "pandas", "matplotlib", "pyyaml"]
CORE = ["pyodide.js", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"]
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "assets", "vendor", "pyodide")


def get(name):
    with urllib.request.urlopen(CDN + name, timeout=120) as r:
        return r.read()


def main():
    os.makedirs(OUT, exist_ok=True)
    lock_bytes = get("pyodide-lock.json")
    lock = json.loads(lock_bytes)
    if lock["info"].get("version") not in (None, VERSION):
        sys.exit(f"unexpected Pyodide version {lock['info']['version']}")
    # the packages and everything they depend on
    todo, need = list(PACKAGES), []
    while todo:
        name = todo.pop()
        if name in need:
            continue
        need.append(name)
        todo.extend(lock["packages"][name].get("depends", []))
    total = 0
    for name in CORE:
        data = lock_bytes if name == "pyodide-lock.json" else get(name)
        open(os.path.join(OUT, name), "wb").write(data)
        total += len(data)
        print(f"{len(data):>10,}  {name}")
    for name in sorted(need):
        pkg = lock["packages"][name]
        data = get(pkg["file_name"])
        if hashlib.sha256(data).hexdigest() != pkg["sha256"]:
            sys.exit(f"checksum mismatch for {pkg['file_name']} – not saved")
        open(os.path.join(OUT, pkg["file_name"]), "wb").write(data)
        total += len(data)
        print(f"{len(data):>10,}  {pkg['file_name']}")
    open(os.path.join(OUT, "NOTICE.txt"), "w").write(
        f"Pyodide {VERSION} (https://pyodide.org), Mozilla Public License 2.0:\n"
        "https://github.com/pyodide/pyodide/blob/main/LICENSE\n"
        f"Downloaded from {CDN} by build/fetch_pyodide.py; the package files were checked against\n"
        "the SHA-256 values in pyodide-lock.json. Each package keeps its own licence\n"
        "(CPython: PSF; NumPy, pandas: BSD 3-clause; Matplotlib: Matplotlib licence; PyYAML: MIT).\n"
        "Packages: " + ", ".join(f"{n} {lock['packages'][n]['version']}" for n in sorted(need)) + "\n")
    print(f"{total:,} bytes in {os.path.normpath(OUT)}")
    print("Now set  pyodideBase: 'assets/vendor/pyodide/'  in assets/js/config.js")


if __name__ == "__main__":
    main()
