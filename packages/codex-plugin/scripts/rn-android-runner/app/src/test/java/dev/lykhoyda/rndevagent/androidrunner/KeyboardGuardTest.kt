package dev.lykhoyda.rndevagent.androidrunner

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeyboardGuardTest {
    @Test fun occludedWhenInsideImeRect() = assertTrue(KeyboardGuard.shouldDismiss(0, 1400, 1080, 2400, 540, 1600, 150))
    @Test fun notOccludedAboveIme() = assertFalse(KeyboardGuard.shouldDismiss(0, 1400, 1080, 2400, 540, 1200, 150))
    @Test fun tooShortRectRejected() = assertFalse(KeyboardGuard.shouldDismiss(0, 2360, 1080, 2400, 540, 2380, 150))
    @Test fun emptyRectNeverOccludes() = assertFalse(KeyboardGuard.shouldDismiss(0, 0, 0, 0, 5, 9999, 150))
    @Test fun tapAtImeRightNotContained() = assertFalse(KeyboardGuard.shouldDismiss(0, 1400, 1080, 2400, 1080, 1600, 150))
    @Test fun tapAtImeBottomNotContained() = assertFalse(KeyboardGuard.shouldDismiss(0, 1400, 1080, 2400, 540, 2400, 150))
}
