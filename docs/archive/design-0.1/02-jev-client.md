# 02. Jev API クライアント設計

対象: `src/jev/client.ts`, `src/jev/types.ts`, `src/jev/cache.ts`, `src/util/cost.ts`

## 1. エンドポイントと契約

- `POST https://api.typesafe.ai/v1/systemone`
- 認証: `Authorization: Bearer <TYPESAFE_API_KEY>`
- リクエスト: `{ state, model, questions: Record<id, Question> }`
- レスポンス: `{ model, answers: Record<id, Answer>, usage: { input_tokens, output_tokens } }`
- Question 型:
  - `noul`: `{ type, instructions, criteria?{true,false} }` → `{ noul: 0..1 }`
  - `choice`: `{ type, instructions, criteria: Record<option, desc|null> }` → `{ choice, probabilities, confidence }`
  - `score`: `{ type, instructions, criteria: string[] (2+) }` → `{ score, legend, probabilities, confidence }`

本プラグイン v1 が使うのは **Score のみ**(ADR-006)。Noul/Choice は型として提供し
将来(ガードレール機能等)に備える。

## 2. モデル指定 (ADR-003)

- 既定 `jev-1.13.0`(バージョン固定)。`jev-latest` は設定で選択可能にするが
  既定から外す。理由: keepAt 等の閾値調整結果がモデル更新で無効化されるのを防ぐ。
- レスポンスの `model` を使用量記録に残し、どの版で判定したか追跡できるようにする。

## 3. TypeScript 型 (src/jev/types.ts)

```ts
export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface JevRequest {
  state: unknown;                       // string | object | array
  model: string;
  questions: Record<string, JevQuestion>;
}

export interface JevUsage { input_tokens: number; output_tokens: number }
export interface JevScoreAnswer {
  type: 'score'; score: number;
  probabilities: Record<string, number>;
  confidence: number;
  legend: Record<string, string>;
}
export interface JevNoulAnswer { type: 'noul'; noul: number }
export interface JevChoiceAnswer {
  type: 'choice'; choice: string;
  probabilities: Record<string, number>; confidence: number;
}
export type JevAnswer = JevScoreAnswer | JevNoulAnswer | JevChoiceAnswer;
export interface JevResponse {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: JevUsage;
}
```

## 4. JevClient 仕様

| 項目 | 既定値 | 根拠 |
|------|--------|------|
| baseUrl | `https://api.typesafe.ai` | docs |
| model | `jev-1.13.0` | ADR-003 |
| timeoutMs | 4,000(対話 UI) | metalmind `JUDGE_TIMEOUT_MS` 準拠 |
| maxRetries | 3(ライブラリ既定 6 より控えめ) | UI 体感優先 |
| backoffBaseMs | 500 | 指数 0.5s→1s→2s + ジッタ |
| backoffMaxMs | 30,000 | docs の SDK 準拠 |
| fetch 実装 | 注入可能(`fetchImpl`) | テスト |

### リトライ対象

| 条件 | 再試行 | 待ち |
|------|--------|------|
| HTTP 429 / 529 | する | `Retry-After` ヘッダ優先、無ければ指数バックオフ+ジッタ |
| ネットワークエラー(TypeError) / タイムアウト(AbortError) | する | 指数バックオフ |
| 401 / 422 / その他 4xx | **しない** | そのままthrow(設定誤りを即時可視化) |

### 使用量計測

- `onUsage` コールバックへ `{ model, inputTokens, outputTokens, at }` を通知。
- レスポンスに `usage` が無い場合は `estimateTokens()` による推定値をフォールバック使用。

## 5. キャッシュ (src/jev/cache.ts)

- 構造: `TTLCache<V>(maxEntries, ttlMs, now?)` — Map ベース TTL + LRU。
- キー: `sha256(model + "\u0000" + questionTemplateVersion + "\u0000" + query + "\u0000" + 各候補の path+text)`
- 既定: TTL 30 分 / 最大 500 エントリ。同一クエリ連打や比較モードでの二重課金を防ぐ。
- 設定変更(除外ルール・モデル・閾値)時は `clear()`。

## 6. コスト推定 (src/util/cost.ts)

- 公式価格: 入力 $0.042 / MTok、出力無料(2026-09 時点、公式 docs/models)。
- `estimateTokens(text)`: CJK 1 文字 ≈ 1 token、その他 ≈ 0.28 token/char の
  上寄り推定。**推定であることを UI に明記**(「≈」表記)。
- 表示例: `30 candidates · ≈12.4k tok · ≈$0.00052`

## 7. 失敗モードとクライアント挙動

| 状況 | 挙動 | UI 表示 |
|------|------|---------|
| 401 | 例外(リトライなし) | 「API キーを確認してください」 |
| 422 | 例外(リトライなし) | 設計バグとしてログのみ |
| 429/529 リトライ枯渇 | 例外 | 「レート制限中。ローカル順の結果を表示」 |
| タイムアウト | 例外(リトライ 1 回まで→諦め) | 「Jev 判定タイムアウト。通常検索を表示」 |
| オフライン | 例外 | 「オフライン。ローカル検索のみで動作」 |
| 全候補が keepAt 未満 | 正常応答 | 「該当する判定なし。元の上位を表示」(metalmind 準拠) |

**原則(P3): クライアント例外はパイプラインで捕捉し、必ず BM25 結果を返す。**
検索という中核価値を AI の障害で失わせない。

## 8. シーケンス(再ランキング 1 回)

```
UI            Pipeline          Reranker        Cache        Client          TypeSafe
 │ search(q)    │                 │               │             │               │
 │─────────────▶│ BM25 → candidates (50)          │             │               │
 │              │ preview(送信内容) → ユーザー承認 │             │               │
 │              │ cache.get(key)? ─┤ hit → 即返す  │             │               │
 │              │──────────────────────────────────────────────▶│ state+30 Noul/Score
 │              │                 │               │             │──────────────▶│
 │              │                 │               │   200 answers + usage       │
 │              │◀── results ─────│◀──────────────┼─────────────│◀──────────────│
 │◀─ results ───│ cache.set(key)  │               │             │               │
```

## 9. テスト観点(詳細は 05)

- モック fetch: 200 / 429→200 / 529 枯渇 / 422 不リトライ / タイムアウト / ネットワーク断
- 回答マッピング: `q00..q29` ↔ 候補インデックス(混線防止の単体テスト)
- キャッシュ: TTL 失効・LRU 退避・キー安定性(同入力→同キー)
