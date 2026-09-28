// swift-tools-version:6.2
import PackageDescription

// The SwiftUI mission-control app. Built as a SwiftPM executable for dev/CI here
// (`swift run ClaudexorApp`); `apps/macos/scripts/build-app.sh` assembles unsigned
// unsigned artifacts, and can sign/notarize when credentials are available.
//
// Floor is macOS 15 (Sequoia) so the app also runs on Intel Macs, which macOS 26
// does not reach. Liquid Glass stays FIRST-CLASS on macOS 26 (no behavioral
// change there); below it every glass surface falls back to the solid chrome
// recipe the design system already specifies for Reduce Transparency. That gate
// lives in exactly one place (`LiquidGlassChrome` in DesignSystemComponents) and
// is proven by the Intel app lane — see docs/DESIGN_SYSTEM.md §3.1.
let package = Package(
    name: "ClaudexorApp",
    platforms: [.macOS(.v15)],
    dependencies: [
        .package(path: "../ClaudexorKit"),
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", exact: "1.15.0"),
    ],
    targets: [
        .executableTarget(
            name: "ClaudexorApp",
            dependencies: [
                .product(name: "ClaudexorKit", package: "ClaudexorKit"),
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ],
            resources: [.process("Resources")],
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
        .testTarget(
            name: "ClaudexorAppTests",
            dependencies: ["ClaudexorApp", .product(name: "ClaudexorKit", package: "ClaudexorKit")],
            resources: [.process("Fixtures")],
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
    ]
)
