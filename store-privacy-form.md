# Chrome Web Store — Privacy practices form (texte de lipit)

Verificat față de cod la versiunea 0.3.8 (rute în `server/routes/*`, `manifest.json`,
`extension/lib/*`). Formularul CWS e în engleză → textele de mai jos sunt în engleză.
Politica de confidențialitate oficială: https://web-annotation-extension-production.up.railway.app/privacy

---

## 1. Single purpose (un singur scop)

> Adormis lets people draw, add text bubbles, shapes, and leave comments directly on top of
> any web page or video, and see the annotations and per-page chat left by others. Everything
> the extension does serves this single purpose: visual annotation and discussion on web pages.

---

## 2. Permission justifications (justificarea permisiunilor)

**storage**
> Stores, via chrome.storage.local, the user's locally generated anonymous identifier, their
> chosen server address, their consent choice, and small UI preferences such as the toolbar
> position. No browsing data is stored for tracking.

**alarms**
> Schedules a once-per-hour check against our server for a newer extension version, so the
> extension can show an "update available" indicator on its icon. It performs no background
> data collection.

**Host access — content scripts on all http/https sites**
> Adormis is a general-purpose annotation tool, so users must be able to draw and comment on
> any web page or video they choose; the content script therefore has to be allowed on all
> http(s) sites. The extension shows its UI only when the user opens the toolbar, does not read
> or transmit page contents in the background, and sends data to our server only when the user
> deliberately creates an annotation or a chat message.

**Remote code:** No. All executable code ships inside the package; nothing is fetched and run
at runtime.

---

## 3. Data collection — ce se bifează la „What user data do you plan to collect?”

BIFEAZĂ aceste categorii (fiecare e adevărată în cod):

- [x] **Authentication information**
  > Optional account: a user-chosen username (display name) plus a password, stored only as a
  > salted scrypt hash. Each install also gets a locally generated random identifier.

- [x] **Personal communications**
  > The optional per-page chat lets signed-in users post short text messages to others viewing
  > the same page.

- [x] **Web history**
  > When the user chooses to place an annotation or send a chat message on a page, that page's
  > URL is sent and stored, so the annotation can be shown there again and on the author's
  > public profile. Pages the user merely visits are never sent — reads use a one-way SHA-256
  > hash of the URL, so the server never learns which pages a user browses.

- [x] **User activity**
  > Up/down votes, content reports, and — only while "watch together" is on — the current video
  > timestamp of the page.

- [x] **Website content**
  > The annotation content the user creates (text, drawings, shapes, links) and a CSS
  > selector/anchor describing where on the page it was placed.

NU bifa (fals în cod):

- [ ] Location — no geolocation is used.
- [ ] Health information — none.
- [ ] Financial and payment information — the optional "Buy me a coffee" button opens PayPal's
      own website; the extension never handles payment data.
- [ ] Personally identifiable information — no name, email, age or ID is required or requested.
      (Vezi nota de mai jos despre numele afișat.)

---

## 4. Data usage certifications (cele 3 bife de la final) — toate ADEVĂRATE, bifează-le pe toate

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

---

## 5. Privacy policy URL

> https://web-annotation-extension-production.up.railway.app/privacy

---

## Note (pentru tine, NU de lipit în formular)

- **Numele afișat:** e opțional și ales de utilizator (pseudonim). L-am declarat la
  „Authentication information” fiindcă e numele de utilizator al contului. Dacă un recenzor
  întreabă, răspunsul e: numele e opțional, ales liber, nu e cerut un nume real; parola e doar
  hash scrypt. Nu bifa „Personally identifiable information” decât dacă îți cere expres Google.
- **IP-ul:** serverul vede IP-ul oricărei cereri (inevitabil, ca orice site), dar îl păstrează
  doar ca amprentă HMAC, maximum 24 h, pentru limitarea abuzului — nu e stocat ca atare. E
  descris în politica de confidențialitate.
- **Potrivirea obligatorie:** ce bifezi aici trebuie să fie în acord cu textul de la `/privacy`.
  Ambele spun același lucru: adresa paginilor adnotate + conținutul adnotărilor + chatul sunt
  publice; paginile doar vizitate nu se trimit (doar hash).
- Cea mai frecventă cauză de respingere e sub-declararea la „Web history”/„Website content” —
  de-aia le-am bifat, deși sună mult: e mai sigur să declari complet.
