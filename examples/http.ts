import type { IncomingMessage, ServerResponse } from "node:http";
import { CeremonyError } from "../src/server/controller.js";

export async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 256_000) throw new CeremonyError("Request is too large", 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export function json(
  response: ServerResponse,
  body: unknown,
  status = 200,
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}
export function page(
  response: ServerResponse,
  title: string,
  body: string,
  redirectOrigin?: string,
): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${redirectOrigin ? ` ${new URL(redirectOrigin).origin}` : ""}; frame-ancestors 'none'; base-uri 'none'`,
    "referrer-policy": "same-origin",
  });
  response.end(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:17px system-ui;background:#f6f4ef;color:#242e2c;max-width:460px;margin:10vh auto;padding:24px}main{background:white;border:1px solid #d6dbd4;border-radius:18px;padding:32px}label{display:block;margin:18px 0}input{display:block;width:90%;padding:12px;margin-top:6px}button{padding:12px 20px;background:#244f43;color:white;border:0;border-radius:8px;margin:8px 8px 0 0}p{line-height:1.6}small{color:#67716b}</style><main><small>LOCAL TEST PROVIDER</small><h1>${escapeHtml(title)}</h1>${body}</main></html>`,
  );
}
