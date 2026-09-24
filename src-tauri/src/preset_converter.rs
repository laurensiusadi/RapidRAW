use regex::Regex;
use regex::regex;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use uuid::Uuid;

use crate::file_management::Preset;

#[derive(Copy, Clone, Debug)]
enum Num {
    I(i64),
    F(f64),
}

fn parse_num(s: &str) -> Option<Num> {
    if let Ok(i) = s.parse::<i64>() {
        Some(Num::I(i))
    } else if let Ok(f) = s.parse::<f64>() {
        Some(Num::F(f))
    } else {
        None
    }
}

fn num_to_json(num: Num) -> Option<Value> {
    match num {
        Num::I(i) => Some(Value::Number(i.into())),
        Num::F(f) => serde_json::Number::from_f64(f).map(Value::Number),
    }
}

fn get_attr_as_f64(attrs: &HashMap<String, String>, key: &str) -> Option<f64> {
    attrs
        .get(key)
        .and_then(|s| s.trim_start_matches('+').parse::<f64>().ok())
}

fn extract_xmp_name(xmp_content: &str) -> Option<String> {
    regex!(r#"(?s)<crs:Name>.*?<rdf:Alt>.*?<rdf:li[^>]*>([^<]+)</rdf:li>.*?</crs:Name>"#)
        .captures(xmp_content)
        .and_then(|c| c.get(1).map(|m| m.as_str().trim().to_string()))
}

fn extract_tone_curve_points(xmp_str: &str, curve_name: &str) -> Option<Vec<Value>> {
    let pattern = format!(
        r"(?s)<crs:{}>\s*<rdf:Seq>(.*?)</rdf:Seq>\s*</crs:{}>",
        curve_name, curve_name
    );
    let re = Regex::new(&pattern).ok()?;
    let captures = re.captures(xmp_str)?;
    let seq_content = captures.get(1)?.as_str();

    let point_re = regex!(r"<rdf:li>(\d+),\s*(\d+)</rdf:li>");
    let mut points = Vec::new();

    for point_cap in point_re.captures_iter(seq_content) {
        let x: u32 = point_cap.get(1)?.as_str().parse().ok()?;
        let y: u32 = point_cap.get(2)?.as_str().parse().ok()?;

        let mut final_y = y;
        if curve_name == "ToneCurvePV2012" {
            const SHADOW_RANGE_END: f64 = 64.0;
            const SHADOW_DAMPEN_START: f64 = 0.8;
            const SHADOW_DAMPEN_END: f64 = 1.0;

            let x_f64 = x as f64;
            let y_f64 = y as f64;

            if y_f64 > x_f64 && x_f64 < SHADOW_RANGE_END {
                let lift_amount = y_f64 - x_f64;
                let progress = x_f64 / SHADOW_RANGE_END;
                let dampening_factor =
                    SHADOW_DAMPEN_START + (SHADOW_DAMPEN_END - SHADOW_DAMPEN_START) * progress;

                let new_y = x_f64 + (lift_amount * dampening_factor);
                final_y = new_y.round().clamp(0.0, 255.0) as u32;
            }
        }

        let mut point = Map::new();
        point.insert("x".to_string(), Value::Number(x.into()));
        point.insert("y".to_string(), Value::Number(final_y.into()));
        points.push(Value::Object(point));
    }

    if points.is_empty() {
        None
    } else {
        Some(points)
    }
}

// ponytail: hand-tuned guess at how far a ±100 parametric slider moves its region, as a
// fraction of the tonal range; Adobe's curve is unpublished, so tune against real Lightroom renders.
const PARAMETRIC_STRENGTH: f64 = 0.10;

/// CPU port of `apply_curve` in shader.wgsl (monotone cubic Hermite over 0..255 points).
fn eval_curve(points: &[(f64, f64)], x: f64) -> f64 {
    let n = points.len();
    if n < 2 {
        return x;
    }
    if x <= points[0].0 {
        return points[0].1;
    }
    if x >= points[n - 1].0 {
        return points[n - 1].1;
    }
    let i = points.windows(2).position(|w| x <= w[1].0).unwrap_or(n - 2);
    let (p1, p2) = (points[i], points[i + 1]);
    let (p0, p3) = (points[i.saturating_sub(1)], points[(i + 2).min(n - 1)]);
    let slope = |a: (f64, f64), b: (f64, f64)| (b.1 - a.1) / (b.0 - a.0).max(0.001);
    let (d_before, d_current, d_after) = (slope(p0, p1), slope(p1, p2), slope(p2, p3));

    let mut m1 = if i == 0 {
        d_current
    } else if d_before * d_current <= 0.0 {
        0.0
    } else {
        (d_before + d_current) / 2.0
    };
    let mut m2 = if i + 2 == n {
        d_current
    } else if d_current * d_after <= 0.0 {
        0.0
    } else {
        (d_current + d_after) / 2.0
    };
    if d_current != 0.0 {
        let (alpha, beta) = (m1 / d_current, m2 / d_current);
        if alpha * alpha + beta * beta > 9.0 {
            let tau = 3.0 / (alpha * alpha + beta * beta).sqrt();
            m1 *= tau;
            m2 *= tau;
        }
    }

    let dx = p2.0 - p1.0;
    if dx <= 0.0 {
        return p1.1;
    }
    let t = (x - p1.0) / dx;
    let (t2, t3) = (t * t, t * t * t);
    let y = (2.0 * t3 - 3.0 * t2 + 1.0) * p1.1
        + (t3 - 2.0 * t2 + t) * m1 * dx
        + (-2.0 * t3 + 3.0 * t2) * p2.1
        + (t3 - t2) * m2 * dx;
    y.clamp(0.0, 255.0)
}

/// Approximates Lightroom's parametric (region) tone curve as control points on 0..255.
/// Each slider shifts its region's midpoint, splits move by the average of their neighbours,
/// and the endpoints stay fixed.
fn parametric_curve_points(attrs: &HashMap<String, String>) -> Option<Vec<(f64, f64)>> {
    let slider = |key: &str| get_attr_as_f64(attrs, key).unwrap_or(0.0) / 100.0 * PARAMETRIC_STRENGTH;
    let d = [
        slider("ParametricShadows"),
        slider("ParametricDarks"),
        slider("ParametricLights"),
        slider("ParametricHighlights"),
    ];
    if d.iter().all(|v| *v == 0.0) {
        return None;
    }
    let split = |key: &str, default: f64| get_attr_as_f64(attrs, key).unwrap_or(default) / 100.0;
    let s = split("ParametricShadowSplit", 25.0);
    let m = split("ParametricMidtoneSplit", 50.0);
    let h = split("ParametricHighlightSplit", 75.0);

    let control = [
        (0.0, 0.0),
        (s / 2.0, d[0]),
        (s, (d[0] + d[1]) / 2.0),
        ((s + m) / 2.0, d[1]),
        (m, (d[1] + d[2]) / 2.0),
        ((m + h) / 2.0, d[2]),
        (h, (d[2] + d[3]) / 2.0),
        ((h + 1.0) / 2.0, d[3]),
        (1.0, 0.0),
    ];
    let mut last_y = 0.0;
    Some(
        control
            .iter()
            .map(|&(x, dy)| {
                last_y = (x + dy).clamp(last_y, 1.0);
                (x * 255.0, last_y * 255.0)
            })
            .collect(),
    )
}

/// Rewrites an old-style `.lrtemplate` (plain Lua table, no embedded `s.xmp`) into the
/// XMP-shaped text `convert_xmp_to_preset` reads, so both formats share one mapping.
pub fn lrtemplate_to_xmp(lua: &str) -> String {
    let mut out = String::new();
    if let Some(c) = regex!(r#"(?m)^\s*title = "([^"]*)""#).captures(lua) {
        out += &format!("<crs:Name><rdf:Alt><rdf:li>{}</rdf:li></rdf:Alt></crs:Name>", c[1].trim());
    }
    for c in regex!(r#"(?m)^\s*([A-Za-z0-9]+) = ("[^"]*"|[-+\d.]+|true|false),"#).captures_iter(lua) {
        out += &format!(r#" crs:{}="{}""#, &c[1], c[2].trim_matches('"'));
    }
    for c in regex!(r"(ToneCurvePV2012\w*) = \{([^}]*)\}").captures_iter(lua) {
        let nums: Vec<&str> = c[2].split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
        out += &format!("<crs:{}><rdf:Seq>", &c[1]);
        for pair in nums.chunks(2) {
            if let [x, y] = pair {
                out += &format!("<rdf:li>{}, {}</rdf:li>", x, y);
            }
        }
        out += &format!("</rdf:Seq></crs:{}>", &c[1]);
    }
    out
}

pub fn convert_xmp_to_preset(xmp_content: &str) -> Result<Preset, String> {
    let xmp_one_line = xmp_content.split('\n').collect::<Vec<_>>().join(" ");

    let attr_re = regex!(r#"crs:([A-Za-z0-9]+)="([^"]*)""#);
    let mut attrs: HashMap<String, String> = HashMap::new();
    for cap in attr_re.captures_iter(&xmp_one_line) {
        attrs.insert(cap[1].to_string(), cap[2].to_string());
    }

    let mut adjustments = Map::new();
    let mut hsl_map = Map::new();
    let mut color_grading_map = Map::new();
    let mut curves_map = Map::new();

    let mappings = vec![
        ("Exposure2012", "exposure"),
        ("Contrast2012", "contrast"),
        ("Highlights2012", "highlights"),
        ("Whites2012", "whites"),
        ("Blacks2012", "blacks"),
        ("Clarity2012", "clarity"),
        ("Dehaze", "dehaze"),
        ("Vibrance", "vibrance"),
        ("Saturation", "saturation"),
        ("Texture", "structure"),
        ("SharpenRadius", "sharpenRadius"),
        ("SharpenDetail", "sharpenDetail"),
        ("SharpenEdgeMasking", "sharpenMasking"),
        ("LuminanceSmoothing", "lumaNoiseReduction"),
        ("ColorNoiseReduction", "colorNoiseReduction"),
        ("ColorNoiseReductionDetail", "colorNoiseDetail"),
        ("ColorNoiseReductionSmoothness", "colorNoiseSmoothness"),
        ("ChromaticAberrationRedCyan", "chromaticAberrationRedCyan"),
        (
            "ChromaticAberrationBlueYellow",
            "chromaticAberrationBlueYellow",
        ),
        ("PostCropVignetteAmount", "vignetteAmount"),
        ("PostCropVignetteMidpoint", "vignetteMidpoint"),
        ("PostCropVignetteFeather", "vignetteFeather"),
        ("PostCropVignetteRoundness", "vignetteRoundness"),
        ("GrainAmount", "grainAmount"),
        ("GrainSize", "grainSize"),
        ("GrainFrequency", "grainRoughness"),
        ("ColorGradeBlending", "blending"),
    ];

    for (xmp_key, rr_key) in mappings {
        if let Some(raw_val) = attrs.get(xmp_key)
            && let Some(num) = parse_num(raw_val.trim_start_matches('+'))
            && let Some(json_val) = num_to_json(num)
        {
            if rr_key == "blending" {
                color_grading_map.insert(rr_key.to_string(), json_val);
            } else {
                adjustments.insert(rr_key.to_string(), json_val);
            }
        }
    }

    if let Some(shadows_val) = get_attr_as_f64(&attrs, "Shadows2012") {
        let adjusted_shadows = (shadows_val * 1.5).min(100.0);
        adjustments.insert("shadows".to_string(), json!(adjusted_shadows));
    }

    if let Some(sharpness_val) = get_attr_as_f64(&attrs, "Sharpness") {
        let scaled_sharpness = (sharpness_val / 150.0) * 100.0;
        adjustments.insert(
            "sharpness".to_string(),
            json!(scaled_sharpness.clamp(0.0, 100.0)),
        );
    }

    if let Some(adjusted_k) = get_attr_as_f64(&attrs, "Temperature") {
        const AS_SHOT_DEFAULT: f64 = 5500.0;
        const MAX_MIRED_SHIFT: f64 = 150.0;
        let as_shot_k = get_attr_as_f64(&attrs, "AsShotTemperature").unwrap_or(AS_SHOT_DEFAULT);
        let mired_adjusted = 1_000_000.0 / adjusted_k;
        let mired_as_shot = 1_000_000.0 / as_shot_k;
        let mired_delta = mired_adjusted - mired_as_shot;
        let temp_value = (-mired_delta / MAX_MIRED_SHIFT) * 100.0;
        adjustments.insert(
            "temperature".to_string(),
            json!(temp_value.clamp(-100.0, 100.0)),
        );
    }

    if let Some(tint_val) = get_attr_as_f64(&attrs, "Tint") {
        let scaled_tint = (tint_val / 150.0) * 100.0;
        adjustments.insert("tint".to_string(), json!(scaled_tint.clamp(-100.0, 100.0)));
    }

    let colors = [
        ("Red", "reds"),
        ("Orange", "oranges"),
        ("Yellow", "yellows"),
        ("Green", "greens"),
        ("Aqua", "aquas"),
        ("Blue", "blues"),
        ("Purple", "purples"),
        ("Magenta", "magentas"),
    ];
    for (src, dst) in colors {
        let mut color_map = Map::new();
        if let Some(raw) = attrs.get(&format!("HueAdjustment{}", src))
            && let Some(num) = parse_num(raw.trim_start_matches('+'))
            && let Some(Value::Number(n)) = num_to_json(num)
            && let Some(val_f64) = n.as_f64()
        {
            let adjusted_hue = val_f64 * 0.75;
            color_map.insert("hue".to_string(), json!(adjusted_hue));
        }
        if let Some(raw) = attrs.get(&format!("SaturationAdjustment{}", src))
            && let Some(num) = parse_num(raw.trim_start_matches('+'))
            && let Some(json_val) = num_to_json(num)
        {
            color_map.insert("saturation".to_string(), json_val);
        }
        if let Some(raw) = attrs.get(&format!("LuminanceAdjustment{}", src))
            && let Some(num) = parse_num(raw.trim_start_matches('+'))
            && let Some(json_val) = num_to_json(num)
        {
            color_map.insert("luminance".to_string(), json_val);
        }
        if !color_map.is_empty() {
            hsl_map.insert(dst.to_string(), Value::Object(color_map));
        }
    }
    if !hsl_map.is_empty() {
        adjustments.insert("hsl".to_string(), Value::Object(hsl_map));
    }

    // Lightroom B&W ignores the color HSL panel and mixes gray from per-color luminance instead.
    if attrs
        .get("ConvertToGrayscale")
        .is_some_and(|v| v.eq_ignore_ascii_case("true"))
    {
        adjustments.insert("saturation".to_string(), json!(-100));
        adjustments.remove("vibrance");
        let gray_mix: Map<String, Value> = colors
            .iter()
            .filter_map(|(src, dst)| {
                let v = get_attr_as_f64(&attrs, &format!("GrayMixer{}", src))?;
                (v != 0.0).then(|| (dst.to_string(), json!({ "luminance": v })))
            })
            .collect();
        if gray_mix.is_empty() {
            adjustments.remove("hsl");
        } else {
            adjustments.insert("hsl".to_string(), Value::Object(gray_mix));
        }
    }

    let mut shadows_map = Map::new();
    let mut midtones_map = Map::new();
    let mut highlights_map = Map::new();
    let mut global_map = Map::new();
    if let Some(raw) = attrs.get("SplitToningShadowHue")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        shadows_map.insert("hue".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("ColorGradeMidtoneHue")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        midtones_map.insert("hue".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("SplitToningHighlightHue")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        highlights_map.insert("hue".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("SplitToningShadowSaturation")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        shadows_map.insert("saturation".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("ColorGradeMidtoneSat")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        midtones_map.insert("saturation".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("SplitToningHighlightSaturation")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        highlights_map.insert("saturation".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("ColorGradeShadowLum")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        shadows_map.insert("luminance".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("ColorGradeMidtoneLum")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        midtones_map.insert("luminance".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("ColorGradeHighlightLum")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        highlights_map.insert("luminance".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("ColorGradeGlobalHue")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        global_map.insert("hue".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("ColorGradeGlobalSat")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        global_map.insert("saturation".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("ColorGradeGlobalLum")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        global_map.insert("luminance".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("SplitToningBalance")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        color_grading_map.insert("balance".to_string(), json_val);
    }
    if !shadows_map.is_empty() {
        color_grading_map.insert("shadows".to_string(), Value::Object(shadows_map));
    }
    if !midtones_map.is_empty() {
        color_grading_map.insert("midtones".to_string(), Value::Object(midtones_map));
    }
    if !highlights_map.is_empty() {
        color_grading_map.insert("highlights".to_string(), Value::Object(highlights_map));
    }
    if !global_map.is_empty() {
        color_grading_map.insert("global".to_string(), Value::Object(global_map));
    }
    if !color_grading_map.is_empty() {
        adjustments.insert("colorGrading".to_string(), Value::Object(color_grading_map));
    }

    let curve_mappings = [
        ("ToneCurvePV2012", "luma"),
        ("ToneCurvePV2012Red", "red"),
        ("ToneCurvePV2012Green", "green"),
        ("ToneCurvePV2012Blue", "blue"),
    ];
    for (xmp_curve, rr_curve) in curve_mappings {
        if let Some(points) = extract_tone_curve_points(xmp_content, xmp_curve) {
            curves_map.insert(rr_curve.to_string(), Value::Array(points));
        }
    }
    if let Some(parametric) = parametric_curve_points(&attrs) {
        let point_curve: Vec<(f64, f64)> = match curves_map.get("luma") {
            Some(Value::Array(points)) => points
                .iter()
                .filter_map(|p| Some((p["x"].as_f64()?, p["y"].as_f64()?)))
                .collect(),
            _ => vec![(0.0, 0.0), (255.0, 255.0)],
        };
        // Lightroom applies the region sliders before the point curve; bake both into 16 samples.
        let composed = (0..16)
            .map(|i| {
                let x = i as f64 * 17.0;
                let y = eval_curve(&point_curve, eval_curve(&parametric, x));
                json!({"x": x as u32, "y": y.round() as u32})
            })
            .collect();
        curves_map.insert("luma".to_string(), Value::Array(composed));
    }
    if !curves_map.is_empty() {
        adjustments.insert("curves".to_string(), Value::Object(curves_map));
    }

    let preset_name =
        extract_xmp_name(xmp_content).unwrap_or_else(|| "Imported Preset".to_string());

    Ok(Preset {
        id: Uuid::new_v4().to_string(),
        name: preset_name,
        adjustments: Value::Object(adjustments),
        include_masks: Some(false),
        include_crop_transform: Some(false),
        preset_type: Some("style".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Trimmed from VSCO Film 01 "S - Kodak Portra 400".
    const PORTRA_400: &str = r#"s = {
	title = "S - Kodak Portra 400 ",
	type = "Develop",
	value = {
		settings = {
			Blacks2012 = 25,
			CameraProfile = "Adobe Standard",
			ConvertToGrayscale = false,
			HueAdjustmentGreen = 20,
			SaturationAdjustmentGreen = -55,
			Shadows2012 = 10,
			ToneCurvePV2012 = {
				0,
				6,
				255,
				255,
			},
			ToneCurvePV2012Red = {
				0,
				0,
				116,
				133,
				255,
				255,
			},
		},
	},
}"#;

    #[test]
    fn lua_lrtemplate_converts() {
        let raw = convert_xmp_to_preset(PORTRA_400).unwrap();
        assert_eq!(raw.adjustments, json!({}), "raw Lua should not parse as XMP");

        let p = convert_xmp_to_preset(&lrtemplate_to_xmp(PORTRA_400)).unwrap();
        let a = &p.adjustments;
        assert_eq!(p.name, "S - Kodak Portra 400");
        assert_eq!(a["blacks"], 25);
        assert_eq!(a["shadows"], 15.0);
        assert_eq!(a["hsl"]["greens"], json!({"hue": 15.0, "saturation": -55}));
        assert_eq!(a["curves"]["luma"], json!([{"x": 0, "y": 5}, {"x": 255, "y": 255}]));
        assert_eq!(a["curves"]["red"][1], json!({"x": 116, "y": 133}));
    }

    #[test]
    fn grayscale_uses_gray_mixer() {
        // Trimmed from VSCO Film 01 "S - Kodak TRI-X 400".
        let lua = "s = {\n\ttitle = \"TRI-X\",\n\tConvertToGrayscale = true,\n\tGrayMixerAqua = 25,\n\
                   \tGrayMixerOrange = 0,\n\tGrayMixerRed = -10,\n\tHueAdjustmentRed = 8,\n\tVibrance = 10,\n}";
        let a = convert_xmp_to_preset(&lrtemplate_to_xmp(lua)).unwrap().adjustments;
        assert_eq!(a["saturation"], -100);
        assert!(a.get("vibrance").is_none());
        assert_eq!(
            a["hsl"],
            json!({"aquas": {"luminance": 25.0}, "reds": {"luminance": -10.0}})
        );
    }

    #[test]
    fn parametric_sliders_bake_into_luma_curve() {
        // Portra 400: region sliders plus a point curve lifting black to 6.
        let xmp = r#"crs:ParametricShadows="0" crs:ParametricDarks="-35" crs:ParametricLights="+20"
            crs:ParametricHighlights="-20" crs:ParametricShadowSplit="15" crs:ParametricMidtoneSplit="35"
            crs:ParametricHighlightSplit="75"
            <crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 6</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012>"#;
        let p = convert_xmp_to_preset(xmp).unwrap();
        let ys: Vec<f64> = p.adjustments["curves"]["luma"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pt| pt["y"].as_f64().unwrap())
            .collect();
        let point_only = |x: f64| 5.0 + x * 250.0 / 255.0;

        assert_eq!(ys.len(), 16);
        assert_eq!((ys[0], ys[15]), (5.0, 255.0));
        assert!(ys.windows(2).all(|w| w[0] <= w[1]), "curve must stay monotone: {:?}", ys);
        assert!(ys[4] < point_only(68.0) - 5.0, "Darks -35 should pull x=68 down: {:?}", ys);
        assert!(ys[8] > point_only(136.0) + 3.0, "Lights +20 should lift x=136: {:?}", ys);
        assert_eq!(eval_curve(&[(0.0, 0.0), (255.0, 255.0)], 100.0), 100.0);
    }
}
