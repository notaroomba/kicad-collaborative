// opentype.js ships no types; web/fab/outline-font.ts declares the few members it uses.
declare module "opentype.js" {
  const opentype: { parse(buffer: ArrayBuffer): unknown };
  export default opentype;
}
