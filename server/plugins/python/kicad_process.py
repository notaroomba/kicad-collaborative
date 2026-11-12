"""multiprocessing for plugins: a "process" is the plugin's function running beside the rest, in this interpreter.

A browser page has one Python and no second program to start.  What a plugin wants from a child process is usually
only that a piece of work sits behind a pipe: it sends a request, waits, reads the answer (KiCad-Parasitics keeps
ngspice there, so a hung simulation can be killed).  That works here: the child's function runs on its own stack in
the page, the pipe's two ends are two queues, and whichever side waits for a message lets the other run.

Stack switching is the browser's (the same that lets Python wait on the editor).  Where it is missing, starting a
process fails with OSError, as it does on a system that cannot start one.
"""
import collections
import logging
import pickle
import time

log = logging.getLogger("kicad_web")

_current = [None]            # the process whose code runs now; None for the plugin itself


class _Killed(BaseException):
    """Unwinds a child's stack when its process is killed."""


def _dom():
    try:
        import wx
        return wx if wx._DOM else None
    except Exception:
        return None


def _pause(ms):
    """Let the other side run for a moment.  Raises RuntimeError where this stack cannot wait."""
    wx = _dom()
    if wx is None:
        raise RuntimeError("nothing else can run while this code waits")
    me = _current[0]
    _current[0] = None              # whatever runs meanwhile is not this process's code
    try:
        wx._wait(wx._kc().sleep(int(ms)))
    finally:
        _current[0] = me


class Connection:
    """One end of a pipe: what is sent here is received at the other end."""
    def __init__(self, inbox, outbox, state, owner=None):
        self._in, self._out, self._state, self._owner, self._closed = inbox, outbox, state, owner, False

    def _dup(self, owner):
        return Connection(self._in, self._out, self._state, owner)

    def _check(self):
        if self._closed:
            raise OSError("handle is closed")
        proc = self._owner
        if proc is not None and proc._killed:
            raise _Killed()

    def _peer_gone(self):
        """The other end's process has ended and left nothing more to read."""
        return any(p._done for p in self._state["procs"] if p is not self._owner) and self._owner is None

    def send(self, obj):
        self._check()
        self._out.append(pickle.dumps(obj))

    def send_bytes(self, data, offset=0, size=None):
        self._check()
        self._out.append(pickle.dumps(bytes(data[offset:None if size is None else offset + size])))

    def poll(self, timeout=0.0):
        self._check()
        if self._in:
            return True
        end = None if timeout is None else time.monotonic() + max(0.0, float(timeout))
        while not self._in:
            if self._peer_gone():
                return True                     # recv will report the end of the pipe
            if end is not None and time.monotonic() >= end:
                return False
            try:
                _pause(5)
            except RuntimeError:
                return bool(self._in)
            self._check()
        return True

    def recv(self):
        self._check()
        while not self._in:
            if self._peer_gone():
                raise EOFError()
            try:
                _pause(5)
            except RuntimeError:
                raise EOFError() from None
            self._check()
        return pickle.loads(self._in.popleft())

    def recv_bytes(self, maxlength=None):
        return self.recv()

    def fileno(self):
        return -1

    def close(self):
        self._closed = True

    closed = property(lambda self: self._closed)
    readable = writable = True

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


def Pipe(duplex=True):
    a, b, state = collections.deque(), collections.deque(), {"procs": []}
    return Connection(a, b, state), Connection(b, a, state)


class _ParentOnly(logging.Filter):
    """A handler the plugin set up does not see what its child logs: a real child has its own logging."""
    def filter(self, record):
        return _current[0] is None


class _ChildOnly(logging.Filter):
    def __init__(self, proc):
        super().__init__()
        self._proc = proc

    def filter(self, record):
        return _current[0] is self._proc


_counter = [0]


class Process:
    def __init__(self, group=None, target=None, name=None, args=(), kwargs=None, *, daemon=None):
        _counter[0] += 1
        self._target, self._kwargs = target, dict(kwargs or {})
        self.name, self.daemon = name or f"Process-{_counter[0]}", bool(daemon)
        self.pid, self.exitcode = None, None
        self._started = self._done = self._killed = False
        # the child gets its own ends of the pipes it is given: the parent closing its copy does not close the child's
        self._args = tuple(self._own(a) for a in args)

    def _own(self, a):
        if isinstance(a, Connection):
            a._state["procs"].append(self)
            return a._dup(self)
        return a

    def run(self):
        if self._target:
            self._target(*self._args, **self._kwargs)

    def start(self):
        wx = _dom()
        if wx is None:
            raise OSError("this Python cannot start a second process: there is no page to run it in")
        if self._started:
            raise AssertionError("cannot start a process twice")
        self._started, self.pid = True, 40000 + _counter[0]
        root = logging.getLogger()
        guard = _ParentOnly()
        guarded = list(root.handlers)
        for h in guarded:
            h.addFilter(guard)
        real_add = root.addHandler

        def add(handler):                       # what the child adds to the root logger is the child's alone
            if _current[0] is self:
                handler.addFilter(_ChildOnly(self))
                self._handlers.append(handler)
            real_add(handler)

        self._handlers = []
        root.addHandler = add

        def body():
            _current[0] = self
            try:
                self.run()
                self.exitcode = 0
            except _Killed:
                self.exitcode = -9
            except SystemExit as e:
                self.exitcode = e.code if isinstance(e.code, int) else 0
            except BaseException:
                self.exitcode = 1
                log.exception("a child process of the plugin failed")
            finally:
                self._done = True
                _current[0] = None
                for h in self._handlers:
                    root.removeHandler(h)
                for h in guarded:
                    h.removeFilter(guard)
                try:
                    del root.addHandler
                except AttributeError:
                    pass

        wx._kc().later(wx._once(body), 0)

    def is_alive(self):
        return self._started and not self._done

    def join(self, timeout=None):
        end = None if timeout is None else time.monotonic() + float(timeout)
        while self.is_alive() and (end is None or time.monotonic() < end):
            try:
                _pause(5)
            except RuntimeError:
                break

    def kill(self):
        self._killed = True
        if not self._started:
            self._done = True

    terminate = kill

    def close(self):
        pass

    @property
    def sentinel(self):
        return -1


class _Queue:
    def __init__(self, maxsize=0):
        self._q = collections.deque()

    def put(self, item, block=True, timeout=None):
        self._q.append(pickle.dumps(item))

    put_nowait = put

    def get(self, block=True, timeout=None):
        import queue
        end = None if timeout is None else time.monotonic() + float(timeout)
        while not self._q:
            if not block or (end is not None and time.monotonic() >= end):
                raise queue.Empty()
            try:
                _pause(5)
            except RuntimeError:
                raise queue.Empty() from None
        return pickle.loads(self._q.popleft())

    def get_nowait(self):
        return self.get(False)

    def empty(self):
        return not self._q

    def qsize(self):
        return len(self._q)

    def close(self):
        pass

    def join_thread(self):
        pass

    cancel_join_thread = join_thread


class Context:
    """multiprocessing.get_context(): every start method is the same one here."""
    Process = Process
    Pipe = staticmethod(Pipe)
    Queue = SimpleQueue = JoinableQueue = staticmethod(_Queue)

    def __init__(self, method="spawn"):
        self._name = method

    def get_start_method(self, allow_none=False):
        return self._name

    def set_executable(self, path):
        pass

    def get_context(self, method=None):
        return Context(method or self._name)

    def cpu_count(self):
        return 1

    def current_process(self):
        return _current[0] or _main

    def active_children(self):
        return []

    def freeze_support(self):
        pass


class _Main:
    name, pid, daemon, exitcode = "MainProcess", 1, False, None

    def is_alive(self):
        return True


_main = _Main()


def install():
    """Give `multiprocessing` these processes and pipes."""
    import multiprocessing
    import multiprocessing.connection as mpc
    import multiprocessing.context as ctx
    import multiprocessing.process as mpp
    if getattr(multiprocessing, "_kc_process", False):
        return
    multiprocessing._kc_process = True
    one = Context("spawn")
    multiprocessing.Process = ctx.Process = Process
    multiprocessing.Pipe = Pipe
    multiprocessing.Queue = multiprocessing.SimpleQueue = multiprocessing.JoinableQueue = _Queue
    multiprocessing.get_context = one.get_context
    multiprocessing.get_start_method = one.get_start_method
    multiprocessing.set_start_method = lambda *a, **k: None
    multiprocessing.set_executable = one.set_executable
    multiprocessing.current_process = mpp.current_process = one.current_process
    multiprocessing.active_children = one.active_children
    multiprocessing.cpu_count = one.cpu_count
    multiprocessing.freeze_support = one.freeze_support
    mpc.Pipe = Pipe
    # for annotations and isinstance checks a plugin makes against the real names
    mpc.Connection = Connection
    mpp.BaseProcess = Process
