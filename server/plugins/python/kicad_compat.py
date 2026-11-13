"""What bfieldtools needs around it to load in this interpreter (KiCad-Parasitics computes inductance with it).

bfieldtools imports all of its parts at once, and three of them reach for things a browser's Python lacks:

  * `scipy.special.lpmn`, which newer scipy dropped: it is given back here, computed by scipy's own replacement
    (`assoc_legendre_p_all`), with the old function's argument order and array layout;
  * `psutil.virtual_memory`, to size its work to the memory at hand: answered with this interpreter's own memory;
  * the cvxpy and cvxopt solvers, for its coil optimiser: they are not available, and say so when used.

The last two are given to bfieldtools only, while it is being imported.  A plugin that imports psutil or cvxpy itself
still learns that they are not installed.
"""
import importlib.abc
import importlib.machinery
import sys
import types
from collections import namedtuple


def _lpmn(m, n, z):
    """scipy.special.lpmn as it was: associated Legendre functions of the first kind Pmn(z) and their derivatives,
    for orders 0..m and degrees 0..n, as two arrays of shape (m+1, n+1)."""
    import numpy as np
    import scipy.special as sp
    if not np.isscalar(m) or abs(m) > n:
        raise ValueError("m must be <= n.")
    if not np.isscalar(n) or n < 0:
        raise ValueError("n must be a non-negative integer.")
    if not np.isscalar(z):
        raise ValueError("z must be scalar.")
    m, n = int(m), int(n)
    p, pd = sp.assoc_legendre_p_all(n, abs(m), float(np.real(z)), diff_n=1)
    if m >= 0:
        cols = list(range(0, m + 1))
    else:
        cols = [0] + [-k for k in range(1, -m + 1)]         # negative orders are stored from the end
    return np.ascontiguousarray(p[:, cols].T), np.ascontiguousarray(pd[:, cols].T)


def _restore_lpmn():
    try:
        import scipy.special as sp
    except Exception:
        return
    if not hasattr(sp, "lpmn") and hasattr(sp, "assoc_legendre_p_all"):
        sp.lpmn = _lpmn


_svmem = namedtuple("svmem", "total available percent used free")
_WASM_LIMIT = 4 << 30                # what a 32-bit WebAssembly program can address


def _virtual_memory():
    """This interpreter's memory: the most it can grow to, and how much of that it has not taken yet."""
    used = 0
    try:
        import pyodide_js
        used = int(pyodide_js._module.HEAPU8.length)
    except Exception:
        used = 512 << 20
    used = min(used, _WASM_LIMIT)
    free = _WASM_LIMIT - used
    return _svmem(_WASM_LIMIT, free, round(100.0 * used / _WASM_LIMIT, 1), used, free)


class _Absent:
    """A name of a package that is not here: it can be stored and passed around, and says what is missing when used."""
    def __init__(self, name):
        object.__setattr__(self, "_name", name)

    def _fail(self, *a, **k):
        raise ImportError(f"{self._name}: the {self._name.split('.')[0]} package is not available in the web editor's Python")

    __call__ = __getattr__ = __getitem__ = __iter__ = _fail

    def __repr__(self):
        return f"<{self._name}: not available>"


def _module(name):
    mod = types.ModuleType(name)
    if name == "psutil":
        mod.virtual_memory = _virtual_memory
        mod.cpu_count = lambda logical=True: 1
    else:
        mod.__getattr__ = lambda attr, _n=name: _Absent(f"{_n}.{attr}")
    return mod


class _Loader(importlib.abc.Loader):
    def create_module(self, spec):
        return _module(spec.name)

    def exec_module(self, module):
        pass


_FOR = {"psutil": "bfieldtools.mesh_impedance", "cvxopt": "bfieldtools.coil_optimize", "cvxpy": "bfieldtools.coil_optimize"}


class Finder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        # once the part of bfieldtools that asked has loaded, the stand-in is no longer anyone else's to find
        for name, wants in _FOR.items():
            mod = sys.modules.get(name)
            if isinstance(getattr(mod, "__loader__", None), _Loader) and not getattr(getattr(sys.modules.get(wants), "__spec__", None), "_initializing", False):
                del sys.modules[name]
        if fullname == "bfieldtools":
            _restore_lpmn()
            return None
        wants = _FOR.get(fullname)
        if wants is None:
            return None
        importer = sys.modules.get(wants)
        if not getattr(getattr(importer, "__spec__", None), "_initializing", False):
            return None                     # asked for by something else: not installed, as far as that goes
        return importlib.machinery.ModuleSpec(fullname, _Loader())


def numpy_wide_counts():
    """numpy on a 32-bit machine (WebAssembly is one) refuses 64-bit counts where the desktop takes them.

    Plugins are written on 64-bit computers, where an integer array is 64-bit by default; here numpy's own index type
    is 32-bit, and `np.repeat(values, counts)` with 64-bit counts stops with "Cannot cast array data from int64 to
    int32".  The counts are narrowed when every one of them fits, which is the same result the desktop gives."""
    import numpy as np
    if np.dtype(np.intp).itemsize >= 8 or getattr(np.repeat, "_kc_wide", False):
        return
    from numpy._core import fromnumeric
    plain = np.repeat

    def repeat(a, repeats, axis=None):
        r = np.asarray(repeats)
        if r.dtype.kind in "iu" and r.dtype.itemsize > np.dtype(np.intp).itemsize:
            if r.size and int(r.max()) > np.iinfo(np.intp).max:
                raise ValueError("repeat counts do not fit this machine's index type")
            repeats = r.astype(np.intp)
        return plain(a, repeats, axis)

    repeat._kc_wide = True
    repeat.__doc__ = plain.__doc__
    np.repeat = fromnumeric.repeat = repeat


# The largest system SuperLU has been seen to factorize inside 4 GB with the lean ordering: a five-point grid matrix of
# 1.49 million unknowns (3.9 GB at its peak, and the field solver's own meshes of that size inside a plugin).  One of
# 2.5 million does not fit, and a factorization that runs out of memory leaves the heap too full for anything else, so
# the choice is made before trying.
_DIRECT_FITS = 1500000
solves = []                          # (unknowns, method, seconds) of each large solve, for a test to read


_recent = []                         # the last few iterative answers: a field solver solves nearly the same system again


def _solve_spd_iteratively(A, b):
    """Ax = b by conjugate gradients, for a symmetric matrix with a positive diagonal (a field problem's matrix is
    one).  It needs room for a few vectors only.  The answer is taken when its residual is a ten-billionth of b's
    size or less, far inside what a direct solve's rounding leaves; None says this matrix is not for this method."""
    import numpy as np
    import scipy.sparse as sp
    from scipy.sparse.linalg import LinearOperator, cg
    b = np.asarray(b)
    if b.ndim != 1 or not sp.issparse(A) or A.shape[0] != A.shape[1] or A.shape[0] != b.shape[0] or np.iscomplexobj(b) or A.dtype.kind == "c":
        return None
    A = A.tocsr()
    d = A.diagonal()
    if not np.all(d > 0):
        return None
    skew = abs(A - A.T)
    if skew.nnz and skew.max() > 1e-12 * abs(A).max():
        return None
    del skew
    norm = float(np.linalg.norm(b))
    if norm == 0.0:
        return np.zeros_like(b, dtype=float)
    # start from an earlier answer of the same size when it is nearer than zero: the next system a field solver asks
    # for is usually the same mesh with the track a little wider or the dielectric taken away
    x0, best = None, norm
    for old in _recent:
        if old.shape == b.shape:
            r = float(np.linalg.norm(b - A @ old))
            if r < best:
                x0, best = old, r
    x, info = cg(A, b, x0=x0, rtol=1e-10, atol=0.0, maxiter=max(20000, 20 * int(A.shape[0] ** 0.5)), M=LinearOperator(A.shape, matvec=lambda v: v / d, dtype=float))
    if info != 0 or not np.all(np.isfinite(x)) or float(np.linalg.norm(A @ x - b)) > 1e-9 * norm:
        return None
    _recent.append(x)
    del _recent[:-2]
    return x


def scipy_lean_direct_solve():
    """scipy's direct sparse solve, kept within what a browser's Python can address (4 GB).

    `spsolve` factorizes with SuperLU, whose default column ordering (COLAMD) fills in far more than it needs to on the
    matrices of grid problems: a field solver's mesh of 1.3 million cells runs out of memory with it here, where a
    desktop has the room.  When the caller left the ordering to scipy and the matrix is large, SuperLU's own
    minimum-degree ordering on the pattern of A-transpose-plus-A is used: the same factorization and the same answer,
    in about half the memory and time.  A caller that names an ordering gets the one it named.

    A system too large even for that (see _DIRECT_FITS) is solved by conjugate gradients when its matrix allows it
    (symmetric, positive diagonal), and the answer is checked against the equations before it is returned.  That is
    slower, a few minutes for a million unknowns, and needs almost no memory.  Anything else is left to SuperLU."""
    import numpy as np
    if np.dtype(np.intp).itemsize >= 8:
        return
    import scipy.sparse.linalg as linalg
    from scipy.sparse.linalg._dsolve import linsolve
    if getattr(linalg.spsolve, "_kc_lean", False):
        return
    plain = linsolve.spsolve

    def spsolve(A, b, permc_spec=None, use_umfpack=True):
        n = getattr(A, "shape", (0, 0))[0]
        if permc_spec is not None or n < 100000:
            return plain(A, b, permc_spec=permc_spec, use_umfpack=use_umfpack)
        import time
        t = time.time()
        if n > _DIRECT_FITS:
            x = _solve_spd_iteratively(A, b)
            if x is not None:
                solves.append((n, "cg", round(time.time() - t, 1)))
                return x
        x = plain(A, b, permc_spec="MMD_AT_PLUS_A", use_umfpack=use_umfpack)
        solves.append((n, "lu", round(time.time() - t, 1)))
        return x

    spsolve._kc_lean = True
    spsolve.__doc__ = plain.__doc__
    linsolve.spsolve = linalg.spsolve = spsolve
    try:
        import scipy.sparse.linalg._dsolve as dsolve
        dsolve.spsolve = spsolve
    except Exception:
        pass


def install():
    if not any(isinstance(f, Finder) for f in sys.meta_path):
        sys.meta_path.insert(0, Finder())
