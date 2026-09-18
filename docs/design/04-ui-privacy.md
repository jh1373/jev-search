# 04. UI・プライバシー・設定

## 初回体験

インストール → ローカル検索が利用可能 → 任意の「Jevを設定」 → 外部送信説明
→ 接続先の選択（OpenRouter / TypeSafe直接） → キー設定（SecretStorage または セッションのみ） → 合成データの接続テスト（明示ボタン）
→ Jev機能を有効化。
キーの有無だけで外部送信を有効化しない。UIは日本語/英語を初版から文言辞書で分離。

検索ビュー: 入力、ローカル件数/更新状態、再ランキングボタン、ローカル/Jevタブ。
結果: タイトル、見出し、抜粋、元順位、Score、未評価/キャッシュ/障害表示。
confidence/確率分布は詳細展開し、正答率ではないと説明する。

## 厳密な送信同意

初版は毎回プレビュー必須。セッション一括同意・背景送信・自動再送ボタン連打は設けない。
表示するもの: 宛先ホスト（OpenRouter=`openrouter.ai` / Direct=`api.typesafe.ai` / Gateway=`ai-gateway.vercel.sh`）、
モデル識別子、質問テンプレート、クエリ、匿名ID、タイトル、見出し、抜粋の全文、件数、分割数、byte数、概算費用、
再試行最大1回の注意。
OpenRouter 経由の場合は「OpenRouter を経由して TypeSafe AI に転送される」こと、プロバイダを TypeSafe に固定し
ZDR（ゼロデータ保持）を要求していること、保持・学習の最終条件は OpenRouter と提供元の方針に従うことを明示する
（当プラグインは保証しない）。Gateway 経由の場合も「Vercel AI Gateway を経由して TypeSafe AI に転送される」ことを明示する。
短いノートは全文が抜粋に入る場合がある。「全文は決して送らない」と説明しない。

承認対象は確定serialized JSON（全バッチ）のhash。承認後に同じbodyを送信する。
表示文字列に加えJSONそのものも展開表示できる。候補除外でbody変更したら再生成し再承認。
送信直前にpolicy世代・索引世代・queryId・キー世代・hash一致を確認。
通信済みデータはキャンセルしても外部から回収できないと明記する。

## 除外ポリシー

フォルダはnormalizePath後にpath===folder または path startsWith(folder+'/')で判定。
../、絶対パス、NULを設定入力として拒否。文字列前方一致だけでPrivate2を除外しない。
タグは#を除きNFKC小文字化。タグaはaとa/bに一致。frontmatterと本文双方を対象。
既定の追加除外タグはprivate、secret。既定除外フォルダはTemplates、Attachments。
実configDir/隠しディレクトリは強制除外。大文字小文字はVaultの実pathを基準とする。
メタデータ未確定時は外部送信しない。除外設定変更は索引・候補・キャッシュ・承認を失効。

## キー保存

キーは「セッション上書き」→「SecretStorage」の順に解決する。
接続先ごとに独立して保持し、接続先を切り替えても他経路のキーは表示・流用しない。

1. **SecretStorage（既定・推奨）**: Obsidian の `app.secretStorage` に値を保存し、`data.json` には
   **秘密の名前だけ**を入れる。公式ガイド [Store secrets](https://docs.obsidian.md/plugins/guides/secret-storage) は
   「`data.json` に平文で置く問題を解決する」「実際の秘密はVault単位のローカル保存に置かれる」と説明している。
   Obsidianを再起動しても残る。設定UIは `SecretComponent` を使い、ユーザーが名前を選ぶか新規作成する。
   IDは英小文字・数字・ハイフンのみ（Obsidianの制約）。不正なIDは空として扱い、キーなしに戻す。
2. **セッションのみの上書き**: 設定画面のテキスト欄に入れた値はメモリのみで、再起動すると消える。
   保存済みの値より優先する。短時間だけ別のキーを使いたい場合の逃げ道。

確認済み（2026-09-18）: `SecretStorage` は `obsidian@1.13.1` の公開型に存在し `@since 1.11.4`。
`setSecret(id, secret)` / `getSecret(id): string | null` / `listSecrets(): string[]`。
`minAppVersion` は 1.13.0 のため常に利用可能。`SecretComponent` は `@since 1.11.1`。

未確認: 保存先の実体（OSキーチェーンかObsidian独自のローカル保存か）、同期範囲、他プラグインや同一OSユーザーからの隔離。
公式ガイドは「Vault単位のローカル保存」とだけ述べ、暗号化やOSキーチェーンを明示していない。
**未確認のまま「暗号化されている」「同期されない」と宣伝しない。**

値が `data.json` に到達しないことは `npm run test:bundle` が検査する（保存スナップショットに値が含まれれば失敗）。
旧 `apiKey` フィールドを検出したら通常ロードせず、削除とキー再発行を案内する。
非対応環境ではセッション入力のみに戻し、平文ファイルへ無断フォールバックしない。
開発テスト用envキーはテストランナーだけが読み、製品ビルドへ埋め込まない。

## 永続設定（秘密の値・本文・クエリなし）

| 名前 | 初期値 | 検証 |
|---|---|---|
| schemaVersion | 1 | 未知の新版は読取のみ・上書き禁止 |
| rerankEnabled | false | boolean |
| model | jev-1.13.0 | Direct のみ。G0検証版、最大64文字。Gateway はヘッダの `typesafe-ai/jev` を使用 |
| endpoint | openrouter | `openrouter` / `direct` / `gateway` のみ。任意URLは拒否 |
| fetchK | 50 | 整数10〜100 |
| rerankNotes | 20 | 整数1〜20 |
| excludedFolders / excludedTags | 本書既定 | 100件・各256文字以内 |
| cacheTtlMinutes | 30 | 0〜60、0で無効 |
| monthlySoftBudgetUsd | 1 | 有限0〜100、0で送信停止 |
| locale | auto | auto/ja/en |
| secrets | 空 | 接続先ごとの秘密の**名前**（値ではない）。英小文字・数字・ハイフン、64文字以内。旧 `apiKey` は読まない |

プレビュー必須・送信先・送信サイズ・物理同時数は初版の不変条件。
不正設定は警告し安全既定へ。未知フィールドは実行しない。
保存はdebounce/直列化して競合防止。失敗時は旧設定を保ち利用者に通知する。
旧apiKeyフィールドを検出したら通常ロードせず、削除とキー再発行を案内する。

## セキュリティ境界

- UIはtextContent/ObsidianのテキストDOM API。innerHTMLや外部画像レンダリング禁止。
- ノート由来のURLへ自動アクセスしない。クリックはVault内TFileに解決する。
- プロンプトインジェクションは判断品質のリスクとして試験。LLM判定を認可に使わない。
- ログは状態コード/自前エラー種別のみ。例外のmessage/応答本文を丸ごと出さない。
- エクスポート診断は明示操作・版と計数のみ。プロジェクトパス、query、キーなし。
- ZDR/No Trainingはプロバイダーとの条件。プラグインが独自に保証しない。

## アクセシビリティと障害UI

Tab移動、↑↓、Enterで開く、Escで閉じる。Modal終了後は起点にフォーカスを戻す。
role/listbox/option、aria-liveで状態通知。色だけで順位差を示さない。
Obsidian CSS変数使用。IME、ズーム200%、ライト/ダーク、読み上げを手動検証。
401=キー確認、422=リクエスト非対応、429/529=混雑、期限超過=ローカル継続。
「低関連」と「未評価」を同じ灰色スコア0で表示しない。
