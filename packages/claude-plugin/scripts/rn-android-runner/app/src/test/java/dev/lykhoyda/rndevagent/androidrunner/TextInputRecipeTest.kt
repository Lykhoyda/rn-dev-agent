package dev.lykhoyda.rndevagent.androidrunner

import org.junit.Assert.assertEquals
import org.junit.Test

class TextInputRecipeTest {
    @Test
    fun directAccessibilityReadbackIsExact() {
        assertEquals(
            TextInputRecipe.ExactReadback.EXACT,
            TextInputRecipe.classifyExactReadback(
                requested = "requested",
                before = "",
                after = "requested",
                hint = "Hint",
                showingHint = false,
                hintKnown = true,
            ),
        )
    }

    @Test
    fun showingHintProvesEmptyClear() {
        assertEquals(
            TextInputRecipe.ExactReadback.EXACT,
            TextInputRecipe.classifyExactReadback(
                requested = "",
                before = "old",
                after = "Hint",
                hint = "Hint",
                showingHint = true,
                hintKnown = true,
            ),
        )
    }

    @Test
    fun literalHintTextDoesNotFalseSucceedAsEmpty() {
        assertEquals(
            TextInputRecipe.ExactReadback.MISMATCH,
            TextInputRecipe.classifyExactReadback(
                requested = "",
                before = "Hint",
                after = "Hint",
                hint = "Hint",
                showingHint = false,
                hintKnown = true,
            ),
        )
    }

    @Test
    fun unknownHintProvenanceIsUnreadableOnPreO() {
        assertEquals(
            TextInputRecipe.ExactReadback.UNREADABLE,
            TextInputRecipe.classifyExactReadback(
                requested = "requested",
                before = "",
                after = "requested",
                hint = null,
                showingHint = null,
                hintKnown = false,
            ),
        )
    }
}
