package dev.lykhoyda.rndevagent.androidrunner

import android.content.Intent
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.widget.EditText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@LargeTest
@RunWith(AndroidJUnit4::class)
class ExactFillPrivacyInstrumentedTest {
    @Test
    fun exactAccessibilityFillKeepsCanaryOutOfLogcat() {
        launchFixture(ExactFillPrivacyFixtureActivity.FIELD_IDENTIFIER)

        shell("logcat -b all -c")
        val canary = "RN_FILL_LOGCAT_PRIVACY_CANARY_581"
        val token = "op-privacy-581"
        val fill = dispatchFill(ExactFillPrivacyFixtureActivity.FIELD_IDENTIFIER, canary, token)
        assertTrue(fill.toString(), fill.optBoolean("ok"))
        assertFalse(fill.toString().contains(canary))

        val verify = dispatchVerify(canary, token)
        assertEquals(verify.toString(), "exact", verifyVerdict(verify))
        assertFalse(verify.toString().contains(canary))

        SystemClock.sleep(250)
        assertFalse(shell("logcat -b all -d -v raw").contains(canary))
    }

    // GH #581: a plain empty clear proves exact; a placeholder-bearing field
    // reads back its hint after the clear, which the recipe deliberately
    // refuses as "ambiguous" so a hint can never false-succeed as field text.
    @Test
    fun exactAccessibilityFillArbitratesEmptyClearsTruthfully() {
        launchFixture(ExactFillPrivacyFixtureActivity.PLACEHOLDER_CLEAR_IDENTIFIER)

        val plainToken = "op-plain-clear-581"
        val plainFill = dispatchFill(
            ExactFillPrivacyFixtureActivity.PLAIN_CLEAR_IDENTIFIER,
            "",
            plainToken,
        )
        assertTrue(plainFill.toString(), plainFill.optBoolean("ok"))
        assertEquals("exact", verifyVerdict(dispatchVerify("", plainToken)))

        val placeholderToken = "op-placeholder-clear-581"
        val placeholderFill = dispatchFill(
            ExactFillPrivacyFixtureActivity.PLACEHOLDER_CLEAR_IDENTIFIER,
            "",
            placeholderToken,
        )
        assertTrue(placeholderFill.toString(), placeholderFill.optBoolean("ok"))
        assertEquals("ambiguous", verifyVerdict(dispatchVerify("", placeholderToken)))
    }

    private fun launchFixture(identifier: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val testPackage = instrumentation.context.packageName
        val intent = Intent()
            .setClassName(testPackage, ExactFillPrivacyFixtureActivity::class.java.name)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        instrumentation.context.startActivity(intent)
        assertTrue(
            UiDevice.getInstance(instrumentation).wait(
                Until.hasObject(By.desc(identifier)),
                10_000,
            ),
        )
    }

    private val dispatcher: CommandDispatcher by lazy {
        CommandDispatcher(InstrumentationRegistry.getInstrumentation())
    }

    private fun dispatchFill(identifier: String, text: String, operationToken: String): JSONObject {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val device = UiDevice.getInstance(instrumentation)
        val field = device.findObject(By.desc(identifier))
        assertTrue("fixture field $identifier must be on screen", field != null)
        val bounds = field.visibleBounds
        return dispatcher.dispatch(
            JSONObject()
                .put("command", "fill")
                .put("appBundleId", instrumentation.context.packageName)
                .put("text", text)
                .put("snapshotIdentifier", identifier)
                .put("snapshotElementType", EditText::class.java.name)
                .put(
                    "targetBounds",
                    JSONObject()
                        .put("x", bounds.left)
                        .put("y", bounds.top)
                        .put("width", bounds.width())
                        .put("height", bounds.height()),
                )
                .put("operationToken", operationToken),
        )
    }

    private fun dispatchVerify(text: String, operationToken: String): JSONObject =
        dispatcher.dispatch(
            JSONObject()
                .put("command", "verifyInput")
                .put("text", text)
                .put("operationToken", operationToken),
        )

    private fun verifyVerdict(response: JSONObject): String? =
        response.optJSONObject("data")?.optString("verifyVerdict")

    private fun shell(command: String): String {
        val descriptor = InstrumentationRegistry.getInstrumentation()
            .uiAutomation
            .executeShellCommand(command)
        return ParcelFileDescriptor.AutoCloseInputStream(descriptor)
            .bufferedReader()
            .use { it.readText() }
    }
}
