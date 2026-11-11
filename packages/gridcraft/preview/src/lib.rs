//! Read-only GridCraft grid painter. No user input, save API, Office process or PDF conversion.
mod raster;

use egui::{Color32, FontData, FontFamily, Rect, pos2, vec2};
use gridcraft_engine::{DocState, Session, Trust};
use gridcraft_model::{Anchor, Sheet, SheetViewMode, Visibility};
use gridcraft_ui_egui::{Services, SheetApp, SheetView, grid};
use image::ImageEncoder;
use serde_json::json;
use std::{collections::HashMap, io::{Cursor, Read}, sync::Arc};
use wasm_bindgen::prelude::*;

const WIDTH: f32 = 960.0;
const HEIGHT: f32 = 720.0;
const STEP_X: f32 = 820.0;
const STEP_Y: f32 = 620.0;
const MAX_PAGES: usize = 1000;
struct Tile { sheet: usize, x: f32, y: f32 }

#[wasm_bindgen]
pub struct XlsxDocument {
    app: SheetApp,
    context: egui::Context,
    tiles: Vec<Tile>,
    metadata: String,
    textures: raster::Textures,
    text: HashMap<usize, String>,
    frame: u64,
}

#[wasm_bindgen]
impl XlsxDocument {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<XlsxDocument, JsValue> {
        Self::from_bytes(bytes).map_err(|error| JsValue::from_str(&error))
    }
    pub fn metadata(&self) -> String { self.metadata.clone() }
    #[wasm_bindgen(js_name = renderPage)]
    pub fn render_page(&mut self, index: usize, scale: f32) -> Result<Vec<u8>, JsValue> {
        self.render(index, scale).map_err(|error| JsValue::from_str(&error))
    }
    #[wasm_bindgen(js_name = pageText)]
    pub fn page_text(&self, index: usize) -> String { self.text.get(&index).cloned().unwrap_or_else(|| "[]".into()) }
}

impl XlsxDocument {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > 100 * 1024 * 1024 { return Err("Il documento supera il limite di 100 MB".into()); }
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
        if archive.len() > 20_000 { return Err("Il documento contiene troppi elementi".into()); }
        let mut expanded = 0u64;
        for i in 0..archive.len() {
            let part = archive.by_index(i).map_err(|e| e.to_string())?;
            if part.size() > 32 * 1024 * 1024 { return Err("Una parte del documento supera il limite dell'anteprima".into()); }
            let actual = std::io::copy(&mut part.take(32 * 1024 * 1024 + 1), &mut std::io::sink()).map_err(|e| e.to_string())?;
            expanded = expanded.saturating_add(actual);
            if actual > 32 * 1024 * 1024 || expanded > 128 * 1024 * 1024 {
                return Err("Il documento espanso supera il limite dell'anteprima".into());
            }
        }
        drop(archive);
        let (mut wb, report) = gridcraft_xlsx::read_xlsx(bytes).map_err(|e| e.to_string())?;
        let mut image_pixels = 0u64;
        let mut omitted_images = 0usize;
        // Remove unsupported encodings before the painter can attempt decoding them. Every
        // retained picture, including those on hidden sheets, still passes the pixel budget.
        for index in 0..wb.sheets.len() {
            if let Some(sheet) = wb.sheet_mut(index) {
                for picture in std::mem::take(&mut sheet.images) {
                    if check_image(&picture.data, &mut image_pixels)? { sheet.images.push(picture); }
                    else { omitted_images += 1; }
                }
                for (cell, picture) in std::mem::take(&mut sheet.cell_pictures) {
                    if check_image(&picture.data, &mut image_pixels)? { sheet.cell_pictures.insert(cell, picture); }
                    else { omitted_images += 1; }
                }
            }
        }
        // View settings belong to this in-memory preview; the original file is never written.
        for index in 0..wb.sheets.len() {
            if let Some(sheet) = wb.sheet_mut(index) {
                sheet.zoom = 100;
                sheet.view = SheetViewMode::Normal;
                sheet.show_formulas = false;
                sheet.show_gridlines = true;
                sheet.show_headings = true;
                sheet.freeze = None;
            }
        }
        let mut session = Session::new();
        // The workbook comes from the opened file, so its active content stays untrusted.
        session.add_document(DocState::new(wb, None, "Anteprima".into(), Trust::FromFile));
        let workbook = &session.active().ok_or("Workbook assente")?.wb;
        let mut tiles = Vec::new();
        let mut sheets = Vec::new();
        for (index, sheet) in workbook.sheets.iter().enumerate() {
            if sheet.visibility != Visibility::Visible { continue; }
            let (width, height) = extent(sheet);
            if !width.is_finite() || !height.is_finite() { return Err("Dimensioni del foglio non valide".into()); }
            let cols = (width / STEP_X).ceil().max(1.0) as usize;
            let rows = (height / STEP_Y).ceil().max(1.0) as usize;
            if cols.saturating_mul(rows).saturating_add(tiles.len()) > MAX_PAGES {
                return Err("Il foglio supera il limite di 1000 riquadri dell'anteprima: aprilo con l'applicazione".into());
            }
            sheets.push(json!({"index": index, "name": sheet.name}));
            for row in 0..rows { for col in 0..cols {
                tiles.push(Tile { sheet: index, x: col as f32 * STEP_X / grid::DISPLAY_SCALE, y: row as f32 * STEP_Y / grid::DISPLAY_SCALE });
            } }
        }
        if tiles.is_empty() { return Err("Il documento non contiene fogli visibili".into()); }
        let mut warnings = report.warnings;
        if omitted_images > 0 {
            warnings.insert(0, format!("Immagini non supportate omesse dall'anteprima: {omitted_images}."));
        }
        if warnings.len() > 99 {
            let omitted = warnings.len() - 98;
            warnings.truncate(98);
            warnings.push(format!("Altre {omitted} limitazioni segnalate dal motore."));
        }
        warnings.push("I font non disponibili vengono sostituiti; alcune funzioni e oggetti possono differire da Excel.".into());
        let metadata = json!({
            // The pinned upstream release tag this preview was compiled from (for example
            // `v0.9.0`): `bundle/wordcraft.ts` sets the environment from `gridcraft.json`, so a
            // literal here cannot silently outlive a pin upgrade.
            "engine": "Gridcraft", "version": env!("JCODE_CRAFT_ENGINE_VERSION"),
            "pages": tiles.iter().map(|tile| json!({"width": WIDTH, "height": HEIGHT, "sheet": tile.sheet})).collect::<Vec<_>>(),
            "sheets": sheets, "warnings": warnings
        }).to_string();
        let context = egui::Context::default();
        SheetApp::setup_context_for_language(&context, false, gridcraft_ui_egui::i18n::Language::En);
        let mut fonts = gridcraft_ui_egui::theme::font_definitions();
        fonts.font_data.insert("jcode-inter".into(), Arc::new(FontData::from_static(include_bytes!(concat!(env!("JCODE_CRAFT_FONT_DIR"), "/Inter-Regular.ttf")))));
        fonts.font_data.insert("jcode-inter-bold".into(), Arc::new(FontData::from_static(include_bytes!(concat!(env!("JCODE_CRAFT_FONT_DIR"), "/Inter-SemiBold.ttf")))));
        fonts.font_data.insert("jcode-mono".into(), Arc::new(FontData::from_static(include_bytes!(concat!(env!("JCODE_CRAFT_FONT_DIR"), "/JetBrainsMono-Regular.ttf")))));
        for (family, chain) in &mut fonts.families {
            let name = match family {
                FontFamily::Monospace => "jcode-mono",
                FontFamily::Name(name) if name.contains("mono") => "jcode-mono",
                FontFamily::Name(name) if name.contains("bold") => "jcode-inter-bold",
                _ => "jcode-inter",
            };
            chain.insert(0, name.into());
        }
        context.set_fonts(fonts);
        let mut app = SheetApp::new(session, Services::default());
        app.fonts_ready = true;
        app.ui.animations = false;
        app.grid.ensure_visible = false;
        Ok(Self { app, context, tiles, metadata, textures: HashMap::new(), text: HashMap::new(), frame: 0 })
    }

    pub fn render(&mut self, index: usize, scale: f32) -> Result<Vec<u8>, String> {
        if !scale.is_finite() || !(0.25..=3.0).contains(&scale) { return Err("Scala dell'anteprima non valida".into()); }
        let tile = self.tiles.get(index).ok_or("Riquadro inesistente")?;
        let width = (WIDTH * scale).round() as u32;
        let height = (HEIGHT * scale).round() as u32;
        if u64::from(width) * u64::from(height) > 16_000_000 { return Err("L'anteprima supera il limite dei pixel".into()); }
        let window = self.app.session.active_window().ok_or("Finestra assente")?;
        let document = self.app.session.active_mut().ok_or("Workbook assente")?;
        Arc::make_mut(&mut document.wb).active_sheet = tile.sheet.into();
        let sheet_uid = document.wb.active().ok_or("Foglio assente")?.uid.get();
        self.app.views.insert((window, sheet_uid), SheetView { scroll: vec2(tile.x, tile.y) });
        self.app.grid.ensure_visible = false;
        let mut output = None;
        let mut free_after_paint = Vec::new();
        // The first pass initializes font/layout state; the next paints the settled viewport.
        for pass in 0..2 {
            self.frame += 1;
            let mut input = egui::RawInput { screen_rect: Some(Rect::from_min_size(pos2(0.0, 0.0), vec2(WIDTH, HEIGHT))), time: Some(self.frame as f64 / 60.0), ..Default::default() };
            if let Some(viewport) = input.viewports.get_mut(&egui::ViewportId::ROOT) { viewport.native_pixels_per_point = Some(scale); }
            let mut frame = self.context.run_ui(input, |ui| {
                ui.painter().rect_filled(ui.max_rect(), 0.0, Color32::WHITE);
                grid::show(&mut self.app, ui);
            });
            let uploaded = raster::update_textures(&mut self.textures, &frame.textures_delta);
            let free: Vec<_> = frame.textures_delta.free.iter().copied().collect();
            // egui requires every handled delta to be drained, including failed uploads.
            frame.textures_delta.clear();
            uploaded?;
            if pass == 0 { for id in free { self.textures.remove(&id); } }
            else { free_after_paint = free; }
            output = Some(frame);
        }
        let output = output.ok_or("Rendering assente")?;
        let mut text = Vec::new();
        for shape in &output.shapes { collect_text(&shape.shape, shape.clip_rect, &mut text); }
        self.text.insert(index, serde_json::to_string(&text).map_err(|e| e.to_string())?);
        // A bounded cache of selectable runs accompanies the UI's visible image cache.
        if self.text.len() > 20 { if let Some(old) = self.text.keys().copied().find(|old| *old != index) { self.text.remove(&old); } }
        let primitives = self.context.tessellate(output.shapes, output.pixels_per_point);
        let rgba = raster::paint(&primitives, &self.textures, width, height, scale);
        for id in free_after_paint { self.textures.remove(&id); }
        let rgba = rgba?;
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png).write_image(&rgba, width, height, image::ExtendedColorType::Rgba8).map_err(|e| e.to_string())?;
        Ok(png)
    }
}

fn check_image(data: &[u8], image_pixels: &mut u64) -> Result<bool, String> {
    let reader = image::ImageReader::new(Cursor::new(data)).with_guessed_format().map_err(|e| e.to_string())?;
    // These are the decoders enabled by the pinned upstream image dependency. A format
    // without a decoder is omitted, while malformed supported images remain a hard error.
    if !matches!(reader.format(), Some(image::ImageFormat::Png | image::ImageFormat::Jpeg)) { return Ok(false); }
    let (width, height) = reader.into_dimensions().map_err(|e| e.to_string())?;
    let pixels = u64::from(width) * u64::from(height);
    *image_pixels = image_pixels.saturating_add(pixels);
    if pixels > 16_000_000 || *image_pixels > 64_000_000 { return Err("Le immagini del documento superano il limite dell'anteprima".into()); }
    Ok(true)
}

fn extent(sheet: &Sheet) -> (f32, f32) {
    let (mut width, mut height) = sheet.used_range().map(|r| (sheet.col_left(r.end.col.saturating_add(1)) as f32, sheet.row_top(r.end.row.saturating_add(1)) as f32)).unwrap_or((0.0, 0.0));
    for range in &sheet.merges {
        width = width.max(sheet.col_left(range.end.col.saturating_add(1)) as f32);
        height = height.max(sheet.row_top(range.end.row.saturating_add(1)) as f32);
    }
    let anchors = sheet.charts.iter().map(|o| &o.anchor).chain(sheet.images.iter().map(|o| &o.anchor)).chain(sheet.shapes.iter().map(|o| &o.anchor));
    for Anchor { cell, dx, dy, width: w, height: h, .. } in anchors {
        width = width.max(sheet.col_left(cell.col) as f32 + dx + w);
        height = height.max(sheet.row_top(cell.row) as f32 + dy + h);
    }
    (width * grid::DISPLAY_SCALE, height * grid::DISPLAY_SCALE)
}

fn collect_text(shape: &egui::Shape, clip: Rect, runs: &mut Vec<serde_json::Value>) {
    match shape {
        egui::Shape::Text(text) => {
            let rect = Rect::from_min_size(text.pos, text.galley.size());
            if text.angle != 0.0 {
                let rotated = Rect::from_min_size(pos2(0.0, 0.0), text.galley.size())
                    .rotate_bb(egui::emath::Rot2::from_angle(text.angle)).translate(text.pos.to_vec2());
                let clip = clip.intersect(Rect::from_min_size(pos2(0.0, 0.0), vec2(WIDTH, HEIGHT)));
                if rotated.intersects(clip) && clip.is_positive() && runs.len() < 20_000 {
                    let font_size = text.galley.job.sections.first().map(|s| s.format.font_id.size).unwrap_or(11.0);
                    // Preserve the local text rectangle and pivot. Clipping this rectangle
                    // before rotating would move the selectable text away from the raster.
                    runs.push(json!({"text": text.galley.text(), "x": text.pos.x, "y": text.pos.y, "width": rect.width(), "height": rect.height(), "fontSize": font_size, "rtl": false,
                        "rotation": text.angle, "clip": {"x": clip.min.x, "y": clip.min.y, "width": clip.width(), "height": clip.height()}}));
                }
            } else if rect.intersects(clip) && runs.len() < 20_000 {
                let bounds = rect.intersect(clip);
                let font_size = text.galley.job.sections.first().map(|s| s.format.font_id.size).unwrap_or(11.0);
                runs.push(json!({"text": text.galley.text(), "x": bounds.min.x, "y": bounds.min.y, "width": bounds.width(), "height": bounds.height(), "fontSize": font_size, "rtl": false}));
            }
        }
        egui::Shape::Vec(shapes) => for shape in shapes { collect_text(shape, clip, runs); },
        _ => {}
    }
}
