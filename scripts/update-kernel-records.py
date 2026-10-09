"""Update wheel RECORD hashes after relocating installed Python entrypoint shebangs."""

import base64
import csv
import hashlib
import json
from pathlib import Path
import sys

kernel = Path(sys.argv[1]).resolve(strict=True)
relocated = {kernel / name for name in json.loads(Path(sys.argv[2]).read_text())}
if any(not path.is_file() or not path.is_relative_to(kernel / "bin") for path in relocated):
    raise RuntimeError("Relocated entrypoint escaped the native kernel bin directory")
site = kernel / "lib" / "python3.14" / "site-packages"
for record in sorted(site.glob("*.dist-info/RECORD")):
    with record.open(newline="") as stream:
        rows = list(csv.reader(stream))
    changed = False
    next_rows = []
    for row in rows:
        if len(row) != 3:
            raise RuntimeError("Malformed installed wheel RECORD")
        installed = (site / row[0]).resolve()
        if not installed.is_relative_to(kernel):
            raise RuntimeError("Installed wheel RECORD references a build-machine path")
        if installed.suffix == ".pyc" and not installed.exists():
            changed = True
            continue
        if installed in relocated:
            data = installed.read_bytes()
            row[1] = "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode("ascii")
            row[2] = str(len(data))
            changed = True
        next_rows.append(row)
    if changed:
        with record.open("w", newline="") as stream:
            writer = csv.writer(stream, lineterminator="\n")
            writer.writerows(next_rows)
