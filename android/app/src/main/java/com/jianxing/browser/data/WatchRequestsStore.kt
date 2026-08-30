package com.jianxing.browser.data

import android.content.Context
import android.content.SharedPreferences
import com.jianxing.browser.guard.BiliResolver
import com.jianxing.browser.model.WatchRequest
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.util.UUID

class WatchRequestsStore(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    @Synchronized
    fun list(): List<WatchRequest> {
        return load().sortedByDescending { it.createdAt }
    }

    @Synchronized
    fun pending(): List<WatchRequest> = list().filter { it.status == "pending" }

    @Synchronized
    fun resolved(): List<WatchRequest> =
        list().filter { it.status == "approved" || it.status == "rejected" }

    @Synchronized
    fun create(
        url: String,
        reason: String? = null,
        mid: String? = null,
        bvid: String? = null,
        aid: String? = null,
        title: String? = null
    ): WatchRequest {
        var normalized = url.trim()
        if (normalized.isNotEmpty() && !Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:").containsMatchIn(normalized)) {
            normalized = "https://$normalized"
        }
        var host: String? = null
        var resolvedMid = mid?.takeIf { it.isNotBlank() }
        var resolvedBvid = bvid?.takeIf { it.isNotBlank() }
        var resolvedAid = aid?.takeIf { it.isNotBlank() }
        var resolvedTitle = title?.takeIf { it.isNotBlank() }

        try {
            val u = URI(normalized)
            host = u.host?.lowercase()
            if (host != null && isBiliHost(host)) {
                val path = u.path ?: ""
                val ids = BiliResolver.parseBiliVideoId(path)
                if (ids != null) {
                    if (resolvedBvid.isNullOrBlank()) resolvedBvid = ids.bvid
                    if (resolvedAid.isNullOrBlank()) resolvedAid = ids.aid
                }
                if (resolvedMid.isNullOrBlank() && (!resolvedBvid.isNullOrBlank() || !resolvedAid.isNullOrBlank())) {
                    val owner = BiliResolver.resolveVideoOwner(resolvedBvid, resolvedAid)
                    if (owner.ok && !owner.mid.isNullOrBlank()) {
                        resolvedMid = owner.mid
                        if (resolvedTitle.isNullOrBlank() && !owner.title.isNullOrBlank()) {
                            resolvedTitle = owner.title
                        }
                    }
                }
                if (resolvedMid.isNullOrBlank()) {
                    val spaceMid = BiliResolver.parseSpaceMid(path)
                    if (!spaceMid.isNullOrBlank()) resolvedMid = spaceMid
                }
            }
            if (resolvedTitle.isNullOrBlank()) resolvedTitle = host
        } catch (_: Exception) {
        }

        val existing = load().find { r ->
            r.status == "pending" && (
                r.url == normalized ||
                    (host != null && r.host == host && resolvedMid == null && resolvedBvid == null && resolvedAid == null) ||
                    (resolvedBvid != null && r.bvid == resolvedBvid) ||
                    (resolvedAid != null && r.aid == resolvedAid)
                )
        }
        if (existing != null) return existing

        val req = WatchRequest(
            id = "wr_${UUID.randomUUID().toString().take(10)}",
            url = normalized,
            host = host,
            reason = reason,
            mid = resolvedMid,
            bvid = resolvedBvid,
            aid = resolvedAid,
            title = resolvedTitle,
            status = "pending",
            createdAt = System.currentTimeMillis()
        )
        val all = load().toMutableList()
        all.add(0, req)
        save(all.take(200))
        return req
    }

    /** Electron alias: markApproved. */
    @Synchronized
    fun markApproved(id: String): WatchRequest? = approve(id)

    @Synchronized
    fun approve(id: String): WatchRequest? {
        val all = load().toMutableList()
        val idx = all.indexOfFirst { it.id == id }
        if (idx < 0) return null
        val req = all[idx]
        if (req.status != "pending") return null
        val updated = req.copy(status = "approved", resolvedAt = System.currentTimeMillis())
        all[idx] = updated
        save(all)
        return updated
    }

    @Synchronized
    fun reject(id: String): WatchRequest? {
        val all = load().toMutableList()
        val idx = all.indexOfFirst { it.id == id }
        if (idx < 0) return null
        val req = all[idx]
        if (req.status != "pending") return null
        val updated = req.copy(status = "rejected", resolvedAt = System.currentTimeMillis())
        all[idx] = updated
        save(all)
        return updated
    }

    /** Same host + pathname as any approved request → allow before guard. */
    @Synchronized
    fun isApprovedUrl(url: String): Boolean {
        val target = try {
            URI(url.trim())
        } catch (_: Exception) {
            return false
        }
        val host = target.host?.lowercase() ?: return false
        val path = target.path?.ifEmpty { "/" } ?: "/"
        return load().any { r ->
            if (r.status != "approved") return@any false
            try {
                val u = URI(r.url)
                u.host?.lowercase() == host && (u.path?.ifEmpty { "/" } ?: "/") == path
            } catch (_: Exception) {
                false
            }
        }
    }

    private fun isBiliHost(host: String): Boolean {
        val h = host.lowercase()
        return h == "bilibili.com" || h.endsWith(".bilibili.com")
    }

    private fun load(): List<WatchRequest> {
        val json = prefs.getString(KEY_REQUESTS, null) ?: return emptyList()
        return try {
            val root = JSONObject(json)
            val arr = root.optJSONArray("requests") ?: JSONArray()
            (0 until arr.length()).map { parseRequest(arr.getJSONObject(it)) }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun save(list: List<WatchRequest>) {
        val arr = JSONArray()
        list.forEach { arr.put(toJson(it)) }
        val root = JSONObject().put("version", 1).put("requests", arr)
        prefs.edit().putString(KEY_REQUESTS, root.toString()).apply()
    }

    private fun parseRequest(o: JSONObject) = WatchRequest(
        id = o.optString("id"),
        url = o.optString("url"),
        host = o.optString("host").takeIf { it.isNotBlank() },
        reason = o.optString("reason").takeIf { it.isNotBlank() },
        mid = o.optString("mid").takeIf { it.isNotBlank() },
        bvid = o.optString("bvid").takeIf { it.isNotBlank() },
        aid = o.optString("aid").takeIf { it.isNotBlank() },
        title = o.optString("title").takeIf { it.isNotBlank() },
        status = o.optString("status", "pending"),
        createdAt = o.optLong("createdAt", System.currentTimeMillis()),
        resolvedAt = if (o.has("resolvedAt")) o.optLong("resolvedAt") else null,
        note = o.optString("note").takeIf { it.isNotBlank() }
    )

    private fun toJson(r: WatchRequest): JSONObject {
        val o = JSONObject()
            .put("id", r.id)
            .put("url", r.url)
            .put("status", r.status)
            .put("createdAt", r.createdAt)
        r.host?.let { o.put("host", it) }
        r.reason?.let { o.put("reason", it) }
        r.mid?.let { o.put("mid", it) }
        r.bvid?.let { o.put("bvid", it) }
        r.aid?.let { o.put("aid", it) }
        r.title?.let { o.put("title", it) }
        r.resolvedAt?.let { o.put("resolvedAt", it) }
        r.note?.let { o.put("note", it) }
        return o
    }

    companion object {
        private const val PREFS_NAME = "jianxing_watch_requests"
        private const val KEY_REQUESTS = "requests_json"
    }
}
