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
3. Il crate overlay `packages/<motore>/preview/` è il nostro adattamento permanente, copiato nel checkout come membro `jcode-preview` del workspace upstream. Se l'upstream cambia le API usate (`wordcraft-*`, `gridcraft-*`, `deckcraft-*`, `pdfcraft-render`, tipi `Workbook`/`Sheet`…) il crate va adattato **in `packages/`**, mai nella cache. La build aggiunge il crate al `Cargo.lock` upstream con `cargo metadata` e compila con `--locked`: si ferma se cambia la versione di un pacchetto upstream.
4. **WordCraft fornisce i font a tutti** (`JCODE_CRAFT_FONT_DIR` = `assets/fonts` del suo checkout): se il suo pin cambia, ricompilare tutti i motori.
5. `npm run release` (build + `npm test` + installazione dei tarball), poi `npm run test:browser`. Alzare `version` in `package.json` per ogni release distribuita (semver: patch = stesso upstream/fix, minor = nuovo upstream o API compatibile, major = API rotta).
6. Rileggere i warning della build: licenze (`LICENSE-*`, `OFL-*`, `epaint-*` per Grid/Deck) e `provenance.json` devono restare completi (`verifyDist` in `scripts/common.mjs` li impone). Aggiornare questa pagina e il README se cambia il comportamento.

Il toolchain Rust è fissato per motore in `rust` del pin: aggiornarlo è lo stesso passo (nuova release stabile → pin → build completa). `rustup target add wasm32-unknown-unknown --toolchain <rust>` e `wasm-bindgen-cli` (`.cache/tools/wasm-bindgen-<versione>/bin`) li installa la build se mancano (serve la rete la prima volta).

Storico adozioni: 2026-11-06 pin spostati a pdfcraft v0.18.2, wordcraft v0.15.2, gridcraft v0.16.1 (adattamento: `active_sheet = tile.sheet.into()`), deckcraft v0.15.1; release 0.2.0 verificata con smoke, browser e installazione dei tarball. Con gridcraft v0.16.1 `epaint_default_fonts` viene dal checkout git di storytold/egui (non piu dal registry) e include `egui-icons.txt`: le note si leggono dal git cache di Cargo, e il wasm di GridCraft sale a ~18 MB. Controllare sempre con `npm run upstream:check` prima di un nuovo giro.

## Aggiornamento automatico (`update-and-release.bat`)

Lungo (fino a ~2 ore), da avviare a mano, **riprendibile**: se si ferma (errore, riavvio, finestra chiusa, kill) si rilancia lo stesso comando e continua da `logs/update-state.json`. Sposta i pin, ricompila i motori cambiati, esegue smoke e browser test, alza la versione minor e produce `release/`. Non fa mai push.

| Comando | Effetto |
| --- | --- |
| `update-and-release.bat` | nuovo aggiornamento, oppure continua quello non finito |
| `--status` | mostra i passi tracciati (pin, build per motore e tentativi, test, versione, release) |
| `--commit` | committa a fine corsa (mai push) |
| `--force` | ricompila e rilascia anche senza release nuove |
| `--resume` | adotta anche una corsa interrotta senza file di stato (pin diversi da HEAD) |
| `--rollback` | annulla (pin, packages e versione a HEAD; rimuove stato, `.cache` dei motori spostati e target Cargo) |

Come riprende: lo stato JSON segna ogni passo prima e dopo l'esecuzione (scrittura atomica); alla ripresa un passo non `done` viene rifatto, uno `done` viene saltato se ancora valido (`dist/` verificato contro il pin con `verifyDist`, `release/manifest.json` contro la versione, commit già fatto). Il target Cargo di un motore resta finché il motore non è finito, quindi una compilazione interrotta riparte dai crate già compilati. Si rifiuta di riprendere se HEAD è cambiato dall'inizio. Se i pin cambiano mentre è in corso (es. un nuovo `--force`), lo stato precedente ha la precedenza: usare `--rollback` per ricominciare.

Log: `logs/update-*.log` (tutto l'output), `logs/update-state.json`, `logs/last-error.txt`, `logs/launcher.log`.

**Se fallisce dopo lo spostamento dei pin** (tipico: le API upstream sono cambiate e il crate overlay non compila) non annulla nulla: pin, stato e `.cache/<motore>` restano per la correzione e scrive `logs/llm-handoff.md` con errori del compilatore estratti e prompt pronto. Procedura per l'LLM:
1. Leggere `logs/llm-handoff.md` e l'errore; adattare **solo** `packages/<motore>/preview` (mai `.cache`), senza rompere il contratto API.
2. Verificare con `node build.mjs <motore>` e `node test/smoke.mjs <motore>`.
3. Rilanciare `update-and-release.bat`: salta i motori già compilati, poi test, versione, release.
4. Se non è adattabile: `update-and-release.bat --rollback` e riferire il motivo.
Un crash per memoria (0xc0000409) è ritentato fino a 3 volte; un errore di compilazione no. Se il crash resta, nel handoff è indicato come memoria, non come bug del codice.

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
