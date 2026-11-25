#!/usr/bin/env node
/**
 * Canli duman testi: sunucuyu stdio uzerinden ayaga kaldirir, her araci gercek
 * API cagrisiyla dener. Mock yok — dogrulanmak istenen sey canli API'nin sekli.
 * Anahtarsiz calisiyorsa 429 nedeniyle yavastir (istek araligi + geri cekilme).
 *
 *   node test.mjs           # hepsi
 *   node test.mjs search    # adinda 'search' gecen vakalar
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2];
const TRANSFORMER = "ARXIV:1706.03762";       // Attention Is All You Need
const DESEQ2 = "DOI:10.1186/s13059-014-0550-8"; // Love ve ark. — DESeq2
const HALLMARKS = "PMID:21376230";             // Hanahan & Weinberg — Hallmarks of cancer

const CASES = [
  ["status", "s2_status", { ping: true }, (t) => /API anahtarı:/.test(t) && /Canlı ping: çalışıyor/.test(t)],
  ["search", "s2_search", { query: "attention is all you need transformer", limit: 5 }, (t) => /Attention Is All You Need/i.test(t) && /S2:[0-9a-f]{40}/.test(t)],
  ["search-detay", "s2_search", { query: "graph neural network drug repurposing", limit: 3, detail: true }, (t) => /atıf \d+/.test(t) && t.length > 800],
  ["search-filtre", "s2_search", { query: "lung adenocarcinoma", limit: 5, year: "2022-2024", openAccessPdf: true, minCitationCount: 10 }, (t) => /PDF: https?:\/\//.test(t) && /202[234]/.test(t)],
  ["search-bos", "s2_search", { query: "zzzqqqxyz nonexistentterm42", limit: 3 }, (t) => /sonuc yok|sonuç yok|Toplam eşleşme: 0/.test(t)],
  ["bulk", "s2_search_bulk", { query: "TCGA + (LUAD | lung adenocarcinoma)", sort: "citationCount:desc", limit: 10 }, (t) => /Toplam eşleşme: \d+/.test(t) && /atıf \d{2,}/.test(t)],
  ["match", "s2_match", { title: "Attention is all you need" }, (t) => /matchScore/.test(t) && /Attention Is All You Need/i.test(t)],
  ["paper-doi", "s2_paper", { id: DESEQ2 }, (t) => /DESeq2/i.test(t) && /DOI:10.1186\/s13059-014-0550-8/.test(t)],
  ["paper-arxiv", "s2_paper", { id: TRANSFORMER }, (t) => /Attention Is All You Need/i.test(t) && /ARXIV:1706.03762/.test(t)],
  ["batch", "s2_papers_batch", { ids: [DESEQ2, TRANSFORMER, HALLMARKS] }, (t) => /DESeq2/i.test(t) && /Attention/i.test(t) && /Hallmarks/i.test(t)],
  ["citations", "s2_citations", { id: DESEQ2, limit: 5 }, (t) => /Atıf yapanlar/.test(t) && /S2:[0-9a-f]{40}/.test(t)],
  ["references", "s2_references", { id: TRANSFORMER, limit: 5, showContexts: true }, (t) => /Kaynakça/.test(t) && /S2:[0-9a-f]{40}/.test(t)],
  ["recommend", "s2_recommendations", { id: TRANSFORMER, limit: 5 }, (t) => /Öneriler \(havuz: all-cs/.test(t) && /S2:[0-9a-f]{40}/.test(t)],
  ["author-search", "s2_author_search", { query: "Yoshua Bengio", limit: 3 }, (t) => /S2AuthorId:\d+/.test(t) && /h-index \d+/.test(t)],
  ["author", "s2_author", { authorId: "1751762", limit: 5 }, (t) => /Bengio/i.test(t) && /Makaleler/.test(t)],
  ["paper-hatali-id", "s2_paper", { id: "DOI:10.9999/yok-boyle-bir-sey" }, (t) => /Hata:/.test(t)],
];

const client = new Client({ name: "s2-smoke-test", version: "1.0.0" }, { capabilities: {} });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(HERE, "index.js")], env: { ...process.env } }));

const tools = (await client.listTools()).tools;
console.log(`Kayıtlı araç: ${tools.length} → ${tools.map((t) => t.name).join(", ")}\n`);

let pass = 0, fail = 0;
const failures = [];
for (const [label, tool, args, check] of CASES) {
  if (filter && !label.includes(filter) && !tool.includes(filter)) continue;
  const t0 = Date.now();
  let out = "", err = null;
  try {
    const r = await client.callTool({ name: tool, arguments: args });
    out = (r.content || []).map((c) => c.text || "").join("\n");
    // hatali-id vakasinda isError beklenir; digerlerinde hatadir
    if (r.isError && !label.includes("hatali")) err = "isError";
  } catch (e) { err = e.message; }
  const ok = !err && check(out);
  console.log(`${ok ? "✓" : "✗"} ${label.padEnd(18)} ${String(Date.now() - t0).padStart(6)}ms ${String(out.length).padStart(6)} krk  ${tool}`);
  if (ok) pass++; else { fail++; failures.push([label, err || "doğrulama başarısız", out.slice(0, 500)]); }
}

console.log(`\n${pass} geçti, ${fail} kaldı`);
for (const [l, e, o] of failures) console.log(`\n--- ${l}: ${e}\n${o}`);
await client.close();
process.exit(fail ? 1 : 0);
