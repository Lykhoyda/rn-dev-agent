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
}
