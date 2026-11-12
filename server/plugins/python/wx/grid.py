# wx.grid for the web editor: Grid as an HTML table of editable cells.
#
# Cells are text inputs (or a checkbox / a drop-down when the plugin gives the cell a bool or choice editor); the grid keeps
# the values in Python, so GetCellValue and SetCellValue are plain list reads and writes.

import wx
from wx import _el, _listen, _binder, Event, Window

for _n in ("CELL_CHANGED", "CELL_CHANGING", "CELL_LEFT_CLICK", "CELL_RIGHT_CLICK", "CELL_LEFT_DCLICK", "CELL_RIGHT_DCLICK", "SELECT_CELL",
           "LABEL_LEFT_CLICK", "LABEL_RIGHT_CLICK", "LABEL_LEFT_DCLICK", "RANGE_SELECT", "RANGE_SELECTED", "RANGE_SELECTING", "EDITOR_SHOWN",
           "EDITOR_HIDDEN", "EDITOR_CREATED", "COL_SIZE", "ROW_SIZE", "COL_SORT", "COL_MOVE", "TABBING", "CMD_CELL_CHANGED"):
    globals()["EVT_GRID_" + _n] = _binder("EVT_GRID_" + _n)
EVT_GRID_CELL_CHANGE = EVT_GRID_CELL_CHANGED          # noqa: F821

GRID_AUTOSIZE = -1
GridSelectCells, GridSelectRows, GridSelectColumns = 0, 1, 2
GRID_VALUE_STRING, GRID_VALUE_BOOL, GRID_VALUE_NUMBER, GRID_VALUE_FLOAT, GRID_VALUE_CHOICE, GRID_VALUE_TEXT, GRID_VALUE_LONG = (
    "string", "bool", "long", "double", "choice", "string", "long")


class GridCellCoords:
    def __init__(self, row=-1, col=-1):
        self._row, self._col = row, col

    def GetRow(self):
        return self._row

    def GetCol(self):
        return self._col

    Row = property(GetRow)
    Col = property(GetCol)

    def __iter__(self):
        return iter((self._row, self._col))


class GridEvent(Event):
    def __init__(self, source, binder, row=-1, col=-1, old=""):
        Event.__init__(self, source, binder)
        self._row, self._col = row, col
        self._string = old

    def GetRow(self):
        return self._row

    def GetCol(self):
        return self._col

    def GetPosition(self):
        return wx.Point(0, 0)

    def Selecting(self):
        return True

    def ControlDown(self):
        return False

    ShiftDown = AltDown = MetaDown = ControlDown


class _Editor:
    _kind = "text"

    def __init__(self, *a, **k):
        self._choices = []

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda *a, **k: None


class GridCellTextEditor(_Editor):
    pass


class GridCellNumberEditor(_Editor):
    _kind = "number"


class GridCellFloatEditor(_Editor):
    _kind = "number"


class GridCellBoolEditor(_Editor):
    _kind = "bool"

    @staticmethod
    def UseStringValues(*a):
        pass


class GridCellChoiceEditor(_Editor):
    _kind = "choice"

    def __init__(self, choices=(), allowOthers=False):
        self._choices = [str(c) for c in choices]

    def SetParameters(self, params):
        self._choices = [p for p in str(params).split(",")]


GridCellEnumEditor = GridCellChoiceEditor
GridCellAutoWrapStringEditor = GridCellTextEditor


class _Renderer(_Editor):
    pass


class GridCellBoolRenderer(_Renderer):
    _kind = "bool"


GridCellStringRenderer = GridCellNumberRenderer = GridCellFloatRenderer = GridCellAutoWrapStringRenderer = GridCellEnumRenderer = GridCellRenderer = _Renderer


class GridCellAttr:
    def __init__(self, *a):
        self._ro, self._editor, self._renderer, self._bg, self._fg = None, None, None, None, None

    def SetReadOnly(self, ro=True):
        self._ro = bool(ro)

    def SetEditor(self, e):
        self._editor = e

    def SetRenderer(self, r):
        self._renderer = r

    def SetBackgroundColour(self, c):
        self._bg = c

    def SetTextColour(self, c):
        self._fg = c

    def Clone(self):
        a = GridCellAttr()
        a.__dict__.update(self.__dict__)
        return a

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda *a, **k: None


class Grid(Window):
    _CLS = "wx-table wx-grid-table"

    def __init__(self, parent=None, id=wx.ID_ANY, pos=wx.DefaultPosition, size=wx.DefaultSize, style=0, *more, **kw):
        Window.__init__(self, parent, id, pos, size, style, **kw)

    def _wx_build(self, kw):
        self._table = _el("table")
        self._head = _el("tr")
        self._corner = _el("th")
        self._head.appendChild(self._corner)
        self._table.appendChild(self._head)
        self.el.appendChild(self._table)
        self._col_labels, self._ths, self._col_attr = [], [], []
        self._rows = []            # {"values": [...], "tr": el, "th": el, "tds": [...], "label": str, "cells": {col: {...}}}
        self._editable = True
        self._row_labels = True
        self._cursor = (0, 0)
        self._sel_rows = set()
        self._batch = 0

    # shape
    def CreateGrid(self, rows, cols, selmode=0):
        self.AppendCols(cols)
        self.AppendRows(rows)
        return True

    def SetTable(self, *a, **k):
        return True

    def _wx_default_label(self, c):
        s = ""
        c += 1
        while c:
            c, r = divmod(c - 1, 26)
            s = chr(65 + r) + s
        return s

    def AppendCols(self, n=1, *a):
        for _ in range(int(n)):
            c = len(self._col_labels)
            th = _el("th")
            th.textContent = self._wx_default_label(c)
            _listen(th, "click", lambda e=None, c=c: self._wx_fire(EVT_GRID_LABEL_LEFT_CLICK, GridEvent(self, EVT_GRID_LABEL_LEFT_CLICK, -1, c)))   # noqa: F821
            self._head.appendChild(th)
            self._col_labels.append(th.textContent)
            self._ths.append(th)
            self._col_attr.append({})
            for r in self._rows:
                r["values"].append("")
                self._wx_cell(r, c)
        return True

    def InsertCols(self, pos=0, n=1, *a):
        return self.AppendCols(n)

    def DeleteCols(self, pos=0, n=1, *a):
        for _ in range(int(n)):
            if 0 <= pos < len(self._col_labels):
                self._col_labels.pop(pos)
                self._ths.pop(pos).remove()
                self._col_attr.pop(pos)
                for r in self._rows:
                    r["values"].pop(pos)
                    r["tds"].pop(pos).remove()
        return True

    def _wx_new_row(self, index):
        tr = _el("tr")
        th = _el("th")
        if not self._row_labels:
            th.style.display = "none"
        tr.appendChild(th)
        row = {"values": [""] * len(self._col_labels), "tr": tr, "th": th, "tds": [], "label": None, "cells": {}}
        for c in range(len(self._col_labels)):
            self._wx_cell(row, c)
        _listen(th, "click", lambda e=None: self._wx_label_click(row))
        if index < len(self._rows):
            self._table.insertBefore(tr, self._rows[index]["tr"])
        else:
            self._table.appendChild(tr)
        self._rows.insert(index, row)

    def _wx_label_click(self, row):
        r = self._rows.index(row)
        self.SelectRow(r)
        self._wx_fire(EVT_GRID_LABEL_LEFT_CLICK, GridEvent(self, EVT_GRID_LABEL_LEFT_CLICK, r, -1))        # noqa: F821

    def _wx_renumber(self):
        for i, r in enumerate(self._rows):
            r["th"].textContent = r["label"] if r["label"] is not None else str(i + 1)

    def AppendRows(self, n=1, *a):
        for _ in range(int(n)):
            self._wx_new_row(len(self._rows))
        self._wx_renumber()
        return True

    def InsertRows(self, pos=0, n=1, *a):
        for _ in range(int(n)):
            self._wx_new_row(max(0, min(pos, len(self._rows))))
        self._wx_renumber()
        return True

    def DeleteRows(self, pos=0, n=1, *a):
        for _ in range(int(n)):
            if 0 <= pos < len(self._rows):
                self._rows.pop(pos)["tr"].remove()
        self._sel_rows = set()
        self._wx_renumber()
        return True

    def ClearGrid(self):
        for r in self._rows:
            for c in range(len(r["values"])):
                r["values"][c] = ""
                self._wx_show(r, c)

    def GetNumberRows(self):
        return len(self._rows)

    def GetNumberCols(self):
        return len(self._col_labels)

    NumberRows = property(GetNumberRows)
    NumberCols = property(GetNumberCols)

    # cells
    def _wx_kind(self, row, c):
        cell = row["cells"].get(c, {})
        ed = cell.get("editor") or cell.get("renderer") or self._col_attr[c].get("editor") or self._col_attr[c].get("renderer")
        fmt = self._col_attr[c].get("format")
        if ed is not None:
            return ed._kind, ed
        if fmt == "bool":
            return "bool", None
        return "text", None

    def _wx_readonly(self, row, c):
        cell = row["cells"].get(c, {})
        if "ro" in cell:
            return cell["ro"]
        return bool(self._col_attr[c].get("ro")) or bool(row.get("ro")) or not self._editable

    def _wx_cell(self, row, c):
        td = _el("td")
        row["tr"].appendChild(td)
        if c < len(row["tds"]):
            row["tds"][c] = td
        else:
            row["tds"].append(td)
        self._wx_fill(row, c)
        _listen(td, "click", lambda e=None, row=row, c=c: self._wx_click(row, c))
        _listen(td, "dblclick", lambda e=None, row=row, c=c: self._wx_fire(EVT_GRID_CELL_LEFT_DCLICK, GridEvent(self, EVT_GRID_CELL_LEFT_DCLICK, self._rows.index(row), c)))    # noqa: F821

    def _wx_fill(self, row, c):
        """(Re)build the control inside a cell for its current editor, value and read-only state."""
        td = row["tds"][c]
        kind, ed = self._wx_kind(row, c)
        ro = self._wx_readonly(row, c)
        v = row["values"][c]
        td.replaceChildren()
        td.textContent = ""
        td._box = None
        if kind == "bool":
            box = _el("input")
            box.type = "checkbox"
            box.checked = str(v) not in ("", "0", "False", "false")
            box.disabled = ro
            td.appendChild(box)
            td._box = box
            _listen(box, "change", lambda e=None: self._wx_edit(row, c, "1" if box.checked else ""))
        elif kind == "choice" and not ro:
            box = _el("select")
            for ch in ([] if v in ed._choices else [str(v)]) + list(ed._choices):
                o = _el("option")
                o.textContent = ch
                o.value = ch
                box.appendChild(o)
            box.value = str(v)
            td.appendChild(box)
            td._box = box
            _listen(box, "change", lambda e=None: self._wx_edit(row, c, str(box.value)))
        elif ro:
            td.textContent = "" if v is None else str(v)
        else:
            box = _el("input")
            box.type = "text"
            box.value = "" if v is None else str(v)
            td.appendChild(box)
            td._box = box
            _listen(box, "change", lambda e=None: self._wx_edit(row, c, str(box.value)))
        cell = row["cells"].get(c, {})
        bg = cell.get("bg") or self._col_attr[c].get("bg")
        fg = cell.get("fg")
        td.style.background = wx.Colour(bg).GetAsString() if bg is not None else ""
        td.style.color = wx.Colour(fg).GetAsString() if fg is not None else ""

    def _wx_show(self, row, c):
        td, v = row["tds"][c], row["values"][c]
        box = getattr(td, "_box", None)
        kind, _ = self._wx_kind(row, c)
        if box is None:
            td.textContent = "" if v is None else str(v)
        elif kind == "bool":
            box.checked = str(v) not in ("", "0", "False", "false")
        else:
            box.value = "" if v is None else str(v)

    def _wx_edit(self, row, c, value):
        old = row["values"][c]
        row["values"][c] = value
        r = self._rows.index(row)
        self._wx_fire(EVT_GRID_CELL_CHANGED, GridEvent(self, EVT_GRID_CELL_CHANGED, r, c, str(old)))        # noqa: F821

    def _wx_click(self, row, c):
        r = self._rows.index(row)
        self._cursor = (r, c)
        self._wx_fire(EVT_GRID_SELECT_CELL, GridEvent(self, EVT_GRID_SELECT_CELL, r, c))                    # noqa: F821
        self._wx_fire(EVT_GRID_CELL_LEFT_CLICK, GridEvent(self, EVT_GRID_CELL_LEFT_CLICK, r, c))            # noqa: F821

    def _wx_ok(self, row, col):
        return 0 <= row < len(self._rows) and 0 <= col < len(self._col_labels)

    def GetCellValue(self, row, col=None):
        if col is None:
            row, col = tuple(row)
        return str(self._rows[row]["values"][col]) if self._wx_ok(row, col) else ""

    def SetCellValue(self, row, col, value=None):
        if value is None:
            (row, col), value = tuple(row), col
        if self._wx_ok(row, col):
            self._rows[row]["values"][col] = "" if value is None else str(value)
            self._wx_show(self._rows[row], col)

    def _wx_set(self, row, col, key, value):
        if self._wx_ok(row, col):
            self._rows[row]["cells"].setdefault(col, {})[key] = value
            self._wx_fill(self._rows[row], col)

    def SetReadOnly(self, row, col, isReadOnly=True):
        self._wx_set(row, col, "ro", bool(isReadOnly))

    def IsReadOnly(self, row, col):
        return self._wx_ok(row, col) and self._wx_readonly(self._rows[row], col)

    def SetCellEditor(self, row, col, editor):
        self._wx_set(row, col, "editor", editor)

    def SetCellRenderer(self, row, col, renderer):
        self._wx_set(row, col, "renderer", renderer)

    def SetCellBackgroundColour(self, row, col, colour):
        self._wx_set(row, col, "bg", colour)

    def GetCellBackgroundColour(self, row, col):
        c = self._rows[row]["cells"].get(col, {}).get("bg") if self._wx_ok(row, col) else None
        return wx.Colour(c) if c is not None else wx.Colour(255, 255, 255)

    def SetCellTextColour(self, row, col, colour):
        self._wx_set(row, col, "fg", colour)

    def GetCellTextColour(self, row, col):
        c = self._rows[row]["cells"].get(col, {}).get("fg") if self._wx_ok(row, col) else None
        return wx.Colour(c) if c is not None else wx.Colour(0, 0, 0)

    def SetCellAlignment(self, *a):
        pass

    SetCellFont = SetCellSize = SetCellOverflow = SetCellAlignment

    def SetAttr(self, row, col, attr):
        if self._wx_ok(row, col) and isinstance(attr, GridCellAttr):
            cell = self._rows[row]["cells"].setdefault(col, {})
            for k, v in (("ro", attr._ro), ("editor", attr._editor), ("renderer", attr._renderer), ("bg", attr._bg), ("fg", attr._fg)):
                if v is not None:
                    cell[k] = v
            self._wx_fill(self._rows[row], col)

    def _wx_refill_col(self, col):
        for r in self._rows:
            self._wx_fill(r, col)

    def SetColAttr(self, col, attr):
        if 0 <= col < len(self._col_attr) and isinstance(attr, GridCellAttr):
            for k, v in (("ro", attr._ro), ("editor", attr._editor), ("renderer", attr._renderer), ("bg", attr._bg)):
                if v is not None:
                    self._col_attr[col][k] = v
            self._wx_refill_col(col)

    def SetRowAttr(self, row, attr):
        if 0 <= row < len(self._rows) and isinstance(attr, GridCellAttr):
            if attr._ro is not None:
                self._rows[row]["ro"] = attr._ro
            for c in range(len(self._col_labels)):
                if attr._bg is not None:
                    self._rows[row]["cells"].setdefault(c, {})["bg"] = attr._bg
                self._wx_fill(self._rows[row], c)

    def SetColFormatBool(self, col):
        if 0 <= col < len(self._col_attr):
            self._col_attr[col]["format"] = "bool"
            self._wx_refill_col(col)

    def SetColFormatNumber(self, col, *a, **k):
        pass

    SetColFormatFloat = SetColFormatCustom = SetColFormatDate = lambda self, col, *a, **k: None

    def EnableEditing(self, edit=True):
        self._editable = bool(edit)
        for r in self._rows:
            for c in range(len(self._col_labels)):
                self._wx_fill(r, c)

    def IsEditable(self):
        return self._editable

    # labels
    def SetColLabelValue(self, col, value):
        if 0 <= col < len(self._ths):
            self._col_labels[col] = str(value)
            self._ths[col].textContent = str(value)

    def GetColLabelValue(self, col):
        return self._col_labels[col] if 0 <= col < len(self._col_labels) else ""

    def SetRowLabelValue(self, row, value):
        if 0 <= row < len(self._rows):
            self._rows[row]["label"] = str(value)
            self._rows[row]["th"].textContent = str(value)

    def GetRowLabelValue(self, row):
        r = self._rows[row] if 0 <= row < len(self._rows) else None
        return (r["label"] if r["label"] is not None else str(row + 1)) if r else ""

    def SetRowLabelSize(self, width):
        self._row_labels = width != 0
        disp = "" if self._row_labels else "none"
        self._corner.style.display = disp
        for r in self._rows:
            r["th"].style.display = disp

    HideRowLabels = lambda self: self.SetRowLabelSize(0)

    def SetColLabelSize(self, height):
        self._head.style.display = "none" if height == 0 else ""

    HideColLabels = lambda self: self.SetColLabelSize(0)

    def GetRowLabelSize(self):
        return 40 if self._row_labels else 0

    def GetColLabelSize(self):
        return 20

    def SetColSize(self, col, width):
        if 0 <= col < len(self._ths) and width and width > 0:
            self._ths[col].style.minWidth = f"{int(width)}px"

    SetColMinimalWidth = SetColSize

    def GetColSize(self, col):
        return 80

    def GetRowSize(self, row):
        return 20

    def HideCol(self, col):
        if 0 <= col < len(self._ths):
            self._ths[col].style.display = "none"
            for r in self._rows:
                r["tds"][col].style.display = "none"

    def ShowCol(self, col):
        if 0 <= col < len(self._ths):
            self._ths[col].style.display = ""
            for r in self._rows:
                r["tds"][col].style.display = ""

    def HideRow(self, row):
        if 0 <= row < len(self._rows):
            self._rows[row]["tr"].style.display = "none"

    def ShowRow(self, row):
        if 0 <= row < len(self._rows):
            self._rows[row]["tr"].style.display = ""

    # cursor and selection
    def GetGridCursorRow(self):
        return self._cursor[0]

    def GetGridCursorCol(self):
        return self._cursor[1]

    def GetGridCursorCoords(self):
        return GridCellCoords(*self._cursor)

    def SetGridCursor(self, row, col=None):
        self._cursor = tuple(row) if col is None else (row, col)

    GoToCell = SetGridCursor

    def MakeCellVisible(self, row, col=None):
        if isinstance(row, int) and 0 <= row < len(self._rows):
            self._rows[row]["tr"].scrollIntoView()

    def SelectRow(self, row, addToSelected=False):
        if not addToSelected:
            self.ClearSelection()
        if 0 <= row < len(self._rows):
            self._sel_rows.add(row)
            self._rows[row]["tr"].classList.add("sel")

    def DeselectRow(self, row):
        if row in self._sel_rows:
            self._sel_rows.discard(row)
            self._rows[row]["tr"].classList.remove("sel")

    def SelectAll(self):
        for r in range(len(self._rows)):
            self.SelectRow(r, True)

    def ClearSelection(self):
        for r in self._sel_rows:
            if r < len(self._rows):
                self._rows[r]["tr"].classList.remove("sel")
        self._sel_rows = set()

    def GetSelectedRows(self):
        return sorted(self._sel_rows)

    def GetSelectedCols(self):
        return []

    def GetSelectedCells(self):
        return []

    GetSelectionBlockTopLeft = GetSelectionBlockBottomRight = GetSelectedBlocks = GetSelectedCells

    def IsInSelection(self, row, col=None):
        return row in self._sel_rows

    def IsSelection(self):
        return bool(self._sel_rows)

    def SelectBlock(self, top, left, bottom, right, addToSelected=False):
        if not addToSelected:
            self.ClearSelection()
        for r in range(top, bottom + 1):
            self.SelectRow(r, True)

    def SetSelectionMode(self, mode):
        pass

    def GetGridWindow(self):
        return self

    GetGridColLabelWindow = GetGridRowLabelWindow = GetGridCornerLabelWindow = GetGridWindow

    def BeginBatch(self):
        self._batch += 1

    def EndBatch(self):
        self._batch = max(0, self._batch - 1)

    def GetBatchCount(self):
        return self._batch

    def ForceRefresh(self):
        pass

    def XToCol(self, *a):
        return 0

    YToRow = XToCol

    def CellToRect(self, *a):
        return wx.Rect(0, 0, 80, 20)

    def SaveEditControlValue(self):
        pass


class GridTableBase:
    def __init__(self, *a, **k):
        pass

    def GetView(self):
        return None


PyGridTableBase = GridStringTable = GridTableBase
GridTableMessage = lambda *a, **k: None
GRIDTABLE_NOTIFY_ROWS_APPENDED = GRIDTABLE_NOTIFY_ROWS_DELETED = GRIDTABLE_NOTIFY_ROWS_INSERTED = GRIDTABLE_REQUEST_VIEW_GET_VALUES = 0
GRIDTABLE_NOTIFY_COLS_APPENDED = GRIDTABLE_NOTIFY_COLS_DELETED = GRIDTABLE_NOTIFY_COLS_INSERTED = 0


def __getattr__(name):
    if name.startswith("__"):
        raise AttributeError(name)
    return getattr(wx, name)
