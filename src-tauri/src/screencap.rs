//! A picture of this screen, for a phone that is driving it.
//!
//! Not WebRTC, which is what the calls use. Screen sharing there goes through
//! `getDisplayMedia`, and that opens the operating system's own "which window
//! would you like to share?" picker — which needs somebody standing at the
//! machine to answer it. The entire point of remote control is that nobody is.
//! The grant this device already gave is the consent; asking a second time, in
//! a dialog only the absent person could see, is asking nobody.
//!
//! So the screen is captured here and served as ordinary JPEG frames over the
//! HTTP server this application is already running. An `<img>` pointed at a
//! multipart stream displays it with no player, no negotiation and no codec —
//! which on a phone across the room is worth more than efficiency.
//!
//! It is deliberately not good video. Ten frames a second of a scaled-down
//! desktop is enough to find a window and click a button, and that is what
//! this is for. Anything smoother means encoding h264, which means a
//! negotiated peer connection, which means the picker again.

/// The widths on offer, and what each costs.
///
/// Measured on a 2560x1440 desktop rather than chosen, because the honest
/// range is narrow and guessing it wide would be a menu of settings that do
/// not work:
///
/// ```text
///   720p      64 ms/frame = 15.7 fps ceiling    82 KB/frame
///   1080p     93 ms/frame = 10.7 fps ceiling   165 KB/frame
///   native   133 ms/frame =  7.5 fps ceiling   258 KB/frame
/// ```
///
/// Those ceilings are the machine, before a byte reaches the network. Sixty
/// frames a second of 1080p as JPEG would also need 77 Mbit/s, which no
/// 802.11n link is going to carry. Getting there needs a codec that sends
/// differences rather than whole pictures, which is a different mechanism
/// entirely and is noted where the choice is made.
pub const WIDTHS: [u32; 3] = [1280, 1920, 0];

/// The widest a frame is sent at.
///
/// A 4K desktop scaled to 1280 is still readable on a phone held at arm's
/// length, and is a quarter of the pixels to encode and push. The limit is on
/// width alone so an ultrawide monitor keeps its shape.
pub const MAX_WIDTH: u32 = 1280;

/// How good the JPEG is.
///
/// Sixty is where text stops looking chewed. Below that the thing you are
/// trying to read is the thing that goes first.
pub const QUALITY: u8 = 60;

/// The smallest gap between frames, in milliseconds.
///
/// Capturing is the expensive half and it happens on the machine somebody else
/// may be using. Ten a second keeps that cost bounded and is quick enough to
/// aim a pointer.
pub const MIN_FRAME_MS: u64 = 100;

/// Turns a requested rate into a gap between frames.
///
/// Anything is accepted and clamped rather than refused: a rate the machine
/// cannot reach simply means it runs flat out, which is what somebody asking
/// for sixty actually wants when sixty is not available.
pub fn frame_gap_ms(fps: u32) -> u64 {
    let fps = fps.clamp(1, 60);
    1000 / u64::from(fps)
}

/// The width to send at, given what was asked for.
///
/// Zero means the screen's own width. Anything wider than the screen is
/// pointless - upscaling a picture to send more bytes of the same detail - so
/// it is capped there.
pub fn requested_width(asked: u32, screen_w: u32) -> u32 {
    if asked == 0 || asked > screen_w {
        return screen_w;
    }
    asked.max(320)
}

/// Shrinks a screen grab and drops its alpha, in one pass.
///
/// The generic resize was taking 82 of the 140 milliseconds a frame cost —
/// more than the capture and the JPEG encoder put together. It is a filtered
/// resample built for arbitrary ratios and arbitrary quality, and neither is
/// wanted here: a 2560-wide screen going to 1280 is exactly two to one, and
/// the picture is going to a phone.
///
/// So this walks the output once, averages the block of source pixels each
/// output pixel stands for, and writes RGB straight out. No intermediate
/// image, no second pass to drop the alpha channel a screen grab does not
/// meaningfully have.
///
/// Averaging rather than picking one pixel of the block matters for exactly
/// the thing this is used for: text. Skipping pixels makes small type shimmer
/// and break up as windows move, which is unreadable in the way that matters
/// when you are trying to find a button.
pub fn downscale_to_rgb(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    out_w: u32,
    out_h: u32,
) -> Vec<u8> {
    let mut out = vec![0u8; (out_w as usize) * (out_h as usize) * 3];
    if src_w == 0 || src_h == 0 || out_w == 0 || out_h == 0 {
        return out;
    }

    // How many source pixels wide and tall each output pixel covers. Held as
    // fixed point so the walk needs no division per pixel.
    let step_x = ((src_w as u64) << 16) / out_w as u64;
    let step_y = ((src_h as u64) << 16) / out_h as u64;
    let block_w = (step_x >> 16).max(1) as usize;
    let block_h = (step_y >> 16).max(1) as usize;
    let samples = (block_w * block_h) as u32;

    for y in 0..out_h as usize {
        let src_y0 = ((y as u64 * step_y) >> 16) as usize;
        let row_out = y * out_w as usize * 3;

        for x in 0..out_w as usize {
            let src_x0 = ((x as u64 * step_x) >> 16) as usize;
            let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);

            for by in 0..block_h {
                let sy = (src_y0 + by).min(src_h as usize - 1);
                let row = sy * src_w as usize * 4;
                for bx in 0..block_w {
                    let sx = (src_x0 + bx).min(src_w as usize - 1);
                    let at = row + sx * 4;
                    r += u32::from(src[at]);
                    g += u32::from(src[at + 1]);
                    b += u32::from(src[at + 2]);
                }
            }

            let at = row_out + x * 3;
            out[at] = (r / samples) as u8;
            out[at + 1] = (g / samples) as u8;
            out[at + 2] = (b / samples) as u8;
        }
    }
    out
}

/// How wide and tall a frame should be, given the screen it came from.
///
/// Kept separate from the capture so the arithmetic can be checked without a
/// display attached — a build machine has no screen, and the ratio being wrong
/// is exactly the bug that would make every tap land in the wrong place.
pub fn scaled_size(width: u32, height: u32) -> (u32, u32) {
    size_for(width, height, MAX_WIDTH)
}

/// The same, to a width the far side chose.
pub fn size_for(width: u32, height: u32, target: u32) -> (u32, u32) {
    if width == 0 || height == 0 || target == 0 {
        return (0, 0);
    }
    if width <= target {
        return (width, height);
    }
    let scaled_height = (u64::from(height) * u64::from(target) / u64::from(width)) as u32;
    // A very wide, very short screen could round to nothing, and a zero-height
    // image is not encodable.
    (target, scaled_height.max(1))
}

#[cfg(target_os = "windows")]
pub use windows_impl::{capture_jpeg, capture_jpeg_at, screen_size};

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{scaled_size, QUALITY};
    use image::codecs::jpeg::JpegEncoder;
    use image::{ExtendedColorType, RgbaImage};

    /// The primary screen's size in pixels.
    ///
    /// Needed by the far end to turn a tap into a coordinate, and worth
    /// answering separately from a frame so it can be asked once.
    pub fn screen_size() -> Option<(u32, u32)> {
        let monitor = primary()?;
        Some((monitor.width().ok()?, monitor.height().ok()?))
    }

    fn primary() -> Option<xcap::Monitor> {
        let monitors = xcap::Monitor::all().ok()?;
        monitors
            .iter()
            .find(|m| m.is_primary().unwrap_or(false))
            .or_else(|| monitors.first())
            .cloned()
    }

    /// One frame, as JPEG bytes.
    ///
    /// Returns the encoded picture and the size it was captured at — not the
    /// size it was sent at. The far end needs the original to map a tap back
    /// onto the desktop, and scaling happening in here is not its business.
    pub fn capture_jpeg() -> Result<(Vec<u8>, u32, u32), String> {
        capture_jpeg_at(super::MAX_WIDTH)
    }

    /// One frame, at a width the far side asked for.
    pub fn capture_jpeg_at(target: u32) -> Result<(Vec<u8>, u32, u32), String> {
        let monitor = primary().ok_or("no screen to capture")?;
        let shot: RgbaImage = monitor.capture_image().map_err(|e| e.to_string())?;
        let (full_w, full_h) = (shot.width(), shot.height());

        let (w, h) = super::size_for(full_w, full_h, super::requested_width(target, full_w));
        let rgb = super::downscale_to_rgb(shot.as_raw(), full_w, full_h, w, h);

        let mut jpeg = Vec::with_capacity(64 * 1024);
        JpegEncoder::new_with_quality(&mut jpeg, QUALITY)
            .encode(&rgb, w, h, ExtendedColorType::Rgb8)
            .map_err(|e| e.to_string())?;

        Ok((jpeg, full_w, full_h))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_small_screen_is_sent_as_it_is() {
        assert_eq!(scaled_size(1280, 720), (1280, 720));
        assert_eq!(scaled_size(1024, 768), (1024, 768));
    }

    #[test]
    fn a_big_one_is_scaled_to_the_limit() {
        assert_eq!(scaled_size(2560, 1440), (MAX_WIDTH, 720));
        assert_eq!(scaled_size(3840, 2160), (MAX_WIDTH, 720));
    }

    /// The shape has to survive, or every tap lands somewhere else.
    #[test]
    fn and_keeps_its_shape() {
        for (w, h) in [(2560u32, 1440u32), (3440, 1440), (1920, 1200), (5120, 2160)] {
            let (sw, sh) = scaled_size(w, h);
            let before = f64::from(w) / f64::from(h);
            let after = f64::from(sw) / f64::from(sh);
            assert!(
                (before - after).abs() < 0.01,
                "{w}x{h} became {sw}x{sh}: {before:.3} vs {after:.3}",
            );
        }
    }

    #[test]
    fn nothing_is_ever_zero_sized() {
        // An encoder given a zero dimension fails, and a screen this shape is
        // absurd but not impossible with a projector or a rotated panel.
        let (w, h) = scaled_size(20000, 3);
        assert!(w > 0 && h > 0, "{w}x{h}");
    }

    #[test]
    fn no_screen_at_all_is_not_a_panic() {
        assert_eq!(scaled_size(0, 0), (0, 0));
        assert_eq!(scaled_size(1920, 0), (0, 0));
    }

    #[test]
    fn a_rate_becomes_a_gap() {
        assert_eq!(frame_gap_ms(10), 100);
        assert_eq!(frame_gap_ms(30), 33);
        assert_eq!(frame_gap_ms(60), 16);
        // Nonsense is clamped rather than refused: a zero would divide by
        // zero, and a request for a thousand simply means "as fast as you can".
        assert_eq!(frame_gap_ms(0), 1000);
        assert_eq!(frame_gap_ms(100_000), frame_gap_ms(60));
    }

    #[test]
    fn a_width_is_never_more_than_the_screen() {
        // Upscaling would send more bytes of the same detail.
        assert_eq!(requested_width(3840, 2560), 2560);
        assert_eq!(requested_width(0, 2560), 2560, "zero means native");
        assert_eq!(requested_width(1920, 2560), 1920);
        assert_eq!(requested_width(1280, 2560), 1280);
        // And never so small it is useless.
        assert_eq!(requested_width(1, 2560), 320);
    }

    #[test]
    fn a_chosen_width_keeps_the_shape() {
        for target in [1280u32, 1920, 2560] {
            let (w, h) = size_for(2560, 1440, target);
            assert_eq!(w, target);
            let before = 2560.0 / 1440.0;
            let after = f64::from(w) / f64::from(h);
            assert!((before - after).abs() < 0.01, "{target}: {w}x{h}");
        }
    }

    /// How many frames a second this machine can actually manage.
    ///
    /// Worth measuring rather than choosing, because the answer decides which
    /// frame rates are honest to offer. Capture and encode are both real work
    /// on a machine somebody else may be using.
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "needs a real display"]
    fn how_fast_can_it_go() {
        // One outside the timing, so a cold graphics path is not counted.
        let _ = capture_jpeg();

        let rounds = 20;
        let mut encoded = 0usize;
        let started = std::time::Instant::now();
        for _ in 0..rounds {
            let (jpeg, _, _) = capture_jpeg().expect("capture failed");
            encoded += jpeg.len();
        }
        let each = started.elapsed() / rounds as u32;
        let fps = 1.0 / each.as_secs_f64();
        let kb = encoded / rounds as usize / 1024;

        println!("  {each:?} per frame  =  {fps:.1} fps");
        println!("  {kb} KB per frame  =  {:.1} Mbit/s at that rate", fps * kb as f64 * 8.0 / 1024.0);
        assert!(fps > 1.0, "only {fps:.1} fps, which is not usable for anything");
    }

    /// Which of the three stages is actually costing the time.
    ///
    /// Guessing here would be expensive: capture, scale and encode are wholly
    /// different problems with wholly different fixes, and optimising the
    /// wrong one is a day for nothing.
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "needs a real display"]
    fn where_the_time_goes() {
        use image::{imageops::FilterType, ExtendedColorType, RgbaImage};
        use image::codecs::jpeg::JpegEncoder;

        let monitor = xcap::Monitor::all().unwrap().into_iter().next().unwrap();
        let _ = monitor.capture_image();

        let rounds = 10u32;

        let t = std::time::Instant::now();
        let mut shot: Option<RgbaImage> = None;
        for _ in 0..rounds {
            shot = Some(monitor.capture_image().unwrap());
        }
        let capture = t.elapsed() / rounds;
        let shot = shot.unwrap();
        let (w, h) = scaled_size(shot.width(), shot.height());

        let t = std::time::Instant::now();
        let mut small = None;
        for _ in 0..rounds {
            small = Some(image::imageops::resize(&shot, w, h, FilterType::Triangle));
        }
        let scale = t.elapsed() / rounds;
        let small = small.unwrap();

        let t = std::time::Instant::now();
        for _ in 0..rounds {
            let rgb = image::DynamicImage::ImageRgba8(small.clone()).into_rgb8();
            let mut out = Vec::with_capacity(128 * 1024);
            JpegEncoder::new_with_quality(&mut out, QUALITY)
                .encode(rgb.as_raw(), w, h, ExtendedColorType::Rgb8)
                .unwrap();
        }
        let encode = t.elapsed() / rounds;

        println!("  screen {}x{} -> {w}x{h}", shot.width(), shot.height());
        println!("  capture {capture:?}");
        println!("  scale   {scale:?}");
        println!("  encode  {encode:?}");
        println!("  total   {:?}", capture + scale + encode);
    }

    /// What 1080p would cost, measured rather than assumed.
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "needs a real display"]
    fn what_1080p_costs() {
        use image::codecs::jpeg::JpegEncoder;
        use image::ExtendedColorType;

        let monitor = xcap::Monitor::all().unwrap().into_iter().next().unwrap();
        let _ = monitor.capture_image();

        for (label, width) in [("720p", 1280u32), ("1080p", 1920), ("native", 2560)] {
            let rounds = 10u32;
            let mut bytes = 0usize;
            let t = std::time::Instant::now();
            for _ in 0..rounds {
                let shot = monitor.capture_image().unwrap();
                let (sw, sh) = (shot.width(), shot.height());
                let h = ((u64::from(sh) * u64::from(width) / u64::from(sw)) as u32).max(1);
                let rgb = super::downscale_to_rgb(shot.as_raw(), sw, sh, width, h);
                let mut out = Vec::with_capacity(256 * 1024);
                JpegEncoder::new_with_quality(&mut out, QUALITY)
                    .encode(&rgb, width, h, ExtendedColorType::Rgb8)
                    .unwrap();
                bytes += out.len();
            }
            let each = t.elapsed() / rounds;
            let fps = 1.0 / each.as_secs_f64();
            let kb = bytes / rounds as usize / 1024;
            println!(
                "  {label:7} {each:>12?} = {fps:5.1} fps max   {kb:4} KB/frame                    {:6.1} Mbit/s at 60fps",
                60.0 * kb as f64 * 8.0 / 1024.0,
            );
        }
    }

    /// Actually grabs this machine's screen and encodes it.
    ///
    /// Ignored by default: a build machine has no display, and the failure
    /// there would say nothing about the code. Run where there is a screen.
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "needs a real display"]
    fn a_real_frame_can_be_captured() {
        let (jpeg, w, h) = capture_jpeg().expect("could not capture");
        assert!(w > 0 && h > 0, "reported {w}x{h}");
        // JPEG starts with the start-of-image marker. Checking the bytes
        // rather than the length, because a plausible-looking pile of zeroes
        // would pass a length check and display as nothing.
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8], "not a JPEG");
        assert_eq!(&jpeg[jpeg.len() - 2..], &[0xFF, 0xD9], "truncated JPEG");
        assert!(jpeg.len() > 4096, "only {} bytes; a blank grab?", jpeg.len());
    }
}
