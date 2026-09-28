import ClaudexorKit
import Testing
@testable import ClaudexorApp

/// M5c: the readiness card is the ONE render owner, so it dedupes doctor
/// findings the daemon may emit more than once (owner-reported duplicates).
@Suite struct HarnessReadinessDedupeTests {
    @Test func checksDedupeByIdKeepingFirstOrder() {
        let checks = [
            ReadinessCheck(kind: "binary", id: "cli", title: "CLI", status: "pass"),
            ReadinessCheck(kind: "auth", id: "auth", title: "Auth", status: "fail", detail: "expired"),
            ReadinessCheck(kind: "auth", id: "auth", title: "Auth", status: "fail", detail: "expired"),
            ReadinessCheck(kind: "binary", id: "cli", title: "CLI", status: "pass"),
        ]
        let deduped = HarnessReadinessPresentation.dedupeChecks(checks)
        #expect(deduped.map(\.id) == ["cli", "auth"])
    }

    @Test func reasonsDedupePreservingOrder() {
        let reasons = ["not logged in", "quota unknown", "not logged in", "binary missing"]
        #expect(HarnessReadinessPresentation.dedupeOrdered(reasons)
            == ["not logged in", "quota unknown", "binary missing"])
    }

    // MARK: - QA-005: absent optional API-key fallback is neutral, never red

    private func apiKeySource(availability: String, verification: String) -> HarnessAuthSource {
        HarnessAuthSource(source: "api_key_env", availability: availability, verification: verification)
    }

    private func providerAuthFileSource(availability: String, verification: String) -> HarnessAuthSource {
        HarnessAuthSource(source: "provider_auth_file", availability: availability, verification: verification)
    }

    @Test func absentOptionalKeyRendersNeutralNotFail() {
        // Native adapter emits a presence-only `stored_key` fail because no key is
        // configured; the typed api_key_env source says unavailable + not_run.
        let rows = [
            ReadinessCheck(kind: "auth", id: "native_session", title: "Native session", status: "pass"),
            ReadinessCheck(kind: "probe", id: "stored_key", title: "Stored key", status: "fail", detail: "no anthropic key fallback"),
        ]
        let out = HarnessReadinessPresentation.neutralizeAbsentOptionalKey(
            rows, authSources: [apiKeySource(availability: "unavailable", verification: "not_run")],
            apiKeyFallbackSource: .apiKeyEnvironment)
        let stored = out.first { $0.id == "stored_key" }
        #expect(stored?.status == "skip")
        #expect(stored?.detail == "not configured (optional API-key fallback)")
        // "skip" is the neutral tone the card maps away from red — not "fail".
        #expect(stored?.status != "fail")
    }

    @Test func presentPresentButFailedKeyStaysRed() {
        // A configured-but-broken key: api_key_env is available + failed. The
        // stored_key presence check is `pass` (key IS present); the real failure
        // is a separate smoke row that must remain red.
        let rows = [
            ReadinessCheck(kind: "probe", id: "stored_key", title: "Stored key", status: "pass"),
            ReadinessCheck(kind: "smoke", id: "isolated_api_smoke", title: "Isolated API-key smoke", status: "fail", detail: "401"),
        ]
        let out = HarnessReadinessPresentation.neutralizeAbsentOptionalKey(
            rows, authSources: [apiKeySource(availability: "available", verification: "failed")],
            apiKeyFallbackSource: .apiKeyEnvironment)
        #expect(out.first { $0.id == "isolated_api_smoke" }?.status == "fail")
        #expect(out.first { $0.id == "stored_key" }?.status == "pass")
    }

    @Test func storedKeyFailWithoutTypedSourceIsLeftUnchanged() {
        // No api_key_env source to prove the absence is optional → do not rewrite.
        let rows = [ReadinessCheck(kind: "probe", id: "stored_key", title: "Stored key", status: "fail")]
        let out = HarnessReadinessPresentation.neutralizeAbsentOptionalKey(
            rows, authSources: [], apiKeyFallbackSource: .apiKeyEnvironment)
        #expect(out.first { $0.id == "stored_key" }?.status == "fail")
    }

    @Test func presentationNeutralizesAbsentOptionalKeyEndToEnd() {
        var info = HarnessInfo(family: .claude, health: .ok, version: "1", auth: "ok", intents: ["implement"])
        info.readiness = [
            ReadinessCheck(kind: "probe", id: "stored_key", title: "Stored key", status: "fail", detail: "no anthropic key fallback"),
        ]
        info.authSources = [apiKeySource(availability: "unavailable", verification: "not_run")]
        let presentation = HarnessReadinessPresentation.from(family: .claude, info: info)
        #expect(presentation.rows.first { $0.id == "stored_key" }?.status == "skip")
    }

    // MARK: - QA-005 codex: the api-key fallback lives at provider_auth_file, not api_key_env

    @Test func codexDefaultSubscriptionNeutralizesAbsentProviderAuthFileKey() {
        // The DEFAULT codex subscription case: native session works, and the
        // OPTIONAL api-key fallback (provider_auth_file) is absent + not_run.
        // Before the typed-source fix the neutralizer only recognized api_key_env,
        // so codex rendered a RED stored_key here — violating native-first QA-005.
        var info = HarnessInfo(family: .codex, health: .ok, version: "1", auth: "ok", intents: ["implement"])
        info.readiness = [
            ReadinessCheck(kind: "auth", id: "native_session", title: "Native session", status: "pass"),
            ReadinessCheck(kind: "probe", id: "stored_key", title: "Stored key", status: "fail", detail: "no OPENAI_API_KEY / auth.json fallback"),
        ]
        info.authSources = [providerAuthFileSource(availability: "unavailable", verification: "not_run")]
        let presentation = HarnessReadinessPresentation.from(family: .codex, info: info)
        let stored = presentation.rows.first { $0.id == "stored_key" }
        #expect(stored?.status == "skip")
        #expect(stored?.detail == "not configured (optional API-key fallback)")
        #expect(stored?.status != "fail")
    }

    @Test func codexPresentButFailedProviderAuthFileKeyStaysRed() {
        // A configured codex api-key fallback that FAILS its smoke stays red: the
        // provider_auth_file source is available (present) so the absence rewrite
        // is never triggered and the real isolated_api_smoke failure shows red.
        var info = HarnessInfo(family: .codex, health: .degraded, version: "1", auth: "key failed", intents: ["implement"])
        info.readiness = [
            ReadinessCheck(kind: "probe", id: "stored_key", title: "Stored key", status: "pass"),
            ReadinessCheck(kind: "smoke", id: "isolated_api_smoke", title: "Isolated API-key smoke", status: "fail", detail: "401"),
        ]
        info.authSources = [providerAuthFileSource(availability: "available", verification: "failed")]
        let presentation = HarnessReadinessPresentation.from(family: .codex, info: info)
        #expect(presentation.rows.first { $0.id == "isolated_api_smoke" }?.status == "fail")
        #expect(presentation.rows.first { $0.id == "stored_key" }?.status == "pass")
    }

    @Test func codexApiKeyEnvSourceDoesNotNeutralizeProviderAuthFileFamily() {
        // A stray api_key_env source must NOT neutralize codex's stored_key: codex's
        // fallback is provider_auth_file, so an unrelated api_key_env absence is not
        // proof the codex fallback is unconfigured — the fail stays red.
        var info = HarnessInfo(family: .codex, health: .ok, version: "1", auth: "ok", intents: ["implement"])
        info.readiness = [
            ReadinessCheck(kind: "probe", id: "stored_key", title: "Stored key", status: "fail", detail: "no auth.json fallback"),
        ]
        info.authSources = [apiKeySource(availability: "unavailable", verification: "not_run")]
        let presentation = HarnessReadinessPresentation.from(family: .codex, info: info)
        #expect(presentation.rows.first { $0.id == "stored_key" }?.status == "fail")
    }

    // MARK: - Round-5 #6: the api-key is PRIMARY for opencode/raw-api, not a fallback

    @Test func apiKeyPrimaryFamilyFailedStoredKeyStaysRed() {
        // opencode's PRIMARY credential is the api key (defaultAuthReadinessRequest
        // == .apiKey), so an absent/failed stored_key is a REAL failure — never the
        // "optional API-key fallback" QA-005 neutralizes for native-first families.
        // The stray api_key_env source that neutralizes claude/cursor must NOT
        // neutralize an api-key-PRIMARY family.
        var info = HarnessInfo(family: .opencode, health: .unavailable, version: "1", auth: "no key", intents: [])
        info.readiness = [
            ReadinessCheck(kind: "probe", id: "stored_key", title: "Stored key", status: "fail", detail: "no OPENAI_API_KEY"),
        ]
        info.authSources = [apiKeySource(availability: "unavailable", verification: "not_run")]
        let presentation = HarnessReadinessPresentation.from(family: .opencode, info: info)
        #expect(presentation.rows.first { $0.id == "stored_key" }?.status == "fail")
    }

    @Test func presentationDoesNotRenderDuplicateRows() {
        var info = HarnessInfo(family: .claude, health: .ok, version: "1", auth: "ok", intents: ["implement"])
        info.readiness = [
            ReadinessCheck(kind: "auth", id: "auth", title: "Auth", status: "pass"),
            ReadinessCheck(kind: "auth", id: "auth", title: "Auth", status: "pass"),
        ]
        info.reasons = ["dup", "dup"]
        let presentation = HarnessReadinessPresentation.from(family: .claude, info: info)
        #expect(presentation.rows.count == 1)
        // rawEvidence carries one reason + one row line, not the duplicates.
        #expect(presentation.rawEvidence == "dup\nauth: pass")
    }

    // MARK: - Install truth: the "did you find my CLI?" fact gets its own row

    private func installedInfo(
        version: String = "2.1.281 (Claude Code)",
        path: String = "/Users/someone/.claudexor/node/bin/claude"
    ) -> HarnessInfo {
        var info = HarnessInfo(family: .claude, health: .unavailable, version: version,
                               auth: "Not ready: unavailable.", intents: [])
        info.readiness = [
            ReadinessCheck(kind: "binary", id: "installed", title: "Installed", status: "pass",
                           detail: "\(version) at \(path)"),
            ReadinessCheck(kind: "probe", id: "native_session", title: "Native session",
                           status: "fail", detail: "not logged in"),
        ]
        return info
    }

    @Test func installFactIsSplitFromTheBinaryRow() {
        let presentation = HarnessReadinessPresentation.from(family: .claude, info: installedInfo())
        #expect(presentation.install?.version == "2.1.281 (Claude Code)")
        #expect(presentation.install?.path == "/Users/someone/.claudexor/node/bin/claude")
    }

    @Test func binaryRowIsHoistedOutOfTheCheckRows() {
        // Install is its own fact; it must not ALSO appear as an anonymous entry
        // in the auth list, or the card shows the same probe twice.
        let presentation = HarnessReadinessPresentation.from(family: .claude, info: installedInfo())
        #expect(presentation.rows.map(\.id) == ["native_session"])
        #expect(!presentation.rows.contains { $0.id == "installed" })
    }

    @Test func hoistingTheBinaryRowKeepsCopyRawEvidenceLossless() {
        // A bug report must still carry the resolved cli version and path even
        // though the row no longer renders in the list.
        let presentation = HarnessReadinessPresentation.from(family: .claude, info: installedInfo())
        #expect(presentation.rawEvidence.contains("installed: pass — 2.1.281 (Claude Code) at "))
    }

    @Test func installedCLIIsVisibleWhileStillUnauthenticated() {
        // The regression this fixes: claude IS installed and the daemon proved
        // it, yet health was `unavailable` (not logged in) — so the card showed
        // only a red capsule and the user concluded the CLI was not recognized.
        let presentation = HarnessReadinessPresentation.from(family: .claude, info: installedInfo())
        #expect(presentation.health == .unavailable)
        #expect(presentation.install != nil)
        #expect(presentation.available == false)
    }

    @Test func installFallsBackToTheManifestVersionWhenNoBinaryRowIsShipped() {
        // Legacy daemon: no typed `binary` row at all, but the manifest still
        // discloses the cli version. The fact must not silently disappear.
        var info = HarnessInfo(family: .claude, health: .ok, version: "codex-cli 0.154.0",
                               auth: "ok", intents: ["implement"])
        info.readiness = [
            ReadinessCheck(kind: "probe", id: "native_session", title: "Native session", status: "pass"),
        ]
        let presentation = HarnessReadinessPresentation.from(family: .claude, info: info)
        #expect(presentation.install?.version == "codex-cli 0.154.0")
        #expect(presentation.install?.path == nil)
        // Nothing to hoist: the row list is untouched.
        #expect(presentation.rows.map(\.id) == ["native_session"])
    }

    @Test func absentInstallIsNilRatherThanTheWordUnknown() {
        // `mapHarnessStatuses` substitutes "unknown" when a harness discloses no
        // version (an api-key harness has no cli). That is an ABSENCE marker and
        // must never reach the screen as if it were a version.
        var info = HarnessInfo(family: .raw, health: .unavailable, version: "unknown",
                               auth: "no key", intents: [])
        info.readiness = [
            ReadinessCheck(kind: "auth", id: "api_key", title: "API key", status: "fail",
                           detail: "OPENAI_API_KEY not set"),
        ]
        let presentation = HarnessReadinessPresentation.from(family: .raw, info: info)
        #expect(presentation.install == nil)
    }

    @Test func everyHarnessNeverLoadedIsNotPresentedAsInstalled() {
        // Before the first doctor load there is no manifest and no rows at all.
        let presentation = HarnessReadinessPresentation.from(family: .claude, info: nil)
        #expect(presentation.install == nil)
        #expect(presentation.rows.isEmpty)
        #expect(presentation.reasons.isEmpty)
    }

    @Test func missingCLIIsNotPresentedAsInstalled() {
        // A failed `binary` row is a real "not found on PATH" verdict, and its
        // detail ("agy not found") is not a version. It must neither claim an
        // install nor vanish from the list.
        var info = HarnessInfo(family: .agy, health: .unavailable, version: "unknown",
                               auth: "agy not found", intents: [])
        info.readiness = [
            ReadinessCheck(kind: "binary", id: "installed", title: "Installed", status: "fail",
                           detail: "agy not found"),
        ]
        let presentation = HarnessReadinessPresentation.from(family: .agy, info: info)
        #expect(presentation.install == nil)
        #expect(presentation.rows.map(\.id) == ["installed"])
    }

    // MARK: - The daemon's remediation must be ON SCREEN, not only on the clipboard

    @Test func reasonsAreCarriedForRendering() {
        var info = HarnessInfo(family: .claude, health: .unavailable, version: "1",
                               auth: "Not ready: unavailable.", intents: [])
        info.reasons = [
            "not authenticated: open Accounts → Claude → Login, then complete Native setup",
        ]
        let presentation = HarnessReadinessPresentation.from(family: .claude, info: info)
        #expect(presentation.reasons.count == 1)
        #expect(presentation.reasons[0].contains("open Accounts"))
    }

    @Test func reasonsStayDeduplicatedAndReachCopyRaw() {
        var info = HarnessInfo(family: .claude, health: .unavailable, version: "1",
                               auth: "x", intents: [])
        info.reasons = ["same", "same", "other"]
        let presentation = HarnessReadinessPresentation.from(family: .claude, info: info)
        #expect(presentation.reasons == ["same", "other"])
        // Reasons lead the evidence, in order, exactly once each — with no
        // trailing separator invented when there are no check rows to follow.
        #expect(presentation.rawEvidence == "same\nother")
    }

    // MARK: - InstallFacts parsing

    @Test func installFactsSplitOnTheLastAtSeparator() {
        let facts = InstallFacts.parse("2.1.281 (Claude Code) at /Users/someone/.local/bin/claude")
        #expect(facts?.version == "2.1.281 (Claude Code)")
        #expect(facts?.path == "/Users/someone/.local/bin/claude")
    }

    @Test func installFactsOnlySplitOnAPathLookingRightHandSide() {
        // A version-only detail (cursor's "2026.09.26-dd393fe") has no " at ".
        // And a version that merely CONTAINS the words must not be carved in
        // half: only a right-hand side that looks like a path is a separator.
        #expect(InstallFacts.parse("2026.09.26-dd393fe")?.version == "2026.09.26-dd393fe")
        #expect(InstallFacts.parse("2026.09.26-dd393fe")?.path == nil)
        let facts = InstallFacts.parse("codex at home 0.154.0")
        #expect(facts?.version == "codex at home 0.154.0")
        #expect(facts?.path == nil)
    }

    @Test func installFactsAcceptTildeAndVariablePaths() {
        #expect(InstallFacts.parse("1.0 at ~/.local/bin/claude")?.path == "~/.local/bin/claude")
        #expect(InstallFacts.parse("1.0 at $HOME/bin/claude")?.path == "$HOME/bin/claude")
    }

    @Test func installFactsUseTheLastPathLookingSeparator() {
        // "weird at /old at /new/bin/tool" — the real path is the LAST one.
        let facts = InstallFacts.parse("weird at /old at /new/bin/tool")
        #expect(facts?.version == "weird at /old")
        #expect(facts?.path == "/new/bin/tool")
    }

    @Test func installFactsNormalizeWhitespaceAndRejectEmpty() {
        #expect(InstallFacts.parse("  2.1.281\nat\t/bin/claude  ")?.path == "/bin/claude")
        #expect(InstallFacts.parse(nil) == nil)
        #expect(InstallFacts.parse("   ") == nil)
    }
}
