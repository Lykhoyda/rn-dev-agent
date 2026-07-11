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
    fun setTextNullReadBackOnEmptyFieldIsRejected() {
        assertEquals(
            SetTextOutcome.REJECTED,
            TextInputRecipe.classifySetText("hello", before = null, after = null),
        )
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
