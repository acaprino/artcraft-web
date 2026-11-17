# artcraft-web

Librerie WebAssembly riusabili della suite ArtCraft (PdfCraft, WordCraft, GridCraft, DeckCraft), **solo anteprima/lettura**, da usare in un Web Worker in Sparklone, JanuraCode e siti web esterni.

| Motore | Formati | Classe | Upstream (pin) |
| --- | --- | --- | --- |
| `pdfcraft` | PDF | `PdfDocument` | storytold/pdfcraft v0.18.2 |
| `wordcraft` | DOCX | `DocxDocument` | storytold/wordcraft v0.15.2 |
| `gridcraft` | XLSX, XLSM | `XlsxDocument` | storytold/gridcraft v0.16.1 |
| `deckcraft` | PPTX, PPTM | `PptxDocument` | storytold/deckcraft v0.15.1 |

API comune: `new Document(bytes)` (PDF: `, password`), `metadata()`, `renderPage(index, scale) -> PNG`, `pageText(index)`, `free()`.

## Release

Ogni versione distribuita è un tag annotato `v<versione>` (la `version` di `package.json`) sul commit di release, con la sua GitHub Release su `acaprino/artcraft-web` (pubblica), pubblicate dal workflow a ogni merge di `develop` in `main` (etichette `release:minor`/`release:major` per minor e major): un `.tgz` per motore, `manifest.json` e `SHA256SUMS`. Qemille ed Ethel scaricano sempre l'ultima release, senza fissarne una.

```sh
update-and-release.bat --commit      # su develop: pin all'ultimo upstream, build, test, commit
# poi la pull request develop -> main: il merge pubblica la release (tag e GitHub Release)
```

Una versione pubblicata non si sostituisce: una nuova release vuole una nuova versione.

## Usare i pacchetti in un'app web

```sh
npm run release                       # produce release/*.tgz (un pacchetto per motore)
npm i /percorso/release/artcraft-web-wordcraft-0.1.0.tgz
```

```js
import init, { DocxDocument } from '@artcraft-web/wordcraft'
await init()                          // bundler: carica il .wasm accanto al modulo
const doc = new DocxDocument(bytes)
const png = doc.renderPage(0, 1.5)    // Uint8Array PNG
const runs = JSON.parse(doc.pageText(0))
doc.free()
```

Per servire il wasm a parte: `@artcraft-web/wordcraft/wasm` (es. `init({ module_or_path: url })`). Esempio completo con Worker: `demo/`.

## Sviluppo

Requisiti: Node ≥ 24.2, Rust via rustup (il toolchain del pin viene usato da `RUSTUP_TOOLCHAIN`), `git`, `tar`, Edge per il test browser. Prima installazione: `npm install`.

```sh
npm run build [motore ...]    # dist/<motore>/ (lento: Grid/Deck ~45 min, un motore alla volta)
npm test                      # prova Node di tutti i motori
npm run test:browser          # prova Edge headless con Worker
npm run release               # build + test + tarball + installazione di prova
npm run upstream:check        # nuove release upstream
update-and-release.bat       # aggiorna pin, ricompila, testa, rilascia (lungo, log in logs/)
```

Struttura:
- `pins/<motore>.json`: repo, tag, commit, rust, wasm-bindgen fissati
- `packages/<motore>/preview/`: crate overlay aggiunto al workspace upstream
- `build.mjs`, `scripts/`: build, release, aggiornamento pin, verifica `dist/`
- `test/`: fixture generate in memoria, prova Node, prova browser, server demo
- `.cache/` (checkout e tool), `dist/`, `release/`: generati, ignorati da git

Procedura di aggiornamento upstream, limiti di risorse e contratto API: `AGENTS.md`.
