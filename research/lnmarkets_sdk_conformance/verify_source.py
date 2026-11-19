"""Verify the unmodified MIT-licensed source snapshots before running probes."""

import hashlib
import json
from pathlib import Path


def verify() -> None:
    root = Path(__file__).resolve().parent
    manifest = json.loads((root / "provenance.json").read_text())
    for source in manifest["sources"]:
        data = (root / source["local"]).read_bytes()
        sha256 = hashlib.sha256(data).hexdigest()
        blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        if sha256 != source["sha256"] or blob != source["sha"]:
            raise SystemExit(f"Source hash mismatch: {source['local']}")
    license_data = (root / "UPSTREAM-LICENSE").read_bytes()
    license_blob = hashlib.sha1(
        b"blob " + str(len(license_data)).encode() + b"\0" + license_data
    ).hexdigest()
    if license_blob != manifest["license"]["sha"]:
        raise SystemExit("Source license hash mismatch")


if __name__ == "__main__":
    verify()
    print("Verified six source snapshots and the upstream license")
