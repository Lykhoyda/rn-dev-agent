package dev.lykhoyda.rndevagent.androidrunner

import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout

class ExactFillPrivacyFixtureActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val privacyInput = EditText(this).apply {
            contentDescription = FIELD_IDENTIFIER
            hint = "Placeholder"
            showSoftInputOnFocus = false
        }
        val placeholderClearInput = EditText(this).apply {
            contentDescription = PLACEHOLDER_CLEAR_IDENTIFIER
            hint = "Placeholder"
            setText("existing")
            showSoftInputOnFocus = false
        }
        val plainClearInput = EditText(this).apply {
            contentDescription = PLAIN_CLEAR_IDENTIFIER
            setText("existing")
            showSoftInputOnFocus = false
        }
        val inputLayout = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            addView(privacyInput, inputLayout)
            addView(placeholderClearInput, inputLayout)
            addView(plainClearInput, inputLayout)
        }
        setContentView(container)
        privacyInput.requestFocus()
    }

    companion object {
        const val FIELD_IDENTIFIER = "rn-fill-privacy-field"
        const val PLACEHOLDER_CLEAR_IDENTIFIER = "rn-fill-placeholder-clear-field"
        const val PLAIN_CLEAR_IDENTIFIER = "rn-fill-plain-clear-field"
    }
}
