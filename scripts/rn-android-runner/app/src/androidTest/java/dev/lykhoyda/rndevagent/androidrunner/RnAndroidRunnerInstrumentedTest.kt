/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.Configurator
import fi.iki.elonen.NanoHTTPD
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@LargeTest
@RunWith(AndroidJUnit4::class)
class RnAndroidRunnerInstrumentedTest {
    private lateinit var server: CommandServer

    @Before
    fun startServer() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        val port = args.getString("RN_ANDROID_RUNNER_PORT")?.toIntOrNull() ?: 22089

        // Mirrors the iOS `withTemporaryScrollIdleTimeoutIfSupported` shim.
        // RN's main thread never reports quiescence when Reanimated/RAF worklets
        // are active — UIAutomator's `waitForIdle` then blocks until its timeout
        // ceiling and throws even after the action succeeded. We disable the
        // idle-wait entirely (`0` = no wait) and let each command handler add
        // its own minimal `Thread.sleep(50)` only where settle is genuinely
        // needed (focus propagation after `tap`, animation frame after `drag`).
        // Action and scroll acknowledgment timeouts stay at 500ms because those
        // gate the actual gesture synthesis, not idle wait.
        Configurator.getInstance().setWaitForIdleTimeout(0)
        Configurator.getInstance().setActionAcknowledgmentTimeout(500)
        Configurator.getInstance().setScrollAcknowledgmentTimeout(500)

        RunnerRuntime.dispatcher = CommandDispatcher(instrumentation)
        server = CommandServer(port)
        server.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)

        Log.i("RnAndroidRunner", "RN_ANDROID_RUNNER_LISTENER_READY")
        Log.i("RnAndroidRunner", "RN_ANDROID_RUNNER_PORT=$port")
    }

    @Test
    fun mainLoop() {
        while (!Thread.currentThread().isInterrupted) {
            try {
                Thread.sleep(1_000)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            }
        }
    }

    @After
    fun stopServer() {
        if (::server.isInitialized) {
            server.stop()
        }
    }
}
