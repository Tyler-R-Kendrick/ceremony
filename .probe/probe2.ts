import { parseBoundedDocument } from "/home/user/ceremony/src/server/connectors/import/parse.js";
const enc = (s: string) => new TextEncoder().encode(s);
const cases: Array<[string, string, Record<string, unknown>?]> = [
  ["json dup key", '{"a":1,"a":2}'],
  ["json escaped proto key", '{"\\u005f\\u005fproto\\u005f\\u005f":{"x":1}}'],
  ["json constructor key", '{"constructor":{"prototype":{"x":1}}}'],
  ["yaml merge key", "base: &b\n  a: 1\nchild:\n  <<: *b\n"],
  ["yaml binary tag", "a: !!binary |\n  aGVsbG8=\n"],
  ["yaml bool ambiguity", "no: value\non: 1\ny: 2\n"],
  ["yaml sexagesimal", "a: 12:30:00\n"],
  ["yaml octal", "a: 0o17\nb: 010\n"],
  ["yaml billion laughs", "a: &a [x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]\ne: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]\nf: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]\ng: [*f,*f,*f,*f,*f,*f,*f,*f,*f]\n"],
  ["yaml 1.1 directive", "%YAML 1.1\n---\na: y\n"],
  ["json media yaml body", "a: 1\n"],
  ["json nan", '{"a":1e999}'],
  ["yaml local tag", "a: !mytag hello\n"],
  ["yaml multi doc", "a: 1\n---\nb: 2\n"],
  ["json trailing", '{"a":1} '],
  ["json nul escape value", '{"a":"\\u0000"}'],
];
for (const [name, text] of cases) {
  try {
    const out = parseBoundedDocument(enc(text), { mediaType: name.startsWith("json") ? "application/json" : "application/yaml" });
    console.log("OK  ", name, "=>", JSON.stringify(out.value).slice(0, 120), "fmt", out.format);
  } catch (e: any) {
    console.log("FAIL", name, "=>", e?.code, e?.detail ?? e?.message);
  }
}
