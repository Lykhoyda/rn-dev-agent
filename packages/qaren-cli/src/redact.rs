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

// Contains the phrase itself, so withholding is a fixed point for every later check.
pub const PRIVATE_KEY_WITHHELD: &str = "[output withheld: contained private key material]";

pub fn names_private_key(text: &str) -> bool {
    text.as_bytes()
        .windows(11)
        .any(|w| w.eq_ignore_ascii_case(b"private key"))
}

#[derive(Debug, Clone, Eq, serde::Serialize)]
#[serde(transparent)]
pub struct OutputText(String);

impl OutputText {
    pub fn from_output(raw: &str) -> Self {
        Self(redact_secrets(raw))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> serde::Deserialize<'de> for OutputText {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = <String as serde::Deserialize>::deserialize(deserializer)?;
        Ok(Self::from_output(&raw))
    }
}

impl std::ops::Deref for OutputText {
    type Target = str;

    fn deref(&self) -> &str {
        &self.0
    }
}

impl AsRef<str> for OutputText {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl<T: AsRef<str> + ?Sized> PartialEq<T> for OutputText {
    fn eq(&self, other: &T) -> bool {
        self.0 == other.as_ref()
    }
}

impl std::fmt::Display for OutputText {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub fn redact_secrets(raw: &str) -> String {
    if names_private_key(raw) {
        return PRIVATE_KEY_WITHHELD.to_string();
    }
    redact_plain(raw)
}

// The one serializer for durable JSON: any string or key naming a private key is withheld whole.
pub fn durable_json<T: serde::Serialize>(value: &T) -> serde_json::Result<String> {
    let text = serde_json::to_string_pretty(value)?;
    if !names_private_key(&text) {
        return Ok(text);
    }
    fn withhold(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::String(s) if names_private_key(s) => {
                *s = PRIVATE_KEY_WITHHELD.to_string();
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(withhold),
            serde_json::Value::Object(map) => {
                *map = std::mem::take(map)
                    .into_iter()
                    .map(|(key, mut item)| {
                        withhold(&mut item);
                        let key = if names_private_key(&key) {
                            PRIVATE_KEY_WITHHELD.to_string()
                        } else {
                            key
                        };
                        (key, item)
                    })
                    .collect();
            }
            _ => {}
        }
    }
    let mut value = serde_json::to_value(value)?;
    withhold(&mut value);
    serde_json::to_string_pretty(&value)
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
    use super::{durable_json, redact_known_key, redact_secrets, PRIVATE_KEY_WITHHELD};

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
    fn any_mention_of_a_private_key_withholds_the_whole_string() {
        for raw in [
            "-----BEGIN PRIVATE KEY-----\nFAKEKEYBODY\n-----END PRIVATE KEY-----\n",
            "FAKEKEYBODY\n-----END OPENSSH PRIVATE KEY----- tail",
            "FAKEKEYBODY\n<redacted private key>\n",
            "warning: this Private Key is ignored\nFAKEKEYBODY",
            PRIVATE_KEY_WITHHELD,
        ] {
            assert_eq!(redact_secrets(raw), PRIVATE_KEY_WITHHELD);
        }
    }

    #[test]
    fn durable_json_withholds_nested_strings_and_keys_only_when_named() {
        let plain = serde_json::json!({"b": 1, "a": ["x"]});
        assert_eq!(
            durable_json(&plain).unwrap(),
            serde_json::to_string_pretty(&plain).unwrap()
        );
        let leaky = serde_json::json!({
            "evidence": ["ok", "FAKEKEYBODY -----END private key-----"],
            "nested": {"PRIVATE KEY FAKEKEYBODY": "v", "keep": "plain"},
        });
        let text = durable_json(&leaky).unwrap();
        assert!(!text.contains("FAKEKEYBODY"), "{text}");
        assert!(text.contains("\"plain\""), "{text}");
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
