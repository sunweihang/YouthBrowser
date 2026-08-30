package com.jianxing.browser.ui

import android.app.Activity
import android.content.Intent
import android.os.Bundle
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
import com.jianxing.browser.data.BookmarkNode
import com.jianxing.browser.databinding.ActivityBookmarksBinding

class BookmarksActivity : AppCompatActivity() {
    private lateinit var binding: ActivityBookmarksBinding
    private val adapter = BookmarksAdapter(
        onOpen = { bm ->
            val url = bm.url ?: return@BookmarksAdapter
            setResult(Activity.RESULT_OK, Intent().putExtra(EXTRA_URL, url))
            finish()
        },
        onDelete = { bm ->
            JianXingApp.instance.bookmarksStore.removeBookmark(bm.id)
            Toast.makeText(this, "已删除", Toast.LENGTH_SHORT).show()
            refresh()
        }
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityBookmarksBinding.inflate(layoutInflater)
        setContentView(binding.root)
        binding.bookmarksList.layoutManager = LinearLayoutManager(this)
        binding.bookmarksList.adapter = adapter
        binding.btnCloseBookmarks.setOnClickListener { finish() }
        refresh()
    }

    private fun refresh() {
        val items = JianXingApp.instance.bookmarksStore.listAllBookmarks()
        adapter.submit(items)
        binding.bookmarksManageEmpty.isVisible = items.isEmpty()
        binding.bookmarksList.isVisible = items.isNotEmpty()
    }

    private class BookmarksAdapter(
        private val onOpen: (BookmarkNode) -> Unit,
        private val onDelete: (BookmarkNode) -> Unit
    ) : RecyclerView.Adapter<BookmarksAdapter.VH>() {
        private var items: List<BookmarkNode> = emptyList()

        fun submit(list: List<BookmarkNode>) {
            items = list
            notifyDataSetChanged()
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val v = LayoutInflater.from(parent.context)
                .inflate(R.layout.item_bookmark, parent, false)
            return VH(v)
        }

        override fun getItemCount(): Int = items.size

        override fun onBindViewHolder(holder: VH, position: Int) {
            val bm = items[position]
            holder.title.text = bm.title
            holder.url.text = bm.url.orEmpty()
            holder.open.setOnClickListener { onOpen(bm) }
            holder.delete.setOnClickListener { onDelete(bm) }
            holder.itemView.setOnClickListener { onOpen(bm) }
        }

        class VH(v: View) : RecyclerView.ViewHolder(v) {
            val title: TextView = v.findViewById(R.id.bmTitle)
            val url: TextView = v.findViewById(R.id.bmUrl)
            val open: MaterialButton = v.findViewById(R.id.bmOpen)
            val delete: MaterialButton = v.findViewById(R.id.bmDelete)
        }
    }

    companion object {
        const val EXTRA_URL = "url"
        const val REQ_OPEN = 4101
    }
}
