package com.jianxing.browser.ui

import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.TextView
import java.util.WeakHashMap

/** Scales native chrome (not WebView) to match Firefox-style browser zoom. */
object ViewZoom {
    private data class Base(
        val width: Int,
        val height: Int,
        val padL: Int,
        val padT: Int,
        val padR: Int,
        val padB: Int,
        val minW: Int,
        val minH: Int,
        val textPx: Float?,
        val maxW: Int,
    )

    private val bases = WeakHashMap<View, Base>()

    fun apply(root: View, percent: Int) {
        walk(root, percent.coerceIn(50, 300) / 100f)
        root.requestLayout()
    }

    private fun walk(view: View, factor: Float) {
        if (view is WebView) return
        val base = bases.getOrPut(view) {
            val lp = view.layoutParams
            val text = view as? TextView
            Base(
                width = lp?.width ?: 0,
                height = lp?.height ?: 0,
                padL = view.paddingLeft,
                padT = view.paddingTop,
                padR = view.paddingRight,
                padB = view.paddingBottom,
                minW = view.minimumWidth,
                minH = view.minimumHeight,
                textPx = text?.textSize,
                maxW = text?.maxWidth ?: 0,
            )
        }
        val lp = view.layoutParams
        if (lp != null) {
            if (base.width > 0) lp.width = (base.width * factor).toInt().coerceAtLeast(1)
            if (base.height > 0) lp.height = (base.height * factor).toInt().coerceAtLeast(1)
            view.layoutParams = lp
        }
        view.setPadding(
            (base.padL * factor).toInt(),
            (base.padT * factor).toInt(),
            (base.padR * factor).toInt(),
            (base.padB * factor).toInt(),
        )
        view.minimumWidth = (base.minW * factor).toInt()
        view.minimumHeight = (base.minH * factor).toInt()
        if (view is TextView) {
            val textPx = base.textPx
            if (textPx != null) {
                view.setTextSize(TypedValue.COMPLEX_UNIT_PX, textPx * factor)
            }
            if (base.maxW > 0 && base.maxW < Int.MAX_VALUE / 4) {
                view.maxWidth = (base.maxW * factor).toInt()
            }
        }
        if (view is ViewGroup) {
            for (i in 0 until view.childCount) {
                walk(view.getChildAt(i), factor)
            }
        }
    }
}
