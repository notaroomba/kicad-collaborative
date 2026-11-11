"""pynng for the web editor: the socket KiCad's IPC client (kipy) talks through.

On the desktop a plugin for KiCad's IPC interface is its own process and reaches KiCad over a
socket.  Here the plugin runs inside the editor's plugin sandbox, so the "socket" is a function
call: every request kipy sends is answered by kicad_ipc, which reads and edits the same board
the pcbnew module does.
"""


class NNGException(Exception):
    pass


class Timeout(NNGException):
    pass


class ConnectionRefused(NNGException):
    pass


class Closed(NNGException):
    pass


class exceptions:
    NNGException = NNGException
    Timeout = Timeout
    ConnectionRefused = ConnectionRefused
    Closed = Closed


class Message:
    def __init__(self, data):
        self.bytes = bytes(data)


class Req0:
    def __init__(self, dial=None, block_on_dial=None, send_timeout=None, recv_timeout=None, **_):
        self._reply = None
        self._closed = False
        self.send_timeout, self.recv_timeout = send_timeout, recv_timeout

    def dial(self, address, block=None):
        pass

    def send(self, data):
        if self._closed:
            raise Closed("the socket is closed")
        import kicad_ipc
        self._reply = kicad_ipc.handle(bytes(data))

    def recv_msg(self, block=True):
        if self._reply is None:
            raise Timeout("nothing was sent")
        out, self._reply = self._reply, None
        return Message(out)

    def recv(self, block=True):
        return self.recv_msg().bytes

    def close(self):
        self._closed = True

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()
        return False
