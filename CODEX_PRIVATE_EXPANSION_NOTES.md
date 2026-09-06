# Private PvP 拡張 — 作業メモ

このファイルは、対話の要約で失われやすい設計判断を保つための作業メモです。公開仕様そのものではなく、実装時は `game-rules.js` とテストを正本として扱います。秘密情報・認証情報・本番設定値は記録しません。

デッキ編集、互換性判定、設定凍結、通信境界の詳細は、実装設計の
[`PRIVATE_PVP_EXPANSION_DESIGN.md`](./PRIVATE_PVP_EXPANSION_DESIGN.md) を参照する。更新版の提案書で追加通常札・終了条件・Tarotの能力文は提示された。Blank、比較型Tarot 6枚、および対象選択を伴わない生成／総ラウンドTarot 3枚（α〜ι）は実装済みである。残りTarotの仕様は設計として確定したが、ロック、伏せ札、対象選択、獲得札実体の実装はまだ保留とする。
カードごとの導入順、必要機能、混在禁止、追加・廃止の運用は
[`PRIVATE_PVP_CARD_CATALOG_DESIGN.md`](./PRIVATE_PVP_CARD_CATALOG_DESIGN.md) を参照する。
残りTarot（κ〜χ）、対象操作、ノイズ、ロック、獲得札、Blank必須化についての
実装前確定仕様は
[`PRIVATE_PVP_REMAINING_TAROT_SPEC.md`](./PRIVATE_PVP_REMAINING_TAROT_SPEC.md) を参照する。

## 変更してはいけない基準

- `game-rules.js` は現行クラシックの唯一の正本。A / K / Q / J / Joker / 3 / 2 を各1枚、90秒、7ラウンドまたは9枚先取、現行の勝敗・タイムアウト処理を維持する。
- Private PvPの既定設定、ランダムマッチ、ソロ／ランク戦は上記クラシックのままにする。
- Ranked Solver・Rating・SeasonにはPrivate拡張設定やカードを混入させない。
- 既存PvP、観戦、チャット、再接続、ランダムマッチを推測で書き換えない。

## 採用済みの方針と進捗

1. Private PvPのみ、60 / 90 / 120秒を待機中・終了後に選択可能。開始後は設定スナップショットを凍結し、変更時は両者の開始同意を解除する。Random / Rankedでは拒否する。
2. Private拡張の基礎として、`private-ruleset.js`、`private-card-definitions.js`、`private-card-instances.js`、`private-deck.js`、`private-game-engine.js`を追加済み。
3. 現在のPrivate純粋エンジンはクラシックを`instanceId`単位で再現し、Ten〜Fourを含む凍結済み共通デッキ、総ラウンド終了時の得点比較、任意の即時勝利閾値を実装済み。Private待機画面のデッキ編集・設定revision・開始同意解除とSocket対局へ接続済みで、クラシック／Random／Rankedの勝敗処理は変更していない。
4. `instanceId`はサーバー発行を前提とし、同名カードのコピーでも一枚ずつ消費する。履歴・持ち越し札・得点に矛盾がある状態は拒否する。
5. カード能力は常設せず、自分が選択中の札だけを手札直下に表示する。選択解除・確定後・観戦中は消す。
6. 「この部屋のルール」は対局中央から外し、自分の手札・選択カード・操作ボタンの後ろへ置く。
7. Blankは拡張Private専用の手札外・再利用可能な仮想札として実装済み。Blankを使う設定では明示的に選択でき、時間切れ時は合法な手札とBlankからサーバーが暗号学的乱数で選ぶ。Blankは手札を消費せず、獲得札・持ち越し札・得点にはならない。
8. `mayPreventAllLegalPlays` を持つカードを将来デッキへ入れた場合だけ、Blankはサーバー側で必須にする。現在の公開済み通常札だけのデッキでは、Blankを使わない設定を選べる。
9. Death、Temperance、The Devil、The Tower、The Chariot、Strength、The Magician、The Lovers、Wheel of FortuneはPrivate拡張で使用可能。強さは各ラウンドの開始時点の得点・持ち越し札・ラウンド番号からサーバーが確定し、Jokerはその確定強さをコピーする。Strengthは内部で2倍単位の整数として計算し、The Chariotは相手の確定強さが15以上なら通常の数値比較より先に勝つ。比較後には強さを履歴へ保存する。The Magicianは相手の実カード定義を自分へ2枚、The Loversは勝利時に自分へKing・敗北時に相手へQueenを追加し、Wheel of Fortuneは勝利で総ラウンドを1増やし敗北で1減らす。いずれもサーバーが上限内で決定し、結果履歴には公開用の追加枚数／ラウンド変化だけを残す。
10. Privateの設定担当は、待機中・終了後に設定を変えず接続中の対戦相手へ編集権限を譲れる。譲渡先はクライアントから指定できず、サーバーが同じ部屋のもう一人の対戦者に限定する。引継ぎ先だけへ通知し、旧担当者の編集要求は直ちに拒否する。担当者の退出・観戦者への切替時も、残った担当候補へ同じ通知を行う。
11. Tarotの中央記号はPrivate拡張での導入順にαから割り当てる（Death=α、Temperance=β、The Devil=γ、The Tower=δ、The Chariot=ε、Strength=ζ、The Magician=η、The Lovers=θ、Wheel of Fortune=ι）。Private拡張を観戦する人には、使用中のTarotだけを選べる一覧と能力説明を表示する。カードの色は、Tarotを紫、Joker／Three／Twoなど能力を持つ通常札を控えめなエメラルド、能力なしの通常札を標準の青で表示する。
12. 拡張デッキ編集・デッキ要約の表示順は、基本7枚 → 使用可能Tarot（α〜ι）→ 追加通常札（Ten〜Four）。実装順で追加されたε・ζを先行させず、あまり使わない能力なしのFour〜Tenは後ろに置く。

## 拡張時の固定境界

- 設定変更はPrivateの待機中・終了後だけ。対局中、観戦者、Random、Rankedからの設定変更はサーバーで拒否する。
- 拡張カードの能力・強さ・対象指定・終了条件をクライアントから受け取らない。
- 将来の複製・生成カードには`definitionId`ではなく`instanceId`を使う。
- 秘匿カードを導入する場合、CSSで隠すだけでは不十分。相手・観戦者用のroom viewからカード名、強さ、能力そのものを除外する。
- 対象選択型能力はサーバーだけが持つ`pendingAction`、一回限りnonce、期限、許可対象カード一覧で検証する。古い再接続、観戦者、重複送信、改ざん対象は状態を変えず拒否する。

## 絶対上限

`private-ruleset.js`の値を正本とする。少なくとも、初期手札、手札最大数、総カード実体、総ラウンド、1ラウンドの効果処理、履歴、拡張対局の観戦者数を上限で拘束する。

## 実装しない項目と保留理由

1. κ〜χのロック、ノイズ、対象選択、コピー、生成、獲得札の意味と上限は
   `PRIVATE_PVP_REMAINING_TAROT_SPEC.md` で確定済み。ただし依存する純粋エンジン・
   受信者別view・対象操作が未実装なので、カードはまだ選択可能にしない。
2. The Magician／The Lovers／Wheel of Fortuneについては、手札24枚・総実体64枚・
   総ラウンド20回の上限と、再帰しない「比較後の一回だけ」の処理を実装済み。
3. 提案にある即時敗北条件は発動条件が未定義のため、引き続き実装しない。

## Tarotの段階導入案

- 初期導入済み: Death、Temperance、The Devil、The Tower、The Chariot、Strength、The Magician、The Lovers、Wheel of Fortune。各1枚まで。選択時に現在ラウンドの強さと成立条件を表示し、解決後は結果・履歴にも強さまたは確定した後処理を残す。Strengthは浮動小数点を用いず内部値を整数化して比較する。
- 実装待ち: Fool、High Priestess、Empress、Emperor、Hierophant、Hermit、Justice、
  Hanged Man、Star、Moon、Sun、Judgement、World。各カードの厳密な能力は
  `PRIVATE_PVP_REMAINING_TAROT_SPEC.md` を正本とする。

## 推奨する実装順

1. 完了: Private設定、設定凍結、選択中カードの説明、拡張用の純粋エンジンとカード実体ID、Ten〜Four、可変デッキ、総ラウンド／即時勝利の終了判定、デッキ編集UI、開始同意・設定revision、Private Socket対局への接続、Blank、比較型Tarot 6枚、対象不要の生成／総ラウンドTarot 3枚。
2. 次: `PRIVATE_PVP_REMAINING_TAROT_SPEC.md` の受信者別view、対象操作、ロック、
   獲得札台帳の順で実装する。
3. 対象選択型、履歴コピー、効果無効化を伴うTarotを、同設計の段階導入順で一枚ずつ追加。

## 必須の回帰・安全テスト

- クラシックの完全回帰とRandom／Rankedへの設定注入拒否。
- Blank有効／無効、Blankの非消費・非得点、時間切れ候補、設定境界。
- 複製カードの二重使用防止。
- 伏せ札の通信データ漏洩がないこと。
- タイマー、再接続、観戦、スマホ表示。
- カード数、ラウンド数、効果連鎖、履歴の上限到達。
