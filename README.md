# Atorasu – XML Schema (XSD) viewer

Offline desktop viewer built with Tauri. The whole UI is plain HTML/CSS/JS in `src/` (no npm, no bundler, no external requests).

## Use
- **Open…** / **Folder…** / drag & drop one or more `.xsd` files. Open schemas that include/import each other together.
- Pick the root element in the dropdown. Click the grey arrows (or double-click a box) to open/close nodes.
- Click a node to see type, restrictions, enumerations, cardinality, documentation and XPath (plain and namespace-agnostic) in the side panel.
- Search matches name, type, documentation and enum values (multiple words = AND; start with `/` to search XPaths). Click a result to jump to it.
- Toggles: Annotations, Type Info, Attributes. Ctrl/Cmd+F search, Ctrl/Cmd+wheel zoom.
- Dashed box = optional, stacked box = repeatable, `↻` = recursive type.

## Build
Requirements: Rust (stable) and the Tauri CLI (`cargo install tauri-cli --version "^2" --locked`). Windows also needs the MSVC build tools.

    cd src-tauri
    cargo tauri build

- macOS: `target/release/bundle/macos/Atorasu.app` and `bundle/dmg/*.dmg`
- Windows: `target/release/atorasu.exe` (portable) and `bundle/nsis/*-setup.exe` (installer, per-user, no admin rights, bundles the WebView2 runtime offline)

Windows cannot be built on a Mac directly; run the included GitHub Actions workflow (`.github/workflows/build.yml`) or build on a Windows machine.

## Security notes
No network access (CSP `connect-src 'none'`), no Tauri plugins or API exposure, no file-system permissions: files are read by the webview from the user's own selection only.
# wagashi
