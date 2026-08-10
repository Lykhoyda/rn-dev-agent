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
        val response = dispatchFill(ExactFillPrivacyFixtureActivity.FIELD_IDENTIFIER, canary)
        assertTrue(response.optBoolean("ok"))
        assertFalse(response.toString().contains(canary))

        SystemClock.sleep(250)
        assertFalse(shell("logcat -b all -d -v raw").contains(canary))
    }

    @Test
    fun exactAccessibilityFillProvesPlaceholderAndPlainEmptyClear() {
        launchFixture(ExactFillPrivacyFixtureActivity.PLACEHOLDER_CLEAR_IDENTIFIER)

        for (identifier in listOf(
            ExactFillPrivacyFixtureActivity.PLACEHOLDER_CLEAR_IDENTIFIER,
            ExactFillPrivacyFixtureActivity.PLAIN_CLEAR_IDENTIFIER,
        )) {
            val response = dispatchFill(identifier, "")
            assertTrue(response.optBoolean("ok"))
            assertTrue(response.optJSONObject("data")?.optString("verify") == "exact")
        }
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

    private fun dispatchFill(identifier: String, text: String): JSONObject {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        return CommandDispatcher(instrumentation).dispatch(
            JSONObject()
                .put("command", "fill")
                .put("appBundleId", instrumentation.context.packageName)
                .put("text", text)
                .put("exactIdentifier", identifier)
                .put("exactType", EditText::class.java.name),
        )
    }

    private fun shell(command: String): String {
        val descriptor = InstrumentationRegistry.getInstrumentation()
            .uiAutomation
            .executeShellCommand(command)
        return ParcelFileDescriptor.AutoCloseInputStream(descriptor)
            .bufferedReader()
            .use { it.readText() }
    }
}
