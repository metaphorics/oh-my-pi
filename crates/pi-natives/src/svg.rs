//! SVG rasterization helpers.
//!
//! Converts trusted, already-generated SVG strings to PNG bytes for terminal
//! image protocols. Parsing and rendering are offloaded through the shared
//! blocking task wrapper so the N-API event loop stays responsive.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use resvg::{tiny_skia, usvg};

use crate::task;

const MAX_ZOOM: f32 = 8.0;
const MAX_PIXELS: u64 = 64_000_000;

#[napi]
pub fn render_svg_to_png(svg: String, zoom: f64) -> task::Promise<Uint8Array> {
	task::blocking("render_svg_to_png", (), move |_| render_svg_to_png_sync(&svg, zoom))
}

fn render_svg_to_png_sync(svg: &str, zoom: f64) -> Result<Uint8Array> {
	if svg.trim().is_empty() {
		return Err(Error::from_reason("SVG input is empty"));
	}
	if !zoom.is_finite() || zoom <= 0.0 || zoom > f64::from(MAX_ZOOM) {
		return Err(Error::from_reason(format!(
			"Invalid SVG zoom {zoom}: expected 0 < zoom <= {MAX_ZOOM}"
		)));
	}
	let zoom = zoom as f32;
	let mut options = usvg::Options::default();
	options.fontdb_mut().load_system_fonts();
	let tree =
		usvg::Tree::from_str(svg, &options).map_err(|err| Error::from_reason(err.to_string()))?;
	let size = tree
		.size()
		.scale_by(zoom)
		.ok_or_else(|| Error::from_reason("Scaled SVG size is invalid"))?
		.to_int_size();
	let width = size.width();
	let height = size.height();
	if u64::from(width) * u64::from(height) > MAX_PIXELS {
		return Err(Error::from_reason(format!(
			"Scaled SVG is too large: {width}x{height} exceeds {MAX_PIXELS} pixels"
		)));
	}
	let mut pixmap = tiny_skia::Pixmap::new(width, height).ok_or_else(|| {
		Error::from_reason(format!("Failed to allocate SVG pixmap {width}x{height}"))
	})?;
	resvg::render(&tree, tiny_skia::Transform::from_scale(zoom, zoom), &mut pixmap.as_mut());
	let png = pixmap
		.encode_png()
		.map_err(|err| Error::from_reason(err.to_string()))?;
	Ok(Uint8Array::from(png))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn renders_svg_to_png_bytes() {
		let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="red"/></svg>"#;
		let png = render_svg_to_png_sync(svg, 2.0).expect("svg renders");
		let bytes = png.to_vec();
		assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
		assert_eq!(u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]), 8);
		assert_eq!(u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]), 6);
	}
}
