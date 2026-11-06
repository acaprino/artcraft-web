//! Immutable PPTX import and static-slide preview through Deckcraft's native CPU renderer.

use std::io::{Cursor, Read};
use std::sync::Once;

use deckcraft_model::{Presentation, ShapeKind};
use deckcraft_render::{RenderOpts, place_slide, render_slide};
use kurbo::Rect;
use serde::Serialize;
use wasm_bindgen::prelude::*;

const MAX_INPUT_BYTES: usize = 100 * 1024 * 1024;
const MAX_PART_BYTES: u64 = 32 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 128 * 1024 * 1024;
const MAX_PARTS: usize = 8192;
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_SHAPES: usize = 100_000;
const MAX_PAGES: usize = 1000;
const MAX_RENDER_PIXELS: f64 = 16_000_000.0;
const MAX_PAGE_RUNS: usize = 50_000;
/// Embedded font parts taken from one presentation, and their total size. The package budgets
/// above already bound the input; these keep the installed copies in the same order of magnitude.
const MAX_EMBEDDED_FONTS: usize = 32;
const MAX_EMBEDDED_FONT_BYTES: usize = 64 * 1024 * 1024;

const BUNDLED_FONTS_WARNING: &str =
    "Deckcraft uses bundled fonts. Unavailable original fonts can change the layout.";
const EMBEDDED_FONTS_WARNING: &str = "Some fonts embedded in the presentation could not be used (unreadable, or over the preview limit); that text draws in a substitute.";

#[derive(Serialize)]
struct PageInfo {
    width: f64,
    height: f64,
    title: String,
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
    warnings: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextRun {
    text: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    font_size: f64,
    font_family: String,
    rtl: bool,
}

/// The browser can only inspect and render; no editing, export, macro or network API is exposed.
#[wasm_bindgen]
pub struct PptxDocument {
    presentation: Presentation,
    metadata: String,
}

#[wasm_bindgen]
impl PptxDocument {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<PptxDocument, JsValue> {
        Self::load(bytes).map_err(js_error)
    }

    /// JSON: {engine, version, pages:[{width,height,title}], text, warnings}.
    pub fn metadata(&self) -> String {
        self.metadata.clone()
    }

    #[wasm_bindgen(js_name = renderPage)]
    pub fn render_page(&self, index: usize, scale: f64) -> Result<Vec<u8>, JsValue> {
        self.render(index, scale).map_err(js_error)
    }

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

fn initialize_fonts() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        // Reuse these OFL bytes from the exact Wordcraft pin; the build records both source inputs.
        let db = deckcraft_fonts::FontDb::global();
        for bytes in [
            include_bytes!(concat!(
                env!("JCODE_CRAFT_FONT_DIR"),
                "/Inter-Regular.ttf"
            ))
            .as_slice(),
            include_bytes!(concat!(env!("JCODE_CRAFT_FONT_DIR"), "/Inter-Medium.ttf")).as_slice(),
            include_bytes!(concat!(
                env!("JCODE_CRAFT_FONT_DIR"),
                "/Inter-SemiBold.ttf"
            ))
            .as_slice(),
            include_bytes!(concat!(
                env!("JCODE_CRAFT_FONT_DIR"),
                "/JetBrainsMono-Regular.ttf"
            ))
            .as_slice(),
        ] {
            db.add_font(bytes.to_vec());
        }
    });
}

/// Install the faces the presentation embeds (`p:embeddedFontLst`) before any text is laid out, as
/// the upstream engine does when it opens a file: a family this preview does not bundle then draws
/// with the presentation's own font instead of a substitute. A MicroType Express subset carries no
/// TrueType or OpenType font and stays a substitute. The database belongs to this worker and a
/// worker serves one document (`craft-client.ts` opens a new one per revision), so installed faces
/// cannot reach another preview. Returns how many faces this presentation added, and whether an
/// embedded face had to be left out.
fn install_embedded_fonts(presentation: &Presentation) -> (usize, bool) {
    let db = deckcraft_fonts::FontDb::global();
    let (mut added, mut parts, mut total) = (0usize, 0usize, 0usize);
    let mut incomplete = false;
    for font in &presentation.embedded_fonts {
        for id in font.faces().into_iter().flatten() {
            let Some(item) = presentation.media(id) else {
                incomplete = true;
                continue;
            };
            let Some(sfnt) = deckcraft_fonts::embedded_sfnt(&item.data) else {
                incomplete = true;
                continue;
            };
            if parts >= MAX_EMBEDDED_FONTS || total.saturating_add(sfnt.len()) > MAX_EMBEDDED_FONT_BYTES {
                incomplete = true;
                continue;
            }
            parts += 1;
            total += sfnt.len();
            // Faces already available stay as they are, so the count is what this file added.
            added += db.add_font(sfnt.to_vec());
        }
    }
    (added, incomplete)
}

impl PptxDocument {
    fn load(bytes: &[u8]) -> Result<Self, String> {
        check_package(bytes)?;
        let presentation = deckcraft_pptx::import(bytes).map_err(|error| error.to_string())?;
        check_presentation(&presentation)?;
        initialize_fonts();
        let (_, fonts_incomplete) = install_embedded_fonts(&presentation);
        let metadata = document_metadata(&presentation, fonts_incomplete)?;
        Ok(Self {
            presentation,
            metadata,
        })
    }

    fn check_page(&self, index: usize) -> Result<(), String> {
        self.presentation
            .slides
            .get(index)
            .map(|_| ())
            .ok_or_else(|| "The slide does not exist.".into())
    }

    fn render(&self, index: usize, scale: f64) -> Result<Vec<u8>, String> {
        self.check_page(index)?;
        if !scale.is_finite() || !(0.25..=3.0).contains(&scale) {
            return Err("The slide scale must be between 0.25 and 3 pixels per point.".into());
        }
        let width = (self.presentation.slide_size.width * scale).ceil();
        let height = (self.presentation.slide_size.height * scale).ceil();
        if width > 8192.0 || height > 8192.0 || width * height > MAX_RENDER_PIXELS {
            return Err("The requested slide image is too large. Reduce the zoom.".into());
        }
        let opts = RenderOpts {
            scale,
            threads: 0,
            ..Default::default()
        };
        let png = render_slide(&self.presentation, index, &opts).to_png();
        if png.is_empty() {
            return Err("Deckcraft could not render this slide.".into());
        }
        Ok(png)
    }

    fn text_runs(&self, index: usize) -> Result<Vec<TextRun>, String> {
        self.check_page(index)?;
        let placed = place_slide(&self.presentation, index);
        let mut output = Vec::new();
        for text in placed.texts {
            let paragraphs: Vec<Vec<char>> = text
                .body
                .paragraphs
                .iter()
                .map(|para| para.text().chars().collect())
                .collect();
            for run in &text.layout.runs {
                if run.glyphs.is_empty() || run.chars.0 == run.chars.1 {
                    continue;
                }
                let shown: String = paragraphs
                    .get(run.para)
                    .into_iter()
                    .flat_map(|chars| chars.get(run.chars.0..run.chars.1).unwrap_or(&[]))
                    .collect();
                if shown.is_empty() {
                    continue;
                }
                let unit = run.size / run.face.upem.max(1.0);
                let mut left = f64::INFINITY;
                let mut top = f64::INFINITY;
                let mut right = f64::NEG_INFINITY;
                let mut bottom = f64::NEG_INFINITY;
                for &(glyph, x, baseline) in &run.glyphs {
                    left = left.min(x);
                    top = top.min(baseline - run.face.ascent.abs() * unit);
                    right = right.max(x + run.face.advance(glyph) * unit);
                    bottom = bottom.max(baseline + run.face.descent.abs() * unit);
                }
                let bounds = text
                    .transform
                    .transform_rect_bbox(Rect::new(left, top, right, bottom));
                if bounds.is_finite() && bounds.width() >= 0.0 && bounds.height() > 0.0 {
                    if output.len() >= MAX_PAGE_RUNS {
                        return Err("The slide contains too many text runs.".into());
                    }
                    output.push(TextRun {
                        rtl: shown
                            .chars()
                            .find(|c| c.is_alphabetic())
                            .is_some_and(deckcraft_fonts::is_rtl),
                        text: shown,
                        x: bounds.x0,
                        y: bounds.y0,
                        width: bounds.width(),
                        height: bounds.height(),
                        font_size: run.size,
                        font_family: run.face.family.clone(),
                    });
                }
            }
        }
        Ok(output)
    }
}

fn check_package(bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES {
        return Err("Choose a PPTX file no larger than 100 MiB.".into());
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| "The file is not a valid PPTX package.".to_string())?;
    if zip.len() > MAX_PARTS {
        return Err("The PPTX package contains too many parts.".into());
    }
    let mut expanded = 0u64;
    for index in 0..zip.len() {
        let part = zip.by_index(index).map_err(|error| error.to_string())?;
        let declared = part.size();
        if declared > MAX_PART_BYTES || expanded.saturating_add(declared) > MAX_EXPANDED_BYTES {
            return Err("The expanded PPTX package exceeds the preview memory limit.".into());
        }
        // Central-directory sizes are untrusted. Validate actual decompression without keeping copies.
        let actual = std::io::copy(&mut part.take(MAX_PART_BYTES + 1), &mut std::io::sink())
            .map_err(|error| error.to_string())?;
        expanded = expanded.saturating_add(actual);
        if actual > MAX_PART_BYTES || actual != declared || expanded > MAX_EXPANDED_BYTES {
            return Err("The expanded PPTX package exceeds the preview memory limit.".into());
        }
    }
    Ok(())
}

fn check_presentation(presentation: &Presentation) -> Result<(), String> {
    if presentation.slides.is_empty() || presentation.slides.len() > MAX_PAGES {
        return Err(format!(
            "The presentation must have between 1 and {MAX_PAGES} slides."
        ));
    }
    if [
        presentation.slide_size.width,
        presentation.slide_size.height,
    ]
    .iter()
    .any(|value| !value.is_finite() || !(1.0..=8192.0).contains(value))
    {
        return Err("The presentation has an unsupported slide size.".into());
    }
    let mut shapes = 0usize;
    let mut text_bytes = 0usize;
    let mut check_shapes = |items: &[deckcraft_model::Shape]| {
        deckcraft_model::walk(items, &mut |shape, _| {
            shapes = shapes.saturating_add(1);
            if let Some(body) = &shape.text {
                text_bytes = text_bytes.saturating_add(
                    body.paragraphs
                        .iter()
                        .flat_map(|para| &para.runs)
                        .map(|run| run.text.len())
                        .sum::<usize>(),
                );
            }
            if let ShapeKind::Table(table) = &shape.kind {
                for cell in table.rows.iter().flat_map(|row| &row.cells) {
                    text_bytes = text_bytes.saturating_add(
                        cell.text
                            .paragraphs
                            .iter()
                            .flat_map(|para| &para.runs)
                            .map(|run| run.text.len())
                            .sum::<usize>(),
                    );
                }
            }
        });
    };
    for slide in &presentation.slides {
        check_shapes(&slide.shapes);
    }
    for master in &presentation.masters {
        check_shapes(&master.shapes);
        for layout in &master.layouts {
            check_shapes(&layout.shapes);
        }
    }
    if shapes > MAX_SHAPES || text_bytes > MAX_TEXT_BYTES {
        return Err("The presentation exceeds the preview content limit.".into());
    }
    for media in &presentation.media {
        if let Ok(reader) =
            image::ImageReader::new(Cursor::new(media.data.as_slice())).with_guessed_format()
        {
            if let Ok((width, height)) = reader.into_dimensions() {
                if u64::from(width).saturating_mul(u64::from(height)) > MAX_RENDER_PIXELS as u64 {
                    return Err("A slide image exceeds the preview memory limit.".into());
                }
            }
        }
    }
    Ok(())
}

fn document_metadata(presentation: &Presentation, fonts_incomplete: bool) -> Result<String, String> {
    let mut text = String::new();
    for slide in &presentation.slides {
        deckcraft_model::walk(&slide.shapes, &mut |shape, _| {
            if let Some(body) = &shape.text {
                text.push_str(&body.text());
                text.push('\n');
            }
            if let ShapeKind::Table(table) = &shape.kind {
                for row in &table.rows {
                    for cell in &row.cells {
                        text.push_str(&cell.text.text());
                        text.push('\t');
                    }
                    text.push('\n');
                }
            }
        });
    }
    let metadata = Metadata {
        engine: "Deckcraft",
        version: env!("JCODE_CRAFT_ENGINE_VERSION"),
        pages: presentation
            .slides
            .iter()
            .map(|slide| PageInfo {
                width: presentation.slide_size.width,
                height: presentation.slide_size.height,
                title: slide.title(),
            })
            .collect(),
        text,
        warnings: if fonts_incomplete {
            vec![BUNDLED_FONTS_WARNING, EMBEDDED_FONTS_WARNING]
        } else {
            vec![BUNDLED_FONTS_WARNING]
        },
    };
    serde_json::to_string(&metadata).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use deckcraft_model::{EmbeddedFont, Paragraph, Run, RunProps, Shape, ShapeId, TextBody, Xfrm};
    use std::sync::Arc;

    fn fixture() -> Vec<u8> {
        let mut presentation = Presentation::default();
        let slide = Arc::make_mut(&mut presentation.slides[0]);
        slide.shapes = vec![Shape {
            id: ShapeId(1001),
            name: "Preview text".into(),
            xfrm: Some(Xfrm::new(40.0, 50.0, 600.0, 160.0)),
            text_box: true,
            text: Some(TextBody::from_text("Selectable café and Ω slide text.")),
            ..Default::default()
        }];
        deckcraft_pptx::export(&presentation).expect("PPTX fixture")
    }

    #[test]
    fn imports_pptx_renders_slide_and_exposes_selectable_text() {
        let viewer = PptxDocument::load(&fixture()).expect("real PPTX import");
        let metadata: serde_json::Value =
            serde_json::from_str(&viewer.metadata()).expect("metadata JSON");
        assert_eq!(metadata["engine"], "Deckcraft");
        assert_eq!(metadata["pages"].as_array().expect("pages").len(), 1);
        assert!(
            metadata["text"]
                .as_str()
                .expect("text")
                .contains("Selectable café and Ω slide text.")
        );
        let runs = viewer.text_runs(0).expect("text layer");
        assert!(runs.iter().any(|run| run.text.contains("café")));
        assert!(runs.iter().all(|run| run.width > 0.0 && run.height > 0.0));
        let png = viewer.render(0, 1.0).expect("CPU renderer");
        let image = image::load_from_memory(&png).expect("PNG").to_rgb8();
        assert_eq!(image.dimensions(), (960, 540));
        assert!(
            image
                .pixels()
                .any(|pixel| pixel.0.iter().any(|channel| *channel < 200))
        );
    }

    #[test]
    fn rejects_invalid_package_page_and_unsafe_scale() {
        assert!(PptxDocument::load(b"not a pptx").is_err());
        let viewer = PptxDocument::load(&fixture()).expect("PPTX fixture");
        assert!(viewer.render(1, 1.0).is_err());
        for scale in [f64::NAN, f64::INFINITY, 0.0, 0.24, 3.01] {
            assert!(viewer.render(0, scale).is_err());
        }
        assert!(viewer.text_runs(1).is_err());
    }

    /// A family this preview does not bundle (its faces are Ubuntu, Inter and JetBrains Mono): only
    /// the file's own embedded copy can provide it, so the installed-face count and the text layer
    /// together prove the document's font is drawn instead of a substitute.
    #[test]
    fn embedded_presentation_fonts_are_installed_and_drawn() {
        const FAMILY: &str = "Source Sans 3";
        let sfnt = include_bytes!(concat!(env!("JCODE_CRAFT_FONT_DIR"), "/SourceSans3-Regular.ttf")).to_vec();
        let mut presentation = Presentation::default();
        let media = presentation
            .add_media("font1.fntdata", "application/x-fontdata", sfnt)
            .expect("media id");
        presentation.embedded_fonts.push(EmbeddedFont { typeface: FAMILY.into(), regular: Some(media), ..Default::default() });
        let slide = Arc::make_mut(&mut presentation.slides[0]);
        slide.shapes = vec![Shape {
            id: ShapeId(1002),
            name: "Embedded font text".into(),
            xfrm: Some(Xfrm::new(40.0, 50.0, 600.0, 160.0)),
            text_box: true,
            text: Some(TextBody {
                paragraphs: vec![Paragraph {
                    runs: vec![Run::with(
                        "Embedded face text",
                        RunProps { font: Some(FAMILY.into()), size: Some(24.0), ..Default::default() },
                    )],
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        }];
        let bytes = deckcraft_pptx::export(&presentation).expect("PPTX with an embedded font");
        let imported = deckcraft_pptx::import(&bytes).expect("re-import");
        assert_eq!(imported.embedded_fonts.len(), 1, "the embedded font survives the round trip");
        let (added, incomplete) = install_embedded_fonts(&imported);
        assert!(added >= 1, "the file's own face is installed: {added} faces added");
        assert!(!incomplete, "no embedded face may be left out");
        let viewer = PptxDocument::load(&bytes).expect("import");
        let metadata: serde_json::Value = serde_json::from_str(&viewer.metadata()).expect("metadata JSON");
        let warnings = metadata["warnings"].as_array().expect("warnings");
        assert!(
            !warnings.iter().any(|warning| warning.as_str() == Some(EMBEDDED_FONTS_WARNING)),
            "a usable embedded font must not warn: {warnings:?}"
        );
        let runs = viewer.text_runs(0).expect("text layer");
        let drawn = runs.iter().find(|run| run.text.contains("Embedded face text")).expect("the run is drawn");
        assert_eq!(drawn.font_family, FAMILY, "the text layer names the document's own font");
    }

    /// An embedded part that is not a font stays a substitute, and the preview says so instead of
    /// passing silently.
    #[test]
    fn an_unreadable_embedded_font_is_reported_not_silently_substituted() {
        let mut presentation = Presentation::default();
        let media = presentation
            .add_media("font1.fntdata", "application/x-fontdata", b"not a font at all".to_vec())
            .expect("media id");
        presentation.embedded_fonts.push(EmbeddedFont { typeface: "JanuraCode Unreadable".into(), regular: Some(media), ..Default::default() });
        let (added, incomplete) = install_embedded_fonts(&presentation);
        assert_eq!(added, 0, "nothing usable is installed");
        assert!(incomplete, "an unusable embedded font must be reported");
    }
}
