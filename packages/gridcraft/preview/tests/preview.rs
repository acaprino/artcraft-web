use gridcraft_engine::core::{CellRef, Value};
use gridcraft_model::{Sheet, Visibility, Workbook};
use std::sync::Arc;
use jcode_gridcraft_preview::XlsxDocument;

fn workbook() -> Vec<u8> {
    let mut wb = Workbook::new();
    let sheet = wb.sheet_mut(0).unwrap();
    sheet.set_value(CellRef::new(0, 0), Value::Text("Ricavi — α".into()));
    sheet.set_value(CellRef::new(1, 0), Value::Number(125.5));
    wb.sheets.push(Arc::new(Sheet::new("Secondo")));
    let mut hidden = Sheet::new("Riservato");
    hidden.visibility = Visibility::Hidden;
    wb.sheets.push(Arc::new(hidden));
    gridcraft_xlsx::write_xlsx(&wb).unwrap()
}

#[test]
fn imports_workbook_and_renders_real_grid_with_selectable_unicode() {
    let bytes = workbook();
    let original = bytes.clone();
    let mut document = XlsxDocument::from_bytes(&bytes).unwrap();
    let metadata: serde_json::Value = serde_json::from_str(&document.metadata()).unwrap();
    assert_eq!(metadata["sheets"].as_array().unwrap().len(), 2);
    assert_eq!(metadata["sheets"][1]["name"], "Secondo");
    assert_eq!(metadata["pages"].as_array().unwrap().len(), 2);
    let png = document.render(0, 1.0).unwrap();
    let image = image::load_from_memory(&png).unwrap().into_rgba8();
    assert_eq!((image.width(), image.height()), (960, 720));
    assert!(image.pixels().any(|p| p.0[0] < 150 && p.0[1] < 150 && p.0[2] < 150));
    assert!(document.page_text(0).contains("Ricavi"));
    assert!(document.page_text(0).contains("α"));
    assert_eq!(bytes, original);
    assert!(document.render(1, 0.5).is_ok());
}

#[test]
fn validates_file_page_and_pixel_limits_without_panics_or_silent_truncation() {
    assert!(XlsxDocument::from_bytes(b"not an XLSX").is_err());
    let mut document = XlsxDocument::from_bytes(&workbook()).unwrap();
    assert!(document.render(9999, 1.0).is_err());
    for scale in [0.0, f32::NAN, f32::INFINITY, 10.0] {
        assert!(document.render(0, scale).is_err());
    }
}
