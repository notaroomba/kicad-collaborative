# again
"""KiSidian: write a note in Markdown, see it rendered in the live preview, press Save Notes; then start the plugin
again in a fresh interpreter, as on another day, and expect the note to be there."""
import os
import wx
import kc_run
from drive_util import windows, click, messages

NOTE = "# Power\n\n- check the **3V3** rail\n- R12 is 10k\n"


def after_run(_action):
    wx._run_later()
    frame = [w for w in windows() if type(w).__name__ == "LivePreviewFrame"]
    assert frame, "the KiSidian window never opened: %s" % messages()[-2:]
    frame = frame[0]
    path = os.path.join(os.getcwd(), "kisidian", "design_notes.md")
    if kc_run.RUN == 1:
        assert frame.active_file == "design_notes.md", frame.active_file
        frame.editor.SetText(NOTE)
        frame._update_preview()
        page = frame.preview.GetPageSource()
        assert type(frame.preview).__name__ == "HtmlWindow", "the preview is a %s" % type(frame.preview).__name__
        assert "<h1>Power</h1>" in page and "<strong>3V3</strong>" in page and "<li>" in page, "the preview does not show the note: %s" % page[-400:]
        assert "srcdoc" in dir(frame.preview.el) or getattr(frame.preview.el, "srcdoc", None), "the preview page was not put on screen"
        click("Save Notes", root=frame)
        assert any("saved successfully" in m for m in messages()), "no success message: %s" % messages()
        with open(path, encoding="utf-8") as f:
            assert f.read() == NOTE, "the file does not hold the note"
        return {"saved": path, "preview_bytes": len(page)}
    assert os.path.isfile(path), "the note is gone on the second run"
    assert frame.editor.GetValue() == NOTE, "the editor shows %r" % frame.editor.GetValue()[:80]
    assert "<strong>3V3</strong>" in frame.preview.GetPageSource(), "the preview does not show the saved note"
    return {"kept": True}
