package dev.lykhoyda.rndevagent.fixture

import android.app.Activity
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.ListView
import android.widget.TextView

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        val count = findViewById<TextView>(R.id.fixture_count)
        var taps = 0
        findViewById<View>(R.id.fixture_button).setOnClickListener {
            taps += 1
            count.text = "count: $taps"
        }

        val bottomCount = findViewById<TextView>(R.id.fixture_bottom_count)
        var bottomTaps = 0
        findViewById<View>(R.id.fixture_bottom_button).setOnClickListener {
            bottomTaps += 1
            bottomCount.text = "bottom taps: $bottomTaps"
        }

        val rows = (1..100).map { "row $it" }
        val list = findViewById<ListView>(R.id.fixture_list)
        list.adapter = object : ArrayAdapter<String>(this, android.R.layout.simple_list_item_1, rows) {
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
                val v = super.getView(position, convertView, parent)
                v.contentDescription = "fixture_row_${position + 1}"
                return v
            }
        }
    }
}
