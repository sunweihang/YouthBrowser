package com.jianxing.browser.ui

import android.annotation.SuppressLint
import android.app.role.RoleManager
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.TypedValue
import android.view.KeyEvent
import android.view.MenuItem
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.PopupMenu
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.text.InputType
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.isVisible
import com.google.android.material.button.MaterialButton
import com.jianxing.browser.JianXingApp
import com.jianxing.browser.databinding.ActivityMainBinding
import com.jianxing.browser.guard.NavigationGuard
import com.jianxing.browser.model.BlockReason
import org.json.JSONObject
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private val guardExecutor = Executors.newSingleThreadExecutor()
    private var lastCheckedUrl: String? = null
    private var loadingBlockedPage = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val web = binding.webView
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.setSupportZoom(true)
        web.settings.builtInZoomControls = true
        web.settings.displayZoomControls = false
        web.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            web.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_YES
        }
        web.addJavascriptInterface(Bridge(), "JianXing")

        web.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                binding.progress.isVisible = newProgress in 1..99
                binding.progress.progress = newProgress
            }
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val url = request?.url?.toString() ?: return false
                if (url.startsWith("file:///android_asset/")) return false
                checkAndLoad(url, fromUser = false)
                return true
            }

            @Deprecated("Deprecated in Java")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                if (url.isNullOrBlank() || url.startsWith("file:///android_asset/")) return false
                checkAndLoad(url, fromUser = false)
                return true
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                if (!loadingBlockedPage && url != null && !url.startsWith("file:///android_asset/")) {
                    binding.urlBar.setText(url)
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                loadingBlockedPage = false
                updateNavButtons()
                updateStarButton()
                if (!url.isNullOrBlank() &&
                    (url.startsWith("http://") || url.startsWith("https://"))
                ) {
                    val title = view?.title?.takeIf { it.isNotBlank() } ?: url
                    JianXingApp.instance.historyStore.record(url, title)
                    injectSitePasswordScript()
                }
            }
        }

        binding.btnBack.setOnClickListener {
            if (web.canGoBack()) web.goBack()
        }
        binding.btnForward.setOnClickListener {
            if (web.canGoForward()) web.goForward()
        }
        binding.btnReload.setOnClickListener {
            val current = web.url
            if (current != null && current.startsWith("file:///android_asset/")) {
                val original = NavigationGuard.parseQueryParam(current, "url")
                if (!original.isNullOrBlank()) checkAndLoad(original, fromUser = true)
            } else {
                web.reload()
            }
        }
        binding.btnGo.setOnClickListener { navigateFromBar() }
        binding.btnStar.setOnClickListener { toggleBookmark() }
        binding.btnMenu.setOnClickListener { showAppMenu(it) }
        binding.urlBar.setOnEditorActionListener { _, actionId, event ->
            if (actionId == EditorInfo.IME_ACTION_GO ||
                (event != null && event.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN)
            ) {
                navigateFromBar()
                true
            } else false
        }

        val launchUrl = extractHttpUrl(intent)
        if (launchUrl != null) {
            checkAndLoad(launchUrl, fromUser = true)
        } else {
            openHomepage()
        }
        refreshBookmarksBar()
        updateNavButtons()
        updateStarButton()
        updateUrlHint()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val url = extractHttpUrl(intent)
        if (url != null) checkAndLoad(url, fromUser = true)
    }

    override fun onResume() {
        super.onResume()
        refreshBookmarksBar()
        updateStarButton()
        updateUrlHint()
    }

    private fun extractHttpUrl(intent: Intent?): String? {
        val data = intent?.data?.toString() ?: return null
        return if (data.startsWith("http://") || data.startsWith("https://")) data else null
    }

    private fun requestDefaultBrowser() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val roleManager = getSystemService(RoleManager::class.java)
            if (roleManager.isRoleAvailable(RoleManager.ROLE_BROWSER)) {
                if (roleManager.isRoleHeld(RoleManager.ROLE_BROWSER)) {
                    Toast.makeText(this, "已经是默认浏览器", Toast.LENGTH_SHORT).show()
                    return
                }
                startActivity(roleManager.createRequestRoleIntent(RoleManager.ROLE_BROWSER))
                return
            }
        }
        startActivity(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS))
    }

    private fun updateUrlHint() {
        val filtered = JianXingApp.instance.rulesStore.isFilteringEnabled()
        binding.urlBar.hint = getString(
            if (filtered) R.string.url_hint_filtered else R.string.url_hint
        )
    }

    private fun currentPageUrl(): String {
        val url = binding.webView.url.orEmpty()
        return if (url.startsWith("http://") || url.startsWith("https://")) url else ""
    }

    private fun showHomepageDialog() {
        val store = JianXingApp.instance.rulesStore
        val input = EditText(this).apply {
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setText(store.getHomepage())
            hint = getString(R.string.homepage_hint)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.homepage)
            .setView(input)
            .setNeutralButton(R.string.homepage_use_current) { _, _ ->
                val url = currentPageUrl()
                if (url.isBlank()) {
                    Toast.makeText(this, "当前没有打开的网页", Toast.LENGTH_SHORT).show()
                    return@setNeutralButton
                }
                if (!store.setHomepage(url)) {
                    Toast.makeText(this, "网址无效", Toast.LENGTH_SHORT).show()
                    return@setNeutralButton
                }
                Toast.makeText(this, "已保存", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton(R.string.homepage_clear) { _, _ ->
                store.setHomepage("")
                Toast.makeText(this, "已清除", Toast.LENGTH_SHORT).show()
            }
            .setPositiveButton(R.string.save) { _, _ ->
                val raw = input.text?.toString().orEmpty()
                if (!store.setHomepage(raw)) {
                    Toast.makeText(this, "网址无效", Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }
                Toast.makeText(this, "已保存", Toast.LENGTH_SHORT).show()
            }
            .show()
    }

    private fun openHomepage() {
        val home = JianXingApp.instance.rulesStore.getHomepage()
        if (home.isNotBlank()) {
            checkAndLoad(home, fromUser = true)
        } else {
            binding.webView.loadDataWithBaseURL(null, homeHtml(), "text/html", "UTF-8", null)
            binding.urlBar.setText("")
        }
    }

    private fun homeHtml(): String {
        val filtered = JianXingApp.instance.rulesStore.isFilteringEnabled()
        val hint = if (filtered) {
            "请在地址栏输入已授权的网址"
        } else {
            "访问过滤未开启。请在地址栏输入网址开始浏览"
        }
        return HOME_HTML.replace("<!--HINT-->", hint)
    }

    private fun navigateFromBar() {
        val raw = binding.urlBar.text?.toString()?.trim().orEmpty()
        if (raw.isEmpty()) return
        checkAndLoad(raw, fromUser = true)
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

    private fun checkAndLoad(rawUrl: String, @Suppress("UNUSED_PARAMETER") fromUser: Boolean) {
        val app = JianXingApp.instance
        val candidate = normalizeForCheck(rawUrl)
        guardExecutor.execute {
            // Approved watch-request URLs bypass the guard (Electron parity)
            if (candidate.startsWith("http") && app.watchRequestsStore.isApprovedUrl(candidate)) {
                runOnUiThread {
                    lastCheckedUrl = candidate
                    binding.urlBar.setText(candidate)
                    binding.webView.loadUrl(candidate)
                    updateNavButtons()
                    updateStarButton()
                }
                return@execute
            }
            val rules = app.rulesStore.load()
            val result = NavigationGuard.canNavigate(rawUrl, rules)
            runOnUiThread {
                if (result.allowed) {
                    val finalUrl = result.finalUrl ?: rawUrl
                    lastCheckedUrl = finalUrl
                    if (!finalUrl.startsWith("file:")) {
                        binding.urlBar.setText(finalUrl)
                    }
                    binding.webView.loadUrl(finalUrl)
                } else {
                    showBlock(
                        rawUrl,
                        result.reason,
                        result.message,
                        result.mid,
                        result.bvid,
                        result.aid,
                        result.title
                    )
                }
                updateNavButtons()
                updateStarButton()
            }
        }
    }

    private fun showBlock(
        originalUrl: String,
        reason: BlockReason?,
        message: String?,
        mid: String?,
        bvid: String?,
        aid: String?,
        title: String?
    ) {
        loadingBlockedPage = true
        val blockUrl = NavigationGuard.buildBlockAssetUrl(
            originalUrl = originalUrl,
            reason = reason,
            message = message ?: "未授权的网站或内容",
            mid = mid,
            bvid = bvid,
            aid = aid,
            title = title
        )
        binding.webView.loadUrl(blockUrl)
    }

    private fun currentPageUrl(): String? {
        val url = binding.webView.url ?: return null
        if (url.startsWith("file:///android_asset/")) {
            val original = NavigationGuard.parseQueryParam(url, "url")
            if (!original.isNullOrBlank() && original.startsWith("http")) return original
            return null
        }
        if (url.startsWith("file:") || url.startsWith("data:") || url.startsWith("about:")) return null
        if (!url.startsWith("http")) return null
        return url
    }

    private fun toggleBookmark() {
        val url = currentPageUrl()
        if (url == null) {
            Toast.makeText(this, "只能收藏网页地址", Toast.LENGTH_SHORT).show()
            return
        }
        val title = binding.webView.title?.takeIf { it.isNotBlank() } ?: url
        val bookmarked = JianXingApp.instance.bookmarksStore.toggle(url, title)
        Toast.makeText(
            this,
            if (bookmarked) "已加入书签" else "已取消书签",
            Toast.LENGTH_SHORT
        ).show()
        updateStarButton()
        refreshBookmarksBar()
    }

    private fun updateStarButton() {
        val url = currentPageUrl()
        val starred = url != null && JianXingApp.instance.bookmarksStore.isBookmarked(url)
        binding.btnStar.text = if (starred) "★ 已收藏" else "☆ 收藏"
    }

    private fun refreshBookmarksBar() {
        val bar = binding.bookmarksBar
        bar.removeAllViews()
        val items = JianXingApp.instance.bookmarksStore.listAllBookmarks()
        binding.bookmarksEmpty.isVisible = items.isEmpty()
        binding.bookmarksScroll.isVisible = true
        val pad = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, 8f, resources.displayMetrics
        ).toInt()
        items.forEach { bm ->
            val btn = MaterialButton(
                this,
                null,
                com.google.android.material.R.attr.materialButtonOutlinedStyle
            ).apply {
                text = bm.title.take(16)
                textSize = 12f
                minimumHeight = 0
                minHeight = 0
                setPadding(pad, pad / 2, pad, pad / 2)
                setOnClickListener {
                    val u = bm.url ?: return@setOnClickListener
                    checkAndLoad(u, fromUser = true)
                }
            }
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { marginEnd = pad / 2 }
            bar.addView(btn, lp)
        }
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
            if (!url.isNullOrBlank()) checkAndLoad(url, fromUser = true)
        }
        refreshBookmarksBar()
        updateStarButton()
    }

    private fun showAppMenu(anchor: android.view.View) {
        val popup = PopupMenu(this, anchor)
        popup.menu.add(0, 1, 0, getString(R.string.menu_new_bookmark))
        popup.menu.add(0, 2, 1, getString(R.string.menu_bookmarks))
        popup.menu.add(0, 3, 2, getString(R.string.menu_history))
        popup.menu.add(0, 4, 3, getString(R.string.menu_home))
        popup.menu.add(0, 5, 4, getString(R.string.menu_set_homepage))
        popup.menu.add(0, 6, 5, getString(R.string.menu_parent))
        popup.menu.add(0, 7, 6, getString(R.string.menu_default_browser))
        popup.menu.add(0, 8, 7, getString(R.string.menu_saved_passwords))
        popup.menu.add(0, 9, 8, getString(R.string.menu_about))
        popup.setOnMenuItemClickListener { item: MenuItem ->
            when (item.itemId) {
                1 -> toggleBookmark()
                2 -> {
                    @Suppress("DEPRECATION")
                    startActivityForResult(
                        Intent(this, BookmarksActivity::class.java),
                        BookmarksActivity.REQ_OPEN
                    )
                }
                3 -> {
                    @Suppress("DEPRECATION")
                    startActivityForResult(
                        Intent(this, HistoryActivity::class.java),
                        HistoryActivity.REQ_OPEN
                    )
                }
                4 -> openHomepage()
                5 -> showHomepageDialog()
                6 -> startActivity(Intent(this, ParentActivity::class.java))
                7 -> requestDefaultBrowser()
                8 -> showSavedPasswords()
                9 -> {
                    AlertDialog.Builder(this)
                        .setTitle(R.string.app_name)
                        .setMessage("面向家庭的青少年浏览器。\n访问由家长配置组控制；历史记录仅家长可删除。")
                        .setPositiveButton(android.R.string.ok, null)
                        .show()
                }
            }
            true
        }
        popup.show()
    }

    private fun updateNavButtons() {
        binding.btnBack.isEnabled = binding.webView.canGoBack()
        binding.btnForward.isEnabled = binding.webView.canGoForward()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (binding.webView.canGoBack()) {
            binding.webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        guardExecutor.shutdownNow()
        binding.webView.destroy()
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

    private fun pageOrigin(): String = originOf(lastCheckedUrl ?: binding.webView.url.orEmpty())

    private fun injectSitePasswordScript() {
        binding.webView.evaluateJavascript(SITE_PASSWORD_JS, null)
    }

    private fun offerSaveSitePassword(username: String, password: String) {
        val origin = pageOrigin()
        if (origin.isBlank() || username.isBlank() || password.isBlank()) return
        val store = JianXingApp.instance.sitePasswordsStore
        val existing = store.find(origin, username)
        if (existing != null && existing.password == password) return
        val host = android.net.Uri.parse(origin).host ?: origin
        val title = if (existing != null) "更新密码" else "保存密码"
        AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage("$host\n$username")
            .setNegativeButton("不保存", null)
            .setPositiveButton("保存") { _, _ ->
                store.save(origin, username, password)
            }
            .show()
    }

    private fun showSavedPasswords() {
        val store = JianXingApp.instance.sitePasswordsStore
        val items = store.list()
        if (items.isEmpty()) {
            Toast.makeText(this, "还没有保存的网站密码", Toast.LENGTH_SHORT).show()
            return
        }
        val labels = items.map { "${it.username}  ·  ${it.host.ifBlank { it.origin }}" }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle(R.string.menu_saved_passwords)
            .setItems(labels) { _, which ->
                val entry = items.getOrNull(which) ?: return@setItems
                AlertDialog.Builder(this)
                    .setTitle("删除这条密码？")
                    .setMessage("${entry.username}\n${entry.host}")
                    .setNegativeButton(android.R.string.cancel, null)
                    .setPositiveButton(R.string.remove) { _, _ ->
                        store.remove(entry.id)
                    }
                    .show()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

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
                val app = JianXingApp.instance
                app.watchRequestsStore.create(
                    url = url.orEmpty(),
                    reason = reason,
                    mid = mid?.takeIf { it.isNotBlank() },
                    bvid = bvid?.takeIf { it.isNotBlank() },
                    aid = aid?.takeIf { it.isNotBlank() },
                    title = title?.takeIf { it.isNotBlank() }
                )
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "已提交访问申请", Toast.LENGTH_SHORT).show()
                }
                "已提交申请，请让家长在「家长 → 访问申请」中处理。"
            } catch (e: Exception) {
                "提交失败：${e.message}"
            }
        }

        @JavascriptInterface
        fun lookupSitePassword(): String {
            val origin = originOf(lastCheckedUrl.orEmpty())
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

    companion object {
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

        private const val HOME_HTML = """
            <!DOCTYPE html><html lang="zh-CN"><head>
            <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
            <title>简行浏览器</title>
            <style>
              body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
                font-family:"PingFang SC","Noto Sans SC",system-ui,sans-serif;
                background:linear-gradient(165deg,#e8f0ec,#f3f6f4);
                color:#1a2420;text-align:center;padding:24px}
              .brand{color:#1b6b4a;font-weight:700;letter-spacing:.04em;margin:0 0 8px;font-size:14px}
              h1{color:#1b6b4a;font-size:28px;margin:0 0 12px}
              p{color:#5c6b64;margin:0;line-height:1.6}
            </style></head><body>
            <div>
              <p class="brand">简行浏览器</p>
              <h1>欢迎使用</h1>
              <p><!--HINT--></p>
            </div>
            </body></html>
        """
    }
}
