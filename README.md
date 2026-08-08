# 🎨 chromagic

**English** | [日本語](README.ja.md)

A **Chromatic-like** Storybook visual regression testing GitHub Action with no external SaaS.
**storycap capture → pixelmatch green/red diff → PR inline comment** (_chroma + magic_).

A replacement for reg-actions. The biggest difference is the **two-color green/red diff** (🟢 = added pixels / 🔴 = removed pixels), which makes **position shifts** obvious at a glance.

## What it looks like

When you open a PR, every changed story gets **expected / actual / difference** side by side in a PR comment:

![chromagic PR comment demo](docs/vrt-demo.gif)

Here's a closer look — a QtyStepper whose "+" was turned green and given wider spacing (difference: 🔴 = old position / 🟢 = new position):

![chromagic example](docs/example-diff.png)

## Quick start

This is all the calling workflow needs:

```yaml
# .github/workflows/vrt.yaml
name: VRT
on:
  pull_request:
  push: { branches: [main] } # ← required for baseline updates

permissions:
  contents: write # pushes the baseline/report branches
  pull-requests: write # PR comments

jobs:
  vrt:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2 # or actions/setup-node
      - run: bun install --frozen-lockfile
      - run: bun run build-storybook # → storybook-static/
      - uses: sgash708/chromagic@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

- **On PRs**: captures every story → compares against `vrt-baseline` → posts green/red diffs as a PR comment
- **On push to main (= merge)**: saves the current screenshots to `vrt-baseline` (= the next baseline; equivalent to Chromatic's Accept)

> On the first run there is no `vrt-baseline` yet, so every story is "new". **Merge once** to establish the baseline; real diffs appear from the next PR.

## Examples

Ready-to-copy workflows for `.github/workflows/vrt.yaml`:

| File | Use case |
|---|---|
| [`examples/vrt.yaml`](examples/vrt.yaml) | **bun** (recommended) |
| [`examples/vrt-npm.yaml`](examples/vrt-npm.yaml) | **npm / Node.js** (no bun) |
| [`examples/vrt-custom.yaml`](examples/vrt-custom.yaml) | Customized inputs (viewport, sensitivity, branch names, etc.) |

## Inputs

| name | default | description |
|---|---|---|
| `github-token` | (required) | `GITHUB_TOKEN`. Used for posting comments and pushing branches |
| `storybook-static-path` | `storybook-static` | Built Storybook static directory |
| `viewport` | `390x844` | Capture viewport WxH |
| `port` | `6006` | Local port for serving the static build |
| `matching-threshold` | `0.05` | pixelmatch sensitivity (0-1, smaller = more sensitive) |
| `threshold-pixel` | `50` | Stories with more changed pixels than this count as "changed" |
| `baseline-branch` | `vrt-baseline` | Branch holding the baseline images |
| `report-branch` | `vrt-reports` | Branch hosting the images referenced by PR comments |
| `install-fonts` | `true` | Install Noto CJK (prevents tofu for CJK text on Linux) |

## Outputs

Counts usable in later steps (e.g. fail the job when there are diffs).

| name | description |
|---|---|
| `changed` | Number of stories with diffs |
| `new` | Number of new stories (absent from the baseline) |
| `deleted` | Number of deleted stories |
| `pass` | Number of matching stories |
| `total` | Total number of captured stories |

```yaml
- uses: sgash708/chromagic@v1
  id: vrt
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
- if: ${{ steps.vrt.outputs.changed != '0' }}
  run: echo "::warning::${{ steps.vrt.outputs.changed }} visual diff(s) found"
```

## How it works

- **Capture**: `storycap` (Chrome for Testing provisioned via `setup-chrome`; Noto CJK bundled so CJK text renders correctly).
- **Compare**: `pixelmatch` (`diffColor=red` / `diffColorAlt=green`) generates the two-color diff.
- **Baseline / image hosting**: no external storage. Baselines live on the `vrt-baseline` branch; PR images are pushed to `vrt-reports/<run_id>` branches and referenced from comments via `?raw=true`.
- **Approval**: for intended changes, just **merge the PR into main** and the baseline updates.

## License

[MIT](LICENSE)
