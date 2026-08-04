/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Rect
import android.os.SystemClock
import android.util.Base64
import android.view.KeyEvent
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.uiautomator.By
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import org.json.JSONArray
import org.json.JSONObject
import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlPullParserException
import org.xmlpull.v1.XmlPullParserFactory
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.regex.Pattern
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

// GH #581: "none" requires read-back proof the field is unchanged; any
// clear/keyevent pass promotes to "observed"; unprovable states are "possible".
enum class MutationDisposition(val wire: String) {
    NONE("none"),
    OBSERVED("observed"),
    POSSIBLE("possible"),
}

open class TypedRunnerException(
    val code: String,
    message: String,
    val mutation: MutationDisposition,
) : IllegalStateException(message)

class NoTextInputTargetException(message: String) :
    TypedRunnerException("NO_TEXT_INPUT_TARGET", message, MutationDisposition.NONE)

class TextTargetFocusFailedException(message: String) :
    TypedRunnerException("TEXT_TARGET_FOCUS_FAILED", message, MutationDisposition.NONE)

class FocusTargetOccludedException(message: String) :
    TypedRunnerException("FOCUS_TARGET_OCCLUDED", message, MutationDisposition.NONE)

// Story 10 (#391): distinct from "no target" so the bridge descends to its
// clear-first Maestro tier instead of re-tapping a healthy focus.
class SetTextRejectedException(message: String, mutation: MutationDisposition) :
    TypedRunnerException("SET_TEXT_REJECTED", message, mutation)

class SnapshotParseException(message: String) : IllegalStateException(message)
class AccessibilityUnavailableException(message: String) : IllegalStateException(message)

class CommandDispatcher(
    private val instrumentation: Instrumentation,
    private val journal: CommandJournal = CommandJournal(),
) {
    private val device: UiDevice = UiDevice.getInstance(instrumentation)

    companion object {
        // GH #418: advertised in /health.commands. The Node sync test
        // (cdp-bridge test/unit/gh-418-command-surface-sync.test.js) enforces
        // that this list exactly matches the dispatch when-branches below.
        val SUPPORTED_COMMANDS = listOf(
            "snapshot", "tap", "press", "type", "fill", "verifyInput", "drag", "swipe",
            "scroll", "screenshot", "back", "dismissKeyboard", "keyboard", "longPress",
            "pinch", "findText", "isWindowUpdating", "status",
        )

        // GH #378: cold-start-only relaunch wait. The windows-based fast-path below
        // means this is reached only on a confirmed cold state (no app window, hence
        // no IME to stall By.pkg), so it no longer needs shortening to dodge the IME
        // stall. Kept at the original 10s: a genuinely cold RN/debug app can take
        // several seconds to expose its first By.pkg node, and slow verbs
        // (snapshot/type) get 35s client-side — a tighter cap would regress
        // cold-launch success without helping the stall the windows check already ends.
        const val FOREGROUND_READY_TIMEOUT_MS = 10_000L

        // GH #581: actual Android input class spellings — fully qualified only
        // (RN TextInput reports android.widget.EditText; bare names never match).
        val INPUT_CLASS_PATTERN: Pattern =
            Pattern.compile(".+\\.(\\w*EditText|\\w*AutoCompleteTextView)$")
    }

    init {
        val ua = instrumentation.uiAutomation
        val info = ua.serviceInfo
        if (info != null) {
            info.flags = info.flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
            ua.serviceInfo = info
        }
    }

    fun dispatch(cmd: JSONObject): JSONObject {
        val command = cmd.getString("command")
        val appPackage = cmd.optString("appBundleId").ifBlank { null }

        if (appPackage != null && command in setOf(
                "snapshot", "findText", "tap", "press", "type", "fill",
                "longPress", "drag", "swipe", "scroll", "pinch",
            )
        ) {
            foreground(appPackage)
        }

        // GH #581: the recorded type target is only valid until the screen can
        // change under it — any verb other than the type/verify pair drops it.
        if (command !in setOf("type", "fill", "verifyInput", "status", "isWindowUpdating", "screenshot")) {
            recordedTypeTarget = null
        }

        val data = when (command) {
            "snapshot" -> snapshot(appPackage)
            "tap", "press" -> tap(cmd)
            "type", "fill" -> type(cmd)
            "verifyInput" -> verifyInput(cmd)
            "drag", "swipe", "scroll" -> drag(cmd)
            "screenshot" -> screenshot()
            "back" -> JSONObject().put("pressed", device.pressBack())
            "dismissKeyboard", "keyboard" -> JSONObject().put("dismissed", device.pressBack())
            // Settle probe (#385): read-only window-gate, deliberately absent from
            // the foregrounding whitelist above — it must never steal foreground,
            // and it IS the settle primitive so it adds no sleep of its own.
            "isWindowUpdating" -> {
                val timeoutMs = cmd.optLong("timeoutMs", 500L).coerceIn(0L, 2_000L)
                JSONObject().put("updating", device.waitForWindowUpdate(appPackage, timeoutMs))
            }
            "longPress" -> longPress(cmd)
            "pinch" -> pinch(cmd)
            // GH #444: optString defaults missing text to "" and By.textContains("")
            // matches an arbitrary node — refuse malformed requests instead.
            "findText" -> {
                if (cmd.optString("text").isBlank()) {
                    return error("INVALID_ARGUMENT", "findText requires a non-blank 'text' argument")
                }
                findText(cmd)
            }
            // Story 14 (#407): read-only outcome probe — answers from the journal,
            // never touches the device.
            "status" -> {
                val id = cmd.optString("commandId")
                if (id.isBlank()) return error("INVALID_ARGUMENT", "status requires a non-blank 'commandId'")
                val entry = journal.lookup(id)
                JSONObject()
                    .put("commandId", id)
                    .put("state", entry?.state ?: "unknown")
                    .apply { entry?.body?.let { put("result", JSONObject(it)) } }
            }
            // Note: TS-side `device_find` is a snapshot-based orchestrator (mirrors iOS).
            // The runner exposes `findText` only as an opt-in fast-path for existence checks.
            else -> return error("UNSUPPORTED_COMMAND", "Unsupported Android runner command: $command")
        }

        return JSONObject().put("ok", true).put("data", data)
    }

    private fun foreground(appPackage: String) {
        // GH #378: `currentPackageName` reports the IME/launcher package during
        // keyboard transitions, so the old equality-only fast-path missed and fired
        // a relaunch intent + a ~10s `By.pkg` wait that itself stalled behind the IME
        // window — breaching the client's 10s HTTP budget with the work already done.
        // An application window of the package existing is the robust "already
        // foreground" signal (not fooled by an IME/system window on top); only a
        // confirmed cold state warrants the relaunch.
        if (isPackageForeground(appPackage) || device.currentPackageName == appPackage) return
        val context = instrumentation.targetContext
        val intent = context.packageManager.getLaunchIntentForPackage(appPackage)
            ?: throw IllegalStateException("No launch intent for package $appPackage")
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        val ready = device.wait(Until.hasObject(By.pkg(appPackage)), FOREGROUND_READY_TIMEOUT_MS)
        if (!ready) {
            throw IllegalStateException("Package $appPackage did not foreground within ${FOREGROUND_READY_TIMEOUT_MS}ms")
        }
    }

    // GH #378: windows-based foreground probe. FLAG_RETRIEVE_INTERACTIVE_WINDOWS
    // (set in init) makes the app's own application window visible in the list even
    // while an IME window sits on top; the pure decision lives in ForegroundGate.
    private fun isPackageForeground(appPackage: String): Boolean {
        val windows = instrumentation.uiAutomation.windows.map {
            ForegroundGate.WindowSignature(it.type, it.root?.packageName?.toString())
        }
        return ForegroundGate.hasForegroundWindow(
            windows,
            appPackage,
            AccessibilityWindowInfo.TYPE_APPLICATION,
        )
    }

    private fun snapshot(appPackage: String?): JSONObject {
        if (appPackage != null) {
            val accessible = device.wait(Until.hasObject(By.pkg(appPackage)), 10_000)
            if (!accessible) {
                throw AccessibilityUnavailableException(
                    "App $appPackage is foreground but absent from UIAutomator accessibility after 10000ms; restart the rn-android-runner session or fix the app's accessibility exposure"
                )
            }
        }

        val bytes = ByteArrayOutputStream()
        device.dumpWindowHierarchy(bytes)
        val xml = bytes.toString("UTF-8")
        val nodes = JSONArray()
        val parser = XmlPullParserFactory.newInstance().newPullParser()
        parser.setInput(xml.reader())

        try {
            var index = 0
            while (parser.eventType != XmlPullParser.END_DOCUMENT) {
                if (parser.eventType == XmlPullParser.START_TAG && parser.name == "node") {
                    val bounds = parseBounds(parser.getAttributeValue(null, "bounds"))
                    if (bounds != null) {
                        val resourceId = parser.getAttributeValue(null, "resource-id").orEmpty()
                        val text = parser.getAttributeValue(null, "text").orEmpty()
                        val desc = parser.getAttributeValue(null, "content-desc").orEmpty()
                        val className = parser.getAttributeValue(null, "class").orEmpty()
                        val visible = parser.getAttributeValue(null, "visible-to-user") != "false"
                        val enabled = parser.getAttributeValue(null, "enabled") != "false"
                        val secure = parser.getAttributeValue(null, "password") == "true"
                        val identifier = normalizeIdentifier(resourceId).ifBlank { desc }

                        val node = JSONObject()
                            .put("index", index)
                            .put("type", className)
                            .put("label", text.ifBlank { desc })
                            .put("identifier", identifier)
                            .put("rect", JSONObject().put("x", bounds.left).put("y", bounds.top).put("width", bounds.width()).put("height", bounds.height()))
                            .put("hittable", HittableSemantics.fromSnapshotNode(enabled, visible))
                            .put("enabled", enabled)
                        if (secure) node.put("secure", true)
                        nodes.put(node)
                        index += 1
                    }
                }
                parser.next()
            }
        } catch (e: XmlPullParserException) {
            val head = xml.take(512)
            throw SnapshotParseException(
                "UIAutomator window-hierarchy XML failed to parse: ${e.message ?: e.javaClass.simpleName}. Head: $head"
            )
        }

        return JSONObject().put("nodes", nodes)
    }

    private fun tap(cmd: JSONObject): JSONObject {
        val x = cmd.getDouble("x").roundToInt()
        val y = cmd.getDouble("y").roundToInt()
        val kbStart = SystemClock.uptimeMillis()
        val kb = applyKeyboardGuard(cmd, x, y)
        val kbMs = SystemClock.uptimeMillis() - kbStart
        return JSONObject().put("x", x).put("y", y).put("tapped", device.click(x, y))
            .put("keyboardGuard", kb).put("keyboardGuardMs", kbMs)
    }

    private fun imeBoundsInScreen(): Rect? {
        val ime = instrumentation.uiAutomation.windows
            .firstOrNull { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD } ?: return null
        val r = Rect()
        ime.getBoundsInScreen(r)
        return if (r.isEmpty) null else r
    }

    private fun applyKeyboardGuard(cmd: JSONObject, x: Int, y: Int): String {
        if (!cmd.optBoolean("guardKeyboard", true)) return "off"
        val b = imeBoundsInScreen() ?: return "no_keyboard"
        return if (KeyboardGuard.shouldDismiss(b.left, b.top, b.right, b.bottom, x, y, 150)) {
            device.pressBack()
            device.waitForIdle(1500)
            "dismissed"
        } else {
            "not_occluded"
        }
    }

    private fun type(cmd: JSONObject): JSONObject {
        recordedTypeTarget = null
        val text = cmd.optString("text")
        // GH #581: bind the declared input exactly — never "click then use
        // whatever is focused". One operation resolves the target, skips the
        // focus tap only when THAT input is focused, otherwise taps the
        // declared focus point and proves the same input gained focus.
        val resolved = resolveExactTypeTarget(cmd)
        var target = resolved.obj
        var focusTap = "skipped-exact-focused"
        if (!isFocusedSafely(target)) {
            val bounds = target.visibleBounds
            val fx = cmd.optDouble("focusX", cmd.optDouble("x", bounds.exactCenterX().toDouble()))
                .roundToInt()
            val fy = cmd.optDouble("focusY", cmd.optDouble("y", bounds.exactCenterY().toDouble()))
                .roundToInt()
            imeBoundsInScreen()?.let { ime ->
                if (ime.contains(fx, fy)) {
                    throw FocusTargetOccludedException(
                        "FOCUS_TARGET_OCCLUDED: the focus tap point sits inside the visible keyboard; no tap or typing was performed. Dismiss the keyboard or scroll the input into view, then retry."
                    )
                }
            }
            device.click(fx, fy)
            // UiObject2 handles go stale across re-renders, so the focus poll
            // re-resolves by the SAME unique identity instead of pinning the
            // pre-tap handle.
            val deadline = SystemClock.uptimeMillis() + cmd.optLong("focusWaitMs", 1500L)
            var focusedTarget: UiObject2? = null
            while (true) {
                val rebound = resolveExactTypeTargetOrNull(cmd)
                if (rebound != null && isFocusedSafely(rebound.obj)) {
                    focusedTarget = rebound.obj
                    break
                }
                if (SystemClock.uptimeMillis() >= deadline) break
                SystemClock.sleep(100)
            }
            target = focusedTarget ?: throw TextTargetFocusFailedException(
                "TEXT_TARGET_FOCUS_FAILED: the bound input did not gain focus after tapping the declared focus target; no typing was performed. Increase waitForKeyboardMs or refresh the snapshot and retry."
            )
            focusTap = "performed"
        }

        // Story 10 (#391): ACTION_SET_TEXT primary — atomic, full-Unicode
        // (emoji survive), fires the change events RN's onChangeText listens
        // to. Read back to classify the outcome; per-char keyevents (Maestro's
        // 75 ms pacing) only when the set was flat-out ignored and every
        // character has a keyevent representation.
        val before = try {
            target.text
        } catch (e: StaleObjectException) {
            null
        }
        target.text = text
        var outcome = TextInputRecipe.classifySetText(text, before, readTargetText(target))
        var method = "setText"

        if (outcome == TextInputRecipe.SetTextOutcome.REJECTED) {
            // Codex P2 (#564): an empty request is a CLEAR — it has no keyevent
            // representation, but the stale-length delete pass below is exactly
            // how to honor it, so it must not throw here. Non-empty text must
            // map to keyevents AND fit the paced-typing budget (round-3: past
            // ~200 chars the 75 ms pacing would blow the client's 35 s budget).
            if (!TextInputRecipe.keyEventFallbackViable(text)) {
                throw SetTextRejectedException(
                    "Bound field ignored ACTION_SET_TEXT and the text has no viable keyevent fallback (non-ASCII or exceeds the paced-typing budget).",
                    mutation = MutationDisposition.NONE,
                )
            }
            // Codex P2 round-2 (#564): keyevents land in whatever is focused
            // NOW — if focus moved (OTP auto-advance), typing would hit the
            // wrong field. Refuse; the Maestro tier re-taps the target ref.
            val stillFocused = isFocusedSafely(target)
            if (!stillFocused) {
                throw SetTextRejectedException(
                    "Focus moved away from the target after ACTION_SET_TEXT — refusing the keyevent fallback (it would type into the newly focused field).",
                    mutation = MutationDisposition.NONE,
                )
            }
            // The rejected set left the prior value in place — clear it with
            // move-to-end + deletes so the keyevent pass can't append.
            val staleLen = before?.length ?: 0
            if (staleLen > 0) {
                device.pressKeyCode(KeyEvent.KEYCODE_MOVE_END, 0)
                repeat(staleLen) { device.pressKeyCode(KeyEvent.KEYCODE_DEL, 0) }
            }
            for (ch in text) {
                val stroke = TextInputRecipe.keyStrokeFor(ch) ?: continue
                device.pressKeyCode(
                    stroke.keyCode,
                    if (stroke.shift) KeyEvent.META_SHIFT_ON else 0,
                )
                SystemClock.sleep(TextInputRecipe.KEYEVENT_PACING_MS)
            }
            method = "keyevents"
            outcome = TextInputRecipe.classifySetText(text, before, readTargetText(target))
            // Codex P2 round-2 (#564): the keyevent tier is judged strictly —
            // a TRANSFORMED read-back on a field that started non-empty can be
            // an under-deleted `old + text` remnant, not a formatter, so only
            // exact matches (or empty-start transforms) count as landed.
            if (!TextInputRecipe.keyEventOutcomeUsable(outcome, beforeWasEmpty = before.isNullOrEmpty())) {
                throw SetTextRejectedException(
                    "Bound field ignored both ACTION_SET_TEXT and the keyevent fallback.",
                    mutation = MutationDisposition.OBSERVED,
                )
            }
        }
        // Codex P2 (#564): UNVERIFIED (no read-back — the target node went
        // stale after a re-render) is NOT retype-fodder: the set may have
        // landed, so a keyevent pass could double-apply. Report honestly and
        // let the bridge's own verification layers arbitrate.

        recordTypeTarget(target, cmd)
        // GH #581: requested text is never echoed back (secret safety).
        return JSONObject()
            .put("typed", true)
            .put("method", method)
            .put("setTextOutcome", outcome.name.lowercase())
            .put("focusTap", focusTap)
            .put("inputResolution", resolved.resolution)
    }

    private data class ResolvedInput(val obj: UiObject2, val resolution: String)

    private data class RecordedTypeTarget(
        val className: String,
        val identifier: String?,
        val bounds: Rect,
        val snapshotGeneration: Int?,
        val snapshotNodeIndex: Int?,
        val snapshotElementType: String?,
        val snapshotIdentifier: String?,
    )

    private var recordedTypeTarget: RecordedTypeTarget? = null

    private fun optionalInt(cmd: JSONObject, key: String): Int? =
        if (cmd.has(key) && !cmd.isNull(key)) cmd.getInt(key) else null

    private fun optionalString(cmd: JSONObject, key: String): String? =
        cmd.optString(key).ifBlank { null }

    private fun recordTypeTarget(target: UiObject2, cmd: JSONObject) {
        recordedTypeTarget = try {
            RecordedTypeTarget(
                className = target.className ?: "",
                identifier = objectIdentifier(target),
                bounds = Rect(target.visibleBounds),
                snapshotGeneration = optionalInt(cmd, "snapshotGeneration"),
                snapshotNodeIndex = optionalInt(cmd, "snapshotNodeIndex"),
                snapshotElementType = optionalString(cmd, "snapshotElementType"),
                snapshotIdentifier = optionalString(cmd, "snapshotIdentifier"),
            )
        } catch (e: StaleObjectException) {
            null
        }
    }

    private fun objectIdentifier(obj: UiObject2): String? {
        val res = obj.resourceName?.let { normalizeIdentifier(it) }
        if (!res.isNullOrBlank()) return res
        val desc = obj.contentDescription
        return if (desc.isNullOrBlank()) null else desc.toString()
    }

    private fun isFocusedSafely(obj: UiObject2): Boolean = try {
        obj.isFocused
    } catch (e: StaleObjectException) {
        false
    }

    private fun inputCandidates(): List<UiObject2> =
        device.findObjects(By.clazz(INPUT_CLASS_PATTERN)).orEmpty()

    private fun boundsMatch(a: Rect, b: Rect, tolerance: Int = 8): Boolean =
        abs(a.centerX() - b.centerX()) <= tolerance &&
            abs(a.centerY() - b.centerY()) <= tolerance &&
            abs(a.width() - b.width()) <= tolerance &&
            abs(a.height() - b.height()) <= tolerance

    private fun strictlyContains(outer: Rect, inner: Rect): Boolean =
        outer != inner && outer.contains(inner)

    private fun describedBounds(cmd: JSONObject): Rect? {
        val bounds = cmd.optJSONObject("targetBounds") ?: return null
        return Rect(
            bounds.getDouble("x").roundToInt(),
            bounds.getDouble("y").roundToInt(),
            (bounds.getDouble("x") + bounds.getDouble("width")).roundToInt(),
            (bounds.getDouble("y") + bounds.getDouble("height")).roundToInt(),
        )
    }

    private fun targetIdentities(candidates: List<UiObject2>): List<TextInputRecipe.TargetIdentity> =
        candidates.map { candidate ->
            val bounds = candidate.visibleBounds
            TextInputRecipe.TargetIdentity(
                type = candidate.className ?: "",
                identifier = objectIdentifier(candidate),
                frame = TextInputRecipe.TargetFrame(
                    bounds.left,
                    bounds.top,
                    bounds.right,
                    bounds.bottom,
                ),
            )
        }

    // Exact binding tiers mirroring the iOS runner: unique identifier across
    // ALL recognized inputs, then unique bounds-equality, then a unique (or
    // strictly nested) point hit. Never "first match", never ambient focus for
    // a supplied target.
    private fun resolveExactTypeTargetOrNull(cmd: JSONObject): ResolvedInput? = try {
        resolveExactTypeTarget(cmd)
    } catch (e: TypedRunnerException) {
        null
    }

    private fun resolveExactTypeTarget(cmd: JSONObject): ResolvedInput {
        val identifier = cmd.optString("snapshotIdentifier").ifBlank { null }
        val expectedClass = cmd.optString("snapshotElementType").ifBlank { null }
        val allCandidates = inputCandidates()
        if (identifier != null) {
            return when (
                val resolution = TextInputRecipe.resolveIdentifier(
                    targetIdentities(allCandidates),
                    expectedClass,
                    identifier,
                    null,
                    requireFrame = false,
                )
            ) {
                is TextInputRecipe.TargetResolution.Unique -> ResolvedInput(
                    allCandidates[resolution.index],
                    "identifier",
                )
                TextInputRecipe.TargetResolution.Ambiguous -> throw NoTextInputTargetException(
                    "NO_TEXT_INPUT_TARGET: identifier \"$identifier\" matches multiple text inputs; no typing was performed"
                )
                TextInputRecipe.TargetResolution.Absent -> throw NoTextInputTargetException(
                    "NO_TEXT_INPUT_TARGET: no text input matches identifier \"$identifier\"; no typing was performed"
                )
            }
        }
        val candidates = allCandidates.filter {
            expectedClass == null || (it.className ?: "") == expectedClass
        }
        val described = describedBounds(cmd)
        if (described != null) {
            val byBounds = candidates.filter { boundsMatch(it.visibleBounds, described) }
            if (byBounds.size > 1) {
                throw NoTextInputTargetException(
                    "NO_TEXT_INPUT_TARGET: the described bounds match ${byBounds.size} text inputs; no typing was performed"
                )
            }
            return ResolvedInput(
                byBounds.firstOrNull() ?: throw NoTextInputTargetException(
                    "NO_TEXT_INPUT_TARGET: no text input matches the described bounds; refresh the snapshot and rebind, no typing was performed"
                ),
                "bounds",
            )
        }
        if (cmd.has("x") && cmd.has("y")) {
            val px = cmd.getDouble("x").roundToInt()
            val py = cmd.getDouble("y").roundToInt()
            val containing = candidates.filter { it.visibleBounds.contains(px, py) }
                .sortedBy { it.visibleBounds.width().toLong() * it.visibleBounds.height() }
            when {
                containing.isEmpty() -> throw NoTextInputTargetException(
                    "NO_TEXT_INPUT_TARGET: no text input exists at ($px, $py); typing into a previously focused field was removed — bind the input's ref/testID and retry"
                )
                containing.size == 1 -> return ResolvedInput(containing[0], "point")
                else -> {
                    for (i in 0 until containing.size - 1) {
                        if (!strictlyContains(containing[i + 1].visibleBounds, containing[i].visibleBounds)) {
                            throw NoTextInputTargetException(
                                "NO_TEXT_INPUT_TARGET: multiple non-nested text inputs overlap ($px, $py); bind the input's ref/testID and retry"
                            )
                        }
                    }
                    return ResolvedInput(containing[0], "point")
                }
            }
        }
        val focused = device.findObject(By.focused(true).clazz(INPUT_CLASS_PATTERN))
            ?: throw NoTextInputTargetException(
                "NO_TEXT_INPUT_TARGET: no text input is focused and no target was provided; app-wide blind typing was removed"
            )
        return ResolvedInput(focused, "focused")
    }

    private fun verifyInput(cmd: JSONObject): JSONObject {
        val expected = cmd.optString("text")
        val candidates = inputCandidates()
        val recorded = recordedTypeTarget
        var target: UiObject2? = null
        var lostVerdict = "target-lost"
        val descriptorAgrees = recorded != null &&
            recorded.snapshotGeneration == optionalInt(cmd, "snapshotGeneration") &&
            recorded.snapshotNodeIndex == optionalInt(cmd, "snapshotNodeIndex") &&
            recorded.snapshotElementType == optionalString(cmd, "snapshotElementType") &&
            recorded.snapshotIdentifier == optionalString(cmd, "snapshotIdentifier")
        if (recorded != null && descriptorAgrees) {
            val identifierMatches = recorded.identifier?.let { identifier ->
                candidates.filter { objectIdentifier(it) == identifier }
            }
            if (identifierMatches != null && identifierMatches.size > 1) {
                lostVerdict = "ambiguous"
            }
            val byRecord = candidates.filter {
                (it.className ?: "") == recorded.className &&
                    objectIdentifier(it) == recorded.identifier &&
                    boundsMatch(it.visibleBounds, recorded.bounds)
            }
            when {
                lostVerdict == "ambiguous" -> Unit
                byRecord.size == 1 -> target = byRecord[0]
                byRecord.size > 1 -> lostVerdict = "ambiguous"
            }
        }
        if (target == null && lostVerdict != "ambiguous") {
            val identifier = cmd.optString("snapshotIdentifier").ifBlank { null }
            val expectedClass = cmd.optString("snapshotElementType").ifBlank { null }
            val described = describedBounds(cmd)
            if (identifier != null) {
                val frame = described?.let {
                    TextInputRecipe.TargetFrame(it.left, it.top, it.right, it.bottom)
                }
                when (
                    val resolution = TextInputRecipe.resolveIdentifier(
                        targetIdentities(candidates),
                        expectedClass,
                        identifier,
                        frame,
                        requireFrame = true,
                    )
                ) {
                    is TextInputRecipe.TargetResolution.Unique -> target = candidates[resolution.index]
                    TextInputRecipe.TargetResolution.Ambiguous -> lostVerdict = "ambiguous"
                    TextInputRecipe.TargetResolution.Absent -> Unit
                }
            } else if (described != null) {
                val byFrame = candidates.filter {
                    (expectedClass == null || (it.className ?: "") == expectedClass) &&
                        boundsMatch(it.visibleBounds, described)
                }
                when {
                    byFrame.size == 1 -> target = byFrame[0]
                    byFrame.size > 1 -> lostVerdict = "ambiguous"
                }
            }
        }
        val bound = target
            ?: return JSONObject().put("verifyVerdict", lostVerdict).put("verifyStable", false)
        val secure = cmd.optBoolean("secureInput", false)
        var previous: String? = null
        var havePrevious = false
        var verdict = "unreadable"
        var stable = false
        for (attempt in 0 until 3) {
            val raw = readTargetText(bound)
            verdict = TextInputRecipe.classifyVerify(expected, raw, secure)
            if (havePrevious && previous == raw) {
                stable = true
                break
            }
            previous = raw
            havePrevious = true
            if (attempt < 2) SystemClock.sleep(150)
        }
        return JSONObject().put("verifyVerdict", verdict).put("verifyStable", stable)
    }

    // Story 10 (#391): read back from the ORIGINAL target node, never from
    // By.focused — ACTION_SET_TEXT can move focus as a side effect (OTP
    // auto-advance), and reading "whatever is focused now" would misread a
    // successful write as a rejection from the next empty field (codex P2
    // round-2). A node staled by a re-render yields null → UNVERIFIED.
    private fun readTargetText(target: UiObject2): String? {
        device.waitForIdle(500)
        return try {
            target.text
        } catch (e: StaleObjectException) {
            null
        }
    }

    private fun drag(cmd: JSONObject): JSONObject {
        val x1 = cmd.optDouble("x1", cmd.optDouble("x")).roundToInt()
        val y1 = cmd.optDouble("y1", cmd.optDouble("y")).roundToInt()
        val x2 = cmd.getDouble("x2").roundToInt()
        val y2 = cmd.getDouble("y2").roundToInt()
        val steps = durationToSteps(cmd.optInt("durationMs", 300))
        val ok = device.swipe(x1, y1, x2, y2, steps)
        return JSONObject().put("x1", x1).put("y1", y1).put("x2", x2).put("y2", y2).put("durationMs", cmd.optInt("durationMs", 300)).put("dragged", ok)
    }

    private fun longPress(cmd: JSONObject): JSONObject {
        val x = cmd.getDouble("x").roundToInt()
        val y = cmd.getDouble("y").roundToInt()
        val durationMs = cmd.optInt("durationMs", 600)
        val kbStart = SystemClock.uptimeMillis()
        val kb = applyKeyboardGuard(cmd, x, y)
        val kbMs = SystemClock.uptimeMillis() - kbStart
        val ok = device.swipe(x, y, x, y, durationToSteps(durationMs))
        return JSONObject().put("x", x).put("y", y).put("durationMs", durationMs).put("pressed", ok)
            .put("keyboardGuard", kb).put("keyboardGuardMs", kbMs)
    }

    private fun pinch(cmd: JSONObject): JSONObject {
        val scale = cmd.optDouble("scale", 1.0)
        val root = device.findObject(By.depth(0)) ?: throw IllegalStateException("No root object available for pinch")
        // UIAutomator's pinchOpen/pinchClose take a Float ratio (0.0-1.0)
        // representing the percentage of the object's diagonal length.
        // The local `percent` (1-100, derived from `abs(scale - 1.0) * 100`)
        // is converted to that ratio by dividing by 100f.
        val percent = max(1, (abs(scale - 1.0) * 100).roundToInt()).coerceAtMost(100)
        val ratio = percent / 100f
        if (scale >= 1.0) root.pinchOpen(ratio, 500) else root.pinchClose(ratio, 500)
        return JSONObject().put("scale", scale).put("percent", percent)
    }

    private fun findText(cmd: JSONObject): JSONObject {
        val text = cmd.optString("text")
        val exact = cmd.optBoolean("exact", false)
        val obj = findByTextOrId(text, exact)
            ?: return JSONObject().put("found", false).put("text", text)

        return try {
            JSONObject()
                .put("found", true)
                .put("text", text)
                .put("node", uiObjectToJson(obj))
        } catch (e: StaleObjectException) {
            JSONObject().put("found", false).put("text", text).put("stale", true)
        }
    }

    private fun screenshot(): JSONObject {
        val file = File(instrumentation.targetContext.cacheDir, "rn-android-runner-screenshot.png")
        if (!device.takeScreenshot(file)) {
            throw IllegalStateException("UiDevice.takeScreenshot returned false")
        }
        val base64 = Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)
        return JSONObject().put("pngBase64", base64)
    }

    private fun findByTextOrId(query: String, exact: Boolean): UiObject2? {
        val safe = Pattern.quote(query)
        // Anchor at start; require explicit `:id/` separator; match query as the
        // complete id-name (no suffix bleed-through like `cancel_submit` matching `submit`).
        val idPattern = Pattern.compile("^[^:]+:id/$safe$")
        return device.findObject(By.res(idPattern))
            ?: device.findObject(By.desc(query))
            ?: device.findObject(By.text(query))
            ?: if (exact) null else device.findObject(By.textContains(query))
    }

    private fun uiObjectToJson(obj: UiObject2): JSONObject {
        val b = obj.visibleBounds
        return JSONObject()
            .put("type", obj.className ?: "")
            .put("label", obj.text ?: obj.contentDescription ?: "")
            .put("identifier", obj.resourceName?.let { normalizeIdentifier(it) } ?: "")
            .put("rect", JSONObject().put("x", b.left).put("y", b.top).put("width", b.width()).put("height", b.height()))
            .put("hittable", HittableSemantics.fromFoundObject(obj.isEnabled, b.width(), b.height()))
    }

    private fun parseBounds(raw: String?): Rect? {
        if (raw.isNullOrBlank()) return null
        val match = Regex("""\[(\d+),(\d+)]\[(\d+),(\d+)]""").find(raw) ?: return null
        val (l, t, r, b) = match.destructured
        return Rect(l.toInt(), t.toInt(), r.toInt(), b.toInt())
    }

    private fun normalizeIdentifier(resourceId: String): String {
        return resourceId.substringAfter(":id/", resourceId).substringAfterLast("/")
    }

    private fun durationToSteps(durationMs: Int): Int {
        return (durationMs / 5).coerceIn(1, 200)
    }

    private fun error(code: String, message: String): JSONObject {
        return JSONObject()
            .put("ok", false)
            .put("error", JSONObject().put("code", code).put("message", message))
    }
}
