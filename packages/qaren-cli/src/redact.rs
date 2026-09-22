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

pub fn redact_secrets(raw: &str) -> String {
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
    fn plain_urls_survive_redaction() {
        let raw = "GET https://registry.npmjs.org/react 200";
        assert_eq!(redact_secrets(raw), raw);
    }
}
