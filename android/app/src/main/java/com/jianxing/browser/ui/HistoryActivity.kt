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
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.isVisible
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.jianxing.browser.JianXingApp
import com.jianxing.browser.R
import com.jianxing.browser.databinding.ActivityHistoryBinding
import com.jianxing.browser.model.HistoryEntry
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class HistoryActivity : AppCompatActivity() {
    private lateinit var binding: ActivityHistoryBinding
    private lateinit var adapter: HistoryAdapter
    private val timeFmt = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault())
    private var canManage = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityHistoryBinding.inflate(layoutInflater)
        setContentView(binding.root)
        canManage = intent.getBooleanExtra(EXTRA_UNLOCKED, false)
        adapter = HistoryAdapter(
            formatTime = { timeFmt.format(Date(it)) },
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
        binding.btnCloseHistory.setOnClickListener { finish() }
        binding.btnClearHistory.isVisible = canManage
        binding.btnClearHistory.setOnClickListener {
            if (!canManage) return@setOnClickListener
            JianXingApp.instance.historyStore.clear()
            Toast.makeText(this, "已清空", Toast.LENGTH_SHORT).show()
            refresh()
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
        adapter.submit(items)
        binding.historyEmpty.isVisible = items.isEmpty()
        binding.historyList.isVisible = items.isNotEmpty()
    }

    private class HistoryAdapter(
        private val formatTime: (Long) -> String,
        private val canDelete: Boolean,
        private val onOpen: (HistoryEntry) -> Unit,
        private val onDelete: (HistoryEntry) -> Unit
    ) : RecyclerView.Adapter<HistoryAdapter.VH>() {
        private var items: List<HistoryEntry> = emptyList()

        fun submit(list: List<HistoryEntry>) {
            items = list
            notifyDataSetChanged()
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val v = LayoutInflater.from(parent.context)
                .inflate(R.layout.item_history, parent, false)
            return VH(v)
        }

        override fun getItemCount(): Int = items.size

        override fun onBindViewHolder(holder: VH, position: Int) {
            val item = items[position]
            holder.title.text = item.title
            holder.time.text = formatTime(item.visitedAt)
            holder.url.text = item.url
            holder.open.setOnClickListener { onOpen(item) }
            holder.delete.isVisible = canDelete
            holder.delete.setOnClickListener {
                if (canDelete) onDelete(item)
            }
            holder.itemView.setOnClickListener { onOpen(item) }
        }

        class VH(v: View) : RecyclerView.ViewHolder(v) {
            val title: TextView = v.findViewById(R.id.histTitle)
            val time: TextView = v.findViewById(R.id.histTime)
            val url: TextView = v.findViewById(R.id.histUrl)
            val open: MaterialButton = v.findViewById(R.id.histOpen)
            val delete: MaterialButton = v.findViewById(R.id.histDelete)
        }
    }

    companion object {
        const val REQ_OPEN = 4102
        const val EXTRA_URL = "url"
        const val EXTRA_UNLOCKED = "unlocked"
    }
}
