# semantic-scholar-mcp

> **English summary.** A local MCP server (stdio) for the Semantic Scholar Academic Graph API: relevance and bulk search, paper details, citations and references, author lookup, recommendations. An API key is optional but recommended: without one, requests go through the shared pool and are often rate-limited.
> The rest of this README is in Turkish.

[Semantic Scholar Academic Graph API](https://api.semanticscholar.org/api-docs/graph) için yerel MCP sunucusu.
Node + `@modelcontextprotocol/sdk`, stdio taşıması, bağımlılık yüzeyi iki paket.

## Araçlar

| Araç | İş |
|---|---|
| `s2_search` | Alaka sıralı arama (≤100), yıl/alan/tür/venue/atıf filtreleri, `openAccessPdf` |
| `s2_search_bulk` | Boolean sorgu + sıralama, çağrı başına ≤1000, token ile sayfalama |
| `s2_match` | Başlıktan tek makale eşleştirme (`matchScore`) |
| `s2_paper` | Tek makale künyesi + özet + TLDR |
| `s2_papers_batch` | Tek çağrıda ≤500 kimlik → künye (kaynakça doğrulama) |
| `s2_citations` | Atıf yapanlar + atıf bağlamı/amacı, "etkili atıf" işareti |
| `s2_references` | Kaynakça, atıf bağlamlarıyla |
| `s2_recommendations` | Benzer makale önerileri (`all-cs` / `recent` havuzu) |
| `s2_author_search`, `s2_author` | Yazar arama; künye + makaleler (h-index, atıf) |
| `s2_status` | Anahtar ayarlı mı, istek aralığı, önbellek sayaçları, canlı ping |

Kimlik biçimleri: `DOI:10.1186/s13059-014-0550-8`, `PMID:21376230`, `PMCID:PMC4302049`,
`ARXIV:1706.03762`, `CorpusId:8620592`, S2 paperId (40 hex) veya makale URL'si.
Bir DOI/PMID 404 verirse kayıt S2'de o kimlikle eşlenmemiştir — `s2_match` ile başlıktan arayın.
(Ölçülmüş örnek: `DOI:10.1038/nature14539` S2'de 404 verir, aynı makale başlıkla bulunur.)

## Ortam değişkenleri

| Değişken | Varsayılan | Not |
|---|---|---|
| `S2_API_KEY` | — | Yoksa paylaşımlı havuz kullanılır; **429 sıktır** |
| `S2_MIN_INTERVAL_MS` | anahtarlı 1100, anahtarsız 3000 | İstekler tek sıraya dizilir, aralık zorlanır |
| `S2_MAX_RETRIES` | 5 | 429/5xx için üstel geri çekilme (`Retry-After` varsa ona uyar) |
| `S2_DEADLINE_MS` | 45000 | Çağrı bütçesi; MCP'nin 60 sn zaman aşımından önce anlaşılır hata döner |
| `S2_CACHE_TTL_MS` | 600000 | Aynı istek için bellek içi önbellek |
| `S2_TIMEOUT_MS` | 30000 | Tek HTTP isteği zaman aşımı |

Anahtar başvurusu: <https://www.semanticscholar.org/product/api#api-key-form>

## Kurulum

```sh
cd ~/projects/semantic-scholar-mcp && npm install
claude mcp add semantic-scholar -s user -e S2_API_KEY=ANAHTAR -- node /path/to/semantic-scholar-mcp/index.js
```

Anahtarı `~/.claude.json` içine düz yazmak istemiyorsanız, kabukta dışa aktarıp
config'te genişletme kullanın (context7 girdisiyle aynı desen):

```json
"semantic-scholar": {
  "type": "stdio",
  "command": "node",
  "args": ["/path/to/semantic-scholar-mcp/index.js"],
  "env": { "S2_API_KEY": "${S2_API_KEY}" }
}
```

## Test

```sh
node test.mjs            # canlı duman testi (ağ gerekir, mock yok)
node test.mjs search     # yalnız adında 'search' geçen vakalar
node test-lifecycle.mjs  # yetim süreç testi (ağ gerekmez)
```

`test-lifecycle.mjs` üç kapanış yolunu dener: stdin kapanışı, istemcinin SIGKILL
yemesi ve **uçuşta istek varken** istemcinin gitmesi. Üçüncüsü gerçek bir kusurdu:
bekleyen `fetch` + geri çekilme zamanlayıcısı olay döngüsünü canlı tuttuğu için
stdio kapansa bile süreç yetim kalıyordu (ölçüldü). `index.js` artık stdin
kapanışı, transport `onclose` ve SIGINT/SIGTERM/SIGHUP yollarının hepsinde
açıkça çıkıyor.

Anahtarsız çalıştırırsanız arama uçları 429 yüzünden kalabilir; bu sunucunun değil
paylaşımlı havuzun sınırıdır (`s2_status` bunu açıkça söyler).

## Lisans

[MIT](LICENSE).
