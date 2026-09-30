# chromagic 実ページVRT + 明示的承認フロー 設計

## 背景・目的

chromagicは現在Storybookのstory単位でVRTを行うが、実際にデプロイされる画面全体の見た目のデグレは検知できない。また現状の承認は「PRをmainにmergeする」ことで暗黙的に行われ、差分を見た上での明示的な承認ステップがない。

本拡張では以下を追加する。

1. 実際のページ（URL）単位のVRT
2. 実ページVRTに限り、PRコメント上での明示的承認（`/chromagic approve`）がなければマージできないゲート

Storybook側の既存フロー（merge=承認）は変更しない。

## スコープ

- 対象: 実ページVRTのみ新方式。Storybook VRTは現状維持
- ログイン: consumerが用意するPlaywrightログインスクリプトでstorage stateを取得
- 対象ページ一覧: consumerリポジトリ内の設定ファイル（`chromagic.pages.json`）
- アプリ起動: consumerがaction inputで渡す起動コマンド
- baseline/report: Storybookとは別ブランチ（`vrt-baseline-pages` / `vrt-reports-pages`）
- Slack通知: 本フェーズのスコープ外（将来拡張として案のみ記載）
- 実ページ機能は明示的opt-in。`pages-config`が存在しない、または`pages-start-command`未指定の場合は実ページVRTをスキップし、既存consumerの挙動に影響を与えない

## アーキテクチャ

### モジュール構成

- `src/main.mjs`: 既存Storybook VRT。差分比較・ブランチpush・コメント生成のロジックを`src/lib/diff.mjs`に切り出し、実ページ側と共有する
- `src/lib/diff.mjs`: pixelmatch比較、baseline/reportブランチへのpush、PRコメントのupsertなど共通ロジック（既存main.mjsからの抽出、ロジック自体は変更しない）
- `src/pages-capture.mjs`: アプリ起動待ち→ログインスクリプト実行→`chromagic.pages.json`のURL巡回撮影
- `src/pages-compare.mjs`: 実ページ版の比較・PRコメント・check run制御（`diff.mjs`を再利用しつつ、実ページ専用のコメントマーカーとcheck run発行を追加）
- `src/approve.mjs`: `/chromagic approve`コメントを処理し、check runを更新する

### action.yml拡張（新規inputs）

| name | default | 説明 |
|---|---|---|
| `pages-config` | `chromagic.pages.json` | 対象URL一覧の設定ファイルパス。存在しなければ実ページVRTをスキップ |
| `pages-start-command` | (未指定) | アプリ起動コマンド。未指定なら実ページVRTをスキップ |
| `pages-base-url` | `http://localhost:3000` | 起動後にアクセスするベースURL |
| `pages-login-script` | (任意) | ログイン用Playwrightスクリプトのパス。省略時は未ログイン状態のままキャプチャ |
| `pages-health-check-timeout` | `30` | 起動待ちのタイムアウト秒数 |
| `pages-baseline-branch` | `vrt-baseline-pages` | 実ページ用ベースラインブランチ |
| `pages-report-branch` | `vrt-reports-pages` | 実ページ用レポートブランチ |
| `pages-viewport` | (`viewport`と同値) | 実ページキャプチャのビューポート。省略時は既存`viewport`を共用 |

既存の`matching-threshold` / `threshold-pixel` / `install-fonts`は実ページVRTでも共用する。

### `chromagic.pages.json` スキーマ

```json
{
  "pages": [
    { "path": "/login", "name": "login" },
    { "path": "/dashboard", "name": "dashboard" }
  ]
}
```

- `path`: `pages-base-url`からの相対パス（必須）
- `name`: 画像ファイル名（省略時は`path`をslug化して使用）

### ログインスクリプトの契約

consumerが用意するPlaywrightスクリプト（例: `.github/chromagic/login.mjs`）は次のシグネチャで実装する。

```js
// default export: Playwright の page を受け取りログインを完了させる
export default async function login(page) {
  await page.goto(`${process.env.CHROMAGIC_BASE_URL}/login`);
  await page.fill("#id", process.env.MY_LOGIN_ID);
  await page.fill("#password", process.env.MY_LOGIN_PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL("**/dashboard");
}
```

chromagicはこの関数を実行した後のブラウザcontextからstorage stateを保存し、以降の各ページキャプチャに再利用する。認証情報（ID/PW等）はconsumer側workflowのenvからスクリプトへ直接渡され、chromagic本体のコードには渡らない。

### 実ページキャプチャフロー

1. `pages-start-command`をバックグラウンドで起動
2. `pages-base-url`に対しポーリングでヘルスチェック（200応答を待つ、`pages-health-check-timeout`でタイムアウト）
3. `pages-login-script`が指定されていればPlaywrightで実行し、storage stateを取得
4. `chromagic.pages.json`の各pageについて、storage stateを適用したcontextで`page.goto`しスクリーンショットを撮影
5. `src/lib/diff.mjs`の比較ロジックで`vrt-baseline-pages`と比較し、差分を`vrt-reports-pages/<run_id>`へpush
6. PRに実ページ専用コメントをupsert（マーカー`<!-- chromagic-vrt-pages -->`、既存Storybookコメントとは別に両方表示される）
7. 差分がある場合、check run `chromagic/pages-approval`を対象PRのhead shaに対し`status=completed`, `conclusion=failure`で作成
8. 差分がない場合は同名のcheck runを`conclusion=success`で作成（承認不要でマージ可能）

ヘルスチェックタイムアウトおよびログインスクリプトの実行失敗は、実ページVRTジョブ自体を失敗させる（デグレを検知できない状態のまま「差分なし」と誤判定することを避けるため）。

### 承認フロー（`/chromagic approve`）

consumer側に追加してもらう新規workflow（`examples/vrt-pages-approve.yaml`として提供）が次を行う。

1. `issue_comment: created`イベントでトリガーし、対象がPRへのコメントであることを確認
2. コメント本文が`/chromagic approve`（前後の空白は許容）と一致するか判定。一致しなければ何もしない
3. PR情報を取得し、コメント投稿者とPR作成者が別人であることを確認（セルフApprove防止）
4. コメント投稿者のリポジトリ権限を`GET /repos/{owner}/{repo}/collaborators/{username}/permission`で確認し、`write`以上でなければ拒否
5. 条件を満たせば、対象PRのhead shaに対する`chromagic/pages-approval`のcheck runを`conclusion=success`に更新
6. 結果をコメントへのリアクション（成功: 👍 / 拒否: 👎 + 理由コメント）で通知

この処理は`src/approve.mjs`として実装し、chromagic action自体に`mode: approve`のような入力を持たせて呼び出せる形にする（consumer側のworkflow定義をシンプルに保つため）。

### head sha変更時の再承認

check runはPRのhead sha単位で作成する。新しいcommitがpushされ実ページVRTが再実行されると、新しいshaに対するcheck runが新規作成され、自動的に未承認（failure）状態に戻る。過去の承認は新しいshaへ引き継がれない。

consumerはbranch protectionで`chromagic/pages-approval`をrequired checkに設定することで、未承認PRのマージをブロックできる（設定手順はREADMEに記載）。

### baseline更新（実ページ）

実ページのbaseline更新は、Storybookと同様にdefaultブランチへのpush（＝マージ後）で`vrt-baseline-pages`を更新する。承認フローは「マージを許可するゲート」であり、baseline自体の更新ロジックはStorybookと共通のものを流用する。

## テスト方針

- `src/lib/diff.mjs`（比較・コメント生成ロジック）: 既存main.mjsからの抽出であり、ロジック不変であることをユニットテストで担保
- `src/approve.mjs`のセルフApprove防止・権限チェック判定: 最重要ロジックのためユニットテストを必須とする
- `src/pages-capture.mjs`のヘルスチェック・ログインスクリプト実行・URL巡回撮影: モックによるユニットテスト
- 実際のE2E的な動作確認は、examplesを使った手動検証で行う

## 将来拡張（本フェーズのスコープ外）

- Slack通知: 差分検出時・Approve完了時にWebhook通知するinputを追加
