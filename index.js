#!/usr/bin/env node
// Semantic Scholar Academic Graph API icin MCP sunucusu.
// Anahtar zorunlu degil; S2_API_KEY tanimliysa x-api-key ile gonderilir.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { get, post, BASE, API_KEY, API_KEY_SOURCE, MIN_INTERVAL, MAX_RETRIES, DEADLINE_MS, stats } from "./lib/http.js";
import {
  PAPER_FIELDS_SHORT, PAPER_FIELDS_FULL, PAPER_FIELDS_BULK, AUTHOR_FIELDS,
  paper, paperList, author, citationEdges,
} from "./lib/render.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const text = (s) => ({ content: [{ type: "text", text: s }] });

// Hata protokol hatasi degil, modele yol gosteren arac hatasi olarak donmeli.
const safe = (fn) => async (args) => {
  try { return await fn(args); }
  catch (e) { return { isError: true, content: [{ type: "text", text: `Hata: ${e.message}` }] }; }
};

const EDGE_FIELDS = "contexts,intents,isInfluential,paperId,title,year,venue,authors,externalIds,citationCount,openAccessPdf";
const REC_FIELDS = "paperId,title,year,venue,authors,externalIds,citationCount,openAccessPdf,abstract,fieldsOfStudy";

const server = new McpServer({ name: "semantic-scholar", version: "0.1.0" });

const ID_HINT =
  "Kimlik bicimleri: S2 paperId (40 hex), DOI:10.xxxx/yyy, PMID:12345678, PMCID:PMC1234, " +
  "ARXIV:2106.15928, CorpusId:12345, MAG:123, ACL:P14-1001 veya makale URL'si. Bir DOI/PMID 404 verirse kayıt S2'de o kimlikle eşlenmemiş demektir; s2_match ile başlıktan arayın.";

/* ================= 1) alaka duzeyine gore arama ================= */
server.registerTool(
  "s2_search",
  {
    title: "Semantic Scholar makale arama",
    description:
      "Anahtar kelimeyle makale arar (alaka sirali, en fazla 100 kayit). Sonuclarda paperId, DOI/PMID, " +
      "atif sayisi ve varsa acik erisim PDF baglantisi doner. Cok sayida kayit veya atif/tarih siralamasi " +
      "gerekiyorsa s2_search_bulk kullanin; elinizde tam baslik varsa s2_match daha isabetlidir.",
    inputSchema: {
      query: z.string().min(2).describe("Ör. 'lung adenocarcinoma graph neural network'"),
      limit: z.number().int().min(1).max(100).default(10),
      offset: z.number().int().min(0).default(0),
      year: z.string().optional().describe("'2020', '2018-2023', '2015-' veya '-2010'"),
      fieldsOfStudy: z.string().optional().describe("Virgüllü, ör. 'Medicine,Biology,Computer Science'"),
      publicationTypes: z.string().optional().describe("Ör. 'Review,ClinicalTrial,JournalArticle'"),
      venue: z.string().optional().describe("Virgüllü dergi/konferans adı"),
      openAccessPdf: z.boolean().default(false).describe("Yalnız açık erişim PDF'i olanlar"),
      minCitationCount: z.number().int().min(0).optional(),
      detail: z.boolean().default(false).describe("Özet ve TLDR'ı da getir"),
    },
    annotations: READ_ONLY,
  },
  safe(async (a) => {
    const j = await get("/graph/v1/paper/search", {
      query: a.query, limit: a.limit, offset: a.offset, year: a.year,
      fieldsOfStudy: a.fieldsOfStudy, publicationTypes: a.publicationTypes, venue: a.venue,
      minCitationCount: a.minCitationCount,
      openAccessPdf: a.openAccessPdf ? "" : undefined,
      fields: a.detail ? PAPER_FIELDS_FULL : PAPER_FIELDS_SHORT,
    });
    const head = `Toplam eşleşme: ${j.total ?? "?"} · gösterilen ${j.data?.length ?? 0} (offset ${a.offset})`;
    return text(paperList(j.data, { detail: a.detail, header: head }));
  }),
);

/* ================= 2) toplu / siralanabilir arama ================= */
server.registerTool(
  "s2_search_bulk",
  {
    title: "Semantic Scholar toplu arama",
    description:
      "Boolean sorgu ve sıralama destekleyen toplu arama (çağrı başına 1000 kayda kadar, token ile sayfalama). " +
      "Sorgu sözdizimi: 'covid + vaccine', '(gene | protein) - plant', 'deep learning'~3, \"exact phrase\". " +
      "Tarama/derleme çalışmaları için bunu, tek bir cevap için s2_search'ü kullanın.",
    inputSchema: {
      query: z.string().min(2).describe("Boolean sorgu, ör. 'TCGA + (LUAD | lung adenocarcinoma)'"),
      sort: z.string().optional().describe("'citationCount:desc', 'publicationDate:desc', 'paperId:asc'"),
      limit: z.number().int().min(1).max(1000).default(100),
      token: z.string().optional().describe("Önceki çağrının döndürdüğü sayfalama token'ı"),
      year: z.string().optional(),
      fieldsOfStudy: z.string().optional(),
      publicationTypes: z.string().optional(),
      venue: z.string().optional(),
      minCitationCount: z.number().int().min(0).optional(),
      openAccessPdf: z.boolean().default(false),
    },
    annotations: READ_ONLY,
  },
  safe(async (a) => {
    const j = await get("/graph/v1/paper/search/bulk", {
      query: a.query, sort: a.sort, token: a.token, year: a.year,
      fieldsOfStudy: a.fieldsOfStudy, publicationTypes: a.publicationTypes, venue: a.venue,
      minCitationCount: a.minCitationCount,
      openAccessPdf: a.openAccessPdf ? "" : undefined,
      fields: PAPER_FIELDS_BULK,
    });
    const rows = (j.data || []).slice(0, a.limit);
    const head = [
      `Toplam eşleşme: ${j.total ?? "?"} · bu sayfada ${rows.length}`,
      j.token ? `Sonraki sayfa token: ${j.token}` : null,
    ].filter(Boolean).join(" · ");
    return text(paperList(rows, { header: head }));
  }),
);

/* ================= 3) baslikla eslestirme ================= */
server.registerTool(
  "s2_match",
  {
    title: "Başlıktan makale eşleştir",
    description:
      "Verilen başlığa en yakın TEK makaleyi döndürür (matchScore ile). Kaynakçadaki bir atfı S2 kaydına " +
      "bağlamak veya DOI/PMID öğrenmek için kullanın.",
    inputSchema: {
      title: z.string().min(4).describe("Makalenin tam veya tama yakın başlığı"),
      detail: z.boolean().default(true),
    },
    annotations: READ_ONLY,
  },
  safe(async (a) => {
    const j = await get("/graph/v1/paper/search/match", {
      query: a.title, fields: a.detail ? PAPER_FIELDS_FULL : PAPER_FIELDS_SHORT,
    });
    const p = j.data?.[0];
    if (!p) return text("Eşleşme bulunamadı.");
    return text(paper(p, { detail: a.detail }));
  }),
);

/* ================= 4) tek makale ================= */
server.registerTool(
  "s2_paper",
  {
    title: "Makale detayı",
    description: `Tek bir makalenin künyesi, özeti, TLDR'ı ve kimlikleri. ${ID_HINT}`,
    inputSchema: {
      id: z.string().min(3).describe("Ör. 'DOI:10.1038/nature14539' veya 'PMID:28792217'"),
      fields: z.string().optional().describe("Özel alan listesi (varsayılan geniş set)"),
      abstractChars: z.number().int().min(100).max(5000).default(1500),
    },
    annotations: READ_ONLY,
  },
  safe(async (a) => {
    const j = await get(`/graph/v1/paper/${encodeURIComponent(a.id)}`, { fields: a.fields || PAPER_FIELDS_FULL });
    return text(paper(j, { detail: true, abstractChars: a.abstractChars }));
  }),
);

/* ================= 5) toplu kimlik sorgusu ================= */
server.registerTool(
  "s2_papers_batch",
  {
    title: "Toplu makale sorgusu",
    description: `Tek çağrıda en fazla 500 kimliği künyeye çevirir — kaynakça doğrulama için hızlı yol. ${ID_HINT}`,
    inputSchema: {
      ids: z.array(z.string()).min(1).max(500).describe("Kimlik listesi"),
      detail: z.boolean().default(false),
    },
    annotations: READ_ONLY,
  },
  safe(async (a) => {
    const j = await post("/graph/v1/paper/batch", { fields: a.detail ? PAPER_FIELDS_FULL : PAPER_FIELDS_SHORT }, { ids: a.ids });
    const rows = (j || []).map((p, i) => (p ? `${i + 1}. ${paper(p, { detail: a.detail }).replace(/\n/g, "\n   ")}` : `${i + 1}. ${a.ids[i]} → bulunamadı`));
    return text(rows.join("\n\n") || "(sonuç yok)");
  }),
);

/* ================= 6) atif yapanlar ================= */
server.registerTool(
  "s2_citations",
  {
    title: "Bu makaleye atıf yapanlar",
    description:
      "Verilen makaleye atıf yapan makaleler; atıf bağlamı (alıntı cümlesi), amaç etiketi (background/method/result) " +
      `ve 'etkili atıf' işareti ile. ${ID_HINT}`,
    inputSchema: {
      id: z.string().min(3),
      limit: z.number().int().min(1).max(1000).default(20),
      offset: z.number().int().min(0).default(0),
      showContexts: z.boolean().default(true),
    },
    annotations: READ_ONLY,
  },
  safe(async (a) => {
    const j = await get(`/graph/v1/paper/${encodeURIComponent(a.id)}/citations`, { fields: EDGE_FIELDS, limit: a.limit, offset: a.offset });
    return text(`Atıf yapanlar (offset ${a.offset}, ${j.data?.length ?? 0} kayıt):\n\n` + citationEdges(j, "citingPaper", { showContexts: a.showContexts }));
  }),
);

/* ================= 7) kaynakca ================= */
server.registerTool(
  "s2_references",
  {
    title: "Makalenin kaynakçası",
    description: `Verilen makalenin atıf yaptığı makaleler, atıf bağlamlarıyla. ${ID_HINT}`,
    inputSchema: {
      id: z.string().min(3),
      limit: z.number().int().min(1).max(1000).default(20),
      offset: z.number().int().min(0).default(0),
      showContexts: z.boolean().default(false),
    },
    annotations: READ_ONLY,
  },
  safe(async (a) => {
    const j = await get(`/graph/v1/paper/${encodeURIComponent(a.id)}/references`, { fields: EDGE_FIELDS, limit: a.limit, offset: a.offset });
    return text(`Kaynakça (offset ${a.offset}, ${j.data?.length ?? 0} kayıt):\n\n` + citationEdges(j, "citedPaper", { showContexts: a.showContexts }));
  }),
);

/* ================= 8) oneriler ================= */
server.registerTool(
  "s2_recommendations",
  {
    title: "Benzer makale önerileri",
    description:
      "Bir makaleye benzer makaleler (S2 öneri motoru). Havuz: 'all-cs' tüm külliyat (varsayılan), " +
      "'recent' yalnız son makaleler — eski bir tohum makale için 'recent' çoğu zaman boş döner. " +
      "Literatür taramasında snowballing için kullanışlıdır.",
    inputSchema: {
      id: z.string().min(3).describe("Tohum makale kimliği"),
      limit: z.number().int().min(1).max(500).default(20),
      from: z.enum(["all-cs", "recent"]).default("all-cs"),
    },
    annotations: READ_ONLY,
  },
  safe(async (a) => {
    let pool = a.from;
    let j = await get(`/recommendations/v1/papers/forpaper/${encodeURIComponent(a.id)}`, { fields: REC_FIELDS, limit: a.limit, from: pool });
    // 'recent' havuzu eski tohumlarda bos doner; sessiz bos cevap yerine genis havuza dus.
    if (!(j.recommendedPapers || []).length && pool === "recent") {
      pool = "all-cs";
      j = await get(`/recommendations/v1/papers/forpaper/${encodeURIComponent(a.id)}`, { fields: REC_FIELDS, limit: a.limit, from: pool });
      if ((j.recommendedPapers || []).length) pool = "all-cs (recent boş döndü)";
    }
    return text(paperList(j.recommendedPapers, { header: `Öneriler (havuz: ${pool}):` }));
  }),
);

/* ================= 9) yazar arama ================= */
server.registerTool(
  "s2_author_search",
  {
    title: "Yazar arama",
    description: "İsimle yazar arar; authorId, makale/atıf sayısı ve h-index döner. Ad benzerlikleri sıktır, kurumu kontrol edin.",
    inputSchema: {
      query: z.string().min(2).describe("Ör. 'Yoshua Bengio'"),
      limit: z.number().int().min(1).max(100).default(10),
      offset: z.number().int().min(0).default(0),
    },
    annotations: READ_ONLY,
  },
  safe(async (a) => {
    const j = await get("/graph/v1/author/search", { query: a.query, fields: AUTHOR_FIELDS, limit: a.limit, offset: a.offset });
    const rows = (j.data || []).map((x, i) => `${i + 1}. ${author(x).replace(/\n/g, "\n   ")}`);
    return text(`Toplam: ${j.total ?? "?"}\n\n` + (rows.join("\n\n") || "(sonuç yok)"));
  }),
);

/* ================= 10) yazar detayi + makaleleri ================= */
server.registerTool(
  "s2_author",
  {
    title: "Yazar detayı",
    description: "authorId ile yazar künyesi ve istenirse makale listesi (atıfa göre sıralı gösterilir).",
    inputSchema: {
      authorId: z.string().min(1).describe("s2_author_search'ten gelen S2AuthorId"),
      withPapers: z.boolean().default(true),
      limit: z.number().int().min(1).max(200).default(20),
      offset: z.number().int().min(0).default(0),
    },
    annotations: READ_ONLY,
  },
  safe(async (a) => {
    const info = await get(`/graph/v1/author/${encodeURIComponent(a.authorId)}`, { fields: AUTHOR_FIELDS });
    if (!a.withPapers) return text(author(info));
    const p = await get(`/graph/v1/author/${encodeURIComponent(a.authorId)}/papers`, { fields: PAPER_FIELDS_SHORT, limit: a.limit, offset: a.offset });
    const rows = [...(p.data || [])].sort((x, y) => (y.citationCount || 0) - (x.citationCount || 0));
    return text(author(info) + "\n\n" + paperList(rows, { header: `Makaleler (offset ${a.offset}, ${rows.length} kayıt):` }));
  }),
);

/* ================= 11) durum ================= */
server.registerTool(
  "s2_status",
  {
    title: "Sunucu durumu",
    description: "API anahtarının ayarlı olup olmadığı, istek aralığı, önbellek/istek sayaçları ve canlı bir ping.",
    inputSchema: { ping: z.boolean().default(true) },
    annotations: READ_ONLY,
  },
  safe(async ({ ping }) => {
    const s = stats();
    let live = "denenmedi";
    if (ping) {
      try {
        const j = await get("/graph/v1/paper/search", { query: "cancer", limit: 1, fields: "title" });
        live = `çalışıyor (örnek sonuç: ${j.data?.[0]?.title ? j.data[0].title.slice(0, 60) : "boş"})`;
      } catch (e) { live = `başarısız → ${e.message}`; }
    }
    return text([
      `Uç nokta: ${BASE}`,
      // Anahtarin DEGERI asla yazdirilmaz, yalnizca ayarli olup olmadigi bildirilir.
      `API anahtarı: ${API_KEY ? `ayarlı (${API_KEY.length} karakter, kaynak: ${API_KEY_SOURCE})` : `YOK (paylaşımlı havuz, 429 sık; ${API_KEY_SOURCE})`}`,
      `İstek aralığı: ${MIN_INTERVAL} ms · azami yeniden deneme: ${MAX_RETRIES} · çağrı bütçesi: ${DEADLINE_MS} ms`,
      `İstek: ${s.calls} · yeniden deneme: ${s.retries} · önbellek: ${s.cacheHits} isabet / ${s.cacheMisses} ıska (${s.cacheSize} kayıt)`,
      `Canlı ping: ${live}`,
    ].join("\n"));
  }),
);

/* ================= yasam dongusu ================= */
// stdio sunucusu istemciye bagimlidir: istemci olunce SURECIN DE olmesi gerekir,
// yoksa arka planda yetim node surecleri birikir (olculdu: test SIGKILL edilince
// index.js ayakta kaldi). Uc kapanis yolunu da baglariz.
let closing = false;
const bye = (code = 0) => {
  if (closing) return;
  closing = true;
  Promise.resolve(server.close?.()).catch(() => {}).finally(() => process.exit(code));
  // close() takilirsa da cikilmali.
  setTimeout(() => process.exit(code), 2000).unref();
};

const transport = new StdioServerTransport();
// SDK connect() sirasinda onceki onclose'u koruyup zincirler (protocol.js:220-223),
// bu yuzden atamayi connect'ten ONCE yapmak guvenli.
transport.onclose = () => bye(0);
process.stdin.on("end", () => bye(0));
process.stdin.on("close", () => bye(0));
process.stdin.on("error", () => bye(0));
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => bye(0));

await server.connect(transport);
