# wx.TreeCtrl and the tree-with-columns widgets (wx.lib.agw.hypertreelist.HyperTreeList, wx.lib.gizmos.TreeListCtrl) for the
# web editor: an HTML table whose first column is indented by depth and carries the expander.
#
# Items are small objects that know their node, as the desktop's TreeItemId does, so GetSelection / GetItemParent /
# GetFirstChild compare and hash as plugin code expects.

import wx as _wx
from wx import _el, _listen, _binder, Event, Window

for _n in ("SEL_CHANGED", "SEL_CHANGING", "ITEM_ACTIVATED", "ITEM_EXPANDED", "ITEM_EXPANDING", "ITEM_COLLAPSED", "ITEM_COLLAPSING",
           "ITEM_RIGHT_CLICK", "ITEM_MENU", "BEGIN_LABEL_EDIT", "END_LABEL_EDIT", "DELETE_ITEM", "KEY_DOWN", "ITEM_GETTOOLTIP",
           "BEGIN_DRAG", "END_DRAG", "ITEM_CHECKED", "ITEM_MIDDLE_CLICK", "STATE_IMAGE_CLICK"):
    globals()["EVT_TREE_" + _n] = _binder("EVT_TREE_" + _n)

(TR_NO_BUTTONS, TR_HAS_BUTTONS, TR_NO_LINES, TR_LINES_AT_ROOT, TR_TWIST_BUTTONS, TR_SINGLE, TR_MULTIPLE, TR_HAS_VARIABLE_ROW_HEIGHT,
 TR_EDIT_LABELS, TR_ROW_LINES, TR_HIDE_ROOT, TR_FULL_ROW_HIGHLIGHT, TR_DEFAULT_STYLE, TR_EXTENDED, TR_COLUMN_LINES, TR_AUTO_CHECK_CHILD,
 TR_AUTO_CHECK_PARENT, TR_AUTO_TOGGLE_CHILD, TR_ELLIPSIZE_LONG_ITEMS, TR_VIRTUAL, TR_NO_HEADER, TR_ALIGN_WINDOWS) = (
    0x0000, 0x0001, 0x0004, 0x0008, 0x0010, 0x0000, 0x0020, 0x0080, 0x0200, 0x0400, 0x0800, 0x2000, 0x0009, 0x0040, 0x1000, 0x4000,
    0x8000, 0x10000, 0x80000, 0x100000, 0x40000, 0x20000)
(TREE_HITTEST_ABOVE, TREE_HITTEST_BELOW, TREE_HITTEST_NOWHERE, TREE_HITTEST_ONITEMBUTTON, TREE_HITTEST_ONITEMICON, TREE_HITTEST_ONITEMINDENT,
 TREE_HITTEST_ONITEMLABEL, TREE_HITTEST_ONITEMRIGHT, TREE_HITTEST_ONITEMSTATEICON, TREE_HITTEST_TOLEFT, TREE_HITTEST_TORIGHT,
 TREE_HITTEST_ONITEMUPPERPART, TREE_HITTEST_ONITEMLOWERPART) = (1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096)
TREE_HITTEST_ONITEM = TREE_HITTEST_ONITEMICON | TREE_HITTEST_ONITEMLABEL
(TreeItemIcon_Normal, TreeItemIcon_Selected, TreeItemIcon_Expanded, TreeItemIcon_SelectedExpanded) = range(4)


class TreeItemId:
    def __init__(self, node=None):
        self._node = node

    def IsOk(self):
        return self._node is not None and not self._node.get("gone")

    __bool__ = IsOk

    def GetID(self):
        return id(self._node) if self._node is not None else 0

    def __eq__(self, other):
        return isinstance(other, TreeItemId) and other._node is self._node

    def __ne__(self, other):
        return not self.__eq__(other)

    def __hash__(self):
        return id(self._node)

    # agw items carry their own accessors
    def GetText(self, column=0):
        n = self._node
        return n["text"][column] if n and column < len(n["text"]) else ""

    def GetData(self):
        return self._node["data"] if self._node else None

    def GetParent(self):
        return TreeItemId(self._node["parent"]) if self._node and self._node["parent"] is not None else TreeItemId()

    def GetChildren(self):
        return [TreeItemId(c) for c in self._node["children"]] if self._node else []

    def HasChildren(self):
        return bool(self._node and self._node["children"])

    def IsExpanded(self):
        return bool(self._node and self._node["expanded"])

    def IsSelected(self):
        return bool(self._node and self._node["sel"])


class TreeEvent(Event):
    def __init__(self, source=None, binder=None, item=None, old=None):
        Event.__init__(self, source, binder)
        self._item, self._old = item or TreeItemId(), old or TreeItemId()
        self._point = _wx.Point(0, 0)

    GetItem = lambda self: self._item
    GetOldItem = lambda self: self._old
    GetPoint = lambda self: self._point
    GetLabel = lambda self: self._item.GetText()
    IsEditCancelled = lambda self: False
    GetKeyCode = lambda self: self._wx_key
    GetToolTip = lambda self: ""
    SetToolTip = lambda self, *_: None


def _node_of(item):
    return item._node if isinstance(item, TreeItemId) else None


class TreeCtrl(Window):
    """A tree: one row per shown item, children under their parent when it is expanded."""
    _CLS = "wx-table wx-tree"

    def __init__(self, parent=None, id=-1, pos=(-1, -1), size=(-1, -1), style=TR_DEFAULT_STYLE, *more, **kw):
        agw = kw.pop("agwStyle", None)
        Window.__init__(self, parent, id, pos, size, style if agw is None else agw, *more, **kw)

    def _wx_build(self, kw):
        self._table = _el("table")
        self._head = _el("tr")
        self._head.style.display = "none"
        self._table.appendChild(self._head)
        self.el.appendChild(self._table)
        self._cols, self._col_els, self._col_widths, self._col_align = [], [], [], []
        self._root = None
        self._main_col = 0
        self._frozen = 0
        self._hit = None            # the row and column the pointer was last pressed on
        self._focus_node = None

    # ---- items

    def _wx_node(self, parent, texts, data=None):
        node = {"text": list(texts), "data": data, "children": [], "parent": parent, "expanded": False, "sel": False, "gone": False,
                "tr": _el("tr"), "tds": [], "bold": False, "fg": None, "bg": None, "exp": None}
        tr = node["tr"]
        _listen(tr, "mousedown", lambda e=None, n=node: self._wx_press(n, e))
        _listen(tr, "click", lambda e=None, n=node: self._wx_click(n, e))
        _listen(tr, "dblclick", lambda e=None, n=node: self._wx_activate(n))
        _listen(tr, "contextmenu", lambda e=None, n=node: self._wx_fire(EVT_TREE_ITEM_RIGHT_CLICK, TreeEvent(self, EVT_TREE_ITEM_RIGHT_CLICK, TreeItemId(n))))          # noqa: F821
        return node

    def _wx_depth(self, node):
        d = 0
        while node["parent"] is not None:
            d += 1
            node = node["parent"]
        return d - (1 if self._wx_style & TR_HIDE_ROOT else 0)

    def _wx_cells(self, node):
        """Bring the row's cells in line with its texts, columns, depth and look."""
        n = max(1, len(self._cols))
        while len(node["text"]) < n:
            node["text"].append("")
        tr = node["tr"]
        while len(node["tds"]) < n:
            td = _el("td")
            col = len(node["tds"])
            _listen(td, "mousedown", lambda e=None, nd=node, c=col: self.__dict__.__setitem__("_hit", (nd, c)))
            tr.appendChild(td)
            node["tds"].append(td)
        for col, td in enumerate(node["tds"]):
            if col == self._main_col:
                if node["exp"] is None:
                    node["exp"] = _el("span", "wx-tree-exp")
                    node["label"] = _el("span")
                    _listen(node["exp"], "click", lambda e=None, nd=node: self._wx_toggle(nd, e))
                    td.appendChild(node["exp"])
                    td.appendChild(node["label"])
                node["exp"].textContent = ("▾" if node["expanded"] else "▸") if node["children"] else ""
                node["label"].textContent = str(node["text"][col])
                td.style.paddingLeft = "%dpx" % (4 + 16 * max(0, self._wx_depth(node)))
            else:
                td.textContent = str(node["text"][col])
                if col < len(self._col_align) and self._col_align[col]:
                    td.style.textAlign = self._col_align[col]
            td.style.fontWeight = "600" if node["bold"] else ""
            td.style.color = node["fg"] or ""
            td.style.background = node["bg"] or ""

    def _wx_rows(self):
        """Lay the rows out again: every item whose ancestors are all expanded, in tree order."""
        if self._frozen:
            self.__dict__["_dirty"] = True
            return
        shown = []

        def visit(node, visible):
            hidden_root = node is self._root and self._wx_style & TR_HIDE_ROOT
            if visible and not hidden_root:
                shown.append(node)
            for c in node["children"]:
                visit(c, visible and (node["expanded"] or hidden_root))
        if self._root is not None:
            visit(self._root, True)
        for node in shown:
            self._wx_cells(node)
        self._table.replaceChildren(self._head, *[n["tr"] for n in shown])
        self.__dict__["_shown"] = shown

    def AddRoot(self, text="", image=-1, selImage=-1, data=None, *a, **k):
        self._root = self._wx_node(None, [str(text)], k.get("data", data))
        self._wx_rows()
        return TreeItemId(self._root)

    def InsertItem(self, parent, previous, text="", image=-1, selImage=-1, data=None, *a, **k):
        p = _node_of(parent)
        if p is None:
            return TreeItemId()
        node = self._wx_node(p, [str(text)], k.get("data", data))
        if isinstance(previous, int):
            index = max(0, min(previous, len(p["children"])))
        else:
            prev = _node_of(previous)
            index = p["children"].index(prev) + 1 if prev in p["children"] else len(p["children"])
        p["children"].insert(index, node)
        self._wx_rows()
        return TreeItemId(node)

    InsertItemBefore = InsertItem

    def AppendItem(self, parent, text="", image=-1, selImage=-1, data=None, *a, **k):
        p = _node_of(parent)
        return self.InsertItem(parent, len(p["children"]) if p else 0, text, data=k.get("data", data))

    def PrependItem(self, parent, text="", image=-1, selImage=-1, data=None, *a, **k):
        return self.InsertItem(parent, 0, text, data=k.get("data", data))

    def _wx_forget(self, node):
        node["gone"] = True
        if node["sel"]:
            node["sel"] = False
        if self._focus_node is node:
            self._focus_node = None
        for c in node["children"]:
            self._wx_forget(c)
        node["children"] = []

    def Delete(self, item):
        node = _node_of(item)
        if node is None:
            return
        self._wx_forget(node)
        if node["parent"] is not None:
            node["parent"]["children"].remove(node)
        elif node is self._root:
            self._root = None
        self._wx_rows()

    def DeleteChildren(self, item):
        node = _node_of(item)
        if node is None:
            return
        for c in node["children"]:
            self._wx_forget(c)
        node["children"] = []
        self._wx_rows()

    def DeleteAllItems(self):
        if self._root is not None:
            self._wx_forget(self._root)
        self._root = None
        self._wx_rows()

    DeleteRoot = DeleteAllItems

    # ---- reading the tree

    def GetRootItem(self):
        return TreeItemId(self._root)

    def GetItemParent(self, item):
        node = _node_of(item)
        return TreeItemId(node["parent"]) if node and node["parent"] is not None else TreeItemId()

    GetParentItem = GetItemParent

    def ItemHasChildren(self, item):
        node = _node_of(item)
        return bool(node and node["children"])

    HasChildren = ItemHasChildren

    def SetItemHasChildren(self, item, has=True):
        pass

    def GetChildrenCount(self, item, recursively=True):
        node = _node_of(item)
        if node is None:
            return 0
        if not recursively:
            return len(node["children"])
        return sum(1 + self.GetChildrenCount(TreeItemId(c), True) for c in node["children"])

    def GetCount(self):
        return (1 + self.GetChildrenCount(TreeItemId(self._root))) if self._root is not None else 0

    def GetFirstChild(self, item):
        node = _node_of(item)
        if node and node["children"]:
            return TreeItemId(node["children"][0]), 1
        return TreeItemId(), 0

    def GetNextChild(self, item, cookie):
        node = _node_of(item)
        if node and isinstance(cookie, int) and 0 <= cookie < len(node["children"]):
            return TreeItemId(node["children"][cookie]), cookie + 1
        return TreeItemId(), cookie

    def GetLastChild(self, item):
        node = _node_of(item)
        return TreeItemId(node["children"][-1]) if node and node["children"] else TreeItemId()

    def _wx_sibling(self, item, step):
        node = _node_of(item)
        if node is None or node["parent"] is None:
            return TreeItemId()
        kids = node["parent"]["children"]
        i = kids.index(node) + step
        return TreeItemId(kids[i]) if 0 <= i < len(kids) else TreeItemId()

    GetNextSibling = lambda self, item: self._wx_sibling(item, 1)
    GetPrevSibling = lambda self, item: self._wx_sibling(item, -1)

    def _wx_visible(self):
        return list(self.__dict__.get("_shown", []))

    def GetFirstVisibleItem(self):
        shown = self._wx_visible()
        return TreeItemId(shown[0]) if shown else TreeItemId()

    def _wx_step_visible(self, item, step):
        shown = self._wx_visible()
        node = _node_of(item)
        if node in shown:
            i = shown.index(node) + step
            if 0 <= i < len(shown):
                return TreeItemId(shown[i])
        return TreeItemId()

    GetNextVisible = GetNext = lambda self, item: self._wx_step_visible(item, 1)
    GetPrevVisible = GetPrev = lambda self, item: self._wx_step_visible(item, -1)
    IsVisible = lambda self, item: _node_of(item) in self._wx_visible()

    # ---- an item's text, data and look

    def GetItemText(self, item, column=0):
        node = _node_of(item)
        return node["text"][column] if node and 0 <= column < len(node["text"]) else ""

    def SetItemText(self, item, text, column=0):
        node = _node_of(item)
        if node is None:
            return
        if not isinstance(text, str) and isinstance(column, str):       # TreeListCtrl's order: (item, column, text)
            text, column = column, text
        while len(node["text"]) <= column:
            node["text"].append("")
        node["text"][column] = str(text)
        if node["tds"] and not self._frozen:
            self._wx_cells(node)

    def GetItemData(self, item):
        node = _node_of(item)
        return node["data"] if node else None

    def SetItemData(self, item, data):
        node = _node_of(item)
        if node is not None:
            node["data"] = data

    GetPyData = GetItemPyData = GetItemData
    SetPyData = SetItemPyData = SetItemData

    def _wx_look(self, item, key, value):
        node = _node_of(item)
        if node is not None:
            node[key] = value
            if node["tds"] and not self._frozen:
                self._wx_cells(node)

    def SetItemBold(self, item, bold=True):
        self._wx_look(item, "bold", bool(bold))

    def IsBold(self, item):
        node = _node_of(item)
        return bool(node and node["bold"])

    def SetItemTextColour(self, item, colour):
        self._wx_look(item, "fg", _wx.Colour(colour).GetAsString() if colour is not None else None)

    def SetItemBackgroundColour(self, item, colour, *_):
        self._wx_look(item, "bg", _wx.Colour(colour).GetAsString() if colour is not None else None)

    def GetItemTextColour(self, item):
        node = _node_of(item)
        return _wx.Colour(node["fg"]) if node and node["fg"] else self.GetForegroundColour()

    def GetItemBackgroundColour(self, item):
        node = _node_of(item)
        return _wx.Colour(node["bg"]) if node and node["bg"] else self.GetBackgroundColour()

    SetItemFont = SetItemImage = SetItemDropHighlight = SetItemWindow = SetItemHyperText = SetItemState = lambda self, *a, **k: None
    GetItemImage = lambda self, *a, **k: -1
    AssignImageList = SetImageList = AssignStateImageList = SetStateImageList = SetIndent = SetSpacing = lambda self, *a, **k: None
    GetImageList = lambda self: None
    GetIndent = lambda self: 16

    # ---- expanding

    def _wx_set_expanded(self, node, on, tell=True):
        if node is None or node["expanded"] == on:
            return
        node["expanded"] = on
        self._wx_rows()
        if tell:
            b = EVT_TREE_ITEM_EXPANDED if on else EVT_TREE_ITEM_COLLAPSED          # noqa: F821
            self._wx_fire(b, TreeEvent(self, b, TreeItemId(node)))

    def _wx_toggle(self, node, e=None):
        if e is not None and _wx._DOM:
            try:
                e.stopPropagation()
            except Exception:
                pass
        self._wx_set_expanded(node, not node["expanded"])

    def Expand(self, item):
        self._wx_set_expanded(_node_of(item), True)

    def Collapse(self, item):
        self._wx_set_expanded(_node_of(item), False)

    def Toggle(self, item):
        node = _node_of(item)
        if node is not None:
            self._wx_set_expanded(node, not node["expanded"])

    def IsExpanded(self, item):
        node = _node_of(item)
        return bool(node and node["expanded"])

    def _wx_all(self, node, on):
        node["expanded"] = on and bool(node["children"])
        for c in node["children"]:
            self._wx_all(c, on)

    def ExpandAll(self, item=None):
        node = _node_of(item) if item is not None else self._root
        if node is not None:
            self._wx_all(node, True)
            self._wx_rows()

    ExpandAllChildren = ExpandAll

    def CollapseAll(self, item=None):
        node = _node_of(item) if item is not None else self._root
        if node is not None:
            self._wx_all(node, False)
            self._wx_rows()

    CollapseAllChildren = CollapseAll

    def CollapseAndReset(self, item):
        self.Collapse(item)
        self.DeleteChildren(item)

    # ---- selection

    def _wx_selected(self):
        out = []

        def visit(node):
            if node["sel"]:
                out.append(node)
            for c in node["children"]:
                visit(c)
        if self._root is not None:
            visit(self._root)
        return out

    def _wx_select(self, node, on=True, tell=True, keep=False):
        old = self._focus_node
        if on and not keep:
            for other in self._wx_selected():
                if other is not node:
                    other["sel"] = False
                    other["tr"].classList.remove("sel")
        changed = node["sel"] != on
        node["sel"] = on
        if on:
            node["tr"].classList.add("sel")
            self._focus_node = node
        else:
            node["tr"].classList.remove("sel")
        if tell and (changed or old is not node):
            self._wx_fire(EVT_TREE_SEL_CHANGED, TreeEvent(self, EVT_TREE_SEL_CHANGED, TreeItemId(node), TreeItemId(old)))          # noqa: F821

    def SelectItem(self, item, select=True, *_):
        node = _node_of(item)
        if node is not None and not node["gone"]:
            self._wx_select(node, bool(select), keep=bool(self._wx_style & TR_MULTIPLE))

    def Unselect(self):
        for node in self._wx_selected():
            self._wx_select(node, False, tell=False)

    UnselectAll = Unselect

    def UnselectItem(self, item):
        node = _node_of(item)
        if node is not None:
            self._wx_select(node, False)

    def ToggleItemSelection(self, item):
        node = _node_of(item)
        if node is not None:
            self._wx_select(node, not node["sel"], keep=True)

    def GetSelection(self):
        sel = self._wx_selected()
        return TreeItemId(sel[0]) if sel else TreeItemId()

    def GetSelections(self):
        return [TreeItemId(n) for n in self._wx_selected()]

    def IsSelected(self, item):
        node = _node_of(item)
        return bool(node and node["sel"])

    def GetFocusedItem(self):
        return TreeItemId(self._focus_node)

    GetCurrentItem = GetFocusedItem

    def SetFocusedItem(self, item):
        self._focus_node = _node_of(item)

    def EnsureVisible(self, item):
        node = _node_of(item)
        if node is None:
            return
        p, changed = node["parent"], False
        while p is not None:
            if not p["expanded"]:
                p["expanded"], changed = True, True
            p = p["parent"]
        if changed:
            self._wx_rows()
        try:
            node["tr"].scrollIntoView()
        except Exception:
            pass

    ScrollTo = EnsureVisible

    # ---- the pointer

    def _wx_press(self, node, e=None):
        if self._hit is None or self._hit[0] is not node:
            self._hit = (node, 0)

    def _wx_click(self, node, e=None):
        keep = False
        if e is not None and _wx._DOM and self._wx_style & TR_MULTIPLE:
            try:
                keep = bool(e.ctrlKey or e.metaKey)
            except Exception:
                keep = False
        self._wx_select(node, not (keep and node["sel"]), keep=keep)

    def _wx_activate(self, node):
        if not self._wx_fire(EVT_TREE_ITEM_ACTIVATED, TreeEvent(self, EVT_TREE_ITEM_ACTIVATED, TreeItemId(node))) and node["children"]:          # noqa: F821
            self._wx_toggle(node)

    def _wx_at(self, point):
        """The row and column under a point given in this window's coordinates."""
        x, y = (point.x, point.y) if hasattr(point, "x") else (point[0], point[1])
        if _wx._DOM:
            try:
                box = self.el.getBoundingClientRect()
                for node in self._wx_visible():
                    r = node["tr"].getBoundingClientRect()
                    if r.top - box.top <= y < r.bottom - box.top:
                        col = 0
                        for i, td in enumerate(node["tds"]):
                            c = td.getBoundingClientRect()
                            if c.left - box.left <= x < c.right - box.left:
                                col = i
                        return node, col
                return None, -1
            except Exception:
                pass
        return self._hit if self._hit is not None and not self._hit[0]["gone"] else (None, -1)

    def HitTest(self, point, *_):
        node, _col = self._wx_at(point)
        return (TreeItemId(node), TREE_HITTEST_ONITEMLABEL if node is not None else TREE_HITTEST_NOWHERE)

    def GetBoundingRect(self, item, textOnly=False):
        node = _node_of(item)
        if node is not None and _wx._DOM:
            try:
                box, r = self.el.getBoundingClientRect(), node["tr"].getBoundingClientRect()
                return _wx.Rect(int(r.left - box.left), int(r.top - box.top), int(r.width), int(r.height))
            except Exception:
                pass
        shown = self._wx_visible()
        return _wx.Rect(0, 20 * shown.index(node), 200, 20) if node in shown else _wx.Rect(0, 0, 0, 0)

    def Freeze(self):
        self._frozen += 1

    def Thaw(self):
        self._frozen = max(0, self._frozen - 1)
        if not self._frozen and self.__dict__.pop("_dirty", False):
            self._wx_rows()

    IsFrozen = lambda self: self._frozen > 0
    EditLabel = EndEditLabel = SortChildren = lambda self, *a, **k: None
    GetViewStart = lambda self: (int(getattr(self.el, "scrollLeft", 0) or 0), int(getattr(self.el, "scrollTop", 0) or 0))

    def Scroll(self, x=-1, y=-1):
        if isinstance(x, (tuple, list)):
            x, y = x
        try:
            if x is not None and x >= 0:
                self.el.scrollLeft = int(x)
            if y is not None and y >= 0:
                self.el.scrollTop = int(y)
        except Exception:
            pass

    def GetAGWWindowStyleFlag(self):
        return self._wx_style

    def SetAGWWindowStyleFlag(self, style):
        self._wx_style = int(style)
        self._wx_rows()

    GetWindowStyleFlag, SetWindowStyleFlag = GetAGWWindowStyleFlag, SetAGWWindowStyleFlag
    GetWindowStyle, SetWindowStyle = GetAGWWindowStyleFlag, SetAGWWindowStyleFlag


class _TreeMain(Window):
    """What GetMainWindow() of a tree with columns returns: the part with the rows.  Here that is the tree itself, so
    the mouse events a plugin binds on it are the tree's, and a hit test also tells the column."""

    def __init__(self, tree):
        self.__dict__["_tree"] = tree

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return getattr(self.__dict__["_tree"], name)

    def __setattr__(self, name, value):
        setattr(self.__dict__["_tree"], name, value)

    def HitTest(self, point, *_):
        tree = self.__dict__["_tree"]
        node, col = tree._wx_at(point)
        return (TreeItemId(node), TREE_HITTEST_ONITEMLABEL if node is not None else TREE_HITTEST_NOWHERE, col)

    def Bind(self, *a, **k):
        return self.__dict__["_tree"].Bind(*a, **k)


class TreeListColumnInfo:
    def __init__(self, text="", width=100, flag=0, image=-1, shown=True, colour=None, edit=False):
        self._text, self._width, self._flag, self._shown = text, width, flag, shown

    GetText = lambda self: self._text
    GetWidth = lambda self: self._width
    GetAlignment = lambda self: self._flag
    IsShown = lambda self: self._shown


class HyperTreeList(TreeCtrl):
    """A tree whose items have a text in each of several columns, under a heading row."""

    def __init__(self, parent=None, id=-1, pos=(-1, -1), size=(-1, -1), style=0, agwStyle=TR_DEFAULT_STYLE, *more, **kw):
        TreeCtrl.__init__(self, parent, id, pos, size, style, *more, agwStyle=agwStyle, **kw)

    def AddColumn(self, text="", width=100, flag=0, image=-1, shown=True, colour=None, edit=False, *a, **k):
        return self.InsertColumn(len(self._cols), text, width, flag, image, shown)

    AppendColumn = AddColumn

    def AddColumnInfo(self, info):
        return self.InsertColumn(len(self._cols), info._text, info._width, info._flag, -1, info._shown)

    def InsertColumn(self, before, text="", width=100, flag=0, image=-1, shown=True, *a, **k):
        if isinstance(text, TreeListColumnInfo):
            text, width, flag, shown = text._text, text._width, text._flag, text._shown
        th = _el("th")
        th.textContent = str(text)
        before = max(0, min(int(before), len(self._cols)))
        self._cols.insert(before, str(text))
        self._col_els.insert(before, th)
        self._col_widths.insert(before, -1)
        self._col_align.insert(before, "right" if flag & _wx.ALIGN_RIGHT else ("center" if flag & _wx.ALIGN_CENTER_HORIZONTAL else ""))
        if self._col_align[before]:
            th.style.textAlign = self._col_align[before]
        self._head.replaceChildren(*self._col_els)
        self._head.style.display = "none" if self._wx_style & TR_NO_HEADER else ""
        self.SetColumnWidth(before, width)
        if not shown:
            th.style.display = "none"
        self._wx_rows()
        return before

    def RemoveColumn(self, col):
        if 0 <= col < len(self._cols):
            for seq in (self._cols, self._col_els, self._col_widths, self._col_align):
                del seq[col]
            self._head.replaceChildren(*self._col_els)
            self._wx_rows()

    def GetColumnCount(self):
        return len(self._cols)

    def SetColumnWidth(self, col, width):
        if 0 <= col < len(self._cols):
            self._col_widths[col] = int(width)
            self._col_els[col].style.minWidth = "%dpx" % int(width) if width and width > 0 else ""

    def GetColumnWidth(self, col):
        return self._col_widths[col] if 0 <= col < len(self._cols) and self._col_widths[col] > 0 else 80

    def GetColumnText(self, col):
        return self._cols[col] if 0 <= col < len(self._cols) else ""

    def SetColumnText(self, col, text):
        if 0 <= col < len(self._cols):
            self._cols[col] = str(text)
            self._col_els[col].textContent = str(text)

    def SetColumnAlignment(self, col, flag):
        if 0 <= col < len(self._cols):
            self._col_align[col] = "right" if flag & _wx.ALIGN_RIGHT else ("center" if flag & _wx.ALIGN_CENTER_HORIZONTAL else "")
            self._wx_rows()

    def SetMainColumn(self, col):
        self._main_col = int(col)
        self._wx_rows()

    GetMainColumn = lambda self: self._main_col
    SetColumnShown = SetColumnEditable = SetColumnImage = SetColumnColour = lambda self, *a, **k: None
    IsColumnShown = lambda self, col: True

    def GetMainWindow(self):
        main = self.__dict__.get("_main_window")
        if main is None:
            main = self.__dict__["_main_window"] = _TreeMain(self)
        return main

    def GetHeaderWindow(self):
        return self.GetMainWindow()

    def HitTest(self, point, *_):
        node, col = self._wx_at(point)
        return (TreeItemId(node), TREE_HITTEST_ONITEMLABEL if node is not None else TREE_HITTEST_NOWHERE, col)


TreeListCtrl = HyperTreeList
CustomTreeCtrl = TreeCtrl
GenericTreeCtrl = TreeCtrl
TreeItemData = lambda data=None: data
