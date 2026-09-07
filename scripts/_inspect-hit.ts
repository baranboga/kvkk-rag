/** Gecici: ilk sonucun UI'a giden ham alanlari + govdede ozet kaynagi var mi? */
import { queryClient } from "../src/db/client";
import { hybridSearch } from "../src/search/hybrid";

const q = process.argv[2] ?? "fidye yazilimi saldirisi sonucu veri ihlali";
const r = await hybridSearch(q, 2);

for (const h of r.hits) {
  console.log("=".repeat(78));
  console.log("kararNo   :", h.kararNo, "|", h.kararTarihi, "| via:", h.via.join("+"));
  console.log("konuOzeti :", h.konuOzeti);
  console.log("-".repeat(78));
  console.log("highlighted:", h.highlighted ? JSON.stringify(h.highlighted) : "<null>");
  console.log("-".repeat(78));
  console.log("snippet (ham chunk, ilk 300):", JSON.stringify(h.snippet.slice(0, 300)));
  console.log();
}

// Govdede "sonuc" paragrafi cikarilabilir mi? (ucretsiz ozet kaynagi)
const rows = await queryClient<{ karar_no: string | null; body: string }[]>`
  SELECT karar_no, body FROM kvkk.decisions
`;
const withRuling = rows.filter((x) => /karar verilmiş/i.test(x.body));
console.log("=".repeat(78));
console.log(`"karar verilmiş..." iceren karar sayisi: ${withRuling.length}/${rows.length}`);

const sample = withRuling[0];
const para = sample.body
  .split(/\n{2,}/)
  .filter((p) => /karar verilmiş/i.test(p))
  .pop();
console.log(`\nornek sonuc paragrafi (${sample.karar_no}):\n`, para?.slice(0, 700));

// Yaptirim turlerinin dagilimi
const pat = {
  "idari para cezası": /idari para cezası/i,
  "kabahat/ihlal tespiti": /ihlal edildiğ|aykırılık teşkil/i,
  "talebin reddi": /talebin reddine|şikâyetin reddine|şikayetin reddine/i,
  "işlem yapılmasına gerek yok": /işlem yapılmasına gerek olmadığ/i,
  "talimat/uyarı": /talimatlandırılmasına|uyarılmasına/i,
};
console.log("\nyaptirim kalibi dagilimi:");
for (const [label, re] of Object.entries(pat)) {
  console.log(`  ${label.padEnd(32)} ${rows.filter((x) => re.test(x.body)).length}`);
}

await queryClient.end();
