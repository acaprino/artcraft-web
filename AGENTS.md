# Regole del progetto artcraft-web

Pacchetti WebAssembly di sola anteprima (PdfCraft, WordCraft, GridCraft, DeckCraft) per applicativi web esterni, Sparklone e JanuraCode. Upstream: `https://github.com/storytold/<motore>`. Riferimento gemello: `D:\Projects\janura-code` (`bundle/wordcraft.ts`, `packages/<motore>/preview`, `<motore>.json`), che ha lo stesso schema per Word/Grid/Deck.

## Comandi

| Scopo | Comando |
| --- | --- |
| Compilare uno o tutti i motori in `dist/<motore>/` | `npm run build` oppure `node build.mjs wordcraft gridcraft` |
| Prova in Node di ogni motore (API, errori, pin, hash) | `npm test` |
| Prova nel browser (Edge headless, Web Worker + wasm) | `npm run test:browser` |
| **Release dei pacchetti** (build, verifica, `npm pack`, installazione di prova) | `npm run release` (`release:fast` riusa `dist/`) |
| Demo locale su `http://127.0.0.1:8080/` | `npm run demo` |
| Novità upstream (non modifica nulla) | `npm run upstream:check` |
| Spostare un pin | `node scripts/update-upstream.mjs <motore> [--tag vX.Y.Z]` |

`npm run release` produce in `release/` un `.tgz` per motore (`@artcraft-web/<motore>`, versione = `version` di `package.json`), `SHA256SUMS` e `manifest.json`, poi installa i tarball in un progetto vuoto e li usa tramite gli entry point del pacchetto. Ogni release cancella la precedente: in `release/` resta solo quella corrente.

Uso in un'app esterna: `npm i /percorso/artcraft-web-wordcraft-0.1.0.tgz` (o URL), poi `import init, { DocxDocument } from '@artcraft-web/wordcraft'`; il `.wasm` si serve da `@artcraft-web/<motore>/wasm`. Usare sempre un Web Worker (render sincrono). Dettagli: README.md.

## Aggiornamento upstream (procedura obbligatoria, manuale)

Né la build né i test aggiornano l'upstream. Ogni pin sta in `pins/<motore>.json` (repo, tag, commit, rust, wasmBindgen); la build rifiuta un checkout il cui commit non coincide.

1. `npm run upstream:check`: tag corrente e ultima release `vX.Y.Z` per motore. Verificare release, tag e commit sul repo ufficiale.
2. `node scripts/update-upstream.mjs <motore>` (o `--tag`): riscrive tag, commit e `wasmBindgen` leggendoli dal tag clonato e cancella `.cache/<motore>`. Se `wasmBindgen` cambia, aggiornare anche `wasm-bindgen = "=X"` in **tutti** i `packages/*/preview/Cargo.toml` (la versione deve essere identica in tutti i crate e nel `wasm-bindgen-cli` in `.cache/tools`).
3. Il crate overlay `packages/<motore>/preview/` è il nostro adattamento permanente, copiato nel checkout come membro `jcode-preview` del workspace upstream. Se l'upstream cambia le API usate (`wordcraft-*`, `gridcraft-*`, `deckcraft-*`, `pdfcraft-render`, tipi `Workbook`/`Sheet`…) il crate va adattato **in `packages/`**, mai nella cache. `lock-package.txt` elenca le dipendenze del crate per `--locked`: rigenerarlo se cambiano.
4. **WordCraft fornisce i font a tutti** (`JCODE_CRAFT_FONT_DIR` = `assets/fonts` del suo checkout): se il suo pin cambia, ricompilare tutti i motori.
5. `npm run release` (build + `npm test` + installazione dei tarball), poi `npm run test:browser`. Alzare `version` in `package.json` per ogni release distribuita (semver: patch = stesso upstream/fix, minor = nuovo upstream o API compatibile, major = API rotta).
6. Rileggere i warning della build: licenze (`LICENSE-*`, `OFL-*`, `epaint-*` per Grid/Deck) e `provenance.json` devono restare completi (`verifyDist` in `scripts/common.mjs` li impone). Aggiornare questa pagina e il README se cambia il comportamento.

Il toolchain Rust è fissato per motore in `rust` del pin: aggiornarlo è lo stesso passo (nuova release stabile → pin → build completa). `rustup target add wasm32-unknown-unknown --toolchain <rust>` e `wasm-bindgen-cli` (`.cache/tools/wasm-bindgen-<versione>/bin`) li installa la build se mancano (serve la rete la prima volta).

Release upstream disponibili all'ultimo controllo (2026-11-06) e non ancora adottate: pdfcraft v0.18.2, wordcraft v0.15.2, gridcraft v0.16.1, deckcraft v0.15.1. Adottarle richiede la verifica completa sopra: i crate overlay sono scritti sulle API di v0.11/v0.12/v0.18.

## Contratto API (non romperlo)

`new Document(bytes[, password])`, `metadata()` (JSON: `engine`, `version` = tag del pin, `pages[]`, `warnings`), `renderPage(index, scale) -> PNG`, `pageText(index)` (JSON di run con `text`, `x`, `y`, `width`, `height`…), `free()`. Errori sempre come eccezione intercettabile, mai un abort del wasm. GridCraft: `pageText(i)` ha contenuto solo dopo `renderPage(i)`. La versione riportata dal wasm viene da `JCODE_CRAFT_ENGINE_VERSION` (= `tag` del pin): niente versioni scritte a mano nei crate. Gli originali sono in sola lettura e i limiti dei documenti (dimensione, pagine, pixel) non si aggirano per far passare una prova.

## Risorse della macchina e disco

- Il disco `D:` ha poco spazio libero (era ~0,7 GB): `target/` di Cargo vale 0,5–1 GB per motore. La build cancella `target/` a ogni motore compiuto (`--keep-target` per tenerlo) e `ARTCRAFT_TARGET_DIR` lo sposta su un altro disco (usato: `C:\Users\alfio\AppData\Local\Temp\opencode\artcraft-target`).
- `CARGO_BUILD_JOBS` vale 1 per scelta: con 2 job `rustc` è terminato con `STATUS_STACK_BUFFER_OVERRUN` (0xc0000409, commit di memoria quasi esaurito). Alzarlo solo con memoria libera. Una build di Grid/Deck dura ~45 min.
- Compilare un motore alla volta; non lanciare più build in parallelo.
- Nessuna copia, backup o archivio: in `dist/` solo la build corrente, in `release/` solo la release corrente, in `.cache/` solo checkout e tool dei pin correnti (un `wasm-bindgen-<versione>`). Script una tantum e output di prova vanno nella cartella temporanea della sessione, eliminati a fine lavoro.

## Altro

- Commit e push solo su richiesta esplicita. `.cache/`, `dist/`, `release/`, `node_modules/` sono ignorati da git.
- Non committare binari di fixture: i documenti di prova si generano in memoria (`test/fixtures.mjs`).
- Verifiche dichiarate solo se eseguite: `npm test`, `npm run test:browser` e `npm run release` con esito letto, per tutti e quattro i motori.
