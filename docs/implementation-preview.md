# 開発プレビュー 0.1.0 — 実装と確認範囲

## 実装したもの

- src/core/search.ts: 日本語bigram/ASCII単語、fielded BM25、見出し分割、増分索引、除外判定。
- src/core/jev.ts: **3つの固定送信先**（OpenRouter `/api/alpha/decisions`、TypeSafe `/v1/systemone`、Vercel AI Gateway `/v4/ai/evaluation-model`）、
  最大24KiB/20候補、Score応答検証（OpenRouter/Direct: probabilitiesとconfidence必須・版照合。Gateway: probabilities任意・rounding考慮）、
  warnings拒否、取消、4秒期限、限定リトライ。OpenRouterは `usage.cost` があれば実コストとして扱う。
  Gateway は `only:['typesafe-ai']` と `zeroDataRetention:true` を要求し、モデルはヘッダで指定する。
  **ADR-012により OpenRouter が第一経路（既定）**。`provider: {only:['typesafe'],allow_fallbacks:false,zdr:true,data_collection:'deny'}` で経路を固定する。
- src/main.ts: 検索ビュー、設定（**接続先選択**）、キー解決（**SecretStorage の名前を保持し値は `data.json` に入れない**。
  セッション上書きが優先）、全文JSONプレビュー、明示送信、結果並べ替え、フォールバック。
- scripts/build.mjs: main.js/manifest/stylesとSHA256SUMS生成。
- 単体29件と生成バンドルのモック読込・検索検査。

## 開発・再現

プロジェクトルートで `npm ci --ignore-scripts`、`npm run check`、`node scripts/verify-bundle.mjs`。
Node 24.18.0で確認。checkは型検査→単体→build。単体は外部APIへ接続しない。
TypeScriptの実行にはNodeの型除去を使用。node_modulesとdistはGit対象外。
実行時依存はObsidianとNode標準HTTPSのみ。npm auditは既知問題0件だったが監査保証ではない。

## 自動テストの実行

| コマンド | 内容 | 外部通信 |
|---|---|---|
| `npm test` | 単体29件（検索・Jev検証・OpenRouter契約・再試行・取消） | なし |
| **`npm run test:live`** | **AT-07 実APIスモーク（合成データ1送信。`RUN_LIVE_TESTS=1`とenvキーが必須）** | **あり（明示時のみ）** |
| `npm run test:bundle` | 生成バンドルの読込・検索・初期OFF・終了処理 | なし |
| `npm run check` | 型検査→単体→ビルド | なし |
| **`npm run test:gui`** | **実機Obsidian GUI E2E（起動〜終了・証跡保存）** | **なし（不合格時は失敗扱い）** |

`npm run test:gui` はこの順で動きます。
1. 専用テストVaultと専用プロファイルを作成・再作成
2. `dist` を該当プラグインフォルダへ配置
3. Obsidianを専用プロファイルで起動
4. CDPで接続し、**Vaultの実パスが専用Vaultであることを確認**（不一致なら即中断）
5. リボン→検索ビュー→索引Ready→検索→ノート移動→ゼロ件を検証
6. 各段階のスクリーンショットと`report.json`/`summary.json`を保存
7. **今回起動したプロセスだけ**を終了

証跡: `.sandbox/gui-e2e/evidence/`

### 現在の実機E2E結果（PASS）

検証済み項目:
- プラグイン読込、リボン描画
- 検索ビュー描画、索引Ready
- **APIキーなし・外部送信OFFが既定**であること
- 「定例会」→`Meeting.md`がヒットし「毎週火曜日」を表示、`Cooking.md`は非表示
- 結果クリックで`Meeting`を開き該当見出しへ移動
- 該当なしクエリで0件
- **設定タブが実機で描画される**（接続先・保存するキー・セッションのみのキー・除外設定の各コントロール）
- **SecretStorage 往復**（名前で保存 → `getSecret` で解決、`listSecrets` に出現、値が設定にも `data.json` にも現れない）
- **レンダラ例外0件**
- **ローカル操作中に `typesafe` / `api.` / `ai-gateway` / `vercel` への通信要求0件**

設定タブは、Obsidian が設定モーダルを別ウィンドウで所有するため、登録済みタブの `containerEl` に対して
`display()` を実行して検証している。**タブ切替UIそのものは未検証。**

未検証:
- Jev実API送信（環境にAPIキー未設定）
- **Obsidian再起動をまたいだキーの復元**（保存と解決は実機で検証済み。再起動後の復元は未実施）
- 設定変更後の再索引、IME/ズーム/複数ウィンドウ、10kノート負荷

### 再現性とハーネスの頑健化

`npm run test:gui` を**2回連続でPASS**（8項目・レンダラ例外0件・外部通信0件）。
初回実装ではリボン待機が10秒でタイムアウトし1回フレークしたため、次を修正しました。
- 接続先をタイトル一致ではなく `app://obsidian.md/index.html` で厳密に選択
  （設定ポップアップや `about:blank` を掴む誤接続を排除）
- ウィンドウタイトルではなく `window.app.vault/workspace/plugins` の準備完了で判定
- リボン待機を30秒へ延長
- 新規プロファイルで未ロードの場合に限り、**専用Vault内で**プラグインを明示有効化

いずれも専用テストVaultでのみ動作し、Vault実パスが一致しなければ即中断します。

型チェック、単体29件、ビルドは成功。クリーンコピーへのnpm ciでも再現。
生成CommonJSをObsidianモックで読み込み、コマンド登録・初期外部通信OFF・接続先既定=OpenRouter・アンロードを確認。
Obsidian 1.13.4は専用manual-vaultで起動。画面での検索操作は未確認。
過去のCDP検査はapp未定義で失敗し削除。これを実機成功とは数えない。
実APIキーはProcess/User/Machineいずれも未設定。実API通信・課金テストは未実施。

## 試す場所

専用Vault: `C:\Users\systemuser\Desktop\Jev×Obsidian\.sandbox\manual-vault`
合成ノートMeeting.mdに「定例会は毎週火曜日です」を配置。
1. Obsidianのコマンドパレットで「Jev Search: Open search」。
2. 「定例会」で検索しMeeting.mdの抜粋が表示されることを確認。
3. 設定のJev Searchで **接続先（既定: OpenRouter）** を確認し、該当するAPIキーを入力（セッションのみ）。
4. 「Preview test」で架空データと送信先を確認して送信すると1問の接続テスト。
5. 本文を送る再ランキングはEnable Jevを有効にし、検索画面から毎回承認。
キーを共有チャット/スクリーンショット/Gitへ貼らない。

## 経路の変更（2026-09-18 / ADR-012）

- 開発・検証の第一経路を **OpenRouter**（`POST https://openrouter.ai/api/alpha/decisions`）へ変更し、
  TypeSafe直接を第2、Vercel AI Gatewayを第3とした。一般ユーザーへの提供は OpenRouter と TypeSafe直接 の2経路。
- 理由: 応答に解決済みモデル版が含まれ **ADR-008の版照合が成立する**（Gatewayでは不可能だった）、
  `usage.cost` で実コストを取得できる、`only:['typesafe']` + `allow_fallbacks:false` でプロバイダを固定でき、
  `zdr:true` + `data_collection:'deny'` を要求できる（TypeSafeはOpenRouterのZDR一覧に登録済み）、
  価格は $0.042/MTok で直接経路と同額。
- 契約は `DecisionsScoreQuestion` / `DecisionsScoreAnswer` で、既存の `prepare()` / `validate()` とほぼ一致する。
- 契約は `/api/alpha/decisions` であり**実験的**。失敗は canary テストで検出し、失敗時はローカル維持する。
- **実装済み**。`Target` に `openrouter` を追加し、`ENDPOINTS` / `requestFor` / `prepare` / `validate` / 単価表と
  `src/main.ts` の設定・同意表示・セッションキーを対応させた。既定の接続先は OpenRouter。
- 版照合は `typesafe/jev-1.13` と日付サフィックス付きスナップショット（`-YYYYMMDD`）を許可する。
- **実API送信は未実施**。AT-07 は `npm run test:live`（`RUN_LIVE_TESTS=1` + envキー）で実行する。
  キーはユーザーの端末で設定し、この文書・リポジトリ・チャットには書かない。
- 未確認: OpenRouter が `probabilities` / `confidence` / `legend` を実際に返すか、返る `model` の実文字列、
  実レイテンシ（製品期限は4秒）、`usage.cost` の有無。AT-07 の出力で確定させる。

## 設計との差分・出荷ブロッカー

- G0の全実機試験は未完了。G1/G2は部分実装、G3〜G5は未実施。
- requestUrlではなくnode:httpsを採用。リダイレクト非追従、destroyによる取消。
  クライアント中断でサーバー処理/課金が取消されるとは保証しない。実機ネットワーク試験が必要。
- 今回は単一バッチのみ。上位20チャンクから24KiBに収まる候補だけ再評価し残りは保持。
  ノートあたり2チャンク制限、複数バッチ順位統合、送信直前の内容ハッシュ照合は未実装。
- キャッシュ、月間予算/使用量永続化、信頼度詳細表示、完全な日英文言辞書は未実装。
- キーは SecretStorage（値は data.json 外・Vault単位）とセッション上書きの二段階（ADR-013）。
  保存先の実体・同期範囲・隔離は未確認のため、暗号化や非同期を宣伝しない。
  実機での保存と名前解決はGUI E2Eで検証済み。再起動をまたいだ復元は未検証。
- 設定UIの保存/再索引、IME、焦点移動、大規模Vault上限/負荷試験、設定マイグレーションは改善が必要。
- core/jev.tsは現時点でNode依存。Transport分離のリファクタリングは残る。
- ライセンス所有者の確定、CI、リリース申請、Mac/Linux/モバイル検証は未完了。

「産業レベル完成」「精度向上実証済み」とは表示しない。現時点では合成Vault用プレビュー。
先駆者は概念参照で、モデル本体/非公開学習の再現を行っていない。

## レビュー課題との対応

RV-01: 毎回確認を実装、使いやすさは未評価。
RV-02: BM25単体テストあり、Recall/日本語比較は未評価。
RV-03: 取消可能なNode transportへ変更、モック試験のみ。
RV-04: セッションキー継続、保存UIなし。
RV-05: 今回は単一バッチで比較問題を回避、候補数削減の影響は未評価。
元の [レビュー記録](reviews/2026-09-18-product-tradeoffs.md) を継続して使う。
