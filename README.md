# Belcoach Prospectie

Oefentool bij module 3 van de opleiding nieuwe makelaars: bezwaren-snelvuur, rollenspelen met Claude als eigenaar, spiekbrief en voortgang.

Dit is de zelfstandige versie, los van claude.ai. Ze werkt zoals de taxatie-app: een gewone website op Vercel, met een AI-tussenlaag (`api/coach.js`) die de Anthropic API-sleutel geheim houdt op de server.

## Bestanden

| Bestand | Wat |
|---|---|
| `index.html` | De volledige pagina (opmaak en werking) |
| `content.js` | De 20 bezwaren, de 12 cases en de observatiechecklist. Pas hier de inhoud aan. |
| `api/coach.js` | De AI-tussenlaag. Bouwt de instructies voor Claude op de server en controleert of de gebruiker aangemeld is. Schrijft scores weg in Supabase. |
| `vercel.json` | Beveiligingsinstellingen en maximale duur van de AI-functie |

## Online zetten (eenmalig, ongeveer 15 minuten)

1. **GitHub:** maak op github.com een nieuwe, privé repository aan met de naam `belcoach`.
2. **Code opsturen:** open Terminal en voer uit:

   ```
   cd ~/Desktop/"Belcoach - live"
   git init
   git add .
   git commit -m "Belcoach eerste versie"
   git branch -M main
   git remote add origin https://github.com/thijshoupels/belcoach.git
   git push -u origin main
   ```

3. **Vercel:** ga naar vercel.com → *Add New… → Project* → kies de repository `belcoach` → *Deploy*. Laat alle instellingen op de standaardwaarde (geen framework, geen build-commando).
4. **Instellingen:** in Vercel → het project → *Settings → Environment Variables*, voeg toe:
   - `ANTHROPIC_API_KEY`: een API-sleutel van console.anthropic.com, bij voorkeur een aparte sleutel "Belcoach" met een maandlimiet.
   - `SUPABASE_URL`: `https://wfxjzmmiunilqgffznlv.supabase.co`
   - `SUPABASE_PUBLISHABLE_KEY`: staat in `.env.example`
   - `SUPABASE_SECRET_KEY`: Supabase → project belcoach → *Project Settings → API Keys → Secret keys*. Geheim: enkel in Vercel plakken, nooit in de code of in een chat.
5. **Opnieuw publiceren:** *Deployments* → bij de laatste deployment *Redeploy*, zodat de instellingen actief worden.
6. **Eigen adres (optioneel):** *Settings → Domains*, bv. `belcoach.huyzen.be`.

## Na een aanpassing

```
cd ~/Desktop/"Belcoach - live"
git add .
git commit -m "Aanpassing Belcoach"
git push
```

Vercel zet de nieuwe versie automatisch online.

## Gebruikers beheren

- Nieuwe deelnemer: Supabase → project belcoach → *Authentication → Users → Invite user*. De deelnemer meldt zich daarna aan met een link per mail.
- Inschrijven zonder uitnodiging staat uit (*Authentication → Sign In / Providers → Allow new users to sign up*).
- Na de eerste deploy: zet in Supabase bij *Authentication → URL Configuration* de **Site URL** op het adres van de Belcoach (bv. `https://belcoach.vercel.app`).
- Lesgevers zien onder **Groep** de voortgang van alle deelnemers.

## Kosten

Je betaalt enkel wat de deelnemers gebruiken, via je Anthropic API-account. Ruwe schatting met de huidige prijzen:

- Snelvuur-feedback (Claude Haiku): ongeveer $0,002 per bezwaar.
- Rollenspel van 10 beurten (Haiku) met beoordeling (Claude Sonnet): ongeveer $0,05.
- 6 deelnemers die elk 20 rollenspelen en 100 bezwaren per maand oefenen: ongeveer $8 per maand.

Zet in console.anthropic.com een maandlimiet op de sleutel, dan kan het nooit uit de hand lopen.

## Veiligheid

- De API-sleutel staat alleen in Vercel, nooit in de code.
- De pagina stuurt geen vrije vragen naar Claude, enkel een actie met een case- of bezwaarnummer en de tekst van de makelaar. De instructies staan vast op de server, dus niemand kan de tool gebruiken als gratis chatbot.
- Zonder geldige aanmelding weigert de server elke AI-vraag.
- Er is een rem van 120 AI-vragen per uur per gebruiker.
- In de database staan enkel naam, e-mailadres, scores per stap en per criterium. Antwoordteksten en gesprekken worden niet bewaard.
- Elke deelnemer ziet enkel zijn eigen scores; de lesgever ziet alles. Scores schrijft enkel de server weg, niemand kan zijn eigen score aanpassen.
