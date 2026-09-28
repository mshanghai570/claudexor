import Testing
@testable import ClaudexorApp

/// The Intel/macOS 15 port lowered the app's floor to an OS where Liquid Glass
/// does not exist at all. The Appearance caption used to describe ONLY the
/// macOS 26 chrome, so on every pre-26 Mac — which is now most of them — the
/// one place the app explains its own look was describing something the user
/// was not looking at. These pin the caption to what actually renders.
@Suite struct AppearanceChromeCopyTests {
    @Test func macOS26WithoutReduceTransparencyPromisesLiquidGlass() {
        let text = AppearanceChromeCopy.backdropText(
            liquidGlassAvailable: true, reduceTransparency: false)
        #expect(text.contains("Liquid Glass."))
        #expect(!text.contains("solid raised panel"))
    }

    @Test func belowMacOS26SaysTheChromeIsSolid() {
        // The regression: on an Intel Mac this caption claimed glass that the
        // build cannot render at all.
        let text = AppearanceChromeCopy.backdropText(
            liquidGlassAvailable: false, reduceTransparency: false)
        #expect(text.contains("solid raised panel"))
        #expect(text.contains("macOS 26"))
    }

    @Test func reduceTransparencyNeverPromisesGlass() {
        // Reduce Transparency forces the solid recipe even on macOS 26.
        let text = AppearanceChromeCopy.backdropText(
            liquidGlassAvailable: true, reduceTransparency: true)
        #expect(text.contains("solid raised panel"))
    }

    @Test func everyVariantStillKeepsTheAlwaysTrueHalf() {
        // The backdrop IS behind-window vibrancy on every supported OS, and code
        // stays solid for contrast — true in all four combinations, so the fix
        // must not quietly drop them.
        for (glass, reduce) in [(true, false), (true, true), (false, false), (false, true)] {
            let text = AppearanceChromeCopy.backdropText(
                liquidGlassAvailable: glass, reduceTransparency: reduce)
            #expect(text.contains("matte glass"))
            #expect(text.contains("Code and diffs stay on a solid surface"))
            #expect(text.contains("Reduce Transparency"))
        }
    }
}
