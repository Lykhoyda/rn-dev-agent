#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const T: u64 = 1_791_540_900_000;

    fn line(seq: u64, at: u64, event: &str, payload: Value) -> String {
        json!({"v": 1, "seq": seq, "event": event, "at": T + at, "payload": payload}).to_string()
    }

    fn stage(seq: u64, at: u64, name: &str, state: &str, extra: Value) -> String {
        let mut p = json!({"name": name, "state": state});
        for (k, v) in extra.as_object().unwrap() {
            p[k] = v.clone();
        }
        line(seq, at, "stage", p)
    }

    fn row(seq: u64, line_no: u64, attempt: u64, outcome: &str, by: &str, act: u64, cap: u64, jev: u64) -> String {
        line(seq, 60_000 + line_no, "row", json!({
            "line": line_no, "attempt": attempt, "kind": "action", "resolvedBy": by, "t": 0, "outcome": outcome,
            "timing": {"captureMs": cap, "nativeMs": 0, "reactMs": 0, "resolveMs": 0, "jevMs": jev,
                       "actMs": act, "postCaptureMs": 0, "otherMs": 0, "total": act + cap + jev}
        }))
    }

    // A Reuse check, mid-walk: the 100-column live frame of the mock.
    fn reuse_check_live() -> Vec<String> {
        vec![
            stage(1, 0, "preflight", "running", json!({})),
            line(2, 10, "run", json!({"runId": "check-20261009T081500Z", "verb": "check", "platform": "ios", "ownerPid": 4242})),
            stage(3, 900, "preflight", "passed", json!({"ms": 900})),
            stage(4, 900, "deps", "running", json!({})),
            line(5, 1000, "cmd", json!({"label": "pnpm-install", "edge": "start"})),
            line(6, 22000, "cmd", json!({"label": "pnpm-install", "edge": "end", "ok": true, "ms": 21000})),
            stage(7, 22300, "deps", "passed", json!({"ms": 21400})),
            stage(8, 22300, "build_decision", "running", json!({})),
            stage(9, 22700, "build_decision", "passed", json!({"code": "reuse", "ms": 400})),
            stage(10, 22700, "prebuild", "skipped", json!({})),
            stage(11, 22700, "native_build", "skipped", json!({})),
            stage(12, 22700, "install_launch_ready", "running", json!({})),
            stage(13, 33900, "install_launch_ready", "passed", json!({"ms": 11200})),
            stage(14, 33900, "verify", "running", json!({})),
            stage(15, 34200, "verify", "passed", json!({"ms": 300})),
            stage(16, 34200, "recording", "skipped", json!({})),
            line(17, 34300, "coreT0", json!({"t0": T + 34300})),
            stage(18, 34300, "attach", "running", json!({})),
            line(19, 37400, "admitted", json!({})),
            stage(20, 37400, "attach", "passed", json!({"ms": 3100})),
            stage(21, 37400, "steps", "running", json!({})),
            row(22, 0, 1, "pass", "startup", 0, 0, 0),
            row(23, 3, 1, "pass", "exact", 1100, 600, 0),
            row(24, 4, 1, "pass", "jev", 2000, 800, 400),
            row(25, 5, 1, "retry", "exact", 0, 1400, 0),
            row(26, 5, 2, "pass", "exact", 900, 700, 0),
            row(27, 7, 1, "fail", "exact\u{1b}[2J", 0, 900, 0),
            line(28, 98000, "cmd", json!({"label": "simctl-io", "edge": "start"})),
        ]
    }

    fn folded(lines: &[String]) -> State {
        let mut state = State::default();
        for l in lines {
            if let Some(input) = parse_event(l) {
                state.fold(input);
            }
        }
        state.now_ms = T + 102_000;
        state
    }

    fn finish(lines: &mut Vec<String>, result: &str, code: Option<&str>) {
        let n = lines.len() as u64;
        lines.push(stage(n + 1, 100_000, "steps", "failed", json!({"code": "PLAN_STEP_FAILED", "ms": 62600})));
        lines.push(stage(n + 2, 100_000, "cleanup", "running", json!({})));
        lines.push(stage(n + 3, 102_000, "cleanup", "passed", json!({"ms": 2000})));
        let mut end = json!({"result": result, "phase": "cleaned", "timingsMs": {"total": 102000},
            "cleanup": {"core": "absent", "metro": "removed", "simulator": "kept", "device_lease": "removed"},
            "expectedExit": 1, "droppedEvents": 0});
        if let Some(code) = code {
            end["failureCode"] = code.into();
            end["failurePhase"] = "walk".into();
        }
        lines.push(line(n + 4, 102_000, "end", end));
    }

    fn ledger() -> crate::core::Ledger {
        let step = |line: u64, attempt: u64, outcome: &str, text: &str, reason: Option<&str>| {
            json!({"block": "plan", "line": line, "attempt": attempt, "kind": "action", "resolvedBy": "exact",
                   "t": 0, "outcome": outcome, "text": text, "reason": reason})
        };
        serde_json::from_value(json!({
            "verdict": "FAIL", "path": "walk", "blocks": [],
            "steps": [
                step(0, 1, "pass", "startup", None),
                step(3, 1, "pass", "Tap \"Tasks\"", None),
                step(4, 1, "pass", "Type ••• into \"Email\"", None),
                step(5, 2, "pass", "Wait for \"Welcome\"", None),
                step(7, 1, "fail", "✓ \"Balance\"\u{1b}]0;pwned\u{7}", Some("TARGET_AMBIGUOUS")),
                step(8, 1, "pass", "never streamed", None),
            ],
            "jev": {"calls": 1, "medianMs": 400}, "llmTurns": 0, "escapes": 0, "recoveries": 0
        }))
        .unwrap()
    }

    #[test]
    fn term_safe_strips_c0_and_c1_controls() {
        assert_eq!(term_safe("a\u{1b}[2Jb\u{7}c\u{9b}d\u{7f}e\tf\ng·✓"), "a[2Jbcdefg·✓");
    }

    #[test]
    fn folds_a_reuse_check_into_the_golden_frame() {
        let state = folded(&reuse_check_live());
        assert_eq!(state.status(), Status::Live);
        let got = frame(&state, 100);
        let golden = [
            "qaren watch  check-20261009T081500Z  check  ios  LIVE  1:42",
            "STAGES",
            "✓ Preflight                        0.9s",
            "✓ Dependencies                    21.4s",
            "✓ Build decision → reuse           0.4s",
            "– Prebuild                         not needed",
            "– Native compile                   not needed",
            "✓ Install·launch·ready            11.2s",
            "✓ Verify                           0.3s",
            "✓ Debugger attach                  3.1s",
            "▶ Steps                            running 1:04",
            "– Recording                        not needed",
            "· Cleanup",
            "STEPS  4 lines  ✓3  ✗1",
            "   line  kind      result                  act  capture      jev",
            "✓     3  action    exact                  1.1s     0.6s        —",
            "✓     4  action    jev                    2.0s     0.8s     0.4s",
            "✓     5  action    exact (attempt 2)      0.9s     0.7s        —",
            "✗     7  action    exact[2J                  —     0.9s        —",
            "Step text appears when the run ends.",
            "now: simctl-io",
        ];
        assert_eq!(got, golden);
        assert!(frame(&state, 20).iter().all(|l| l.chars().count() <= 20));
    }

    #[test]
    fn finished_view_takes_text_only_from_the_ledger() {
        let mut lines = reuse_check_live();
        let live = folded(&lines);
        let rendered = frame(&live, 200).join("\n") + &plain(&live, &mut HashSet::new()).join("\n");
        assert!(!rendered.contains("Tasks") && !rendered.contains("Email"), "{rendered}");
        assert!(serde_json::to_string(&snapshot(&live)).unwrap().find("Tasks").is_none());

        finish(&mut lines, "fail", Some("PLAN_STEP_FAILED"));
        let mut done = folded(&lines);
        assert_eq!(done.status(), Status::Finished);
        done.apply_ledger(&ledger());
        let got = frame(&done, 200);
        assert_eq!(got[0], "qaren watch  check-20261009T081500Z  check  ios  FINISHED  1:42");
        assert!(got.contains(&"✓     4  action    jev                    2.0s     0.8s     0.4s  Type ••• into \"Email\"".to_string()), "{got:#?}");
        assert!(got.contains(&"✗     7  action    exact[2J                  —     0.9s        —  ✓ \"Balance\"\\]0;pwned — TARGET\\_AMBIGUOUS".to_string()), "{got:#?}");
        assert!(got.contains(&"✗ Steps                            PLAN_STEP_FAILED  3/4 passed  1:02".to_string()), "{got:#?}");
        assert_eq!(got.last().unwrap(), "VERDICT FAIL  (expected exit 1)  PLAN_STEP_FAILED  cleanup clean");
        assert!(!got.join("\n").contains("never streamed"));
        assert!(!got.join("\n").contains('\u{1b}') && !got.join("\n").contains('\u{7}'));
    }

    #[test]
    fn plain_prints_each_final_item_once_without_escapes() {
        let mut lines = reuse_check_live();
        let mut printed = HashSet::new();
        let first = plain(&folded(&lines[..8]), &mut printed);
        assert_eq!(
            first,
            [
                "qaren watch  check-20261009T081500Z  check  ios",
                "✓ Preflight                        0.9s",
                "✓ Dependencies                    21.4s",
            ]
        );
        assert!(plain(&folded(&lines[..8]), &mut printed).is_empty());
        let middle = plain(&folded(&lines), &mut printed);
        assert_eq!(middle[0], "✓ Build decision → reuse           0.4s");
        assert!(middle.contains(&"  ✗     7  action    exact[2J                  —     0.9s        —".to_string()), "{middle:#?}");
        assert!(!middle.iter().any(|l| l.contains("Steps") || l.contains("Cleanup")));
        finish(&mut lines, "fail", Some("PLAN_STEP_FAILED"));
        let mut done = folded(&lines);
        done.apply_ledger(&ledger());
        let last = plain(&done, &mut printed);
        assert_eq!(
            last,
            [
                "        line 3: Tap \"Tasks\"",
                "        line 4: Type ••• into \"Email\"",
                "        line 5: Wait for \"Welcome\"",
                "        line 7: ✓ \"Balance\"\\]0;pwned — TARGET\\_AMBIGUOUS",
                "✗ Steps                            PLAN_STEP_FAILED  3/4 passed  1:02",
                "✓ Cleanup                          2.0s",
                "VERDICT FAIL  (expected exit 1)  PLAN_STEP_FAILED  cleanup clean",
            ]
        );
        assert!(plain(&done, &mut printed).is_empty());
        for l in first.iter().chain(&middle).chain(&last) {
            assert!(!l.chars().any(|c| c.is_control()), "{l:?}");
        }
    }

    #[test]
    fn a_finished_run_watched_later_prints_the_text_with_each_row() {
        let mut lines = reuse_check_live();
        finish(&mut lines, "fail", Some("PLAN_STEP_FAILED"));
        let mut done = folded(&lines);
        done.apply_ledger(&ledger());
        let out = plain(&done, &mut HashSet::new());
        assert!(out.contains(&"  ✓     3  action    exact                  1.1s     0.6s        —  Tap \"Tasks\"".to_string()), "{out:#?}");
        assert!(!out.iter().any(|l| l.starts_with("        line")));
    }

    fn temp_runs(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("qaren-watch-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("check-1").join("logs")).unwrap();
        root
    }

    fn args(plain: bool, json: bool) -> WatchArgs {
        WatchArgs {
            target: Target::RunId("check-1".into()),
            plain,
            json,
        }
    }

    fn follow_out(root: &Path, args: WatchArgs, alive: bool) -> (u8, String) {
        let mut out = Vec::new();
        let code = follow(root, &args, &mut out, &mut |_| alive, Duration::ZERO);
        (code, String::from_utf8(out).unwrap())
    }

    #[test]
    fn owner_dead_without_end_reports_incomplete() {
        let root = temp_runs("dead");
        let lines = reuse_check_live();
        std::fs::write(root.join("check-1/logs/events.jsonl"), lines.join("\n") + "\n").unwrap();
        let (code, out) = follow_out(&root, args(true, false), false);
        assert_eq!(code, 0);
        assert!(out.ends_with("ENDED WITHOUT FINAL EVENT (telemetry incomplete)\n"), "{out}");
        assert!(out.contains("✓ Verify"));
        assert!(!out.contains('\u{1b}'));
        let (code, out) = follow_out(&root, args(false, true), false);
        assert_eq!(code, 0);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["state"], "incomplete");
        assert_eq!(v["stages"][2], json!({"name": "build_decision", "state": "passed", "code": "reuse", "ms": 400}));
        assert_eq!(v["steps"][3]["line"], 7);
        assert!(v["steps"][3].get("text").is_none());
    }

    #[test]
    fn a_finished_run_is_printed_once_with_ledger_text() {
        let root = temp_runs("finished");
        let mut lines = reuse_check_live();
        finish(&mut lines, "fail", Some("PLAN_STEP_FAILED"));
        std::fs::write(root.join("check-1/logs/events.jsonl"), lines.join("\n") + "\n").unwrap();
        std::fs::write(root.join("check-1/ledger.json"), serde_json::to_string(&ledger()).unwrap()).unwrap();
        let (code, out) = follow_out(&root, args(true, false), true);
        assert_eq!(code, 0);
        assert!(out.contains("Type ••• into \"Email\""), "{out}");
        assert!(out.ends_with("VERDICT FAIL  (expected exit 1)  PLAN_STEP_FAILED  cleanup clean\n"));
        let (_, json_out) = follow_out(&root, args(false, true), true);
        let v: Value = serde_json::from_str(&json_out).unwrap();
        assert_eq!(v["state"], "finished");
        assert_eq!(v["end"]["result"], "fail");
        assert_eq!(v["steps"][1]["text"], "Type ••• into \"Email\"");
    }

    #[test]
    fn missing_events_is_unavailable_exit_3() {
        let root = temp_runs("missing");
        assert_eq!(follow_out(&root, args(true, false), true).0, 3);
        let none = WatchArgs { target: Target::RunId("check-2".into()), plain: true, json: false };
        assert_eq!(follow_out(&root, none, true).0, 1);
        let bad = WatchArgs { target: Target::RunId("../etc".into()), plain: true, json: false };
        assert_eq!(follow_out(&root, bad, true).0, 2);
        assert_eq!(follow_out(&root.join("absent"), WatchArgs { target: Target::Latest, plain: true, json: false }, true).0, 1);
    }

    #[test]
    fn latest_is_the_newest_run_record() {
        let root = temp_runs("latest");
        std::fs::create_dir_all(root.join("check-2")).unwrap();
        std::fs::write(root.join("check-1/run.json"), "{}").unwrap();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(root.join("check-2/run.json"), "{}").unwrap();
        std::fs::create_dir_all(root.join("check-3")).unwrap();
        assert_eq!(latest(&root).as_deref(), Some("check-2"));
    }

    #[test]
    fn the_tail_keeps_a_partial_line_until_it_completes() {
        let root = temp_runs("tail");
        let path = root.join("check-1/logs/events.jsonl");
        std::fs::write(&path, "one\ntw").unwrap();
        let mut tail = Tail::new(path.clone());
        assert_eq!(tail.lines(), ["one"]);
        assert!(tail.lines().is_empty());
        use std::io::Write as _;
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"o\nthree\n").unwrap();
        assert_eq!(tail.lines(), ["two", "three"]);
    }
}
