package com.jianxing.browser.sync

import android.os.Handler
import android.os.Looper
import com.jianxing.browser.JianXingApp
import com.jianxing.browser.data.HistoryStore
import org.json.JSONArray
import java.util.concurrent.Executors

object HistorySync {
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var debounce: Runnable? = null

    fun schedule() {
        if (JianXingApp.instance.accountStore.getSession() == null) return
        debounce?.let { main.removeCallbacks(it) }
        val task = Runnable { syncNow() }
        debounce = task
        main.postDelayed(task, DEBOUNCE_MS)
    }

    fun syncNow(onDone: ((ok: Boolean, changed: Boolean) -> Unit)? = null) {
        val app = JianXingApp.instance
        if (app.accountStore.getSession() == null) {
            onDone?.invoke(true, false)
            return
        }
        io.execute {
            val result = runSync()
            main.post { onDone?.invoke(result.first, result.second) }
        }
    }

    @Synchronized
    private fun runSync(): Pair<Boolean, Boolean> {
        val app = JianXingApp.instance
        val store = app.historyStore
        val client = SyncClient(app.accountStore)
        repeat(2) { attempt ->
            val remote = client.pullHistory()
            if (!remote.ok || remote.entries == null) {
                return false to false
            }
            val remoteEntries = HistoryStore.parseEntries(remote.entries)
            val remoteDeleted = HistoryStore.parseDeletedIds(remote.deletedIds)
            val remoteCleared = remote.clearedAt ?: 0L
            val remoteRevision = remote.revision ?: 0
            val changed = store.mergeFromSync(
                remoteEntries,
                remoteDeleted,
                remoteCleared,
                remoteRevision
            )
            val local = store.exportForSync()
            val remoteSnap = HistoryStore.Snapshot(
                entries = remoteEntries,
                deletedIds = remoteDeleted,
                clearedAt = remoteCleared,
                revision = remoteRevision
            )
            if (HistoryStore.payloadEqual(local, remoteSnap)) {
                store.setRevision(remoteRevision)
                return true to changed
            }
            val entries = JSONArray()
            local.entries.forEach { entries.put(HistoryStore.entryToJson(it)) }
            val deleted = JSONArray()
            local.deletedIds.forEach { deleted.put(it) }
            val pushed = client.pushHistory(
                entries,
                deleted,
                local.clearedAt,
                store.getRevision()
            )
            if (pushed.ok) {
                pushed.revision?.let { store.setRevision(it) }
                return true to true
            }
            val conflict = pushed.error?.contains("先拉取") == true ||
                pushed.error?.contains("已更新") == true
            if (!conflict || attempt == 1) {
                return false to changed
            }
        }
        return false to false
    }

    private const val DEBOUNCE_MS = 8000L
}
