import { evaluateNetworkTarget, classifyAddress } from "/home/user/ceremony/src/server/connectors/import/network.js";
const pub = { mode: "public" as const, maxRedirects: 3, maxResponseBytes: 1024, timeoutMs: 1000 };
const targets = [
  "https://user:pw@example.com/a",
  "file:///etc/passwd",
  "data:text/plain,hi",
  "https://169.254.169.254/latest/meta-data/",
  "https://[::ffff:169.254.169.254]/x",
  "https://2852039166/",
  "https://0251.0376.0251.0376/",
  "https://[::1]/x",
  "http://example.com/x",
  "https://localhost/x",
  "https://foo.localhost/x",
  "https://example.com:8443/x",
  "https://example.com:443/x",
  "https://10.1.2.3/x",
  "https://100.64.1.1/x",
  "https://example.com./x",
];
for (const t of targets) {
  try {
    const d = evaluateNetworkTarget(t, pub);
    console.log(d.allowed ? "ALLOW" : "deny ", JSON.stringify(t), d.allowed ? d.origin + " net=" + d.network : d.detail);
  } catch (e: any) { console.log("throw", JSON.stringify(t), e?.detail ?? e?.message); }
}
for (const a of ["169.254.169.254","0.0.0.0","192.0.0.1","fd00::1","64:ff9b::1","2001:4860:4860::8888","255.255.255.255","198.18.0.1"])
  console.log("classify", a, "=>", classifyAddress(a));
