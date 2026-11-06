/// <reference lib="webworker" />
// One worker, any engine: the engine package is loaded on first use from ./<engine>/<engine>.js.
const DOCUMENT_CLASS = { pdfcraft: 'PdfDocument', wordcraft: 'DocxDocument', gridcraft: 'XlsxDocument', deckcraft: 'PptxDocument' }
const loaded = new Map()

async function load(engine) {
  if (!DOCUMENT_CLASS[engine]) throw new Error(`Unknown engine ${engine}`)
  if (!loaded.has(engine)) {
    loaded.set(engine, (async () => {
      const module = await import(`./${engine}/${engine}.js`)
      const response = await fetch(new URL(`./${engine}/${engine}_bg.wasm`, import.meta.url))
      if (!response.ok) throw new Error(`wasm ${response.status}`)
      await module.default({ module_or_path: await response.arrayBuffer() })
      return module[DOCUMENT_CLASS[engine]]
    })())
    loaded.get(engine).catch(() => loaded.delete(engine))
  }
  return loaded.get(engine)
}

let doc = null

self.onmessage = async (event) => {
  const { id, method, engine, bytes, password, page, scale } = event.data
  try {
    if (method === 'open') {
      const Document = await load(engine)
      doc?.free()
      doc = null
      doc = new Document(bytes, password)
      self.postMessage({ id, metadata: JSON.parse(doc.metadata()) })
    } else if (method === 'page') {
      if (!doc) throw new Error('No document')
      const png = doc.renderPage(page, scale)
      const text = doc.pageText(page)
      self.postMessage({ id, png: png.buffer, text }, [png.buffer])
    } else if (method === 'close') {
      doc?.free()
      doc = null
      self.postMessage({ id })
    }
  } catch (error) {
    self.postMessage({ id, error: String(error?.message ?? error) })
  }
}
