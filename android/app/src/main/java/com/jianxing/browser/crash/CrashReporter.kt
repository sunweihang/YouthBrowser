package com.jianxing.browser.crash

import android.app.Application
import android.os.Build
import android.util.Log
import com.jianxing.browser.BuildConfig
import com.jianxing.browser.data.AccountStore
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

object CrashReporter {
    private const val TAG = "CrashReporter"
    private const val MAX_MESSAGE = 2000
    private const val MAX_STACK = 16000
    private const val MAX_URL = 1024
    private const val MAX_PENDING = 40
    private const val MAX_LOG_BYTES = 1_500_000L

    private val io = Executors.newSingleThreadExecutor { r ->
        Thread(r, "crash-reporter").apply { isDaemon = true }
    }
    private val http = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(6, TimeUnit.SECONDS)
        .writeTimeout(6, TimeUnit.SECONDS)
        .build()
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    @Volatile
    private var app: Application? = null
    private var previousHandler: Thread.UncaughtExceptionHandler? = null
    private val recent = LinkedHashMap<String, Long>()

    fun init(application: Application) {
        app = application
        previousHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                val payload = buildPayload(
                    kind = "android-crash",
                    level = "fatal",
                    message = error.message ?: error.javaClass.name,
                    stack = Log.getStackTraceString(error),
                    extra = mapOf("thread" to thread.name)
                )
                writeLocal(payload)
                enqueuePending(payload)
            } catch (_: Exception) {
            }
            previousHandler?.uncaughtException(thread, error)
        }
        io.execute {
            try {
                writeLog("${nowIso()} [boot] v${BuildConfig.VERSION_NAME} ${Build.MODEL}")
                flushPending()
            } catch (e: Exception) {
                Log.w(TAG, "init flush failed", e)
            }
        }
    }

    fun report(
        kind: String,
        message: String,
        stack: String? = null,
        url: String? = null,
        extra: Map<String, Any?>? = null,
        level: String = "error"
    ) {
        io.execute {
            try {
                if (shouldDedup(kind, message, url)) return@execute
                val payload = buildPayload(kind, level, message, stack, url, extra)
                writeLocal(payload)
                if (!post(payload)) enqueuePending(payload)
            } catch (e: Exception) {
                Log.w(TAG, "report failed", e)
            }
        }
    }

    private fun shouldDedup(kind: String, message: String, url: String?): Boolean {
        val key = "$kind|${message.take(200)}|${(url ?: "").take(200)}"
        val now = System.currentTimeMillis()
        val it = recent.entries.iterator()
        while (it.hasNext()) {
            if (now - it.next().value > 60_000) it.remove()
        }
        val prev = recent[key]
        if (prev != null && now - prev < 60_000) return true
        recent[key] = now
        return false
    }

    private fun logsDir(): File {
        val dir = File(requireNotNull(app).filesDir, "logs")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    private fun installId(): String {
        val file = File(logsDir(), "install-id.txt")
        try {
            if (file.exists()) {
                val id = file.readText().trim()
                if (id.isNotEmpty()) return id
            }
        } catch (_: Exception) {
        }
        val id = UUID.randomUUID().toString()
        try {
            file.writeText(id)
        } catch (_: Exception) {
        }
        return id
    }

    private fun pendingFile() = File(logsDir(), "pending-reports.json")

    private fun logFile() = File(logsDir(), "app.log")

    private fun writeLog(line: String) {
        try {
            val file = logFile()
            if (file.exists() && file.length() > MAX_LOG_BYTES) {
                val bak = File(logsDir(), "app.prev.log")
                if (bak.exists()) bak.delete()
                file.renameTo(bak)
            }
            file.appendText("$line\n")
        } catch (_: Exception) {
        }
    }

    private fun writeLocal(payload: JSONObject) {
        writeLog(
            listOf(
                nowIso(),
                "[${payload.optString("level")}]",
                payload.optString("kind"),
                payload.optString("message").take(400),
                payload.optString("url")
            ).filter { it.isNotBlank() }.joinToString(" ")
        )
    }

    private fun readPending(): JSONArray {
        val file = pendingFile()
        if (!file.exists()) return JSONArray()
        return try {
            JSONArray(file.readText())
        } catch (_: Exception) {
            JSONArray()
        }
    }

    private fun writePending(arr: JSONArray) {
        try {
            pendingFile().writeText(arr.toString())
        } catch (_: Exception) {
        }
    }

    private fun enqueuePending(payload: JSONObject) {
        val arr = readPending()
        arr.put(payload)
        while (arr.length() > MAX_PENDING) arr.remove(0)
        writePending(arr)
    }

    private fun flushPending() {
        val arr = readPending()
        if (arr.length() == 0) return
        val remain = JSONArray()
        for (i in 0 until arr.length()) {
            val item = arr.optJSONObject(i) ?: continue
            if (!post(item)) remain.put(item)
        }
        writePending(remain)
    }

    private fun buildPayload(
        kind: String,
        level: String,
        message: String,
        stack: String? = null,
        url: String? = null,
        extra: Map<String, Any?>? = null
    ): JSONObject {
        val session = runCatching { AccountStore(requireNotNull(app)).getSession() }.getOrNull()
        val obj = JSONObject()
            .put("id", UUID.randomUUID().toString())
            .put("ts", System.currentTimeMillis())
            .put("kind", kind)
            .put("level", level)
            .put("message", clip(message, MAX_MESSAGE).ifEmpty { "unknown error" })
            .put("platform", "android")
            .put("arch", Build.SUPPORTED_ABIS.firstOrNull() ?: "")
            .put("osRelease", "Android ${Build.VERSION.RELEASE} (${Build.VERSION.SDK_INT}) ${Build.MANUFACTURER} ${Build.MODEL}")
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("installId", installId())
            .put("username", session?.username ?: "")
        if (!stack.isNullOrBlank()) obj.put("stack", clip(stack, MAX_STACK))
        if (!url.isNullOrBlank()) obj.put("url", clip(url, MAX_URL))
        if (!extra.isNullOrEmpty()) {
            val extraObj = JSONObject()
            extra.forEach { (k, v) -> extraObj.put(k, v?.toString() ?: "") }
            obj.put("extra", extraObj)
        }
        return obj
    }

    private fun post(payload: JSONObject): Boolean {
        return try {
            val store = AccountStore(requireNotNull(app))
            val session = store.getSession()
            val base = (session?.serverUrl ?: store.getServerUrl()).trimEnd('/')
            val builder = Request.Builder()
                .url("$base/telemetry/crash")
                .header("Accept", "application/json")
                .header("X-SimplyGo-Client", "android")
                .post(payload.toString().toRequestBody(jsonMedia))
            if (session != null) {
                builder.header("Authorization", "Bearer ${session.token}")
            }
            http.newCall(builder.build()).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                resp.isSuccessful && text.contains("\"ok\":true")
            }
        } catch (e: Exception) {
            Log.w(TAG, "upload failed", e)
            false
        }
    }

    private fun clip(value: String, max: Int): String = value.take(max)

    private fun nowIso(): String = java.text.SimpleDateFormat(
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
        java.util.Locale.US
    ).apply {
        timeZone = java.util.TimeZone.getTimeZone("UTC")
    }.format(java.util.Date())
}
