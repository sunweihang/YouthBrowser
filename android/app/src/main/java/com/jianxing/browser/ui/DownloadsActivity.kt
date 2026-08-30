package com.jianxing.browser.ui

import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
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
import com.jianxing.browser.JianXingApp
import com.jianxing.browser.R
import com.jianxing.browser.data.DownloadsHelper
import com.jianxing.browser.databinding.ActivityDownloadsBinding
import com.jianxing.browser.model.DownloadEntry
import java.util.Calendar

class DownloadsActivity : AppCompatActivity() {
    private lateinit var binding: ActivityDownloadsBinding
    private lateinit var adapter: DownloadsAdapter

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityDownloadsBinding.inflate(layoutInflater)
        setContentView(binding.root)
        binding.appVersion.text = "v${versionName()}"
        adapter = DownloadsAdapter(
            onOpen = { openFile(it) },
            onFolder = { showDownloadsApp() },
            onRemove = { entry ->
                JianXingApp.instance.downloadsStore.remove(entry.id)
                refresh()
            }
        )
        binding.downloadsList.layoutManager = LinearLayoutManager(this)
        binding.downloadsList.adapter = adapter
        binding.btnOpenFolder.setOnClickListener { showDownloadsApp() }
        binding.btnClearDownloads.setOnClickListener {
            AlertDialog.Builder(this)
                .setTitle("清空列表")
                .setMessage("从列表移除已结束的下载？文件仍保留在下载文件夹。")
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(R.string.downloads_clear) { _, _ ->
                    JianXingApp.instance.downloadsStore.clear()
                    refresh()
                }
                .show()
        }
        binding.downloadsSearch.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) { refresh() }
        })
        refresh()
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        val q = binding.downloadsSearch.text?.toString().orEmpty()
        val items = JianXingApp.instance.downloadsStore.list(q).map {
            DownloadsHelper.refresh(this, it)
        }
        adapter.submit(groupByDay(items))
        binding.downloadsEmpty.isVisible = items.isEmpty()
        binding.downloadsList.isVisible = items.isNotEmpty()
    }

    private fun openFile(entry: DownloadEntry) {
        val fresh = DownloadsHelper.refresh(this, entry)
        val uri = when {
            fresh.systemId >= 0 -> {
                val dm = getSystemService(DOWNLOAD_SERVICE) as DownloadManager
                dm.getUriForDownloadedFile(fresh.systemId)
            }
            fresh.filePath.startsWith("content:") || fresh.filePath.startsWith("file:") ->
                Uri.parse(fresh.filePath)
            else -> null
        }
        if (uri == null) {
            Toast.makeText(this, "文件不存在", Toast.LENGTH_SHORT).show()
            return
        }
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, fresh.mime.ifBlank { "*/*" })
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, "没有可打开此文件的应用", Toast.LENGTH_SHORT).show()
        }
    }

    private fun showDownloadsApp() {
        try {
            startActivity(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS))
        } catch (_: Exception) {
            Toast.makeText(this, "无法打开系统下载", Toast.LENGTH_SHORT).show()
        }
    }

    private fun versionName(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "—"
    } catch (_: Exception) { "—" }

    private class DownloadsAdapter(
        private val onOpen: (DownloadEntry) -> Unit,
        private val onFolder: (DownloadEntry) -> Unit,
        private val onRemove: (DownloadEntry) -> Unit
    ) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
        private var rows: List<Row> = emptyList()

        fun submit(list: List<Row>) {
            rows = list
            notifyDataSetChanged()
        }

        override fun getItemViewType(position: Int) = if (rows[position] is Row.Day) 0 else 1
        override fun getItemCount() = rows.size

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
            return if (viewType == 0) {
                DayVH(LayoutInflater.from(parent.context).inflate(R.layout.item_day_label, parent, false))
            } else {
                ItemVH(LayoutInflater.from(parent.context).inflate(R.layout.item_download, parent, false))
            }
        }

        override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
            when (val row = rows[position]) {
                is Row.Day -> (holder as DayVH).label.text = row.label
                is Row.Item -> {
                    val h = holder as ItemVH
                    val item = row.entry
                    h.title.text = item.filename
                    h.time.text = HistoryActivity.formatClock(item.startedAt)
                    h.meta.text = statusText(item)
                    val done = item.state == "completed"
                    h.open.isVisible = done
                    h.folder.isVisible = done
                    h.open.setOnClickListener { onOpen(item) }
                    h.folder.setOnClickListener { onFolder(item) }
                    h.remove.setOnClickListener { onRemove(item) }
                    h.itemView.setOnClickListener { if (done) onOpen(item) }
                }
            }
        }

        class DayVH(v: View) : RecyclerView.ViewHolder(v) {
            val label: TextView = v.findViewById(R.id.dayLabel)
        }

        class ItemVH(v: View) : RecyclerView.ViewHolder(v) {
            val title: TextView = v.findViewById(R.id.dlTitle)
            val time: TextView = v.findViewById(R.id.dlTime)
            val meta: TextView = v.findViewById(R.id.dlMeta)
            val open: View = v.findViewById(R.id.dlOpen)
            val folder: View = v.findViewById(R.id.dlFolder)
            val remove: View = v.findViewById(R.id.dlRemove)
        }
    }

    sealed class Row {
        data class Day(val label: String) : Row()
        data class Item(val entry: DownloadEntry) : Row()
    }

    companion object {
        private fun groupByDay(entries: List<DownloadEntry>): List<Row> {
            val out = mutableListOf<Row>()
            var last = ""
            for (item in entries) {
                val key = dayKey(item.startedAt)
                if (key != last) {
                    last = key
                    out.add(Row.Day(HistoryActivity.dayLabel(item.startedAt)))
                }
                out.add(Row.Item(item))
            }
            return out
        }

        private fun dayKey(ts: Long): String {
            val c = Calendar.getInstance().apply { timeInMillis = ts }
            return "%04d-%02d-%02d".format(
                c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH)
            )
        }

        private fun statusText(item: DownloadEntry): String {
            val state = when (item.state) {
                "completed" -> "已完成"
                "cancelled" -> "已取消"
                "interrupted" -> "已中断"
                else -> "下载中"
            }
            val size = if (item.totalBytes > 0) formatBytes(item.totalBytes)
            else if (item.receivedBytes > 0) formatBytes(item.receivedBytes)
            else ""
            return listOf(state, size).filter { it.isNotBlank() }.joinToString(" · ")
        }

        private fun formatBytes(n: Long): String {
            if (n < 1024) return "$n B"
            if (n < 1024 * 1024) return "%.1f KB".format(n / 1024.0)
            if (n < 1024L * 1024 * 1024) return "%.1f MB".format(n / (1024.0 * 1024))
            return "%.1f GB".format(n / (1024.0 * 1024 * 1024))
        }
    }
}
