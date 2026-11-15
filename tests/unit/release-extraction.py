import hashlib
import importlib.util
import io
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("extract_release", Path(__file__).resolve().parents[2] / "scripts/extract-release.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
SHA = "a" * 40
NAME = f"itsm-release-{SHA}.tar.gz"


def tar_bytes(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz", format=tarfile.GNU_FORMAT) as archive:
        for name, payload, kind in entries:
            entry = tarfile.TarInfo(name)
            entry.type = kind
            if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                entry.linkname = "../../outside"
            entry.size = len(payload) if kind == tarfile.REGTYPE else 0
            archive.addfile(entry, io.BytesIO(payload) if entry.size else None)
    return output.getvalue()


class ExtractionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def artifact(self, entries, checksum=None, extra=False, symlink=False):
        archive = tar_bytes(entries)
        checksum = checksum or hashlib.sha256(archive).hexdigest()
        path = self.root / "artifact.zip"
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as outer:
            info = zipfile.ZipInfo(NAME)
            info.external_attr = ((stat.S_IFLNK if symlink else stat.S_IFREG) | 0o600) << 16
            outer.writestr(info, archive)
            outer.writestr(NAME + ".sha256", f"{checksum}  {NAME}\n")
            if extra:
                outer.writestr("../outside", "no")
        return path

    def extract(self, entries, **options):
        target = self.root / "result"
        module.extract_release(self.artifact(entries, **options), target, SHA)
        return target / "bundle"

    def test_regular_files_get_private_permissions_without_restoring_ownership(self):
        bundle = self.extract([(".", b"", tarfile.DIRTYPE), ("./scripts", b"", tarfile.DIRTYPE),
                               ("./release.json", b"{}", tarfile.REGTYPE),
                               ("./scripts/check.mjs", b"safe", tarfile.REGTYPE)])
        self.assertEqual((bundle / "scripts/check.mjs").read_bytes(), b"safe")
        self.assertEqual((bundle / "scripts/check.mjs").stat().st_mode & 0o777, 0o600)
        self.assertEqual(bundle.stat().st_mode & 0o777, 0o700)
        self.assertFalse((bundle.parent / NAME).exists())

    def test_cli_uses_bounded_extraction_and_redacts_rejection(self):
        archive = self.artifact([("release.json", b"{}", tarfile.REGTYPE)])
        target = self.root / "cli-result"
        result = subprocess.run([sys.executable, str(Path(module.__file__)), str(archive), str(target), SHA],
                                capture_output=True, text=True, timeout=45)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((target / "bundle/release.json").read_text(), "{}")
        result = subprocess.run([sys.executable, str(Path(module.__file__)), "sensitive-archive-path", str(target), SHA],
                                capture_output=True, text=True, timeout=45)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr.strip(), "UNSAFE_RELEASE_ARCHIVE")
        self.assertNotIn("sensitive-archive-path", result.stdout + result.stderr)

    def test_accepts_only_the_reviewed_systemd_template_path(self):
        template = "infra/systemd/itsm-deploy-approved@.service"
        bundle = self.extract([("release.json", b"{}", tarfile.REGTYPE),
                               ("./" + template, b"[Unit]\n", tarfile.REGTYPE)])
        self.assertEqual((bundle / template).read_bytes(), b"[Unit]\n")
        self.assertEqual((bundle / template).stat().st_mode & 0o777, 0o600)
        self.clear_result()
        for name in ("infra/systemd/other@.service", "../" + template, "/" + template,
                     "infra/systemd/../systemd/itsm-deploy-approved@.service"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.extract([("release.json", b"{}", tarfile.REGTYPE), (name, b"no", tarfile.REGTYPE)])
            self.clear_result()

    def clear_result(self):
        import shutil
        shutil.rmtree(self.root / "result", ignore_errors=True)

    def test_rejects_traversal_absolute_paths_and_normalized_duplicates(self):
        for name in ("../outside", "/outside", "./../outside", "a/../../outside", "a//b", "a/./b", "a\\b"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.extract([(name, b"no", tarfile.REGTYPE)])
            self.clear_result()
        with self.assertRaises(ValueError):
            self.extract([("release.json", b"{}", tarfile.REGTYPE), ("./release.json", b"{}", tarfile.REGTYPE)])
        self.assertFalse((self.root / "outside").exists())

    def test_rejects_links_and_special_tar_members(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE):
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                self.extract([("release.json", b"{}", tarfile.REGTYPE), ("scripts/unsafe", b"", kind)])
            self.clear_result()

    def test_rejects_wrong_checksum_extra_zip_members_and_outer_links(self):
        entries = [("release.json", b"{}", tarfile.REGTYPE)]
        for options in ({"checksum": "0" * 64}, {"extra": True}, {"symlink": True}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.extract(entries, **options)
            self.clear_result()

    def test_rejects_expansion_limits_and_missing_manifest(self):
        with self.assertRaises(ValueError):
            self.extract([("release.json", b"x" * (module.MAX_FILE + 1), tarfile.REGTYPE)])
        self.clear_result()
        with self.assertRaises(ValueError):
            self.extract([("other.txt", b"no manifest", tarfile.REGTYPE)])

    def test_refuses_existing_destination_and_duplicate_zip_members(self):
        archive = self.artifact([("release.json", b"{}", tarfile.REGTYPE)])
        destination = self.root / "existing"
        destination.mkdir()
        (destination / "preserve").write_text("existing")
        with self.assertRaises(ValueError):
            module.extract_release(archive, destination, SHA)
        self.assertEqual((destination / "preserve").read_text(), "existing")
        with zipfile.ZipFile(archive, "a") as outer:
            outer.writestr(NAME, b"duplicate")
        with self.assertRaises(ValueError):
            module.extract_release(archive, self.root / "result", SHA)


if __name__ == "__main__":
    unittest.main()
