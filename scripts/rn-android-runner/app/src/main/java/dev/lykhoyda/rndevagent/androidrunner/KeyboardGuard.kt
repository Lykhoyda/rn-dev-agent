package dev.lykhoyda.rndevagent.androidrunner

object KeyboardGuard {
    fun shouldDismiss(imeLeft: Int, imeTop: Int, imeRight: Int, imeBottom: Int, tapX: Int, tapY: Int, minHeightPx: Int): Boolean {
        val width = imeRight - imeLeft
        val height = imeBottom - imeTop
        if (width <= 0 || height < minHeightPx) return false
        return false
    }
}
