package com.jianxing.browser

import android.app.Application
import com.jianxing.browser.data.AccountStore
import com.jianxing.browser.data.BookmarksStore
import com.jianxing.browser.data.HistoryStore
import com.jianxing.browser.data.RulesStore
import com.jianxing.browser.data.SitePasswordsStore
import com.jianxing.browser.data.WatchRequestsStore

class JianXingApp : Application() {
    lateinit var rulesStore: RulesStore
        private set
    lateinit var watchRequestsStore: WatchRequestsStore
        private set
    lateinit var accountStore: AccountStore
        private set
    lateinit var bookmarksStore: BookmarksStore
        private set
    lateinit var historyStore: HistoryStore
        private set
    lateinit var sitePasswordsStore: SitePasswordsStore
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        rulesStore = RulesStore(this)
        watchRequestsStore = WatchRequestsStore(this)
        accountStore = AccountStore(this)
        bookmarksStore = BookmarksStore(this)
        historyStore = HistoryStore(this)
        sitePasswordsStore = SitePasswordsStore(this)
        rulesStore.ensureDefaultRequestGroup()
    }

    companion object {
        lateinit var instance: JianXingApp
            private set
    }
}
