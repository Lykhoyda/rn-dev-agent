package dev.lykhoyda.rndevagent.androidrunner

import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject

object RunnerRuntime {
    lateinit var dispatcher: CommandDispatcher
}

class CommandServer(port: Int) : NanoHTTPD(port) {
    override fun serve(session: IHTTPSession): Response {
        if (session.method == Method.GET && session.uri == "/health") {
            return json(Response.Status.OK, JSONObject().put("ok", true))
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
        return newFixedLengthResponse(status, "application/json", body.toString())
    }
}
