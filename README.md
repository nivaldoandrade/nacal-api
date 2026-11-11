# NaCal API

API serverless para um diário alimentar inteligente com inteligência artificial. O sistema permite que os usuários registrem suas refeições através de **fotos**, **áudios** ou **texto**, que são analisados automaticamente por IA para identificar os alimentos, estimar quantidades e calcular macronutrientes (proteínas, carboidratos e gorduras). O sistema também calcula metas diárias personalizadas de calorias e macros com base no perfil do usuário.

## Funcionalidades

- **Autenticação completa**: Cadastro com **confirmação de e-mail por código**, login, refresh token e recuperação de senha via AWS Cognito; e-mail normalizado (minúsculas) em todos os fluxos;
- **Beta fechado**: allowlist de e-mails (`BETA_GATE_ENABLED` + `BETA_ALLOWED_EMAILS`) aplicada no cadastro por e-mail e no login com Google;
- **Aceite de termos**: cadastro e onboarding exigem `acceptedTerms: true`; a `Account` guarda `termsVersion` e `termsAcceptedAt`;
- **Login com Google (OAuth 2.0 + PKCE)**: Autenticação via Google Identity Provider do Cognito com callback e onboarding automático do novo usuário;
- **Perfil do usuário**: Cadastro de dados pessoais (nome, data de nascimento, gênero, altura, peso, nível de atividade e objetivo);
- **Metas nutricionais**: Cálculo automático de calorias e macronutrientes diários com base no perfil (TDEE/BMR);
- **Upload de refeições**: Upload de fotos (JPEG) ou áudios (M4A, WebM) via Presigned POST do S3;
- **Validação de mídia**: Confere assinatura real do arquivo, tamanho e duração antes de chamar a IA; arquivos inválidos viram `REJECTED` (`INVALID_FILE`) com estorno de cota;
- **Gate de foto**: Pré-filtro no Cloudflare Workers AI (Clef-flash) rejeita fotos que claramente não são comida/bebida antes da OpenAI; falhas do gate são fail-open;
- **Análise por IA**: Identificação automática de alimentos com quantidades e macronutrientes via IA;
- **Descrição opcional na foto**: Texto livre (até 300 caracteres) enviado junto com a foto para completar o que a imagem não mostra (bebida em copo opaco, ingrediente escondido, quantidade, qual refeição foi);
- **Refeição por texto**: Uma frase digitada ("no almoço comi arroz, feijão e um bife", até 500 caracteres) vira uma refeição `SUCCESS` numa chamada síncrona (`POST /meals/text`), sem upload, fila ou polling. Consome 1 refeição da cota só quando dá certo;
- **Adicionar item por texto**: Depois do processamento, o usuário pode completar uma refeição `SUCCESS` com um texto curto ("um copo de coca 350ml"); a IA devolve só os itens novos, que são anexados à refeição. Não consome cota, mas é bloqueado para Free sem cota restante; até 5 adições por refeição, só nas primeiras 24h e até 30 itens;
- **Remover item e excluir refeição**: Em uma refeição `SUCCESS`, o usuário pode remover um item (o item vai para `removedFoods` e pode ser restaurado na mesma posição, para o "Desfazer" do app) e excluir a refeição inteira (soft delete com status `DELETED` e remoção do arquivo no S3, sem estorno de cota). Sem IA e sem janela de 24h; a refeição precisa manter pelo menos um item;
- **Aviso do que não foi identificado**: Na análise por foto, a IA pode sinalizar (`unidentified`: `DRINK`, `PACKAGED`, `COVERED` ou `OTHER`) algo claramente presente cujo conteúdo não dá para ver (copo opaco, embalagem fechada, recipiente tampado), sem adivinhar o item; o app usa isso para levar ao "Adicionar item". Cada alimento devolvido pela IA também traz `unidentifiedKind`: itens que a própria IA marca como não identificados ("bebida não identificada", "alguma coisa no pote") são removidos no backend; na foto viram esse aviso e, no "Adicionar item", são contados em `unidentifiedFoodsCount`;
- **Nome e ícone da refeição**: Derivados pela API a partir do horário no **fuso do usuário** (`timeZone` IANA enviado no `create-meal`), com `mealType` declarado no áudio, no texto ou na descrição da foto sobrepondo o horário;
- **Dia da refeição no fuso do usuário**: A refeição é agrupada no dia local de quando foi registrada (mesmo `timeZone`), então um jantar às 23h fica no mesmo dia do café da manhã, e não no dia seguinte em UTC;
- **Transcrição de áudio**: Transcrição automática de áudio via IA antes da análise;
- **Processamento assíncrono**: Fila SQS para processamento de refeições com até **2 tentativas no total** (1 retry);
- **CDN para arquivos**: CloudFront para servir os arquivos de refeição;
- **Refeição presa não fica com a cota**: 15 min depois do `create-meal`, uma mensagem atrasada no SQS confere a refeição; se o upload nunca terminou ou ela nunca saiu da fila, vira `FAILED` com estorno de cota;
- **Alarmes**: Notificação por email quando falhas inesperadas esgotam as entregas das filas (Dead Letter Queues) e quando a fila de processamento acumula (mensagem mais antiga com mais de 2 min);
- **Rate limiting**: Proteção por IP, e-mail e conta com resposta `429 RATE_LIMIT_EXCEEDED` e header `Retry-After` — implementado em código com contadores atômicos no DynamoDB (sem WAF);
- **Planos e assinatura**: plano Free com **20 refeições AI/mês** e Pro com **até 20 refeições AI por dia** (uso justo); **trial de 7 dias** sem cartão (1 por conta), checkout hospedado no **Asaas** (mensal recorrente só cartão; anual Pix/cartão), webhook idempotente como fonte da verdade, reconciliação horária dos pagamentos confirmados (ativa o que o webhook não ativou e avisa por e-mail) e downgrade lazy na expiração; a rota pública do webhook é endurecida com allowlist dos IPs oficiais do Asaas e rate limit por IP (120/60s), além de `reservedConcurrency: 5` na função;
- **Produção**: stage `prod` com proteção contra deleção (Cognito e DynamoDB), alarme da DLQ ativo, CORS restrito e validação do `.env.prod` antes do deploy (`yarn deploy:prod`);

## Arquitetura

![Diagrama da Arquitetura](/api/assets/diagrama-arquitetura.png)

A aplicação segue uma arquitetura **serverless event-driven** com separação clara de camadas:

```
┌─────────────────────────────────────────────────────────────────┐
│                        API Gateway HTTP API                      │
│                     (JWT Authorizer - Cognito)                   │
└──────────┬──────────────────────────────────┬────────────────────┘
           │                                  │
           ▼                                  ▼
   ┌───────────────┐                ┌──────────────────┐
   │  Lambda HTTP  │                │ Cognito Triggers │
   │  (Controllers)│                │  (PreSignUp,     │
   │               │                │   PreTokenGen,   │
   │  - Auth       │                │   CustomMessage) │
   │  - Profile    │                └──────────────────┘
   │  - Meal       │
   │  - Account    │
   │  - Billing    │
   └───────┬───────┘
           │
           ▼
   ┌────────────────────┐
   │  DynamoDB          │◄──── Single Table Design
   │  (Accounts,        │      (PAY_PER_REQUEST)
   │   Profiles,        │
   │   Goals,           │
   │   Meals,           │
   │   Subscriptions)   │
   └────────────────────┘
           │
           ▼ (upload via Presigned POST)
   ┌───────────────┐    S3 Event    ┌──────────────┐    SQS     ┌──────────────┐
   │  S3 Bucket    │───────────────►│ MealUploaded │──────────►│ MealQueue    │
   │  (Meals)      │                │ Trigger      │           │ Consumer     │
   └───────────────┘                └──────────────┘           └──────┬───────┘
                                                                      │
                                                                      ▼
                                                              ┌──────────────┐
                                                              │  OpenAI API  │
                                                              │  (GPT-5.4-mini│
                                                              │   Vision /   │
                                                              │   Transcribe)│
                                                              └──────────────┘
```

> Fotos passam por um gate opcional no Cloudflare Workers AI antes da OpenAI; detalhes em [Validação, gate e rejeição](#validação-gate-e-rejeição).

## Fluxo de Processamento de Refeições

### 1. Upload e Criação
1. Usuário envia `POST /create-meal` com `{ contentType, fileSize, timeZone?, description? }` (`description` só para fotos);
2. Backend consome a cota, publica na `MealUploadCheckQueue` uma mensagem com atraso de 15 min (ver [Refeição presa](#3-refeição-presa-checagem-de-15-min)), cria a refeição no DynamoDB (status: `UPLOADING`) e retorna um `mealId` junto com dados do Presigned POST (base64, válido por 5 min). Se a publicação ou a gravação falhar, a cota é estornada e a resposta é `500`;
3. Frontend faz upload direto para o S3 usando o Presigned POST;
4. S3 recebe o arquivo e dispara evento `ObjectCreated`.

### 2. Processamento Assíncrono
5. Lambda `newMealUploadedTrigger` é acionada pelo evento S3;
6. Atualiza o status da refeição para `QUEUED` e publica mensagem na fila SQS;
7. Lambda `processMeal` consome a mensagem, reivindica a refeição com lease condicional (`PROCESSING`) e baixa o arquivo do S3;
8. Valida o arquivo real (assinatura/magic bytes), tamanho e duração: foto JPEG até 10 MB; áudio M4A/WebM até 2 MB e 1–32s. Arquivo inválido vira `REJECTED` (`INVALID_FILE`), com estorno de cota e remoção do arquivo;
9. Para **fotos**, o gate Clef-flash avalia se há comida/bebida. Score abaixo de `0.30` vira `REJECTED` (`NOT_A_MEAL`), com estorno de cota; falha, timeout ou resposta inválida do gate não bloqueiam o processamento (fail-open);
10. Para **fotos**, a imagem vai para o GPT-5.4-mini junto com a `description`, quando enviada, delimitada em `<user_note>` (com `<`/`>` neutralizados). A nota acrescenta itens não visíveis e corrige identidade/quantidade dos visíveis, dentro do plausível para a imagem; ela é tratada como dado, nunca como instrução, e não monta a refeição sozinha se a foto não mostra comida;
11. Para **áudios**, transcreve via GPT-4o-mini-transcribe e envia a transcrição ao GPT-5.4-mini com o mesmo prompt da refeição por texto (`getTextMealPrompt`, variante de áudio), dentro de `<user_note>` com `<`/`>` neutralizados. A variante de áudio só muda a introdução: diz à IA que é uma fala transcrita, para ignorar hesitações e, quando o usuário se corrige, usar a versão corrigida. Menções que não dizem qual alimento era ("alguma coisa no pote") são removidas como no texto, sem aviso ao usuário (`unidentified` fica `null`). Áudio sem fala ou sem alimentos vira `REJECTED` (`NO_FOOD_DETECTED`), com estorno de cota;
12. IA retorna dados estruturados dos alimentos (nome, quantidade, proteínas, carboidratos, gorduras) e um `mealType` opcional quando o usuário declara a refeição (no áudio ou na descrição da foto). Para **fotos**, também devolve `unidentified` (`DRINK`, `PACKAGED`, `COVERED`, `OTHER` ou `null`) quando há algo claramente presente cujo conteúdo não dá para ver e a nota não explica, e marca cada alimento com `unidentifiedKind` (`null` quando identificado). O `MealAiGateway` remove os alimentos marcados (log `[UNIDENTIFIED]`) e, se `unidentified` veio `null`, usa a categoria do primeiro alimento removido; se nenhum alimento sobrar, a refeição vira `REJECTED` (`NO_FOOD_DETECTED`), com estorno de cota;
13. Backend mantém no máximo 30 itens (`Meal.MAX_FOODS`, o mesmo teto do texto e do "Adicionar item"), calcula calorias, define `name`/`icon` (via `MealNamingService`: horário no fuso do usuário ou `mealType` declarado) e atualiza o DynamoDB com status `SUCCESS`;
14. Em falha transitória, a 1ª tentativa volta para `QUEUED`; a 2ª falha marca `FAILED`, **estorna a cota** e remove o arquivo do S3. A 3ª entrega da SQS serve para cleanup; falhas inesperadas que esgotam as entregas vão para a Dead Letter Queue e disparam alarme por email.

### 3. Refeição presa (checagem de 15 min)
15. A mensagem publicada no passo 2 fica invisível por 900s (`Meal.UPLOAD_CHECK_DELAY_SECONDS`, máximo do SQS; o Presigned POST expira em 5 min) e então é consumida pela Lambda `checkMealUpload`;
16. Ela lê a refeição com leitura consistente. Em `UPLOADING` (arquivo nunca chegou, ou o gatilho do S3 falhou) ou em `QUEUED` com `attempts = 0` (a publicação na `MealsQueue` falhou, ou a fila acumulou mais de ~10 min), marca `FAILED`, **estorna a cota** (mês e dia, na mesma transação do passo 14) e remove o arquivo do S3, se existir. Em qualquer outro status, ou se a refeição não existir, não faz nada;
17. A escrita é condicionada ao status lido, então um upload que termina no último segundo não é estornado. Erros voltam para a fila (3 entregas) e depois vão para a `MealUploadCheckDLQ`, com alarme por email.

### 4. Refeição por texto (síncrona)
Não passa por S3, SQS nem `processMeal`: `POST /meals/text` resolve tudo na própria request (Lambda com `timeout: 29`).
1. Checa a cota do plano antes de chamar a IA (Free: `403 FREE_QUOTA_EXCEEDED`; Pro: `429 DAILY_MEAL_LIMIT_REACHED`);
2. Envia o texto ao GPT-5.4-mini (prompt `getTextMealPrompt`) dentro de `<user_note>`, com `<`/`>` neutralizados e tratado como dado. A IA devolve os alimentos e o `mealType` declarado; menções que não dizem qual alimento era ("alguma coisa no pote", "um pacotinho") vêm marcadas com `unidentifiedKind` e são removidas (log `[UNIDENTIFIED]`);
3. Sem nenhum alimento, responde `422 NO_FOOD_IDENTIFIED` **sem consumir cota**;
4. Consome a cota de forma atômica, calcula calorias, define `name`/`icon` e grava a refeição já em `SUCCESS` (`inputType: TEXT`, sem arquivo). Se a gravação falhar, a cota é estornada.

## Validação, gate e rejeição

### Validação do arquivo

- **Fotos**: apenas JPEG real (assinatura `FF D8 FF`), até **10 MB** e com dimensões válidas. O app normaliza outras imagens para JPEG antes do upload;
- **Áudios**: apenas M4A ou WebM, até **2 MB** e entre **1 e 32 segundos**; o container e a assinatura do arquivo são conferidos;
- Arquivo inválido, corrompido ou fora dos limites vira `REJECTED` com `rejectionReason: INVALID_FILE`, a cota é estornada e o arquivo é removido do S3.

### Gate de foto (Cloudflare Workers AI)

- Roda apenas para fotos, antes da chamada de visão da OpenAI;
- Usa o modelo `@cf/cloudflare/clef-flash` e o score `result.answers.is_food_or_drink.noul`;
- `score < MEAL_GATE_REJECT_THRESHOLD` → `REJECTED` com `rejectionReason: NOT_A_MEAL`, cota estornada e arquivo removido;
- É **fail-open**: sem credenciais, timeout (8s), `429`, `5xx`, resposta inválida ou imagem acima de 4 MiB/16 MP, o gate retorna `SKIP` e a OpenAI processa normalmente;
- Configuração: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_API_TOKEN` (permissões `Workers AI - Read` e `Workers AI - Edit`), `MEAL_GATE_ENABLED` (default `true`) e `MEAL_GATE_REJECT_THRESHOLD` (default `0.30`).

### Status e estorno

| Status | Quando acontece | Cota | `inputFileUrl` |
| ------ | --------------- | ---- | -------------- |
| `REJECTED` | Arquivo inválido, foto sem comida/bebida ou áudio sem fala/alimentos | Estornada | `null` |
| `FAILED` | Falha de plataforma após 2 tentativas (OpenAI, timeout, S3, resposta inválida), ou refeição presa em `UPLOADING`/`QUEUED` 15 min depois do `create-meal` | Estornada | `null` |
| `DELETED` | Usuário excluiu a refeição (`DELETE /meals/{id}`) | Não estornada | some da API (`404`) |

Os motivos de rejeição são `INVALID_FILE`, `NOT_A_MEAL` e `NO_FOOD_DETECTED`. Uma tentativa rejeitada ou com falha continua contando no rate limit de `POST /create-meal`.

O estorno é feito numa transação (`TransactWriteItems`) que muda o status da refeição e decrementa o contador mensal juntos. Cada operação usa seu próprio `ClientRequestToken` (`<mealId>#fail#<tentativa>` / `<mealId>#reject#<tentativa>` / `<mealId>#upload` para a refeição presa em `UPLOADING`; o DynamoDB aceita no máximo 36 caracteres), então um retry da fila não colide com outra operação na janela de idempotência do DynamoDB. Se o contador já estiver em zero, a refeição é marcada com `quotaRefunded: false`.

## Fluxo de Cadastro por E-mail

```text
App                                   API                                   Cognito / DynamoDB
 | POST /auth/sign-up                  |                                      |
 |------------------------------------▶| beta gate + e-mail em minúsculas      |
 |                                     | SignUp (UNCONFIRMED) ---------------▶ | envia código
 |                                     | grava PendingSignUp (TTL 24h) ------▶ | perfil + termos
 |◀------- 201 requiresConfirmation ---|                                      |
 | POST /auth/confirm-sign-up          |                                      |
 | { email, confirmationCode, password}|                                      |
 |------------------------------------▶| ConfirmSignUp ----------------------▶ | CONFIRMED
 |                                     | testa a senha (InitiateAuth)         |
 |                                     | cria Account + Profile + Goal ------▶ | (aplica o PendingSignUp)
 |◀------- 200 { passwordResetRequired }                                      |
 | POST /auth/sign-in                  |                                      |
```

- **Cadastro**: `POST /auth/sign-up` cria o usuário `UNCONFIRMED` no Cognito e guarda perfil e aceite de termos num `PendingSignUp` (TTL de 24h). A `Account` só é criada depois da confirmação. Responde `201 { requiresConfirmation: true, alreadyPending }`;
- **Cadastro repetido**: se o e-mail ainda está `UNCONFIRMED`, o usuário pendente é apagado e recriado. A senha, o perfil e os termos novos passam a valer, com código novo e TTL renovado (`alreadyPending: true`). E-mail já confirmado → `409 EMAIL_ALREADY_IN_USE`;
- **Confirmação**: `POST /auth/confirm-sign-up` recebe código **e senha**. O código prova a posse do e-mail, mas não quem escolheu a senha (qualquer pessoa pode cadastrar um e-mail ainda não confirmado). Depois de confirmar, a API testa a senha:
  - senha certa → aplica o `PendingSignUp` e cria a conta já com onboarding → `200 { passwordResetRequired: false }`;
  - senha errada (ou qualquer falha no teste, *fail-closed*) → troca a senha por uma aleatória, descarta o `PendingSignUp` e cria a conta sem onboarding → `200 { passwordResetRequired: true }`. O usuário define uma senha nova pelo "esqueci a senha";
- **Conta já confirmada**: a confirmação não grava nada; responde `200` se a conta existe e `400 INVALID_CONFIRMATION_CODE` se não existe;
- **Reenvio**: `POST /auth/resend-confirmation-code` responde `204` sempre (não revela se o e-mail existe) e só reenvia para usuários `UNCONFIRMED`;
- **Login antes de confirmar**: `POST /auth/sign-in` responde `403 EMAIL_NOT_CONFIRMED`;
- **Recuperação de conta incompleta**: se o Cognito confirmou o usuário mas a gravação da conta falhou, `GET /me` (chamado logo após o login) cria a conta a partir do `PendingSignUp`. Só acontece quando a conta não existe, o e-mail está verificado e o `internalId` do usuário bate com o do token;
- **Erros do Cognito**: limite de tentativas → `429 TOO_MANY_ATTEMPTS`; falha no envio do código → `502 CODE_DELIVERY_FAILED`;
- **E-mail com maiúsculas**: o pool do Cognito diferencia maiúsculas. Novos usuários são gravados em minúsculas; login e recuperação de senha tentam o e-mail normalizado e, se não existir, o digitado (contas antigas);
- **Troca de e-mail**: o pool exige verificação antes de aplicar um e-mail novo (`AttributesRequireVerificationBeforeUpdate`), e o provisionamento de conta busca pelo `internalId` imutável, nunca pelo e-mail.

## Classificação da Refeição (nome e ícone)

O nome e o ícone **não** são definidos pela IA: a API os deriva do **horário da refeição interpretado no fuso do usuário** (o `timeZone` IANA enviado no `POST /create-meal`, com fallback `America/Sao_Paulo`). Quando o usuário **declara explicitamente** a refeição no áudio, no texto ou na descrição da foto (por exemplo, "almocei", "estou jantando", "foi meu almoço"), a IA devolve um `mealType` opcional que **sobrepõe** o horário; menções genéricas ou negadas ficam como `null` e caem no horário.

| Horário (local) | Nome            | Ícone | `mealType` da IA  |
| --------------- | --------------- | ----- | ----------------- |
| 04:00–10:59     | Café da manhã   | ☕    | `BREAKFAST`       |
| 11:00–14:59     | Almoço          | 🍽️    | `LUNCH`           |
| 15:00–17:59     | Lanche da tarde | 🍎    | `AFTERNOON_SNACK` |
| 18:00–22:59     | Jantar          | 🍲    | `DINNER`          |
| 23:00–03:59     | Ceia            | 🌙    | `SUPPER`          |

- O horário é calculado com `Intl` no fuso recebido; `timeZone` inválido ou ausente cai no default `America/Sao_Paulo`.
- A lógica vive em `MealNamingService` (`application/services/`); a IA retorna apenas os alimentos/macros e o `mealType` opcional.
- O mesmo fuso define o **dia** da refeição: o `GSI1PK` (`MEAL#<accountId>#YYYY-MM-DD`) usa a data local do `createdAt` no `timeZone` salvo, com o mesmo fallback. A regra de fuso e o cálculo do dia ficam em `shared/utils/timeZone.ts`, usados por `MealNamingService` e `MealItem`, o que garante que nome e dia nunca divergem.

## Fluxo de Autenticação OAuth (Google)

O login com Google usa o fluxo **Authorization Code + PKCE**:

```text
Frontend                          Cognito                       API (Lambda)
   |  1. Gera code_verifier        |                              |
   |  2. Redireciona para login    |                              |
   |------------------------------▶|  /oauth2/authorize            |
   |                               |  3. Usuário autentica no      |
   |                               |     Google                   |
   |                               |  4. PreSignUp_ExternalProvider|
   |                               |     cria usuário nativo      |
   |                               |     ("shadow") + vincula     |
   |                               |     provider                 |
   |◀--------- 5. code ------------|                              |
   |  6. POST /auth/oauth/callback |                              |
   |----------------------------------------------------------▶|
   |                               |  7. Troca code + verifier por |
   |                               |     tokens (PKCE)            |
   |                               |  8. Cria Account (isOnboarded:
   |                               |     false) se email não      |
   |                               |     registrado               |
   |◀--------- 9. tokens + isOnboarded ------------------------|
   |  10. Se isOnboarded = false                               |
   |      POST /auth/complete-onboarding                       |
   |----------------------------------------------------------▶|
   |                               |  11. Cria Profile + Goal e   |
   |                               |      marca isOnboarded=true  |
   |                               |      (TransactWrite)         |
   |◀--------------------- 12. 204 ----------------------------|
```

1. O frontend gera um `code_verifier` aleatório e redireciona o usuário para o Cognito (`/oauth2/authorize`) com o `code_challenge` (PKCE);
2. O usuário autentica com a conta Google e o Cognito redireciona de volta com um `code`;
3. No primeiro login com Google, o trigger `PreSignUp_ExternalProvider` cria um usuário nativo "shadow" no Cognito (username = email, atributo `custom:internalId`) e vincula o Identity Provider a esse usuário;
4. O frontend envia `code`, `redirectUri` e `codeVerifier` para `POST /auth/oauth/callback`;
5. O backend troca o `code` pelos tokens, deriva identidade do token (exige `email_verified`) e, se ainda não houver `Account` para o `internalId`, **cria a `Account` no DynamoDB**. Se existir um `PendingSignUp` (cadastro por e-mail sem código, seguido de login com Google), ele é aplicado e a conta já nasce com onboarding; caso contrário, `isOnboarded: false` — retorna `200` com `{ accessToken, refreshToken, isOnboarded }`. O access token já contém o claim `internalId`;
6. **Usuário novo** (`isOnboarded: false`): o frontend chama `POST /auth/complete-onboarding` com o `accessToken`. O backend deriva identidade do token, **reutiliza a `Account` criada no callback**, cria `Profile` e `Goal` e marca `isOnboarded: true` atomicamente (`TransactWriteCommand`). Responde `204`;
7. Como o claim `internalId` já vem no primeiro token (atributo `custom:internalId` injetado pelo trigger `preTokenGeneration`), não é necessária uma troca de token extra após o onboarding.

**Observações:**
- O `complete-onboarding` é **idempotente**: reexecuta a gravação de `Profile`/`Goal` e o flag com o mesmo `accountId` (retry seguro);
- Erros: `400 INVALID_GRANT` se a troca de code falhar ou faltar dado no token; se a conta existir mas pertencer a outro `externalId`, `409 EMAIL_ALREADY_IN_USE`; se o token for válido mas não houver `Account` registrada, `404 ACCOUNT_NOT_FOUND`;
- A troca de código tem timeout de 5 segundos;
- Com o beta fechado, o trigger `PreSignUp` recusa e-mails fora da allowlist e o Cognito redireciona de volta com `error_description` contendo `BETA_ACCESS_DENIED` (o app mostra a mensagem do beta).

## Fluxo de Planos e Pagamento (Billing)

Gateway **Asaas** (sandbox: `api-sandbox.asaas.com`), atrás do contrato `IPaymentGateway` — os use cases nunca citam o gateway:

```text
TRIAL (dia 0, sem gateway):
  POST /billing/trial ──► Subscription { status: TRIALING, trialEndsAt: +7d,
      planId: PRO_MONTHLY }   (1 por conta · Pro imediato · 20/dia)

CHECKOUT:
  POST /billing/checkout ──► Asaas Checkout ──► { checkoutUrl }
      mensal = RECURRENT + só cartão     (1ª cobrança imediata)
      anual  = DETACHED  + Pix/cartão    (pagamento único; renovação via app)
  App abre checkoutUrl no browser ──► usuário paga

WEBHOOK (fonte da verdade):
  Asaas ──POST /billing/webhooks/asaas──► allowlist de IP (403) ──►
      rate limit IP 120/60s (429) ──► header asaas-access-token ──►
      PAYMENT_CONFIRMED / RECEIVED ──► status ACTIVE + paidUntil (+ciclo) ──►
      app invalida ['accounts'] e reflete via GET /me

RECONCILIAÇÃO (rede de segurança do webhook, a cada 1h com o Asaas de produção):
  EventBridge ──► Lambda reconcilePayments ──► GET /v3/payments
      (status CONFIRMED e RECEIVED, vencimento nos últimos 35 dias) ──►
      mesmo join e mesma ativação do webhook (WebhookUseCase.applyEvent) ──►
      ativa só o pagamento que ainda não está coberto pelo paidUntil ──►
      e-mail (SNS) se ativou algo, achou pagamento sem conta ou falhou

EXPIRAÇÃO (lazy, sem scheduler):
  resolveEffectivePlan: trial/pago vencido ──► FREE + cota 20/mês
```

**Observações:**
- **Idempotência**: dedup por `event.id` na RateLimitTable (TTL 14d = retenção de reenvio do Asaas) + guards de transição (`paidUntil` só avança · `CHECKOUT_PAID` é no-op);
- **Endurecimento da rota pública**: 3 camadas: allowlist dos **IPs oficiais do Asaas** (env `ASAAS_WEBHOOK_ALLOWED_IPS`; default = 4 IPs de produção, `*` desabilita em sandbox/dev; checada no adapter **antes** de tudo → `403`), token `asaas-access-token` (`502` se inválido), rate limit por IP 120/60s (`429` + `Retry-After`). O `reservedConcurrency: 5` em `sls/functions/billing.yml` é o teto de custo/concorrência da função do webhook (exige cota de concorrência de Lambda acima do mínimo da conta; nas duas contas a cota é 1000);
- **Join do webhook com a conta**: via `externalReference` (`"<accountId>#<planId>"`) e índice reverso `GATEWAY#<id>` na MainTable (testado com payload real pago no sandbox);
- **Pagamento de assinatura já cancelada**: um `PAYMENT_CONFIRMED`/`RECEIVED` da **mesma** assinatura do Asaas que o usuário cancelou (`gatewayRefs.subscriptionId`) não reativa: mantém `CANCELED` e só avança o `paidUntil` quando o ciclo pago é mais novo. Cobre o `PAYMENT_RECEIVED` do cartão, que chega cerca de 30 dias depois do `PAYMENT_CONFIRMED`, e vale para o webhook e para a reconciliação. Pagamento de uma assinatura nova (re-assinatura) reativa normalmente. Todo pagamento confirmado também grava o `planId` do plano pago (quem fez o trial e pagou o anual passa a `PRO_YEARLY`);
- **Renovação adiantada do anual**: pagamento do anual feito antes do `paidUntil` atual soma um ano a partir desse `paidUntil` (em vez de contar do vencimento do pagamento), para o assinante não perder os dias restantes; depois de vencido, conta do vencimento do pagamento. A soma só acontece quando `vencimento + 1 ano` passa do `paidUntil` atual, então um segundo evento do mesmo pagamento (o `PAYMENT_RECEIVED` do cartão, a reconciliação) não soma de novo. Limite conhecido: dois pagamentos de anual com menos de um ano entre os vencimentos, ambos antes do `paidUntil`, contam como um só (o app só oferece renovar nos últimos 30 dias). O mensal não mudou. Não há e-mail de aviso de vencimento: o aviso é só no app, calculado do `GET /me`;
- **Reconciliação**: a Lambda `reconcilePayments` lista no Asaas os pagamentos `CONFIRMED`/`RECEIVED` com vencimento nos últimos 35 dias e aplica cada um pelo `WebhookUseCase.applyEvent`. Um pagamento é pulado quando a assinatura já tem `paidUntil >= vencimento + ciclo` (por isso quem pagou e cancelou não é reativado). Os pagamentos são processados em ordem de vencimento, para o primeiro pagamento de uma assinatura criar o vínculo antes da renovação. Cada pagamento conferido ganha um marcador de 45 dias (janela + 10) na RateLimitTable (`RL#webhook-event#reconcile-payment#<payId>`) e não é relido. Quando ativa algo, acha um pagamento pago sem conta correspondente ou algum pagamento dá erro, publica um e-mail no `DQLAlarmTopic` (env `ALERT_TOPIC_ARN`, injetada pelo Serverless), e o alarme `ReconcilePaymentsErrorsAlarm` (métrica `Errors` da Lambda, ações só em prod) cobre a execução que falha sem e-mail próprio: listagem do Asaas com erro, falha ao publicar no SNS, timeout e erro ao iniciar (o motivo fica no log). O agendamento (`rate(1 hour)`) liga sozinho quando `ASAAS_BASE_URL` é `https://api.asaas.com` e fica desligado no sandbox, em qualquer stage (`sls/config/reconcileScheduleEnabled.js`); com o sandbox roda sob demanda: `npx serverless invoke -f reconcilePayments` (aceita `--data '{"lookbackDays":45}'` para uma janela maior, até 365 dias, útil também depois de uma falha longa do webhook). Fora do escopo: `PAYMENT_OVERDUE` e cancelamentos perdidos;
- **Cotas**: Free 20/mês e Pro 20/dia, detalhadas em [Cotas de refeição](#cotas-de-refeição);
- Trial é **1 por conta** (`409 TRIAL_NOT_AVAILABLE`); cancelar trial é downgrade local (sem gateway), assinatura paga cancela no gateway e mantém `PRO` até `paidUntil` + carência de 3 dias.

### Cotas de refeição

O `MealQuotaService` controla as cotas com contadores atômicos e condicionais na RateLimitTable (`PK = RL#account-monthly#<id>` e `RL#account-daily#<id>`). Foto, áudio e texto consomem 1 refeição; o "Adicionar item" não consome.

| Plano | Limite | Contador (SK) | Ao estourar |
|---|---|---|---|
| Free | 20 refeições por mês (mês em UTC) | `YYYY-MM` | `403 FREE_QUOTA_EXCEEDED` |
| Pro (pago ou trial) | 20 refeições por dia (dia em `America/Sao_Paulo`) | `YYYY-MM-DD` no diário + `YYYY-MM#PRO` no mensal, sem limite, só para estatística | `429 DAILY_MEAL_LIMIT_REACHED` |

- O contador do Free conta só as refeições feitas no Free; as do Pro (trial ou pago) vão para `YYYY-MM#PRO`. Quem volta ao Free no meio do mês tem as 20 menos o que já usou no Free naquele mês: trial logo depois do cadastro → 20 cheias; usou as 20 do Free, fez o trial e voltou no mesmo mês → 0 até o mês seguinte. O mesmo vale para o Pro pago que cancela, deixa de pagar ou tem o anual vencido.
- A refeição grava `quotaMonth` e `quotaDay` (este só no Pro). O estorno (`REJECTED`, `FAILED`, incluindo a refeição presa, ou falha ao gravar a refeição) devolve os dois contadores no bucket gravado, mesmo que aconteça no dia seguinte.
- "Adicionar item": no Free sem cota do mês responde `403 FREE_QUOTA_EXCEEDED`; no Pro não é bloqueado pelo limite diário (já tem o teto de 5 adições por refeição e 20/h).
- Os rate limits por hora ([Rate Limit](#rate-limit)) continuam valendo junto com as cotas.
- `GET /me` devolve `mealQuota` (mensal) e `dailyMealQuota` (só Pro).

## Pré-requisitos

- [Node.js 20 ou superior](https://nodejs.org/en/)
- Yarn ou outro package manager
- [Serverless Framework v4](https://www.serverless.com)
- [Credenciais AWS configuradas](https://www.serverless.com/framework/docs/providers/aws/guide/credentials#aws-credentials)
- [Chave de API do OpenAI](https://platform.openai.com/api-keys)

## Configuração do Serverless

1. Instale o Serverless via NPM:

   ```bash
   npm i serverless -g
   ```

   Para mais informações: [Installation](https://www.serverless.com/framework/docs/getting-started#installation).

2. Faça login no Serverless:

   Crie uma conta no Serverless e faça login com o comando abaixo:

   ```bash
   sls login
   ```

   Para mais informações: [Signing In](https://www.serverless.com/framework/docs/getting-started#signing-in).

### Configuração das Credenciais AWS

Para mais informações: [AWS Credentials](https://www.serverless.com/framework/docs/providers/aws/guide/credentials#aws-credentials)

#### **Opção 1: AWS CLI (Recomendado)**

1. Faça o download e instalação: [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html#getting-started-install-instructions).

2. Crie um: [IAM user](https://docs.aws.amazon.com/cli/latest/userguide/cli-authentication-user.html#cli-authentication-user-create)

   **OBS:** No **Attach existing policies directly** e procure e adicione a política **AdministratorAccess**.

3. Configure AWS CLI:

   ```bash
   aws configure
   ```

   Preencha com:
   - AWS Access Key ID
   - AWS Secret Access Key
   - Default region: `sa-east-1`
   - Default output format: `json`

   Para mais informações: [Configure the AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/cli-authentication-user.html#cli-authentication-user-configure.title)

#### **Opção 2: Variáveis de Ambiente**

1. Crie um: [IAM user](https://docs.aws.amazon.com/cli/latest/userguide/cli-authentication-user.html#cli-authentication-user-create)

   **OBS:** No **Attach existing policies directly** e procure e adicione a política **AdministratorAccess**.

2. Configure as variáveis de ambiente do Serverless Framework conforme a [documentação oficial](https://www.serverless.com/framework/docs/providers/aws/guide/credentials#using-aws-access-keys).

## Passo a passo

### 1. Clone o repositório

```bash
git clone https://github.com/nivaldoandrade/nacal-api

cd nacal-api
```

### 2. Instale as dependências

```bash
yarn
# ou
npm install
```

### 3. Configure as variáveis de ambiente

```bash
# Copie o arquivo de exemplo
cp .env.example .env

# Edite o arquivo .env e preencha os valores
```

Preencha o `.env` com os valores necessários:

```env
COGNITO_EMAIL=noreply@seudominio
COGNITO_EMAIL_TO_REPLY=suporte@seudominio
SES_SOURCE_ARN=arn:aws:ses:sa-east-1:xxxxx:identity/seudominio

API_DOMAIN_NAME=
API_CERTIFICATE_ARN=

MEALS_CDN_DOMAIN_NAME=
MEALS_CDN_CERTIFICATE_ARN=

DLQ_ALARM_EMAIL=seu-email@exemplo.com

OPENAI_API_KEY=sk-xxxxx

# Cloudflare Workers AI (gate de foto, opcional)
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_AI_API_TOKEN=
MEAL_GATE_ENABLED=true
MEAL_GATE_REJECT_THRESHOLD=0.30

# Beta fechado (opcional)
BETA_GATE_ENABLED=false
BETA_ALLOWED_EMAILS=
```

### 4. Realize o deploy na AWS

```bash
sls deploy
```

Se tudo ocorrer bem, o output esperado será:

```plaintext
endpoints:
  POST - https://xxx.execute-api.sa-east-1.amazonaws.com/auth/sign-up
  POST - https://xxx.execute-api.sa-east-1.amazonaws.com/auth/sign-in
  POST - https://xxx.execute-api.sa-east-1.amazonaws.com/auth/confirm-sign-up
  POST - https://xxx.execute-api.sa-east-1.amazonaws.com/auth/resend-confirmation-code
  POST - https://xxx.execute-api.sa-east-1.amazonaws.com/auth/refresh-token
  POST - https://xxx.execute-api.sa-east-1.amazonaws.com/auth/forgot-password
  POST - https://xxx.execute-api.sa-east-1.amazonaws.com/auth/confirmation-forgot-password
  POST - https://xxx.execute-api.sa-east-1.amazonaws.com/auth/oauth/callback
  POST - https://xxx.execute-api.sa-east-1.amazonaws.com/auth/complete-onboarding
  GET  - https://xxx.execute-api.sa-east-1.amazonaws.com/me
  PUT  - https://xxx.execute-api.sa-east-1.amazonaws.com/profiles
  POST - https://xxx.execute-api.sa-east-1.amazonaws.com/create-meal
  GET  - https://xxx.execute-api.sa-east-1.amazonaws.com/meals
  GET  - https://xxx.execute-api.sa-east-1.amazonaws.com/meals/{id}
  POST - https://xxx.execute-api.sa-east-1.amazonaws.com/meals/text
  POST - https://xxx.execute-api.sa-east-1.amazonaws.com/meals/{id}/items
  DELETE - https://xxx.execute-api.sa-east-1.amazonaws.com/meals/{id}
  DELETE - https://xxx.execute-api.sa-east-1.amazonaws.com/meals/{id}/items/{itemId}
  POST - https://xxx.execute-api.sa-east-1.amazonaws.com/meals/{id}/items/{itemId}/restore
functions:
  hello: nacal-api-dev-hello
  signUp: nacal-api-dev-signUp
  signIn: nacal-api-dev-signIn
  confirmSignUp: nacal-api-dev-confirmSignUp
  resendConfirmationCode: nacal-api-dev-resendConfirmationCode
  refreshToken: nacal-api-dev-refreshToken
  forgotPassword: nacal-api-dev-forgotPassword
  confirmationForgotPassword: nacal-api-dev-confirmationForgotPassword
  oauthCallback: nacal-api-dev-oauthCallback
  completeOnboarding: nacal-api-dev-completeOnboarding
  preSignUpTrigger: nacal-api-dev-preSignUpTrigger
  preTokenGenerationTrigger: nacal-api-dev-preTokenGenerationTrigger
  customMessageTrigger: nacal-api-dev-customMessageTrigger
  me: nacal-api-dev-me
  updateProfile: nacal-api-dev-updateProfile
  createMeal: nacal-api-dev-createMeal
  listMeals: nacal-api-dev-listMeals
  getMealById: nacal-api-dev-getMealById
  createTextMeal: nacal-api-dev-createTextMeal
  addMealItems: nacal-api-dev-addMealItems
  newMealUploadedTrigger: nacal-api-dev-newMealUploadedTrigger
  processMeal: nacal-api-dev-processMeal
  checkMealUpload: nacal-api-dev-checkMealUpload
  reconcilePayments: nacal-api-dev-reconcilePayments
```

O endpoint base da API será: `https://xxx.execute-api.sa-east-1.amazonaws.com`

Para produção, use `AWS_PROFILE=nacal-prod yarn deploy:prod`: o script valida `.env.prod` e executa `sls deploy --stage prod`. O checklist completo está em `../docs/producao-nacal.md`.

`yarn check:prod` (rodado pelo `deploy:prod`) recusa, entre outros:
- chaves do `.env` ausentes no `.env.prod` (herdariam valores de dev) e valores de exemplo;
- `APP_WEB_URL` com path ou barra final, e domínios/ARNs fora do esperado;
- `CORS_ALLOWED_ORIGINS` com `*` ou sem HTTPS;
- `ASAAS_WEBHOOK_ALLOWED_IPS` com `*` ou com CIDR (a allowlist compara o IP exato);
- `BETA_GATE_ENABLED`/`MEAL_GATE_ENABLED` diferentes de `true`/`false`, beta ligado sem e-mails ou `BETA_ALLOWED_EMAILS` acima de 2 KB;
- `AWS_PROFILE` ausente.

### 5. Configurar o CDN na zona de DNS (opcional)

Aplica-se quando `MEALS_CDN_DOMAIN_NAME` estiver definido no `.env` (domínio customizado da distribuição CloudFront para os arquivos de refeição). O registro de DNS do domínio precisa apontar para o domain da distribuição.

- **Primeiro deploy**: após o `sls deploy`, consulte o domain da distribuição criada (`sls info` ou `aws cloudfront list-distributions`) e crie na zona de DNS do domínio um registro **CNAME** de `MEALS_CDN_DOMAIN_NAME` apontando para esse domain (ex.: `dxxxxxxxxxxxx.cloudfront.net`);
- **Recriação da stack**: antes de deployar, garanta que o CNAME **não aponte mais** para a distribuição antiga/deletada (caso contrário o CloudFront rejeita a criação do alias). Após o deploy, recrie o CNAME apontando para o domain da nova distribuição;
- Sem `MEALS_CDN_DOMAIN_NAME`, a distribuição usa o domain padrão `*.cloudfront.net` — nenhuma ação é necessária no DNS.

## Endpoints

### Autenticação

| Método | Url                                  | Descrição                                | Autenticação |
| ------ | ------------------------------------ | ---------------------------------------- | ------------ |
| POST   | `/auth/sign-up`                      | Cadastra um novo usuário (pendente até confirmar o e-mail) | Pública      |
| POST   | `/auth/confirm-sign-up`              | Confirma o e-mail com código e senha e cria a conta | Pública      |
| POST   | `/auth/resend-confirmation-code`     | Reenvia o código de confirmação          | Pública      |
| POST   | `/auth/sign-in`                      | Realiza login                            | Pública      |
| POST   | `/auth/refresh-token`                | Renova tokens de acesso                  | Pública      |
| POST   | `/auth/forgot-password`              | Solicita código de recuperação de senha  | Pública      |
| POST   | `/auth/confirmation-forgot-password` | Confirma redefinição de senha com código | Pública      |
| POST   | `/auth/oauth/callback`               | Troca o code do Google por tokens (PKCE) | Pública      |
| POST   | `/auth/complete-onboarding`          | Cria perfil e metas do usuário do Google (conta já criada no callback) | Pública  |

### Perfil e Conta

| Método | Url         | Descrição                                        | Autenticação |
| ------ | ----------- | ------------------------------------------------ | ------------ |
| GET    | `/me`       | Retorna `isOnboarded`, perfil, metas, `subscription`, `mealQuota` e `dailyMealQuota` do usuário (recria a conta se ela faltar após a confirmação) | JWT          |
| PUT    | `/profiles` | Atualiza o perfil do usuário                     | JWT          |

### Refeições

| Método | Url                      | Descrição                                              | Autenticação |
| ------ | ------------------------ | ------------------------------------------------------ | ------------ |
| POST   | `/create-meal`           | Cria uma refeição (JPEG ≤10 MB ou M4A/WebM ≤2 MB e 1–32s) e retorna Presigned POST | JWT          |
| GET    | `/meals?date=YYYY-MM-DD` | Lista refeições de um dia específico                   | JWT          |
| GET    | `/meals/{id}`            | Retorna uma refeição por ID com status, rejeição, `inputFileUrl`, alimentos, `canAddItems`, `canRemoveItems` e `unidentified` | JWT          |
| POST   | `/meals/text`            | Cria uma refeição a partir de um texto (IA síncrona) e devolve a refeição pronta | JWT          |
| POST   | `/meals/{id}/items`      | Adiciona itens a uma refeição `SUCCESS` a partir de texto (IA síncrona) | JWT          |
| DELETE | `/meals/{id}`            | Exclui a refeição (soft delete + remove o arquivo do S3) | JWT          |
| DELETE | `/meals/{id}/items/{itemId}` | Remove um item de uma refeição `SUCCESS` | JWT          |
| POST   | `/meals/{id}/items/{itemId}/restore` | Restaura um item removido (o "Desfazer" do app) | JWT          |

### Billing

| Método | Url                       | Descrição                                                                 | Autenticação                       |
| ------ | ------------------------- | ------------------------------------------------------------------------- | ---------------------------------- |
| GET    | `/billing/plans`          | Catálogo de planos (id, preço, ciclo, trialDays, features)                | JWT                                |
| POST   | `/billing/trial`          | Trial de 7 dias (1 por conta) → `{ trialEndsAt }`                         | JWT                                |
| POST   | `/billing/checkout`       | Cria checkout Asaas → `{ checkoutUrl, expiresAt }`                        | JWT                                |
| POST   | `/billing/cancel`         | Cancela trial (local) ou assinatura (gateway) → `{ status }`              | JWT                                |
| POST   | `/billing/webhooks/asaas` | Webhook Asaas — fonte da verdade da ativação                              | Pública (header `asaas-access-token`) |

## Rate Limit

Proteção contra abuso e excesso de requests, implementada **em código** (sem AWS WAF): o decorator `@RateLimit` marca os controllers, o `lambdaHttpAdapter` aplica o enforcement centralizado e contadores **atômicos e condicionais** no DynamoDB (`RateLimitTable`) controlam a janela fixa. Requests bloqueados **não gravam** no banco, e as chaves de IP, de conta e de e-mail são **por rota** (`RL#ip#<rota>#<ip>`, `RL#account#<rota>#<id>` e `RL#email#<rota>#email#<email>` — rotas não disputam o mesmo contador; o e-mail é normalizado com `trim` + minúsculas).

**Custo:** o bloqueio ocorre dentro da Lambda, então um `429` ainda custa API Gateway (~$1,59/1M na `sa-east-1`) + invocação Lambda ($0,20/1M). Requests bloqueados **não** gravam no DynamoDB e **não** chamam Cognito/OpenAI — o volume atual fica coberto pelo free tier (1M requests/mês). Bloquear antes da invocação (WAF rate-based, ~$6/mês) fica como evolução futura.

**Limites por rota:**

| Rota | Escopo | Limite |
|---|---|---|
| `POST /auth/sign-up` | IP | 5 / 15min |
| `POST /auth/sign-in` | IP + email | 10 / 15min cada |
| `POST /auth/confirm-sign-up` | IP + email | 10 / 15min cada |
| `POST /auth/resend-confirmation-code` | IP + email | 3 / 15min cada |
| `POST /auth/refresh-token` | IP | 60 / 15min |
| `POST /auth/forgot-password` | IP + email | 5 / 15min (IP) e 5 / 1h (email) |
| `POST /auth/confirmation-forgot-password` | IP | 10 / 15min |
| `POST /auth/oauth/callback` | IP | 30 / 15min |
| `POST /auth/complete-onboarding` | IP | 30 / 15min |
| `POST /create-meal` | conta | 10 / 1h |
| `POST /meals/text` | conta | 10 / 1h |
| `POST /meals/{id}/items` | conta | 20 / 1h |
| `DELETE /meals/{id}` | conta | 30 / 1h |
| `DELETE /meals/{id}/items/{itemId}` | conta | 60 / 1h |
| `POST /meals/{id}/items/{itemId}/restore` | conta | 60 / 1h |
| `POST /billing/trial` | conta | 5 / 1h |
| `POST /billing/webhooks/asaas` | IP | 120 / 60s |

`POST /create-meal` conta cada tentativa, inclusive quando a refeição termina em `REJECTED`. `POST /meals/text` também conta cada tentativa, inclusive as que terminam em `422 NO_FOOD_IDENTIFIED`, e tem contador próprio (não divide o limite com o `create-meal`).

**Resposta `429`:**

```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "..."
  }
}
```

com header `Retry-After` em segundos.

### Exemplos de Uso

#### Sign Up -> `/auth/sign-up`

- Cadastra um novo usuário pendente e envia o código de confirmação por e-mail:

  ```bash
  curl -X POST https://xxx.execute-api.sa-east-1.amazonaws.com/auth/sign-up \
    -H "Content-Type: application/json" \
    -d '{
      "acceptedTerms": true,
      "account": {
        "email": "usuario@email.com",
        "password": "senha1234"
      },
      "profile": {
        "name": "João Silva",
        "birthDate": "1990-05-15",
        "gender": "MALE",
        "height": 175,
        "weight": 80,
        "activityLevel": "MODERATE",
        "goal": "LOSE"
      }
    }'
  ```

- Resposta esperada (`201`):
  ```json
  {
    "requiresConfirmation": true,
    "alreadyPending": false
  }
  ```

- Erros: `403 BETA_ACCESS_DENIED` (e-mail fora do beta), `409 EMAIL_ALREADY_IN_USE` (e-mail já confirmado), `429 TOO_MANY_ATTEMPTS`.

#### Confirm Sign Up -> `/auth/confirm-sign-up`

- Confirma o e-mail. A senha é obrigatória (ver "Fluxo de Cadastro por E-mail"):

  ```bash
  curl -X POST https://xxx.execute-api.sa-east-1.amazonaws.com/auth/confirm-sign-up \
    -H "Content-Type: application/json" \
    -d '{
      "email": "usuario@email.com",
      "confirmationCode": "123456",
      "password": "senha1234"
    }'
  ```

- Resposta esperada (`200`):
  ```json
  {
    "passwordResetRequired": false
  }
  ```

- `passwordResetRequired: true` significa que a senha não bateu e foi substituída; o usuário precisa criar uma nova pelo "esqueci a senha".
- Erros: `400 INVALID_CONFIRMATION_CODE`, `429 TOO_MANY_ATTEMPTS`.

#### Resend Confirmation Code -> `/auth/resend-confirmation-code`

- Reenvia o código para um cadastro pendente. Responde `204` mesmo se o e-mail não existir:

  ```bash
  curl -X POST https://xxx.execute-api.sa-east-1.amazonaws.com/auth/resend-confirmation-code \
    -H "Content-Type: application/json" \
    -d '{ "email": "usuario@email.com" }'
  ```

- Erros: `429 TOO_MANY_ATTEMPTS`, `502 CODE_DELIVERY_FAILED`.

#### Sign In -> `/auth/sign-in`

- Realiza login e retorna tokens:

  ```bash
  curl -X POST https://xxx.execute-api.sa-east-1.amazonaws.com/auth/sign-in \
    -H "Content-Type: application/json" \
    -d '{
      "email": "usuario@email.com",
      "password": "senha123"
    }'
  ```

- Resposta esperada:
  ```json
  {
    "accessToken": "eyJhbGciOiJSUzI1NiIs...",
    "refreshToken": "eyJhdWQiOiJYLmNv..."
  }
  ```

- Erros: `401 INVALID_CREDENTIALS`, `403 EMAIL_NOT_CONFIRMED` (cadastro ainda sem código confirmado), `429 TOO_MANY_ATTEMPTS`.

#### OAuth Callback -> `/auth/oauth/callback`

- Troca o `code` de autorização do Google por tokens (fluxo OAuth 2.0 Authorization Code + PKCE). O `codeVerifier` é o mesmo gerado no início do fluxo pelo frontend:

  ```bash
  curl -X POST https://xxx.execute-api.sa-east-1.amazonaws.com/auth/oauth/callback \
    -H "Content-Type: application/json" \
    -d '{
      "code": "4/0AfJohXnZ0x9y...",
      "redirectUri": "https://app.nacal.app/oauth/callback",
      "codeVerifier": "aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvV"
    }'
  ```

- Resposta esperada (`200`):
  ```json
  {
    "accessToken": "eyJhbGciOiJSUzI1NiIs...",
    "refreshToken": "eyJhdWQiOiJYLmNv...",
    "isOnboarded": false
  }
  ```

- `isOnboarded: false` indica um usuário novo — o backend cria a `Account` no DynamoDB com `isOnboarded: false`, então o frontend deve chamar `/auth/complete-onboarding` com o `accessToken` retornado. Para um usuário já registrado, `isOnboarded: true` e a conta existente é reutilizada. O `accessToken` já contém o claim `internalId` (usado como `accountId` nas rotas autenticadas).
- Erros: `400 INVALID_GRANT` (code inválido ou expirado, resposta do Cognito sem tokens ou token sem dados de identidade) e `400 VALIDATION` (body inválido). Timeout de 5s na troca de código com o Cognito.

#### Complete Onboarding -> `/auth/complete-onboarding`

- Cria o perfil e as metas nutricionais de um usuário do Google (a `Account` já foi criada no `OAuth Callback`). Identidade (nome, email, `externalId`) é derivada **do access token**, não do body:

```bash
  curl -X POST https://xxx.execute-api.sa-east-1.amazonaws.com/auth/complete-onboarding \
    -H "Content-Type: application/json" \
    -d '{
      "accessToken": "eyJhbGciOiJSUzI1NiIs...",
      "birthDate": "1990-05-15",
      "gender": "MALE",
      "height": 175,
      "weight": 80,
      "activityLevel": "MODERATE",
      "goal": "LOSE"
    }'
  ```

- Resposta esperada: `204 No Content`.
- O backend reutiliza a `Account` criada no callback, grava `Profile` e `Goal` e marca `isOnboarded: true` atomicamente (`TransactWriteCommand`).
- **Idempotente**: reexecutar após sucesso re-grava os mesmos itens com o mesmo `accountId` e retorna `204`.
- Erros: `409 EMAIL_ALREADY_IN_USE` (email já pertence a outra conta, `externalId` divergente), `400 INVALID_GRANT` (token inválido/expirado ou dados ausentes no Cognito), `404 ACCOUNT_NOT_FOUND` (token válido sem `Account` registrada) e `400 VALIDATION` (body inválido).
- Não é necessário trocar o token após o sucesso: o `accessToken` do callback já contém o claim `internalId`.

#### Get Me -> `/me`

- Retorna o `isOnboarded`, o perfil e as metas do usuário autenticado:

  ```bash
  curl -X GET https://xxx.execute-api.sa-east-1.amazonaws.com/me \
    -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIs..."
  ```

- Resposta esperada (usuário onboarded):
  ```json
  {
    "isOnboarded": true,
    "profile": {
      "name": "João Silva",
      "birthDate": "1990-05-15",
      "gender": "MALE",
      "height": 175,
      "weight": 80,
      "goal": "LOSE"
    },
    "goal": {
      "calories": 2200,
      "proteins": 165,
      "carbohydrates": 220,
      "fats": 73
    },
    "subscription": {
      "plan": "PRO",
      "planId": "PRO_MONTHLY",
      "status": "TRIALING",
      "trialEndsAt": "2026-10-13T12:00:00.000Z"
    },
    "mealQuota": { "used": 3, "limit": null, "remaining": null },
    "dailyMealQuota": { "used": 1, "limit": 20, "remaining": 19 }
  }
  ```

- `subscription` é `null` sem item de assinatura (plano FREE); `plan` é o **plano efetivo** derivado de `resolveEffectivePlan` (trial/pago vigente = `PRO`, vencido = `FREE`); `mealQuota` é a cota do mês: no FREE, `limit` é `20`; no PRO, `used` conta as refeições Pro do mês e `limit`/`remaining` são `null`. `dailyMealQuota` é `null` no FREE e, no PRO, traz a cota do dia (`limit` 20, dia em `America/Sao_Paulo`);
- Para um usuário que ainda não completou o onboarding, o endpoint responde `200` com `isOnboarded: false` e `profile`/`goal` como `null` — usado pelo frontend para decidir se encaminha o usuário ao onboarding.
- O `accountId` é resolvido a partir do claim `internalId` do access token; se o token não tiver o claim, retorna `401`. Se a conta não existir, retorna `404`.

#### Create Meal -> `/create-meal`

- Cria uma refeição e retorna dados do Presigned POST para upload:

  ```bash
  curl -X POST https://xxx.execute-api.sa-east-1.amazonaws.com/create-meal \
    -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIs..." \
    -H "Content-Type: application/json" \
    -d '{
      "contentType": "image/jpeg",
      "fileSize": 5242880,
      "timeZone": "America/Sao_Paulo",
      "description": "tinha um copo de suco de laranja também"
    }'
  ```

- `timeZone` é a zona IANA do dispositivo (ex.: `America/Sao_Paulo`, `Europe/Lisbon`), usada para nomear a refeição e definir em qual dia ela aparece; é opcional e cai em `America/Sao_Paulo` se ausente/inválida.
- `description` é opcional e só aceita fotos (em áudio retorna `400`): texto livre de até 300 caracteres após `trim`; string vazia é tratada como ausente. Não aparece nas respostas de leitura da refeição.
- `contentType` aceito: `image/jpeg` (até 10 MB), `audio/m4a` ou `audio/webm` (até 2 MB e 1–32s); `fileSize` é em bytes. A validação real do conteúdo acontece no processamento e um arquivo inválido vira `REJECTED`.
- **Cota**: consome 1 refeição na criação (Free sem cota no mês: `403 FREE_QUOTA_EXCEEDED`; Pro com 20 refeições no dia: `429 DAILY_MEAL_LIMIT_REACHED`). A cota volta se a refeição terminar em `REJECTED` ou `FAILED`.

- Resposta esperada:
  ```json
  {
    "mealId": "2CkS0wZr5cY3xK1mN7jQ9bT2vL",
    "uploadSignature": "eyJ1cmwiOiJodHRwczovL2FwaS1k..."
  }
  ```

- Upload no frontend (JavaScript):

  ```javascript
  // Decodificar a assinatura (uploadSignature) de base64
  const presignedData = JSON.parse(atob(response.uploadSignature));

  const formData = new FormData();

  // Adicionar fields do Presigned POST
  Object.entries(presignedData.fields).forEach(([key, value]) => {
    formData.append(key, value);
  });

  // Adicionar metadata e arquivo
  formData.append('X-Amz-meta-name', file.name);
  formData.append('file', file);

  // Upload direto para o S3
  await axios.post(presignedData.url, formData);
  ```

#### List Meals -> `/meals`

- Lista refeições de um dia específico. `date` é o **dia local** do usuário (`YYYY-MM-DD`), não o dia em UTC: a API compara direto com o dia gravado na refeição, calculado no fuso dela:

  ```bash
  curl -X GET "https://xxx.execute-api.sa-east-1.amazonaws.com/meals?date=2026-08-26" \
    -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIs..."
  ```

- Resposta esperada:
  ```json
  {
    "meals": [
      {
        "id": "2CkS0wZr5cY3xK1mN7jQ9bT2vL",
        "name": "Almoço",
        "icon": "🍽️",
        "foods": [
          {
            "name": "Arroz branco",
            "quantity": "200g",
            "proteins": 5.4,
            "carbohydrates": 53.4,
            "fats": 0.6,
            "calories": 254
          },
          {
            "name": "Feijão carioca",
            "quantity": "150g",
            "proteins": 9.8,
            "carbohydrates": 30.7,
            "fats": 0.5,
            "calories": 167
          },
          {
            "name": "Peito de frango grelhado",
            "quantity": "150g",
            "proteins": 46.5,
            "carbohydrates": 0,
            "fats": 5.4,
            "calories": 240
          }
        ],
        "createdAt": "2026-08-26T15:00:00.000Z",
        "timeZone": "America/Sao_Paulo"
      }
    ]
  }
  ```

- `timeZone` é o fuso em que a refeição foi registrada, já com o fallback `America/Sao_Paulo` aplicado (o mesmo usado para o dia e o nome). O app usa esse fuso para exibir a hora, então uma refeição registrada em viagem mantém a hora local de onde foi feita.

#### Get Meal By ID -> `/meals/{id}`

- Retorna uma refeição específica com detalhes dos alimentos:

  ```bash
  curl -X GET https://xxx.execute-api.sa-east-1.amazonaws.com/meals/2CkS0wZr5cY3xK1mN7jQ9bT2vL \
    -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIs..."
  ```

- Resposta esperada (refeição rejeitada):
  ```json
  {
    "id": "2CkS0wZr5cY3xK1mN7jQ9bT2vL",
    "status": "REJECTED",
    "rejectionReason": "NOT_A_MEAL",
    "inputFileType": "PICTURE",
    "inputFileUrl": null,
    "name": "",
    "icon": "",
    "foods": [],
    "canAddItems": false,
    "canRemoveItems": false,
    "unidentified": null,
    "createdAt": "2026-10-22T15:00:00.000Z"
  }
  ```

- Refeições por texto vêm com `inputFileType: "TEXT"` e `inputFileUrl: null` (não há arquivo).
- Em `REJECTED`, `inputFileUrl` é `null` porque o arquivo é removido do S3; `rejectionReason` indica o motivo (`INVALID_FILE`, `NOT_A_MEAL` ou `NO_FOOD_DETECTED`).
- `canAddItems` indica se a refeição ainda aceita `POST /meals/{id}/items` (status `SUCCESS`, dentro das 24h e abaixo dos limites); não considera a cota do plano Free.
- `unidentified` traz a categoria do que a IA viu e não conseguiu identificar na foto (`DRINK`, `PACKAGED`, `COVERED`, `OTHER`) ou `null`. Só vem preenchido enquanto `canAddItems` é `true` e nenhuma adição foi feita; depois disso volta `null` (o valor original continua salvo na refeição). Refeições por áudio, por texto e refeições antigas sempre trazem `null`.
- `canRemoveItems` indica se a refeição aceita remover e restaurar itens (status `SUCCESS`, sem janela de tempo). A regra de manter pelo menos um item fica no app, que oferece excluir a refeição no lugar.
- Cada alimento traz `id` e `order` (ordem estável usada para restaurar um item removido na mesma posição). Refeições antigas não têm esses campos gravados: a API devolve `id: "f<posição>"` e `order: <posição>`, e eles passam a ser gravados na primeira remoção. Também pode trazer `source`: `INITIAL` (identificado no processamento) ou `ADDED` (adicionado por texto); refeições antigas não têm esse campo.
- Refeições excluídas (`DELETED`) respondem `404`. A leitura é fortemente consistente, para refletir na hora uma edição recém-feita.

#### Create Text Meal -> `/meals/text`

- Cria uma refeição a partir de um texto e devolve a refeição já processada:

  ```bash
  curl -X POST https://xxx.execute-api.sa-east-1.amazonaws.com/meals/text \
    -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIs..." \
    -H "Content-Type: application/json" \
    -d '{
      "text": "no almoço comi 2 colheres de arroz, feijão, um bife e uma coca zero lata",
      "timeZone": "America/Sao_Paulo"
    }'
  ```

- `text` é obrigatório: 1 a 500 caracteres após `trim`. Fica salvo na refeição (em `description`) e não aparece nas respostas de leitura.
- `timeZone` segue a mesma regra do `create-meal` (nome, ícone e dia da refeição; fallback `America/Sao_Paulo`). A refeição entra no dia e na hora do envio; "no almoço comi…" só ajusta o nome e o ícone via `mealType`.
- A chamada à OpenAI é **síncrona** (GPT-5.4-mini, prompt `getTextMealPrompt`, Lambda com `timeout: 29`, ~1–2s). Ela tem timeout próprio de 12s com no máximo 1 retry (o mesmo vale para o `POST /meals/{id}/items`), então uma OpenAI lenta vira erro da própria Lambda antes do corte de 29s. O prompt reaproveita as regras do "Adicionar item" (nomes genéricos entram com versão típica, quantidade implausível é limitada, nomes só em português) e acrescenta: itens com macros zero (água, café preto, refrigerante zero) sempre entram, o que o usuário diz que **não** comeu fica de fora e "café" como bebida nunca vira café da manhã. O mesmo prompt analisa a transcrição dos áudios, numa variante que só troca a introdução.
- **Cota**: consome 1 refeição (do mês no Free, do dia no Pro), como foto e áudio, mas só quando dá certo. Ordem: checagem da cota antes da IA (`403` no Free, `429 DAILY_MEAL_LIMIT_REACHED` no Pro) → IA → `422` sem consumir → consumo atômico → gravação (estorno se a gravação falhar). Uma falha ou timeout durante a IA não deixa cota consumida.
- A refeição nasce `SUCCESS`, com `inputFileType: "TEXT"`, itens com `source: "INITIAL"` e `unidentified: null`; o `POST /meals/{id}/items` funciona nela como em qualquer refeição.

- Resposta esperada (`201`):
  ```json
  {
    "meal": {
      "id": "2CkS0wZr5cY3xK1mN7jQ9bT2vL",
      "status": "SUCCESS",
      "rejectionReason": null,
      "inputFileType": "TEXT",
      "inputFileUrl": null,
      "name": "Almoço",
      "icon": "🍽️",
      "foods": [
        { "name": "arroz branco", "quantity": "2 colheres (100g)", "calories": 130, "proteins": 2.5, "carbohydrates": 28, "fats": 0.3, "source": "INITIAL" },
        { "name": "Coca-Cola zero", "quantity": "350ml", "calories": 0, "proteins": 0, "carbohydrates": 0, "fats": 0, "source": "INITIAL" }
      ],
      "canAddItems": true,
      "unidentified": null,
      "createdAt": "2026-11-07T15:00:00.000Z"
    },
    "unidentifiedFoodsCount": 0
  }
  ```

- `unidentifiedFoodsCount`: menções que não dizem qual alimento era ("alguma coisa no pote", "um pacotinho") e foram descartadas; o app sugere completar pelo "Adicionar item".

- Erros:

  | Status | Código | Quando |
  |---|---|---|
  | `400` | `VALIDATION` | `text` vazio ou acima de 500 caracteres |
  | `403` | `FREE_QUOTA_EXCEEDED` | Usuário Free sem cota restante no mês (checado antes da IA) |
  | `422` | `NO_FOOD_IDENTIFIED` | A IA não encontrou nenhum alimento no texto, ou só menções que não dizem o que era; a cota não é consumida |
  | `429` | `DAILY_MEAL_LIMIT_REACHED` | Usuário Pro já registrou 20 refeições hoje (checado antes da IA) |
  | `429` | `RATE_LIMIT_EXCEEDED` | Mais de 10 chamadas na hora |

#### Add Meal Items -> `/meals/{id}/items`

- Adiciona itens a uma refeição já processada a partir de um texto curto:

  ```bash
  curl -X POST https://xxx.execute-api.sa-east-1.amazonaws.com/meals/2CkS0wZr5cY3xK1mN7jQ9bT2vL/items \
    -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIs..." \
    -H "Content-Type: application/json" \
    -d '{ "text": "um copo de coca 350ml" }'
  ```

- `text` é obrigatório: 1 a 300 caracteres após `trim`.
- A chamada à OpenAI é **síncrona** (GPT-5.4-mini, prompt `getAddItemsPrompt`, Lambda com `timeout: 29`). A IA recebe os itens já registrados em `<registered_items>` e o texto em `<user_note>` (com `<`/`>` neutralizados, tratados como dado) e devolve só os itens novos. Itens já registrados não são duplicados, exceto quando o usuário pede uma porção extra ("mais um arroz"), que entra como uma linha nova.
- Calorias calculadas no backend (`carbs*4 + prot*4 + fat*9`); os itens novos entram com `source: "ADDED"`.
- **Não consome cota**, mas responde `403 FREE_QUOTA_EXCEEDED` se o usuário Free já não tem cota no mês (checado antes da IA). O limite diário do Pro não bloqueia.
- Limites: até **5 adições por refeição**, só **até 24h** depois de `createdAt` e no máximo **30 itens**. O append é condicional no DynamoDB (status, janela, adições e itens), então requests concorrentes não furam os limites. Itens que a IA devolveu e não couberam são descartados e contados em `skippedFoodsCount`.

- Resposta esperada:
  ```json
  {
    "meal": {
      "id": "2CkS0wZr5cY3xK1mN7jQ9bT2vL",
      "status": "SUCCESS",
      "foods": [
        { "name": "Arroz branco", "quantity": "150g", "calories": 195, "proteins": 4, "carbohydrates": 42, "fats": 0.5, "source": "INITIAL" },
        { "name": "Coca-Cola", "quantity": "350ml", "calories": 140, "proteins": 0, "carbohydrates": 35, "fats": 0, "source": "ADDED" }
      ],
      "canAddItems": true,
      "unidentified": null,
      "...": "demais campos iguais ao GET /meals/{id}"
    },
    "addedFoods": [
      { "name": "Coca-Cola", "quantity": "350ml", "calories": 140, "proteins": 0, "carbohydrates": 35, "fats": 0, "source": "ADDED" }
    ],
    "skippedFoodsCount": 0,
    "unidentifiedFoodsCount": 0
  }
  ```

- `skippedFoodsCount`: itens identificados que ficaram de fora porque a refeição chegou ao limite de 30 itens.
- `unidentifiedFoodsCount`: menções que não dizem qual alimento era ("alguma coisa no pote", "um pacotinho") e foram descartadas. Nomes genéricos de comida ou bebida ("uma bebida", "um suco", "pão") entram com uma versão típica.

- Erros:

  | Status | Código | Quando |
  |---|---|---|
  | `404` | `RESOURCE_NOT_FOUND` | Refeição não existe ou é de outra conta |
  | `409` | `MEAL_NOT_EDITABLE` | Refeição não está `SUCCESS` ou passou da janela de 24h |
  | `409` | `MEAL_ITEM_LIMIT_REACHED` | 5 adições já feitas ou 30 itens na refeição |
  | `422` | `NO_FOOD_IDENTIFIED` | A IA não encontrou nenhum alimento no texto, ou só encontrou menções que não dizem o que era ("alguma coisa no pote", "um pacotinho"), que são descartadas |
  | `403` | `FREE_QUOTA_EXCEEDED` | Usuário Free sem cota restante no mês |
  | `429` | `RATE_LIMIT_EXCEEDED` | Mais de 20 chamadas na hora |

#### Delete Meal -> `/meals/{id}`

- Exclui uma refeição:

  ```bash
  curl -X DELETE https://xxx.execute-api.sa-east-1.amazonaws.com/meals/2CkS0wZr5cY3xK1mN7jQ9bT2vL \
    -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIs..."
  ```

- Responde `204` sem corpo. É um soft delete: a refeição fica com `status: "DELETED"` e `deletedAt`, sai da listagem (que só traz `SUCCESS`) e passa a responder `404` nas outras rotas. Depois, o arquivo de entrada é removido do S3; se essa remoção falhar, o erro vai para o log e a resposta continua `204`.
- **Não estorna a cota** do mês.
- Aceita refeições `SUCCESS`, `REJECTED` e `FAILED`. Durante o processamento (`UPLOADING`, `QUEUED`, `PROCESSING`) responde `409 MEAL_NOT_EDITABLE`, para não disputar a refeição com o `processMeal`.
- Uma refeição já excluída responde `404`; o app trata isso como sucesso.

- Erros:

  | Status | Código | Quando |
  |---|---|---|
  | `404` | `RESOURCE_NOT_FOUND` | Refeição não existe, já foi excluída ou é de outra conta |
  | `409` | `MEAL_NOT_EDITABLE` | Refeição ainda em processamento |
  | `429` | `RATE_LIMIT_EXCEEDED` | Mais de 30 chamadas na hora |

#### Remove Meal Item -> `/meals/{id}/items/{itemId}`

- Remove um item de uma refeição `SUCCESS`:

  ```bash
  curl -X DELETE https://xxx.execute-api.sa-east-1.amazonaws.com/meals/2CkS0wZr5cY3xK1mN7jQ9bT2vL/items/2CkS1aBc9dE8fG7hI6jK5lM4nO \
    -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIs..."
  ```

- Responde `200` com `{ "meal": { ... } }` (mesmos campos do `GET /meals/{id}`).
- Sem IA e sem janela de 24h. O item sai de `foods` e vai para `removedFoods` (com `removedAt`), que guarda os itens para o "Desfazer" e serve de métrica de erro da IA; `editedAt` é atualizado. `itemAdditions` e `unidentified` não mudam, e um item removido libera vaga no limite de 30 itens.
- É idempotente: remover um item que já está em `removedFoods` devolve a refeição sem mudar nada.
- A gravação usa trava otimista pelo contador `foodsVersion` (incrementado também pelo `POST /meals/{id}/items`), com leitura consistente e até 3 tentativas, então remoções e adições concorrentes não se sobrescrevem.

- Erros:

  | Status | Código | Quando |
  |---|---|---|
  | `404` | `RESOURCE_NOT_FOUND` | Refeição ou item não existe |
  | `409` | `MEAL_NOT_EDITABLE` | Refeição não está `SUCCESS` |
  | `409` | `MEAL_LAST_ITEM` | É o último item da refeição (exclua a refeição) |
  | `429` | `RATE_LIMIT_EXCEEDED` | Mais de 60 chamadas na hora |

#### Restore Meal Item -> `/meals/{id}/items/{itemId}/restore`

- Devolve um item removido para a refeição, na posição original (pela `order` do item):

  ```bash
  curl -X POST https://xxx.execute-api.sa-east-1.amazonaws.com/meals/2CkS0wZr5cY3xK1mN7jQ9bT2vL/items/2CkS1aBc9dE8fG7hI6jK5lM4nO/restore \
    -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIs..."
  ```

- Responde `200` com `{ "meal": { ... } }`. É idempotente: restaurar um item que já está em `foods` devolve a refeição sem mudar nada.

- Erros:

  | Status | Código | Quando |
  |---|---|---|
  | `404` | `RESOURCE_NOT_FOUND` | Refeição não existe ou o item não está em `removedFoods` |
  | `409` | `MEAL_NOT_EDITABLE` | Refeição não está `SUCCESS` |
  | `409` | `MEAL_ITEM_LIMIT_REACHED` | A refeição já tem 30 itens |
  | `429` | `RATE_LIMIT_EXCEEDED` | Mais de 60 chamadas na hora |

#### Get Plans -> `/billing/plans`

- Catálogo de planos (fonte única `Subscription.Plan`):

  ```bash
  curl -X GET https://xxx.execute-api.sa-east-1.amazonaws.com/billing/plans \
    -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIs..."
  ```

- Resposta esperada:
  ```json
  {
    "plans": [
      {
        "id": "PRO_MONTHLY",
        "name": "Pro Mensal",
        "price": 999,
        "cycle": "MONTHLY",
        "trialDays": 7,
        "features": ["Até 20 refeições AI por dia"]
      },
      {
        "id": "PRO_YEARLY",
        "name": "Pro Anual",
        "price": 8990,
        "cycle": "YEARLY",
        "trialDays": 7,
        "features": ["Até 20 refeições AI por dia"]
      }
    ]
  }
  ```

#### Start Trial -> `/billing/trial`

- Ativa o trial de 7 dias (sem gateway; 1 por conta):

  ```bash
  curl -X POST https://xxx.execute-api.sa-east-1.amazonaws.com/billing/trial \
    -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIs..."
  ```

- Resposta esperada:
  ```json
  { "trialEndsAt": "2026-10-13T12:00:00.000Z" }
  ```

- Segunda tentativa na mesma conta → `409 TRIAL_NOT_AVAILABLE`.

#### Create Checkout -> `/billing/checkout`

- Cria o checkout hospedado no Asaas (mensal: recorrente só cartão; anual: Pix/cartão):

  ```bash
  curl -X POST https://xxx.execute-api.sa-east-1.amazonaws.com/billing/checkout \
    -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIs..." \
    -H "Content-Type: application/json" \
    -d '{ "planId": "PRO_MONTHLY", "returnUrl": "https://app.exemplo.com/billing/return" }'
  ```

- Resposta esperada:
  ```json
  { "checkoutUrl": "https://sandbox.asaas.com/checkout/...", "expiresAt": "2026-10-06T13:00:00.000Z" }
  ```

- `planId` fora do catálogo → `400`; `returnUrl` precisa passar pelo allowlist de `APP_WEB_URL` (origin exato ou prefixo `origin/`).

#### Cancel -> `/billing/cancel`

- Cancela trial (downgrade local) ou assinatura paga (cancela no gateway):

  ```bash
  curl -X POST https://xxx.execute-api.sa-east-1.amazonaws.com/billing/cancel \
    -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIs..."
  ```

- Resposta esperada:
  ```json
  { "status": "CANCELED" }
  ```

- Assinatura paga mantém o acesso PRO até `paidUntil` + carência de 3 dias.

#### Asaas Webhook -> `/billing/webhooks/asaas`

- Recebe eventos do Asaas (rota pública; valida o header `asaas-access-token`):

  ```bash
  curl -X POST https://xxx.execute-api.sa-east-1.amazonaws.com/billing/webhooks/asaas \
    -H "Content-Type: application/json" \
    -H "asaas-access-token: SEU_ASAAS_WEBHOOK_TOKEN" \
    -d '{ "event": "PAYMENT_CONFIRMED", "id": "evt_1a2b3c", "payment": { "id": "pay_...", "subscription": "sub_..." } }'
  ```

- Resposta esperada:
  ```json
  { "received": true }
  ```

- IP fora da allowlist → `403 FORBIDDEN` (checado antes do rate limit e do token); acima de 120 req/min no mesmo IP → `429` com `Retry-After`; token inválido → `502 BILLING_ERROR`; evento desconhecido → `200` com `{"received": false}`; processamento é idempotente por `event.id` (dedup de 14 dias na RateLimitTable).

## Eventos

### Triggers Cognito

| Trigger            | Função                      | Descrição                                                                |
| ------------------ | --------------------------- | ------------------------------------------------------------------------ |
| PreSignUp          | `preSignUpTrigger`          | Aplica o beta fechado (cadastro por e-mail e Google); em `PreSignUp_ExternalProvider` cria usuário nativo "shadow" (`custom:internalId`) ou reaproveita o nativo existente (confirmando-o se estava pendente) e vincula o Identity Provider. Cadastros por e-mail **não** são mais auto-confirmados |
| PreTokenGeneration | `preTokenGenerationTrigger` | Injeta o claim `internalId` no access token a partir de `custom:internalId` |
| CustomMessage      | `customMessageTrigger`      | Personaliza em português os e-mails de confirmação de cadastro, reenvio de código e recuperação de senha |

### Eventos S3

| Evento        | Função                   | Descrição                                                                                        |
| ------------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| ObjectCreated | `newMealUploadedTrigger` | Quando um arquivo é enviado ao S3, lê metadados, atualiza status para QUEUED e publica na fila SQS |

### Filas SQS

| Fila       | Função        | Descrição                                                         |
| ---------- | ------------- | ----------------------------------------------------------------- |
| MealsQueue | `processMeal` | Consome mensagens e processa refeições via OpenAI; alarme quando a mensagem mais antiga passa de 2 min |
| MealsDLQ   | --            | Dead Letter Queue para falhas inesperadas que esgotaram as entregas da fila |
| MealUploadCheckQueue | `checkMealUpload` | Mensagem atrasada 15 min por refeição de foto/áudio; marca `FAILED` e estorna a cota se a refeição ficou presa |
| MealUploadCheckDLQ   | --                | Dead Letter Queue da checagem, com alarme |

## Tecnologias Utilizadas

### Backend

- Serverless Framework v4;
- AWS (Lambda, API Gateway HTTP API, DynamoDB, S3, CloudFront, SQS, SNS, Cognito, SES);
- TypeScript;
- Zod (validação de schemas);
- esbuild (bundling);
- OpenAI API (GPT-5.4-mini, GPT-4o-mini-transcribe);
- Cloudflare Workers AI (Clef-flash, gate de foto);
- Asaas (gateway de pagamento — checkout hospedado + webhook);
- `image-size` e `music-metadata` (validação de imagens e áudios);
- KSUID (geração de IDs únicos);
- reflect-metadata (injeção de dependência via decorators).

## Recursos Criados na AWS

### DynamoDB

- **Table**: `nacal-api-{stage}-MainTable`
  - Single-table design com entidades: Account, Profile, Goal, Meal, PendingSignUp
  - `Account` armazena `isOnboarded` (indica se o usuário completou o onboarding; `false` até `complete-onboarding` gravar `Profile`/`Goal`), `termsVersion` e `termsAcceptedAt`
  - `PendingSignUp` guarda perfil e aceite de termos de um cadastro por e-mail até a confirmação; expira por TTL (`expiresAt`, 24h)
  - Proteção contra deleção ativa só no stage `prod`
  - Billing: PAY_PER_REQUEST
  - Point-in-time recovery: 35 dias
  - GSI1 para consultas por email e data

- **Table**: `nacal-api-{stage}-RateLimitTable`
  - Contadores de rate limit por janela (`PK = RL#<scope>#<chave>`, `SK = bucket da janela`)
  - TTL em `expiresAt` para expirar janelas automaticamente
  - Billing: PAY_PER_REQUEST

### Cognito

- **UserPool**: `nacal-api-{stage}-UserPool`
  - Auth flow: USER_PASSWORD_AUTH
  - Username attribute: email
  - Senha: mínimo 8 caracteres
  - Access token: 1 dia
  - Refresh token: 7 dias (com rotação)
- **UserPoolClient**: `nacal-api-{stage}-UserPoolClient`
- **Google Identity Provider**: Login com Google (Authorization Code + PKCE), scopes `profile email openid`, mapeamento de `name` e `email`, callback para o domínio do frontend

### S3

- **Bucket**: `nacal-api-{stage}-meals-bucket`
  - Armazenamento de arquivos de refeição (imagens e áudios)
  - CORS configurado para o frontend
  - Eventos de object creation habilitados

### CloudFront

- **Distribution**: CDN para servir arquivos de refeição
  - OAC (Origin Access Control) configurado com o S3
  - Suporte a domínio personalizado

### SQS

- **MealsQueue**: Fila para processamento assíncrono de refeições, com alarme por email (SNS) quando a mensagem mais antiga passa de 2 min (`MealsQueueAgeAlarm`)
- **MealsDLQ**: Dead Letter Queue com alarme por email (SNS)
- **MealUploadCheckQueue**: Fila da checagem de refeição presa (atraso de 15 min por mensagem)
- **MealUploadCheckDLQ**: Dead Letter Queue da checagem, com alarme por email (SNS)

### EventBridge

- **Regra agendada** (`rate(1 hour)`) que dispara a Lambda `reconcilePayments` (reconciliação de pagamentos do Asaas); ligada só quando `ASAAS_BASE_URL` aponta para a API de produção do Asaas, com alarme de erros da Lambda por email (SNS)

### API Gateway

- HTTP API v2 com CORS habilitado
- JWT Authorizer configurado com o Cognito UserPool para rotas protegidas
- Rotas de OAuth (`/auth/oauth/callback` e `/auth/complete-onboarding`) são públicas e validam o `accessToken` no body
- Rotas `/billing/*` são protegidas por JWT, exceto `POST /billing/webhooks/asaas` (pública, endurecida com allowlist de IP dos IPs oficiais do Asaas, rate limit por IP 120/60s; valida o header `asaas-access-token`; `reservedConcurrency: 5`)
- Suporte a domínio personalizado (opcional)

## Variáveis de Ambiente

### Deploy (`.env`)

| Variável                    | Descrição                                               | Obrigatório |
| --------------------------- | ------------------------------------------------------- | ----------- |
| `COGNITO_EMAIL`             | Endereço de email remetente para o Cognito              | Sim         |
| `COGNITO_EMAIL_TO_REPLY`    | Endereço de email para respostas                        | Sim         |
| `SES_SOURCE_ARN`            | ARN da identidade SES verificada usada pelo Cognito       | Sim         |
| `API_DOMAIN_NAME`           | Domínio personalizado da API (ex: `api.nacal.app`) | Não         |
| `API_CERTIFICATE_ARN`       | ARN do certificado ACM para o domínio da API            | Não         |
| `CORS_ALLOWED_ORIGINS`      | Origens permitidas no HTTP API (vírgula). Vazio = `*` em dev; em prod use `https://app.nacal.app` | Não (recomendado em prod) |
| `MEALS_CDN_DOMAIN_NAME`     | Domínio personalizado do CloudFront para arquivos       | Não         |
| `MEALS_CDN_CERTIFICATE_ARN` | ARN do certificado ACM para o CDN                       | Não         |
| `DLQ_ALARM_EMAIL`           | Email para notificações de falha no processamento       | Sim         |
| `OPENAI_API_KEY`            | Chave de API do OpenAI                                  | Sim         |
| `CLOUDFLARE_ACCOUNT_ID`     | Account ID do Cloudflare Workers AI (gate de foto)      | Não (sem credenciais o gate fica `SKIP`) |
| `CLOUDFLARE_AI_API_TOKEN`   | Token do Workers AI com permissões de leitura/edição    | Não (sem credenciais o gate fica `SKIP`) |
| `MEAL_GATE_ENABLED`         | Liga/desliga o gate de foto (`true`/`1` ou `false`/`0`) | Não (default `true`) |
| `MEAL_GATE_REJECT_THRESHOLD` | Score mínimo para aceitar a foto; abaixo dele, rejeita | Não (default `0.30`) |
| `ASAAS_BASE_URL`            | URL base da API Asaas (sandbox: `https://api-sandbox.asaas.com`) | Sim |
| `ASAAS_API_KEY`             | Chave de acesso da Asaas (enviada como `access_token`)  | Sim         |
| `ASAAS_WEBHOOK_TOKEN`       | Token esperado no header `asaas-access-token` do webhook | Sim        |
| `ASAAS_WEBHOOK_ALLOWED_IPS` | Allowlist de IPs de origem do webhook (separada por vírgula). Padrão: IPs oficiais de produção do Asaas. `*` desabilita (dev/sandbox) | Não (default = 4 IPs de produção) |
| `APP_WEB_URL`               | Origin do app web (sem path nem barra final) — allowlist da `returnUrl` do checkout e `AllowedOrigin` do CORS do bucket de refeições | Sim        |
| `BETA_GATE_ENABLED`         | Liga o beta fechado (`true`/`1`); um valor não reconhecido mantém o beta **fechado** | Não (default `false`) |
| `BETA_ALLOWED_EMAILS`       | E-mails liberados no beta, separados por vírgula. Vai para todas as funções (limite de 4 KB de env do Lambda; o `check:prod` avisa acima de 1 KB) | Não |
| `GOOGLE_CLIENT_ID`          | Client ID do provider Google no Cognito                 | Sim (login Google) |
| `GOOGLE_CLIENT_SECRET`      | Client secret do provider Google no Cognito             | Sim (login Google) |

### Runtime (auto-injetadas pelo Serverless)

| Variável                | Fonte                                 |
| ----------------------- | ------------------------------------- |
| `COGNITO_CLIENT_ID`     | `!Ref UserPoolClient`                 |
| `COGNITO_USER_POOL_ID`  | `!Ref UserPool`                       |
| `COGNITO_CLIENT_SECRET` | `!GetAtt UserPoolClient.ClientSecret` |
| `MAIN_TABLE_NAME`       | `!Ref MainTable`                      |
| `RATE_LIMIT_TABLE_NAME` | `!Ref RateLimitTable`                 |
| `MEALS_BUCKET_NAME`     | `!Ref MealsBucket`                    |
| `MEALS_CDN_DOMAIN_NAME` | CloudFront domain ou fallback do env  |
| `MEALS_QUEUE_URL`       | `!Ref MealsQueue`                     |

## Arquitetura do Código

```
src/
├── kernel/                    # Camada de framework/DI
│   ├── decorators/            # @Injectable(), @Schema(), @RateLimit(), @IpAllowlist()
│   └── di/                    # Registry (container de DI singleton)
│
├── shared/                    # Utilitários compartilhados
│   ├── config/                # AppConfig, validação de env (Zod)
│   └── utils/                 # generateUniqueId, ValueOf
│
├── main/                      # Entry points (handlers Lambda)
│   ├── adapters/              # Adaptadores Lambda -> Controller/EventHandler/SQSHandler
│   ├── utils/                 # Body parser, response builders
│   └── functions/             # Handlers organizados por domínio
│       ├── auth/              # signUp, signIn, refreshToken, forgotPassword, triggers
│       ├── meal/              # createMeal, listMeals, getMealById, addMealItems, processMeal, uploadTrigger
│       ├── account/           # me
│       ├── profile/           # updateProfile
│       └── billing/           # plans, trial, checkout, cancel, webhookAsaas
│
├── application/               # Lógica de negócio
│   ├── contracts/             # Controller, IEventHandler, ISQSHandler, IPaymentGateway
│   ├── entities/              # Account, Profile, Goal, Meal, Subscription
│   ├── services/              # GoalCalculator, RateLimitService, MealQuotaService,
│   │                          # MealNamingService, MealFileValidationService
│   ├── useCases/              # Use cases organizados por domínio
│   ├── controllers/           # Controllers com schemas Zod
│   ├── presenters/            # MealPresenter (formato de saída da refeição)
│   ├── query/                 # Queries diretas ao DynamoDB
│   ├── events/                # MealUploadedEventHandler
│   ├── queues/                # MealQueueConsumer
│   └── errors/                # ErrorCode, ApplicationError, HttpError, MealRejectedError
│
└── infra/                     # Integrações externas
    ├── clients/               # Clients AWS SDK (DynamoDB, Cognito, S3, SQS)
    ├── databases/dynamodb/    # Repositories + Item mappers + Unit of Work
    ├── gateways/              # AuthGateway, MealFileStorageGateway, MealQueueGateway,
    │                          # AsaasPaymentGateway
    ├── ai/                    # Integrações de IA
    │   ├── gateways/          # MealAiGateway (OpenAI) e MealGateGateway (Clef-flash)
    │   └── prompts/           # Prompts de análise (PT-BR)
    └── utils/                 # downloadByURL
```

### Padrões Arquiteturais

- **Clean Architecture / Hexagonal**: Separação clara entre `application` (negócio), `infra` (integrações), `main` (entry points), `kernel` (framework) e `shared` (utilitários);
- **Injeção de Dependência customizada**: Container DI singleton (`Registry`) com decorator `@Injectable()` usando `reflect-metadata` para resolução automática de construtores;
- **Schema Validation Decorator**: `@Schema(zodSchema)` nos controllers para validação automática do request body;
- **Controller Pattern**: Classe abstrata `Controller<'public' | 'private'>` distinguindo rotas autenticadas vs públicas;
- **Rate Limit declarativo**: decorator `@RateLimit` (IP/email/conta) nos controllers + enforce centralizado no `lambdaHttpAdapter` com contadores atômicos condicionais no DynamoDB;
- **IP Allowlist declarativo**: decorator `@IpAllowlist((config) => …)` apontando a lista de IPs permitida + enforcement no `lambdaHttpAdapter` (403 antes do rate limit), usado pelo webhook Asaas com os IPs oficiais do gateway (env `ASAAS_WEBHOOK_ALLOWED_IPS`);
- **Unit of Work**: Transações DynamoDB (`TransactWriteCommand`) para escrita atômica de múltiplas entidades;
- **Event-Driven Processing**: S3 Event -> SQS -> Lambda para processamento assíncrono de refeições;
- **Single-Table DynamoDB**: Todas as entidades em uma tabela com chaves compostas e GSIs;
- **Gateway Pattern**: Camada de abstração para serviços externos (Auth, Storage, Queue, AI);

## Comandos Úteis

```bash
# Deploy completo
sls deploy

# Deploy de função específica
sls deploy function -f createMeal

# Visualizar logs
sls logs -f processMeal --t

# Desenvolvimento local
sls dev

# Remover stack
sls remove
```

## Recriando a Stack do Zero

Necessário quando é preciso destruir e recriar todos os recursos, por exemplo depois de uma falha de deploy com resources presos. **Alerta: apaga todos os usuários do UserPool e os dados da DynamoDB** (ok em ambiente de dev sem dados reais).

1. Remova o stack e aguarde a deleção terminar (o CloudFormation pode levar alguns minutos). Não faça o deploy antes disso — o Framework falha com "Stack ... is in DELETE_IN_PROGRESS state and can not be updated":

   ```bash
   sls remove

   aws cloudformation describe-stacks --stack-name nacal-api-{stage}
   # Repita até o comando responder "does not exist"
   ```

2. O `sls remove` não apaga alguns resíduos que podem travar o novo deploy — remova manualmente:

   - **Log group do custom resource** (o Framework não remove): 
     ```bash
     aws logs delete-log-group --log-group-name /aws/lambda/nacal-api-{stage}-custom-resource-existing-s3
     ```
   - **Bucket órfão** do `MealsBucket` (`DeletionPolicy: Retain`), se ainda existir:
     ```bash
      aws s3 rb s3://nacal-api-{stage}-meals-bucket --force
     ```

3. Caso use `MEALS_CDN_DOMAIN_NAME`: garanta que o CNAME na zona de DNS **não aponte para a distribuição CloudFront antiga/deletada** (o CloudFront rejeita criar o alias enquanto o DNS apontar para outro CloudFront). Corrija o registro de DNS antes de continuar — ver "Configurar o CDN na zona de DNS" no passo a passo.

4. Aguarde o "cooldown" do domínio do UserPool (`nacal-dev.auth.sa-east-1.amazoncognito.com`), se o deploy falhar com domínio indisponível, aguarde alguns minutos e rode o deploy novamente.

5. Rode o deploy e recrie o CNAME do CDN apontando para o domain da nova distribuição:

   ```bash
   sls deploy
   ```

## Troubleshooting

### Deploy falha com erro de permissão
- Verifique se as credenciais AWS estão configuradas corretamente;
- Confirme que o IAM user tem a política **AdministratorAccess**;
- Verifique se o Serverless Framework está logado: `sls login`.

### Upload de refeição não dispara processamento
- Verifique se o evento `ObjectCreated` está configurado no bucket S3;
- Confirme que a permissão `s3:GetObject` está configurada na Lambda `newMealUploadedTrigger`;
- Verifique os logs da Lambda no CloudWatch.

### Refeição fica com status REJECTED
- É uma rejeição esperada, não uma falha de infraestrutura: arquivo inválido, foto sem comida/bebida ou áudio sem fala/alimentos;
- Consulte `rejectionReason` em `GET /meals/{id}`: `INVALID_FILE`, `NOT_A_MEAL` ou `NO_FOOD_DETECTED`;
- A cota é estornada e `inputFileUrl` retorna `null`; o arquivo é removido do S3;
- Para falso positivo do gate de foto, revise `MEAL_GATE_REJECT_THRESHOLD` e os logs `meal_gate`/`meal_gate_error` no CloudWatch.

### Refeição fica com status FAILED
- Verifique os logs da Lambda `processMeal` no CloudWatch;
- Confirme que a `OPENAI_API_KEY` está configurada e é válida;
- Verifique se o formato do arquivo é suportado (imagens: JPEG; áudios: M4A, WebM);
- Após 2 tentativas, a refeição fica `FAILED`, a cota é estornada, o arquivo é removido e a mensagem é descartada; falhas inesperadas que esgotam as 3 entregas da fila vão para a Dead Letter Queue e disparam alarme por email.

### Erro 401 / Token inválido
- Verifique se o header `Authorization: Bearer <token>` está sendo enviado;
- Confirme que o token não expirou (validade de 1 dia);
- Use o endpoint `/auth/refresh-token` para obter um novo token.

### Erro 429 / Rate limit excedido
- Verifique o header `Retry-After` da resposta para saber quando tentar novamente;
- Confirme qual escopo estourou (IP, email ou conta) na tabela `RateLimitTable` no DynamoDB (consulta por `PK = RL#<scope>#<chave>`);
- Requests bloqueados **não** incrementam o contador — o limite é por janela fixa e recomeça ao expirar;
- `DAILY_MEAL_LIMIT_REACHED` não é rate limit: é a cota diária do Pro (contador `RL#account-daily#<id>`, SK `YYYY-MM-DD`), que recomeça à meia-noite de Brasília;
- Se precisar ajustar um limite, basta alterar o decorator `@RateLimit` no controller correspondente.

### Erro de CORS
- O CORS do HTTP API vem de `sls/config/cors.js`: `CORS_ALLOWED_ORIGINS` vazio libera todas as origens (dev); em produção use só `https://app.nacal.app`;
- O upload direto para o S3 usa o CORS do bucket, cuja origem é `APP_WEB_URL` exata (sem barra final);
- Após mudanças, faça novo deploy: `sls deploy`.

### Confirmação de e-mail
- `403 EMAIL_NOT_CONFIRMED` no login: o cadastro ainda não foi confirmado; use `POST /auth/resend-confirmation-code` e depois `POST /auth/confirm-sign-up`;
- `passwordResetRequired: true` na confirmação: a senha enviada não era a do cadastro; o usuário cria uma nova pelo "esqueci a senha";
- Usuário confirmado pelo console do Cognito não fica com `email_verified = true`, e o `GET /me` não recria a conta; marque o atributo com `aws cognito-idp admin-update-user-attributes ... Name=email_verified,Value=true`.

### Erro ao cadastrar usuário (Sign Up)
- Verifique se o `COGNITO_EMAIL` e `SES_SOURCE_ARN` estão configurados;
- Confirme que o SES está no modo production ou verificado para o email de destino;
- Verifique os logs da Lambda `signUp` no CloudWatch.

### Processamento de áudio falha
- Verifique se o arquivo de áudio não está corrompido;
- Confirme que o formato é suportado (M4A ou WebM, 1–32s e até 2 MB);
- Verifique se a `OPENAI_API_KEY` tem acesso ao modelo `gpt-4o-mini-transcribe`;
- Áudio sem fala ou sem alimentos vira `REJECTED` (`NO_FOOD_DETECTED`), não `FAILED`.

### "The provider Google does not exist for User Pool"
- Erro de corrida ao criar o `UserPoolClient` antes do `GoogleIdentityProvider` (o client referencia o provider `Google` por nome);
- Já mitigado com `DependsOn: GoogleIdentityProvider` no `UserPoolClient` em `sls/resources/userPool.yaml`; se reaparecer, é uma corrida de criação do CloudFormation — reexecute o deploy.

### CloudFront: "incorrectly configured DNS record that points to another CloudFront distribution"
- O CNAME de `MEALS_CDN_DOMAIN_NAME` está apontando para uma distribuição CloudFront antiga/deletada;
- Corrija o registro de DNS (aponte para longe ou apague), rode o `sls deploy` e recrie o CNAME apontando para o domain da nova distribuição (ver "Configurar o CDN na zona de DNS").

### Deploy falha porque o log group do custom resource existe
- O `sls remove` não apaga o log group `/aws/lambda/nacal-api-{stage}-custom-resource-existing-s3`;
- Remova manualmente antes de um novo deploy:

  ```bash
  aws logs delete-log-group --log-group-name /aws/lambda/nacal-api-{stage}-custom-resource-existing-s3
  ```

### Alarme de Dead Letter Queue
- O alarme dispara para falhas inesperadas que esgotaram as 3 entregas da fila, não para rejeições (`REJECTED`) nem para o `FAILED` tratado na 2ª tentativa;
- Verifique o email configurado em `DLQ_ALARM_EMAIL`;
- Analise os logs da Lambda `processMeal` para identificar a causa raiz;
- Verifique se há falhas de rede ou timeout na chamada à API do OpenAI;
