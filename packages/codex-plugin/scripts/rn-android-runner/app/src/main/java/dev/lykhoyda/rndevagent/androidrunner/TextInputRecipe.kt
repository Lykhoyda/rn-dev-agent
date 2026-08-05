package dev.lykhoyda.rndevagent.androidrunner

/** Secret-free exact read-back policy for direct AccessibilityNodeInfo fills. */
object TextInputRecipe {
    enum class ExactReadback { EXACT, MISMATCH, UNREADABLE }

    fun classifyExactReadback(
        requested: String,
        before: String?,
        after: String?,
        hint: String?,
        showingHint: Boolean?,
        hintKnown: Boolean,
    ): ExactReadback {
        if (!hintKnown || showingHint == null || after == null) return ExactReadback.UNREADABLE
        if (requested.isEmpty()) {
            if (showingHint || after.isEmpty()) return ExactReadback.EXACT
            return ExactReadback.MISMATCH
        }
        if (showingHint) return ExactReadback.MISMATCH
        return if (after == requested) ExactReadback.EXACT else ExactReadback.MISMATCH
    }
}
