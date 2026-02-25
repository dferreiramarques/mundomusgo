# Mundo Musgo — Plataforma Online

RPG narrativo multiplayer. 1 GM + 2 a 5 jogadores por mesa.

## Deploy no Railway

1. Fork ou faz push deste repo para GitHub
2. Em [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Seleciona o repo → Railway detecta `package.json` e faz deploy automático
4. Settings → Networking → Generate Domain (para HTTPS + WSS público)
5. A variável `PORT` é injectada automaticamente pelo Railway

## Desenvolvimento local

```bash
npm install
npm run dev        # node --watch (auto-restart)
# ou
npm start          # produção
```

Abre `http://localhost:3000`

## Estrutura

```
server.js     — servidor Node.js + WebSocket (lógica completa)
client.html   — frontend single-file (HTML + CSS + JS)
package.json  — dependências (apenas ws)
```

## Funcionalidades

### Lobby
- 3 mesas permanentes (M1, M2, M3)
- Primeiro a entrar numa mesa = GM automático
- Até 6 pessoas por mesa (1 GM + 5 jogadores)
- Reconexão automática (janela de 30s)

### GM
- **Texto de Cena** — broadcast de narrativa para todos os jogadores
- **Push de Media** — enviar imagem (URL) ou vídeo (YouTube) para todos os ecrãs
- **Dados do GM** — D4 a D20, resultados visíveis a todos
- **Vista de Jogadores** — tabela com stats, Musgo, dados e última acção de cada jogador
- **Log da História** — todas as cenas e media em ordem cronológica
- **Export JSON** — download do log completo em `/log?lobby=M1`

### Jogadores
- **Personagem** — editor completo com todos os campos de Mundo Musgo
  - Rolar Força (3d6+10) e Sorte (1d6+2) directamente no editor
  - Rolar Habilidade Especial (D6)
  - Gravar personagem como `.json` local
  - Carregar personagem de `.json`
  - Personagem guardado automaticamente em localStorage
- **Dados** — D4, D6, 2D6, 3D6, D8, D10, D12, D20. Rolar a qualquer momento, visível a todos
- **Última Acção** — descrição da acção actual, visível a todos
- **Chat** — conversa meta-cena partilhada

### Voz / Vídeo
- Botão 🎙 abre sala Jitsi Meet automática por mesa
- Zero configuração, usa WebRTC nativo do browser

## WebSocket Messages

### Client → Server
| Tipo | Payload | Quem |
|------|---------|------|
| `ROLL_DICE` | `{notation: "3d6"}` | Todos |
| `CHAT` | `{text}` | Todos |
| `GM_SCENE` | `{text}` | GM |
| `GM_PUSH_MEDIA` | `{mediaType, data}` | GM |
| `GM_CLEAR_MEDIA` | — | GM |
| `PLAYER_ACTION` | `{text}` | Jogadores |
| `CHARACTER_UPDATE` | `{character}` | Jogadores |

### Server → Client
| Tipo | Quando |
|------|--------|
| `GAME_STATE` | Após qualquer acção |
| `JOINED` | Ao entrar numa mesa |
| `LOBBIES` | Ao pedir lista de mesas |
