# NaCal API

API serverless para um diário alimentar inteligente com inteligência artificial. O sistema permite que os usuários registrem suas refeições através de **fotos**, **áudios** ou **texto**, que são analisados automaticamente por IA para identificar os alimentos, estimar quantidades e calcular macronutrientes (proteínas, carboidratos e gorduras). O sistema também calcula metas diárias personalizadas de calorias e macros com base no perfil do usuário.

> **Novo no projeto?** Comece pelo [Guia da API](docs/guide/README.md): visão geral, arquitetura do código e fluxos com diagramas.

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
- **Alarmes**: Notificação por email (só em prod) quando falhas inesperadas esgotam as entregas das filas (Dead Letter Queues), quando a fila de processamento acumula (mensagem mais antiga com mais de 2 min), quando o HTTP API responde `5xx` (3 em 5 min), quando o webhook do Asaas responde algo diferente de 2xx, quando uma refeição vira `FAILED`, quando a `processMeal` sofre throttling e quando o trigger do S3 dá erro;
- **Observabilidade**: logs JSON com uma linha por request (`routeKey`, `statusCode`, latência, erro), transições do processamento de refeições, `usage` de tokens de cada chamada à OpenAI, métricas EMF (`MealFailed`, `WebhookNon2xx`), access log do HTTP API, retenção de 30 dias e sourcemaps nas stacks de erro;
- **Rate limiting**: Proteção por IP, e-mail e conta com resposta `429 RATE_LIMIT_EXCEEDED` e header `Retry-After` — implementado em código com contadores atômicos no DynamoDB (sem WAF);
- **Planos e assinatura**: plano Free com **20 refeições AI/mês** e Pro com **até 20 refeições AI por dia** (uso justo); **trial de 7 dias** sem cartão (1 por conta), checkout hospedado no **Asaas** (mensal recorrente só cartão; anual Pix/cartão), webhook idempotente como fonte da verdade (estorno total e chargeback descontam o ciclo pago e cancelam a mensal no Asaas, com alerta por e-mail), reconciliação horária dos pagamentos confirmados e estornados (ativa ou desconta o que o webhook não aplicou e avisa por e-mail) e downgrade lazy na expiração; a rota pública do webhook é endurecida com allowlist dos IPs oficiais do Asaas e rate limit por IP (120/60s), além de `reservedConcurrency: 5` na função;
- **Produção**: stage `prod` com proteção contra deleção (Cognito e DynamoDB), alarme da DLQ ativo, CORS restrito e validação do `.env.prod` antes do deploy (`yarn deploy:prod`);

## Arquitetura

Backend **serverless e orientado a eventos** na AWS (`sa-east-1`): API Gateway HTTP API com authorizer JWT do Cognito, Lambdas em Node.js 24 (arm64), DynamoDB single-table, S3 + CloudFront para os arquivos das refeições, SQS para o processamento assíncrono com IA (OpenAI, com gate de foto no Cloudflare Workers AI) e Asaas para os pagamentos.

```mermaid
flowchart LR
    app["App"] --> apigw["API Gateway<br/>+ JWT Cognito"] --> lambdas["Lambdas HTTP"]
    lambdas --> ddb[("DynamoDB")]
    app -. "Presigned POST" .-> s3[("S3")]
    s3 --> trig["newMealUploadedTrigger"] --> q[["SQS"]] --> proc["processMeal"]
    proc --> ai["OpenAI + Cloudflare"]
    proc --> ddb
    asaas["Asaas"] -- "webhook" --> lambdas
```

A explicação completa, com diagramas de cada parte, está no **[Guia da API](docs/guide/README.md)**:

| Tema | Página |
|---|---|
| Peças da AWS e inventário de Lambdas | [Visão geral](docs/guide/01-visao-geral.md) |
| Camadas, DI e ciclo de vida da request | [Arquitetura do código](docs/guide/02-arquitetura-codigo.md) |
| Tabelas, chaves e padrões de acesso | [Modelo de dados](docs/guide/03-modelo-de-dados.md) |
| Estados de refeição, assinatura e conta | [Máquinas de estado](docs/guide/04-maquinas-de-estado.md) |
| Códigos de erro, cotas e rate limit | [Erros, cotas e rate limit](docs/guide/05-erros-cotas-rate-limit.md) |
| Alarmes, logs e runbooks | [Operação](docs/guide/06-operacao.md) |
| Refeição por foto ou áudio (upload, fila, gate, IA, estorno) | [Fluxo](docs/guide/fluxos/refeicao-foto-audio.md) |
| Refeição por texto | [Fluxo](docs/guide/fluxos/refeicao-texto.md) |
| Listar, adicionar, remover e restaurar itens, excluir | [Fluxo](docs/guide/fluxos/refeicao-itens.md) |
| Cadastro por e-mail | [Fluxo](docs/guide/fluxos/auth-cadastro-email.md) |
| Login com Google | [Fluxo](docs/guide/fluxos/auth-google-oauth.md) |
| Login, refresh e senha | [Fluxo](docs/guide/fluxos/auth-login-senha.md) |
| Perfil e meta | [Fluxo](docs/guide/fluxos/perfil-e-meta.md) |
| Planos, checkout e webhook do Asaas | [Fluxo](docs/guide/fluxos/billing.md) |
| Reconciliação de pagamentos | [Fluxo](docs/guide/fluxos/billing-reconciliacao.md) |

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

Para produção, use `AWS_PROFILE=nacal-prod yarn deploy:prod`: o script valida `.env.prod` e executa `sls deploy --stage prod`. O checklist da conta de produção é um documento interno, fora deste repo: peça ao responsável pelo projeto.

`yarn check:prod` (rodado pelo `deploy:prod`) recusa, entre outros:
- chaves do `.env` ausentes no `.env.prod` (herdariam valores de dev) e valores de exemplo;
- `APP_WEB_URL` com path ou barra final, e domínios/ARNs fora do esperado;
- `CORS_ALLOWED_ORIGINS` com `*` ou sem HTTPS;
- `ASAAS_WEBHOOK_ALLOWED_IPS` com `*` ou com CIDR (a allowlist compara o IP exato);
- `BETA_GATE_ENABLED`/`MEAL_GATE_ENABLED` diferentes de `true`/`false`, beta ligado sem e-mails ou `BETA_ALLOWED_EMAILS` acima de 2 KB;
- `AWS_PROFILE` ausente.

#### Convidar para o beta

A lista de espera da landing guarda só o e-mail, então o convite vai por e-mail (template `betaInviteEmail`, enviado pelo SES a partir do `COGNITO_EMAIL_TO_REPLY`, um endereço que recebe respostas, em vez do `noreply`, para não cair no spam). Para cada onda:

1. Adicione os e-mails em `BETA_ALLOWED_EMAILS` no `.env.prod` e rode `AWS_PROFILE=nacal-prod yarn deploy:prod`.
2. Dry-run (gera o preview e confere se todos já estão liberados na Lambda publicada):
   ```bash
   AWS_PROFILE=nacal-prod npx tsx scripts/sendBetaInvites.ts a@exemplo.com b@exemplo.com
   ```
3. Envio: o mesmo comando com `--send`. Use `--stage=dev` para testar com o `.env` e a stack de dev.

O script lê `BETA_ALLOWED_EMAILS` e `BETA_GATE_ENABLED` do `nacal-api-<stage>-preSignUpTrigger` e não envia nada se algum destinatário ainda não estiver liberado. Cada destinatário recebe um e-mail separado.

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
| POST   | `/billing/checkout`       | Cria checkout Asaas ou devolve a fatura vencida → `{ checkoutUrl, expiresAt, type }` | JWT                                |
| POST   | `/billing/cancel`         | Cancela trial (local) ou assinatura (gateway) → `{ status }`              | JWT                                |
| POST   | `/billing/webhooks/asaas` | Webhook Asaas — fonte da verdade da ativação                              | Pública (header `asaas-access-token`) |

## Rate Limit

Implementado em código (sem WAF), com o decorator `@RateLimit` e contadores atômicos na `RateLimitTable`. Estourar o limite responde `429 RATE_LIMIT_EXCEEDED` com o header `Retry-After`. Os limites de cada rota estão em [Erros, cotas e rate limit](docs/guide/05-erros-cotas-rate-limit.md#rate-limit).

## Exemplos de Uso

#### Sign Up -> `/auth/sign-up`

- Cadastra um novo usuário pendente e envia o código de confirmação por e-mail. A senha é aparada (`trim`) e precisa ter pelo menos 8 caracteres depois disso (o Cognito não aceita espaço no começo ou no fim):

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

- Erros: `403 BETA_ACCESS_DENIED` (e-mail fora do beta), `409 EMAIL_ALREADY_IN_USE` (e-mail já confirmado), `409 EMAIL_LINKED_TO_GOOGLE` (e-mail já no Cognito ligado ao Google), `429 TOO_MANY_ATTEMPTS`.

#### Confirm Sign Up -> `/auth/confirm-sign-up`

- Confirma o e-mail. A senha é obrigatória e aparada (`trim`), como no `sign-up` e no `sign-in` (ver "Fluxo de Cadastro por E-mail"):

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

- Erros: `401 INVALID_CREDENTIALS`, `409 EMAIL_LINKED_TO_GOOGLE` (senha errada num e-mail ligado ao Google), `403 EMAIL_NOT_CONFIRMED` (cadastro ainda sem código confirmado), `429 TOO_MANY_ATTEMPTS`.

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

- `isOnboarded: false` indica um usuário novo — o backend cria a `Account` no DynamoDB com `isOnboarded: false`, então o frontend deve chamar `/auth/complete-onboarding` com o `accessToken` retornado. Para um usuário já registrado, `isOnboarded: true` e a conta existente é reutilizada. Um cadastro por e-mail ainda não confirmado com o mesmo e-mail tem o `PendingSignUp` descartado (o Google prova o e-mail, não quem preencheu o cadastro), então a conta volta com `isOnboarded: false` e passa pelo onboarding. O `accessToken` já contém o claim `internalId` (usado como `accountId` nas rotas autenticadas).
- Erros: `400 INVALID_GRANT` (code inválido ou expirado, resposta do Cognito sem tokens ou token sem dados de identidade) e `400 VALIDATION` (body inválido). Timeout de 5s na troca de código com o Cognito; timeout ou falha de rede nessa troca também viram `400 INVALID_GRANT` (Lambda com timeout de 15s).

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
- **Conta já onboarded**: responde `204` sem gravar (perfil, metas e `termsAcceptedAt` não mudam, nem as edições feitas por `PUT /profiles` e `POST /goals`). O `Put` da `Account` na transação tem condição (`attribute_not_exists(PK) OR isOnboarded = false`), então duas chamadas simultâneas gravam uma vez só; a outra também recebe `204` (se o DynamoDB acusar `TransactionConflict`, a transação é tentada mais uma vez).
- Erros: `409 EMAIL_ALREADY_IN_USE` (email já pertence a outra conta, `externalId` divergente), `400 INVALID_GRANT` (token inválido/expirado ou dados ausentes no Cognito), `401 UNAUTHORIZED` (usuário do token apagado do Cognito), `404 RESOURCE_NOT_FOUND` (token válido sem `Account` registrada) e `400 VALIDATION` (body inválido).
- Não é necessário trocar o token após o sucesso: o `accessToken` do callback já contém o claim `internalId`.

#### Get Me -> `/me`

- Retorna o `isOnboarded`, o `email` da conta, o perfil e as metas do usuário autenticado (o app usa o `email` para identificar a conta no pedido de exclusão por e-mail):

  ```bash
  curl -X GET https://xxx.execute-api.sa-east-1.amazonaws.com/me \
    -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIs..."
  ```

- Resposta esperada (usuário onboarded):
  ```json
  {
    "isOnboarded": true,
    "email": "joao@email.com",
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
- O `accountId` é resolvido a partir do claim `internalId` do access token; se o token não tiver o claim, retorna `401`. Se a conta não existir, retorna `404`. Se a conta não existir e o usuário do token tiver sido apagado do Cognito, retorna `401 UNAUTHORIZED` (o app tenta o refresh e desloga).

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

  // Adicionar o arquivo (os fields assinados vão sem alteração; o S3 recusa campo extra ou valor diferente)
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
- A chamada à OpenAI é **síncrona** (GPT-5.4-mini, prompt `getTextMealPrompt`, Lambda com `timeout: 29`, ~1–2s). Ela tem timeout próprio de 12s com no máximo 1 retry e um prazo total de 25s que inclui a espera de um `Retry-After` (o mesmo vale para o `POST /meals/{id}/items`), então uma OpenAI lenta vira erro da própria Lambda antes do corte de 29s. O prompt reaproveita as regras do "Adicionar item" (nomes genéricos entram com versão típica, quantidade implausível é limitada, nomes só em português) e acrescenta: itens com macros zero (água, café preto, refrigerante zero) sempre entram, o que o usuário diz que **não** comeu fica de fora e "café" como bebida nunca vira café da manhã. O mesmo prompt analisa a transcrição dos áudios, numa variante que só troca a introdução.
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
- Limites: até **5 adições por refeição**, só **até 24h** depois de `createdAt` e no máximo **30 itens**. O append é condicional no DynamoDB (status, `foodsVersion`, janela, adições e itens), com leitura consistente: requests concorrentes não furam os limites nem repetem o `order`, e quem perde a corrida regrava com o `order` recalculado, sem nova chamada à IA (até 3 tentativas, depois `500`). Itens que a IA devolveu e não couberam são descartados e contados em `skippedFoodsCount`.

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
  { "checkoutUrl": "https://sandbox.asaas.com/checkout/...", "expiresAt": "2026-10-06T13:00:00.000Z", "type": "CHECKOUT" }
  ```

- `planId` fora do catálogo → `400`; `returnUrl` precisa passar pelo allowlist de `APP_WEB_URL` (origin exato ou prefixo `origin/`).
- Um checkout do mesmo plano e `returnUrl` criado há pouco (faltando mais de 10 min para expirar) é devolvido de novo, em vez de criar outro.
- Mensal em `PAST_DUE` ainda com Pro (carência de 3 dias) → devolve a fatura vencida da assinatura atual: `{ "checkoutUrl": "https://sandbox.asaas.com/i/...", "expiresAt": null, "type": "INVOICE" }`. Com o Pro já vencido, a assinatura antiga é cancelada no Asaas e sai um checkout novo.
- Mensal ativa, troca de ciclo com o Pro pago ou anual a mais de 31 dias do vencimento → `409 SUBSCRIPTION_ALREADY_ACTIVE`. Rate limit: 10 por hora por conta (o `/billing/cancel` também).
- Cada chamada ao Asaas aborta em 10s; timeout ou falha de rede viram `502 BILLING_ERROR`. Lambda com timeout de 29s (`/billing/cancel`: 15s).

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
- Eventos tratados (marcar no webhook do painel do Asaas, separado no sandbox e em produção): `PAYMENT_CREATED`, `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`, `SUBSCRIPTION_DELETED` (e `SUBSCRIPTION_CANCELED`), `CHECKOUT_PAID`, `CHECKOUT_CANCELED`, `CHECKOUT_EXPIRED`, `PAYMENT_REFUNDED`, `PAYMENT_PARTIALLY_REFUNDED`, `PAYMENT_CHARGEBACK_REQUESTED`, `PAYMENT_CHARGEBACK_DISPUTE` e `PAYMENT_AWAITING_CHARGEBACK_REVERSAL`.
- Estorno total (`PAYMENT_REFUNDED`) e chargeback aberto (`PAYMENT_CHARGEBACK_REQUESTED`) de um pagamento que gerou o ciclo atual descontam um ciclo do `paidUntil`, cancelam a mensal no Asaas e põem `CANCELED` quando o Pro acaba; estorno parcial e os demais eventos de chargeback só alertam. Todos publicam alerta no SNS. Regras em [billing](docs/guide/fluxos/billing.md#estorno-e-chargeback).
- A assinatura é gravada com `version` (escrita condicional); webhook, cancelamento e checkout releem e reaplicam no conflito.

## Eventos

Triggers do Cognito, evento do S3, filas SQS e o schedule da reconciliação estão no [inventário de Lambdas](docs/guide/01-visao-geral.md#disparadas-por-evento).

### E-mails transacionais

- O layout base fica em `src/infra/emails/emailLayout.ts` e os e-mails em `src/infra/emails/templates/`. Cada e-mail é uma lista de blocos (parágrafo, código, nota) que vira HTML e texto puro (`{ subject, html, text }`). O texto puro serve para envios próprios pelo SES, que aceitam as duas versões;
- O HTML usa tabelas e CSS inline. Os blocos `<style>` ficam separados (base, modo escuro, Outlook.com, Apple) porque o Gmail descarta um bloco inteiro quando não aceita um seletor. Tem ajustes para o Outlook no Windows (tabela fixa de 520px, fontes forçadas, 96 DPI) e logo em PNG público (`https://www.nacal.app/assets/apple-touch-icon.png`);
- Limites do Cognito: corpo com até 20.000 caracteres e assunto com até 140. Acima dos 20.000, o Cognito descarta a mensagem sem erro e manda o texto padrão; por isso o trigger usa a versão em texto puro quando o HTML passa do limite. O corpo precisa conter o `codeParameter` (`{####}`) e só é aceito com `EmailSendingAccount: DEVELOPER`;
- Preview local: `npx tsx scripts/previewEmails.ts [pasta]` grava o HTML e o texto de cada e-mail e um `index.html` com os temas claro e escuro lado a lado, e mostra o tamanho de cada HTML. Sem pasta, grava em `$TMPDIR/nacal-email-preview`;
- Para testar de verdade: `sls deploy function -f customMessageTrigger --stage dev` e um cadastro ou "esqueci a senha" em dev.

## Tecnologias Utilizadas

### Backend

- Serverless Framework v4;
- AWS (Lambda, API Gateway HTTP API, DynamoDB, S3, CloudFront, SQS, SNS, Cognito, SES);
- TypeScript;
- Zod (validação de schemas);
- esbuild (bundling);
- OpenAI API (GPT-5.4-mini, GPT-4o-transcribe);
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
  - Refresh token: 7 dias (com rotação; o anterior ainda vale por 60 s, `RetryGracePeriodSeconds`)
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

- **Trigger do S3** (`newMealUploadedTrigger`): relança o erro quando algum registro falha, para o S3 repetir o evento (até 2 vezes); alarme de erros por email (SNS, `NewMealUploadedTriggerErrorsAlarm`)
- **MealsQueue**: Fila para processamento assíncrono de refeições, com alarme por email (SNS) quando a mensagem mais antiga passa de 2 min (`MealsQueueAgeAlarm`)
- **MealsDLQ**: Dead Letter Queue com alarme por email (SNS)
- Os consumidores (`processMeal`, lote de 2, e `checkMealUpload`, lote de 10) usam `ReportBatchItemFailures`: só a mensagem que falhou volta para a fila
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
- Access log em `/aws/http-api/nacal-api-<stage>` (IP, rota, status), com retenção de 30 dias

### CloudWatch

- Log groups de todas as Lambdas com retenção de 30 dias (`provider.logRetentionInDays`)
- Alarmes (`sls/resources/observabilityAlarms.yml`, ligados só em prod, email via SNS): `HttpApi5xxAlarm` (3+ respostas `5xx` em 5 min), `AsaasWebhookNon2xxAlarm` (métrica EMF `WebhookNon2xx`), `MealFailedAlarm` (métrica EMF `MealFailed`), `NewMealUploadedTriggerErrorsAlarm` (erros do trigger do S3) e `ProcessMealThrottlesAlarm`, além dos alarmes das filas e da reconciliação. O que fazer com cada um: [runbook de alertas](docs/guide/runbooks/alertas.md)

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
| `SERVICE_NAME`          | `nacal-api-<stage>` (dimensão `Service` das métricas EMF) |
| `NODE_OPTIONS`          | `--enable-source-maps`, posto pelo Serverless em cada função quando o build gera sourcemap (não definir no `env.yml`, o valor por função sobrepõe o do provider) |

## Arquitetura do Código

Camadas (`kernel`, `shared`, `main`, `application`, `infra`), mapa das pastas, injeção de dependência, adapters e o passo a passo para criar um endpoint: [Arquitetura do código](docs/guide/02-arquitetura-codigo.md).

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
- Verifique os logs da Lambda `processMeal` no CloudWatch (filtre pelo `mealId`: as linhas `meal processing attempt failed` trazem o erro de cada tentativa; em prod, o `MealFailedAlarm` avisa por email, ver o [runbook de alertas](docs/guide/runbooks/alertas.md#mealfailedalarm));
- O trabalho da OpenAI de cada tentativa tem prazo de 90 s (análise 45 s + 1 retry, transcrição 30 s + 1 retry, download do áudio 15 s), que vale também para a espera de um `Retry-After` da OpenAI; estourou, a tentativa falha e vai para o retry ou para `FAILED`. Resposta cortada por `max_output_tokens` (4096) também vira erro (`OPEN AI incomplete response`);
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
- Verifique se a `OPENAI_API_KEY` tem acesso ao modelo `gpt-4o-transcribe`;
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
