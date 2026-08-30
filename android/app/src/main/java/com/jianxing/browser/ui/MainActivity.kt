package com.jianxing.browser.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.role.RoleManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.print.PrintAttributes
import android.print.PrintManager
import android.provider.Settings
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.view.Gravity
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.PopupWindow
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.isVisible
import com.jianxing.browser.JianXingApp
import com.jianxing.browser.R
import com.jianxing.browser.data.BookmarkNode
import com.jianxing.browser.data.DownloadsHelper
import com.jianxing.browser.databinding.ActivityMainBinding
import com.jianxing.browser.guard.NavigationGuard
import com.jianxing.browser.model.BlockReason
import com.jianxing.browser.model.DownloadEntry
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private val guardExecutor = Executors.newSingleThreadExecutor()
    private val tabs = mutableListOf<BrowserTab>()
    private var activeTabId: String? = null
    private var pendingPassword: PendingPassword? = null
    private var chromeHidden = false
    private var currentDownload: DownloadEntry? = null
    private var pendingDownload: PendingDownload? = null
    private var appMenuPopup: PopupWindow? = null
    private val downloadHandler = Handler(Looper.getMainLooper())
    private val downloadPoll = object : Runnable {
        override fun run() {
            pollDownloads()
            if (DownloadsHelper.activeCount() > 0 || binding.downloadBar.isVisible) {
                downloadHandler.postDelayed(this, 800)
            }
        }
    }

    data class BrowserTab(
        val id: String,
        val webView: WebView,
        var title: String = "新标签页",
        var url: String = "",
        var loading: Boolean = false,
        var lastCheckedUrl: String? = null,
        var loadingBlockedPage: Boolean = false,
        var bypassCacheOnce: Boolean = false
    )

    data class PendingPassword(
        val origin: String,
        val host: String,
        val username: String,
        val password: String,
        val update: Boolean
    )

    data class PendingDownload(
        val url: String,
        val userAgent: String?,
        val contentDisposition: String?,
        val mimeType: String?
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnNewTab.setOnClickListener { newTab() }
        binding.btnBack.setOnClickListener { goBack() }
        binding.btnForward.setOnClickListener { goForward() }
        binding.btnReload.setOnClickListener { reload() }
        binding.btnReload.setOnLongClickListener {
            reload(ignoreCache = true)
            true
        }
        binding.btnStar.setOnClickListener { toggleBookmark() }
        binding.btnDownloads.setOnClickListener {
            startActivity(Intent(this, DownloadsActivity::class.java))
        }
        binding.downloadBarOpen.setOnClickListener {
            currentDownload?.let { DownloadsHelper.openFile(this, it) }
        }
        binding.downloadBarShow.setOnClickListener { DownloadsHelper.openFolder(this) }
        binding.downloadBarList.setOnClickListener {
            startActivity(Intent(this, DownloadsActivity::class.java))
        }
        binding.downloadBarClose.setOnClickListener { closeDownloadBar() }
        binding.btnMenu.setOnClickListener { showAppMenu(it) }
        binding.urlBar.setOnEditorActionListener { _, actionId, event ->
            if (actionId == EditorInfo.IME_ACTION_GO ||
                (event != null && event.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN)
            ) {
                navigateFromBar()
                true
            } else false
        }

        binding.passwordSave.setOnClickListener { savePendingPassword() }
        binding.passwordDismiss.setOnClickListener { closePasswordBar() }
        binding.passwordClose.setOnClickListener { closePasswordBar() }
        binding.homepageSave.setOnClickListener { saveHomepageFromBar() }
        binding.homepageUseCurrent.setOnClickListener { setCurrentHomepage() }
        binding.homepageClear.setOnClickListener { clearHomepage() }
        binding.homepageClose.setOnClickListener { closeHomepageBar() }
        binding.homepageInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE || actionId == EditorInfo.IME_ACTION_GO) {
                saveHomepageFromBar(); true
            } else false
        }
        binding.findInput.setOnEditorActionListener { _, actionId, event ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH ||
                (event != null && event.keyCode == KeyEvent.KEYCODE_ENTER)
            ) {
                runFind(forward = true, findNext = true); true
            } else false
        }
        binding.findInput.addTextChangedListener(SimpleTextWatcher { runFind(true, false) })
        binding.findPrev.setOnClickListener { runFind(false, true) }
        binding.findNext.setOnClickListener { runFind(true, true) }
        binding.findClose.setOnClickListener { closeFindBar() }

        val launchUrl = extractLaunchUrl(intent)
        if (launchUrl != null) newTab(launchUrl) else newTab()
        refreshBookmarksBar()
        updateChrome()
        refreshSetupBadge()
        refreshDownloadsChrome()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val url = extractLaunchUrl(intent)
        if (url != null) newTab(url)
    }

    override fun onResume() {
        super.onResume()
        refreshBookmarksBar()
        updateChrome()
        refreshSetupBadge()
        refreshDownloadsChrome()
        startDownloadPoll()
    }

    override fun onPause() {
        downloadHandler.removeCallbacks(downloadPoll)
        super.onPause()
    }

    private fun extractLaunchUrl(intent: Intent?): String? {
        val uri = intent?.data ?: return null
        val data = uri.toString()
        if (data.startsWith("http://") || data.startsWith("https://")) return data
        if (data.startsWith("file://") || data.startsWith("content://")) {
            if (data.startsWith("content://")) {
                try {
                    contentResolver.takePersistableUriPermission(
                        uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
                    )
                } catch (_: Exception) { }
            }
            val type = intent.type ?: runCatching { contentResolver.getType(uri) }.getOrNull()
            val looksHtml = type?.contains("html") == true ||
                data.contains(Regex("\\.(xhtml|html?)(?:[?#]|$)", RegexOption.IGNORE_CASE))
            if (looksHtml || type.isNullOrBlank()) return data
        }
        return null
    }

    private fun activeTab(): BrowserTab? = tabs.find { it.id == activeTabId } ?: tabs.lastOrNull()

    private fun newTab(initialUrl: String? = null): BrowserTab {
        val tab = BrowserTab(id = newTabId(), webView = createWebView())
        tabs.add(tab)
        binding.webHost.addView(
            tab.webView,
            android.widget.FrameLayout.LayoutParams(
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        activateTab(tab.id)
        if (initialUrl != null) checkAndLoad(tab, initialUrl, fromUser = true)
        else openHomepage(tab)
        renderTabs()
        return tab
    }

    private fun closeTab(id: String) {
        val idx = tabs.indexOfFirst { it.id == id }
        if (idx < 0) return
        val tab = tabs.removeAt(idx)
        binding.webHost.removeView(tab.webView)
        tab.webView.destroy()
        if (tabs.isEmpty()) {
            newTab()
            return
        }
        if (activeTabId == id) {
            val next = tabs.getOrNull(idx.coerceAtMost(tabs.lastIndex)) ?: tabs.last()
            activateTab(next.id)
        }
        renderTabs()
        updateChrome()
    }

    private fun activateTab(id: String) {
        activeTabId = id
        tabs.forEach { it.webView.isVisible = it.id == id }
        renderTabs()
        updateChrome()
        applyZoom(activeTab())
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(): WebView {
        val web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = true
        web.settings.setSupportZoom(true)
        web.settings.builtInZoomControls = true
        web.settings.displayZoomControls = false
        web.settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        web.settings.textZoom = JianXingApp.instance.settingsStore.getTextZoom()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            web.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_YES
        }
        web.addJavascriptInterface(Bridge(), "JianXing")
        web.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            startDownload(url, userAgent, contentDisposition, mimeType)
        }
        web.setFindListener { active, numberOfMatches, _ ->
            binding.findCount.text =
                if (numberOfMatches > 0) "${active + 1} / $numberOfMatches" else "无匹配"
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                val tab = tabs.find { it.webView == view } ?: return
                tab.loading = newProgress in 1..99
                if (tab.id == activeTabId) {
                    binding.progress.isVisible = tab.loading
                    binding.progress.progress = newProgress
                    renderTabs()
                }
            }

            override fun onReceivedTitle(view: WebView?, title: String?) {
                val tab = tabs.find { it.webView == view } ?: return
                if (!title.isNullOrBlank() && title != "about:blank") tab.title = title
                if (tab.id == activeTabId) renderTabs()
            }
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: return false
                val tab = tabs.find { it.webView == view } ?: return true
                if (url.startsWith("file:///android_asset/")) return false
                if (DownloadsHelper.looksLikeDownload(url)) {
                    startDownload(url, view?.settings?.userAgentString, null, null)
                    return true
                }
                checkAndLoad(tab, url, fromUser = false)
                return true
            }

            @Deprecated("Deprecated in Java")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                if (url.isNullOrBlank() || url.startsWith("file:///android_asset/")) return false
                val tab = tabs.find { it.webView == view } ?: return true
                if (DownloadsHelper.looksLikeDownload(url)) {
                    startDownload(url, view?.settings?.userAgentString, null, null)
                    return true
                }
                checkAndLoad(tab, url, fromUser = false)
                return true
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                val tab = tabs.find { it.webView == view } ?: return
                tab.loading = true
                if (!tab.loadingBlockedPage && url != null && !url.startsWith("file:///android_asset/")) {
                    tab.url = url
                    if (tab.id == activeTabId && currentFocus != binding.urlBar) {
                        binding.urlBar.setText(url)
                    }
                }
                if (tab.id == activeTabId) renderTabs()
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                val tab = tabs.find { it.webView == view } ?: return
                tab.loadingBlockedPage = false
                tab.loading = false
                tab.title = view?.title?.takeIf { it.isNotBlank() } ?: tab.title
                if (tab.bypassCacheOnce) {
                    tab.bypassCacheOnce = false
                    view?.settings?.cacheMode = WebSettings.LOAD_DEFAULT
                }
                if (!url.isNullOrBlank() && (url.startsWith("http://") || url.startsWith("https://"))) {
                    tab.url = url
                    JianXingApp.instance.historyStore.record(url, tab.title)
                    injectSitePasswordScript(tab)
                }
                if (tab.id == activeTabId) {
                    updateChrome()
                    renderTabs()
                }
            }
        }
        return web
    }

    private fun navigateFromBar() {
        val raw = binding.urlBar.text?.toString()?.trim().orEmpty()
        if (raw.isEmpty()) return
        val tab = activeTab() ?: newTab()
        checkAndLoad(tab, raw, fromUser = true)
    }

    private fun normalizeForCheck(rawUrl: String): String {
        var s = rawUrl.trim()
        if (s.isEmpty()) return s
        if (!Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:").containsMatchIn(s)) {
            val looksLikeIp = Regex("^(\\d{1,3}\\.){3}\\d{1,3}([/:?]|$)").containsMatchIn(s)
            s = "${if (looksLikeIp) "http" else "https"}://$s"
        }
        return s
    }

    private fun checkAndLoad(tab: BrowserTab, rawUrl: String, @Suppress("UNUSED_PARAMETER") fromUser: Boolean) {
        val app = JianXingApp.instance
        val candidate = normalizeForCheck(rawUrl)
        guardExecutor.execute {
            if (candidate.startsWith("http") && app.watchRequestsStore.isApprovedUrl(candidate)) {
                runOnUiThread { loadAllowed(tab, candidate) }
                return@execute
            }
            val result = NavigationGuard.canNavigate(rawUrl, app.rulesStore.load())
            runOnUiThread {
                if (result.allowed) {
                    loadAllowed(tab, result.finalUrl ?: rawUrl)
                } else {
                    showBlock(tab, rawUrl, result.reason, result.message, result.mid, result.bvid, result.aid, result.title)
                }
            }
        }
    }

    private fun loadAllowed(tab: BrowserTab, url: String) {
        tab.lastCheckedUrl = url
        tab.url = if (url.startsWith("file:")) "" else url
        if (!url.startsWith("file:") && tab.id == activeTabId) binding.urlBar.setText(url)
        tab.webView.loadUrl(url)
        if (tab.id == activeTabId) updateChrome()
    }

    private fun showBlock(
        tab: BrowserTab,
        originalUrl: String,
        reason: BlockReason?,
        message: String?,
        mid: String?,
        bvid: String?,
        aid: String?,
        title: String?
    ) {
        tab.loadingBlockedPage = true
        tab.url = ""
        tab.title = "此页面不可访问"
        tab.webView.loadUrl(
            NavigationGuard.buildBlockAssetUrl(
                originalUrl = originalUrl,
                reason = reason,
                message = message ?: "未授权的网站或内容",
                mid = mid, bvid = bvid, aid = aid, title = title
            )
        )
        if (tab.id == activeTabId) {
            binding.urlBar.setText("")
            updateChrome()
            renderTabs()
        }
    }

    private fun openHomepage(tab: BrowserTab = activeTab() ?: newTab()) {
        val home = JianXingApp.instance.settingsStore.getHomepage()
        if (home.isNotBlank()) {
            checkAndLoad(tab, home, fromUser = true)
        } else {
            val filtered = JianXingApp.instance.rulesStore.isFilteringEnabled()
            val hint = if (filtered) {
                "请在地址栏输入已授权的网址。B 站仅可打开白名单 UP 的视频或空间。"
            } else {
                "访问过滤未开启。请在地址栏输入网址开始浏览。"
            }
            tab.webView.loadUrl(
                NavigationGuard.buildBlockAssetUrl(
                    originalUrl = "(未打开页面)",
                    reason = BlockReason.HOST_DENIED,
                    message = hint
                )
            )
            tab.url = ""
            tab.title = "开始"
            if (tab.id == activeTabId) {
                binding.urlBar.setText("")
                updateChrome()
            }
        }
    }

    private fun goBack() {
        val tab = activeTab() ?: return
        if (tab.webView.canGoBack()) tab.webView.goBack()
    }

    private fun goForward() {
        val tab = activeTab() ?: return
        if (tab.webView.canGoForward()) tab.webView.goForward()
    }

    private fun reload(ignoreCache: Boolean = false) {
        val tab = activeTab() ?: return
        val current = tab.webView.url
        if (current != null && current.startsWith("file:///android_asset/")) {
            val original = NavigationGuard.parseQueryParam(current, "url")
            if (!original.isNullOrBlank() && original.startsWith("http")) {
                if (ignoreCache) prepareBypassCache(tab)
                checkAndLoad(tab, original, fromUser = true)
                return
            }
        }
        if (ignoreCache) {
            prepareBypassCache(tab)
            if (!current.isNullOrBlank() &&
                (current.startsWith("http://") || current.startsWith("https://"))
            ) {
                tab.webView.loadUrl(current)
                return
            }
        }
        tab.webView.reload()
    }

    private fun prepareBypassCache(tab: BrowserTab) {
        tab.bypassCacheOnce = true
        tab.webView.settings.cacheMode = WebSettings.LOAD_NO_CACHE
    }

    private fun confirmClearCache() {
        AlertDialog.Builder(this)
            .setTitle(R.string.cache_clear_title)
            .setMessage(R.string.cache_clear_message)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.menu_clear_cache) { _, _ -> clearHttpCache() }
            .show()
    }

    private fun clearHttpCache() {
        val web = activeTab()?.webView ?: tabs.firstOrNull()?.webView
        web?.clearCache(true)
        reload(ignoreCache = true)
        toast(getString(R.string.cache_cleared))
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val shortcut = matchShortcut(event) ?: return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_DOWN) shortcut()
        return true
    }

    private fun matchShortcut(event: KeyEvent): (() -> Unit)? {
        val ctrl = event.isCtrlPressed
        val shift = event.isShiftPressed
        return when (event.keyCode) {
            KeyEvent.KEYCODE_R -> if (ctrl) ({ reload(ignoreCache = shift) }) else null
            KeyEvent.KEYCODE_F5 -> ({ reload(ignoreCache = ctrl || shift) })
            KeyEvent.KEYCODE_FORWARD_DEL -> if (ctrl && shift) ({ confirmClearCache() }) else null
            else -> null
        }
    }

    private fun currentPageUrl(): String? {
        val tab = activeTab() ?: return null
        val url = tab.webView.url ?: tab.url
        if (url.startsWith("file:///android_asset/")) {
            val original = NavigationGuard.parseQueryParam(url, "url")
            if (!original.isNullOrBlank() && original.startsWith("http")) return original
            return null
        }
        if (url.startsWith("http://") || url.startsWith("https://")) return url
        return null
    }

    private fun toggleBookmark() {
        val url = currentPageUrl()
        if (url == null) {
            toast("只能收藏网页地址")
            return
        }
        val title = activeTab()?.webView?.title?.takeIf { it.isNotBlank() } ?: url
        val bookmarked = JianXingApp.instance.bookmarksStore.toggle(url, title)
        toast(if (bookmarked) "已加入书签" else "已取消书签")
        updateChrome()
        refreshBookmarksBar()
    }

    private fun updateChrome() {
        val tab = activeTab()
        val filtered = JianXingApp.instance.rulesStore.isFilteringEnabled()
        binding.urlBar.hint = getString(if (filtered) R.string.url_hint_filtered else R.string.url_hint)
        if (tab == null) {
            binding.btnBack.isEnabled = false
            binding.btnForward.isEnabled = false
            binding.btnStar.isEnabled = false
            binding.btnStar.text = "☆"
            binding.btnStar.setTextColor(getColor(R.color.jx_text))
            return
        }
        if (currentFocus != binding.urlBar) {
            val show = if (tab.url.startsWith("file:")) "" else tab.url
            if (binding.urlBar.text?.toString() != show) binding.urlBar.setText(show)
        }
        binding.btnBack.isEnabled = tab.webView.canGoBack()
        binding.btnForward.isEnabled = tab.webView.canGoForward()
        val url = currentPageUrl()
        val starred = url != null && JianXingApp.instance.bookmarksStore.isBookmarked(url)
        binding.btnStar.isEnabled = url != null
        binding.btnStar.text = if (starred) "★" else "☆"
        binding.btnStar.setTextColor(getColor(if (starred) R.color.jx_star else R.color.jx_text))
        binding.progress.isVisible = tab.loading
        applyBookmarksBarVisibility()
        refreshSetupBadge()
    }

    private fun renderTabs() {
        binding.tabsBar.removeAllViews()
        val inflater = LayoutInflater.from(this)
        for (tab in tabs) {
            val chip = inflater.inflate(R.layout.item_tab, binding.tabsBar, false)
            val title = chip.findViewById<TextView>(R.id.tabTitle)
            val close = chip.findViewById<TextView>(R.id.tabClose)
            val active = tab.id == activeTabId
            chip.isSelected = active
            title.text = if (tab.loading) "加载中…" else tab.title.ifBlank { "新标签页" }
            title.setTextColor(getColor(if (active) R.color.jx_text else R.color.jx_muted))
            close.setOnClickListener { closeTab(tab.id) }
            chip.setOnClickListener { activateTab(tab.id) }
            binding.tabsBar.addView(chip)
        }
    }

    private fun refreshBookmarksBar() {
        val bar = binding.bookmarksBar
        bar.removeAllViews()
        val items = JianXingApp.instance.bookmarksStore.listToolbar()
        val pad = (8 * resources.displayMetrics.density).toInt()
        items.forEach { node ->
            val chip = TextView(this).apply {
                text = if (node.type == "folder") "${node.title} ▾" else node.title
                textSize = 12f
                setTextColor(getColor(R.color.jx_text))
                setPadding(pad, pad / 2, pad, pad / 2)
                background = getDrawable(R.drawable.bg_find_input)
                maxLines = 1
                maxWidth = (160 * resources.displayMetrics.density).toInt()
                ellipsize = android.text.TextUtils.TruncateAt.END
                setOnClickListener {
                    if (node.type == "folder") showFolderPopup(this, node)
                    else node.url?.let { url ->
                        val tab = activeTab() ?: newTab()
                        checkAndLoad(tab, url, fromUser = true)
                    }
                }
            }
            if (node.type != "folder") {
                chip.setOnLongClickListener {
                    JianXingApp.instance.bookmarksStore.removeBookmark(node.id)
                    refreshBookmarksBar()
                    updateChrome()
                    true
                }
            }
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { marginEnd = pad / 2 }
            bar.addView(chip, lp)
        }
        applyBookmarksBarVisibility()
    }

    private fun showFolderPopup(anchor: View, folder: BookmarkNode) {
        val kids = JianXingApp.instance.bookmarksStore.children(folder.id)
        val popup = PopupMenu(this, anchor, Gravity.TOP)
        if (kids.isEmpty()) {
            popup.menu.add(0, 0, 0, "（空文件夹）").isEnabled = false
        } else {
            kids.forEachIndexed { i, child ->
                popup.menu.add(0, i + 1, i, child.title)
            }
        }
        popup.setOnMenuItemClickListener { item ->
            val child = kids.getOrNull(item.itemId - 1) ?: return@setOnMenuItemClickListener false
            if (child.type == "folder") showFolderPopup(anchor, child)
            else child.url?.let {
                val tab = activeTab() ?: newTab()
                checkAndLoad(tab, it, fromUser = true)
            }
            true
        }
        popup.show()
    }

    private fun applyBookmarksBarVisibility() {
        val visible = JianXingApp.instance.settingsStore.isBookmarksBarVisible() && !chromeHidden
        binding.bookmarksScroll.isVisible = visible
        binding.bookmarksBarLine.isVisible = visible
    }

    private fun refreshSetupBadge() {
        val needs = !JianXingApp.instance.rulesStore.hasPassword()
        binding.updateBadge.isVisible = needs
        binding.updateBadge.text = "!"
        binding.btnMenu.strokeColor = android.content.res.ColorStateList.valueOf(
            getColor(if (needs) R.color.jx_danger else R.color.jx_line)
        )
    }

    private fun showAppMenu(anchor: View) {
        appMenuPopup?.dismiss()
        val url = currentPageUrl()
        val starred = url != null && JianXingApp.instance.bookmarksStore.isBookmarked(url)
        val zoom = JianXingApp.instance.settingsStore.getTextZoom()
        val content = layoutInflater.inflate(R.layout.popup_app_menu, null)
        val list = content.findViewById<LinearLayout>(R.id.appMenuList)

        fun addItem(id: Int, title: String, checked: Boolean? = null, shortcut: String? = null) {
            val row = layoutInflater.inflate(R.layout.item_app_menu, list, false)
            row.findViewById<TextView>(R.id.menuTitle).text = title
            val mark = row.findViewById<TextView>(R.id.menuCheck)
            val hint = row.findViewById<TextView>(R.id.menuHint)
            if (checked == true) {
                mark.isVisible = true
                mark.text = "✓"
                hint.isVisible = false
            } else {
                mark.isVisible = false
                if (!shortcut.isNullOrBlank()) {
                    hint.isVisible = true
                    hint.text = shortcut
                } else {
                    hint.isVisible = false
                }
            }
            row.setOnClickListener {
                if (id == MENU_ZOOM) {
                    showZoomMenu(row)
                    return@setOnClickListener
                }
                appMenuPopup?.dismiss()
                onAppMenuClick(id)
            }
            list.addView(row)
        }

        fun addDivider() {
            layoutInflater.inflate(R.layout.item_app_menu_divider, list, true)
        }

        addItem(MENU_NEW_TAB, getString(R.string.menu_new_tab))
        addItem(MENU_CLOSE_TAB, getString(R.string.menu_close_tab))
        addDivider()
        addItem(MENU_TOGGLE_BM, getString(if (starred) R.string.menu_unbookmark else R.string.menu_new_bookmark))
        addItem(MENU_MANAGE_BM, getString(R.string.menu_bookmarks))
        addDivider()
        addItem(MENU_HOME, getString(R.string.menu_home))
        addItem(MENU_SET_CURRENT_HOME, getString(R.string.menu_set_current_home))
        addItem(MENU_SET_HOME, getString(R.string.menu_set_homepage))
        addDivider()
        addItem(MENU_HISTORY, getString(R.string.menu_history))
        addItem(MENU_DOWNLOADS, getString(R.string.menu_downloads))
        addItem(MENU_SAVE_PAGE, getString(R.string.menu_save_page))
        addItem(MENU_RELOAD, getString(R.string.menu_reload), shortcut = getString(R.string.shortcut_reload))
        addItem(MENU_RELOAD_HARD, getString(R.string.menu_reload_hard), shortcut = getString(R.string.shortcut_reload_hard))
        addItem(MENU_CLEAR_CACHE, getString(R.string.menu_clear_cache), shortcut = getString(R.string.shortcut_clear_cache))
        addDivider()
        addItem(MENU_FIND, getString(R.string.menu_find))
        addItem(MENU_PRINT, getString(R.string.menu_print))
        addItem(MENU_ZOOM, "${getString(R.string.menu_zoom)}（$zoom%）")
        addItem(MENU_FULLSCREEN, getString(R.string.menu_fullscreen))
        addDivider()
        addItem(MENU_PARENT, getString(R.string.menu_parent))
        addItem(MENU_UPDATE, getString(R.string.menu_update))
        addItem(MENU_PASSWORDS, getString(R.string.menu_saved_passwords))
        addItem(MENU_DEFAULT, getString(R.string.menu_default_browser))
        addDivider()
        addItem(
            MENU_BM_BAR,
            getString(R.string.menu_bookmarks_bar),
            JianXingApp.instance.settingsStore.isBookmarksBarVisible()
        )
        addItem(MENU_ABOUT, getString(R.string.menu_about))

        val width = (288 * resources.displayMetrics.density).toInt()
        val maxH = (resources.displayMetrics.heightPixels * 0.72f).toInt()
        content.measure(
            View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
        )
        val height = minOf(content.measuredHeight, maxH)
        content.findViewById<ScrollView>(R.id.appMenuScroll).layoutParams.height = height

        val popup = PopupWindow(content, width, height, true).apply {
            isOutsideTouchable = true
            elevation = 16f
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setOnDismissListener { appMenuPopup = null }
        }
        appMenuPopup = popup
        popup.showAsDropDown(anchor, 0, (6 * resources.displayMetrics.density).toInt(), Gravity.END)
    }

    private fun showZoomMenu(anchor: View) {
        val popup = PopupMenu(this, anchor, Gravity.END)
        popup.menu.add(0, MENU_ZOOM_IN, 0, getString(R.string.menu_zoom_in))
        popup.menu.add(0, MENU_ZOOM_OUT, 0, getString(R.string.menu_zoom_out))
        popup.menu.add(0, MENU_ZOOM_RESET, 0, getString(R.string.menu_zoom_reset))
        popup.setOnMenuItemClickListener { item ->
            appMenuPopup?.dismiss()
            onAppMenuClick(item.itemId)
            true
        }
        popup.show()
    }

    private fun onAppMenuClick(id: Int) {
        when (id) {
            MENU_NEW_TAB -> newTab()
            MENU_CLOSE_TAB -> activeTab()?.id?.let { closeTab(it) }
            MENU_TOGGLE_BM -> toggleBookmark()
            MENU_MANAGE_BM -> openBookmarks()
            MENU_HOME -> openHomepage()
            MENU_SET_CURRENT_HOME -> setCurrentHomepage()
            MENU_SET_HOME -> openHomepageBar()
            MENU_HISTORY -> openHistory()
            MENU_DOWNLOADS -> startActivity(Intent(this, DownloadsActivity::class.java))
            MENU_SAVE_PAGE -> saveCurrentPage()
            MENU_RELOAD -> reload()
            MENU_RELOAD_HARD -> reload(ignoreCache = true)
            MENU_CLEAR_CACHE -> confirmClearCache()
            MENU_FIND -> openFindBar()
            MENU_PRINT -> printPage()
            MENU_ZOOM_IN -> changeZoom(10)
            MENU_ZOOM_OUT -> changeZoom(-10)
            MENU_ZOOM_RESET -> changeZoom(0, reset = true)
            MENU_FULLSCREEN -> toggleFullscreen()
            MENU_PARENT -> startActivity(Intent(this, ParentActivity::class.java))
            MENU_UPDATE -> startActivity(Intent(this, UpdateActivity::class.java))
            MENU_PASSWORDS -> startActivity(Intent(this, PasswordsActivity::class.java))
            MENU_DEFAULT -> requestDefaultBrowser()
            MENU_BM_BAR -> {
                val next = !JianXingApp.instance.settingsStore.isBookmarksBarVisible()
                JianXingApp.instance.settingsStore.setBookmarksBarVisible(next)
                applyBookmarksBarVisibility()
            }
            MENU_ABOUT -> showAbout()
        }
    }

    private fun openBookmarks() {
        @Suppress("DEPRECATION")
        startActivityForResult(Intent(this, BookmarksActivity::class.java), BookmarksActivity.REQ_OPEN)
    }

    private fun openHistory() {
        @Suppress("DEPRECATION")
        startActivityForResult(Intent(this, HistoryActivity::class.java), HistoryActivity.REQ_OPEN)
    }

    private fun showAbout() {
        val ver = try {
            packageManager.getPackageInfo(packageName, 0).versionName
        } catch (_: Exception) { "?" }
        AlertDialog.Builder(this)
            .setTitle(R.string.app_name)
            .setMessage("版本 $ver\n面向家庭的青少年浏览器。\n访问由家长配置组控制；历史记录仅家长可删除。")
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    private fun requestDefaultBrowser() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val roleManager = getSystemService(RoleManager::class.java)
            if (roleManager.isRoleAvailable(RoleManager.ROLE_BROWSER)) {
                if (roleManager.isRoleHeld(RoleManager.ROLE_BROWSER)) {
                    toast("已经是默认浏览器")
                    return
                }
                startActivity(roleManager.createRequestRoleIntent(RoleManager.ROLE_BROWSER))
                return
            }
        }
        startActivity(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS))
    }

    private fun changeZoom(delta: Int, reset: Boolean = false) {
        val store = JianXingApp.instance.settingsStore
        val next = if (reset) 100 else store.getTextZoom() + delta
        store.setTextZoom(next)
        applyZoom(activeTab())
        toast("缩放 ${store.getTextZoom()}%")
    }

    private fun applyZoom(tab: BrowserTab?) {
        tab?.webView?.settings?.textZoom = JianXingApp.instance.settingsStore.getTextZoom()
    }

    private fun printPage() {
        val tab = activeTab() ?: return
        val mgr = getSystemService(PRINT_SERVICE) as? PrintManager ?: return
        val adapter = tab.webView.createPrintDocumentAdapter(tab.title.ifBlank { "简行浏览器" })
        mgr.print(tab.title.ifBlank { "简行" }, adapter, PrintAttributes.Builder().build())
    }

    private fun toggleFullscreen() {
        chromeHidden = !chromeHidden
        val show = !chromeHidden
        binding.chrome.isVisible = show
        binding.toolbar.isVisible = show
        applyBookmarksBarVisibility()
        if (chromeHidden) {
            window.decorView.systemUiVisibility =
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        } else {
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
        }
    }

    private fun openFindBar() {
        binding.findBar.isVisible = true
        binding.findInput.requestFocus()
        val q = binding.findInput.text?.toString().orEmpty()
        if (q.isNotEmpty()) activeTab()?.webView?.findAllAsync(q)
    }

    private fun closeFindBar() {
        binding.findBar.isVisible = false
        binding.findCount.text = ""
        activeTab()?.webView?.clearMatches()
    }

    private fun runFind(forward: Boolean, findNext: Boolean) {
        val q = binding.findInput.text?.toString().orEmpty()
        val web = activeTab()?.webView ?: return
        if (q.isEmpty()) {
            web.clearMatches()
            binding.findCount.text = ""
            return
        }
        if (findNext) web.findNext(forward) else web.findAllAsync(q)
    }

    private fun openHomepageBar() {
        binding.homepageError.text = ""
        binding.homepageInput.setText(JianXingApp.instance.settingsStore.getHomepage())
        binding.homepageBar.isVisible = true
        binding.homepageInput.requestFocus()
    }

    private fun closeHomepageBar() {
        binding.homepageBar.isVisible = false
        binding.homepageError.text = ""
    }

    private fun saveHomepageFromBar() {
        val raw = binding.homepageInput.text?.toString().orEmpty()
        if (!JianXingApp.instance.settingsStore.setHomepage(raw)) {
            binding.homepageError.text = "网址无效"
            return
        }
        closeHomepageBar()
        toast("已保存")
    }

    private fun setCurrentHomepage() {
        val url = currentPageUrl()
        if (url.isNullOrBlank()) {
            binding.homepageError.text = "当前没有打开的网页"
            toast("当前没有打开的网页")
            return
        }
        if (!JianXingApp.instance.settingsStore.setHomepage(url)) {
            binding.homepageError.text = "网址无效"
            return
        }
        binding.homepageInput.setText(url)
        closeHomepageBar()
        toast("已保存")
    }

    private fun clearHomepage() {
        JianXingApp.instance.settingsStore.setHomepage("")
        closeHomepageBar()
        toast("已清除")
    }

    private fun closePasswordBar() {
        pendingPassword = null
        binding.passwordBar.isVisible = false
    }

    private fun savePendingPassword() {
        val offer = pendingPassword ?: return
        JianXingApp.instance.sitePasswordsStore.save(offer.origin, offer.username, offer.password)
        closePasswordBar()
        toast("已保存密码")
    }

    private fun offerSaveSitePassword(username: String, password: String) {
        val origin = pageOrigin()
        if (origin.isBlank() || username.isBlank() || password.isBlank()) return
        val store = JianXingApp.instance.sitePasswordsStore
        val existing = store.find(origin, username)
        if (existing != null && existing.password == password) return
        val host = android.net.Uri.parse(origin).host ?: origin
        pendingPassword = PendingPassword(origin, host, username, password, existing != null)
        binding.passwordBarText.text =
            if (existing != null) "更新 $host（$username）的密码？"
            else "保存 $host（$username）的密码？"
        binding.passwordBar.isVisible = true
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if ((requestCode == BookmarksActivity.REQ_OPEN || requestCode == HistoryActivity.REQ_OPEN) &&
            resultCode == RESULT_OK
        ) {
            val url = data?.getStringExtra(
                if (requestCode == HistoryActivity.REQ_OPEN) HistoryActivity.EXTRA_URL
                else BookmarksActivity.EXTRA_URL
            )
            if (!url.isNullOrBlank()) {
                val tab = activeTab() ?: newTab()
                checkAndLoad(tab, url, fromUser = true)
            }
        }
        refreshBookmarksBar()
        updateChrome()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            chromeHidden -> toggleFullscreen()
            appMenuPopup?.isShowing == true -> appMenuPopup?.dismiss()
            binding.findBar.isVisible -> closeFindBar()
            binding.homepageBar.isVisible -> closeHomepageBar()
            binding.passwordBar.isVisible -> closePasswordBar()
            binding.downloadBar.isVisible -> closeDownloadBar()
            activeTab()?.webView?.canGoBack() == true -> goBack()
            else -> super.onBackPressed()
        }
    }

    override fun onDestroy() {
        appMenuPopup?.dismiss()
        downloadHandler.removeCallbacks(downloadPoll)
        guardExecutor.shutdownNow()
        tabs.forEach { it.webView.destroy() }
        tabs.clear()
        super.onDestroy()
    }

    private fun originOf(url: String): String {
        if (!url.startsWith("http://") && !url.startsWith("https://")) return ""
        return try {
            val uri = android.net.Uri.parse(url)
            "${uri.scheme}://${uri.authority}"
        } catch (_: Exception) {
            ""
        }
    }

    private fun pageOrigin(): String {
        val tab = activeTab() ?: return ""
        return originOf(tab.lastCheckedUrl ?: tab.webView.url.orEmpty())
    }

    private fun injectSitePasswordScript(tab: BrowserTab) {
        tab.webView.evaluateJavascript(SITE_PASSWORD_JS, null)
    }

    private fun startDownload(
        url: String,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String?
    ) {
        ensureNotifyPermission()
        if (DownloadsHelper.needsLegacyStoragePermission() &&
            checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            pendingDownload = PendingDownload(url, userAgent, contentDisposition, mimeType)
            requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), REQ_STORAGE)
            return
        }
        beginDownload(url, userAgent, contentDisposition, mimeType)
    }

    private fun beginDownload(
        url: String,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String?
    ) {
        val res = DownloadsHelper.start(this, url, userAgent, contentDisposition, mimeType)
        res.fold(
            onSuccess = {
                showDownloadBar(it)
                startDownloadPoll()
                toast("开始下载 ${it.filename}")
            },
            onFailure = { toast(it.message ?: "下载失败") }
        )
    }

    private fun saveCurrentPage() {
        val url = currentPageUrl()
        if (url.isNullOrBlank()) {
            toast("当前没有可保存的网页")
            return
        }
        startDownload(url, activeTab()?.webView?.settings?.userAgentString, null, "text/html")
    }

    private fun closeDownloadBar() {
        binding.downloadBar.isVisible = false
    }

    private fun showDownloadBar(item: DownloadEntry) {
        currentDownload = item
        val name = item.filename.ifBlank { "download" }
        when {
            item.state == "completed" -> {
                binding.downloadBarText.text = "已下载 $name"
                binding.downloadBarMeta.text = DownloadsHelper.formatBytes(
                    if (item.receivedBytes > 0) item.receivedBytes else item.totalBytes
                )
                binding.downloadBarOpen.isVisible = true
                binding.downloadBarShow.isVisible = true
            }
            item.state == "cancelled" && item.paused -> {
                binding.downloadBarText.text = "已暂停 $name"
                binding.downloadBarMeta.text = ""
                binding.downloadBarOpen.isVisible = false
                binding.downloadBarShow.isVisible = false
            }
            item.state == "cancelled" -> {
                binding.downloadBarText.text = "已取消 $name"
                binding.downloadBarMeta.text = ""
                binding.downloadBarOpen.isVisible = false
                binding.downloadBarShow.isVisible = false
            }
            item.state == "interrupted" -> {
                binding.downloadBarText.text = "下载中断 $name"
                binding.downloadBarMeta.text = ""
                binding.downloadBarOpen.isVisible = false
                binding.downloadBarShow.isVisible = false
            }
            else -> {
                val rec = item.receivedBytes
                val tot = item.totalBytes
                val pct = if (tot > 0) "${minOf(100, ((rec * 100) / tot).toInt())}%" else ""
                binding.downloadBarText.text = "${if (item.paused) "已暂停" else "正在下载"} $name"
                binding.downloadBarMeta.text = listOf(
                    pct,
                    if (tot > 0) "${DownloadsHelper.formatBytes(rec)} / ${DownloadsHelper.formatBytes(tot)}"
                    else if (rec > 0) DownloadsHelper.formatBytes(rec) else ""
                ).filter { it.isNotBlank() }.joinToString(" · ")
                binding.downloadBarOpen.isVisible = false
                binding.downloadBarShow.isVisible = false
            }
        }
        binding.downloadBar.isVisible = true
    }

    private fun refreshDownloadsBadge() {
        val n = DownloadsHelper.activeCount()
        binding.downloadsBadge.isVisible = n > 0
        binding.downloadsBadge.text = if (n > 0) n.toString() else ""
    }

    private fun refreshDownloadsChrome() {
        refreshDownloadsBadge()
        val item = currentDownload?.id?.let { JianXingApp.instance.downloadsStore.get(it) }
            ?: JianXingApp.instance.downloadsStore.latest()
        if (item != null && (binding.downloadBar.isVisible || item.state == "progressing")) {
            showDownloadBar(DownloadsHelper.refresh(this, item))
        } else {
            refreshDownloadsBadge()
        }
    }

    private fun pollDownloads() {
        val store = JianXingApp.instance.downloadsStore
        val items = store.list().map { DownloadsHelper.refresh(this, it) }
        refreshDownloadsBadge()
        val tracked = currentDownload?.id?.let { id -> items.find { it.id == id } }
        val latestActive = items.firstOrNull { it.state == "progressing" && !it.paused }
        val next = latestActive ?: tracked
        if (next != null && (binding.downloadBar.isVisible || next.state == "progressing")) {
            showDownloadBar(next)
        }
    }

    private fun startDownloadPoll() {
        downloadHandler.removeCallbacks(downloadPoll)
        if (DownloadsHelper.activeCount() > 0 || binding.downloadBar.isVisible) {
            downloadHandler.post(downloadPoll)
        } else {
            refreshDownloadsBadge()
        }
    }

    private fun ensureNotifyPermission() {
        if (Build.VERSION.SDK_INT < 33) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        ) return
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
    }

    @Deprecated("Deprecated in Java")
    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_STORAGE) {
            val pending = pendingDownload ?: return
            pendingDownload = null
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                beginDownload(pending.url, pending.userAgent, pending.contentDisposition, pending.mimeType)
            } else {
                toast("需要存储权限才能下载")
            }
        }
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    inner class Bridge {
        @JavascriptInterface
        fun requestAccess(
            url: String?,
            reason: String?,
            mid: String?,
            bvid: String?,
            aid: String?,
            title: String?
        ): String {
            return try {
                JianXingApp.instance.watchRequestsStore.create(
                    url = url.orEmpty(),
                    reason = reason,
                    mid = mid?.takeIf { it.isNotBlank() },
                    bvid = bvid?.takeIf { it.isNotBlank() },
                    aid = aid?.takeIf { it.isNotBlank() },
                    title = title?.takeIf { it.isNotBlank() }
                )
                runOnUiThread { toast("已提交访问申请") }
                "已提交申请，请让家长在「家长 → 访问申请」中处理。"
            } catch (e: Exception) {
                "提交失败：${e.message}"
            }
        }

        @JavascriptInterface
        fun lookupSitePassword(): String {
            val origin = pageOrigin()
            if (origin.isBlank()) return ""
            val hit = JianXingApp.instance.sitePasswordsStore.lookup(origin) ?: return ""
            return JSONObject()
                .put("username", hit.username)
                .put("password", hit.password)
                .toString()
        }

        @JavascriptInterface
        fun submittedSitePassword(username: String?, password: String?) {
            val user = username.orEmpty().trim()
            val pass = password.orEmpty()
            if (user.isBlank() || pass.isBlank()) return
            runOnUiThread { offerSaveSitePassword(user, pass) }
        }
    }

    private class SimpleTextWatcher(private val after: () -> Unit) : android.text.TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
        override fun afterTextChanged(s: android.text.Editable?) { after() }
    }

    companion object {
        private const val MENU_NEW_TAB = 1
        private const val MENU_CLOSE_TAB = 2
        private const val MENU_TOGGLE_BM = 3
        private const val MENU_MANAGE_BM = 4
        private const val MENU_HOME = 5
        private const val MENU_SET_CURRENT_HOME = 6
        private const val MENU_SET_HOME = 7
        private const val MENU_HISTORY = 8
        private const val MENU_DOWNLOADS = 19
        private const val MENU_SAVE_PAGE = 20
        private const val MENU_RELOAD = 21
        private const val MENU_RELOAD_HARD = 22
        private const val MENU_CLEAR_CACHE = 23
        private const val MENU_FIND = 9
        private const val MENU_PRINT = 10
        private const val MENU_ZOOM = 11
        private const val MENU_FULLSCREEN = 12
        private const val MENU_PARENT = 13
        private const val MENU_UPDATE = 14
        private const val MENU_PASSWORDS = 15
        private const val MENU_DEFAULT = 16
        private const val MENU_BM_BAR = 17
        private const val MENU_ABOUT = 18
        private const val MENU_ZOOM_IN = 80
        private const val MENU_ZOOM_OUT = 81
        private const val MENU_ZOOM_RESET = 82

        private const val REQ_NOTIFY = 4104
        private const val REQ_STORAGE = 4105

        private fun newTabId(): String = "t_${UUID.randomUUID().toString().take(8)}"

        private const val SITE_PASSWORD_JS = """
            (function(){
              if (window.__jxPw) return;
              window.__jxPw = true;
              function visible(el){
                if(!el) return false;
                var s=getComputedStyle(el);
                if(s.display==='none'||s.visibility==='hidden') return false;
                var r=el.getBoundingClientRect();
                return r.width>0&&r.height>0;
              }
              function setVal(el,v){
                var d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
                if(d&&d.set) d.set.call(el,v); else el.value=v;
                el.dispatchEvent(new Event('input',{bubbles:true}));
                el.dispatchEvent(new Event('change',{bubbles:true}));
              }
              function collect(){
                var pwds=[].slice.call(document.querySelectorAll('input[type=password],input.jx-pw-shown')).filter(visible);
                if(!pwds.length||!pwds[0].value) return null;
                var scope=pwds[0].form||document;
                var inputs=[].slice.call(scope.querySelectorAll('input')).filter(function(el){
                  var t=String(el.type||'text').toLowerCase();
                  return visible(el)&&t!=='password'&&t!=='hidden'&&t!=='submit'&&t!=='button'&&t!=='checkbox'&&t!=='radio';
                });
                var user=null;
                for(var i=0;i<inputs.length;i++){
                  var key=(inputs[i].name+' '+inputs[i].id+' '+inputs[i].autocomplete+' '+inputs[i].placeholder).toLowerCase();
                  var t=String(inputs[i].type||'text').toLowerCase();
                  if(t==='email'||t==='tel'||/user|email|login|account|phone|mobile|name/.test(key)){ user=inputs[i]; break; }
                }
                if(!user&&inputs[0]) user=inputs[0];
                if(!user||!user.value) return null;
                return {username:user.value.trim(), password:pwds[0].value};
              }
              function fill(creds){
                if(!creds||!creds.password) return;
                var pwds=[].slice.call(document.querySelectorAll('input[type=password]')).filter(visible);
                if(!pwds.length) return;
                var pwd=pwds[0];
                var scope=pwd.form||document;
                var inputs=[].slice.call(scope.querySelectorAll('input')).filter(function(el){
                  var t=String(el.type||'text').toLowerCase();
                  return visible(el)&&t!=='password'&&t!=='hidden'&&t!=='submit'&&t!=='button'&&t!=='checkbox'&&t!=='radio';
                });
                var user=inputs[0]||null;
                if(user&&creds.username&&!user.value) setVal(user,creds.username);
                if(pwd&&!pwd.value) setVal(pwd,creds.password);
              }
              try {
                var raw=window.JianXing&&window.JianXing.lookupSitePassword&&window.JianXing.lookupSitePassword();
                if(raw) fill(JSON.parse(raw));
              } catch(e) {}
              var last='';
              function report(){
                var c=collect();
                if(!c) return;
                var k=c.username+'\\0'+c.password;
                if(k===last) return;
                last=k;
                try { window.JianXing.submittedSitePassword(c.username,c.password); } catch(e) {}
              }
              document.addEventListener('submit',report,true);
              document.addEventListener('keydown',function(e){
                if(e.key==='Enter'&&e.target&&e.target.type==='password') setTimeout(report,0);
              },true);
              document.addEventListener('click',function(e){
                var t=e.target&&e.target.closest&&e.target.closest('button,input[type=submit],input[type=button],[role=button]');
                if(t && !t.classList.contains('jx-pw-eye')) setTimeout(report,80);
              },true);
              function place(input,btn){
                var r=input.getBoundingClientRect();
                var ok=r.width>=48&&r.height>=18&&r.bottom>0&&r.top<innerHeight;
                btn.style.display=ok?'grid':'none';
                if(!ok) return;
                btn.style.left=Math.round(r.right-26)+'px';
                btn.style.top=Math.round(r.top+(r.height-20)/2)+'px';
              }
              function attachEyes(){
                [].slice.call(document.querySelectorAll('input[type=password],input.jx-pw-shown')).forEach(function(input){
                  if(input.dataset.jxEye) return;
                  input.dataset.jxEye='1';
                  var btn=document.createElement('button');
                  btn.type='button';
                  btn.className='jx-pw-eye';
                  btn.textContent='👁';
                  btn.style.cssText='position:fixed;z-index:2147483646;width:20px;height:20px;padding:0;margin:0;border:none;background:transparent;cursor:pointer;display:grid;place-items:center;font-size:13px;line-height:1;';
                  btn.addEventListener('mousedown',function(e){ e.preventDefault(); });
                  btn.addEventListener('click',function(e){
                    e.preventDefault(); e.stopPropagation();
                    var show=input.type==='password';
                    input.type=show?'text':'password';
                    input.classList.toggle('jx-pw-shown',show);
                    btn.textContent=show?'🙈':'👁';
                    place(input,btn);
                  });
                  document.documentElement.appendChild(btn);
                  var sync=function(){ if(!input.isConnected){ btn.remove(); return; } place(input,btn); };
                  window.addEventListener('scroll',sync,true);
                  window.addEventListener('resize',sync);
                  sync();
                });
              }
              attachEyes();
              new MutationObserver(attachEyes).observe(document.documentElement,{childList:true,subtree:true});
            })();
        """
    }
}
