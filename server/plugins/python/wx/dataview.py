# wx.dataview for the web editor: DataViewListCtrl (and the tree-less uses of DataViewCtrl / TreeListCtrl) as an HTML table.
#
# Rows hold Python values; a column is text, a checkbox, a progress bar or an icon-and-text.  Items are small objects that
# know their row, as the desktop's DataViewItem does, so ItemToRow / RowToItem / GetSelection work as plugin code expects.

import wx
from wx import _el, _listen, _binder, Event, Window

DATAVIEW_CELL_INERT, DATAVIEW_CELL_ACTIVATABLE, DATAVIEW_CELL_EDITABLE = 0, 1, 2
DATAVIEW_COL_RESIZABLE, DATAVIEW_COL_SORTABLE, DATAVIEW_COL_REORDERABLE, DATAVIEW_COL_HIDDEN = 1, 2, 4, 8
DV_SINGLE, DV_MULTIPLE, DV_NO_HEADER, DV_HORIZ_RULES, DV_VERT_RULES, DV_ROW_LINES, DV_VARIABLE_LINE_HEIGHT = 0, 1, 2, 4, 8, 16, 32
NOT_FOUND = -1

for _n in ("SELECTION_CHANGED", "ITEM_ACTIVATED", "ITEM_VALUE_CHANGED", "ITEM_EDITING_DONE", "ITEM_EDITING_STARTED", "ITEM_START_EDITING",
           "ITEM_CONTEXT_MENU", "COLUMN_HEADER_CLICK", "COLUMN_HEADER_RIGHT_CLICK", "COLUMN_SORTED", "COLUMN_REORDERED", "ITEM_COLLAPSED",
           "ITEM_EXPANDED", "ITEM_COLLAPSING", "ITEM_EXPANDING", "ITEM_BEGIN_DRAG", "ITEM_DROP", "ITEM_DROP_POSSIBLE"):
    globals()["EVT_DATAVIEW_" + _n] = _binder("EVT_DATAVIEW_" + _n)
from ._tree import (DataViewTreeListCtrl as TreeListCtrl, TreeListEvent, TreeItemId as TreeListItem, TL_SINGLE, TL_MULTIPLE, TL_CHECKBOX,          # noqa: E402,F401
                    TL_3STATE, TL_USER_3STATE, TL_NO_HEADER, TL_DEFAULT_STYLE, TLI_FIRST, TLI_LAST, EVT_TREELIST_SELECTION_CHANGED,
                    EVT_TREELIST_ITEM_ACTIVATED, EVT_TREELIST_ITEM_CHECKED, EVT_TREELIST_ITEM_EXPANDING, EVT_TREELIST_ITEM_EXPANDED,
                    EVT_TREELIST_ITEM_CONTEXT_MENU, EVT_TREELIST_COLUMN_SORTED)


class DataViewItem:
    def __init__(self, row=None):
        self._row = row

    def IsOk(self):
        return self._row is not None and not (isinstance(self._row, dict) and self._row.get("gone"))

    __bool__ = IsOk

    def GetID(self):
        return id(self._row) if self._row is not None else 0

    def __eq__(self, other):
        return isinstance(other, DataViewItem) and other._row is self._row

    def __hash__(self):
        return id(self._row)


NullDataViewItem = DataViewItem()


class DataViewIconText:
    def __init__(self, text="", icon=None):
        self._text, self._icon = text, icon

    def GetText(self):
        return self._text

    def SetText(self, t):
        self._text = t

    def GetIcon(self):
        return self._icon

    def SetIcon(self, i):
        self._icon = i

    def __str__(self):
        return str(self._text)


class DataViewColumn:
    def __init__(self, title="", renderer=None, model_column=0, width=-1, align=0, flags=0, kind="text", mode=0):
        self._title = title if isinstance(title, str) else ""
        self._kind, self._mode, self._model, self._width, self._flags = kind, mode, model_column, width, flags
        self._th = None
        self._hidden = False

    def GetTitle(self):
        return self._title

    def SetTitle(self, t):
        self._title = t
        if self._th is not None:
            self._th.textContent = t

    def GetWidth(self):
        return self._width if self._width and self._width > 0 else 80

    def SetWidth(self, w):
        self._width = w
        if self._th is not None and w and w > 0:
            self._th.style.minWidth = f"{int(w)}px"

    SetMinWidth = SetWidth

    def GetModelColumn(self):
        return self._model

    def SetHidden(self, hidden=True):
        self._hidden = bool(hidden)
        if self._th is not None:
            self._th.style.display = "none" if hidden else ""

    def IsHidden(self):
        return self._hidden

    def SetSortOrder(self, ascending=True):
        pass

    def IsSortOrderAscending(self):
        return True

    def __getattr__(self, name):
        if name.startswith("Set") or name.startswith("Un"):
            return lambda *a, **k: None
        if name.startswith("Is") or name.startswith("Get"):
            return lambda *a, **k: 0
        raise AttributeError(name)


class DataViewEvent(Event):
    def __init__(self, source, binder, row=None, col=-1):
        Event.__init__(self, source, binder)
        self._row, self._col = row, col

    def GetItem(self):
        return DataViewItem(self._row)

    def GetColumn(self):
        return self._col

    def GetDataViewColumn(self):
        cols = self._source._cols
        return cols[self._col] if 0 <= self._col < len(cols) else None

    def GetValue(self):
        return self._row["values"][self._col] if self._row is not None and 0 <= self._col < len(self._row["values"]) else None

    def GetModel(self):
        return self._source

    def GetPosition(self):
        return wx.Point(0, 0)


class DataViewListCtrl(Window):
    _CLS = "wx-table"

    def __init__(self, parent=None, id=wx.ID_ANY, pos=wx.DefaultPosition, size=wx.DefaultSize, style=0, *more, **kw):
        Window.__init__(self, parent, id, pos, size, style, **kw)

    def _wx_build(self, kw):
        self._table = _el("table")
        self._head = _el("tr")
        self._table.appendChild(self._head)
        self.el.appendChild(self._table)
        self._cols = []
        self._rows = []            # {"values": [...], "tr": el, "tds": [...], "data": any, "sel": bool}
        self._multiple = bool(self._wx_style & DV_MULTIPLE)
        if self._wx_style & DV_NO_HEADER:
            self._head.style.display = "none"

    # columns
    def _wx_col(self, label, kind, mode=DATAVIEW_CELL_INERT, width=-1, align=0, flags=0, at=None):
        col = DataViewColumn(label, None, len(self._cols), width, align, flags, kind, mode)
        th = _el("th")
        th.textContent = col._title
        col._th = th
        if width and width > 0:
            th.style.minWidth = f"{int(width)}px"
        index = len(self._cols)
        _listen(th, "click", lambda e=None: self._wx_fire(EVT_DATAVIEW_COLUMN_HEADER_CLICK, DataViewEvent(self, EVT_DATAVIEW_COLUMN_HEADER_CLICK, None, index)))     # noqa: F821
        self._head.appendChild(th)
        self._cols.append(col)
        for r in self._rows:
            r["values"].append("")
            self._wx_cell(r, len(self._cols) - 1)
        return col

    @staticmethod
    def _wx_col_args(a, kw, mode):
        """(mode, width) from wxPython's `label, mode, width, align, flags`, given by position or by name."""
        return kw.get("mode", a[0] if len(a) > 0 else mode), kw.get("width", a[1] if len(a) > 1 else -1)

    def AppendTextColumn(self, label="", *a, **kw):
        return self._wx_col(label, "text", *self._wx_col_args(a, kw, DATAVIEW_CELL_INERT))

    def AppendToggleColumn(self, label="", *a, **kw):
        return self._wx_col(label, "toggle", *self._wx_col_args(a, kw, DATAVIEW_CELL_ACTIVATABLE))

    def AppendProgressColumn(self, label="", *a, **kw):
        return self._wx_col(label, "progress", *self._wx_col_args(a, kw, DATAVIEW_CELL_INERT))

    def AppendIconTextColumn(self, label="", *a, **kw):
        return self._wx_col(label, "text", *self._wx_col_args(a, kw, DATAVIEW_CELL_INERT))

    AppendBitmapColumn = AppendDateColumn = AppendIconTextColumn
    PrependTextColumn = AppendTextColumn
    PrependToggleColumn = AppendToggleColumn

    def AppendColumn(self, col, *a):
        if isinstance(col, DataViewColumn):
            return self._wx_col(col._title, col._kind, col._mode, col._width)
        return self._wx_col(str(col), "text")

    InsertColumn = lambda self, pos, col, *a: self.AppendColumn(col)
    PrependColumn = AppendColumn

    def GetColumnCount(self):
        return len(self._cols)

    def GetColumn(self, i):
        return self._cols[i] if 0 <= i < len(self._cols) else None

    def GetColumnPosition(self, col):
        return self._cols.index(col) if col in self._cols else NOT_FOUND

    GetColumnIndex = GetColumnPosition

    def ClearColumns(self):
        self.DeleteAllItems()
        for c in self._cols:
            if c._th is not None:
                c._th.remove()
        self._cols = []
        return True

    def DeleteColumn(self, col):
        return False

    def GetSortingColumn(self):
        return None

    # cells
    def _wx_cell(self, row, c):
        col = self._cols[c]
        td = _el("td")
        v = row["values"][c]
        if col._kind == "toggle":
            box = _el("input")
            box.type = "checkbox"
            box.checked = bool(v)
            box.disabled = col._mode == DATAVIEW_CELL_INERT

            def changed(e=None, row=row, c=c, box=box):
                row["values"][c] = bool(box.checked)
                self._wx_fire(EVT_DATAVIEW_ITEM_VALUE_CHANGED, DataViewEvent(self, EVT_DATAVIEW_ITEM_VALUE_CHANGED, row, c))     # noqa: F821
            _listen(box, "change", changed)
            td.appendChild(box)
            td._box = box
        elif col._kind == "progress":
            bar = _el("progress")
            bar.max = 100
            bar.value = int(v or 0)
            td.appendChild(bar)
            td._box = bar
        elif col._mode == DATAVIEW_CELL_EDITABLE:
            box = _el("input")
            box.type = "text"
            box.value = "" if v is None else str(v)

            def edited(e=None, row=row, c=c, box=box):
                row["values"][c] = str(box.value)
                self._wx_fire(EVT_DATAVIEW_ITEM_VALUE_CHANGED, DataViewEvent(self, EVT_DATAVIEW_ITEM_VALUE_CHANGED, row, c))     # noqa: F821
                self._wx_fire(EVT_DATAVIEW_ITEM_EDITING_DONE, DataViewEvent(self, EVT_DATAVIEW_ITEM_EDITING_DONE, row, c))       # noqa: F821
            _listen(box, "change", edited)
            td.appendChild(box)
            td._box = box
        else:
            td.textContent = "" if v is None else str(v)
            td._box = None
        if col._hidden:
            td.style.display = "none"
        row["tr"].appendChild(td)
        row["tds"].append(td)

    def _wx_show(self, row, c):
        td, v, col = row["tds"][c], row["values"][c], self._cols[c]
        box = getattr(td, "_box", None)
        if col._kind == "toggle":
            box.checked = bool(v)
        elif col._kind == "progress":
            box.value = int(v or 0)
        elif box is not None:
            box.value = "" if v is None else str(v)
        else:
            td.textContent = "" if v is None else str(v)

    # rows
    def _wx_insert(self, index, values, data=None):
        values = list(values) + [""] * (len(self._cols) - len(values))
        tr = _el("tr")
        row = {"values": values[:max(len(self._cols), len(values))], "tr": tr, "tds": [], "data": data, "sel": False}
        for c in range(len(self._cols)):
            self._wx_cell(row, c)
        _listen(tr, "click", lambda e=None: self._wx_click(row, e))
        _listen(tr, "dblclick", lambda e=None: self._wx_fire(EVT_DATAVIEW_ITEM_ACTIVATED, DataViewEvent(self, EVT_DATAVIEW_ITEM_ACTIVATED, row, 0)))      # noqa: F821
        _listen(tr, "contextmenu", lambda e=None: self._wx_fire(EVT_DATAVIEW_ITEM_CONTEXT_MENU, DataViewEvent(self, EVT_DATAVIEW_ITEM_CONTEXT_MENU, row, 0)))  # noqa: F821
        index = max(0, min(index, len(self._rows)))
        if index < len(self._rows):
            self._table.insertBefore(tr, self._rows[index]["tr"])
        else:
            self._table.appendChild(tr)
        self._rows.insert(index, row)
        return row

    def _wx_click(self, row, e=None):
        more = self._multiple and e is not None and (getattr(e, "ctrlKey", False) or getattr(e, "metaKey", False) or getattr(e, "shiftKey", False))
        if more:
            self._wx_mark(row, not row["sel"])
        else:
            for r in self._rows:
                if r is not row and r["sel"]:
                    self._wx_mark(r, False)
            self._wx_mark(row, True)
        self._wx_fire(EVT_DATAVIEW_SELECTION_CHANGED, DataViewEvent(self, EVT_DATAVIEW_SELECTION_CHANGED, row, 0))     # noqa: F821

    def _wx_mark(self, row, on):
        row["sel"] = bool(on)
        if on:
            row["tr"].classList.add("sel")
        else:
            row["tr"].classList.remove("sel")

    def AppendItem(self, values, data=None):
        self._wx_insert(len(self._rows), values, data)

    def PrependItem(self, values, data=None):
        self._wx_insert(0, values, data)

    def InsertItem(self, row, values, data=None):
        self._wx_insert(row, values, data)

    def DeleteItem(self, row):
        if 0 <= row < len(self._rows):
            r = self._rows.pop(row)
            r["gone"] = True
            r["tr"].remove()

    def DeleteAllItems(self):
        for r in self._rows:
            r["gone"] = True
            r["tr"].remove()
        self._rows = []

    def GetItemCount(self):
        return len(self._rows)

    def GetStore(self):
        return self

    # a model that hands the rows over (DataViewIndexListModel, PyDataViewModel): the table is filled from it and
    # filled again whenever the model says its rows changed
    _wx_model = None

    def AssociateModel(self, model):
        old = self._wx_model
        if old is not None and self in getattr(old, "_wx_views", []):
            old._wx_views.remove(self)
        self._wx_model = model
        if model is not None:
            if not hasattr(model, "_wx_views"):
                model._wx_views = []
            model._wx_views.append(self)
        self._wx_refill()
        return True

    def GetModel(self):
        return self._wx_model

    def _wx_refill(self):
        model = self._wx_model
        chosen = [i for i, r in enumerate(self._rows) if r["sel"]]
        self.DeleteAllItems()
        if model is None:
            return
        cols = [c.GetModelColumn() if c.GetModelColumn() is not None else i for i, c in enumerate(self._cols)]
        for values, data, depth in model._wx_rows(cols):
            row = self._wx_insert(len(self._rows), ["" if v is None else v for v in values], data)
            if depth and row["tds"]:
                row["tds"][0].style.paddingLeft = f"{8 + 16 * depth}px"
        for i in chosen:
            if i < len(self._rows):
                self._wx_mark(self._rows[i], True)

    GetCount = GetItemCount

    def GetValue(self, row, col):
        row = self._wx_index(row)
        return self._rows[row]["values"][col]

    def SetValue(self, value, row, col):
        row = self._wx_index(row)
        if 0 <= row < len(self._rows) and 0 <= col < len(self._cols):
            self._rows[row]["values"][col] = value
            self._wx_show(self._rows[row], col)

    def GetTextValue(self, row, col):
        v = self.GetValue(row, col)
        return "" if v is None else str(v)

    def SetTextValue(self, value, row, col):
        self.SetValue(str(value), row, col)

    def GetToggleValue(self, row, col):
        return bool(self.GetValue(row, col))

    def SetToggleValue(self, value, row, col):
        self.SetValue(bool(value), row, col)

    def GetItemData(self, item):
        r = self._wx_rowof(item)
        return r["data"] if r is not None else None

    def SetItemData(self, item, data):
        r = self._wx_rowof(item)
        if r is not None:
            r["data"] = data

    def _wx_index(self, row):
        if isinstance(row, DataViewItem):
            return self.ItemToRow(row)
        return int(row)

    def _wx_rowof(self, item):
        if isinstance(item, DataViewItem):
            return item._row if item.IsOk() else None
        return self._rows[item] if isinstance(item, int) and 0 <= item < len(self._rows) else None

    # items and selection
    def ItemToRow(self, item):
        r = item._row if isinstance(item, DataViewItem) else None
        return self._rows.index(r) if r in self._rows else NOT_FOUND

    def RowToItem(self, row):
        return DataViewItem(self._rows[row]) if 0 <= row < len(self._rows) else DataViewItem()

    def GetSelectedRow(self):
        return next((i for i, r in enumerate(self._rows) if r["sel"]), NOT_FOUND)

    def GetSelection(self):
        return next((DataViewItem(r) for r in self._rows if r["sel"]), DataViewItem())

    GetCurrentItem = GetSelection

    def GetSelections(self):
        return [DataViewItem(r) for r in self._rows if r["sel"]]

    def GetSelectedItemsCount(self):
        return sum(1 for r in self._rows if r["sel"])

    def HasSelection(self):
        return any(r["sel"] for r in self._rows)

    def IsSelected(self, item):
        r = self._wx_rowof(item)
        return bool(r and r["sel"])

    def IsRowSelected(self, row):
        return 0 <= row < len(self._rows) and self._rows[row]["sel"]

    def Select(self, item):
        r = self._wx_rowof(item)
        if r is not None:
            if not self._multiple:
                self.UnselectAll()
            self._wx_mark(r, True)

    def SelectRow(self, row):
        self.Select(row)

    def Unselect(self, item):
        r = self._wx_rowof(item)
        if r is not None:
            self._wx_mark(r, False)

    UnselectRow = Unselect

    def SelectAll(self):
        for r in self._rows:
            self._wx_mark(r, True)

    def UnselectAll(self):
        for r in self._rows:
            if r["sel"]:
                self._wx_mark(r, False)

    def SetSelections(self, items):
        self.UnselectAll()
        for it in items:
            r = self._wx_rowof(it)
            if r is not None:
                self._wx_mark(r, True)

    def EnsureVisible(self, item, column=None):
        r = self._wx_rowof(item)
        if r is not None:
            r["tr"].scrollIntoView()

    def GetCurrentColumn(self):
        return self._cols[0] if self._cols else None

    def Expand(self, *a):
        pass

    Collapse = ExpandAncestors = EditItem = SetRowHeight = SetIndent = SetExpanderColumn = SetAlternateRowColour = Expand

    def GetChildCount(self, *a):
        return len(self._rows)

    def GetMainWindow(self):
        return self


DataViewCtrl = DataViewListCtrl
DataViewTreeCtrl = DataViewListCtrl
DataViewListStore = DataViewListCtrl


class _Model:
    """What every model shares: the views showing it, told to fill again when the rows change."""

    def _wx_changed(self, *a, **k):
        for v in list(getattr(self, "_wx_views", [])):
            try:
                v._wx_refill()
            except Exception:
                pass
        return True

    RowAppended = RowPrepended = RowInserted = RowDeleted = RowsDeleted = RowChanged = RowValueChanged = _wx_changed
    Reset = Cleared = ItemAdded = ItemsAdded = ItemDeleted = ItemsDeleted = ItemChanged = ItemsChanged = ValueChanged = Resort = _wx_changed
    AddNotifier = RemoveNotifier = IncRef = DecRef = UseWeakRefs = lambda self, *a: None
    HasDefaultCompare = lambda self: False
    IsContainer = lambda self, item: False
    GetParent = lambda self, item: NullDataViewItem
    GetAttr = lambda self, item, col, attr: False
    IsEnabled = lambda self, item, col: True
    HasContainerColumns = lambda self, item: False
    IsListModel = lambda self: False
    IsVirtualListModel = lambda self: False


class DataViewIndexListModel(_Model):
    """Rows by number: GetValueByRow(row, col) and GetCount() are the plugin's."""

    def __init__(self, rows=0):
        self._wx_count = int(rows or 0)
        self._wx_views = []

    def GetCount(self):
        return self._wx_count

    def GetRow(self, item):
        r = getattr(item, "_row", None)
        if isinstance(r, dict):
            for v in self._wx_views:
                if r in v._rows:
                    return v._rows.index(r)
            return -1
        return int(r) if isinstance(r, int) else -1

    def GetItem(self, row):
        for v in self._wx_views:
            if 0 <= row < len(v._rows):
                return DataViewItem(v._rows[row])
        return NullDataViewItem

    def Reset(self, rows=None):
        if rows is not None:
            self._wx_count = int(rows)
        return self._wx_changed()

    def GetValue(self, item, col):
        return self.GetValueByRow(self.GetRow(item), col)

    def SetValue(self, value, item, col):
        return self.SetValueByRow(value, self.GetRow(item), col)

    GetValueByRow = lambda self, row, col: ""
    SetValueByRow = lambda self, value, row, col: False
    GetAttrByRow = lambda self, row, col, attr: False
    IsListModel = lambda self: True

    def _wx_rows(self, cols):
        for r in range(int(self.GetCount() or 0)):
            values = []
            for c in cols:
                try:
                    values.append(self.GetValueByRow(r, c))
                except (IndexError, KeyError):
                    values.append("")
            yield values, None, 0


DataViewVirtualListModel = PyDataViewIndexListModel = PyDataViewVirtualListModel = DataViewIndexListModel


class PyDataViewModel(_Model):
    """Rows as a tree of the plugin's own objects: GetChildren(parent, children) and GetValue(item, col) are the
    plugin's.  The tree is shown opened out, children indented under their parent."""

    def __init__(self):
        self._wx_views = []
        self._wx_objects = {}

    def ObjectToItem(self, obj):
        if obj is None:
            return NullDataViewItem
        item = DataViewItem(id(obj))
        self._wx_objects[id(obj)] = obj
        return item

    def ItemToObject(self, item):
        r = getattr(item, "_row", None)
        if isinstance(r, dict):                       # a row of the table: the model's own item is kept with it
            return self.ItemToObject(r.get("data")) if isinstance(r.get("data"), DataViewItem) else None
        return self._wx_objects.get(r)

    GetColumnCount = lambda self: 0
    GetColumnType = lambda self, col: "string"
    GetChildren = lambda self, parent, children: 0
    GetValue = lambda self, item, col: ""
    SetValue = lambda self, value, item, col: False

    def _wx_rows(self, cols, parent=None, depth=0):
        children = []
        self.GetChildren(parent if parent is not None else NullDataViewItem, children)
        for item in children:
            values = []
            for c in cols:
                try:
                    v = self.GetValue(item, c)
                    values.append("" if v is False or v is None else v)
                except Exception:
                    values.append("")
            yield values, item, depth
            if depth < 8 and self.IsContainer(item):
                yield from self._wx_rows(cols, item, depth + 1)


DataViewModel = PyDataViewModel


class _Renderer:
    def __init__(self, *a, **k):
        pass

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda *a, **k: None


DataViewTextRenderer = DataViewToggleRenderer = DataViewProgressRenderer = DataViewIconTextRenderer = DataViewBitmapRenderer = _Renderer
DataViewChoiceRenderer = DataViewSpinRenderer = DataViewDateRenderer = DataViewCustomRenderer = DataViewRenderer = _Renderer
DataViewItemArray = list


def __getattr__(name):
    if name.startswith("__"):
        raise AttributeError(name)
    return getattr(wx, name)
