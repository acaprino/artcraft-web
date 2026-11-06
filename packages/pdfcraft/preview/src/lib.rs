//! Read-only PDF preview: parse, render pages to PNG, and return the selectable text layer.

use std::sync::Arc;

use pdfcraft_render::{PageRenderer, RenderConfig, RenderRequest, RequestKind};
use serde::Serialize;
use wasm_bindgen::prelude::*;

const MAX_INPUT_BYTES: usize = 100 * 1024 * 1024;
const MAX_PAGES: usize = 5000;

#[derive(Serialize)]
struct PageMeta {
    width: f32,
    height: f32,
    label: String,
}

#[derive(Serialize)]
struct Metadata {
    engine: &'static str,
    version: &'static str,
    title: Option<String>,
    pages: Vec<PageMeta>,
    warnings: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextRun {
    text: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

#[wasm_bindgen]
pub struct PdfDocument {
    renderer: std::cell::RefCell<PageRenderer>,
    metadata: String,
    pages: usize,
}

#[wasm_bindgen]
impl PdfDocument {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8], password: Option<String>) -> Result<PdfDocument, JsValue> {
        Self::load(bytes, password).map_err(|m| JsValue::from_str(&m))
    }

    pub fn metadata(&self) -> String {
        self.metadata.clone()
    }

    #[wasm_bindgen(js_name = renderPage)]
    pub fn render_page(&self, index: usize, scale: f32) -> Result<Vec<u8>, JsValue> {
        self.render(index, scale).map_err(|m| JsValue::from_str(&m))
    }

    #[wasm_bindgen(js_name = pageText)]
    pub fn page_text(&self, index: usize) -> Result<String, JsValue> {
        self.text(index).map_err(|m| JsValue::from_str(&m))
    }
}

impl PdfDocument {
    fn load(bytes: &[u8], password: Option<String>) -> Result<Self, String> {
        if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES {
            return Err("Choose a PDF file no larger than 100 MiB.".into());
        }
        let data = Arc::new(bytes.to_vec());
        let info = pdfcraft_render::inspect(data.clone(), password.as_deref()).map_err(|e| e.to_string())?;
        if info.pages.is_empty() || info.pages.len() > MAX_PAGES {
            return Err(format!("The document must have between 1 and {MAX_PAGES} pages."));
        }
        let config = RenderConfig { password: password.map(|p| Arc::from(p.as_str())), reject_oversize: true, ..Default::default() };
        let renderer = PageRenderer::new(data, config);
        let metadata = Metadata {
            engine: "PdfCraft",
            version: option_env!("JCODE_CRAFT_ENGINE_VERSION").unwrap_or("unknown"),
            title: info.title.clone(),
            pages: info.pages.iter().map(|p| PageMeta { width: p.width, height: p.height, label: p.label.clone() }).collect(),
            warnings: Vec::new(),
        };
        Ok(Self {
            pages: info.pages.len(),
            renderer: std::cell::RefCell::new(renderer),
            metadata: serde_json::to_string(&metadata).map_err(|e| e.to_string())?,
        })
    }

    fn render(&self, index: usize, scale: f32) -> Result<Vec<u8>, String> {
        if index >= self.pages {
            return Err("The page does not exist.".into());
        }
        if !scale.is_finite() || !(0.25..=3.0).contains(&scale) {
            return Err("The page scale must be between 0.25 and 3 pixels per point.".into());
        }
        let page = self.renderer.borrow_mut().render(RenderRequest { page: index, kind: RequestKind::Pixels, scale, ..Default::default() });
        if let Some(error) = page.error {
            return Err(error);
        }
        let mut rgba = page.rgba.to_vec();
        for px in rgba.chunks_exact_mut(4) {
            let a = u32::from(px[3]);
            if a != 0 && a != 255 {
                for c in &mut px[..3] {
                    *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
                }
            }
        }
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, page.width, page.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header().and_then(|mut w| w.write_image_data(&rgba)).map_err(|e| e.to_string())?;
        Ok(out)
    }

    fn text(&self, index: usize) -> Result<String, String> {
        if index >= self.pages {
            return Err("The page does not exist.".into());
        }
        let page = self.renderer.borrow_mut().render(RenderRequest { page: index, kind: RequestKind::Text, scale: 1.0, ..Default::default() });
        if let Some(error) = page.error {
            return Err(error);
        }
        let text = page.text.ok_or("No text layer.")?;
        let mut runs = Vec::new();
        for (i, g) in text.glyphs.iter().enumerate() {
            let [x0, y0, x1, y1] = g.rect;
            let same_line = i > 0 && text.line_of.get(i) == text.line_of.get(i - 1) && !text.space_before.get(i).copied().unwrap_or(false);
            if let (true, Some(last)) = (same_line, runs.last_mut()) {
                let last: &mut TextRun = last;
                last.text.push_str(&g.text);
                last.width = (x1 - last.x).max(last.width);
                last.height = last.height.max(y1 - y0);
                continue;
            }
            runs.push(TextRun { text: g.text.clone(), x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
        }
        serde_json::to_string(&runs).map_err(|e| e.to_string())
    }
}
