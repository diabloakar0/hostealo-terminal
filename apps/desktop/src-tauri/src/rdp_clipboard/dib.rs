//! Images on the Windows clipboard travel as CF_DIB: a BITMAPINFOHEADER (or a V4/V5 header)
//! followed by the pixels, usually bottom-up. These convert between that and plain RGBA.

use super::Image;

/// Larger images are refused rather than allocating gigabytes.
const MAX_PIXELS: usize = 16384 * 16384;

const BI_RGB: u32 = 0;
const BI_BITFIELDS: u32 = 3;
const BI_ALPHABITFIELDS: u32 = 6;

/// RGBA → 32-bit bottom-up DIB (what Windows apps expect from CF_DIB).
pub fn encode(image: &Image) -> Vec<u8> {
    let (width, height) = (image.width, image.height);
    let mut dib = Vec::with_capacity(40 + width * height * 4);
    dib.extend_from_slice(&40u32.to_le_bytes()); // biSize
    dib.extend_from_slice(&(width as i32).to_le_bytes());
    dib.extend_from_slice(&(height as i32).to_le_bytes()); // positive: bottom-up
    dib.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    dib.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
    dib.extend_from_slice(&BI_RGB.to_le_bytes());
    dib.extend_from_slice(&((width * height * 4) as u32).to_le_bytes()); // biSizeImage
    dib.extend_from_slice(&2835i32.to_le_bytes()); // 72 DPI
    dib.extend_from_slice(&2835i32.to_le_bytes());
    dib.extend_from_slice(&0u32.to_le_bytes()); // biClrUsed
    dib.extend_from_slice(&0u32.to_le_bytes()); // biClrImportant
    for row in image.rgba.chunks_exact(width * 4).rev() {
        for pixel in row.as_chunks::<4>().0 {
            dib.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
        }
    }
    dib
}

fn u16_at(data: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(data.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

/// One colour channel described by a bit mask.
#[derive(Clone, Copy)]
struct Channel {
    mask: u32,
    shift: u32,
    max: u32,
}

impl Channel {
    fn new(mask: u32) -> Self {
        let shift = if mask == 0 { 0 } else { mask.trailing_zeros() };
        Self {
            mask,
            shift,
            max: mask.checked_shr(shift).unwrap_or(0),
        }
    }

    fn read(self, pixel: u32) -> Option<u8> {
        (self.max > 0).then(|| (((pixel & self.mask) >> self.shift) * 255 / self.max) as u8)
    }
}

/// CF_DIB / CF_DIBV5 → RGBA. Supports the 16, 24 and 32-bit formats apps actually put on the
/// clipboard; palettes and compressed bitmaps are refused.
pub fn decode(data: &[u8]) -> Option<Image> {
    let header_size = u32_at(data, 0)? as usize;
    if header_size < 40 {
        return None;
    }
    let width = usize::try_from(i32::from_le_bytes(data.get(4..8)?.try_into().ok()?)).ok()?;
    let raw_height = i32::from_le_bytes(data.get(8..12)?.try_into().ok()?);
    let height = raw_height.unsigned_abs() as usize;
    let top_down = raw_height < 0;
    let bit_count = u16_at(data, 14)?;
    let compression = u32_at(data, 16)?;
    let colors_used = u32_at(data, 32)? as usize;
    if width == 0 || height == 0 || width.checked_mul(height)? > MAX_PIXELS {
        return None;
    }

    let mut offset = header_size;
    let masks = match (compression, bit_count) {
        (BI_BITFIELDS | BI_ALPHABITFIELDS, 16 | 32) => {
            // V4/V5 headers carry the masks; a plain header is followed by them.
            let at = if header_size >= 52 { 40 } else { header_size };
            let alpha = if compression == BI_ALPHABITFIELDS || header_size >= 56 {
                u32_at(data, at + 12)?
            } else {
                0
            };
            if header_size < 52 {
                offset += if compression == BI_ALPHABITFIELDS {
                    16
                } else {
                    12
                };
            }
            [
                u32_at(data, at)?,
                u32_at(data, at + 4)?,
                u32_at(data, at + 8)?,
                alpha,
            ]
        }
        (BI_RGB, 16) => [0x7C00, 0x03E0, 0x001F, 0],
        (BI_RGB, 24) => [0xFF_0000, 0x00_FF00, 0x00_00FF, 0],
        (BI_RGB, 32) => [0x00FF_0000, 0x0000_FF00, 0x0000_00FF, 0xFF00_0000],
        _ => return None,
    };
    offset += colors_used.min(256) * 4;

    let bytes_per_pixel = usize::from(bit_count / 8);
    let stride = (width * usize::from(bit_count)).div_ceil(32) * 4;
    let pixels = data.get(offset..offset.checked_add(stride.checked_mul(height)?)?)?;
    let [red, green, blue, alpha] = masks.map(Channel::new);

    let mut rgba = Vec::with_capacity(width * height * 4);
    for y in 0..height {
        let row = if top_down { y } else { height - 1 - y };
        let row = &pixels[row * stride..row * stride + width * bytes_per_pixel];
        for pixel in row.chunks_exact(bytes_per_pixel) {
            let mut value = [0u8; 4];
            value[..bytes_per_pixel].copy_from_slice(pixel);
            let value = u32::from_le_bytes(value);
            rgba.extend_from_slice(&[
                red.read(value).unwrap_or(0),
                green.read(value).unwrap_or(0),
                blue.read(value).unwrap_or(0),
                alpha.read(value).unwrap_or(255),
            ]);
        }
    }
    // Most 32-bit DIBs leave the alpha byte at zero: such an image is opaque, not invisible.
    if alpha.max > 0 && rgba.as_chunks::<4>().0.iter().all(|pixel| pixel[3] == 0) {
        for pixel in rgba.as_chunks_mut::<4>().0 {
            pixel[3] = 255;
        }
    }
    Some(Image {
        width,
        height,
        rgba,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Image {
        // 3×2: red, green, blue / white, black, half-transparent grey.
        Image {
            width: 3,
            height: 2,
            rgba: vec![
                255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, //
                255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 128,
            ],
        }
    }

    #[test]
    fn round_trips_through_a_32_bit_dib() {
        let image = sample();
        let dib = encode(&image);
        assert_eq!(dib.len(), 40 + 3 * 2 * 4);
        // Bottom-up: the first stored row is the image's last one, in BGRA.
        assert_eq!(&dib[40..44], &[255, 255, 255, 255]);
        assert_eq!(decode(&dib), Some(image));
    }

    #[test]
    fn decodes_24_bit_rows_with_padding_and_top_down_images() {
        // 3×2, 24-bit: rows of 9 bytes padded to 12.
        let mut dib = encode(&sample())[..40].to_vec();
        dib[8..12].copy_from_slice(&(-2i32).to_le_bytes()); // top-down
        dib[14..16].copy_from_slice(&24u16.to_le_bytes());
        dib.extend_from_slice(&[0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 0]);
        dib.extend_from_slice(&[255, 255, 255, 0, 0, 0, 10, 20, 30, 0, 0, 0]);
        let image = decode(&dib).unwrap();
        assert_eq!(
            &image.rgba[..12],
            &[255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]
        );
        assert_eq!(&image.rgba[20..], &[30, 20, 10, 255]);
    }

    #[test]
    fn decodes_bitfield_masks() {
        // 1×1, 32-bit BI_BITFIELDS with the masks after a plain header, alpha byte zero.
        let mut dib = encode(&Image {
            width: 1,
            height: 1,
            rgba: vec![0; 4],
        })[..40]
            .to_vec();
        dib[16..20].copy_from_slice(&BI_BITFIELDS.to_le_bytes());
        for mask in [0x0000_00FFu32, 0x0000_FF00, 0x00FF_0000] {
            dib.extend_from_slice(&mask.to_le_bytes());
        }
        dib.extend_from_slice(&[1, 2, 3, 0]);
        assert_eq!(decode(&dib).unwrap().rgba, vec![1, 2, 3, 255]);
    }

    #[test]
    fn rejects_truncated_and_unsupported_bitmaps() {
        let dib = encode(&sample());
        assert_eq!(decode(&dib[..dib.len() - 1]), None);
        let mut paletted = dib.clone();
        paletted[14..16].copy_from_slice(&8u16.to_le_bytes());
        assert_eq!(decode(&paletted), None);
        assert_eq!(decode(&[0; 12]), None);
    }
}
