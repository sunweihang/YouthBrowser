package com.jianxing.browser.data

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.webkit.MimeTypeMap
import android.webkit.URLUtil
import com.jianxing.browser.JianXingApp
import com.jianxing.browser.guard.NavigationGuard
import com.jianxing.browser.model.DownloadEntry
import java.net.URLDecoder

object DownloadsHelper {
    private val FILE_EXT = Regex(
        "\\.(zip|rar|7z|tar|gz|tgz|bz2|xz|pdf|doc|docx|xls|xlsx|ppt|pptx|csv|txt|rtf|mp3|mp4|m4a|wav|flac|aac|ogg|avi|mkv|mov|webm|png|jpe?g|gif|webp|svg|ico|apk|ipa|exe|msi|dmg|pkg|iso|img|bin|torrent|epub|mobi|azw3)(?:[?#]|$)",
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
