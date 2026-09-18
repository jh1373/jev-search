# 01. アーキテクチャ設計

製品名: **Jev Search for Obsidian**(プラグインID: `jev-search`)
バージョン: 0.1.0 / ステータス: 設計固定

## 1. 目的とスコープ

Obsidian Vault 内の日本語・英語混在ノートに対し、ローカル検索(BM25)の結果を
TypeSafe Jev の確率的判断で再ランキングし、**「欲しいノートが上に来る」**検索体験を
提供する Obsidian コミュニティプラグイン。

### やること (v1 / MVP)
- ローカル BM25 検索(チャンク単位、見出し・タイトルブースト付き)
- Jev による再ランキング(3 段階 Score: off-topic / related / answers)
- 送信プレビュー・除外ルール・フォールバックを備えた プライバシー設計
- コスト・レイテンシの可視化
- 日本語ベンチマークの実施と公開(docs/benchmark)

### やらないこと (v1 Non-goals)

- 自由文回答の生成(RAG の生成段階)。判定・並べ替えまで。
- ノートの自動書き換え・移動・タグ付与(読み取り専用を維持)
- 画像/音声の理解(Jev 現行仕様がテキストのみのため)
- ローカル LLM による生成

## 2. ペルソナと最重要ユースケース

| ペルソナ | ニーズ | 本プラグインの応え |
|---|---|---|
| 日本語ノート中心の PKM ユーザー | 曖昧な語でノートを探したい | CJK bigram 対応 BM25 + 関連性判定 |
| エージェント利用者 | Vault を AI に読ませたい前段フィルタ | 上位候補の信頼度付きリスト |
| プライバシー重視ユーザー | 外部送信を制御したい | プレビュー・除外設定・オフ機能 |

## 3. 設計原則 (P1〜P8)

| ID | 原則 | 根拠 |
|----|------|------|
| P1 | Jev なしでも成立する(ローカル検索単体で価値) | 依存リスク低減・課題A対策 |
| P2 | 送信は明示同意(プレビュー→確認) | プライバシー・課題B対策 |
| P3 | 失敗時は元の検索結果を返す(空を返さない) | metalmind の実証済みパターン |
| P4 | モデルはピン留め(既定 `jev-1.13.0`) | 閾値調整の再現性 |
| P5 | テレメトリ一切なし | 信頼 |
| P6 | BYOK(API キーはユーザー所有、コードに埋め込まない) | セキュリティ・課題D対策 |
| P7 | 全判断に確率とコストを添えて表示 | Jev の差別化ポイント |
| P8 | ゼロ実行時依存(ランタイム npm 依存なし) | 供給網リスク低減・監査容易 |

## 4. システム構成図

```
┌──────────────────────────────────────────────────────────┐
│ Obsidian (Desktop)                                        │
│                                                          │
│  ┌────────────┐   query    ┌──────────────────────────┐  │
│  │ SearchView │───────────▶│ SearchPipeline           │  │
│  │ (results)  │            │  1) VaultNoteSource      │  │
│  └─────▲──────┘            │  2) chunkMarkdown        │  │
│        │                   │  3) BM25Index.search     │  │
│        │            ┌──────│  4) JevReranker (opt-in) │  │
│        │            │      └──────┬───────────┬───────┘  │
│  ┌─────┴─────┐      │             │           │          │
│  │ Preview   │◀─────┘      ┌─────▼──────┐ ┌──▼───────┐  │
│  │ Modal     │              │ TTLCache   │ │ Settings │  │
│  └───────────┘              └─────┬──────┘ └──────────┘  │
│                                   │ HTTPS (POST)         │
└───────────────────────────────────┼──────────────────────┘
                                    ▼
                    https://api.typesafe.ai/v1/systemone
                              (Jev / System One)
```

## 5. コンポーネント責務

| モジュール | 責務 | 依存先 |
|-----------|------|--------|
| `src/jev/client.ts` | Jev HTTP クライアント。タイムアウト・指数バックオフ(429/529)・使用量計測 | util |
| `src/jev/types.ts` | API 契約の型(Noul/Choice/Score, Request/Response/Usage) | なし |
| `src/jev/cache.ts` | 判定結果キャッシュ(TTL+LRU)。同一問い合わせの再課金防止 | util |
| `src/rerank/reranker.ts` | 候補→Noul/Score 質問への変換、バッチ分割、並列実行、閾値判定 | jev |
| `src/search/tokenizer.ts` | 日本語対応トークナイザ(ASCII 単語 + CJK bigram) | なし |
| `src/search/bm25.ts` | BM25 ランキング | tokenizer |
| `src/search/engine.ts` | チャンキング+インデックス構築+検索 | 上記すべて |
| `src/search/pipeline.ts` | 検索→(プレビュー)→再ランキング→結果の統合フロー | search, rerank |
| `src/ui/*` | 検索ビュー・設定タブ・送信プレビューモーダル・結果描画 | obsidian |
| `src/util/*` | hash, text クリップ/トークン推定 | なし |

## 6. ディレクトリ構成

```
Jev×Obsidian/
├─ docs/
│  ├─ design/ 01..06 (本設計書群)
│  └─ benchmark/     (日本語ベンチマークのプロトコルと結果)
├─ src/
│  ├─ main.ts          プラグインエントリ
│  ├─ jev/             Jev API 層
│  ├─ search/          ローカル検索層
│  ├─ rerank/          再ランキング層
│  ├─ ui/              UI 層 (Obsidian 依存をここに閉じる)
│  └─ util/            汎用
├─ test/
│  ├─ unit/            vitest (モック使用・オフライン)
│  ├─ integration/     実 API テスト (TYPESAFE_API_KEY があれば実行)
│  └─ fixtures/        固定入力
├─ .github/workflows/  CI
├─ manifest.json / versions.json   Obsidian プラグイン宣言
├─ esbuild.config.mjs / tsconfig.json / vitest.config.ts
└─ package.json
```

**依存の向き規約**: `ui → (search, rerank, jev) → util`。
`search` / `rerank` / `jev` / `util` は **obsidian を import しない**(テスト可能性の確保)。
Obsidian API は `ui` と `main.ts`、および `search/vaultSource.ts`(型のみ)に限る。

## 7. 主要データフロー (検索 1 回)

```
1. ユーザーがクエリ入力
2. ensureIndex(): 変更検出時のみ全ノート再チャンク+BM25 再構築
3. BM25.topK(query, fetchK)            → 候補 (既定 50)
4. excludedFolders / .obsidian 除外
5. showPreview=true → プレビューモーダル(送信内容+推定トークン/コスト)
   → ユーザー承認
6. 上位 rerankTopN(既定 30)を Jev へ(1 コール、30 件/60k 文字以内)
7. score ≥ keepAt をソート、results へ。0 件なら BM25 順を返す(P3)
8. 結果ビュー描画(見出しバッジ/スコア/レイテンシ/推定コスト)
```

## 8. 設定スキーマ(要旨。詳細は 04)

apiKey / model(既定 `jev-1.13.0`) / rerankEnabled / fetchK / rerankTopN /
keepAt / answersAt / timeoutMs / maxStateChars / showPreview / estimateCost /
excludedFolders / cacheTtlMinutes / cacheMaxEntries

## 9. セキュリティ・プライバシー原則

- キーは設定ファイルに平文保存(Obsidian 標準の制約)。README で注意喚起し、
  将来の Keychain 対応は ADR で検討(06 参照)。
- 送信対象は「承認済みプレビューの候補のみ」。裏側の自動送信はしない。
- `manifest.json` は `isDesktopOnly: true`(node:crypto 使用のため)。
- ログに本文・クエリ・キーを出力しない。DOM への反映のみ。

## 10. ADR 一覧(本文は 06)

ADR-001 BYOK / ADR-002 既定オフでなく「キー設定済みなら ON・プレビュー既定 ON」 /
ADR-003 モデルピン留め / ADR-004 ゼロ実行時依存 / ADR-005 CJK bigram トークナイザ /
ADR-006 Score 3 段階判定(metalmind 準拠) / ADR-007 プレビューゲート /
ADR-008 ベンチマーク同梱
