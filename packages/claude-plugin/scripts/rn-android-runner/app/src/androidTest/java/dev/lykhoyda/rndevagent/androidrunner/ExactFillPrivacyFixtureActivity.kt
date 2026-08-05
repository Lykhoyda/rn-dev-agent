package dev.lykhoyda.rndevagent.androidrunner

import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.EditText
import android.widget.FrameLayout

class ExactFillPrivacyFixtureActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val input = EditText(this).apply {
            contentDescription = FIELD_IDENTIFIER
            hint = "Placeholder"
            showSoftInputOnFocus = false
        }
        val container = FrameLayout(this).apply {
            addView(
                input,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.CENTER,
                ),
            )
        }
        setContentView(container)
        input.requestFocus()
    }

    companion object {
        const val FIELD_IDENTIFIER = "rn-fill-privacy-field"
    }
}
