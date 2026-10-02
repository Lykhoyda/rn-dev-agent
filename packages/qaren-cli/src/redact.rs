pub fn redact_api_key(raw: &str) -> String {
    redact_known_key(raw, std::env::var("TYPESAFE_API_KEY").ok().as_deref())
}

pub fn redact_known_key(raw: &str, key: Option<&str>) -> String {
    let Some(key) = key.filter(|k| !k.is_empty()) else {
        return raw.to_string();
    };
    let encoded = serde_json::to_string(key).unwrap_or_default();
    raw.replace(&encoded[1..encoded.len() - 1], "[REDACTED_SECRET]")
        .replace(key, "[REDACTED_SECRET]")
}

pub const PRIVATE_KEY_MASK: &str = "<redacted private key>";

// Each stream must close its own block before either stream can resume logging.
#[derive(Default)]
pub struct KeyMasker {
    open: [bool; 2],
    pub orphan_end: bool,
}

fn opens(line: &str) -> bool {
    line.rfind("BEGIN")
        .is_some_and(|begin| line.rfind("-----END").is_none_or(|end| end < begin))
}

impl KeyMasker {
    pub fn open(&mut self, stream: usize) {
        self.open[stream] = true;
    }

    pub fn line(&mut self, stream: usize, line: &str) -> Option<String> {
        let named = line.contains("PRIVATE KEY");
        if self.open.iter().any(|open| *open) {
            if named && line.contains("-----END") {
                self.open[stream] = opens(line);
            } else if named && opens(line) {
                self.open[stream] = true;
            }
            return None;
        }
        if !named {
            return Some(line.to_string());
        }
        // Fail-closed: any END not preceded by its own BEGIN means a body may sit before it.
        if line
            .find("END")
            .is_some_and(|end| line.find("-----BEGIN").is_none_or(|begin| end < begin))
            || line.matches("END").count() > line.matches("-----BEGIN").count()
        {
            self.orphan_end = true;
        }
        self.open[stream] = opens(line);
        let ending = &line[line.trim_end_matches(['\r', '\n']).len()..];
        Some(format!("{PRIVATE_KEY_MASK}{ending}"))
    }
}

pub fn redact_secrets(raw: &str) -> String {
    if !raw.contains("PRIVATE KEY") {
        return redact_plain(raw);
    }
    let mut open = false;
    for line in raw
        .split_inclusive(['\n', '\r'])
        .filter(|line| line.contains("PRIVATE KEY"))
    {
        for index in 0..line.len() {
            let remaining = &line.as_bytes()[index..];
            if remaining.starts_with(b"BEGIN") {
                open = true;
            } else if remaining.starts_with(b"END") {
                if !open {
                    return PRIVATE_KEY_MASK.to_string();
                }
                open = false;
            }
        }
    }
    let mut masker = KeyMasker::default();
    let kept: String = raw
        .split_inclusive(['\n', '\r'])
        .filter_map(|line| masker.line(0, line))
        .collect();
    // A body printed without its header can sit anywhere before an orphan END.
    if masker.orphan_end {
        return PRIVATE_KEY_MASK.to_string();
    }
    redact_plain(&kept)
}

pub fn redact_plain(raw: &str) -> String {
    let safe = redact_api_key(raw);
    let raw = safe.as_str();
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(idx) = rest.find("://") {
        let (head, tail) = rest.split_at(idx + 3);
        out.push_str(head);
        if let Some(at) = tail.find('@') {
            let userinfo = &tail[..at];
            if !userinfo.contains('/') && !userinfo.contains(' ') {
                out.push_str("<redacted>@");
                rest = &tail[at + 1..];
                continue;
            }
        }
        rest = tail;
    }
    out.push_str(rest);
    let token_like = |t: &str| {
        (t.starts_with("npm_") && t.len() > 20)
            || t.starts_with("ghp_")
            || t.starts_with("gho_")
            || t.starts_with("ghs_")
            || t.starts_with("github_pat_")
    };
    let mut redacted = String::with_capacity(out.len());
    let mut redact_next = false;
    for token in out.split_inclusive(char::is_whitespace) {
        let trimmed = token.trim_end();
        let ws = &token[trimmed.len()..];
        // npmrc-style assignments carry the value inline or as the next token.
        let assignment = trimmed.split_once('=').filter(|(key, _)| {
            let key = key.to_ascii_lowercase();
            key.ends_with("authtoken")
                || key.ends_with("_auth")
                || key.ends_with("password")
                || key.ends_with("token")
                || key.ends_with("api_key")
        });
        if redact_next {
            redacted.push_str("<redacted>");
            redacted.push_str(ws);
            redact_next = false;
        } else if let Some((key, value)) = assignment {
            redacted.push_str(key);
            redacted.push('=');
            redacted.push_str(if value.is_empty() { "" } else { "<redacted>" });
            redact_next = value.is_empty();
            redacted.push_str(ws);
        } else if token_like(trimmed) {
            redacted.push_str("<redacted>");
            redacted.push_str(ws);
        } else if matches!(trimmed.to_ascii_lowercase().as_str(), "bearer" | "basic") {
            redacted.push_str(trimmed);
            redacted.push_str(ws);
            redact_next = true;
        } else {
            redacted.push_str(token);
        }
    }
    redacted
}

#[cfg(test)]
mod tests {
    use super::{redact_known_key, redact_secrets, PRIVATE_KEY_MASK};

    #[test]
    fn typesafe_key_is_redacted_without_a_prefix_and_in_json() {
        let key = "opaque-\"key\\value";
        let raw = format!(
            "plain {key} encoded {}",
            serde_json::to_string(key).unwrap()
        );
        let safe = redact_known_key(&raw, Some(key));
        assert!(!safe.contains("opaque"), "{safe}");
        assert_eq!(
            redact_secrets("TYPESAFE_API_KEY=secret"),
            "TYPESAFE_API_KEY=<redacted>"
        );
    }

    #[test]
    fn redacts_url_userinfo_and_npm_tokens() {
        let raw = "fetch https://user:hunter2@registry.example.com/pkg failed npm_abcdefghijklmnopqrstuvwx123456789012 end";
        let clean = redact_secrets(raw);
        assert!(!clean.contains("hunter2"), "{clean}");
        assert!(
            !clean.contains("npm_abcdefghijklmnopqrstuvwx123456789012"),
            "{clean}"
        );
        assert!(clean.contains("registry.example.com"), "{clean}");
    }

    const BODY: [&str; 3] = ["FAKEKEYBODYAAAA1", "FAKEKEYBODYBBBB2", "Zq3="];

    fn no_body(text: &str) {
        for body in BODY {
            assert!(!text.contains(body), "{text}");
        }
    }

    #[test]
    fn a_marker_mention_cannot_blind_a_following_truncated_key() {
        let raw = format!(
            "error: unterminated -----BEGIN marker\n-----BEGIN PRIVATE KEY-----\n{}\n{}\n{}\n",
            BODY[0], BODY[1], BODY[2]
        );
        let clean = redact_secrets(&raw);
        no_body(&clean);
        assert!(
            clean.starts_with("error: unterminated -----BEGIN marker\n"),
            "{clean}"
        );
    }

    #[test]
    fn an_unterminated_begin_masks_to_the_end_of_the_string() {
        let clean = redact_secrets(&format!(
            "start\nfetched -----BEGIN RSA PRIVATE KEY-----\n{}\n{}\nafter\n",
            BODY[0], BODY[1]
        ));
        assert_eq!(clean, format!("start\n{PRIVATE_KEY_MASK}\n"));
    }

    #[test]
    fn an_orphan_end_masks_the_whole_string() {
        for raw in [
            format!(
                "exit=1 {}\n{}\n-----END PRIVATE KEY----- tail",
                BODY[0], BODY[1]
            ),
            format!(
                "{} | {} | -----END OPENSSH PRIVATE KEY-----",
                BODY[0], BODY[1]
            ),
        ] {
            assert_eq!(redact_secrets(&raw), PRIVATE_KEY_MASK);
        }
    }

    #[test]
    fn a_dashless_or_extra_end_still_masks_the_whole_string() {
        for raw in [
            format!("{}\nEND PRIVATE KEY\n", BODY[0]),
            format!(
                "{}\n-----BEGIN PRIVATE KEY----- x -----END PRIVATE KEY----- y -----END PRIVATE KEY-----\n",
                BODY[0]
            ),
        ] {
            assert_eq!(redact_secrets(&raw), PRIVATE_KEY_MASK);
        }
    }

    #[test]
    fn extra_private_key_ends_mask_the_whole_string_in_an_open_block() {
        for separator in ["\n", "\r", "\r\n"] {
            let raw = [
                "PREBODY",
                "-----BEGIN PRIVATE KEY-----",
                "BODY",
                "-----END PRIVATE KEY----- -----END PRIVATE KEY-----",
                "",
            ]
            .join(separator);
            assert_eq!(redact_secrets(&raw), PRIVATE_KEY_MASK);
        }
    }

    #[test]
    fn a_later_begin_cannot_hide_an_orphan_end() {
        for separator in ["\n", "\r", "\r\n", " "] {
            let raw = [
                "PREBODY",
                "-----BEGIN PRIVATE KEY-----",
                "BODY",
                "-----END PRIVATE KEY----- -----END PRIVATE KEY-----",
                "-----BEGIN PRIVATE KEY-----",
                "TAILBODY",
                "",
            ]
            .join(separator);
            assert_eq!(redact_secrets(&raw), PRIVATE_KEY_MASK);
        }
    }

    #[test]
    fn complete_and_one_line_blocks_mask_only_their_lines() {
        let clean = redact_secrets(&format!(
            "-----BEGIN PRIVATE KEY----- {} -----END PRIVATE KEY----- exit=1\nnext line\n",
            BODY[0]
        ));
        assert_eq!(clean, format!("{PRIVATE_KEY_MASK}\nnext line\n"));
        let clean = redact_secrets(&format!(
            "a\r\n-----BEGIN PRIVATE KEY-----\r\n{}\r\n-----END PRIVATE KEY-----\r\nb\n",
            BODY[0]
        ));
        no_body(&clean);
        assert!(
            clean.starts_with("a\r") && clean.ends_with("b\n"),
            "{clean}"
        );
        let escaped = serde_json::to_string(&format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            BODY[0]
        ))
        .unwrap();
        assert_eq!(redact_secrets(&escaped), PRIVATE_KEY_MASK);
    }

    #[test]
    fn a_closing_word_inside_prose_never_ends_a_block() {
        let clean = redact_secrets(&format!(
            "-----BEGIN PRIVATE KEY-----\nSENDING PRIVATE KEY\n{}\n",
            BODY[0]
        ));
        no_body(&clean);
    }

    #[test]
    fn an_end_on_another_stream_never_closes_this_streams_block() {
        let mut masker = super::KeyMasker::default();
        assert_eq!(
            masker.line(0, "-----BEGIN PRIVATE KEY-----\n").as_deref(),
            Some("<redacted private key>\n")
        );
        let mut kept = Vec::new();
        for n in 0..26 {
            kept.extend(masker.line(0, &format!("FAKEKEYBODY{n}\n")));
            if n == 9 {
                kept.extend(masker.line(1, "-----END PRIVATE KEY-----\n"));
            }
        }
        assert!(kept.is_empty(), "{kept:?}");
        assert_eq!(masker.line(1, "stream b keeps going\n"), None);
        assert_eq!(masker.line(0, "-----END PRIVATE KEY-----\n"), None);
        assert_eq!(masker.line(1, "after\n").as_deref(), Some("after\n"));
    }

    #[test]
    fn non_key_text_passes_byte_identical() {
        for plain in [
            "commit 0123456789abcdef0123456789abcdef01234567 built\n",
            "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----\n",
            "BUILD SUCCEEDED\r\n[1/3] Compiling\n",
        ] {
            assert_eq!(redact_secrets(plain), plain);
        }
    }

    #[test]
    fn plain_urls_survive_redaction() {
        let raw = "GET https://registry.npmjs.org/react 200";
        assert_eq!(redact_secrets(raw), raw);
    }
}
