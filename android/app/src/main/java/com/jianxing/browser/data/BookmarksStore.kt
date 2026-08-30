package com.jianxing.browser.data

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

data class BookmarkNode(
    val id: String,
    val type: String, // "bookmark" | "folder"
    val title: String,
    val url: String? = null,
    val parentId: String,
    val createdAt: Long,
    val order: Int
)

/**
 * Electron bookmarks-store tree: toolbar / other roots, SharedPreferences JSON.
 */
class BookmarksStore(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private var nodes: MutableList<BookmarkNode> = mutableListOf()
    private var revision: Int = 0

    init {
        nodes = load().toMutableList()
    }

    fun getRevision(): Int = revision

    fun setRevision(rev: Int) {
        revision = maxOf(0, rev)
        persist()
    }

    fun listToolbarBookmarks(): List<BookmarkNode> =
        childrenOf(TOOLBAR_ID).filter { it.type == "bookmark" }

    fun listAllBookmarks(): List<BookmarkNode> =
        nodes.filter { it.type == "bookmark" }
            .sortedWith(compareByDescending { it.createdAt })

    fun removeBookmark(id: String): Boolean = remove(id)

    fun isBookmarked(url: String): Boolean = findByUrl(url) != null

    fun toggle(url: String, title: String): Boolean {
        val existing = findByUrl(url)
        return if (existing != null) {
            remove(existing.id)
            false
        } else {
            addBookmark(title, url, TOOLBAR_ID)
            true
        }
    }

    fun exportForSync(): List<BookmarkNode> = nodes.map { it.copy() }

    fun replaceFromSync(rawNodes: List<Map<String, Any?>>, rev: Int? = null) {
        val normalized = rawNodes.mapNotNull { normalizeNode(it) }.toMutableList()
        nodes = ensureRoots(normalized).toMutableList()
        if (rev != null && rev >= 0) revision = rev
        persist()
    }

    fun replaceFromJson(arr: JSONArray, rev: Int? = null) {
        val list = mutableListOf<Map<String, Any?>>()
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            val map = mutableMapOf<String, Any?>()
            o.keys().forEach { k -> map[k] = o.get(k) }
            list.add(map)
        }
        replaceFromSync(list, rev)
    }

    private fun addBookmark(title: String, url: String, parentId: String): BookmarkNode? {
        val cleaned = url.trim()
        if (!cleaned.startsWith("http://") && !cleaned.startsWith("https://")) return null
        findByUrl(cleaned)?.let { return it }
        val node = BookmarkNode(
            id = newId("bm"),
            type = "bookmark",
            title = title.trim().ifBlank { cleaned },
            url = cleaned,
            parentId = parentId,
            createdAt = System.currentTimeMillis(),
            order = nextOrder(parentId)
        )
        nodes.add(node)
        persist()
        return node
    }

    private fun remove(id: String): Boolean {
        if (id == TOOLBAR_ID || id == OTHER_ID) return false
        val node = nodes.find { it.id == id } ?: return false
        val toDelete = mutableSetOf(id)
        if (node.type == "folder") {
            var changed = true
            while (changed) {
                changed = false
                for (n in nodes) {
                    if (n.parentId in toDelete && n.id !in toDelete) {
                        toDelete.add(n.id)
                        changed = true
                    }
                }
            }
        }
        nodes = nodes.filterNot { it.id in toDelete }.toMutableList()
        persist()
        return true
    }

    private fun findByUrl(url: String): BookmarkNode? {
        val normalized = normalizeUrl(url)
        return nodes.find {
            it.type == "bookmark" && it.url != null && normalizeUrl(it.url) == normalized
        }
    }

    private fun childrenOf(parentId: String): List<BookmarkNode> =
        nodes.filter { it.parentId == parentId }
            .sortedWith(compareBy({ it.order }, { it.createdAt }))

    private fun nextOrder(parentId: String): Int {
        val kids = childrenOf(parentId)
        return if (kids.isEmpty()) 0 else kids.maxOf { it.order } + 1
    }

    private fun load(): List<BookmarkNode> {
        val json = prefs.getString(KEY_BOOKMARKS, null) ?: return seedRoots()
        return try {
            val root = JSONObject(json)
            revision = root.optInt("revision", 0).coerceAtLeast(0)
            if (root.has("nodes")) {
                val arr = root.getJSONArray("nodes")
                val list = mutableListOf<BookmarkNode>()
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    val map = mutableMapOf<String, Any?>()
                    o.keys().forEach { k -> map[k] = o.get(k) }
                    normalizeNode(map)?.let { list.add(it) }
                }
                ensureRoots(list)
            } else {
                seedRoots()
            }
        } catch (_: Exception) {
            seedRoots()
        }
    }

    private fun persist() {
        val arr = JSONArray()
        nodes.forEach { n ->
            val o = JSONObject()
                .put("id", n.id)
                .put("type", n.type)
                .put("title", n.title)
                .put("parentId", n.parentId)
                .put("createdAt", n.createdAt)
                .put("order", n.order)
            n.url?.let { o.put("url", it) }
            arr.put(o)
        }
        val root = JSONObject()
            .put("version", 2)
            .put("revision", revision)
            .put("nodes", arr)
        prefs.edit().putString(KEY_BOOKMARKS, root.toString()).apply()
    }

    private fun normalizeNode(raw: Map<String, Any?>): BookmarkNode? {
        val type = if (raw["type"]?.toString() == "folder") "folder" else "bookmark"
        val id = raw["id"]?.toString()?.takeIf { it.isNotBlank() }
            ?: newId(if (type == "folder") "fld" else "bm")
        if (type == "bookmark") {
            val url = raw["url"]?.toString() ?: return null
            if (!url.startsWith("http")) return null
        }
        return BookmarkNode(
            id = id,
            type = type,
            title = raw["title"]?.toString()?.trim()?.takeIf { it.isNotEmpty() }
                ?: if (type == "folder") "新建文件夹" else (raw["url"]?.toString() ?: "未命名"),
            url = if (type == "bookmark") raw["url"]?.toString() else null,
            parentId = when {
                id == TOOLBAR_ID || id == OTHER_ID -> ""
                else -> raw["parentId"]?.toString() ?: TOOLBAR_ID
            },
            createdAt = (raw["createdAt"] as? Number)?.toLong() ?: System.currentTimeMillis(),
            order = (raw["order"] as? Number)?.toInt() ?: 0
        )
    }

    private fun seedRoots(extra: List<BookmarkNode> = emptyList()): List<BookmarkNode> =
        listOf(
            BookmarkNode(TOOLBAR_ID, "folder", "书签工具栏", null, "", 0, 0),
            BookmarkNode(OTHER_ID, "folder", "其他书签", null, "", 0, 1)
        ) + extra

    private fun ensureRoots(list: List<BookmarkNode>): List<BookmarkNode> {
        var next = list.toMutableList()
        val hasToolbar = next.any { it.id == TOOLBAR_ID }
        val hasOther = next.any { it.id == OTHER_ID }
        if (!hasToolbar || !hasOther) {
            next = seedRoots(
                next.filter { it.id != TOOLBAR_ID && it.id != OTHER_ID }
            ).toMutableList()
        }
        next = next.map { n ->
            if (n.id == TOOLBAR_ID || n.id == OTHER_ID) {
                n.copy(
                    type = "folder",
                    parentId = "",
                    title = if (n.id == TOOLBAR_ID) "书签工具栏" else "其他书签"
                )
            } else n
        }.toMutableList()
        return next
    }

    private fun normalizeUrl(url: String): String {
        return try {
            val u = java.net.URI(url)
            // drop fragment
            java.net.URI(u.scheme, u.authority, u.path, u.query, null).toString()
        } catch (_: Exception) {
            url.trim()
        }
    }

    private fun newId(prefix: String): String =
        "${prefix}_${System.currentTimeMillis().toString(36)}_${UUID.randomUUID().toString().take(6)}"

    fun toSyncJsonArray(): JSONArray {
        val arr = JSONArray()
        exportForSync().forEach { n ->
            val o = JSONObject()
                .put("id", n.id)
                .put("type", n.type)
                .put("title", n.title)
                .put("parentId", n.parentId)
                .put("createdAt", n.createdAt)
                .put("order", n.order)
            n.url?.let { o.put("url", it) }
            arr.put(o)
        }
        return arr
    }

    companion object {
        const val TOOLBAR_ID = "toolbar"
        const val OTHER_ID = "other"
        private const val PREFS_NAME = "jianxing_bookmarks"
        private const val KEY_BOOKMARKS = "bookmarks_json"
    }
}
