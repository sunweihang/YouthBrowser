package com.jianxing.browser.data

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

data class SitePasswordEntry(
    val id: String,
    val origin: String,
    val host: String,
    val username: String,
    val password: String,
    val updatedAt: Long
)

class SitePasswordsStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Synchronized
    fun list(): List<SitePasswordEntry> {
        val arr = JSONArray(prefs.getString(KEY, "[]"))
        val out = mutableListOf<SitePasswordEntry>()
        for (i in 0 until arr.length()) {
            parse(arr.getJSONObject(i))?.let { out.add(it) }
        }
        return out.sortedByDescending { it.updatedAt }
    }

    fun lookup(origin: String): SitePasswordEntry? =
        list().firstOrNull { it.origin == origin }

    fun find(origin: String, username: String): SitePasswordEntry? =
        list().firstOrNull { it.origin == origin && it.username == username }

    @Synchronized
    fun save(origin: String, username: String, password: String): Boolean {
        val user = username.trim()
        if (origin.isBlank() || user.isBlank() || password.isBlank()) return false
        val host = try {
            android.net.Uri.parse(origin).host.orEmpty().lowercase()
        } catch (_: Exception) {
            ""
        }
        val now = System.currentTimeMillis()
        val items = list().toMutableList()
        val idx = items.indexOfFirst { it.origin == origin && it.username == user }
        val row = SitePasswordEntry(
            id = if (idx >= 0) items[idx].id else newId(),
            origin = origin,
            host = host,
            username = user,
            password = password,
            updatedAt = now
        )
        if (idx >= 0) items[idx] = row else items.add(row)
        persist(items)
        return true
    }

    @Synchronized
    fun remove(id: String): Boolean {
        val items = list()
        val next = items.filterNot { it.id == id }
        if (next.size == items.size) return false
        persist(next)
        return true
    }

    private fun persist(items: List<SitePasswordEntry>) {
        val arr = JSONArray()
        items.forEach { e ->
            arr.put(
                JSONObject()
                    .put("id", e.id)
                    .put("origin", e.origin)
                    .put("host", e.host)
                    .put("username", e.username)
                    .put("secret", encode(e.password))
                    .put("updatedAt", e.updatedAt)
            )
        }
        prefs.edit().putString(KEY, arr.toString()).apply()
    }

    private fun parse(obj: JSONObject): SitePasswordEntry? {
        val password = decode(obj.optString("secret"))
        val origin = obj.optString("origin")
        if (origin.isBlank() || password.isBlank()) return null
        return SitePasswordEntry(
            id = obj.optString("id").ifBlank { newId() },
            origin = origin,
            host = obj.optString("host"),
            username = obj.optString("username"),
            password = password,
            updatedAt = obj.optLong("updatedAt")
        )
    }

    companion object {
        private const val PREFS = "jianxing_site_passwords"
        private const val KEY = "entries"

        private fun newId(): String = "p_${UUID.randomUUID().toString().take(12)}"

        private fun encode(value: String): String =
            Base64.encodeToString(value.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)

        private fun decode(value: String): String = try {
            String(Base64.decode(value, Base64.NO_WRAP), Charsets.UTF_8)
        } catch (_: Exception) {
            ""
        }
    }
}
