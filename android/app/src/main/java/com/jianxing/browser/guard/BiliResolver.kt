package com.jianxing.browser.guard

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.util.regex.Pattern

data class VideoIds(val bvid: String? = null, val aid: String? = null)

data class VideoOwner(
    val ok: Boolean,
    val mid: String? = null,
    val title: String? = null,
    val error: String? = null
)

object BiliResolver {
    private val client = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        .build()

    private val bvPattern = Pattern.compile("/video/(BV[\\w]+)", Pattern.CASE_INSENSITIVE)
    private val avPattern = Pattern.compile("/video/av(\\d+)", Pattern.CASE_INSENSITIVE)
    private val spacePattern = Pattern.compile("^/(?:space/)?(\\d+)(?:/|$)", Pattern.CASE_INSENSITIVE)

    fun parseBiliVideoId(pathname: String): VideoIds? {
        val bv = bvPattern.matcher(pathname)
        if (bv.find()) return VideoIds(bvid = bv.group(1))
        val av = avPattern.matcher(pathname)
        if (av.find()) return VideoIds(aid = av.group(1))
        return null
    }

    fun parseSpaceMid(pathname: String): String? {
        val m = spacePattern.matcher(pathname)
        return if (m.find()) m.group(1) else null
    }

    /** Resolve b23 short URL to final location (best-effort). */
    fun resolveShortUrl(url: String): String {
        return try {
            val req = Request.Builder().url(url).head().build()
            client.newCall(req).execute().use { resp ->
                resp.request.url.toString()
            }
        } catch (_: Exception) {
            try {
                val req = Request.Builder().url(url).get().build()
                client.newCall(req).execute().use { resp ->
                    resp.request.url.toString()
                }
            } catch (_: Exception) {
                url
            }
        }
    }

    /** Optional API resolve of video owner mid. Returns failure if network/API unavailable. */
    fun resolveVideoOwner(bvid: String?, aid: String?): VideoOwner {
        val apiUrl = when {
            !bvid.isNullOrBlank() ->
                "https://api.bilibili.com/x/web-interface/view?bvid=$bvid"
            !aid.isNullOrBlank() ->
                "https://api.bilibili.com/x/web-interface/view?aid=$aid"
            else -> return VideoOwner(ok = false, error = "无视频 ID")
        }
        return try {
            val req = Request.Builder()
                .url(apiUrl)
                .header("User-Agent", "Mozilla/5.0 SimplyGo/1.0")
                .get()
                .build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) {
                    return VideoOwner(ok = false, error = "API ${resp.code}")
                }
                val body = resp.body?.string() ?: return VideoOwner(ok = false, error = "空响应")
                val root = JSONObject(body)
                if (root.optInt("code", -1) != 0) {
                    return VideoOwner(ok = false, error = root.optString("message", "解析失败"))
                }
                val data = root.optJSONObject("data")
                    ?: return VideoOwner(ok = false, error = "无 data")
                val owner = data.optJSONObject("owner")
                val mid = owner?.optLong("mid", 0L)?.takeIf { it > 0 }?.toString()
                    ?: return VideoOwner(ok = false, error = "无 mid")
                val title = data.optString("title").takeIf { it.isNotBlank() }
                VideoOwner(ok = true, mid = mid, title = title)
            }
        } catch (e: Exception) {
            VideoOwner(ok = false, error = e.message ?: "网络错误")
        }
    }
}
