/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

/** Pure fail-closed decisions shared by exact accessibility press traversal. */
object ExactPressSafety {
    data class ZOrderStep(
        val nodeIdentity: Int,
        val drawingOrder: Int,
    )

    fun traversalComplete(pendingNodeCount: Int): Boolean = pendingNodeCount == 0

    fun liveTargetIsHittable(
        enabled: Boolean,
        visibleToUser: Boolean,
        containsRequestedPoint: Boolean,
    ): Boolean = enabled && visibleToUser && containsRequestedPoint

    /**
     * Returns true when a distinct same-window branch at the requested point
     * may draw over the exact target. Ancestors and descendants are part of the
     * target's own ownership chain and therefore are not blockers.
     */
    fun sameWindowNodeMayOcclude(
        targetPath: List<ZOrderStep>,
        candidatePath: List<ZOrderStep>,
    ): Boolean {
        val shared = targetPath.zip(candidatePath).takeWhile { (target, candidate) ->
            target.nodeIdentity == candidate.nodeIdentity
        }.size
        if (shared == targetPath.size || shared == candidatePath.size) return false
        return candidatePath[shared].drawingOrder >= targetPath[shared].drawingOrder
    }
}
