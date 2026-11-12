import type { SchCtx } from "./types";

/** What the image picker hands back: the file's name and bytes, or its base64 text. */
export interface ImageFile { name?: string; bytes?: Uint8Array; base64?: string }
/** The image picker: done(file) or done(null). */
export type ImagePickerFn = (ctx: SchCtx, done: (file: ImageFile | null) => void) => void;
import { startCarry } from "./carry";
import { hasDom } from "./dom";
import { IMAGE_PPI, base64ToBytes, bytesToBase64, imageNode, imageSize } from "./nodes";
import { S } from "./state";

// ---------------------------------------------------------------- images (a file picker, then the bitmap rides on the cursor)
// done({ name, bytes }) or done({ base64 }) — or done(null).  Swappable for tests, like the prompt.
export let imagePickerImpl: ImagePickerFn = function (ctx, done) {
  if (!hasDom()) { done(null); return; }
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/png,image/jpeg"; inp.style.display = "none"; inp.dataset.schtools = "1";
  document.body.appendChild(inp);
  let sent = false; const finish = (v: ImageFile | null) => { if (sent) return; sent = true; inp.remove(); done(v); };
  inp.addEventListener("change", () => { const f = inp.files && inp.files[0]; if (!f) { finish(null); return; } f.arrayBuffer().then((buf) => finish({ name: f.name, bytes: new Uint8Array(buf) })).catch(() => finish(null)); });
  inp.addEventListener("cancel", () => finish(null));
  // a dismissed dialog fires no change in older browsers: once focus is back and nothing was chosen, give up
  window.addEventListener("focus", () => setTimeout(() => { if (!inp.files || !inp.files.length) finish(null); }, 800), { once: true });
  inp.click();
};
/** CollabTools.sch.setImagePicker: swap the file picker (tests). */
export function setImagePickerImpl(fn: ImagePickerFn) { imagePickerImpl = fn; }
export function openImagePicker(ctx: SchCtx) {
  if (S.imageWait) return; S.imageWait = true;
  imagePickerImpl(ctx, (file) => {
    S.imageWait = false;
    if (!file || S.tool !== "image") return;
    const bytes = file.bytes || (file.base64 ? base64ToBytes(file.base64) : null);
    const base64 = file.base64 || (bytes ? bytesToBase64(bytes) : "");
    if (!base64) { ctx.toast("Could not read the image"); return; }
    const px = bytes ? imageSize(bytes) : null;               // drawn at BITMAP_BASE's 300 PPI
    startCarry(ctx, "image", imageNode(S.cursor || [0, 0], base64), S.cursor);
    if (S.carry) S.carry.size = px ? [px[0] * 25.4 / IMAGE_PPI, px[1] * 25.4 / IMAGE_PPI] : [20, 20];
  });
}
