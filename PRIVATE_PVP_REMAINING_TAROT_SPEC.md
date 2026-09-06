# Private PvP 拡張 — 残りTarotの実装仕様

最終更新: 2026-09-06
状態: **実装済み・検証中。κ〜χ は `private-expanded-v1` のデッキ編集で選択可能。**

この文書は `private-expanded-v1` 専用の実装仕様である。通常の
Private PvP、ランダムマッチ、ソロ、Ranked、`game-rules.js` のクラシック
ルールは対象外であり、変更しない。

現在は α〜χ（Death から The World）の全22枚が、Private拡張だけで
利用可能である。本書は κ〜χ の残り13枚について、実装・回帰検証の正本となる
仕様を定める。本文の選択肢は、提案文に矛盾しない範囲で、無限ループ、情報漏洩、
手詰まり、通信再送による二重適用を防ぐために採用したもの。

関連する土台は次を正本とする。

- `PRIVATE_PVP_EXPANSION_DESIGN.md`: Private拡張全体の境界・上限・設定凍結
- `PRIVATE_PVP_CARD_CATALOG_DESIGN.md`: カタログの運用・導入手順
- `private-card-definitions.js`: 永続的な `definitionId` と表示順
- `private-ruleset.js`: すべての絶対上限

## 1. 適用範囲と導入条件

### 1.1 対局ごとの固定事項

- この仕様は、開始時に凍結された `rulesSnapshot` と共通デッキだけに適用する。
- カード定義・能力・対象候補・乱数・得点・終了判定はサーバーが決定する。
  クライアントはカード実体IDまたは、サーバー発行の一回限りの対象操作IDを
  選ぶだけである。
- 待機中・結果画面で設定を変更した場合、`rulesRevision` を増加させ、両者の
  開始同意を解除する。進行中対局の `rulesSnapshot` は決して書き換えない。
- 新しい能力は個別に `specified` → `engine-ready` → `experimental` →
  `available` と進める。一枚でも必要な受信者別view・状態検証・テストが未完成
  なら、デッキ編集画面で増やせない。

### 1.2 共通語彙

| 用語 | 意味 |
| --- | --- |
| 物理札 | サーバー発行の `instanceId` を持ち、手札・獲得札・スタック・破棄札に存在できる札。 |
| 仮想Blank | 手札外の再利用可能な選択肢。物理札ではなく、生成・コピー・ロック・獲得・破棄の対象外。 |
| 定義コピー | 元札と同じ `definitionId` を持つ**新しい**物理札。ロック・ノイズ等の一時状態は引き継がない。 |
| 獲得札 | 勝利により得た物理札の実体。得点は `wonPile.length` から導く。 |
| 破棄札 | 効果で手札または獲得札から除かれた物理札。再びゲーム状態へ戻さない。 |
| ノイズ | 所有者だけが実体を見られる一時状態。相手・観戦者には定義ID、強さ、能力を送らない。 |
| 対象操作 | 効果の対象を選ぶサーバー発行の一回限りの操作。通常のカード選択とは別物。 |

すべてのカード実体には、少なくとも次を保存する。古い対局を読めるよう、
表示名でなくIDを永続化する。

```js
{
  instanceId: 'server-issued',
  definitionId: 'the-star',
  state: {
    locks: [],             // 0件以上の独立した一時ロック
    visibility: 'public' | 'noise-owner-only',
    revealOn: 'play' | null
  },
  origin: { kind: 'initial' | 'generated', sourceEffectId: '...' }
}
```

`state` や `origin` はクライアントから受け取らない。古い実装の
`state.locked: boolean` は、移行時に `locks.length > 0` で導出できる互換表示
として扱い、最終的な正本にはしない。

## 2. 共通の効果解決モデル

カード別の例外を増やさないため、全カードは下記の決まったフェーズだけに
効果を登録する。フェーズ、seat順（p1 → p2）、同一カード内のeffect順で
安定ソートする。クライアントの到着順で結果を変えない。

```text
0. round-start snapshot       得点、スタック、直前の解決済みプロフィールを固定
1. pre-commit target          The Sunの破壊対象を先に選ぶ
2. simultaneous commit        両者の物理札 / Blank を確定
3. reveal and comparison      強さ確定、The Emperor、Chariot等の勝敗判定
4. canonical award / stack    現行ルールどおり獲得札または持ち越しへ移す
5. automatic post-result      Moon、ロック、既存の生成・ラウンド延長など
6. queued target actions      High Priestess等を一件ずつ解決
7. final bookkeeping          履歴、公開イベント、終了判定、次ラウンド開始
```

- 第4段階までに既存の比較・得点規則を適用する。Tarotは `game-rules.js` を
  複製せず、Private拡張エンジンから既存の正規比較を呼ぶ。
- 第5〜6段階のすべてを終えてから、即時勝利閾値、手札尽き、総ラウンド上限を
  再判定する。既に実装済みの Magician / Lovers / Wheel of Fortune の
  「比較後に一回だけ」の性質を維持する。
- 1ラウンドの効果処理数、履歴、手札、総物理札、ラウンド数は
  `private-ruleset.js` の絶対上限を超えない。上限で追加できない札は、既存の
  追加仕様と同じく可能な枚数だけ追加し、結果へ `capped` を記録する。札を
  勝手に捨てて枠を作ってはならない。
- 効果で候補がなくなった場合は `skipped-no-legal-target` と記録して不発にする。
  対象がなくても、ラウンドを巻き戻したり待機状態に残したりしない。

### 2.1 対象操作の安全な契約

対象を選ばせる効果は、サーバー内部の `pendingAction` を必ず通す。

```js
{
  id: '128-bit-random-action-id',
  nonce: 'single-use-random-nonce',
  gameRevision: 42,
  phase: 'pre-commit' | 'post-result',
  sourceSeat: 'p1',
  actorSeat: 'p1',
  effectId: 'the-justice.lock-one.v1',
  allowedTargets: [/* server-derived opaque target keys */],
  expiresAt: 'server timestamp',
  resolvedResult: null
}
```

1. サーバーだけが候補を作る。ブラウザが `definitionId`、任意の`instanceId`、
   seat、効果種別を指定して対象を増やすことはできない。
2. 1対局につき未解決の `pendingAction` は最大1件とする。複数の能力が出たら、
   第6段階の安定順で次の一件を発行する。
3. 対象者は20秒以内に操作する。再送は同じ `id` と `nonce` に対する
   idempotentな結果返却だけとし、最初に確定した結果以外は状態を変えない。
4. 時間切れ・切断では、候補があればサーバーが `crypto.randomInt` 相当の
   暗号学的乱数で一つを選ぶ。候補がなければ不発にする。通常の対戦ターンを
   無期限に止めない。
5. 再接続者には、当人に許可された未解決操作だけを復元する。通常の第6段階の
   操作では、相手・観戦者には「能力の対象を選択中」とだけ送り、候補やノイズの
   正体を送らない。The Sunの第1段階は、相手がまだ自分の札を確定していないため、
   **行為者以外には操作中である事実も短い操作期限も送らず**、元のターン期限と
   通常のカード確定操作を維持する。
6. 観戦者、退出済みseat、古い `gameRevision`、期限切れnonce、二重送信、
   不許可対象は、すべて状態変更なしで拒否する。

The Sunだけは第1段階で対象を選ぶ。ほかの対象型カードはカードが公開・
勝敗確定してから第6段階で選ぶ。Sunの相手は対象選択中にも自分の札を通常どおり
確定できる。この分離により、能力の対象選択で相手の未公開カードを推測できない。

### 2.2 公開範囲とノイズ

`The Star` を有効にする対局では、共通のroomオブジェクトをそのまま全員へ
送ってはならない。`private-room-view` のような受信者別viewを必須にする。

- 所有者には本来の定義、能力、ロック状態を送る。
- 相手・観戦者にはノイズ札を `{ instanceId, category: 'noise', displayName:
  'Noise' }` として送る。`definitionId`、強さ、能力文、内部状態、生成元は
  含めない。
- ノイズ札が実際に確定された瞬間にだけ、そのラウンドの相手・観戦者へ定義と
  効果を公開する。過去履歴もこの時点から公開表記へ置き換える。
- High Priestess、Justiceなどが相手手札を対象にする際、ノイズ札の正体を
  推測・複製できないよう、ノイズ札は他人の「定義を見る必要がある対象」から
  除外する。単にロックするJusticeだけは、匿名のノイズ札を指定できる。

この仕様はCSS非表示では満たせない。Socket payload、再接続payload、履歴、
観戦表示それぞれに、ノイズの`definitionId`が含まれないことをテストする。

## 3. Blankと選択不能状態

Blankは、手札外・非消費・非得点・非コピーの仮想札であるという既存仕様を
維持する。必要性はUIのチェック状態でなく、正規化済みデッキからサーバーが
導く。

### 3.1 機械可読な宣言

各カード定義は、将来の効果に合わせて次のいずれかを宣言する。

```js
playabilityRisk: 'none'
  | 'temporary-all-hand-lock'
  | 'persistent-all-hand-lock'
  | 'hand-exhaustion-ends-game'
```

- `temporary-all-hand-lock` と `persistent-all-hand-lock` を含むデッキは
  `blankRequired: true` である。現在の仕様では The Empress と Justice が
  前者に当たる。
- `hand-exhaustion-ends-game` は、手札を0枚にした時点で既存の
  `hand-exhausted` 終了判定が働くカードである。The Sunはこれに当たり、
  Blankを必須にはしない。
- 移行中は既存の `mayPreventAllLegalPlays` を上記の互換入力として読めるが、
  新規カードの判定は `playabilityRisk` を正本にする。

### 3.2 UIとサーバーの挙動

1. デッキにBlank必須カードを追加すると、サーバーは `blankEnabled: true` を
   正規化済み設定へ自動で入れ、`blankAutoEnabledReason` に理由となるカードを
   返す。既存の開始同意は解除する。
2. 必須の間、UIの「Blankを使う」はチェック済み・無効で、
   `Justice / The Empress が全手札を一時ロックし得るため必須です` と表示する。
3. APIや古い画面から `blankEnabled: false` を送っても、Blank必須デッキとして
   確定することはない。サーバーは真に正規化するか、明確な設定エラーとして
   拒否する。falseのまま保存する経路を作らない。
4. 必須カードを全て外した後は、Blankを有効のまま残すことはできるが、
   チェックを外せる。自動でoffにはしない。
5. タイムアウト時は、合法な物理札と有効なBlankを一つの候補集合として扱う。
   ロック中の物理札、破棄札、仮想Blank以外の偽IDは候補に含めない。

## 4. デッキ互換性の一般設計

「一緒に使えないカード」は個別のif文で散らさず、カード定義とルール機能の
両方で宣言する。ここでいう機能タグはサーバー実装の版であり、プレイヤーが
任意に有効化できる設定ではない。

```js
{
  id: 'the-star',
  requiresCapabilities: ['target-actions-v1', 'card-generation-v1', 'recipient-view-v1'],
  providesTags: ['creates-noise'],
  excludesTags: [],
  playabilityRisk: 'none',
  effectProfileId: 'star-add-owner-only-v1',
  status: 'specified'
}
```

デッキの正規化時は次の順で検証する。

1. 既知のカード、利用可能なruleset、status、枚数、初期札数を検証する。
2. 選択カードが必要とするサーバー能力が、そのruleset版に実装済みか検証する。
3. ルール設定が提供するタグと、全選択カードの `providesTags` を集計する。
4. 各 `excludesTags` と、相手側から提供されたタグを**双方向**に検査する。
5. `uniqueGroup`、生成上限、Blank必須条件を導出し、正規化済みデッキだけを
   保存する。

現時点でこの13枚同士に、ゲームを成立させられない本質的な相互排他はない。
そのため、バランス上の好みで不必要な禁止は置かない。ただし以下のような将来の
実際の競合はこの仕組みで表す。

| 競合例 | 定義方法 | UIの振る舞い |
| --- | --- | --- |
| 受信者別view未対応の旧ruleset と The Star | Starが `recipient-view-v1` を要求 | Starを増やせず、理由と必要機能を表示する。 |
| 将来の「常時全手札公開」設定とノイズカード | 設定側が`all-hands-public`を提供、Starがそれを除外 | 後から選ぶ側を無効化し、既に選ばれた側もサーバーが拒否する。 |
| 将来の同系統の大型効果を一枚だけにする場合 | 同じ `uniqueGroup` と最大1を宣言 | 片方を入れると同群の追加操作を無効化する。 |
| 全札ロック効果とBlank off | `playabilityRisk` でBlankを派生 | Blankを自動でonにしてoff操作を無効化する。 |

UIは候補を灰色にするだけで終わらせない。サーバーが返した
`conflictCode`、関係するカード名、解決方法を各カード行と設定の要約に表示する。
直接Socketを呼んでも同じ検証を通るため、無効な組合せは開始できない。

## 5. 残りTarotの確定仕様

以下の「コピー」は常に新しい物理札を作る。生成札はその場で能力を発動せず、
後のラウンドで選ばれた時だけ通常どおり発動する。

### κ The Fool (`the-fool`) / ο The Hermit (`the-hermit`) — 解決済みプロフィールの反響

| 項目 | The Fool | The Hermit |
| --- | --- | --- |
| 参照先 | 自分の直前ラウンドの物理札 | 相手の直前ラウンドの物理札 |
| 基本強さ | 参照プロフィールがなければ0 | 同左 |
| コピーするもの | 解決済み強さと、勝敗判定に関わる安全な能力 | 同左 |
| コピーしないもの | 対象選択、ロック、破棄、ノイズ、獲得札移送、再帰的な反響 | 同左 |

ラウンド履歴には、各物理札についてサーバー作成の `echoProfile` を保存する。
`echoProfile` は `resolvedStrengthUnits`、比較上書きの種類、静的な比較後効果の
識別子からなり、元の一時状態やクライアント表示を含まない。

- 初回ラウンド、Blank、The Fool、The Hermitを参照した場合は、強さ0・能力なし。
  反響が反響を無限に参照することはない。
- `comparison` または `comparison-and-safe-post-effect` を明示したカードだけが
  反響可能である。既存の条件強さ、Strength、Chariot、Magician、Lovers、Wheel
  は個別に安全なプロフィールを持てる。対象選択・秘匿・ロック・獲得札操作を
  持つカードはv1では `not-echoable` とする。
- Chariotを反響した場合、前回の数値0をコピーしつつ、今回の相手の確定強さに
  対するChariot判定を行う。条件強さ系は「前回に解決した数値」をコピーして、
  現局面で再計算しない。
- 既存のカード説明は実装時に「直前ラウンドの**解決済み強さと勝敗判定能力**を
  コピー」へ改める。この限定を明示しない「全能力コピー」は導入しない。

必要能力: `round-snapshot-v1`, `echo-profile-v1`, `comparison-override-v1`。

### λ The High Priestess (`the-high-priestess`) — 敗北時の相手札コピー

- 発動は第6段階。High Priestessを出した側が敗北した時だけ、その側が対象者に
  なる。
- 対象は、公開されている相手の現在の物理手札一枚。相手がこのラウンドに出した
  札、Blank、破棄札、ノイズ札は候補外である。
- 対象の定義コピーをHigh Priestessの使用者の手札へ一枚加える。コピーは公開・
  非ロックである。
- 対象なし、手札上限、総札上限では可能な分だけ処理または不発にする。操作期限
  切れはサーバーが候補から一枚を選ぶ。

必要能力: `target-actions-v1`, `card-generation-v1`。

### μ The Empress (`the-empress`) / π Justice (`justice`) — 一ターンのロック

ロックは曖昧な「ほかのカードが出たら解除」ではなく、次の一ターン制とする。

- ロックは効果が適用された時点で相手手札にあった物理札へ付く。以後に生成された
  札はロックされない。
- ロックされたプレイヤーの**次の解決済みラウンドの終了時**に、そのプレイヤー
  に掛かっていた当該ロックを解除する。そのラウンドではロック札を選べない。
  合法な物理札がなければ必須Blankで一ラウンド進め、その終了時に解除する。
- 同じ札へ複数のロックが付いた場合、いずれか一つでも残っている間は選べない。
  各ロックは独立に上記のタイミングで外す。
- 切断・タイムアウトでもそのプレイヤーの次ラウンドは進行したものとして扱う。
  ロックが永久に残る状態は作らない。

The Empressは勝利時に、相手の**現在の非Tarot物理手札すべて**をロックする。
The Justiceは勝利時に、使用者が選んだ相手物理手札一枚をロックする。Justiceは
ノイズ札を匿名のまま選べるが、正体を表示しない。Empressは対象選択を行わない。

両カードは `playabilityRisk: 'temporary-all-hand-lock'` であり、デッキへ含める
限りBlankは必須である。必要能力は `lock-state-v1`、Justiceのみ
`target-actions-v1`。

### ν The Emperor (`the-emperor`) — Tarotへの勝敗上書きと無効化

- 公開直後、通常の強さ比較より先に判定する。
- 片方だけがThe Emperorで、もう片方がTarotなら、The Emperor側をこのラウンドの
  勝者に固定する。相手Tarotのこのラウンド由来の比較・勝敗後効果は実行しない。
- 両者がThe Emperorなら、両者のこのラウンド由来のTarot効果を無効化し、強さ0対0
  の引き分けとする。
- 相手がTarotでない場合、The Emperorは強さ0・能力なしとして通常比較に参加する。
- The Sunの破壊のように公開前の第1段階で既に完了した処理は巻き戻さない。The
  Emperorが無効化するのは、第3段階以後に解決する「このラウンド由来」のTarot効果
  だけである。
- すでに過去ラウンドで作られたロック、ノイズ、獲得札、生成札は無効化しない。
  The Emperorは現在ラウンドの効果だけを扱い、状態を巻き戻さない。

この優先順位はChariotより先である。必要能力: `tarot-negation-v1`。

### ξ The Hierophant (`the-hierophant`) — 敗北時の自分札コピー

- 発動は第6段階。敗北時のみ、使用者が自分の現在の物理手札一枚を選ぶ。
- ロック・ノイズの有無は問わない。所有者が知っている自分の札であり、コピーは
  公開・非ロックで生成する。
- High Priestessと同じ上限・期限・再送規則を用いる。現在手札がなければ不発。

必要能力: `target-actions-v1`, `card-generation-v1`。

### ρ The Hanged Man (`the-hanged-man`) / σ The Star (`the-star`) — 相手が選ぶ生成札

両カードは敗北時に発動する。使用者の相手が、相手自身の手札へ追加したい
**カード定義**を選ぶ。候補は、開始時に凍結した共通デッキに含まれる、Blank以外の
物理札定義の重複なし集合である。これにより、カードカタログ全体から未承認の札を
作ったり、廃止済み札を復活させたりしない。

- The Hanged Manは通常の公開札を一枚追加する。
- The Starは同じ定義の札を一枚追加するが、所有者以外にはノイズとして見せる。
  所有者は正体を知って通常どおり選べる。実際にプレイされた時だけ公開する。
- 相手が操作しなければ、サーバーが凍結済み候補から一つ選ぶ。候補がなければ不発。
- 生成上限に達しても、既存手札・得点を削らず不発として記録する。

必要能力は、Hanged Manが `target-actions-v1`, `card-generation-v1`、The Starが
それらに加えて `recipient-view-v1`, `noise-state-v1` である。

### τ The Moon (`the-moon`) — 敗北・引き分け時の獲得札全破棄

このカードのため、拡張エンジンは現在の数値scoreだけでなく、各seatの
`wonPile`（物理札の順序付き配列）を正本にする。`score` は常にその長さから導き、
食い違う保存状態は拒否する。

- The Moonの使用者が敗北または引き分けなら、第5段階で使用者の**そのラウンド
  開始時から保有していた獲得札すべて**を破棄札へ移す。
- 現ラウンドの勝者が得た札や持ち越し札は、Moon使用者の獲得札には含まれないため
  失われない。引き分けでは両出札はスタックに置かれ、Moon使用者の過去の獲得札
  だけが失われる。
- 両者がMoonで引き分けた場合は、p1、p2の順に各自の獲得札を破棄する。互いの
  破棄対象は独立している。

必要能力: `won-pile-ledger-v1`, `acquired-card-discard-v1`。

### υ The Sun (`the-sun`) — 確定前の自分札破壊

- The Sunを確定したい使用者は、第1段階で自分の別の物理手札一枚を選ぶ。
  The Sun自身、Blank、既に破棄済みの札は選べない。ロック中の札は破壊できる。
- 選択札を直ちに破棄してから、The Sunを通常の一枚として同時確定する。
  相手にはThe Sunの確定まで対象の詳細を送らない。
- Sun以外の物理手札がなければ、Sunは選択・確定できるが破壊効果だけ不発にする。
- 破壊により手札が0枚になった場合、ラウンド終了後の既存`hand-exhausted`で
  対局を終了する。これは選択不能な待機状態ではないためBlank必須条件にはしない。

必要能力: `pre-commit-target-v1`, `destroy-card-v1`。

### φ Judgement (`judgement`) — 過去に出した札の再生成

- 第5段階で、Judgement使用者が**過去の完了ラウンドで出した物理札**を古い順に
  走査し、その全ての定義コピーを自分の手札へ追加する。
- Blankと、当該ラウンドに出したJudgement自身は含めない。過去に生成された札も
  物理札として出していれば含める。履歴上の同じ定義が複数回あれば、その回数分を
  コピーする。
- 手札・総札・一ラウンド効果上限に達した時点で停止し、何枚追加できたかと上限で
  止まったことを履歴に残す。生成札の能力はその場で連鎖発動しない。

必要能力: `played-card-ledger-v1`, `card-generation-v1`。

### χ The World (`the-world`) — 相手の過去の獲得札を奪う

- 第6段階で、The Worldの使用者が相手の**そのラウンド開始時に存在した**獲得札
  一枚を選ぶ。現ラウンドに新しく獲得された出札を対象にしない。
- 選んだ物理札を相手の`wonPile`から破棄札へ移し、同じ定義の新しい公開・非ロック
  コピーをThe World使用者の手札へ一枚加える。相手の得点は`wonPile`長から即時に
  減る。
- The Moon等により候補が既に失われた場合、その候補を再利用しない。実行時点の
  `wonPile`に残っている候補だけを表示し、残っていなければ不発にする。
- 両者がThe Worldを使った場合はp1、p2の順に解決する。二番目の操作には一番目の
  結果を反映した候補だけを渡す。

必要能力: `target-actions-v1`, `won-pile-ledger-v1`, `acquired-card-transfer-v1`,
`card-generation-v1`。

## 6. 必要な実装境界

この仕様を実装する際、`server.js` や `main.js` へカードごとの状態遷移を積み上げない。
以下の責務に分ける。

| モジュール | 担当 |
| --- | --- |
| `private-card-definitions.js` | 定義、能力版、必要capability、タグ、表示。能力コード自体は持たない。 |
| `private-card-effects.js` | 比較前の純粋な強さ・反響プロフィール・勝敗上書きを決める。 |
| `private-card-post-effects.js` | 対象選択を伴わない比較後の生成・ラウンド延長要求を純粋に作る。 |
| `private-action-queue.js` | 対象候補、nonce、期限、idempotency、再接続、期限時の乱数選択。 |
| `private-game-engine.js` | 物理札、wonPile、stack、discard、lock、効果キューを含む純粋な状態遷移と不変条件。 |
| `private-room-view.js`（新規） | 所有者・相手・観戦者別のpayloadを作る。ノイズの正体をここで確実に除く。 |
| `private-deck.js` / `private-room-config.js` | capability・タグ・Blank必須の正規化。UIではなくサーバーが最終判定する。 |
| `server.js` | 認可済みSocket要求を上記へ渡し、対象操作の短期タイマー・再接続復帰・受信者別配信を調停する。能力の判定値は持たない。 |
| `main.js` / `style.css` | 読み取り専用の表示、対象選択、ロック・ノイズ・不発・上限の説明。能力判定を持たない。 |

現在のカード定義には `effectProfileId` を付け、`private-expanded-v1` の意味を
固定する。公開済みの効果文を後から意味変更する場合は、同じ `definitionId` の
動作を上書きせず、新しいruleset版と対応する効果プロファイルを追加する。進行中・
過去対局の履歴再現を守るためである。

## 7. UI/UXの受入条件

- 現在利用可能な α〜χ はデッキ編集で枚数を増減できる。将来の未実装カードを
  「予定」として表示する場合は、枚数増減を許可しない。競合・Blank必須・必要機能は
  カード行に日本語で表示する。
- 対局中、カードを選んだ本人だけに、そのカードの能力と対象選択の説明を表示する。
  相手の未公開選択やノイズの正体は表示しない。
- 対象操作は画面中央を塞ぐ常設パネルではなく、手札の近くに明確な一時パネルで
  表示する。操作対象、残り秒数、取り消せないことを示す。キーボード操作と44px以上
  のタップ領域を提供する。
- ロック札は色だけに頼らず、鍵アイコン・`次のあなたのラウンド終了後に解除`という
  文言・`aria-disabled` を付ける。
- ノイズ札は名称だけで情報を隠し、相手・観戦者には能力欄を出さない。所有者には
  本来のカード表示と「相手にはノイズとして見えています」を示す。
- Moon / World後は得点の減少理由を結果履歴に残す。最終結果演出は、効果解決が
  完了してから一度だけ表示する。

## 8. 実装前後の必須テスト

### 共通

- クラシックPrivate、ランダムマッチ、ソロ、Rankedから拡張設定・カードID・
  対象操作を送っても拒否される。
- 同一Socket再送、二重クリック、再接続、古いrevision、観戦者操作、期限切れ操作で
  効果・札・得点が二重に変化しない。
- カード数64、手札24、ラウンド20、効果24、履歴64の全境界で停止・記録する。
- Blank必須のデッキは、UIを改ざんしてもoffの状態で開始できない。Blank非必須へ戻すと
  利用者がoffに戻せる。

### カード群

- Fool / Hermit: 初回、Blank、反響カード、Chariot、条件強さ、非反響効果の各組合せ。
- High Priestess / Hierophant / Justice / Sun / World: 候補なし、ノイズ、ロック、
  操作期限、二重送信、上限到達。
- Empress / Justice: 全札ロック、重複ロック、Blankタイムアウト、次ラウンド後の解除。
- Emperor: Tarot対Tarot、非Tarot、両Emperor、Chariot、既存の持続状態を巻き戻さないこと。
- Star: 相手・観戦者・再接続payload・履歴に正体が露出しないこと、実プレイ時だけ公開すること。
- Moon / World: wonPileとscoreの一致、draw、同時使用、Moon後のWorld候補更新、終了判定。
- Judgement: 重複履歴、生成札履歴、Blank除外、途中上限、能力が生成時に発動しないこと。

### 段階導入順

1. `wonPile` / discard / score導出と、recipient-specific viewを純粋エンジン・viewテストで導入する。
2. `pendingAction` の一回性、期限、再接続を実装し、Sun、High Priestess、Hierophant、Justiceを一枚ずつ実験導入する。
3. ロックとBlank必須の正規化を導入し、Empressを追加する。
4. Hanged Man、Star、Moon、World、Judgementをそれぞれ独立したテスト群と共に追加する。
5. Emperor、Fool、Hermitは比較器・履歴スナップショットを拡張した後、既存の比較Tarot回帰を全て通して追加する。

全22枚は現在もPrivateの実験拡張プリセットだけで有効である。通常Private、
ランダムマッチ、ソロ、Rankedへは移さない。以後の変更でも、再接続・観戦・モバイル
表示を含む回帰テストと実地確認を完了してから公開する。
