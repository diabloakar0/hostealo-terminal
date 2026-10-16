//! The iPhone and iPad clipboard (UIPasteboard), for remote desktop sessions: text and images,
//! both ways. Files stay out: iOS apps cannot put files on the clipboard for other apps.
//!
//! iOS asks the user before an app reads what another app copied. The session only reads after
//! the pasteboard's change counter moves (reading the counter needs no permission), so the
//! question comes once per copy, when you come back to the app; in Settings › Hostealo Terminal
//! › Paste from Other Apps it can be allowed for good.

use std::io::Cursor;
#[cfg(target_os = "ios")]
use std::path::PathBuf;

use super::Image;
#[cfg(target_os = "ios")]
use super::LocalClipboard;

#[cfg(target_os = "ios")]
#[derive(Default)]
pub struct IosClipboard;

#[cfg(target_os = "ios")]
impl LocalClipboard for IosClipboard {
    fn change_count(&self) -> Option<u64> {
        let pasteboard = objc2_ui_kit::UIPasteboard::generalPasteboard();
        // SAFETY: a plain getter on the shared pasteboard, which is safe from any thread.
        Some(unsafe { pasteboard.changeCount() } as u64)
    }

    fn text(&self) -> Option<String> {
        let pasteboard = objc2_ui_kit::UIPasteboard::generalPasteboard();
        // SAFETY: as above. `hasStrings` does not trigger the paste permission; `string` may.
        unsafe {
            if !pasteboard.hasStrings() {
                return None;
            }
            pasteboard.string().map(|text| text.to_string())
        }
    }

    fn image(&self) -> Option<Image> {
        let pasteboard = objc2_ui_kit::UIPasteboard::generalPasteboard();
        // SAFETY: as above.
        let image = unsafe {
            if !pasteboard.hasImages() {
                return None;
            }
            pasteboard.image()?
        };
        decode_png(&image.png_representation()?.to_vec())
    }

    fn files(&self) -> Vec<PathBuf> {
        Vec::new()
    }

    fn set_text(&self, text: &str) {
        let pasteboard = objc2_ui_kit::UIPasteboard::generalPasteboard();
        // SAFETY: setting a string on the shared pasteboard.
        unsafe { pasteboard.setString(Some(&objc2_foundation::NSString::from_str(text))) };
    }

    fn set_image(&self, image: &Image) {
        let Some(png) = encode_png(image) else {
            return;
        };
        let data = objc2_foundation::NSData::with_bytes(&png);
        let Some(image) = objc2_ui_kit::UIImage::imageWithData(&data) else {
            return;
        };
        let pasteboard = objc2_ui_kit::UIPasteboard::generalPasteboard();
        // SAFETY: setting an image on the shared pasteboard.
        unsafe { pasteboard.setImage(Some(&image)) };
    }
}

/// A PNG file as RGBA rows (UIKit hands images over as PNG).
pub(crate) fn decode_png(bytes: &[u8]) -> Option<Image> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut buf).ok()?;
    buf.truncate(info.buffer_size());
    let pixels = (info.width as usize) * (info.height as usize);
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => buf
            .as_chunks::<3>()
            .0
            .iter()
            .flat_map(|&[r, g, b]| [r, g, b, 255])
            .collect(),
        png::ColorType::GrayscaleAlpha => buf
            .as_chunks::<2>()
            .0
            .iter()
            .flat_map(|&[g, a]| [g, g, g, a])
            .collect(),
        png::ColorType::Grayscale => buf.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        // Expanded by the transformation above; never reaches here.
        png::ColorType::Indexed => return None,
    };
    (rgba.len() == pixels * 4).then_some(Image {
        width: info.width as usize,
        height: info.height as usize,
        rgba,
    })
}

/// RGBA rows as a PNG file.
pub(crate) fn encode_png(image: &Image) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, image.width as u32, image.height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().ok()?;
    writer.write_image_data(&image.rgba).ok()?;
    writer.finish().ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn images_survive_the_trip_through_png() {
        let image = Image {
            width: 3,
            height: 2,
            rgba: (0..24).map(|i| (i * 10) as u8).collect(),
        };
        let png = encode_png(&image).unwrap();
        assert_eq!(&png[1..4], b"PNG");
        assert_eq!(decode_png(&png), Some(image));
    }

    #[test]
    fn rgb_pngs_get_an_opaque_alpha() {
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, 2, 1);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&[1, 2, 3, 4, 5, 6]).unwrap();
        writer.finish().unwrap();
        let image = decode_png(&out).unwrap();
        assert_eq!(image.rgba, vec![1, 2, 3, 255, 4, 5, 6, 255]);
    }

    #[test]
    fn garbage_is_not_an_image() {
        assert_eq!(decode_png(b"not a png"), None);
    }
}
