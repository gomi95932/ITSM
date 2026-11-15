"""Extract a verified Actions artifact without trusting archive paths or metadata."""

import hashlib
import os
from pathlib import Path
import re
import resource
import shutil
import stat
import sys
import tarfile
import zipfile

MAX_ARCHIVE = 100 * 1024 * 1024
MAX_CONTENT = 32 * 1024 * 1024
MAX_FILE = 8 * 1024 * 1024


def require(condition):
    if not condition:
        raise ValueError("UNSAFE_RELEASE_ARCHIVE")


def extract_release(artifact, destination, sha):
    require(re.fullmatch(r"[a-f0-9]{40}", sha) is not None)
    destination = Path(destination)
    require(not destination.exists())
    require(Path(artifact).stat().st_size <= MAX_ARCHIVE)
    archive_name = f"itsm-release-{sha}.tar.gz"
    checksum_name = f"{archive_name}.sha256"
    destination.mkdir(mode=0o700)
    archive_path = destination / archive_name
    with zipfile.ZipFile(artifact) as outer:
        entries = outer.infolist()
        require(len(entries) == 2)
        require({entry.filename for entry in entries} == {archive_name, checksum_name})
        for entry in entries:
            mode = entry.external_attr >> 16
            require(not entry.is_dir() and not entry.flag_bits & 1)
            require(stat.S_IFMT(mode) in (0, stat.S_IFREG))
            require(0 < entry.file_size <= (MAX_ARCHIVE if entry.filename == archive_name else 256))
        checksum = outer.read(checksum_name).decode("ascii")
        match = re.fullmatch(rf"([a-f0-9]{{64}})  {re.escape(archive_name)}\n", checksum)
        require(match is not None)
        digest = hashlib.sha256()
        size = 0
        with outer.open(archive_name) as source, archive_path.open("xb") as target:
            os.chmod(archive_path, 0o600)
            while chunk := source.read(64 * 1024):
                size += len(chunk)
                require(size <= MAX_ARCHIVE)
                digest.update(chunk)
                target.write(chunk)
        require(digest.hexdigest() == match.group(1))

    bundle = destination / "bundle"
    bundle.mkdir(mode=0o700)
    seen = set()
    total = 0
    with tarfile.open(archive_path, mode="r|gz") as archive:
        for entry in archive:
            name = entry.name
            if name in (".", "./"):
                require(entry.isdir() and "." not in seen)
                seen.add(".")
                continue
            if name.startswith("./"):
                name = name[2:]
            if name.endswith("/"):
                name = name[:-1]
            require(re.fullmatch(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*", name) is not None)
            require(all(part not in (".", "..") for part in name.split("/")))
            require(name not in seen and len(seen) < 512)
            require(not entry.pax_headers and (entry.isdir() or entry.isreg()))
            seen.add(name)
            target = bundle / name
            if entry.isdir():
                require(entry.size == 0)
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
                continue
            require(0 <= entry.size <= MAX_FILE)
            total += entry.size
            require(total <= MAX_CONTENT)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as output, archive.extractfile(entry) as source:
                shutil.copyfileobj(source, output, length=64 * 1024)
            require(target.stat().st_size == entry.size)
    require((bundle / "release.json").is_file())
    archive_path.unlink()


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 4)
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
        os.umask(0o077)
        extract_release(*sys.argv[1:])
    except Exception:
        print("UNSAFE_RELEASE_ARCHIVE", file=sys.stderr)
        sys.exit(1)
