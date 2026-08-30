package com.jianxing.browser.ui

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.isVisible
import com.jianxing.browser.databinding.ActivityUpdateBinding
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class UpdateActivity : AppCompatActivity() {
    private lateinit var binding: ActivityUpdateBinding
    private val io = Executors.newSingleThreadExecutor()
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityUpdateBinding.inflate(layoutInflater)
        setContentView(binding.root)
        binding.updCurrent.text = "v$currentVersion"
        binding.updLatest.text = "—"
        binding.updMsg.text = "点击检查更新，查看服务器上的最新版本。"
        binding.updCheckBtn.setOnClickListener { check() }
        check()
    }

    override fun onDestroy() {
        io.shutdownNow()
        super.onDestroy()
    }

    private val currentVersion: String
        get() = try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "?"
        } catch (_: Exception) { "?" }

    private fun check() {
        binding.updCheckBtn.isEnabled = false
        binding.updCheckBtn.text = "检查中…"
        binding.updError.isVisible = false
        binding.updMsg.text = "正在检查…"
        io.execute {
            try {
                val req = Request.Builder().url(FEED).get().build()
                http.newCall(req).execute().use { resp ->
                    val text = resp.body?.string().orEmpty()
                    val latest = Regex("""version:\s*([0-9.]+)""").find(text)?.groupValues?.get(1)
                    runOnUiThread {
                        binding.updCheckBtn.isEnabled = true
                        binding.updCheckBtn.text = "检查更新"
                        if (latest.isNullOrBlank()) {
                            binding.updLatest.text = "—"
                            binding.updError.text = "无法解析更新信息"
                            binding.updError.isVisible = true
                            binding.updMsg.text = "请稍后重试，或从家长处获取最新安装包。"
                            return@runOnUiThread
                        }
                        binding.updLatest.text = "v$latest"
                        binding.updMsg.text = if (compareVersion(currentVersion, latest) >= 0) {
                            "当前已是最新版本。"
                        } else {
                            "发现新版本 v$latest。请从官网或家长处安装最新 Android 安装包。"
                        }
                    }
                }
            } catch (e: Exception) {
                runOnUiThread {
                    binding.updCheckBtn.isEnabled = true
                    binding.updCheckBtn.text = "检查更新"
                    binding.updError.text = e.message ?: "检查失败"
                    binding.updError.isVisible = true
                    binding.updMsg.text = "无法连接更新服务器。"
                }
            }
        }
    }

    private fun compareVersion(a: String, b: String): Int {
        val pa = a.split('.').map { it.toIntOrNull() ?: 0 }
        val pb = b.split('.').map { it.toIntOrNull() ?: 0 }
        val n = maxOf(pa.size, pb.size)
        for (i in 0 until n) {
            val d = (pa.getOrNull(i) ?: 0) - (pb.getOrNull(i) ?: 0)
            if (d != 0) return d
        }
        return 0
    }

    companion object {
        private const val FEED = "https://spacedreams.cn/simplygo/latest-android.yml"
    }
}
