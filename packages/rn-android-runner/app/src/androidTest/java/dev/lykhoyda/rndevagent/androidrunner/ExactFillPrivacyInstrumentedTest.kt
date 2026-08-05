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
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val device = UiDevice.getInstance(instrumentation)
        val testPackage = instrumentation.context.packageName
        val intent = Intent()
            .setClassName(testPackage, ExactFillPrivacyFixtureActivity::class.java.name)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        instrumentation.context.startActivity(intent)
        assertTrue(
            device.wait(
                Until.hasObject(By.desc(ExactFillPrivacyFixtureActivity.FIELD_IDENTIFIER)),
                10_000,
            ),
        )

        shell("logcat -b all -c")
        val canary = "RN_FILL_LOGCAT_PRIVACY_CANARY_581"
        val response = CommandDispatcher(instrumentation).dispatch(
            JSONObject()
                .put("command", "fill")
                .put("appBundleId", testPackage)
                .put("text", canary)
                .put("exactIdentifier", ExactFillPrivacyFixtureActivity.FIELD_IDENTIFIER)
                .put("exactType", EditText::class.java.name),
        )
        assertTrue(response.optBoolean("ok"))
        assertFalse(response.toString().contains(canary))

        SystemClock.sleep(250)
        assertFalse(shell("logcat -b all -d -v raw").contains(canary))
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
