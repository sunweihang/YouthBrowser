package com.jianxing.browser.ui

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ProgressBar
import android.widget.TextView
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
    private val pollHandler = Handler(Looper.getMainLooper())
    private val poll = object : Runnable {
        override fun run() {
            refresh(silent = true)
            if (hasActive()) pollHandler.postDelayed(this, 800)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityDownloadsBinding.inflate(layoutInflater)
        setContentView(binding.root)
        binding.appVersion.text = "v${versionName()}"
        adapter = DownloadsAdapter(
            onOpen = { DownloadsHelper.openFile(this, it) },
            onFolder = { DownloadsHelper.openFolder(this) },
            onPause = { entry ->
                DownloadsHelper.pause(this, entry)
                refresh()
            },
            onResume = { entry ->
                DownloadsHelper.resume(this, entry).fold(
                    onSuccess = { refresh() },
                    onFailure = { refresh() }
                )
            },
            onCancel = { entry ->
                DownloadsHelper.cancel(this, entry)
                refresh()
            },
            onRemove = { entry ->
                if (entry.state == "progressing") DownloadsHelper.cancel(this, entry)
                JianXingApp.instance.downloadsStore.remove(entry.id)
                refresh()
            }
        )
        binding.downloadsList.layoutManager = LinearLayoutManager(this)
        binding.downloadsList.adapter = adapter
        binding.btnOpenFolder.setOnClickListener { DownloadsHelper.openFolder(this) }
        binding.btnClearDownloads.setOnClickListener {
            AlertDialog.Builder(this)
                .setTitle("清空列表")
                .setMessage("从列表移除已结束的下载？进行中的下载会保留，文件仍在下载文件夹。")
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
        startPoll()
    }

    override fun onPause() {
        pollHandler.removeCallbacks(poll)
        super.onPause()
    }

    private fun hasActive(): Boolean = DownloadsHelper.activeCount() > 0

    private fun startPoll() {
        pollHandler.removeCallbacks(poll)
        if (hasActive()) pollHandler.postDelayed(poll, 800)
    }

    private fun refresh(silent: Boolean = false) {
        val q = binding.downloadsSearch.text?.toString().orEmpty()
        val items = JianXingApp.instance.downloadsStore.list(q).map {
            DownloadsHelper.refresh(this, it)
        }
        adapter.submit(groupByDay(items))
        binding.downloadsEmpty.isVisible = items.isEmpty()
        binding.downloadsList.isVisible = items.isNotEmpty()
        if (!silent) startPoll()
    }

    private fun versionName(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "—"
    } catch (_: Exception) { "—" }

    private class DownloadsAdapter(
        private val onOpen: (DownloadEntry) -> Unit,
        private val onFolder: (DownloadEntry) -> Unit,
        private val onPause: (DownloadEntry) -> Unit,
        private val onResume: (DownloadEntry) -> Unit,
        private val onCancel: (DownloadEntry) -> Unit,
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
                    h.meta.text = DownloadsHelper.statusText(item)
                    val progressing = item.state == "progressing" && !item.paused
                    val paused = item.paused
                    val done = item.state == "completed"
                    val pct = if (item.totalBytes > 0) {
                        ((item.receivedBytes * 100) / item.totalBytes).toInt().coerceIn(0, 100)
                    } else 8
                    h.progress.isVisible = progressing
                    if (progressing) h.progress.progress = pct
                    h.pause.isVisible = progressing
                    h.resume.isVisible = paused
                    h.cancel.isVisible = progressing
                    h.open.isVisible = done
                    h.folder.isVisible = done
                    h.pause.setOnClickListener { onPause(item) }
                    h.resume.setOnClickListener { onResume(item) }
                    h.cancel.setOnClickListener { onCancel(item) }
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
            val progress: ProgressBar = v.findViewById(R.id.dlProgress)
            val pause: View = v.findViewById(R.id.dlPause)
            val resume: View = v.findViewById(R.id.dlResume)
            val cancel: View = v.findViewById(R.id.dlCancel)
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
    }
}
