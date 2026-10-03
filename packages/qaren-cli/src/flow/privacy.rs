use crate::redact::redact_secrets;

pub const PRIVATE: &str = "<private>";
pub const TEXT_CHARS: usize = 512;
pub const REASON_CHARS: usize = 2_048;
// Shorter forms match only as a whole quoted string so `Save` and `home-tab` stay readable.
const WHOLE_QUOTED_BELOW: usize = 3;

// The one output boundary for every string that leaves the engine: raw text in, masked text out.
pub struct Privacy {
    forms: Vec<Form>,
}

// ASCII-lowercased, control-free; `whole_quoted` follows the value's length before escaping.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct Form {
    text: String,
    whole_quoted: bool,
}

impl Privacy {
    pub fn new(values: impl IntoIterator<Item = String>) -> Privacy {
        let mut forms: Vec<Form> = values
            .into_iter()
            .filter(|value| !value.trim().is_empty())
            .flat_map(|value| {
                let normalised = value.split_whitespace().collect::<Vec<_>>().join(" ");
                [value.trim().to_string(), normalised, value]
            })
            .flat_map(|base| {
                let whole_quoted = base.chars().count() < WHOLE_QUOTED_BELOW;
                let stripped: String = base.chars().filter(|c| !c.is_control()).collect();
                [clean(&base), stripped].map(|text| Form {
                    text: text.to_ascii_lowercase(),
                    whole_quoted,
                })
            })
            .filter(|form| !form.text.trim().is_empty())
            .collect();
        forms.sort();
        forms.dedup();
        Privacy { forms }
    }

    // Quoted fields are the `{:?}` renderings of raw app text, so each one is unescaped, guarded
    // as raw text and re-escaped; the text between them is guarded as it is.
    pub fn sanitize(&self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        let mut cursor = 0;
        while let Some(open) = text[cursor..].find('"').map(|at| cursor + at) {
            let mut at = open + 1;
            let mut escaped = false;
            let close = loop {
                let Some(ch) = text[at..].chars().next() else {
                    break None;
                };
                match ch {
                    _ if escaped => escaped = false,
                    '\\' => escaped = true,
                    '"' => break Some(at),
                    _ => {}
                }
                at += ch.len_utf8();
            };
            let Some(close) = close else {
                break;
            };
            out.push_str(&self.guard(&text[cursor..open], false));
            out.push('"');
            out.push_str(&rendered(
                &self.guard(&unescape(&text[open + 1..close]), true),
            ));
            out.push('"');
            cursor = close + 1;
        }
        out.push_str(&self.guard(&text[cursor..], false));
        out
    }

    // Map private ranges across changed tokens; withhold private content when token counts differ.
    fn guard(&self, raw: &str, whole_field: bool) -> String {
        let raw = clean(raw);
        let redacted = redact_secrets(&raw);
        let before: Vec<&str> = raw
            .split_inclusive(|c: char| c.is_ascii_whitespace())
            .collect();
        let after: Vec<&str> = redacted
            .split_inclusive(|c: char| c.is_ascii_whitespace())
            .collect();
        let private = self.ranges(&raw.to_ascii_lowercase(), whole_field);
        if before.len() != after.len() {
            return if private.is_empty() {
                redacted
            } else {
                PRIVATE.to_string()
            };
        }
        let mut ranges = self.ranges(&redacted.to_ascii_lowercase(), whole_field);
        let mut tokens = Vec::with_capacity(before.len());
        let (mut from, mut to) = (0, 0);
        for (b, a) in before.iter().zip(&after) {
            let ws = usize::from(b.ends_with(|c: char| c.is_ascii_whitespace()));
            tokens.push((from, to, b.len(), a.len() - ws, b != a));
            from += b.len();
            to += a.len();
        }
        for (start, end) in private {
            for &(from, to, len, kept, changed) in &tokens {
                if start >= from + len || end <= from {
                    continue;
                }
                ranges.push(if changed {
                    (to, to + kept)
                } else {
                    (to + start.max(from) - from, to + end.min(from + len) - from)
                });
            }
        }
        masked(&redacted, ranges)
    }

    pub fn bound(text: String, max: usize) -> String {
        if text.chars().count() <= max {
            text
        } else {
            text.chars().take(max).collect()
        }
    }

    pub fn names(&self, name: &str) -> bool {
        let lower = clean(name).to_ascii_lowercase();
        self.forms.iter().any(|form| {
            if form.whole_quoted {
                lower == form.text
            } else {
                lower.contains(form.text.as_str())
            }
        })
    }

    // Every occurrence of every form over ASCII-lowercased text, overlapping ones included; a
    // short form matches only a whole quoted field.
    fn ranges(&self, lower: &str, whole_field: bool) -> Vec<(usize, usize)> {
        let mut ranges = Vec::new();
        for form in &self.forms {
            if form.whole_quoted {
                if whole_field && lower == form.text {
                    ranges.push((0, lower.len()));
                }
                continue;
            }
            let mut from = 0;
            while let Some(at) = lower[from..].find(&form.text).map(|at| from + at) {
                ranges.push((at, at + form.text.len()));
                from = at + lower[at..].chars().next().map_or(1, char::len_utf8);
            }
        }
        ranges
    }
}

fn masked(text: &str, ranges: Vec<(usize, usize)>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    for (start, end) in merge(ranges) {
        out.push_str(&text[cursor..start]);
        out.push_str(PRIVATE);
        cursor = end;
    }
    out.push_str(&text[cursor..]);
    out
}

// Overlapping and adjacent ranges become one so neighbouring values render as one marker.
fn merge(mut ranges: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
    for (start, end) in ranges {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
}

// Control characters never reach a row: whitespace ones keep the token boundary the
// redactor needs, the rest are dropped.
fn clean(text: &str) -> String {
    text.chars()
        .filter_map(|c| match (c.is_control(), c.is_whitespace()) {
            (false, _) => Some(c),
            (true, true) => Some(' '),
            (true, false) => None,
        })
        .collect()
}

// How `{:?}` renders text inside a quoted field.
fn rendered(value: &str) -> String {
    let quoted = format!("{value:?}");
    quoted[1..quoted.len() - 1].to_string()
}

// The inverse of `rendered`; an escape it does not know is kept as written.
fn unescape(inner: &str) -> String {
    let mut out = String::with_capacity(inner.len());
    let mut rest = inner;
    while let Some(at) = rest.find('\\') {
        out.push_str(&rest[..at]);
        let tail = &rest[at + 1..];
        let (ch, used) = match tail.chars().next() {
            Some('n') => ('\n', 1),
            Some('r') => ('\r', 1),
            Some('t') => ('\t', 1),
            Some('0') => ('\0', 1),
            Some(c @ ('\\' | '"' | '\'')) => (c, 1),
            Some('u') => tail[1..]
                .strip_prefix('{')
                .and_then(|hex| {
                    let end = hex.find('}')?;
                    let ch = char::from_u32(u32::from_str_radix(&hex[..end], 16).ok()?)?;
                    Some((ch, end + 3))
                })
                .unwrap_or(('\\', 0)),
            _ => ('\\', 0),
        };
        out.push(ch);
        rest = &tail[used..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn privacy(values: &[&str]) -> Privacy {
        Privacy::new(values.iter().map(|v| v.to_string()))
    }

    #[test]
    fn an_embedded_long_value_is_fully_masked_and_trimmed_and_case_variants_match() {
        let value = "correct-horse-battery-staple-".repeat(3)[..80].to_string();
        let masked =
            privacy(&[&value]).sanitize(&format!("label={:?}", format!("Comment: {value}")));
        assert_eq!(masked, "label=\"Comment: <private>\"");

        let spaced = privacy(&["  hunter2-probe-secret  "]);
        assert_eq!(
            spaced.sanitize("found StaticText[label=\"hunter2-probe-secret\" id=\"t\"]"),
            "found StaticText[label=\"<private>\" id=\"t\"]"
        );
        assert_eq!(
            spaced.sanitize("label=\"HUNTER2-PROBE-SECRET\"; label=\"Hunter2-probe-secret\""),
            "label=\"<private>\"; label=\"<private>\""
        );
        assert_eq!(
            spaced.sanitize("a  hunter2-probe-secret"),
            "a  <private>",
            "the trimmed form matches inside raw text"
        );
    }

    #[test]
    fn overlapping_and_adjacent_values_render_as_one_marker() {
        let masked = privacy(&["abcdef", "defghi"]).sanitize("label=\"abcdefghi\"");
        assert_eq!(masked, "label=\"<private>\"");
        let repeated = privacy(&["abab"]).sanitize("x ababab y");
        assert_eq!(
            repeated, "x <private> y",
            "overlapping occurrences leave no tail"
        );
        assert_eq!(privacy(&["abc", "xyz"]).sanitize("abcxyz"), "<private>");
    }

    #[test]
    fn whitespace_normalised_values_match_the_rendered_label() {
        let masked = privacy(&["first\n  second"])
            .sanitize("label=\"first second\" and \"first\\n  second\"");
        assert_eq!(masked, "label=\"<private>\" and \"<private>\"");
    }

    #[test]
    fn one_character_values_mask_only_whole_quoted_strings() {
        let one = privacy(&["a"]);
        assert_eq!(
            one.sanitize("tapOn text \"Save\" id=\"home-tab\" label=\"a\" label=\"A\""),
            "tapOn text \"Save\" id=\"home-tab\" label=\"<private>\" label=\"<private>\""
        );
        assert!(!one.names("home-tab"));
        assert!(one.names("a") && one.names("A"));
        let longer = privacy(&["qa-password"]);
        assert!(longer.names("after-QA-Password"));
        assert!(
            longer.names("after-qa-\u{1}password"),
            "control characters never hide a name"
        );
        assert!(!longer.names("after"));
        let escaped = privacy(&["\"a"]);
        assert_eq!(
            escaped.sanitize("text \"\\\"a\" and \"\\\"ab\""),
            "text \"<private>\" and \"\\\"ab\"",
            "a two-character value stays whole-quoted after escaping"
        );
    }

    #[test]
    fn bounding_happens_after_masking() {
        let value = "hunter2-probe-secret";
        for (max, lead) in [(REASON_CHARS, 2_040), (TEXT_CHARS, 505)] {
            let text = format!("{}{value}{}", "x".repeat(lead), "y".repeat(40));
            let bounded = Privacy::bound(privacy(&[value]).sanitize(&text), max);
            assert_eq!(bounded.chars().count(), max);
            assert_eq!(
                bounded,
                format!("{}{}", "x".repeat(lead), &PRIVATE[..max - lead])
            );
        }
        assert_eq!(Privacy::bound("short".into(), TEXT_CHARS), "short");
        assert_eq!(Privacy::bound("héllo".into(), 2), "hé");
    }

    #[test]
    fn secrets_are_still_redacted_and_control_characters_never_split_a_value() {
        let token = "ghp_abcdefghijklmnopqrstuvwxyz123456";
        let typed = privacy(&["hunter2"]);
        assert_eq!(
            typed.sanitize(&format!("label=\"Save {token} hunter2\"")),
            "label=\"Save <redacted> <private>\""
        );
        assert_eq!(
            typed.sanitize(&format!("label={token:?} id=\"x\"")),
            "label=\"<redacted>\" id=\"x\"",
            "a token that fills a quoted field is still recognised"
        );
        assert_eq!(typed.sanitize("hun\u{1}ter2 \u{7}ok"), "<private> ok");
        assert_eq!(typed.sanitize("Bearer\nsecret-token"), "Bearer <redacted>");
        assert_eq!(typed.sanitize("plain"), "plain");
    }

    #[test]
    fn masking_and_redaction_never_hide_each_other() {
        assert_eq!(
            privacy(&["Bearer"]).sanitize("Bearer secret-token"),
            "<private> <redacted>",
            "a masked keyword still triggers redaction"
        );
        assert_eq!(
            privacy(&["hunter2 more"]).sanitize("Bearer hunter2 more end"),
            "Bearer <private> <private> end",
            "a redacted token inside a value leaves no residue of the value around it"
        );
        assert_eq!(
            privacy(&["password"]).sanitize("password=hunter2"),
            "<private>",
            "a value inside a redacted token masks the whole token"
        );
        let link = "https://alice:pw@private.example/reset-secret";
        let masked = privacy(&[link]).sanitize(&format!("label={link:?} then {link}"));
        assert_eq!(masked, "label=\"<private>\" then <private>");
        let spaced = "https://alice:\u{a0}pw@private.example/reset-secret";
        assert_eq!(
            privacy(&[spaced]).sanitize(&format!("label={spaced:?} then {spaced} end")),
            "label=\"<private>\" then <private> end",
            "a redaction inside a token that spans a non-ASCII space still maps"
        );
        assert_eq!(
            privacy(&["other"]).sanitize(&format!("see {spaced} end")),
            "see https://<redacted>@private.example/reset-secret end"
        );
        let combined = format!("Bearer secret-token {spaced}");
        assert_eq!(
            privacy(&["Bearer"]).sanitize(&format!("label={combined:?} and {combined}")),
            "label=\"<private> <redacted> https://<redacted>@private.example/reset-secret\" and <private> <redacted> https://<redacted>@private.example/reset-secret",
            "a masked keyword never blinds the redactor beside a moved token boundary"
        );
        let displayed = privacy(&["ab\n\"secret"]);
        assert_eq!(
            displayed.sanitize("label=\"ab\\\"secret\""),
            "label=\"<private>\"",
            "a value shown without its newline is masked in its escaped rendering"
        );
        assert!(displayed.names("ab\"secret") && displayed.names("ab\n\"secret"));
    }

    #[test]
    fn redaction_sees_the_raw_text_behind_a_quoted_field() {
        let none = privacy(&[]);
        for (label, expected) in [
            ("Bearer\nsecret-token", "Bearer <redacted>"),
            ("password=\"secret-token\"", "password=<redacted>"),
            ("ghp_abcdefghijklmnopqrstuvwxyz123456", "<redacted>"),
            ("plain \"quoted\" text", "plain \"quoted\" text"),
        ] {
            let shown = format!("found Button[label={label:?} id=\"x\"]");
            assert_eq!(
                none.sanitize(&shown),
                format!("found Button[label={expected:?} id=\"x\"]"),
                "{shown}"
            );
        }
        assert_eq!(none.sanitize("odd \" quote"), "odd \" quote");
    }

    #[test]
    fn blank_and_empty_values_mask_nothing() {
        let blank = privacy(&["", "   ", " \n "]);
        let text = "label=\"a   b\" and \"   \"";
        assert_eq!(blank.sanitize(text), text);
        assert!(!blank.names("   "));
    }

    #[test]
    fn escaped_renderings_of_a_value_are_masked() {
        let quoted = privacy(&["say \"hi\"\\now"]);
        assert_eq!(
            quoted.sanitize("text \"say \\\"hi\\\"\\\\now\" raw say hi"),
            "text \"<private>\" raw say hi"
        );
        let plain = privacy(&["hunter2"]);
        assert_eq!(
            plain.sanitize("not sent: could not type hunter2 into \"Name hunter2\""),
            "not sent: could not type <private> into \"Name <private>\""
        );
        for inner in ["tab\tnew\nquote\"back\\u\u{1f600}\u{7}", "plain", "\\", ""] {
            let shown = rendered(inner);
            assert_eq!(unescape(&shown), inner, "{shown}");
        }
        assert_eq!(unescape("\\q\\u{zz}\\"), "\\q\\u{zz}\\");
    }
}
