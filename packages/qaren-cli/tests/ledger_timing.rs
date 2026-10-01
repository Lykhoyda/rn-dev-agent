use qaren::core::{Ledger, Row};
use qaren::report::{render, ReportInput};
use serde_json::json;

fn ledger(steps: serde_json::Value, speed: serde_json::Value) -> serde_json::Value {
    json!({"verdict":"PASS","path":"walk","blocks":[],"steps":steps,
        "jev":{"calls":0,"medianMs":0,"inputTokens":0,"callDetails":[]},"llmTurns":0,"escapes":0,"recoveries":0,"speed":speed})
}

fn timing() -> serde_json::Value {
    json!({"captureMs":40,"nativeMs":30,"reactMs":8,"presenceMs":26,"resolveMs":20,"jevMs":12,
        "actMs":15,"postCaptureMs":30,"otherMs":15,"total":120})
}

#[test]
fn row_timing_and_ledger_speed_round_trip_through_the_ledger() {
    let raw = ledger(
        json!([{"block":"qa","line":1,"attempt":1,"kind":"step","resolvedBy":"jev","t":120,
            "outcome":"pass","timing":timing()}]),
        json!({"stepMedianMs":120,"stepP95Ms":120,"walkMs":120}),
    );
    let parsed: Ledger = serde_json::from_value(raw.clone()).unwrap();
    assert_eq!(parsed.steps[0].timing.as_ref().unwrap().post_capture_ms, 30);
    assert_eq!(parsed.speed.as_ref().unwrap().step_p95_ms, 120);
    assert_eq!(serde_json::to_value(&parsed).unwrap(), raw);
}

#[test]
fn malformed_timing_is_dropped_without_rejecting_the_row_or_ledger() {
    let row: Row = serde_json::from_value(json!({"block":"qa","line":1,"attempt":1,"kind":"step",
        "resolvedBy":"exact","t":5,"outcome":"pass","timing":{"captureMs":-1}}))
    .unwrap();
    assert!(row.timing.is_none());
    let parsed: Ledger =
        serde_json::from_value(ledger(json!([]), json!({"walkMs":"slow"}))).unwrap();
    assert!(parsed.speed.is_none());
    let untimed: Ledger =
        serde_json::from_value(json!({"verdict":"PASS","path":"walk","blocks":[],
        "steps":[],"jev":{"calls":0,"medianMs":0},"llmTurns":0,"escapes":0,"recoveries":0}))
        .unwrap();
    assert!(untimed.speed.is_none());
    assert!(!serde_json::to_string(&untimed).unwrap().contains("speed"));
}

#[test]
fn report_run_details_print_speed_only_when_present() {
    let input = |ledger: &Ledger| {
        render(&ReportInput {
            run_id: "check-1",
            platform: "ios",
            app_id: "com.example",
            device: "sim",
            plan: "",
            ledger,
        })
    };
    let timed: Ledger = serde_json::from_value(ledger(
        json!([]),
        json!({"stepMedianMs":250,"stepP95Ms":400,"walkMs":1900}),
    ))
    .unwrap();
    assert!(input(&timed).contains("stepMedianMs 250 · stepP95Ms 400 · walkMs 1900\n"));
    let untimed: Ledger = serde_json::from_value(ledger(json!([]), json!(null))).unwrap();
    assert!(!input(&untimed).contains("stepMedianMs"));
}
