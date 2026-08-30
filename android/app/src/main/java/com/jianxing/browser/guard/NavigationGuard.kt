package com.jianxing.browser.guard

import com.jianxing.browser.data.RulesStore
import com.jianxing.browser.model.BiliConstants
import com.jianxing.browser.model.BlockReason
import com.jianxing.browser.model.NavigateResult
import com.jianxing.browser.model.RulesConfig
import com.jianxing.browser.model.SiteGroup
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

/**
 * Navigation guard mirroring Electron logic (simplified for Android WebView).
 *
 * Bilibili: empty allowedMids blocks video/space (only home + search).
 * Non-empty: resolve mid via API when possible; if resolve fails on video pages,
 * deny with bili_resolve_failed (safer parental default).
 */
object NavigationGuard {

    fun normalizeHost(host: String): String =
        host.trim().lowercase().trimEnd('.')

    fun isBiliFamilyHost(host: String): Boolean {
        val h = normalizeHost(host)
        return BiliConstants.HOST_SUFFIXES.any { suffix ->
            h == suffix || h.endsWith(".$suffix")
        }
    }

    fun hostAllowed(host: String, allowedHosts: List<String>): Boolean {
        val h = normalizeHost(host)
        for (raw in allowedHosts) {
            val rule = normalizeHost(raw)
            if (rule.isEmpty()) continue
            if (rule.startsWith("*.")) {
                val suffix = rule.removePrefix("*.")
                if (h == suffix || h.endsWith(".$suffix")) return true
            } else if (h == rule) {
                return true
            }
        }
        return false
    }

    private fun matchingGroups(host: String, rules: RulesConfig): List<SiteGroup> =
        rules.groups.filter { it.enabled && hostAllowed(host, it.hosts) }

    private fun hasEnabledBiliExtension(rules: RulesConfig): Boolean =
        rules.groups.any { it.enabled && it.extensionId == "bilibili" }

    private fun biliMidsFromGroups(groups: List<SiteGroup>): List<String> {
        val mids = linkedSetOf<String>()
        for (g in groups) {
            if (g.extensionId != "bilibili") continue
            RulesStore.asBiliConfig(g.extensionConfig).allowedMids.forEach { mids.add(it) }
        }
        return mids.toList()
    }

    private val staticAssetHosts = listOf(
        "hdslb.com", "bilivideo.com", "akamaized.net", "api.bilibili.com"
    )

    private fun isBiliStaticOrApi(host: String): Boolean {
        val h = normalizeHost(host)
        return staticAssetHosts.any { suffix -> h == suffix || h.endsWith(".$suffix") }
    }

    private fun deny(
        reason: BlockReason,
        message: String,
        mid: String? = null,
        bvid: String? = null,
        aid: String? = null,
        title: String? = null
    ) = NavigateResult(
        allowed = false,
        reason = reason,
        message = message,
        mid = mid,
        bvid = bvid,
        aid = aid,
        title = title
    )

    private fun allow(finalUrl: String) = NavigateResult(allowed = true, finalUrl = finalUrl)

    private fun isAllowedBiliPath(pathname: String): String? {
        if (pathname.startsWith("/bfs/") || pathname.startsWith("/favicon") || pathname == "/robots.txt") {
            return "asset"
        }
        if (pathname == "/" || pathname.isEmpty()) return "home"
        if (pathname == "/search" || pathname.startsWith("/search/") ||
            pathname == "/s" || pathname.startsWith("/s/")
        ) {
            return "search"
        }
        if (Regex("/video/(BV[\\w]+|av\\d+)", RegexOption.IGNORE_CASE).containsMatchIn(pathname)) {
            return "video"
        }
        if (Regex("^/space/\\d+(?:/|$)", RegexOption.IGNORE_CASE).containsMatchIn(pathname)) {
            return "space"
        }
        if (Regex("^/\\d+(?:/|$)").containsMatchIn(pathname)) return "space"
        return null
    }

    private fun isBiliSearchHost(host: String): Boolean {
        val h = normalizeHost(host)
        return h == "search.bilibili.com" || h.endsWith(".search.bilibili.com")
    }

    private fun enforceBilibili(
        url: URI,
        host: String,
        allowedMids: List<String>
    ): NavigateResult {
        val pathname = url.path?.ifEmpty { "/" } ?: "/"
        val urlStr = url.toString()

        if (isBiliStaticOrApi(host) &&
            !host.contains("www.bilibili") &&
            !host.contains("m.bilibili") &&
            !host.contains("space.bilibili")
        ) {
            return allow(urlStr)
        }

        if (host == "space.bilibili.com" || host.endsWith(".space.bilibili.com")) {
            val mid = BiliResolver.parseSpaceMid(pathname)
                ?: return deny(BlockReason.BILI_PATH_DENIED, "仅允许打开指定 UP 的空间主页")
            if (!allowedMids.contains(mid)) {
                return deny(BlockReason.BILI_UP_DENIED, "UP $mid 不在允许列表", mid = mid)
            }
            return allow(urlStr)
        }

        if (host == "www.bilibili.com" || host == "m.bilibili.com" || host.endsWith(".bilibili.com")) {
            when (isAllowedBiliPath(pathname)) {
                "asset", "search", "home" -> return allow(urlStr)
                "video" -> {
                    // Empty mid list → block videos (mirror Electron)
                    if (allowedMids.isEmpty()) {
                        return deny(
                            BlockReason.BILI_UP_DENIED,
                            "未配置允许的 UP，视频不可访问"
                        )
                    }
                    val ids = BiliResolver.parseBiliVideoId(pathname)
                        ?: return deny(BlockReason.BILI_PATH_DENIED, "无法识别视频 ID")
                    val owner = BiliResolver.resolveVideoOwner(ids.bvid, ids.aid)
                    if (!owner.ok || owner.mid.isNullOrBlank()) {
                        // v1: if API unavailable, deny rather than open all videos
                        return deny(
                            BlockReason.BILI_RESOLVE_FAILED,
                            owner.error ?: "无法确认该视频的 UP 主",
                            bvid = ids.bvid,
                            aid = ids.aid
                        )
                    }
                    if (!allowedMids.contains(owner.mid)) {
                        return deny(
                            BlockReason.BILI_UP_DENIED,
                            "该视频属于 UP ${owner.mid}，不在允许列表",
                            mid = owner.mid,
                            bvid = ids.bvid,
                            aid = ids.aid,
                            title = owner.title
                        )
                    }
                    return allow(urlStr)
                }
                "space" -> {
                    val mid = BiliResolver.parseSpaceMid(pathname)
                    if (mid != null && allowedMids.contains(mid)) return allow(urlStr)
                    if (mid != null) {
                        return deny(BlockReason.BILI_UP_DENIED, "UP $mid 不在允许列表", mid = mid)
                    }
                }
            }
            return deny(
                BlockReason.BILI_PATH_DENIED,
                "B 站已在策略中，但该路径未开放：请用首页/搜索，或点「申请访问」"
            )
        }

        return deny(BlockReason.BILI_PATH_DENIED, "B 站该域名路径未授权")
    }

    fun isDownloadAllowed(rawUrl: String, rules: RulesConfig): Boolean {
        val href = rawUrl.trim()
        if (href.isEmpty()) return false
        if (href.startsWith("blob:") || href.startsWith("data:")) return true
        val url = try {
            URI(href)
        } catch (_: Exception) {
            return false
        }
        val protocol = url.scheme?.lowercase()
        if (protocol != "http" && protocol != "https") return false
        if (!rules.filteringEnabled) return true
        val host = normalizeHost(url.host ?: "")
        if (host.isEmpty()) return false
        if (isBiliSearchHost(host) && hasEnabledBiliExtension(rules)) return true
        if (isBiliStaticOrApi(host) && hasEnabledBiliExtension(rules)) return true
        return matchingGroups(host, rules).isNotEmpty()
    }

    fun canNavigate(rawUrl: String, rules: RulesConfig): NavigateResult {
        var urlString = rawUrl.trim()
        if (urlString.isEmpty()) return deny(BlockReason.INVALID_URL, "地址为空")

        // Allow in-app / asset / about schemes used by WebView
        if (urlString.startsWith("file:") ||
            urlString.startsWith("about:") ||
            urlString.startsWith("data:") ||
            urlString.startsWith("javascript:")
        ) {
            return allow(urlString)
        }

        if (!Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:").containsMatchIn(urlString)) {
            val looksLikeIp = Regex("^(\\d{1,3}\\.){3}\\d{1,3}([/:?]|$)").containsMatchIn(urlString)
            urlString = "${if (looksLikeIp) "http" else "https"}://$urlString"
        }

        val url = try {
            URI(urlString)
        } catch (_: Exception) {
            return deny(BlockReason.INVALID_URL, "无法解析的网址")
        }

        val protocol = url.scheme?.lowercase()
        if (protocol != "http" && protocol != "https") {
            return deny(BlockReason.PROTOCOL_DENIED, "仅允许 http/https")
        }

        if (!rules.filteringEnabled) {
            return allow(urlString)
        }

        var host = normalizeHost(url.host ?: "")
        if (host.isEmpty()) return deny(BlockReason.INVALID_URL, "无法解析的网址")

        var workingUrl = url
        if (host == "b23.tv" || host == "www.b23.tv") {
            val final = BiliResolver.resolveShortUrl(url.toString())
            try {
                workingUrl = URI(final)
                host = normalizeHost(workingUrl.host ?: "")
            } catch (_: Exception) {
                return deny(BlockReason.INVALID_URL, "短链解析失败")
            }
        }

        if (isBiliSearchHost(host) && hasEnabledBiliExtension(rules)) {
            return allow(workingUrl.toString())
        }

        if (isBiliStaticOrApi(host) && hasEnabledBiliExtension(rules)) {
            val matched = matchingGroups(host, rules)
            val anyBili = rules.groups.filter { it.enabled && it.extensionId == "bilibili" }
            val covered = anyBili.any { hostAllowed(host, it.hosts) }
            if (covered || matched.isNotEmpty() || isBiliFamilyHost(host)) {
                if (covered || matched.isNotEmpty()) {
                    return allow(workingUrl.toString())
                }
            }
        }

        val matched = matchingGroups(host, rules)
        if (matched.isEmpty()) {
            return deny(BlockReason.HOST_DENIED, "未匹配任何启用的配置组：$host")
        }

        val biliGroups = matched.filter { it.extensionId == "bilibili" }
        if (biliGroups.isNotEmpty() && isBiliFamilyHost(host)) {
            val mids = biliMidsFromGroups(biliGroups)
            return enforceBilibili(workingUrl, host, mids)
        }

        return allow(workingUrl.toString())
    }

    fun buildBlockAssetUrl(
        originalUrl: String,
        reason: BlockReason?,
        message: String,
        mid: String? = null,
        bvid: String? = null,
        aid: String? = null,
        title: String? = null
    ): String {
        fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
        val reasonCode = reason?.code ?: "host_denied"
        val params = mutableListOf(
            "url=${enc(originalUrl)}",
            "reason=${enc(reasonCode)}",
            "message=${enc(message)}"
        )
        mid?.let { params.add("mid=${enc(it)}") }
        bvid?.let { params.add("bvid=${enc(it)}") }
        aid?.let { params.add("aid=${enc(it)}") }
        title?.let { params.add("title=${enc(it)}") }
        return "file:///android_asset/block.html?${params.joinToString("&")}"
    }

    fun parseQueryParam(url: String, key: String): String? {
        return try {
            val q = url.substringAfter('?', "")
            q.split('&').forEach { part ->
                val k = part.substringBefore('=')
                if (k == key) {
                    return URLDecoder.decode(part.substringAfter('='), "UTF-8")
                }
            }
            null
        } catch (_: Exception) {
            null
        }
    }
}
