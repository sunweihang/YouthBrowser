package com.jianxing.browser.data

import android.content.Context
import android.content.SharedPreferences
import com.jianxing.browser.model.HistoryEntry
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.util.UUID

class HistoryStore(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    @Synchronized
    fun list(query: String = ""): List<HistoryEntry> {
        val q = query.trim().lowercase()
        return load()
            .filter { e ->
                q.isEmpty() ||
                    e.title.lowercase().contains(q) ||
                    e.url.lowercase().contains(q) ||
                    e.host.lowercase().contains(q)
            }
            .sortedByDescending { it.visitedAt }
    }

    @Synchronized
    fun count(): Int = load().size

    @Synchronized
    fun record(url: String, title: String?): HistoryEntry? {
        val href = url.trim()
        if (!href.startsWith("http://") && !href.startsWith("https://")) return null
        val now = System.currentTimeMillis()
        val host = try {
            URI(href).host?.lowercase().orEmpty()
        } catch (_: Exception) {
            ""
        }
        val pageTitle = title?.trim().orEmpty().ifBlank { host.ifBlank { href } }
        val items = load().toMutableList()
        val last = items.firstOrNull()
        if (last != null && last.url == href && now - last.visitedAt < DEDUPE_MS) {
            val updated = last.copy(
                title = if (pageTitle.isNotBlank() && pageTitle != href) pageTitle else last.title,
                visitedAt = now
            )
            items[0] = updated
            save(items)
            return updated
        }
        val entry = HistoryEntry(
            id = "h_${UUID.randomUUID().toString().replace("-", "").take(12)}",
            url = href,
            title = pageTitle,
            host = host,
            visitedAt = now
        )
        items.add(0, entry)
        save(items.take(MAX_ENTRIES))
        return entry
    }

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
        save(emptyList())
    }

    private fun load(): List<HistoryEntry> {
        val json = prefs.getString(KEY_ENTRIES, null) ?: return emptyList()
        return try {
            val root = JSONObject(json)
            val arr = root.optJSONArray("entries") ?: JSONArray()
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                HistoryEntry(
                    id = o.optString("id"),
                    url = o.optString("url"),
                    title = o.optString("title"),
                    host = o.optString("host"),
                    visitedAt = o.optLong("visitedAt", System.currentTimeMillis())
                )
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun save(list: List<HistoryEntry>) {
        val arr = JSONArray()
        list.forEach { e ->
            arr.put(
                JSONObject()
                    .put("id", e.id)
                    .put("url", e.url)
                    .put("title", e.title)
                    .put("host", e.host)
                    .put("visitedAt", e.visitedAt)
            )
        }
        prefs.edit()
            .putString(KEY_ENTRIES, JSONObject().put("version", 1).put("entries", arr).toString())
            .apply()
    }

    companion object {
        private const val PREFS_NAME = "jianxing_history"
        private const val KEY_ENTRIES = "entries_json"
        private const val MAX_ENTRIES = 2000
        private const val DEDUPE_MS = 2000L
    }
}
