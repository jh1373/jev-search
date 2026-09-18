# 08. 出典・確認事項・保留事項

確認日2026-09-18。公開資料は変更されるため実装採用時にcommit/版を固定する。

## 一次資料

- [TypeSafe API](https://docs.typesafe.ai/api.md): endpoint、3種質問、Score、usage、エラー。
- [モデルと価格](https://docs.typesafe.ai/models.md): 取得時jev-1.13.0、$0.042/MTok、動的上限。
- [Confidence](https://docs.typesafe.ai/confidence.md): 分布から導出、正答率と同一ではない。
- [Vercel AI Gateway / Jev](https://vercel.com/ai-gateway/models/jev): スラッグ `typesafe-ai/jev`、入力 $0.04/M。
- [OpenRouter / Jev 1.13](https://openrouter.ai/typesafe/jev-1.13): モダリティ `text->decisions`、入力 $0.042/MTok、出力 $0。
- [OpenRouter OpenAPI仕様](https://openrouter.ai/openapi.json): `POST /api/alpha/decisions`、`DecisionsScoreQuestion` /
  `DecisionsScoreAnswer`（`score`必須・`confidence`/`legend`/`probabilities`任意）、
  `ProviderPreferences`（`only` / `allow_fallbacks` / `zdr` / `data_collection`）。
- [OpenRouter ZDRエンドポイント一覧](https://openrouter.ai/api/v1/endpoints/zdr): `typesafe/jev-1.13` がZDR対象として登録済み。
- [Vercel AI Gateway / Evaluation](https://vercel.com/docs/ai-gateway/modalities/evaluation): AI SDK の `experimental_evaluate`、score/choice/boolean。
- [Vercel AI Gateway / Pricing](https://vercel.com/docs/ai-gateway/pricing): トークンのマークアップ・プラットフォーム料なし。
- [Vercel AI Gateway / Security](https://vercel.com/docs/ai-gateway/security-and-compliance): 既定ZDR、per-request ZDR は Pro/Enterprise。
- [Vercel AI Gateway / FAQ](https://vercel.com/docs/ai-gateway/faq): プロンプト/レスポンスは保持しない（メタデータのみ、ルーティング詳細は30日）。
- [TypeSafe Jev on AI Gateway (changelog)](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway): `zeroDataRetention: true` をサポート。
- AI SDK `packages/gateway/src/gateway-evaluation-model.ts`（ソース）: 生HTTPで `POST {baseURL}/evaluation-model`、ヘッダでモデル・spec version 4 を指定する実装を確認。
- [Obsidian Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines): DOM、Vault API、CSS、ログ等。
- [Obsidian Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin): 現行ディレクトリ申請とRelease要件。

## 先駆者（設計参照）

- [metalmind](https://github.com/Nikitzu/metalmind): Score3段階、タイムアウト、フォールバック。
- [jev-rerank](https://github.com/hev/jev-rerank): バッチ、Noulによる並べ替え。
- [typesafe-mcp](https://github.com/itsmostafa/typesafe-mcp): APIクライアントと混雑応答処理。
- [Hybrid Search](https://github.com/flowing-abyss/obsidian-hybrid-search): 索引、再ランキングの分離。
- [比較評価](https://github.com/anessbelbati/jev-rerank-bench): 専用rerankerとの比較・差の不確実性。

先行リポジトリの存在/コード確認と、こちらでの動作再現は別。
日本語Obsidianでの優位性・世界初・確率の他領域への較正を主張しない。
今回、先行コードを製品へコピーしていない。

## 確認済み

Node/npm/Gitの版、Obsidian実行ファイルの存在、既存Vaultの所在、公開API資料。
ユーザーはTypeSafe直接キーをまだ保有していない（待機リスト中）。プロセスenvには `TYPESAFE_API_KEY` 未設定。
Vercel AI Gateway で Jev（`typesafe-ai/jev`）が評価モダリティとして提供され、AI SDK `experimental_evaluate` および
生HTTP（`POST {baseURL}/evaluation-model`、spec version 4）で呼べることをAI SDKソースで確認した。
consoleのログイン画面だけから「誰でも即キー発行」と判断できない。
現在の価格が永続する保証も確認できない。

## G0で解消する保留

| 項目 | 確認手段 | 未解消時 |
|---|---|---|
| Electron/requestUrlの応答/取消/redirect | 合成データのObsidian実機試験 | Transport設計再検討、出荷停止 |
| SecretStorage API・保存保護・同期範囲 | 公開型、公式資料、対応版実機 | セッションメモリのみ |
| 最低Obsidian版 | 利用APIと互換性試験 | manifest版を確定しない |
| Gateway実契約（応答shape/rounding/warnings/usage/実版） | 最大3送信の合成API試験(Gateway) | Gateway機能を実験状態に留める |
| Direct契約（版照合/丸め公差/コンテキスト） | Directキー取得後に合成API試験 | Direct経路を保留 |
| 日本語費用推定 | 実usageとの比較 | 概算/不明表示のみ |
| Gateway ZDR/学習可否の実効 | Pro/Enterprise で per-request ZDR を適用して確認 | ZDRを保証しない旨を明記 |
| 3OS性能/ライセンス | 再現buildと対象LICENSE | 対応OS/流用を制限 |
| 公開名/著作権者/申請所有者 | ユーザーの公開アカウント情報 | ローカル開発を継続、無断公開しない |

## 設計履歴

0.1は初稿。相反する同意/リトライ条件や未検証の保証を含んだため
`docs/archive/design-0.1`へ保存した。実装は0.2のみを参照する。
0.2では条件・上限をサービスの保証ではなく製品側の仮設定として記述した。
