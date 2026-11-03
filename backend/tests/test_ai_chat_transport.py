"""ai_chat.transport: validated ssh argv, Ed25519 keys, Fernet at rest, per-provider key files (spec 6)."""
import os
from pathlib import Path

import pytest
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import serialization

from ai_chat import transport
from ai_chat.transport import (
    KEYFILES,
    KeyFiles,
    authorized_keys_line,
    build_ssh_argv,
    decrypt_private,
    encrypt_private,
    fingerprint,
    generate_keypair,
    validate_from_ip,
    validate_host,
    validate_host_key,
    validate_path,
    validate_port,
    validate_slug,
    validate_user,
)
from integration_keys import store

ED_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMR/YW4CFNOosryx/jlJSanzDGJ/mMQWbPpsN/qO2t8l"
ED_KEY_FPR = "SHA256:uaiifYCziLaZiVJFa7gWeH1DphLhPkUioVT1Em0berk"  # ssh-keygen -lf of the key above
JARVIS = dict(host="100.68.141.122", port=22, user="hermes-tars", slug="jarvis", keyfile="/k", known_hosts="/h")


# ---- validators ------------------------------------------------------------------------------

@pytest.mark.parametrize("host", ["-oProxyCommand=x", "a b", "host;rm", "", "x" * 300, "h\nx",
                                  "host\n", " host", "host.", "-host", "a" * 64 + ".example",
                                  "127.1", "2130706433", "1.2.3", "fe80::1%eth0", "ho_st", "höst", None, 7])
def test_hostile_host_rejected(host):
    with pytest.raises(ValueError, match="ssh_host"):
        validate_host(host)


@pytest.mark.parametrize("host", ["100.68.141.122", "jarvis", "bot-1.tail1234.ts.net", "::1",
                                  "2001:db8::1", "a" * 63 + ".example", "Host-1"])
def test_good_host_accepted(host):
    assert validate_host(host) == host


@pytest.mark.parametrize("user", ["root -o", "-x", "Root", "a" * 33, "", "a\n", "a b", None])
def test_hostile_user_rejected(user):
    with pytest.raises(ValueError, match="ssh_user"):
        validate_user(user)


@pytest.mark.parametrize("user", ["hermes-tars", "_svc", "a", "a" * 32])
def test_good_user_accepted(user):
    assert validate_user(user) == user


@pytest.mark.parametrize("port", [0, 65536, -1, True, "22", 22.0, None])
def test_bad_port_rejected(port):
    with pytest.raises(ValueError, match="ssh_port"):
        validate_port(port)


@pytest.mark.parametrize("port", [1, 22, 65535])
def test_good_port_accepted(port):
    assert validate_port(port) == port


@pytest.mark.parametrize("slug", ["a", "A1", "ja rvis", "jarvis\n", "a" * 33, "../x", "a/b", "a.b", "", None])
def test_bad_slug_rejected(slug):
    with pytest.raises(ValueError, match="slug"):
        validate_slug(slug)


@pytest.mark.parametrize("slug", ["jarvis", "ab", "a-1", "a" * 32])
def test_good_slug_accepted(slug):
    assert validate_slug(slug) == slug


@pytest.mark.parametrize("key", [
    "", "ssh-ed25519", "ssh-ed25519 ", ED_KEY + "\n", ED_KEY + "\nssh-rsa AAAA", ED_KEY + " comment",
    "ssh-dss AAAA", "ssh-ed25519  AAAA", "@cert-authority ssh-ed25519 AAAA", "ssh-ed25519 AA=AA", "ssh-ed25519 A====", None])
def test_bad_host_key_rejected(key):
    with pytest.raises(ValueError, match="host_key"):
        validate_host_key(key)


@pytest.mark.parametrize("key", [ED_KEY, "ecdsa-sha2-nistp256 AAAAE2VjZHNh", "ecdsa-sha2-nistp521 AAAA==",
                                 "ssh-rsa AAAAB3NzaC1yc2E="])
def test_good_host_key_accepted(key):
    assert validate_host_key(key) == key


@pytest.mark.parametrize("ip", ["", "host", "100.120.92.93\n", "100.120.92.0/24", "1.2.3", "fe80::1%eth0", " 1.2.3.4", None])
def test_bad_from_ip_rejected(ip):
    with pytest.raises(ValueError, match="authorized_from"):
        validate_from_ip(ip)


@pytest.mark.parametrize("ip", ["100.120.92.93", "::1", "2001:db8::1"])
def test_good_from_ip_accepted(ip):
    assert validate_from_ip(ip) == ip


@pytest.mark.parametrize("path", ["", "rel/x", "/a b", '/a"b', "/a\n", "/a\nb", "/a;b", "/$HOME", "/" + "a" * 256, None])
def test_bad_path_rejected_default_field(path):
    with pytest.raises(ValueError, match="^path$"):
        validate_path(path)


def test_bad_path_names_the_caller_field():
    with pytest.raises(ValueError, match="^session_cwd$"):
        validate_path("rel", "session_cwd")
    with pytest.raises(ValueError, match="^launcher_path$"):
        validate_path('/x"', field="launcher_path")


@pytest.mark.parametrize("path", ["/", "/tmp", "/opt/accumark/hermes/bb-acp/20261030/bin/hermes-jarvis", "/" + "a" * 255])
def test_good_path_accepted(path):
    assert validate_path(path) == path


# ---- argv ------------------------------------------------------------------------------------

def test_argv_shape():
    argv = build_ssh_argv(host="100.68.141.122", port=22, user="hermes-tars", slug="jarvis", keyfile="/k", known_hosts="/h")
    assert argv[:4] == ["ssh", "-T", "-F", "/dev/null"]
    assert "HostKeyAlias=jarvis" in argv and "StrictHostKeyChecking=yes" in argv and "BatchMode=yes" in argv
    assert argv[-3:] == ["-p", "22", "hermes-tars@100.68.141.122"]


def test_argv_is_exactly_the_spec_section_6_argv():
    assert build_ssh_argv(**JARVIS) == [
        "ssh", "-T", "-F", "/dev/null", "-i", "/k",
        "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=/h", "-o", "HostKeyAlias=jarvis",
        "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
        "-p", "22", "hermes-tars@100.68.141.122"]


@pytest.mark.parametrize("field,bad,name", [
    ("host", "-oProxyCommand=x", "ssh_host"), ("host", "a b", "ssh_host"),
    ("user", "root -o", "ssh_user"), ("user", "-x", "ssh_user"),
    ("port", 0, "ssh_port"), ("port", "22 -o x", "ssh_port"),
    ("slug", "a b", "slug"), ("slug", "x\n", "slug"),
    ("keyfile", "", "keyfile"), ("keyfile", "/k -o ProxyCommand=x", "keyfile"), ("keyfile", "/k\n", "keyfile"),
    ("known_hosts", "", "known_hosts"), ("known_hosts", "/h /etc/passwd", "known_hosts"),
    ("known_hosts", "/h%d", "known_hosts"), ("known_hosts", '/h"x', "known_hosts"), ("known_hosts", None, "known_hosts")])
def test_argv_rejects_hostile_field(field, bad, name):
    with pytest.raises(ValueError, match=f"^{name}$"):
        build_ssh_argv(**{**JARVIS, field: bad})


# ---- keys ------------------------------------------------------------------------------------

def test_keypair_roundtrip_and_fingerprint():
    pem, public = generate_keypair()
    assert isinstance(pem, bytes) and pem.startswith(b"-----BEGIN OPENSSH PRIVATE KEY-----") and pem.endswith(b"\n")
    assert public.startswith("ssh-ed25519 ") and "\n" not in public and len(public.split()) == 2
    fpr = fingerprint(public)
    assert fpr.startswith("SHA256:") and "=" not in fpr
    loaded = serialization.load_ssh_private_key(pem, password=None)
    again = loaded.public_key().public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH).decode()
    assert again == public
    assert generate_keypair()[1] != public


def test_fingerprint_matches_ssh_keygen_vector():
    assert fingerprint(ED_KEY) == ED_KEY_FPR
    assert fingerprint(ED_KEY + " mk1-acp-jarvis") == ED_KEY_FPR  # a trailing comment is ignored


@pytest.mark.parametrize("line", ["", "ssh-ed25519", "ssh-ed25519 !!!!", "ssh-ed25519 AAA", None])
def test_fingerprint_rejects_garbage(line):
    with pytest.raises(ValueError):
        fingerprint(line)


@pytest.fixture
def secret(monkeypatch):
    monkeypatch.setenv("INTEGRATION_KEYS_SECRET", Fernet.generate_key().decode())


def test_encrypt_decrypt_roundtrip(secret):
    pem, _ = generate_keypair()
    ct = encrypt_private(pem)
    assert isinstance(ct, str) and "OPENSSH" not in ct and ct != pem.decode()
    assert decrypt_private(ct) == pem


def test_encrypt_requires_secret(monkeypatch):
    monkeypatch.delenv("INTEGRATION_KEYS_SECRET", raising=False)
    with pytest.raises(store.KeysNotConfigured):
        encrypt_private(b"x")
    with pytest.raises(store.KeysNotConfigured):
        decrypt_private("x")


def test_encrypt_refuses_a_malformed_secret(monkeypatch):
    monkeypatch.setenv("INTEGRATION_KEYS_SECRET", "not-a-fernet-key")
    with pytest.raises(store.KeysNotConfigured):
        encrypt_private(b"x")


def test_authorized_keys_line():
    assert authorized_keys_line("ssh-ed25519 AAAA", "jarvis", "/opt/accumark/hermes/bb-acp/20261030/bin/hermes-jarvis",
        "100.120.92.93") == 'from="100.120.92.93",restrict,command="/opt/accumark/hermes/bb-acp/20261030/bin/hermes-jarvis" ssh-ed25519 AAAA mk1-acp-jarvis'


@pytest.mark.parametrize("args,name", [
    (('ssh-ed25519 AAAA" ,command="x', "jarvis", "/l", "1.2.3.4"), "public_key"),
    (("ssh-ed25519 AAAA\nssh-ed25519 BBBB", "jarvis", "/l", "1.2.3.4"), "public_key"),
    (("ssh-ed25519 AAAA ", "jarvis", "/l", "1.2.3.4"), "public_key"),
    (("ssh-rsa AAAA", "jarvis", "/l", "1.2.3.4"), "public_key"),
    (("ssh-ed25519 AAAA", "jar vis", "/l", "1.2.3.4"), "slug"),
    (("ssh-ed25519 AAAA", "jarvis", '/l" ssh-ed25519 BBBB', "1.2.3.4"), "launcher_path"),
    (("ssh-ed25519 AAAA", "jarvis", "/l\n", "1.2.3.4"), "launcher_path"),
    (("ssh-ed25519 AAAA", "jarvis", "/l", '1.2.3.4",command="x'), "authorized_from"),
    (("ssh-ed25519 AAAA", "jarvis", "/l", "10.0.0.0/8"), "authorized_from")])
def test_authorized_keys_line_rejects_option_injection(args, name):
    with pytest.raises(ValueError, match=f"^{name}$"):
        authorized_keys_line(*args)


# ---- key files -------------------------------------------------------------------------------

@pytest.fixture
def kf(tmp_path):
    k = KeyFiles(str(tmp_path))
    yield k
    k.cleanup()


def test_known_hosts_carries_slug_alias(kf):
    pem, _ = generate_keypair()
    keyfile, known_hosts = kf.paths("jarvis", pem, ED_KEY)
    assert Path(known_hosts).read_bytes() == f"jarvis {ED_KEY}\n".encode()
    assert Path(keyfile).read_bytes() == pem
    assert Path(keyfile).name == "jarvis.key" and Path(known_hosts).name == "jarvis.known_hosts"
    assert Path(keyfile).parent == Path(known_hosts).parent
    assert Path(keyfile).parent.name.startswith("mk1-acp-")


@pytest.mark.skipif(os.name != "posix", reason="POSIX file modes")
def test_keyfile_mode_0600(kf):
    pem, _ = generate_keypair()
    keyfile, known_hosts = kf.paths("jarvis", pem, ED_KEY)
    assert os.stat(keyfile).st_mode & 0o777 == 0o600
    assert os.stat(known_hosts).st_mode & 0o777 == 0o600
    assert os.stat(Path(keyfile).parent).st_mode & 0o777 == 0o700


def test_one_directory_for_all_providers(kf):
    pem, _ = generate_keypair()
    a = kf.paths("jarvis", pem, ED_KEY)
    b = kf.paths("nova", pem, ED_KEY)
    assert Path(a[0]).parent == Path(b[0]).parent and a[0] != b[0]


def test_rewrites_only_when_content_changed(kf, monkeypatch):
    pem, _ = generate_keypair()
    writes = []
    real = os.replace
    monkeypatch.setattr(os, "replace", lambda src, dst: (writes.append(os.path.basename(dst)), real(src, dst))[1])
    first = kf.paths("jarvis", pem, ED_KEY)
    assert sorted(writes) == ["jarvis.key", "jarvis.known_hosts"]
    writes.clear()
    assert kf.paths("jarvis", pem, ED_KEY) == first and writes == []
    other_pem, _ = generate_keypair()
    assert kf.paths("jarvis", other_pem, ED_KEY) == first
    assert writes == ["jarvis.key"] and Path(first[0]).read_bytes() == other_pem
    writes.clear()
    new_host_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOTHER"
    assert kf.paths("jarvis", other_pem, new_host_key) == first
    assert writes == ["jarvis.known_hosts"] and Path(first[1]).read_text() == f"jarvis {new_host_key}\n"


def test_recreates_a_file_removed_behind_its_back(kf):
    pem, _ = generate_keypair()
    keyfile, _ = kf.paths("jarvis", pem, ED_KEY)
    os.unlink(keyfile)
    assert Path(kf.paths("jarvis", pem, ED_KEY)[0]).read_bytes() == pem


def test_cleanup_removes_the_directory_and_paths_recreates_it(kf):
    pem, _ = generate_keypair()
    keyfile, known_hosts = kf.paths("jarvis", pem, ED_KEY)
    kf.cleanup()
    assert not Path(keyfile).parent.exists()
    kf.cleanup()  # idempotent
    again, _ = kf.paths("jarvis", pem, ED_KEY)
    assert Path(again).read_bytes() == pem


def test_paths_refuses_hostile_slug_and_host_key_and_writes_nothing(kf, tmp_path):
    pem, _ = generate_keypair()
    for slug in ("../evil", "a/b", "a b", "x\n"):
        with pytest.raises(ValueError, match="^slug$"):
            kf.paths(slug, pem, ED_KEY)
    for hk in (ED_KEY + "\nevil.example ssh-ed25519 AAAA", "@cert-authority * " + ED_KEY, ""):
        with pytest.raises(ValueError, match="^host_key$"):
            kf.paths("jarvis", pem, hk)
    for pem in (b"", "not bytes", None):
        with pytest.raises(ValueError, match="^private_key$"):
            kf.paths("jarvis", pem, ED_KEY)
    assert list(tmp_path.iterdir()) == []  # nothing, not even the directory, was created


def test_default_root_works_without_an_explicit_dir():
    # /dev/shm where it exists, else the tempfile default (this Windows box).
    k = KeyFiles()
    try:
        pem, _ = generate_keypair()
        keyfile, _ = k.paths("jarvis", pem, ED_KEY)
        assert Path(keyfile).parent.name.startswith("mk1-acp-") and Path(keyfile).read_bytes() == pem
    finally:
        k.cleanup()


def test_module_singleton():
    assert isinstance(KEYFILES, KeyFiles) and transport.KEYFILES is KEYFILES
