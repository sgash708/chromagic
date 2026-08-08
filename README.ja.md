# 🎨 chromagic

[English](README.md) | **日本語**

外部 SaaS なしの **Chromatic ライク**な Storybook ビジュアルリグレッションテスト GitHub Action。
**storycap 撮影 → pixelmatch の緑/赤 diff → PR インラインコメント**（_chroma + magic_）。

reg-actions の置き換え。最大の違いは **diff が緑/赤の2色**（🟢=増えた / 🔴=消えたピクセル）で、特に**位置ズレ**が一目で分かること。

## 出力イメージ

PR を出すと、変更があった story ごとに **expected / actual / difference** が PR コメントに並びます:

![chromagic PR comment demo](docs/vrt-demo.gif)

下はさらに拡大した例。QtyStepper の「+」を緑にして間隔を広げたケース（difference: 🔴=旧位置 / 🟢=新位置）:

![chromagic example](docs/example-diff.png)

## クイックスタート

呼び出し側のワークフローはこれだけ:

```yaml
# .github/workflows/vrt.yaml
name: VRT
on:
  pull_request:
  push: { branches: [main] } # ← ベースライン更新に必須

permissions:
  contents: write # baseline/report ブランチ push
  pull-requests: write # PR コメント

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

- **PR**: 全 story を撮影 → `vrt-baseline` と比較 → 緑/赤 diff を PR コメントに表示
- **main への push（=マージ）**: 現行を `vrt-baseline` に保存（＝次回の基準。Chromatic の Accept 相当）

> 初回は `vrt-baseline` が無いため全 story が「new」。**一度マージ**して基準が出来た後の PR から実差分が出る。

## Examples

そのままコピーして `.github/workflows/vrt.yaml` に置ける例:

| ファイル | 用途 |
|---|---|
| [`examples/vrt.yaml`](examples/vrt.yaml) | **bun**（推奨） |
| [`examples/vrt-npm.yaml`](examples/vrt-npm.yaml) | **npm / Node.js**（bun 非使用） |
| [`examples/vrt-custom.yaml`](examples/vrt-custom.yaml) | input をカスタム（ビューポート・感度・ブランチ名 等） |

## inputs

| name | default | 説明 |
|---|---|---|
| `github-token` | （必須） | `GITHUB_TOKEN`。コメント投稿・ブランチ push に使用 |
| `storybook-static-path` | `storybook-static` | ビルド済み Storybook 静的ディレクトリ |
| `viewport` | `390x844` | 撮影ビューポート WxH |
| `port` | `6006` | 静的配信のローカルポート |
| `matching-threshold` | `0.05` | pixelmatch 感度(0-1、小さいほど敏感) |
| `threshold-pixel` | `50` | この変化ピクセル数超で「変更」判定 |
| `baseline-branch` | `vrt-baseline` | 基準画像ブランチ |
| `report-branch` | `vrt-reports` | PR コメント画像のホストブランチ |
| `install-fonts` | `true` | Noto CJK を入れる(日本語の豆腐化防止・Linux) |

## outputs

後続ステップで件数を使える（例: 差分があれば fail させる）。

| name | 説明 |
|---|---|
| `changed` | 差分が出た story 数 |
| `new` | 新規 story 数（baseline に無い） |
| `deleted` | 削除 story 数 |
| `pass` | 一致した story 数 |
| `total` | 撮影した story 総数 |

```yaml
- uses: sgash708/chromagic@v1
  id: vrt
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
- if: ${{ steps.vrt.outputs.changed != '0' }}
  run: echo "::warning::${{ steps.vrt.outputs.changed }} 件の視覚差分あり"
```

## 仕組み

- **撮影**: `storycap`（Chrome for Testing を `setup-chrome` で用意、Noto CJK 同梱で日本語も正しく描画）。
- **比較**: `pixelmatch`（`diffColor=赤` / `diffColorAlt=緑`）で2色 diff を生成。
- **基準/画像ホスト**: 外部ストレージ不要。基準は `vrt-baseline`、PR 画像は `vrt-reports/<run_id>` ブランチへ git push し、コメントから `?raw=true` で参照。
- **承認**: 意図した変更は **PR を main に merge** すれば基準が更新される。

## License

MIT
