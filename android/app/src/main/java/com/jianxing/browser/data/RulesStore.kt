package com.jianxing.browser.data

import android.content.Context
import android.content.SharedPreferences
import com.jianxing.browser.model.BiliConstants
import com.jianxing.browser.model.BilibiliExtensionConfig
import com.jianxing.browser.model.RulesConfig
import com.jianxing.browser.model.SiteGroup
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

class RulesStore(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    @Synchronized
    fun load(): RulesConfig {
        val json = prefs.getString(KEY_RULES, null) ?: return defaultRules()
        return try {
            val config = parseRules(JSONObject(json))
            migrateLegacyPassword(config)
        } catch (_: Exception) {
            defaultRules()
        }
    }

    /** Clear legacy SHA-256 hashes so parent must re-set with scrypt. */
    private fun migrateLegacyPassword(config: RulesConfig): RulesConfig {
        val hash = config.parentPasswordHash
        if (hash.isBlank() || hash.startsWith("scrypt$")) return config
        val isLegacyHex = hash.matches(Regex("^[a-fA-F0-9]{64}$"))
        if (!isLegacyHex && !hash.startsWith("scrypt$")) {
            // Unknown format — clear
            val cleared = config.copy(parentPasswordHash = "")
            save(cleared)
            return cleared
        }
        if (isLegacyHex) {
            val cleared = config.copy(parentPasswordHash = "")
            save(cleared)
            return cleared
        }
        return config
    }

    @Synchronized
    fun save(config: RulesConfig) {
        prefs.edit().putString(KEY_RULES, toJson(config).toString()).apply()
    }

    fun hasPassword(): Boolean = load().parentPasswordHash.isNotBlank()

    fun setPassword(password: String) {
        val rules = load()
        save(rules.copy(parentPasswordHash = PasswordHasher.hash(password)))
    }

    fun verifyPassword(password: String): Boolean {
        val hash = load().parentPasswordHash
        return PasswordHasher.verify(password, hash)
    }

    fun changePassword(current: String, next: String): Boolean {
        if (!verifyPassword(current)) return false
        setPassword(next)
        return true
    }

    // ── Group CRUD (Electron parity) ──

    @Synchronized
    fun createGroup(
        name: String,
        extensionId: String = "none",
        useSuggestedHosts: Boolean = true
    ): SiteGroup? {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return null
        val ext = if (extensionId == "bilibili") "bilibili" else "none"
        val hosts = if (ext == "bilibili" && useSuggestedHosts) {
            BiliConstants.SUGGESTED_HOSTS.toList()
        } else {
            emptyList()
        }
        val group = SiteGroup(
            id = newId(),
            name = trimmed,
            enabled = true,
            hosts = hosts,
            extensionId = ext,
            extensionConfig = defaultExtensionConfig(ext)
        )
        val rules = load()
        save(rules.copy(groups = rules.groups + group))
        return group
    }

    @Synchronized
    fun updateGroup(
        id: String,
        name: String? = null,
        enabled: Boolean? = null,
        extensionId: String? = null
    ): Boolean {
        val rules = load()
        val idx = rules.groups.indexOfFirst { it.id == id }
        if (idx < 0) return false
        var g = rules.groups[idx]
        if (name != null && name.trim().isNotEmpty()) {
            g = g.copy(name = name.trim())
        }
        if (enabled != null) {
            g = g.copy(enabled = enabled)
        }
        if (extensionId == "bilibili" || extensionId == "none") {
            if (extensionId != g.extensionId) {
                g = g.copy(
                    extensionId = extensionId,
                    extensionConfig = defaultExtensionConfig(extensionId)
                )
            }
        }
        val groups = rules.groups.toMutableList()
        groups[idx] = g
        save(rules.copy(groups = groups))
        return true
    }

    @Synchronized
    fun deleteGroup(id: String): Boolean {
        val rules = load()
        val next = rules.groups.filterNot { it.id == id }
        if (next.size == rules.groups.size) return false
        save(rules.copy(groups = next))
        return true
    }

    @Synchronized
    fun setEnabled(id: String, enabled: Boolean): Boolean =
        updateGroup(id, enabled = enabled)

    fun isFilteringEnabled(): Boolean = load().filteringEnabled

    @Synchronized
    fun setFilteringEnabled(enabled: Boolean) {
        save(load().copy(filteringEnabled = enabled))
    }

    fun getHomepage(): String = load().homepage

    @Synchronized
    fun setHomepage(raw: String): Boolean {
        val parsed = normalizeHomepage(raw) ?: return false
        save(load().copy(homepage = parsed))
        return true
    }

    @Synchronized
    fun addHost(groupId: String, host: String): Boolean {
        val cleaned = cleanHost(host)
        if (cleaned.isEmpty()) return false
        val rules = load()
        val idx = rules.groups.indexOfFirst { it.id == groupId }
        if (idx < 0) return false
        val group = rules.groups[idx]
        if (group.hosts.any { it.equals(cleaned, ignoreCase = true) }) return true
        val groups = rules.groups.toMutableList()
        groups[idx] = group.copy(hosts = group.hosts + cleaned)
        save(rules.copy(groups = groups))
        return true
    }

    @Synchronized
    fun removeHost(groupId: String, host: String): Boolean {
        val cleaned = cleanHost(host)
        val rules = load()
        val idx = rules.groups.indexOfFirst { it.id == groupId }
        if (idx < 0) return false
        val group = rules.groups[idx]
        val groups = rules.groups.toMutableList()
        groups[idx] = group.copy(hosts = group.hosts.filterNot { it.equals(cleaned, ignoreCase = true) })
        save(rules.copy(groups = groups))
        return true
    }

    @Synchronized
    fun addBiliUp(groupId: String, mid: String, note: String? = null): Boolean {
        if (!mid.matches(Regex("^\\d+$"))) return false
        val rules = load()
        val idx = rules.groups.indexOfFirst { it.id == groupId }
        if (idx < 0) return false
        val group = rules.groups[idx]
        if (group.extensionId != "bilibili") return false
        val cfg = asBiliConfig(group.extensionConfig)
        val mids = if (cfg.allowedMids.contains(mid)) cfg.allowedMids else cfg.allowedMids + mid
        val notes = cfg.midNotes.toMutableMap()
        if (!note.isNullOrBlank()) notes[mid] = note
        val ext = mutableMapOf<String, Any?>(
            "allowedMids" to mids,
            "midNotes" to notes
        )
        val groups = rules.groups.toMutableList()
        groups[idx] = group.copy(extensionConfig = ext)
        save(rules.copy(groups = groups))
        return true
    }

    @Synchronized
    fun removeBiliUp(groupId: String, mid: String): Boolean {
        val rules = load()
        val idx = rules.groups.indexOfFirst { it.id == groupId }
        if (idx < 0) return false
        val group = rules.groups[idx]
        if (group.extensionId != "bilibili") return false
        val cfg = asBiliConfig(group.extensionConfig)
        val mids = cfg.allowedMids.filterNot { it == mid }
        val notes = cfg.midNotes.toMutableMap().apply { remove(mid) }
        val ext = mutableMapOf<String, Any?>(
            "allowedMids" to mids,
            "midNotes" to notes
        )
        val groups = rules.groups.toMutableList()
        groups[idx] = group.copy(extensionConfig = ext)
        save(rules.copy(groups = groups))
        return true
    }

    fun exportGroups(): List<SiteGroup> =
        load().groups.map { g ->
            g.copy(
                hosts = g.hosts.toList(),
                extensionConfig = g.extensionConfig.toMap()
            )
        }

    fun getGroup(id: String): SiteGroup? = load().groups.find { it.id == id }

    // ── Request-group helpers (kept) ──

    fun ensureDefaultRequestGroup() {
        val rules = load()
        val existing = rules.groups.find {
            it.name == BiliConstants.REQUEST_GROUP_NAME && it.extensionId == "none"
        }
        if (existing != null) return
        createGroup(
            name = BiliConstants.REQUEST_GROUP_NAME,
            extensionId = "none",
            useSuggestedHosts = false
        )
    }

    fun getOrCreateRequestGroup(): SiteGroup {
        ensureDefaultRequestGroup()
        return load().groups.first {
            it.name == BiliConstants.REQUEST_GROUP_NAME && it.extensionId == "none"
        }
    }

    fun addHostToRequestGroup(host: String): Boolean {
        val group = getOrCreateRequestGroup()
        return addHost(group.id, host)
    }

    fun removeHostFromRequestGroup(host: String) {
        val group = load().groups.find {
            it.name == BiliConstants.REQUEST_GROUP_NAME && it.extensionId == "none"
        } ?: return
        removeHost(group.id, host)
    }

    fun replaceGroups(groups: List<SiteGroup>) {
        val rules = load()
        val merged = groups.toMutableList()
        if (merged.none { it.name == BiliConstants.REQUEST_GROUP_NAME && it.extensionId == "none" }) {
            val local = rules.groups.find {
                it.name == BiliConstants.REQUEST_GROUP_NAME && it.extensionId == "none"
            }
            if (local != null) merged.add(local)
            else merged.add(
                SiteGroup(
                    id = newId(),
                    name = BiliConstants.REQUEST_GROUP_NAME,
                    enabled = true,
                    hosts = emptyList(),
                    extensionId = "none"
                )
            )
        }
        save(rules.copy(groups = merged))
    }

    companion object {
        private const val PREFS_NAME = "jianxing_rules"
        private const val KEY_RULES = "rules_json"

        fun newId(): String = "g_${UUID.randomUUID().toString().take(12)}"

        fun cleanHost(host: String): String {
            return host.trim().lowercase()
                .removePrefix("https://")
                .removePrefix("http://")
                .substringBefore('/')
                .trimEnd('.')
        }

        fun defaultExtensionConfig(extensionId: String): Map<String, Any?> {
            return if (extensionId == "bilibili") {
                mapOf(
                    "allowedMids" to emptyList<String>(),
                    "midNotes" to emptyMap<String, String>()
                )
            } else {
                emptyMap()
            }
        }

        fun asBiliConfig(raw: Map<String, Any?>?): BilibiliExtensionConfig {
            val midsRaw = raw?.get("allowedMids")
            val mids = when (midsRaw) {
                is List<*> -> midsRaw.map { it.toString() }.filter { it.matches(Regex("^\\d+$")) }
                is JSONArray -> (0 until midsRaw.length()).map { midsRaw.getString(it) }
                    .filter { it.matches(Regex("^\\d+$")) }
                else -> emptyList()
            }
            val notesRaw = raw?.get("midNotes")
            val notes = mutableMapOf<String, String>()
            when (notesRaw) {
                is Map<*, *> -> notesRaw.forEach { (k, v) ->
                    if (k != null && v != null) notes[k.toString()] = v.toString()
                }
                is JSONObject -> notesRaw.keys().forEach { k ->
                    notes[k] = notesRaw.optString(k, "")
                }
            }
            return BilibiliExtensionConfig(allowedMids = mids, midNotes = notes)
        }

        fun normalizeHomepage(raw: String): String? {
            val s = raw.trim()
            if (s.isEmpty()) return ""
            var url = s
            if (!Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:").containsMatchIn(url)) {
                url = "https://$url"
            }
            return try {
                val uri = android.net.Uri.parse(url)
                val scheme = uri.scheme?.lowercase()
                if (scheme != "http" && scheme != "https") null
                else uri.toString()
            } catch (_: Exception) {
                null
            }
        }

        private fun defaultRules() = RulesConfig(
            version = 2,
            parentPasswordHash = "",
            filteringEnabled = false,
            homepage = "",
            groups = emptyList()
        )

        private fun parseRules(obj: JSONObject): RulesConfig {
            val groupsArr = obj.optJSONArray("groups") ?: JSONArray()
            val groups = mutableListOf<SiteGroup>()
            for (i in 0 until groupsArr.length()) {
                normalizeGroup(groupsArr.getJSONObject(i))?.let { groups.add(it) }
            }
            return RulesConfig(
                version = obj.optInt("version", 2),
                parentPasswordHash = obj.optString("parentPasswordHash", ""),
                filteringEnabled = obj.optBoolean("filteringEnabled", false),
                homepage = normalizeHomepage(obj.optString("homepage", "")) ?: "",
                groups = groups
            )
        }

        private fun normalizeGroup(obj: JSONObject): SiteGroup? {
            val extensionId = if (obj.optString("extensionId") == "bilibili") "bilibili" else "none"
            val hostsArr = obj.optJSONArray("hosts") ?: JSONArray()
            val hosts = (0 until hostsArr.length())
                .map { cleanHost(hostsArr.getString(it)) }
                .filter { it.isNotEmpty() }
                .distinct()
            val extObj = obj.optJSONObject("extensionConfig")
            val extMap = mutableMapOf<String, Any?>()
            if (extObj != null) {
                extObj.keys().forEach { key ->
                    extMap[key] = extObj.get(key)
                }
            }
            if (extensionId == "bilibili" && !extMap.containsKey("allowedMids")) {
                extMap["allowedMids"] = emptyList<String>()
                extMap["midNotes"] = emptyMap<String, String>()
            }
            return SiteGroup(
                id = obj.optString("id").ifBlank { newId() },
                name = obj.optString("name").ifBlank { "未命名配置组" },
                enabled = obj.optBoolean("enabled", true),
                hosts = hosts,
                extensionId = extensionId,
                extensionConfig = extMap
            )
        }

        fun toJson(config: RulesConfig): JSONObject {
            val groups = JSONArray()
            config.groups.forEach { g ->
                groups.put(groupToJson(g))
            }
            return JSONObject()
                .put("version", config.version)
                .put("parentPasswordHash", config.parentPasswordHash)
                .put("filteringEnabled", config.filteringEnabled)
                .put("homepage", config.homepage)
                .put("groups", groups)
        }

        fun groupToJson(g: SiteGroup): JSONObject {
            val hosts = JSONArray()
            g.hosts.forEach { hosts.put(it) }
            val ext = JSONObject()
            g.extensionConfig.forEach { (k, v) ->
                when (v) {
                    is List<*> -> {
                        val arr = JSONArray()
                        v.forEach { arr.put(it) }
                        ext.put(k, arr)
                    }
                    is Map<*, *> -> {
                        val o = JSONObject()
                        v.forEach { (mk, mv) -> o.put(mk.toString(), mv) }
                        ext.put(k, o)
                    }
                    is JSONArray -> ext.put(k, v)
                    is JSONObject -> ext.put(k, v)
                    null -> {}
                    else -> ext.put(k, v)
                }
            }
            return JSONObject()
                .put("id", g.id)
                .put("name", g.name)
                .put("enabled", g.enabled)
                .put("hosts", hosts)
                .put("extensionId", g.extensionId)
                .put("extensionConfig", ext)
        }

        fun parseGroupsFromJson(arr: JSONArray): List<SiteGroup> {
            val list = mutableListOf<SiteGroup>()
            for (i in 0 until arr.length()) {
                normalizeGroup(arr.getJSONObject(i))?.let { list.add(it) }
            }
            return list
        }
    }
}
