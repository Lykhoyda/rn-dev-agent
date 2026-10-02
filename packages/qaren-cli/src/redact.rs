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

const PRIVATE_KEY_MASK: &str = "<redacted private key>";

// The `-----BEGIN|END ...PRIVATE KEY-----` header nearest the start: (start, end).
fn private_key_header(raw: &str, kind: &str) -> Option<(usize, usize)> {
    let marker = format!("-----{kind} ");
    let mut from = 0;
    while let Some(found) = raw[from..].find(&marker) {
        let label = from + found + marker.len();
        let close = raw[label..].find("-----")?;
        let end = label + close + 5;
        if raw[label..label + close].contains("PRIVATE KEY") {
            return Some((from + found, end));
        }
        from = end;
    }
    None
}

// `in_key` carries an open PEM block across log lines; an END before any BEGIN means
// the start was cut off, so everything before it is key material.
fn mask_private_keys(raw: &str, in_key: &mut bool) -> String {
    if let Some((end, _)) = private_key_header(raw, "END") {
        if private_key_header(raw, "BEGIN").is_none_or(|(begin, _)| end < begin) {
            *in_key = true;
        }
    }
    let mask = |span: &str, out: &mut String| {
        let body = span.trim_end_matches(['\r', '\n']);
        if !body.trim().is_empty() {
            out.push_str(PRIVATE_KEY_MASK);
        }
        out.push_str(&span[body.len()..]);
    };
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    loop {
        if *in_key {
            let Some((end, _)) = private_key_header(rest, "END") else {
                mask(rest, &mut out);
                return out;
            };
            mask(&rest[..end], &mut out);
            rest = &rest[end..];
            *in_key = false;
        }
        let Some((_, header_end)) = private_key_header(rest, "BEGIN") else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..header_end]);
        rest = &rest[header_end..];
        *in_key = true;
    }
}

pub fn redact_secrets(raw: &str) -> String {
    redact_stream_line(raw, &mut false)
}

pub fn redact_stream_line(raw: &str, in_private_key: &mut bool) -> String {
    let safe = redact_api_key(&mask_private_keys(raw, in_private_key));
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
    use super::{redact_known_key, redact_secrets};

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

    #[test]
    fn private_key_bodies_are_masked_in_every_representation() {
        let body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
        let short = "Zq3=";
        for raw in [
            format!("exit=255 -----BEGIN PRIVATE KEY-----\n{body}\n{short}\n"),
            format!("exit=255 -----BEGIN PRIVATE KEY----- | {body} | {short}"),
            format!("{body} | {short} | -----END OPENSSH PRIVATE KEY----- tail"),
            serde_json::to_string(&format!(
                "-----BEGIN RSA PRIVATE KEY-----\n{body}\n{short}\n-----END RSA PRIVATE KEY-----\n"
            ))
            .unwrap(),
        ] {
            let clean = redact_secrets(&raw);
            assert!(!clean.contains(body) && !clean.contains(short), "{clean}");
            assert!(clean.contains("<redacted private key>"), "{clean}");
        }
        assert!(redact_secrets(&format!(
            "x -----BEGIN PRIVATE KEY-----\n{body}\n-----END PRIVATE KEY----- exit=1"
        ))
        .ends_with("-----END PRIVATE KEY----- exit=1"));
        let plain =
            "commit 0123456789abcdef0123456789abcdef01234567 -----BEGIN CERTIFICATE----- MIIB";
        assert_eq!(redact_secrets(plain), plain);
    }

    #[test]
    fn an_open_private_key_block_masks_following_stream_lines() {
        let mut open = false;
        let lines = [
            "fetched -----BEGIN PRIVATE KEY-----\n",
            "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj\n",
            "Zq3=\n",
            "-----END PRIVATE KEY-----\n",
            "after\n",
        ];
        let out: Vec<_> = lines
            .iter()
            .map(|line| super::redact_stream_line(line, &mut open))
            .collect();
        assert_eq!(
            out,
            [
                "fetched -----BEGIN PRIVATE KEY-----\n",
                "<redacted private key>\n",
                "<redacted private key>\n",
                "-----END PRIVATE KEY-----\n",
                "after\n",
            ]
        );
        assert!(!open);
    }

    #[test]
    fn plain_urls_survive_redaction() {
        let raw = "GET https://registry.npmjs.org/react 200";
        assert_eq!(redact_secrets(raw), raw);
    }
}
