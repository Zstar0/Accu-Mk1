"""SSH transport for ACP providers: validated ssh argv, Ed25519 keys, Fernet at rest, key files (spec 6).

This is a security control, so every validator fails closed: it raises `ValueError(<column name>)` for
anything that does not match, including non-strings and a trailing newline (`fullmatch`, never `$`).
Nothing here logs, prints or returns key material except `generate_keypair` (to its caller) and
`decrypt_private`. The argv is a list handed to the process API, never a shell string, and every field
in it is validated first.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import ipaddress
import os
import re
import shutil
import tempfile
import threading

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from integration_keys import store

_SLUG = re.compile(r"[a-z0-9-]{2,32}")
_USER = re.compile(r"[a-z_][a-z0-9_-]{0,31}")
_LABEL = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?")  # RFC 1123 label, never starts with "-"
_HOST_KEY = re.compile(r"(?:ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,3}")
_PUBLIC_KEY = re.compile(r"ssh-ed25519 [A-Za-z0-9+/]+={0,3}")  # the only key type Mk1 generates
_PATH = re.compile(r"/[A-Za-z0-9._/-]{0,255}")
# A file path that rides inside an ssh `-o Option=<path>` string: ssh splits that on whitespace, honours
# quotes and expands `%` tokens, so none of those may appear.
_ARG_PATH = re.compile(r"[^\s\x00-\x1f\x7f\"'%]{1,4096}")


def _match(rx: re.Pattern[str], value: object, field: str) -> str:
    if not isinstance(value, str) or rx.fullmatch(value) is None:
        raise ValueError(field)
    return value


def _is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return False
    return "%" not in value  # no IPv6 zone ids


def validate_slug(s: object) -> str:
    return _match(_SLUG, s, "slug")


def validate_user(s: object) -> str:
    return _match(_USER, s, "ssh_user")


def validate_port(n: object) -> int:
    if type(n) is not int or not 1 <= n <= 65535:  # `type`, not isinstance: True is not a port
        raise ValueError("ssh_port")
    return n


def validate_host(s: object) -> str:
    """An IP literal or an RFC 1123 hostname; never starts with "-"."""
    if isinstance(s, str) and 0 < len(s) <= 253:
        if _is_ip(s):
            return s
        labels = s.split(".")
        # An all-digit last label ("127.1", "2130706433") is an inet_aton spelling of an IP, not a hostname.
        if all(_LABEL.fullmatch(x) for x in labels) and not labels[-1].isdigit():
            return s
    raise ValueError("ssh_host")


def validate_host_key(s: object) -> str:
    return _match(_HOST_KEY, s, "host_key")


def validate_from_ip(s: object) -> str:
    if isinstance(s, str) and _is_ip(s):
        return s
    raise ValueError("authorized_from")


def validate_path(s: object, field: str = "path") -> str:
    """An absolute POSIX path; `field` names the provider column (`launcher_path`, `session_cwd`)."""
    return _match(_PATH, s, field)


def generate_keypair() -> tuple[bytes, str]:
    """(OpenSSH private PEM, `ssh-ed25519 AAAA...` public line)."""
    key = Ed25519PrivateKey.generate()
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH,
                            serialization.NoEncryption())
    public = key.public_key().public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH)
    return pem, public.decode()


def encrypt_private(pem: bytes) -> str:
    f = store._fernet()
    if f is None:
        raise store.KeysNotConfigured()
    return f.encrypt(pem).decode()


def decrypt_private(ct: str) -> bytes:
    """Raises `KeysNotConfigured` without a secret; `cryptography.fernet.InvalidToken` if the secret changed."""
    f = store._fernet()
    if f is None:
        raise store.KeysNotConfigured()
    return f.decrypt(ct.encode())


def fingerprint(public_line: str) -> str:
    """`SHA256:` + unpadded base64 of sha256 of the key blob, as `ssh-keygen -lf` prints it."""
    parts = public_line.split() if isinstance(public_line, str) else []
    if len(parts) < 2:
        raise ValueError("public_line")
    try:
        blob = base64.b64decode(parts[1], validate=True)
    except binascii.Error:
        raise ValueError("public_line") from None
    return "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")


def authorized_keys_line(public_key: str, slug: str, launcher_path: str, authorized_from: str) -> str:
    """The line the admin installs on the bot host: pins the source IP and the forced command."""
    key = _match(_PUBLIC_KEY, public_key, "public_key")
    return (f'from="{validate_from_ip(authorized_from)}",restrict,'
            f'command="{validate_path(launcher_path, "launcher_path")}" {key} mk1-acp-{validate_slug(slug)}')


def build_ssh_argv(*, host: str, port: int, user: str, slug: str, keyfile: str, known_hosts: str) -> list[str]:
    host, port, user, slug = validate_host(host), validate_port(port), validate_user(user), validate_slug(slug)
    keyfile = _match(_ARG_PATH, keyfile, "keyfile")
    known_hosts = _match(_ARG_PATH, known_hosts, "known_hosts")
    return ["ssh", "-T", "-F", "/dev/null", "-i", keyfile,
            "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={known_hosts}",
            "-o", f"HostKeyAlias={slug}",
            "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
            "-p", str(port), f"{user}@{host}"]


def _write(path: str, data: bytes) -> None:
    """Mode 0600 from the first byte, atomic (a concurrent spawn never reads half a key), skipped if unchanged."""
    try:
        with open(path, "rb") as f:
            if f.read() == data:
                return
    except FileNotFoundError:
        pass
    tmp = path + ".tmp"
    try:
        os.unlink(tmp)  # a leftover from a crash mid-write; O_EXCL below refuses to reuse it
    except FileNotFoundError:
        pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


class KeyFiles:
    """Per-provider `<slug>.key` and `<slug>.known_hosts` in one private (0700) directory.

    `root` is the parent for the `mkdtemp` directory: `/dev/shm` when it exists (memory-backed, so the key
    never reaches disk), else the tempfile default. The directory is created on first use. The owner calls
    `cleanup()` at shutdown.
    """

    def __init__(self, root: str | None = None) -> None:
        self._root = root
        self._dir: str | None = None
        self._lock = threading.Lock()

    def paths(self, slug: str, private_pem: bytes, host_key: str) -> tuple[str, str]:
        """(keyfile, known_hosts). Validates first; writes only what changed."""
        slug, host_key = validate_slug(slug), validate_host_key(host_key)
        if not isinstance(private_pem, bytes) or not private_pem:
            raise ValueError("private_key")
        with self._lock:
            if self._dir is None:
                root = self._root or ("/dev/shm" if os.path.isdir("/dev/shm") else None)
                self._dir = tempfile.mkdtemp(prefix="mk1-acp-", dir=root)
            keyfile = os.path.join(self._dir, f"{slug}.key")
            known_hosts = os.path.join(self._dir, f"{slug}.known_hosts")
            _write(keyfile, private_pem)
            _write(known_hosts, f"{slug} {host_key}\n".encode())
        return keyfile, known_hosts

    def cleanup(self) -> None:
        with self._lock:
            d, self._dir = self._dir, None
            if d is not None:
                shutil.rmtree(d, ignore_errors=True)


KEYFILES = KeyFiles()
