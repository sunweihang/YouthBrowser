package com.jianxing.browser.ui

import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.isVisible
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.jianxing.browser.JianXingApp
import com.jianxing.browser.R
import com.jianxing.browser.data.SitePasswordEntry
import com.jianxing.browser.databinding.ActivityPasswordsBinding

class PasswordsActivity : AppCompatActivity() {
    private lateinit var binding: ActivityPasswordsBinding
    private val adapter = PasswordAdapter { entry ->
        AlertDialog.Builder(this)
            .setTitle("删除这条密码？")
            .setMessage("${entry.username}\n${entry.host.ifBlank { entry.origin }}")
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.remove) { _, _ ->
                JianXingApp.instance.sitePasswordsStore.remove(entry.id)
                refresh()
            }
            .show()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityPasswordsBinding.inflate(layoutInflater)
        setContentView(binding.root)
        binding.list.layoutManager = LinearLayoutManager(this)
        binding.list.adapter = adapter
        binding.searchInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) { refresh() }
        })
        refresh()
    }

    private fun refresh() {
        val q = binding.searchInput.text?.toString()?.trim()?.lowercase().orEmpty()
        val items = JianXingApp.instance.sitePasswordsStore.list().filter { item ->
            q.isEmpty() ||
                item.host.lowercase().contains(q) ||
                item.origin.lowercase().contains(q) ||
                item.username.lowercase().contains(q)
        }
        adapter.submit(items)
        binding.empty.isVisible = items.isEmpty()
        binding.list.isVisible = items.isNotEmpty()
    }

    private class PasswordAdapter(
        private val onDelete: (SitePasswordEntry) -> Unit
    ) : RecyclerView.Adapter<PasswordAdapter.VH>() {
        private var items: List<SitePasswordEntry> = emptyList()

        fun submit(list: List<SitePasswordEntry>) {
            items = list
            notifyDataSetChanged()
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val v = LayoutInflater.from(parent.context).inflate(R.layout.item_password, parent, false)
            return VH(v)
        }

        override fun getItemCount() = items.size

        override fun onBindViewHolder(holder: VH, position: Int) {
            val item = items[position]
            holder.user.text = item.username.ifBlank { "—" }
            holder.host.text = item.host.ifBlank { item.origin }
            holder.delete.setOnClickListener { onDelete(item) }
        }

        class VH(v: View) : RecyclerView.ViewHolder(v) {
            val user: TextView = v.findViewById(R.id.pwUser)
            val host: TextView = v.findViewById(R.id.pwHost)
            val delete: View = v.findViewById(R.id.pwDelete)
        }
    }
}
