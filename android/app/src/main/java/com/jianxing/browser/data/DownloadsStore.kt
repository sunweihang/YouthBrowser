package com.jianxing.browser.data

import android.content.Context
import android.content.SharedPreferences
import com.jianxing.browser.model.DownloadEntry
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

class DownloadsStore(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    @Synchronized
    fun list(query: String = ""): List<DownloadEntry> {
        val q = query.trim().lowercase()
        return load()
            .filter { e ->
                q.isEmpty() ||
                    e.filename.lowercase().contains(q) ||
                    e.url.lowercase().contains(q)
            }
            .sortedByDescending { it.startedAt }
    }

    @Synchronized
    fun add(entry: DownloadEntry): DownloadEntry {
        val items = load().toMutableList()
        items.add(0, entry)
        save(items.take(MAX_ENTRIES))
        return entry
    }

    @Synchronized
    fun update(id: String, patch: (DownloadEntry) -> DownloadEntry): DownloadEntry? {
        val items = load().toMutableList()
        val idx = items.indexOfFirst { it.id == id }
        if (idx < 0) return null
        val next = patch(items[idx])
        items[idx] = next
        save(items)
        return next
    }

    @Synchronized
    fun findBySystemId(systemId: Long): DownloadEntry? =
        load().firstOrNull { it.systemId == systemId }

    @Synchronized
    fun remove(id: String): Boolean {
        val items = load()
        val next = items.filter { it.id != id }
        if (next.size == items.size) return false
        save(next)
        return true
    }

    @Synchronized
    fun clear() {
        save(load().filter { it.state == "progressing" })
    }

    @Synchronized
    fun newId(): String = "d_${UUID.randomUUID().toString().replace("-", "").take(12)}"

    private fun load(): List<DownloadEntry> {
        val json = prefs.getString(KEY_ENTRIES, null) ?: return emptyList()
        return try {
            val root = JSONObject(json)
            val arr = root.optJSONArray("entries") ?: JSONArray()
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                DownloadEntry(
                    id = o.optString("id"),
                    url = o.optString("url"),
                    filename = o.optString("filename"),
                    filePath = o.optString("filePath"),
                    mime = o.optString("mime"),
                    state = o.optString("state", "completed"),
                    receivedBytes = o.optLong("receivedBytes"),
                    totalBytes = o.optLong("totalBytes"),
                    startedAt = o.optLong("startedAt", System.currentTimeMillis()),
                    endedAt = if (o.has("endedAt") && !o.isNull("endedAt")) o.optLong("endedAt") else null,
                    systemId = o.optLong("systemId", -1)
                )
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun save(list: List<DownloadEntry>) {
        val arr = JSONArray()
        list.forEach { e ->
            arr.put(
                JSONObject()
                    .put("id", e.id)
                    .put("url", e.url)
                    .put("filename", e.filename)
                    .put("filePath", e.filePath)
                    .put("mime", e.mime)
                    .put("state", e.state)
                    .put("receivedBytes", e.receivedBytes)
                    .put("totalBytes", e.totalBytes)
                    .put("startedAt", e.startedAt)
                    .put("endedAt", e.endedAt)
                    .put("systemId", e.systemId)
            )
        }
        prefs.edit()
            .putString(KEY_ENTRIES, JSONObject().put("version", 1).put("entries", arr).toString())
            .apply()
    }

    companion object {
        private const val PREFS_NAME = "jianxing_downloads"
        private const val KEY_ENTRIES = "entries_json"
        private const val MAX_ENTRIES = 500
    }
}
