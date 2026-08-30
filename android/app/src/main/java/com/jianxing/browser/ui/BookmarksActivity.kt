package com.jianxing.browser.ui

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.isVisible
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.jianxing.browser.JianXingApp
import com.jianxing.browser.R
import com.jianxing.browser.data.BookmarkNode
import com.jianxing.browser.data.BookmarksStore
import com.jianxing.browser.databinding.ActivityBookmarksBinding
import com.jianxing.browser.sync.SyncClient
import java.util.concurrent.Executors

class BookmarksActivity : AppCompatActivity() {
    private lateinit var binding: ActivityBookmarksBinding
    private val io = Executors.newSingleThreadExecutor()
    private val roots = setOf(BookmarksStore.TOOLBAR_ID, BookmarksStore.OTHER_ID)
    private var selectedFolderId = BookmarksStore.TOOLBAR_ID
    private var selectedItemId: String? = null

    private val treeAdapter = RowAdapter(
        onClick = { node ->
            selectedFolderId = node.id
            selectedItemId = if (node.id in roots) null else node.id
            render()
        }
    )
    private val listAdapter = RowAdapter(
        onClick = { node ->
            selectedItemId = node.id
            renderList()
        },
        onOpen = { node ->
            if (node.type == "folder") {
                selectedFolderId = node.id
                selectedItemId = null
                render()
            } else {
                node.url?.let { openUrl(it) }
            }
        }
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityBookmarksBinding.inflate(layoutInflater)
        setContentView(binding.root)
        binding.folderTree.layoutManager = LinearLayoutManager(this)
        binding.folderTree.adapter = treeAdapter
        binding.itemList.layoutManager = LinearLayoutManager(this)
        binding.itemList.adapter = listAdapter
        binding.appVersion.text = "v${versionName()}"

        binding.btnNewFolder.setOnClickListener { createFolder() }
        binding.btnRename.setOnClickListener { renameSelected() }
        binding.btnMove.setOnClickListener { moveSelected() }
        binding.btnDelete.setOnClickListener { deleteSelected() }
        binding.btnPushBm.setOnClickListener { pushSync() }
        binding.btnPullBm.setOnClickListener { pullSync() }
        render()
        refreshSync()
    }

    override fun onDestroy() {
        io.shutdownNow()
        super.onDestroy()
    }

    private fun store() = JianXingApp.instance.bookmarksStore

    private fun render() {
        treeAdapter.submit(flattenFolders(), selectedFolderId)
        renderList()
    }

    private fun renderList() {
        val folder = store().getNode(selectedFolderId)
        binding.listTitle.text = folder?.title ?: getString(R.string.content_title)
        val items = store().children(selectedFolderId)
        listAdapter.submit(items, selectedItemId)
        binding.emptyHint.isVisible = items.isEmpty()
        binding.itemList.isVisible = items.isNotEmpty()
        val sel = selectedItemId?.let { store().getNode(it) }
        val canMutate = sel != null && sel.id !in roots
        binding.btnRename.isEnabled = canMutate
        binding.btnMove.isEnabled = canMutate
        binding.btnDelete.isEnabled = canMutate
    }

    private fun flattenFolders(): List<BookmarkNode> {
        val out = mutableListOf<BookmarkNode>()
        fun walk(id: String) {
            val node = store().getNode(id) ?: return
            out.add(node)
            store().children(id).filter { it.type == "folder" }.forEach { walk(it.id) }
        }
        walk(BookmarksStore.TOOLBAR_ID)
        walk(BookmarksStore.OTHER_ID)
        return out
    }

    private fun createFolder() {
        prompt("新建文件夹", "文件夹名称", "新建文件夹") { title ->
            val node = store().createFolder(title, selectedFolderId)
            if (node == null) setStatus("创建失败")
            else {
                selectedItemId = node.id
                render()
                setStatus("已创建文件夹")
            }
        }
    }

    private fun renameSelected() {
        val sel = selectedItemId?.let { store().getNode(it) } ?: return
        if (sel.id in roots) return
        prompt("重命名", "名称", sel.title) { title ->
            if (!store().rename(sel.id, title)) setStatus("重命名失败")
            else {
                render()
                setStatus("已重命名")
            }
        }
    }

    private fun deleteSelected() {
        val sel = selectedItemId?.let { store().getNode(it) } ?: return
        if (sel.id in roots) return
        val tip = if (sel.type == "folder") {
            "删除文件夹「${sel.title}」及其全部内容？此操作不可撤销。"
        } else {
            "删除书签「${sel.title}」？"
        }
        AlertDialog.Builder(this)
            .setTitle("确认删除")
            .setMessage(tip)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.remove) { _, _ ->
                store().removeBookmark(sel.id)
                selectedItemId = null
                render()
                setStatus("已删除")
            }
            .show()
    }

    private fun moveSelected() {
        val sel = selectedItemId?.let { store().getNode(it) } ?: return
        if (sel.id in roots) return
        val folders = store().listFolders().filter { it.id != sel.id }
        if (folders.isEmpty()) {
            setStatus("没有可移动到的文件夹")
            return
        }
        val spinner = Spinner(this)
        spinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, folders.map { it.title })
        AlertDialog.Builder(this)
            .setTitle("移动到文件夹")
            .setMessage("将「${sel.title}」移动到")
            .setView(spinner)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                val target = folders.getOrNull(spinner.selectedItemPosition) ?: return@setPositiveButton
                if (!store().move(sel.id, target.id)) setStatus("移动失败")
                else {
                    selectedFolderId = target.id
                    render()
                    setStatus("已移动到「${target.title}」")
                    refreshSync()
                }
            }
            .show()
    }

    private fun prompt(title: String, label: String, value: String, onOk: (String) -> Unit) {
        val input = EditText(this).apply {
            setText(value)
            setTextColor(getColor(R.color.jx_text))
            setHintTextColor(getColor(R.color.jx_muted))
            hint = label
        }
        val pad = (16 * resources.displayMetrics.density).toInt()
        val wrap = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(input)
        }
        AlertDialog.Builder(this)
            .setTitle(title)
            .setView(wrap)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                onOk(input.text?.toString()?.trim().orEmpty())
            }
            .show()
    }

    private fun refreshSync() {
        val account = JianXingApp.instance.accountStore.getSession()
        binding.syncAccount.text = account?.username ?: "未登录账号"
        binding.bmSyncMeta.text = "本地修订 ${store().getRevision()}  /  云端修订 …"
        binding.bmSyncStatus.text = "检查中…"
        val loggedIn = account != null
        binding.btnPushBm.isEnabled = loggedIn
        binding.btnPullBm.isEnabled = loggedIn
        if (!loggedIn) {
            binding.bmSyncStatus.text = "—"
            return
        }
        io.execute {
            val res = SyncClient(JianXingApp.instance.accountStore).pullBookmarks()
            runOnUiThread {
                if (res.ok) {
                    binding.bmSyncMeta.text =
                        "本地修订 ${store().getRevision()}  /  云端修订 ${res.revision ?: 0}"
                    binding.bmSyncStatus.text = "本地收藏夹已是最新"
                } else {
                    binding.bmSyncMeta.text =
                        "本地修订 ${store().getRevision()}  /  云端修订 —"
                    binding.bmSyncStatus.text = res.error ?: "无法连接服务器"
                }
            }
        }
    }

    private fun pushSync() {
        setStatus("正在上传收藏夹…")
        io.execute {
            val res = SyncClient(JianXingApp.instance.accountStore)
                .pushBookmarks(store().toSyncJsonArray(), store().getRevision())
            runOnUiThread {
                if (res.ok) {
                    res.revision?.let { store().setRevision(it) }
                    setStatus("收藏夹已上传")
                } else {
                    setStatus(res.error ?: "上传失败")
                }
                refreshSync()
            }
        }
    }

    private fun pullSync() {
        setStatus("正在拉取收藏夹…")
        io.execute {
            val res = SyncClient(JianXingApp.instance.accountStore).pullBookmarks()
            runOnUiThread {
                if (res.ok && res.nodes != null) {
                    store().replaceFromJson(res.nodes, res.revision)
                    render()
                    setStatus("收藏夹已拉取")
                } else {
                    setStatus(res.error ?: "拉取失败")
                }
                refreshSync()
            }
        }
    }

    private fun openUrl(url: String) {
        setResult(Activity.RESULT_OK, Intent().putExtra(EXTRA_URL, url))
        finish()
    }

    private fun setStatus(msg: String) {
        binding.status.text = msg
    }

    private fun versionName(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "—"
    } catch (_: Exception) { "—" }

    private class RowAdapter(
        private val onClick: (BookmarkNode) -> Unit,
        private val onOpen: ((BookmarkNode) -> Unit)? = null
    ) : RecyclerView.Adapter<RowAdapter.VH>() {
        private var items: List<BookmarkNode> = emptyList()
        private var selectedId: String? = null

        fun submit(list: List<BookmarkNode>, selected: String?) {
            items = list
            selectedId = selected
            notifyDataSetChanged()
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val v = LayoutInflater.from(parent.context).inflate(R.layout.item_bm_row, parent, false)
            return VH(v)
        }

        override fun getItemCount() = items.size

        override fun onBindViewHolder(holder: VH, position: Int) {
            val node = items[position]
            holder.itemView.isSelected = node.id == selectedId
            holder.icon.text = if (node.type == "folder") "📁" else "☆"
            holder.title.text = node.title
            holder.meta.text = if (node.type == "folder") "文件夹" else (node.url ?: "")
            holder.itemView.setOnClickListener { onClick(node) }
            holder.itemView.setOnLongClickListener {
                onOpen?.invoke(node)
                true
            }
        }

        class VH(v: View) : RecyclerView.ViewHolder(v) {
            val icon: TextView = v.findViewById(R.id.rowIcon)
            val title: TextView = v.findViewById(R.id.rowTitle)
            val meta: TextView = v.findViewById(R.id.rowMeta)
        }
    }

    companion object {
        const val EXTRA_URL = "url"
        const val REQ_OPEN = 4101
    }
}
