"""psutil for the web editor: the handful of questions KiCad plugins ask about the computer.

There is one process here (this interpreter, in a browser tab) and no others to list; memory and
processor counts are what the browser says.
"""
import os
from collections import namedtuple


class Error(Exception):
    pass


class NoSuchProcess(Error):
    def __init__(self, pid=None, name=None, msg=None):
        Error.__init__(self, msg or f"process {pid} does not exist")
        self.pid, self.name = pid, name


class AccessDenied(Error):
    def __init__(self, pid=None, name=None, msg=None):
        Error.__init__(self, msg or "access denied")
        self.pid, self.name = pid, name


class ZombieProcess(NoSuchProcess):
    pass


class TimeoutExpired(Error):
    pass


_svmem = namedtuple("svmem", "total available percent used free")
_pmem = namedtuple("pmem", "rss vms")
_GB = 1024 ** 3


def _device_memory():
    try:
        import js
        gb = float(getattr(js.navigator, "deviceMemory", 0) or 0)
        if gb > 0:
            return int(gb * _GB)
    except Exception:
        pass
    return 4 * _GB


def virtual_memory():
    total = _device_memory()
    used = total // 4
    return _svmem(total, total - used, 25.0, used, total - used)


def cpu_count(logical=True):
    try:
        import js
        return int(js.navigator.hardwareConcurrency or 1)
    except Exception:
        return 1


def cpu_percent(interval=None, percpu=False):
    return [0.0] * cpu_count() if percpu else 0.0


def pid_exists(pid):
    return int(pid) == os.getpid()


def pids():
    return [os.getpid()]


class Process:
    def __init__(self, pid=None):
        self.pid = os.getpid() if pid is None else int(pid)
        if self.pid != os.getpid():
            raise NoSuchProcess(self.pid)
        self.info = {"pid": self.pid, "name": "pcbnew", "exe": "/usr/bin/pcbnew", "cmdline": ["pcbnew"], "cwd": os.getcwd()}

    def name(self):
        return "pcbnew"

    def exe(self):
        return "/usr/bin/pcbnew"

    def cmdline(self):
        return ["pcbnew"]

    def cwd(self):
        return os.getcwd()

    def memory_info(self):
        return _pmem(256 * 1024 * 1024, 512 * 1024 * 1024)

    def memory_percent(self):
        return 5.0

    def cpu_percent(self, interval=None):
        return 0.0

    def children(self, recursive=False):
        return []

    def parent(self):
        return None

    def parents(self):
        return []

    def open_files(self):
        return []

    def is_running(self):
        return True

    def status(self):
        return "running"

    def as_dict(self, attrs=None):
        return dict(self.info)

    def oneshot(self):
        import contextlib
        return contextlib.nullcontext()

    def terminate(self):
        raise AccessDenied(self.pid)

    kill = terminate

    def wait(self, timeout=None):
        return 0


def process_iter(attrs=None, ad_value=None):
    return iter([Process()])


def boot_time():
    import time
    return time.time() - 60.0
