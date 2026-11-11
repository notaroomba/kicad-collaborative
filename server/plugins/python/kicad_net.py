"""kicad_net.py — the network, for plugins that were given it.

A plugin in the web editor runs in a sandboxed frame that cannot open connections.  What the
person may grant an official KiCad plugin instead is "network": HTTP requests carried by the
editor's server to the web addresses that plugin names in its own code, and nowhere else.

Plugins reach the network in many ways (urllib, http.client, requests, a urllib3 they bring
themselves), and all of those end in the same place: a socket they write an HTTP request into
and read the answer from.  So that is the one thing replaced here.  A socket a plugin opens is
a buffer; when the plugin starts reading, the request it wrote is parsed, sent through the
editor (`net.fetch`), and the answer is laid out as the bytes a server would have sent.
"""

import base64
import errno
import io
import json
import socket
import ssl

_fetch = None            # callable(dict) -> dict, set by install()
_real = {}


class _Raw(io.RawIOBase):
    def __init__(self, sock):
        self._sock = sock

    def readable(self):
        return True

    def readinto(self, b):
        data = self._sock.recv(len(b))
        b[:len(data)] = data
        return len(data)


class _Writer(io.RawIOBase):
    def __init__(self, sock):
        self._sock = sock

    def writable(self):
        return True

    def write(self, b):
        self._sock.sendall(bytes(b))
        return len(b)


class WebSocketStandIn:
    """What `socket.socket()` returns: one HTTP exchange at a time, carried by the editor."""

    def __init__(self, family=socket.AF_INET, type=socket.SOCK_STREAM, proto=0, fileno=None):
        self.family, self.type, self.proto = family, type, proto
        self._host, self._port, self._tls = None, 0, False
        self._out = bytearray()
        self._in = None
        self._closed = False
        self._timeout = None
        self.context = None
        self.server_hostname = None

    # ---- connecting

    def connect(self, address):
        if _fetch is None:
            raise OSError(errno.ENETUNREACH, "this plugin has no network access in the web editor")
        if not isinstance(address, (tuple, list)) or len(address) < 2:
            raise OSError(errno.EAFNOSUPPORT, "only connections to a web server are possible in the web editor")
        self._host, self._port = str(address[0]), int(address[1])

    def connect_ex(self, address):
        try:
            self.connect(address)
            return 0
        except OSError as e:
            return e.errno or errno.ECONNREFUSED

    def bind(self, address):
        pass

    def listen(self, *a):
        pass

    def accept(self):
        raise OSError(95, "listening for connections is not possible in the browser")

    def settimeout(self, t):
        self._timeout = t

    def gettimeout(self):
        return self._timeout

    def setblocking(self, flag):
        pass

    def getblocking(self):
        return True

    def setsockopt(self, *a):
        pass

    def getsockopt(self, *a):
        return 0

    def shutdown(self, how):
        pass

    def fileno(self):
        return -1

    def getpeername(self):
        return (self._host or "0.0.0.0", self._port)

    def getsockname(self):
        return ("127.0.0.1", 0)

    def detach(self):
        return -1

    def close(self):
        self._closed = True

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()
        return False

    # ---- TLS, as far as a caller can tell

    def getpeercert(self, binary_form=False):
        if binary_form:
            return b""
        host = self.server_hostname or self._host or ""
        return {"subject": ((("commonName", host),),), "subjectAltName": (("DNS", host),)}

    def cipher(self):
        return ("TLS_AES_256_GCM_SHA384", "TLSv1.3", 256)

    def version(self):
        return "TLSv1.3" if self._tls else None

    def selected_alpn_protocol(self):
        return None

    def selected_npn_protocol(self):
        return None

    def do_handshake(self, *a):
        pass

    def pending(self):
        return 0

    def unwrap(self):
        return self

    def compression(self):
        return None

    # ---- the exchange

    def sendall(self, data, *a):
        if self._host is None:
            raise OSError(errno.ENOTCONN, "the socket is not connected")
        if self._in is not None:            # the previous answer was read: this is the next request on the connection
            self._in = None
            self._out = bytearray()
        self._out += bytes(data)

    def send(self, data, *a):
        self.sendall(data)
        return len(data)

    def sendfile(self, file, offset=0, count=None):
        data = file.read() if count is None else file.read(count)
        self.sendall(data)
        return len(data)

    def recv(self, n=65536, *a):
        if self._in is None:
            self._in = io.BytesIO(self._exchange())
        return self._in.read(n)

    def recv_into(self, buf, nbytes=0, *a):
        data = self.recv(nbytes or len(buf))
        buf[:len(data)] = data
        return len(data)

    read = recv

    def write(self, data):
        return self.send(data)

    def makefile(self, mode="r", buffering=None, *, encoding=None, errors=None, newline=None):
        binary = "b" in mode
        if "w" in mode or "a" in mode:
            f = io.BufferedWriter(_Writer(self), 1)
        else:
            f = io.BufferedReader(_Raw(self))
        return f if binary else io.TextIOWrapper(f, encoding=encoding or "utf-8", errors=errors, newline=newline)

    def _exchange(self):
        """Parse the request written so far, have the editor send it, and return the raw answer."""
        raw = bytes(self._out)
        head, sep, rest = raw.partition(b"\r\n\r\n")
        lines = head.decode("iso-8859-1").split("\r\n")
        parts = lines[0].split(" ")
        if not sep or len(parts) < 2:
            raise OSError(errno.EPROTO, "only HTTP can be spoken over a connection in the web editor")
        method, target = parts[0].upper(), parts[1]
        headers = []
        for line in lines[1:]:
            name, colon, value = line.partition(":")
            if colon:
                headers.append((name.strip(), value.strip()))
        low = {k.lower(): v for k, v in headers}
        body = rest
        if "chunked" in low.get("transfer-encoding", "").lower():
            body, pos = bytearray(), 0
            while pos < len(rest):
                end = rest.find(b"\r\n", pos)
                if end < 0:
                    break
                size = int(rest[pos:end].split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    break
                body += rest[end + 2:end + 2 + size]
                pos = end + 2 + size + 2
            body = bytes(body)
        elif "content-length" in low:
            body = rest[:int(low["content-length"] or 0)]
        tls = self._tls or self._port == 443
        if target.startswith(("http://", "https://")):
            url = target
        else:
            host = low.get("host") or (self._host if self._port in (80, 443) else f"{self._host}:{self._port}")
            url = ("https://" if tls else "http://") + host + (target if target.startswith("/") else "/" + target)
        send = [(k, v) for k, v in headers if k.lower() not in ("host", "content-length", "transfer-encoding", "connection", "accept-encoding", "expect", "te", "upgrade")]
        try:
            out = _fetch({"url": url, "method": method, "headers": send, "body": base64.b64encode(body).decode("ascii"), "timeout": self._timeout})
        except OSError:
            raise
        except Exception as e:
            raise OSError(errno.ECONNREFUSED, str(e)) from None
        if not isinstance(out, dict) or out.get("error") or "status" not in out:
            raise OSError(errno.ECONNREFUSED, str((out or {}).get("error") or "the request could not be sent") if isinstance(out, dict) else "the request could not be sent")
        data = base64.b64decode(out.get("body") or "")
        status = int(out["status"])
        reason = str(out.get("reason") or "").replace("\r", " ").replace("\n", " ")
        answer = [f"HTTP/1.1 {status} {reason}".rstrip()]
        length = None
        for k, v in out.get("headers") or []:
            lk = str(k).lower()
            if lk == "content-length":
                length = str(v)
            if lk in ("content-length", "transfer-encoding", "connection", "keep-alive"):
                continue
            answer.append(f"{k}: {v}".replace("\r", " ").replace("\n", " "))
        no_body = method == "HEAD" or status in (204, 304) or 100 <= status < 200
        answer.append(f"Content-Length: {length if (no_body and length is not None) else len(data)}")
        answer.append("Connection: close")
        return ("\r\n".join(answer) + "\r\n\r\n").encode("iso-8859-1", "replace") + (b"" if no_body else data)


def _wrap_socket(self, sock, server_side=False, do_handshake_on_connect=True, suppress_ragged_eofs=True, server_hostname=None, session=None):
    if not isinstance(sock, WebSocketStandIn):
        raise OSError(errno.EPROTO, "TLS over a real socket is not possible in the browser")
    sock._tls = True
    sock.context = self
    sock.server_hostname = server_hostname
    return sock


def _getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    # Names are resolved by the server that carries the request, so the name itself stands in for the address.
    if isinstance(port, str):
        port = {"http": 80, "https": 443}.get(port, int(port) if port.isdigit() else 0)
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (str(host), int(port or 0)))]


def _create_connection(address, timeout=None, source_address=None, **kw):
    s = WebSocketStandIn()
    if timeout is not None and not isinstance(timeout, object().__class__):
        try:
            s.settimeout(float(timeout))
        except (TypeError, ValueError):
            pass
    s.connect(address)
    return s


def install(fetch):
    """Replace the socket layer.  `fetch` sends one request through the editor, or is None when there is no editor."""
    global _fetch
    _fetch = fetch
    if _real:
        return
    _real.update(socket=socket.socket, getaddrinfo=socket.getaddrinfo, create_connection=socket.create_connection)
    if not hasattr(socket, "AF_UNIX"):       # plugins name it when they look for KiCad's socket; nothing here listens on one
        socket.AF_UNIX = 1
    WebSocketStandIn.__name__ = "socket"
    socket.socket = WebSocketStandIn
    socket.SocketType = WebSocketStandIn
    socket.getaddrinfo = _getaddrinfo
    socket.create_connection = _create_connection
    socket.gethostbyname = lambda host: str(host)
    socket.gethostbyname_ex = lambda host: (str(host), [], [str(host)])
    socket.getfqdn = lambda name="": str(name or "localhost")
    ssl.SSLContext.wrap_socket = _wrap_socket
    ssl.SSLSocket = WebSocketStandIn
    # the pieces of an SSL context a client sets before it connects; they have no effect here (the server's TLS is used)
    for name, value in (("check_hostname", True), ("verify_mode", getattr(ssl, "CERT_REQUIRED", 2)), ("options", 0), ("verify_flags", 0),
                        ("post_handshake_auth", False), ("keylog_filename", None), ("hostname_checks_common_name", False),
                        ("minimum_version", getattr(getattr(ssl, "TLSVersion", None), "TLSv1_2", 771)), ("maximum_version", getattr(getattr(ssl, "TLSVersion", None), "MAXIMUM_SUPPORTED", -1)),
                        ("protocol", getattr(ssl, "PROTOCOL_TLS_CLIENT", 16)), ("security_level", 2)):
        if not hasattr(ssl.SSLContext, name):
            setattr(ssl.SSLContext, name, value)
    for name in ("load_verify_locations", "load_default_certs", "set_default_verify_paths", "set_ciphers", "set_alpn_protocols", "load_cert_chain",
                 "set_npn_protocols", "set_ecdh_curve", "load_dh_params", "set_servername_callback"):
        if not hasattr(ssl.SSLContext, name):
            setattr(ssl.SSLContext, name, lambda self, *a, **k: None)
    if not hasattr(ssl.SSLContext, "cert_store_stats"):
        ssl.SSLContext.cert_store_stats = lambda self: {"x509": 1, "crl": 0, "x509_ca": 1}
    if not hasattr(ssl.SSLContext, "get_ca_certs"):
        ssl.SSLContext.get_ca_certs = lambda self, binary_form=False: []
