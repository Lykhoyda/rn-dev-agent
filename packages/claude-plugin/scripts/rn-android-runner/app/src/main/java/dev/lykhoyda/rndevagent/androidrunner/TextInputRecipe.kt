package dev.lykhoyda.rndevagent.androidrunner

// Story 10 (#391): text-input recipe helpers for the `type` command. RN
// TextInput is EditText-backed, so the focused node accepts ACTION_SET_TEXT
// (UiObject2.setText) — atomic, full-Unicode, fires RN's onChangeText. This
// object holds the pure logic around that primary path: classifying the
// read-back outcome and mapping ASCII characters to keyevents for the
// fallback tier (Maestro's 75 ms pacing). Kept free of android.* imports so
// the JVM unit suite covers it directly (like KeyboardGuard).
object TextInputRecipe {
    const val KEYEVENT_PACING_MS = 75L

    enum class SetTextOutcome { ACCEPTED, TRANSFORMED, REJECTED }

    // Read-back classification after a set attempt:
    //   ACCEPTED    — field now holds exactly the requested text.
    //   TRANSFORMED — field changed to something else (input mask, uppercase
    //                 transform, formatter). The set landed; the component
    //                 reshaped it. Retyping would not converge.
    //   REJECTED    — field did not change at all: the set was ignored
    //                 (e.g. a controlled component re-rendering from state).
    fun classifySetText(requested: String, before: String?, after: String?): SetTextOutcome {
        val readBack = after.orEmpty()
        if (readBack == requested) return SetTextOutcome.ACCEPTED
        if (readBack != before.orEmpty()) return SetTextOutcome.TRANSFORMED
        return SetTextOutcome.REJECTED
    }

    data class KeyStroke(val keyCode: Int, val shift: Boolean)

    // android.view.KeyEvent constants, inlined as plain Ints so this object
    // stays JVM-pure. Values are stable public API.
    private const val KEYCODE_0 = 7
    private const val KEYCODE_A = 29
    private const val KEYCODE_COMMA = 55
    private const val KEYCODE_PERIOD = 56
    private const val KEYCODE_TAB = 61
    private const val KEYCODE_SPACE = 62
    private const val KEYCODE_ENTER = 66
    private const val KEYCODE_GRAVE = 68
    private const val KEYCODE_MINUS = 69
    private const val KEYCODE_EQUALS = 70
    private const val KEYCODE_LEFT_BRACKET = 71
    private const val KEYCODE_RIGHT_BRACKET = 72
    private const val KEYCODE_BACKSLASH = 73
    private const val KEYCODE_SEMICOLON = 74
    private const val KEYCODE_APOSTROPHE = 75
    private const val KEYCODE_SLASH = 76
    private const val KEYCODE_AT = 77
    private const val KEYCODE_PLUS = 81

    // Shifted pairs on the US virtual keycharmap (emulator default).
    private val SHIFTED: Map<Char, KeyStroke> = mapOf(
        '!' to KeyStroke(KEYCODE_0 + 1, shift = true),
        '#' to KeyStroke(KEYCODE_0 + 3, shift = true),
        '$' to KeyStroke(KEYCODE_0 + 4, shift = true),
        '%' to KeyStroke(KEYCODE_0 + 5, shift = true),
        '^' to KeyStroke(KEYCODE_0 + 6, shift = true),
        '&' to KeyStroke(KEYCODE_0 + 7, shift = true),
        '*' to KeyStroke(KEYCODE_0 + 8, shift = true),
        '(' to KeyStroke(KEYCODE_0 + 9, shift = true),
        ')' to KeyStroke(KEYCODE_0, shift = true),
        '_' to KeyStroke(KEYCODE_MINUS, shift = true),
        ':' to KeyStroke(KEYCODE_SEMICOLON, shift = true),
        '"' to KeyStroke(KEYCODE_APOSTROPHE, shift = true),
        '<' to KeyStroke(KEYCODE_COMMA, shift = true),
        '>' to KeyStroke(KEYCODE_PERIOD, shift = true),
        '?' to KeyStroke(KEYCODE_SLASH, shift = true),
        '{' to KeyStroke(KEYCODE_LEFT_BRACKET, shift = true),
        '}' to KeyStroke(KEYCODE_RIGHT_BRACKET, shift = true),
        '|' to KeyStroke(KEYCODE_BACKSLASH, shift = true),
        '~' to KeyStroke(KEYCODE_GRAVE, shift = true),
    )

    private val UNSHIFTED: Map<Char, KeyStroke> = mapOf(
        ' ' to KeyStroke(KEYCODE_SPACE, shift = false),
        '\t' to KeyStroke(KEYCODE_TAB, shift = false),
        '\n' to KeyStroke(KEYCODE_ENTER, shift = false),
        ',' to KeyStroke(KEYCODE_COMMA, shift = false),
        '.' to KeyStroke(KEYCODE_PERIOD, shift = false),
        '-' to KeyStroke(KEYCODE_MINUS, shift = false),
        '=' to KeyStroke(KEYCODE_EQUALS, shift = false),
        '[' to KeyStroke(KEYCODE_LEFT_BRACKET, shift = false),
        ']' to KeyStroke(KEYCODE_RIGHT_BRACKET, shift = false),
        '\\' to KeyStroke(KEYCODE_BACKSLASH, shift = false),
        ';' to KeyStroke(KEYCODE_SEMICOLON, shift = false),
        '\'' to KeyStroke(KEYCODE_APOSTROPHE, shift = false),
        '/' to KeyStroke(KEYCODE_SLASH, shift = false),
        '`' to KeyStroke(KEYCODE_GRAVE, shift = false),
        '@' to KeyStroke(KEYCODE_AT, shift = false),
        '+' to KeyStroke(KEYCODE_PLUS, shift = false),
    )

    fun keyStrokeFor(c: Char): KeyStroke? = when (c) {
        in 'a'..'z' -> KeyStroke(KEYCODE_A + (c - 'a'), shift = false)
        in 'A'..'Z' -> KeyStroke(KEYCODE_A + (c - 'A'), shift = true)
        in '0'..'9' -> KeyStroke(KEYCODE_0 + (c - '0'), shift = false)
        else -> UNSHIFTED[c] ?: SHIFTED[c]
    }

    // Emoji, IME-composed, and non-US-keymap text has no keyevent
    // representation — the fallback tier only applies when every character maps.
    fun isKeyEventTypable(text: String): Boolean =
        text.isNotEmpty() && text.all { keyStrokeFor(it) != null }
}
