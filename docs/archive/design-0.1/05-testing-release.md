# 05. テスト・ベンチマーク・リリース設計

## 1. テスト戦略の 3 層

| 層 | 範囲 | ツール | 実行条件 |
|---|---|---|---|
| 単体 | クライアント/リランカー/BM25/トークナイザ/キャッシュ | vitest(モック fetch) | 常時・オフライン |
| 結合 | 実 Jev API に対する 1 往復(キー必須) | vitest(`jev.integration.test.ts`) | `TYPESAFE_API_KEY` がある時のみ |
| 手動 E2E | 実 Vault での検索体験・プレビュー・設定反映 | チェックリスト(本書 §5) | リリース前 |

CI(GitHub Actions)では単体のみ。結合テストはローカルで手動実行
(キーを CI に置かない=漏洩面の削減)。

## 2. 単体テスト計画(主要ケース)

**client.test.ts**
- 200 正常: answers マッピング・usage 通知
- 429 → Retry-After 200ms → 成功(2 回目)で 1 リトライを確認
- 429×4 → JevRateLimitError(リトライ 3 回上限)
- 529 → リトライされる
- 422 → リトライしない
- 401 → リトライしない
- タイムアウト(AbortError) → リトライ後諦め
- ネットワーク TypeError → リトライされる

**cache.test.ts**
- 同キー hit / TTL 失効 / LRU 退避(上限超過で最古除去) / キー安定性

**tokenizer.test.ts**
- 日本語: 「プロジェクト管理」→ bigram 生成
- 英数: "BM25 reranker" → `bm25, reranker` (+ bigram 区別)
- 混合: 「RAGで再ランキングする」
- 記号のみ・空文字・絵文字

**bm25.test.ts**
- フィクスチャ 5 ノートで、期待通りの上位 3 件
- タイトル一致ブーストの確認
- 日本語クエリ recall(語尾違い)

**reranker.test.ts**
- score マッピング(h00↔候補0) / 閾値フィルタ / 全員未満→フォールバック
- バッチ分割(35 候補→2 コール) / タイトル付与の確認
- クライアント例外→例外透過(パイプラインで捕捉する契約)

**pipeline.test.ts**
- Jev 成功 → Jev 順 / Jev 失敗 → BM25 順+警告バッジ
- excludedFolders が候補から除去される
- 除外タグのノートが除外される

## 3. 結合テスト(実 API)

- 固定クエリ 3 種 × 固定 state(社内向けダミーテキスト)で:
  1) ステータス 200・answers が質問 ID と一致
  2) score/probabilities が 0..1・confidence 存在
  3) usage 記録が 0 超
  - 失敗しても開発環境の問題として扱い、単体結果に影響させない。

## 4. 日本語ベンチマーク (docs/benchmark/)

**目的**: 「日本語ノートで Jev 再ランキングは BM25 より良いか」を数値で公開。

### プロトコル
1. **コーパス**: 公開可能な日本語文書 50〜200 ノート
   (候補: 自作サンプル Vault / 公開日本語ノート集合 / CLI で生成した合成ノート)
2. **クエリ**: 20〜30 問。各問に「正解ノート(1〜3 件)」を人手で付与
   - 意味質問・部分一致・逆説語(同義語のみで対象語を含まない)を混ぜる
3. **方式**: (a) BM25 のみ (b) BM25+Jev 再ランキング
4. **指標**: Recall@5 / nDCG@5 / Hit@1 / p50・p95 レイテンシ / 1 問あたりコスト
5. **信頼性**: クエリごとの個別結果を docs/benchmark/results.md に全掲載(隠さない)
6. **限界の明記**: 評価者=作者・サンプル規模・汎化の限界を明記

### 実施手順(手動だが再現可能)
- `test/fixtures/benchmark/` にコーパスと golden ファイル
- スクリプト(後日同梱)でCLI実行→集計→ markdown 生成

## 5. 手動リリース前チェックリスト

- [ ] `npm run build` 成功(警告ゼロ目標)
- [ ] `npm run test:unit` 全緑
- [ ] 実 Vault(`Documents\Obsidian Vault`)で手動確認:
  - [ ] インデックス構築が遅延実行され UI を塞がない
  - [ ] 検索→プレビュー→承認→再ランキング→表示 が通る
  - [ ] キー無しでローカル検索のみ動く(P1)
  - [ ] オフライン時に警告表示+ローカル順(P3)
  - [ ] 除外フォルダが機能
  - [ ] キー変更→キャッシュクリア
- [ ] manifest の `version` と `versions.json` 整合
- [ ] README(英日)・ライセンス・注意喚起

## 6. CI (.github/workflows/ci.yml)

- push/PR で: npm ci → typecheck → test:unit → build
- Node 22 / 24 のマトリクス
- 秘密情報なし・ネットワークアクセスなし

## 7. リリース形態

- GitHub Releases に `main.js / manifest.json / styles.css` を添付
- Obsidian コミュニティプラグイン申請は v1.0 安定後(審査観点: 無テレメトリ・
  明示的同意フローは有利に働く見込み)
