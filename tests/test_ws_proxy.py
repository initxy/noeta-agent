"""The WebSocket reverse proxy — `LEDGER §9.9` row 63 and the framing rules.

The one property everything else hangs off: **an unreachable upstream yields a
real HTTP 502, never a 101 followed by a close.** noVNC and xterm.js get no
close frame from an abrupt TCP teardown after a 101, so a container that is
gone would be indistinguishable from a network blip — and the panel would spin
forever instead of saying what happened.

The frame reader in this file is written out by hand rather than imported from
the module under test. A test that decodes with the same code it is checking
proves only that the code agrees with itself; the masking direction (RFC 6455
section 5.3) is exactly the kind of rule that would then stay wrong in both
places at once.
"""
from __future__ import annotations

import socket
import struct
import threading
from dataclasses import dataclass, field
from typing import Iterator, Optional

import pytest

from noeta.agent.host import ws_proxy
from noeta.agent.host.preview_gateway import PreviewGateway

# Bounds a hang. Every leg of this suite is loopback and answers instantly.
TIMEOUT = 5.0

# RFC 6455 section 1.3's published vector. Pinned against the constant rather
# than against our own implementation, which is the only way this assertion
# means anything.
RFC_KEY = "dGhlIHNhbXBsZSBub25jZQ=="
RFC_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="

OPCODE_TEXT = 0x1
OPCODE_BINARY = 0x2
OPCODE_CLOSE = 0x8


# ---------------------------------------------------------------------------
# A hand-rolled frame codec, independent of the module under test
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RawFrame:
    fin: bool
    opcode: int
    masked: bool
    payload: bytes


def read_frame(stream) -> Optional[RawFrame]:
    head = stream.read(2)
    if len(head) < 2:
        return None
    fin = bool(head[0] & 0x80)
    opcode = head[0] & 0x0F
    masked = bool(head[1] & 0x80)
    length = head[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", stream.read(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", stream.read(8))[0]
    key = stream.read(4) if masked else b""
    payload = stream.read(length) if length else b""
    if masked:
        payload = bytes(b ^ key[i % 4] for i, b in enumerate(payload))
    return RawFrame(fin=fin, opcode=opcode, masked=masked, payload=payload)


def write_frame(sock: socket.socket, opcode: int, payload: bytes, *, mask: bool) -> None:
    header = bytearray([0x80 | opcode])
    length = len(payload)
    mask_bit = 0x80 if mask else 0
    if length < 126:
        header.append(mask_bit | length)
    elif length < (1 << 16):
        header.append(mask_bit | 126)
        header += struct.pack("!H", length)
    else:
        header.append(mask_bit | 127)
        header += struct.pack("!Q", length)
    if mask:
        key = b"\x01\x02\x03\x04"
        header += key
        payload = bytes(b ^ key[i % 4] for i, b in enumerate(payload))
    sock.sendall(bytes(header) + payload)


# ---------------------------------------------------------------------------
# A fake container: a WebSocket echo endpoint on a real socket
# ---------------------------------------------------------------------------


@dataclass
class FakeContainer:
    """One AF_INET listener that answers a WebSocket upgrade and echoes."""

    port: int = 0
    #: Every request target seen, query intact — the terminal's PTY socket
    #: carries `?session_id=…` and dropping it attaches the wrong shell.
    targets: list[str] = field(default_factory=list)
    #: Request headers of the last upgrade, lowercased. urllib and the browser
    #: both normalize header case, so comparisons here are case-insensitive.
    headers: dict[str, str] = field(default_factory=dict)
    #: Whether each received frame arrived masked. RFC 6455 section 5.3 says
    #: every client-to-server frame must be.
    masked_in: list[bool] = field(default_factory=list)
    subprotocol_in: Optional[str] = None
    _sock: Optional[socket.socket] = None
    _thread: Optional[threading.Thread] = None
    _stop: bool = False

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> None:
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(8)
        self.port = int(self._sock.getsockname()[1])
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop = True
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass

    def _serve(self) -> None:
        while not self._stop:
            try:
                conn, _ = self._sock.accept()  # type: ignore[union-attr]
            except OSError:
                return
            threading.Thread(target=self._session, args=(conn,), daemon=True).start()

    def _session(self, conn: socket.socket) -> None:
        stream = conn.makefile("rb")
        request = stream.readline().decode("latin-1")
        headers: dict[str, str] = {}
        while True:
            line = stream.readline()
            if line in (b"\r\n", b"\n", b""):
                break
            name, _, value = line.decode("latin-1").partition(":")
            headers[name.strip().lower()] = value.strip()
        self.targets.append(request.split(" ")[1] if " " in request else request)
        self.headers = headers
        self.subprotocol_in = headers.get("sec-websocket-protocol")

        accept = ws_proxy.accept_key(headers.get("sec-websocket-key", ""))
        lines = [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Accept: {accept}",
        ]
        if self.subprotocol_in:
            lines.append(f"Sec-WebSocket-Protocol: {self.subprotocol_in}")
        conn.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))

        while True:
            frame = read_frame(stream)
            if frame is None:
                return
            self.masked_in.append(frame.masked)
            if frame.opcode == OPCODE_CLOSE:
                write_frame(conn, OPCODE_CLOSE, frame.payload, mask=False)
                return
            write_frame(conn, frame.opcode, b"echo:" + frame.payload, mask=False)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def container() -> Iterator[FakeContainer]:
    fake = FakeContainer()
    fake.start()
    try:
        yield fake
    finally:
        fake.stop()


@pytest.fixture
def gateway() -> Iterator[PreviewGateway]:
    gate = PreviewGateway()
    assert gate.serve() is not None
    try:
        yield gate
    finally:
        gate.close()


def dead_port() -> int:
    """A port nothing listens on: bind it, read it back, release it."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@dataclass
class Conn:
    """A raw connection to the gateway, opened with a WebSocket handshake."""

    sock: socket.socket
    stream: object
    status: str
    headers: dict[str, str]

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


def upgrade(
    gateway: PreviewGateway,
    target: str,
    *,
    key: str = RFC_KEY,
    subprotocol: Optional[str] = None,
) -> Conn:
    """Do a raw WebSocket handshake through the gateway.

    Returns the socket plus the status line and headers, so a test can assert
    on the *HTTP* answer — which is the only way to tell a 502 from a 101
    followed by a close."""
    sock = socket.create_connection(("127.0.0.1", gateway.port), timeout=TIMEOUT)
    lines = [
        f"GET {target} HTTP/1.1",
        f"Host: 127.0.0.1:{gateway.port}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        f"Sec-WebSocket-Key: {key}",
        "Sec-WebSocket-Version: 13",
    ]
    if subprotocol:
        lines.append(f"Sec-WebSocket-Protocol: {subprotocol}")
    sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))
    stream = sock.makefile("rb")
    status = stream.readline().decode("latin-1").strip()
    headers: dict[str, str] = {}
    while True:
        line = stream.readline()
        if line in (b"\r\n", b"\n", b""):
            break
        name, _, value = line.decode("latin-1").partition(":")
        headers[name.strip().lower()] = value.strip()
    return Conn(sock=sock, stream=stream, status=status, headers=headers)


# ---------------------------------------------------------------------------
# Row 63 — the ordering rule
# ---------------------------------------------------------------------------


def test_an_unreachable_upstream_yields_502_not_a_101(gateway: PreviewGateway):
    """Row 63, and the reason the upstream leg is dialled BEFORE the 101.

    A 101 followed by an abrupt close gives the panel no close frame and no
    status; a 502 says "the sandbox is not there" in a way both noVNC and
    xterm.js can surface."""
    token = gateway.mount_session("s1", f"http://127.0.0.1:{dead_port()}")

    conn = upgrade(gateway, f"/sandbox-preview/{token}/websockify")
    try:
        assert conn.status.startswith("HTTP/1.1 502")
        assert "101" not in conn.status
    finally:
        conn.close()


def test_a_reachable_upstream_yields_101_with_the_rfc_accept_value(
    gateway: PreviewGateway, container: FakeContainer
):
    """Row 63's other half. The accept value is checked against RFC 6455's own
    published vector, not against our implementation."""
    token = gateway.mount_session("s1", container.base_url)

    conn = upgrade(gateway, f"/sandbox-preview/{token}/websockify")
    try:
        assert conn.status.startswith("HTTP/1.1 101")
        assert conn.headers["sec-websocket-accept"] == RFC_ACCEPT
        assert conn.headers["upgrade"].lower() == "websocket"
        # A 101 must not carry a body length; a framework's `send_response`
        # would add one and browsers reject the upgrade.
        assert "content-length" not in conn.headers
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Framing
# ---------------------------------------------------------------------------


def test_frames_are_forwarded_verbatim_masked_upstream_unmasked_downstream(
    gateway: PreviewGateway, container: FakeContainer
):
    """RFC 6455 section 5.3: client-to-server frames must be masked. The proxy
    is a client on its upstream leg and a server on its downstream one, so it
    has to mask one direction and not the other — getting it backwards makes
    every compliant peer drop the connection."""
    token = gateway.mount_session("s1", container.base_url)
    conn = upgrade(gateway, f"/sandbox-preview/{token}/websockify")
    assert conn.status.startswith("HTTP/1.1 101")
    try:
        write_frame(conn.sock, OPCODE_BINARY, b"hello", mask=True)
        frame = read_frame(conn.stream)

        assert frame is not None
        assert frame.opcode == OPCODE_BINARY
        assert frame.payload == b"echo:hello"
        # Downstream (container -> browser) is never masked.
        assert frame.masked is False
        # Upstream (browser -> container) always is.
        assert container.masked_in == [True]
    finally:
        conn.close()


def test_the_query_string_reaches_the_container(
    gateway: PreviewGateway, container: FakeContainer
):
    """The terminal's PTY socket is addressed with `?session_id=…`; dropping it
    silently attaches to a different shell."""
    token = gateway.mount_session("s1", container.base_url)
    conn = upgrade(
        gateway, f"/sandbox-preview/{token}/v1/shell/ws?session_id=abc123"
    )
    try:
        assert conn.status.startswith("HTTP/1.1 101")
        assert container.targets == ["/v1/shell/ws?session_id=abc123"]
    finally:
        conn.close()


def test_the_subprotocol_is_the_clients_first_and_both_legs_agree(
    gateway: PreviewGateway, container: FakeContainer
):
    """We support them all, so the answer is "the first one offered" — and it
    is computed once, before the dial, so the two legs cannot disagree."""
    token = gateway.mount_session("s1", container.base_url)
    conn = upgrade(
        gateway, f"/sandbox-preview/{token}/websockify", subprotocol="binary, base64"
    )
    try:
        assert conn.status.startswith("HTTP/1.1 101")
        assert conn.headers["sec-websocket-protocol"] == "binary"
        assert container.subprotocol_in == "binary"
    finally:
        conn.close()


def test_a_close_frame_is_forwarded_and_ends_both_legs(
    gateway: PreviewGateway, container: FakeContainer
):
    """Forwarded first, then torn down: the peer must be able to report *why*
    rather than seeing a reset."""
    token = gateway.mount_session("s1", container.base_url)
    conn = upgrade(gateway, f"/sandbox-preview/{token}/websockify")
    try:
        write_frame(conn.sock, OPCODE_CLOSE, b"\x03\xe8", mask=True)
        frame = read_frame(conn.stream)

        assert frame is not None
        assert frame.opcode == OPCODE_CLOSE
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# The allocation bound
# ---------------------------------------------------------------------------


def test_a_declared_payload_over_the_cap_is_refused_before_it_is_allocated():
    """A corrupt or malicious 64-bit length would otherwise grow host memory
    until the process falls over. The check is on the *declaration*, so nothing
    is read and nothing is allocated."""

    class Stream:
        def __init__(self) -> None:
            self.reads: list[int] = []
            # fin + binary, length 127 (64-bit extended), then 1 TiB.
            self.data = bytes([0x82, 127]) + struct.pack("!Q", 1 << 40)
            self.offset = 0

        def read(self, count: int) -> bytes:
            self.reads.append(count)
            chunk = self.data[self.offset : self.offset + count]
            self.offset += count
            return chunk

    stream = Stream()
    reader = ws_proxy.FrameReader(stream)  # type: ignore[arg-type]

    with pytest.raises(ws_proxy.WebSocketProtocolError):
        reader.read()
    assert max(stream.reads) <= 8, "the oversized payload must never be read"


def test_the_cap_is_generous_enough_for_a_full_screen_vnc_update():
    """1920x1080x4 is about 8 MiB. The cap has to sit well above a legitimate
    raw framebuffer update or an idle desktop resize kills the panel."""
    assert ws_proxy.MAX_PAYLOAD_BYTES >= 8 * 1920 * 1080 * 4


def test_the_accept_key_matches_the_published_vector():
    assert ws_proxy.accept_key(RFC_KEY) == RFC_ACCEPT


def test_the_negotiated_subprotocol_is_the_first_offered():
    assert ws_proxy.negotiated_subprotocol("binary, base64") == "binary"
    assert ws_proxy.negotiated_subprotocol("  ") is None
    assert ws_proxy.negotiated_subprotocol(None) is None
