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
    private var cached: Snapshot? = null

    @Synchronized
    fun list(query: String = ""): List<HistoryEntry> {
        val q = query.trim().lowercase()
        return load().entries
            .filter { e ->
                q.isEmpty() ||
                    e.title.lowercase().contains(q) ||
                    e.url.lowercase().contains(q) ||
                    e.host.lowercase().contains(q)
            }
            .sortedByDescending { it.visitedAt }
    }

    @Synchronized
    fun count(): Int = load().entries.size

    @Synchronized
    fun getRevision(): Int = load().revision

    @Synchronized
    fun setRevision(revision: Int) {
        val snap = load()
        save(snap.copy(revision = maxOf(0, revision)))
    }

    @Synchronized
    fun exportForSync(): Snapshot = load()

    @Synchronized
    fun mergeFromSync(
        remoteEntries: List<HistoryEntry>,
        remoteDeletedIds: List<String>,
        remoteClearedAt: Long,
        remoteRevision: Int
    ): Boolean {
        val local = load()
        val deleted = pruneDeletedIds(local.deletedIds + remoteDeletedIds)
        val clearedAt = maxOf(local.clearedAt, remoteClearedAt.coerceAtLeast(0L))
        val byId = LinkedHashMap<String, HistoryEntry>()
        for (entry in local.entries + remoteEntries) {
            val normalized = normalize(entry) ?: continue
            if (deleted.contains(normalized.id)) continue
            if (clearedAt > 0 && normalized.visitedAt <= clearedAt) continue
            val prev = byId[normalized.id]
            byId[normalized.id] = if (prev == null) normalized else pickNewer(prev, normalized)
        }
        val merged = byId.values.sortedByDescending { it.visitedAt }.take(MAX_ENTRIES)
        val revision = maxOf(local.revision, remoteRevision.coerceAtLeast(0))
        val next = Snapshot(
            entries = merged,
            deletedIds = deleted,
            clearedAt = clearedAt,
            revision = revision
        )
        val changed = !payloadEqual(local, next)
        save(next)
        return changed
    }

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
        val snap = load()
        val items = snap.entries.toMutableList()
        val lastSame = items.firstOrNull { it.url == href }
        if (lastSame != null && now - lastSame.visitedAt < DEDUPE_MS) {
            val updated = lastSame.copy(
                title = if (pageTitle.isNotBlank() && pageTitle != href) pageTitle else lastSame.title,
                visitedAt = now
            )
            items.removeAll { it.id == lastSame.id }
            items.add(0, updated)
            save(snap.copy(entries = items.take(MAX_ENTRIES)))
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
        save(snap.copy(entries = items.take(MAX_ENTRIES)))
        return entry
    }

    @Synchronized
    fun remove(id: String): Boolean {
        val snap = load()
        val next = snap.entries.filter { it.id != id }
        if (next.size == snap.entries.size) return false
        save(
            snap.copy(
                entries = next,
                deletedIds = pruneDeletedIds(snap.deletedIds + id)
            )
        )
        return true
    }

    @Synchronized
    fun clear() {
        val snap = load()
        save(
            snap.copy(
                entries = emptyList(),
                deletedIds = pruneDeletedIds(snap.deletedIds + snap.entries.map { it.id }),
                clearedAt = System.currentTimeMillis()
            )
        )
    }

    data class Snapshot(
        val entries: List<HistoryEntry>,
        val deletedIds: List<String> = emptyList(),
        val clearedAt: Long = 0L,
        val revision: Int = 0
    )

    private fun load(): Snapshot {
        cached?.let { return it }
        val json = prefs.getString(KEY_ENTRIES, null) ?: return Snapshot(emptyList()).also { cached = it }
        return try {
            val root = JSONObject(json)
            val arr = root.optJSONArray("entries") ?: JSONArray()
            val entries = (0 until arr.length()).mapNotNull { i ->
                normalize(parseEntry(arr.getJSONObject(i)))
            }
            val deletedArr = root.optJSONArray("deletedIds") ?: JSONArray()
            val deleted = (0 until deletedArr.length()).map { deletedArr.optString(it) }
            Snapshot(
                entries = entries,
                deletedIds = pruneDeletedIds(deleted),
                clearedAt = root.optLong("clearedAt", 0L).coerceAtLeast(0L),
                revision = root.optInt("revision", 0).coerceAtLeast(0)
            ).also { cached = it }
        } catch (_: Exception) {
            Snapshot(emptyList()).also { cached = it }
        }
    }

    private fun save(snap: Snapshot) {
        cached = snap
        val arr = JSONArray()
        snap.entries.forEach { arr.put(entryToJson(it)) }
        val deleted = JSONArray()
        snap.deletedIds.forEach { deleted.put(it) }
        prefs.edit()
            .putString(
                KEY_ENTRIES,
                JSONObject()
                    .put("version", 2)
                    .put("revision", snap.revision)
                    .put("clearedAt", snap.clearedAt)
                    .put("deletedIds", deleted)
                    .put("entries", arr)
                    .toString()
            )
            .apply()
    }

    companion object {
        private const val PREFS_NAME = "jianxing_history"
        private const val KEY_ENTRIES = "entries_json"
        private const val MAX_ENTRIES = 2000
        private const val MAX_DELETED_IDS = 3000
        private const val DEDUPE_MS = 2000L

        fun parseEntry(o: JSONObject): HistoryEntry =
            HistoryEntry(
                id = o.optString("id"),
                url = o.optString("url"),
                title = o.optString("title"),
                host = o.optString("host"),
                visitedAt = o.optLong("visitedAt", 0L)
            )

        fun parseEntries(arr: JSONArray): List<HistoryEntry> =
            (0 until arr.length()).mapNotNull { i ->
                try {
                    normalize(parseEntry(arr.getJSONObject(i)))
                } catch (_: Exception) {
                    null
                }
            }

        fun parseDeletedIds(arr: JSONArray?): List<String> {
            if (arr == null) return emptyList()
            return (0 until arr.length()).map { arr.optString(it) }.filter { it.isNotBlank() }
        }

        fun entryToJson(e: HistoryEntry): JSONObject =
            JSONObject()
                .put("id", e.id)
                .put("url", e.url)
                .put("title", e.title)
                .put("host", e.host)
                .put("visitedAt", e.visitedAt)

        fun payloadEqual(a: Snapshot, b: Snapshot): Boolean {
            if (a.clearedAt != b.clearedAt) return false
            if (a.deletedIds.toSet() != b.deletedIds.toSet()) return false
            if (a.entries.size != b.entries.size) return false
            val left = a.entries.sortedBy { it.id }
            val right = b.entries.sortedBy { it.id }
            return left == right
        }

        private fun normalize(raw: HistoryEntry): HistoryEntry? {
            val id = raw.id.trim()
            val url = raw.url.trim()
            if (id.isEmpty()) return null
            if (!url.startsWith("http://") && !url.startsWith("https://")) return null
            val host = raw.host.trim().lowercase().ifBlank {
                try {
                    URI(url).host?.lowercase().orEmpty()
                } catch (_: Exception) {
                    ""
                }
            }
            val title = raw.title.trim().ifBlank { host.ifBlank { url } }
            return raw.copy(id = id, url = url, title = title, host = host)
        }

        private fun pickNewer(a: HistoryEntry, b: HistoryEntry): HistoryEntry {
            if (b.visitedAt != a.visitedAt) {
                return if (b.visitedAt > a.visitedAt) b else a
            }
            val aWeak = a.title.isBlank() || a.title == a.url || a.title == a.host
            val bWeak = b.title.isBlank() || b.title == b.url || b.title == b.host
            if (aWeak && !bWeak) return b
            if (bWeak && !aWeak) return a
            return if (b.title.length >= a.title.length) b else a
        }

        private fun pruneDeletedIds(ids: List<String>): List<String> {
            val unique = ArrayList<String>()
            val seen = HashSet<String>()
            for (i in ids.indices.reversed()) {
                val id = ids[i].trim()
                if (id.isEmpty() || !seen.add(id)) continue
                unique.add(id)
                if (unique.size >= MAX_DELETED_IDS) break
            }
            unique.reverse()
            return unique
        }
    }
}
