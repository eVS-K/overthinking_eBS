# DoS 対策と運用設定

このサーバーは、通常の2人対戦を保ちながら、アプリケーション層で次を制限します。

- 許可したOrigin以外、およびOriginなしのSocket.IO接続を拒否
- 接続試行、HTTPリクエスト、Socket.IOイベント、部屋作成のレート制限
- Socket.IOの受信ペイロードを16KBに制限し、WebSocket圧縮を無効化
- 1 IPあたりの接続数、全接続数、同時の部屋数、各部屋の観戦者数を制限
- HTTPヘッダー／リクエストのタイムアウトを短く設定
- 1接続につき1部屋だけを許可し、切断時の全ルーム走査を廃止
- チャットは50文字・改行なし・1参加セッション50回に制限し、送信間隔と履歴件数も制限

## Render の環境変数

通常のGitHub Pages運用では、`https://evs-k.github.io` と
`https://overthinking-ebs.onrender.com` は初期設定で許可済みです。
別の公開URLを追加するときだけ、Renderに次を設定してください。

```text
ALLOWED_ORIGINS=https://evs-k.github.io,https://your-domain.example
```

負荷特性に応じて、次の上限も環境変数で変更できます。未設定時は安全寄りの既定値を使います。

| 変数 | 既定値 | 内容 |
| --- | ---: | --- |
| `MAX_ACTIVE_ROOMS` | 300 | 同時に存在できる部屋数 |
| `MAX_SPECTATORS_PER_ROOM` | 40 | 1部屋あたりの観戦者数 |
| `MAX_SOCKETS_PER_IP` | 32 | 1 IPあたりの同時Socket接続数 |
| `MAX_HTTP_CONNECTIONS` | 800 | Node.jsプロセス全体のTCP接続数 |
| `SOCKET_EVENT_LIMIT` | 24 | 10秒間に許可する1接続あたりの操作数 |
| `RATE_LIMIT_TRACKED_IPS` | 5000 | レート制限で追跡するIP数の上限 |

`ALLOW_ORIGINLESS_SOCKET_CONNECTIONS=true` はローカルの特殊なテスト用途だけです。公開環境では設定しないでください。

アプリ側の制限は、帯域を埋める大規模DDoSそのものをネットワーク手前で止めるものではありません。公開規模を上げる場合は、独自ドメインをCloudflare等のWAF/CDNでプロキシし、DDoS緩和と接続レート制限を併用してください。
