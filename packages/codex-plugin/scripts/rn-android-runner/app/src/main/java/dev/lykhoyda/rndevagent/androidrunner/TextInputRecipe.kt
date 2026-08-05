package dev.lykhoyda.rndevagent.androidrunner

/** Secret-free exact read-back policy for direct AccessibilityNodeInfo fills. */
object TextInputRecipe {
    enum class ExactReadback { EXACT, MISMATCH, UNREADABLE }
    enum class ExactResolution { UNIQUE, MISSING, AMBIGUOUS, UNREADABLE }

    fun classifyResolution(matchCount: Int, traversalComplete: Boolean): ExactResolution {
        if (!traversalComplete) return ExactResolution.UNREADABLE
        if (matchCount == 0) return ExactResolution.MISSING
        if (matchCount > 1) return ExactResolution.AMBIGUOUS
        return ExactResolution.UNIQUE
    }

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
