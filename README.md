# NaCal API

API serverless para um diário alimentar inteligente com inteligência artificial. O sistema permite que os usuários registrem suas refeições através de **fotos** ou **áudios**, que são analisados automaticamente por IA para identificar os alimentos, estimar quantidades e calcular macronutrientes (proteínas, carboidratos e gorduras). O sistema também calcula metas diárias personalizadas de calorias e macros com base no perfil do usuário.

## Funcionalidades

- **Autenticação completa**: Cadastro, login, refresh token e recuperação de senha via AWS Cognito;
- **Login com Google (OAuth 2.0 + PKCE)**: Autenticação via Google Identity Provider do Cognito com callback e onboarding automático do novo usuário;
- **Perfil do usuário**: Cadastro de dados pessoais (nome, data de nascimento, gênero, altura, peso, nível de atividade e objetivo);
- **Metas nutricionais**: Cálculo automático de calorias e macronutrientes diários com base no perfil (TDEE/BMR);
- **Upload de refeições**: Upload de fotos (JPEG) ou áudios (M4A, WebM) via Presigned POST do S3;
- **Análise por IA**: Identificação automática de alimentos com quantities e macronutrientes via IA;
- **Transcrição de áudio**: Transcrição automática de áudio via IA antes da análise;
- **Processamento assíncrono**: Fila SQS para processamento de refeições com retry automático;
- **CDN para arquivos**: CloudFront para servir os arquivos de refeição;
- **Alarmes**: Notificação por email quando refeições falham (Dead Letter Queue);
- **Rate limiting**: Proteção por IP, e-mail e conta com resposta `429 RATE_LIMIT_EXCEEDED` e header `Retry-After` — implementado em código com contadores atômicos no DynamoDB (sem WAF);
- **Planos e assinatura**: plano Free com **20 refeições AI/mês** e Pro ilimitado; **trial de 7 dias** sem cartão (1 por conta), checkout hospedado no **Asaas** (mensal recorrente só cartão; anual Pix/cartão), webhook idempotente como fonte da verdade e downgrade lazy na expiração;

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

## Fluxo de Processamento de Refeições

### 1. Upload e Criação
1. Usuário envia `POST /create-meal` com `{ contentType, fileSize }`;
2. Backend cria a refeição no DynamoDB (status: `PENDING`) e retorna um `mealId` junto com dados do Presigned POST (base64);
3. Frontend faz upload direto para o S3 usando o Presigned POST;
4. S3 recebe o arquivo e dispara evento `ObjectCreated`.

### 2. Processamento Assíncrono
5. Lambda `newMealUploadedTrigger` é acionada pelo evento S3;
6. Atualiza o status da refeição para `QUEUED` e publica mensagem na fila SQS;
7. Lambda `processMeal` consome a mensagem da fila SQS;
8. Para **imagens**: envia para o GPT-5.4-mini com prompt de análise visual;
9. Para **áudios**: transcreve via GPT-4o-mini-transcribe, depois envia o texto para o GPT-5.4-mini;
10. IA retorna dados estruturados dos alimentos (nome, quantidade, proteínas, carboidratos, gorduras);
11. Backend calcula calorias e atualiza o DynamoDB com status `SUCCESS`;
12. Em caso de falha, o SQS faz retry automático (até 2 vezes). Após esgotar, vai para a Dead Letter Queue e dispara alarme por email.

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
5. O backend troca o `code` pelos tokens, deriva identidade do token e, se o email ainda não estiver registrado, **cria a `Account` no DynamoDB** com `isOnboarded: false` — retorna `200` com `{ accessToken, refreshToken, isOnboarded }`. O access token já contém o claim `internalId`;
6. **Usuário novo** (`isOnboarded: false`): o frontend chama `POST /auth/complete-onboarding` com o `accessToken`. O backend deriva identidade do token, **reutiliza a `Account` criada no callback**, cria `Profile` e `Goal` e marca `isOnboarded: true` atomicamente (`TransactWriteCommand`). Responde `204`;
7. Como o claim `internalId` já vem no primeiro token (atributo `custom:internalId` injetado pelo trigger `preTokenGeneration`), não é necessária uma troca de token extra após o onboarding.

**Observações:**
- O `complete-onboarding` é **idempotente**: reexecuta a gravação de `Profile`/`Goal` e o flag com o mesmo `accountId` (retry seguro);
- Erros: `400 INVALID_GRANT` se a troca de code falhar ou faltar dado no token; se a conta existir mas pertencer a outro `externalId`, `409 EMAIL_ALREADY_IN_USE`; se o token for válido mas não houver `Account` registrada, `404 ACCOUNT_NOT_FOUND`;
- A troca de código tem timeout de 5 segundos.

## Fluxo de Planos e Pagamento (Billing)

Gateway **Asaas** (sandbox: `api-sandbox.asaas.com`), atrás do contrato `IPaymentGateway` — os use cases nunca citam o gateway:

```text
TRIAL (dia 0, sem gateway):
  POST /billing/trial ──► Subscription { status: TRIALING, trialEndsAt: +7d,
      planId: PRO_MONTHLY }   (1 por conta · Pro imediato · cota ∞)

CHECKOUT:
  POST /billing/checkout ──► Asaas Checkout ──► { checkoutUrl }
      mensal = RECURRENT + só cartão     (1ª cobrança imediata)
      anual  = DETACHED  + Pix/cartão    (pagamento único; renovação via app)
  App abre checkoutUrl no browser ──► usuário paga

WEBHOOK (fonte da verdade):
  Asaas ──POST /billing/webhooks/asaas──► header asaas-access-token ──►
      PAYMENT_CONFIRMED / RECEIVED ──► status ACTIVE + paidUntil (+ciclo) ──►
      app invalida ['accounts'] e reflete via GET /me

EXPIRAÇÃO (lazy, sem scheduler):
  resolveEffectivePlan: trial/pago vencido ──► FREE + cota 20/mês
```

**Observações:**
- **Idempotência**: dedup por `event.id` na RateLimitTable (TTL 14d = retenção de reenvio do Asaas) + guards de transição (`paidUntil` só avança · `CHECKOUT_PAID` é no-op);
- **Join do webhook com a conta**: via `externalReference` (`"<accountId>#<planId>"`) e índice reverso `GATEWAY#<id>` na MainTable (testado com payload real pago no sandbox);
- **Cota FREE**: `MealQuotaService` usa a RateLimitTable com bucket `YYYY-MM` — a 21ª refeição do mês responde `403 FREE_QUOTA_EXCEEDED`;
- Trial é **1 por conta** (`409 TRIAL_NOT_AVAILABLE`); cancelar trial é downgrade local (sem gateway), assinatura paga cancela no gateway e mantém `PRO` até `paidUntil` + carência de 3 dias.

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
functions:
  hello: api-dev-hello
  signUp: api-dev-signUp
  signIn: api-dev-signIn
  refreshToken: api-dev-refreshToken
  forgotPassword: api-dev-forgotPassword
  confirmationForgotPassword: api-dev-confirmationForgotPassword
  oauthCallback: api-dev-oauthCallback
  completeOnboarding: api-dev-completeOnboarding
  preSignUpTrigger: api-dev-preSignUpTrigger
  preTokenGenerationTrigger: api-dev-preTokenGenerationTrigger
  customMessageTrigger: api-dev-customMessageTrigger
  me: api-dev-me
  updateProfile: api-dev-updateProfile
  createMeal: api-dev-createMeal
  listMeals: api-dev-listMeals
  getMealById: api-dev-getMealById
  newMealUploadedTrigger: api-dev-newMealUploadedTrigger
  processMeal: api-dev-processMeal
```

O endpoint base da API será: `https://xxx.execute-api.sa-east-1.amazonaws.com`

### 5. Configurar o CDN na zona de DNS (opcional)

Aplica-se quando `MEALS_CDN_DOMAIN_NAME` estiver definido no `.env` (domínio customizado da distribuição CloudFront para os arquivos de refeição). O registro de DNS do domínio precisa apontar para o domain da distribuição.

- **Primeiro deploy**: após o `sls deploy`, consulte o domain da distribuição criada (`sls info` ou `aws cloudfront list-distributions`) e crie na zona de DNS do domínio um registro **CNAME** de `MEALS_CDN_DOMAIN_NAME` apontando para esse domain (ex.: `dxxxxxxxxxxxx.cloudfront.net`);
- **Recriação da stack**: antes de deployar, garanta que o CNAME **não aponte mais** para a distribuição antiga/deletada (caso contrário o CloudFront rejeita a criação do alias). Após o deploy, recrie o CNAME apontando para o domain da nova distribuição;
- Sem `MEALS_CDN_DOMAIN_NAME`, a distribuição usa o domain padrão `*.cloudfront.net` — nenhuma ação é necessária no DNS.

## Endpoints

### Autenticação

| Método | Url                                  | Descrição                                | Autenticação |
| ------ | ------------------------------------ | ---------------------------------------- | ------------ |
| POST   | `/auth/sign-up`                      | Cadastra um novo usuário                 | Pública      |
| POST   | `/auth/sign-in`                      | Realiza login                            | Pública      |
| POST   | `/auth/refresh-token`                | Renova tokens de acesso                  | Pública      |
| POST   | `/auth/forgot-password`              | Solicita código de recuperação de senha  | Pública      |
| POST   | `/auth/confirmation-forgot-password` | Confirma redefinição de senha com código | Pública      |
| POST   | `/auth/oauth/callback`               | Troca o code do Google por tokens (PKCE) | Pública      |
| POST   | `/auth/complete-onboarding`          | Cria perfil e metas do usuário do Google (conta já criada no callback) | Pública  |

### Perfil e Conta

| Método | Url         | Descrição                                        | Autenticação |
| ------ | ----------- | ------------------------------------------------ | ------------ |
| GET    | `/me`       | Retorna `isOnboarded`, perfil, metas, `subscription` e `mealQuota` do usuário | JWT          |
| PUT    | `/profiles` | Atualiza o perfil do usuário                     | JWT          |

### Refeições

| Método | Url                      | Descrição                                              | Autenticação |
| ------ | ------------------------ | ------------------------------------------------------ | ------------ |
| POST   | `/create-meal`           | Cria uma refeição e retorna Presigned POST para upload | JWT          |
| GET    | `/meals?date=YYYY-MM-DD` | Lista refeições de um dia específico                   | JWT          |
| GET    | `/meals/{id}`            | Retorna uma refeição por ID com detalhes dos alimentos | JWT          |

### Billing

| Método | Url                       | Descrição                                                                 | Autenticação                       |
| ------ | ------------------------- | ------------------------------------------------------------------------- | ---------------------------------- |
| GET    | `/billing/plans`          | Catálogo de planos (id, preço, ciclo, trialDays, features)                | JWT                                |
| POST   | `/billing/trial`          | Trial de 7 dias (1 por conta) → `{ trialEndsAt }`                         | JWT                                |
| POST   | `/billing/checkout`       | Cria checkout Asaas → `{ checkoutUrl, expiresAt }`                        | JWT                                |
| POST   | `/billing/cancel`         | Cancela trial (local) ou assinatura (gateway) → `{ status }`              | JWT                                |
| POST   | `/billing/webhooks/asaas` | Webhook Asaas — fonte da verdade da ativação                              | Pública (header `asaas-access-token`) |

## Rate Limit

Proteção contra abuso e excesso de requests, implementada **em código** (sem AWS WAF): o decorator `@RateLimit` marca os controllers, o `lambdaHttpAdapter` aplica o enforcement centralizado e contadores **atômicos e condicionais** no DynamoDB (`RateLimitTable`) controlam a janela fixa. Requests bloqueados **não gravam** no banco, e as chaves de IP e de conta são **por rota** (`RL#ip#<rota>#<ip>` e `RL#account#<rota>#<id>` — rotas não disputam o mesmo contador).

**Custo:** o bloqueio ocorre dentro da Lambda, então um `429` ainda custa API Gateway (~$1,59/1M na `sa-east-1`) + invocação Lambda ($0,20/1M). Requests bloqueados **não** gravam no DynamoDB e **não** chamam Cognito/OpenAI — o volume atual fica coberto pelo free tier (1M requests/mês). Bloquear antes da invocação (WAF rate-based, ~$6/mês) fica como evolução futura.

**Limites por rota:**

| Rota | Escopo | Limite |
|---|---|---|
| `POST /auth/sign-up` | IP | 5 / 15min |
| `POST /auth/sign-in` | IP + email | 10 / 15min cada |
| `POST /auth/refresh-token` | IP | 60 / 15min |
| `POST /auth/forgot-password` | IP + email | 5 / 15min (IP) e 5 / 1h (email) |
| `POST /auth/confirmation-forgot-password` | IP | 10 / 15min |
| `POST /auth/oauth/callback` | IP | 30 / 15min |
| `POST /auth/complete-onboarding` | IP | 30 / 15min |
| `POST /create-meal` | conta | 10 / 1h |
| `POST /billing/trial` | conta | 5 / 1h |

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

- Cadastra um novo usuário com perfil e metas nutricionais:

  ```bash
  curl -X POST https://xxx.execute-api.sa-east-1.amazonaws.com/auth/sign-up \
    -H "Content-Type: application/json" \
    -d '{
      "email": "usuario@email.com",
      "password": "senha123",
      "name": "João Silva",
      "birthDate": "1990-05-15",
      "gender": "MALE",
      "height": 175,
      "weight": 80,
      "activityLevel": "MODERATE",
      "goal": "LOSE"
    }'
  ```

- Request body:
  ```json
  {
    "email": "usuario@email.com",
    "password": "senha123",
    "name": "João Silva",
    "birthDate": "1990-05-15",
    "gender": "MALE",
    "height": 175,
    "weight": 80,
    "activityLevel": "MODERATE",
    "goal": "LOSE"
  }
  ```

- Resposta esperada:
  ```json
  {
    "accessToken": "eyJhbGciOiJSUzI1NiIs...",
    "refreshToken": "eyJhdWQiOiJYLmNv..."
  }
  ```

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

#### OAuth Callback -> `/auth/oauth/callback`

- Troca o `code` de autorização do Google por tokens (fluxo OAuth 2.0 Authorization Code + PKCE). O `codeVerifier` é o mesmo gerado no início do fluxo pelo frontend:

  ```bash
  curl -X POST https://xxx.execute-api.sa-east-1.amazonaws.com/auth/oauth/callback \
    -H "Content-Type: application/json" \
    -d '{
      "code": "4/0AfJohXnZ0x9y...",
      "redirectUri": "https://app.nafoodiary.com/oauth/callback",
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
    "mealQuota": { "used": 3, "limit": null, "remaining": null }
  }
  ```

- `subscription` é `null` sem item de assinatura (plano FREE); `plan` é o **plano efetivo** derivado de `resolveEffectivePlan` (trial/pago vigente = `PRO`, vencido = `FREE`); `mealQuota.limit` é `20` no FREE e `null` (ilimitado) no PRO;
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
      "fileSize": 5242880
    }'
  ```

- Resposta esperada:
  ```json
  {
    "mealId": "2CkS0wZr5cY3xK1mN7jQ9bT2vL",
    "presignedPost": "eyJ1cmwiOiJodHRwczovL2FwaS1k..."
  }
  ```

- Upload no frontend (JavaScript):

  ```javascript
  // Decodificar o presignedPost de base64
  const presignedData = JSON.parse(atob(response.presignedPost));

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

- Lista refeições de um dia específico:

  ```bash
  curl -X GET "https://xxx.execute-api.sa-east-1.amazonaws.com/meals?date=2026-08-26" \
    -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIs..."
  ```

- Resposta esperada:
  ```json
  {
    "meals": [
      {
        "mealId": "2CkS0wZr5cY3xK1mN7jQ9bT2vL",
        "status": "SUCCESS",
        "inputType": "IMAGE",
        "fileUrl": "https://cdn.nafoodiary.com/meals/2CkS0wZr5cY3xK1mN7jQ9bT2vL.jpg",
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
        "createdAt": "2026-08-26T12:00:00.000Z"
      }
    ]
  }
  ```

#### Get Meal By ID -> `/meals/{id}`

- Retorna uma refeição específica com detalhes dos alimentos:

  ```bash
  curl -X GET https://xxx.execute-api.sa-east-1.amazonaws.com/meals/2CkS0wZr5cY3xK1mN7jQ9bT2vL \
    -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIs..."
  ```

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
        "features": ["Refeições AI ilimitadas"]
      },
      {
        "id": "PRO_YEARLY",
        "name": "Pro Anual",
        "price": 9990,
        "cycle": "YEARLY",
        "trialDays": 7,
        "features": ["Refeições AI ilimitadas"]
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

- Token inválido → `502 BILLING_ERROR`; evento desconhecido → `200` com `{"received": false}`; processamento é idempotente por `event.id` (dedup de 14 dias na RateLimitTable).

## Eventos

### Triggers Cognito

| Trigger            | Função                      | Descrição                                                                |
| ------------------ | --------------------------- | ------------------------------------------------------------------------ |
| PreSignUp          | `preSignUpTrigger`          | Auto-confirma e auto-verifica novos usuários; em `PreSignUp_ExternalProvider` cria usuário nativo "shadow" (`custom:internalId`) e vincula o Identity Provider |
| PreTokenGeneration | `preTokenGenerationTrigger` | Injeta o claim `internalId` no access token a partir de `custom:internalId` |
| CustomMessage      | `customMessageTrigger`      | Personaliza o email de recuperação de senha em português                 |

### Eventos S3

| Evento        | Função                   | Descrição                                                                                        |
| ------------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| ObjectCreated | `newMealUploadedTrigger` | Quando um arquivo é enviado ao S3, lê metados, atualiza status para QUEUED e publica na fila SQS |

### Filas SQS

| Fila       | Função        | Descrição                                                         |
| ---------- | ------------- | ----------------------------------------------------------------- |
| MealsQueue | `processMeal` | Consome mensagens e processa refeições via OpenAI                 |
| MealsDLQ   | --            | Dead Letter Queue para refeições que falharam após 2 retentativas |

## Tecnologias Utilizadas

### Backend

- Serverless Framework v4;
- AWS (Lambda, API Gateway HTTP API, DynamoDB, S3, CloudFront, SQS, SNS, Cognito, SES);
- TypeScript;
- Zod (validação de schemas);
- esbuild (bundling);
- OpenAI API (GPT-5.4-mini, GPT-4o-mini-transcribe);
- Asaas (gateway de pagamento — checkout hospedado + webhook);
- KSUID (geração de IDs únicos);
- reflect-metadata (injeção de dependência via decorators).

## Recursos Criados na AWS

### DynamoDB

- **Table**: `api-{stage}-MainTable`
  - Single-table design com entidades: Account, Profile, Goal, Meal
  - `Account` armazena `isOnboarded` (indica se o usuário completou o onboarding; `false` até `complete-onboarding` gravar `Profile`/`Goal`)
  - Billing: PAY_PER_REQUEST
  - Point-in-time recovery: 35 dias
  - GSI1 para consultas por email e data

- **Table**: `api-{stage}-RateLimitTable`
  - Contadores de rate limit por janela (`PK = RL#<scope>#<chave>`, `SK = bucket da janela`)
  - TTL em `expiresAt` para expirar janelas automaticamente
  - Billing: PAY_PER_REQUEST

### Cognito

- **UserPool**: `api-{stage}-UserPool`
  - Auth flow: USER_PASSWORD_AUTH
  - Username attribute: email
  - Senha: mínimo 8 caracteres
  - Access token: 1 dia
  - Refresh token: 7 dias (com rotação)
- **UserPoolClient**: `api-{stage}-UserPoolClient`
- **Google Identity Provider**: Login com Google (Authorization Code + PKCE), scopes `profile email openid`, mapeamento de `name` e `email`, callback para o domínio do frontend

### S3

- **Bucket**: `api-{stage}-meals-bucket`
  - Armazenamento de arquivos de refeição (imagens e áudios)
  - CORS configurado para o frontend
  - Eventos de object creation habilitados

### CloudFront

- **Distribution**: CDN para servir arquivos de refeição
  - OAC (Origin Access Control) configurado com o S3
  - Suporte a domínio personalizado

### SQS

- **MealsQueue**: Fila para processamento assíncrono de refeições
- **MealsDLQ**: Dead Letter Queue com alarme por email (SNS)

### API Gateway

- HTTP API v2 com CORS habilitado
- JWT Authorizer configurado com o Cognito UserPool para rotas protegidas
- Rotas de OAuth (`/auth/oauth/callback` e `/auth/complete-onboarding`) são públicas e validam o `accessToken` no body
- Rotas `/billing/*` são protegidas por JWT, exceto `POST /billing/webhooks/asaas` (pública — valida o header `asaas-access-token`)
- Suporte a domínio personalizado (opcional)

## Variáveis de Ambiente

### Deploy (`.env`)

| Variável                    | Descrição                                               | Obrigatório |
| --------------------------- | ------------------------------------------------------- | ----------- |
| `COGNITO_EMAIL`             | Endereço de email remetente para o Cognito              | Sim         |
| `COGNITO_EMAIL_TO_REPLY`    | Endereço de email para respostas                        | Sim         |
| `SES_SOURCE_ARN`            | ARN da identidade SES verificada usada pelo Cognito       | Sim         |
| `API_DOMAIN_NAME`           | Domínio personalizado da API (ex: `api.nafoodiary.com`) | Não         |
| `API_CERTIFICATE_ARN`       | ARN do certificado ACM para o domínio da API            | Não         |
| `MEALS_CDN_DOMAIN_NAME`     | Domínio personalizado do CloudFront para arquivos       | Não         |
| `MEALS_CDN_CERTIFICATE_ARN` | ARN do certificado ACM para o CDN                       | Não         |
| `DLQ_ALARM_EMAIL`           | Email para notificações de falha no processamento       | Sim         |
| `OPENAI_API_KEY`            | Chave de API do OpenAI                                  | Sim         |
| `ASAAS_BASE_URL`            | URL base da API Asaas (sandbox: `https://api-sandbox.asaas.com`) | Sim |
| `ASAAS_API_KEY`             | Chave de acesso da Asaas (enviada como `access_token`)  | Sim         |
| `ASAAS_WEBHOOK_TOKEN`       | Token esperado no header `asaas-access-token` do webhook | Sim        |
| `APP_WEB_URL`               | Origin do app web — allowlist da `returnUrl` do checkout | Sim        |
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
│   ├── decorators/            # @Injectable(), @Schema(), @RateLimit()
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
│       ├── meal/              # createMeal, listMeals, getMealById, processMeal, uploadTrigger
│       ├── account/           # me
│       ├── profile/           # updateProfile
│       └── billing/           # plans, trial, checkout, cancel, webhookAsaas
│
├── application/               # Lógica de negócio
│   ├── contracts/             # Controller, IEventHandler, ISQSHandler, IPaymentGateway
│   ├── entities/              # Account, Profile, Goal, Meal, Subscription
│   ├── services/              # GoalCalculator, RateLimitService, MealQuotaService
│   ├── useCases/              # Use cases organizados por domínio
│   ├── controllers/           # Controllers com schemas Zod
│   ├── query/                 # Queries diretas ao DynamoDB
│   ├── events/                # MealUploadedEventHandler
│   ├── queues/                # MealQueueConsumer
│   └── errors/                # ErrorCode, ApplicationError, HttpError
│
└── infra/                     # Integrações externas
    ├── clients/               # Clients AWS SDK (DynamoDB, Cognito, S3, SQS)
    ├── databases/dynamodb/    # Repositories + Item mappers + Unit of Work
    ├── gateways/              # AuthGateway, MealFileStorageGateway, MealQueueGateway,
    │                          # AsaasPaymentGateway
    ├── ai/                    # OpenAI integration
    │   ├── gateways/          # MealAiGateway
    │   └── prompts/           # Prompts de análise (PT-BR)
    └── utils/                 # downloadByURL
```

### Padrões Arquiteturais

- **Clean Architecture / Hexagonal**: Separação clara entre `application` (negócio), `infra` (integrações), `main` (entry points), `kernel` (framework) e `shared` (utilitários);
- **Injeção de Dependência customizada**: Container DI singleton (`Registry`) com decorator `@Injectable()` usando `reflect-metadata` para resolução automática de construtores;
- **Schema Validation Decorator**: `@Schema(zodSchema)` nos controllers para validação automática do request body;
- **Controller Pattern**: Classe abstrata `Controller<'public' | 'private'>` distinguindo rotas autenticadas vs públicas;
- **Rate Limit declarativo**: decorator `@RateLimit` (IP/email/conta) nos controllers + enforce centralizado no `lambdaHttpAdapter` com contadores atômicos condicionais no DynamoDB;
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

   aws cloudformation describe-stacks --stack-name api-{stage}
   # Repita até o comando responder "does not exist"
   ```

2. O `sls remove` não apaga alguns resíduos que podem travar o novo deploy — remova manualmente:

   - **Log group do custom resource** (o Framework não remove): 
     ```bash
     aws logs delete-log-group --log-group-name /aws/lambda/api-{stage}-custom-resource-existing-s3
     ```
   - **Bucket órfão** do `MealsBucket` (`DeletionPolicy: Retain`), se ainda existir:
     ```bash
     aws s3 rb s3://nafoodiary-api-{stage}-meals-bucket --force
     ```

3. Caso use `MEALS_CDN_DOMAIN_NAME`: garanta que o CNAME na zona de DNS **não aponte para a distribuição CloudFront antiga/deletada** (o CloudFront rejeita criar o alias enquanto o DNS apontar para outro CloudFront). Corrija o registro de DNS antes de continuar — ver "Configurar o CDN na zona de DNS" no passo a passo.

4. Aguarde o "cooldown" do domínio do UserPool (`nafoodiary.auth.sa-east-1.amazoncognito.com`), se o deploy falhar com domínio indisponível, aguarde alguns minutos e rode o deploy novamente.

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

### Refeição fica com status FAILED
- Verifique os logs da Lambda `processMeal` no CloudWatch;
- Confirme que a `OPENAI_API_KEY` está configurada e é válida;
- Verifique se o formato do arquivo é suportado (imagens: JPEG, PNG; áudios: M4A, 3GP, WebM);
- Após 2 falhas, a refeição vai para a Dead Letter Queue e um email de alarme é enviado.

### Erro 401 / Token inválido
- Verifique se o header `Authorization: Bearer <token>` está sendo enviado;
- Confirme que o token não expirou (validade de 1 dia);
- Use o endpoint `/auth/refresh-token` para obter um novo token.

### Erro 429 / Rate limit excedido
- Verifique o header `Retry-After` da resposta para saber quando tentar novamente;
- Confirme qual escopo estourou (IP, email ou conta) na tabela `RateLimitTable` no DynamoDB (consulta por `PK = RL#<scope>#<chave>`);
- Requests bloqueados **não** incrementam o contador — o limite é por janela fixa e recomeça ao expirar;
- Se precisar ajustar um limite, basta alterar o decorator `@RateLimit` no controller correspondente.

### Erro de CORS
- Verifique se o CORS está habilitado no `serverless.yml` (`httpApi.cors: true`);
- Para domínios de produção, configure o CORS no API Gateway;
- Após mudanças, faça novo deploy: `sls deploy`.

### Erro ao cadastrar usuário (Sign Up)
- Verifique se o `COGNITO_EMAIL` e `SES_SOURCE_ARN` estão configurados;
- Confirme que o SES está no modo production ou verificado para o email de destino;
- Verifique os logs da Lambda `signUp` no CloudWatch.

### Processamento de áudio falha
- Verifique se o arquivo de áudio não está corrompido;
- Confirme que o formato é suportado (M4A, 3GP, WebM);
- Verifique se a `OPENAI_API_KEY` tem acesso ao modelo `gpt-4o-mini-transcribe`.

### "The provider Google does not exist for User Pool"
- Erro de corrida ao criar o `UserPoolClient` antes do `GoogleIdentityProvider` (o client referencia o provider `Google` por nome);
- Já mitigado com `DependsOn: GoogleIdentityProvider` no `UserPoolClient` em `sls/resources/userPool.yaml`; se reaparecer, é uma corrida de criação do CloudFormation — reexecute o deploy.

### CloudFront: "incorrectly configured DNS record that points to another CloudFront distribution"
- O CNAME de `MEALS_CDN_DOMAIN_NAME` está apontando para uma distribuição CloudFront antiga/deletada;
- Corrija o registro de DNS (aponte para longe ou apague), rode o `sls deploy` e recrie o CNAME apontando para o domain da nova distribuição (ver "Configurar o CDN na zona de DNS").

### Deploy falha porque o log group do custom resource existe
- O `sls remove` não apaga o log group `/aws/lambda/api-{stage}-custom-resource-existing-s3`;
- Remova manualmente antes de um novo deploy:

  ```bash
  aws logs delete-log-group --log-group-name /aws/lambda/api-{stage}-custom-resource-existing-s3
  ```

### Alarme de Dead Letter Queue
- Verifique o email configurado em `DLQ_ALARM_EMAIL`;
- Analise os logs da Lambda `processMeal` para identificar a causa raiz;
- Verifique se há falhas de rede ou timeout na chamada à API do OpenAI;
