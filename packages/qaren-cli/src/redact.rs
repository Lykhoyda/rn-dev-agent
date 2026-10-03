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
    // Quotes and brackets around a token are kept but never hide it.
    let wrap = |c: char| {
        matches!(
            c,
            '"' | '\'' | '`' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';'
        )
    };
    for token in out.split_inclusive(char::is_whitespace) {
        let trimmed = token.trim_end();
        let ws = &token[trimmed.len()..];
        let core = trimmed.trim_start_matches(wrap);
        let pre = &trimmed[..trimmed.len() - core.len()];
        // Unopened trailing quotes stay part of the value, as in `password="x"`.
        let core = if pre.is_empty() {
            core
        } else {
            core.trim_end_matches(wrap)
        };
        let suf = &trimmed[pre.len() + core.len()..];
        // npmrc-style assignments carry the value inline or as the next token.
        let assignment = core.split_once('=').filter(|(key, _)| {
            let key = key.to_ascii_lowercase();
            key.ends_with("authtoken")
                || key.ends_with("_auth")
                || key.ends_with("password")
                || key.ends_with("token")
                || key.ends_with("api_key")
        });
        if redact_next && !core.is_empty() {
            redacted.push_str(pre);
            redacted.push_str("<redacted>");
            redacted.push_str(suf);
            redacted.push_str(ws);
            redact_next = false;
        } else if let Some((key, value)) = assignment {
            redacted.push_str(pre);
            redacted.push_str(key);
            redacted.push('=');
            redacted.push_str(if value.is_empty() { "" } else { "<redacted>" });
            redacted.push_str(suf);
            redact_next = value.is_empty();
            redacted.push_str(ws);
        } else if token_like(core) {
            redacted.push_str(pre);
            redacted.push_str("<redacted>");
            redacted.push_str(suf);
            redacted.push_str(ws);
        } else if matches!(core.to_ascii_lowercase().as_str(), "bearer" | "basic") {
            redacted.push_str(trimmed);
            redacted.push_str(ws);
            redact_next = true;
        } else {
            redacted.push_str(token);
        }
    }
    redacted
}

// Public text leaves the machine: hostname, home, absolute paths, UUIDs and LAN addresses go.
#[derive(Debug, Clone, Default)]
pub struct MachineIdentity {
    pub hostname: Option<String>,
    pub home: Option<String>,
    pub username: Option<String>,
    // The run's own device ids, serials and ports, recorded by `qaren pr`.
    pub values: Vec<String>,
}

impl MachineIdentity {
    pub fn current() -> Self {
        MachineIdentity {
            hostname: hostname(),
            home: std::env::var("HOME").ok().filter(|h| h.len() > 1),
            username: username(),
            values: Vec::new(),
        }
    }

    pub fn with_values(&self, values: &[String]) -> Self {
        let mut machine = self.clone();
        machine.values.extend(values.iter().cloned());
        machine
    }
}

fn username() -> Option<String> {
    // SAFETY: getpwuid returns a pointer into static storage or null; the name is copied at once.
    unsafe {
        let entry = libc::getpwuid(libc::getuid());
        if entry.is_null() || (*entry).pw_name.is_null() {
            return None;
        }
        std::ffi::CStr::from_ptr((*entry).pw_name)
            .to_str()
            .ok()
            .filter(|name| !name.is_empty())
            .map(str::to_string)
    }
}

fn hostname() -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is valid for its length; gethostname NUL-terminates within it.
    if unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } != 0 {
        return None;
    }
    let end = buf.iter().position(|b| *b == 0)?;
    String::from_utf8(buf[..end].to_vec())
        .ok()
        .filter(|h| !h.is_empty())
}

pub fn redact_machine(raw: &str, machine: &MachineIdentity) -> String {
    let mut text = redact_secrets(raw);
    if let Some(home) = &machine.home {
        text = text.replace(home.trim_end_matches('/'), "~");
    }
    text = redact_absolute_paths(&text);
    // Known values are replaced as whole words only; shorter than 3 characters is not masked.
    for value in &machine.values {
        if value.len() >= 3 {
            let label = if value.bytes().all(|b| b.is_ascii_digit()) {
                "<port>"
            } else {
                "<device>"
            };
            text = replace_ignore_ascii_case(&text, value, label);
        }
    }
    if let Some(user) = machine.username.as_ref().filter(|u| u.len() >= 3) {
        text = replace_ignore_ascii_case(&text, user, "<user>");
    }
    if let Some(host) = &machine.hostname {
        let short = host.split('.').next().unwrap_or(host);
        for name in [host.as_str(), short] {
            if name.len() >= 3 {
                text = replace_ignore_ascii_case(&text, name, "<host>");
            }
        }
    }
    redact_lan_ipv4(&redact_uuids(&text))
}

// Whole-name matches only, so a short hostname cannot eat part of an ordinary word.
fn replace_ignore_ascii_case(text: &str, needle: &str, with: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let needle = needle.to_ascii_lowercase();
    let word = |b: Option<&u8>| b.is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'-');
    let bytes = lower.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut at, mut from) = (0, 0);
    while let Some(i) = lower[from..].find(&needle) {
        let start = from + i;
        let end = start + needle.len();
        from = start + lower[start..].chars().next().unwrap().len_utf8();
        if word(start.checked_sub(1).and_then(|p| bytes.get(p))) || word(bytes.get(end)) {
            continue;
        }
        out.push_str(&text[at..start]);
        out.push_str(with);
        at = end;
        from = end;
    }
    out.push_str(&text[at..]);
    out
}

fn is_path_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '~' | '/' | '@' | '+')
}

// A path starts at a '/' that opens a token and spans at least two segments.
fn redact_absolute_paths(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let opens = i == 0
            || matches!(
                chars[i - 1],
                ' ' | '\t' | '\n' | '(' | '"' | '\'' | '`' | '[' | '=' | ','
            );
        if chars[i] == '/'
            && opens
            && chars
                .get(i + 1)
                .is_some_and(|c| is_path_char(*c) && *c != '/')
        {
            let mut j = i + 1;
            while j < chars.len() && is_path_char(chars[j]) {
                j += 1;
            }
            if chars[i + 1..j].contains(&'/') {
                out.push_str("<path>");
                i = j;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn redact_uuids(text: &str) -> String {
    const GROUPS: [usize; 5] = [8, 4, 4, 4, 12];
    let bytes = text.as_bytes();
    let is_uuid_at = |start: usize| {
        let mut at = start;
        for (n, len) in GROUPS.iter().enumerate() {
            if at + len > bytes.len() || !bytes[at..at + len].iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            at += len;
            if n < 4 {
                if bytes.get(at) != Some(&b'-') {
                    return None;
                }
                at += 1;
            }
        }
        let bounded = |b: Option<&u8>| !b.is_some_and(|b| b.is_ascii_alphanumeric());
        (bounded(start.checked_sub(1).and_then(|p| bytes.get(p))) && bounded(bytes.get(at)))
            .then_some(at)
    };
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if let Some(end) = is_uuid_at(i) {
            out.push_str("<id>");
            i = end;
        } else {
            let c = text[i..].chars().next().unwrap_or_default();
            out.push(c);
            i += c.len_utf8().max(1);
        }
    }
    out
}

fn is_lan(octets: [u8; 4]) -> bool {
    matches!(octets, [10, ..] | [192, 168, ..] | [169, 254, ..])
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
}

fn redact_lan_ipv4(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        let starts = bytes[i].is_ascii_digit()
            && !(i > 0 && (bytes[i - 1].is_ascii_digit() || bytes[i - 1] == b'.'));
        if starts {
            let end = i + bytes[i..]
                .iter()
                .take_while(|b| b.is_ascii_digit() || **b == b'.')
                .count();
            let candidate = text[i..end].trim_end_matches('.');
            let octets: Vec<Option<u8>> = candidate.split('.').map(|p| p.parse().ok()).collect();
            if octets.len() == 4 && octets.iter().all(Option::is_some) {
                let o: Vec<u8> = octets.into_iter().flatten().collect();
                if is_lan([o[0], o[1], o[2], o[3]]) {
                    out.push_str("<lan>");
                    i += candidate.len();
                    continue;
                }
            }
            out.push_str(&text[i..end]);
            i = end;
            continue;
        }
        let c = text[i..].chars().next().unwrap_or_default();
        out.push(c);
        i += c.len_utf8().max(1);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        redact_known_key, redact_machine, redact_secrets, MachineIdentity, PRIVATE_KEY_MASK,
    };

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
    fn quoted_tokens_are_redacted_and_keep_their_quotes() {
        let raw = r#"type: "ghp_abcdefghijklmnopqrstuvwxyz0123" ('token=hunter2') [github_pat_x1]"#;
        assert_eq!(
            redact_secrets(raw),
            r#"type: "<redacted>" ('token=<redacted>') [<redacted>]"#
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

    #[test]
    fn rejected_multibyte_names_preserve_boundaries_and_later_matches() {
        let machine = MachineIdentity {
            values: vec!["Антон".into(), "设备".into()],
            username: Some("用户".into()),
            hostname: Some("主机.local".into()),
            ..Default::default()
        };
        assert_eq!(
            redact_machine(
                "Антон-ios Антон; 设备-ios 设备; 用户-ios 用户; 主机.local-ios 主机.local 主机-ios 主机",
                &machine,
            ),
            "Антон-ios <device>; 设备-ios <device>; 用户-ios <user>; <host>.local-ios <host> 主机-ios <host>"
        );
    }

    #[test]
    fn identity_matching_keeps_ascii_case_and_word_boundaries() {
        let machine = MachineIdentity {
            values: vec!["Device".into()],
            username: Some("Alice".into()),
            hostname: Some("Mac.local".into()),
            ..Default::default()
        };
        assert_eq!(
            redact_machine(
                "Device-ios DEVICE xDevice Alice-ios ALICE Mac-ios MAC.local macOS MAC",
                &machine
            ),
            "Device-ios <device> xDevice Alice-ios <user> Mac-ios <host> macOS <host>"
        );
    }

    #[test]
    fn machine_identity_is_removed_from_public_text() {
        let machine = MachineIdentity {
            hostname: Some("Work-MacBook-Pro.local".into()),
            home: Some("/Users/alice".into()),
            ..Default::default()
        };
        let raw = "on work-macbook-pro at /Users/alice/app/plan.md and /private/var/x.log, sim 1DC408C4-51DA-4C4F-ACA1-39881C916FDD via 192.168.1.20:8081, 10.0.0.7, 172.20.1.1 and 169.254.3.4; keep 8.8.8.8, 172.32.0.1, https://github.com/o/r/pull/12, ./media/video.mp4 and 1.2.3.4.5";
        let clean = redact_machine(raw, &machine);
        for leak in [
            "macbook", "alice", "/Users", "/private", "1DC408C4", "192.168", "10.0.0.7", "172.20",
            "169.254",
        ] {
            assert!(
                !clean
                    .to_ascii_lowercase()
                    .contains(&leak.to_ascii_lowercase()),
                "{leak}: {clean}"
            );
        }
        for kept in [
            "8.8.8.8",
            "172.32.0.1",
            "https://github.com/o/r/pull/12",
            "./media/video.mp4",
        ] {
            assert!(clean.contains(kept), "{kept}: {clean}");
        }
        assert_eq!(redact_machine(&clean, &machine), clean);
        let short = MachineIdentity {
            hostname: Some("mac.local".into()),
            home: None,
            ..Default::default()
        };
        assert_eq!(
            redact_machine("macOS on mac, MAC.local", &short),
            "macOS on <host>, <host>"
        );
    }
}
