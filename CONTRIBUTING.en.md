# Contributing to Agent Polish

[简体中文](CONTRIBUTING.md)

For installation, see the [project README](README.md). For details on when the plugin sends a draft and how it displays the reply, see the [technical reference](docs/technical.en.md).

## Where to Make Changes

- `packages/codex-polish/` and `packages/agy-polish/` define the public npm packages. The workspace root is private. `scripts/install.mjs` and `scripts/agy-cli.mjs` handle setup, updates, diagnostics, and uninstallation for their respective hosts.
- `plugins/codex-polish/` contains the plugin manifest, the `UserPromptSubmit` hook, and two skills. `codex-polish` sends the selected draft through `agy acp`, and formats Gemini’s complete reply for display. Explicit requests use Turbo. The optional OpenAI Decisions check applies only when the hook runs in Normal mode. `codex-polish-setup` manages the current Codex profile’s polishing settings, runtime model discovery, diagnostics, and the [credential guide](plugins/codex-polish/skills/codex-polish-setup/references/credentials.en.md).
- `plugins/agy-polish/` is the standalone Antigravity plugin. Its MCP tool calls the local `codex exec` to edit a draft. Antigravity chat setup and the terminal installer share the same preferences.
- The full source tree includes the regression suite in `tests/` and the evaluation script and synthetic samples in `evaluation/`. See the [evaluation guide](evaluation/README.en.md).
- When updating user-facing prompts or documentation, update both English and Chinese.

## Testing and Packaging from Source

Run these commands from a source checkout on Windows, macOS or Linux with Node.js 22.16+ and npm. The native tests exercise the Codex and Antigravity CLIs. [Get the full source](https://github.com/mreasonyang/agent-polish)

```sh
npm test
node evaluation/report.mjs evaluation/example.jsonl
node -e "require('node:fs').mkdirSync('dist', { recursive: true })"
npm pack --workspace @kyun.si/codex-polish --pack-destination dist
npm pack --workspace @kyun.si/agy-polish --pack-destination dist
```

Each workspace prepares its files in `prepack` and produces `dist/kyun.si-codex-polish-<version>.tgz` or `dist/kyun.si-agy-polish-<version>.tgz`. Default tests need no API key. Native installer tests use temporary profiles, and Decisions tests use mock responses to exercise the style check.

## Reporting Bugs

Report bugs in GitHub Issues. Include steps to reproduce, expected and actual results, and the versions of your OS, Node.js, Codex CLI, and `agy`. For diagnostics, ask Codex **"Check Codex Polish setup"** in the affected chat. Redact credentials, private paths, and chat text before sharing. [Open an issue](https://github.com/mreasonyang/agent-polish/issues)

Report security vulnerabilities privately. [Security policy](SECURITY.en.md)

## Submitting a Verifiable Patch

Open a GitHub pull request with the reason for the change, steps to reproduce or verify it, and results from the tests you ran. For changes involving a provider, say whether you used a mock or a live account. Use synthetic samples or authorized, de-identified material. The project uses the [Apache License 2.0](LICENSE).

## Publishing a release

For each host you are releasing, set the version in `packages/<host>-polish/package.json` and the matching plugin manifest under `plugins/<host>-polish/`. Set `publishConfig.tag` in that workspace to the npm channel for the version.

| Version | Codex Git tag | Antigravity Git tag | npm tag | GitHub release |
| --- | --- | --- | --- | --- |
| `X.Y.Z` | `codex-vX.Y.Z` | `agy-vX.Y.Z` | `latest` | Release |
| `X.Y.Z-beta.N` | `codex-vX.Y.Z-beta.N` | `agy-vX.Y.Z-beta.N` | `beta` | Prerelease |

After the target commit passes CI, push the matching host tag. Betas can originate on a feature branch. Both hosts can release the same version independently. For example, `codex-v0.0.4-beta.2` selects only `@kyun.si/codex-polish`, and `agy-v0.0.4-beta.2` selects only `@kyun.si/agy-polish`. For each tag, Actions tests on Linux, macOS and Windows and publishes the selected tarball to npm and its own GitHub release. The repository's GitHub **Latest** release follows Codex stable releases. npm's `latest` tag is independent for each package.

To resume a host release, rerun the original tag run, or run `gh workflow run publish.yml --ref <tag> -f tag=<tag>`. The workflow verifies any existing npm version and recovers missing release assets or tags when safe. Recover a historical `vX.Y.Z` or `vX.Y.Z-beta.N` by running `gh workflow run publish.yml --ref main -f tag=<tag>`. This verifies the existing Codex npm version and can restore its GitHub asset. An older release cannot move a newer npm channel backward.

### npm setup after the GitHub rename

1. Try the existing trusted connection for `@kyun.si/codex-polish`. If npm rejects OIDC from the renamed repository, have a maintainer with npm write access and 2FA open **Settings → Trusted publishing**. Add a GitHub Actions connection with owner `mreasonyang`, repository `agent-polish`, workflow `publish.yml` and a blank environment. Enable **Allow npm publish** and **Allow npm dist-tag**. npm binds a validated connection to the repository identity and does not let you edit its required fields. After the new connection succeeds, you can remove the obsolete connection. A new connection needs a successful publish within 48 hours. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
2. If `@kyun.si/agy-polish` is new, a maintainer authorized to create packages in `@kyun.si` must establish the npm name first. With npm 11.21+ and a signed-in local npm account, pack the intended workspace and stage the archive as public. npm creates the public `0.0.0-stage` placeholder. Reject the staged beta with 2FA to free up that version for the OIDC run, then add the same GitHub Actions connection to the new package. Use the staged ID printed by npm. [npm package creation with staging](https://github.blog/changelog/2026-10-02-npm-staged-publishing-now-supports-creating-new-packages/) · [npm staged publishing](https://docs.npmjs.com/staged-publishing/)

   ```sh
   node -e "require('node:fs').mkdirSync('dist', { recursive: true })"
   npm pack --workspace @kyun.si/agy-polish --pack-destination dist
   npm stage publish ./dist/kyun.si-agy-polish-0.0.4-beta.2.tgz --access public --tag beta --registry https://registry.npmjs.org/
   npm stage reject <stage-id> --registry https://registry.npmjs.org/
   ```

GitHub Actions then publishes the real beta via OIDC with provenance from the public repository. **Allow npm dist-tag** lets it recover tags and remove the temporary `latest` pointer if npm assigned it to the placeholder or first beta and the version history contains only prereleases. [npm provenance](https://docs.npmjs.com/generating-provenance-statements/) · [npm dist-tag permissions](https://docs.npmjs.com/trusted-publishers/#managing-dist-tags-with-trusted-publishing)
