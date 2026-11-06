# artcraft-web

Librerie WebAssembly riusabili della suite ArtCraft (PdfCraft, WordCraft, GridCraft, DeckCraft), **solo anteprima/lettura**, da usare in un Web Worker in Sparklone, JanuraCode e siti web esterni.

| Motore | Formati | Classe | Upstream (pin) |
| --- | --- | --- | --- |
| `pdfcraft` | PDF | `PdfDocument` | storytold/pdfcraft v0.18.1 |
| `wordcraft` | DOCX | `DocxDocument` | storytold/wordcraft v0.11.0 |
| `gridcraft` | XLSX, XLSM | `XlsxDocument` | storytold/gridcraft v0.12.1 |
| `deckcraft` | PPTX, PPTM | `PptxDocument` | storytold/deckcraft v0.11.1 |

API comune: `new Document(bytes)` (PDF: `, password`), `metadata()`, `renderPage(index, scale) -> PNG`, `pageText(index)`, `free()`.

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
```

Struttura:
- `pins/<motore>.json`: repo, tag, commit, rust, wasm-bindgen fissati
- `packages/<motore>/preview/`: crate overlay aggiunto al workspace upstream (`lock-package.txt` per `--locked`)
- `build.mjs`, `scripts/`: build, release, aggiornamento pin, verifica `dist/`
- `test/`: fixture generate in memoria, prova Node, prova browser, server demo
- `.cache/` (checkout e tool), `dist/`, `release/`: generati, ignorati da git

Procedura di aggiornamento upstream, limiti di risorse e contratto API: `AGENTS.md`.
