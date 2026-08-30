package com.jianxing.browser.sync

import com.jianxing.browser.data.AccountStore
import com.jianxing.browser.data.RulesStore
import com.jianxing.browser.model.AccountSession
import com.jianxing.browser.model.SiteGroup
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class SyncClient(private val account: AccountStore) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(12, TimeUnit.SECONDS)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    data class Result(
        val ok: Boolean,
        val error: String? = null,
        val groups: List<SiteGroup>? = null,
        val revision: Int? = null,
        val updatedAt: Long? = null
    )

    data class BookmarksResult(
        val ok: Boolean,
        val error: String? = null,
        val nodes: JSONArray? = null,
        val revision: Int? = null,
        val updatedAt: Long? = null
    )

    private fun api(
        baseUrl: String,
        path: String,
        method: String = "GET",
        token: String? = null,
        body: JSONObject? = null
    ): JSONObject {
        val url = "${baseUrl.trimEnd('/')}$path"
        val builder = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
        if (token != null) {
            builder.header("Authorization", "Bearer $token")
        }
        when (method.uppercase()) {
            "POST" -> builder.post((body?.toString() ?: "{}").toRequestBody(jsonMedia))
            "PUT" -> builder.put((body?.toString() ?: "{}").toRequestBody(jsonMedia))
            else -> builder.get()
        }
        client.newCall(builder.build()).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            return try {
                JSONObject(text)
            } catch (_: Exception) {
                throw IllegalStateException("服务器响应异常 (${resp.code})")
            }
        }
    }

    fun register(username: String, password: String, serverUrl: String? = null): Result {
        return try {
            val base = (serverUrl ?: account.getServerUrl()).trimEnd('/')
            val data = api(
                base,
                "/auth/register",
                method = "POST",
                body = JSONObject()
                    .put("username", username)
                    .put("password", password)
            )
            if (!data.optBoolean("ok") || data.optString("token").isBlank()) {
                return Result(ok = false, error = data.optString("error", "注册失败"))
            }
            account.setSession(
                AccountSession(
                    serverUrl = base,
                    username = data.optString("username", username),
                    token = data.getString("token")
                )
            )
            Result(ok = true)
        } catch (e: Exception) {
            Result(ok = false, error = e.message ?: "注册失败")
        }
    }

    fun login(username: String, password: String, serverUrl: String? = null): Result {
        return try {
            val base = (serverUrl ?: account.getServerUrl()).trimEnd('/')
            val prev = account.getSession()
            val data = api(
                base,
                "/auth/login",
                method = "POST",
                body = JSONObject()
                    .put("username", username)
                    .put("password", password)
            )
            if (!data.optBoolean("ok") || data.optString("token").isBlank()) {
                return Result(ok = false, error = data.optString("error", "登录失败"))
            }
            val uname = data.optString("username", username)
            val sameUser = prev?.username == uname
            account.setSession(
                AccountSession(
                    serverUrl = base,
                    username = uname,
                    token = data.getString("token"),
                    lastSyncAt = if (sameUser) prev?.lastSyncAt else null,
                    lastRevision = if (sameUser) prev?.lastRevision else null
                )
            )
            Result(ok = true)
        } catch (e: Exception) {
            Result(ok = false, error = e.message ?: "登录失败")
        }
    }

    fun logout() {
        val s = account.getSession()
        if (s != null) {
            try {
                api(s.serverUrl, "/auth/logout", method = "POST", token = s.token)
            } catch (_: Exception) {
            }
        }
        account.clearSession()
    }

    fun pull(touch: Boolean = true): Result {
        return try {
            val s = account.getSession() ?: return Result(ok = false, error = "未登录账号")
            val data = api(s.serverUrl, "/sync/config", token = s.token)
            if (!data.optBoolean("ok")) {
                return Result(ok = false, error = data.optString("error", "拉取失败"))
            }
            val groupsArr = data.optJSONArray("groups") ?: JSONArray()
            val groups = RulesStore.parseGroupsFromJson(groupsArr)
            val revision = data.optInt("revision", 0)
            if (touch) account.touchSync(revision)
            Result(
                ok = true,
                groups = groups,
                revision = revision,
                updatedAt = data.optLong("updatedAt", 0L)
            )
        } catch (e: Exception) {
            Result(ok = false, error = e.message ?: "拉取失败")
        }
    }

    fun push(groups: List<SiteGroup>, revision: Int? = null): Result {
        return try {
            val s = account.getSession() ?: return Result(ok = false, error = "未登录账号")
            val groupsArr = JSONArray()
            groups.forEach { groupsArr.put(RulesStore.groupToJson(it)) }
            val body = JSONObject()
                .put("groups", groupsArr)
                .put("revision", revision ?: (s.lastRevision ?: 0))
            val data = api(
                s.serverUrl,
                "/sync/config",
                method = "PUT",
                token = s.token,
                body = body
            )
            if (!data.optBoolean("ok")) {
                return Result(ok = false, error = data.optString("error", "上传失败"))
            }
            val rev = data.optInt("revision", 0)
            account.touchSync(rev)
            Result(ok = true, revision = rev, updatedAt = data.optLong("updatedAt", 0L))
        } catch (e: Exception) {
            Result(ok = false, error = e.message ?: "上传失败")
        }
    }

    fun pullBookmarks(): BookmarksResult {
        return try {
            val s = account.getSession() ?: return BookmarksResult(ok = false, error = "未登录账号")
            val data = api(s.serverUrl, "/sync/bookmarks", token = s.token)
            if (!data.optBoolean("ok")) {
                return BookmarksResult(ok = false, error = data.optString("error", "拉取收藏夹失败"))
            }
            BookmarksResult(
                ok = true,
                nodes = data.optJSONArray("nodes") ?: JSONArray(),
                revision = data.optInt("revision", 0),
                updatedAt = data.optLong("updatedAt", 0L)
            )
        } catch (e: Exception) {
            BookmarksResult(ok = false, error = e.message ?: "拉取收藏夹失败")
        }
    }

    fun pushBookmarks(nodes: JSONArray, localRevision: Int): BookmarksResult {
        return try {
            val s = account.getSession() ?: return BookmarksResult(ok = false, error = "未登录账号")
            val body = JSONObject()
                .put("nodes", nodes)
                .put("revision", localRevision)
            val data = api(
                s.serverUrl,
                "/sync/bookmarks",
                method = "PUT",
                token = s.token,
                body = body
            )
            if (!data.optBoolean("ok")) {
                return BookmarksResult(ok = false, error = data.optString("error", "上传收藏夹失败"))
            }
            BookmarksResult(
                ok = true,
                revision = data.optInt("revision", 0),
                updatedAt = data.optLong("updatedAt", 0L)
            )
        } catch (e: Exception) {
            BookmarksResult(ok = false, error = e.message ?: "上传收藏夹失败")
        }
    }

    companion object {
        const val DEFAULT_SERVER_URL = "https://spacedreams.cn/simplygo-api"
    }
}
