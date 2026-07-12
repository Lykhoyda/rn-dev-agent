package dev.lykhoyda.rndevagent.androidrunner

import dev.lykhoyda.rndevagent.androidrunner.TextInputRecipe.SetTextOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Story 10 (#391): pure-logic coverage for the ACTION_SET_TEXT read-back
// classifier and the keyevent fallback mapping.
class TextInputRecipeTest {

    @Test
    fun setTextExactReadBackIsAccepted() {
        assertEquals(
            SetTextOutcome.ACCEPTED,
            TextInputRecipe.classifySetText("hello", before = "", after = "hello"),
        )
    }

    @Test
    fun setTextEmojiReadBackIsAccepted() {
        assertEquals(
            SetTextOutcome.ACCEPTED,
            TextInputRecipe.classifySetText("héllo 👋🏽 世界", before = "", after = "héllo 👋🏽 世界"),
        )
    }

    @Test
    fun setTextClearingAFieldIsAccepted() {
        assertEquals(
            SetTextOutcome.ACCEPTED,
            TextInputRecipe.classifySetText("", before = "old", after = ""),
        )
    }

    @Test
    fun setTextMaskedValueIsTransformed() {
        // Input mask reformatted the digits — the set landed, retyping won't converge.
        assertEquals(
            SetTextOutcome.TRANSFORMED,
            TextInputRecipe.classifySetText("41111111", before = "", after = "4111 1111"),
        )
    }

    @Test
    fun setTextUppercaseTransformIsTransformed() {
        assertEquals(
            SetTextOutcome.TRANSFORMED,
            TextInputRecipe.classifySetText("abc", before = "", after = "ABC"),
        )
    }

    @Test
    fun setTextUnchangedFieldIsRejected() {
        assertEquals(
            SetTextOutcome.REJECTED,
            TextInputRecipe.classifySetText("hello", before = "stale", after = "stale"),
        )
    }

    @Test
    fun setTextNullReadBackIsUnverifiedNotRejected() {
        // Codex P2 (#564): no read-back (focused node gone after a re-render)
        // proves nothing either way — it must not trigger the keyevent retype
        // (double-apply risk) nor claim a transform.
        assertEquals(
            SetTextOutcome.UNVERIFIED,
            TextInputRecipe.classifySetText("hello", before = null, after = null),
        )
    }

    @Test
    fun setTextNullReadBackAfterPriorTextIsUnverifiedNotTransformed() {
        assertEquals(
            SetTextOutcome.UNVERIFIED,
            TextInputRecipe.classifySetText("hello", before = "prior", after = null),
        )
    }

    @Test
    fun setTextEmptyRequestWithNullReadBackIsUnverified() {
        assertEquals(
            SetTextOutcome.UNVERIFIED,
            TextInputRecipe.classifySetText("", before = "old", after = null),
        )
    }

    @Test
    fun keyEventFallbackViableForEmptyAndShortAscii() {
        assertTrue(TextInputRecipe.keyEventFallbackViable(""))
        assertTrue(TextInputRecipe.keyEventFallbackViable("hello world 42!"))
        assertTrue(TextInputRecipe.keyEventFallbackViable("a".repeat(TextInputRecipe.KEYEVENT_FALLBACK_MAX_CHARS)))
    }

    @Test
    fun keyEventFallbackNotViablePastPacedTypingBudget() {
        // Codex P2 round-3 (#564): 75 ms/char past ~200 chars would blow the
        // bridge's 35 s type budget mid-fallback.
        assertFalse(
            TextInputRecipe.keyEventFallbackViable("a".repeat(TextInputRecipe.KEYEVENT_FALLBACK_MAX_CHARS + 1)),
        )
    }

    @Test
    fun keyEventFallbackNotViableForNonAscii() {
        assertFalse(TextInputRecipe.keyEventFallbackViable("héllo 👋🏽 世界"))
    }

    @Test
    fun keyEventTransformedOnEmptyFieldIsUsable() {
        assertTrue(
            TextInputRecipe.keyEventOutcomeUsable(SetTextOutcome.TRANSFORMED, beforeWasEmpty = true),
        )
    }

    @Test
    fun keyEventTransformedOnNonEmptyFieldIsNotUsable() {
        // Codex P2 round-2 (#564): could be an under-deleted `old + text`
        // remnant — must descend to Maestro, not pass as a formatter reshape.
        assertFalse(
            TextInputRecipe.keyEventOutcomeUsable(SetTextOutcome.TRANSFORMED, beforeWasEmpty = false),
        )
    }

    @Test
    fun keyEventAcceptedAndUnverifiedAreUsableRejectedIsNot() {
        assertTrue(TextInputRecipe.keyEventOutcomeUsable(SetTextOutcome.ACCEPTED, beforeWasEmpty = false))
        assertTrue(TextInputRecipe.keyEventOutcomeUsable(SetTextOutcome.UNVERIFIED, beforeWasEmpty = false))
        assertFalse(TextInputRecipe.keyEventOutcomeUsable(SetTextOutcome.REJECTED, beforeWasEmpty = true))
    }

    @Test
    fun lowercaseLettersMapWithoutShift() {
        val stroke = TextInputRecipe.keyStrokeFor('a')
        assertEquals(29, stroke?.keyCode)
        assertFalse(stroke!!.shift)
        assertEquals(54, TextInputRecipe.keyStrokeFor('z')?.keyCode)
    }

    @Test
    fun uppercaseLettersMapWithShift() {
        val stroke = TextInputRecipe.keyStrokeFor('Z')
        assertEquals(54, stroke?.keyCode)
        assertTrue(stroke!!.shift)
    }

    @Test
    fun digitsMapToDigitKeycodes() {
        assertEquals(7, TextInputRecipe.keyStrokeFor('0')?.keyCode)
        assertEquals(16, TextInputRecipe.keyStrokeFor('9')?.keyCode)
    }

    @Test
    fun shiftedPunctuationMapsToBaseKeyWithShift() {
        val bang = TextInputRecipe.keyStrokeFor('!')
        assertEquals(8, bang?.keyCode) // KEYCODE_1
        assertTrue(bang!!.shift)
        val colon = TextInputRecipe.keyStrokeFor(':')
        assertEquals(74, colon?.keyCode) // KEYCODE_SEMICOLON
        assertTrue(colon!!.shift)
    }

    @Test
    fun emojiHasNoKeyStroke() {
        assertNull(TextInputRecipe.keyStrokeFor('世'))
    }

    @Test
    fun asciiTextIsKeyEventTypable() {
        assertTrue(TextInputRecipe.isKeyEventTypable("User@example.com, #42 (a-z)!"))
    }

    @Test
    fun emojiTextIsNotKeyEventTypable() {
        assertFalse(TextInputRecipe.isKeyEventTypable("héllo 👋🏽 世界"))
    }

    @Test
    fun emptyTextIsNotKeyEventTypable() {
        assertFalse(TextInputRecipe.isKeyEventTypable(""))
    }
}
