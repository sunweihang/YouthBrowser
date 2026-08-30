package com.jianxing.browser.data

import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.webkit.MimeTypeMap
import android.webkit.URLUtil
import android.widget.Toast
import com.jianxing.browser.JianXingApp
import com.jianxing.browser.guard.NavigationGuard
import com.jianxing.browser.model.DownloadEntry
import java.net.URLDecoder

object DownloadsHelper {
    private val FILE_EXT = Regex(
        "\\.(zip|rar|7z|tar|gz|tgz|bz2|xz|pdf|doc|docx|xls|xlsx|ppt|pptx|csv|txt|rtf|mp3|mp4|m4a|wav|flac|aac|ogg|avi|mkv|mov|webm|png|jpe?g|gif|webp|svg|ico|apk|ipa|exe|msi|dmg|pkg|iso|img|bin|torrent|epub|mobi|azw3|json|xml|yaml|yml)(?:[?#]|$)",
        RegexOption.IGNORE_CASE
    )

    fun looksLikeDownload(url: String): Boolean {
        return try {
            val path = Uri.parse(url).path.orEmpty()
            FILE_EXT.containsMatchIn(path)
        } catch (_: Exception) {
            false
        }
    }

    fun start(
        context: Context,
        url: String,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String?
    ): Result<DownloadEntry> {
        val href = url.trim()
        if (href.startsWith("blob:") || href.startsWith("data:")) {
            return Result.failure(IllegalArgumentException("无法下载此类型的文件"))
        }
        if (!href.startsWith("http://") && !href.startsWith("https://")) {
            return Result.failure(IllegalArgumentException("仅允许 http/https"))
        }
        val app = JianXingApp.instance
        val allowed = NavigationGuard.isDownloadAllowed(href, app.rulesStore.load()) ||
            app.watchRequestsStore.isApprovedUrl(href)
        if (!allowed) {
            return Result.failure(IllegalArgumentException("该地址不允许下载"))
        }

        val filename = guessFilename(href, contentDisposition, mimeType)
        val request = DownloadManager.Request(Uri.parse(href))
        request.setTitle(filename)
        request.setDescription(filename)
        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename)
        if (!userAgent.isNullOrBlank()) {
            request.addRequestHeader("User-Agent", userAgent)
        }
        if (!mimeType.isNullOrBlank()) {
            request.setMimeType(mimeType)
        }

        val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val systemId = dm.enqueue(request)
        val entry = DownloadEntry(
            id = app.downloadsStore.newId(),
            url = href,
            filename = filename,
            mime = mimeType.orEmpty(),
            state = "progressing",
            systemId = systemId
        )
        app.downloadsStore.add(entry)
        return Result.success(entry)
    }

    fun activeCount(): Int =
        JianXingApp.instance.downloadsStore.list().count { it.state == "progressing" && !it.paused }

    fun cancel(context: Context, entry: DownloadEntry): DownloadEntry {
        if (entry.systemId >= 0) {
            val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            dm.remove(entry.systemId)
        }
        val next = entry.copy(
            state = "cancelled",
            paused = false,
            endedAt = System.currentTimeMillis()
        )
        JianXingApp.instance.downloadsStore.update(entry.id) { next }
        return next
    }

    fun pause(context: Context, entry: DownloadEntry): DownloadEntry {
        if (entry.systemId >= 0) {
            val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            dm.remove(entry.systemId)
        }
        val next = entry.copy(state = "cancelled", paused = true, endedAt = System.currentTimeMillis())
        JianXingApp.instance.downloadsStore.update(entry.id) { next }
        return next
    }

    fun resume(context: Context, entry: DownloadEntry): Result<DownloadEntry> {
        return start(context, entry.url, null, null, entry.mime.ifBlank { null })
    }

    fun needsLegacyStoragePermission(): Boolean =
        Build.VERSION.SDK_INT <= Build.VERSION_CODES.P

    fun openFile(context: Context, entry: DownloadEntry) {
        val fresh = refresh(context, entry)
        val uri = when {
            fresh.systemId >= 0 -> {
                val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                dm.getUriForDownloadedFile(fresh.systemId)
            }
            fresh.filePath.startsWith("content:") || fresh.filePath.startsWith("file:") ->
                Uri.parse(fresh.filePath)
            else -> null
        }
        if (uri == null) {
            Toast.makeText(context, "文件不存在", Toast.LENGTH_SHORT).show()
            return
        }
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, fresh.mime.ifBlank { "*/*" })
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(context, "没有可打开此文件的应用", Toast.LENGTH_SHORT).show()
        }
    }

    fun openFolder(context: Context) {
        try {
            context.startActivity(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {
            Toast.makeText(context, "无法打开系统下载", Toast.LENGTH_SHORT).show()
        }
    }

    fun formatBytes(n: Long): String {
        if (n < 1024) return "$n B"
        if (n < 1024 * 1024) return "%.1f KB".format(n / 1024.0)
        if (n < 1024L * 1024 * 1024) return "%.1f MB".format(n / (1024.0 * 1024))
        return "%.1f GB".format(n / (1024.0 * 1024 * 1024))
    }

    fun statusText(item: DownloadEntry): String {
        val state = when {
            item.paused -> "已暂停"
            item.state == "completed" -> "已完成"
            item.state == "cancelled" -> "已取消"
            item.state == "interrupted" -> "已中断"
            else -> "下载中"
        }
        val size = if (item.state == "progressing" && item.totalBytes > 0) {
            "${formatBytes(item.receivedBytes)} / ${formatBytes(item.totalBytes)}"
        } else if (item.totalBytes > 0) {
            formatBytes(item.totalBytes)
        } else if (item.receivedBytes > 0) {
            formatBytes(item.receivedBytes)
        } else {
            ""
        }
        return listOf(state, size).filter { it.isNotBlank() }.joinToString(" · ")
    }

    fun refresh(context: Context, entry: DownloadEntry): DownloadEntry {
        if (entry.systemId < 0) return entry
        val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val q = DownloadManager.Query().setFilterById(entry.systemId)
        dm.query(q)?.use { c ->
            if (!c.moveToFirst()) return entry
            val status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
            val rec = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
            val tot = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
            val local = try {
                c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI)).orEmpty()
            } catch (_: Exception) {
                ""
            }
            val state = when (status) {
                DownloadManager.STATUS_SUCCESSFUL -> "completed"
                DownloadManager.STATUS_FAILED -> "interrupted"
                DownloadManager.STATUS_PAUSED -> "progressing"
                DownloadManager.STATUS_RUNNING -> "progressing"
                DownloadManager.STATUS_PENDING -> "progressing"
                else -> entry.state
            }
            val next = entry.copy(
                state = state,
                receivedBytes = rec,
                totalBytes = if (tot > 0) tot else entry.totalBytes,
                filePath = local.ifBlank { entry.filePath },
                endedAt = if (state == "completed" || state == "interrupted") {
                    entry.endedAt ?: System.currentTimeMillis()
                } else entry.endedAt
            )
            if (next != entry) {
                JianXingApp.instance.downloadsStore.update(entry.id) { next }
            }
            return next
        }
        return entry
    }

    fun guessFilename(url: String, contentDisposition: String?, mimeType: String?): String {
        val fromHeader = filenameFromDisposition(contentDisposition)
        if (!fromHeader.isNullOrBlank()) return sanitize(fromHeader)
        val guessed = URLUtil.guessFileName(url, contentDisposition, mimeType)
        if (guessed.isNotBlank() && guessed != "downloadfile.bin") return sanitize(guessed)
        val path = try {
            URLDecoder.decode(Uri.parse(url).lastPathSegment.orEmpty(), "UTF-8")
        } catch (_: Exception) {
            ""
        }
        if (path.isNotBlank()) return sanitize(path)
        val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType).orEmpty()
        return if (ext.isNotBlank()) "download.$ext" else "download"
    }

    private fun filenameFromDisposition(raw: String?): String? {
        if (raw.isNullOrBlank()) return null
        val star = Regex("filename\\*=(?:UTF-8''|utf-8'')([^;]+)", RegexOption.IGNORE_CASE)
            .find(raw)
            ?.groupValues
            ?.getOrNull(1)
        if (!star.isNullOrBlank()) {
            return try {
                URLDecoder.decode(star.trim().trim('"', '\''), "UTF-8")
            } catch (_: Exception) {
                star.trim().trim('"', '\'')
            }
        }
        val plain = Regex("filename\\s*=\\s*\"?([^\";]+)\"?", RegexOption.IGNORE_CASE)
            .find(raw)
            ?.groupValues
            ?.getOrNull(1)
        return plain?.trim()?.trim('"', '\'')
    }

    private fun sanitize(name: String): String {
        val cleaned = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").trim().trim('.')
        return cleaned.ifBlank { "download" }.take(180)
    }
}
