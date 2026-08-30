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

    companion object {
        private const val PREFS = "jianxing_settings"
        private const val KEY_BM_BAR = "bookmarks_bar_visible"
        private const val KEY_ZOOM = "text_zoom"
    }
}
