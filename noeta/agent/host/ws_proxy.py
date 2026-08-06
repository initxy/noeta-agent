"""A WebSocket reverse proxy: the smallest useful subset of RFC 6455.

Stdlib only, no third-party dependency, and **deliberately transparent**: it
forwards `(fin, opcode, payload)` verbatim in both directions and understands
nothing about what rides on top. No `permessage-deflate`, no UTF-8 validation,
control frames passed through unchanged. Full compliance would invite more bugs
than it fixes — the two clients on the other end are noVNC and xterm.js, and
what they need is a pipe that does not corrupt or reorder.

Three rules here are load-bearing rather than stylistic:

- **Dial the upstream leg BEFORE sending the 101.** An unreachable container
  has to surface to the browser as a real HTTP error. A 101 followed by an
  abrupt TCP close gives noVNC and xterm.js no close frame and no status, so
  they cannot tell "the sandbox is gone" from "the network blipped". After a
  successful handshake the caller must write **no further HTTP response**.
- **Bound the declared payload length before allocating.** A full-frame raw VNC
  update at 1920x1080x4 is about 8 MiB, so the 64 MiB cap is generous; without
  it a corrupt or malicious 64-bit length grows host memory until the process
  falls over.
- **`SO_SNDTIMEO` on the send side only.** The read side stays fully blocking,
  because an idle-but-healthy panel — a VNC session nobody is touching —
  legitimately goes minutes between frames, and a read timeout would tear down
  a working connection.

Masking is not optional either: RFC 6455 section 5.3 requires client-to-server
frames to be masked, so the upstream leg (browser to container) writes masked
and the downstream leg (container to browser) writes unmasked.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import os
import socket
import struct
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import BinaryIO, Optional
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

__all__ = [
    "MAX_PAYLOAD_BYTES",
    "UpstreamUnreachable",
    "WebSocketProtocolError",
    "accept_key",
    "encode_frame",
    "handshake_response",
    "negotiated_subprotocol",
    "open_upstream",
    "proxy",
]

#: RFC 6455 section 1.3. Concatenated with the client key and SHA-1'd to prove
#: the server understood the upgrade rather than echoing an arbitrary header.
_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

#: Ceiling on one frame's declared payload, checked *before* the read.
MAX_PAYLOAD_BYTES = 64 * 1024 * 1024

#: Send-side timeout. Never applied to the read side — see the module docstring.
SEND_TIMEOUT_S = 30.0

#: How long the upstream TCP connect and handshake may take.
DIAL_TIMEOUT_S = 30.0

#: TCP keepalive: start after 60s idle, probe every 10s, give up after 3.
#: Reaps a peer that vanished without a FIN, which is what a `docker kill`
#: looks like from this side.
_KEEPALIVE_IDLE_S = 60
_KEEPALIVE_INTERVAL_S = 10
_KEEPALIVE_COUNT = 3

_OPCODE_CLOSE = 0x8


class WebSocketProtocolError(Exception):
    """A frame or handshake this proxy refuses to forward."""


class UpstreamUnreachable(Exception):
    """The container leg could not be established. Surfaces as a 502."""


@dataclass(frozen=True)
class Frame:
    """One WebSocket frame, already unmasked. Forwarded verbatim."""

    fin: bool
    opcode: int
    payload: bytes


def accept_key(key: str) -> str:
    """`Sec-WebSocket-Accept` for a client's `Sec-WebSocket-Key`."""
    digest = hashlib.sha1((key.strip() + _WS_GUID).encode("ascii")).digest()  # noqa: S324
    return base64.b64encode(digest).decode("ascii")


def negotiated_subprotocol(requested: Optional[str]) -> Optional[str]:
    """The subprotocol to agree on: the first the client offered, or none.

    We support them all — the proxy is transparent — so "first in the client's
    list" is the whole algorithm. It is computed **before** the upstream dial so
    both legs are told the same answer; deriving it separately per leg is how
    the two ends end up disagreeing about framing."""
    if not requested:
        return None
    for candidate in requested.split(","):
        cleaned = candidate.strip()
        if cleaned:
            return cleaned
    return None


def handshake_response(key: str, subprotocol: Optional[str] = None) -> bytes:
    """The 101, built by hand.

    Not via a framework's `send_response`: that adds `Content-Length: 0`, and a
    101 carrying a content length makes browsers treat the upgrade as a
    malformed response rather than a switch."""
    lines = [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        f"Sec-WebSocket-Accept: {accept_key(key)}",
    ]
    if subprotocol:
        lines.append(f"Sec-WebSocket-Protocol: {subprotocol}")
    return ("\r\n".join(lines) + "\r\n\r\n").encode("ascii")


# ---------------------------------------------------------------------------
# Framing
# ---------------------------------------------------------------------------


def encode_frame(frame: Frame, *, mask: bool) -> bytes:
    """Serialize one frame. `mask=True` for the browser-to-container leg."""
    length = len(frame.payload)
    header = bytearray()
    header.append((0x80 if frame.fin else 0x00) | (frame.opcode & 0x0F))
    mask_bit = 0x80 if mask else 0x00
    if length < 126:
        header.append(mask_bit | length)
    elif length < (1 << 16):
        header.append(mask_bit | 126)
        header += struct.pack("!H", length)
    else:
        header.append(mask_bit | 127)
        header += struct.pack("!Q", length)
    if not mask:
        return bytes(header) + frame.payload
    key = os.urandom(4)
    masked = bytes(byte ^ key[index % 4] for index, byte in enumerate(frame.payload))
    return bytes(header) + key + masked


class FrameReader:
    """Reads frames off a blocking byte stream.

    Takes a file object rather than a socket so the downstream leg can keep
    reading through the HTTP server's own buffered reader: bytes the server
    already pulled past the request headers must not be stranded in that
    buffer, which is exactly what reading the raw socket instead would do.
    """

    def __init__(self, stream: BinaryIO) -> None:
        self._stream = stream

    def _exactly(self, count: int) -> Optional[bytes]:
        if count == 0:
            return b""
        data = self._stream.read(count)
        # A short read means the peer closed mid-frame. Treated as end of
        # stream: there is nothing partial worth forwarding.
        if not data or len(data) < count:
            return None
        return data

    def read(self) -> Optional[Frame]:
        """The next frame, or `None` at end of stream."""
        head = self._exactly(2)
        if head is None:
            return None
        fin = bool(head[0] & 0x80)
        opcode = head[0] & 0x0F
        masked = bool(head[1] & 0x80)
        length = head[1] & 0x7F
        if length == 126:
            extended = self._exactly(2)
            if extended is None:
                return None
            length = struct.unpack("!H", extended)[0]
        elif length == 127:
            extended = self._exactly(8)
            if extended is None:
                return None
            length = struct.unpack("!Q", extended)[0]
        # Checked BEFORE the read that would allocate it.
        if length > MAX_PAYLOAD_BYTES:
            raise WebSocketProtocolError(
                f"frame payload of {length} bytes exceeds the "
                f"{MAX_PAYLOAD_BYTES} byte cap"
            )
        key = b""
        if masked:
            read_key = self._exactly(4)
            if read_key is None:
                return None
            key = read_key
        payload = self._exactly(length) if length else b""
        if payload is None:
            return None
        if masked:
            payload = bytes(byte ^ key[index % 4] for index, byte in enumerate(payload))
        return Frame(fin=fin, opcode=opcode, payload=payload)


# ---------------------------------------------------------------------------
# Sockets
# ---------------------------------------------------------------------------


def tune(sock: socket.socket) -> None:
    """Send timeout and TCP keepalive, every option best-effort.

    Test doubles are `AF_UNIX` socket pairs where the TCP options do not exist,
    and `SO_SNDTIMEO` takes a `struct timeval` on POSIX but a DWORD on Windows —
    so each option is applied on its own and a failure is ignored rather than
    taking the connection down with it."""
    try:
        sock.setsockopt(
            socket.SOL_SOCKET,
            socket.SO_SNDTIMEO,
            struct.pack("ll", int(SEND_TIMEOUT_S), 0),
        )
    except (OSError, AttributeError, struct.error):
        pass
    for level, option, value in (
        (socket.SOL_SOCKET, "SO_KEEPALIVE", 1),
        (getattr(socket, "IPPROTO_TCP", 6), "TCP_KEEPIDLE", _KEEPALIVE_IDLE_S),
        (getattr(socket, "IPPROTO_TCP", 6), "TCP_KEEPINTVL", _KEEPALIVE_INTERVAL_S),
        (getattr(socket, "IPPROTO_TCP", 6), "TCP_KEEPCNT", _KEEPALIVE_COUNT),
    ):
        name = getattr(socket, option, None)
        if name is None:
            continue
        try:
            sock.setsockopt(level, name, value)
        except OSError:
            pass


def _shutdown(sock: Optional[socket.socket]) -> None:
    """Best-effort `shutdown` — what unblocks the sibling pump thread.

    Closing alone is not enough: the other thread is parked in a blocking read
    on its own file object, and only a shutdown makes that read return."""
    if sock is None:
        return
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass


@dataclass
class Upstream:
    """The container leg: its socket and a reader positioned at the first frame."""

    sock: socket.socket
    reader: FrameReader
    stream: BinaryIO
    subprotocol: Optional[str]


def open_upstream(
    url: str,
    *,
    headers: Mapping[str, str] = {},
    subprotocol: Optional[str] = None,
    timeout: float = DIAL_TIMEOUT_S,
) -> Upstream:
    """Dial the container and complete the WebSocket handshake against it.

    Raises `UpstreamUnreachable` for anything that stops the leg coming up —
    DNS, connect, a non-101 answer, a truncated response. The caller turns that
    into a 502, which is the entire reason this runs before the downstream 101.

    `url` carries the **raw request target with its query intact**: the
    terminal's PTY WebSocket is addressed with `?session_id=...` and dropping it
    silently attaches to the wrong shell.
    """
    parts = urlsplit(url)
    if parts.scheme not in ("http", "ws"):
        # The container is always reached over loopback http. A TLS leg would
        # need its own certificate story, and inventing one for a socket that
        # never leaves the host is complexity with no security to show for it.
        raise UpstreamUnreachable(f"unsupported upstream scheme: {parts.scheme!r}")
    host = parts.hostname or "127.0.0.1"
    port = parts.port or 80
    target = parts.path or "/"
    if parts.query:
        target = f"{target}?{parts.query}"

    key = base64.b64encode(os.urandom(16)).decode("ascii")
    request = [
        f"GET {target} HTTP/1.1",
        f"Host: {parts.netloc}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        f"Sec-WebSocket-Key: {key}",
        "Sec-WebSocket-Version: 13",
    ]
    if subprotocol:
        request.append(f"Sec-WebSocket-Protocol: {subprotocol}")
    for name, value in headers.items():
        request.append(f"{name}: {value}")

    sock: Optional[socket.socket] = None
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
        sock.sendall(("\r\n".join(request) + "\r\n\r\n").encode("latin-1"))
        stream = sock.makefile("rb")
        status = stream.readline()
        if not status.startswith(b"HTTP/1.1 101") and not status.startswith(
            b"HTTP/1.0 101"
        ):
            raise UpstreamUnreachable(
                f"upstream refused the upgrade: {status.decode('latin-1').strip()!r}"
            )
        while True:
            line = stream.readline()
            if line in (b"\r\n", b"\n", b""):
                break
    except UpstreamUnreachable:
        _shutdown(sock)
        if sock is not None:
            sock.close()
        raise
    except OSError as exc:
        _shutdown(sock)
        if sock is not None:
            sock.close()
        raise UpstreamUnreachable(f"cannot reach the sandbox: {exc}") from exc

    # Cleared only now: the read side must be fully blocking once frames flow.
    sock.settimeout(None)
    tune(sock)
    return Upstream(
        sock=sock, reader=FrameReader(stream), stream=stream, subprotocol=subprotocol
    )


# ---------------------------------------------------------------------------
# The pump
# ---------------------------------------------------------------------------


def _pump(reader: FrameReader, dest: socket.socket, *, mask: bool) -> None:
    """Forward frames until either end closes. Never raises to the caller."""
    while True:
        try:
            frame = reader.read()
        except (OSError, WebSocketProtocolError, ValueError) as exc:
            logger.debug("preview websocket read ended: %s", exc)
            return
        if frame is None:
            return
        try:
            dest.sendall(encode_frame(frame, mask=mask))
        except OSError as exc:
            logger.debug("preview websocket write ended: %s", exc)
            return
        # A close frame is forwarded, then both legs come down. Forwarding it
        # first is what lets the peer report *why* rather than seeing a reset.
        if frame.opcode == _OPCODE_CLOSE:
            return


def proxy(
    *,
    client_sock: socket.socket,
    client_stream: BinaryIO,
    client_key: str,
    upstream: Upstream,
    write: Callable[[bytes], object],
) -> None:
    """Complete the downstream handshake and pump both directions.

    `upstream` is already connected — that ordering is the point. `write` sends
    the raw 101 (the caller owns the socket's writer), and after it returns the
    caller must write no further HTTP response.

    The browser-to-container direction runs on a daemon thread and the
    container-to-browser direction runs inline, so this call owns the handler
    thread for exactly as long as the socket lives. That is the correct
    ownership model for a `ThreadingHTTPServer`: the thread *is* the connection.
    """
    tune(client_sock)
    write(handshake_response(client_key, upstream.subprotocol))

    downstream = FrameReader(client_stream)
    to_container = threading.Thread(
        target=_pump,
        args=(downstream, upstream.sock),
        kwargs={"mask": True},
        name="preview-ws-up",
        daemon=True,
    )
    to_container.start()
    try:
        _pump(upstream.reader, client_sock, mask=False)
    finally:
        _shutdown(upstream.sock)
        _shutdown(client_sock)
        to_container.join(timeout=1.0)
        try:
            upstream.stream.close()
        except OSError:
            pass
        try:
            upstream.sock.close()
        except OSError:
            pass
