// Sonuclari modele okunur, kompakt markdown olarak basar. Ham JSON'u sismandirmadan
// takip cagrilari icin gereken kimlikleri (paperId, DOI, PMID) hep tasir.

export const PAPER_FIELDS_SHORT = [
  "paperId", "title", "year", "venue", "publicationTypes", "authors.name",
  "citationCount", "influentialCitationCount", "externalIds", "openAccessPdf", "fieldsOfStudy",
].join(",");

export const PAPER_FIELDS_FULL = [
  PAPER_FIELDS_SHORT, "abstract", "tldr", "referenceCount", "publicationDate",
  "journal", "publicationVenue", "s2FieldsOfStudy", "citationStyles",
].join(",");

// bulk arama tldr/citationStyles gibi bazi alanlari kabul etmez.
export const PAPER_FIELDS_BULK = [
  "paperId", "title", "year", "venue", "publicationTypes", "authors",
  "citationCount", "influentialCitationCount", "externalIds", "openAccessPdf", "fieldsOfStudy",
].join(",");

export const AUTHOR_FIELDS = [
  "authorId", "name", "affiliations", "homepage", "paperCount", "citationCount", "hIndex",
].join(",");

const clip = (s, n) => {
  if (!s) return "";
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

function ids(p) {
  const e = p.externalIds || {};
  const out = [];
  if (e.DOI) out.push(`DOI:${e.DOI}`);
  if (e.PubMed) out.push(`PMID:${e.PubMed}`);
  if (e.PubMedCentral) out.push(`PMCID:${e.PubMedCentral}`);
  if (e.ArXiv) out.push(`ARXIV:${e.ArXiv}`);
  return out.join(" ");
}

function authorLine(p, max = 6) {
  const a = (p.authors || []).map((x) => x.name).filter(Boolean);
  if (!a.length) return "";
  return a.length > max ? a.slice(0, max).join(", ") + ` +${a.length - max}` : a.join(", ");
}

/** Tek makale — liste satiri (kisa) veya detay (uzun). */
export function paper(p, { detail = false, abstractChars = 600 } = {}) {
  if (!p) return "(boş kayıt)";
  const head = [
    `**${p.title || "(başlıksız)"}**`,
    [p.year, p.venue || p.journal?.name].filter(Boolean).join(" · "),
  ].filter(Boolean).join("  \n");
  const meta = [];
  const au = authorLine(p, detail ? 25 : 6);
  if (au) meta.push(au);
  const cites = [];
  if (p.citationCount != null) cites.push(`atıf ${p.citationCount}`);
  if (p.influentialCitationCount != null) cites.push(`etkili ${p.influentialCitationCount}`);
  if (p.referenceCount != null && detail) cites.push(`kaynak ${p.referenceCount}`);
  if (cites.length) meta.push(cites.join(" / "));
  if (p.paperId) meta.push(`S2:${p.paperId}`);
  const x = ids(p);
  if (x) meta.push(x);
  if (p.openAccessPdf?.url) meta.push(`PDF: ${p.openAccessPdf.url}`);
  if (p.fieldsOfStudy?.length) meta.push(p.fieldsOfStudy.join(", "));
  if (p.matchScore != null) meta.push(`matchScore ${Math.round(p.matchScore)}`);

  const body = [];
  const tldr = p.tldr?.text;
  if (tldr) body.push(`TLDR: ${clip(tldr, 400)}`);
  if (p.abstract) body.push(clip(p.abstract, detail ? abstractChars : 300));
  return [head, meta.join(" | "), ...body].filter(Boolean).join("\n");
}

export function paperList(items, { detail = false, header = "" } = {}) {
  if (!items || !items.length) return header ? `${header}\n(sonuç yok)` : "(sonuç yok)";
  const body = items.map((p, i) => `${i + 1}. ${paper(p, { detail }).replace(/\n/g, "\n   ")}`).join("\n\n");
  return header ? `${header}\n\n${body}` : body;
}

export function author(a, { detail = false } = {}) {
  if (!a) return "(boş kayıt)";
  const meta = [];
  if (a.authorId) meta.push(`S2AuthorId:${a.authorId}`);
  if (a.paperCount != null) meta.push(`makale ${a.paperCount}`);
  if (a.citationCount != null) meta.push(`atıf ${a.citationCount}`);
  if (a.hIndex != null) meta.push(`h-index ${a.hIndex}`);
  if (a.affiliations?.length) meta.push(a.affiliations.join("; "));
  if (a.homepage) meta.push(a.homepage);
  const out = [`**${a.name || "(isimsiz)"}**`, meta.join(" | ")];
  if (detail && a.papers?.length) out.push(paperList(a.papers, { header: "Makaleler:" }));
  return out.filter(Boolean).join("\n");
}

/** citations/references cevaplari {citingPaper|citedPaper, contexts, intents, isInfluential} tasir. */
export function citationEdges(data, key, { showContexts = true } = {}) {
  const rows = (data?.data || []).map((d, i) => {
    const p = d[key] || d;
    const tags = [];
    if (d.isInfluential) tags.push("ETKILI");
    if (d.intents?.length) tags.push(d.intents.join("/"));
    const ctx = showContexts && d.contexts?.length ? `\n   > ${clip(d.contexts[0], 300)}` : "";
    return `${i + 1}. ${paper(p).replace(/\n/g, "\n   ")}${tags.length ? `\n   [${tags.join(" ")}]` : ""}${ctx}`;
  });
  return rows.length ? rows.join("\n\n") : "(sonuç yok)";
}
