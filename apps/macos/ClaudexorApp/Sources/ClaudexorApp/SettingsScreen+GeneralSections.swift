import SwiftUI

extension SettingsScreen {
    func settingsTab<Content: View>(
        @ViewBuilder _ content: () -> Content
    ) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                content()
            }
            .padding(.horizontal, Theme.Spacing.xl)
            .padding(.vertical, Theme.Spacing.xl)
            .frame(maxWidth: Theme.Layout.readableMaxWidth, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            // QA-076: each pane needs an explicit keyboard-focus cohort.
            .focusSection()
        }
        .scrollContentBackground(.hidden)
        .background(Theme.surfaceBase)
    }

    /// The active location's human name, used to qualify the local-only facts
    /// below so a remote-scoped pane never presents This Mac's engine as the
    /// one being edited.
    var activeLocationLabel: String {
        guard let id = model.activeExecutionLocation.remoteConnectionID,
              let connection = model.remoteConnections.first(where: { $0.id == id })
        else { return "the selected remote host" }
        return connection.displayName
    }

    private var isEditingLocalLocation: Bool {
        model.activeExecutionLocation == .local
    }

    @ViewBuilder var generalGroup: some View {
        @Bindable var model = model
        settingsGroup("General", "gearshape") {
            // This row is the LOCAL daemon's health, and every other control on
            // this pane is scoped to the ACTIVE execution location. Leaving that
            // unqualified made a healthy remote host read as a dead engine (and
            // the reverse) — the same class of lie as a wrong status capsule.
            KeyValueRow(
                key: isEditingLocalLocation
                    ? "Engine status (This Mac)"
                    : "Engine status (This Mac — not \(activeLocationLabel))",
                value: model.health.label,
                valueColor: model.health == .connected
                    ? Theme.status(.positive)
                    : .secondary
            )
            HStack {
                Button {
                    Task { await model.connect() }
                } label: {
                    Label("Reconnect", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .productControlAccessibility("Reconnect")
                .help("Reconnect the app to the selected engine and reload its current state.")
                Button {
                    Task { await refreshAll() }
                } label: {
                    Label("Refresh metadata", systemImage: "arrow.triangle.2.circlepath")
                }
                .buttonStyle(.bordered)
                .productControlAccessibility("Refresh metadata")
                .help("Reload settings, quota, secrets, harness readiness, and trust metadata.")
            }
        }
    }

    @ViewBuilder var appearanceGroup: some View {
        @Bindable var model = model
        settingsGroup("Appearance", "paintpalette") {
            Picker("Theme", selection: $model.appearance) {
                ForEach(AppearanceMode.allCases) {
                    Label($0.label, systemImage: $0.glyph).tag($0)
                }
            }
            .pickerStyle(.segmented)
            Text(AppearanceChromeCopy.backdropText)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder var routingGroup: some View {
        settingsGroup("Agent & Routing", "point.3.connected.trianglepath.dotted") {
            HStack {
                Picker(
                    "Routing goal",
                    selection: draftBinding(\.routingGoal, lane: .routingGoal)
                ) {
                    Text("Auto").tag("auto")
                    Text("Quality").tag("quality")
                    Text("Economy").tag("economy")
                }
                .help("Auto paces expiring quota, Quality uses your highest comparable tier, and Economy minimizes incremental paid spend.")
                laneStatus(.routingGoal)
            }
            HStack {
                Picker(
                    "Paid fallback",
                    selection: draftBinding(\.paidFallback, lane: .paidFallback)
                ) {
                    Text("Never").tag("never")
                    Text("When unavailable").tag("when_unavailable")
                    Text("Allowed within cap").tag("allowed_within_cap")
                }
                .help("Controls whether routing may leave subscription or proven-zero routes.")
                laneStatus(.paidFallback)
            }
            KeyValueRow(key: "Quality tiers", value: "\(qualityTierCount()) configured")
            HStack {
                Picker("Primary harness", selection: primaryHarnessBinding()) {
                    Text("None").tag("__none")
                    ForEach(model.selectableHarnesses.filter { $0 != .raw }) { family in
                        Label {
                            Text(family.label)
                        } icon: {
                            HarnessIconImage.image(for: family)
                        }
                        .tag(family.rawValue)
                    }
                }
                .help("Primary is a bias, not a hardcoded semantic role.")
                laneStatus(.primaryHarness)
            }
            HStack {
                Picker(
                    "Env inheritance",
                    selection: draftBinding(\.envInheritance, lane: .envInheritance)
                ) {
                    Text("Mirror native").tag("mirror_native")
                    Text("Clean").tag("clean")
                }
                .help("mirror_native reuses native CLI auth/session context by default.")
                laneStatus(.envInheritance)
            }
            HStack {
                Picker(
                    "Auth route",
                    selection: draftBinding(\.authPreference, lane: .authPreference)
                ) {
                    Text("Auto (subscription first)").tag("auto")
                    Text("Subscription").tag("subscription")
                    Text("API key").tag("api_key")
                }
                .help("Which credential route harness runs prefer. Auto seeds the native subscription session and falls back to a stored API key; an explicit route discloses any fallback in the run events.")
                laneStatus(.authPreference)
            }
            FlowLayout(spacing: Theme.Spacing.sm) {
                ForEach(model.selectableHarnesses.filter { $0 != .raw }) { family in
                    FilterChip(
                        label: family.label,
                        iconImage: HarnessIconImage.image(for: family),
                        isActive: activeDraft.eligibleHarnesses.contains(family),
                        tint: family.color
                    ) {
                        toggleEligibleHarness(family)
                    }
                    .help("Default eligible pool. Empty means auto-discover available harnesses.")
                }
            }
            laneStatus(.eligibleHarnesses)
            if activeDraft.routingGoal == "quality", qualityTierCount() == 0 {
                Label(
                    "Quality routing has no configured tiers, so this edit is not saved. Add a quality tier with claudexor settings or choose Auto/Economy.",
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.caption)
                .foregroundStyle(Theme.status(.caution))
            }
        }
    }

    @ViewBuilder var harnessDoctorGroup: some View {
        settingsGroup("Harness Doctor & Auth", "cpu") {
            Text("Claudexor mirrors native harness auth first, with API-key fallback through stored secret refs.")
                .font(.caption)
                .foregroundStyle(.secondary)
            if case .failed(let message) = model.activeAccountsLoadState {
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    Label("Could not refresh accounts and readiness",
                          systemImage: "exclamationmark.triangle.fill")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Theme.status(.negative))
                    Text(message).font(.caption2).foregroundStyle(.secondary)
                    Button("Retry") { Task { _ = await model.refreshAccounts() } }
                        .buttonStyle(.bordered).controlSize(.small)
                }
            }
            // Same qualification as General: `endpoint` is the LOCAL daemon's.
            // A remote-scoped pane that showed This Mac's loopback URL as "the
            // Control API" pointed the reader at the wrong machine.
            KeyValueRow(
                key: isEditingLocalLocation
                    ? "Control API"
                    : "Control API (This Mac)",
                value: model.endpoint.isEmpty ? "—" : "http://\(model.endpoint)",
                mono: true
            )
            GitReadinessCard(
                capability: model.activeGitCapability,
                readinessFresh: model.activeHarnessReadinessFresh
            )
            ForEach(model.selectableHarnesses.filter { $0 != .raw }) { family in
                nativeAuthRow(family)
            }
        }
    }

    @ViewBuilder var secretsGroup: some View {
        settingsGroup("Secrets", "key") {
            Text("Secret values live in the v2 0600 file store. Run params and artifacts store refs/metadata only.")
                .font(.caption)
                .foregroundStyle(.secondary)
            KeyValueRow(key: "Secret backend", value: model.activeSecretBackend)
            if !model.activeStoredSecrets.isEmpty {
                FlowLayout(spacing: Theme.Spacing.xs) {
                    ForEach(model.activeStoredSecrets) { secret in
                        Text("\(secret.name) · \(secret.backend)")
                            .font(.caption2)
                            .padding(.horizontal, Theme.Spacing.sm)
                            .padding(.vertical, 2)
                            .background(Theme.surfaceRaisedHi, in: Capsule())
                            .foregroundStyle(.secondary)
                    }
                }
            }
            FlowLayout(spacing: Theme.Spacing.sm) {
                ForEach(model.selectableHarnesses) { family in
                    Button {
                        model.authSheetTarget = AuthSheetTarget(family: family)
                    } label: {
                        Label {
                            Text("Open \(family.label) Auth")
                        } icon: {
                            HarnessIconImage.image(for: family)
                        }
                    }
                    .buttonStyle(.bordered)
                    .help("Store fallback refs and run setup jobs in the shared \(family.label) Auth sheet.")
                }
            }
        }
    }

    @ViewBuilder var perHarnessGroup: some View {
        settingsGroup("Per-Harness Defaults", "slider.horizontal.3") {
            Text("Engine-level defaults per harness: enable/disable, model override, effort, and web policy. Stored in ~/.claudexor/v3/config.yaml.")
                .font(.caption)
                .foregroundStyle(.secondary)
            ForEach(model.selectableHarnesses.filter { $0 != .raw }) { family in
                HarnessDefaultsRow(
                    family: family,
                    settings: model.activeSettingsSnapshot?.harnesses?[family.rawValue],
                    autosave: $harnessAutosave
                )
            }
        }
    }
}
