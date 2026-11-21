# Contributing to Codex Polish

[简体中文](CONTRIBUTING.md)

For installation, see the [project README](README.md). For details on when the plugin sends a draft and how it displays the reply, see the [technical reference](docs/technical.en.md).

## Where to Make Changes

- `scripts/install.mjs` and the `.command` launchers handle installation, updates, status checks, uninstallation, and local marketplace registration.
- `plugins/codex-polish/` contains the plugin manifest, the `UserPromptSubmit` hook, and two skills. `codex-polish` sends the selected draft through `agy acp`, and formats Gemini’s complete reply for display. Explicit requests use Turbo. The optional OpenAI Decisions check applies only when the hook runs in Normal mode. `codex-polish-setup` manages the current Codex profile’s polishing settings, runtime model discovery, diagnostics, and the [credential guide](plugins/codex-polish/skills/codex-polish-setup/references/credentials.en.md).
- The full source tree includes the regression suite in `tests/` and the evaluation script and synthetic samples in `evaluation/`. See the [evaluation guide](evaluation/README.en.md).
- When updating user-facing prompts or documentation, update both English and Chinese.

## Testing and Packaging from Source

Run these commands from a source checkout on Windows, macOS or Linux with Node.js 22.16+. The plugin uses the Node standard library. Packaging requires npm. The native tests use the Codex CLI and npx. On macOS and Linux they also use tar. [Get the full source](https://github.com/mreasonyang/codex-polish)

```sh
npm test
node evaluation/report.mjs evaluation/example.jsonl
node -e "require('node:fs').mkdirSync('dist', { recursive: true })"
npm pack --ignore-scripts --pack-destination dist
```

`npm pack` writes `dist/kyun.si-codex-polish-<version>.tgz` using the version from `package.json`. Default tests need no API key. Native installer tests use a temporary Codex profile. The Decisions tests use mock responses to exercise the style check.

## Reporting Bugs

Report bugs in GitHub Issues. Include steps to reproduce, expected and actual results, and the versions of your OS, Node.js, Codex CLI, and `agy`. For diagnostics, ask Codex **"Check Codex Polish setup"** in the affected chat. Redact credentials, private paths, and chat text before sharing. [Open an issue](https://github.com/mreasonyang/codex-polish/issues)

Report security vulnerabilities privately. [Security policy](SECURITY.en.md)

## Submitting a Verifiable Patch

Open a GitHub pull request with the reason for the change, steps to reproduce or verify it, and results from the tests you ran. For changes involving a provider, say whether you used a mock or a live account. Use synthetic samples or authorized, de-identified material. The project uses the [Apache License 2.0](LICENSE).

## Publishing a beta

Set the version in both `package.json` and the plugin manifest to `X.Y.Z-beta.N`. Commit the change and push the matching Git tag. For example, to publish `0.0.1-beta.8`:

```sh
git tag v0.0.1-beta.8
git push origin v0.0.1-beta.8
```

GitHub Actions tests the tagged code, publishes the package to npm with the `beta` tag, and creates a GitHub prerelease. If a step fails, run the publishing workflow again from the Actions tab and enter the existing tag.

npm grants publishing access per package. Configure this package’s trusted publisher for the `mreasonyang/codex-polish` repository and the `publish.yml` workflow, and enable **Allow npm publish** and **Allow npm dist-tag**. Tag access lets the workflow remove `latest` if npm sets it on the first beta. GitHub authenticates the workflow to npm on each release without a stored npm token. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
