// ============================================================================
// api/coach.js — AI-tussenlaag van de Belcoach
// ============================================================================
// Vercel maakt hiervan automatisch een serverless endpoint op /api/coach.
//
// Zelfde principe als api/claude.js in de taxatie-app: de Anthropic-sleutel
// blijft geheim op de server (omgevingsvariabele ANTHROPIC_API_KEY) en staat
// nooit in de pagina.
//
// Extra veilig: de browser stuurt GEEN vrije prompt. Hij kiest enkel een actie
// (bv. "eigenaar") met een case- of bezwaarnummer en de tekst van de makelaar.
// De volledige instructies voor Claude worden hier op de server opgebouwd.
// Zo kan niemand dit endpoint misbruiken als gratis chatbot op jouw kosten.
//
// Toegang: enkel aangemelde gebruikers (Supabase Auth). De browser stuurt het
// sessietoken mee; de server controleert het bij Supabase. Scores worden enkel
// hier, op de server, weggeschreven (met de geheime Supabase-sleutel), zodat
// niemand zijn eigen score kan aanpassen.
//
// Omgevingsvariabelen in Vercel:
//   ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY
// ============================================================================

import { OBJ, CASES, CRIT } from "../content.js";
const MODEL_SNEL = "claude-haiku-4-5-20251001"; // eigenaar spelen, snelvuur-feedback: snel en goedkoop
const MODEL_GRONDIG = "claude-sonnet-4-6";      // beoordeling van een volledig gesprek
const MAX_PER_UUR = 120;                        // AI-vragen per gebruiker per uur
const MAX_TEKST = 1500;                         // tekens per beurt van de makelaar
const MAX_BEURTEN = 40;

const SB_URL = () => (process.env.SUPABASE_URL || "").replace(/\/$/, "");

// Headers voor server-aanroepen met de geheime sleutel (nieuwe sb_secret_ of oude service_role)
function geheimeHeaders(extra = {}) {
  const key = process.env.SUPABASE_SECRET_KEY || "";
  const h = { apikey: key, "Content-Type": "application/json", ...extra };
  if (!key.startsWith("sb_secret_")) h.Authorization = "Bearer " + key;
  return h;
}

// Controleert het sessietoken bij Supabase en geeft de gebruiker terug, of null
async function gebruiker(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token || !SB_URL()) return null;
  try {
    const r = await fetch(SB_URL() + "/auth/v1/user", {
      headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: "Bearer " + token },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u?.id ? u : null;
  } catch { return null; }
}

// Rem per gebruiker: telt de AI-vragen van het voorbije uur in de database
async function remOk(userId, actie) {
  const sinds = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const r = await fetch(`${SB_URL()}/rest/v1/ai_verbruik?select=id&user_id=eq.${userId}&created_at=gte.${encodeURIComponent(sinds)}`, {
    headers: geheimeHeaders({ Prefer: "count=exact", Range: "0-0" }),
  });
  const totaal = Number((r.headers.get("content-range") || "").split("/")[1] || 0);
  if (totaal >= MAX_PER_UUR) return false;
  await opslaan("ai_verbruik", { user_id: userId, actie });
  return true;
}

async function opslaan(tabel, rij) {
  const r = await fetch(`${SB_URL()}/rest/v1/${tabel}`, {
    method: "POST",
    headers: geheimeHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(rij),
  });
  if (!r.ok) console.error("Opslaan mislukt", tabel, r.status, await r.text().catch(() => ""));
}

const tekst = (v, max = MAX_TEKST) => String(v ?? "").slice(0, max).trim();

async function vraagClaude({ model, messages, max_tokens }) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens, messages }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("Anthropic-fout", r.status, data?.error?.message);
    const e = new Error("ai");
    e.status = r.status === 429 ? 429 : 502;
    throw e;
  }
  return (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
}

function leesJson(t) {
  try { return JSON.parse(t); } catch {}
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) { try { return JSON.parse(m[1]); } catch {} }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}

// ---------------------------------------------------------------- prompts

function promptSnelvuur(o, antwoord, tweede) {
  return `Een nieuwe vastgoedmakelaar in Vlaanderen oefent het ombuigen van een bezwaar tijdens een koud telefoongesprek, met de methode knuffel – brug – counter – afspraak.
- Knuffel: eerst erkennen wat de eigenaar zegt en begrip tonen, zonder tegenspreken.
- Brug: kort geruststellen en de druk wegnemen.
- Counter: pas dan ingaan op het bezwaar door een voordeel te teasen; NIET diensten opsommen, niet verkopen, geen commissie uitleggen.
- Afspraak: in één zin twee concrete momenten ZEGGEN (bv. "dinsdag 14u of donderdag 19u"), niet vragen "zou het passen dat". Uitzondering: bij "Het is al verkocht" of "Geen interesse" mag de afspraak ook een opvolgafspraak of een open vraag zijn.
${tweede ? `Eerste bezwaar was: "${o.b}". De eigenaar reageerde daarna met een tweede bezwaar: "${tweede}". Beoordeel het antwoord op dat tweede bezwaar.` : `Bezwaar van de eigenaar: "${o.b}"`}
Antwoord van de makelaar: """${antwoord}"""
Een goed voorbeeld (niet het enige juiste antwoord): knuffel "${o.k}" brug "${o.br}" counter + afspraak "${o.c}"

Beoordeel op de bedoeling, niet op de letterlijke woorden. Het antwoord is vaak ingesproken en via spraakherkenning omgezet: negeer tikfouten, ontbrekende leestekens, herhalingen en verkeerd herkende woorden, en lees wat de makelaar bedoelde.
- Een stap telt (ok=true) zodra de functie herkenbaar aanwezig is, ook in eigen woorden, kort, impliciet of samen met een andere stap in één zin. Voorbeeld: "Ik begrijp het, geen probleem" is een knuffel; "u zit nergens aan vast" is een brug.
- Afspraak telt ook als de makelaar concrete momenten voorstelt in een andere vorm, bv. "volgende week dinsdagnamiddag of donderdagavond" of "past dinsdag om 14u of liever donderdag?".
- Twijfel je, geef dan het voordeel van de twijfel en zet je verbeterpunt in de uitleg.
- Zet ok=false alleen als de stap echt ontbreekt of het tegendeel gebeurt (tegenspreken, "ja maar", diensten opsommen, geen enkel moment voorstellen).
Schrijf in het Nederlands, in de je-vorm, zakelijk, kort en bemoedigend.
Antwoord met alleen JSON in deze vorm, zonder andere tekst:
{"knuffel":{"ok":true,"uitleg":"max 12 woorden"},"brug":{"ok":false,"uitleg":"..."},"counter":{"ok":true,"uitleg":"..."},"afspraak":{"ok":false,"uitleg":"..."},"jaMaar":false,"verkoopt":false,"tip":"één concrete zin","betereVersie":"het antwoord herschreven, max 60 woorden, zoals je het aan de telefoon zegt"}`;
}

function promptTweede(o, antwoord) {
  return `Rollenspel voor een makelaarsopleiding in Vlaanderen. Jij bent een eigenaar die zijn woning zelf verkoopt en gebeld wordt door een makelaar. Je zei net: "${o.b}". De makelaar antwoordde: """${antwoord}"""
Reageer als eigenaar met een NIEUW, ander bezwaar (regel van drie: de makelaar moet opnieuw ombuigen). Maximaal 2 korte zinnen, Vlaamse spreektaal, beleefd. Geef alleen wat de eigenaar zegt, zonder aanhalingstekens of uitleg.`;
}

function regels(c) {
  return `Je speelt een rollenspel voor de opleiding van nieuwe vastgoedmakelaars in Vlaanderen. Jij bent de EIGENAAR die gebeld wordt door een makelaar (de BELLER) die een afspraak wil. Blijf altijd in je rol.

Jouw rolkaart:
- Naam: ${c.naam}
- Situatie: ${c.sit}
- Verborgen bezwaar: ${c.bez} (zeg het niet meteen letterlijk bij het begin; laat het natuurlijk opduiken zodra de beller zijn reden van bellen geeft)
- Karakter: ${c.kar}
- Beslissingsnemers: ${c.dm}
- Wanneer je akkoord gaat: ${c.ok}

Spelregels:
- Antwoord zoals iemand aan de telefoon: kort, 1 tot 3 zinnen, beleefde Vlaamse spreektaal. Geen opsommingen, geen uitleg, geen regieaanwijzingen.
- Je kent het belscript niet en helpt de beller niet. Je geeft geen tips.
- De beller spreekt in en zijn tekst komt uit spraakherkenning. Lees wat hij bedoelt, ook als een zin vreemd, onvolledig of zonder leestekens is, en reageer als een echt mens aan de telefoon. Hang niet vast aan exacte woorden of aan het script.
- Zegt de beller "ja maar", gaat hij in discussie of begint hij aan de telefoon te verkopen (diensten opsommen, commissie uitleggen), dan word je kortafer.
- Erkent de beller je bezwaar (op welke manier ook), stelt hij je gerust en stelt hij concrete momenten voor, dan word je opener. Een oprechte, natuurlijke poging volstaat; wees geen onredelijke tegenspeler. Ga pas akkoord als de voorwaarde op je rolkaart vervuld is. Na de derde mislukte poging om een afspraak te maken, of bij aandringen, rond je beleefd af.
- Ga je akkoord, neem dan de dag en het uur over die de beller noemt. Vraagt de beller niet naar de andere beslissingsnemers, dan zeg je daar zelf niets over.
- Is het gesprek afgelopen (afspraak bevestigd en afgerond, of jij hangt op), eindig je laatste beurt met [EINDE].
- Schrijf nooit tekst voor de beller. De berichten van de beller beginnen met "BELLER:".`;
}

function promptBeoordeling(c, beurten, duur) {
  const gesprek = beurten.map((b) => (b.wie === "eigenaar" ? "EIGENAAR: " : "BELLER: ") + b.tekst).join("\n");
  return `Je bent een ervaren opleider van vastgoedmakelaars in Vlaanderen. Beoordeel dit oefengesprek (koude of warme telefonische prospectie) van een nieuwe makelaar met de observatiechecklist. Score per criterium: 0 = niet, 1 = deels, 2 = goed. Beoordeel op de bedoeling en het effect op de eigenaar, niet op de letterlijke woorden van het script. De tekst van de beller komt uit spraakherkenning: negeer tikfouten, ontbrekende leestekens en verkeerd herkende woorden. Geef 2 als het criterium duidelijk aanwezig is, ook in eigen woorden; 1 als het gedeeltelijk of onhandig gebeurt; 0 alleen als het echt ontbreekt. Baseer je enkel op wat er in het gesprek staat, en wees eerlijk maar bemoedigend.

Case: ${c.t}. Wat de beller wist: ${c.known}
Rolkaart van de eigenaar (de beller kende die niet): situatie: ${c.sit} Verborgen bezwaar: ${c.bez} Beslissingsnemers: ${c.dm} Voorwaarde voor akkoord: ${c.ok}
${c.lvl === "warm" ? "Dit is een warm gesprek: het doel is niet per se een afspraak, maar ontdekken wanneer en waarom de prospect wil verkopen en een volgend contact vastleggen. Beoordeel criteria 6, 7 en 9 in dat licht." : "Het enige doel van het gesprek is een afspraak; verkopen of de commissie uitleggen aan de telefoon is fout."}

Criteria:
${CRIT.map((x, i) => i + 1 + ". " + x).join("\n")}

Gesprek (duur ${duur}):
${gesprek}

Schrijf in het Nederlands, in de je-vorm. Antwoord met alleen JSON, zonder andere tekst:
{"criteria":[{"nr":1,"score":2,"toelichting":"max 15 woorden"}, ... alle 10],"afspraak":true,"sterkPunt":"één zin","tips":["concrete tip","concrete tip","concrete tip"],"betereZin":{"moment":"waar in het gesprek","zin":"wat je beter had gezegd"}}`;
}

// --------------------------------------------------------------- beurten

function leesBeurten(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_BEURTEN) return null;
  const beurten = raw.map((b) => ({ wie: b?.wie === "eigenaar" ? "eigenaar" : "beller", tekst: tekst(b?.tekst) }));
  // vaste volgorde: eigenaar neemt op, daarna om beurten beller – eigenaar
  for (let i = 0; i < beurten.length; i++) {
    if (beurten[i].wie !== (i % 2 === 0 ? "eigenaar" : "beller") || !beurten[i].tekst) return null;
  }
  return beurten;
}

// ---------------------------------------------------------------- handler

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ fout: "Enkel POST toegelaten." });
  const user = await gebruiker(req);
  if (!user) return res.status(401).json({ fout: "Niet aangemeld. Meld je opnieuw aan." });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ fout: "ANTHROPIC_API_KEY ontbreekt op de server." });
  const body = req.body || {};
  const aiActies = ["snelvuur", "tweede", "eigenaar", "beoordeel"];
  if (aiActies.includes(body.actie) && !(await remOk(user.id, body.actie))) {
    return res.status(429).json({ fout: `Je hebt het maximum van ${MAX_PER_UUR} AI-vragen per uur bereikt. Probeer het later opnieuw.` });
  }
  try {
    switch (body.actie) {
      case "snelvuur": {
        const o = OBJ.find((x) => x.id === Number(body.bezwaar));
        const antwoord = tekst(body.antwoord);
        if (!o || !antwoord) return res.status(400).json({ fout: "Bezwaar of antwoord ontbreekt." });
        const t = await vraagClaude({ model: MODEL_SNEL, max_tokens: 700,
          messages: [{ role: "user", content: promptSnelvuur(o, antwoord, tekst(body.tweede, 300)) }] });
        const j = leesJson(t);
        if (!j) return res.status(502).json({ fout: "De feedback kwam niet goed door. Probeer opnieuw." });
        await opslaan("snelvuur_pogingen", {
          user_id: user.id, bezwaar_id: o.id, ronde: [1, 2, 3].includes(Number(body.ronde)) ? Number(body.ronde) : 2,
          knuffel: !!j.knuffel?.ok, brug: !!j.brug?.ok, counter: !!j.counter?.ok, afspraak: !!j.afspraak?.ok, bron: "claude",
        });
        return res.status(200).json(j);
      }
      case "zelfcheck": {
        const o = OBJ.find((x) => x.id === Number(body.bezwaar));
        const s = body.stappen || {};
        if (!o) return res.status(400).json({ fout: "Bezwaar ontbreekt." });
        await opslaan("snelvuur_pogingen", {
          user_id: user.id, bezwaar_id: o.id, ronde: [1, 2, 3].includes(Number(body.ronde)) ? Number(body.ronde) : 2,
          knuffel: !!s.knuffel, brug: !!s.brug, counter: !!s.counter, afspraak: !!s.afspraak, bron: "zelf",
        });
        return res.status(200).json({ ok: true });
      }
      case "tweede": {
        const o = OBJ.find((x) => x.id === Number(body.bezwaar));
        if (!o) return res.status(400).json({ fout: "Bezwaar ontbreekt." });
        const t = await vraagClaude({ model: MODEL_SNEL, max_tokens: 150,
          messages: [{ role: "user", content: promptTweede(o, tekst(body.antwoord) || "(mondeling)") }] });
        return res.status(200).json({ tekst: t.replace(/^["“]|["”]$/g, "") });
      }
      case "eigenaar": {
        const c = CASES.find((x) => x.id === Number(body.case));
        const beurten = leesBeurten(body.beurten);
        if (!c || !beurten || (beurten.length && beurten[beurten.length - 1].wie !== "beller")) {
          return res.status(400).json({ fout: "Ongeldig gesprek." });
        }
        const messages = [{ role: "user", content: regels(c) + "\n\n[De telefoon gaat. Je neemt op. Zeg alleen wat je zegt bij het opnemen.]" }];
        for (const b of beurten) messages.push(b.wie === "eigenaar" ? { role: "assistant", content: b.tekst } : { role: "user", content: "BELLER: " + b.tekst });
        const t = await vraagClaude({ model: MODEL_SNEL, max_tokens: 250, messages });
        const einde = /\[EINDE\]/.test(t);
        return res.status(200).json({ tekst: t.replace(/\[EINDE\]/g, "").trim() || "…", einde });
      }
      case "beoordeel": {
        const c = CASES.find((x) => x.id === Number(body.case));
        const beurten = leesBeurten(body.beurten);
        if (!c || !beurten || beurten.filter((b) => b.wie === "beller").length < 1) return res.status(400).json({ fout: "Te kort gesprek om te beoordelen." });
        const t = await vraagClaude({ model: MODEL_GRONDIG, max_tokens: 1500,
          messages: [{ role: "user", content: promptBeoordeling(c, beurten, tekst(body.duur, 10)) }] });
        const j = leesJson(t);
        if (!j) return res.status(502).json({ fout: "De beoordeling kwam niet goed door. Probeer opnieuw." });
        const crit = Array.isArray(j.criteria) ? j.criteria : [];
        const scores = CRIT.map((_, i) => {
          const f = crit.find((x) => Number(x?.nr) === i + 1) || crit[i] || {};
          return Math.max(0, Math.min(2, Math.round(Number(f.score) || 0)));
        });
        const [m, sec] = tekst(body.duur, 10).split(":").map(Number);
        await opslaan("rollenspellen", {
          user_id: user.id, case_id: c.id, score: scores.reduce((a, b) => a + b, 0), afspraak: !!j.afspraak,
          duur_sec: Number.isFinite(m) && Number.isFinite(sec) ? m * 60 + sec : null, criteria: scores,
        });
        return res.status(200).json(j);
      }

      default:
        return res.status(400).json({ fout: "Onbekende actie." });
    }
  } catch (err) {
    if (err.status === 429) return res.status(429).json({ fout: "De AI-dienst is even overbelast. Probeer het zo meteen opnieuw." });
    console.error(err);
    return res.status(502).json({ fout: "De AI-dienst is momenteel niet bereikbaar. Probeer het straks opnieuw." });
  }
}
