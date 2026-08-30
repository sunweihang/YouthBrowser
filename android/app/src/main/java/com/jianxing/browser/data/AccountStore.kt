package com.jianxing.browser.data

import android.content.Context
import android.content.SharedPreferences
import com.jianxing.browser.model.AccountSession
import com.jianxing.browser.sync.SyncClient

class AccountStore(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun getServerUrl(): String =
        prefs.getString(KEY_SERVER, SyncClient.DEFAULT_SERVER_URL) ?: SyncClient.DEFAULT_SERVER_URL

    fun setServerUrl(url: String) {
        prefs.edit().putString(KEY_SERVER, url.trim().trimEnd('/')).apply()
    }

    fun getSession(): AccountSession? {
        val token = prefs.getString(KEY_TOKEN, null) ?: return null
        val username = prefs.getString(KEY_USERNAME, null) ?: return null
        val server = prefs.getString(KEY_SERVER, SyncClient.DEFAULT_SERVER_URL)
            ?: SyncClient.DEFAULT_SERVER_URL
        return AccountSession(
            serverUrl = server,
            username = username,
            token = token,
            lastSyncAt = prefs.getLong(KEY_LAST_SYNC, 0L).takeIf { it > 0 },
            lastRevision = prefs.getInt(KEY_REVISION, 0).takeIf { it > 0 }
        )
    }

    fun setSession(session: AccountSession) {
        prefs.edit()
            .putString(KEY_SERVER, session.serverUrl.trimEnd('/'))
            .putString(KEY_USERNAME, session.username)
            .putString(KEY_TOKEN, session.token)
            .putLong(KEY_LAST_SYNC, session.lastSyncAt ?: 0L)
            .putInt(KEY_REVISION, session.lastRevision ?: 0)
            .apply()
    }

    fun clearSession() {
        prefs.edit()
            .remove(KEY_TOKEN)
            .remove(KEY_USERNAME)
            .remove(KEY_LAST_SYNC)
            .remove(KEY_REVISION)
            .apply()
    }

    fun touchSync(revision: Int) {
        prefs.edit()
            .putLong(KEY_LAST_SYNC, System.currentTimeMillis())
            .putInt(KEY_REVISION, revision)
            .apply()
    }

    companion object {
        private const val PREFS_NAME = "jianxing_account"
        private const val KEY_SERVER = "server_url"
        private const val KEY_USERNAME = "username"
        private const val KEY_TOKEN = "token"
        private const val KEY_LAST_SYNC = "last_sync_at"
        private const val KEY_REVISION = "last_revision"
    }
}
