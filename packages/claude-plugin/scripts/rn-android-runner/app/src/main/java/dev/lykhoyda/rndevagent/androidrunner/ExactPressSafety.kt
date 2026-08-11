/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

/** Pure fail-closed decisions shared by exact accessibility press traversal. */
object ExactPressSafety {
    data class ZOrderStep(
        val nodeIdentity: Int,
        // null on API < 24, where AccessibilityNodeInfo.drawingOrder does not exist.
        val drawingOrder: Int?,
    )

    enum class OcclusionVerdict { CLEAR, OCCLUDED, UNKNOWN }

    fun traversalComplete(pendingNodeCount: Int): Boolean = pendingNodeCount == 0

    fun liveTargetIsHittable(
        enabled: Boolean,
        visibleToUser: Boolean,
        containsRequestedPoint: Boolean,
    ): Boolean = enabled && visibleToUser && containsRequestedPoint

    /**
     * Classifies whether a distinct same-window branch at the requested point
     * draws over the exact target. Ancestors and descendants are part of the
     * target's own ownership chain and therefore are not blockers; a missing
     * drawing order is reported as UNKNOWN rather than assumed either way.
     */
    fun sameWindowOcclusion(
        targetPath: List<ZOrderStep>,
        candidatePath: List<ZOrderStep>,
    ): OcclusionVerdict {
        val shared = targetPath.zip(candidatePath).takeWhile { (target, candidate) ->
            target.nodeIdentity == candidate.nodeIdentity
        }.size
        if (shared == targetPath.size || shared == candidatePath.size) return OcclusionVerdict.CLEAR
        val candidateOrder = candidatePath[shared].drawingOrder ?: return OcclusionVerdict.UNKNOWN
        val targetOrder = targetPath[shared].drawingOrder ?: return OcclusionVerdict.UNKNOWN
        return if (candidateOrder >= targetOrder) {
            OcclusionVerdict.OCCLUDED
        } else {
            OcclusionVerdict.CLEAR
        }
    }
}
