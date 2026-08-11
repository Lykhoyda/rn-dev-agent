/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ExactPressSafetyTest {
    @Test fun completedTraversalIsUsable() =
        assertTrue(ExactPressSafety.traversalComplete(0))

    @Test fun cappedTraversalWithPendingNodesIsUnresolved() =
        assertFalse(ExactPressSafety.traversalComplete(1))

    @Test fun liveEnabledTargetOwningThePointIsHittable() =
        assertTrue(ExactPressSafety.liveTargetIsHittable(true, true, true))

    @Test fun disabledTargetIsNotHittable() =
        assertFalse(ExactPressSafety.liveTargetIsHittable(false, true, true))

    @Test fun invisibleOrObscuredTargetIsNotHittable() =
        assertFalse(ExactPressSafety.liveTargetIsHittable(true, false, true))

    @Test fun targetThatMovedAwayFromThePointIsNotHittable() =
        assertFalse(ExactPressSafety.liveTargetIsHittable(true, true, false))

    @Test fun bottomSheetActionAboveCoveredControlIsAnOccluder() {
        val target = listOf(step(1, 0), step(2, 0), step(3, 0))
        val deleteTaskOnSheet = listOf(step(1, 0), step(4, 1), step(5, 0))

        assertTrue(ExactPressSafety.sameWindowNodeMayOcclude(target, deleteTaskOnSheet))
    }

    @Test fun lowerSiblingDoesNotOccludeTopmostExactTarget() {
        val target = listOf(step(1, 0), step(4, 1), step(5, 0))
        val lowerControl = listOf(step(1, 0), step(2, 0), step(3, 0))

        assertFalse(ExactPressSafety.sameWindowNodeMayOcclude(target, lowerControl))
    }

    @Test fun targetOwnershipAncestorsAndDescendantsAreNotOccluders() {
        val target = listOf(step(1, 0), step(2, 0))
        val targetChild = listOf(step(1, 0), step(2, 0), step(3, 1))

        assertFalse(ExactPressSafety.sameWindowNodeMayOcclude(target, targetChild))
        assertFalse(ExactPressSafety.sameWindowNodeMayOcclude(targetChild, target))
    }

    @Test fun distinctSiblingWithUnknownEqualOrderFailsClosed() {
        val target = listOf(step(1, 0), step(2, 0))
        val overlappingSibling = listOf(step(1, 0), step(3, 0))

        assertTrue(ExactPressSafety.sameWindowNodeMayOcclude(target, overlappingSibling))
    }

    private fun step(nodeIdentity: Int, drawingOrder: Int) =
        ExactPressSafety.ZOrderStep(nodeIdentity, drawingOrder)
}
