import SwiftUI
import AppKit
import ClaudexorKit

/// Location-wide workspace prerequisite shown beside (not folded into) the
/// per-harness Doctor rows. Git availability can block write strategies while
/// every provider remains healthy, so the two truths must stay orthogonal.
struct GitReadinessPresentation: Equatable {
    var title: String
    var status: String
    var detail: String
    var remediation: String?
    var tone: StatusTone
    var glyph: String

    static func from(
        capability: WorkspaceGitCapability?,
        readinessFresh: Bool
    ) -> GitReadinessPresentation {
        guard readinessFresh, let capability else {
            return GitReadinessPresentation(
                title: "Workspace Git",
                status: "Unknown",
                detail: "Refresh Harness Doctor to check workspace prerequisites.",
                remediation: nil,
                tone: .neutral,
                glyph: "questionmark.circle")
        }
        switch capability.status {
        case "available":
            return GitReadinessPresentation(
                title: "Workspace Git",
                status: "Available",
                detail: capability.version ?? "Available in this engine environment.",
                remediation: nil,
                tone: .positive,
                glyph: "checkmark.circle.fill")
        case "developer_tools_stub":
            return GitReadinessPresentation(
                title: "Workspace Git",
                status: "Developer tools required",
                detail: capability.detail ?? "Git cannot run until Apple Command Line Tools are installed.",
                remediation: capability.remediation,
                tone: .warn,
                glyph: "exclamationmark.triangle.fill")
        case "missing":
            return GitReadinessPresentation(
                title: "Workspace Git",
                status: "Missing",
                detail: capability.detail ?? "Git is not installed or is not on this engine's PATH.",
                remediation: capability.remediation,
                tone: .warn,
                glyph: "exclamationmark.triangle.fill")
        default:
            return GitReadinessPresentation(
                title: "Workspace Git",
                status: "Failed",
                detail: capability.detail ?? "The engine found Git but could not run it successfully.",
                remediation: capability.remediation,
                tone: .warn,
                glyph: "exclamationmark.triangle.fill")
        }
    }
}

struct GitReadinessCard: View {
    let capability: WorkspaceGitCapability?
    let readinessFresh: Bool

    private var presentation: GitReadinessPresentation {
        .from(capability: capability, readinessFresh: readinessFresh)
    }

    var body: some View {
        AlignedList(verticalSpacing: Theme.Spacing.xxs) {
            AlignedListRow(identity: AlignedRowIdentity(
                dotColor: Theme.status(presentation.tone),
                dotSystemImage: presentation.glyph,
                dotHelp: presentation.status,
                title: presentation.title,
                badges: [AlignedRowBadge(
                    presentation.status,
                    emphasis: presentation.tone == .positive ? .positive
                        : presentation.tone == .warn ? .warning : .secondary)],
                details: [
                    AlignedRowDetail(0, presentation.detail),
                    presentation.remediation.map {
                        AlignedRowDetail(1, $0, emphasis: .warning)
                    },
                ].compactMap { $0 }
            )) { EmptyView() }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(presentation.title)
        .accessibilityValue([presentation.status, presentation.detail, presentation.remediation]
            .compactMap { $0 }.joined(separator: " "))
    }
}

/// ONE readiness presentation for the three surfaces that used to carry
/// verbatim copies of the harness row (Settings, Onboarding, AuthSheet —
/// W4.7/W4.9, sol #19). Pure derivation from HarnessInfo: identity, the
/// server's routability truth, the daemon-normalized typed check rows, the
/// configured-model verdict, and the raw evidence for "copy raw". Surfaces
/// render it through HarnessReadinessCard and pass their OWN actions as a
/// caller slot — three workflows never centralize into one conditional.
struct HarnessReadinessPresentation: Equatable {
    var family: HarnessFamily
    /// Server routability truth (R8): routes at least one intent right now.
    var available: Bool
    var health: HarnessHealth
    var summary: String
    /// Install truth — WHICH cli the daemon actually probed, and where. Hoisted
    /// out of `rows` because "is the binary here" and "is it signed in" are
    /// different questions, and as two anonymous entries in one list a user
    /// could not tell them apart: a correctly-installed, merely-unauthenticated
    /// cli rendered as the same red "Unavailable" as a cli that was never there.
    var install: InstallFacts?
    /// Server-authored, human-readable blockers that already spell out the fix
    /// ("run `claudexor auth login claude`"). These reached the user ONLY
    /// through the "copy raw" clipboard, so the one sentence that says what to
    /// do next was the one thing the card never showed.
    var reasons: [String]
    var rows: [ReadinessCheck]
    /// The un-normalized evidence (reasons + raw probe ids) for "copy raw".
    var rawEvidence: String

    static func from(family: HarnessFamily, info: HarnessInfo?) -> HarnessReadinessPresentation {
        // M5c: the daemon can emit the same finding more than once (aggregated
        // across probes) — dedupe here, the ONE readiness render owner, so a
        // repeated check/reason never shows twice (owner-reported).
        // QA-005 applies ONLY where the api-key is a genuine FALLBACK — i.e. the
        // family's PRIMARY credential is a native/subscription session (codex/
        // claude/cursor). For api-key-PRIMARY families (opencode, raw-api) the
        // stored_key IS the primary credential, so a failure there is real and must
        // stay red — pass no fallback source so the rewrite never fires.
        let apiKeyIsFallback = family.defaultAuthReadinessRequest?.authRequest == .subscription
        let allRows = neutralizeAbsentOptionalKey(
            dedupeChecks(info?.readiness ?? []),
            authSources: info?.authSources ?? [],
            apiKeyFallbackSource: apiKeyIsFallback ? family.apiKeyAuthReadinessRequest?.source : nil)
        // Install truth is the ONE typed `binary` row — the daemon normalizes
        // which probe answers "is the cli here", so the card switches on `kind`
        // and never on an id substring. A `fail` is the "not found on PATH"
        // verdict, not an install (and its detail is not a version at all). A
        // legacy daemon that ships no binary row still discloses the version in
        // its manifest, so present that as the same install fact.
        let binaryRow = allRows.first { $0.kind == "binary" }
        let install: InstallFacts? = {
            if let binaryRow {
                return binaryRow.status == "pass"
                    ? InstallFacts.parse(binaryRow.detail)
                    : nil
            }
            return InstallFacts.parse(manifestVersion(info?.version))
        }()
        // Hoist the binary row ONLY when it was actually consumed as install
        // truth, so no probe is ever dropped from the rendered list.
        let rows = install == nil ? allRows : allRows.filter { $0.kind != "binary" }
        let reasons = dedupeOrdered(info?.reasons ?? [])
        return HarnessReadinessPresentation(
            family: family,
            available: !(info?.routableIntents.isEmpty ?? true),
            health: info?.health ?? .unavailable,
            summary: info?.auth ?? "Harness Doctor has not loaded this harness.",
            install: install,
            reasons: reasons,
            rows: rows,
            // Evidence stays LOSSLESS: it is built from every row, including the
            // binary row hoisted out of `rows` above, so a bug report still
            // carries the resolved cli version and path.
            rawEvidence: (
                reasons
                    + allRows.map { row in
                        "\(row.id): \(row.status)\(row.detail.map { " — \($0)" } ?? "")"
                    }
            ).joined(separator: "\n")
        )
    }

    /// `mapHarnessStatuses` substitutes this literal when a harness discloses no
    /// version (an api-key harness has no cli). It is an ABSENCE marker, not a
    /// version — so it must never reach the screen as one.
    private static func manifestVersion(_ version: String?) -> String? {
        guard let version, version != "unknown" else { return nil }
        return version
    }

    /// QA-005: an ABSENT OPTIONAL API-key fallback must read neutral, never a red
    /// failure. The native adapters emit a presence-only `stored_key` conformance
    /// check that flips to `fail` merely because no key is configured — but on a
    /// healthy native harness the API key is an unused fallback, not a failure.
    /// The authority is the TYPED auth-source verdict, not the row's status
    /// string (ARCHITECTURE §5). The fallback does NOT live at one hard-coded
    /// source: the native-first CLIs read the key from `api_key_env`, but Codex's
    /// fallback is `provider_auth_file` — `HarnessFamily.apiKeyAuthReadinessRequest`
    /// is the authority for which TYPED source each family's api-key fallback uses.
    /// When THAT source is `unavailable + not_run` the fallback is simply not
    /// configured, so the `stored_key` fail is rewritten to a neutral `skip`
    /// ("not configured"). This is what keeps the DEFAULT Codex subscription case
    /// (provider_auth_file absent + not_run) from rendering a red `stored_key`.
    /// A present-but-broken key never reaches this rewrite (its `stored_key` is
    /// `pass`; the real failure surfaces via the `isolated_api_smoke` row), so
    /// genuine failures still render red. A family without an api-key fallback
    /// (`apiKeyFallbackSource == nil`) is never neutralized.
    static func neutralizeAbsentOptionalKey(
        _ checks: [ReadinessCheck], authSources: [HarnessAuthSource],
        apiKeyFallbackSource: AuthSourceKind?
    ) -> [ReadinessCheck] {
        guard let apiKeyFallbackSource else { return checks }
        let keyAbsent = authSources.contains {
            AuthSourceKind(rawValue: $0.source) == apiKeyFallbackSource
                && $0.availability == AuthAvailability.unavailable.rawValue
                && $0.verification == AuthVerification.notRun.rawValue
        }
        guard keyAbsent else { return checks }
        return checks.map { row in
            guard row.id == "stored_key", row.status == "fail" else { return row }
            return ReadinessCheck(
                kind: row.kind, id: row.id, title: row.title,
                status: "skip", detail: "not configured (optional API-key fallback)")
        }
    }

    /// Order-preserving de-duplication of readiness checks by id (first wins).
    static func dedupeChecks(_ checks: [ReadinessCheck]) -> [ReadinessCheck] {
        var seen = Set<String>()
        return checks.filter { seen.insert($0.id).inserted }
    }

    /// Order-preserving de-duplication of identical reason strings.
    static func dedupeOrdered(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { seen.insert($0).inserted }
    }
}

/// Install truth, split into the two facts a user actually needs: the cli
/// VERSION (short — it is the headline) and the resolved absolute PATH (long —
/// it truncates from the head so the binary name always survives, with the full
/// path in `.help`).
///
/// The daemon ships both as one binary-kind detail string,
/// "2.1.281 (Claude Code) at /Users/…/.claudexor/node/bin/claude". The split
/// only accepts a separator whose RIGHT side actually looks like a path
/// (absolute, `~`, or `$VAR`), so a version that merely CONTAINS the words —
/// "codex at home 0.154.0" — is never carved in half.
struct InstallFacts: Equatable {
    var version: String
    var path: String?

    static func parse(_ detail: String?) -> InstallFacts? {
        guard let detail else { return nil }
        let text = AlignedRowText.singleLine(detail)
        guard !text.isEmpty else { return nil }
        // Collect every " at " boundary forward (the reliable `range(of:)`), then
        // try them from the END so the LAST split that looks like a path wins.
        var boundaries: [Range<String.Index>] = []
        var cursor = text.startIndex
        while cursor < text.endIndex,
              let hit = text.range(of: " at ", range: cursor..<text.endIndex) {
            boundaries.append(hit)
            cursor = hit.upperBound
        }
        for separator in boundaries.reversed() {
            let version = String(text[text.startIndex..<separator.lowerBound])
            let path = String(text[separator.upperBound...])
            guard !version.isEmpty, pathStartsLikeAPath(path) else { continue }
            return InstallFacts(version: version, path: path)
        }
        return InstallFacts(version: text, path: nil)
    }

    private static func pathStartsLikeAPath(_ candidate: String) -> Bool {
        candidate.hasPrefix("/") || candidate.hasPrefix("~") || candidate.hasPrefix("$")
    }
}

/// The shared card (W4.7-UI): identity + health + the typed check rows +
/// model verdict + "copy raw", with the CALLER's action row slotted in.
/// Fixed geometry: the health capsule and row glyph columns have fixed
/// widths so the card never drifts with text length (DESIGN_SYSTEM).
struct HarnessReadinessCard<Actions: View>: View {
    let presentation: HarnessReadinessPresentation
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(alignment: .center, spacing: Theme.Spacing.sm) {
                HarnessChip(family: presentation.family, selected: true,
                            available: presentation.available)
                Text(presentation.summary)
                    .font(.caption).foregroundStyle(.secondary)
                    .lineLimit(2)
                Spacer(minLength: Theme.Spacing.md)
                Label(presentation.health.rawValue.capitalized,
                      systemImage: presentation.health.glyph)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(presentation.health.color)
                    .padding(.horizontal, Theme.Spacing.sm)
                    .padding(.vertical, Theme.Spacing.xxs)
                    .frame(minWidth: 96) // fixed anchor — text length never moves the row
                    .background(presentation.health.color.opacity(0.14), in: Capsule())
            }
            if let install = presentation.install {
                // Install is its OWN row, not another entry in the auth list: it
                // is the answer to "did you find my cli?", which is the first
                // question and the one the generic health capsule never answered.
                AlignedList(verticalSpacing: Theme.Spacing.xxs) {
                    AlignedListRow(identity: AlignedRowIdentity(
                        dotColor: Theme.status(.positive),
                        dotSystemImage: "checkmark.circle.fill",
                        dotHelp: "Installed",
                        title: install.version,
                        titleFont: .caption,
                        details: install.path.map {
                            // Head-truncated: the binary name is the informative
                            // end, `/Users/someone/…` is not.
                            [AlignedRowDetail(0, $0, truncation: .head)]
                        } ?? []
                    )) { EmptyView() }
                    .help(install.path.map { "\(install.version)\n\($0)" } ?? install.version)
                }
            }
            if !presentation.rows.isEmpty {
                // Ported to the shared AlignedListRow component (UI cut 3 §1):
                // status glyph + check title + SINGLE-LINE detail (full text via
                // `.help`), so a long probe detail can never wrap into fragments.
                AlignedList(verticalSpacing: Theme.Spacing.xxs) {
                    ForEach(presentation.rows, id: \.id) { row in
                        AlignedListRow(identity: AlignedRowIdentity(
                            dotColor: Self.rowColor(row.status),
                            dotSystemImage: Self.rowGlyph(row.status),
                            dotHelp: row.status,
                            title: row.title,
                            titleFont: .caption,
                            details: (row.detail?.isEmpty == false)
                                ? [AlignedRowDetail(0, row.detail!)] : []
                        )) { EmptyView() }
                    }
                }
            }
            if !presentation.reasons.isEmpty {
                // The daemon's own remediation, finally on screen instead of
                // only on the clipboard. Full sentences, so they read as prose
                // rather than as another probe row (which is what made the
                // actionable text unreadable when it was one of those).
                VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                    Text("What to do")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Theme.status(.caution))
                    ForEach(Array(presentation.reasons.enumerated()), id: \.offset) { _, reason in
                        Label {
                            Text(reason).lineLimit(2)
                        } icon: {
                            Image(systemName: "arrow.turn.down.right")
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .help(reason)
                    }
                }
            }
            HStack(spacing: Theme.Spacing.sm) {
                actions()
                if !presentation.rawEvidence.isEmpty {
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(presentation.rawEvidence, forType: .string)
                    } label: {
                        Label("Copy raw", systemImage: "doc.on.doc")
                    }
                    .buttonStyle(.borderless)
                    .font(.caption)
                    .help("Copy the raw doctor reasons and probe ids for a bug report.")
                }
            }
        }
    }

    static func rowGlyph(_ status: String) -> String {
        switch status {
        case "pass": return "checkmark.circle.fill"
        case "fail": return "xmark.circle.fill"
        default: return "minus.circle"
        }
    }

    static func rowColor(_ status: String) -> Color {
        switch status {
        case "pass": return Theme.status(.positive)
        case "fail": return Theme.status(.negative)
        default: return .secondary
        }
    }
}
