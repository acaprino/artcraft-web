//! Software backend for egui's textured triangles. The upstream grid owns layout and drawing.
use egui::{
    Color32, TextureFilter, TextureId, TextureOptions, TextureWrapMode,
    epaint::{ClippedPrimitive, Primitive, textures::TexturesDelta},
};
use std::collections::HashMap;

const MAX_PIXELS: usize = 16_000_000;
const MAX_TEXTURE_PIXELS: usize = 32_000_000;
const MAX_TEXTURES: usize = 256;
const MAX_FRAGMENT_WORK: u64 = 100_000_000;

pub struct Texture {
    size: [usize; 2],
    pixels: Vec<Color32>,
    options: TextureOptions,
}
pub type Textures = HashMap<TextureId, Texture>;

fn pixel_count([width, height]: [usize; 2]) -> Result<usize, String> {
    let count = width
        .checked_mul(height)
        .ok_or("Dimensioni della trama non valide")?;
    if width == 0 || height == 0 || width > 16_384 || height > 16_384 || count > MAX_PIXELS {
        return Err("La trama supera il limite dei pixel".into());
    }
    Ok(count)
}

pub fn update_textures(textures: &mut Textures, delta: &TexturesDelta) -> Result<(), String> {
    for (id, updates) in &delta.set {
        for image in updates {
            let egui::ImageData::Color(data) = &image.image;
            let count = pixel_count(data.size)?;
            if data.pixels.len() != count {
                return Err("Dati della trama non validi".into());
            }
            if let Some([x, y]) = image.pos {
                let target = textures
                    .get_mut(id)
                    .ok_or("Trama parziale priva di origine")?;
                if target.pixels.len() != pixel_count(target.size)?
                    || x.checked_add(data.size[0])
                        .is_none_or(|end| end > target.size[0])
                    || y.checked_add(data.size[1])
                        .is_none_or(|end| end > target.size[1])
                {
                    return Err("Dimensioni della trama non valide".into());
                }
                for row in 0..data.size[1] {
                    let start = (y + row) * target.size[0] + x;
                    target.pixels[start..start + data.size[0]].copy_from_slice(
                        &data.pixels[row * data.size[0]..(row + 1) * data.size[0]],
                    );
                }
                target.options = image.options;
            } else {
                let other_pixels = textures.iter().filter(|(key, _)| *key != id).try_fold(
                    0usize,
                    |total, (_, texture)| {
                        total
                            .checked_add(texture.pixels.len())
                            .ok_or("Memoria delle trame esaurita")
                    },
                )?;
                if other_pixels.saturating_add(count) > MAX_TEXTURE_PIXELS
                    || (!textures.contains_key(id) && textures.len() >= MAX_TEXTURES)
                {
                    return Err("Le trame superano il limite di memoria dell'anteprima".into());
                }
                textures.insert(
                    *id,
                    Texture {
                        size: data.size,
                        pixels: data.pixels.clone(),
                        options: image.options,
                    },
                );
            }
        }
    }
    Ok(())
}

pub fn paint(
    primitives: &[ClippedPrimitive],
    textures: &Textures,
    width: u32,
    height: u32,
    scale: f32,
) -> Result<Vec<u8>, String> {
    let count = pixel_count([width as usize, height as usize])?;
    if !scale.is_finite() || scale <= 0.0 {
        return Err("Scala del disegno non valida".into());
    }
    let mut pixels = vec![255u8; count * 4];
    let mut work = 0u64;
    for primitive in primitives {
        let Primitive::Mesh(mesh) = &primitive.primitive else {
            return Err("Disegno del foglio non supportato".into());
        };
        if !mesh.is_valid() || !mesh.indices.len().is_multiple_of(3) {
            return Err("Geometria del foglio non valida".into());
        }
        if mesh.indices.is_empty() {
            continue;
        }
        let texture = textures
            .get(&mesh.texture_id)
            .ok_or("Trama del foglio assente")?;
        if texture.pixels.len() != pixel_count(texture.size)? {
            return Err("Dati della trama non validi".into());
        }
        let clip = primitive.clip_rect;
        if [clip.min.x, clip.min.y, clip.max.x, clip.max.y]
            .iter()
            .any(|v| v.is_nan())
        {
            return Err("Ritaglio del foglio non valido".into());
        }
        for triangle in mesh.indices.chunks_exact(3) {
            // Mesh::is_valid has checked every vertex index before this lookup.
            let mut vertices = [
                mesh.vertices[triangle[0] as usize],
                mesh.vertices[triangle[1] as usize],
                mesh.vertices[triangle[2] as usize],
            ];
            let mut p = vertices.map(|v| [v.pos.x * scale, v.pos.y * scale]);
            if p.iter().flatten().any(|v| !v.is_finite())
                || vertices
                    .iter()
                    .any(|v| !v.uv.x.is_finite() || !v.uv.y.is_finite())
            {
                return Err("Vertici del foglio non validi".into());
            }
            let mut area = edge(p[0], p[1], p[2][0], p[2][1]);
            if !area.is_finite() {
                return Err("Geometria del foglio non valida".into());
            }
            if area.abs() < 0.00001 {
                continue;
            }
            if area < 0.0 {
                p.swap(1, 2);
                vertices.swap(1, 2);
                area = -area;
            }
            let min_x = p
                .iter()
                .map(|p| p[0])
                .fold(f32::INFINITY, f32::min)
                .max(clip.min.x * scale)
                .floor()
                .clamp(0.0, width as f32) as u32;
            let min_y = p
                .iter()
                .map(|p| p[1])
                .fold(f32::INFINITY, f32::min)
                .max(clip.min.y * scale)
                .floor()
                .clamp(0.0, height as f32) as u32;
            let max_x = p
                .iter()
                .map(|p| p[0])
                .fold(f32::NEG_INFINITY, f32::max)
                .min(clip.max.x * scale)
                .ceil()
                .clamp(0.0, width as f32) as u32;
            let max_y = p
                .iter()
                .map(|p| p[1])
                .fold(f32::NEG_INFINITY, f32::max)
                .min(clip.max.y * scale)
                .ceil()
                .clamp(0.0, height as f32) as u32;
            work = work.saturating_add(
                u64::from(max_x.saturating_sub(min_x)) * u64::from(max_y.saturating_sub(min_y)),
            );
            if work > MAX_FRAGMENT_WORK {
                return Err("Il disegno supera il limite di complessità dell'anteprima".into());
            }
            let uv = vertices.map(|v| [v.uv.x, v.uv.y]);
            let (dx, dy, ex, ey) = (
                p[1][0] - p[0][0],
                p[1][1] - p[0][1],
                p[2][0] - p[0][0],
                p[2][1] - p[0][1],
            );
            let derivative = |channel: usize, dimension: usize| {
                let (a, b) = (
                    uv[1][channel] - uv[0][channel],
                    uv[2][channel] - uv[0][channel],
                );
                [
                    (a * ey - b * dy) / area * texture.size[dimension] as f32,
                    (dx * b - ex * a) / area * texture.size[dimension] as f32,
                ]
            };
            let [du_dx, du_dy] = derivative(0, 0);
            let [dv_dx, dv_dy] = derivative(1, 1);
            let filter = if du_dx.hypot(dv_dx).max(du_dy.hypot(dv_dy)) > 1.0 {
                texture.options.minification
            } else {
                texture.options.magnification
            };
            let colors = vertices.map(|v| v.color.to_array());
            let inclusive = [
                top_left(p[1], p[2]),
                top_left(p[2], p[0]),
                top_left(p[0], p[1]),
            ];
            for y in min_y..max_y {
                for x in min_x..max_x {
                    let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
                    if px < clip.min.x * scale
                        || px >= clip.max.x * scale
                        || py < clip.min.y * scale
                        || py >= clip.max.y * scale
                    {
                        continue;
                    }
                    let edges = [
                        edge(p[1], p[2], px, py),
                        edge(p[2], p[0], px, py),
                        edge(p[0], p[1], px, py),
                    ];
                    // Shared edges belong to one triangle: translucent quads have no diagonal seam.
                    if edges
                        .iter()
                        .zip(inclusive)
                        .any(|(v, include)| *v < 0.0 || (*v == 0.0 && !include))
                    {
                        continue;
                    }
                    let weights = edges.map(|v| v / area);
                    let u = (0..3).map(|i| uv[i][0] * weights[i]).sum::<f32>();
                    let v = (0..3).map(|i| uv[i][1] * weights[i]).sum::<f32>();
                    let sample = sample(texture, u, v, filter);
                    let mut color = [0.0f32; 4];
                    for channel in 0..4 {
                        color[channel] = sample[channel]
                            * (0..3)
                                .map(|i| colors[i][channel] as f32 * weights[i])
                                .sum::<f32>()
                            / 255.0;
                    }
                    let offset = (y as usize * width as usize + x as usize) * 4;
                    let inverse = 1.0 - color[3] / 255.0;
                    for channel in 0..3 {
                        pixels[offset + channel] =
                            (color[channel] + pixels[offset + channel] as f32 * inverse)
                                .round()
                                .clamp(0.0, 255.0) as u8;
                    }
                }
            }
        }
    }
    Ok(pixels)
}

fn edge(a: [f32; 2], b: [f32; 2], x: f32, y: f32) -> f32 {
    (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])
}
fn top_left(a: [f32; 2], b: [f32; 2]) -> bool {
    b[1] < a[1] || (b[1] == a[1] && b[0] > a[0])
}

fn sample(texture: &Texture, u: f32, v: f32, filter: TextureFilter) -> [f32; 4] {
    let normalize = |value: f32| match texture.options.wrap_mode {
        TextureWrapMode::ClampToEdge => value.clamp(0.0, 1.0),
        TextureWrapMode::Repeat => value.rem_euclid(1.0),
        TextureWrapMode::MirroredRepeat => {
            let value = value.rem_euclid(2.0);
            if value > 1.0 { 2.0 - value } else { value }
        }
    };
    let (u, v) = (normalize(u), normalize(v));
    let texel = |x: i64, y: i64| {
        let index = |value: i64, size: usize| match texture.options.wrap_mode {
            TextureWrapMode::ClampToEdge => value.clamp(0, size as i64 - 1) as usize,
            TextureWrapMode::Repeat => value.rem_euclid(size as i64) as usize,
            TextureWrapMode::MirroredRepeat => {
                let value = value.rem_euclid(size as i64 * 2);
                if value >= size as i64 {
                    size * 2 - 1 - value as usize
                } else {
                    value as usize
                }
            }
        };
        texture.pixels[index(y, texture.size[1]) * texture.size[0] + index(x, texture.size[0])]
            .to_array()
            .map(f32::from)
    };
    if filter == TextureFilter::Nearest {
        return texel(
            (u * texture.size[0] as f32).floor() as i64,
            (v * texture.size[1] as f32).floor() as i64,
        );
    }
    let (x, y) = (
        u * texture.size[0] as f32 - 0.5,
        v * texture.size[1] as f32 - 0.5,
    );
    let (left, top, fx, fy) = (
        x.floor() as i64,
        y.floor() as i64,
        x - x.floor(),
        y - y.floor(),
    );
    let c = [
        texel(left, top),
        texel(left + 1, top),
        texel(left, top + 1),
        texel(left + 1, top + 1),
    ];
    std::array::from_fn(|channel| {
        (c[0][channel] * (1.0 - fx) + c[1][channel] * fx) * (1.0 - fy)
            + (c[2][channel] * (1.0 - fx) + c[3][channel] * fx) * fy
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use egui::{
        ColorImage,
        epaint::{ImageDelta, Mesh, Vertex},
        pos2,
    };
    fn textures() -> Textures {
        HashMap::from([(
            TextureId::Managed(0),
            Texture {
                size: [1, 1],
                pixels: vec![Color32::WHITE],
                options: TextureOptions::LINEAR,
            },
        )])
    }
    fn quad(color: Color32) -> ClippedPrimitive {
        ClippedPrimitive {
            clip_rect: egui::Rect::EVERYTHING,
            primitive: Primitive::Mesh(Mesh {
                texture_id: TextureId::Managed(0),
                indices: vec![0, 1, 2, 0, 2, 3],
                vertices: [[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0]]
                    .map(|p| Vertex {
                        pos: pos2(p[0], p[1]),
                        uv: pos2(0.5, 0.5),
                        color,
                    })
                    .to_vec(),
            }),
        }
    }
    #[test]
    fn translucent_quad_has_no_double_blended_diagonal() {
        let rgba = paint(
            &[quad(Color32::from_black_alpha(128))],
            &textures(),
            4,
            4,
            1.0,
        )
        .expect("quad render");
        assert!(
            rgba.chunks_exact(4)
                .all(|pixel| pixel == [127, 127, 127, 255])
        );
    }
    #[test]
    fn respects_linear_and_nearest_texture_filtering() {
        let t = Texture {
            size: [2, 1],
            pixels: vec![Color32::BLACK, Color32::WHITE],
            options: TextureOptions::LINEAR,
        };
        assert_eq!(
            sample(&t, 0.5, 0.5, TextureFilter::Linear),
            [127.5, 127.5, 127.5, 255.0]
        );
        assert_eq!(sample(&t, 0.5, 0.5, TextureFilter::Nearest), [255.0; 4]);
    }
    #[test]
    fn rejects_invalid_mesh_data_and_output_dimensions() {
        let mut primitive = quad(Color32::WHITE);
        let Primitive::Mesh(mesh) = &mut primitive.primitive else {
            unreachable!()
        };
        mesh.indices[0] = 99;
        assert!(paint(&[primitive], &textures(), 4, 4, 1.0).is_err());
        assert!(paint(&[], &textures(), 20_000, 20_000, 1.0).is_err());
        assert!(paint(&[], &textures(), 4, 4, f32::NAN).is_err());
        let mut malformed = ColorImage::filled([1, 1], Color32::WHITE);
        malformed.size = [2, 2];
        let mut delta = TexturesDelta::default();
        delta.push(
            TextureId::Managed(0),
            ImageDelta::full(malformed, TextureOptions::LINEAR),
        );
        let rejected = update_textures(&mut textures(), &delta).is_err();
        // egui requires integrations to acknowledge every delta, including rejected input.
        delta.clear();
        assert!(rejected);
    }
    #[test]
    fn rejects_partial_texture_overflow_and_oversized_textures() {
        let image = ColorImage::filled([1, 1], Color32::WHITE);
        let mut delta = TexturesDelta::default();
        delta.push(
            TextureId::Managed(0),
            ImageDelta::partial([usize::MAX, 0], image, TextureOptions::LINEAR),
        );
        let rejected = update_textures(&mut textures(), &delta).is_err();
        delta.clear();
        assert!(rejected);
        let mut oversized = ColorImage::filled([1, 1], Color32::WHITE);
        oversized.size = [MAX_PIXELS + 1, 1];
        let mut delta = TexturesDelta::default();
        delta.push(
            TextureId::Managed(1),
            ImageDelta::full(oversized, TextureOptions::LINEAR),
        );
        let rejected = update_textures(&mut textures(), &delta).is_err();
        delta.clear();
        assert!(rejected);
    }
}
