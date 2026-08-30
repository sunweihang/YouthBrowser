package com.jianxing.browser.model

data class BilibiliExtensionConfig(
    val allowedMids: List<String> = emptyList(),
    val midNotes: Map<String, String> = emptyMap()
)

data class SiteGroup(
    val id: String,
    val name: String,
    val enabled: Boolean = true,
    val hosts: List<String> = emptyList(),
    val extensionId: String = "none", // "none" | "bilibili"
    val extensionConfig: Map<String, Any?> = emptyMap()
)

data class RulesConfig(
    val version: Int = 2,
    val parentPasswordHash: String = "",
    val filteringEnabled: Boolean = false,
    val homepage: String = "",
    val groups: List<SiteGroup> = emptyList()
)

data class DownloadEntry(
    val id: String,
    val url: String,
    val filename: String,
    val filePath: String = "",
    val mime: String = "",
    val state: String = "progressing",
    val receivedBytes: Long = 0,
    val totalBytes: Long = 0,
    val startedAt: Long = System.currentTimeMillis(),
    val endedAt: Long? = null,
    val systemId: Long = -1
)

data class HistoryEntry(
    val id: String,
    val url: String,
    val title: String,
    val host: String,
    val visitedAt: Long
)

data class WatchRequest(
    val id: String,
    val url: String,
    val host: String? = null,
    val reason: String? = null,
    val mid: String? = null,
    val bvid: String? = null,
    val aid: String? = null,
    val title: String? = null,
    val status: String = "pending", // pending | approved | rejected
    val createdAt: Long = System.currentTimeMillis(),
    val resolvedAt: Long? = null,
    val note: String? = null
)

enum class BlockReason(val code: String) {
    INVALID_URL("invalid_url"),
    HOST_DENIED("host_denied"),
    BILI_PATH_DENIED("bili_path_denied"),
    BILI_UP_DENIED("bili_up_denied"),
    BILI_RESOLVE_FAILED("bili_resolve_failed"),
    PROTOCOL_DENIED("protocol_denied")
}

data class NavigateResult(
    val allowed: Boolean,
    val reason: BlockReason? = null,
    val finalUrl: String? = null,
    val message: String? = null,
    val mid: String? = null,
    val bvid: String? = null,
    val aid: String? = null,
    val title: String? = null
)

data class AccountSession(
    val serverUrl: String,
    val username: String,
    val token: String,
    val lastSyncAt: Long? = null,
    val lastRevision: Int? = null
)

object BiliConstants {
    val SUGGESTED_HOSTS = listOf(
        "www.bilibili.com",
        "m.bilibili.com",
        "space.bilibili.com",
        "www.b23.tv",
        "b23.tv",
        "api.bilibili.com",
        "*.hdslb.com",
        "*.bilivideo.com",
        "*.akamaized.net"
    )

    val HOST_SUFFIXES = listOf(
        "bilibili.com",
        "b23.tv",
        "hdslb.com",
        "bilivideo.com",
        "akamaized.net"
    )

    const val REQUEST_GROUP_NAME = "访问申请"
}
