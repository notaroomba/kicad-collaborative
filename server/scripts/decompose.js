// decompose.js — split one IIFE-style browser module into ES modules (.ts) with generated imports.
//
//   node scripts/decompose.js <input.js> <outdir> <plan.json>
//
// The input is `(function (root) { "use strict"; …statements…; root.NAME = {…}; })(…)`.  Every
// top-level statement is assigned to a module by the plan (name regexes first, then the section
// line ranges, then `default`), declarations are exported, and each module imports the top-level
// names it references from the modules that declare them (TypeScript's parser finds the
// references, so `a.b` property names and object keys are not mistaken for identifiers).  The
// `root.NAME = {…}` statement and everything after it become index.ts.  Nothing is rewritten
// inside statements — this is a move, not a refactor — so the rebuilt bundle behaves exactly
// like the original file.
"use strict";
const fs = require("fs"), path = require("path"), ts = require("typescript");
const [,, input, outdir, planFile] = process.argv;
if (!input || !outdir || !planFile) { console.error("usage: decompose.js <input.js> <outdir> <plan.json>"); process.exit(2); }
const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
let text = fs.readFileSync(input, "utf8");
let stateInits = [];   // [name, initializerText] for plan.state mode

// ---- state mode: top-level `let`s become properties of one exported object (E) — references are
// rewritten with the language service, which respects scopes (a local `tool` inside a function
// shadowing the top-level one is left alone) and expands shorthand properties ({ selected } →
// { selected: E.selected }).
if (plan.state) {
  const sf0 = ts.createSourceFile(input, text, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
  const host = { getScriptFileNames: () => [input], getScriptVersion: () => "1", getScriptSnapshot: (f) => f === input ? ts.ScriptSnapshot.fromString(text) : undefined,
    getCurrentDirectory: () => process.cwd(), getCompilationSettings: () => ({ allowJs: true, target: ts.ScriptTarget.ES2020, noLib: true }), getDefaultLibFileName: () => "lib.d.ts", fileExists: () => false, readFile: () => undefined };
  const ls = ts.createLanguageService(host, ts.createDocumentRegistry());
  const edits = [];   // {start, end, text}
  for (const st of sf0.statements) {
    if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Let)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) { console.error("destructured top-level let not supported:", d.getText(sf0)); process.exit(1); }
      const name = d.name.text; stateInits.push([name, d.initializer ? d.initializer.getText(sf0) : "undefined"]);
      const locs = ls.findRenameLocations(input, d.name.getStart(sf0), false, false, true) || [];
      for (const l of locs) { if (l.textSpan.start === d.name.getStart(sf0)) continue; edits.push({ start: l.textSpan.start, end: l.textSpan.start + l.textSpan.length, text: (l.prefixText || "") + plan.state + "." + name + (l.suffixText || "") }); }
    }
    const removed = text.slice(st.getFullStart(), st.getEnd()); const nl = (removed.match(/\n/g) || []).length;
    edits.push({ start: st.getFullStart(), end: st.getEnd(), text: "\n".repeat(nl) });   // the declaration goes away; line numbers stay put for the plan's ranges
  }
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end);
}
const sf = ts.createSourceFile(input, text, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);

// ---- locate the IIFE body
let body = null, rootParam = "root";
for (const st of sf.statements) {
  if (!ts.isExpressionStatement(st)) continue;
  let e = st.expression; while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isCallExpression(e)) { let c = e.expression; while (ts.isParenthesizedExpression(c)) c = c.expression; if (ts.isFunctionExpression(c)) { body = c.body; if (c.parameters[0]) rootParam = c.parameters[0].name.getText(sf); break; } }
}
const plainScript = !body;
if (plainScript) rootParam = "window";
const stmts = (plainScript ? sf.statements : body.statements).filter((s) => !(ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression)));   // drop "use strict"
const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

// ---- declared names per statement
function bindingNames(name, out) {
  if (ts.isIdentifier(name)) out.push(name.text);
  else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
}
const units = stmts.map((st, i) => {
  const names = [];
  if (ts.isFunctionDeclaration(st) && st.name) names.push(st.name.text);
  else if (ts.isClassDeclaration(st) && st.name) names.push(st.name.text);
  else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) bindingNames(d.name, names);
  const start = st.getFullStart(), end = st.getEnd();
  return { i, st, names, start, end, line: lineOf(st.getStart(sf)), text: text.slice(start, end) };
});
const declaredBy = new Map(); for (const u of units) for (const n of u.names) declaredBy.set(n, u);

// ---- module assignment
function moduleFor(u) {
  if (plan.index && u.line >= plan.index.from && u.line <= plan.index.to) return "index";
  if (!plainScript && ts.isExpressionStatement(u.st) && ts.isBinaryExpression(u.st.expression) && u.st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const l = u.st.expression.left; if (ts.isPropertyAccessExpression(l) && l.expression.getText(sf) === rootParam) return "index";
  }
  if (!u.names.length) for (const b of plan.bare || []) if (u.line >= b.from && u.line <= b.to) return b.module;
  for (const [mod, pats] of Object.entries(plan.modules || {})) for (const p of pats) { const re = new RegExp(p); if (u.names.some((n) => re.test(n))) return mod; }
  for (const s of plan.sections || []) if (u.line >= s.from && u.line <= s.to) return s.module;
  return plan.default || "misc";
}
let indexSeen = false;
for (const u of units) {
  let m = moduleFor(u);
  if (m === "index") indexSeen = true; else if (indexSeen && !plainScript) m = "index";   // an IIFE's export block and everything after it stay together
  if (!u.names.length && m !== "index" && !(plan.bare || []).some((b) => u.line >= b.from && u.line <= b.to)) {
    // a bare statement (listener registration, global assignment) runs at load: a plain script's go to the boot
    // module so every module has evaluated first; an IIFE's ride with the declaration above
    m = plainScript ? (plan.bareDefault || "index") : (u.i > 0 ? units[u.i - 1].module || m : m);
  }
  u.module = m;
}

// ---- references: identifiers that are not property names / object keys / declaration names
function refsOf(node, out) {
  if (ts.isIdentifier(node)) {
    const p = node.parent;
    if (ts.isPropertyAccessExpression(p) && p.name === node) return;
    if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) && p.name === node) return;
    if (ts.isBindingElement(p) && p.propertyName === node) return;
    if ((ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isParameter(p) || ts.isVariableDeclaration(p)) && p.name === node) return;
    out.add(node.text); return;
  }
  ts.forEachChild(node, (c) => refsOf(c, out));
}
for (const u of units) { const s = new Set(); refsOf(u.st, s); u.refs = s; }

// ---- emit
const modules = new Map();
for (const u of units) { if (!modules.has(u.module)) modules.set(u.module, []); modules.get(u.module).push(u); }
const envName = plan.env || "env";
function exportify(u) {
  let t = u.text; if (!u.st) return t;   // synthetic statements (the api exposure) are emitted verbatim
  if (ts.isFunctionDeclaration(u.st) || ts.isClassDeclaration(u.st) || ts.isVariableStatement(u.st)) {
    const declStart = u.st.getStart(sf) - u.start;
    t = t.slice(0, declStart) + "export " + t.slice(declStart);
  }
  return t;
}
fs.mkdirSync(outdir, { recursive: true });
const header = (plan.header || "").split("\n").map((l) => "// " + l).join("\n");
let written = [];
const stateMod = plan.state ? (plan.stateModule || "state") : null;
if (plan.state) {
  // the state object: initialisers keep their original text (they may reference top-level consts — imported below)
  const s0 = ts.createSourceFile("inits.js", "const _ = {" + stateInits.map(([n, i]) => n + ": " + i).join(", ") + "};", ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
  const refs = new Set(); refsOf(s0, refs);
  const need = new Map();
  for (const r of refs) { const d = declaredBy.get(r); if (!d) continue; if (!need.has(d.module)) need.set(d.module, new Set()); need.get(d.module).add(r); }
  const imports = [...need].sort().map(([src, names]) => `import { ${[...names].sort().join(", ")} } from "./${src}";`);
  const lines = stateInits.map(([n, i]) => `  ${n}: ${i},`).join("\n");
  fs.writeFileSync(path.join(outdir, stateMod + ".ts"), `${header}\n${plan.nocheck ? "// @ts-nocheck\n" : ""}${imports.join("\n")}${imports.length ? "\n" : ""}/** The editor's mutable state — every former top-level \`let\` of the original script, referenced as ${plan.state}.<name>. */\nexport const ${plan.state}: any = {\n${lines}\n};\n${plan.expose ? `(typeof window !== "undefined" ? window : globalThis)["${plan.expose}"] = ${plan.state};\n` : ""}`);
  declaredBy.set(plan.state, { module: stateMod, names: [plan.state] });
  written.push([stateMod, stateInits.length, stateInits.length + 3]);
}
for (const [mod, list] of modules) {
  const own = new Set(list.flatMap((u) => u.names));
  const need = new Map();   // source module → Set(names)
  let usesRoot = false;
  for (const u of list) for (const r of u.refs) {
    if (r === rootParam) { usesRoot = true; continue; }
    if (own.has(r)) continue;
    const d = declaredBy.get(r); if (!d || d.module === mod) continue;
    if (!need.has(d.module)) need.set(d.module, new Set()); need.get(d.module).add(r);
  }
  const imports = [];
  if (usesRoot && !plainScript) imports.push(`import { ${rootParam} } from "./${envName}";`);   // a plain script's `window` is the real global
  for (const [src, names] of [...need].sort()) imports.push(`import { ${[...names].sort().join(", ")} } from "./${src}";`);
  let bodyText;
  if (mod === "index" && plainScript) {
    // a plain script's index: import every other module for its side effects, in the original order, then the boot statements
    const order = [...modules.keys()].filter((m) => m !== "index");
    imports.unshift(...order.map((m) => `import "./${m}";`));
    // plan.api: functions/consts re-exposed on the state object for tests and tooling (E.api.worldMm, …)
    if (plan.api && plan.state) {
      const byMod = new Map();
      for (const n of plan.api) { const d = declaredBy.get(n); if (!d) { console.error("api name not found:", n); process.exit(1); } if (!byMod.has(d.module)) byMod.set(d.module, []); byMod.get(d.module).push(n); }
      for (const [m, names] of byMod) imports.push(`import { ${names.sort().join(", ")} } from "./${m}";`);
      const st = declaredBy.get(plan.state); imports.push(`import { ${plan.state} } from "./${st.module}";`);
      list.push({ text: `\n// exposed for tests and tooling (window.${plan.expose || plan.state}.api)\n${plan.state}.api = { ${plan.api.slice().sort().join(", ")} };`, st: null, names: [], refs: new Set() });
    }
  }
  if (mod === "index" && !plainScript) {
    // `root.NAME = {…}` → `const api = {…}; root.NAME = api;` then the remaining statements
    bodyText = list.map((u) => {
      if (ts.isExpressionStatement(u.st) && ts.isBinaryExpression(u.st.expression) && ts.isPropertyAccessExpression(u.st.expression.left) && u.st.expression.left.expression.getText(sf) === rootParam) {
        const rhsStart = u.st.expression.right.getStart(sf) - u.start; const lead = u.text.slice(0, u.st.getStart(sf) - u.start);
        return lead + "export const api = " + u.text.slice(rhsStart) + `\n${rootParam}.${u.st.expression.left.name.text} = api;`;
      }
      return u.text;
    }).join("\n");
  } else bodyText = list.map(exportify).join("\n");
  const file = path.join(outdir, mod + ".ts");
  const nocheck = plan.nocheck ? "// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module\n" : "";
  fs.writeFileSync(file, `${header}\n${nocheck}${imports.join("\n")}${imports.length ? "\n" : ""}${bodyText.replace(/^\n+/, "")}\n`);
  written.push([mod, list.length, list.reduce((n, u) => n + u.text.split("\n").length, 0)]);
}
// env module: the IIFE's `root` parameter
if (!plainScript) fs.writeFileSync(path.join(outdir, envName + ".ts"), `${header}\n/** The IIFE's former \`${rootParam}\` parameter: window in a browser, globalThis under node. */\nexport const ${rootParam}: any = typeof window !== "undefined" ? window : globalThis;\n`);
// import graph (for cycle checks)
const graph = {};
for (const [mod, list] of modules) { graph[mod] = new Set(); for (const u of list) for (const r of u.refs) { const d = declaredBy.get(r); if (d && d.module !== mod) graph[mod].add(d.module); } }
const cycles = [];
for (const a of Object.keys(graph)) for (const b of graph[a]) if (graph[b] && graph[b].has(a) && a < b) cycles.push(a + " <-> " + b);
console.log("modules:", written.map(([m, n, l]) => `${m} (${n} stmts, ${l} lines)`).join(", "));
console.log("import cycles:", cycles.length ? cycles.join("; ") : "none");
const unassigned = units.filter((u) => !u.module); if (unassigned.length) console.log("UNASSIGNED", unassigned.length);
