# again
"""KiNotes: write a line into the notes, tick the first task, close the window, and expect both saved in the project's
.kinotes folder. Then start the plugin again in a fresh interpreter, as on the next day, and expect the note and the
ticked task back: a plugin's own hidden files beside the board are kept between runs."""
import json
import os
import wx
import kc_run
from drive_util import windows, find_all, tick

NOTE = "Check the clearance between C2 and the valve socket."
FOLDER = "/project/.kinotes"


def after_run(_action):
    wx._run_later()
    frame = [w for w in windows() if type(w).__name__ == "KiNotesFrame"]
    assert frame, "the KiNotes window never opened"
    frame = frame[0]
    editor = [c for c in find_all(root=frame) if type(c).__name__ == "VisualNoteEditor"][0]
    boxes = [c for c in find_all(wx.CheckBox, root=frame) if not c.GetLabel()]
    assert len(boxes) >= 3, "the task list is missing"
    if kc_run.RUN == 1:
        assert NOTE not in editor.GetValue(), "the note is already there on the first run"
        editor.SetValue(editor.GetValue().rstrip() + "\n\n" + NOTE + "\n")
        tick(boxes[0], True)
        frame.Close()
        wx._run_later()
        with open(os.path.join(FOLDER, "KiNotes_project.md"), encoding="utf-8") as f:
            saved = f.read()
        assert NOTE in saved, "the note was not saved:\n%s" % saved[-300:]
        with open(os.path.join(FOLDER, "todos.json"), encoding="utf-8") as f:
            todos = json.load(f)
        done = [t for t in (todos if isinstance(todos, list) else todos.get("todos", [])) if t.get("done") or t.get("completed") or t.get("checked")]
        assert len(done) == 1, "the ticked task was not saved: %s" % json.dumps(todos)[:300]
        return {"saved": sorted(os.listdir(FOLDER))}
    assert NOTE in editor.GetValue(), "the note did not come back on the second run:\n%s" % editor.GetValue()[-300:]
    assert boxes[0].GetValue() and not boxes[1].GetValue(), "the ticked task did not come back"
    frame.Close()
    wx._run_later()
    return {"note_back": True, "task_back": True}
