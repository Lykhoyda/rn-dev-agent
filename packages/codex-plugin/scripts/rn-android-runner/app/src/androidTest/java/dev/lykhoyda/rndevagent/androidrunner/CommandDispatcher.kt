/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Base64
import android.view.accessibility.AccessibilityNodeInfo
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

class NoFocusedInputException(message: String) : IllegalStateException(message)

class ExactFillException(
    val fillCode: String,
    val mutation: String,
    val reason: String,
    message: String,
) : IllegalStateException(message)

class SnapshotParseException(message: String) : IllegalStateException(message)
class AccessibilityUnavailableException(message: String) : IllegalStateException(message)
class ExactPressException(
    val pressCode: String,
    val mutation: String,
    val reason: String,
    message: String,
) : IllegalStateException(message)

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
            "snapshot", "tap", "press", "type", "fill", "drag", "swipe", "scroll",
            "screenshot", "back", "dismissKeyboard", "keyboard", "longPress",
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

        val data = when (command) {
            "snapshot" -> snapshot(appPackage)
            "tap", "press" -> tap(cmd)
            "type", "fill" -> type(cmd)
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
                        val packageName = parser.getAttributeValue(null, "package").orEmpty()
                        val checked = parser.getAttributeValue(null, "checked") == "true"
                        val visible = parser.getAttributeValue(null, "visible-to-user") != "false"
                        val enabled = parser.getAttributeValue(null, "enabled") != "false"
                        val identifier = normalizeIdentifier(resourceId).ifBlank { desc }

                        nodes.put(
                            JSONObject()
                                .put("index", index)
                                .put("type", className)
                                .put("label", text.ifBlank { desc })
                                .put("identifier", identifier)
                                .put("packageName", packageName)
                                .put("checked", checked)
                                .put("rect", JSONObject().put("x", bounds.left).put("y", bounds.top).put("width", bounds.width()).put("height", bounds.height()))
                                .put("hittable", HittableSemantics.fromSnapshotNode(enabled, visible))
                                .put("enabled", enabled)
                        )
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
        val exactIdentifier = cmd.optString("exactIdentifier").ifBlank { null }
        val exactType = cmd.optString("exactType").ifBlank { null }
        if (exactIdentifier != null && exactType != null) {
            val appPackage = cmd.optString("appBundleId").ifBlank { null }
            val includeSystemUi = cmd.optBoolean("includeSystemUi", false)
            val target = resolveExactPressNode(exactIdentifier, exactType, appPackage, includeSystemUi)
            val dispatched = try {
                target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            } finally {
                target.recycle()
            }
            if (!dispatched) {
                throw ExactPressException(
                    "INTERACTION_NOT_ACTUATED",
                    "none",
                    "accessibility-action-rejected",
                    "The exact accessibility target rejected ACTION_CLICK; no coordinate fallback was attempted.",
                )
            }
            return JSONObject()
                .put("tapped", true)
                .put("method", "accessibility-action")
                .put("identifier", exactIdentifier)
        }

        val x = cmd.getDouble("x").roundToInt()
        val y = cmd.getDouble("y").roundToInt()
        val kbStart = SystemClock.uptimeMillis()
        val kb = applyKeyboardGuard(cmd, x, y)
        val kbMs = SystemClock.uptimeMillis() - kbStart
        return JSONObject().put("x", x).put("y", y).put("tapped", device.click(x, y))
            .put("keyboardGuard", kb).put("keyboardGuardMs", kbMs)
    }

    private fun resolveExactPressNode(
        identifier: String,
        type: String,
        appPackage: String?,
        includeSystemUi: Boolean,
    ): AccessibilityNodeInfo {
        if (!includeSystemUi && appPackage == null) {
            throw ExactPressException(
                "INTERACTION_NOT_ACTUATED",
                "none",
                "app-window-unavailable",
                "Exact Android interaction requires the owned app package.",
            )
        }
        val matches = mutableListOf<AccessibilityNodeInfo>()
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        instrumentation.uiAutomation.windows.forEach { window ->
            val root = window.root ?: return@forEach
            val packageName = root.packageName?.toString()
            if (includeSystemUi || packageName == appPackage) {
                stack.addLast(AccessibilityNodeInfo.obtain(root))
            }
        }
        var visited = 0
        while (stack.isNotEmpty() && visited++ < 20_000) {
            val node = stack.removeLast()
            for (index in 0 until node.childCount) {
                node.getChild(index)?.let { stack.addLast(it) }
            }
            val nodeIdentifier = normalizeIdentifier(node.viewIdResourceName.orEmpty())
                .ifBlank { node.contentDescription?.toString().orEmpty() }
            val nodeType = node.className?.toString().orEmpty()
            if (nodeIdentifier == identifier && nodeType == type) matches.add(node) else node.recycle()
        }
        while (stack.isNotEmpty()) stack.removeLast().recycle()
        if (matches.size != 1) {
            matches.forEach { it.recycle() }
            throw ExactPressException(
                "INTERACTION_NOT_ACTUATED",
                "none",
                if (matches.isEmpty()) "exact-target-missing" else "exact-target-ambiguous",
                "Exact Android interaction resolved ${matches.size} matching targets; refusing to guess.",
            )
        }
        return matches.single()
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
        val text = cmd.optString("text")
        val exactIdentifier = cmd.optString("exactIdentifier").ifBlank { null }
        val exactType = cmd.optString("exactType").ifBlank { null }
        if (exactIdentifier != null && exactType != null) {
            return exactType(exactIdentifier, exactType, text)
        }
        throw NoFocusedInputException(
            "Exact text-input descriptor is required; app-wide focused typing is disabled."
        )
    }

    private data class ExactNodeResolution(
        val node: AccessibilityNodeInfo?,
        val verdict: TextInputRecipe.ExactResolution,
    )

    private fun exactType(identifier: String, type: String, requested: String): JSONObject {
        var initialResolution = resolveExactNode(identifier, type)
        if (initialResolution.verdict == TextInputRecipe.ExactResolution.UNREADABLE) {
            throw ExactFillException(
                "TEXT_ENTRY_UNVERIFIED",
                "none",
                "unreadable",
                "The exact text input traversal was incomplete; no text was entered.",
            )
        }
        val initial = initialResolution.node ?: throw ExactFillException(
            "NO_TEXT_INPUT_TARGET",
            "none",
            if (initialResolution.verdict == TextInputRecipe.ExactResolution.AMBIGUOUS) "ambiguous" else "target-lost",
            "The exact text input descriptor did not resolve uniquely; no text was entered.",
        )
        val initialBounds = Rect().also { initial.getBoundsInScreen(it) }
        if (!initial.isEnabled || !initial.isVisibleToUser || initialBounds.isEmpty) {
            initial.recycle()
            throw ExactFillException(
                "TEXT_ENTRY_UNVERIFIED",
                "none",
                "occluded",
                "The exact text input is not safely actionable; no text was entered.",
            )
        }
        if (initial.isPassword) {
            initial.recycle()
            throw ExactFillException(
                "TEXT_ENTRY_UNVERIFIED",
                "none",
                "secure",
                "Secure text input cannot provide exact readable verification; no text was entered.",
            )
        }

        val focusedBefore = initial.isFocused
        if (!focusedBefore) {
            initial.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            SystemClock.sleep(150)
        }

        initialResolution = resolveExactNode(identifier, type)
        if (initialResolution.verdict == TextInputRecipe.ExactResolution.UNREADABLE) {
            initial.recycle()
            throw ExactFillException(
                "TEXT_ENTRY_UNVERIFIED",
                "none",
                "unreadable",
                "The exact text input traversal was incomplete during focus; no text was entered.",
            )
        }
        val focused = initialResolution.node ?: run {
            initial.recycle()
            throw ExactFillException(
                "TEXT_TARGET_LOST",
                "none",
                if (initialResolution.verdict == TextInputRecipe.ExactResolution.AMBIGUOUS) "ambiguous" else "target-lost",
                "The exact text input was lost during focus; no text was entered.",
            )
        }
        val sameAfterFocus = initial == focused
        initial.recycle()
        if (!sameAfterFocus) {
            focused.recycle()
            throw ExactFillException(
                "TEXT_TARGET_LOST",
                "none",
                "target-lost",
                "The exact accessibility node changed during focus; no text was entered.",
            )
        }
        if (!focused.isFocused) {
            focused.recycle()
            throw ExactFillException(
                "TEXT_TARGET_FOCUS_FAILED",
                "none",
                "focus-unproven",
                "The exact text input did not prove focused before mutation; no text was entered.",
            )
        }

        val before = nodeText(focused)
        val bundle = Bundle().apply {
            putCharSequence(
                AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                requested,
            )
        }
        val dispatched = focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle)
        if (!dispatched) {
            focused.recycle()
            throw ExactFillException(
                "TEXT_ENTRY_UNVERIFIED",
                "possible",
                "dispatch-uncertain",
                "The exact text mutation action was not acknowledged.",
            )
        }

        var consecutiveExact = 0
        var finalVerdict = TextInputRecipe.ExactReadback.UNREADABLE
        var observedChanged = false
        repeat(6) { attempt ->
            if (attempt > 0) SystemClock.sleep(80)
            val readResolution = resolveExactNode(identifier, type)
            if (readResolution.verdict == TextInputRecipe.ExactResolution.UNREADABLE) {
                focused.recycle()
                throw ExactFillException(
                    "TEXT_ENTRY_UNVERIFIED",
                    "possible",
                    "unreadable",
                    "The exact text input traversal was incomplete after mutation.",
                )
            }
            val current = readResolution.node ?: run {
                focused.recycle()
                throw ExactFillException(
                    "TEXT_TARGET_LOST",
                    "possible",
                    if (readResolution.verdict == TextInputRecipe.ExactResolution.AMBIGUOUS) "ambiguous" else "target-lost",
                    "The exact text input was lost after mutation.",
                )
            }
            if (current != focused) {
                current.recycle()
                focused.recycle()
                throw ExactFillException(
                    "TEXT_TARGET_LOST",
                    "possible",
                    "target-lost",
                    "The exact accessibility node changed after mutation.",
                )
            }
            val after = nodeText(current)
            observedChanged = observedChanged || after != before
            val hintKnown = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            val showingHint = if (hintKnown) current.isShowingHintText else null
            val hint = if (hintKnown) current.hintText?.toString() else null
            finalVerdict = TextInputRecipe.classifyExactReadback(
                requested = requested,
                before = before,
                after = after,
                hint = hint,
                showingHint = showingHint,
                hintKnown = hintKnown,
            )
            current.recycle()
            consecutiveExact = if (finalVerdict == TextInputRecipe.ExactReadback.EXACT) {
                consecutiveExact + 1
            } else {
                0
            }
            if (consecutiveExact >= 2) {
                focused.recycle()
                return JSONObject()
                    .put("filled", true)
                    .put("verify", "exact")
                    .put("focusedBefore", focusedBefore)
            }
        }
        focused.recycle()
        throw ExactFillException(
            "TEXT_ENTRY_UNVERIFIED",
            if (observedChanged) "observed" else "possible",
            if (finalVerdict == TextInputRecipe.ExactReadback.MISMATCH) "mismatch" else "unreadable",
            "Text mutation did not produce stable exact read-back.",
        )
    }

    private fun resolveExactNode(identifier: String, type: String): ExactNodeResolution {
        val matches = mutableListOf<AccessibilityNodeInfo>()
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        instrumentation.uiAutomation.windows.forEach { window ->
            window.root?.let { stack.addLast(AccessibilityNodeInfo.obtain(it)) }
        }
        var visited = 0
        while (stack.isNotEmpty() && visited++ < 20_000) {
            val node = stack.removeLast()
            for (index in 0 until node.childCount) {
                node.getChild(index)?.let { stack.addLast(it) }
            }
            val nodeIdentifier = normalizeIdentifier(node.viewIdResourceName.orEmpty())
                .ifBlank { node.contentDescription?.toString().orEmpty() }
            val nodeType = node.className?.toString().orEmpty()
            if (nodeIdentifier == identifier && nodeType == type && node.isEditable) {
                matches.add(node)
            } else {
                node.recycle()
            }
        }
        val traversalComplete = stack.isEmpty()
        while (stack.isNotEmpty()) stack.removeLast().recycle()
        val verdict = TextInputRecipe.classifyResolution(
            matchCount = matches.size,
            traversalComplete = traversalComplete,
        )
        if (verdict != TextInputRecipe.ExactResolution.UNIQUE) {
            matches.forEach { it.recycle() }
            return ExactNodeResolution(null, verdict)
        }
        return ExactNodeResolution(matches.single(), verdict)
    }

    private fun nodeText(node: AccessibilityNodeInfo): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return node.text?.toString()
        return if (node.isShowingHintText) node.text?.toString() ?: node.hintText?.toString().orEmpty()
        else node.text?.toString().orEmpty()
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
