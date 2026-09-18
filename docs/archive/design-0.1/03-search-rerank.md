# 03. 検索・再ランキング設計

対象: `src/search/*`, `src/rerank/reranker.ts`

## 1. 全体パイプライン

```
vault notes ─▶ chunkMarkdown ─▶ BM25Index ─▶ topK fetch
                                              │
                     (除外フィルタ・プレビューゲート)
                                              ▼
                                     JevReranker.rerank(query, topN)
                                              │
                            state = { query, hits: [{path,title,heading,text}] }
                            questions = { h00..h29: Score(3 段階) }
                                              ▼
                            score ≥ keepAt で絞込・ソート → 結果
```

## 2. チャンキング (src/search/chunk.ts)

- ノートを Markdown 見出し(`#`〜`###`)で分割。
- 1 チャンク最大 1,200 文字。超過時は段落境界でスライド分割。
- Front Matter(YAML)は本文から除去し、タイトル補完にのみ使用。
- チャンク ID: `<path>#<headingIndex>`。

## 3. トークナイザ (src/search/tokenizer.ts, ADR-005)

**問題**: BM25 の空白分割は日本語で機能しない。外部形態素解析は
ゼロ実行時依存方針(P8)と矛盾するため導入しない。

**解**: 文字種で分けた混合トークナイザ。

```
1) ASCII 区間  : /[a-z0-9_]+/i で分割 → 小文字化(語単位)
2) CJK 区間    : 連続する 2 文字 bigram + 元の連続区間全体(見出し一致用)
3) 記号・空白  : 区切りとして破棄
```

- 例: 「Zettelkastenと Obsidian の違い」→
  `zettelkasten, zett, ette, ttel, ..., obsidian, obsi, bsi, ...` に加え
  見出し用の原文字列を保持。
- テストフィクスチャ: 「プロジェクト管理」「知的生産」「RAG 再ランキング」等の
  語尾変化・複合語で recall を確認する(05 参照)。

## 4. BM25 (src/search/bm25.ts)

- パラメータ: `k1=1.2, b=0.75`(古典設定)
- ブースト: タイトル一致 ×3.0、見出し一致 ×1.5
- `search(query, k)`: 上位 k 件を `{ path, title, heading, text, score }` で返す
- インデックスはメモリ内 Map。永続化せず起動時/変更時に再構築(v1)。

## 5. JevReranker (src/rerank/reranker.ts)

### 質問テンプレート(metalmind の実証済み形を採用、ADR-006)

```
criteria:
  0: "off-topic: この抜粋は質問が問うている内容に関係しない"
  1: "related: 質問と同じ主題だが、問いには答えていない"
  2: "answers: 質問に直接答える、または求められた事実・決定・数値を含む"

instructions: "抜粋 {i}(state.hits[{i}])は state.query にどの程度答えているか?"
state: { query, hits: [{ path, title, heading, text }] }
questions: h00..h29 (各候補 1 Score 質問、同一コールで並列評価)
```

- 抜粋には **タイトルを必ず添える**(metalmind の知見: frontmatter だけの
  先頭チャンクは空と同義に見え off-topic 誤判定になるため)。
- text は 2,000 文字でクリップ(先頭)。
- 1 コール上限: **30 質問 / 状態 60,000 文字**(超過時は複数コールに分割、
  `jev-rerank` の 30/100k 方針を保守側に倒した値)。分割時は 2 並列まで。

### 判定・後処理

| 閾値 | 既定 | 意味 |
|------|------|------|
| `keepAt` | 1.0 | score ≥ 1.0(related 以上)のみ残す |
| `answersAt` | 1.5 | score ≥ 1.5 は「answers」バッジ表示 |
| 空結果時 | — | BM25 上位をそのまま返し、バッジに「Jev 判定なし」 |

- score はチャンク単位 → ノート単位へは「ノート内最大 score」で代表。
- ソート: score 降順、同点は BM25 順。

## 6. 比較モード(v1 の差別化機能)

結果ビュー上部に切替表示:

- `ローカル順`: BM25 のまま
- `Jev 判定順`: 再ランキング後。各項目に score バッジ。
- 「差分」表示: 順位が大きく変わったノートをハイライト。

これによりユーザーが自分の Vault で効果をその場で検証できる(P7)。

## 7. テスト観点

- トークナイザ: 日英混在・記号・長文・絵文字
- BM25: 既知の文書集合で順位の妥当性(フィクスチャ期待値)
- reranker: モック回答でのマッピング/閾値/フォールバック/バッチ分割
