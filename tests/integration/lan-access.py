import configparser
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import unittest


ROOT = Path(__file__).resolve().parents[2]
RULES = ROOT / "infra/nftables/itsm-dev-lan.nft"
DESTINATION = "10.10.81.125"
MARKER = b"itsm-isolated-lan-fixture\n"


def command(*args, input_text=None, check=True):
    return subprocess.run(
        args, input=input_text, text=True, capture_output=True,
        timeout=10, check=check,
    )


def unit(name):
    parser = configparser.ConfigParser(interpolation=None)
    parser.optionxform = str
    with (ROOT / "infra/systemd" / name).open() as source:
        parser.read_file(source)
    return parser


class Endpoint:
    def __init__(self, address, port):
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.socket.bind((address, port))
        self.socket.listen(16)
        self.socket.settimeout(0.1)
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        while not self.stopped.is_set():
            try:
                connection, _ = self.socket.accept()
            except socket.timeout:
                continue
            except OSError:
                if self.stopped.is_set():
                    return
                raise
            with connection:
                connection.settimeout(1)
                connection.sendall(MARKER)

    def close(self):
        self.stopped.set()
        self.socket.close()
        self.thread.join(timeout=2)
        if self.thread.is_alive():
            raise RuntimeError("FIXTURE_ENDPOINT_DID_NOT_STOP")


class LanAccess(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Never alter the host ruleset, even when invoked with sudo by mistake.
        if os.geteuid() != 0 or os.stat("/proc/self/ns/net").st_ino == os.stat("/proc/1/ns/net").st_ino:
            raise RuntimeError("ROOT_IN_DISPOSABLE_NETWORK_NAMESPACE_REQUIRED")
        command("ip", "link", "set", "lo", "up")
        sources = [
            DESTINATION, "10.10.81.10", "10.10.91.10", "10.10.80.255",
            "10.10.82.0", "10.10.90.255", "10.10.92.0",
        ]
        for address in sources:
            command("ip", "address", "add", address + "/32", "dev", "lo")
        command("nft", "--file", "-", input_text="""
table inet unrelated_fixture {
    chain output {
        type filter hook output priority 0; policy accept;
        ip daddr 192.0.2.1 counter accept
    }
}
""")
        command("nft", "--check", "--file", str(RULES))
        command("nft", "--file", str(RULES))
        cls.lan = Endpoint(DESTINATION, 8080)
        cls.addClassCleanup(cls.lan.close)
        cls.loopback = Endpoint("127.0.0.1", 8088)
        cls.addClassCleanup(cls.loopback.close)

    def probe(self, source, destination=DESTINATION, port=8080):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
            connection.settimeout(0.75)
            connection.bind((source, 0))
            connection.connect((destination, port))
            received = bytearray()
            while len(received) < len(MARKER):
                chunk = connection.recv(len(MARKER) - len(received))
                if not chunk:
                    break
                received.extend(chunk)
            self.assertEqual(bytes(received), MARKER)

    def test_allowed_networks_and_denied_neighbors(self):
        for source in ["10.10.81.10", "10.10.91.10", DESTINATION]:
            with self.subTest(source=source):
                self.probe(source)
        for source in ["10.10.80.255", "10.10.82.0", "10.10.90.255", "10.10.92.0", "127.0.0.2"]:
            with self.subTest(source=source):
                self.probe(source, "127.0.0.1", 8088)
                with self.assertRaises(socket.timeout):
                    self.probe(source)

    def test_repeat_application_replaces_only_dedicated_table(self):
        before = json.loads(command("nft", "--json", "list", "table", "inet", "unrelated_fixture").stdout)
        for _ in range(2):
            command("nft", "--file", str(RULES))
        after = json.loads(command("nft", "--json", "list", "table", "inet", "unrelated_fixture").stdout)
        self.assertEqual(before, after)
        own = json.loads(command("nft", "--json", "list", "table", "inet", "itsm_dev_lan").stdout)
        self.assertEqual(sum("chain" in entry for entry in own["nftables"]), 1)
        self.assertEqual(sum("rule" in entry for entry in own["nftables"]), 1)
        self.probe("10.10.91.10")
        with self.assertRaises(socket.timeout):
            self.probe("127.0.0.2")

    def test_rejected_transaction_keeps_previous_filter(self):
        # A kernel-rejected rule follows a valid delete in the same batch.
        invalid = """
delete table inet itsm_dev_lan
add rule inet unrelated_fixture nonexistent_chain tcp dport 1 drop
"""
        result = command("nft", "--file", "-", input_text=invalid, check=False)
        self.assertNotEqual(result.returncode, 0)
        command("nft", "list", "table", "inet", "itsm_dev_lan")
        self.probe("10.10.81.10")
        with self.assertRaises(socket.timeout):
            self.probe("127.0.0.2")

    def test_fixed_units_fail_closed_and_keep_filter_on_stop(self):
        firewall = unit("itsm-dev-lan-firewall.service")
        lan_socket = unit("itsm-dev-lan.socket")
        service = unit("itsm-dev-lan.service")
        firewall_name = "itsm-dev-lan-firewall.service"
        for config in [lan_socket, service]:
            for dependency in ["BindsTo", "After", "PartOf"]:
                self.assertIn(firewall_name, config["Unit"][dependency].split())
        self.assertIn("itsm-dev-lan.socket", service["Unit"]["BindsTo"].split())
        self.assertEqual(lan_socket["Socket"]["ListenStream"], DESTINATION + ":8080")
        self.assertEqual(lan_socket["Socket"]["IPAddressDeny"], "any")
        self.assertEqual(set(lan_socket["Socket"]["IPAddressAllow"].split()), {
            "127.0.0.1/32", "10.10.81.0/24", "10.10.91.0/24",
        })
        self.assertEqual(service["Service"]["IPAddressDeny"], "any")
        self.assertEqual(service["Service"]["IPAddressAllow"], "127.0.0.1/32")
        self.assertEqual(service["Service"]["ExecStart"],
                         "/usr/lib/systemd/systemd-socket-proxyd --connections-max=128 127.0.0.1:8088")
        self.assertEqual(firewall["Service"]["Type"], "oneshot")
        self.assertEqual(firewall["Service"]["RemainAfterExit"], "yes")
        for action in ["ExecStart", "ExecReload"]:
            self.assertEqual(firewall["Service"][action], "/usr/sbin/nft --file /etc/itsm-dev-lan.nft")
        for action in ["ExecStartPre", "ExecStop", "ExecStopPost"]:
            self.assertNotIn(action, firewall["Service"])
        self.assertEqual(set(firewall["Unit"]["Before"].split()), {
            "itsm-dev-lan.socket", "itsm-dev-lan.service",
        })


if __name__ == "__main__":
    unittest.main(verbosity=2)
