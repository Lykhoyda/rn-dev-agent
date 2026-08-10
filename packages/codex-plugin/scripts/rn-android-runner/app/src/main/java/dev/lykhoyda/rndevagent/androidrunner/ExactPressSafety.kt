/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

/** Pure fail-closed decisions shared by exact accessibility press traversal. */
object ExactPressSafety {
    fun traversalComplete(pendingNodeCount: Int): Boolean = pendingNodeCount == 0

    fun liveTargetIsHittable(
        enabled: Boolean,
        visibleToUser: Boolean,
        containsRequestedPoint: Boolean,
    ): Boolean = enabled && visibleToUser && containsRequestedPoint
}
