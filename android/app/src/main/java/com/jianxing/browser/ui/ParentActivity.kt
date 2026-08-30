package com.jianxing.browser.ui

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.isVisible
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.jianxing.browser.JianXingApp
import com.jianxing.browser.R
import com.jianxing.browser.data.RulesStore
import com.jianxing.browser.databinding.ActivityParentBinding
import com.jianxing.browser.model.BiliConstants
import com.jianxing.browser.model.SiteGroup
import com.jianxing.browser.model.WatchRequest
import com.jianxing.browser.sync.SyncClient
import java.util.concurrent.Executors

class ParentActivity : AppCompatActivity() {
    private lateinit var binding: ActivityParentBinding
    private val io = Executors.newSingleThreadExecutor()
    private var unlocked = false
    private var editingGroupId: String? = null

    private val groupsAdapter = GroupsAdapter { group -> openGroupDetail(group.id) }

    private val detailHostsAdapter = HostsAdapter { host ->
        val gid = editingGroupId ?: return@HostsAdapter
        JianXingApp.instance.rulesStore.removeHost(gid, host)
        refreshGroupDetail()
        refreshGroups()
    }

    private val detailMidsAdapter = HostsAdapter { mid ->
        val gid = editingGroupId ?: return@HostsAdapter
        JianXingApp.instance.rulesStore.removeBiliUp(gid, mid)
        refreshGroupDetail()
        refreshGroups()
    }

    private val pendingAdapter = RequestsAdapter(
        showActions = true,
        onApprove = { approveRequest(it) },
        onReject = {
            JianXingApp.instance.watchRequestsStore.reject(it.id)
            refreshRequests()
            refreshOverview()
            toast("已拒绝")
        }
    )

    private val resolvedAdapter = RequestsAdapter(
        showActions = false,
        onApprove = {},
        onReject = {}
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityParentBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.groupsList.layoutManager = LinearLayoutManager(this)
        binding.groupsList.adapter = groupsAdapter
        binding.detailHostsList.layoutManager = LinearLayoutManager(this)
        binding.detailHostsList.adapter = detailHostsAdapter
        binding.detailMidsList.layoutManager = LinearLayoutManager(this)
        binding.detailMidsList.adapter = detailMidsAdapter
        binding.requestsPendingList.layoutManager = LinearLayoutManager(this)
        binding.requestsPendingList.adapter = pendingAdapter
        binding.requestsResolvedList.layoutManager = LinearLayoutManager(this)
        binding.requestsResolvedList.adapter = resolvedAdapter

        binding.serverInput.setText(JianXingApp.instance.accountStore.getServerUrl())

        setupAuthHandlers()
        setupDashboardHandlers()
        showAuthOrDashboard()
    }

    private fun showAuthOrDashboard() {
        val app = JianXingApp.instance
        if (unlocked) {
            binding.authShell.isVisible = false
            binding.dashboard.isVisible = true
            refreshAllDashboard()
            return
        }
        binding.dashboard.isVisible = false
        binding.authShell.isVisible = true
        if (!app.rulesStore.hasPassword()) {
            binding.setupPanel.isVisible = true
            binding.gatePanel.isVisible = false
        } else {
            binding.setupPanel.isVisible = false
            binding.gatePanel.isVisible = true
            refreshGateAccountUi()
        }
    }

    private fun refreshGateAccountUi() {
        val session = JianXingApp.instance.accountStore.getSession()
        if (session != null) {
            binding.gateAccountHint.text = session.username
            binding.gateAccountHint.isVisible = true
            binding.gateUser.setText(session.username)
            binding.btnGateLogout.isVisible = true
            binding.btnGatePull.isVisible = true
        } else {
            binding.gateAccountHint.text = ""
            binding.gateAccountHint.isVisible = false
            binding.btnGateLogout.isVisible = false
            binding.btnGatePull.isVisible = false
        }
    }

    private fun setupAuthHandlers() {
        val app = JianXingApp.instance

        binding.btnSetup.setOnClickListener {
            val p1 = binding.setupPass.text?.toString().orEmpty()
            val p2 = binding.setupPass2.text?.toString().orEmpty()
            binding.setupError.text = ""
            when {
                p1.length < 4 -> binding.setupError.text = "密码至少 4 位"
                p1 != p2 -> binding.setupError.text = "两次密码不一致"
                else -> {
                    app.rulesStore.setPassword(p1)
                    unlocked = true
                    toast("密码已设置")
                    showAuthOrDashboard()
                }
            }
        }

        binding.btnUnlock.setOnClickListener {
            binding.unlockError.text = ""
            val pwd = binding.unlockPass.text?.toString().orEmpty()
            if (app.rulesStore.verifyPassword(pwd)) {
                unlocked = true
                showAuthOrDashboard()
            } else {
                binding.unlockError.text = "密码错误"
            }
        }

        binding.btnGateLogin.setOnClickListener {
            gateAuth(register = false)
        }
        binding.btnGateRegister.setOnClickListener {
            gateAuth(register = true)
        }
        binding.btnGateLogout.setOnClickListener {
            io.execute {
                SyncClient(app.accountStore).logout()
                runOnUiThread {
                    refreshGateAccountUi()
                    toast("已退出登录")
                }
            }
        }
        binding.btnGatePull.setOnClickListener { pullRules(fromGate = true) }
    }

    private fun gateAuth(register: Boolean) {
        val app = JianXingApp.instance
        val user = binding.gateUser.text?.toString()?.trim().orEmpty()
        val pass = binding.gateAccountPass.text?.toString().orEmpty()
        binding.gateAccountError.text = ""
        if (user.isBlank() || pass.isBlank()) {
            binding.gateAccountError.text = "请填写用户名和密码"
            return
        }
        io.execute {
            val client = SyncClient(app.accountStore)
            val result = if (register) client.register(user, pass) else client.login(user, pass)
            runOnUiThread {
                if (result.ok) {
                    refreshGateAccountUi()
                    toast(if (register) "注册成功" else "登录成功")
                } else {
                    binding.gateAccountError.text = result.error ?: "失败"
                }
            }
        }
    }

    private fun setupDashboardHandlers() {
        binding.navChips.setOnCheckedStateChangeListener { _, checkedIds ->
            val id = checkedIds.firstOrNull() ?: return@setOnCheckedStateChangeListener
            showPage(id)
        }

        binding.filterEnabledSwitch.setOnCheckedChangeListener { _, checked ->
            val store = JianXingApp.instance.rulesStore
            if (store.isFilteringEnabled() == checked) return@setOnCheckedChangeListener
            store.setFilteringEnabled(checked)
            refreshOverview()
        }

        binding.btnOpenHistory.setOnClickListener {
            startActivity(
                Intent(this, HistoryActivity::class.java)
                    .putExtra(HistoryActivity.EXTRA_UNLOCKED, true)
            )
        }

        binding.btnCreateGroup.setOnClickListener {
            val name = binding.newGroupName.text?.toString().orEmpty()
            val bili = binding.newGroupBili.isChecked
            val g = JianXingApp.instance.rulesStore.createGroup(
                name = name,
                extensionId = if (bili) "bilibili" else "none",
                useSuggestedHosts = bili
            )
            if (g == null) {
                toast("请填写配置组名称")
            } else {
                binding.newGroupName.setText("")
                binding.newGroupBili.isChecked = false
                refreshGroups()
                refreshOverview()
                openGroupDetail(g.id)
                toast("已创建")
            }
        }

        binding.groupEnabledSwitch.setOnCheckedChangeListener { _, checked ->
            val gid = editingGroupId ?: return@setOnCheckedChangeListener
            val g = JianXingApp.instance.rulesStore.getGroup(gid) ?: return@setOnCheckedChangeListener
            if (g.enabled != checked) {
                JianXingApp.instance.rulesStore.setEnabled(gid, checked)
                refreshGroups()
                refreshOverview()
            }
        }

        binding.btnDetailAddHost.setOnClickListener {
            val gid = editingGroupId ?: return@setOnClickListener
            val host = binding.detailHostInput.text?.toString().orEmpty()
            if (host.isBlank()) return@setOnClickListener
            JianXingApp.instance.rulesStore.addHost(gid, host)
            binding.detailHostInput.setText("")
            refreshGroupDetail()
            refreshGroups()
        }

        binding.btnDetailAddMid.setOnClickListener {
            val gid = editingGroupId ?: return@setOnClickListener
            val raw = binding.detailMidInput.text?.toString().orEmpty()
            val mid = extractMid(raw)
            if (mid == null) {
                toast("请输入有效 mid 或空间链接")
                return@setOnClickListener
            }
            JianXingApp.instance.rulesStore.addBiliUp(gid, mid)
            binding.detailMidInput.setText("")
            refreshGroupDetail()
            refreshGroups()
        }

        binding.btnDeleteGroup.setOnClickListener {
            val gid = editingGroupId ?: return@setOnClickListener
            AlertDialog.Builder(this)
                .setTitle("删除配置组")
                .setMessage("确定删除该配置组？")
                .setPositiveButton("删除") { _, _ ->
                    JianXingApp.instance.rulesStore.deleteGroup(gid)
                    editingGroupId = null
                    binding.groupDetailPanel.isVisible = false
                    refreshGroups()
                    refreshOverview()
                }
                .setNegativeButton("取消", null)
                .show()
        }

        binding.btnSyncLogin.setOnClickListener { syncAuth(register = false) }
        binding.btnSyncRegister.setOnClickListener { syncAuth(register = true) }
        binding.btnSyncLogout.setOnClickListener {
            io.execute {
                SyncClient(JianXingApp.instance.accountStore).logout()
                runOnUiThread {
                    updateSyncStatus()
                    toast("已退出登录")
                }
            }
        }
        binding.btnSyncPull.setOnClickListener { pullRules(fromGate = false) }
        binding.btnSyncPush.setOnClickListener { pushRules() }
        binding.btnSyncBookmarksPull.setOnClickListener { pullBookmarks() }
        binding.btnSyncBookmarksPush.setOnClickListener { pushBookmarks() }

        binding.btnChangePassword.setOnClickListener {
            val cur = binding.securityCurrent.text?.toString().orEmpty()
            val n1 = binding.securityNew.text?.toString().orEmpty()
            val n2 = binding.securityNew2.text?.toString().orEmpty()
            binding.securityError.text = ""
            when {
                n1.length < 4 -> binding.securityError.text = "新密码至少 4 位"
                n1 != n2 -> binding.securityError.text = "两次新密码不一致"
                !JianXingApp.instance.rulesStore.changePassword(cur, n1) ->
                    binding.securityError.text = "当前密码错误"
                else -> {
                    toast("密码已更新")
                    binding.securityCurrent.setText("")
                    binding.securityNew.setText("")
                    binding.securityNew2.setText("")
                }
            }
        }
    }

    private fun showPage(chipId: Int) {
        binding.pageOverview.isVisible = chipId == R.id.chipOverview
        binding.pageGroups.isVisible = chipId == R.id.chipGroups
        binding.pageRequests.isVisible = chipId == R.id.chipRequests
        binding.pageSync.isVisible = chipId == R.id.chipSync
        binding.pageSecurity.isVisible = chipId == R.id.chipSecurity
        when (chipId) {
            R.id.chipOverview -> refreshOverview()
            R.id.chipGroups -> refreshGroups()
            R.id.chipRequests -> refreshRequests()
            R.id.chipSync -> updateSyncStatus()
        }
    }

    private fun refreshAllDashboard() {
        refreshOverview()
        refreshGroups()
        refreshRequests()
        updateSyncStatus()
        showPage(R.id.chipOverview)
        binding.chipOverview.isChecked = true
    }

    private fun refreshOverview() {
        val app = JianXingApp.instance
        val rules = app.rulesStore.load()
        val pending = app.watchRequestsStore.pending().size
        val session = app.accountStore.getSession()
        val enabled = rules.groups.count { it.enabled }
        val filtering = rules.filteringEnabled
        binding.filterEnabledSwitch.isChecked = filtering
        binding.overviewSummary.text = buildString {
            appendLine(if (filtering) "访问过滤：开" else "访问过滤：关")
            appendLine("配置组：${rules.groups.size}（启用 $enabled）")
            appendLine("待处理访问申请：$pending")
            appendLine(
                if (session != null) {
                    "账号：${session.username} · revision ${session.lastRevision ?: 0}"
                } else {
                    "账号：未登录"
                }
            )
            appendLine("浏览记录：${app.historyStore.count()} 条")
            append("收藏夹 revision：${app.bookmarksStore.getRevision()}")
        }
    }

    private fun refreshGroups() {
        val groups = JianXingApp.instance.rulesStore.load().groups
        groupsAdapter.submit(groups)
        binding.groupsEmpty.isVisible = groups.isEmpty()
        if (editingGroupId != null) refreshGroupDetail()
    }

    private fun openGroupDetail(id: String) {
        editingGroupId = id
        binding.groupDetailPanel.isVisible = true
        refreshGroupDetail()
        binding.pageGroups.post {
            binding.pageGroups.smoothScrollTo(0, binding.groupDetailPanel.top)
        }
    }

    private fun refreshGroupDetail() {
        val gid = editingGroupId ?: return
        val g = JianXingApp.instance.rulesStore.getGroup(gid) ?: run {
            binding.groupDetailPanel.isVisible = false
            return
        }
        binding.groupDetailTitle.text = g.name
        binding.groupEnabledSwitch.setOnCheckedChangeListener(null)
        binding.groupEnabledSwitch.isChecked = g.enabled
        binding.groupEnabledSwitch.setOnCheckedChangeListener { _, checked ->
            val current = JianXingApp.instance.rulesStore.getGroup(gid) ?: return@setOnCheckedChangeListener
            if (current.enabled != checked) {
                JianXingApp.instance.rulesStore.setEnabled(gid, checked)
                refreshGroups()
                refreshOverview()
            }
        }
        detailHostsAdapter.submit(g.hosts)
        val isBili = g.extensionId == "bilibili"
        binding.biliUpsSection.isVisible = isBili
        if (isBili) {
            val cfg = RulesStore.asBiliConfig(g.extensionConfig)
            detailMidsAdapter.submitWithRaw(cfg.allowedMids) { mid ->
                val note = cfg.midNotes[mid]
                if (note.isNullOrBlank()) mid else "$mid（$note）"
            }
        }
    }

    private fun refreshRequests() {
        val pending = JianXingApp.instance.watchRequestsStore.pending()
        val resolved = JianXingApp.instance.watchRequestsStore.resolved()
        pendingAdapter.submit(pending)
        resolvedAdapter.submit(resolved)
        binding.requestsPendingEmpty.isVisible = pending.isEmpty()
        binding.requestsResolvedEmpty.isVisible = resolved.isEmpty()
    }

    private fun approveRequest(req: WatchRequest) {
        val app = JianXingApp.instance
        val host = req.host ?: try {
            java.net.URI(req.url).host
        } catch (_: Exception) {
            null
        }
        val isBili = host != null && (
            host.equals("bilibili.com", true) ||
                host.endsWith(".bilibili.com", true)
            )
        val mid = req.mid?.takeIf { it.matches(Regex("^\\d+$")) }

        if (isBili && mid != null) {
            val rules = app.rulesStore.load()
            val biliGroup = rules.groups.find { it.enabled && it.extensionId == "bilibili" }
            if (biliGroup == null) {
                toast("没有启用的 B 站配置组")
                return
            }
            val note = req.title?.trim()?.takeIf { it.isNotEmpty() }
                ?.let { "访问申请：${it.take(40)}" } ?: "访问申请"
            app.rulesStore.addBiliUp(biliGroup.id, mid, note)
        } else if (!isBili && !host.isNullOrBlank()) {
            app.rulesStore.addHostToRequestGroup(host)
        }

        app.watchRequestsStore.markApproved(req.id)
        refreshRequests()
        refreshGroups()
        refreshOverview()
        toast(
            if (isBili && mid != null) "已同意并加入 UP $mid"
            else "已同意并加入「${BiliConstants.REQUEST_GROUP_NAME}」"
        )
    }

    private fun syncAuth(register: Boolean) {
        val app = JianXingApp.instance
        val server = binding.serverInput.text?.toString()?.trim().orEmpty()
            .ifBlank { SyncClient.DEFAULT_SERVER_URL }
        val user = binding.syncUser.text?.toString()?.trim().orEmpty()
        val pass = binding.syncPass.text?.toString().orEmpty()
        if (user.isBlank() || pass.isBlank()) {
            toast("请填写用户名和密码")
            return
        }
        binding.syncStatus.text = if (register) "正在注册…" else "正在登录…"
        io.execute {
            app.accountStore.setServerUrl(server)
            val client = SyncClient(app.accountStore)
            val result = if (register) client.register(user, pass, server) else client.login(user, pass, server)
            runOnUiThread {
                if (result.ok) {
                    toast(if (register) "注册成功" else "登录成功")
                } else {
                    binding.syncStatus.text = result.error
                }
                updateSyncStatus()
                refreshOverview()
            }
        }
    }

    private fun pullRules(fromGate: Boolean) {
        val app = JianXingApp.instance
        if (app.accountStore.getSession() == null) {
            toast("请先登录账号")
            return
        }
        if (fromGate) binding.gateAccountError.text = "正在拉取…"
        else binding.syncStatus.text = "正在拉取规则…"
        io.execute {
            val client = SyncClient(app.accountStore)
            val pull = client.pull()
            val bm = if (pull.ok) client.pullBookmarks() else null
            runOnUiThread {
                if (pull.ok && pull.groups != null) {
                    app.rulesStore.replaceGroups(pull.groups)
                    if (bm != null && bm.ok && bm.nodes != null) {
                        app.bookmarksStore.replaceFromJson(bm.nodes, bm.revision)
                    }
                    toast("规则已更新（${pull.groups.size} 组）")
                    if (fromGate) binding.gateAccountError.text = ""
                    else binding.syncStatus.text = "拉取成功 · revision ${pull.revision ?: 0}"
                    if (unlocked) {
                        refreshGroups()
                        refreshOverview()
                        updateSyncStatus()
                    } else {
                        refreshGateAccountUi()
                    }
                } else {
                    val err = pull.error ?: "拉取失败"
                    if (fromGate) binding.gateAccountError.text = err
                    else binding.syncStatus.text = err
                }
            }
        }
    }

    private fun pushRules() {
        val app = JianXingApp.instance
        if (app.accountStore.getSession() == null) {
            toast("请先登录账号")
            return
        }
        binding.syncStatus.text = "正在上传规则…"
        io.execute {
            val groups = app.rulesStore.exportGroups()
            val rev = app.accountStore.getSession()?.lastRevision ?: 0
            val push = SyncClient(app.accountStore).push(groups, rev)
            runOnUiThread {
                if (push.ok) {
                    binding.syncStatus.text = "上传成功 · revision ${push.revision ?: 0}"
                    toast("规则已上传")
                    refreshOverview()
                    updateSyncStatus()
                } else {
                    binding.syncStatus.text = push.error ?: "上传失败"
                }
            }
        }
    }

    private fun pullBookmarks() {
        val app = JianXingApp.instance
        if (app.accountStore.getSession() == null) {
            toast("请先登录账号")
            return
        }
        binding.syncStatus.text = "正在拉取收藏夹…"
        io.execute {
            val res = SyncClient(app.accountStore).pullBookmarks()
            runOnUiThread {
                if (res.ok && res.nodes != null) {
                    app.bookmarksStore.replaceFromJson(res.nodes, res.revision)
                    binding.syncStatus.text = "收藏夹已拉取 · revision ${res.revision ?: 0}"
                    toast("收藏夹已更新")
                    refreshOverview()
                } else {
                    binding.syncStatus.text = res.error ?: "拉取收藏夹失败"
                }
            }
        }
    }

    private fun pushBookmarks() {
        val app = JianXingApp.instance
        if (app.accountStore.getSession() == null) {
            toast("请先登录账号")
            return
        }
        binding.syncStatus.text = "正在上传收藏夹…"
        io.execute {
            val nodes = app.bookmarksStore.toSyncJsonArray()
            val rev = app.bookmarksStore.getRevision()
            val res = SyncClient(app.accountStore).pushBookmarks(nodes, rev)
            runOnUiThread {
                if (res.ok) {
                    res.revision?.let { app.bookmarksStore.setRevision(it) }
                    binding.syncStatus.text = "收藏夹已上传 · revision ${res.revision ?: 0}"
                    toast("收藏夹已上传")
                    refreshOverview()
                } else {
                    binding.syncStatus.text = res.error ?: "上传收藏夹失败"
                }
            }
        }
    }

    private fun updateSyncStatus() {
        val s = JianXingApp.instance.accountStore.getSession()
        if (s != null) {
            binding.syncStatus.text = "已登录：${s.username} · revision ${s.lastRevision ?: 0}"
            binding.syncUser.setText(s.username)
            binding.serverInput.setText(s.serverUrl)
        } else {
            binding.syncStatus.text = "未登录"
        }
    }

    private fun extractMid(input: String): String? {
        val trimmed = input.trim()
        if (trimmed.matches(Regex("^\\d+$"))) return trimmed
        try {
            val url = java.net.URI(
                if (trimmed.startsWith("http")) trimmed else "https://$trimmed"
            )
            if (url.host?.contains("space.bilibili.com") == true) {
                val m = Regex("^/(\\d+)").find(url.path ?: "")
                if (m != null) return m.groupValues[1]
            }
        } catch (_: Exception) {
        }
        val spaceMatch = Regex("space\\.bilibili\\.com/(\\d+)").find(trimmed)
        return spaceMatch?.groupValues?.get(1)
    }

    private fun toast(msg: String) =
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    override fun onDestroy() {
        io.shutdownNow()
        super.onDestroy()
    }

    // ── Adapters ──

    private class GroupsAdapter(
        private val onEdit: (SiteGroup) -> Unit
    ) : RecyclerView.Adapter<GroupsAdapter.VH>() {
        private val items = mutableListOf<SiteGroup>()

        fun submit(list: List<SiteGroup>) {
            items.clear()
            items.addAll(list)
            notifyDataSetChanged()
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val v = LayoutInflater.from(parent.context).inflate(R.layout.item_group, parent, false)
            return VH(v)
        }

        override fun getItemCount() = items.size

        override fun onBindViewHolder(holder: VH, position: Int) {
            val g = items[position]
            holder.name.text = g.name
            holder.meta.text = buildString {
                append(if (g.enabled) "启用" else "停用")
                append(" · ")
                append(if (g.extensionId == "bilibili") "B站" else "通用")
            }
            holder.preview.text = if (g.hosts.isEmpty()) "无域名"
            else g.hosts.take(4).joinToString(", ") + if (g.hosts.size > 4) "…" else ""
            holder.edit.setOnClickListener { onEdit(g) }
            holder.itemView.setOnClickListener { onEdit(g) }
        }

        class VH(v: View) : RecyclerView.ViewHolder(v) {
            val name: TextView = v.findViewById(R.id.groupName)
            val meta: TextView = v.findViewById(R.id.groupMeta)
            val preview: TextView = v.findViewById(R.id.groupHostsPreview)
            val edit: MaterialButton = v.findViewById(R.id.btnEditGroup)
        }
    }

    private class HostsAdapter(
        private val onRemove: (String) -> Unit
    ) : RecyclerView.Adapter<HostsAdapter.VH>() {
        private val display = mutableListOf<String>()
        private val raw = mutableListOf<String>()

        fun submit(list: List<String>) {
            display.clear()
            raw.clear()
            display.addAll(list)
            raw.addAll(list)
            notifyDataSetChanged()
        }

        fun submitWithRaw(rawIds: List<String>, displayOf: (String) -> String) {
            display.clear()
            raw.clear()
            rawIds.forEach {
                raw.add(it)
                display.add(displayOf(it))
            }
            notifyDataSetChanged()
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val v = LayoutInflater.from(parent.context).inflate(R.layout.item_host, parent, false)
            return VH(v)
        }

        override fun getItemCount() = display.size

        override fun onBindViewHolder(holder: VH, position: Int) {
            holder.text.text = display[position]
            holder.remove.setOnClickListener { onRemove(raw[position]) }
        }

        class VH(v: View) : RecyclerView.ViewHolder(v) {
            val text: TextView = v.findViewById(R.id.hostText)
            val remove: MaterialButton = v.findViewById(R.id.btnRemoveHost)
        }
    }

    private class RequestsAdapter(
        private val showActions: Boolean,
        private val onApprove: (WatchRequest) -> Unit,
        private val onReject: (WatchRequest) -> Unit
    ) : RecyclerView.Adapter<RequestsAdapter.VH>() {
        private val items = mutableListOf<WatchRequest>()

        fun submit(list: List<WatchRequest>) {
            items.clear()
            items.addAll(list)
            notifyDataSetChanged()
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val v = LayoutInflater.from(parent.context).inflate(R.layout.item_request, parent, false)
            return VH(v)
        }

        override fun getItemCount() = items.size

        override fun onBindViewHolder(holder: VH, position: Int) {
            val req = items[position]
            holder.title.text = req.title ?: req.host ?: "访问申请"
            holder.url.text = req.url
            holder.reason.text = listOfNotNull(req.reason, req.mid?.let { "mid=$it" })
                .joinToString(" · ").ifBlank { "—" }
            holder.actions.isVisible = showActions
            holder.status.isVisible = !showActions
            if (!showActions) {
                holder.status.text = when (req.status) {
                    "approved" -> "已同意"
                    "rejected" -> "已拒绝"
                    else -> req.status
                }
            }
            holder.approve.setOnClickListener { onApprove(req) }
            holder.reject.setOnClickListener { onReject(req) }
        }

        class VH(v: View) : RecyclerView.ViewHolder(v) {
            val title: TextView = v.findViewById(R.id.requestTitle)
            val url: TextView = v.findViewById(R.id.requestUrl)
            val reason: TextView = v.findViewById(R.id.requestReason)
            val status: TextView = v.findViewById(R.id.requestStatus)
            val actions: View = v.findViewById(R.id.requestActions)
            val approve: MaterialButton = v.findViewById(R.id.btnApprove)
            val reject: MaterialButton = v.findViewById(R.id.btnReject)
        }
    }
}
