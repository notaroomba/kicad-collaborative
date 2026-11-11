// review/names.ts — net names as people read them.  KiCad stores a name with its reserved characters
// escaped ("/VPP{slash}MCLR"); everything shown to a person has them back ("/VPP/MCLR").
const ESCAPES: Record<string, string> = { slash: "/", backslash: "\\", colon: ":", dblquote: '"', quote: "'", lt: "<", gt: ">", bar: "|", space: " ", tab: "\t", return: "\n", brace: "{", dollar: "$", tilde: "~", comma: "," };

export function netLabel(name: string): string {
  return name.replace(/\{([a-z]+)\}/g, (all, key: string) => ESCAPES[key] ?? all);
}
