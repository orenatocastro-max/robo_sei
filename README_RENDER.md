# Robô SEI NIAR v11.8 - Correção de campos em frames

Esta versão corrige falhas na tela de login quando o SEI renderiza os campos de usuário/senha em estrutura diferente ou dentro de frame.

Melhorias:
- procura campos de usuário/senha em todos os frames;
- aceita input text, tel, number, email e autocomplete;
- fallback por heurística para preencher o primeiro campo visível e o campo password;
- imprime diagnóstico dos campos sem expor valores digitados;
- mantém correções anteriores de botão ACESSAR e leitura robusta.

No Render, mantenha:

```bash
npx playwright install chromium && node index.js
```

Variáveis principais:

```env
ROBOT_MODE=sei
SEI_URL=...
SEI_USER=...
SEI_PASSWORD=...
SEI_UNIDADE=JP II
SEI_DEBUG=true
```
