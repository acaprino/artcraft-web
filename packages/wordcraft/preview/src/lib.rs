//! Read-only DOCX preview using Wordcraft's DOCX importer, pagination and CPU renderer.
//! The browser owns the file bytes and page images; no document is saved or converted to PDF.

use std::io::{Cursor, Read};

use serde::Serialize;
use wasm_bindgen::prelude::*;
use wordcraft_doc::{Document, Pos, StoryRef};
use wordcraft_layout::display::{Draw, page_display};
use wordcraft_layout::{DocLayout, LayoutCache, LayoutOptions, Page};
use wordcraft_render::{RenderOptions, render_page};

const MAX_INPUT_BYTES: usize = 100 * 1024 * 1024;
const MAX_PART_BYTES: u64 = 32 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 128 * 1024 * 1024;
const MAX_PARTS: usize = 8192;
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_PARAGRAPHS: usize = 100_000;
const MAX_PAGES: usize = 1000;
const MAX_RENDER_PIXELS: f64 = 16_000_000.0;
const MAX_IMAGE_PIXELS: u64 = 16_000_000;
const MAX_PAGE_RUNS: usize = 50_000;
/// Embedded font files taken from one document, and their total decoded size. The package budgets
/// above already bound the input; these keep the decoded copies in the same order of magnitude.
const MAX_EMBEDDED_FONTS: usize = 32;
const MAX_EMBEDDED_FONT_BYTES: usize = 64 * 1024 * 1024;

const BUNDLED_FONTS_WARNING: &str =
    "Wordcraft uses bundled fonts. Unavailable original fonts can change the layout.";
const EMBEDDED_FONTS_WARNING: &str = "Some fonts embedded in the document could not be used (unreadable, or over the preview limit); that text draws in a substitute.";

#[derive(Serialize)]
struct PageInfo {
    width: f32,
    height: f32,
}

#[derive(Serialize)]
struct OutlineEntry {
    title: String,
    level: u8,
    page: usize,
    y: f32,
}

#[derive(Serialize)]
struct Metadata {
    engine: &'static str,
    /// The pinned upstream release tag this preview was compiled from (for example `v0.8.0`).
    /// `bundle/wordcraft.ts` sets the environment from `<engine>.json`; a literal here could
    /// silently outlive its pin.
    version: &'static str,
    pages: Vec<PageInfo>,
    text: String,
    outline: Vec<OutlineEntry>,
    warnings: Vec<&'static str>,
}

/// Transparent text-layer geometry, in page points, matching the rendered display list.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextRun {
    text: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    font_size: f32,
    font_family: String,
    rtl: bool,
    link: Option<String>,
}

/// An immutable document. `free()` releases its imported document and page layout.
/// Run in a module worker so loading and rendering do not block the application.
#[wasm_bindgen]
pub struct DocxDocument {
    document: Document,
    layout: DocLayout,
    options: RenderOptions,
    metadata: String,
}

#[wasm_bindgen]
impl DocxDocument {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<DocxDocument, JsValue> {
        Self::load(bytes).map_err(js_error)
    }

    /// JSON: {engine, version, pages:[{width,height}], text, outline}.
    pub fn metadata(&self) -> String {
        self.metadata.clone()
    }

    /// A PNG encoded directly from the Wordcraft page. Scale is pixels per page point.
    #[wasm_bindgen(js_name = renderPage)]
    pub fn render_page(&self, index: usize, scale: f32) -> Result<Vec<u8>, JsValue> {
        self.render(index, scale).map_err(js_error)
    }

    /// JSON array of selectable text runs for this page, including headers and footers.
    #[wasm_bindgen(js_name = pageText)]
    pub fn page_text(&self, index: usize) -> Result<String, JsValue> {
        self.text_runs(index)
            .and_then(|runs| serde_json::to_string(&runs).map_err(|error| error.to_string()))
            .map_err(js_error)
    }
}

fn js_error(message: String) -> JsValue {
    JsValue::from_str(&message)
}

impl DocxDocument {
    fn load(bytes: &[u8]) -> Result<Self, String> {
        check_package(bytes)?;
        let document = wordcraft_docx::read(bytes).map_err(|error| error.to_string())?;
        check_document(&document)?;
        let (_, fonts_incomplete) = install_embedded_fonts(&document);

        // The default print view retains the DOCX paper size, margins, tables and page breaks.
        let opts = LayoutOptions {
            hide_deleted: true,
            ..Default::default()
        };
        let layout = wordcraft_layout::layout(&document, &mut LayoutCache::new(), &opts);
        if layout.pages.is_empty() || layout.pages.len() > MAX_PAGES {
            return Err(format!(
                "The document must have between 1 and {MAX_PAGES} pages."
            ));
        }
        if layout.pages.iter().any(|page| !valid_page_size(page)) {
            return Err("The document has an unsupported page size.".into());
        }

        let mut options = RenderOptions::default();
        options.display.dim_header = false;
        options.display.markup = false;
        let metadata = document_metadata(&document, &layout, fonts_incomplete)?;
        Ok(Self {
            document,
            layout,
            options,
            metadata,
        })
    }

    fn page(&self, index: usize) -> Result<&Page, String> {
        self.layout
            .pages
            .get(index)
            .ok_or_else(|| "The page does not exist.".into())
    }

    fn render(&self, index: usize, scale: f32) -> Result<Vec<u8>, String> {
        let page = self.page(index)?;
        if !scale.is_finite() || !(0.25..=3.0).contains(&scale) {
            return Err("The page scale must be between 0.25 and 3 pixels per point.".into());
        }
        let width = (page.w as f64 * scale as f64).ceil();
        let height = (page.h as f64 * scale as f64).ceil();
        if width > 8192.0 || height > 8192.0 || width * height > MAX_RENDER_PIXELS {
            return Err("The requested page image is too large. Reduce the zoom.".into());
        }
        let png = render_page(&self.document, page, scale, &self.options).to_png();
        if png.is_empty() {
            return Err("Wordcraft could not render this page.".into());
        }
        Ok(png)
    }

    fn text_runs(&self, index: usize) -> Result<Vec<TextRun>, String> {
        let page = self.page(index)?;
        let display = page_display(&self.document, page, &self.options.display);
        let mut runs = Vec::new();
        collect_text(&display, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], &mut runs, 0)?;
        Ok(runs)
    }
}

/// Install the fonts the document embeds (ECMA-376 Part 1, 17.8.1) before the layout resolves
/// families, as the upstream engine does when it opens a file: text set in a face this preview does
/// not bundle then draws with the document's own font instead of a substitute. The font database
/// belongs to this worker and a worker serves one document (`craft-client.ts` opens a new one per
/// revision), so installed faces cannot reach another preview. Each file keeps the name the
/// document's font table gives it, as upstream passes it, because Word embeds subsets under a
/// made-up family that the text never asks for. Returns how many faces this document added, and
/// whether an embedded font had to be left out, so the metadata says so instead of silently
/// substituting.
fn install_embedded_fonts(document: &Document) -> (usize, bool) {
    let mut files: Vec<(Vec<u8>, String)> = Vec::new();
    let mut total = 0usize;
    let mut incomplete = false;
    for font in wordcraft_docx::embedded_fonts(document) {
        if files.len() >= MAX_EMBEDDED_FONTS {
            incomplete = true;
            break;
        }
        // De-obfuscated bytes still have to be a font, and a decoded copy has to fit the budget.
        match wordcraft_fonts::decode_font_file(&font.data) {
            Ok(decoded) if total.saturating_add(decoded.len()) <= MAX_EMBEDDED_FONT_BYTES => {
                total += decoded.len();
                files.push((decoded, font.name));
            }
            _ => incomplete = true,
        }
    }
    // Faces already available stay as they are, so the count is what this document added.
    let added = if files.is_empty() { 0 } else { wordcraft_fonts::FontDb::global().add_document_fonts(files) };
    (added, incomplete)
}

// Bound the package before Wordcraft allocates decompressed XML, media or layout structures.
fn check_package(bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES {
        return Err("Choose a DOCX file no larger than 100 MiB.".into());
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| "The file is not a valid DOCX package.".to_string())?;
    if zip.len() > MAX_PARTS {
        return Err("The DOCX package contains too many parts.".into());
    }
    let mut expanded = 0u64;
    for index in 0..zip.len() {
        let part = zip.by_index(index).map_err(|error| error.to_string())?;
        let declared = part.size();
        if declared > MAX_PART_BYTES || expanded.saturating_add(declared) > MAX_EXPANDED_BYTES {
            return Err("The expanded DOCX package exceeds the preview memory limit.".into());
        }
        // Check actual decompression too: central-directory size claims are not trusted.
        let actual = std::io::copy(&mut part.take(MAX_PART_BYTES + 1), &mut std::io::sink())
            .map_err(|error| error.to_string())?;
        expanded = expanded.saturating_add(actual);
        if actual > MAX_PART_BYTES || actual != declared || expanded > MAX_EXPANDED_BYTES {
            return Err("The expanded DOCX package exceeds the preview memory limit.".into());
        }
    }
    Ok(())
}

fn check_document(document: &Document) -> Result<(), String> {
    let stories =
        std::iter::once(StoryRef::Body).chain(document.parts.keys().copied().map(StoryRef::Part));
    let mut paragraphs = 0usize;
    let mut text_bytes = 0usize;
    let mut forced_pages = 0usize;
    for story in stories {
        for path in document.para_paths(story) {
            paragraphs = paragraphs.saturating_add(1);
            if let Some(para) = document.para(story, &path) {
                text_bytes = text_bytes.saturating_add(para.text.len());
                if story == StoryRef::Body {
                    forced_pages = forced_pages
                        .saturating_add(para.text.bytes().filter(|byte| *byte == 0x0c).count());
                    if forced_pages >= MAX_PAGES {
                        return Err(format!(
                            "The document exceeds the preview limit of {MAX_PAGES} pages."
                        ));
                    }
                }
            }
            if paragraphs > MAX_PARAGRAPHS || text_bytes > MAX_TEXT_BYTES {
                return Err("The document exceeds the preview text limit.".into());
            }
        }
    }
    for media in document.media.values() {
        if let Some((width, height)) = wordcraft_render::image_size(media) {
            if u64::from(width).saturating_mul(u64::from(height)) > MAX_IMAGE_PIXELS {
                return Err("A document image exceeds the preview memory limit.".into());
            }
        }
    }
    Ok(())
}

fn valid_page_size(page: &Page) -> bool {
    page.w.is_finite()
        && page.h.is_finite()
        && (1.0..=8192.0).contains(&page.w)
        && (1.0..=8192.0).contains(&page.h)
}

fn document_metadata(document: &Document, layout: &DocLayout, fonts_incomplete: bool) -> Result<String, String> {
    let mut text = String::new();
    let mut outline = Vec::new();
    for path in document.para_paths(StoryRef::Body) {
        let Some(para) = document.para(StoryRef::Body, &path) else {
            continue;
        };
        let shown = para.final_text();
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&shown);
        let level = wordcraft_layout::outline::para_level(document, para);
        if level <= 9 && !shown.trim().is_empty() {
            let position = Pos::new(StoryRef::Body, path, 0);
            if let Some(caret) = layout.caret(&position) {
                outline.push(OutlineEntry {
                    title: shown,
                    level,
                    page: caret.page,
                    y: caret.top,
                });
            }
        }
    }
    let metadata = Metadata {
        engine: "Wordcraft",
        version: env!("JCODE_CRAFT_ENGINE_VERSION"),
        pages: layout
            .pages
            .iter()
            .map(|page| PageInfo {
                width: page.w,
                height: page.h,
            })
            .collect(),
        text,
        outline,
        warnings: if fonts_incomplete {
            vec![BUNDLED_FONTS_WARNING, EMBEDDED_FONTS_WARNING]
        } else {
            vec![BUNDLED_FONTS_WARNING]
        },
    };
    serde_json::to_string(&metadata).map_err(|error| error.to_string())
}

fn collect_text(
    draws: &[Draw],
    transform: [f32; 6],
    out: &mut Vec<TextRun>,
    depth: usize,
) -> Result<(), String> {
    if depth > 32 {
        return Err("The document drawing is nested too deeply.".into());
    }
    for draw in draws {
        match draw {
            Draw::Glyphs {
                face,
                size,
                glyphs,
                text,
                link,
                ..
            } if !text.is_empty() && !glyphs.is_empty() => {
                let face = face.get();
                let unit = *size as f64 / face.units_per_em().max(1.0);
                let (ascent, descent) = face.vertical_metrics();
                let ascent = (ascent * unit).abs() as f32;
                let descent = (descent * unit).abs() as f32;
                let mut left = f32::INFINITY;
                let mut top = f32::INFINITY;
                let mut right = f32::NEG_INFINITY;
                let mut bottom = f32::NEG_INFINITY;
                for &(glyph, x, baseline) in glyphs {
                    left = left.min(x);
                    top = top.min(baseline - ascent);
                    right = right.max(x + (face.advance(glyph) * unit) as f32);
                    bottom = bottom.max(baseline + descent);
                }
                let corners = [(left, top), (right, top), (left, bottom), (right, bottom)]
                    .map(|(x, y)| point(transform, x, y));
                let x = corners.iter().map(|p| p.0).fold(f32::INFINITY, f32::min);
                let y = corners.iter().map(|p| p.1).fold(f32::INFINITY, f32::min);
                let width = corners
                    .iter()
                    .map(|p| p.0)
                    .fold(f32::NEG_INFINITY, f32::max)
                    - x;
                let height = corners
                    .iter()
                    .map(|p| p.1)
                    .fold(f32::NEG_INFINITY, f32::max)
                    - y;
                if [x, y, width, height, *size]
                    .iter()
                    .all(|value| value.is_finite())
                    && width >= 0.0
                    && height > 0.0
                {
                    if out.len() >= MAX_PAGE_RUNS {
                        return Err("The page contains too many text runs.".into());
                    }
                    out.push(TextRun {
                        text: text.clone(),
                        x,
                        y,
                        width,
                        height,
                        font_size: *size,
                        font_family: face.family.clone(),
                        rtl: text
                            .chars()
                            .find(|c| c.is_alphabetic())
                            .is_some_and(wordcraft_fonts::is_rtl),
                        link: link.clone(),
                    });
                }
            }
            Draw::Turned { x, y, turn, items } => collect_text(
                items,
                compose(transform, Draw::turn_matrix(*turn, *x, *y)),
                out,
                depth + 1,
            )?,
            Draw::Rotated {
                cx,
                cy,
                spin,
                items,
            } => collect_text(
                items,
                compose(transform, spin.matrix(*cx, *cy)),
                out,
                depth + 1,
            )?,
            Draw::Clip { items, .. } => collect_text(items, transform, out, depth + 1)?,
            Draw::Figure { draws, .. } => collect_text(draws, transform, out, depth + 1)?,
            _ => {}
        }
    }
    Ok(())
}

fn point([a, b, c, d, e, f]: [f32; 6], x: f32, y: f32) -> (f32, f32) {
    (a * x + c * y + e, b * x + d * y + f)
}

fn compose(outer: [f32; 6], inner: [f32; 6]) -> [f32; 6] {
    let [a, b, c, d, e, f] = outer;
    let [g, h, i, j, k, l] = inner;
    [
        a * g + c * h,
        b * g + d * h,
        a * i + c * j,
        b * i + d * j,
        a * k + c * l + e,
        b * k + d * l + f,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use wordcraft_doc::{Paragraph, para_block};

    fn fixture() -> Vec<u8> {
        let mut document = Document::from_text("Preview title\nSelectable café and Ω text.");
        document.body[0] = para_block(
            Paragraph::with_text("Preview title", Default::default()).styled("Heading1"),
        );
        wordcraft_docx::write(&document).expect("DOCX fixture")
    }

    #[test]
    fn imports_docx_renders_png_and_returns_matching_text_geometry() {
        let viewer = DocxDocument::load(&fixture()).expect("real DOCX import");
        let metadata: serde_json::Value =
            serde_json::from_str(&viewer.metadata()).expect("metadata JSON");
        assert_eq!(metadata["engine"], "Wordcraft");
        assert_eq!(metadata["pages"].as_array().expect("pages").len(), 1);
        assert!(
            metadata["text"]
                .as_str()
                .expect("text")
                .contains("Selectable café and Ω text.")
        );
        assert_eq!(metadata["outline"][0]["title"], "Preview title");
        let runs = viewer.text_runs(0).expect("text layer");
        assert!(runs.iter().any(|run| run.text.contains("café")));
        assert!(runs.iter().all(|run| run.width > 0.0
            && run.height > 0.0
            && run.x.is_finite()
            && run.y.is_finite()));

        let png = viewer.render(0, 1.0).expect("CPU render");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(
            u32::from_be_bytes(png[16..20].try_into().expect("PNG width")),
            612
        );
        assert_eq!(
            u32::from_be_bytes(png[20..24].try_into().expect("PNG height")),
            792
        );
        let image = image::load_from_memory(&png)
            .expect("read rendered PNG")
            .to_rgb8();
        assert!(
            image
                .pixels()
                .any(|pixel| pixel.0.iter().any(|channel| *channel < 200)),
            "The page contains visible text"
        );
    }

    #[test]
    fn rejects_invalid_input_page_and_unsafe_raster_requests() {
        assert!(DocxDocument::load(b"not a docx").is_err());
        let viewer = DocxDocument::load(&fixture()).expect("DOCX fixture");
        assert!(viewer.render(1, 1.0).is_err());
        for scale in [f32::NAN, f32::INFINITY, -1.0, 0.0, 0.24, 3.01] {
            assert!(viewer.render(0, scale).is_err());
        }
        assert!(viewer.text_runs(1).is_err());
    }

    #[test]
    fn rejects_excessive_forced_pages_before_pagination() {
        let document = Document::from_text(&"\u{000c}".repeat(MAX_PAGES));
        assert!(check_document(&document).is_err());
    }
}
