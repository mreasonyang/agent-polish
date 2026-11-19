# Contributing to Codex Polish

[简体中文](CONTRIBUTING.md)

For installation, see the [project README](README.en.md). For the checks a reply goes through, see the [technical reference](docs/technical.en.md).

## Where to Make Changes

- `scripts/install.mjs` and the `.command` launchers handle installation, updates, status checks, uninstallation, and local marketplace registration.
- `plugins/codex-polish/` contains the plugin manifest, the `UserPromptSubmit` hook, and two skills. `codex-polish` handles placeholder protection, optional OpenAI Decisions checks, `agy acp` rewrites, and validation. `codex-polish-setup` manages `.codex/codex-polish.*` settings, runtime model discovery, diagnostics, and the [credential guide](plugins/codex-polish/skills/codex-polish-setup/references/credentials.en.md).
- The full source tree includes the regression suite in `tests/` and the evaluation script and synthetic samples in `evaluation/`. See the [evaluation guide](evaluation/README.en.md).
- When updating user-facing prompts or documentation, update both English and Chinese.

## Testing and Packaging from Source

Run these commands from a source checkout on macOS or Linux with Node.js 22.16+ (standard library only, no `npm install`). Packaging requires npm. The native installation tests also use the Codex CLI, npx, and tar. [Get the full source](https://github.com/mreasonyang/codex-polish)

```sh
npm test
node evaluation/report.mjs evaluation/example.jsonl
mkdir -p dist
npm pack --ignore-scripts --pack-destination dist
```

`npm pack` writes version `0.0.1-beta.1` of `@kyun.si/codex-polish` to `dist/kyun.si-codex-polish-0.0.1-beta.1.tgz`. Default tests need no API key. Native installer tests use a temporary Codex profile. A separate opt-in test makes four billable OpenAI requests. See the [live test instructions](docs/technical.en.md).

## Reporting Bugs

Report bugs in GitHub Issues. Include steps to reproduce, expected and actual results, and the versions of your OS, Node.js, Codex CLI, and `agy`. For diagnostics, ask Codex **"Check Codex Polish setup"** in the affected project. Redact credentials, private paths, and chat text before sharing. [Open an issue](https://github.com/mreasonyang/codex-polish/issues)

Report security vulnerabilities privately. [Security policy](SECURITY.en.md)

## Submitting a Verifiable Patch

Open a GitHub pull request with the reason for the change, steps to reproduce or verify it, and results from the tests you ran. For changes involving a provider, say whether you used a mock or a live account. Use synthetic samples or authorized, de-identified material. The project uses the [Apache License 2.0](LICENSE).

## Publishing to npm

For the first release, a maintainer with publish access to `@kyun.si` must sign in to npm, test and pack the project as shown above, then publish the tarball manually from the repository root.

```sh
npm publish ./dist/kyun.si-codex-polish-0.0.1-beta.1.tgz --tag beta --access public
```

After the first publish succeeds, add a GitHub trusted publisher in the npm package settings. Select `mreasonyang/codex-polish` and enter `publish.yml` as the workflow filename. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)

For subsequent betas, use a Git tag of the form `vX.Y.Z-beta.N`. For example, after updating the package version to `0.0.1-beta.2`, create a GitHub Release for tag `v0.0.1-beta.2` and select **Set as a pre-release**. The workflow checks the version, runs the tests, and publishes with the npm `beta` tag. Reserve `latest` for stable releases.
