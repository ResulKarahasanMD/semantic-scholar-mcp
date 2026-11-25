#!/usr/bin/env node
/**
 * Yetim surec testi — ag gerektirmez.
 * stdio sunucusu istemciye bagimlidir; istemci gidince surec de gitmelidir.
 *   A) istemci stdin'i kapatir  → sunucu cikmali
 *   B) istemci SIGKILL yer      → sunucu cikmali (borular kapanir)
 *   C) UCUSTA istek varken istemci gider → sunucu yine de cikmali.
 *      Asil kusur buydu: bekleyen fetch + geri cekilme zamanlayicisi olay dongusunu
 *      canli tutuyor, stdio kapansa bile surec yetim kaliyordu. Ag yok: istekler
 *      TEST-NET-1 (192.0.2.1) adresine gider, oradan cevap gelmez.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "index.js");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitGone(pid, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!alive(pid)) return Date.now() - t0;
    await sleep(100);
  }
  return null;
}

let fail = 0;

// A) stdin kapanisi
{
  const srv = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "ignore"] });
  await sleep(600);
  srv.stdin.end();
  const ms = await waitGone(srv.pid);
  console.log(`${ms != null ? "✓" : "✗"} A stdin kapanınca sunucu çıkıyor${ms != null ? ` (${ms} ms)` : " — HÂLÂ AYAKTA"}`);
  if (ms == null) { fail++; try { process.kill(srv.pid, "SIGKILL"); } catch {} }
}

// B) ebeveyn SIGKILL
{
  const code = `const{spawn}=require("child_process");` +
    `const c=spawn(process.execPath,[${JSON.stringify(SERVER)}],{stdio:["pipe","pipe","ignore"]});` +
    `console.log(c.pid);setInterval(()=>{},1000);`;
  const parent = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"] });
  const srvPid = await new Promise((res) => parent.stdout.once("data", (d) => res(Number(String(d).trim()))));
  await sleep(600);
  process.kill(parent.pid, "SIGKILL");
  const ms = await waitGone(srvPid);
  console.log(`${ms != null ? "✓" : "✗"} B ebeveyn SIGKILL yiyince sunucu çıkıyor${ms != null ? ` (${ms} ms)` : " — YETİM KALDI"}`);
  if (ms == null) { fail++; try { process.kill(srvPid, "SIGKILL"); } catch {} }
}

// C) ucusta istek varken istemci gider
{
  const srv = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, S2_BASE_URL: "http://192.0.2.1", S2_MIN_INTERVAL_MS: "0", S2_TIMEOUT_MS: "30000", S2_API_KEY: "" },
  });
  const send = (o) => srv.stdin.write(JSON.stringify(o) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lifecycle", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "s2_search", arguments: { query: "ucusta istek testi" } } });
  await sleep(2000); // istek uçuşa geçsin
  srv.stdin.end();
  const ms = await waitGone(srv.pid, 10000);
  console.log(`${ms != null ? "✓" : "✗"} C uçuşta istek varken istemci gidince sunucu çıkıyor${ms != null ? ` (${ms} ms)` : " — YETİM KALDI"}`);
  if (ms == null) { fail++; try { process.kill(srv.pid, "SIGKILL"); } catch {} }
}

console.log(fail ? `\n${fail} vaka kaldı` : "\nyetim süreç yok");
process.exit(fail ? 1 : 0);
