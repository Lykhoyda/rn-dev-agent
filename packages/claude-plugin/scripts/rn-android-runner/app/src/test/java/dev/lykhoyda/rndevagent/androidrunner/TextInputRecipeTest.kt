package dev.lykhoyda.rndevagent.androidrunner

import org.junit.Assert.assertEquals
import org.junit.Test

class TextInputRecipeTest {
    @Test
    fun incompleteTraversalIsUnreadableEvenWithOneObservedMatch() {
        assertEquals(
            TextInputRecipe.ExactResolution.UNREADABLE,
            TextInputRecipe.classifyResolution(matchCount = 1, traversalComplete = false),
        )
    }

    @Test
    fun completeTraversalClassifiesMissingUniqueAndAmbiguous() {
        assertEquals(
            TextInputRecipe.ExactResolution.MISSING,
            TextInputRecipe.classifyResolution(matchCount = 0, traversalComplete = true),
        )
        assertEquals(
            TextInputRecipe.ExactResolution.UNIQUE,
            TextInputRecipe.classifyResolution(matchCount = 1, traversalComplete = true),
        )
        assertEquals(
            TextInputRecipe.ExactResolution.AMBIGUOUS,
            TextInputRecipe.classifyResolution(matchCount = 2, traversalComplete = true),
        )
    }

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
    fun preOReadbackProvesExactNonEmptyEntry() {
        assertEquals(
            TextInputRecipe.ExactReadback.EXACT,
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

    @Test
    fun preOReadbackMismatchesWhenNonEmptyEntryDidNotLand() {
        assertEquals(
            TextInputRecipe.ExactReadback.MISMATCH,
            TextInputRecipe.classifyExactReadback(
                requested = "requested",
                before = "old",
                after = "old",
                hint = null,
                showingHint = null,
                hintKnown = false,
            ),
        )
    }

    @Test
    fun preOClearIsExactOnlyWhenReadbackIsEmpty() {
        assertEquals(
            TextInputRecipe.ExactReadback.EXACT,
            TextInputRecipe.classifyExactReadback(
                requested = "",
                before = "old",
                after = "",
                hint = null,
                showingHint = null,
                hintKnown = false,
            ),
        )
    }

    @Test
    fun preOClearRefusesUnchangedTextAndHintAmbiguity() {
        assertEquals(
            TextInputRecipe.ExactReadback.MISMATCH,
            TextInputRecipe.classifyExactReadback(
                requested = "",
                before = "old",
                after = "old",
                hint = null,
                showingHint = null,
                hintKnown = false,
            ),
        )
        assertEquals(
            TextInputRecipe.ExactReadback.UNREADABLE,
            TextInputRecipe.classifyExactReadback(
                requested = "",
                before = "old",
                after = "Hint",
                hint = null,
                showingHint = null,
                hintKnown = false,
            ),
        )
    }
}
