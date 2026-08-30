package com.jianxing.browser.data

import android.content.Context

class SettingsStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun isBookmarksBarVisible(): Boolean = prefs.getBoolean(KEY_BM_BAR, true)

    fun setBookmarksBarVisible(visible: Boolean) {
        prefs.edit().putBoolean(KEY_BM_BAR, visible).apply()
    }

    fun getTextZoom(): Int = prefs.getInt(KEY_ZOOM, 100).coerceIn(50, 300)

    fun setTextZoom(zoom: Int) {
        prefs.edit().putInt(KEY_ZOOM, zoom.coerceIn(50, 300)).apply()
    }

    fun getHomepage(): String = prefs.getString(KEY_HOMEPAGE, "") ?: ""

    fun setHomepage(raw: String): Boolean {
        val parsed = RulesStore.normalizeHomepage(raw) ?: return false
        prefs.edit().putString(KEY_HOMEPAGE, parsed).apply()
        return true
    }

    fun migrateHomepageFromRules(legacy: String) {
        if (prefs.contains(KEY_HOMEPAGE)) return
        prefs.edit().putString(KEY_HOMEPAGE, legacy).apply()
    }

    companion object {
        private const val PREFS = "jianxing_settings"
        private const val KEY_BM_BAR = "bookmarks_bar_visible"
        private const val KEY_ZOOM = "text_zoom"
        private const val KEY_HOMEPAGE = "homepage"
    }
}
