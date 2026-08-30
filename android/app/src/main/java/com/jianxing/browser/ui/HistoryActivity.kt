package com.jianxing.browser.ui

import android.app.Activity
import android.content.Intent
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
import com.jianxing.browser.databinding.ActivityHistoryBinding
import com.jianxing.browser.model.HistoryEntry
import java.util.Calendar

class HistoryActivity : AppCompatActivity() {
    private lateinit var binding: ActivityHistoryBinding
    private lateinit var adapter: HistoryAdapter
    private var canManage = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityHistoryBinding.inflate(layoutInflater)
        setContentView(binding.root)
        canManage = intent.getBooleanExtra(EXTRA_UNLOCKED, false)
        binding.appVersion.text = "v${versionName()}"
        adapter = HistoryAdapter(
            canDelete = canManage,
            onOpen = { entry ->
                setResult(Activity.RESULT_OK, Intent().putExtra(EXTRA_URL, entry.url))
                finish()
            },
            onDelete = { entry ->
                if (!canManage) return@HistoryAdapter
                JianXingApp.instance.historyStore.remove(entry.id)
                Toast.makeText(this, "已删除", Toast.LENGTH_SHORT).show()
                refresh()
            }
        )
        binding.historyList.layoutManager = LinearLayoutManager(this)
        binding.historyList.adapter = adapter
        binding.btnClearHistory.isVisible = canManage
        binding.btnClearHistory.setOnClickListener {
            if (!canManage) return@setOnClickListener
            AlertDialog.Builder(this)
                .setTitle("清空全部")
                .setMessage("确定清空全部浏览历史？此操作不可恢复。")
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(R.string.history_clear) { _, _ ->
                    JianXingApp.instance.historyStore.clear()
                    Toast.makeText(this, "已清空历史记录", Toast.LENGTH_SHORT).show()
                    refresh()
                }
                .show()
        }
        binding.historySearch.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) { refresh() }
        })
        refresh()
    }

    private fun refresh() {
        val q = binding.historySearch.text?.toString().orEmpty()
        val items = JianXingApp.instance.historyStore.list(q)
        adapter.submit(groupByDay(items))
        binding.historyEmpty.isVisible = items.isEmpty()
        binding.historyList.isVisible = items.isNotEmpty()
    }

    private fun versionName(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "—"
    } catch (_: Exception) { "—" }

    private class HistoryAdapter(
        private val canDelete: Boolean,
        private val onOpen: (HistoryEntry) -> Unit,
        private val onDelete: (HistoryEntry) -> Unit
    ) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
        private var rows: List<Row> = emptyList()

        fun submit(list: List<Row>) {
            rows = list
            notifyDataSetChanged()
        }

        override fun getItemViewType(position: Int) = if (rows[position] is Row.Day) 0 else 1

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
            return if (viewType == 0) {
                DayVH(LayoutInflater.from(parent.context).inflate(R.layout.item_day_label, parent, false))
            } else {
                ItemVH(LayoutInflater.from(parent.context).inflate(R.layout.item_history, parent, false))
            }
        }

        override fun getItemCount() = rows.size

        override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
            when (val row = rows[position]) {
                is Row.Day -> (holder as DayVH).label.text = row.label
                is Row.Item -> {
                    val h = holder as ItemVH
                    val item = row.entry
                    h.title.text = item.title.ifBlank { item.host.ifBlank { item.url } }
                    h.url.text = item.host
                    h.time.text = formatClock(item.visitedAt)
                    h.delete.isVisible = canDelete
                    h.delete.setOnClickListener { if (canDelete) onDelete(item) }
                    h.itemView.setOnClickListener { onOpen(item) }
                }
            }
        }

        class DayVH(v: View) : RecyclerView.ViewHolder(v) {
            val label: TextView = v.findViewById(R.id.dayLabel)
        }

        class ItemVH(v: View) : RecyclerView.ViewHolder(v) {
            val title: TextView = v.findViewById(R.id.histTitle)
            val time: TextView = v.findViewById(R.id.histTime)
            val url: TextView = v.findViewById(R.id.histUrl)
            val delete: View = v.findViewById(R.id.histDelete)
        }
    }

    sealed class Row {
        data class Day(val label: String) : Row()
        data class Item(val entry: HistoryEntry) : Row()
    }

    companion object {
        const val REQ_OPEN = 4102
        const val EXTRA_URL = "url"
        const val EXTRA_UNLOCKED = "unlocked"

        fun groupByDay(entries: List<HistoryEntry>): List<Row> {
            val out = mutableListOf<Row>()
            var last = ""
            for (item in entries) {
                val key = dayKey(item.visitedAt)
                if (key != last) {
                    last = key
                    out.add(Row.Day(dayLabel(item.visitedAt)))
                }
                out.add(Row.Item(item))
            }
            return out
        }

        fun formatClock(ts: Long): String {
            val c = Calendar.getInstance().apply { timeInMillis = ts }
            return "%02d:%02d".format(c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE))
        }

        private fun dayKey(ts: Long): String {
            val c = Calendar.getInstance().apply { timeInMillis = ts }
            return "%04d-%02d-%02d".format(
                c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH)
            )
        }

        fun dayLabel(ts: Long): String {
            val c = Calendar.getInstance().apply { timeInMillis = ts }
            val today = Calendar.getInstance()
            val yest = Calendar.getInstance().apply { add(Calendar.DAY_OF_YEAR, -1) }
            val key = dayKey(ts)
            if (key == dayKey(today.timeInMillis)) return "今天"
            if (key == dayKey(yest.timeInMillis)) return "昨天"
            return "${c.get(Calendar.YEAR)}年${c.get(Calendar.MONTH) + 1}月${c.get(Calendar.DAY_OF_MONTH)}日"
        }
    }
}
