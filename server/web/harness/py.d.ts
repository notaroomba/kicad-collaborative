// The Python harness package is bundled into the sandbox program as text (esbuild --loader:.py=text).
declare module "*.py" {
  const text: string;
  export default text;
}
