/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject

object RunnerRuntime {
    lateinit var dispatcher: CommandDispatcher
}

class CommandServer(port: Int, private val pluginVersion: String? = null) : NanoHTTPD(port) {
    override fun serve(session: IHTTPSession): Response {
        if (session.method == Method.GET && session.uri == "/health") {
            val body = JSONObject()
                .put("ok", true)
                .put("protocolVersion", RunnerProtocol.VERSION)
                .put("capabilities", JSONArray())
            if (pluginVersion != null) body.put("runnerVersion", pluginVersion)
            return json(Response.Status.OK, body)
        }

        if (session.method != Method.POST || session.uri != "/command") {
            return json(
                Response.Status.NOT_FOUND,
                JSONObject()
                    .put("ok", false)
                    .put("error", JSONObject().put("code", "NOT_FOUND").put("message", "Use POST /command"))
            )
        }

        return try {
            val files = HashMap<String, String>()
            session.parseBody(files)
            val raw = files["postData"] ?: "{}"
            val command = JSONObject(raw)
            json(Response.Status.OK, RunnerRuntime.dispatcher.dispatch(command))
        } catch (e: NoFocusedInputException) {
            json(
                Response.Status.OK,
                JSONObject()
                    .put("ok", false)
                    .put("error", JSONObject().put("code", "NO_FOCUSED_INPUT").put("message", e.message ?: "no focused input"))
            )
        } catch (e: SnapshotParseException) {
            json(
                Response.Status.OK,
                JSONObject()
                    .put("ok", false)
                    .put("error", JSONObject().put("code", "SNAPSHOT_PARSE_FAILED").put("message", e.message ?: "snapshot parse failed"))
            )
        } catch (t: Throwable) {
            json(
                Response.Status.INTERNAL_ERROR,
                JSONObject()
                    .put("ok", false)
                    .put("error", JSONObject().put("code", "RUNNER_ERROR").put("message", t.message ?: t.javaClass.name))
            )
        }
    }

    private fun json(status: Response.Status, body: JSONObject): Response {
        if (!body.has("v")) body.put("v", RunnerProtocol.VERSION)
        return newFixedLengthResponse(status, "application/json", body.toString())
    }
}
