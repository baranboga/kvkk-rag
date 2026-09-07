/** Gecici: (1) ilk sonucun ham alanlari (2) ucretsiz ozet kaynagi var mi? */
import { queryClient } from "../src/db/client";
import { hybridSearch } from "../src/search/hybrid";

const r = await hybridSearch("çalışanın e posta saklama süresi", 1);
const h = r.hits[0];
console.log("=== #1 ===", h.kararNo, "| via:", h.via.join("+"));
console.log("highlighted:", h.highlighted ? JSON.stringify(h.highlighted.slice(0, 200)) : "<NULL>");
console.log("snippet ilk 160:", JSON.stringify(h.snippet.slice(0, 160)));

const rows = await queryClient<{ karar_no: string | null; body: string }[]>`
  SELECT karar_no, body FROM kvkk.decisions
`;

// Kararin hukmu ("...karar verilmistir") govdede var mi?
const RULING = /karar veril(miş|mesi)/i;
const withRuling = rows.filter((x) => RULING.test(x.body));
console.log(`\n"karar veril..." iceren: ${withRuling.length}/${rows.length}`);

const para = withRuling[0].body
  .split(/\n{2,}/)
  .filter((p) => RULING.test(p))
  .pop();
console.log(`\nornek hukum paragrafi (${withRuling[0].karar_no}, ${para?.length} kar):\n`, para?.slice(0, 600));

// Yaptirim kaliplari — ucretsiz "sonuc" etiketi uretilebilir mi?
const pats: [string, RegExp][] = [
  ["idari para cezası", /idari para cezası/i],
  ["ceza tutarı (TL)", /([\d.]{4,})\s*(?:TL|Türk Lirası)/i],
  ["şikâyetin reddi", /(şikâyet|şikayet|talebin|başvurunun)[^.]{0,40}reddine/i],
  ["talimat verilmesi", /talimatlandırılmasına|yönünde talimat/i],
  ["işlem gerekmediği", /işlem yapılmasına gerek olmadığ/i],
];
console.log("\nyaptirim kalibi dagilimi:");
for (const [label, re] of pats) {
  console.log(`  ${label.padEnd(22)} ${rows.filter((x) => re.test(x.body)).length}/${rows.length}`);
}

// Ceza tutari ornekleri
console.log("\nceza tutari ornekleri:");
for (const x of rows.slice(0, 400)) {
  const m = x.body.match(/([\d][\d.]{3,})\s*(?:TL|Türk Lirası)/);
  if (m) console.log(`  ${x.karar_no} -> ${m[1]} TL`);
  if (m && rows.indexOf(x) > 40) break;
}

await queryClient.end();
